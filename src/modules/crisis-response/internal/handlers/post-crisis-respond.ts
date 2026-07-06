/**
 * crisis-response/internal/handlers/post-crisis-respond.ts — clinician
 * records first-response on an acknowledged crisis event (calls SECDEF
 * wrapper `record_crisis_response()` from migration 037 §2, emits Cat A
 * `crisis.responded` audit in the same atomic transaction, and returns
 * the resulting lifecycle_transition_id).
 *
 * Endpoint: POST /v0/crisis-events/:id/respond
 *
 * **Sprint 2 PR 4 — the THIRD write-path handler in the Crisis Response
 * slice (first of two mid-lifecycle handlers in this PR).** Lands
 * alongside `POST /v0/crisis-events/:id/resolve` (also this PR). The
 * branch is based on `main` (NOT on PR 2 initiate or PR 3 acknowledge,
 * both of which are parked [CODEX-PENDING]); when those merge, the
 * union of all four handlers + the routes.ts mounts is resolved at
 * conflict-merge time.
 *
 * Mirrors PR 3's canonical composition stack (acknowledge pattern):
 *   - body shape: wrapper signature is `(p_tenant_id TEXT,
 *     p_crisis_event_id UUID, p_transition_payload JSONB DEFAULT NULL)`.
 *     `p_tenant_id` is sourced from tenant context; `p_crisis_event_id`
 *     is sourced from path `:id`; only `p_transition_payload` is
 *     body-supplied (optional `{ payload?: object | null }`).
 *   - patient_id resolution for the audit: the wrapper RETURNS BIGINT
 *     (the transition_id) — it does NOT echo patient_id. The audit
 *     envelope MUST carry `target_patient_id` per the P1 audit
 *     partitioning rule (SI-022 §3 line 3 + I-027). The handler
 *     resolves patient_id by issuing a side SELECT against
 *     `crisis_event_current_state_v` under
 *     `withDbRole('crisis_event_staff_reader', ...)` inside the SAME tx
 *     BEFORE the wrapper SELECT — that read also serves as a
 *     tenant-scope guard (view's RLS + tenant-context binding forces
 *     the row to belong to the request tenant, returning 0 rows on
 *     cross-tenant or missing). 0-row read maps to tenant-blind 404
 *     per I-025 BEFORE the wrapper is ever called.
 *
 * **Composition stack (Option B per `src/lib/with-db-role.ts`
 * §preconditions; same as PR 3):**
 *
 *     withIdempotentExecution                    (manages cache reservation
 *       └─ withTransaction                        + replay + body-mismatch
 *          └─ (sets tenant context via            via shared helper)
 *             SELECT set_tenant_context($1))
 *             └─ withTenantContext                (RLS context binding)
 *                └─ withActorContext              (SI-010 GUC; REQUIRED —
 *                                                  the wrapper raises 42501
 *                                                  on missing actor binding
 *                                                  per migration 037 §2
 *                                                  lines 209-217)
 *                   ├─ withDbRole(tx,
 *                   │     'crisis_event_staff_reader', ...)
 *                   │  └─ SELECT patient_id
 *                   │     FROM crisis_event_current_state_v
 *                   │     WHERE crisis_event_id = $1    (404 envelope
 *                   │                                    branch if 0 rows)
 *                   └─ withDbRole(tx,
 *                        'crisis_responder', ...)
 *                      └─ SELECT
 *                         record_crisis_response(...)
 *                         (RETURNS BIGINT lifecycle_transition_id;
 *                         natural idempotency on same-actor replay per
 *                         wrapper §2 lines 244-256)
 *             └─ claimResourceLifecycleAuditSlot(tx) (dedupe: skip the
 *                                                  emit on wrapper-level
 *                                                  replay — keyed on the
 *                                                  transition id; Codex R1
 *                                                  #202 finding 1)
 *                └─ if claimed:
 *                   └─ emitCrisisRespondedAudit(tx) (Cat A FLOOR-020;
 *                                                  fails-closed atomically
 *                                                  with the wrapper write
 *                                                  via the shared tx)
 *
 * **Layer B authorization (DEFERRED — closest-available role-gate gap):**
 *   Per SI-022 §7, `crisis_responder` is granted to clinician + on-call
 *   clinician. Until the JWT-role → DB-slice-role membership mapping
 *   lands (Phase A successor to SI-010 / SI-024.1), Sprint 2 PR 4 gates
 *   Layer B at the closest-available role — `clinician` — via
 *   `requireClinicianActorContext`.
 *
 *   Defense-in-depth: the DB layer fails closed regardless — the
 *   request's bound role (`telecheck_app_role`) does NOT inherit
 *   `crisis_responder` privileges (NOINHERIT per migration 051), so
 *   `withDbRole`'s `SET LOCAL ROLE` is what gates privilege
 *   acquisition; bypassing the Fastify layer gate would still require
 *   an explicit `withDbRole('crisis_responder', ...)` to reach the
 *   wrapper.
 *
 * **Crisis-specific platform-floor discipline (I-019):**
 *   - The response path MUST NEVER silently swallow errors. If the
 *     wrapper raises (40001 race-loss, 40001 from-state mismatch,
 *     02000 not-found, 42501 actor-not-bound) the handler re-throws so
 *     the surrounding transaction rolls back; the audit emit + wrapper
 *     INSERT either BOTH commit or BOTH roll back per FLOOR-020.
 *   - Rejection paths (Layer B 403, body validation 400, 404 not-found,
 *     409 race-loss / from-state-invalid) intentionally do NOT emit
 *     `crisis.responded` because no lifecycle transition row was
 *     actually created. SI-022 §3 does NOT enumerate a
 *     `crisis.response_rejected` audit action; rejection telemetry
 *     surfaces via the Fastify error log only.
 *
 * **Tenant-blind envelopes (I-025):**
 *   - 400 on body validation failure (only `payload` field validated;
 *     must be a JSON object or absent)
 *   - 403 on 42501 from SET LOCAL ROLE or wrapper LAYER B/C guard
 *     (R2 MED-1 closure pattern; envelope does not leak tenant_id)
 *   - 404 on staff-view 0-row read (same envelope whether the event
 *     genuinely doesn't exist or exists in another tenant)
 *   - 409 on wrapper SQLSTATE 40001 (race-loss to concurrent responder
 *     OR invalid from-state for response — both surface to the caller
 *     as state-machine conflicts)
 *   - 404 on wrapper SQLSTATE 02000 (defensive — should be unreachable
 *     because the staff-view pre-fetch catches missing first; covers
 *     the race where the row was deleted between pre-fetch and wrapper
 *     call, which shouldn't happen against an append-only table but
 *     we map it to 404 for safety)
 *
 * Spec references:
 *   - SI-022 Crisis Response Slice v1.0 §3 normative AUDIT_EVENTS row
 *     3 (`crisis.responded` Cat A, NOT sampled, P1 keyed by
 *     patient_id) + §5 endpoint surface
 *   - CDM v1.9 → v1.10 Amendment §3.4 normative landing (P-040)
 *   - State Machines v1.1 §3 triple #9 (acknowledged → responded
 *     clinician_response)
 *   - migration 037 §2 (record_crisis_response SECDEF + Layer A
 *     EXECUTE grant matrix locking the wrapper to `crisis_responder`
 *     role)
 *   - migration 051 (Option B app-role acquisition foundation —
 *     telecheck_app_role NOINHERIT membership in both
 *     crisis_responder AND crisis_event_staff_reader)
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
import { claimResourceLifecycleAuditSlot } from '../../../../lib/audit-dedupe.js';
import {
  requireClinicianActorContext,
  resolveActorTenantIdForAudit,
} from '../../../../lib/auth-context.js';
import { withIdempotentExecution } from '../../../../lib/idempotent-handler.js';
import { withTenantContext } from '../../../../lib/rls.js';
import { requireTenantContext } from '../../../../lib/tenant-context.js';
import { withDbRole } from '../../../../lib/with-db-role.js';
import { emitCrisisRespondedAudit } from '../../audit.js';
import { asCrisisEventId } from '../types.js';

// ---------------------------------------------------------------------------
// Path-param + body shape + validation
// ---------------------------------------------------------------------------

interface RespondPathParams {
  id?: string;
}

/**
 * Wire body for POST /v0/crisis-events/:id/respond. The wrapper's
 * `p_transition_payload JSONB DEFAULT NULL` parameter is the only
 * body-supplied input — `p_tenant_id` is sourced from tenant context,
 * `p_crisis_event_id` is sourced from the path. The payload is an
 * optional caller-supplied JSON object carrying clinical-context
 * metadata (e.g., `response_modality`, `intervention_summary`, free-text
 * notes); the wrapper stores it on the lifecycle_transition row's
 * `transition_payload` JSONB column without further validation.
 *
 * Body is optional (handler accepts undefined / empty object); when
 * present, `payload` MUST be a JSON object (not array / string / number
 * / boolean / null) to match the JSONB column semantics + avoid
 * downstream surprise from a wrapped scalar.
 */
