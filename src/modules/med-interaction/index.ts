/**
 * Med Interaction Engine module — public interface (skeleton).
 *
 * Per ADR-001: cross-module callers consume the Med Interaction module
 * ONLY through this file. At v0.1 the only exported surface is the
 * Fastify plugin (for app.ts wiring) and branded ID types (for
 * downstream slices that hold typed references to interaction_signal_id /
 * interaction_override_id / interaction_ruleset_id without needing
 * full row shapes).
 *
 * Schema authoring (the real `InteractionSignal`, `InteractionOverride`,
 * `InteractionRuleset` row interfaces + repos + signal-evaluator service
 * + adapter abstraction + HTTP handlers) is BLOCKED on Med Interaction
 * Engine slice PRD ratification. This skeleton exists so the module
 * directory + plugin wiring + branded ID imports are stable now —
 * downstream slices (Pharmacy, Async Consult, Mode 2 protocol agents)
 * can typed-import these IDs ahead of full implementation.
 *
 * Hard rule (per CLAUDE.md): the interaction engine runs BEFORE the
 * clinician commits a prescription. Not after, not in parallel. This
 * is platform-floor and binds independent of slice PRD ratification.
 *
 * Spec references:
 *   - ADR-001 (modular monolith — public-interface-only cross-module access)
 *   - Master PRD v1.10 §7 (interaction engine as platform-floor)
 *   - ADR-029 (AI workload taxonomy — `clinical_decision_support`)
 *   - I-019 (platform-floor adjacency — crisis detection is sibling pattern)
 *   - CDM v1.2 (entity inventory — Med Interaction entities pending slice PRD)
 */

// Branded ID types — safe to ship at v0.1 because they are identifier
// hygiene, not schema. Downstream slices (Pharmacy, Async Consult,
// etc.) that hold typed references to these IDs can compile clean
// before the slice PRD ratifies row shapes.
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
