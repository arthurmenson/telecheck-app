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

import { createHash } from 'node:crypto';

import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { requireActorContext } from '../../../../lib/auth-context.js';
import { asTenantId } from '../../../../lib/glossary.js';
import { buildIdempotencyCtx, type IdempotencyCtx } from '../../../../lib/idempotency.js';
import { withIdempotentExecution } from '../../../../lib/idempotent-handler.js';
import { requireTenantContext } from '../../../../lib/tenant-context.js';
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
/**
 * R3 H2 closure (Codex 2026-05-16): the request body no longer carries
 * `ai_chat_session_id`. At v1.0 the handler generates a fresh
 * server-side session id bound to the authenticated (tenant, patient)
 * — this prevents the trust hazard of accepting an unvalidated
 * session_id from the client (cross-tenant / cross-patient pollution
 * of the audit chain). When the session-lifecycle endpoints land
 * (POST /v0/ai/chat-sessions, GET /v0/ai/chat-sessions/:id, etc.),
 * the client will create sessions explicitly and POST /chat will
 * accept the validated session_id with owner-patient verification.
 *
 * Trade-off: at v1.0 every Mode 1 chat call creates a one-shot
 * session id. That's acceptable for the fail-soft posture (NullLLMProvider
 * always returns AI-RESIL-001 anyway). Real conversational continuity
 * lands with the real provider adapter + session persistence layer.
 */
