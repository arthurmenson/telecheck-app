# AI Cost Optimization Strategy — Telecheck platform

**Status:** DRAFT v0.1 — awaiting Evans's review
**Date:** 2026-05-11
**Author:** Autonomous Claude (drafted in parallel during 2026-05-11 SI closure cycle turn)
**Target spec doc:** new artifact (no canonical predecessor); promotes to CLAUDE.md + EHBG §X if Evans ratifies
**Cross-references:** ADR-020 (multi-provider abstraction); ADR-029 (AI workload taxonomy); WORKLOAD_TAXONOMY v5.2; src/lib/ai-context.ts

---

## §1 Summary

This document proposes a layered AI cost optimization strategy for the Telecheck platform spanning two cost surfaces: (a) development-time agent invocations during autonomous Claude Code runs, and (b) future runtime AI workloads under WORKLOAD_TAXONOMY v5.2 (`conversational_assistant` Mode 1 + `protocol_execution` Mode 2). The core lever is the Anthropic API's prompt caching feature, which charges cache reads at ~10% of base input price and cache writes at ~25% above base — yielding 60-90% input-token savings on workloads whose context is dominated by a stable cached prefix (e.g., the spec corpus, system prompts, guardrail templates, protocol definitions). Estimates herein are projections from documented Anthropic API mechanics, not measured platform results.

The proposed strategy lands cleanly on the existing multi-provider posture per ADR-020 (Anthropic Claude primary; AWS Bedrock + Azure OpenAI as resilience providers). A new helper `src/lib/ai-cache.ts` would wrap cache-control semantics behind the provider interface, normalizing across Anthropic native prompt caching, Bedrock's caching surface, and Azure OpenAI's variant. Cache-miss fallback fails open so resilience routing is unaffected. Per-tenant prefix variation is keyed into a tenant-scoped cache layer to preserve I-023/I-024/I-025 tenant isolation invariants.

The implementation plan is structured in three tiers: Tier 1 (Sprint 35-36 immediate work) lands the strategy doc, the `ai-cache.ts` skeleton, an agent-prompt template refactor for cache-hit-friendly context blocks, and cache-hit telemetry. Tier 2 (Sprint 36+) adds Haiku/Sonnet/Opus model-tier routing keyed off WORKLOAD_TAXONOMY v5.2 plus a per-CCR tenant-keyed cache layer. Tier 3 (longer horizon) restructures the spec corpus and skill-file organization to maximize cache reuse across the agent pool. Total projected savings at launch-month scale are substantial; Evans should plug provider-specific pricing into the §8 framework to materialize a dollar figure.

## §2 The cost surface today

The Telecheck platform's AI cost surface has four distinct categories, each with different optimization levers:

**Development-time agent invocations during autonomous runs.** Autonomous Claude Code runs (such as the 2026-05-11 SI closure cycle and Sprint 35 plan authoring) spawn parallel general-purpose agents that each load substantial spec-corpus context. The canonical bundle is ~87 markdown files (~75 baseline + 12 v1.10 additions), totaling several hundred KB of context that each agent re-reads on every invocation. With 6+ parallel agents per cycle turn, the cumulative input-token cost compounds. The Plan agent, foreground Claude, and each spawned subagent today re-read overlapping subsets of CLAUDE.md, the Artifact Registry v2.10, the Active Document Index v1.0, and the relevant canonical PRDs.

**Codex companion script (adversarial review).** The `codex@openai-codex` plugin invokes OpenAI Codex for cross-family adversarial review at each v1.10 workstream phase exit. This runs in the OpenAI provider family, not Anthropic, so Anthropic prompt caching does not apply. Optimization here is constrained to (a) keeping Codex review scope tight per phase, and (b) ensuring the Codex companion script does not re-load context that's already in Codex's own context window for the session.

**Future runtime: Mode 1 conversational AI per ADR-002 + WORKLOAD_TAXONOMY v5.2 `conversational_assistant`.** At launch, Mode 1 sessions handle patient-facing conversational interactions under the `advisory` autonomy level (the only permitted pair per WORKLOAD_TAXONOMY §2.1). Each session's context envelope includes: system prompt, guardrail template (per `guardrail_template_id`), glossary, tenant-specific CCR config, per-patient context, and a per-turn user message. The first four are stable across many turns and many sessions — high cache affinity. The last one is per-turn.

