/**
 * crisis-response/internal/handlers/post-crisis-resolve.ts — clinician
 * marks a crisis event resolved from EITHER `responded` OR `escalated`
 * (calls SECDEF wrapper `record_crisis_resolution()` from migration 037
 * §3, emits Cat A `crisis.resolved` audit in the same atomic transaction,
 * and returns the resulting lifecycle_transition_id).
 *
 * Endpoint: POST /v0/crisis-events/:id/resolve
 *
 * **Sprint 2 PR 4 — the FOURTH write-path handler in the Crisis
 * Response slice (second of two mid-lifecycle handlers in this PR).**
 * Lands alongside `POST /v0/crisis-events/:id/respond` (also this PR).
 * The branch is based on `main` (NOT on PR 2 initiate or PR 3
 * acknowledge, both of which are parked [CODEX-PENDING]); when those
 * merge, the union of all four handlers + the routes.ts mounts is
 * resolved at conflict-merge time.
 *
 * Mirrors the respond handler with one adaptation: resolution has TWO
 * allowed from-states per migration 037 §3 + State Machines v1.1 §3
 * triples #10 + #11:
 *   - `responded → resolved clinician_resolution` (triple #10)
 *   - `escalated → resolved clinician_resolution` (triple #11)
 *
 * The audit envelope carries `detail.from_state` explicitly so
 * post-incident reconstruction can identify which lifecycle path was
 * taken without re-querying. The handler reads the from-state back AFTER
 * the wrapper from the committed `crisis_event_lifecycle_transition` row
 * (keyed by the wrapper-returned id) — NOT from the pre-lock pre-fetch.
 * The pre-fetch's `current_state` is read before the wrapper takes its
 * SELECT FOR UPDATE lock and is NOT authoritative: a
 * responded_no_resolution_timeout sweep can transition responded→escalated
 * in the pre-fetch→wrapper-lock window, so the committed transition row is
 * the only authority on the from_state the wrapper actually recorded
 * (Codex R1 #202 — same closure as PR3 acknowledge finding 1).
 *
 * The wrapper's from-state validation runs under SELECT FOR UPDATE on
 * the parent crisis_event row (migration 037 §3 lines 333-339), so a
 * concurrent transition between the pre-fetch and the wrapper SELECT
 * is detected at the wrapper (raises SQLSTATE 40001 with
 * "cannot resolve from state X") and surfaces as tenant-blind 409. The
 * pre-fetch's role is purely (a) patient_id resolution for the audit
 * envelope and (b) tenant-scope guard via the view's RLS; the wrapper is
 * the authority on transition validity and the committed transition row
 * is the authority on the audit from_state.
 *
 * **Composition stack (Option B per `src/lib/with-db-role.ts`
 * §preconditions; same as respond handler):**
 *
 *     withIdempotentExecution                    (manages cache reservation
 *       └─ withTransaction                        + replay + body-mismatch
 *          └─ (sets tenant context via            via shared helper)
 *             SELECT set_tenant_context($1))
 *             └─ withTenantContext                (RLS context binding)
 *                └─ withActorContext              (SI-010 GUC; REQUIRED —
 *                                                  the wrapper raises 42501
 *                                                  on missing actor binding
 *                                                  per migration 037 §3
 *                                                  lines 315-323)
 *                   ├─ withDbRole(tx,
 *                   │     'crisis_event_staff_reader', ...)
 *                   │  └─ SELECT patient_id
 *                   │     FROM crisis_event_current_state_v
 *                   │     WHERE crisis_event_id = $1    (404 envelope
 *                   │                                    branch if 0 rows)
 *                   └─ withDbRole(tx,
 *                        'crisis_resolver', ...)
 *                      └─ SELECT
 *                         record_crisis_resolution(...)
 *                         (RETURNS BIGINT lifecycle_transition_id;
 *                         natural idempotency on same-actor replay per
 *                         wrapper §3 lines 351-363)
 *             └─ claimResourceLifecycleAuditSlot(tx) (dedupe: skip the
 *                                                  emit on wrapper-level
 *                                                  replay — keyed on the
 *                                                  transition id; Codex R1
 *                                                  #202 finding 1)
 *                └─ if claimed:
 *                   ├─ withDbRole(tx, 'crisis_event_staff_reader')
 *                   │  └─ SELECT from_state
 *                   │     FROM crisis_event_lifecycle_transition
 *                   │     WHERE id = <wrapper-returned id>
 *                   └─ emitCrisisResolvedAudit(tx) (Cat A FLOOR-020;
 *                                                  fails-closed atomically
 *                                                  with the wrapper write
 *                                                  via the shared tx)
 *
 * **From-state read-back authority:** the audit's `from_state` is read
 * back from the committed `crisis_event_lifecycle_transition` row (by the
 * wrapper-returned id), NOT from the pre-lock pre-fetch. The committed row
 * carries the exact `from_state` the wrapper recorded under its SELECT FOR
 * UPDATE lock — one of `responded` or `escalated` for a valid resolution
 * (migration 037 §3). The read-back guard throws if it ever surfaces any
 * other value (a wrapper-contract violation) rather than emitting a
 * mislabeled FLOOR-020 audit. This closes the TOCTOU race the pre-fetch
 * could not: a responded_no_resolution_timeout sweep transitioning
 * responded→escalated between the pre-fetch and the wrapper lock would
 * make the pre-fetch's `current_state` ('responded') disagree with the
 * from_state the wrapper actually recorded ('escalated') — the read-back
 * always matches the wrapper (Codex R1 #202).
 *
 * **Layer B authorization (DEFERRED — closest-available role-gate gap):**
 *   Per SI-022 §7, `crisis_resolver` is granted to clinician + on-call
 *   clinician. Until the JWT-role → DB-slice-role membership mapping
 *   lands (Phase A successor to SI-010 / SI-024.1), Sprint 2 PR 4 gates
 *   Layer B at the closest-available role — `clinician` — via
 *   `requireClinicianActorContext`.
 *
 *   Defense-in-depth: NOINHERIT app-role membership per migration 051
 *   forces explicit `withDbRole('crisis_resolver', ...)` for privilege
 *   acquisition; bypassing the Fastify gate still cannot reach the
 *   wrapper without an explicit elevation.
 *
 * **Crisis-specific platform-floor discipline (I-019):**
 *   - The resolution path MUST NEVER silently swallow errors. If the
 *     wrapper raises (40001 race-loss, 40001 from-state mismatch,
 *     02000 not-found, 42501 actor-not-bound) the handler re-throws so
 *     the surrounding transaction rolls back; the audit emit + wrapper
 *     INSERT either BOTH commit or BOTH roll back per FLOOR-020.
 *   - Rejection paths (Layer B 403, body validation 400, 404 not-found,
 *     409 race-loss / from-state-invalid) intentionally do NOT emit
 *     `crisis.resolved` because no lifecycle transition row was
 *     actually created. SI-022 §3 does NOT enumerate a
 *     `crisis.resolution_rejected` audit action.
 *
 * **Tenant-blind envelopes (I-025):**
 *   - 400 on body validation failure
 *   - 403 on 42501 (R2 MED-1 closure pattern)
 *   - 404 on staff-view 0-row read (same envelope whether missing or
 *     cross-tenant)
 *   - 409 on wrapper SQLSTATE 40001 (race-loss to concurrent resolver
 *     OR invalid from-state for resolution)
 *   - 404 on wrapper SQLSTATE 02000 (defensive)
 *
 * Spec references:
 *   - SI-022 Crisis Response Slice v1.0 §3 normative AUDIT_EVENTS row
 *     4 (`crisis.resolved` Cat A, NOT sampled, P1 keyed by patient_id)
 *     + §5 endpoint surface
 *   - CDM v1.9 → v1.10 Amendment §3.5 normative landing (P-040)
 *   - State Machines v1.1 §3 triples #10 + #11 (responded → resolved /
 *     escalated → resolved clinician_resolution)
 *   - migration 037 §3 (record_crisis_resolution SECDEF + Layer A
 *     EXECUTE grant matrix locking the wrapper to `crisis_resolver`
 *     role)
 *   - migration 051 (Option B app-role acquisition foundation —
 *     telecheck_app_role NOINHERIT membership in both crisis_resolver
 *     AND crisis_event_staff_reader)
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
import { emitCrisisResolvedAudit } from '../../audit.js';
import { asCrisisEventId } from '../types.js';

// ---------------------------------------------------------------------------
// Path-param + body shape + validation
// ---------------------------------------------------------------------------

interface ResolvePathParams {
  id?: string;
}

/**
 * Wire body for POST /v0/crisis-events/:id/resolve. Same shape as
 * respond + acknowledge — only `p_transition_payload` is body-supplied
 * (optional plain object).
 */
