/**
 * ai-service/internal/handlers/chat.ts — Mode 1 conversational assistant
 * stub handler (TLC-AI PR B).
 *
 * Endpoint: POST /v0/ai/chat
 * Body:    { message: string, session_id?: string }
 *
 * Status at PR B: STUB ONLY. The handler validates input, applies
 * patient-role + live-session + tenant-scoping gates, and returns a
 * canned envelope shaped per AI_LAYERING v5.2 §6 (FLOOR-020) — but it
 * does NOT call a real LLM, does NOT emit a per-response audit
 * record, and does NOT consult a real guardrail template.
 *
 * The wire-shape lands now so:
 *   - Frontend / mobile clients can integrate against a stable JSON
 *     shape ahead of the real provider integration (PR D)
 *   - Tenant scoping + auth gate is exercised end-to-end via the
 *     existing patient-JWT + live-session machinery (TLC-058)
 *   - Codex review on this PR can challenge envelope shape before
 *     real costs land in PR D's secret-handling + SDK wiring
 *
 * Per-response audit emission is intentionally DEFERRED. AI_LAYERING
 * v5.2 §6 FLOOR-020 requires every AI-generated response produce an
 * audit record carrying session_id, patient_id, mode, guardrail_-
 * template_id+version, ai_model_version, input/output summary,
 * escalation_triggered, crisis_detected, timestamp — but
 * AUDIT_EVENTS v5.3's enumerated Mode 1 action IDs are
 * `ai_mode_1_session_started`, `ai_mode_1_escalation`,
 * `crisis_detection_trigger`, and `emergency_escalation`. The per-
 * response action is not explicitly enumerated. Rather than silently
 * fork the spec (CLAUDE.md hard rule), PR B emits no per-response
 * audit and defers that question to PR E (guardrail templates) /
 * PR F (crisis detection) when the emission boundary is concretely
 * established. Spec issue tracked separately.
 *
 * Per ADR-029 + WORKLOAD_TAXONOMY v5.2, the stub response carries:
 *   - source_type: 'ai'                            (FLOOR-007)
 *   - ai_workload_type: 'conversational_assistant'  (canonical)
 *   - autonomy_level: 'advisory'                    (Mode 1 ceiling)
 *   - guardrail_template_id: 'conservative_default' (AI-GUARD-003)
 *   - model_version: 'stub-v0'                      (PR D replaces)
 *   - escalation_triggered: false                   (no real detector)
 *   - crisis_detected: false                        (PR F replaces)
 *
 * Per AI_LAYERING v5.2 §9 tenant scoping: the conversation is bound
 * to (tenant_id, ai_chat_session_id). The session_id body parameter
 * is OPTIONAL — when absent, the handler synthesizes a fresh
 * AIChatSessionId. The handler does NOT (yet) validate that a
 * supplied session_id belongs to this tenant + patient; that
 * validation lands when the conversation-persistence schema does
 * (PR C or sibling).
 *
 * Spec references:
 *   - AI Clinical Assistant Slice PRD v1.0 §4.1 (Mode 1 surface)
 *   - AI_LAYERING v5.2 §2 (AI-ARCH-001 two-mode)
 *   - AI_LAYERING v5.2 §3 (AI-GUARD-001..005 guardrail governance)
 *   - AI_LAYERING v5.2 §4 (FLOOR-007..FLOOR-013 immutable boundaries)
 *   - AI_LAYERING v5.2 §6 (FLOOR-020 audit envelope — DEFERRED at PR B)
 *   - AI_LAYERING v5.2 §9 (tenant scoping)
 *   - AUDIT_EVENTS v5.3 §Mode 1 action IDs
 *   - WORKLOAD_TAXONOMY v5.2 (canonical discriminator)
 *   - AUTONOMY_LEVELS v5.2 (Mode 1 cap at 'advisory')
 *   - I-019 (crisis detection platform-floor; FLOOR-009)
 *   - I-023 / I-025 / I-027 (tenant scoping; tenant-blind errors)
 *   - TLC-058 (requirePatientActorContext + findActiveSessionById)
 */

import type { FastifyReply, FastifyRequest } from 'fastify';

import { UnauthenticatedError, requirePatientActorContext } from '../../../../lib/auth-context.js';
import { requireTenantContext } from '../../../../lib/tenant-context.js';
import { asSessionId, findActiveSessionById } from '../../../identity/index.js';
import type { AIChatSessionId } from '../types.js';

const MAX_MESSAGE_LENGTH = 8_000; // safe ceiling; real provider may cap lower

interface ChatBody {
  message?: unknown;
  session_id?: unknown;
}

interface ErrorEnvelope {
  error: { code: string; message: string; trace_id: string };
}

function makeErrorEnvelope(traceId: string, code: string, message: string): ErrorEnvelope {
  return { error: { code, message, trace_id: traceId } };
}

/**
 * Session-liveness gate for AI patient surfaces. Mirrors the pharmacy
 * read-handler's `requireLiveSession` (Codex PR-116 closures — JWT
 * sig + expiry alone is not enough; the session row's revoked_at +
 * expires_at must also pass, AND live.account_id must equal the
 * JWT's account_id).
 *
 * TODO(refactor): both this and pharmacy's copy should converge to a
 * shared lib/auth-context helper. Punted to a sweep PR because
 * touching the auth surface across slices risks regression and the
 * inline copy is small.
 */
async function requirePatientLiveSession(req: FastifyRequest): Promise<{
  ctx: ReturnType<typeof requireTenantContext>;
  actor: ReturnType<typeof requirePatientActorContext>;
}> {
  const ctx = requireTenantContext(req);
  const actor = requirePatientActorContext(req);
  const live = await findActiveSessionById(ctx, asSessionId(actor.sessionId));
  if (live === null) {
    throw new UnauthenticatedError();
  }
  if (live.account_id !== actor.accountId) {
    throw new UnauthenticatedError();
  }
  return { ctx, actor };
}

