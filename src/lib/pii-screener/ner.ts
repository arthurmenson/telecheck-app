/**
 * pii-screener/ner.ts — Layer 1 local NER classifier (Sprint 1.1b).
 *
 * Extends the regex core (patterns.ts) with named-entity recognition for
 * classes that regex cannot express cleanly: real person names, addresses,
 * organizations, dates of birth, geopolitical entities.
 *
 * Library choice: **wink-nlp** with the **wink-eng-lite-web-model**
 * (Evans-ratified 2026-08-31 chat message "B").
 * - MIT-licensed, no native bindings, ~4MB model
 * - Runs entirely in Node — matches the SAFETY invariant (never touches
 *   an external AI provider); the "web-model" name refers to the model
 *   being usable in web contexts, not to network access
 * - Covers PERSON / DATE / TIME / MONEY / ORG / GPE / NUMBER / CARDINAL /
 *   ORDINAL / PERCENT entity types with a small English model
 *
 * Absolute prohibition (unchanged from Sprint 1.1a Layer 1):
 *   This module NEVER calls an external AI provider (Anthropic / Bedrock
 *   / Azure) to classify candidate text. wink-nlp is a purely local
 *   library — the SAFETY checker's import allowlist admits it exactly
 *   because it does not reach the network.
 *
 * Adversarial coverage (per docs/PILOT_1_COVERAGE_MATRIX.md):
 *   - A1: real-looking name in chat  → NER PERSON fires → BLOCK on ai_bound
 *   - A5: clinician real patient real name in decision notes → same
 *   - A6: subtle PII (name + condition tied) on AI-bound route → BLOCK
 *   - A6b: same on internal route → REDACT INLINE (low-confidence NER hit)
 *
 * Confidence classification (per PII spec §Layer 1 Decision matrix):
 *   - PERSON entities → high_confidence (real names are unambiguous PII)
 *   - GPE / LOCATION → low_confidence (a city name might appear in
 *     synthetic prose; still block on ai_bound per matrix)
 *   - DATE → low_confidence (dates in medical prose are common but real
 *     DOBs must be caught; the workflow is: participants use the synthetic
 *     1990-01-01 across the roster, so any OTHER date should still pass;
 *     redact-inline on internal is the safe posture)
 *   - Everything else → not surfaced by this module (out of Sprint 1.1b
 *     scope; extend the allowed entity list here if a follow-up PR needs
 *     ORG or MONEY detection)
 *
 * SAFETY: this module is guaranteed by construction to NEVER make an
 * external network call. wink-nlp + wink-eng-lite-web-model both load
 * their model from disk at process start; screening is pure CPU work
 * against the loaded model. The SAFETY checker (index.test.ts) admits
 * exactly these two specifiers and no others.
 */

/* eslint-disable @typescript-eslint/unbound-method -- wink-nlp's `its.*`
 * accessors are the library's canonical projection API (see wink-nlp
 * docs); they are passed to `.out()` unbound by design. The lint rule
 * fires because `its.detail`, `its.value`, `its.span` are typed as
 * methods on an object, but wink-nlp treats them as inert selector
 * references, not methods called against `this`. Disabling per file
 * is the correct posture for library API conformance. */

import model from 'wink-eng-lite-web-model';
import winkNLP, { type WinkMethods, type Detail, type ItemEntity } from 'wink-nlp';

/**
 * A single NER-detected entity hit in the input, normalized to the
 * Layer 1 PiiHit shape (see index.ts).
 */
export interface NerHit {
  /** wink-nlp entity type, uppercased. */
  readonly entityType: string;
  /** Confidence class per §Confidence classification above. */
  readonly confidence: 'high_confidence' | 'low_confidence';
  /** The matched substring. */
  readonly match: string;
  /** Start index in the original input. */
  readonly start: number;
  /** End index (exclusive) in the original input. */
  readonly end: number;
}

