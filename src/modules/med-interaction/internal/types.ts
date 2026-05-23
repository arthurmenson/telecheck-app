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

// Row-shape interfaces (InteractionEngineEvaluation, InteractionSignal,
// InteractionSignalOverride, InteractionSignalLifecycleTransition) are
// intentionally NOT exported here. CDM v1.7 §4.NEW1-NEW4 already RATIFIED
// (P-034 2026-05-21) the canonical row shapes; the migrations 047-050 DB
// layer is COMPLETE. The TypeScript interfaces themselves land alongside
// the matching repository files under internal/repositories/ as each
// write handler in PR 8+ requires them (deferring row-shape authoring keeps
// PR 7's surface narrow to what the first read handler actually needs).

// ---------------------------------------------------------------------------
// PR 7 view shape — public response of GET /v0/med-interaction/signals/:id.
//
// Mirrors the SECDEF access function's RETURNS TABLE clause (migration
// 048 §3 + CDM v1.7 §4.NEW5):
//   - signal_id          VARCHAR(26) — the ULID
//   - current_state      TEXT        — interaction_signal_state_t once
//                                      the DOMAIN lands (Option 2
//                                      carryforward; documented in 048)
//   - as_of              TIMESTAMPTZ — serialized as ISO-8601 string on
//                                      the wire (Fastify default Date
//                                      serializer)
//   - transition_reason  TEXT        — interaction_signal_transition_
//                                      reason_t (DOMAIN deferred per
//                                      Option 2 same as current_state)
//
// Field names + types are snake_case + JSON-friendly per OpenAPI v0.3
// conventions for the `/v1/med-interaction/signals/{id}` endpoint
// (registered under the code-repo's `/v0/` prefix at v0.1 per the
// platform-wide path-prefix policy; the prefix bumps to /v1 with the
// platform-wide cutover and the response shape is unchanged).
// ---------------------------------------------------------------------------
export interface InteractionSignalCurrentStateView {
  /** ULID — 26-char Crockford base32; the interaction_signal_id. */
  signal_id: string;
  /**
   * Current state of the signal, DERIVED from
   * `interaction_signal_lifecycle_transition` per I-035 Option A.
   * Realized as TEXT until the `interaction_signal_state_t` DOMAIN lands
   * in a future TYPES amendment (Option 2 carryforward).
   */
  current_state: string;
  /** Last-transition timestamp serialized as ISO-8601 (UTC). */
  as_of: string;
  /**
   * Reason for the most recent transition that produced `current_state`.
   * Realized as TEXT until the `interaction_signal_transition_reason_t`
   * DOMAIN lands (Option 2 carryforward, same as `current_state`).
   */
  transition_reason: string;
}
