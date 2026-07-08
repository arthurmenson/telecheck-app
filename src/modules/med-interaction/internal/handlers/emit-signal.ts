/**
 * med-interaction/internal/handlers/emit-signal.ts —
 *   POST /v0/med-interaction/signals — emit a new signal under an
 *   existing interaction_engine_evaluation; calls the SECDEF wrapper
 *   `record_signal_emission(...)` from migration 050 to atomically
 *   INSERT the `interaction_signal` row + the paired initial
 *   `none → emitted` `interaction_signal_lifecycle_transition` row.
 *
 * **PR 8 of N — second write handler in this PR.**
 *
 * This handler follows the same canonical Option B composition pattern
 * established by `create-evaluation.ts` and the PR 7 reference handler
 * `get-signal.ts`:
 *
 *   - withTransaction (via withIdempotentExecution) → withTenantContext →
 *     withActorContext → withDbRole('medication_interaction_engine_evaluator')
 *     → SECDEF call (`record_signal_emission`) + Cat A audit emission in
 *     same tx.
 *   - 42501 → tenant-blind 403 mapping (I-025) via outer try/catch
 *     around the withDbRole call.
 *   - Cat A audit `interaction_signal_emitted` via
 *     `audit.ts emitSignalEmittedAudit` in the same tx as the wrapper call.
 *   - Layer B authorization deferred-permissive per Option 2 ratifier
 *     decision (any authenticated actor; production fail-closed).
 *
 * Endpoint contract:
 *   Method   POST
 *   Path     /v0/med-interaction/signals
 *   Body     {
 *              evaluation_id:        ULID,
 *              patient_id:           ULID,
 *              check_class:          'drug_drug'|'drug_condition'|'drug_lab'|
 *                                    'pharmacogenomic'|'special_clinical_flag',
 *              severity:             'critical'|'major'|'moderate'|'minor',
 *              recommended_action:   'block'|'warn'|'monitor',
 *              medications_involved: ULID[],
 *              evidence_sources:     JSON (KB citations),
 *              signal_payload:       JSON (structured signal payload)
 *            }
 *   Returns  201 + { signal_id, emitted_at } on success
 *            400 on malformed body
 *            401 if no authenticated actor (production fail-closed)
 *            403 if 42501 surfaces from SQL (insufficient scope OR
 *                cross-tenant evaluation_id)
 *            404 if the paired evaluation row does not exist (the
 *                wrapper raises SQLSTATE 02000 / `no_data` from its
 *                evidence check; mapped to a tenant-blind 404)
 *            409 on idempotency replay / in-flight / body mismatch
 *
 * **SECDEF wrapper signature (migration 050 §1):**
 *   record_signal_emission(
 *     p_id            VARCHAR(26),   -- ULID for the new transition row
 *     p_tenant_id     TEXT,
 *     p_signal_id     VARCHAR(26),   -- the just-INSERTed interaction_signal row
 *     p_actor_id      VARCHAR(26),
 *     p_metadata      JSONB
 *   ) RETURNS VOID
 *
 * **Pre-step (interaction_signal INSERT):**
 *   Per SI-019 Sub-decision 8 + migration 050 §1's evidence check, the
 *   `record_signal_emission` wrapper expects the paired interaction_signal
 *   row to already exist (it `SELECT EXISTS`-checks it). So the handler
 *   INSERTs the signal row FIRST (under the same withDbRole elevation),
 *   then calls the wrapper which INSERTs the initial lifecycle transition
 *   row. Both INSERTs run in the same transaction so a failed wrapper
 *   call rolls back the signal INSERT too — no orphan signal rows.
 *
 * **Canonical lifecycle audit rule for this handler (R1 Finding 2 closure
 * 2026-05-23):**
 *   This handler emits EXACTLY ONE audit event per successful request:
 *     1. `interaction_signal_emitted` (Cat A)
 *   The initial `none → emitted` lifecycle transition row INSERTed
 *   atomically by `record_signal_emission` is NOT separately attested by
 *   `interaction_signal_lifecycle_transition_emitted` — the
 *   `interaction_signal_emitted` event carries the same evidence
 *   (signal_id, evaluation_id, severity, check_class). The unit test
 *   below asserts the exact emitter call sequence (`auditCalls` mock log
 *   shape). See `audit.ts` file-level docstring `CANONICAL LIFECYCLE
 *   AUDIT RULE` for the full cross-handler contract.
 *
 * **Why not put the signal INSERT inside the wrapper?**
 *   The migration 050 wrapper's contract (per the §1 docstring) is
 *   strictly to record the lifecycle transition; the signal row INSERT
 *   stays in the application layer because the per-row column set
 *   (check_class, severity, KMS-relevant evidence_sources/signal_payload)
 *   is wide and likely to evolve, while the lifecycle transition is a
 *   stable 6-state machine. Same separation of concerns as Async Consult
 *   SI-005's `record_consult_clinician_decision` (decision row INSERTed
 *   by app code; lifecycle wrapper just records the state transition).
 *
 * Spec references:
 *   - SI-019 Slice PRD v2.0 §5 (POST /signals contract) + §6 (audit
 *     catalog enumeration for signal_emitted) + Sub-decision 8.5
 *     (wrapper-arbitration pattern)
 *   - CDM v1.6 → v1.7 Amendment §4.NEW2 (interaction_signal row shape) +
 *     §6.NEW2 (record_signal_emission wrapper signature)
 *   - migration 047 §2 (interaction_signal DDL + RLS + append-only
 *     trigger)
 *   - migration 050 §1 (record_signal_emission SECDEF wrapper)
 *   - I-002, I-003, I-025, I-027 (carryforward from create-evaluation.ts)
 *   - get-signal.ts (PR 7 reference handler for 42501 → 403 + composition)
 *   - create-evaluation.ts (sibling handler in this PR; same canonical
 *     shape)
 */

