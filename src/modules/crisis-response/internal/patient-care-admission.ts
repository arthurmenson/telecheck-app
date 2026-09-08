import { createHash, randomUUID } from 'node:crypto';

import { withActorContext } from '../../../lib/actor-context-binding.js';
import { crisisDetector } from '../../../lib/crisis-detection.js';
import { withTenantBoundConnection, type DbClient, type DbTransaction } from '../../../lib/db.js';
import { emitDomainEvent } from '../../../lib/domain-events.js';
import { logger } from '../../../lib/logger.js';
import { withTenantContext } from '../../../lib/rls.js';
import type { TenantContext } from '../../../lib/tenant-context.js';
import { withDbRole } from '../../../lib/with-db-role.js';
import { getTenantCountryProfile } from '../../tenant-config/index.js';
import { emitCrisisDetectedAudit } from '../audit.js';

import { withPatientCareRead } from './patient-care-read.js';
import { asCrisisEventId, asServerSignalId } from './types.js';

export interface PatientCareAdmissionContext {
  tenant: TenantContext;
  accountId: string;
  sessionId: string;
  actorNonce: string;
  /** Retry selector only; never an actor, patient, event or signal identifier. */
  idempotencyKey?: string;
  /**
   * Caller-owned connection with a REAL transaction lifecycle. Test-only.
   *
   * The integration harness routes every app connection through one shared
   * client that translates BEGIN/COMMIT into savepoints, and a deferred
   * constraint trigger fires only at a real COMMIT — so COMMIT-time
   * authority enforcement is invisible there. Integration tests pass their
   * own connection here to observe it. Forwarded to
   * `withTenantBoundConnection` as its caller-owned `externalTx`, which
   * means the caller also owns the tenant binding. Refused outside test.
   */
  connection?: DbClient;
}
export interface PatientCrisisResources {
  country_of_care: string;
  emergency_number: string | null;
  crisis_helplines: Array<{ name: string; number: string; available_hours: string }>;
  status: 'available' | 'unavailable';
}
export type PatientCareAdmissionResult =
  | { kind: 'no_detection' }
  | {
      kind: 'crisis_interruption';
      resources: PatientCrisisResources;
      detector_version: 'keyword_engineering_v1';
      recording_status: 'recorded';
      crisis_event_id: string;
      disclosure_status: 'available';
      escalation_status: 'pending';
    }
  | {
      kind: 'crisis_interruption';
      resources: PatientCrisisResources;
      detector_version: 'keyword_engineering_v1';
      recording_status: 'recorded';
      disclosure_status: 'unavailable';
      escalation_status: 'pending';
    }
  | {
      kind: 'crisis_interruption';
      resources: PatientCrisisResources;
      detector_version: 'keyword_engineering_v1';
      recording_status: 'not_recorded';
      escalation_status: 'not_queued';
    }
  | {
      kind: 'crisis_interruption';
      resources: PatientCrisisResources;
      detector_version: 'keyword_engineering_v1';
      recording_status: 'unconfirmed';
      escalation_status: 'unconfirmed';
    };

const MAX_ADMITTED_BYTES = 1_048_576;
/** JSON ingress may be malformed for the business schema. Scan every string value. */
export function collectPatientCareText(body: unknown): string[] {
  const pending: unknown[] = [body];
  const seen = new WeakSet<object>();
  const strings: string[] = [];
  let bytes = 0;
  let nodes = 0;
  while (pending.length) {
    const value = pending.pop();
    if (++nodes > MAX_ADMITTED_BYTES) throw new Error('crisis_input_limit');
    if (typeof value === 'string') {
      bytes += Buffer.byteLength(value, 'utf8');
      if (bytes > MAX_ADMITTED_BYTES) throw new Error('crisis_input_limit');
      strings.push(value);
    } else if (value && typeof value === 'object' && !seen.has(value)) {
      seen.add(value);
      for (const item of Object.values(value)) pending.push(item);
    }
  }
  return strings;
}

