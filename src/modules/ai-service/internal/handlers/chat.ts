/**
 * ai-service/internal/handlers/chat.ts — Mode 1 conversational assistant
 * HTTP handler.
 *
 * POST /v0/ai/chat
 *   Request body:
 *     { message_text: string, ai_chat_session_id?: string (UUID) }
 *   Response (Mode1ChatResponseView):
 *     200 — canonical FLOOR-020 envelope + response text
 *     400 — malformed body / message too long / malformed session id
 *     401 — no authenticated actor (Bearer JWT required)
 *     404 — ai_chat_session_id supplied but no such conversation is
 *           owned by this (tenant, patient) — tenant-blind per I-025
 *
 * Lifecycle (Codex PR B + PR F discipline preserved; persistence wired
 * per the migration-067 entities RATIFIED at P-035/P-036):
 *   1. Resolve tenant context (auto via plugin) + actor context (JWT)
 *   2. Parse body via Zod; tenant-blind 400 on failure (I-025)
 *   3. Run I-019 crisis gate on INPUT text — emits Category A audit
 *      on positive detection per AUDIT_EVENTS v5.3
 *   4. PERSIST the turn into the Mode 1 conversation entities
 *      (migration 067; CDM v1.8 §4.NEW1/NEW3/NEW4/NEW5) under the
 *      `ai_service_mode1` DB role (migration 068; Mode 1 spec §5.1
 *      Layer 1), same-tx with the idempotency reservation + FLOOR-020
 *      audit:
 *        a. conversation row — created when no ai_chat_session_id is
 *           supplied (deterministic UUID per Idempotency-Key), else
 *           loaded + patient-ownership-validated (tenant-blind 404 on
 *           miss per I-025)
 *        b. turn-admission row — turn_id (deterministic UUID) +
 *           user_message + request_body_hash +
 *           history_snapshot_high_water_mark (spec §6.3)
 *        c. detector-result row — non-crisis turns only; the crisis-
 *           positive detector-result row is SPEC-GATED (see the
 *           "Crisis-turn detector-result persistence" note below)
 *   5. On crisis: return crisis-resource sentinel response (no LLM
 *      call) per AI_LAYERING §6 crisis-write exception
 *   6. On no crisis: verify the detector-result row exists in the same
 *      tx BEFORE the provider call (Mode 1 spec §4.2 runtime
 *      detector-ordering precondition); load Conservative Default
 *      guardrail; call LLM provider (v1.0: NullProvider always throws
 *      LLMProviderUnavailableError per ADR-020)
 *   7. Catch LLMProviderUnavailableError → return AI-RESIL-001
 *      "AI temporarily unavailable" envelope
 *   8. PERSIST the turn-result row (completed / failed split-table
 *      terminal state per CDM v1.8 §4.NEW5)
 *   9. Emit FLOOR-020 audit per emitMode1ChatResponseAudit; on audit
 *      failure translate to 503 (whole tx — including the persistence
 *      rows — rolls back; the deterministic IDs make the retry land
 *      the same rows)
 *
 * Per I-019: crisis detection runs UNCONDITIONALLY on input; even
 * a flag-flip cannot disable it (FLOOR-013).
 *
 * Per AI-RESIL-001: when no LLM provider is available, the surface
 * gracefully degrades to a documented "temporarily unavailable" UI
 * state. The patient is informed; the audit + the turn-result row
 * (turn_outcome='failed', failure_class='llm_provider_unavailable')
 * capture the outcome.
 *
 * ## Crisis-turn detector-result persistence — SPEC-GATED deferral
 *
 * The ratified `ai_mode1_conversation_turn_detector_result` DDL (CDM
 * v1.8 §4.NEW4) carries the I-019-floor CHECK
 * `signal_iff_severity`: a non-null `severity` REQUIRES a non-null
 * `crisis_server_signal_id` correlating to the I-019 enqueue-ack log
 * (`i019_enqueue_ack_log` — a table that does NOT exist in this repo;
 * its FK is DEFERRED in migration 067 pending ratifier confirmation of
 * the canonical target). Additionally the ratified severity enum
 * (`self_harm` | `imminent_harm` | `medical_emergency`) does not map
 * bijectively from the v1.0 keyword-stub detector's `CrisisType`
 * (`suicidal_ideation` | `self_harm` | `abuse_disclosure` |
 * `medical_emergency` | `general_crisis`). Fabricating a signal id or
 * force-mapping the taxonomy would falsify the I-019 forensic anchor,
 * and writing `severity = NULL` for a crisis-positive turn would
 * record "no crisis detected" — worse. Fail-closed choice: crisis-
 * positive turns SKIP the detector-result row; the Category A
 * `crisis_detection_trigger` audit emitted by `runCrisisGate` (own-tx,
 * rollback-immune) remains the durable I-019 record. The row lands
 * when the i019_enqueue_ack_log surface + the severity-taxonomy
 * mapping are ratified. No LLM call happens on crisis turns, so the
 * §4.2 detector-ordering precondition (detector row before
 * llm.invoke()) is not violated by the skip.
 *
 * ## ai.mode1.* audit-action registration — follow-up
 *
 * AUDIT_EVENTS v5.10 (P-036) registers 11 new action IDs
 * (`ai.mode1.turn_admitted`, `ai.mode1.turn_completed`, …). Their
 * app-layer registration in lib/audit.ts + per-phase emission is a
 * follow-up PR; this PR persists the turn lifecycle rows and keeps the
 * existing `ai_chat_response_emitted` (placeholder Cat C) +
 * `crisis_detection_trigger` (Cat A) emission discipline unchanged.
 *
 * ## I-026 at-rest encryption posture
 *
 * `user_message` / `assistant_message` are TEXT per the ratified DDL;
 * I-026 encryption-at-rest is the platform KMS layer (ADR-024).
 * src/lib/kms.ts is a THROWING stub outside test envs (per its header,
 * real AWS KMS integration is a Track 5 deliverable), so a handler-
 * layer envelope is not yet wireable — matching the posture of every
 * other PHI-bearing TEXT column in this repo (accounts PII, consult
 * fields outside the async-consult 8-field envelope path). When the
 * KMS integration lands, the message columns join it.
 *
 * Spec references:
 *   - AI Service Mode 1 Handler Spec v0.4 RATIFIED (P-035) §2.5, §4.2,
 *     §5.1 Layer 1, §6.1–§6.3
 *   - CDM v1.7 → v1.8 Amendment (P-036/P-036a) §2.NEW1–NEW5
 *   - migrations/067 (entities) + 068 (ai_service_mode1 writer grants)
 *   - AI Clinical Assistant Slice PRD v1.0 §3 Mode 1
 *   - AI_LAYERING v5.2 §2/§3/§4/§6/§7
 *   - I-019 / I-023 / I-025 / I-026 / I-027 / I-035
 *   - ADR-020 multi-provider LLM abstraction
 *   - ADR-029 workload taxonomy (conversational_assistant + advisory)
 */

