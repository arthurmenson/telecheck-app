/**
 * med-interaction/internal/types.ts — branded ID types only at v0.1.
 *
 * Schema authoring is BLOCKED on Med Interaction Engine slice
 * ratification. The CDM v1.2 entity inventory does not yet expand
 * Med Interaction signal/override/ruleset row shapes; per EHBG §7,
 * engineering does not author canonical schema. Branded IDs land
 * here because they are NOT schema (identifier hygiene); row-shape
 * interfaces wait for slice PRD ratification.
 *
 * The interaction engine itself is platform-floor: Master PRD §7
 * + EHBG §10 require the interaction check to run BEFORE clinician
 * commit on any prescription path. The hard-rule in CLAUDE.md
 * ("Interaction engine runs BEFORE clinician commits prescription —
 * not after, not in parallel") binds independent of slice ratification.
 *
 * This skeleton + branded IDs let downstream slices (Pharmacy, Async
 * Consult, Mode 2 protocol agents) compile clean against typed signal
 * + override references before the slice PRD lands.
 *
 * Spec references:
 *   - Master PRD v1.10 §7 (interaction engine as platform-floor)
 *   - EHBG §7 (engineering implements per CDM, does not author)
 *   - ADR-029 (AI workload taxonomy — interaction signals are
 *     `clinical_decision_support` workload class)
 *   - I-019 (crisis detection adjacent — both are platform-floor)
 *   - Pharmacy + Refill Slice PRD v2.1 §6 (downstream consumer)
 */

// ---------------------------------------------------------------------------
// Branded ID types — PROVISIONAL pending Med Interaction Engine slice PRD
// ratification. Names align with anticipated CDM entity inventory; if a
// future slice PRD picks different names, treat as Sprint 4+ rename.
// ---------------------------------------------------------------------------

declare const _interactionSignalIdBrand: unique symbol;
export type InteractionSignalId = string & {
  readonly [_interactionSignalIdBrand]: 'InteractionSignalId';
};
export function asInteractionSignalId(s: string): InteractionSignalId {
  return s as InteractionSignalId;
}

declare const _interactionOverrideIdBrand: unique symbol;
export type InteractionOverrideId = string & {
  readonly [_interactionOverrideIdBrand]: 'InteractionOverrideId';
};
export function asInteractionOverrideId(s: string): InteractionOverrideId {
  return s as InteractionOverrideId;
}

declare const _interactionRulesetIdBrand: unique symbol;
export type InteractionRulesetId = string & {
  readonly [_interactionRulesetIdBrand]: 'InteractionRulesetId';
};
export function asInteractionRulesetId(s: string): InteractionRulesetId {
  return s as InteractionRulesetId;
}

// Row-shape interfaces (InteractionSignal, InteractionOverride,
// InteractionRuleset) are intentionally NOT exported here. They land
// when the Med Interaction Engine slice PRD is ratified and CDM §4
// adds the field-level expansion.
