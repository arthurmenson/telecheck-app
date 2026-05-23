/**
 * Med Interaction Engine module — public interface (Sprint 1 / PR 1).
 *
 * Per ADR-001: cross-module callers consume the Med Interaction module
 * ONLY through this file. At Sprint 1 / PR 1 (this commit) the exported
 * surface is the Fastify plugin (for app.ts wiring) + branded ID types
 * (for downstream slices that hold typed references to interaction_signal_id
 * / interaction_override_id / interaction_ruleset_id without needing
 * full row shapes).
 *
 * **Status:** spec layer COMPLETE + RATIFIED (SI-019 v2.0 P-033 +
 * CDM v1.6 → v1.7 P-034 RATIFIED 2026-05-21). DB layer at PR 1 of ~6:
 * migration 046 ships the 12 net-new RBAC roles. Subsequent PRs add:
 *
 *   - PR 2: 4 entities (interaction_engine_evaluation +
 *     interaction_signal + interaction_signal_override +
 *     interaction_signal_lifecycle_transition) + RLS + per-table
 *     append-only triggers + composite tenant-scoped FKs
 *   - PR 3: 1 SECURITY BARRIER view + 1 optional MV + SECDEF access function
 *   - PR 4: raw lifecycle writer SECDEF + anti-bypass EXECUTE matrix
 *   - PR 5: 6 reason-specific lifecycle wrappers (emission + activation +
 *     supersession + resolution + expiry + override)
 *   - PR 6+: Fastify handler implementation (8 endpoints per SI-019 §5 +
 *     CDM §6 OpenAPI v0.3) + Cat A audit emission + LAYER B role-membership
 *     check + integration tests
 *
 * This skeleton-with-RBAC commit lands so the module directory + plugin
 * wiring + branded ID imports are stable as subsequent PRs land —
 * downstream slices (Pharmacy clinician-commit gate per I-002, Async
 * Consult, Mode 2 protocol agents) can typed-import these IDs ahead of
 * full handler implementation.
 *
 * Hard rule (per CLAUDE.md + I-002): the interaction engine runs BEFORE
 * the clinician commits a `medication_request`. Not after, not in
 * parallel. Platform-floor; binds at the Pharmacy + Async Consult
 * clinician-commit boundaries.
 *
 * Spec references:
 *   - Telecheck_Medication_Interaction_Engine_Slice_PRD_v2_0.md (P-033)
 *   - Telecheck_CDM_v1_6_to_v1_7_Amendment.md (P-034)
 *   - ADR-001 (modular monolith — public-interface-only cross-module access)
 *   - Master PRD v1.10 §7 (interaction engine as platform-floor)
 *   - ADR-029 (AI workload taxonomy — `clinical_decision_support`)
 *   - I-002 (interaction-before-commit platform-floor)
 *   - I-019 (platform-floor adjacency — crisis detection is sibling pattern)
 *   - src/modules/med-interaction/README.md
 *   - docs/med-interaction-implementation-plan.md
 */

// Branded ID types — identifier hygiene + cross-module type safety.
// Downstream slices (Pharmacy, Async Consult, Mode 2 protocol agents)
// hold typed references to these IDs. Row shapes themselves land in
// PR 2 when the 4 entities are created in the DB.
export type {
  InteractionSignalId,
  InteractionOverrideId,
  InteractionRulesetId,
} from './internal/types.js';

export {
  asInteractionSignalId,
  asInteractionOverrideId,
  asInteractionRulesetId,
} from './internal/types.js';

// Fastify plugin for app.ts wiring. Currently exposes only `/health` + `/ready`.
export { medInteractionPlugin } from './plugin.js';