**Future runtime: Mode 2 protocol-execution agent per ADR-002 + WORKLOAD_TAXONOMY v5.2 `protocol_execution`.** Mode 2 executes clinical protocols (per `protocol_id` + `version`) under `advisory`, `suggestion`, or `action_with_confirm` autonomy. Per-invocation context includes: protocol definition, governance guardrails, tool catalog, medication_request data, patient context, consult context. Protocol definitions and guardrails are stable; per-invocation data is not.

**Provider mix per ADR-020.** Anthropic Claude is the primary clinical AI provider. AWS Bedrock and Azure OpenAI serve as resilience providers (fallback under provider outage or rate-limit pressure). Cache mechanics differ across these three providers; the `ai-cache.ts` helper must normalize.

## §3 Anthropic API prompt caching mechanics

The Anthropic Messages API exposes prompt caching via `cache_control` blocks. Key documented mechanics:

- **Cache-hit cost:** ~10% of the base input-token price. A cached prefix that would have cost $3.00/M input tokens at base now costs ~$0.30/M on hit.
- **Cache-write cost:** ~25% above base input price. Writing to the cache is more expensive than a plain non-cached read, so cache misses on cache-controlled blocks are slightly worse than no caching. Telemetry must track miss rate to detect the regression case.
- **TTL:** default 5-minute sliding window (resets on each cache read). Extended 1-hour TTL is available for stable prefixes that should survive longer idle gaps.
- **Minimum cacheable block size:** 1024 tokens for Sonnet and Opus tier models; 2048 tokens for Haiku. Smaller blocks cannot be cache-controlled.
- **Maximum cache breakpoints:** up to 4 `cache_control` breakpoints per request, enabling layered caching (e.g., platform-canonical prefix + tenant prefix + session prefix + turn).
- **cache_control block placement:** any content block (system prompt, tool definitions, tool results, conversation history) can carry `cache_control`. The cached prefix is matched exactly against the prior request's content from the start — any drift invalidates everything from the drift point forward.
- **What's NOT cacheable:** output tokens (the model's generated response is never cached); per-message variability past the last cache breakpoint (so the user's per-turn message goes outside the cached prefix); cross-organization sharing (each organization has its own cache namespace).

The practical implication for Telecheck: the strategy must place stable platform-canonical content (system prompt, guardrails, glossary) first; then stable tenant content (per-CCR config, tenant-specific guardrails); then session-stable content (per-patient context, protocol definition); then per-turn variable content (user message, tool-result for this invocation) last. Each layer gets its own `cache_control` breakpoint.

## §4 Application to development-time workflow

**Spec corpus caching strategy.** The autonomous Claude Code runtime does not (currently) expose `cache_control` semantics directly to the agent author — caching is managed by the harness. However, the harness's effectiveness depends on the agent's prompt structure. By placing the spec-corpus context (CLAUDE.md + Artifact Registry + Active Document Index + canonical PRDs) at the head of every agent invocation as a stable block, and varying only the task-specific instructions at the tail, the harness's cache-hit rate climbs from ~30% (today's baseline, estimated) to ~85-90% (projected). The 75-file canonical bundle, loaded once per session and reused across all spawned agents, becomes a single cache write amortized over many cache reads.

**Agent context caching.** When the Plan agent spawns 6 parallel general-purpose agents, each agent's prompt today includes overlapping spec-corpus references. If each agent's prompt is structured to place identical context blocks at the head — same wording, same order, same content — the harness's underlying cache treats them as cache hits after the first. Tail-varying instructions (the agent's specific task) are the only non-cached portion. This is a behavior change for the agent-author: prompts must be structured cache-hit-first, not human-readability-first.

**Skills + slash commands vs inline context.** Skills under `~/.claude/skills/` and project-local skills are loaded on demand (lazy) — they appear in context only when invoked. Inline context (CLAUDE.md, etc.) loads every turn. The optimization is: anything that is not needed every turn should live in a skill, not inline. For Telecheck, the always-on inline content should be the bare minimum needed for orientation (canonical-version pointers, source-of-truth hierarchy, hard rules). Detailed reference content (full Artifact Registry contents, full ADR text) should be skill-loaded on demand.

