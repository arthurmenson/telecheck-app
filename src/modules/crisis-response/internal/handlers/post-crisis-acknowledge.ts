/**
 * crisis-response/internal/handlers/post-crisis-acknowledge.ts — a
 * clinician / care-team actor claims a detected (or escalated) crisis
 * event, transitioning it to `acknowledged` (calls SECDEF wrapper
 * `record_crisis_acknowledgement_claim()` from migration 037 §1, emits
 * Cat A `crisis.acknowledged` audit in the same atomic transaction, and
 * returns the resulting lifecycle_transition_id).
 *
 * Endpoint: POST /v0/crisis-events/:id/acknowledge
 *
 * **Sprint 2 PR 3 — the mid-lifecycle CLAIM write-path handler in the
 * Crisis Response slice.** It is the first transition off the
 * detected/escalated entry states toward clinician handling, and the
 * lifecycle prerequisite for PR 4's `respond` (acknowledged → responded)
 * + `resolve` handlers. The branch is based on `main` (NOT on PR 2
 * initiate, which is parked [CODEX-PENDING], nor on PR 4 respond/resolve,
 * also parked); when those merge, the union of all four handlers + the
 * routes.ts mounts + the audit.ts emitters is resolved at conflict-merge
 * time.
 *
 * Mirrors PR 4's canonical composition stack (respond/resolve pattern):
 *   - body shape: wrapper signature is `(p_tenant_id TEXT,
 *     p_crisis_event_id UUID, p_transition_payload JSONB DEFAULT NULL)`.
 *     `p_tenant_id` is sourced from tenant context; `p_crisis_event_id`
 *     is sourced from path `:id`; only `p_transition_payload` is
 *     body-supplied (optional `{ payload?: object | null }`).
 *   - patient_id + current_state resolution for the audit: the wrapper
 *     RETURNS BIGINT (the transition_id) — it does NOT echo patient_id
 *     or from_state. The audit envelope MUST carry `target_patient_id`
 *     (P1 audit partitioning per SI-022 §3 + I-027) AND `from_state`
 *     (post-incident reconstructability). The handler resolves both by
 *     a side SELECT against `crisis_event_current_state_v` under
 *     `withDbRole('crisis_event_staff_reader', ...)` inside the SAME tx
 *     BEFORE the wrapper SELECT — that read also serves as a
 *     tenant-scope guard (view's RLS + tenant-context binding forces the
 *     row to belong to the request tenant, returning 0 rows on
 *     cross-tenant or missing). 0-row read maps to tenant-blind 404 per
 *     I-025 BEFORE the wrapper is ever called.
 *
 * **Composition stack (Option B per `src/lib/with-db-role.ts`
 * §preconditions; same as PR 4):**
 *
 *     withIdempotentExecution                    (manages cache reservation
 *       └─ withTransaction                        + replay + body-mismatch
 *          └─ (sets tenant context via            via shared helper)
 *             SELECT set_tenant_context($1))
 *             └─ withTenantContext                (RLS context binding)
 *                └─ withActorContext              (SI-010 GUC; REQUIRED —
 *                                                  the wrapper raises 42501
 *                                                  on missing actor binding
 *                                                  per migration 037 §1
 *                                                  lines 76-86)
 *                   ├─ withDbRole(tx,
 *                   │     'crisis_event_staff_reader', ...)
 *                   │  └─ SELECT patient_id, current_state
 *                   │     FROM crisis_event_current_state_v
 *                   │     WHERE crisis_event_id = $1    (404 envelope
 *                   │                                    branch if 0 rows)
 *                   └─ withDbRole(tx,
 *                        'crisis_acknowledger', ...)
 *                      └─ SELECT
 *                         record_crisis_acknowledgement_claim(...)
 *                         (RETURNS BIGINT lifecycle_transition_id;
 *                         natural idempotency on same-actor replay per
 *                         wrapper §1 lines 126-140; concurrent-claim
 *                         loser raises 40001 per lines 135-139)
 *             └─ emitCrisisAcknowledgedAudit(tx)  (Cat A FLOOR-020;
 *                                                  fails-closed atomically
 *                                                  with the wrapper write
 *                                                  via the shared tx)
 *
 * **Layer B authorization (DEFERRED — closest-available role-gate gap):**
 *   Per SI-022 §7, `crisis_acknowledger` is granted to clinician +
 *   on-call clinician + care-team. Until the JWT-role → DB-slice-role
 *   membership mapping lands (Phase A successor to SI-010 / SI-024.1),
 *   Sprint 2 PR 3 gates Layer B at the closest-available role —
 *   `clinician` — via `requireClinicianActorContext`.
 *
 *   Defense-in-depth: the DB layer fails closed regardless — the
 *   request's bound role (`telecheck_app_role`) does NOT inherit
 *   `crisis_acknowledger` privileges (NOINHERIT per migration 051), so
 *   `withDbRole`'s `SET LOCAL ROLE` is what gates privilege acquisition;
 *   bypassing the Fastify layer gate would still require an explicit
 *   `withDbRole('crisis_acknowledger', ...)` to reach the wrapper.
 *
 * **Crisis-specific platform-floor discipline (I-019):**
 *   - The acknowledge path MUST NEVER silently swallow errors. If the
 *     wrapper raises (40001 race-loss / from-state mismatch, 02000
 *     not-found, 42501 actor-not-bound) the handler re-throws so the
 *     surrounding transaction rolls back; the audit emit + wrapper SELECT
 *     either BOTH commit or BOTH roll back per FLOOR-020.
 *   - Rejection paths (Layer B 403, body validation 400, 404 not-found,
 *     409 race-loss / from-state-invalid) intentionally do NOT emit
 *     `crisis.acknowledged` because no lifecycle transition row was
 *     actually created. SI-022 §3 does NOT enumerate a
 *     `crisis.acknowledgement_rejected` audit action; rejection
 *     telemetry surfaces via the Fastify error log only.
 *
 * **Tenant-blind envelopes (I-025):**
 *   - 400 on body validation failure (only `payload` field validated;
 *     must be a JSON object or absent)
 *   - 403 on 42501 from SET LOCAL ROLE or wrapper LAYER B/C guard
 *     (R2 MED-1 closure pattern; envelope does not leak tenant_id)
 *   - 404 on staff-view 0-row read (same envelope whether the event
 *     genuinely doesn't exist or exists in another tenant)
 *   - 409 on wrapper SQLSTATE 40001 (concurrent-claim race-loss OR
 *     invalid from-state for acknowledgement — both surface to the
 *     caller as state-machine conflicts)
 *   - 404 on wrapper SQLSTATE 02000 (defensive — should be unreachable
 *     because the staff-view pre-fetch catches missing first; covers the
 *     race where the row was deleted between pre-fetch and wrapper call,
 *     which shouldn't happen against an append-only table but we map it
 *     to 404 for safety)
 *
 * Spec references:
 *   - SI-022 Crisis Response Slice v1.0 §3 normative AUDIT_EVENTS row 2
 *     (`crisis.acknowledged` Cat A, NOT sampled, P1 keyed by
 *     patient_id) + §5 endpoint surface
 *   - CDM v1.9 → v1.10 Amendment §3.3 normative landing (P-040)
 *   - State Machines v1.1 §3 triples #7 + #8 (detected → acknowledged
 *     OR escalated → acknowledged, both clinician_acknowledgement)
 *   - migration 037 §1 (record_crisis_acknowledgement_claim SECDEF +
 *     Layer A EXECUTE grant matrix locking the wrapper to
 *     `crisis_acknowledger` role)
 *   - migration 051 (Option B app-role acquisition foundation —
 *     telecheck_app_role NOINHERIT membership in both
 *     crisis_acknowledger AND crisis_event_staff_reader)
 *   - src/lib/with-db-role.ts (Option B per-tx SET LOCAL ROLE helper)
 *   - src/lib/idempotent-handler.ts (SI-006 PR-C reserve-then-execute)
 *   - src/lib/audit.ts (AUDIT_EVENTS v5.3 envelope emitter)
 *   - I-003 (audit append-only; bare suppression forbidden)
 *   - I-019 (crisis detection always-on platform-floor)
 *   - I-023 (three-layer tenant isolation: RLS + view predicate +
 *     tenant-context binding)
 *   - I-025 (tenant-blind error envelopes)
 *   - I-027 (audit records always carry tenant_id)
 *   - FLOOR-020 (Cat A fail-closed same-tx audit emission discipline)
 */

