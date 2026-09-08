import { createHash, randomUUID } from 'node:crypto';

import { withActorContext } from '../../../lib/actor-context-binding.js';
import { commitAuthorityTransaction } from '../../../lib/commit-authority-transaction.js';
import { crisisDetector } from '../../../lib/crisis-detection.js';
import { type DbClient, type DbTransaction } from '../../../lib/db.js';
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
   * own connection here to observe it. It is used in place of a pool
   * client: the caller sets the tenant binding beforehand and owns disposal
   * — this module never returns or destroys a caller-owned connection.
   * Refused outside test.
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

function mapUnauthenticated(error: unknown): unknown {
  if ((error as { code?: unknown } | null)?.code === 'PT401')
    return Object.assign(new Error('crisis_unauthenticated'), { code: 'PT401', statusCode: 401 });
  return error;
}

/**
 * Runs `work` in a transaction whose COMMIT is itself authority-checked.
 *
 * The owned-client lifecycle that PR #302 introduced here (and #303/#304/
 * #305 copied) now lives in the shared primitive (PR #306), which also
 * closes the FATAL/PANIC-after-COMMIT misclassification this copy inherited.
 * The deferred `crisis_care_evidence` trigger fires AT COMMIT with tenant and
 * actor bindings both still in scope. An unconfirmed COMMIT (stalled past
 * the deadline, or a transport / class-08 / FATAL failure after COMMIT was
 * issued) surfaces as PT503, which the caller reports as `unconfirmed` —
 * never `not_recorded`, never a success.
 *
 * Caller-owned path (test-only): the caller supplies an already tenant-bound
 * connection and owns its disposal; the primitive still runs BEGIN/COMMIT
 * and the deadline on it. Refused outside test.
 */
async function patientTransaction<T>(
  ctx: PatientCareAdmissionContext,
  work: (tx: DbTransaction) => Promise<T>,
): Promise<T> {
  if (ctx.connection !== undefined && process.env['NODE_ENV'] !== 'test') {
    throw new Error('patientTransaction: a caller-owned connection is test-only');
  }
  const run = commitAuthorityTransaction({
    tenantId: ctx.tenant.tenantId,
    nonce: ctx.actorNonce,
    assertLive: (tx) => assertPatient(tx, ctx),
    unconfirmed: () => Object.assign(new Error('crisis_commit_unconfirmed'), { code: 'PT503' }),
    discardEvent: 'crisis.recording_connection.discarded',
    ...(ctx.connection !== undefined ? { callerOwnedClient: ctx.connection } : {}),
  });
  try {
    return await run(work);
  } catch (error) {
    throw mapUnauthenticated(error);
  }
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
  let authenticated = false;
  let crisisEventId: string | undefined;
  let recordingStatus: 'recorded' | 'not_recorded' | 'unconfirmed';
  try {
    crisisEventId = await patientTransaction(ctx, async (tx) => {
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
    });
    recordingStatus = 'recorded';
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    if (code === 'PT401') throw error;
    if (code === '42501' && !authenticated)
      throw Object.assign(new Error('crisis_forbidden'), { code: '42501', statusCode: 403 });
    signalAdmissionUnavailable();
    // The primitive already classified the COMMIT outcome: PT503 is the one
    // shape that means "may have committed" (stalled past the deadline, or a
    // transport / class-08 / FATAL failure after COMMIT was issued). Every
    // other failure is a definite rollback or happened before COMMIT.
    recordingStatus = code === 'PT503' ? 'unconfirmed' : 'not_recorded';
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
