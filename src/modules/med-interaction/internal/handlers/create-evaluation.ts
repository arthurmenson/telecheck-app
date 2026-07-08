/**
 * med-interaction/internal/handlers/create-evaluation.ts —
 *   POST /v0/med-interaction/evaluations — initiate an interaction-engine
 *   evaluation; create an `interaction_engine_evaluation` row directly.
 *
 * **PR 8 of N — FIRST WRITE HANDLER POST-FOUNDATION-051.**
 *
 * This handler establishes the Cat A audit-emission pattern for the
 * Med-Interaction slice. Every subsequent write handler (PR 8 signal
 * emission, PR 9 signal activation, PRs 10-11 override/resolve/expire/
 * supersede) mirrors:
 *
 *   - Canonical composition: withTransaction → withTenantContext →
 *     withActorContext → withDbRole → (DB write + audit emit) — all in
 *     the SAME transaction so a partial commit cannot leave a write
 *     effect without its audit record (Option 2 carryforward; the
 *     module-level Option 2 ratifier decision deferred Cat A audit
 *     emission from SQL wrappers to the application layer for this
 *     same-tx atomicity reason).
 *   - 42501 → tenant-blind 403 mapping (I-025): every withDbRole call
 *     wrapped in try/catch mapping `err.code === '42501'` to
 *     `req.server.httpErrors.forbidden(...)`. Covers BOTH the SET LOCAL
 *     ROLE pre-callback path AND the inner SQL's RLS/policy denial path.
 *   - Idempotency via `withIdempotentExecution` (per IDEMPOTENCY contract
 *     v5.1, tenant-scoped Idempotency-Key header).
 *   - Layer B authorization: deferred-permissive per Option 2 ratifier
 *     decision (any authenticated actor; production fail-closed on missing
 *     actorContext). Tightening lands when `tenant_account_membership` or
 *     the per-slice cache equivalent ships.
 *   - Tenant-blind error envelopes per I-025.
 *
 * Endpoint contract:
 *   Method   POST
 *   Path     /v0/med-interaction/evaluations    (module prefix /v0/med-interaction)
 *   Body     {
 *              triggered_by:                'prescribing'|'refill'|'protocol_gate'|
 *                                           'manual_recheck'|'lab_update'|
 *                                           'adverse_event_investigation',
 *              triggered_by_resource_id:    ULID,
 *              patient_id:                  ULID,
 *              engine_version:              semver string,
 *              knowledge_base_version:      semver string,
 *              medication_set_snapshot:     JSON object,
 *              condition_set_snapshot:      JSON object,
 *              lab_set_snapshot:            JSON object
 *            }
 *   Returns  201 + { evaluation_id, evaluated_at } on success
 *            400 on malformed body / missing required fields
 *            401 if no authenticated actor (production fail-closed)
 *            403 if 42501 surfaces from SQL (insufficient scope)
 *            409 on idempotency replay / in-flight / body mismatch
 *
 * **Canonical lifecycle audit rule for this handler (R1 Finding 2 closure
 * 2026-05-23):**
 *   This handler emits EXACTLY ONE audit event per successful request:
 *     1. `interaction_engine_evaluation_completed` (Cat A)
 *   It does NOT emit any signal-lifecycle events (`interaction_signal_emitted`
 *   or `interaction_signal_lifecycle_transition_emitted`) — those belong
 *   to the /signals and /signals/:id/activate handlers respectively. The
 *   unit test below asserts the exact emitter call sequence (`auditCalls`
 *   mock log shape). See `audit.ts` file-level docstring `CANONICAL
 *   LIFECYCLE AUDIT RULE` for the full cross-handler contract.
 *
 * **Why no SECDEF wrapper for the INSERT:**
 *   Per the SI-019 spec §5 + CDM v1.7 §4.NEW1, `interaction_engine_evaluation`
 *   is INSERTed directly by the engine-evaluator role (no SECDEF wrapper;
 *   the wrappers in migration 050 are scoped to the signal lifecycle state
 *   machine). The handler still calls `withDbRole(tx,
 *   'medication_interaction_engine_evaluator', ...)` so the INSERT runs at
 *   the slice role's privileges + the role-membership trust boundary
 *   matches the canonical composition pattern.
 *
 * **Cat A audit (same-tx mandatory per I-003 + Option 2 carryforward):**
 *   On successful INSERT, emits `interaction_engine_evaluation_completed`
 *   (Cat A) via `audit.ts emitEvaluationCompletedAudit()`. The audit
 *   INSERT runs in the SAME tx as the INSERT; an audit-INSERT failure
 *   raises and rolls back the entire transaction (per I-003 the audit
 *   write is non-suppressible).
 *
 * Spec references:
 *   - SI-019 Slice PRD v2.0 §5 (POST /evaluations contract) + §6 (audit
 *     catalog enumeration for evaluation_completed)
 *   - CDM v1.6 → v1.7 Amendment §4.NEW1 (interaction_engine_evaluation row
 *     shape)
 *   - migration 047 §1 (DDL + RLS + triggers for interaction_engine_evaluation)
 *   - migration 051 + src/lib/with-db-role.ts (Option B foundation)
 *   - I-002 (interaction engine runs BEFORE clinician commits
 *     medication_request — this handler is the platform-floor entry point
 *     into that gate)
 *   - I-003 (audit append-only; bare suppression forbidden — audit emit
 *     in the same tx as the INSERT)
 *   - I-023 (tenant isolation; enforced by the tenant_id column + RLS)
 *   - I-025 (tenant-blind error envelopes)
 *   - I-027 (every audit record carries tenant_id)
 *   - get-signal.ts (the PR 7 reference handler for the 42501 → 403
 *     mapping pattern + canonical composition order)
 */