/**
 * The canonical Mode 1 response envelope shape — exported for client
 * integration even though the handler is feature-gated to 503 at PR B.
 *
 * PR B route + body-validation wiring is forward-compatible: when PRs
 * D/E/F land (Anthropic provider + guardrail templates + crisis
 * detection), the only change in this handler is replacing the 503
 * with a Mode1ChatResponseView-shaped 200.
 */
export interface Mode1ChatResponseView {
  ai_chat_session_id: AIChatSessionId;
  message_id: string;
  source_type: 'ai';
  /** Canonical AI_LAYERING mode discriminator (Codex PR B R1 MEDIUM
   *  closure 2026-05-14). Surfaces the legacy `mode_1 / mode_2 /
   *  scribe / interpretation / food_scan` enum from AI_LAYERING v5.2
   *  §6 audit envelope so frontends can discriminate UI states
   *  without re-derivating from `ai_workload_type`. */
  ai_mode: 'mode_1';
  ai_workload_type: 'conversational_assistant';
  autonomy_level: 'advisory';
  guardrail_template_id: 'conservative_default';
  model_version: string;
  escalation_triggered: boolean;
  crisis_detected: boolean;
  response_text: string;
}

export async function chatMode1Handler(req: FastifyRequest, reply: FastifyReply): Promise<unknown> {
  const { ctx: _ctx, actor: _actor } = await requirePatientLiveSession(req);
  void _ctx;
  void _actor;

  // ---- Body validation ----
  if (typeof req.body !== 'object' || req.body === null || Array.isArray(req.body)) {
    return reply
      .code(400)
      .send(
        makeErrorEnvelope(
          req.id,
          'internal.request.invalid',
          'Body must be a JSON object with a `message` field.',
        ),
      );
  }

  const body = req.body as ChatBody;
  if (typeof body.message !== 'string' || body.message.length === 0) {
    return reply
      .code(400)
      .send(
        makeErrorEnvelope(
          req.id,
          'internal.request.invalid',
          'message must be a non-empty string.',
        ),
      );
  }
  if (body.message.length > MAX_MESSAGE_LENGTH) {
    return reply
      .code(400)
      .send(
        makeErrorEnvelope(
          req.id,
          'internal.request.invalid',
          `message exceeds maximum length (${MAX_MESSAGE_LENGTH} characters).`,
        ),
      );
  }
  if (
    body.session_id !== undefined &&
    (typeof body.session_id !== 'string' || body.session_id.length === 0)
  ) {
    return reply
      .code(400)
      .send(
        makeErrorEnvelope(
          req.id,
          'internal.request.invalid',
          'session_id must be a non-empty string when provided.',
        ),
      );
  }
  const allowedKeys = new Set(['message', 'session_id']);
  const extraKeys = Object.keys(body).filter((k) => !allowedKeys.has(k));
  if (extraKeys.length > 0) {
    return reply
      .code(400)
      .send(
        makeErrorEnvelope(
          req.id,
          'internal.request.invalid',
          `Unexpected body field(s): ${extraKeys.join(', ')}.`,
        ),
      );
  }

  // PR B intentionally returns 503 after validation succeeds, per
  // Codex PR B R1 CRITICAL + HIGH closures 2026-05-14:
  //
  //   CRITICAL — Returning a live AI-labeled 200 response without
  //              running I-019 crisis detection on the patient's
  //              input violates the platform floor (FLOOR-009 +
  //              FLOOR-013). The detector lands in PR F; until then
  //              the route MUST NOT emit any AI response, even a
  //              canned one.
  //
  //   HIGH     — Emitting an AI-labeled 200 without a durable audit
  //              record violates FLOOR-020 (every AI-generated
  //              response produces an audit record). The audit
  //              boundary lands in PR E/F or via an AUDIT_EVENTS
  //              spec amendment that names the per-response Mode 1
  //              action.
  //
  // The route exists + body validation runs so that:
  //   - When PRs D/E/F land, this handler swaps the 503 below for a
  //     Mode1ChatResponseView-shaped 200 with the crisis-detection
  //     gate + real provider call + audit emission. The validation
  //     code above doesn't change.
  //   - Clients integrate against the Mode1ChatResponseView TYPE
  //     contract (exported from the module) without waiting for the
  //     handler to go live.
  //   - The auth + body-validation surface is exercised end-to-end
  //     in tests, locking in regression coverage for the platform
  //     floor / tenant-blind 404 boundaries before the live surface
  //     ships.
  //
  // The 503 envelope is intentionally informational; it does NOT
  // carry a Mode1ChatResponseView. Returning a Mode1ChatResponseView-
  // shaped error would imply an AI response was generated, which
  // contradicts the platform-floor stance.
  return reply.code(503).send({
    status: 'not_ready',
    module: 'ai-service',
    surface: 'mode_1_chat',
    phase: 'route_registered_503_pr_b',
    pending_message:
      'AI assistant is not yet ready to serve traffic — Mode 1 chat ' +
      'requires crisis detection (FLOOR-009 / I-019 platform-floor; PR F), ' +
      'per-response audit emission (FLOOR-020; PR E/F or AUDIT_EVENTS ' +
      'spec amendment), and real Anthropic provider integration (ADR-020; ' +
      'PR D). PR B registers the route + body-validation surface for ' +
      'forward-compatibility. The Mode1ChatResponseView type contract is ' +
      'exported from the ai-service module for client integration.',
  });
}
