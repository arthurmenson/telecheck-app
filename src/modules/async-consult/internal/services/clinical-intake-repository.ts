import {
  getPool,
  type DbClient,
  type DbTransaction,
  type withTransaction,
} from '../../../../lib/db.js';
import { emitDomainEvent } from '../../../../lib/domain-events.js';
import {
  IdempotencyReplayError,
  IdempotencyBodyMismatchError,
  IdempotencyInFlightError,
} from '../../../../lib/idempotency.js';
import { logger } from '../../../../lib/logger.js';
import { readCurrentTenantId } from '../../../../lib/rls.js';
import { ulid } from '../../../../lib/ulid.js';
import type { CareConsentPatientContext } from '../../../consent/index.js';
import { resolveConsultIntakeDefinition } from '../../../forms-intake/index.js';
import {
  emitAsyncConsultIntakeDefinitionBoundAudit,
  emitAsyncConsultIntakeSubmittedAudit,
} from '../../audit.js';

import {
  CareIntakeError,
  type BoundCareIntake,
  type CareIntakeRepository,
} from './clinical-intake.js';

async function bind(tx: DbTransaction, ctx: CareConsentPatientContext) {
  await tx.query('SELECT set_tenant_context($1)', [ctx.tenant.tenantId]);
  await tx.query("SELECT set_config('app.request_nonce',$1,true)", [ctx.actorNonce]);
}

async function actor(tx: DbTransaction, ctx: CareConsentPatientContext) {
  await bind(tx, ctx);
  const result = await tx
    .query<{
      account_id: string;
      session_id: string;
      tenant_id: string;
      actor_role: string;
      country_of_care: string;
    }>('SELECT * FROM public.kms_current_actor_context()')
    .catch((error: unknown) => {
      const failure = error as { code?: string; message?: string };
      if (failure.code === 'P0001' && failure.message === 'kms_actor_unavailable')
        throw Object.assign(new Error('care_unauthenticated'), { code: 'PT401' });
      throw error;
    });
  const current = result.rows[0];
  if (
    !current ||
    current.account_id !== ctx.accountId ||
    current.session_id !== ctx.sessionId ||
    current.tenant_id !== ctx.tenant.tenantId ||
    current.actor_role !== 'patient' ||
    current.country_of_care !== ctx.tenant.countryOfCare
  )
    throw Object.assign(new Error('care_unauthenticated'), { code: 'PT401' });
}

/** Encloses reservation/replay, writes, audit/outbox and deferred proof checks. */
/**
 * Wall-clock bound on the COMMIT statement only. PostgreSQL disables
 * `statement_timeout` before running deferred constraint triggers inside
 * COMMIT, so once the evidence triggers fire there their audit/outbox scans
 * are unbounded server-side; this is the client-side bound. Deliberately
 * below the transaction's 10 s statement_timeout.
 */
const COMMIT_DEADLINE_MS = 4_000;

/** Bound on post-COMMIT ROLLBACK/cleanup, which run outside SET LOCAL timeouts. */
const CLEANUP_DEADLINE_MS = 2_000;

/**
 * A pool client this module may return or DISCARD.
 *
 * `on`/`off` matter as much as `release`: pg-pool removes its idle 'error'
 * listener when a client is checked out, and getPool() only handles POOL
 * errors. On EPIPE/ECONNRESET pg both rejects the in-flight query AND emits
 * a client 'error' event. An emitter error with no listener throws — Node
 * exits with code 1 before any rejection handler runs, taking every other
 * in-flight request with it. (Codex round 3 on PR #303, reproduced with the
 * installed driver.) So this module listens for the whole time it owns the
 * client, including asynchronous cleanup, and only lets go at release.
 */
interface RecordingClient extends DbClient {
  release?: (destroy?: boolean) => void;
  on?: (event: 'error', listener: (error: Error) => void) => unknown;
  off?: (event: 'error', listener: (error: Error) => void) => unknown;
}

/** Attach the ownership-window error listener; returns the detach function. */
function ownClientErrors(client: RecordingClient): () => void {
  const listener = (): void => {
    // The in-flight query rejects with the same failure; the outcome
    // lifecycle classifies it there. Listening is what keeps the process up.
  };
  client.on?.('error', listener);
  return () => client.off?.('error', listener);
}

