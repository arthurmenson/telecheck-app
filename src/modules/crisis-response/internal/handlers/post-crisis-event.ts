/**
 * crisis-response/internal/handlers/post-crisis-event.ts — initiate a
 * crisis event (calls SECDEF wrapper `record_crisis_initiation()` from
 * migration 036, emits Cat A `crisis.detected` audit in the same atomic
 * transaction, and returns the resulting crisis_event_id).
 *
 * Endpoint: POST /v0/crisis-events
 *
 * **Sprint 2 PR 2 — the SECOND real Fastify handler in the Crisis
 * Response slice (FIRST write-path handler).** Lands after Sprint 2 PR 1
 * `GET /v0/crisis-events/:id` (merged to telecheck-app:main as e4cb312).
 *
 * Mirrors PR 1's canonical composition stack + adds:
 *   - body validation (manual; mirrors async-consult/identity handler
 *     pattern; matches `record_crisis_initiation()` wrapper signature
 *     from migration 036 §1)
 *   - `Idempotency-Key`-based reserve-then-execute via
 *     `withIdempotentExecution` (per IDEMPOTENCY v5.1 + SI-006 PR-C
 *     extraction at `src/lib/idempotent-handler.ts`)
 *   - withDbRole('crisis_initiator', ...) elevation around the wrapper
 *     SELECT (the wrapper is GRANTed EXECUTE ONLY to crisis_initiator
 *     per migration 036 §3)
 *   - same-tx Cat A `crisis.detected` audit emission via
 *     `emitCrisisDetectedAudit()` (FLOOR-020 fail-closed; same tx as
 *     wrapper INSERT — handler MUST NOT swallow audit-emit errors per
 *     I-003)
 *   - 42501 → tenant-blind 403 mapping wrapping the ENTIRE withDbRole
 *     call (mirrors PR 1's R2 MED-1 closure pattern at lines 261-296
 *     of get-crisis-event.ts; the catch boundary must wrap withDbRole
 *     itself — not just the inner wrapper-query — because 42501 can
 *     surface either at SET LOCAL ROLE pre-elevation OR inside the
 *     wrapper's LAYER B/C tenant-scope guard)
 *
 * **Composition stack (Option B per `src/lib/with-db-role.ts`
 * §preconditions; same as PR 1 + idempotency outer):**
 *
 *     withIdempotentExecution                    (manages cache reservation
 *       └─ withTransaction                        + replay + body-mismatch
 *          └─ (sets tenant context via            via shared helper)
 *             SELECT set_tenant_context($1))
 *             └─ withTenantContext                (RLS context binding;
 *                └─ withActorContext              same as PR 1)
 *                   └─ withDbRole(tx,
 *                        'crisis_initiator', ...)
 *                      └─ SELECT
 *                         record_crisis_initiation(...)
 *                         (returns UUID; idempotent at
 *                         DB layer via UNIQUE on
 *                         (tenant_id, server_signal_id))
 *             └─ emitCrisisDetectedAudit(tx)      (Cat A FLOOR-020;
 *                                                  fails-closed atomically
 *                                                  with the wrapper INSERT
 *                                                  via the shared tx)
 *
 * **withIdempotentExecution already does `await tx.query('SELECT
 * set_tenant_context($1)', ...)` internally** (per
 * `src/lib/idempotent-handler.ts` line 113), so the handler body does NOT
 * re-bind tenant context — it just composes `withTenantContext` for the
 * private tenant binding the rls.ts library uses for its own helpers
 * (parity with PR 1's pattern; both bindings coexist by design).
 *
 * **Layer B authorization (DEFERRED — closest-available role-gate gap):**
 *   Per SI-022 §7, `crisis_initiator` is granted to clinician +
 *   on-call clinician + ai_mode1_service. Until the JWT-role →
 *   DB-slice-role membership mapping lands (Phase A successor to
 *   SI-010 / SI-024.1), Sprint 2 PR 2 gates Layer B at the closest-
 *   available role — `clinician` — via `requireClinicianActorContext`.
 *
 *   **TODO (Layer B gap):** when the membership mapping lands, replace
 *   the `requireClinicianActorContext` gate with a precise check that
 *   asserts the acting JWT role + identity is entitled to act as
 *   `crisis_initiator` (clinician OR on-call clinician OR
 *   ai_mode1_service). The audit emitter's `actor_type` derivation must
 *   ALSO expand at that point — currently hard-coded `'clinician'` at
 *   the emitter call site; the future expansion uses `'ai_workload'`
 *   when the bound actor is the ai_mode1_service identity.
 *
 *   Defense-in-depth: even if the Layer B gate were absent at the
 *   Fastify layer, the DB layer fails closed — the request's bound
 *   role (`telecheck_app_role`) does NOT inherit `crisis_initiator`
 *   privileges (NOINHERIT per migration 051), so `withDbRole`'s
 *   `SET LOCAL ROLE` is what gates privilege acquisition; bypassing
 *   the role-gate at the Fastify layer would still require an explicit
 *   `withDbRole('crisis_initiator', ...)` call to reach the wrapper.
 *
 * **Crisis-specific platform-floor discipline (I-019):**
 *   - The initiation path MUST NEVER silently swallow errors. If the
 *     wrapper raises (validation failure, idempotency-mismatch via
 *     SQLSTATE 23505, etc.) the handler re-throws so the surrounding
 *     transaction rolls back; the audit emit + business INSERT either
 *     BOTH commit or BOTH roll back per FLOOR-020.
 *   - Rejection paths (Layer B 403, validation 400, idempotency
 *     mismatch 409, etc.) intentionally do NOT emit `crisis.detected`
 *     because no `crisis_event` row was actually created. The
 *     downstream Mode 1 FLOOR-020 emitter for
 *     `crisis_detection_trigger` (at `src/modules/ai-service/internal/
 *     crisis/audit.ts`) is the canonical record of the SURFACE-side
 *     detection signal; rejection of the response-surface initiation
 *     does not invalidate that prior Cat A record.
 *   - A `crisis.initiation_rejected` Cat A audit IS NOT in the SI-022
 *     §3 amendment table — the spec deliberately separates the
 *     surface-side detection record (`crisis_detection_trigger` Cat A,
 *     emitted pre-initiation by Mode 1) from the lifecycle-bound entry
 *     (`crisis.detected` Cat A, emitted here on the success path only).
 *     Initiation-rejection telemetry surfaces via the normal Fastify
 *     error log + the upstream `crisis_detection_trigger` audit row
 *     (which is durable regardless of whether the response surface
 *     accepted the initiation).
 *
 * **Tenant-blind envelopes (I-025):**
 *   - 400 on body validation failure (no resource enumeration possible)
 *   - 403 on 42501 from SET LOCAL ROLE or wrapper LAYER C guard
 *     (mirrors PR 1 R2 MED-1 closure; tenant_id not leaked in message)
 *   - 409 on idempotency body-mismatch OR wrapper SQLSTATE 23505
 *     idempotency-mismatch (different immutable fields with same
 *     server_signal_id — distinct from the canonical idempotent replay
 *     which the wrapper resolves silently by returning the existing
 *     crisis_event_id)
 *
 * Spec references:
 *   - SI-022 Crisis Response Slice v1.0 §3 (Cat A `crisis.detected`)
 *     + §5 (POST endpoint surface, noting v1.0 spec lists `/v1/crisis/
 *     :id/{acknowledge,response,resolve}` for mid-lifecycle wrappers
 *     and does NOT list a corresponding POST initiation endpoint —
 *     this PR's `POST /v0/crisis-events` is the response-surface
 *     entrypoint per `docs/crisis-response-implementation-plan.md`
 *     Sprint 2 plan + the implementation README's "Remaining Sprint 2-3"
 *     section)
 *   - CDM v1.9 → v1.10 Amendment §3.1 normative audit landing (P-040)
 *   - migration 036 (record_crisis_initiation SECDEF + Layer A EXECUTE
 *     grant matrix locking the wrapper to `crisis_initiator` role)
 *   - migration 051 (Option B app-role acquisition foundation —
 *     telecheck_app_role NOINHERIT membership in crisis_initiator)
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
import {
  emitCrisisDetectedAudit,
  type CrisisDetectionSourceSurface,
} from '../../audit.js';
import {
  asCrisisEventId,
  asServerSignalId,
  CRISIS_SEVERITIES,
  CRISIS_TYPES,
  type CrisisSeverity,
  type CrisisType,
} from '../types.js';

// ---------------------------------------------------------------------------
// Body shape + validation
// ---------------------------------------------------------------------------

/**
 * Wire body for POST /v0/crisis-events. Matches the
 * `record_crisis_initiation()` wrapper signature in migration 036 §1
 * (the 6 required identification / classification params + the
 * `source_surface` audit-payload field from SI-022 §4 line 916). The
 * 8-column KMS envelope params are NOT exposed on this v0 wire surface
 * — Sprint 4 lands the KMS envelope encryption path per the README
 * "Sprint 4 — Hardening" section + ADR-024. For Sprint 2 PR 2 (this PR),
 * crisis events are initiated with all 8 KMS envelope columns NULL
 * (allowed by the migration 033 §4 all-or-none CHECK constraint).
 */
