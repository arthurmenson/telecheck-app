/**
 * ai-service/internal/handlers/chat.ts — Mode 1 conversational assistant
 * HTTP handler.
 *
 * POST /v0/ai/chat
 *   Request body:
 *     { ai_chat_session_id: string, message_text: string }
 *   Response (Mode1ChatResponseView):
 *     200 — canonical FLOOR-020 envelope + response text
 *     400 — malformed body / message too long / missing session id
 *     401 — no authenticated actor (Bearer JWT required)
 *
 * Lifecycle (Codex PR B + PR F discipline preserved):
 *   1. Resolve tenant context (auto via plugin) + actor context (JWT)
 *   2. Parse body via Zod; tenant-blind 400 on failure (I-025)
 *   3. Run I-019 crisis gate on INPUT text — emits Category A audit
 *      on positive detection per AUDIT_EVENTS v5.3
 *   4. On crisis: return crisis-resource sentinel response (no LLM
 *      call) per AI_LAYERING §6 crisis-write exception
 *   5. On no crisis: load Conservative Default guardrail; call LLM
 *      provider via resolveProvider (v1.0: NullProvider always
 *      throws LLMProviderUnavailableError per ADR-020 — real
 *      adapters land when secrets management is resolved)
 *   6. Catch LLMProviderUnavailableError → return AI-RESIL-001
 *      "AI temporarily unavailable" envelope
 *   7. (Future: when real provider lands) Run I-019 crisis gate on
 *      OUTPUT text — defense-in-depth on the AI's own response
 *   8. Emit FLOOR-020 audit per emitMode1ChatResponseAudit; on audit
 *      failure log + ops-alert but still surface the response per
 *      AI_LAYERING §6 crisis-write exception
 *
 * Per I-019: crisis detection runs UNCONDITIONALLY on input; even
 * a flag-flip cannot disable it (FLOOR-013).
 *
 * Per AI-RESIL-001: when no LLM provider is available, the surface
 * gracefully degrades to a documented "temporarily unavailable" UI
 * state. The patient is informed; the audit captures the
 * provider_unavailable=true outcome.
 *
 * Spec references:
 *   - AI Clinical Assistant Slice PRD v1.0 §3 Mode 1
 *   - AI_LAYERING v5.2 §2 (AI-ARCH-001 Mode 1)
 *   - AI_LAYERING v5.2 §3 (AI-GUARD-001..005)
 *   - AI_LAYERING v5.2 §4 (FLOOR-007..FLOOR-013)
 *   - AI_LAYERING v5.2 §6 (FLOOR-020 audit envelope + crisis-write
 *     exception)
 *   - AI_LAYERING v5.2 §7 (AI-RESIL-001/002)
 *   - I-019 platform-floor crisis detection (always-on)
 *   - I-023 / I-025 / I-027 tenant scoping + tenant-blind errors
 *   - ADR-020 multi-provider LLM abstraction
 *   - ADR-029 workload taxonomy (conversational_assistant + advisory)
 */

import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { requireActorContext } from '../../../../lib/auth-context.js';
import { withTransaction } from '../../../../lib/db.js';
import { asTenantId } from '../../../../lib/glossary.js';
import { requireTenantContext } from '../../../../lib/tenant-context.js';
import { ulid } from '../../../../lib/ulid.js';
import { emitMode1ChatResponseAudit } from '../../audit.js';
import { runCrisisGate } from '../crisis/gate.js';
import { CONSERVATIVE_DEFAULT_TEMPLATE } from '../guardrails/conservative-default.js';
import { NullLLMProvider } from '../providers/null-provider.js';
import { LLMProviderUnavailableError } from '../providers/types.js';
import { asAIChatSessionId, type Mode1ChatResponseView } from '../types.js';

// ---------------------------------------------------------------------------
// Request body schema
// ---------------------------------------------------------------------------

/**
 * Mode 1 chat request body. Conservative limits at v1.0:
 *   - ai_chat_session_id: ULID string, required (frontend allocates on
 *     session creation; the handler does NOT auto-create sessions in
 *     this PR's MVP — session lifecycle lands in a follow-up).
 *   - message_text: 1..4000 chars. Upper bound prevents accidentally
 *     uploading documents into the chat stream; clinical-grade NLP
 *     classifiers + real LLM adapters often bound input around 4-8k
 *     tokens, so 4000 chars is conservative enough to fit any
 *     reasonable provider's input limit.
 */