/** Transaction outcome, captured the instant COMMIT resolves or rejects. */
type Settled<T> = { ok: true; value: T } | { ok: false; error: unknown };

let nextDiscardSignalAt = -Infinity;
function signalRecordingClientDiscarded(): void {
  if (performance.now() < nextDiscardSignalAt) return;
  nextDiscardSignalAt = performance.now() + 60_000;
  try {
    logger.error(
      { event: 'care_intake.recording_connection.discarded' },
      'Care intake recording connection discarded: cleanup did not complete within its bound',
    );
  } catch {
    // Never let a logger failure replace the care response.
  }
}

/**
 * Consumed background work after the outcome has been published: roll back
 * a failed transaction, clear the tenant binding, return the client — or
 * discard it if that cannot finish inside its bound. I-023 holds either
 * way: the binding is cleared, or the backend that held it is destroyed.
 */
function finalizeRecordingClient(
  client: RecordingClient,
  run: Promise<unknown>,
  rollback: boolean,
  previousTenantId: string | null,
  disown: () => void,
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
  let timer: ReturnType<typeof setTimeout> | null = null;
  const bound = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('cleanup_deadline')), CLEANUP_DEADLINE_MS);
  });
  // Restore the binding that was in place when this factory took the client,
  // exactly as withTenantContext does — never blindly clear. Under the test
  // harness every factory shares one client with an outer binding; clearing
  // it asynchronously, after the response, deleted the binding the rest of
  // the suite still relied on (CI on PR #303: `No active tenant binding`).
  const restore =
    previousTenantId === null ? 'SELECT clear_tenant_context()' : 'SELECT set_tenant_context($1)';
  const restoreParams = previousTenantId === null ? [] : [previousTenantId];
  void Promise.race([rolledBack.then(() => client.query(restore, restoreParams)), bound])
    .then(
      () => {
        disown();
        client.release?.();
      },
      () => {
        disown();
        client.release?.(true);
        signalRecordingClientDiscarded();
      },
    )
    .finally(() => {
      if (timer !== null) clearTimeout(timer);
    });
}

/**
 * Runs `work` in a transaction whose COMMIT is itself authority-checked.
 *
 * The previous shape — `withTransaction(() => withTenantContext(() =>
 * withActorContext(work)))` followed by `SET CONSTRAINTS
 * care_intake_evidence,care_binding_evidence IMMEDIATE` — is the defect
 * class fixed for the crisis path in PR #302. `withTenantContext` DELETES
 * the per-backend tenant binding in its cleanup, before the outer COMMIT;
 * `kms_current_actor_context()` needs `current_tenant_id()`, so at COMMIT
 * nothing could re-validate authority, and forcing the triggers IMMEDIATE
 * consumed their events — the real COMMIT ran with no authority check and
 * an actor nonce expiring in that window was committed under expired
 * authority (`kms_current_actor_context()` compares against
 * `clock_timestamp()`).
 *
 * Now this module owns the client: it sets the tenant binding, runs
 * BEGIN…COMMIT with both bindings live, and lets the deferred triggers —
 * which call `consent_care_live_actor()` first and last — fire AT COMMIT as
 * a genuine authority gate. The outcome is published the instant COMMIT
 * settles; ROLLBACK and cleanup are bounded background work; a stalled
 * COMMIT is bounded client-side and reported as PT503, with this module's
 * own socket destroyed rather than any backend signalled by pid.
 *
 * Keeps `typeof withTransaction` so `withIdempotentExecution` can consume
 * it unchanged.
 */