interface PostCrisisRespondBody {
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
 * SQLSTATE map (per migration 037 §2):
 *   - 42501 → tenant-blind 403 (actor-not-bound OR tenant-scope-mismatch
 *     OR SET LOCAL ROLE elevation failure). Handled at the inner
 *     try/catch wrapping the entire withDbRole call — by the time this
 *     mapper runs, the 42501 has already been rethrown as a Fastify
 *     httpErrors.forbidden() and the global error envelope plugin
 *     formats it.
 *   - 02000 → tenant-blind 404 (wrapper's not-found path; defensive —
 *     should be unreachable because the staff-view pre-fetch catches
 *     missing first).
 *   - 40001 → tenant-blind 409 (concurrent responder race-loss OR
 *     invalid from-state for response — both are state-machine
 *     conflicts from the caller's perspective; wrapper §2 lines 244-264
 *     are the two RAISE EXCEPTION sites).
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
          'The crisis event cannot be responded to in its current state, ' +
            'or another responder has recorded a response concurrently.',
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
 * newly-inserted (or idempotently-replayed) `responded` row, plus the
 * crisis_event_id for caller convenience. tenant_id / actor identity /
 * from_state are NOT echoed — the audit trail + the view query are the
 * canonical surfaces for those.
 */
interface PostCrisisRespondResponseView {
  crisis_event_id: string;
  lifecycle_transition_id: string;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * POST /v0/crisis-events/:id/respond — clinician records first-response
 * on an acknowledged crisis event.
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
 *      SELECT patient_id from view (404 branch on 0 rows; same shape
 *      whether row genuinely missing or in another tenant per I-025).
 *   8. Same tx, second withDbRole('crisis_responder', ...) → SELECT
 *      record_crisis_response(tenant_id, crisis_event_id, payload).
 *      Map 42501 → tenant-blind 403 via the canonical R2 MED-1 closure
 *      pattern (catch wraps entire withDbRole call).
 *   9. Emit Cat A crisis.responded audit in the same tx
 *      (FLOOR-020 fail-closed).
 *
 * Returns 200 + { crisis_event_id, lifecycle_transition_id } on
 * success; 400 / 403 / 404 / 409 on mapped failures; 500 (with default
 * envelope) on unmapped failures via the global error plugin.
 */
export async function postCrisisRespondHandler(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<unknown> {
  // Phase 1 — tenant context.
  const ctx = requireTenantContext(req);

  // Phase 2 — LAYER B authorization (closest-available role-gate).
  const actor = requireClinicianActorContext(req);

  // Phase 3 — path :id validation.
  const params = (req.params ?? {}) as RespondPathParams;
  const crisisEventIdRaw = params.id;
  if (typeof crisisEventIdRaw !== 'string' || !isUuidShape(crisisEventIdRaw)) {
    return reply
      .code(400)
      .send(
        makeErrorEnvelope(
          req.id,
          'internal.request.invalid',
          'Invalid respond path: :id must be a UUID.',
        ),
      );
  }

  // Phase 4 — body validation. Body is optional. When present, the root
  // MUST be a JSON object whose only accepted member is `payload?: object`.
  // A non-object root (array / scalar) is rejected up front (Codex R1 #202
  // finding 2 — `'payload' in body` on a scalar throws a TypeError and
  // bypasses the 400 envelope); a non-object `payload` is then rejected.
  const rawBody: unknown = req.body ?? {};
  if (!isPlainObject(rawBody)) {
    return reply
      .code(400)
      .send(
        makeErrorEnvelope(
          req.id,
          'internal.request.invalid',
          'Invalid respond body: request body must be a JSON object ' +
            '(not array, string, number, or boolean).',
        ),
      );
  }
  const body = rawBody as PostCrisisRespondBody;
  if ('payload' in body && body.payload !== undefined && !isPlainObject(body.payload)) {
    return reply
      .code(400)
      .send(
        makeErrorEnvelope(
          req.id,
          'internal.request.invalid',
          'Invalid respond body: when `payload` is present it must be a ' +
            'JSON object (not array, string, number, boolean, or null).',
        ),
      );
  }
  const transitionPayload: Record<string, unknown> | null = body.payload ?? null;

  // Phase 5 — resolve actor home-tenant for audit attribution.
  const actorTenantId = resolveActorTenantIdForAudit(req, ctx.tenantId);

  // Phase 6+7+8+9 — idempotency wrap + tx composition + pre-fetch +
  // wrapper call + 42501 mapping + same-tx audit emission.
  return withIdempotentExecution<PostCrisisRespondResponseView | ErrorEnvelopeBody>(
    req,
    reply,
    mapServiceError,
    async (tx) => {
      const composition = async (): Promise<
        { kind: 'ok'; response: PostCrisisRespondResponseView } | { kind: 'not_found' }
      > => {
        // Phase 7 — staff-view pre-fetch under crisis_event_staff_reader
        // to resolve patient_id for the audit envelope. Tenant-scope is
        // enforced by the view's RLS predicate + the bound
        // tenant_context — 0 rows means missing OR cross-tenant per
        // I-025, both mapping to 404 with the same envelope.
        const preFetch = async (): Promise<string | null> => {
          try {
            return await withDbRole(tx, 'crisis_event_staff_reader', async () => {
              const result = await tx.query<{ patient_account_id: string }>(
                'SELECT patient_account_id FROM crisis_event_current_state_v ' +
                  'WHERE crisis_event_id = $1',
                [crisisEventIdRaw],
              );
              const row = result.rows[0];
              return row?.patient_account_id ?? null;
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

        const patientId = await preFetch();
        if (patientId === null) {
          return { kind: 'not_found' };
        }

        // Phase 8 — wrapper SELECT under crisis_responder.
        // R2 MED-1 closure: try/catch wraps the ENTIRE withDbRole call
        // so 42501 from EITHER SET LOCAL ROLE OR the wrapper's
        // LAYER B/C guard maps to tenant-blind 403.
        const runRespond = async (): Promise<string> => {
          try {
            return await withDbRole(tx, 'crisis_responder', async () => {
              const result = await tx.query<{ lifecycle_transition_id: string }>(
                'SELECT record_crisis_response($1, $2, $3) ' + 'AS lifecycle_transition_id',
                [ctx.tenantId, crisisEventIdRaw, transitionPayload],
              );
              const row = result.rows[0];
              if (row === undefined) {
                throw new Error(
                  'record_crisis_response returned no row; ' + 'wrapper-contract violation.',
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

        const lifecycleTransitionId = await runRespond();

        // Phase 9 — Cat A crisis.responded audit emission in the SAME
        // transaction, gated by claimResourceLifecycleAuditSlot so a
        // wrapper-level idempotent replay (same actor, different
        // Idempotency-Key, latest already `responded`) does NOT append a
        // duplicate Cat A row (Codex R1 #202 finding 1; mirrors the PR3
        // acknowledge dedupe). The dedupe key is anchored on the
        // wrapper-returned lifecycle_transition_id — the wrapper returns
        // the SAME id on same-actor replay and a fresh id for a distinct
        // transition. Per FLOOR-020 + I-003 the emit inside the claimed
        // branch is NOT wrapped in try/catch — a throw propagates so the
        // tx rolls back (no marker survives a failed emit).
        const auditClaimed = await claimResourceLifecycleAuditSlot(tx, {
          tenantId: ctx.tenantId,
          resourceType: 'crisis_event_lifecycle_transition',
          resourceId: lifecycleTransitionId,
          auditAction: 'crisis.responded',
        });
        if (auditClaimed) {
          await emitCrisisRespondedAudit(
            {
              tenantId: ctx.tenantId,
              actorAccountId: actor.accountId,
              actorTenantId,
              countryOfCare: actor.countryOfCare,
              crisisEventId: asCrisisEventId(crisisEventIdRaw),
              targetPatientId: patientId,
              lifecycleTransitionId,
            },
            tx,
          );
        }

        return {
          kind: 'ok',
          response: {
            crisis_event_id: crisisEventIdRaw,
            lifecycle_transition_id: lifecycleTransitionId,
          },
        };
      };

      // Phase 7+8+9 inner — bind SI-010 actor context (the wrapper
      // REQUIRES it per migration 037 §2 lines 209-217; if the nonce is
      // undefined the wrapper raises 42501 → tenant-blind 403, which is
      // correct behavior in deployments lacking SI-010 binding —
      // response is unavailable without actor attribution).
      const outcome = await withTenantContext<
        { kind: 'ok'; response: PostCrisisRespondResponseView } | { kind: 'not_found' }
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