import type { FastifyReply, FastifyRequest } from 'fastify';

import { withActorContext } from '../../../../lib/actor-context-binding.js';
import { resolveActorTenantIdForAudit } from '../../../../lib/auth-context.js';
import { withIdempotentExecution } from '../../../../lib/idempotent-handler.js';
import { withTenantContext } from '../../../../lib/rls.js';
import { requireTenantContext } from '../../../../lib/tenant-context.js';
import { ulid } from '../../../../lib/ulid.js';
import { withDbRole } from '../../../../lib/with-db-role.js';
import { emitSignalEmittedAudit } from '../../audit.js';

const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;

function isUlid(s: unknown): s is string {
  return typeof s === 'string' && ULID_PATTERN.test(s);
}

function isUlidArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => isUlid(x));
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

const VALID_CHECK_CLASSES = new Set([
  'drug_drug',
  'drug_condition',
  'drug_lab',
  'pharmacogenomic',
  'special_clinical_flag',
]);

const VALID_SEVERITIES = new Set(['critical', 'major', 'moderate', 'minor']);

const VALID_RECOMMENDED_ACTIONS = new Set(['block', 'warn', 'monitor']);

interface EmitSignalBody {
  evaluation_id?: string;
  patient_id?: string;
  check_class?: string;
  severity?: string;
  recommended_action?: string;
  medications_involved?: unknown;
  evidence_sources?: Record<string, unknown>;
  signal_payload?: Record<string, unknown>;
}

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

function mapServiceError(): boolean {
  return false;
}

interface EmitSignalView {
  signal_id: string;
  emitted_at: string;
}