export function careIntakeTransaction(ctx: CareConsentPatientContext): typeof withTransaction {
  return async <T>(work: (tx: DbTransaction) => Promise<T>): Promise<T> => {
    const client = (await getPool().connect()) as unknown as RecordingClient;
    const disown = ownClientErrors(client);
    let previousTenantId: string | null = null;
    let commitIssued = false;

    let settled: Settled<T> | null = null;
    let deadlineTimer: ReturnType<typeof setTimeout> | null = null;
    let armDeadline: () => void = () => undefined;
    const deadline = new Promise<never>((_, reject) => {
      armDeadline = () => {
        deadlineTimer = setTimeout(() => {
          reject(Object.assign(new Error('care_commit_unconfirmed'), { code: 'COMMIT_DEADLINE' }));
        }, COMMIT_DEADLINE_MS);
      };
    });

    const run = (async () => {
      await client.query('BEGIN');
      try {
        // The probe needs a transaction (it uses a sub-savepoint), so it runs
        // after BEGIN. The tenant binding is per-backend, not
        // transaction-local, so setting it here still holds through COMMIT.
        previousTenantId = await readCurrentTenantId(client);
        await client.query('SELECT set_tenant_context($1)', [ctx.tenant.tenantId]);
        await client.query("SET LOCAL statement_timeout='10s'");
        await client.query("SET LOCAL lock_timeout='3s'");
        await actor(client, ctx);
        let result: T;
        try {
          result = await work(client);
          await actor(client, ctx);
        } catch (error) {
          // An idempotency replay/mismatch/in-flight outcome is still only
          // disclosed to a live, authorised actor.
          if (
            error instanceof IdempotencyReplayError ||
            error instanceof IdempotencyBodyMismatchError ||
            error instanceof IdempotencyInFlightError
          )
            await actor(client, ctx);
          throw error;
        }
        armDeadline();
        commitIssued = true;
        // The deferred care_intake_evidence / care_binding_evidence triggers
        // fire HERE, with tenant and actor bindings both still in scope.
        await client.query('COMMIT');
        settled = { ok: true, value: result };
        return result;
      } catch (error) {
        settled = { ok: false, error };
        throw error;
      } finally {
        if (deadlineTimer !== null) clearTimeout(deadlineTimer);
      }
    })();

    const unconfirmed = () => {
      // The COMMIT's fate is unknown: destroy THIS socket so it can never be
      // re-borrowed mid-COMMIT; never signal a backend by pid. Surface as
      // PT503 (503) so the caller is told to check status before retrying
      // — never as a success and never as a definite failure.
      run.catch(() => undefined);
      disown();
      client.release?.(true);
      return Object.assign(new Error('care_commit_unconfirmed'), { code: 'PT503' });
    };

    try {
      const value = await Promise.race([run, deadline]);
      finalizeRecordingClient(client, run, false, previousTenantId, disown);
      const outcome = settled as Settled<T> | null;
      return outcome?.ok ? outcome.value : value;
    } catch (error) {
      const outcome = settled as Settled<T> | null;
      if (outcome?.ok) {
        finalizeRecordingClient(client, run, false, previousTenantId, disown);
        return outcome.value;
      }
      if (outcome && !outcome.ok) {
        // A server RAISE during COMMIT (PT401, 23514, ...) is a definite
        // rollback and passes through. A rejection with no SQLSTATE
        // (ECONNRESET) or a class-08 connection exception (08007
        // transaction_resolution_unknown) arriving AFTER COMMIT was issued is
        // indeterminate — the submission and its idempotency record may have
        // committed — and must not be rethrown as if it were a known failure.
        // (Codex review of PR #303.)
        // A SQLSTATE shape alone does not prove the server raised: EPIPE is
        // five uppercase characters too. pg's server errors always carry
        // `severity`; transport errors (EPIPE, ECONNRESET, ETIMEDOUT) never do.
        // (Codex round 2 on PR #303.)
        const failure = outcome.error as { code?: unknown; severity?: unknown } | null;
        const code = failure?.code;
        const sqlState =
          typeof code === 'string' &&
          /^[0-9A-Z]{5}$/.test(code) &&
          typeof failure?.severity === 'string'
            ? code
            : null;
        const indeterminate = commitIssued && (sqlState === null || sqlState.startsWith('08'));
        if (indeterminate) throw unconfirmed();
        // A known outcome always wins over the deadline.
        finalizeRecordingClient(client, run, true, previousTenantId, disown);
        throw outcome.error;
      }
      if ((error as { code?: unknown } | null)?.code === 'COMMIT_DEADLINE') throw unconfirmed();
      finalizeRecordingClient(client, run, true, previousTenantId, disown);
      throw error;
    }
  };
}

