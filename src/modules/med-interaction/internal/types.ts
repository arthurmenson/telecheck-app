/**
 * med-interaction/internal/types.ts — branded ID types (Sprint 1 / PR 1).
 *
 * Spec layer COMPLETE + RATIFIED (SI-019 v2.0 P-033 + CDM v1.6 → v1.7
 * P-034 RATIFIED 2026-05-21). CDM v1.7 §4.NEW1-NEW4 expanded the 4
 * canonical entities (interaction_engine_evaluation +
 * interaction_signal + interaction_signal_override +
 * interaction_signal_lifecycle_transition). At PR 1 (this commit) the
 * DB-layer migrations have NOT yet created the entity tables (RBAC
 * roles only); branded IDs ship now for cross-module type safety so
 * downstream slices (Pharmacy clinician-commit gate per I-002, Async
 * Consult, Mode 2 protocol agents) can typed-import ahead of full
 * row-shape interfaces (which land alongside repository files in PR
 * 2-3 when entities + views exist).
 *
 * The interaction engine itself is platform-floor: Master PRD §7
 * + I-002 require the interaction check to run BEFORE clinician
 * commit on any `medication_request` path. The hard-rule in CLAUDE.md
 * ("Interaction engine runs BEFORE clinician commits prescription —
 * not after, not in parallel") binds at the Pharmacy + Async Consult
 * clinician-commit boundaries.
 *
 * Spec references:
 *   - Telecheck_Medication_Interaction_Engine_Slice_PRD_v2_0.md (P-033)
 *   - Telecheck_CDM_v1_6_to_v1_7_Amendment.md §4.NEW1-NEW4 (P-034)
 *   - Master PRD v1.10 §7 (interaction engine as platform-floor)
 *   - I-002 (interaction-before-commit platform-floor)
 *   - ADR-029 (AI workload taxonomy — interaction signals are
 *     `clinical_decision_support` workload class)
 *   - I-019 (crisis detection adjacent — both are platform-floor)
 *   - Pharmacy + Refill Slice PRD v2.1 §6 (downstream consumer)
 *   - src/modules/med-interaction/README.md
 */

// ---------------------------------------------------------------------------
// Branded ID types — CDM v1.7 §4.NEW1-NEW3 canonical entities. Names map
// 1:1 to ratified CDM entity inventory; row-shape interfaces land with
// PR 2+ repository files.
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

// Row-shape interfaces (InteractionEngineEvaluation, InteractionSignal,
// InteractionSignalOverride, InteractionSignalLifecycleTransition) are
// intentionally NOT exported here. CDM v1.7 §4.NEW1-NEW4 already RATIFIED
// (P-034 2026-05-21) the canonical row shapes; the TypeScript interfaces
// land in PR 2/3 alongside the entity migrations (047 entities + 048
// view/MV) + the matching repository files under internal/repositories/.
