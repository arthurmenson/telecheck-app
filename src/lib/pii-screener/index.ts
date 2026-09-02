/**
 * pii-screener/index.ts — Layer 1 input screener for Pilot 1 synthetic-only
 * substrate.
 *
 * Sprint 1.1a: regex-only implementation. Local NER (Sprint 1.1b) will
 * plug into the same interface without changing the calling contract.
 *
 * Purpose (per docs/PII_SCREENING_AND_LOG_REDACTION_SPEC.md §Layer 1):
 *   Block or warn on free-text inputs that contain real personal
 *   information, preventing that content from reaching the substrate,
 *   the AI provider, logs, or backups. Pilot 1 participants sign a
 *   consent agreeing not to enter real PII; this screener catches
 *   accidents (and, on second occurrence per the IR runbook Category 5,
 *   participant removal).
 *
 * Absolute prohibition (per PII spec §Layer 1 §Absolute prohibition):
 *   This module NEVER calls an external AI provider (Anthropic /
 *   Bedrock / Azure) to classify candidate text. The candidate text
 *   IS the potential real PII we are trying to keep away from those
 *   providers. All classification is local (regex here; Sprint 1.1b
 *   adds local NER).
 *
 * Decision matrix (per PII spec §Layer 1 §Decision):
 *   Route class     | Any hit          | Interpretation
 *   ----------------|------------------|----------------------------------
 *   ai_bound        | BLOCK (422)      | AI-bound routes reach a provider
 *                   |                  | that MUST NEVER see real PII.
 *   internal        | high → BLOCK     | Internal routes persist to DB
 *                   | low  → REDACT    | but not the provider; low-conf
 *                   |                  | redaction preserves workflow.
 *
 * Spec references:
 *   - docs/PII_SCREENING_AND_LOG_REDACTION_SPEC.md §Layer 1 (input screener)
 *   - docs/PATH_A_PILOT_COMPLETION_RUNBOOK.md §Technical gates
 *   - docs/PILOT_1_COVERAGE_MATRIX.md scenarios A1-A6, A6b (adversarial coverage)
 */

import { classifyEntities, NerOffsetDerivationError } from './ner.js';
import { PII_PATTERNS, type PiiPattern } from './patterns.js';

/**
 * The class of route being screened. Determines fail-closed semantics.
 * See module header §Decision matrix.
 */
export type RouteClass = 'ai_bound' | 'audit_bound' | 'internal';

/**
 * A single pattern hit inside a candidate string.
 */
export interface PiiHit {
  /** Pattern id that fired (e.g., `us_ssn`, `email`). */
  readonly patternId: string;
  /** Human-readable label for participant-visible messages. */
  readonly label: string;
  /** Confidence class of the firing pattern. */
  readonly confidence: 'high_confidence' | 'low_confidence';
  /**
   * The matched substring. NOT logged raw; used only for redaction
   * computation and length-based diagnostics. Callers MUST NOT
   * persist or transmit this value except through the same Layer 3
   * log-redaction path.
   */
  readonly match: string;
  /** Start index of the match in the input. */
  readonly start: number;
  /** End index (exclusive) of the match in the input. */
  readonly end: number;
}

/**
 * Result of a Layer 1 screening pass.
 *
 * The screener itself is DECISION-NEUTRAL — it returns hits + a
 * suggested action based on RouteClass. The route handler makes the
 * final call to reject-with-422 vs. redact-inline vs. warn.
 */
