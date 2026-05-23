/**
 * med-interaction/internal/types.ts — branded ID types (Sprint 1 / PR 6 of 6).
 *
 * Spec layer COMPLETE + RATIFIED (SI-019 v2.0 P-033 + CDM v1.6 → v1.7
 * P-034 RATIFIED 2026-05-21). CDM v1.7 §4.NEW1-NEW4 expanded the 4
 * canonical entities (interaction_engine_evaluation +
 * interaction_signal + interaction_signal_override +
 * interaction_signal_lifecycle_transition). **DB layer COMPLETE through
 * migration 050** (PRs 1-5 merged; 21 Codex rounds total): all 4
 * entities + RLS + per-table append-only + monotonic-ordering triggers
 * (047) + SECURITY BARRIER view + optional MV + SECDEF access function
 * (048) + raw lifecycle writer SECDEF (049) + 6 reason-specific
 * wrappers (050; 3 operational + 3 fail-closed) are in place.
 *
 * Branded IDs continue to ship at PR 6 (this commit, the Fastify
 * scaffold-update PR) for cross-module type safety so downstream slices
 * (Pharmacy clinician-commit gate per I-002, Async Consult, Mode 2
 * protocol agents) can typed-import ahead of full row-shape interfaces.
 * Row-shape interfaces themselves still land alongside repository files
 * at PR 7+ when handler implementation begins; CDM v1.7 §4.NEW1-NEW4
 * already RATIFIED the canonical shapes so when interfaces land they
 * map 1:1 to the migration-047 DDL.
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

// Full row-shape interfaces (InteractionEngineEvaluation, InteractionSignal,
// InteractionSignalOverride, InteractionSignalLifecycleTransition) are
// intentionally NOT exported here. CDM v1.7 §4.NEW1-NEW4 already RATIFIED
// (P-034 2026-05-21) the canonical row shapes; the migrations 047-050 DB
// layer is COMPLETE. Those interfaces land alongside the write-path
// repository files (PR 8+) when the lifecycle-action handlers begin; PR 7
// adds only the read-model projection below.

// ---------------------------------------------------------------------------
// Read-model projection (PR 7) — current-state hot-path display.
//
// This is the OUTPUT shape of the SECDEF access function
// get_interaction_signal_current_state(p_signal_id) from migration 048,
// the canonical read path for HOT-PATH DISPLAY consumers per SI-019
// Sub-decision 9 (clinician dashboard / pharmacy portal / patient mobile
// summary / admin reporting). It is the non-authoritative current-state
// projection, NOT the full signal row — the transition table is the source
// of truth per I-035. STRICT-FRESHNESS enforcement/gating consumers MUST
// NOT use this read path; they query the transition table directly under
// advisory lock.
//
// Per the Option 2 carryforward documented in migration 048: `current_state`
// and `transition_reason` are TEXT at the DB layer (the canonical CDM enums
// interaction_signal_state_t / interaction_signal_transition_reason_t are
// not yet realized as DOMAIN types in the code repo), so they are typed as
// `string` here rather than narrowed enums — narrowing would be speculative
// ahead of the TYPES amendment cycle that formalizes them. There is no
// `tenant_id` field: the access function does not project it (tenant scope
// is enforced inside the SECDEF body via current_tenant_id()), and
// patient-facing surfaces must never receive the operating-tenant
// identifier (Master PRD §17 + Glossary v5.2 C3).
// ---------------------------------------------------------------------------

export interface InteractionSignalCurrentState {
  signal_id: string;
  current_state: string;
  /** Transition timestamp of the current-state row (MV `as_of`). */
  as_of: Date;
  transition_reason: string;
}
