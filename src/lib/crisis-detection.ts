/**
 * crisis-detection.ts — I-019 platform-floor crisis-detection guard.
 *
 * Purpose:
 *   Always-on crisis indicator detection across chat, voice (future), and
 *   community surfaces. Cannot be disabled, gated by config, or overridden
 *   by any feature, admin surface, guardrail template, or moderation policy.
 *
 * Spec references:
 *   - I-019: "Crisis detection (suicidal ideation, self-harm, abuse disclosure,
 *     medical emergency indicators) is always active across all platform surfaces
 *     — AI chat, community, forms, messaging. No guardrail template, moderation
 *     policy, or admin configuration can disable crisis detection."
 *   - AUDIT_EVENTS v5.2 §Category A: `crisis_detection_trigger` action with
 *     actor_type=system, detail: patient_id, crisis_type, detection_source,
 *     response_provided, escalation_destination.
 *   - WORKLOAD_TAXONOMY v5.2 §2.1: `conversational_assistant` has governance_class
 *     `floor_safety` — crisis detection is the primary floor safety gate.
 *   - Tenant Threading Addendum v1.0 §3.5 (community moderation): crisis detection
 *     is platform-scoped and cannot be weakened by any tenant.
 *
 * Always-on contract:
 *   This module's detection logic CANNOT be disabled by any configuration flag.
 *   `config.featureFlags` is NOT consulted here. The check intentionally throws
 *   at construction time if anyone attempts to wrap it in a feature flag.
 *
 * Pattern-matching strategy (v1.0 stub):
 *   A stub list of keyword/phrase patterns is used for now. Production integration
 *   with a real crisis-detection model (clinical NLP classifier) is required
 *   before patient-facing deployment. The stub intentionally uses a conservative
 *   (high-recall) pattern list to minimize false negatives.
 *
 *   PRODUCTION FOLLOW-UP REQUIRED:
 *   - Replace stub patterns with a clinical-grade NLP classifier trained on
 *     crisis language (per clinical safety officer review).
 *   - Add multi-language support (EN + TWI for Ghana market at minimum).
 *   - Add voice transcript pipeline integration (when voice surface activates).
 *   - Integrate with tenant-specific crisis escalation pathways
 *     (from CCR `country_of_care` → emergency contact chain).
 *
 * Open questions for Engineering Lead:
 *   - Escalation destination resolution: currently returns a stub
 *     `recommendedSurfaces`. Real implementation queries CCR for the
 *     tenant's crisis escalation pathway (local emergency number, crisis
 *     helpline, in-platform escalation contact).
 *   - Audit emission: the caller is responsible for emitting
 *     `crisis_detection_trigger` Category A audit event. Should this module
 *     emit it directly? Separation of concerns favors caller emission;
 *     alternatively, to prevent bare suppression, this module could emit
 *     and surface the result. Engineering Lead to decide.
 */

// ---------------------------------------------------------------------------
// Crisis detection patterns (stub — conservative, high-recall)
// ---------------------------------------------------------------------------
// STUB: Replace with a clinical-grade NLP classifier before patient-facing deployment.
// Per I-019: crisis detection must never fail to detect a real crisis.
// A false positive (unnecessary escalation) is safer than a false negative.

