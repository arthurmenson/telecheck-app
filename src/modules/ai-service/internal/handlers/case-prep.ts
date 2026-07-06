/**
 * ai-service/internal/handlers/case-prep.ts — Mode 2 protocol-execution
 * case-prep agent HTTP handler.
 *
 * POST /v0/ai/case-prep
 *   Request body:
 *     { consult_id: string, protocol_id: string, protocol_version: string,
 *       patient_id: string, context: object }
 *   Response (Mode2CasePrepResponseView):
 *     200 — canonical AI envelope + case-prep recommendation
 *     400 — malformed body / missing required field
 *     401 — no authenticated actor (Bearer JWT required)
 *     403 — non-clinician actor (Mode 2 is clinician-driven; Mode 1 is
 *           patient-facing)
 *     503 — audit-emission-failed (idempotency cache rolls back; retry
 *           runs a fresh lifecycle)
 *
 * Mode 2 is the protocol-execution AI workload class per ADR-002 +
 * ADR-029 WORKLOAD_TAXONOMY. The agent operates inside a clinician-
 * supervised protocol envelope and prepares clinical material
 * (recommendation, confidence, concern flags) for clinician review.
 * The clinician then approves / modifies / declines per AI Clinical
 * Assistant Slice PRD v1.0 §4.2 + §6 — Mode 2 itself NEVER prescribes
 * at v1.0 (autonomy ceiling = action_with_confirm per ADR-005 + I-012).
 *
 * Lifecycle (mirrors the Mode 1 chat.ts pattern):
 *   1. Resolve tenant context (auto via plugin) + actor context (JWT)
 *   2. Layer B authorization — clinician-only at v1.0; reject patient /
 *      tenant_admin / platform_admin actors
 *   3. Two-stage body validation (R6 H1 closure pattern):
 *        Stage 1 — minimal shape check on raw inputs sufficient for
 *                  the crisis gate to scan input segments. If the body
 *                  is so malformed there's no text to scan, 400 early.
 *        Stage 2 — full Zod validation AFTER the crisis gate, so a
 *                  crisis-text-bearing oversized payload still gets
 *                  Cat A audit + crisis-sentinel response (FLOOR-013).
 *   4. Crisis-floor preflight (I-019 platform-floor) via runCrisisGate
 *      on the patient context text segments. On positive detection:
 *      emit Cat A audit (inside runCrisisGate) + return crisis-
 *      response envelope + DO NOT invoke the LLM.
 *   5. Call the LLM provider via the same provider abstraction Mode 1
 *      uses (resolveProvider → NullLLMProvider at v1.0 → always throws
 *      LLMProviderUnavailableError → AI-RESIL-001 fail-soft).
 *   6. Stamp the canonical AI envelope per CLAUDE.md hard rule for
 *      Mode 2 specifically — protocol_id + protocol_version, NOT
 *      guardrail_template_id (which is Mode 1's field).
 *   7. Emit Cat A `ai_mode_2_evaluation` audit same-tx (AUDIT_EVENTS
 *      v5.3 canonical action ID).
 *   8. Return Mode2CasePrepResponseView with the recommendation +
 *      envelope.
 *
 * Per I-019 + FLOOR-013: crisis detection runs UNCONDITIONALLY on
 * input. No protocol activation, no admin configuration, no flag-flip
 * can disable it.
 *
 * Per AI-RESIL-001: when no LLM provider is available, the surface
 * gracefully degrades to a documented "case-prep temporarily
 * unavailable" envelope. The clinician is informed; the audit
 * captures provider_unavailable=true.
 *
 * Per I-012 + ADR-005: this handler emits the case-prep envelope
 * ONLY. The reject-unless three-clause rule (autonomy_level ==
 * 'action_with_confirm' + explicit clinician confirmation in audit
 * chain + RBAC-authorized confirming actor) is enforced at the
 * DOWNSTREAM prescribing boundary in the protocol-engine slice (per
 * State Machines v1.2 §19 §19.X) — case-prep itself does NOT
 * execute prescribing, so the three-clause rule doesn't bind here.
 * The case-prep envelope is the AUDIT ANCHOR the downstream
 * `prescribing.protocol_authorization_granted` event references via
 * the ai_workflow_execution_id resource_id.
 *
 * Spec references:
 *   - AI Clinical Assistant Slice PRD v1.0 §4.2 (Mode 2 case-prep)
 *   - AI_LAYERING v5.2 §2 AI-ARCH-002 (Mode 2 protocol_execution)
 *   - AI_LAYERING v5.2 §6 FLOOR-020 (audit envelope; crisis-write
 *     exception)
 *   - AI_LAYERING v5.2 §7 (AI-RESIL-001/002)
 *   - WORKLOAD_TAXONOMY v5.2 (protocol_execution discriminator)
 *   - AUTONOMY_LEVELS v5.2 (action_with_confirm ceiling at v1.0)
 *   - ADR-002 (binary AI mode; preserved at v1.0)
 *   - ADR-005 (protocolized autonomy; action_with_confirm for
 *     protocol_execution)
 *   - ADR-020 (multi-provider LLM abstraction)
 *   - ADR-029 (AI workload taxonomy)
 *   - I-012 (reject-unless three-clause — enforced downstream)
 *   - I-019 (crisis detection platform-floor; always-on)
 *   - I-023 / I-025 / I-027 (tenant scoping; tenant-blind errors;
 *     tenant_id on every audit record)
 *   - AUDIT_EVENTS v5.3 `ai_mode_2_evaluation` Category A
 */