export interface ScreeningResult {
  /**
   * Every pattern hit found in the input, in match-order. Empty when
   * no pattern fired.
   */
  readonly hits: readonly PiiHit[];
  /**
   * Suggested action given the route class and the highest-confidence
   * hit found. Route handlers should honor this unless they have an
   * explicit exemption (e.g., a route accepting an already-vetted
   * clinician-authored structured document).
   *
   * `block` — reject the request with 422; do NOT continue processing.
   * `redact` — replace the matched substrings inline in the input and
   *   continue processing with the redacted content. Emit a warn-class
   *   audit event.
   * `pass` — no hits; process the input unchanged.
   */
  readonly action: 'block' | 'redact' | 'pass';
  /**
   * When `action === 'redact'`, the input string with each low-confidence
   * hit replaced by `[REDACTED:<label>]`. Undefined for `block` and
   * `pass` results. Populated only for internal routes with low-confidence
   * hits (AI-bound routes never redact because low-confidence still blocks).
   */
  readonly redactedInput?: string;
  /**
   * When `action === 'block'`, a machine-readable reason code for the
   * response envelope. Undefined otherwise.
   */
  readonly blockReason?:
    | 'regex_match_high_confidence'
    | 'regex_match_any_ai_bound'
    | 'match_any_audit_bound';
  /**
   * When `action === 'block'`, a participant-visible message pointing to
   * the participant kit's synthetic values. Undefined otherwise.
   */
  readonly participantMessage?: string;
}

/**
 * Standard participant-visible block message. Kept as a constant so the
 * participant-kit training document can quote it exactly.
 */
export const PARTICIPANT_BLOCK_MESSAGE =
  'This looks like real personal information. Pilot 1 uses synthetic data only. ' +
  'Please re-enter with synthetic values (see participant kit).';

/**
 * Screen a candidate free-text string for PII per §Layer 1.
 *
 * @param text - The candidate string to screen. Empty string returns
 *   a pass result.
 * @param routeClass - Whether the route being called reaches an
 *   external AI provider (`ai_bound`) or stays within the trusted
 *   substrate (`internal`). Determines the low-confidence handling.
 * @returns Decision-neutral ScreeningResult; route handler decides
 *   whether to reject-with-422, redact-and-continue, or pass-through.
 *
 * Runtime characteristics:
 *   - Pure function: no I/O, no network, no logging.
 *   - Deterministic: same input + route class → same result every time.
 *   - Complexity: O(patterns × input length). For Pilot 1 traffic
 *     (10 volunteer participants, short messages) this is trivially
 *     fast. Sprint 1.1b's local NER will change the cost profile.
 *
 * SAFETY: this function is guaranteed by construction to NEVER make an
 * external network call. It uses only synchronous regex operations
 * against the compile-time PII_PATTERNS array. Sprint 1.1b MUST
 * preserve this property when adding the NER layer — see the
 * §Absolute prohibition callout in the module header.
 */