import type { FastifyReply, FastifyRequest } from 'fastify';

import { withActorContext } from '../../../../lib/actor-context-binding.js';
import {
  requireClinicianActorContext,
  resolveActorTenantIdForAudit,
} from '../../../../lib/auth-context.js';
import { withIdempotentExecution } from '../../../../lib/idempotent-handler.js';
import { withTenantContext } from '../../../../lib/rls.js';
import { requireTenantContext } from '../../../../lib/tenant-context.js';
import { withDbRole } from '../../../../lib/with-db-role.js';
import { emitCrisisAcknowledgedAudit } from '../../audit.js';
import { asCrisisEventId } from '../types.js';

// ---------------------------------------------------------------------------
// Path-param + body shape + validation
// ---------------------------------------------------------------------------

interface AcknowledgePathParams {
  id?: string;
}

/**
 * Wire body for POST /v0/crisis-events/:id/acknowledge. The wrapper's
 * `p_transition_payload JSONB DEFAULT NULL` parameter is the only
 * body-supplied input — `p_tenant_id` is sourced from tenant context,
 * `p_crisis_event_id` is sourced from the path. The payload is an
 * optional caller-supplied JSON object carrying claim-context metadata
 * (e.g., `claim_channel`, `triage_notes`); the wrapper stores it on the
 * lifecycle_transition row's `transition_payload` JSONB column without
 * further validation.
 *
 * Body is optional (handler accepts undefined / empty object); when
 * present, `payload` MUST be a JSON object (not array / string / number
 * / boolean / null) to match the JSONB column semantics + avoid
 * downstream surprise from a wrapped scalar.
 */