import { createHash } from 'node:crypto';

import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { requireActorContext } from '../../../../lib/auth-context.js';
import { asTenantId } from '../../../../lib/glossary.js';
import { buildIdempotencyCtx, type IdempotencyCtx } from '../../../../lib/idempotency.js';
import { withIdempotentExecution } from '../../../../lib/idempotent-handler.js';
import { requireTenantContext } from '../../../../lib/tenant-context.js';
import { emitMode2CasePrepResponseAudit } from '../../audit.js';
import { runCrisisGate } from '../crisis/gate.js';
import { NullLLMProvider } from '../providers/null-provider.js';
import { LLMProviderUnavailableError } from '../providers/types.js';
import { asAIWorkflowExecutionId, type Mode2CasePrepResponseView } from '../types.js';

// ---------------------------------------------------------------------------
// Request body schema
// ---------------------------------------------------------------------------

/**
 * Mode 2 case-prep request body. Conservative limits at v0.1:
 *   - consult_id: ULID-shaped (per CDM v1.2). The consult is the
 *     clinical anchor; Mode 2 audit records reference consult_id (not
 *     session_id, which is Mode 1's discriminator).
 *   - protocol_id / protocol_version: caller-supplied per AI Clinical
 *     Assistant Slice PRD v1.0 §4.2 ("operates inside an approved
 *     protocol envelope"). The protocol-engine slice (not yet shipped)
 *     will validate these against the active protocol registry; at
 *     v0.1 we accept any non-empty strings and TODO the validation.
 *   - patient_id: the consult subject. Distinct from the actor
 *     (clinician).
 *   - context: structured intake data the agent reasons over (symptom
 *     questionnaire, history, current medications, allergies,
 *     contraindications per Slice PRD v1.0 §4.2). Open-shape object
 *     at v0.1 — schema lands when Forms/Intake → case-prep
 *     integration contract is finalized.
 *
 * Upper bound on context-as-JSON: 32KB. Conservative enough to fit
 * any reasonable intake bundle without enabling abuse via oversized
 * payloads. The crisis-gate scan happens BEFORE this bound is
 * enforced (two-stage validation, R6 H1 pattern from Mode 1 chat).
 */
const Mode2CasePrepRequestSchema = z.object({
  consult_id: z.string().min(1, 'consult_id is required').max(64),
  protocol_id: z.string().min(1, 'protocol_id is required').max(128),
  protocol_version: z.string().min(1, 'protocol_version is required').max(32),
  patient_id: z.string().min(1, 'patient_id is required').max(64),
  // Context schema is intentionally open at v0.1 — final shape lands
  // with the Forms/Intake → case-prep integration contract.
  context: z.record(z.string(), z.unknown()),
});

/** Max serialized JSON context length (chars). */
const MAX_CONTEXT_JSON_LENGTH = 32_768;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * v0.1 provider routing: per ADR-020, every active workload routes to
 * NullLLMProvider until real adapters land. The Null provider always
 * throws `LLMProviderUnavailableError`, exercising the AI-RESIL-001
 * fail-soft path on every request.
 *
 * When real adapters land, swap this for
 * `resolveProvider('protocol_execution')`. The provider abstraction
 * does NOT differ between Mode 1 conversational_assistant and Mode 2
 * protocol_execution — the workload-type discriminator is on the
 * `LLMCompletionRequest` itself per ADR-020.
 */