let nextSignalAt = -Infinity;
function signalAdmissionUnavailable(): void {
  if (performance.now() < nextSignalAt) return;
  nextSignalAt = performance.now() + 60_000;
  try {
    logger.error({ event: 'crisis.admission.unavailable' }, 'Crisis admission unavailable');
  } catch {
    // Do not replace the patient safety response with a logger failure.
  }
}

async function assertPatient(tx: DbTransaction, ctx: PatientCareAdmissionContext): Promise<void> {
  const result = await withDbRole(tx, 'crisis_care_patient', () =>
    tx.query<{ actor: Record<string, unknown> }>(
      'SELECT public.crisis_care_live_patient() AS actor',
    ),
  );
  const actor = result.rows[0]?.actor;
  if (
    actor?.['account_id'] !== ctx.accountId ||
    actor?.['session_id'] !== ctx.sessionId ||
    actor?.['tenant_id'] !== ctx.tenant.tenantId ||
    actor?.['country_of_care'] !== ctx.tenant.countryOfCare
  )
    throw Object.assign(new Error('crisis_unauthenticated'), { code: 'PT401' });
}

/**
 * Runs `work` in a transaction whose COMMIT is itself authority-checked.
 *
 * ## Why the nesting is tenant-scope OUTSIDE, BEGIN/COMMIT INSIDE
 *
 * The earlier shape was `withTransaction(() => withTenantContext(() =>
 * withActorContext(work)))`. That looks right and is subtly wrong:
 * `withTenantContext` DELETES the per-backend tenant binding in its
 * cleanup, which runs when the callback returns — i.e. BEFORE the outer
 * `withTransaction` issues COMMIT. The actor nonce (`set_config(...,
 * true)`) is transaction-local and survives to COMMIT, but
 * `kms_current_actor_context()` requires `current_tenant_id()` too, so at
 * COMMIT time nothing could re-validate authority.
 *
 * The code worked around that by forcing the DEFERRABLE evidence trigger
 * `crisis_care_evidence` IMMEDIATE while the bindings were still in scope.
 * That drains the trigger queue, so the actual COMMIT ran with NO authority
 * check at all. Between the last `assertPatient` and COMMIT the nonce can
 * expire — `kms_current_actor_context()` compares against
 * `clock_timestamp()`, not the frozen `NOW()` — and the admission was
 * committed under expired authority. Reproduced by the clinical v1 review.
 *
 * Inverting the nesting fixes the root cause instead of the symptom: the
 * tenant binding is set on the connection, BEGIN…COMMIT run inside that
 * scope, and cleanup follows COMMIT. Both bindings are live when the
 * deferred trigger fires, so `crisis_care_require_evidence()` —
 * which calls `crisis_care_live_patient()` first and last — becomes a
 * genuine COMMIT-time authority gate. An expired nonce now raises PT401
 * from the COMMIT statement and the transaction rolls back.
 *
 * The IMMEDIATE forcing is therefore removed on purpose. Re-adding it
 * would reopen the window. The two app-side `assertPatient` calls stay
 * for fail-fast; they are no longer the last word.
 */