export function screenInput(text: string, routeClass: RouteClass): ScreeningResult {
  if (text.length === 0) {
    return { hits: [], action: 'pass' };
  }

  const hits: PiiHit[] = [];
  // Layer 1a — regex fast-path.
  for (const pattern of PII_PATTERNS) {
    // Reset regex lastIndex to allow reuse (regexes in PII_PATTERNS use /g flag).
    pattern.regex.lastIndex = 0;
    for (const match of text.matchAll(pattern.regex)) {
      const matchedText = match[0];
      const start = match.index ?? 0;
      // Optional post-match validator (e.g., Luhn for credit card). If a
      // pattern declares a validator and it rejects, this is not a hit.
      if (pattern.validate && !pattern.validate(matchedText)) {
        continue;
      }
      hits.push({
        patternId: pattern.id,
        label: pattern.label,
        confidence: pattern.confidence,
        match: matchedText,
        start,
        end: start + matchedText.length,
      });
    }
  }

  // Layer 1b — local NER classifier (Sprint 1.1b; wink-nlp).
  // Runs after regex so regex-matched substrings still surface as
  // regex hits with their own labels; NER surfaces entities the regex
  // library does not express (real names, addresses, DOBs, orgs).
  //
  // Per Codex R5 (Sprint 1.1b): if NER detects an entity but offset
  // derivation fails, throw NerOffsetDerivationError rather than silently
  // omit the hit. We catch it here and fail closed with a synthetic
  // high-confidence hit; the route handler sees the hit + blocks, so
  // the potentially-real PII cannot slip into the request pipeline
  // just because we couldn't compute where it is.
  try {
    for (const ner of classifyEntities(text)) {
      hits.push({
        patternId: `ner_${ner.entityType.toLowerCase()}`,
        label: nerLabelFor(ner.entityType),
        confidence: ner.confidence,
        match: ner.match,
        start: ner.start,
        end: ner.end,
      });
    }
  } catch (e) {
    if (e instanceof NerOffsetDerivationError) {
      // Fail closed: synthesize a whole-input high-confidence hit so
      // the decision matrix blocks. The match spans the entire input
      // because we cannot localize; the participant sees the standard
      // block message + is prompted to re-enter with synthetic values.
      hits.push({
        patternId: 'ner_offset_derivation_failure',
        label: `Named entity (${e.entityType}) — offset undeterminable`,
        confidence: 'high_confidence',
        match: text,
        start: 0,
        end: text.length,
      });
    } else {
      throw e;
    }
  }

  if (hits.length === 0) {
    return { hits: [], action: 'pass' };
  }

  const hasHighConfidence = hits.some((h) => h.confidence === 'high_confidence');

  // Decision matrix per §Layer 1 Decision.
  if (routeClass === 'ai_bound') {
    // AI-bound routes fail-closed on ANY hit — high or low confidence —
    // because the low-confidence match may still be real PII that
    // MUST NOT reach the external provider.
    return {
      hits,
      action: 'block',
      blockReason: hasHighConfidence ? 'regex_match_high_confidence' : 'regex_match_any_ai_bound',
      participantMessage: PARTICIPANT_BLOCK_MESSAGE,
    };
  }

  if (routeClass === 'audit_bound') {
    // Audit-bound routes fail-closed on ANY hit for a reason distinct
    // from (and arguably stronger than) the ai_bound rationale:
    //
    //   The audit chain is APPEND-ONLY per I-003, and the Pilot 1
    //   env-purge allowlist explicitly PRESERVES `audit_records` (it is
    //   the vehicle for the `env.purge.executed` attestation). So PII
    //   that reaches an audit record survives the environment purge
    //   ENTIRELY — the one mitigation Pilot 1 relies on for the
    //   crisis-path residual risk does not apply here.
    //
    //   There is no redact-inline option either: rewriting an audit
    //   payload after the fact would itself violate I-003.
    //
    // Therefore: block at ingress, before the audit row is written.
    return {
      hits,
      action: 'block',
      blockReason: 'match_any_audit_bound',
      participantMessage: PARTICIPANT_BLOCK_MESSAGE,
    };
  }

  // routeClass === 'internal'
  if (hasHighConfidence) {
    return {
      hits,
      action: 'block',
      blockReason: 'regex_match_high_confidence',
      participantMessage: PARTICIPANT_BLOCK_MESSAGE,
    };
  }

  // Low-confidence-only hits on an internal route → redact inline.
  return {
    hits,
    action: 'redact',
    redactedInput: applyRedactions(text, hits),
  };
}

/**
 * Apply inline redactions to the input string, replacing each hit
 * substring with `[REDACTED:<label>]`. Hits must be sorted by
 * start-index (screenInput() emits them in match-order, which is
 * start-index-ascending per pattern; we sort here for safety when
 * multiple patterns overlap).
 *
 * When two hits overlap, the earlier one wins (its redaction extends
 * over the later one's range). This is a deterministic tie-break; the
 * participant sees the earlier pattern's label.
 */
function applyRedactions(text: string, hits: readonly PiiHit[]): string {
  const sorted = [...hits].sort((a, b) => a.start - b.start);
  const chunks: string[] = [];
  let cursor = 0;
  for (const hit of sorted) {
    if (hit.start < cursor) {
      // Overlap with a previous hit — skip. The previous redaction
      // already covers this range.
      continue;
    }
    chunks.push(text.slice(cursor, hit.start));
    chunks.push(`[REDACTED:${hit.label}]`);
    cursor = hit.end;
  }
  chunks.push(text.slice(cursor));
  return chunks.join('');
}

