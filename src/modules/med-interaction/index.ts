/**
 * Med Interaction Engine module — public interface (Sprint 1 / PR 6 of 6).
 *
 * Per ADR-001: cross-module callers consume the Med Interaction module
 * ONLY through this file. At Sprint 1 / PR 6 of 6 (this commit — the
 * final DB-layer scaffold-update PR) the exported surface is still the
 * Fastify plugin (for app.ts wiring) + branded ID types (for downstream
 * slices that hold typed references to interaction_signal_id /
 * interaction_override_id / interaction_ruleset_id without needing
 * full row shapes). Row-shape interfaces + repository helpers land
 * alongside the handler PRs (PR 7+).
 *
 * **Status:** spec layer COMPLETE + RATIFIED (SI-019 v2.0 P-033 +
 * CDM v1.6 → v1.7 P-034 RATIFIED 2026-05-21). **DB layer COMPLETE
 * through migration 050** (PRs 1-5 merged; 21 Codex rounds total):
 *
 *   - PR 1 (migration 046, 5 rounds): 12 net-new RBAC roles —
 *     4 application + 6 wrapper-owner + 2 service-level-owner. NOLOGIN
 *     + non-BYPASSRLS. No grants at this PR; grants land alongside the
 *     functions/wrappers they protect.
 *   - PR 2 (migration 047, 7 rounds): 4 entities — interaction_engine_evaluation
 *     + interaction_signal (state DERIVED per I-035 Option A; NO state
 *     column) + interaction_signal_override (8-col KMS envelope) +
 *     interaction_signal_lifecycle_transition. RLS + per-table append-
 *     only triggers + server-assigned monotonic-ordering trigger
 *     (clock_timestamp() + auto-bump) with state-continuity check +
 *     caller-tenant guard.
 *   - PR 3 (migration 048, 5 rounds): 1 SECURITY BARRIER view + 1
 *     optional MV + SECDEF access function with MV access-discipline
 *     (preflight + immediate REVOKE PUBLIC + aclexplode loop + final
 *     verifier; no BEGIN/COMMIT per transactional-runner safety).
 *   - PR 4 (migration 049, 3 rounds): raw lifecycle writer SECDEF +
 *     anti-bypass EXECUTE matrix (6 wrapper-owners) + STEP 3.5
 *     advisory-locked activation-override-evidence check.
 *   - PR 5 (migration 050, 3 rounds): 6 reason-specific lifecycle
 *     wrappers — 3 operational (emission + activation + supersession)
 *     + 3 fail-closed (resolution + expiry + override; RAISE EXCEPTION
 *     SQLSTATE 0A000 pending evidence-source migrations from Async
 *     Consult / Pharmacy / LAYER B).
 *   - PR 6 (this commit): Fastify module scaffold update — README +
 *     routes.ts /health blocker payload + /ready reason + plugin /
 *     index / internal-types header doc-blocks + integration-test
 *     assertions updated to reflect DB layer COMPLETE through migration
 *     050. No DB or HTTP-handler delta; pure docs/test alignment closing
 *     the DB-layer series.
 *   - PR 7+: Fastify handler implementation (8 endpoints per SI-019 §5
 *     + CDM §6 OpenAPI v0.3) + Cat A audit emission + LAYER B role-
 *     membership check + integration tests for tenant isolation + I-002
 *     ordering invariant.
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
