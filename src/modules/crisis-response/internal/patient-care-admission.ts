import { createHash, randomUUID } from 'node:crypto';

import { withActorContext } from '../../../lib/actor-context-binding.js';
import { crisisDetector } from '../../../lib/crisis-detection.js';
import { getPool, type DbClient, type DbTransaction } from '../../../lib/db.js';
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

/**
 * Wall-clock bound on the COMMIT statement only.
 *
 * PostgreSQL disables `statement_timeout` before it runs deferred
 * constraint triggers inside COMMIT, so once the evidence trigger fires at
 * COMMIT (which it must — see patientTransaction) the evidence scan is no
 * longer covered by the transaction's 5-second `SET LOCAL
 * statement_timeout`. Without a client-side bound, a slow scan could hold
 * the recording connection and delay the patient's safety-resource
 * response. (Codex round 3 on PR #302.)
 *
 * Deliberately BELOW the 5-second statement_timeout so the integration
 * regression proves this bound, not the server's.
 */
const COMMIT_DEADLINE_MS = 4_000;

/**
 * Bound on the post-COMMIT `clear_tenant_context()` DELETE, which runs
 * outside the transaction and therefore outside its `SET LOCAL` timeouts.
 * A concurrent lock on `_session_tenant_context` could otherwise hold the
 * connection indefinitely after an acknowledged commit. (Codex round 4.)
 */
const CLEANUP_DEADLINE_MS = 2_000;

/**
 * A connection this module may dispose of. Pool clients expose `release`;
 * the test-only caller-owned connection may not, in which case the caller
 * owns disposal too.
 */
interface RecordingClient extends DbClient {
  release?: (destroy?: boolean) => void;
}

/** Transaction outcome, captured the instant COMMIT resolves or rejects. */
type Settled<T> = { ok: true; value: T } | { ok: false; error: unknown };

let nextDiscardSignalAt = -Infinity;
function signalRecordingClientDiscarded(): void {
  if (performance.now() < nextDiscardSignalAt) return;
  nextDiscardSignalAt = performance.now() + 60_000;
  try {
    logger.error(
      { event: 'crisis.recording_connection.discarded' },
      'Crisis recording connection discarded: tenant cleanup did not complete within its bound',
    );
  } catch {
    // Never let a logger failure replace the patient safety response.
  }
}

/**
 * Acquire the connection the admission will record on.
 *
 * Owned path: a raw pool client with the tenant binding set here, so this
 * module — not a shared wrapper — controls when it is returned or
 * DISCARDED. That ownership is the point: on a stalled COMMIT the only safe
 * remedy is to destroy this exact socket. Signalling the backend by pid
 * from another connection was rejected in review because, under pool
 * saturation, the cancel can be delayed until after this client has been
 * released and re-borrowed by an unrelated request — same role, so
 * `pg_cancel_backend` would abort another tenant's transaction.
 *
 * Caller-owned path (test-only): the caller sets the tenant binding and
 * owns disposal; refused outside test.
 */
async function acquireRecordingClient(
  ctx: PatientCareAdmissionContext,
): Promise<{ client: RecordingClient; owned: boolean }> {
  if (ctx.connection !== undefined) {
    if (process.env['NODE_ENV'] !== 'test') {
      throw new Error('patientTransaction: a caller-owned connection is test-only');
    }
    return { client: ctx.connection, owned: false };
  }
  const client = (await getPool().connect()) as unknown as RecordingClient;
  try {
    await client.query('SELECT set_tenant_context($1)', [ctx.tenant.tenantId]);
  } catch (error) {
    // I-023: never return a client to the pool in an unknown binding state.
    client.release?.(true);
    throw error;
  }
  return { client, owned: true };
}

/**
 * Consumed background work: roll back a failed transaction, clear the
 * tenant binding, then return the client — or discard it if that cannot
 * finish inside its bound. Never awaited by the caller, so neither ROLLBACK
 * nor cleanup can delay the patient response. I-023 is preserved either
 * way: the binding is cleared, or the backend that held it is destroyed.
 *
 * ROLLBACK lives here, not on the response path, because the outcome is
 * already known the instant COMMIT rejects: the server has aborted the
 * transaction. Awaiting ROLLBACK before publishing that outcome let a
 * stalled connection run into the still-armed deadline and overwrite a
 * known PT401 (401) or 23514 (not_recorded) with `unconfirmed`. (Codex
 * round 5 on PR #302.)
 *
 * On a caller-owned connection the ROLLBACK is still issued — leaving the
 * transaction aborted would break the caller's next statement — but the
 * connection is never returned or destroyed by this module.
 */