interface PostCrisisAcknowledgeBody {
  payload?: Record<string, unknown> | undefined;
}

/**
 * RFC 4122 UUID shape (case-insensitive hex; any variant). Mirrors PR 1
 * `UUID_PATTERN` — `crisis_event.id` is `UUID` per migration 033 §4.
 */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuidShape(raw: string): boolean {
  return UUID_PATTERN.test(raw);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return (
    v !== null &&
    typeof v === 'object' &&
    !Array.isArray(v) &&
    Object.getPrototypeOf(v) === Object.prototype
  );
}

// ---------------------------------------------------------------------------
// Error envelope helper
// ---------------------------------------------------------------------------

interface ErrorEnvelopeBody {
  error: { code: string; message: string; request_id: string };
}

function makeErrorEnvelope(reqId: string, code: string, message: string): ErrorEnvelopeBody {
  return { error: { code, message, request_id: reqId } };
}

/**
 * Service-error mapper passed to `withIdempotentExecution`. Maps the
 * canonical failures from the SECDEF wrapper to tenant-blind HTTP
 * envelopes per I-025.
 *
 * SQLSTATE map (per migration 037 §1):
 *   - 42501 → tenant-blind 403 (actor-not-bound OR tenant-scope-mismatch
 *     OR SET LOCAL ROLE elevation failure). Handled at the inner
 *     try/catch wrapping the entire withDbRole call — by the time this
 *     mapper runs, the 42501 has already been rethrown as a Fastify
 *     httpErrors.forbidden() and the global error envelope plugin
 *     formats it.
 *   - 02000 → tenant-blind 404 (wrapper's not-found path; defensive —
 *     should be unreachable because the staff-view pre-fetch catches
 *     missing first).
 *   - 40001 → tenant-blind 409 (concurrent-claim race-loss per wrapper
 *     §1 lines 135-139 OR invalid from-state for acknowledgement per
 *     §1 lines 143-147 — both are state-machine conflicts from the
 *     caller's perspective).
 */