interface PostCrisisEventBody {
  patient_id?: string;
  server_signal_id?: string;
  crisis_type?: string;
  severity?: string;
  regulatory_reporting_enabled?: boolean;
  source_surface?: string;
}

const VALID_SOURCE_SURFACES: ReadonlySet<CrisisDetectionSourceSurface> = new Set([
  'mode_1_chat',
  'community',
  'forms',
  'messaging',
]);

const VALID_CRISIS_TYPES: ReadonlySet<string> = new Set(CRISIS_TYPES);
const VALID_SEVERITIES: ReadonlySet<string> = new Set(CRISIS_SEVERITIES);

/**
 * RFC 4122 UUID shape (case-insensitive hex; any variant). Mirrors PR 1
 * `UUID_PATTERN` — both `patient_id` and `server_signal_id` columns on
 * `crisis_event` are UUID per migration 033 §4 (NOT ULID despite some
 * brief drift). Boundary validation catches malformed input before the
 * DB type-cast error path (which would otherwise surface as 500).
 */
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuidShape(raw: string): boolean {
  return UUID_PATTERN.test(raw);
}

function isString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}

// ---------------------------------------------------------------------------
// Error envelope helper (mirrors async-consult / identity / consent pattern)
// ---------------------------------------------------------------------------

interface ErrorEnvelopeBody {
  error: { code: string; message: string; request_id: string };
}

