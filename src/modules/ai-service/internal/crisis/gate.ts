/**
 * ai-service/internal/crisis/gate.ts — the I-019 crisis-detection
 * gate every AI surface MUST traverse before processing patient
 * input or emitting AI output per AI_LAYERING v5.2 §4 FLOOR-009
 * + FLOOR-013.
 *
 * The gate composes:
 *   1. Run lib/crisis-detection.ts's platform-singleton
 *      `crisisDetector.detect(text, tenantId, source)` per I-019
 *      (always-on; cannot be configured away by any guardrail
 *      template, admin surface, or tenant override).
 *   2. On positive detection: emit the canonical
 *      `crisis_detection_trigger` Category A audit per AUDIT_EVENTS
 *      v5.3 (via the AI-side wrapper in ./audit.ts) AND return a
 *      sentinel `{ kind: 'crisis', ... }` discriminated-union value.
 *      The caller (Mode 1 chat handler when it goes live; Mode 2
 *      case-prep handler when it goes live) maps the sentinel to
 *      the documented crisis-resources response envelope.
 *   3. On negative detection: return `{ kind: 'no_crisis' }` so the
 *      caller proceeds with the normal AI codepath.
 *
 * Per AI_LAYERING v5.2 §6 FLOOR-020 crisis-write exception: if the
 * audit emission fails during a crisis response, the gate still
 * returns the crisis sentinel — safety trumps audit completeness
 * for crisis paths. The audit failure is logged + an ops alert
 * fires (caller's responsibility; the gate just surfaces the
 * error via the returned sentinel's `audit_emission_failed` flag).
 *
 * At PR F this is service-callable only — no handler is mounted.
 * When Mode 1 chat / Mode 2 case-prep handlers come online, they
 * call this gate as their FIRST step (before any LLM provider
 * call), and again on AI OUTPUT (before surfacing — defense-in-
 * depth on the AI's own response text per the
 * `ai_chat_output` / `ai_case_prep_output` detection sources in
 * audit.ts).
 *
 * Spec references:
 *   - AI_LAYERING v5.2 §4 (FLOOR-009 + FLOOR-013)
 *   - AI_LAYERING v5.2 §6 (FLOOR-020 + crisis-write exception)
 *   - I-019 (platform-floor; always-on)
 *   - I-003 (audit append-only; bare suppression forbidden)
 *   - src/lib/crisis-detection.ts (the canonical detector; v1.0
 *     keyword-stub pending clinical-grade NLP classifier per AI
 *     Safety Lead review)
 *   - src/modules/forms-intake/internal/services/submission-service.ts
 *     (precedent for detect → audit → throw sentinel pattern; the
 *     forms-intake version throws a string sentinel; the ai-service
 *     gate returns a discriminated-union value instead because the
 *     caller may want to proceed with a different response path
 *     based on which detection_source fired)
 */

import { claimAuditDedupeSlot } from '../../../../lib/audit-dedupe.js';
import { crisisDetector } from '../../../../lib/crisis-detection.js';
import type { DbTransaction } from '../../../../lib/db.js';
import { withTransaction } from '../../../../lib/db.js';
import type { IdempotencyCtx } from '../../../../lib/idempotency.js';

import {
  type AICrisisAuditEnvelope,
  type AICrisisDetectionSource,
  emitAICrisisDetectionTrigger,
} from './audit.js';

export type CrisisGateOutcome =
  | {
      kind: 'no_crisis';
    }
  | {
      kind: 'crisis';
      crisis_type: string;
      detection_source: AICrisisDetectionSource;
      /** True if the canonical crisis-detection audit emitted
       *  successfully. False if the emission failed (op alert
       *  context — the caller still proceeds with the crisis-
       *  resource response per the FLOOR-020 crisis-write
       *  exception). */
      audit_emitted: boolean;
    };