/**
 * Entity types the NER classifier surfaces. Any entity type NOT on this
 * list is ignored (see §Confidence classification above). Extending the
 * list requires Sprint 1.1b Codex re-review because the confidence
 * classification determines the block/redact/pass decision.
 */
const SURFACED_ENTITY_TYPES: readonly string[] = [
  'PERSON', // real names
  'GPE', // geopolitical entity (country, city, state)
  'LOCATION', // location
  'DATE', // dates including DOBs
  'ORG', // organization names — could tie to real identity
];

/**
 * Confidence classification per §Confidence classification above.
 */
const ENTITY_CONFIDENCE: Readonly<Record<string, 'high_confidence' | 'low_confidence'>> = {
  PERSON: 'high_confidence',
  GPE: 'low_confidence',
  LOCATION: 'low_confidence',
  DATE: 'low_confidence',
  ORG: 'low_confidence',
};

/**
 * The wink-nlp instance is loaded once at module init. wink-nlp is
 * synchronous once the model is loaded, so we can memoize + reuse across
 * all screener invocations.
 */
let nlpInstance: WinkMethods | null = null;

/**
 * Returns the memoized wink-nlp instance, loading it lazily on first
 * call. Lazy to avoid paying the ~4MB model cost when only the regex
 * core is exercised (e.g., in isolated unit tests).
 */
function getNlp(): WinkMethods {
  if (nlpInstance === null) {
    nlpInstance = winkNLP(model);
  }
  return nlpInstance;
}

/**
 * Run wink-nlp entity extraction against the candidate input and return
 * every hit for a surfaced entity type. Deterministic (wink-nlp is
 * rule-based + statistical over a fixed model; no non-determinism).
 *
 * @param text - Candidate free-text.
 * @returns Zero or more NerHit records in match-order.
 *
 * Character-offset strategy (Codex R3 finding on Sprint 1.1a Sprint 1.1b —
 * the merge-critical risk in wink-nlp integration):
 *   wink-nlp's `its.span` on an entity returns token-index ranges, and
 *   the mapping from token span to character span is subtle (multi-token
 *   entities, punctuation attachment). Rather than reconstruct character
 *   offsets from token metadata, we ask wink-nlp for the entity's
 *   matched text via `its.value` and locate it via `indexOf` starting
 *   from a monotonically-advancing cursor. This is:
 *     - correct by construction (the text we redact IS the text we matched)
 *     - order-preserving (entities come in appearance order + cursor
 *       advances)
 *     - safe against multi-occurrence collisions (if the same entity
 *       text appears twice, each hit gets its own occurrence via cursor)
 *     - independent of wink-nlp's internal token/span representation
 */
export function classifyEntities(text: string): readonly NerHit[] {
  if (text.length === 0) return [];
  const nlp = getNlp();
  const doc = nlp.readDoc(text);
  const hits: NerHit[] = [];
  // Cursor advances after each matched entity so a repeated entity text
  // resolves to its next occurrence in the source, not the first.
  let cursor = 0;
  doc.entities().each((entity: ItemEntity) => {
    const detail = entity.out(nlp.its.detail) as Detail;
    // wink-nlp entity types are typically lowercased; normalize.
    const rawType = detail.type ?? '';
    const entityType = String(rawType).toUpperCase();
    if (!SURFACED_ENTITY_TYPES.includes(entityType)) {
      return;
    }
    const value = String(entity.out(nlp.its.value));
    if (value.length === 0) return;
    // Locate this entity's text at or after the cursor. wink-nlp emits
    // entities in appearance order; if indexOf returns -1 (misalignment
    // due to normalization by wink-nlp), skip this entity rather than
    // record a wrong offset.
    const start = text.indexOf(value, cursor);
    if (start < 0) return;
    const end = start + value.length;
    cursor = end;
    const confidence = ENTITY_CONFIDENCE[entityType] ?? 'low_confidence';
    hits.push({
      entityType,
      confidence,
      match: value,
      start,
      end,
    });
  });
  return hits;
}