import type { FastifyReply, FastifyRequest } from 'fastify';

import { withActorContext } from '../../../../lib/actor-context-binding.js';
import { resolveActorTenantIdForAudit } from '../../../../lib/auth-context.js';
import { withIdempotentExecution } from '../../../../lib/idempotent-handler.js';
import { withTenantContext } from '../../../../lib/rls.js';
import { requireTenantContext } from '../../../../lib/tenant-context.js';
import { ulid } from '../../../../lib/ulid.js';
import { withDbRole } from '../../../../lib/with-db-role.js';
import { emitEvaluationCompletedAudit } from '../../audit.js';

// ---------------------------------------------------------------------------
// ULID + body shape validation (HTTP boundary). Mirrors get-signal.ts §3 +
// the consent/forms-intake body shape style (lightweight predicates, no
// runtime schema lib — the canonical row shape lives in CDM v1.7 §4.NEW1
// and is enforced at the DB layer via column types + triggers).
// ---------------------------------------------------------------------------

const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;

function isUlid(s: unknown): s is string {
  return typeof s === 'string' && ULID_PATTERN.test(s);
}

const VALID_TRIGGERS = new Set([
  'prescribing',
  'refill',
  'protocol_gate',
  'manual_recheck',
  'lab_update',
  'adverse_event_investigation',
]);