function finalizeRecordingClient(
  client: RecordingClient,
  owned: boolean,
  run: Promise<unknown>,
  rollback: boolean,
): void {
  const settledRun = run.then(
    () => undefined,
    () => undefined,
  );
  const rolledBack = rollback
    ? settledRun
        .then(() => client.query('ROLLBACK'))
        .then(
          () => undefined,
          () => undefined,
        )
    : settledRun;
  if (!owned) {
    void rolledBack;
    return;
  }
  let timer: ReturnType<typeof setTimeout> | null = null;
  const bound = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('cleanup_deadline')), CLEANUP_DEADLINE_MS);
  });
  void Promise.race([rolledBack.then(() => client.query('SELECT clear_tenant_context()')), bound])
    .then(
      () => client.release?.(),
      () => {
        client.release?.(true);
        signalRecordingClientDiscarded();
      },
    )
    .finally(() => {
      if (timer !== null) clearTimeout(timer);
    });
}

function mapUnauthenticated(error: unknown): unknown {
  if ((error as { code?: unknown } | null)?.code === 'PT401')
    return Object.assign(new Error('crisis_unauthenticated'), { code: 'PT401', statusCode: 401 });
  return error;
}

async function patientTransaction<T>(
  ctx: PatientCareAdmissionContext,
  work: (tx: DbTransaction) => Promise<T>,
  beforeCommit: () => void = () => undefined,
): Promise<T> {
  const { client, owned } = await acquireRecordingClient(ctx);

  // The transaction's outcome is SETTLED the moment COMMIT resolves or
  // rejects. Everything afterwards — tenant cleanup, pool release — is
  // bookkeeping and must not be allowed to rewrite that outcome or delay
  // its delivery. (Codex rounds 2 and 4 on PR #302.)
  let settled: Settled<T> | null = null;

  // Armed only when COMMIT is issued, so it bounds nothing else.
  let deadlineTimer: ReturnType<typeof setTimeout> | null = null;
  let armDeadline: () => void = () => undefined;
  const deadline = new Promise<never>((_, reject) => {
    armDeadline = () => {
      deadlineTimer = setTimeout(() => {
        reject(Object.assign(new Error('crisis_commit_deadline'), { code: 'COMMIT_DEADLINE' }));
      }, COMMIT_DEADLINE_MS);
    };
  });

  const run = (async () => {
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
      armDeadline();
      // The deferred `crisis_care_evidence` trigger fires HERE, with the
      // tenant and actor bindings both still in scope.
      await client.query('COMMIT');
      settled = { ok: true, value: result };
      return result;
    } catch (error) {
      // Publish immediately. ROLLBACK is bounded background work — see
      // finalizeRecordingClient — never something the response waits on.
      settled = { ok: false, error };
      throw error;
    } finally {
      if (deadlineTimer !== null) clearTimeout(deadlineTimer);
    }
  })();

  try {
    const value = await Promise.race([run, deadline]);
    finalizeRecordingClient(client, owned, run, false);
    // `settled` is assigned inside the closure above; read it through a
    // widened alias so control-flow narrowing does not freeze it at null.
    const outcome = settled as Settled<T> | null;
    return outcome?.ok ? outcome.value : value;
  } catch (error) {
    const outcome = settled as Settled<T> | null;
    if (outcome?.ok) {
      finalizeRecordingClient(client, owned, run, false);
      return outcome.value;
    }
    if (outcome && !outcome.ok) {
      // A KNOWN outcome always wins, even if the deadline also fired while
      // ROLLBACK was pending: the server has already aborted the
      // transaction, so this is a 401 / not_recorded, never `unconfirmed`.
      finalizeRecordingClient(client, owned, run, true);
      throw mapUnauthenticated(outcome.error);
    }
    if ((error as { code?: unknown } | null)?.code === 'COMMIT_DEADLINE') {
      // The COMMIT is still in flight. Do not wait for it, and do not
      // signal any backend: destroy THIS socket so it can never be handed
      // to another request mid-COMMIT, and let the server resolve the
      // transaction on disconnect. The outcome is genuinely unknown at this
      // moment — the caller reports `unconfirmed`, never `not_recorded`.
      run.catch(() => undefined);
      if (owned) client.release?.(true);
      throw error;
    }
    finalizeRecordingClient(client, owned, run, true);
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
    // `unconfirmed` is reserved for a genuinely unknowable outcome. An error
    // the SERVER raised while processing the transaction — including one
    // raised by the COMMIT statement itself, now that the evidence trigger
    // fires there — means the transaction was aborted: a known rollback,
    // so `crisis_evidence_required` (23514) at COMMIT classifies as
    // `not_recorded`.
    //
    // The exception is SQLSTATE class 08 (connection exception). Those are
    // not the server reporting a rollback; they are the client reporting
    // that it does not know what the server did. 08007 is literally
    // `transaction_resolution_unknown`. Treating class 08 as definite
    // turned explicit uncertainty into a false absence claim: the
    // admission may already be committed, and a retry under another key
    // would duplicate it. (Codex verification round on PR #302.)
    //
    // Driver-level codes such as `ECONNRESET` are not five-char SQLSTATEs
    // and stay uncertain for the same reason.
    const sqlState = typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code) ? code : null;
    const definiteRollback = sqlState !== null && !sqlState.startsWith('08');
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