import { createHash } from 'node:crypto';

import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { requireActorContext } from '../../../../lib/auth-context.js';
import type { DbTransaction } from '../../../../lib/db.js';
import { asTenantId } from '../../../../lib/glossary.js';
import { buildIdempotencyCtx, type IdempotencyCtx } from '../../../../lib/idempotency.js';
import { withIdempotentExecution } from '../../../../lib/idempotent-handler.js';
import { requireTenantContext } from '../../../../lib/tenant-context.js';
import { withDbRole } from '../../../../lib/with-db-role.js';
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
 *   - message_text: 1..4000 chars. Upper bound prevents accidentally
 *     uploading documents into the chat stream; clinical-grade NLP
 *     classifiers + real LLM adapters often bound input around 4-8k
 *     tokens, so 4000 chars is conservative enough to fit any
 *     reasonable provider's input limit.
 *   - ai_chat_session_id: OPTIONAL UUID of an existing conversation
 *     (the `ai_mode1_conversation.id` returned by a prior response).
 *     When supplied, the handler loads the conversation and validates
 *     patient ownership — the R3 H2 trust hazard (accepting an
 *     unvalidated client session id) is closed by the migration-067
 *     persistence: the conversation row is the validation anchor.
 *     When absent, the handler creates a fresh conversation whose id
 *     is DETERMINISTIC per Idempotency-Key (R4 H1: retries land the
 *     same conversation).
 */