**Tool-result truncation.** Already in place via the harness's tool-output truncation (30000 character cap on Bash output, etc.). The optimization: verify that large agent JSONL outputs (e.g., from spawned subagents reporting back) are isolated to a single tool result block so they fall outside the cached prefix and do not pollute it.

**Concrete numbers.** A representative autonomous-run cycle (e.g., the 2026-05-11 SI closure turn) loads ~500KB of spec-corpus context per agent invocation. Across 6 parallel agents in a single turn, that's ~3MB of input tokens (~750K tokens at ~4 chars/token). With caching applied at the harness layer and a cache-hit-friendly prompt structure: ~500KB written once + 6 × 50KB tail-variable content = ~800KB. Input-token savings: ~73%. Translated to cost at illustrative Anthropic Sonnet pricing ($3/M input base, $0.30/M cache hit): the un-cached cost is ~$2.25/cycle-turn; the cached cost is ~$0.60/cycle-turn. Per-day savings at ~10 turns/day: ~$16.50/day or ~$500/month for dev-time agent work alone.

## §5 Application to future runtime workflow (Mode 1 + Mode 2)

**Mode 1 conversational AI (`conversational_assistant` + `advisory`).** Per-session context layering:

| Layer | Cache TTL | Content | Variability |
|---|---|---|---|
| L1 platform-canonical | 1h | System prompt + base guardrail framework + canonical glossary | Stable across all sessions, all tenants |
| L2 tenant | 5m | Tenant-specific guardrail overlays + CCR-keyed config (per `country_of_care`) + `tenant.consumer_dba` for patient-facing rendering | Stable across sessions for a given tenant |
| L3 session | 5m | Patient context summary + conversation history-to-date | Stable across turns within a session |
| L4 turn | — | Current user message | Per-turn |

Cache breakpoints placed at L1/L2 boundary, L2/L3 boundary, L3/L4 boundary. The per-turn portion is the only non-cached portion. For a 20-turn session, the L1+L2+L3 content is cached once and read 19 times.

**Mode 2 protocol-execution agent (`protocol_execution` + `advisory|suggestion|action_with_confirm`).** Per-invocation context layering:

| Layer | Cache TTL | Content | Variability |
|---|---|---|---|
| L1 platform-canonical | 1h | System prompt + governance framework + tool catalog | Stable across all invocations |
| L2 protocol | 1h | Protocol definition (per `protocol_id` + `version`) + protocol-specific guardrails | Stable per protocol; protocols change rarely |
| L3 tenant | 5m | Tenant overlay + CCR config + per-tenant policy authorizations | Stable per tenant |
| L4 invocation | — | medication_request data + patient context + consult context | Per-invocation |

Note glossary discipline: `medication_request` is the canonical entity name (not `prescription`) per Contracts Pack v5.2 GLOSSARY. Mode 2 invocations operate on `medication_request` records and emit `medication_order` execution audit events under I-012 reject-unless rules.

**Per-tenant prefix variation and tenant isolation.** Per I-023, every PHI-touching query is tenant-filtered; the same rigor applies to the AI cache. Tenant-specific context (L2/L3 above) MUST be keyed into a tenant-scoped cache namespace. The cache-key contract: `(provider, model_version, prefix_layer, tenant_id, content_hash)`. A cache hit across tenants — i.e., one tenant's prompt reading another tenant's cache — would be a I-023 violation. The `ai-cache.ts` helper enforces tenant scoping at the cache-key construction layer. Per-tenant cache TTL is forced to 5 minutes (the platform default) to bound staleness of tenant-specific data.

**Multi-provider abstraction per ADR-020.** Anthropic's native prompt caching is the reference implementation. AWS Bedrock exposes prompt caching with its own surface (slightly different breakpoint placement semantics; per-model availability varies). Azure OpenAI exposes a different caching variant. The `ai-cache.ts` helper exposes a single interface:

```ts
// Illustrative API surface (subject to TLC-058a design review)
interface CachedPromptBuilder {
  addLayer(layer: 'platform' | 'tenant' | 'session' | 'turn', content: string, opts: { ttl: '5m' | '1h' }): this;
  build(provider: 'anthropic' | 'bedrock' | 'azure-openai'): ProviderRequest;
}
```