const CRISIS_PATTERNS: ReadonlyArray<RegExp> = [
  // Suicidal ideation. Stem-prefix matchers (`suicid`, `harm`) DO NOT use a
  // trailing `\b` so they catch declined / inflected forms like "suicide",
  // "suicidal", "suicidality", "self-harming". The prior version used
  // `\b(suicid|...)\b` which failed to match "suicide" because the `e` after
  // `suicid` is a word character — no \b boundary fired. Per I-019 (crisis
  // detection is platform-floor) and the explicit comment above ("a false
  // positive is safer than a false negative"), high-recall stem matching is
  // the correct posture. Codex crisis-detect-r0 closure 2026-05-04.
  /\b(suicid\w*|kill\s+myself|end\s+my\s+life|want\s+to\s+die|don'?t\s+want\s+to\s+live|thoughts?\s+of\s+death)/i,
  // Self-harm — stem-prefix `self[\s-]?harm` allows "self-harming",
  // "self-harms". Multi-word phrases retain the trailing `\b` since they
  // already include word characters at the end that don't need to inflect.
  /\b(self[\s-]?harm\w*|cutting\s+myself|hurt\s+myself|burning\s+myself|hurting\s+myself)/i,
  // Abuse disclosure
  /\b(being\s+abused|someone\s+is\s+hurting\s+me|domestic\s+violence|sexual\s+abuse|physical\s+abuse)\b/i,
  // Medical emergency indicators
  /\b(chest\s+pain|can'?t\s+breathe|difficulty\s+breathing|stroke|seizure|unconscious|overdose)\b/i,
  // Explicit crisis phrases
  /\b(in\s+crisis|mental\s+health\s+emergency|psychiatric\s+emergency|help\s+me\s+please.{0,20}dying)\b/i,
  // Means-related (conservative)
  /\b(found\s+pills\s+to\s+take|have\s+a\s+plan\s+to\s+end)\b/i,
];

export type CrisisType =
  | 'suicidal_ideation'
  | 'self_harm'
  | 'abuse_disclosure'
  | 'medical_emergency'
  | 'general_crisis';

export type DetectionSource =
  | 'ai_chat'
  | 'community_post'
  | 'form_response'
  | 'messaging'
  | 'voice_transcript';

export interface CrisisDetectionResult {
  crisisDetected: true;
  crisisType: CrisisType;
  action: 'escalate';
  tenantId: string;
  detectionSource: DetectionSource;
  /**
   * Platform surfaces to render immediately when crisis detected.
   * Per I-017 (emergency info always accessible): emergency contact info is
   * cached on-device and available offline.
   * STUB: real implementation resolves tenant's CCR emergency contact chain.
   */
  recommendedSurfaces: string[];
}

export interface NoCrisisResult {
  crisisDetected: false;
}

export type CrisisDetectionOutcome = CrisisDetectionResult | NoCrisisResult;

// ---------------------------------------------------------------------------
// DisabledCrisisDetectionError
// Thrown if anyone attempts to disable this platform-floor invariant.
// ---------------------------------------------------------------------------

export class DisabledCrisisDetectionError extends Error {
  constructor(reason: string) {
    super(
      `I-019 violation: attempted to disable crisis detection — "${reason}". ` +
        'Crisis detection is a platform-floor invariant and cannot be disabled ' +
        'by any configuration, feature flag, guardrail template, or admin action.',
    );
    this.name = 'DisabledCrisisDetectionError';
  }
}

// ---------------------------------------------------------------------------
// CrisisDetector
// ---------------------------------------------------------------------------

export class CrisisDetector {
  /**
   * Construct a CrisisDetector instance.
   *
   * @param _disabledByConfig  Must never be passed at all. Throws I-019
   *   violation if the constructor is called with ANY argument — including
   *   explicit `undefined`, `undefined` from a defaulted/optional parameter,
   *   or a value spread from `[undefined]`. The `never` type above is the
   *   compile-time block; the `arguments.length > 0` runtime check is the
   *   physical fail-closed gate.
   *
   * Tightened 2026-05-03 per Codex crisis-detection-r1 HIGH (verify-r2):
   *   Prior implementation used `_disabledByConfig !== undefined`, which
   *   accepted explicit `undefined` (and spread `[undefined]`) silently.
   *   That left a bypass surface for any future config plumb that
   *   normalized a disable flag to undefined. The argument-count check
   *   closes the bypass: passing anything — INCLUDING undefined — fails
   *   closed. The only documented usage is `new CrisisDetector()` with NO
   *   argument (used by the platform singleton at the bottom of this file).
   */
  constructor(_disabledByConfig?: never) {
    // I-019: argument-count gate. ANY supplied argument trips this — including
    // explicit `undefined`, defaulted `undefined`, or a spread `[undefined]`.
    // This is the fail-closed posture per the always-on contract: the only
    // permitted call site is `new CrisisDetector()` with zero arguments.
    if (arguments.length > 0) {
      throw new DisabledCrisisDetectionError('constructor called with disabledByConfig argument');
    }
  }

  /**
   * detectCrisis — scans input text for crisis indicators.
   *
   * Always-on per I-019. No config flag, feature flag, or admin setting
   * can prevent this method from executing.
   *
   * @param text         Input text to scan (patient message, post, form response).
   * @param tenantId     Operating-tenant identifier (for escalation pathway resolution).
   * @param source       Which platform surface produced this text.
   * @returns            `CrisisDetectionResult` if crisis detected; `NoCrisisResult` otherwise.
   */
  detect(text: string, tenantId: string, source: DetectionSource): CrisisDetectionOutcome {
    if (!text || text.trim().length === 0) {
      return { crisisDetected: false };
    }

    // Test each pattern. Return on first match (high-recall priority).
    for (const pattern of CRISIS_PATTERNS) {
      if (pattern.test(text)) {
        const crisisType = this.classifyCrisisType(text);
        return {
          crisisDetected: true,
          crisisType,
          action: 'escalate',
          tenantId,
          detectionSource: source,
          // STUB: real implementation resolves CCR emergency contact chain per tenant + country_of_care
          recommendedSurfaces: [
            'crisis_resources_modal',
            'emergency_contact_display',
            'in_platform_escalation_trigger',
          ],
        };
      }
    }

    return { crisisDetected: false };
  }

  private classifyCrisisType(text: string): CrisisType {
    const lower = text.toLowerCase();
    // Keep classifier alternates in PARITY with the corresponding
    // CRISIS_PATTERNS alternates above. A pattern that detects but isn't
    // classified falls through to 'general_crisis' — the failure mode CI
    // surfaced 2026-05-04 (e.g., "I have thoughts of death" detected via
    // CRISIS_PATTERNS but classified as general_crisis because the
    // classifier was missing `thoughts?\s+of\s+death`). Codex
    // crisis-classify-r0 closure 2026-05-04.
    if (
      /suicid|kill\s+myself|end\s+my\s+life|want\s+to\s+die|don'?t\s+want\s+to\s+live|thoughts?\s+of\s+death/.test(
        lower,
      )
    ) {
      return 'suicidal_ideation';
    }
    if (/self[\s-]?harm|cutting|hurt\s+myself|burning\s+myself|hurting\s+myself/.test(lower)) {
      return 'self_harm';
    }
    if (/abused|hurting\s+me|domestic\s+violence|sexual\s+abuse|physical\s+abuse/.test(lower)) {
      return 'abuse_disclosure';
    }
    if (
      /chest\s+pain|can'?t\s+breathe|difficulty\s+breathing|stroke|seizure|unconscious|overdose/.test(
        lower,
      )
    ) {
      return 'medical_emergency';
    }
    return 'general_crisis';
  }
}

// ---------------------------------------------------------------------------
// Platform-singleton detector instance
// ---------------------------------------------------------------------------

/**
 * crisisDetector — the platform-singleton CrisisDetector instance.
 *
 * Always-on per I-019. Import and call `.detect()` directly.
 * Do NOT attempt to replace this with a config-gated version.
 */
export const crisisDetector = new CrisisDetector();
