/**
 * AI Service module — public interface (scaffold at PR A).
 *
 * Per ADR-001: cross-module callers consume the AI Service module
 * ONLY through this file. At PR A the only exported surface is the
 * Fastify plugin (for app.ts wiring) + the branded ID types + the
 * canonical workload/autonomy enum re-exports (so downstream slices
 * holding typed AI references can compile without importing from
 * the `src/lib/audit.ts` internals).
 *
 * Full implementation lands in subsequent PRs:
 *   - PR B: Mode 1 chat stub endpoint with full audit envelope
 *   - PR C: Mode 2 case-prep stub endpoint with full audit envelope
 *   - PR D: real Anthropic provider integration (multi-provider per
 *     ADR-020)
 *   - PR E: guardrail-template repo + Conservative Default
 *     enforcement (AI-GUARD-001..005)
 *   - PR F: crisis-detection scaffold (FLOOR-009 / I-019
 *     platform-floor; runs independent of guardrail templates per
 *     FLOOR-013)
 *
 * Spec references:
 *   - ADR-001 (modular monolith — public-interface-only cross-module
 *     access)
 *   - AI Clinical Assistant Slice PRD v1.0
 *   - AI_LAYERING v5.2 §2 (two-mode AI-ARCH-001/002)
 *   - AI_LAYERING v5.2 §3 (guardrail template governance
 *     AI-GUARD-001..005)
 *   - AI_LAYERING v5.2 §4 (immutable AI boundaries FLOOR-007..FLOOR-013)
 *   - AI_LAYERING v5.2 §6 (FLOOR-020 audit envelope)
 *   - AI_LAYERING v5.2 §7 (AI-RESIL-001/002 resilience)
 *   - AI_LAYERING v5.2 §9 (tenant scoping per ADR-023)
 *   - AI_LAYERING v5.2 §10 (workload taxonomy expansion per ADR-029)
 *   - ADR-002 (binary AI mode; preserved at v1.0 for current
 *     workloads; ADR-029 prospective successor)
 *   - ADR-005 (protocolized autonomy; preserved at action_with_confirm
 *     for protocol_execution workloads)
 *   - ADR-020 (multi-provider LLM abstraction)
 *   - ADR-029 (AI workload taxonomy)
 *   - I-012 (clinician sign-off required for prescribing; AI cannot
 *     execute prescribing actions at v1.0 except via protocol-engine
 *     route bound by the reject-unless three-clause rule per Master
 *     PRD v1.10 §13.7)
 *   - I-019 (crisis detection cannot be configured away;
 *     platform-floor; runs across all AI surfaces)
 *   - I-023 / I-027 (tenant isolation; tenant_id on every audit)
 */

// Branded ID types — safe to ship at PR A because they are identifier
// hygiene, not schema. Downstream slices that hold typed references
// (e.g., an audit emitter that captures AIChatSessionId or
// AIWorkflowExecutionId) can compile clean against these before the
// row shapes land in PR D+.
export type {
  AIChatSessionId,
  AIWorkflowExecutionId,
  GuardrailTemplateId,
} from './internal/types.js';

// Mode 1 chat response wire contract — PR B type-only export. The
// handler is intentionally NOT mounted until PR F lands crisis
// detection (FLOOR-009 / I-019). Frontends integrate against this
// shape now so when PRs D/E/F merge, the 200-response wire shape is
// already a known contract.
export type { Mode1ChatResponseView } from './internal/types.js';

// Mode 2 case-prep response wire contract — PR C type-only export.
// Same gating posture as Mode 1: the route is NOT mounted until
// crisis detection (PR F), per-response audit (PR E/F), real
// provider (PR D), and the protocol-engine integration (which
// drives the I-012 reject-unless three-clause rule at the
// downstream prescribing boundary per State Machines v1.2 §19 §19.X)
// are all in place. Clinician-console integration imports the type
// now; the route comes online with PR F + the protocol engine slice.
export type { Mode2CasePrepResponseView } from './internal/types.js';

export {
  asAIChatSessionId,
  asAIWorkflowExecutionId,
  asGuardrailTemplateId,
} from './internal/types.js';

// Re-export the canonical workload + autonomy types from the audit
// envelope's source-of-truth declaration. AI Service emissions
// populate the same envelope fields per FLOOR-020; downstream slices
// importing from this module surface their AI-discriminator handling
// from a single boundary.
export type { AIWorkloadType, AutonomyLevel } from './internal/types.js';

// Fastify plugin for app.ts wiring. Currently exposes only `/health`
// (200) + `/ready` (503). Real handlers land in subsequent PRs.
export { aiServicePlugin } from './plugin.js';