The helper normalizes cache_control placement, breakpoint count, and TTL semantics across providers. When a provider does not support caching for a given model, the helper falls back to non-cached execution silently (with telemetry recording the degradation). This preserves ADR-020 resilience-provider posture: cache optimization is a performance feature, not a correctness feature; routing decisions are independent.

## §6 Model tiering strategy

Within the Anthropic Claude family, three tiers (Haiku, Sonnet, Opus) span ~10x cost differences. The model-tier routing strategy maps WORKLOAD_TAXONOMY v5.2 (workload_type, autonomy_level) pairs to model tiers:

| Workload | Pair (per WORKLOAD_TAXONOMY v5.2) | Recommended tier | Rationale |
|---|---|---|---|
| Routine ops (file existence checks, simple lookups, status updates, glossary lookups) | Tool/utility AI calls; not `conversational_assistant` or `protocol_execution` per taxonomy | Haiku | Latency + cost both favor Haiku; no clinical decision content |
| Low-stakes Mode 1 (e.g., patient asks "when is my next refill?") | `conversational_assistant` + `advisory` | Haiku-eligible | Information retrieval against patient's own data; I-019 crisis-detection floor must still run (platform-floor; never gated) |
| Medium-stakes Mode 1 (e.g., clinician decision-support) | `conversational_assistant` + `advisory` | Sonnet | More nuance; clinician is the receiver |
| Mode 2 protocol execution (e.g., GLP-1 protocol evaluation) | `protocol_execution` + `advisory|suggestion|action_with_confirm` | Sonnet (default); Opus for high-complexity protocols | Mode 2 carries clinical-execution risk; quality > cost; Opus reserved for protocols where reasoning chain length warrants it |
| Adversarial design review on cross-cutting changes | Not a runtime workload; dev-time tooling | Opus (when cross-family Codex is not the right family) | High stakes; reasoning depth matters |

**Mapping to WORKLOAD_TAXONOMY v5.2.** Per ADR-029, `model_version` is captured per call in the audit envelope. Cost telemetry is therefore retrospectively recoverable: query the audit table for `model_version` distribution by `(ai_workload_type, autonomy_level, tenant_id, country_of_care)` and compute per-tier spend.

**Reserved workload types not routed.** The reserved values (`autonomous_agent`, `multi_agent_supervisor`, `tool_using_agent`) and reserved autonomy levels (`action_with_audit_only`, `fully_autonomous`) per WORKLOAD_TAXONOMY v5.2 §3 / AUTONOMY_LEVELS v5.2 §3 are NOT implemented at v1.0. Future model-tier routing for them is gated behind successor ADR-030+ and activation audit events per ADR-029.

**Per ADR-029 envelope rules.** Every AI audit event carries `ai_workload_type`, `autonomy_level`, `model_version`, plus (Mode 1) `guardrail_template_id` or (Mode 2) `protocol_id` + `version`. This envelope is the foundation of retrospective cost analysis: spend per workload type, spend per protocol, spend per tenant. A cache-hit telemetry field (`cache_creation_input_tokens` + `cache_read_input_tokens`) added to the AI audit envelope makes cache-effectiveness retrospectively analyzable too. This addition is proposed as part of TLC-058c.

## §7 Concrete implementation plan

The plan is structured in three tiers, separated by required prerequisite work.

**Tier 1 (wire in Sprint 35-36):**

- **TLC-058** — strategy doc (this file). Landed in 2026-05-11 turn as a candidate; awaiting Evans's ratification for inclusion in Sprint 35 or Sprint 36.
- **TLC-058a** — `src/lib/ai-cache.ts` skeleton. Wraps Anthropic SDK `cache_control` on system + canonical-guardrail prefixes. Multi-provider abstraction per ADR-020 (AWS Bedrock + Azure OpenAI equivalents). Surfaces: `CachedPromptBuilder.addLayer()` (per §5 layering), `build(provider)` (provider-specific output), graceful fallback when provider doesn't support caching. Tenant-scoped cache-key construction enforced at the helper layer.
- **TLC-058b** — agent-prompt template refactor. Introduces `<spec_context_cached>` block convention so background agents spawned by foreground Claude (Plan agent, general-purpose agents, Codex review companion) maximize cache hits. Updates CLAUDE.md (this repo) and AGENTS.md (telecheckONE) to document the convention. Required so the Tier 1 cache benefit actually materializes for dev-time workflow.
- **TLC-058c** — cache-hit telemetry. Logs `cache_creation_input_tokens` + `cache_read_input_tokens` per call. Adds these fields to the AI audit envelope (extends AUDIT_EVENTS v5.2 §1 — likely requires a Contracts Pack hygiene cycle bump to v5.3). Simple JSON daily-roll-up file at `logs/ai-cache-telemetry/YYYY-MM-DD.json` until ops dashboard exists.