export function careIntakeRepository(ctx: CareConsentPatientContext): CareIntakeRepository {
  return {
    async authorize(tx, consultId) {
      await actor(tx, ctx);
      const result = await tx.query<{ binding: BoundCareIntake }>(
        'SELECT public.care_authorize_intake($1) AS binding',
        [consultId],
      );
      if (!result.rows[0]?.binding) throw new CareIntakeError('care.intake_unavailable');
      return result.rows[0].binding;
    },
    async append(tx, record) {
      await actor(tx, ctx);
      const e = record.envelope;
      await tx.query(
        'SELECT public.care_append_intake($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb)',
        [
          record.submissionId,
          record.binding.consult_id,
          e.ciphertext,
          e.dekId,
          e.iv,
          e.tag,
          e.alg,
          e.algVersion,
          e.aad,
          e.encryptedAt,
          ulid(),
          ulid(),
          JSON.stringify(record.consent),
        ],
      );
    },
    async evidence(tx, record) {
      await actor(tx, ctx);
      const audit = await emitAsyncConsultIntakeSubmittedAudit(
        {
          tenantId: ctx.tenant.tenantId,
          submissionId: record.submissionId,
          consultId: record.binding.consult_id,
          patientId: ctx.accountId,
          actorId: ctx.accountId,
          actorTenantId: ctx.tenant.tenantId,
          countryOfCare: ctx.tenant.countryOfCare,
          templateId: record.binding.definition.template_id,
          templateVersion: String(record.binding.definition.template_version),
        },
        tx,
      );
      await emitDomainEvent(tx, {
        tenant_id: ctx.tenant.tenantId,
        aggregate_type: 'consult',
        aggregate_id: record.binding.consult_id,
        event_type: 'async_consult.intake_submitted.v1',
        payload: {
          submission_id: record.submissionId,
          audit_id: audit.audit_id,
          publication_id: record.consent.publication_id,
          policy_hash: record.consent.policy_hash,
          ai_interpretation_active: record.consent.ai_interpretation_active,
        },
        occurred_at: new Date().toISOString(),
      });
    },
  };
}

/** Binds once when intake starts; subsequent calls retain that exact version. */
export async function beginCareIntake(
  tx: DbTransaction,
  ctx: CareConsentPatientContext,
  consultId: string,
) {
  await actor(tx, ctx);
  const result = await tx.query<{ binding: BoundCareIntake & { created: boolean } }>(
    'SELECT public.care_bind_intake($1) AS binding',
    [consultId],
  );
  const bound = result.rows[0]?.binding;
  if (!bound || bound.patient_id !== ctx.accountId || bound.consult_id !== consultId)
    throw new CareIntakeError('care.intake_unavailable');
  const definition = await resolveConsultIntakeDefinition(
    tx,
    {
      tenantId: ctx.tenant.tenantId,
      accountId: ctx.accountId,
      sessionId: ctx.sessionId,
      actorNonce: ctx.actorNonce,
      countryOfCare: bound.definition.country_of_care,
    },
    {
      deploymentId: bound.definition.deployment_id,
      kind: bound.consult_type === 'general' ? 'general_consult' : 'program',
      programId: bound.definition.program_id,
      existingBinding: true,
    },
  );
  if (
    definition.schema_hash !== bound.definition.schema_hash ||
    definition.template_id !== bound.definition.template_id ||
    definition.template_version !== bound.definition.template_version ||
    definition.country_of_care !== ctx.tenant.countryOfCare
  )
    throw new CareIntakeError('care.form_review_required');
  await actor(tx, ctx);
  if (bound.created) {
    const audit = await emitAsyncConsultIntakeDefinitionBoundAudit(
      {
        tenantId: ctx.tenant.tenantId,
        consultId,
        patientId: ctx.accountId,
        countryOfCare: ctx.tenant.countryOfCare,
        templateId: definition.template_id,
        templateVersion: definition.template_version,
        deploymentId: definition.deployment_id,
        schemaHash: definition.schema_hash,
      },
      tx,
    );
    await emitDomainEvent(tx, {
      tenant_id: ctx.tenant.tenantId,
      aggregate_type: 'consult',
      aggregate_id: consultId,
      event_type: 'async_consult.intake_definition_bound.v1',
      payload: {
        audit_id: audit.audit_id,
        schema_hash: definition.schema_hash,
        deployment_id: definition.deployment_id,
      },
      occurred_at: new Date().toISOString(),
    });
  }
  return { consult_id: consultId, definition };
}