export async function emitSignalHandler(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<unknown> {
  const ctx = requireTenantContext(req);

  assertLayerBAuthorized(req);

  const body = (req.body ?? {}) as EmitSignalBody;
  if (
    !isUlid(body.evaluation_id) ||
    !isUlid(body.patient_id) ||
    !isNonEmptyString(body.check_class) ||
    !VALID_CHECK_CLASSES.has(body.check_class) ||
    !isNonEmptyString(body.severity) ||
    !VALID_SEVERITIES.has(body.severity) ||
    !isNonEmptyString(body.recommended_action) ||
    !VALID_RECOMMENDED_ACTIONS.has(body.recommended_action) ||
    !isUlidArray(body.medications_involved) ||
    !isObject(body.evidence_sources) ||
    !isObject(body.signal_payload)
  ) {
    return reply.code(400).send({
      error: {
        code: 'internal.request.invalid',
        message:
          'evaluation_id (ULID), patient_id (ULID), check_class (enum), severity (enum), ' +
          'recommended_action (enum), medications_involved (ULID[]), evidence_sources ' +
          '(object), and signal_payload (object) are required.',
        request_id: req.id,
      },
    });
  }

  const evaluationId = body.evaluation_id;
  const patientId = body.patient_id;
  const checkClass = body.check_class;
  const severity = body.severity;
  const recommendedAction = body.recommended_action;
  const medicationsInvolved = body.medications_involved;
  const evidenceSources = body.evidence_sources;
  const signalPayload = body.signal_payload;

  const actorNonce = req.actorNonce;
  const actorId = req.actorContext?.accountId ?? 'system';
  const actorTenantId = resolveActorTenantIdForAudit(req, ctx.tenantId);

  return withIdempotentExecution<EmitSignalView>(req, reply, mapServiceError, async (tx) => {
    const signalId = ulid();
    const transitionId = ulid();
    const emittedAt = new Date();

    const callWrappers = async (): Promise<void> => {
      let derivedPatientIdForAudit = '';
      try {
        await withDbRole(tx, 'medication_interaction_engine_evaluator', async () => {
          // §1 — Derive the canonical patient_id from the persisted
          // interaction_engine_evaluation row, in the SAME tx, BEFORE
          // the audit emission. The body-supplied patient_id is
          // validated against this derived value; on mismatch the
          // handler fails closed with a tenant-blind 404 (the wire
          // response does not differentiate "wrong patient" from
          // "evaluation does not exist in this tenant" per I-025).
          //
          // R2 HIGH-1 closure (Codex 2026-05-24): the prior version
          // passed the body-supplied patient_id straight into the
          // audit emitter without validation, so a bad client or
          // compromised same-tenant caller could emit a signal under
          // evaluation A but place the Cat A audit record under
          // patient B — corrupting per-patient audit reconstruction
          // and the patient-scoped hash-chain partition.
          const evalRow = await tx.query(
            `SELECT patient_id
                   FROM interaction_engine_evaluation
                  WHERE tenant_id = $1 AND id = $2`,
            [ctx.tenantId, evaluationId],
          );
          const evalRows = evalRow.rows as Array<{ patient_id: string }>;
          const derivedPatientId = evalRows[0]?.patient_id;
          if (typeof derivedPatientId !== 'string' || derivedPatientId.length === 0) {
            // Missing evaluation row → tenant-blind 404 (I-025).
            throw req.server.httpErrors.notFound('Interaction signal not found.');
          }
          if (derivedPatientId !== patientId) {
            // Body-supplied patient_id does not match the durable
            // evaluation row → tenant-blind 404. Do NOT differentiate
            // "wrong patient" from "wrong tenant" / "doesn't exist."
            throw req.server.httpErrors.notFound('Interaction signal not found.');
          }

          // §2 — INSERT the interaction_signal row. The SECDEF
          // wrapper's evidence check (`SELECT EXISTS FROM
          // interaction_signal WHERE id = $1`) requires this to be
          // present before the wrapper runs.
          await tx.query(
            `INSERT INTO interaction_signal (
                   id, tenant_id, evaluation_id, check_class, severity,
                   recommended_action, medications_involved, evidence_sources,
                   signal_payload
                 ) VALUES (
                   $1, $2, $3, $4, $5,
                   $6, $7::varchar(26)[], $8::jsonb, $9::jsonb
                 )`,
            [
              signalId,
              ctx.tenantId,
              evaluationId,
              checkClass,
              severity,
              recommendedAction,
              medicationsInvolved,
              JSON.stringify(evidenceSources),
              JSON.stringify(signalPayload),
            ],
          );

          // §3 — Call the SECDEF wrapper to INSERT the initial
          // `none → emitted` lifecycle transition row atomically.
          // The wrapper acquires the per-(tenant, signal) advisory
          // lock + re-validates the signal row exists + delegates
          // to record_interaction_signal_lifecycle_transition (raw
          // writer from migration 049).
          await tx.query('SELECT record_signal_emission($1, $2, $3, $4, $5::jsonb)', [
            transitionId,
            ctx.tenantId,
            signalId,
            actorId,
            JSON.stringify({ evaluation_id: evaluationId }),
          ]);

          derivedPatientIdForAudit = derivedPatientId;
        });

        // §4 — Cat A audit `interaction_signal_emitted` in the SAME tx
        // as the wrapper call, AFTER the withDbRole block returns.
        // Evidence-unlock PR live-PG fix: the audit INSERT must NOT run
        // under the elevated slice role — medication_interaction_engine_
        // evaluator has no audit_records privileges (least-privilege:
        // slice roles get their slice's tables only), so emitting inside
        // the elevated callback raised 42501 → 403 on live PostgreSQL.
        // withDbRole restores the prior session role on return (its R1
        // closure exists precisely for handlers that perform audit work
        // after the elevated call), so this runs as the app role in the
        // SAME transaction — the I-003 / Option 2 atomicity guarantee is
        // unchanged (an audit-INSERT failure still rolls back the signal
        // INSERT + lifecycle transition INSERT). Mirrors the
        // async-consult record-decision precedent.
        //
        // The patient_id passed to the audit emitter is the DB-derived
        // value, NOT the body-supplied value (R2 HIGH-1 closure). They
        // are validated equal above, so this is a defense-in-depth use
        // of the derived value.
        await emitSignalEmittedAudit(
          {
            tenantId: ctx.tenantId,
            signalId,
            evaluationId,
            patientId: derivedPatientIdForAudit,
            actorId,
            actorTenantId,
            countryOfCare: ctx.countryOfCare,
            checkClass,
            severity,
            recommendedAction,
          },
          tx,
        );
      } catch (err) {
        // 42501 → tenant-blind 403 (I-025). Covers SET LOCAL ROLE +
        // INSERT RLS denial + SECDEF wrapper's tenant-scope guard
        // (record_signal_emission raises 42501 via the SI-010
        // current_actor_account_tenant_id() check on tenant mismatch).
        if (typeof err === 'object' && err !== null && 'code' in err) {
          const code = (err as { code?: unknown }).code;
          if (code === '42501') {
            throw req.server.httpErrors.forbidden('Insufficient scope for this request.');
          }
          // The wrapper raises SQLSTATE 02000 (`no_data`) with
          // message `paired_signal_not_found` when the evidence
          // check finds no signal row — defensive coverage since
          // the handler INSERTs the row above (this would only fire
          // if a future race / different code path called the
          // wrapper directly). Map to a tenant-blind 404.
          if (code === '02000') {
            throw req.server.httpErrors.notFound('Interaction signal not found.');
          }
          // R2 HIGH-3 closure (Codex 2026-05-24): interaction_signal
          // has a composite FK to (tenant_id, evaluation_id), so an
          // unknown or cross-tenant evaluation_id fails on the INSERT
          // with SQLSTATE 23503 (foreign_key_violation) BEFORE the
          // SECDEF wrapper runs. The §1 pre-INSERT evaluation lookup
          // catches the well-formed-but-missing case (and the
          // patient-mismatch case) and maps to 404 cleanly, but if a
          // concurrent DELETE / RLS-policy-rejected lookup somehow
          // races between §1 and §2 the INSERT can still raise 23503.
          // Map to tenant-blind 404 per I-025 — same wire response as
          // "evaluation does not exist in this tenant."
          if (code === '23503') {
            throw req.server.httpErrors.notFound('Interaction signal not found.');
          }
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
        signal_id: signalId,
        emitted_at: emittedAt.toISOString(),
      },
    };
  });
}
