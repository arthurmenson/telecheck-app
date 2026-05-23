/**
 * med-interaction/internal/handlers/post-evaluation.ts —
 *   POST /v0/med-interaction/evaluations — record an interaction-engine evaluation.
 *
 * **PR 8 of N — FIRST WRITE HANDLER POST-FOUNDATION-051.**
 *
 * This is the first write-path handler for the Med-Interaction slice (SI-019
 * v2.0 P-033 + CDM v1.7 P-034). It establishes the canonical write composition
 * that every subsequent write handler mirrors (PR 9+ signal lifecycle actions):
 * a slice-role-elevated business INSERT under `withDbRole`, followed by a
 * same-transaction Cat A audit emission under the restored app role.
 *
 * Endpoint contract (OpenAPI v0.3 endpoint #1, mounted under the code-repo
 * `/v0/med-interaction` prefix per the platform-wide v0.1 path policy):
 *   Method   POST
 *   Path     /v0/med-interaction/evaluations
 *   Body     the engine-supplied evaluation context (see EvaluationBodySchema)
 *   Returns  201 + { evaluation_id } on success
 *            400 on malformed body
 *            401 if no authenticated actor (production fail-closed)
 *
 * **Backing entity (migration 047 §1):** `interaction_engine_evaluation` is a
 * strict append-only table (I-035) that records one row per engine invocation.
 * The `medication_interaction_engine_evaluator` application role holds the
 * direct `INSERT` grant (migration 047 §1 GRANT block) — there is no SECDEF
 * wrapper for evaluation creation (wrappers exist only for the signal lifecycle
 * state machine in migration 050). The INSERT runs under that role via
 * `withDbRole`; RLS WITH CHECK (`tenant_id = current_tenant_id()`) is satisfied
 * by the `app.tenant_id` GUC bound by `withTenantContext`.
 *
 * **Audit posture (I-002 / I-003):** the engine evaluation is the artifact the
 * Pharmacy clinician-commit gate and Mode 2 protocol gates read at
 * STRICT-FRESHNESS per I-002; recording it is a cataloged Cat A safety event
 * (`medication_interaction.engine_evaluation_completed`, AUDIT_EVENTS v5.9 /
 * P-034). The audit emission runs INSIDE the same transaction as the INSERT so
 * a partial commit cannot leave an evaluation row without its audit record
 * (I-003 same-transaction durability). It runs AFTER the `withDbRole` callback
 * returns — i.e. under the restored `telecheck_app_role`, which holds the
 * `audit_records` INSERT grant — not under the evaluator role.
 *
 * **Composition order:**
 *   withTransaction → withTenantContext → withActorContext? → {
 *     withDbRole(medication_interaction_engine_evaluator) → INSERT evaluation
 *     emitEngineEvaluationCompletedAudit(tx)   // restored app role, same tx
 *   }
 *
 * **Layer B authorization (deferred — same posture as PR 7 get-signal):**
 *   The spec intent for this endpoint is clinician / pharmacist / engine
 *   callers. Per the Option 2 ratifier carryforward, LAYER B role-membership
 *   authorization is deferred to a cross-slice integration cycle (the
 *   `tenant_account_membership` table is not in the code repo yet). At PR 8 the
 *   only check is that an authenticated actorContext is present (production
 *   fail-closed). The trust boundary that holds regardless: `withDbRole`
 *   hard-codes the evaluator role (a forged JWT cannot widen privilege) and the
 *   RLS WITH CHECK pins the row to the request-resolved tenant.
 *
 * Spec references:
 *   - SI-019 Med-Interaction Engine Slice PRD v2.0 §Sub-decision 1 (entity),
 *     §Sub-decision 2 (audit), §Sub-decision 4 (endpoint set)
 *   - CDM v1.6 → v1.7 Amendment §4.NEW1 (interaction_engine_evaluation),
 *     §4 AUDIT_EVENTS v5.9, §6 OpenAPI v0.3 endpoint #1
 *   - migration 047 §1 (entity + RLS + append-only triggers + INSERT grant)
 *   - I-002 (interaction-before-commit), I-003 (audit durability),
 *     I-023 (tenant isolation), I-035 (append-only)
 *   - src/modules/med-interaction/README.md
 */

import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { withActorContext } from '../../../../lib/actor-context-binding.js';
import { withTransaction } from '../../../../lib/db.js';
import { withTenantContext } from '../../../../lib/rls.js';
import { requireTenantContext } from '../../../../lib/tenant-context.js';
import { ulid } from '../../../../lib/ulid.js';
import { withDbRole } from '../../../../lib/with-db-role.js';
import { emitEngineEvaluationCompletedAudit } from '../../audit.js';

// ---------------------------------------------------------------------------
// ULID validation (Crockford base32, 26 chars) — same gate as get-signal for
// the caller-supplied resource id. The entity columns are VARCHAR(26); a
// malformed value would otherwise surface as a DB error rather than a clean
// HTTP-boundary 400.
// ---------------------------------------------------------------------------
const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;

// ---------------------------------------------------------------------------
// Request body schema (zod). Mirrors interaction_engine_evaluation's
// NOT NULL columns (migration 047 §1) minus the server-assigned `id` +
// the DEFAULT now() `evaluated_at`. `triggered_by` enum matches the table
// CHECK constraint verbatim. The three `*_snapshot` columns are JSONB; we
// accept any JSON object/array shape (the canonical inner structure is the
// engine's responsibility and is not constrained at the schema layer per the
// CDM, which types them as opaque JSONB).
// ---------------------------------------------------------------------------
const TRIGGERED_BY_VALUES = [
  'prescribing',
  'refill',
  'protocol_gate',
  'manual_recheck',
  'lab_update',
  'adverse_event_investigation',
] as const;