/**
 * Result of a Layer 2 egress screening pass.
 *
 * Layer 2 is REDACT-ONLY by design — it never blocks. Rationale:
 *   - By the time content reaches egress, the work is already done
 *     (the LLM has been called, the row has been written). Blocking the
 *     response would cost the participant their turn while leaving the
 *     upstream state intact — strictly worse than redacting.
 *   - Layer 1 is the blocking gate. Layer 2 is the safety net for
 *     content Layer 1 could not have seen: model-GENERATED text that
 *     happens to contain PII-shaped output.
 */
export interface EgressScreeningResult {
  /** Every hit found in the candidate output, in match-order. */
  readonly hits: readonly PiiHit[];
  /**
   * The output with every hit replaced by `[REDACTED:<label>]`.
   * Equals the input verbatim when there are no hits.
   */
  readonly output: string;
  /** True when at least one redaction was applied. */
  readonly redacted: boolean;
}

/**
 * Screen a candidate egress string (Layer 2) and return it with any PII
 * redacted inline.
 *
 * **Where this matters (Sprint 1.1d egress inventory).** Most Telecheck
 * response surfaces carry NO screenable plaintext:
 *   - async-consult reads return pre-encrypted KMS envelopes (I-026) —
 *     ciphertext, nothing to screen
 *   - admin dashboards return aggregate counts — no free-text echo
 *   - the Mode 1 crisis sentinel is a fixed server-side constant
 *
 * The one genuine surface is **Mode 1 `response_text`** — model-generated
 * prose. Note what this does and does not defend against:
 *   - It does NOT defend against the participant's own PII round-tripping,
 *     because Layer 1 already blocked that input before the provider saw
 *     it (route class `ai_bound` blocks on ANY hit).
 *   - It DOES defend against the model EMITTING PII-shaped text of its
 *     own accord — a hallucinated name, a plausible-looking SSN, an
 *     invented email. That output is not real PII, but it is
 *     indistinguishable from real PII to a reader, and rendering it to a
 *     Pilot 1 participant is both confusing and (if it coincides with a
 *     real identifier) a genuine hazard.
 *
 * @param text - Candidate egress string.
 * @returns The redacted output plus the hits that drove it.
 *
 * SAFETY: same absolute prohibition as Layer 1 — this performs only
 * local regex + local NER classification and never calls an external
 * provider. The import allowlist enforced by the SAFETY checker in
 * index.test.ts covers this function's dependencies.
 */
export function screenOutput(text: string): EgressScreeningResult {
  if (text.length === 0) {
    return { hits: [], output: text, redacted: false };
  }
  // Reuse the Layer 1 detection pipeline with `internal` semantics —
  // we only need the hit list here; the action is always redact.
  const detected = screenInput(text, 'internal');
  if (detected.hits.length === 0) {
    return { hits: [], output: text, redacted: false };
  }
  return {
    hits: detected.hits,
    output: applyRedactions(text, detected.hits),
    redacted: true,
  };
}

/**
 * Human-readable label for NER-detected entity types. Used by the
 * participant-visible message + inline-redact placeholder.
 */
function nerLabelFor(entityType: string): string {
  switch (entityType) {
    case 'PERSON':
      return 'Person name';
    case 'GPE':
      return 'Geopolitical entity (country / city / state)';
    case 'LOCATION':
      return 'Location';
    case 'DATE':
      return 'Date';
    case 'ORG':
      return 'Organization';
    default:
      return `Named entity (${entityType})`;
  }
}

/**
 * Re-export the pattern types for callers that want to introspect the
 * loaded patterns (e.g., participant-kit documentation generators).
 */
export type { PiiPattern };
export { PII_PATTERNS } from './patterns.js';