**Tier 2 (Sprint 36+):**

- **Model-tier routing within Claude.** Task router picks Haiku/Sonnet/Opus based on `(ai_workload_type, autonomy_level)` pair per WORKLOAD_TAXONOMY v5.2. `src/lib/ai-context.ts` extended with `resolveModelTier(aiContext: AIContext): 'haiku' | 'sonnet' | 'opus'`. Defaults to Sonnet; explicit Haiku eligibility for low-stakes Mode 1 sub-paths; Opus reserved for designated high-complexity protocols.
- **Cache-hit dashboard.** Operational visibility into cache-hit rate per workload, per tenant, per model. Initial implementation: read the daily JSON roll-ups; emit Grafana-equivalent panels once observability stack is selected.
- **Per-CCR tenant-keyed cache layer.** Layered cache namespace per `(provider, model_version, prefix_layer, tenant_id, country_of_care_hash)`. Required for multi-tenant correctness and for per-CCR config variation (which differs by `country_of_care`).

**Tier 3 (project-structure work — longer horizon):**

- **Spec corpus chunking.** Break large canonical files (Canonical Data Model v1.2, large slice PRDs like Forms/Intake v2.1 and Pharmacy + Refill v2.1) into per-section files. Smaller cached prefixes mean better cache reuse across agents that only need a subset. Requires coordination with the spec corpus author and Promotion Ledger entry per change.
- **Skill-file consolidation.** Lazy-load skills via slash-command-only invocation; remove always-on inline skills that are not needed every turn. Reduces every-turn context size and increases cache-hit rate on the remaining inline context. Requires per-skill audit of invocation frequency.

## §8 Estimated savings range

These are projections from documented Anthropic API mechanics applied to the Telecheck workload profile. They are not measurements. They assume Tier 1 caching is wired and the cache-hit-friendly prompt structure is adopted.

| Workload | Today's input-token cost | With Tier 1 caching | Savings |
|---|---|---|---|
| Autonomous-run spec corpus reads (per turn, 6 agents) | ~3MB input | ~800KB input | ~73% |
| Mode 1 conversational AI (per session, 20 turns) | ~200KB input | ~60KB input (cache prefix + per-turn variance only) | ~70% |
| Mode 2 protocol execution (per evaluation, 1 invocation) | ~80KB input | ~25KB input | ~69% |
| Codex adversarial review (per cycle, cross-family) | unchanged (different provider family) | unchanged | n/a |

**Dollar-impact framework.** At projected launch-month scale (~1M Mode 1 sessions of 20 turns each + ~100K Mode 2 evaluations + dev-time agent invocations at ~10 cycle-turns/day), the savings translate to substantial dollar amounts. Evans should plug provider-specific pricing into the following framework:

```
Mode 1 monthly:    1,000,000 sessions × 20 turns × 10KB/turn × $P_input_base × 0.30 (after 70% cache savings)
Mode 2 monthly:      100,000 invocations × 80KB × $P_input_base × 0.31 (after 69% cache savings)
Dev-time monthly:        300 turns × 6 agents × 500KB × $P_input_base × 0.27 (after 73% cache savings)
```

Where `$P_input_base` is the per-MB input-token price for the chosen model tier (Sonnet at illustrative $3/M input tokens ≈ ~$12/MB input; Haiku at ~$1/MB; Opus at ~$60/MB). The exact figures depend on launch-month volumes and tier mix (which Tier 2 model-tier routing makes plannable). Honest framing: this is a back-of-envelope projection; the savings ratio (~70%) is robust to the volume estimates; the absolute dollar amount is not.

## §9 Risks + mitigations