export interface CrisisGateContext {
  tenantId: string;
  countryOfCare: string;
  /** Stable system-actor id for this AI surface. E.g.,
   *  'system:ai_mode_1' or 'system:ai_mode_2_case_prep'. */
  aiActorId: string;
  /** The patient the surface is acting on behalf of (Mode 1: the
   *  chat user; Mode 2: the consult subject). */
  patientId: string;
  /** Surface aggregate the text came from. Mode 1 → ai_chat_session
   *  + ai_chat_session_id; Mode 2 → ai_workflow_execution +
   *  ai_workflow_execution_id. */
  resourceType: 'ai_chat_session' | 'ai_workflow_execution';
  resourceId: string;
  /** Per-tenant escalation destination (e.g., crisis helpline,
   *  in-platform escalation contact). Resolved upstream by the
   *  caller from CCR + crisis type; null if not resolvable
   *  (the audit still fires; ops alerts on null). */
  escalationDestination: string | null;
  /** Idempotency context from the request lifecycle (handler-side
   *  `buildIdempotencyCtx` output). When supplied, the gate claims
   *  an `audit_dedupe_markers` slot before emitting so a retry
   *  under the same Idempotency-Key after a partial-failure window
   *  cannot double-emit the Category A audit. Omit for direct
   *  service-call paths and tests. Per Codex PR F R1 HIGH closure
   *  2026-05-13 — same pattern as forms-intake's submission-service
   *  runCrisisGate (Sprint 34 / SI-006). */
  idempotencyCtx?: IdempotencyCtx;
}

/**
 * Derive the FLOOR-020 (workload_type, autonomy_level) pair the
 * Category A audit MUST carry, from the resource aggregate the text
 * came from. Mode 1 chat surfaces are conversational_assistant +
 * advisory; Mode 2 case-prep / protocol-execution surfaces are
 * protocol_execution + action_with_confirm.
 *
 * Surfaced as a pure-function derivation (rather than a free
 * parameter on `CrisisGateContext`) so a future surface that mis-
 * pairs detection_source with resourceType (e.g., an `ai_chat_output`
 * fired against an `ai_workflow_execution` aggregate) fails at the
 * compile-or-test layer rather than producing a mislabeled audit row.
 * Per Codex PR F R1 HIGH closure 2026-05-13.
 */
function deriveAuditEnvelope(
  resourceType: 'ai_chat_session' | 'ai_workflow_execution',
  detectionSource: AICrisisDetectionSource,
): AICrisisAuditEnvelope {
  // Defense in depth: the source MUST belong to the same surface as
  // the aggregate. ai_chat_* against ai_workflow_execution (or
  // ai_case_prep_* against ai_chat_session) is a programmer error;
  // throw loud rather than emit a mislabeled audit row.
  if (resourceType === 'ai_chat_session') {
    if (detectionSource !== 'ai_chat_input' && detectionSource !== 'ai_chat_output') {
      throw new Error(
        `runCrisisGate: detectionSource=${detectionSource} is not a Mode 1 chat ` +
          `source but resourceType=ai_chat_session implies Mode 1. Refusing to emit ` +
          `a mislabeled FLOOR-020 envelope.`,
      );
    }
    return { workloadType: 'conversational_assistant', autonomyLevel: 'advisory' };
  }
  // resourceType === 'ai_workflow_execution' (Mode 2 case-prep /
  // protocol_execution surface).
  if (detectionSource !== 'ai_case_prep_input' && detectionSource !== 'ai_case_prep_output') {
    throw new Error(
      `runCrisisGate: detectionSource=${detectionSource} is not a Mode 2 case-prep ` +
        `source but resourceType=ai_workflow_execution implies Mode 2. Refusing to ` +
        `emit a mislabeled FLOOR-020 envelope.`,
    );
  }
  return { workloadType: 'protocol_execution', autonomyLevel: 'action_with_confirm' };
}

/**
 * Run the I-019 crisis-detection gate on a single text input.
 *
 * Pure functional contract: NO side effects on the `no_crisis`
 * path; emits exactly one audit row + returns `{ kind: 'crisis' }`
 * on the positive path.
 *
 * The audit emission runs inside a fresh transaction by default so
 * a positive detection persists even if the caller's outer
 * transaction is going to roll back (rejecting the request).
 * Optionally accepts an `externalTx` for callers that want the
 * audit committed with their own writing transaction (e.g., a
 * future surface that wants to atomically record both the
 * detection AND a state change).
 *
 * **Idempotency dedupe (Codex PR F R1 HIGH closure 2026-05-13):**
 * When `ctx.idempotencyCtx` is supplied (the canonical caller
 * pattern from an idempotency-protected HTTP handler), the gate
 * claims an `audit_dedupe_markers` slot via `claimAuditDedupeSlot`
 * BEFORE emitting. A retry under the same Idempotency-Key after a
 * partial-failure window (audit committed, idempotency completion
 * UPDATE rolled back) hits ON CONFLICT DO NOTHING, skips the second
 * emit, and the gate still returns `{ kind: 'crisis', audit_emitted:
 * true }` because the audit IS durable from the prior attempt. Same
 * pattern as forms-intake's `submission-service.ts` runCrisisGate
 * (Sprint 34 / SI-006 audit-dedupe SI).
 *
 * Without `idempotencyCtx` (direct service-call paths, tests), the
 * dedupe step is skipped — caller accepts the documented duplicate-
 * audit risk on retry.
 */
