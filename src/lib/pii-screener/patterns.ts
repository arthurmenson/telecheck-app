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
  /**
   * Whether Layer 3 (log redaction) applies this pattern.
   *
   * REQUIRED, not optional, so adding a pattern forces the decision
   * rather than inheriting a default.
   *
   * This is a SEPARATE axis from `confidence`, which governs the Layer 1
   * route decision (block vs redact-inline). Layer 3 originally filtered
   * on `confidence` and that was wrong: it conflated two unrelated
   * reasons a pattern might be low-confidence.
   *
   *   - `ipv4` / `ipv6` are genuinely ambiguous in a log line — an IP
   *     there is usually infrastructure, and scrubbing it would delete
   *     the diagnostic signal the logs exist for. Excluded.
   *   - `us_passport` is low-confidence only because it needs CONTEXT.
   *     The pattern now requires the literal word "passport" adjacent to
   *     the value, so a match is high-signal, not noisy. Filtering it out
   *     of Layer 3 meant `passport no. AB1234567` reached the log
   *     destination unredacted (Codex finding, Sprint 1.2a).
   *
   * Set false ONLY when a match is more likely to be an operational
   * value than PII. When in doubt, set true — Layer 3 is the last line
   * of defense, where a false redaction costs less than a leak.
   */
  readonly redactInLogs: boolean;
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
    redactInLogs: true,
    // Both forms: XXX-XX-XXXX (hyphenated) OR XXXXXXXXX (9 contiguous
    // digits — the "compact" SSN form). Lookaround-bounded on digits
    // to prevent matching inside longer digit sequences (e.g., 16-digit
    // card numbers or MRN sequences).
    //
    // Codex R1 finding (2026-08-31): the prior `\b\d{3}-\d{2}-\d{4}\b`
    // did NOT match the compact 9-digit form despite the comment
    // claiming it did, so `123456789` was being classified as the
    // low-confidence `us_passport` pattern instead — a decision-matrix
    // violation on internal routes (would redact instead of block).
    regex: /(?<!\d)(?:\d{3}-\d{2}-\d{4}|\d{9})(?!\d)/g,
  },
  {
    id: 'ghana_card',
    label: 'Ghana National ID (Ghana Card)',
    confidence: 'high_confidence',
    redactInLogs: true,
    // Ghana Card format: GHA-XXXXXXXXX-X (13 chars including hyphens,
    // GHA prefix + 9 digits + check digit).
    regex: /\bGHA-\d{9}-\d\b/g,
  },
  {
    id: 'us_passport',
    label: 'US Passport number (context-bound)',
    confidence: 'low_confidence',
    // Context-bound, so a match is high-signal despite the
    // low_confidence route classification — see redactInLogs.
    redactInLogs: true,
    // 9 alphanumeric chars ADJACENT to a "passport" keyword (case-
    // insensitive). Codex R1 finding (2026-08-31): the prior
    // context-free `\b[A-Z0-9]{9}\b` matched any 9-char uppercase word
    // — `SYNTHETIC`, `EMERGENCY`, `EDUCATION` — over-blocking on
    // AI-bound routes and false-positive on internal.
    //
    // Contextual form: `passport(?: (?:no\.?|number|#))?\s*[:#]?\s*
    // [A-Z0-9]{9}` — matches "passport 123456789", "passport no. AB1234567",
    // "passport #: ABCDE1234", etc. When the 9-char string appears
    // WITHOUT the passport-context word, Sprint 1.1b's local NER is the
    // authoritative detector (this narrow regex is a fast-path for the
    // labeled case).
    regex: /\bpassport(?:\s+(?:no\.?|number|#))?\s*[:#]?\s*([A-Z0-9]{9})\b/gi,
  },

  // ---------------------------------------------------------------------
  // Financial identifiers — high confidence (Luhn-validated)
  // ---------------------------------------------------------------------
  {
    id: 'credit_card',
    label: 'Credit card number',
    confidence: 'high_confidence',
    redactInLogs: true,
    // 13-19 digit sequences with optional inter-digit separators
    // (spaces/hyphens ONLY between digits — never trailing).
    // Codex R1 finding (2026-08-31): the prior `\b(?:\d[ -]?){13,19}\b`
    // put the separator inside the repeated group, greedy-including
    // any trailing space, so `4111 1111 1111 1111 expires` matched
    // `4111 1111 1111 1111 ` (with trailing space) — wrong boundary
    // + broken canonical test.
    //
    // Fix: separators appear ONLY between digits; final char must be a
    // digit. Structure: digit, then 12-18 repetitions of
    // [optional separator + digit].
    regex: /(?<!\d)\d(?:[ -]?\d){12,18}(?!\d)/g,
    validate: (match: string) => isLuhnValid(match),
  },

  // ---------------------------------------------------------------------
  // Contact identifiers — high confidence
  // ---------------------------------------------------------------------
  {
    id: 'email',
    label: 'Email address',
    confidence: 'high_confidence',
    redactInLogs: true,
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
    redactInLogs: true,
    // Matches +1 XXX-XXX-XXXX, (XXX) XXX-XXXX, XXX-XXX-XXXX, XXX.XXX.XXXX,
    // AND the bare ten-digit form XXXXXXXXXX.
    //
    // ## The bug this shape fixes, and the over-correction after it
    //
    // The original form ended in `\b` with no leading digit guard, so it
    // matched any ten consecutive digits with plausible leading digits —
    // INCLUDING a run sitting inside a longer identifier. The UUID
    // `550e8400-e29b-41d4-a716-446655440000` contains `6655440000`, so
    // roughly 1–2% of UUIDs were rewritten as
    // `...44[REDACTED:US phone number]`; `9007199254740993` became
    // `900719[REDACTED:...]`. Those identifiers appear on nearly every
    // log line, so the loose form damaged far more than it protected.
    //
    // My first fix dropped bare ten-digit detection altogether. That was
    // an over-correction: it left a real bare phone number (`3125551212`)
    // passing Layer 3 unredacted — precisely the case a last-line
    // defense exists for.
    //
    // ## The actual fix: digit lookarounds, not fewer forms
    //
    // The problem was never the bare form; it was SUBSTRING matching.
    // Bounding every alternative with `(?<!\d)` / `(?!\d)` means a
    // ten-digit candidate embedded in a longer digit run is rejected
    // because it is adjacent to another digit, while a standalone phone
    // number still matches. UUIDs and large integers are safe by
    // construction rather than by exclusion.
    // The guards bracket the WHOLE match, not each alternative. Putting
    // `(?<!\d)` inside the bare alternative instead made `+14155550123`
    // fall through: the optional `+1` prefix was consumed first, so the
    // guard saw `1` as the preceding character and failed.
    //
    // Trade-off accepted: a standalone ten-digit integer under an
    // arbitrary key redacts even when it is not a phone number. Numeric
    // fields pino itself emits are protected by NUMERIC_PRESERVE_RULES;
    // beyond those there is no shape test that separates a bare phone
    // number from a bare ten-digit counter, and Layer 3 is a last-line
    // defense where a false redaction costs less than a leak.
    regex:
      /(?<!\d)(?:\+?1[\s.-]?)?(?:\([2-9]\d{2}\)[\s.-]?[2-9]\d{2}[\s.-]?\d{4}|[2-9]\d{2}[\s.-][2-9]\d{2}[\s.-]\d{4}|[2-9]\d{2}[2-9]\d{2}\d{4})(?!\d)/g,
  },
  {
    id: 'ghana_phone',
    label: 'Ghana phone number',
    confidence: 'high_confidence',
    redactInLogs: true,
    // +233 followed by 9 digits (Ghana country code + subscriber),
    // or 0 followed by 9 digits (Ghana local format).
    //
    // Codex R1 finding (2026-08-31): the prior `\b(?:\+233\d{9}|0\d{9})\b`
    // used `\b` which does NOT match before `+` because both are
    // non-word chars (\b is a word/non-word transition; +/space are
    // both non-word). So the documented + tested `+233241234567` form
    // silently produced zero hits and would pass through an AI-bound
    // route. Fix: digit-lookaround boundaries `(?<!\d)...(?!\d)` on
    // the digit portion — matches after any non-digit context
    // (whitespace, punctuation, string start).
    //
    // Sprint 1.2a: separators added. The contiguous-only form missed
    // `+233 24 123 4567` and `024 123 4567`, which is how these numbers
    // are usually written — while `us_phone` had accepted separators all
    // along. Ghana testers are explicitly in Pilot 1 scope (see the
    // locale-coverage note in this file's header), so the gap was live
    // on an AI-bound route, not theoretical. Grouping is fixed at
    // 2-3-4 after the prefix, and the digit lookarounds still prevent
    // matching inside a longer run.
    regex:
      /(?<!\d)(?:\+233[\s.-]?\d{2}[\s.-]?\d{3}[\s.-]?\d{4}|0\d{2}[\s.-]?\d{3}[\s.-]?\d{4})(?!\d)/g,
  },

  // ---------------------------------------------------------------------
  // Network identifiers — low confidence (can appear in synthetic data)
  // ---------------------------------------------------------------------
  {
    id: 'ipv4',
    label: 'IPv4 address',
    confidence: 'low_confidence',
    // Operational, not PII, in a log line — see redactInLogs.
    redactInLogs: false,
    // Standard dotted quad. Low confidence because 127.0.0.1 or
    // 192.168.1.1 might legitimately appear in synthetic test data
    // discussion; for AI-bound routes still block (defense-in-depth).
    regex: /\b(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\b/g,
  },
  {
    id: 'ipv6',
    label: 'IPv6 address',
    confidence: 'low_confidence',
    // Operational, not PII, in a log line — see redactInLogs.
    redactInLogs: false,
    // IPv6 in three common forms:
    //   (1) full 8-group: 2001:0db8:85a3:0000:0000:8a2e:0370:7334
    //   (2) compressed with `::` (one or more all-zero groups collapsed):
    //       2001:db8::8a2e:370:7334, ::1, fe80::, ::
    //   (3) IPv4-mapped: ::ffff:192.0.2.1
    //
    // The alternation covers:
    //   (a) 8 full groups
    //   (b) any occurrence of `::` between valid group runs, requiring
    //       at least one hex group total (avoids matching bare `::`
    //       without context — though bare `::` is a valid loopback
    //       address; we include it as its own alternate)
    //   (c) IPv4-mapped form `::ffff:d.d.d.d`
    //
    // Boundaries: word-boundary would be wrong (colons + hex are word-
    // like); use surrounding-non-address-char lookaround approximation
    // via (?<![:.0-9a-fA-F]) and (?![:.0-9a-fA-F]).
    //
    // Codex R9 finding (2026-08-31): the spec explicitly requires IPv6
    // detection; prior version shipped IPv4-only.
    regex: /(?<![:.0-9a-fA-F])(?:(?:[0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}|(?:[0-9a-fA-F]{1,4}:){1,7}:|(?:[0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|(?:[0-9a-fA-F]{1,4}:){1,5}(?::[0-9a-fA-F]{1,4}){1,2}|(?:[0-9a-fA-F]{1,4}:){1,4}(?::[0-9a-fA-F]{1,4}){1,3}|(?:[0-9a-fA-F]{1,4}:){1,3}(?::[0-9a-fA-F]{1,4}){1,4}|(?:[0-9a-fA-F]{1,4}:){1,2}(?::[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:(?:(?::[0-9a-fA-F]{1,4}){1,6})|:(?:(?::[0-9a-fA-F]{1,4}){1,7}|:)|::(?:ffff(?::0{1,4})?:)?(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?))(?![:.0-9a-fA-F])/g,
  },

  // ---------------------------------------------------------------------
  // Medical record identifiers — high confidence (structural patterns)
  // ---------------------------------------------------------------------
  {
    id: 'medical_record_number',
    label: 'Medical record number (structural pattern)',
    confidence: 'high_confidence',
    redactInLogs: true,
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