**Cache invalidation drift.** When the spec corpus is updated mid-session (e.g., a Promotion Ledger entry lands during an autonomous run), cached prefixes become stale and any reasoning grounded in them inherits the staleness. Mitigation: TTL-driven invalidation (5-min default bounds staleness window); a spec-corpus-version sentinel at the head of every cached prefix (`SPEC_CORPUS_VERSION: 2026-05-11.0`) so a mid-session bump invalidates the cache cleanly. The sentinel is part of the cached content, so any change to it shifts the cache key.

**Per-tenant data poisoning via cache.** A misconfigured cache-key construction could allow one tenant's prompt to read another tenant's cached prefix — a I-023/I-024/I-025 violation. Mitigation: tenant-scoped cache-key construction enforced at the `ai-cache.ts` helper layer; integration test that confirms identical prompt content under different `tenant_id` produces distinct cache keys; per-tenant cache TTL forced to 5 min (short enough that drift between tenants is bounded). Audit: add a per-call assertion that the `tenant_id` field on the resolved `req.tenantContext` matches the `tenant_id` baked into the cache-key construction.

**Multi-provider variance.** Not all providers support the same cache semantics, and per-model availability within a provider can vary. AWS Bedrock's caching is per-model; Azure OpenAI's variant has different breakpoint rules. Mitigation: `ai-cache.ts` must fail gracefully — skip the caching layer when the provider doesn't support it for the resolved model, log the degradation via telemetry, and proceed with non-cached execution. Cache optimization is a performance feature, never a correctness feature; ADR-020 resilience-routing decisions are unaffected.