const Mode1ChatRequestSchema = z.object({
  message_text: z
    .string()
    .min(1, 'message_text is required')
    .max(4000, 'message_text must be ≤4000 chars'),
  ai_chat_session_id: z.string().uuid().optional(),
});

/** Canonical UUID shape gate for the client-supplied session id. */
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

// ---------------------------------------------------------------------------
// Persistence constants
// ---------------------------------------------------------------------------

/**
 * Detector version stamped on `ai_mode1_conversation_turn_detector_result`
 * rows. src/lib/crisis-detection.ts is the v1.0 keyword stub (its own
 * header documents the clinical-grade NLP classifier follow-up); it
 * exposes no version constant, so the version identity is pinned here
 * and MUST be bumped when the detector implementation changes.
 */
const MODE1_CRISIS_DETECTOR_VERSION = 'keyword-stub-v1.0';

/**
 * Default conversation-history window persisted on the admission row.
 * The request does not yet carry `conversation_history_window` (the
 * canonical spec §2.2 optional field lands with real conversational
 * continuity); the ratified default is 20, max 50 (spec §6.3 step 4;
 * CDM v1.8 §4.NEW3 CHECK 0 < n <= 50).
 */
const MODE1_CONVERSATION_HISTORY_WINDOW = 20;

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
 * Derive a deterministic RFC-4122-shaped UUID from the idempotency
 * context. Stable across retries with the same Idempotency-Key — used
 * for the conversation id (when the client did not supply one) and the
 * turn id, so:
 *   - the crisis-gate dedupe key (which includes resourceId) remains
 *     stable after a rollback + retry cycle (R4 H1 closure 2026-05-16),
 *   - a retry after a rolled-back attempt re-lands the SAME
 *     `ai_mode1_conversation` / `..._turn_admission` primary keys
 *     instead of orphaning a second conversation.
 *
 * The migration-067 entity ids are UUID (ratified DDL), so the derived
 * identifier is formatted as a UUID: 32 hex chars from SHA-256 of the
 * idempotency 4-tuple + body-hash + variant, with the version nibble
 * forced to 4 and the variant nibble to 8..b for RFC-4122 cosmetic
 * validity. NOT a security boundary — these IDs are opaque per-request
 * handles, not authorization tokens. The trust chain remains tenant_id
 * + actor_id + target_patient_id (audit) and the composite tenant-scoped
 * FKs (DB).
 *
 * `variant` lets us derive distinct IDs (conversation vs turn) from
 * the same idempotency context without collision.
 */