interface CreateEvaluationBody {
  triggered_by?: string;
  triggered_by_resource_id?: string;
  patient_id?: string;
  engine_version?: string;
  knowledge_base_version?: string;
  medication_set_snapshot?: Record<string, unknown>;
  condition_set_snapshot?: Record<string, unknown>;
  lab_set_snapshot?: Record<string, unknown>;
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// ---------------------------------------------------------------------------
// Layer B authorization — deferred-permissive (Option 2 carryforward).
// Mirrors get-signal.ts §2 exactly; see that file for the long-form
// rationale + tightening followup. TODO(cross-slice cycle): replace with
// the SI-019-§5 role/membership matrix once tenant_account_membership
// (or per-slice cache equivalent) is available.
// ---------------------------------------------------------------------------
function assertLayerBAuthorized(req: FastifyRequest): void {
  if (req.actorContext !== undefined) {
    return;
  }
  const isProd = process.env['NODE_ENV'] === 'production';
  if (isProd) {
    throw req.server.httpErrors.unauthorized(
      'Actor identity could not be authenticated for this request.',
    );
  }
}

// ---------------------------------------------------------------------------
// Service-error mapper for withIdempotentExecution. We map PG 42501
// (insufficient_privilege) to 403 at the inner withDbRole try/catch
// already, so any error reaching here is unexpected — propagate to
// Fastify's global error handler.
// ---------------------------------------------------------------------------
function mapServiceError(): boolean {
  return false;
}

// ---------------------------------------------------------------------------
// Response view shape.
// ---------------------------------------------------------------------------
interface CreateEvaluationView {
  evaluation_id: string;
  evaluated_at: string;
}

// ---------------------------------------------------------------------------
// Handler.
// ---------------------------------------------------------------------------
export async function createEvaluationHandler(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<unknown> {
  const ctx = requireTenantContext(req);

  // §1 — Layer B (deferred-permissive).
  assertLayerBAuthorized(req);

  // §2 — Body validation (HTTP-boundary).
  const body = (req.body ?? {}) as CreateEvaluationBody;
  if (
    !isNonEmptyString(body.triggered_by) ||
    !VALID_TRIGGERS.has(body.triggered_by) ||
    !isUlid(body.triggered_by_resource_id) ||
    !isUlid(body.patient_id) ||
    !isNonEmptyString(body.engine_version) ||
    !isNonEmptyString(body.knowledge_base_version) ||
    !isObject(body.medication_set_snapshot) ||
    !isObject(body.condition_set_snapshot) ||
    !isObject(body.lab_set_snapshot)
  ) {
    return reply.code(400).send({
      error: {
        code: 'internal.request.invalid',
        message:
          'triggered_by (enum), triggered_by_resource_id (ULID), patient_id (ULID), ' +
          'engine_version, knowledge_base_version, medication_set_snapshot (object), ' +
          'condition_set_snapshot (object), and lab_set_snapshot (object) are required.',
        request_id: req.id,
      },
    });
  }

  // Capture narrowed body fields (TypeScript flow-narrowing keeps these
  // typed as `string` / `Record<string, unknown>` below).
  const triggeredBy = body.triggered_by;
  const triggeredByResourceId = body.triggered_by_resource_id;
  const patientId = body.patient_id;
  const engineVersion = body.engine_version;
  const knowledgeBaseVersion = body.knowledge_base_version;
  const medicationSetSnapshot = body.medication_set_snapshot;
  const conditionSetSnapshot = body.condition_set_snapshot;
  const labSetSnapshot = body.lab_set_snapshot;

  const actorNonce = req.actorNonce;
  // Best-effort actor id resolution — production has actorContext after
  // the auth plugin runs; in non-production the assertLayerBAuthorized
  // permissive path may not (used `system` placeholder).
  const actorId = req.actorContext?.accountId ?? 'system';
  const actorTenantId = resolveActorTenantIdForAudit(req, ctx.tenantId);

  // §3 — Idempotency-wrapped tx body. The idempotency helper opens the
  // tx + binds tenant context + the reserve-then-execute pattern; we
  // re-bind tenant context inside withTenantContext below for the SET
  // LOCAL semantics that the SECDEF function/RLS-policy path consumes
  // (idempotent-handler already SET set_tenant_context($1) earlier in
  // the tx — the inner withTenantContext is a no-op but the explicit
  // wrapping preserves the canonical composition shape from get-signal.ts
  // and pins the wrapperCalls order in unit tests).
  // §3 — Evaluation-window timer. Captured BEFORE entering the idempotency
  // body so the latency observability metric covers the engine's evaluation
  // window from request acceptance through commit. The column is
  // `interaction_engine_evaluation.evaluation_window_ms INTEGER NOT NULL
  // CHECK (>= 0)` per SI-019 Slice PRD v2.0 §CDM and migration 047 §1.
  // Server-computed (not body-supplied) per SI-019 spec ("latency
  // observability" attribute — handler responsibility).
  //
  // R1 Finding 1 closure (Codex 2026-05-23): the prior INSERT omitted
  // evaluation_window_ms entirely, which would have raised a NOT NULL
  // constraint violation against the schema on first integration test
  // against live PostgreSQL. The column is now populated from this
  // monotonic-time delta.
  const evaluationStartedAt = Date.now();

  return withIdempotentExecution<CreateEvaluationView>(req, reply, mapServiceError, async (tx) => {
    const evaluationId = ulid();
    const evaluatedAt = new Date();

    const callWrappers = async (): Promise<void> => {
      let evaluationWindowMsForAudit = 0;
      try {
        await withDbRole(tx, 'medication_interaction_engine_evaluator', async () => {
          // §3a — Direct INSERT into interaction_engine_evaluation
          // (per SI-019 spec: NOT via a SECDEF wrapper; the wrappers
          // in migration 050 are scoped to signal-lifecycle state
          // transitions, not evaluation creation).
          //
          // 12-column INSERT — matches migration 047 §1 schema exactly:
          //   id, tenant_id, patient_id, triggered_by,
          //   triggered_by_resource_id, evaluated_at,
          //   evaluation_window_ms, engine_version,
          //   knowledge_base_version, medication_set_snapshot,
          //   condition_set_snapshot, lab_set_snapshot.
          const evaluationWindowMs = Math.max(0, Date.now() - evaluationStartedAt);
          await tx.query(
            `INSERT INTO interaction_engine_evaluation (
                   id, tenant_id, patient_id, triggered_by, triggered_by_resource_id,
                   evaluated_at, evaluation_window_ms, engine_version, knowledge_base_version,
                   medication_set_snapshot, condition_set_snapshot, lab_set_snapshot
                 ) VALUES (
                   $1, $2, $3, $4, $5,
                   $6, $7, $8, $9,
                   $10::jsonb, $11::jsonb, $12::jsonb
                 )`,
            [
              evaluationId,
              ctx.tenantId,
              patientId,
              triggeredBy,
              triggeredByResourceId,
              evaluatedAt.toISOString(),
              evaluationWindowMs,
              engineVersion,
              knowledgeBaseVersion,
              JSON.stringify(medicationSetSnapshot),
              JSON.stringify(conditionSetSnapshot),
              JSON.stringify(labSetSnapshot),
            ],
          );
          evaluationWindowMsForAudit = evaluationWindowMs;
        });

        // §3b — Cat A audit emission in the SAME tx (I-003 + Option 2
        // carryforward atomicity), AFTER the withDbRole block returns.
        // Evidence-unlock PR live-PG fix: the audit INSERT must NOT run
        // under the elevated slice role — medication_interaction_engine_
        // evaluator has no audit_records privileges (least-privilege:
        // slice roles get their slice's tables only), so emitting inside
        // the elevated callback raised 42501 → 403 on live PostgreSQL.
        // withDbRole restores the prior session role on return (its R1
        // closure exists precisely for handlers that perform audit work
        // after the elevated call), so this emission runs as the app
        // role, in the SAME transaction — atomicity is unchanged.
        // Mirrors the async-consult record-decision precedent.
        //
        // Signals_produced_count is 0 at evaluation create time —
        // signals are INSERTed by the separate POST /signals endpoint
        // and attested via interaction_signal_emitted (the engine
        // evaluator may call /signals 1..N times after this row).
        //
        // Canonical lifecycle audit rule (R1 Finding 2 closure
        // 2026-05-23): this handler emits EXACTLY ONE audit event:
        //   1. interaction_engine_evaluation_completed (Cat A)
        // No other audit events fire from this handler. See `audit.ts`
        // file-level docstring for the cross-handler contract.
        await emitEvaluationCompletedAudit(
          {
            tenantId: ctx.tenantId,
            evaluationId,
            patientId,
            actorId,
            actorTenantId,
            countryOfCare: ctx.countryOfCare,
            triggeredBy,
            triggeredByResourceId,
            engineVersion,
            knowledgeBaseVersion,
            evaluationWindowMs: evaluationWindowMsForAudit,
            signalsProducedCount: 0,
          },
          tx,
        );
      } catch (err) {
        // 42501 → 403 per I-025 (mirrors get-signal.ts §5 pattern).
        // Both the SET LOCAL ROLE pre-callback step AND the inner
        // INSERT's RLS policy can raise 42501; the outer catch covers
        // both.
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

    await withTenantContext(tx, ctx.tenantId, async () => {
      if (typeof actorNonce === 'string' && actorNonce.length > 0) {
        await withActorContext(tx, actorNonce, callWrappers);
      } else {
        await callWrappers();
      }
    });

    return {
      status: 201,
      view: {
        evaluation_id: evaluationId,
        evaluated_at: evaluatedAt.toISOString(),
      },
    };
  });
}
