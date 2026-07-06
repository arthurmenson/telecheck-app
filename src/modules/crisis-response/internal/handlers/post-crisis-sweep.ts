/**
 * crisis-response/internal/handlers/post-crisis-sweep.ts — operator-
 * invoked no-acknowledgement sweep handler. Wraps the
 * `execute_crisis_no_acknowledgement_sweep()` SECDEF wrapper from
 * migration 038 (granted EXECUTE ONLY to `crisis_sweep_scheduler` slice
 * role per migration 038 §3) and, when the wrapper emits an escalation,
 * lands the Cat A `crisis.no_acknowledgement_escalation` audit in the
 * SAME atomic transaction.
 *
 * Endpoint: `POST /v0/crisis-events/:id/_sweep`
 *
 * The `_sweep` underscore prefix marks this as the operator-only
 * surface (cron/scheduler-invoked); the convention deliberately
 * distinguishes it from the patient/clinician routes (`/acknowledge`,
 * `/respond`, `/resolve`) per SI-022 §5 sweep-endpoint note. In
 * production this endpoint MUST NOT be exposed to authenticated
 * patient/clinician traffic — see "Layer B authorization" below.
 *
 * **Sprint 2 PR 6 — the LAST write-path handler in the Crisis Response
 * slice's Sprint 2 endpoint surface.** Branch is based on `main`; PRs 2
 * (initiate), 3 (acknowledge), 4 (respond+resolve), 5 (patient-summary
 * GET) are parked [CODEX-PENDING] or sibling-PR-merging in parallel —
 * conflict-merges in `routes.ts` + `audit.ts` + `README.md` are
 * expected and resolvable at merge time. This PR introduces the FIRST
 * Cat A emitter `emitCrisisNoAcknowledgementEscalationAudit` in
 * `audit.ts` (sibling PRs add additional emitters to the same file
 * + extend `CrisisAuditActionPlaceholder`).
 *
 * **Idempotency model — fencing_token, NOT Idempotency-Key:**
 *   The sweep wrapper is idempotent by design via its lease-takeover
 *   + fencing-token mechanism per migration 038 §1.1 + STEP F at §1.3.
 *   The wrapper guarantees:
 *
 *   - First claim per `(tenant_id, crisis_event_id,
 *     scheduled_for_obligation_generation)` triple → INSERT new
 *     sweep_execution row with `fencing_token = 1`.
 *   - Concurrent first-claim race → loser raises SQLSTATE 40001
 *     (R2 HIGH-1 closure 2026-05-22 with controlled re-read).
 *   - Lease takeover (claim expired) → UPDATE existing row, INCREMENT
 *     fencing_token monotonically (R3 closure 2026-05-22).
 *   - Lease held by another worker (claim not expired) → SQLSTATE 40001
 *     (callers must retry after expiry).
 *   - Replay of an already-completed sweep generation → returns the
 *     existing completed sweep's info with outcome
 *     `'already_completed'` (R1 HIGH-1 closure 2026-05-22 idempotent
 *     replay guard).
 *   - STEP F atomic completion guarded by fencing_token → if the
 *     fencing token has advanced (another worker took over during
 *     processing), the UPDATE affects zero rows and SQLSTATE 40001 is
 *     raised.
 *
 *   The handler therefore does NOT use `withIdempotentExecution` /
 *   `Idempotency-Key` header semantics — the canonical idempotency
 *   surface for sweep is the (generation, fencing_token) tuple in the
 *   `crisis_sweep_execution` table.
 *
 * **Composition stack (per `src/lib/with-db-role.ts` §preconditions;
 * mirrors PR 4 respond pattern minus the idempotency wrap):**
 *
 *     withTransaction
 *       └─ withTenantContext (RLS context binding)
 *          └─ withActorContext (SI-010 GUC; REQUIRED — the wrapper
 *                               raises 42501 on missing actor binding
 *                               per migration 038 §1 lines 112-122)
 *             ├─ withDbRole(tx, 'crisis_event_staff_reader', ...)
 *             │  └─ SELECT patient_id
 *             │     FROM crisis_event_current_state_v
 *             │     WHERE crisis_event_id = $1
 *             │     (404 envelope branch if 0 rows — same shape for
 *             │      missing OR cross-tenant per I-025)
 *             └─ withDbRole(tx, 'crisis_sweep_scheduler', ...)
 *                └─ SELECT * FROM execute_crisis_no_acknowledgement_sweep(...)
 *                   (RETURNS TABLE sweep_execution_id UUID,
 *                    fencing_token BIGINT, outcome TEXT)
 *          └─ (CONDITIONAL: when outcome === 'completed_escalated')
 *             emitCrisisNoAcknowledgementEscalationAudit(tx)
 *             (Cat A FLOOR-020; same tx as wrapper UPDATE; bare
 *              suppression FORBIDDEN per I-003)
 *
 * **Wrapper signature (verified against migration 038 §1):**
 *
 *   execute_crisis_no_acknowledgement_sweep(
 *     p_tenant_id                     TEXT,
 *     p_crisis_event_id               UUID,
 *     p_target_obligation_generation  INTEGER,
 *     p_worker_id                     TEXT,
 *     p_claim_ttl_seconds             INTEGER DEFAULT 60
 *   ) RETURNS TABLE (
 *     sweep_execution_id   UUID,
 *     fencing_token        BIGINT,
 *     outcome              TEXT  -- 5-value enum (see CrisisSweepOutcome)
 *   )
 *
 *   **NOTE on the brief's `max_age_seconds` / `batch_size` body fields:**
 *   The brief sketched a batch-mode body shape with `max_age_seconds` +
 *   `batch_size`. The canonical migration 038 wrapper is SINGLE-EVENT
 *   (per-crisis-event-id, per-obligation-generation) — there is no
 *   batch-mode wrapper. The handler authors the body shape to match
 *   the actual wrapper signature; an upstream batch-orchestrator
 *   (cron/scheduler) is responsible for iterating per-generation
 *   sweeps across the candidate set + invoking THIS endpoint per
 *   crisis_event. This adheres to "Slice PRD vs OpenAPI vs Wrapper:
 *   wrapper-truth wins" per the canonical source-of-truth hierarchy
 *   (CDM v1.2 §0).
 *
 * **Body shape (verified against wrapper signature; UUID for path):**
 *
 *   {
 *     scheduler_id: string,                       // → p_worker_id
 *     fencing_token: string,                      // observability echo;
 *                                                  // the wrapper sources
 *                                                  // canonical fencing
 *                                                  // from the table
 *     target_obligation_generation: number,       // → p_target_obligation_generation
 *     claim_ttl_seconds?: number                  // → p_claim_ttl_seconds
 *                                                  // (defaults to 60 in
 *                                                  // the SQL DEFAULT)
 *   }
 *
 *   The brief's `fencing_token` is accepted as a body field per the
 *   brief contract — used as an observability echo for caller-side
 *   trace correlation. The wrapper's canonical fencing-token IS NOT
 *   sourced from the body (it is sourced from / advanced in the
 *   `crisis_sweep_execution` table). The handler does NOT pass the
 *   body-supplied `fencing_token` to the wrapper; it carries it
 *   through to the audit detail + the response view for trace
 *   correlation only.
 *
 * **Layer B authorization (DEFERRED — sweep-scheduler role-gate gap):**
 *   Per SI-022 §7 + migration 038 §3, the wrapper's EXECUTE grant is
 *   locked to the `crisis_sweep_scheduler` slice role; there is no JWT
 *   role that maps to that DB role yet (planned for SI-024 Phase A
 *   alongside the JWT-role → DB-slice-role membership mapping). For
 *   Sprint 2 PR 6 (this PR) the Fastify gate is the closest-available
 *   `requireAdminActorContext` (tenant_admin OR platform_admin) —
 *   admin is the closest gate that does NOT widen to clinician /
 *   patient. The deployment-time constraint MUST additionally restrict
 *   this endpoint via:
 *
 *     - Network ACL (private subnet / VPC-only access), AND
 *     - HTTP-layer constraint (e.g., mutual-TLS scheduler identity,
 *       or a deploy-time auth header that admin JWTs do NOT carry),
 *
 *   so that a compromised admin JWT cannot invoke the sweep endpoint
 *   from the public surface. This deploy-time hardening is OUT OF
 *   SCOPE for this PR's code surface — tracked in README §"Sprint 2 PR
 *   6 follow-up".
 *
 *   **TODO (Layer B gap):** when the JWT-role → DB-slice-role mapping
 *   lands, replace `requireAdminActorContext` with a precise check
 *   asserting the acting JWT identity is entitled to act as
 *   `crisis_sweep_scheduler`.
 *
 *   Defense-in-depth: the DB layer fails closed regardless — the
 *   request's bound role (`telecheck_app_role`) does NOT inherit
 *   `crisis_sweep_scheduler` privileges (NOINHERIT per migration 051);
 *   `withDbRole`'s `SET LOCAL ROLE` is the privilege-acquisition gate,
 *   so bypassing the Fastify gate would still require an explicit
 *   `withDbRole('crisis_sweep_scheduler', ...)` call to reach the
 *   wrapper.
 *
 * **SQLSTATE map (per migration 038 §1):**
 *   - 42501 → tenant-blind 403 (actor-not-bound OR tenant-scope-mismatch
 *     OR SET LOCAL ROLE elevation failure). Handled inline at the
 *     try/catch wrapping the ENTIRE withDbRole call — by the canonical
 *     R2 MED-1 closure pattern (mirrors PR 1 lines 261-296 of
 *     get-crisis-event.ts).
 *   - 02000 → tenant-blind 404 (wrapper's crisis_event-not-found path;
 *     defensive — should be unreachable because the staff-view pre-
 *     fetch catches missing first).
 *   - 23514 → tenant-blind 404 (CHECK violation — defensive; not
 *     normally raised by the sweep wrapper, but mapped per brief).
 *   - 40001 → tenant-blind 409 (lease-takeover by another scheduler:
 *     wrapper §1.1 lines 195-203 lease-held-by-other-worker, §1.1
 *     lines 277-281 R3 first-claim-race-loser, §1.2 lines 346-351 or
 *     §1.3 lines 387-391 STEP F lease-lost-during-processing).
 *   - 23505 → tenant-blind 409 (duplicate sweep run — defensive; the
 *     wrapper §1.1 R4 closure re-raises non-canonical unique
 *     violations with 23505 for unexpected constraint drift).
 *   - 22023 → tenant-blind 400 (invalid_parameter_value; wrapper §1
 *     lines 136-139 raise on `p_claim_ttl_seconds` out of [1, 600]).
 *
 * **Crisis-specific platform-floor discipline (I-019):**
 *   - The sweep path MUST NEVER silently swallow errors. If the wrapper
 *     raises (lease conflict, state-machine no-op, audit-emit failure),
 *     the handler propagates so the surrounding tx rolls back; the
 *     wrapper's STATE change either BOTH commits (with audit) or BOTH
 *     rolls back per FLOOR-020.
 *   - Rejection paths (403, 404, 409, 400) intentionally do NOT emit
 *     `crisis.no_acknowledgement_escalation` because no escalation
 *     lifecycle transition was created — emitting an audit for a
 *     non-existent state change violates the I-003 hash-chain
 *     semantics + the FLOOR-020 same-tx pairing rule.
 *   - The `'already_completed'` / `'completed_no_op'` outcomes are
 *     SUCCESS responses from the wrapper's perspective (sweep ran
 *     successfully and found no escalation to emit). The handler
 *     returns 200 + the wrapper outcome without firing the audit —
 *     the original sweep's audit (for `'completed_escalated'`) is the
 *     canonical record for that generation; re-emitting on replay
 *     would create duplicate audit rows for a single ratified state
 *     change.
 *
 * **Tenant-blind envelopes (I-025):**
 *   - 400 on body validation failure (no resource enumeration possible)
 *   - 403 on 42501 from SET LOCAL ROLE or wrapper LAYER B/C guard
 *     (canonical R2 MED-1 closure; tenant_id not leaked in message)
 *   - 404 on 02000 / 23514 from wrapper not-found path (same envelope
 *     for missing OR cross-tenant per I-025)
 *   - 409 on 40001 (lease conflict) or 23505 (defensive duplicate)
 *   - 500 (default envelope; unmapped errors pass through to the global
 *     error envelope plugin)
 *
 *   Per SI-022 §6 + I-025, the response body MUST NOT carry per-event
 *   detail that could leak cross-tenant — the success view carries only
 *   `crisis_event_id`, `sweep_execution_id`, `fencing_token`, `outcome`,
 *   `target_obligation_generation`. No patient PHI, no actor identity,
 *   no tenant_id echoed.
 *
 * Spec references:
 *   - SI-022 Crisis Response Slice v1.0 §5 (sweep endpoint surface) +
 *     §6 Sub-decision 4 + Sub-decision 6 (sweep semantics + STEP D Cat
 *     A audit emit step)
 *   - SI-022 §3 normative AUDIT_EVENTS row 5
 *     (`crisis.no_acknowledgement_escalation` Cat A, NOT sampled,
 *     P1 keyed by patient_id; R1 MED-1 closure 2026-05-21 Cat B → Cat
 *     A promotion)
 *   - CDM v1.9 → v1.10 Amendment §3.1 normative landing (P-040)
 *   - migration 038 (sweep wrapper SECDEF; lease-takeover + fencing-
 *     token + STEP F atomic completion; EXECUTE granted ONLY to
 *     crisis_sweep_scheduler)
 *   - migration 051 (Option B app-role acquisition foundation —
 *     telecheck_app_role NOINHERIT membership in
 *     crisis_sweep_scheduler + crisis_event_staff_reader)
 *   - src/lib/with-db-role.ts (Option B per-tx SET LOCAL ROLE helper)
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
  requireAdminActorContext,
  resolveActorTenantIdForAudit,
} from '../../../../lib/auth-context.js';
import { withTransaction } from '../../../../lib/db.js';
import { withTenantContext } from '../../../../lib/rls.js';
import { requireTenantContext } from '../../../../lib/tenant-context.js';
import { withDbRole } from '../../../../lib/with-db-role.js';
import { emitCrisisNoAcknowledgementEscalationAudit } from '../../audit.js';
import { asCrisisEventId, asCrisisSweepExecutionId, type CrisisSweepOutcome } from '../types.js';

// ---------------------------------------------------------------------------
// Path-param + body shape + validation
// ---------------------------------------------------------------------------

interface SweepPathParams {
  id?: string;
}

/**
 * Wire body for `POST /v0/crisis-events/:id/_sweep`. Verified against
 * the `execute_crisis_no_acknowledgement_sweep()` wrapper signature
 * from migration 038 §1.
 *
 * Required:
 *   - scheduler_id                  → wrapper `p_worker_id` TEXT (non-empty)
 *   - fencing_token                 → observability echo (carried to audit
 *                                      detail + response view; NOT passed to
 *                                      wrapper — wrapper sources canonical
 *                                      fencing from the table)
 *   - target_obligation_generation  → wrapper `p_target_obligation_generation`
 *                                      INTEGER (non-negative)
 *
 * Optional:
 *   - claim_ttl_seconds             → wrapper `p_claim_ttl_seconds` INTEGER
 *                                      DEFAULT 60; wrapper validates range
 *                                      [1, 600] and raises 22023 on out-of-
 *                                      range, which the handler maps to 400
 *                                      tenant-blind.
 */