export function deriveDeterministicMode1Uuid(ctx: IdempotencyCtx, variant: string): string {
  const seed = `${ctx.tenantId}|${ctx.idempotencyKey}|${ctx.actorId}|${ctx.endpoint}|${ctx.bodyHash}|uuid|${variant}`;
  const hex = createHash('sha256').update(seed).digest('hex');
  const variantNibble = ((Number.parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  return (
    `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-` +
    `${variantNibble}${hex.slice(17, 20)}-${hex.slice(20, 32)}`
  );
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

/** Extract a PG error code from a thrown value, if present. */
function pgErrorCode(err: unknown): string | null {
  if (typeof err === 'object' && err !== null && 'code' in err) {
    const code = (err as { code?: unknown }).code;
    return typeof code === 'string' ? code : null;
  }
  return null;
}

/**
 * Service-error mapper for `withIdempotentExecution`. Translates the
 * Mode1AuditEmissionFailedError into a tenant-blind 503 with retry-
 * advisory semantics, and PG integrity-violation classes from the
 * Mode 1 persistence writes into tenant-blind 409s (I-025 — a
 * composite-FK failure must not differentiate which reference failed
 * or whether the row exists in another tenant). Other unmapped errors
 * propagate to Fastify's global error handler.
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
  const code = pgErrorCode(err);
  if (code === '23503' || code === '23505') {
    // Composite tenant-scoped FK failure (conversation/patient chain,
    // CDM v1.8 R1/R2/R4 closures) or a primary-key collision outside
    // the idempotency reservation's serialization. Both are
    // conflict-class outcomes; tenant-blind per I-025.
    void reply.code(409).send({
      error: {
        code: 'internal.resource.conflict',
        message: 'The chat message does not match an eligible conversation for this account.',
        request_id: reqId,
      },
    });
    return true;
  }
  return false;
}

/**
 * Load the claimed conversation and validate patient ownership.
 * Runs under the `ai_service_mode1` role with RLS FORCE + explicit
 * tenant filter (I-023 layers 1+2). Returns true when the
 * conversation exists in this tenant AND belongs to this patient.
 * Cross-tenant rows are invisible under RLS; in-tenant rows owned by
 * another patient return false — callers surface BOTH as the same
 * tenant-blind miss (I-025).
 */
async function conversationOwnedByPatient(
  tx: DbTransaction,
  tenantId: string,
  conversationId: string,
  patientAccountId: string,
): Promise<boolean> {
  const res = await tx.query<{ patient_id: string }>(
    `SELECT patient_id
       FROM ai_mode1_conversation
      WHERE tenant_id = $1 AND id = $2`,
    [tenantId, conversationId],
  );
  return res.rows.length > 0 && res.rows[0]!.patient_id === patientAccountId;
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
  // Stage 2: full Zod validation (length + session-id format) AFTER
  // the crisis gate.
  const rawBody = (req.body ?? {}) as Record<string, unknown>;
  const rawMessageText = rawBody['message_text'];
  if (typeof rawMessageText !== 'string' || rawMessageText.length === 0) {
    throw req.server.httpErrors.badRequest(
      'Invalid request body: message_text is required and must be a non-empty string.',
    );
  }

  // Optional client-supplied conversation id (Stage-1 SHAPE read only;
  // enforcement is post-gate so a malformed id cannot suppress the
  // I-019 scan). Only a UUID-shaped string is ever echoed into the
  // crisis-gate resourceId / audit surface — arbitrary client strings
  // (potential PHI) never reach the audit chain.
  const rawSessionIdInput = rawBody['ai_chat_session_id'];
  let claimedConversationId: string | null = null;
  let sessionIdFormatInvalid = false;
  if (rawSessionIdInput !== undefined && rawSessionIdInput !== null) {
    if (typeof rawSessionIdInput === 'string' && UUID_RE.test(rawSessionIdInput)) {
      claimedConversationId = rawSessionIdInput.toLowerCase();
    } else {
      sessionIdFormatInvalid = true;
    }
  }

  // R3 H2 + R4 H1 closures (Codex 2026-05-16), persistence-era shape:
  //   Server-side conversation/turn ID generation is DETERMINISTIC per
  //   idempotent request (see deriveDeterministicMode1Uuid docstring).
  //   With migration-067 persistence these are no longer opaque
  //   handles only — conversationId is the `ai_mode1_conversation.id`
  //   primary key (created here or validated against the client's
  //   claim) and turnId is the `..._turn_admission.id` idempotency
  //   anchor per the ratified DDL ("client-generated UUID; idempotency
  //   key" — this server derives it FROM the Idempotency-Key, which
  //   preserves the replay-stability property the spec wants without
  //   re-opening the R3 H2 client-trust hazard).
  const idempotencyCtx = buildIdempotencyCtx(req);
  const conversationId =
    claimedConversationId ?? deriveDeterministicMode1Uuid(idempotencyCtx, 'conversation');
  const turnId = deriveDeterministicMode1Uuid(idempotencyCtx, 'turn');
  const sessionId = asAIChatSessionId(conversationId);
  const messageId = turnId;

  // R1 H1 closure (Codex 2026-05-16): wrap the lifecycle in
  // withIdempotentExecution so retries on the same Idempotency-Key
  // return the cached response WITHOUT re-running crisis detection,
  // re-emitting Category A audit, re-triggering escalation,
  // re-emitting the Category C response audit, or re-inserting the
  // persistence rows. The idempotency cache key is the 4-tuple
  // (tenantId, idempotencyKey, endpoint, actorId) — patient identity
  // is bound so cross-patient replay is impossible. The helper has
  // already bound the tenant GUC on the tx (set_tenant_context), which
  // is what the migration-067 RLS policies evaluate.
  return withIdempotentExecution(req, reply, mapServiceError, async (tx) => {
    const handlerStart = Date.now();

    // I-019 crisis gate on INPUT — runs BEFORE any LLM call AND before
    // any persistence/validation rejection. Emits the canonical
    // `crisis_detection_trigger` Category A audit on positive
    // detection (own fresh tx inside the gate — rollback-immune).
    // Always-on per FLOOR-013. idempotencyCtx threads through so the
    // gate's audit-dedupe slot prevents Category A double-emit on
    // Idempotency-Key replay.
    const gateStart = Date.now();
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
    const detectorLatencyMs = Date.now() - gateStart;

    const crisisDetected = inputCrisisOutcome.kind === 'crisis';

    // Stage 2 validation: enforce the full Zod constraints ONLY if no
    // crisis was detected. If crisis was detected, we proceed to the
    // crisis-sentinel response path regardless of message size or
    // session-id format — the patient still needs the safety surface +
    // the audit chain has captured the Category A trigger. Per R6 H1
    // closure 2026-05-16.
    if (!crisisDetected) {
      const parsed = Mode1ChatRequestSchema.safeParse({
        message_text: rawMessageText,
        ...(typeof rawSessionIdInput === 'string' ? { ai_chat_session_id: rawSessionIdInput } : {}),
      });
      if (!parsed.success || sessionIdFormatInvalid) {
        const detail = parsed.success
          ? 'ai_chat_session_id: must be a UUID'
          : parsed.error.issues.map((e) => `${e.path.join('.')}: ${e.message}`).join('; ');
        throw req.server.httpErrors.badRequest(`Invalid request body: ${detail}`);
      }
    }

    // -----------------------------------------------------------------
    // Persistence phase 1 — conversation + turn-admission (+ detector-
    // result for non-crisis turns), under the ai_service_mode1 role
    // (migration 068; Mode 1 spec §5.1 Layer 1). Same tx as the
    // idempotency reservation + the FLOOR-020 audit below, so a
    // failure anywhere rolls back everything atomically and the retry
    // (deterministic IDs) re-lands identical rows.
    //
    // The tenant GUC is already bound by withIdempotentExecution
    // (set_tenant_context) — the RLS tenant_isolation policies on the
    // 4 lifecycle tables evaluate against it; every statement ALSO
    // carries an explicit tenant_id filter/column (I-023 app layer).
    // No actor-nonce binding here: the Mode 1 write path issues plain
    // INSERTs — no SECDEF wrapper and no current_actor_*() reference
    // consumes app.request_nonce (contrast async-consult, whose
    // wrappers validate the SI-010 actor row).
    // -----------------------------------------------------------------
    let persisted = false;
    if (crisisDetected && sessionIdFormatInvalid) {
      // Crisis turn with a malformed session id: the safety surface
      // outranks the 400 (R6 H1), but there is no resolvable
      // conversation identity to persist against. Skip persistence;
      // the Category A crisis audit (already emitted, own-tx) is the
      // durable record.
      req.log.warn(
        { turn_id: turnId },
        'mode1_chat: crisis-positive turn with malformed ai_chat_session_id — ' +
          'crisis sentinel surfaced; Mode 1 persistence skipped (no resolvable ' +
          'conversation identity); Category A crisis audit is the durable record',
      );
    } else {
      await withDbRole(tx, 'ai_service_mode1', async () => {
        if (claimedConversationId !== null) {
          const owned = await conversationOwnedByPatient(
            tx,
            ctx.tenantId,
            claimedConversationId,
            actor.accountId,
          );
          if (!owned) {
            if (!crisisDetected) {
              // Tenant-blind miss per I-025: "no such conversation",
              // "another tenant's conversation", and "another
              // patient's conversation" are indistinguishable.
              throw req.server.httpErrors.notFound('Conversation not found.');
            }
            // Crisis turn claiming a conversation this patient does
            // not own: surface the safety response; do NOT persist
            // against an unowned conversation.
            req.log.warn(
              { turn_id: turnId },
              'mode1_chat: crisis-positive turn with unowned/unknown ai_chat_session_id — ' +
                'crisis sentinel surfaced; Mode 1 persistence skipped; Category A crisis ' +
                'audit is the durable record',
            );
            return;
          }
        } else {
          // Fresh conversation (deterministic id per Idempotency-Key;
          // CDM v1.8 §4.NEW1). Composite tenant-scoped patient FK →
          // accounts(tenant_id, account_id) enforces the identity chain.
          await tx.query(
            `INSERT INTO ai_mode1_conversation (id, tenant_id, patient_id)
             VALUES ($1, $2, $3)`,
            [conversationId, ctx.tenantId, actor.accountId],
          );
        }

        // Turn-admission row (CDM v1.8 §4.NEW3). history_snapshot_high_
        // water_mark = MAX(turn_result.completed_at) for this
        // conversation AT admission (spec §6.3 step 1); '-infinity'
        // when no prior turns exist (the column is NOT NULL; -infinity
        // is the honest "no prior completed turn" floor).
        // request_body_hash = SHA-256 of the canonicalized request body
        // — reuses the idempotency layer's canonical hasher output
        // (hex) so admission-row hash and idempotency-cache hash cannot
        // drift.
        await tx.query(
          `INSERT INTO ai_mode1_conversation_turn_admission
             (id, tenant_id, conversation_id, patient_id, user_message,
              request_body_hash, history_snapshot_high_water_mark,
              conversation_history_window, client_capabilities)
           VALUES
             ($1, $2, $3, $4, $5, decode($6, 'hex'),
              COALESCE(
                (SELECT MAX(r.completed_at)
                   FROM ai_mode1_conversation_turn_result r
                  WHERE r.tenant_id = $2 AND r.conversation_id = $3),
                '-infinity'::timestamptz),
              $7, NULL)`,
          [
            turnId,
            ctx.tenantId,
            conversationId,
            actor.accountId,
            rawMessageText,
            idempotencyCtx.bodyHash,
            MODE1_CONVERSATION_HISTORY_WINDOW,
          ],
        );

        if (!crisisDetected) {
          // Detector-result row (CDM v1.8 §4.NEW4): severity NULL +
          // crisis_server_signal_id NULL is the ratified "detector
          // completed, no crisis" shape. The existence of this row IS
          // the canonical detector_completed state the §4.2 LLM-invoke
          // precondition checks. Crisis-positive turns skip this row —
          // SPEC-GATED; see the file-header deferral note.
          await tx.query(
            `INSERT INTO ai_mode1_conversation_turn_detector_result
               (turn_id, tenant_id, detector_version, severity,
                crisis_server_signal_id, detector_latency_ms)
             VALUES ($1, $2, $3, NULL, NULL, $4)`,
            [turnId, ctx.tenantId, MODE1_CRISIS_DETECTOR_VERSION, detectorLatencyMs],
          );
        }
        persisted = true;
      });
    }

    // Branch: crisis → return crisis-resource sentinel response without
    // calling the LLM. AI_LAYERING §6 crisis-write exception: the
    // response surfaces even if the Category A crisis audit emit failed
    // (the audit_emitted=false case in the gate outcome).
    let responseText: string;
    let providerUnavailable: boolean;
    let aiModelVersion: string;
    let turnOutcome: 'completed' | 'failed';
    let persistedAssistantMessage: string | null;
    let persistedProvider: string | null = null;
    let persistedModelId: string | null = null;
    let promptTokenCount: number | null = null;
    let completionTokenCount: number | null = null;
    let failureClass: string | null = null;
    let failurePhase: string | null = null;
    if (crisisDetected) {
      responseText = CRISIS_RESPONSE_TEXT;
      providerUnavailable = false;
      aiModelVersion = 'crisis-bypass:no-llm-call';
      // The crisis sentinel IS the patient-visible completion of this
      // turn (turn_outcome='completed' with the sentinel as
      // assistant_message; provider/model NULL — no LLM ran). The
      // crisis facts live in the Category A audit, not on this row
      // (see the file-header spec-gated note on detector-result).
      turnOutcome = 'completed';
      persistedAssistantMessage = CRISIS_RESPONSE_TEXT;
    } else {
      // Mode 1 spec §4.2 runtime detector-ordering precondition: the
      // llm.invoke() call site verifies the durable detector-result
      // row exists for this turn within the SAME transaction before
      // issuing the provider request. Process-restart-safe +
      // retry-safe because the precondition is a DB row, not an
      // in-memory flag. (The Cat A
      // `ai.mode1.invariant_violation_detector_ordering` emission
      // lands with the ai.mode1.* audit-action registration follow-up;
      // the hard failure here already prevents the invariant-violating
      // LLM call and rolls the turn back.)
      await withDbRole(tx, 'ai_service_mode1', async () => {
        const guard = await tx.query<{ present: boolean }>(
          `SELECT EXISTS (
              SELECT 1 FROM ai_mode1_conversation_turn_detector_result
               WHERE tenant_id = $1 AND turn_id = $2
            ) AS present`,
          [ctx.tenantId, turnId],
        );
        if (guard.rows[0]?.present !== true) {
          throw new Error(
            'mode1_chat: I-019 detector-ordering invariant violation — no ' +
              'ai_mode1_conversation_turn_detector_result row for this turn at the ' +
              'llm.invoke() call site (Mode 1 spec §4.2). Failing the turn.',
          );
        }
      });

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
        turnOutcome = 'completed';
        persistedAssistantMessage = result.text;
        persistedProvider = result.provider_name;
        persistedModelId = result.model;
        promptTokenCount = result.usage.input_tokens;
        completionTokenCount = result.usage.output_tokens;
      } catch (err) {
        if (err instanceof LLMProviderUnavailableError) {
          responseText = AI_UNAVAILABLE_RESPONSE_TEXT;
          providerUnavailable = true;
          aiModelVersion = 'null-provider:unavailable';
          // Ratified failure taxonomy (CDM v1.8 §4.NEW5): the turn
          // FAILED with class llm_provider_unavailable during the LLM
          // phase; assistant_message NULL (the canned fail-soft text
          // surfaced to the patient is a UI envelope, not an assistant
          // message); provider records WHICH provider was unavailable
          // ("null IFF turn failed pre-LLM" — this failure is
          // during_llm, so the provider identity is known).
          turnOutcome = 'failed';
          persistedAssistantMessage = null;
          persistedProvider = err.provider_name;
          failureClass = 'llm_provider_unavailable';
          failurePhase = 'during_llm';
          req.log.warn(
            { err, ai_chat_session_id: sessionId },
            'mode1_chat: LLM provider unavailable; surfaced AI-RESIL-001 fail-soft response',
          );
        } else {
          // Unknown error class — re-throw so the global error envelope
          // plugin can map it to the canonical 5xx surface. The tx
          // (persistence rows included) rolls back; a spec-shaped
          // turn_result(failure_class='internal_error') row cannot
          // survive its own transaction's rollback — recording
          // internal-error terminal rows durably requires an own-tx
          // writer and is deferred with the ai.mode1.* audit follow-up.
          throw err;
        }
      }
    }

    // -----------------------------------------------------------------
    // Persistence phase 2 — turn-result terminal row (CDM v1.8
    // §4.NEW5): the existence of this row IS the canonical terminal
    // state ('completed' | 'failed'); the 4-column composite FK to the
    // admission row closes the conversation→admission→result identity
    // chain (R4 HIGH-1).
    // -----------------------------------------------------------------
    if (persisted) {
      const totalLatencyMs = Date.now() - handlerStart;
      await withDbRole(tx, 'ai_service_mode1', async () => {
        await tx.query(
          `INSERT INTO ai_mode1_conversation_turn_result
             (turn_id, tenant_id, conversation_id, patient_id,
              assistant_message, provider, model_id,
              prompt_token_count, completion_token_count,
              total_latency_ms, turn_outcome, failure_class, failure_phase)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
          [
            turnId,
            ctx.tenantId,
            conversationId,
            actor.accountId,
            persistedAssistantMessage,
            persistedProvider,
            persistedModelId,
            promptTokenCount,
            completionTokenCount,
            totalLatencyMs,
            turnOutcome,
            failureClass,
            failurePhase,
          ],
        );
      });
    }

    // Emit FLOOR-020 audit for the response (Category C operational)
    // inside the same transaction the idempotent-execution helper opened.
    // The audit is durable iff the transaction commits; on commit, the
    // idempotency cache row captures the response so retries serve from
    // cache without re-emitting either the crisis audit (deduped via
    // idempotencyCtx-bound gate) OR this response audit (transaction
    // didn't run). The Mode 1 persistence rows above commit or roll
    // back with it — response, audit, and conversation rows are
    // all-or-nothing.
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
        tx,
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