function patientTransaction<T>(
  ctx: PatientCareAdmissionContext,
  work: (tx: DbTransaction) => Promise<T>,
  beforeCommit: () => void = () => undefined,
): Promise<T> {
  if (ctx.connection !== undefined && process.env['NODE_ENV'] !== 'test') {
    throw new Error('patientTransaction: a caller-owned connection is test-only');
  }
  // The transaction's outcome is SETTLED the moment COMMIT resolves or
  // rejects. Everything that happens afterwards on the connection — the
  // wrapper's clear_tenant_context cleanup, pool release — is bookkeeping
  // and must not be allowed to rewrite that outcome. Without this capture,
  // a cleanup failure after a successful COMMIT surfaced as a generic error
  // with no SQLSTATE, so an acknowledged admission was reported
  // `unconfirmed`; and a PT401 raised by COMMIT followed by a cleanup
  // failure became an AggregateError with no code, replacing the required
  // 401. (Codex review of PR #302, reproduced by fault injection.)
  let settled: { ok: true; value: T } | { ok: false; error: unknown } | null = null;
  return withTenantBoundConnection(
    ctx.tenant.tenantId,
    async (client) => {
      await client.query('BEGIN');
      try {
        const result = await withActorContext(client, ctx.actorNonce, async () => {
          await client.query("SET LOCAL statement_timeout='5s'");
          await client.query("SET LOCAL lock_timeout='2s'");
          await assertPatient(client, ctx);
          const result = await work(client);
          await assertPatient(client, ctx);
          return result;
        });
        beforeCommit();
        // The deferred `crisis_care_evidence` trigger fires HERE, with the
        // tenant and actor bindings both still in scope.
        await client.query('COMMIT');
        settled = { ok: true, value: result };
        return result;
      } catch (error) {
        settled = { ok: false, error };
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
      }
    },
    ctx.connection,
  )
    .then(
      (value) => (settled?.ok ? settled.value : value),
      (error: unknown) => {
        // Prefer the settled transaction outcome over whatever the wrapper
        // threw during cleanup. If COMMIT succeeded, the admission stands.
        if (settled?.ok) return settled.value;
        throw settled && !settled.ok ? settled.error : error;
      },
    )
    .catch((error: unknown) => {
      if ((error as { code?: unknown } | null)?.code === 'PT401')
        throw Object.assign(new Error('crisis_unauthenticated'), {
          code: 'PT401',
          statusCode: 401,
        });
      throw error;
    });
}

/**
 * Invoke before ordinary validation and outside the ordinary business transaction.
 * A keyword engineering detector is not a clinically validated classifier. No input
 * text, text fingerprint, or ordinary intake record is retained by this operation.
 */