interface PostCrisisSweepBody {
  scheduler_id?: unknown;
  fencing_token?: unknown;
  target_obligation_generation?: unknown;
  claim_ttl_seconds?: unknown;
}

/**
 * RFC 4122 UUID shape (case-insensitive hex; any variant). Mirrors PR 1
 * — `crisis_event.id` is `UUID` per migration 033 §4.
 */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuidShape(raw: string): boolean {
  return UUID_PATTERN.test(raw);
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}

function isNonNegativeInteger(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0;
}

function isPositiveInteger(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v > 0;
}

// ---------------------------------------------------------------------------
// Error envelope helper (mirrors sibling crisis-response handlers)
// ---------------------------------------------------------------------------

interface ErrorEnvelopeBody {
  error: { code: string; message: string; request_id: string };
}

function makeErrorEnvelope(reqId: string, code: string, message: string): ErrorEnvelopeBody {
  return { error: { code, message, request_id: reqId } };
}

// ---------------------------------------------------------------------------
// Wrapper row shape — mirrors migration 038 §1 RETURNS TABLE
// ---------------------------------------------------------------------------

interface SweepWrapperRow {
  sweep_execution_id: string;
  /** BIGINT serialized as string by the pg driver for safe JSON
   *  round-trip past JS Number.MAX_SAFE_INTEGER. */
  fencing_token: string;
  outcome: CrisisSweepOutcome;
}