function makeErrorEnvelope(reqId: string, code: string, message: string): ErrorEnvelopeBody {
  return { error: { code, message, request_id: reqId } };
}

/**
 * Service-error mapper passed to `withIdempotentExecution`. Maps the
 * canonical failures from the SECDEF wrapper + audit emission to
 * tenant-blind HTTP envelopes per I-025.
 *
 * Pre-mapping happens INSIDE the body for the 42501 wrap (we throw
 * `req.server.httpErrors.forbidden(...)` from the inner try/catch which
 * Fastify formats via the global error envelope plugin). This mapper
 * handles SQLSTATE 23505 (idempotency-mismatch from wrapper's
 * unique_violation re-raise path) which surfaces as a generic Error
 * from `pg`.
 */
function mapServiceError(err: unknown, reply: FastifyReply, reqId: string): boolean {
  if (
    err !== null &&
    typeof err === 'object' &&
    'code' in err &&
    (err as { code?: unknown }).code === '23505'
  ) {
    // wrapper's idempotency-mismatch path raises with SQLSTATE 23505
    // and a descriptive message. Per I-025 we surface a tenant-blind
    // 409 with a stable code (no message-passthrough; the wrapper's
    // message contains tenant_id + server_signal_id).
    void reply
      .code(409)
      .send(
        makeErrorEnvelope(
          reqId,
          'internal.resource.conflict',
          'A crisis event with this server signal already exists with conflicting initiation fields.',
        ),
      );
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Response view (PHI-safe; tenant_id stripped per Master PRD §17 + C3)
// ---------------------------------------------------------------------------

/**
 * On 201 success the handler returns ONLY the new crisis_event_id —
 * the wrapper RETURNS UUID and the downstream client uses GET
 * /v0/crisis-events/:id (Sprint 2 PR 1) to fetch the full row. This
 * keeps the POST response shape minimal + avoids leaking tenant_id /
 * actor identity / intake_payload state on the initiation response.
 */
interface PostCrisisEventResponseView {
  crisis_event_id: string;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * POST /v0/crisis-events — initiate a crisis event.
 *
 * Flow (8 phases):
 *   1. Resolve tenant context.
 *   2. Layer B closest-available role-gate (`requireClinicianActorContext`).
 *   3. Parse + validate body (all 6 required fields).
 *   4. Resolve actor home-tenant for audit attribution (F-4 R5 closure).
 *   5. Enter `withIdempotentExecution` (manages the
 *      `Idempotency-Key`-keyed reserve-then-execute slot + replays
 *      cached completed responses + body-mismatch 409s).
 *   6. Inside the idempotency body's tx: compose
 *      withTenantContext → withActorContext (if nonce bound) →
 *      withDbRole('crisis_initiator', ...) wrapping the
 *      `SELECT record_crisis_initiation(...)` call.
 *   7. Map 42501 (SET LOCAL ROLE or wrapper LAYER C guard) to
 *      tenant-blind 403 via the canonical PR 1 R2 MED-1 closure
 *      pattern (catch wraps ENTIRE withDbRole call).
 *   8. Emit Cat A `crisis.detected` audit in the same tx
 *      (FLOOR-020 fail-closed; any throw rolls back wrapper INSERT
 *      atomically).
 *
 * Returns 201 + `{ crisis_event_id }` on success; 400 / 403 / 409 on
 * mapped failures; 500 (with default envelope) on unmapped failures
 * via the global error plugin.
 */
export async function postCrisisEventHandler(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<unknown> {
  // Phase 1 — tenant context.
  const ctx = requireTenantContext(req);

  // Phase 2 — LAYER B authorization (closest-available role-gate).
  // See file header "Layer B authorization (DEFERRED)" for the TODO.
  const actor = requireClinicianActorContext(req);

  // Phase 3 — body validation.
  const body = (req.body ?? {}) as PostCrisisEventBody;

  if (
    !isString(body.patient_id) ||
    !isUuidShape(body.patient_id) ||
    !isString(body.server_signal_id) ||
    !isUuidShape(body.server_signal_id) ||
    !isString(body.crisis_type) ||
    !VALID_CRISIS_TYPES.has(body.crisis_type) ||
    !isString(body.severity) ||
    !VALID_SEVERITIES.has(body.severity) ||
    typeof body.regulatory_reporting_enabled !== 'boolean' ||
    !isString(body.source_surface) ||
    !VALID_SOURCE_SURFACES.has(body.source_surface as CrisisDetectionSourceSurface)
  ) {
    return reply
      .code(400)
      .send(
        makeErrorEnvelope(
          req.id,
          'internal.request.invalid',
          'Invalid initiate body: patient_id (UUID), server_signal_id (UUID), ' +
            'crisis_type (6-value enum), severity (3-value enum), ' +
            'regulatory_reporting_enabled (boolean), source_surface ' +
            '(mode_1_chat|community|forms|messaging) are required.',
        ),
      );
  }

  // Phase 4 — resolve actor home-tenant for audit attribution.
  // For clinician role acting in own tenant, equals ctx.tenantId; the
  // helper exists for the platform_admin path (cross-tenant action),
  // not used here but the canonical call shape is consistent across
  // POST handlers in the codebase.
  const actorTenantId = resolveActorTenantIdForAudit(req, ctx.tenantId);

  const patientId = body.patient_id;
  const serverSignalId = body.server_signal_id;
  const crisisType = body.crisis_type as CrisisType;
  const severity = body.severity as CrisisSeverity;
  const regulatoryReportingEnabled = body.regulatory_reporting_enabled;
  const sourceSurface = body.source_surface as CrisisDetectionSourceSurface;

  // Phase 5+6+7+8 — idempotency wrap + tx composition + 42501 mapping +
  // same-tx audit emission.
  return withIdempotentExecution<PostCrisisEventResponseView | ErrorEnvelopeBody>(
    req,
    reply,
    mapServiceError,
    async (tx) => {
      // withIdempotentExecution already did `SELECT set_tenant_context($1)`
      // for the idempotency_keys RLS. Now compose the rls.ts private
      // tenant-context binding for parity with PR 1 (same physical
      // connection; binding helpers run on the canonical DbTransaction
      // handle from db.ts — see PR 1 lines 238-248 for the type-boundary
      // note that applies here unchanged).
      const crisisEventIdRaw = await withTenantContext<string>(
        tx,
        ctx.tenantId,
        async () => {
          // SI-010 actor nonce: present when authContextPlugin's
          // bind-pool wiring is configured (production); undefined in
          // dev/test deployments that opt out. The
          // record_crisis_initiation() wrapper requires SI-010 actor
          // context (it calls current_actor_account_id() and raises
          // 42501 if no actor bound — see migration 036 lines 122-127
          // + 148-153). When the nonce is undefined the wrapper will
          // fail with 42501 → tenant-blind 403, which is the correct
          // behavior in deployments lacking the SI-010 binding (the
          // initiation path is unavailable without actor attribution).
          //
          // I-025 envelope-leak defense (per PR 1 R2 MED-1 closure
          // 2026-05-23): the try/catch wraps the ENTIRE withDbRole
          // call so 42501 is mapped whether it surfaces from:
          //   (1) withDbRole's SET LOCAL ROLE pre-callback elevation
          //       (e.g., crisis_initiator membership drift)
          //   (2) the wrapper's internal LAYER B/C guards
          //       (SI-010 actor-not-bound or tenant-scope-mismatch
          //       per migration 036 lines 122-159)
          // Without the wide catch, a privilege-acquisition 42501 from
          // path (1) would escape past an inner catch and reach the
          // global envelope as 500 with leaky raw PG message.
          const runInitiate = async (): Promise<string> => {
            try {
              return await withDbRole(tx, 'crisis_initiator', async () => {
                // Call the SECDEF wrapper. All 8 KMS envelope params
                // are NULL at v0 wire surface; Sprint 4 lands KMS
                // envelope encryption per README + ADR-024. The
                // wrapper accepts NULLs for those columns under the
                // table CHECK's "all-or-none" constraint.
                const result = await tx.query<{ crisis_event_id: string }>(
                  'SELECT record_crisis_initiation($1, $2, $3, $4, $5, $6) AS crisis_event_id',
                  [
                    ctx.tenantId,
                    patientId,
                    serverSignalId,
                    crisisType,
                    severity,
                    regulatoryReportingEnabled,
                  ],
                );
                const row = result.rows[0];
                if (row === undefined) {
                  // Defensive: wrapper RETURNS UUID NOT NULL by
                  // contract — but if a future wrapper amendment
                  // ever returns 0 rows this would surface as 500
                  // (rather than undefined behavior on a downstream
                  // emit). Re-throw for the global envelope.
                  throw new Error(
                    'record_crisis_initiation returned no row; wrapper-contract violation.',
                  );
                }
                return row.crisis_event_id;
              });
            } catch (err) {
              if (
                typeof err === 'object' &&
                err !== null &&
                'code' in err &&
                (err as { code?: unknown }).code === '42501'
              ) {
                throw req.server.httpErrors.forbidden(
                  'Insufficient scope for this request.',
                );
              }
              throw err;
            }
          };

          if (req.actorNonce !== undefined) {
            return withActorContext(tx, req.actorNonce, runInitiate);
          }
          return runInitiate();
        },
      );

      // Phase 8 — Cat A `crisis.detected` audit emission in the SAME
      // transaction as the wrapper INSERT. Per FLOOR-020 + I-003 the
      // throw on any audit-emit failure MUST propagate (do NOT
      // try/catch around this call): a partial commit that leaves a
      // crisis_event row without its audit record is a platform-floor
      // violation, and the surrounding tx rolling back is the
      // canonical recovery (the client's retry — with same
      // Idempotency-Key — replays cleanly when the underlying issue
      // is resolved).
      await emitCrisisDetectedAudit(
        {
          tenantId: ctx.tenantId,
          actorAccountId: actor.accountId,
          actorTenantId,
          countryOfCare: actor.countryOfCare,
          crisisEventId: asCrisisEventId(crisisEventIdRaw),
          targetPatientId: patientId,
          serverSignalId: asServerSignalId(serverSignalId),
          crisisType,
          severity,
          regulatoryReportingEnabled,
          sourceSurface,
        },
        tx,
      );

      return {
        status: 201,
        view: { crisis_event_id: crisisEventIdRaw },
      };
    },
  );
}