function mapServiceError(err: unknown, reply: FastifyReply, reqId: string): boolean {
  if (err === null || typeof err !== 'object' || !('code' in err)) {
    return false;
  }
  const code = (err as { code?: unknown }).code;
  if (code === '02000') {
    void reply
      .code(404)
      .send(
        makeErrorEnvelope(
          reqId,
          'internal.resource.not_found',
          'No crisis event with the requested id exists for this tenant.',
        ),
      );
    return true;
  }
  if (code === '40001') {
    void reply
      .code(409)
      .send(
        makeErrorEnvelope(
          reqId,
          'internal.resource.conflict',
          'The crisis event cannot be acknowledged in its current state, ' +
            'or another actor has claimed the acknowledgement concurrently.',
        ),
      );
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Response view
// ---------------------------------------------------------------------------

/**
 * On 200 success the handler returns the lifecycle_transition_id of the
 * newly-inserted (or idempotently-replayed) `acknowledged` row, plus the
 * crisis_event_id for caller convenience. tenant_id / actor identity /
 * from_state are NOT echoed — the audit trail + the view query are the
 * canonical surfaces for those.
 */
interface PostCrisisAcknowledgeResponseView {
  crisis_event_id: string;
  lifecycle_transition_id: string;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * POST /v0/crisis-events/:id/acknowledge — clinician / care-team claims
 * a detected (or escalated) crisis event.
 *
 * Flow (9 phases):
 *   1. Resolve tenant context.
 *   2. Layer B closest-available role-gate (requireClinicianActorContext).
 *   3. Validate path :id (UUID shape).
 *   4. Parse + validate body (optional payload; if present, plain object).
 *   5. Resolve actor home-tenant for audit attribution.
 *   6. Enter withIdempotentExecution.
 *   7. Inside the idempotency body's tx: compose withTenantContext →
 *      withActorContext (REQUIRED for this wrapper — fail-closed on
 *      missing nonce) → withDbRole('crisis_event_staff_reader', ...) →
 *      SELECT patient_id + current_state from view (404 branch on 0 rows;
 *      same shape whether row genuinely missing or in another tenant per
 *      I-025).
 *   8. Same tx, second withDbRole('crisis_acknowledger', ...) → SELECT
 *      record_crisis_acknowledgement_claim(tenant_id, crisis_event_id,
 *      payload). Map 42501 → tenant-blind 403 via the canonical R2 MED-1
 *      closure pattern (catch wraps entire withDbRole call).
 *   9. Emit Cat A crisis.acknowledged audit in the same tx
 *      (FLOOR-020 fail-closed).
 *
 * Returns 200 + { crisis_event_id, lifecycle_transition_id } on
 * success; 400 / 403 / 404 / 409 on mapped failures; 500 (with default
 * envelope) on unmapped failures via the global error plugin.
 */
export async function postCrisisAcknowledgeHandler(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<unknown> {
  // Phase 1 — tenant context.
  const ctx = requireTenantContext(req);

  // Phase 2 — LAYER B authorization (closest-available role-gate).
  const actor = requireClinicianActorContext(req);

  // Phase 3 — path :id validation.
  const params = (req.params ?? {}) as AcknowledgePathParams;
  const crisisEventIdRaw = params.id;
  if (typeof crisisEventIdRaw !== 'string' || !isUuidShape(crisisEventIdRaw)) {
    return reply
      .code(400)
      .send(
        makeErrorEnvelope(
          req.id,
          'internal.request.invalid',
          'Invalid acknowledge path: :id must be a UUID.',
        ),
      );
  }

  // Phase 4 — body validation. Body is optional. When present, the only
  // accepted shape is `{ payload?: object }`. A non-object `payload`
  // (array / scalar / null) is rejected.
  const body = (req.body ?? {}) as PostCrisisAcknowledgeBody;
  if ('payload' in body && body.payload !== undefined && !isPlainObject(body.payload)) {
    return reply
      .code(400)
      .send(
        makeErrorEnvelope(
          req.id,
          'internal.request.invalid',
          'Invalid acknowledge body: when `payload` is present it must be a ' +
            'JSON object (not array, string, number, boolean, or null).',
        ),
      );
  }
  const transitionPayload: Record<string, unknown> | null = body.payload ?? null;

  // Phase 5 — resolve actor home-tenant for audit attribution.
  const actorTenantId = resolveActorTenantIdForAudit(req, ctx.tenantId);

  // Phase 6+7+8+9 — idempotency wrap + tx composition + pre-fetch +
  // wrapper call + 42501 mapping + same-tx audit emission.
  return withIdempotentExecution<PostCrisisAcknowledgeResponseView | ErrorEnvelopeBody>(
    req,
    reply,
    mapServiceError,
    async (tx) => {
      const composition = async (): Promise<
        { kind: 'ok'; response: PostCrisisAcknowledgeResponseView } | { kind: 'not_found' }
      > => {
        // Phase 7 — staff-view pre-fetch. Captures patient_id (audit P1
        // partition key) AND current_state (audit from_state echo).
        // Tenant-scope via view RLS + bound tenant_context — 0 rows is
        // tenant-blind 404 per I-025.
        const preFetch = async (): Promise<{ patientId: string; currentState: string } | null> => {
          try {
            return await withDbRole(tx, 'crisis_event_staff_reader', async () => {
              const result = await tx.query<{
                patient_id: string;
                current_state: string;
              }>(
                'SELECT patient_id, current_state FROM crisis_event_current_state_v ' +
                  'WHERE crisis_event_id = $1',
                [crisisEventIdRaw],
              );
              const row = result.rows[0];
              if (row === undefined) return null;
              return { patientId: row.patient_id, currentState: row.current_state };
            });
          } catch (err) {
            if (
              typeof err === 'object' &&
              err !== null &&
              'code' in err &&
              (err as { code?: unknown }).code === '42501'
            ) {
              throw req.server.httpErrors.forbidden('Insufficient scope for this request.');
            }
            throw err;
          }
        };

        const preFetched = await preFetch();
        if (preFetched === null) {
          return { kind: 'not_found' };
        }
        const { patientId, currentState } = preFetched;

        // Phase 8 — wrapper SELECT under crisis_acknowledger.
        // R2 MED-1 closure: try/catch wraps the ENTIRE withDbRole call
        // so 42501 from EITHER SET LOCAL ROLE OR the wrapper's
        // LAYER B/C guard maps to tenant-blind 403.
        const runAcknowledge = async (): Promise<string> => {
          try {
            return await withDbRole(tx, 'crisis_acknowledger', async () => {
              const result = await tx.query<{ lifecycle_transition_id: string }>(
                'SELECT record_crisis_acknowledgement_claim($1, $2, $3) ' +
                  'AS lifecycle_transition_id',
                [ctx.tenantId, crisisEventIdRaw, transitionPayload],
              );
              const row = result.rows[0];
              if (row === undefined) {
                throw new Error(
                  'record_crisis_acknowledgement_claim returned no row; ' +
                    'wrapper-contract violation.',
                );
              }
              return row.lifecycle_transition_id;
            });
          } catch (err) {
            if (
              typeof err === 'object' &&
              err !== null &&
              'code' in err &&
              (err as { code?: unknown }).code === '42501'
            ) {
              throw req.server.httpErrors.forbidden('Insufficient scope for this request.');
            }
            throw err;
          }
        };

        const lifecycleTransitionId = await runAcknowledge();

        // Phase 9 — Cat A crisis.acknowledged audit emission in the SAME
        // transaction. Per FLOOR-020 + I-003 any audit-emit failure MUST
        // propagate (no bare try/catch) — a partial commit that leaves a
        // lifecycle_transition row without its audit is a platform-floor
        // violation.
        //
        // from_state narrowing: by the time control reaches here the
        // wrapper has accepted current_state as a valid from-state
        // (detected OR escalated per migration 037 §1 line 143). Any
        // other value would have surfaced as 40001 from the wrapper (or
        // the same-actor idempotent-replay path, which returns the
        // existing transition_id) BEFORE this emit. Defensive narrowing:
        // anything that is not literally `escalated` is recorded as
        // `detected` — the canonical post-incident reconstruction
        // surfaces any anomaly via the join to lifecycle_transition.
        const auditFromState: 'detected' | 'escalated' =
          currentState === 'escalated' ? 'escalated' : 'detected';

        await emitCrisisAcknowledgedAudit(
          {
            tenantId: ctx.tenantId,
            actorAccountId: actor.accountId,
            actorTenantId,
            countryOfCare: actor.countryOfCare,
            crisisEventId: asCrisisEventId(crisisEventIdRaw),
            targetPatientId: patientId,
            lifecycleTransitionId,
            fromState: auditFromState,
          },
          tx,
        );

        return {
          kind: 'ok',
          response: {
            crisis_event_id: crisisEventIdRaw,
            lifecycle_transition_id: lifecycleTransitionId,
          },
        };
      };

      // Phase 7+8+9 inner — bind SI-010 actor context (the wrapper
      // REQUIRES it per migration 037 §1 lines 76-86; if the nonce is
      // undefined the wrapper raises 42501 → tenant-blind 403, which is
      // correct behavior in deployments lacking SI-010 binding —
      // acknowledgement is unavailable without actor attribution).
      const outcome = await withTenantContext<
        { kind: 'ok'; response: PostCrisisAcknowledgeResponseView } | { kind: 'not_found' }
      >(tx, ctx.tenantId, async () => {
        if (req.actorNonce !== undefined) {
          return withActorContext(tx, req.actorNonce, composition);
        }
        return composition();
      });

      if (outcome.kind === 'not_found') {
        return {
          status: 404,
          view: makeErrorEnvelope(
            req.id,
            'internal.resource.not_found',
            'No crisis event with the requested id exists for this tenant.',
          ),
        };
      }
      return { status: 200, view: outcome.response };
    },
  );
}
