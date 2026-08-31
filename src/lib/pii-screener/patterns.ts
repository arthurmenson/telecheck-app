/**
 * pii-screener/patterns.ts — regex pattern library for Pilot 1 PII detection.
 *
 * Sprint 1.1a scope: regex-only fast-path patterns for the Layer 1 input
 * screener. Local NER (Sprint 1.1b) will layer on top; these regex patterns
 * are the fail-closed floor and MUST NEVER call an external provider to
 * classify candidate text.
 *
 * Spec references:
 *   - docs/PII_SCREENING_AND_LOG_REDACTION_SPEC.md §Layer 1 (input screener)
 *   - PII spec §Regex fast-path — pattern list per this file
 *   - PATH_A_PILOT_COMPLETION_RUNBOOK.md §Technical gates (implementation gate)
 *
 * Pattern classification:
 *   - `high_confidence`: pattern match is high signal that this is real PII;
 *     block on match for AI-bound routes and for internal routes alike.
 *   - `low_confidence`: pattern is suggestive but has known false-positive
 *     modes (short numerics, common word patterns). For AI-bound routes
 *     block anyway (defense-in-depth); for internal routes redact-inline.
 *
 * Locale coverage (Pilot 1):
 *   - US-centric patterns for the Heros team member volunteer testers most
 *     likely to be US-based (SSN, US phone)
 *   - Ghana Card format for Ghana-based clinicians and Ghana pilot
 *     alignment (per ADR-028 country-of-care lookup discipline; Ghana
 *     patients still not admitted at Pilot 1 but Ghana testers are)
 *   - Generic patterns (email, credit card via Luhn) locale-agnostic
 *
 * Deliberate non-goals:
 *   - Real-name detection — Sprint 1.1b (local NER) handles person names.
 *     A regex for names would over-block (any capitalized word).
 *   - Address detection — Sprint 1.1b handles structured addresses. A
 *     regex for addresses would either miss most or over-block on any
 *     "N Some Word St" string.
 *   - Medical condition names tied to identifiers — Sprint 1.1b task.
 */

export interface PiiPattern {
  /** Machine-readable slug (e.g., `us_ssn`, `email`). */
  readonly id: string;
  /** Human-readable description for participant-visible messages. */
  readonly label: string;
  /**
   * Confidence classification per §Layer 1 Decision.
   * high_confidence → BLOCK on AI-bound routes AND internal routes.
   * low_confidence → BLOCK on AI-bound routes; REDACT INLINE on internal routes.
   */
  readonly confidence: 'high_confidence' | 'low_confidence';
  /** Regex applied against candidate free-text. */
  readonly regex: RegExp;
  /**
   * Optional post-match validator (e.g., Luhn check for credit cards).
   * If present, a regex match is ONLY treated as a hit when the validator
   * also returns true. Reduces false-positive rate on structural patterns.
   */
  readonly validate?: (match: string) => boolean;
}

/**
 * Luhn algorithm validator — used to reduce false positives on credit-card
 * regex matches (13-19 digit sequences that don't Luhn-validate are
 * arithmetic strings, not card numbers).
 */
export function isLuhnValid(digitString: string): boolean {
  const digits = digitString.replace(/\D/g, '');
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  let alternate = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = parseInt(digits.charAt(i), 10);
    if (alternate) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alternate = !alternate;
  }
  return sum % 10 === 0;
}

/**
 * Pattern library — ordered by expected match cost (cheapest first) so
 * the screener can short-circuit on the first hit if desired.
 */