export async function admitPatientCareInput(
  ctx: PatientCareAdmissionContext,
  body: unknown,
  source: 'form_response' | 'messaging',
): Promise<PatientCareAdmissionResult> {
  const detection = crisisDetector.detect(
    collectPatientCareText(body).join('\n'),
    ctx.tenant.tenantId,
    source,
  );
  if (!detection.crisisDetected) {
    await patientTransaction(ctx, async () => undefined);
    return { kind: 'no_detection' };
  }
  const resources: PatientCrisisResources = {
    country_of_care: ctx.tenant.countryOfCare,
    emergency_number: null,
    crisis_helplines: [],
    status: 'unavailable',
  };
  let commitPossible = false;
  let authenticated = false;
  let crisisEventId: string | undefined;
  let recordingStatus: 'recorded' | 'not_recorded' | 'unconfirmed';
  try {
    crisisEventId = await patientTransaction(
      ctx,
      async (tx) => {
        authenticated = true;
        const sourceSurface = source === 'form_response' ? 'forms' : 'messaging';
        // Hash only the transport retry selector, never clinical text or body bytes.
        const keyHash = createHash('sha256')
          .update(ctx.idempotencyKey ?? randomUUID())
          .digest('hex');
        const result = await withDbRole(tx, 'crisis_care_patient', () =>
          tx.query<{
            result: { crisis_event_id: string; server_signal_id?: string; created: boolean };
          }>('SELECT public.crisis_care_record($1,$2,$3) AS result', [
            detection.crisisType,
            sourceSurface,
            keyHash,
          ]),
        );
        const record = result.rows[0]?.result;
        if (!record) throw new Error('crisis_record_unavailable');
        if (record.created) {
          if (!record.server_signal_id) throw new Error('crisis_record_unavailable');
          const audit = await emitCrisisDetectedAudit(
            {
              tenantId: ctx.tenant.tenantId,
              crisisInitiatorIdentity: 'patient',
              actorAccountId: ctx.accountId,
              actorTenantId: ctx.tenant.tenantId,
              countryOfCare: ctx.tenant.countryOfCare,
              crisisEventId: asCrisisEventId(record.crisis_event_id),
              targetPatientId: ctx.accountId,
              serverSignalId: asServerSignalId(record.server_signal_id),
              crisisType: detection.crisisType,
              severity: 'unassessed',
              regulatoryReportingEnabled: false,
              sourceSurface,
              detectorVersion: 'keyword_engineering_v1',
            },
            tx,
          );
          await emitDomainEvent(tx, {
            tenant_id: ctx.tenant.tenantId,
            aggregate_type: 'CrisisEvent',
            aggregate_id: record.crisis_event_id,
            event_type: 'crisis.detected.v1',
            occurred_at: new Date().toISOString(),
            payload: {
              crisis_event_id: record.crisis_event_id,
              audit_id: audit.audit_id,
              severity: 'unassessed',
              source_surface: sourceSurface,
              detector_version: 'keyword_engineering_v1',
              escalation_status: 'pending',
            },
          });
        }
        return record.crisis_event_id;
      },
      () => {
        commitPossible = true;
      },
    );
    recordingStatus = 'recorded';
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    if (code === 'PT401') throw error;
    if (code === '42501' && !authenticated)
      throw Object.assign(new Error('crisis_forbidden'), { code: '42501', statusCode: 403 });
    signalAdmissionUnavailable();
    // `unconfirmed` is reserved for a genuinely unknowable outcome — the
    // acknowledgement was lost. An error that carries a SQLSTATE was RAISED
    // by the server, and a raise during COMMIT is a guaranteed rollback,
    // not an uncertainty. Now that the evidence trigger fires at COMMIT
    // rather than being forced early, its `crisis_evidence_required`
    // (23514) can arrive on the COMMIT statement and must still classify
    // as `not_recorded`. SQLSTATE is exactly five alphanumerics; driver
    // codes such as `ECONNRESET` do not match and stay uncertain.
    const definiteRollback = typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code);
    recordingStatus = commitPossible && !definiteRollback ? 'unconfirmed' : 'not_recorded';
  }

  // Recording has already settled. Public configuration can neither prevent
  // that transaction nor change its acknowledged/uncertain outcome.
  try {
    const profile = await withPatientCareRead((tx) => getTenantCountryProfile(ctx.tenant, tx));
    if (profile) {
      resources.emergency_number = profile.emergency_number;
      resources.crisis_helplines = profile.crisis_helplines.map((line) => ({ ...line }));
      resources.status = 'available';
    } else signalAdmissionUnavailable();
  } catch {
    signalAdmissionUnavailable();
  }
  const common = {
    kind: 'crisis_interruption' as const,
    detector_version: 'keyword_engineering_v1' as const,
    resources,
  };
  if (recordingStatus === 'not_recorded')
    return { ...common, recording_status: 'not_recorded', escalation_status: 'not_queued' };
  if (recordingStatus === 'unconfirmed')
    return { ...common, recording_status: 'unconfirmed', escalation_status: 'unconfirmed' };

  // Revalidate after the resource wait before disclosing an event identifier.
  // This separate, bounded read cannot undo an acknowledged recording commit.
  try {
    await withPatientCareRead((tx) =>
      withTenantContext(tx, ctx.tenant.tenantId, () =>
        withActorContext(tx, ctx.actorNonce, () => assertPatient(tx, ctx)),
      ),
    );
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    if (code === 'PT401')
      throw Object.assign(new Error('crisis_unauthenticated'), { code: 'PT401', statusCode: 401 });
    if (code === '42501')
      throw Object.assign(new Error('crisis_forbidden'), { code: '42501', statusCode: 403 });
    signalAdmissionUnavailable();
    return {
      ...common,
      recording_status: 'recorded',
      escalation_status: 'pending',
      disclosure_status: 'unavailable',
    };
  }
  return {
    ...common,
    recording_status: 'recorded',
    crisis_event_id: crisisEventId!,
    escalation_status: 'pending',
    disclosure_status: 'available',
  };
}