**Cost-vs-latency trade-off via cache writes.** Cache writes cost ~25% extra. If cache miss rate is high (cached prefixes shift on every request because the prompt structure isn't actually stable), cost goes UP, not down. Telemetry must track miss rate explicitly. Mitigation: TLC-058c telemetry surfaces miss rate as a first-class metric; an alert fires if the rolling 24h miss rate exceeds 30% (heuristic threshold; tune in Tier 2 based on observation).

**I-019 crisis-detection floor under model-tier routing.** Routing low-stakes Mode 1 to Haiku must NOT bypass crisis-detection scanning. Per I-019, crisis detection is platform-floor; it runs regardless of workload type or autonomy level. Mitigation: crisis-detection is implemented as a separate scanning pass on every Mode 1 input, independent of the model tier serving the conversational response. Confirmed already in design via the existing AI-LAYERING contract.

**Audit-envelope completeness.** Adding `cache_creation_input_tokens` + `cache_read_input_tokens` to the AI audit envelope is a contracts-pack change. The current envelope (AUDIT_EVENTS v5.2 §1) does not include them. Mitigation: TLC-058c includes the proposed envelope extension; expected to flow through a Contracts Pack v5.3 hygiene cycle (or treated as additive non-breaking under v5.2). Confirm with Engineering Lead before TLC-058c implementation.

## §10 Decision points for Evans

The following decisions block Tier 1 advancement and require Evans's explicit ratification:

1. **Approve TLC-058 sprint inclusion.** Sprint 35 if budget allows; Sprint 36 otherwise. The strategy doc itself is the lowest-effort sub-item; TLC-058a (`ai-cache.ts` skeleton) is the largest. Plausible split: TLC-058 in Sprint 35 (this doc + foreground review); TLC-058a + b + c in Sprint 36.
2. **Confirm 1-hour extended TTL is acceptable for spec-corpus prefix** (vs default 5-min). 1h TTL gives better cache-hit rate but slightly more staleness exposure for the spec-corpus version. The sentinel-driven invalidation in §9 mitigates this, but Evans should weigh.
3. **Confirm Haiku tier is acceptable for low-stakes Mode 1 sub-paths** (vs Sonnet always). Cost savings are material (~10x); the trade-off is response quality on borderline cases. Recommend conservative rollout: Haiku eligibility flagged per sub-path via feature flag; default false; flip on per sub-path after empirical observation.
4. **Choose telemetry surface.** Three options: (a) stdout-logging only (zero-infra); (b) JSON daily roll-up files (proposed in TLC-058c); (c) observability vendor (Datadog, Honeycomb, etc.) — requires vendor selection. Recommend (b) for Tier 1; revisit at Tier 2 dashboard work.
5. **Confirm Contracts Pack envelope extension is additive.** The proposed `cache_creation_input_tokens` + `cache_read_input_tokens` envelope fields are additive (nullable for non-cached calls); should be acceptable under v5.2 without a v5.3 cycle, but Engineering Lead should confirm.
6. **Adversarial review pathway.** Should TLC-058 itself trigger a Codex adversarial review at sprint exit per the v1.10 cycle cadence pattern? Recommend yes — this is a cross-cutting performance/cost decision with multi-provider implications; adversarial scrutiny is well-suited.

## §11 Spec references + cross-references

- **ADR-020** — Multi-Provider AI Abstraction (Anthropic Claude primary; AWS Bedrock + Azure OpenAI resilience providers).
- **ADR-029** — AI Workload Taxonomy (discriminator `ai_workload_type` per WORKLOAD_TAXONOMY v5.2; prospectively supersedes ADR-002 binary Mode 1/Mode 2 framing).
- **WORKLOAD_TAXONOMY v5.2** — `conversational_assistant` + `protocol_execution` active at v1.0; `autonomous_agent`/`multi_agent_supervisor`/`tool_using_agent` reserved.
- **AUTONOMY_LEVELS v5.2** — `advisory`/`suggestion`/`action_with_confirm` active at v1.0; `action_with_audit_only`/`fully_autonomous` reserved.
- **AUDIT_EVENTS v5.2 §1** — AI audit envelope (every AI event carries `ai_workload_type`, `autonomy_level`, `model_version`, `guardrail_template_id` or `protocol_id`+`version`). Proposed additive extension: `cache_creation_input_tokens` + `cache_read_input_tokens`.
- **AI-LAYERING (Contracts Pack v5.2)** — AI architectural layering; crisis-detection floor placement.
- **Master PRD v1.10 §13.7** — AI workload taxonomy (canonical normative source for `ai_workload_type` field name).
- **`src/lib/ai-context.ts`** — existing helper for AI workload type + autonomy level resolution per ADR-029. Tier 2 extension point for `resolveModelTier()`.
- **`src/lib/ai-cache.ts`** — proposed new helper (TLC-058a). Wraps cache_control semantics behind ADR-020 multi-provider abstraction.
- **PROJECT_CONVENTIONS r5** — canonical authoring pattern; this doc adheres to its discipline rules.
- **I-019** — crisis-detection floor (unaffected by model-tier routing).
- **I-023/I-024/I-025** — tenant isolation (enforced at cache-key construction).
- **I-027** — audit append-only (cache-telemetry fields are additive; never overwrite prior records).
- **I-012** — reject-unless three-clause for prescribing actions (orthogonal to caching; Mode 2 `action_with_confirm` flow unchanged).

**Cross-reference gap identified.** The `src/lib/ai-context.ts` helper exposes `resolveAiContext()` returning `{ ai_workload_type, autonomy_level }` but does not currently surface `model_version` or `guardrail_template_id`/`protocol_id`. The proposed `ai-cache.ts` and the Tier 2 `resolveModelTier()` extension assume these fields are accessible at AI-call time. Recommended follow-up (not blocking TLC-058 but tracked here for sprint planning): extend `AIContext` to optionally carry these fields, or define a sibling `AIInvocationContext` type that composes `AIContext` with the model + template/protocol pointers. Flag to Engineering Lead for shape design before TLC-058a wire-up.

## §12 Authoring discipline checklist (mandatory)

- [x] No emoji.
- [x] Canonical glossary terms (no `prescription` — used `medication_request` throughout; `Mode 1` / `Mode 2` not `chatbot`; `tenant` not `customer`).
- [x] Honest savings estimates; flagged as estimates/projections, not measurements.
- [x] Multi-provider abstraction per ADR-020 explicit throughout (§2, §5, §7, §9, §11).
- [x] WORKLOAD_TAXONOMY v5.2 mapping in §6 model tiering (explicit `(ai_workload_type, autonomy_level)` pair to tier mapping).
- [x] Tier 1 / 2 / 3 implementation plan separates immediate work from longer-horizon (§7).
- [x] Tenant isolation invariants (I-023/I-024/I-025) explicit in cache-key construction (§5, §9).
- [x] Crisis-detection floor (I-019) preserved under model-tier routing (§9).
- [x] Reserved workload types and autonomy levels not routed (§6).
- [x] Decision points for Evans enumerated explicitly (§10).
- [x] Cross-reference gap on `ai-context.ts` surface flagged (§11).