const JsonSnapshotSchema = z.union([z.record(z.string(), z.unknown()), z.array(z.unknown())]);

const EvaluationBodySchema = z.object({
  patient_id: z.string().regex(ULID_PATTERN, 'patient_id must be a 26-char Crockford-base32 ULID'),
  triggered_by: z.enum(TRIGGERED_BY_VALUES),
  triggered_by_resource_id: z
    .string()
    .regex(ULID_PATTERN, 'triggered_by_resource_id must be a 26-char Crockford-base32 ULID'),
  evaluation_window_ms: z.number().int().min(0),
  engine_version: z.string().min(1),
  knowledge_base_version: z.string().min(1),
  medication_set_snapshot: JsonSnapshotSchema,
  condition_set_snapshot: JsonSnapshotSchema,
  lab_set_snapshot: JsonSnapshotSchema,
});

type EvaluationBody = z.infer<typeof EvaluationBodySchema>;

// ---------------------------------------------------------------------------
// Layer B authorization (deferred-permissive; see file-level docstring).
// Identical posture to PR 7 get-signal: authenticated actor accepted; absent
// actor rejected 401 in production, permitted in non-production for test
// ergonomics. The withDbRole allowlist + RLS WITH CHECK are the trust
// boundaries that hold regardless of this permissive gate.
// ---------------------------------------------------------------------------
function assertLayerBAuthorized(req: FastifyRequest): void {
  // TODO(med-interaction cross-slice integration cycle): replace with the
  // SI-019-§Sub-decision-6 role matrix (clinician / pharmacist / engine
  // service account) once `tenant_account_membership` (or the per-slice cache
  // equivalent) is available.
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

export async function postEvaluationHandler(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<FastifyReply> {
  // §1 — Tenant context (I-023 fail-closed; tenantContextPlugin ran in the
  // onRequest hook; absence here is a programming error).
  const ctx = requireTenantContext(req);

  // §2 — Layer B authorization (deferred-permissive).
  assertLayerBAuthorized(req);

  // §3 — Body validation at the HTTP boundary.
  const parsed = EvaluationBodySchema.safeParse(req.body);
  if (!parsed.success) {
    const messages = parsed.error.issues
      .map((e) => `${e.path.join('.')}: ${e.message}`)
      .join('; ');
    throw req.server.httpErrors.badRequest(`Invalid evaluation body: ${messages}`);
  }
  const body: EvaluationBody = parsed.data;

  // §4 — Server-assigned ULID for the append-only evaluation row.
  const evaluationId = ulid();

  // §5 — Resolve the actor nonce for the withActorContext composition. The
  // direct INSERT does not call any current_actor_*() helper (no SECDEF
  // wrapper), so the nonce is defensive only — but threading it keeps the
  // write composition uniform with PR 9+ wrapper-calling handlers.
  const actorNonce = req.actorNonce;

  // §6 — Canonical write composition. The evaluation INSERT runs under the
  // evaluator slice role; the audit emission runs after the role is restored
  // (still inside the same tx + tenant context) so it executes as
  // telecheck_app_role, which holds the audit_records INSERT grant.
  await withTransaction(async (tx) => {
    return withTenantContext(tx, ctx.tenantId, async () => {
      const run = async (): Promise<void> => {
        await withDbRole(tx, 'medication_interaction_engine_evaluator', async () => {
          await tx.query(
            `INSERT INTO interaction_engine_evaluation (
                id, tenant_id, patient_id, triggered_by, triggered_by_resource_id,
                evaluation_window_ms, engine_version, knowledge_base_version,
                medication_set_snapshot, condition_set_snapshot, lab_set_snapshot
             ) VALUES (
                $1, $2, $3, $4, $5,
                $6, $7, $8,
                $9::jsonb, $10::jsonb, $11::jsonb
             )`,
            [
              evaluationId,
              ctx.tenantId,
              body.patient_id,
              body.triggered_by,
              body.triggered_by_resource_id,
              body.evaluation_window_ms,
              body.engine_version,
              body.knowledge_base_version,
              JSON.stringify(body.medication_set_snapshot),
              JSON.stringify(body.condition_set_snapshot),
              JSON.stringify(body.lab_set_snapshot),
            ],
          );
        });

        // Same-transaction Cat A audit emission (I-003 durability). Runs under
        // the restored app role.
        await emitEngineEvaluationCompletedAudit(
          {
            tenantId: ctx.tenantId,
            evaluationId,
            patientId: body.patient_id,
            countryOfCare: ctx.countryOfCare,
            triggeredBy: body.triggered_by,
            triggeredByResourceId: body.triggered_by_resource_id,
            engineVersion: body.engine_version,
            knowledgeBaseVersion: body.knowledge_base_version,
            evaluationWindowMs: body.evaluation_window_ms,
          },
          tx,
        );
      };

      if (typeof actorNonce === 'string' && actorNonce.length > 0) {
        return withActorContext(tx, actorNonce, run);
      }
      return run();
    });
  });

  // §7 — 201 Created with the server-assigned evaluation id.
  return reply.code(201).send({ evaluation_id: evaluationId });
}