const Mode1ChatRequestSchema = z.object({
  ai_chat_session_id: z.string().min(1).max(128, 'ai_chat_session_id must be ≤128 chars'),
  message_text: z
    .string()
    .min(1, 'message_text is required')
    .max(4000, 'message_text must be ≤4000 chars'),
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * v1.0 provider routing: per ADR-020, every active workload routes to
 * NullLLMProvider until real adapters (Anthropic primary + Bedrock +
 * Azure OpenAI resilience) land. The Null provider always throws
 * `LLMProviderUnavailableError`, exercising the AI-RESIL-001 fail-soft
 * path on every request.
 *
 * Why a freshly-constructed instance per request: the Null provider
 * is stateless and cheap; constructing on demand avoids importing the
 * registry (which has a wider surface than this handler needs). When
 * real adapters land, swap this for `resolveProvider('conversational_assistant')`.
 */
function getMode1Provider(): NullLLMProvider {
  return new NullLLMProvider();
}

/**
 * Canonical AI-RESIL-001 fail-soft response text. Centralized so the
 * exact wording is reviewable in one place + can be CCR-tenant-localized
 * in a follow-up.
 */
const AI_UNAVAILABLE_RESPONSE_TEXT =
  'The AI assistant is temporarily unavailable. Please try again shortly. ' +
  'If this is urgent or you need to talk to a clinician, contact your care team directly.';

/**
 * Canonical crisis-response surface text. Triggered when the I-019
 * crisis gate detects crisis indicators in the patient's input. The
 * AI assistant intentionally does NOT engage the message content; the
 * patient is redirected to crisis-appropriate resources per Slice PRD
 * §6.2 + FLOOR-009.
 *
 * In a follow-up PR, the exact text + escalation phone numbers will
 * be resolved from CCR (country_of_care drives the helpline) so the
 * patient sees locale-correct resources.
 */
const CRISIS_RESPONSE_TEXT =
  'I noticed you may be going through something serious. Your safety is the priority. ' +
  'If you are in immediate danger, please call emergency services right away. ' +
  'Your care team has been alerted and a clinician will follow up.';

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function mode1ChatHandler(req: FastifyRequest, reply: FastifyReply): Promise<unknown> {
  const ctx = requireTenantContext(req);
  const actor = requireActorContext(req);

  // Patient-only at v1.0 — Mode 1 is the patient-facing conversational
  // surface. Clinician / admin paths use Mode 2 case-prep when those
  // ship. Defense in depth on top of the route-level RBAC that future
  // session-creation flows will enforce.
  if (actor.role !== 'patient') {
    throw req.server.httpErrors.forbidden('Mode 1 chat is patient-facing only at v1.0.');
  }

  const parsed = Mode1ChatRequestSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    throw req.server.httpErrors.badRequest(
      `Invalid request body: ${parsed.error.issues
        .map((e) => `${e.path.join('.')}: ${e.message}`)
        .join('; ')}`,
    );
  }
  const body = parsed.data;
  const sessionId = asAIChatSessionId(body.ai_chat_session_id);
  const messageId = `aimsg_${ulid()}`;

  // I-019 crisis gate on INPUT — runs BEFORE any LLM call. Emits the
  // canonical `crisis_detection_trigger` Category A audit on positive
  // detection. Always-on per FLOOR-013.
  const inputCrisisOutcome = await runCrisisGate(
    {
      tenantId: ctx.tenantId,
      countryOfCare: ctx.countryOfCare,
      aiActorId: 'system:ai_mode_1',
      patientId: actor.accountId,
      resourceType: 'ai_chat_session',
      resourceId: sessionId,
      // Per-tenant escalation destination resolution lands with the
      // CCR-driven helpline integration (Slice PRD §6.2 + CCR_RUNTIME
      // contract). Null at v1.0 → ops alert via the crisis audit row.
      escalationDestination: null,
    },
    body.message_text,
    'ai_chat_input',
  );

  const crisisDetected = inputCrisisOutcome.kind === 'crisis';

  // Branch: crisis → return crisis-resource sentinel response without
  // calling the LLM. AI_LAYERING §6 crisis-write exception: the
  // response surfaces even if the Category A crisis audit emit failed
  // (the audit_emitted=false case in the gate outcome).
  let responseText: string;
  let providerUnavailable: boolean;
  let aiModelVersion: string;
  if (crisisDetected) {
    responseText = CRISIS_RESPONSE_TEXT;
    providerUnavailable = false;
    aiModelVersion = 'crisis-bypass:no-llm-call';
  } else {
    // No crisis → attempt LLM completion. At v1.0 the NullLLMProvider
    // throws LLMProviderUnavailableError unconditionally; the
    // AI-RESIL-001 fail-soft path renders the documented "temporarily
    // unavailable" UI state.
    const provider = getMode1Provider();
    try {
      // Build a minimal completion request matching the canonical
      // LLMCompletionRequest shape (snake_case per spec). Guardrail-
      // template binding + system prompt assembly land with the real
      // provider adapter (PR D); the Null provider ignores the
      // request payload anyway and unconditionally throws.
      const result = await provider.sendCompletion({
        workload_type: 'conversational_assistant',
        messages: [{ role: 'user', content: body.message_text }],
        max_output_tokens: 1024,
        // Clinical paths default to deterministic (temperature=0) per
        // AI Safety review; Mode 1 chat is patient-facing advisory and
        // benefits from the same low-variance posture.
        temperature: 0,
        tenant_id: ctx.tenantId,
      });
      responseText = result.text;
      providerUnavailable = false;
      aiModelVersion = `${result.provider_name}:${result.model_version}`;
    } catch (err) {
      if (err instanceof LLMProviderUnavailableError) {
        responseText = AI_UNAVAILABLE_RESPONSE_TEXT;
        providerUnavailable = true;
        aiModelVersion = 'null-provider:unavailable';
        req.log.warn(
          { err, ai_chat_session_id: sessionId },
          'mode1_chat: LLM provider unavailable; surfaced AI-RESIL-001 fail-soft response',
        );
      } else {
        // Unknown error class — re-throw so the global error envelope
        // plugin can map it to the canonical 5xx surface. The audit
        // emission below will NOT fire because we don't reach it; the
        // error becomes the durable record via the error envelope's
        // standard logging path.
        throw err;
      }
    }
  }

  // Emit FLOOR-020 audit for the response (Category C operational).
  // Opens a dedicated micro-transaction so the audit is durable even
  // if no other DB writes happen in this request. On emission failure
  // we still surface the response per AI_LAYERING §6 crisis-write
  // exception, but log + ops-alert via the warn-level structured log.
  try {
    await withTransaction(async (tx) => {
      await emitMode1ChatResponseAudit(
        {
          tenantId: asTenantId(ctx.tenantId),
          actorId: actor.accountId,
          actorTenantId: ctx.tenantId,
          countryOfCare: ctx.countryOfCare,
          targetPatientId: actor.accountId,
          aiModelVersion,
          detail: {
            ai_chat_session_id: sessionId,
            message_id: messageId,
            ai_mode: 'mode_1',
            guardrail_template_id: 'conservative_default',
            guardrail_version: CONSERVATIVE_DEFAULT_TEMPLATE.version,
            crisis_detected: crisisDetected,
            escalation_triggered: crisisDetected,
            provider_unavailable: providerUnavailable,
            input_text_length: body.message_text.length,
            response_text_length: responseText.length,
          },
        },
        tx,
      );
    });
  } catch (auditErr) {
    // Audit emission failure: log structured error, still surface
    // response. The structured log carries the response envelope
    // metadata so SIEM ingestion preserves the forensic record even
    // if the durable audit row never landed.
    req.log.error(
      {
        err: auditErr,
        ai_chat_session_id: sessionId,
        message_id: messageId,
        crisis_detected: crisisDetected,
        provider_unavailable: providerUnavailable,
        ai_model_version: aiModelVersion,
      },
      'mode1_chat: FLOOR-020 audit emission failed — response surfaced per AI_LAYERING §6 crisis-write exception',
    );
  }

  const view: Mode1ChatResponseView = {
    ai_chat_session_id: sessionId,
    message_id: messageId,
    patient_id: actor.accountId,
    source_type: 'ai',
    ai_mode: 'mode_1',
    ai_workload_type: 'conversational_assistant',
    autonomy_level: 'advisory',
    guardrail_template_id: 'conservative_default',
    guardrail_version: CONSERVATIVE_DEFAULT_TEMPLATE.version,
    ai_model_version: aiModelVersion,
    escalation_triggered: crisisDetected,
    crisis_detected: crisisDetected,
    response_text: responseText,
  };
  return reply.code(200).send(view);
}