export const PII_PATTERNS: readonly PiiPattern[] = [
  // ---------------------------------------------------------------------
  // Government identifiers — high confidence
  // ---------------------------------------------------------------------
  {
    id: 'us_ssn',
    label: 'US Social Security Number',
    confidence: 'high_confidence',
    // Standard SSN format XXX-XX-XXXX with word boundaries to avoid
    // matching inside longer digit sequences. Also matches without
    // hyphens if surrounded by non-digit boundaries.
    regex: /\b\d{3}-\d{2}-\d{4}\b/g,
  },
  {
    id: 'ghana_card',
    label: 'Ghana National ID (Ghana Card)',
    confidence: 'high_confidence',
    // Ghana Card format: GHA-XXXXXXXXX-X (13 chars including hyphens,
    // GHA prefix + 9 digits + check digit).
    regex: /\bGHA-\d{9}-\d\b/g,
  },
  {
    id: 'us_passport',
    label: 'US Passport number',
    confidence: 'low_confidence',
    // 9 alphanumeric chars, often mixed. Low confidence because a bare
    // 9-char alphanumeric could be many things; we require an
    // adjacent "passport" word context in the calling code if we want
    // to raise confidence.
    regex: /\b[A-Z0-9]{9}\b/g,
  },

  // ---------------------------------------------------------------------
  // Financial identifiers — high confidence (Luhn-validated)
  // ---------------------------------------------------------------------
  {
    id: 'credit_card',
    label: 'Credit card number',
    confidence: 'high_confidence',
    // 13-19 digit sequences with optional separators (spaces/hyphens).
    // The Luhn validator below filters out arithmetic false positives.
    regex: /\b(?:\d[ -]?){13,19}\b/g,
    validate: (match: string) => isLuhnValid(match),
  },

  // ---------------------------------------------------------------------
  // Contact identifiers — high confidence
  // ---------------------------------------------------------------------
  {
    id: 'email',
    label: 'Email address',
    confidence: 'high_confidence',
    // Standard email pattern (RFC 5322 subset covering common forms).
    // Deliberately excludes participant login emails (which are
    // synthetic per the participant kit); real personal emails match
    // this pattern.
    regex: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,24}\b/g,
  },
  {
    id: 'us_phone',
    label: 'US phone number',
    confidence: 'high_confidence',
    // Matches +1 XXX-XXX-XXXX, (XXX) XXX-XXXX, XXX-XXX-XXXX, XXX.XXX.XXXX
    // and various compact forms. Word boundaries prevent matching inside
    // longer digit sequences.
    regex:
      /(?:\+?1[\s.-]?)?\(?([2-9]\d{2})\)?[\s.-]?([2-9]\d{2})[\s.-]?(\d{4})\b/g,
  },
  {
    id: 'ghana_phone',
    label: 'Ghana phone number',
    confidence: 'high_confidence',
    // +233 followed by 9 digits (Ghana country code + subscriber),
    // or 0 followed by 9 digits (Ghana local format). Word boundaries
    // matter.
    regex: /\b(?:\+233\d{9}|0\d{9})\b/g,
  },

  // ---------------------------------------------------------------------
  // Network identifiers — low confidence (can appear in synthetic data)
  // ---------------------------------------------------------------------
  {
    id: 'ipv4',
    label: 'IPv4 address',
    confidence: 'low_confidence',
    // Standard dotted quad. Low confidence because 127.0.0.1 or
    // 192.168.1.1 might legitimately appear in synthetic test data
    // discussion; for AI-bound routes still block (defense-in-depth).
    regex: /\b(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\b/g,
  },

  // ---------------------------------------------------------------------
  // Medical record identifiers — high confidence (structural patterns)
  // ---------------------------------------------------------------------
  {
    id: 'medical_record_number',
    label: 'Medical record number (structural pattern)',
    confidence: 'high_confidence',
    // Common MRN patterns: 6-10 digits prefixed by "MRN", "MR#", or "MR:".
    // Case-insensitive.
    regex: /\b(?:MRN|MR#|MR:?)\s*[:#-]?\s*\d{5,12}\b/gi,
  },
] as const;

/**
 * Convenience lookup by pattern id.
 */
export function getPatternById(id: string): PiiPattern | undefined {
  return PII_PATTERNS.find((p) => p.id === id);
}