function getMode2Provider(): NullLLMProvider {
  return new NullLLMProvider();
}

/**
 * Derive a deterministic Mode 2 identifier from the idempotency
 * context. Mirrors the Mode 1 chat.ts pattern (R4 H1 closure):
 * deterministic IDs preserve crisis-audit dedupe slot stability
 * across retries (the gate's dedupe key includes resourceId).
 *
 * NOT a security boundary — these IDs are opaque per-request handles,
 * not authorization tokens. The trust chain remains tenant_id +
 * actor_id + target_patient_id in the audit envelope.
 */
function deriveDeterministicId(prefix: string, ctx: IdempotencyCtx, variant = ''): string {
  const seed = `${ctx.tenantId}|${ctx.idempotencyKey}|${ctx.actorId}|${ctx.endpoint}|${ctx.bodyHash}|${variant}`;
  const hash = createHash('sha256').update(seed).digest('hex');
  return `${prefix}${hash.slice(0, 26)}`;
}

/**
 * Canonical AI-RESIL-001 fail-soft response text for Mode 2. The
 * clinician sees a clear "case-prep unavailable" signal so they can
 * proceed with a fully-manual review path. Centralized so the exact
 * wording is reviewable in one place + CCR-tenant-localizable in a
 * follow-up.
 */
const AI_UNAVAILABLE_CASE_PREP_TEXT =
  'AI case-prep is temporarily unavailable for this consult. Proceed with manual review; ' +
  'no AI-prepared recommendation is available. The patient context has been logged for ' +
  'audit. Retry case-prep generation when the AI surface returns to a healthy state.';

/**
 * Canonical crisis-response text for Mode 2 case-prep. When the input
 * scan detects crisis indicators in the patient context, the agent
 * does NOT prepare a case — the consult is routed to immediate
 * clinician review with emergency flags per Slice PRD v1.0 §10.X
 * (Mode 2 crisis behavior).
 */
const CRISIS_CASE_PREP_TEXT =
  'Case-prep was halted because the patient context contains crisis indicators. The case ' +
  'has been routed to immediate clinician review with emergency flags. No AI-prepared ' +
  'recommendation is provided; the clinician should review the patient context directly ' +
  'and act per crisis-response protocol.';

/**
 * V0.1 STUB recommendation text. When the real provider lands, this
 * is replaced by the LLM's protocol-aware case-prep output. Kept here
 * so the wire shape + audit emission are exercised end-to-end against
 * the Null provider's fail-soft path (which always overrides this
 * stub at v0.1).
 *
 * TODO(SI-AI-MODE2): wire real protocol-aware prompting (load protocol
 * by id + version, render the Slice PRD §4.2 instruction set,
 * structure the context for LLM consumption, parse a structured
 * recommendation back) — lands with the protocol-engine slice.
 */
const STUB_RECOMMENDATION_TEXT =
  'AI case-prep stub recommendation: protocol-aware prompting + structured response ' +
  'parsing are not wired at v0.1. Clinician should review the patient context directly.';

/**
 * Serialize the context payload to a deterministic JSON string for
 * crisis scanning + length-bounding. JSON.stringify with no replacer
 * yields stable output for primitive-keyed objects, which matches the
 * IdempotencyCtx body-hash computation (so retries produce the same
 * length).
 */