const Mode1ChatRequestSchema = z.object({
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
 * Derive a deterministic Mode 1 identifier from the idempotency context.
 * Returns `<prefix><26-char base32 lowercase hash>`. Stable across retries
 * with the same Idempotency-Key — used for session_id and message_id so
 * the crisis-gate dedupe key (which includes resourceId) remains stable
 * after a rollback + retry cycle (R4 H1 closure 2026-05-16).
 *
 * `variant` lets us derive distinct IDs (e.g., session vs message) from
 * the same idempotency context without collision.
 *
 * NOT a security boundary — these IDs are opaque per-request handles,
 * not authorization tokens. The trust chain remains tenant_id + actor_id
 * + target_patient_id in the audit envelope.
 */
function deriveDeterministicId(prefix: string, ctx: IdempotencyCtx, variant = ''): string {
  const seed = `${ctx.tenantId}|${ctx.idempotencyKey}|${ctx.actorId}|${ctx.endpoint}|${ctx.bodyHash}|${variant}`;
  const hash = createHash('sha256').update(seed).digest('hex');
  // 26 chars to match ULID length conventions (cosmetic; not enforced).
  return `${prefix}${hash.slice(0, 26)}`;
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

/**
 * Mode 1 chat handler's typed audit-emission-failure sentinel — used
 * to translate a rethrown FLOOR-020 audit error into the documented
 * 503 envelope (R3 H1 closure 2026-05-16). The withIdempotentExecution
 * helper rolls back the cache reservation on any callback throw; this
 * wrapper carries the original error through to the global error
 * handler for log + ops-alert visibility while ensuring the wire
 * response is the retryable 503 not a generic 500.
 */
class Mode1AuditEmissionFailedError extends Error {
  /** Original audit-emission error; preserved for ops triage. */
  readonly auditCause: unknown;
  constructor(auditCause: unknown) {
    super('mode_1_chat_audit_emission_failed');
    this.name = 'Mode1AuditEmissionFailedError';
    this.auditCause = auditCause;
  }
}

/**
 * Service-error mapper for `withIdempotentExecution`. Translates the
 * Mode1AuditEmissionFailedError into a tenant-blind 503 with retry-
 * advisory semantics. Other unmapped errors propagate to Fastify's
 * global error handler.
 */
function mapServiceError(err: unknown, reply: FastifyReply, reqId: string): boolean {
  if (err instanceof Mode1AuditEmissionFailedError) {
    void reply.code(503).send({
      error: {
        code: 'ai_chat.audit_emission_unavailable',
        message: 'AI chat is temporarily unable to record the response audit. Please try again.',
        request_id: reqId,
      },
    });
    return true;
  }
  return false;
}

export async function mode1ChatHandler(req: FastifyRequest, reply: FastifyReply): Promise<unknown> {
  const ctx = requireTenantContext(req);
  const actor = requireActorContext(req);

  // R1 H2 closure (Codex 2026-05-16): Mode 1 chat is direct-patient
  // surface at v1.0; delegate sessions are NOT in scope. Reject any
  // request whose actorContext carries a non-null delegateId rather
  // than silently treating it as a direct patient action with
  // misleading audit attribution (actor_type='patient' +
  // delegate_context=null). When the delegate-aware Mode 1 surface
  // ships, this guard relaxes to a delegate-scope check + delegate-
  // context audit threading.
  if (actor.delegateId !== null) {
    throw req.server.httpErrors.forbidden(
      'Mode 1 chat does not support delegated sessions at v1.0.',
    );
  }

  // Patient-only at v1.0 — Mode 1 is the patient-facing conversational
  // surface. Clinician / admin paths use Mode 2 case-prep when those
  // ship. Defense in depth on top of the route-level RBAC that future
  // session-creation flows will enforce.
  if (actor.role !== 'patient') {
    throw req.server.httpErrors.forbidden('Mode 1 chat is patient-facing only at v1.0.');
  }

  // R6 H1 closure (Codex 2026-05-16): two-stage body validation.
  // Crisis detection MUST run on the patient's raw text BEFORE we
  // 400-reject for length / format. Otherwise an oversized message
  // that contains crisis indicators would be rejected at validation
  // with no I-019 audit + no crisis-sentinel response — defeating
  // FLOOR-013's "always-on" guarantee.
  //
  // Stage 1: minimal pre-gate type check. Extract message_text if
  // present and is a string of ANY length. If the body shape is so
  // malformed that no string is available, return 400 immediately
  // (there's no text to scan).
  // Stage 2: full Zod validation (length + other constraints) AFTER
  // the crisis gate.
  const rawBody = (req.body ?? {}) as Record<string, unknown>;
  const rawMessageText = rawBody['message_text'];
  if (typeof rawMessageText !== 'string' || rawMessageText.length === 0) {
    throw req.server.httpErrors.badRequest(
      'Invalid request body: message_text is required and must be a non-empty string.',
    );
  }
  // R3 H2 + R4 H1 closures (Codex 2026-05-16):
  //   Server-side session/message ID generation is DETERMINISTIC per
  //   idempotent request. Deriving the IDs from the idempotency
  //   4-tuple + body-hash ensures that a retry with the same
  //   Idempotency-Key produces the SAME session_id and message_id, so:
  //     - The crisis audit's dedupe key (which includes resourceId)
  //       remains stable across retries → Category A audit emits at
  //       most once even if the FLOOR-020 Cat C audit failed and the
  //       cache row rolled back on the prior attempt.
  //     - The Mode1ChatResponseView wire shape returned on a cached
  //       replay carries the same identifiers a client would have
  //       previously observed (if a prior attempt had succeeded; for
  //       rollback paths, retries simply land the same IDs fresh).
  //   The IDs are NOT trust anchors for cross-patient correlation
  //   (the audit chain's tenant_id + actor_id + target_patient_id
  //   are); they're per-request opaque identifiers. SHA-256 of the
  //   IdempotencyCtx is collision-resistant for this purpose.
  const idempotencyCtx = buildIdempotencyCtx(req);
  const sessionId = asAIChatSessionId(deriveDeterministicId('aics_', idempotencyCtx));
  const messageId = deriveDeterministicId('aimsg_', idempotencyCtx, 'message');

  // R1 H1 closure (Codex 2026-05-16): wrap the lifecycle in
  // withIdempotentExecution so retries on the same Idempotency-Key
  // return the cached response WITHOUT re-running crisis detection,
  // re-emitting Category A audit, re-triggering escalation, or
  // re-emitting the Category C response audit. The crisis gate is
  // dedupe-protected via idempotencyCtx (forms-intake submission-service
  // pattern). The idempotency cache key is the 4-tuple
  // (tenantId, idempotencyKey, endpoint, actorId) — patient identity
  // is bound so cross-patient replay is impossible.
  // (idempotencyCtx already built earlier for deriving session/message
  //  IDs deterministically per R4 H1 closure.)

  return withIdempotentExecution(req, reply, mapServiceError, async (_tx) => {
    // I-019 crisis gate on INPUT — runs BEFORE any LLM call. Emits the
    // canonical `crisis_detection_trigger` Category A audit on positive
    // detection. Always-on per FLOOR-013. idempotencyCtx threads through
    // so the gate's audit-dedupe slot prevents Category A double-emit
    // on Idempotency-Key replay.
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
        idempotencyCtx,
      },
      rawMessageText,
      'ai_chat_input',
    );

    const crisisDetected = inputCrisisOutcome.kind === 'crisis';

    // Stage 2 validation: enforce the full Zod constraints ONLY if no
    // crisis was detected. If crisis was detected, we proceed to the
    // crisis-sentinel response path regardless of message size — the
    // patient still needs the safety surface + the audit chain has
    // captured the Category A trigger. Per R6 H1 closure 2026-05-16.
    if (!crisisDetected) {
      const parsed = Mode1ChatRequestSchema.safeParse({ message_text: rawMessageText });
      if (!parsed.success) {
        throw req.server.httpErrors.badRequest(
          `Invalid request body: ${parsed.error.issues
            .map((e) => `${e.path.join('.')}: ${e.message}`)
            .join('; ')}`,
        );
      }
    }

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
        // LLMCompletionRequest shape (snake_case per spec).
        const result = await provider.sendCompletion({
          workload_type: 'conversational_assistant',
          messages: [{ role: 'user', content: rawMessageText }],
          max_output_tokens: 1024,
          // Clinical paths default to deterministic (temperature=0).
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
          // plugin can map it to the canonical 5xx surface.
          throw err;
        }
      }
    }

    // Emit FLOOR-020 audit for the response (Category C operational)
    // inside the same transaction the idempotent-execution helper opened.
    // The audit is durable iff the transaction commits; on commit, the
    // idempotency cache row captures the response so retries serve from
    // cache without re-emitting either the crisis audit (deduped via
    // idempotencyCtx-bound gate) OR this response audit (transaction
    // didn't run).
    // R2 H1 closure (Codex 2026-05-16): do NOT swallow audit emission
    // failures inside the idempotent callback. withIdempotency marks
    // the cache row completed whenever the callback returns
    // successfully, so a swallowed audit error would cache an
    // unaudited patient-visible 200 and replay it on retry — a
    // permanent FLOOR-020 audit gap exactly where R1 wanted lifecycle
    // atomicity.
    //
    // Correct posture: rethrow on audit failure. The
    // withIdempotentExecution helper rolls back the cache
    // reservation; the error envelope plugin maps the throw to a
    // tenant-blind 503; the client's retry runs a fresh lifecycle
    // (including a fresh crisis-audit attempt, deduped by
    // idempotencyCtx so Category A doesn't double-emit on the
    // retry).
    //
    // The AI_LAYERING §6 crisis-write exception applies to the
    // Category A crisis_detection_trigger audit emitted INSIDE
    // runCrisisGate (which has its own dedupe-aware fail-soft path
    // already). It does NOT apply to the Category C operational
    // response audit — losing that audit forever in exchange for
    // caching a 200 is the worse trade.
    try {
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
            input_text_length: rawMessageText.length,
            response_text_length: responseText.length,
          },
        },
        _tx,
      );
    } catch (auditErr) {
      // R3 H1 closure (Codex 2026-05-16): translate to typed error so
      // mapServiceError can map to the documented 503. Log + propagate
      // the cause for ops triage.
      req.log.error(
        {
          err: auditErr,
          ai_chat_session_id: sessionId,
          message_id: messageId,
          crisis_detected: crisisDetected,
          provider_unavailable: providerUnavailable,
          ai_model_version: aiModelVersion,
        },
        'mode1_chat: FLOOR-020 audit emission failed — translating to 503; idempotency cache rolls back',
      );
      throw new Mode1AuditEmissionFailedError(auditErr);
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
    return { status: 200, view };
  });
}
