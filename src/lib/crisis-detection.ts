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
  // Suicidal ideation
  /\b(suicid|kill\s+myself|end\s+my\s+life|want\s+to\s+die|don'?t\s+want\s+to\s+live|thoughts?\s+of\s+death)\b/i,
  // Self-harm
  /\b(self[\s-]?harm|cutting\s+myself|hurt\s+myself|burning\s+myself|hurting\s+myself)\b/i,
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

export type DetectionSource = 'ai_chat' | 'community_post' | 'form_response' | 'messaging' | 'voice_transcript';

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
   * @param _disabledByConfig  Must never be true. Throws I-019 violation if true.
   *   This parameter exists only so callers who attempt to gate crisis detection
   *   on a feature flag get a compile-time parameter they must explicitly pass,
   *   making the I-019 violation visible in code review.
   */
  constructor(_disabledByConfig?: never) {
    // I-019: this guard throws if anyone passes a truthy disable flag.
    // The `never` type above is a compile-time block; this is the runtime block.
    if (_disabledByConfig !== undefined) {
      throw new DisabledCrisisDetectionError(
        'constructor called with disabledByConfig argument',
      );
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
  detect(
    text: string,
    tenantId: string,
    source: DetectionSource,
  ): CrisisDetectionOutcome {
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
    if (/suicid|kill\s+myself|end\s+my\s+life|want\s+to\s+die|don'?t\s+want\s+to\s+live/.test(lower)) {
      return 'suicidal_ideation';
    }
    if (/self[\s-]?harm|cutting|hurt\s+myself|burning\s+myself/.test(lower)) {
      return 'self_harm';
    }
    if (/abused|hurting\s+me|domestic\s+violence|sexual\s+abuse|physical\s+abuse/.test(lower)) {
      return 'abuse_disclosure';
    }
    if (/chest\s+pain|can'?t\s+breathe|stroke|seizure|unconscious|overdose/.test(lower)) {
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