function serializeContext(context: Record<string, unknown>): string {
  return JSON.stringify(context);
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * Mode 2 case-prep handler's typed audit-emission-failure sentinel —
 * mirrors the Mode 1 chat.ts pattern (R3 H1 closure): translates a
 * rethrown audit error into the documented 503 envelope so the
 * idempotency cache rolls back + the client's retry runs a fresh
 * lifecycle.
 */
class Mode2AuditEmissionFailedError extends Error {
  /** Original audit-emission error; preserved for ops triage. */
  readonly auditCause: unknown;
  constructor(auditCause: unknown) {
    super('mode_2_case_prep_audit_emission_failed');
    this.name = 'Mode2AuditEmissionFailedError';
    this.auditCause = auditCause;
  }
}

/**
 * Service-error mapper for `withIdempotentExecution`. Translates the
 * Mode2AuditEmissionFailedError into a tenant-blind 503 with retry-
 * advisory semantics. Other unmapped errors propagate to Fastify's
 * global error handler.
 */
function mapServiceError(err: unknown, reply: FastifyReply, reqId: string): boolean {
  if (err instanceof Mode2AuditEmissionFailedError) {
    void reply.code(503).send({
      error: {
        code: 'ai_case_prep.audit_emission_unavailable',
        message:
          'AI case-prep is temporarily unable to record the response audit. Please try again.',
        request_id: reqId,
      },
    });
    return true;
  }
  return false;
}

export async function mode2CasePrepHandler(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<unknown> {
  const ctx = requireTenantContext(req);
  const actor = requireActorContext(req);

  // Layer B authorization: Mode 2 case-prep is clinician-driven at
  // v1.0. Patients never interact with Mode 2 directly (per Slice PRD
  // v1.0 §4.2 "Where it operates: Behind the scenes... The patient
  // does not see Mode 2 or know it by that name"). tenant_admin /
  // platform_admin similarly do not invoke clinical case-prep
  // surfaces.
  //
  // Defense-in-depth on top of route-level RBAC (which a successor SI
  // will tighten to a clinician-role-membership check; v0.1 uses the
  // JWT role claim).
  //
  // TODO(SI-024): tighten via clinician-role membership + (future)
  // protocol-eligibility check (clinician must be on the consult's
  // care team for the named protocol).
  if (actor.role !== 'clinician') {
    throw req.server.httpErrors.forbidden('Mode 2 case-prep is clinician-only.');
  }

  // Reject delegated sessions for Mode 2 at v0.1 — case-prep operates
  // on the clinician's direct authorization. Delegate-aware clinician
  // workflows (e.g., a nurse acting on behalf of a physician) require
  // explicit delegate-scope handling that lands with the delegation
  // slice.
  if (actor.delegateId !== null) {
    throw req.server.httpErrors.forbidden(
      'Mode 2 case-prep does not support delegated sessions at v0.1.',
    );
  }

  // Two-stage body validation (R6 H1 closure pattern from Mode 1 chat).
  // Crisis detection MUST run on the patient context text BEFORE we
  // 400-reject for length / format — otherwise an oversized context
  // bearing crisis indicators would be rejected at validation with no
  // I-019 audit + no crisis-sentinel response (defeating FLOOR-013).
  //
  // Stage 1: minimal pre-gate shape check. Extract the required
  // identifiers AND a serializable context object. If the body shape
  // is so malformed there's no scannable context, 400 immediately
  // (there's no crisis text path to preserve).
  const rawBody = (req.body ?? {}) as Record<string, unknown>;
  const rawConsultId = rawBody['consult_id'];
  const rawProtocolId = rawBody['protocol_id'];
  const rawProtocolVersion = rawBody['protocol_version'];
  const rawPatientId = rawBody['patient_id'];
  const rawContext = rawBody['context'];

  if (
    typeof rawConsultId !== 'string' ||
    rawConsultId.length === 0 ||
    typeof rawProtocolId !== 'string' ||
    rawProtocolId.length === 0 ||
    typeof rawProtocolVersion !== 'string' ||
    rawProtocolVersion.length === 0 ||
    typeof rawPatientId !== 'string' ||
    rawPatientId.length === 0 ||
    typeof rawContext !== 'object' ||
    rawContext === null ||
    Array.isArray(rawContext)
  ) {
    throw req.server.httpErrors.badRequest(
      'Invalid request body: consult_id / protocol_id / protocol_version / patient_id ' +
        '(non-empty strings) and context (object) are required.',
    );
  }

  // Serialize context for crisis scanning + length checks. JSON.stringify
  // can throw on circular references; treat that as a 400 (the crisis
  // gate can't scan an unserializable structure).
  let contextText: string;
  try {
    contextText = serializeContext(rawContext as Record<string, unknown>);
  } catch (_err) {
    throw req.server.httpErrors.badRequest(
      'Invalid request body: context must be JSON-serializable (no circular references).',
    );
  }

  const idempotencyCtx = buildIdempotencyCtx(req);
  const workflowExecutionId = asAIWorkflowExecutionId(
    deriveDeterministicId('aiwfe_', idempotencyCtx),
  );

  return withIdempotentExecution(req, reply, mapServiceError, async (_tx) => {
    // I-019 crisis gate on INPUT — runs BEFORE any LLM call. Emits
    // the canonical `crisis_detection_trigger` Category A audit on
    // positive detection. Always-on per FLOOR-013. idempotencyCtx
    // threads through so the gate's audit-dedupe slot prevents
    // Category A double-emit on Idempotency-Key replay.
    //
    // auditDedupeDiscriminator='context_serialized' is required for
    // case-prep per gate.ts (Codex PR F R6 HIGH): Mode 2 scans
    // multiple consult segments, and a per-segment discriminator is
    // mandatory to prevent the dedupe marker from silently
    // suppressing later positive detections. At v0.1 we scan the
    // whole serialized context as one segment; when per-field
    // segment scanning lands (Slice PRD v1.0 §10.X), each field
    // gets its own discriminator.
    const inputCrisisOutcome = await runCrisisGate(
      {
        tenantId: ctx.tenantId,
        countryOfCare: ctx.countryOfCare,
        aiActorId: 'system:ai_mode_2_case_prep',
        patientId: rawPatientId,
        resourceType: 'ai_workflow_execution',
        resourceId: workflowExecutionId,
        // CCR-driven crisis-escalation resolver lands with the
        // crisis-escalation slice (Slice PRD §6.2 + CCR_RUNTIME).
        // Null at v0.1 → ops alert via the crisis audit row.
        escalationDestination: null,
        idempotencyCtx,
        auditDedupeDiscriminator: 'context_serialized',
      },
      contextText,
      'ai_case_prep_input',
    );

    const crisisDetected = inputCrisisOutcome.kind === 'crisis';

    // Stage 2 validation: enforce the full Zod constraints + the
    // context-length bound ONLY if no crisis was detected. If crisis
    // was detected, we proceed to the crisis-sentinel response path
    // regardless of payload size — the clinician still needs the
    // safety surface + the audit chain has captured Cat A.
    if (!crisisDetected) {
      const parsed = Mode2CasePrepRequestSchema.safeParse({
        consult_id: rawConsultId,
        protocol_id: rawProtocolId,
        protocol_version: rawProtocolVersion,
        patient_id: rawPatientId,
        context: rawContext,
      });
      if (!parsed.success) {
        throw req.server.httpErrors.badRequest(
          `Invalid request body: ${parsed.error.issues
            .map((e) => `${e.path.join('.')}: ${e.message}`)
            .join('; ')}`,
        );
      }
      if (contextText.length > MAX_CONTEXT_JSON_LENGTH) {
        throw req.server.httpErrors.badRequest(
          `Invalid request body: context serialized to ${contextText.length} chars; max ` +
            `${MAX_CONTEXT_JSON_LENGTH}.`,
        );
      }
    }

    // Branch: crisis → return crisis-resource sentinel response
    // without calling the LLM. AI_LAYERING §6 crisis-write exception:
    // the response surfaces even if Cat A crisis-audit emission
    // failed (the audit_emitted=false case in the gate outcome).
    let recommendationText: string;
    let providerUnavailable: boolean;
    let aiModelVersion: string;
    let confidence: 'low' | 'medium' | 'high';
    let concernFlags: ReadonlyArray<string>;

    if (crisisDetected) {
      recommendationText = CRISIS_CASE_PREP_TEXT;
      providerUnavailable = false;
      aiModelVersion = 'crisis-bypass:no-llm-call';
      // Crisis-bypass: confidence + concern_flags are sentinel-safe
      // values. Clinician-facing UI branches on crisis_detected
      // before rendering confidence; these defaults are inert.
      confidence = 'low';
      concernFlags = ['crisis_detected_in_input'];
    } else {
      // No crisis → attempt LLM completion. At v0.1 the NullLLMProvider
      // throws LLMProviderUnavailableError unconditionally; the
      // AI-RESIL-001 fail-soft path renders the documented "case-prep
      // temporarily unavailable" envelope.
      const provider = getMode2Provider();
      try {
        const result = await provider.sendCompletion({
          workload_type: 'protocol_execution',
          messages: [
            {
              role: 'system',
              content:
                `You are an AI case-prep agent operating under protocol ${rawProtocolId} ` +
                `(version ${rawProtocolVersion}). Per AI Clinical Assistant Slice PRD ` +
                `v1.0 §4.2 you do not converse with patients and do not auto-approve ` +
                `clinical actions. Prepare a structured recommendation for clinician ` +
                `review only.`,
            },
            { role: 'user', content: contextText },
          ],
          max_output_tokens: 4096,
          // Clinical paths default to deterministic (temperature=0).
          temperature: 0,
          tenant_id: ctx.tenantId,
        });
        recommendationText = result.text || STUB_RECOMMENDATION_TEXT;
        providerUnavailable = false;
        aiModelVersion = `${result.provider_name}:${result.model_version}`;
        // Confidence + concern flags come from the structured-response
        // parser that lands with the real provider integration. At
        // v0.1 we default to a conservative 'low' + no flags; the
        // clinician sees the AI surfaced something but treats the
        // band as advisory.
        confidence = 'low';
        concernFlags = [];
      } catch (err) {
        if (err instanceof LLMProviderUnavailableError) {
          recommendationText = AI_UNAVAILABLE_CASE_PREP_TEXT;
          providerUnavailable = true;
          aiModelVersion = 'null-provider:unavailable';
          confidence = 'low';
          concernFlags = ['ai_unavailable_manual_review_required'];
          req.log.warn(
            {
              err,
              ai_workflow_execution_id: workflowExecutionId,
              consult_id: rawConsultId,
            },
            'mode2_case_prep: LLM provider unavailable; surfaced AI-RESIL-001 fail-soft response',
          );
        } else {
          // Unknown error class — re-throw so the global error
          // envelope plugin can map it to the canonical 5xx surface.
          throw err;
        }
      }
    }

    // Emit Cat A `ai_mode_2_evaluation` audit inside the same
    // transaction the idempotent-execution helper opened. Per the
    // Mode 1 R2 H1 + R3 H1 closures: do NOT swallow audit emission
    // failures. withIdempotency marks the cache row completed when
    // the callback returns successfully, so a swallowed audit error
    // would cache an unaudited patient-touching 200 and replay it on
    // retry — a permanent audit gap. Correct posture: rethrow on
    // audit failure; mapServiceError translates to a tenant-blind
    // 503; the idempotency cache reservation rolls back; the client's
    // retry runs a fresh lifecycle (including a fresh crisis-audit
    // attempt, deduped by idempotencyCtx so Cat A doesn't double-
    // emit on the retry).
    //
    // The AI_LAYERING §6 crisis-write exception applies to the
    // Category A `crisis_detection_trigger` audit emitted INSIDE
    // runCrisisGate (which has its own dedupe-aware fail-soft path).
    // It does NOT apply to this Cat A `ai_mode_2_evaluation` audit —
    // losing the case-prep response audit in exchange for caching
    // an audit-less 200 is the worse trade.
    try {
      await emitMode2CasePrepResponseAudit(
        {
          tenantId: asTenantId(ctx.tenantId),
          actorId: actor.accountId,
          actorTenantId: ctx.tenantId,
          countryOfCare: ctx.countryOfCare,
          targetPatientId: rawPatientId,
          aiModelVersion,
          detail: {
            ai_workflow_execution_id: workflowExecutionId,
            consult_id: rawConsultId,
            ai_mode: 'mode_2',
            protocol_id: rawProtocolId,
            protocol_version: rawProtocolVersion,
            confidence,
            concern_flag_count: concernFlags.length,
            crisis_detected: crisisDetected,
            escalation_triggered: crisisDetected,
            provider_unavailable: providerUnavailable,
            context_length: contextText.length,
            recommendation_length: recommendationText.length,
          },
        },
        _tx,
      );
    } catch (auditErr) {
      req.log.error(
        {
          err: auditErr,
          ai_workflow_execution_id: workflowExecutionId,
          consult_id: rawConsultId,
          crisis_detected: crisisDetected,
          provider_unavailable: providerUnavailable,
          ai_model_version: aiModelVersion,
        },
        'mode2_case_prep: ai_mode_2_evaluation audit emission failed — translating to 503; ' +
          'idempotency cache rolls back',
      );
      throw new Mode2AuditEmissionFailedError(auditErr);
    }

    const view: Mode2CasePrepResponseView = {
      ai_workflow_execution_id: workflowExecutionId,
      consult_id: rawConsultId,
      patient_id: rawPatientId,
      source_type: 'ai',
      ai_mode: 'mode_2',
      ai_workload_type: 'protocol_execution',
      autonomy_level: 'action_with_confirm',
      protocol_id: rawProtocolId,
      protocol_version: rawProtocolVersion,
      ai_model_version: aiModelVersion,
      recommendation: recommendationText,
      confidence,
      concern_flags: concernFlags,
      crisis_detected: crisisDetected,
      escalation_triggered: crisisDetected,
    };
    return { status: 200, view };
  });
}