interface PostCrisisResolveBody {
  payload?: Record<string, unknown> | undefined;
}

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
 * Service-error mapper passed to `withIdempotentExecution`. Same shape
 * as the respond handler's mapper — per migration 037 §3 the wrapper's
 * SQLSTATE surface is identical to §2 (42501 / 02000 / 40001).
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
          'The crisis event cannot be resolved from its current state, ' +
            'or another resolver has recorded a resolution concurrently.',
        ),
      );
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Response view
// ---------------------------------------------------------------------------

interface PostCrisisResolveResponseView {
  crisis_event_id: string;
  lifecycle_transition_id: string;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * POST /v0/crisis-events/:id/resolve — clinician marks a crisis event
 * resolved from either `responded` or `escalated`.
 *
 * Flow (9 phases — identical to respond handler with one adaptation:
 * the pre-fetch additionally captures `current_state` for the audit
 * envelope's `detail.from_state` field):
 *   1. Resolve tenant context.
 *   2. Layer B closest-available role-gate (requireClinicianActorContext).
 *   3. Validate path :id (UUID shape).
 *   4. Parse + validate body (optional payload).
 *   5. Resolve actor home-tenant for audit attribution.
 *   6. Enter withIdempotentExecution.
 *   7. Inside the idempotency body's tx: compose withTenantContext →
 *      withActorContext → withDbRole('crisis_event_staff_reader', ...)
 *      → SELECT patient_id, current_state from view (404 branch on 0
 *      rows; current_state echoed into audit detail).
 *   8. Same tx, second withDbRole('crisis_resolver', ...) → SELECT
 *      record_crisis_resolution(...) with R2 MED-1 closure on 42501.
 *   9. Emit Cat A crisis.resolved audit in the same tx with explicit
 *      from_state.
 *
 * Returns 200 + { crisis_event_id, lifecycle_transition_id } on
 * success; 400 / 403 / 404 / 409 on mapped failures; 500 (default
 * envelope) on unmapped failures.
 */
export async function postCrisisResolveHandler(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<unknown> {
  // Phase 1 — tenant context.
  const ctx = requireTenantContext(req);

  // Phase 2 — LAYER B authorization.
  const actor = requireClinicianActorContext(req);

  // Phase 3 — path :id validation.
  const params = (req.params ?? {}) as ResolvePathParams;
  const crisisEventIdRaw = params.id;
  if (typeof crisisEventIdRaw !== 'string' || !isUuidShape(crisisEventIdRaw)) {
    return reply
      .code(400)
      .send(
        makeErrorEnvelope(
          req.id,
          'internal.request.invalid',
          'Invalid resolve path: :id must be a UUID.',
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
          'Invalid resolve body: request body must be a JSON object ' +
            '(not array, string, number, or boolean).',
        ),
      );
  }
  const body = rawBody as PostCrisisResolveBody;
  if ('payload' in body && body.payload !== undefined && !isPlainObject(body.payload)) {
    return reply
      .code(400)
      .send(
        makeErrorEnvelope(
          req.id,
          'internal.request.invalid',
          'Invalid resolve body: when `payload` is present it must be a ' +
            'JSON object (not array, string, number, boolean, or null).',
        ),
      );
  }
  const transitionPayload: Record<string, unknown> | null = body.payload ?? null;

  // Phase 5 — resolve actor home-tenant for audit attribution.
  const actorTenantId = resolveActorTenantIdForAudit(req, ctx.tenantId);

  // Phase 6+7+8+9 — idempotency wrap + tx composition + pre-fetch +
  // wrapper call + 42501 mapping + same-tx audit emission.
  return withIdempotentExecution<PostCrisisResolveResponseView | ErrorEnvelopeBody>(
    req,
    reply,
    mapServiceError,
    async (tx) => {
      const composition = async (): Promise<
        | {
            kind: 'ok';
            response: PostCrisisResolveResponseView;
          }
        | { kind: 'not_found' }
      > => {
        // Phase 7 — staff-view pre-fetch. Captures patient_id (audit
        // P1 partition key) + establishes the tenant-blind 404. current_state
        // is intentionally NOT captured for audit: it is read pre-lock and
        // is not authoritative for the audit from_state (Codex R1 #202 —
        // a responded_no_resolution_timeout sweep can transition
        // responded→escalated in the pre-fetch→wrapper-lock window; the
        // from_state is read back post-wrapper from the committed
        // transition row instead, matching the PR3 acknowledge closure).
        // Tenant-scope via view RLS + bound tenant_context — 0 rows is
        // tenant-blind 404 per I-025.
        const preFetch = async (): Promise<{ patientId: string } | null> => {
          try {
            return await withDbRole(tx, 'crisis_event_staff_reader', async () => {
              const result = await tx.query<{
                patient_id: string;
              }>(
                'SELECT patient_id FROM crisis_event_current_state_v ' +
                  'WHERE crisis_event_id = $1',
                [crisisEventIdRaw],
              );
              const row = result.rows[0];
              if (row === undefined) return null;
              return { patientId: row.patient_id };
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
        const { patientId } = preFetched;

        // Phase 8 — wrapper SELECT under crisis_resolver.
        // R2 MED-1 closure: try/catch wraps the ENTIRE withDbRole call
        // so 42501 from EITHER SET LOCAL ROLE OR the wrapper's
        // LAYER B/C guard maps to tenant-blind 403.
        const runResolve = async (): Promise<string> => {
          try {
            return await withDbRole(tx, 'crisis_resolver', async () => {
              const result = await tx.query<{ lifecycle_transition_id: string }>(
                'SELECT record_crisis_resolution($1, $2, $3) ' + 'AS lifecycle_transition_id',
                [ctx.tenantId, crisisEventIdRaw, transitionPayload],
              );
              const row = result.rows[0];
              if (row === undefined) {
                throw new Error(
                  'record_crisis_resolution returned no row; ' + 'wrapper-contract violation.',
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

        const lifecycleTransitionId = await runResolve();

        // Phase 9 — Cat A crisis.resolved audit emission in the SAME
        // transaction, gated by claimResourceLifecycleAuditSlot so a
        // wrapper-level idempotent replay (same actor, different
        // Idempotency-Key, latest already `resolved`) does NOT append a
        // duplicate Cat A row (Codex R1 #202 finding 1; mirrors the PR3
        // acknowledge dedupe). Keyed on the wrapper-returned
        // lifecycle_transition_id (same id on replay, fresh id otherwise).
        // Per FLOOR-020 + I-003 the emit inside the claimed branch is NOT
        // wrapped in try/catch — a throw propagates so the tx rolls back.
        const auditClaimed = await claimResourceLifecycleAuditSlot(tx, {
          tenantId: ctx.tenantId,
          resourceType: 'crisis_event_lifecycle_transition',
          resourceId: lifecycleTransitionId,
          auditAction: 'crisis.resolved',
        });
        if (auditClaimed) {
          // from_state is read back from the transition row the wrapper
          // committed under its SELECT FOR UPDATE lock (Codex R1 #202 —
          // same closure as PR3 acknowledge finding 1). The pre-lock
          // pre-fetch current_state is NOT authoritative: a
          // responded_no_resolution_timeout sweep can transition
          // responded→escalated in the pre-fetch→wrapper-lock window. The
          // committed transition row carries the exact from_state the
          // wrapper recorded (responded OR escalated).
          // crisis_event_staff_reader holds SELECT on
          // crisis_event_lifecycle_transition (migration 034 §line 240).
          const auditFromState = await withDbRole(
            tx,
            'crisis_event_staff_reader',
            async (): Promise<'responded' | 'escalated'> => {
              const result = await tx.query<{ from_state: string }>(
                'SELECT from_state FROM crisis_event_lifecycle_transition ' +
                  'WHERE tenant_id = $1 AND id = $2',
                [ctx.tenantId, lifecycleTransitionId],
              );
              const row = result.rows[0];
              if (row === undefined) {
                throw new Error(
                  'crisis_event_lifecycle_transition row absent for ' +
                    'wrapper-returned id; wrapper-contract violation.',
                );
              }
              if (row.from_state !== 'responded' && row.from_state !== 'escalated') {
                throw new Error(
                  `crisis.resolved transition recorded unexpected ` +
                    `from_state '${row.from_state}'; expected responded|escalated.`,
                );
              }
              return row.from_state;
            },
          );

          await emitCrisisResolvedAudit(
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
        }

        return {
          kind: 'ok',
          response: {
            crisis_event_id: crisisEventIdRaw,
            lifecycle_transition_id: lifecycleTransitionId,
          },
        };
      };

      // Phase 7+8+9 inner — bind SI-010 actor context (REQUIRED for
      // the wrapper per migration 037 §3 lines 315-323).
      const outcome = await withTenantContext<
        | {
            kind: 'ok';
            response: PostCrisisResolveResponseView;
          }
        | { kind: 'not_found' }
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