// ---------------------------------------------------------------------------
// Response view (PHI-safe; tenant_id stripped per I-025)
// ---------------------------------------------------------------------------

/**
 * On 200 success the handler returns the wrapper's RETURNS TABLE shape
 * (sweep_execution_id, fencing_token, outcome) plus the path-supplied
 * crisis_event_id + target_obligation_generation for caller-side
 * correlation. tenant_id / patient_id / actor identity are NOT echoed
 * per the I-025 envelope-leak discipline outlined in the file header.
 */
interface PostCrisisSweepResponseView {
  crisis_event_id: string;
  sweep_execution_id: string;
  fencing_token: string;
  outcome: CrisisSweepOutcome;
  target_obligation_generation: number;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * POST /v0/crisis-events/:id/_sweep — operator-invoked no-
 * acknowledgement sweep.
 *
 * Flow (8 phases):
 *   1. Resolve tenant context.
 *   2. Layer B closest-available role-gate (requireAdminActorContext).
 *   3. Validate path :id (UUID shape).
 *   4. Parse + validate body (scheduler_id, fencing_token,
 *      target_obligation_generation required; claim_ttl_seconds
 *      optional + positive integer).
 *   5. Resolve actor home-tenant for audit attribution.
 *   6. Open tx; compose withTenantContext → withActorContext (REQUIRED;
 *      wrapper raises 42501 on missing actor) → withDbRole
 *      crisis_event_staff_reader → SELECT patient_id (404 on 0 rows).
 *   7. Same tx, second withDbRole crisis_sweep_scheduler → SELECT FROM
 *      execute_crisis_no_acknowledgement_sweep(...). Map 42501 → 403
 *      via canonical R2 MED-1 closure. Map other SQLSTATEs at outer
 *      catch.
 *   8. If wrapper outcome === 'completed_escalated', emit Cat A
 *      `crisis.no_acknowledgement_escalation` audit in the SAME tx
 *      (FLOOR-020 fail-closed). Other outcomes skip audit per the
 *      I-003 hash-chain discipline.
 *
 * Returns 200 + the wrapper RETURNS TABLE shape on success;
 * 400 / 403 / 404 / 409 on mapped failures; 500 (default envelope) on
 * unmapped failures via the global error plugin.
 */
export async function postCrisisSweepHandler(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<unknown> {
  // Phase 1 — tenant context.
  const ctx = requireTenantContext(req);

  // Phase 2 — LAYER B authorization (closest-available role-gate).
  // See file header "Layer B authorization (DEFERRED)" for the TODO.
  const actor = requireAdminActorContext(req);

  // Phase 3 — path :id validation.
  const params = (req.params ?? {}) as SweepPathParams;
  const crisisEventIdRaw = params.id;
  if (typeof crisisEventIdRaw !== 'string' || !isUuidShape(crisisEventIdRaw)) {
    return reply
      .code(400)
      .send(
        makeErrorEnvelope(
          req.id,
          'internal.request.invalid',
          'Invalid sweep path: :id must be a UUID.',
        ),
      );
  }

  // Phase 4 — body validation. Required: scheduler_id (non-empty
  // string), fencing_token (non-empty string), target_obligation_
  // generation (non-negative integer). Optional: claim_ttl_seconds
  // (positive integer; wrapper enforces [1, 600] and raises 22023 on
  // out-of-range — we additionally pre-validate positive-integer shape
  // at the boundary so a wrong type / negative is caught before the DB
  // round-trip).
  const body = (req.body ?? {}) as PostCrisisSweepBody;
  if (
    !isNonEmptyString(body.scheduler_id) ||
    !isNonEmptyString(body.fencing_token) ||
    !isNonNegativeInteger(body.target_obligation_generation) ||
    (body.claim_ttl_seconds !== undefined && !isPositiveInteger(body.claim_ttl_seconds))
  ) {
    return reply
      .code(400)
      .send(
        makeErrorEnvelope(
          req.id,
          'internal.request.invalid',
          'Invalid sweep body: scheduler_id (non-empty string), ' +
            'fencing_token (non-empty string), and ' +
            'target_obligation_generation (non-negative integer) are ' +
            'required; claim_ttl_seconds (when present) must be a ' +
            'positive integer.',
        ),
      );
  }

  const schedulerId = body.scheduler_id;
  // `body.fencing_token` is an observability echo only — the handler
  // does NOT pass it to the wrapper (wrapper sources canonical fencing
  // from the `crisis_sweep_execution` table). It is intentionally read
  // + validated above but not bound to a downstream variable; the
  // wrapper-returned fencing token is what populates the audit detail
  // + response view. Marked-consumed via void to satisfy unused-var
  // lint while preserving the body-validation side effect.
  void body.fencing_token;
  const targetGeneration = body.target_obligation_generation;
  // Default the optional parameter on the client side so the SQL call
  // sends the explicit value rather than relying on the SQL DEFAULT
  // (which would not be applied when the parameter is bound as NULL).
  const claimTtlSeconds = body.claim_ttl_seconds ?? 60;

  // Phase 5 — actor home-tenant for audit attribution.
  const actorTenantId = resolveActorTenantIdForAudit(req, ctx.tenantId);

  // Phase 6+7+8 — tx + composition + wrapper SELECT + conditional audit.
  return withTransaction<unknown>(async (tx) => {
    const composition = async (): Promise<
      | { kind: 'ok'; row: SweepWrapperRow; patientId: string }
      | { kind: 'not_found' }
      | { kind: 'mapped'; status: number; body: ErrorEnvelopeBody }
    > => {
      // Phase 6 — staff-view pre-fetch under crisis_event_staff_reader
      // to resolve patient_id for the audit envelope + serve as a
      // tenant-scope guard. 0 rows means missing OR cross-tenant per
      // I-025, both mapping to 404 with the same envelope BEFORE the
      // wrapper is invoked. R2 MED-1 closure: catch wraps the ENTIRE
      // withDbRole so 42501 from either SET LOCAL ROLE or the view's
      // RLS evaluation maps to tenant-blind 403.
      const preFetch = async (): Promise<string | null> => {
        try {
          return await withDbRole(tx, 'crisis_event_staff_reader', async () => {
            const result = await tx.query<{ patient_id: string }>(
              'SELECT patient_id FROM crisis_event_current_state_v ' + 'WHERE crisis_event_id = $1',
              [crisisEventIdRaw],
            );
            return result.rows[0]?.patient_id ?? null;
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

      // Phase 7 — wrapper SELECT under crisis_sweep_scheduler.
      // R2 MED-1 closure: try/catch wraps the ENTIRE withDbRole call so
      // 42501 from EITHER SET LOCAL ROLE OR the wrapper's LAYER B/C
      // guard maps to tenant-blind 403. Other SQLSTATEs (02000 / 23514
      // / 40001 / 23505 / 22023) are mapped at the outer try/catch
      // below to controlled HTTP envelopes per the spec table in the
      // file header.
      const runSweep = async (): Promise<SweepWrapperRow> => {
        try {
          return await withDbRole(tx, 'crisis_sweep_scheduler', async () => {
            const result = await tx.query<SweepWrapperRow>(
              'SELECT sweep_execution_id, fencing_token, outcome ' +
                'FROM execute_crisis_no_acknowledgement_sweep($1, $2, $3, $4, $5)',
              [ctx.tenantId, crisisEventIdRaw, targetGeneration, schedulerId, claimTtlSeconds],
            );
            const row = result.rows[0];
            if (row === undefined) {
              // Defensive: wrapper RETURNS TABLE with exactly 1 row by
              // contract; 0 rows would indicate a wrapper-contract
              // violation. Re-throw for the global envelope (500).
              throw new Error(
                'execute_crisis_no_acknowledgement_sweep returned no row; ' +
                  'wrapper-contract violation.',
              );
            }
            return row;
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

      const row = await runSweep();

      // Phase 8 — conditional Cat A audit emission. Per the I-003 +
      // FLOOR-020 discipline outlined in the file header, the audit
      // fires ONLY when outcome === 'completed_escalated' (the only
      // outcome where a lifecycle_transition row was actually inserted
      // by the wrapper). Bare suppression on emit failure is FORBIDDEN
      // — the throw propagates and rolls back the wrapper-side state
      // change atomically.
      if (row.outcome === 'completed_escalated') {
        await emitCrisisNoAcknowledgementEscalationAudit(
          {
            tenantId: ctx.tenantId,
            actorAccountId: actor.accountId,
            actorTenantId,
            countryOfCare: actor.countryOfCare,
            crisisEventId: asCrisisEventId(crisisEventIdRaw),
            targetPatientId: patientId,
            sweepExecutionId: asCrisisSweepExecutionId(row.sweep_execution_id),
            fencingToken: row.fencing_token,
            sweepOutcome: 'completed_escalated',
            targetObligationGeneration: targetGeneration,
            claimTtlSeconds,
            workerId: schedulerId,
          },
          tx,
        );
      }

      return { kind: 'ok', row, patientId };
    };

    try {
      // Phase 6 outer — bind tenant + SI-010 actor context. The wrapper
      // REQUIRES actor binding per migration 038 §1 lines 112-122; when
      // the nonce is undefined the wrapper raises 42501 → tenant-blind
      // 403 via the inner catch, which is correct behavior in
      // deployments lacking SI-010 binding.
      const outcome = await withTenantContext<
        | { kind: 'ok'; row: SweepWrapperRow; patientId: string }
        | { kind: 'not_found' }
        | { kind: 'mapped'; status: number; body: ErrorEnvelopeBody }
      >(tx, ctx.tenantId, async () => {
        if (req.actorNonce !== undefined) {
          return withActorContext(tx, req.actorNonce, composition);
        }
        return composition();
      });

      if (outcome.kind === 'not_found') {
        return reply
          .code(404)
          .send(
            makeErrorEnvelope(
              req.id,
              'internal.resource.not_found',
              'No crisis event with the requested id exists for this tenant.',
            ),
          );
      }
      if (outcome.kind === 'mapped') {
        return reply.code(outcome.status).send(outcome.body);
      }

      const view: PostCrisisSweepResponseView = {
        crisis_event_id: crisisEventIdRaw,
        sweep_execution_id: outcome.row.sweep_execution_id,
        fencing_token: outcome.row.fencing_token,
        outcome: outcome.row.outcome,
        target_obligation_generation: targetGeneration,
      };
      return reply.code(200).send(view);
    } catch (err) {
      // SQLSTATE map at the outer catch. 42501 was already mapped
      // inline at the inner try/catch into a Fastify httpErrors throw;
      // it bypasses this catch (httpErrors is recognized by the global
      // error envelope plugin). The remaining canonical SQLSTATEs from
      // migration 038 §1 are mapped here to tenant-blind envelopes.
      if (err !== null && typeof err === 'object' && 'code' in err) {
        const code = (err as { code?: unknown }).code;
        if (code === '02000' || code === '23514') {
          return reply
            .code(404)
            .send(
              makeErrorEnvelope(
                req.id,
                'internal.resource.not_found',
                'No crisis event with the requested id exists for this tenant.',
              ),
            );
        }
        if (code === '40001') {
          // Lease conflict: either a concurrent sweep worker holds the
          // canonical lease, or first-claim race-loser, or STEP F lost
          // its lease mid-processing. Callers (cron/scheduler) should
          // retry after the claim TTL elapses.
          return reply
            .code(409)
            .send(
              makeErrorEnvelope(
                req.id,
                'internal.resource.conflict',
                'Sweep lease conflict: another scheduler currently holds the ' +
                  'lease for this crisis event + obligation generation, or the ' +
                  'lease was taken over during processing. Retry after the ' +
                  'claim TTL elapses.',
              ),
            );
        }
        if (code === '23505') {
          // Defensive: wrapper §1.1 R4 closure re-raises non-canonical
          // unique violations with 23505 (the canonical first-claim
          // race is handled with 40001 internally). Treat as a
          // duplicate-run conflict from the caller's perspective.
          return reply
            .code(409)
            .send(
              makeErrorEnvelope(
                req.id,
                'internal.resource.conflict',
                'Sweep run conflict: duplicate sweep submission for this ' +
                  'crisis event + obligation generation.',
              ),
            );
        }
        if (code === '22023') {
          // invalid_parameter_value — wrapper §1 lines 136-139 raise on
          // p_claim_ttl_seconds out of [1, 600]. Map to 400 tenant-blind.
          return reply
            .code(400)
            .send(
              makeErrorEnvelope(
                req.id,
                'internal.request.invalid',
                'Invalid sweep body: claim_ttl_seconds out of allowed ' + 'range [1, 600].',
              ),
            );
        }
      }
      // Unmapped — propagate to the global error envelope plugin (500).
      throw err;
    }
  });
}