export async function runCrisisGate(
  ctx: CrisisGateContext,
  text: string,
  detectionSource: AICrisisDetectionSource,
  externalTx?: DbTransaction,
): Promise<CrisisGateOutcome> {
  // crisisDetector.detect's source parameter is its narrow enum
  // (`ai_chat` | `community_post` | `form_response` | `messaging` |
  // `voice_transcript`) — used for the detector's own logging.
  // The AI-side granular `ai_chat_input` / `ai_chat_output` /
  // `ai_case_prep_*` discrimination is preserved on the audit
  // envelope's `detection_source` field; the detector itself only
  // needs to know this is AI chat.
  const outcome = crisisDetector.detect(text, ctx.tenantId, 'ai_chat');
  if (!outcome.crisisDetected) {
    return { kind: 'no_crisis' };
  }

  // Derive the FLOOR-020 (workload_type, autonomy_level) pair from
  // the resource aggregate. Mode 1 chat → conversational_assistant +
  // advisory; Mode 2 case-prep → protocol_execution +
  // action_with_confirm. Throws loud on (resourceType, detectionSource)
  // mismatch rather than producing a mislabeled audit row.
  const auditEnvelope = deriveAuditEnvelope(ctx.resourceType, detectionSource);

  // Positive detection — emit the canonical Category A audit.
  // Per FLOOR-020 crisis-write exception: if the audit emission
  // fails, the caller still proceeds with the crisis-resource
  // response. We capture the failure on the returned outcome so
  // the caller can fire an ops alert.
  let auditEmitted = true;
  try {
    const emit = async (tx: DbTransaction) => {
      await tx.query('SELECT set_tenant_context($1)', [ctx.tenantId]);
      // Idempotency dedupe: if the caller is on an idempotency-
      // protected path, claim a marker BEFORE emitting. A second
      // attempt under the same Idempotency-Key + body + endpoint +
      // actor + audit-action 5-tuple hits ON CONFLICT and returns
      // false — we skip the emit (the audit is already durable
      // from the first attempt). Per Codex PR F R1 HIGH closure.
      if (ctx.idempotencyCtx !== undefined) {
        const claimed = await claimAuditDedupeSlot(tx, {
          tenantId: ctx.idempotencyCtx.tenantId,
          idempotencyKey: ctx.idempotencyCtx.idempotencyKey,
          endpoint: ctx.idempotencyCtx.endpoint,
          actorId: ctx.idempotencyCtx.actorId,
          bodyHash: ctx.idempotencyCtx.bodyHash,
          auditAction: 'crisis_detection_trigger',
        });
        if (!claimed) {
          // Prior attempt already emitted this exact audit on this
          // exact request — short-circuit. The caller still gets
          // `{ kind: 'crisis', audit_emitted: true }` because the
          // audit IS durable (just from the earlier attempt).
          return;
        }
      }
      await emitAICrisisDetectionTrigger(
        {
          tenantId: ctx.tenantId,
          actorId: ctx.aiActorId,
          countryOfCare: ctx.countryOfCare,
          targetPatientId: ctx.patientId,
          detectionSource,
          crisisType: outcome.crisisType,
          resourceType: ctx.resourceType,
          resourceId: ctx.resourceId,
          responseProvided: true, // canonical path: caller WILL surface crisis resources
          escalationDestination: ctx.escalationDestination,
          auditEnvelope,
        },
        tx,
      );
    };
    if (externalTx !== undefined) {
      await emit(externalTx);
    } else {
      await withTransaction(emit);
    }
  } catch {
    // Per FLOOR-020 crisis-write exception, swallow the audit
    // failure and proceed with crisis-resource surfacing. The
    // gate's caller decides whether to ops-alert from the
    // `audit_emitted: false` signal.
    auditEmitted = false;
  }

  return {
    kind: 'crisis',
    crisis_type: outcome.crisisType,
    detection_source: detectionSource,
    audit_emitted: auditEmitted,
  };
}
