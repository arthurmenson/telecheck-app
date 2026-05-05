# Med Interaction Engine module — BLOCKED ON Med Interaction Engine slice PRD ratification

## Status (v0.1 skeleton)

This module is a **directory skeleton** authored at Sprint 3 (TLC-007). The interaction-checking surface (POST /signals/check, override workflow, ruleset resolver, adapter abstraction to vendor interaction databases) is **BLOCKED** until the Med Interaction Engine slice PRD is ratified.

## What ships at v0.1

- Module directory boundary (per ADR-001 modular monolith)
- Fastify plugin shell registering `/v0/med-interaction`
- Liveness probe (`GET /health` → 200) with informational `blocked` metadata
- Readiness probe (`GET /ready` → 503) — Kubernetes/LB will keep traffic off the module
- Branded ID types (`InteractionSignalId`, `InteractionOverrideId`, `InteractionRulesetId`) — identifier hygiene only, not schema
- Plugin smoke test (`tests/integration/med-interaction-plugin-wiring.test.ts`)

## What does NOT ship at v0.1

- Row-shape interfaces for InteractionSignal / InteractionOverride / InteractionRuleset
- Repository files
- Service files (signal evaluator, override workflow)
- Real HTTP handlers (POST /signals/check, etc.)
- Vendor adapter abstraction (interaction databases like First Databank, Lexicomp)
- Database migrations
- Audit / domain event emitters

## Why this is intentionally a skeleton

Per EHBG §7, engineering does not author canonical schema; the slice PRD owns it. The CDM v1.2 entity inventory does not yet expand Med Interaction signal/override/ruleset row shapes — authoring schemas now would silently fork the spec corpus (per the "do NOT silently fork" hard rule in CLAUDE.md).

The skeleton lands now so that:

1. **Module boundary is established** under ADR-001 — the public-interface surface is fixed, even if it's mostly types
2. **App-level wiring is stable** — `src/app.ts` registers `medInteractionPlugin` once; plugin internals can evolve without re-touching `app.ts`
3. **Downstream slices can typed-import branded IDs** — Pharmacy + Refill (TLC-010+), Async Consult, and Mode 2 protocol agents will all hold typed references to `InteractionSignalId` / `InteractionOverrideId` ahead of full schema ratification
4. **Liveness/readiness pattern is consistent** — applies the Sprint 1 Codex MEDIUM finding (`pharmacy-blocked-handler`) a-priori: `/health` 200 with metadata for operator monitoring, `/ready` 503 to signal "not production-ready"

## Hard rule (platform-floor)

Per CLAUDE.md and Master PRD v1.10 §7, the interaction engine **runs BEFORE the clinician commits a prescription**. Not after, not in parallel. This binds independent of slice ratification — when real handlers land, they enforce this ordering at the prescription-commit boundary.

## On-resume notes (when slice PRD ratifies)

When the Med Interaction Engine slice PRD is ratified:

1. Author CDM §4 row-shape expansions for InteractionSignal / InteractionOverride / InteractionRuleset (spec-side change; not in this repo)
2. Add row-shape interfaces to `src/modules/med-interaction/internal/types.ts`
3. Author `internal/repositories/` with tenant-scoped repos
4. Author `internal/services/signal-evaluator.ts` (the engine itself)
5. Author `internal/adapters/` for vendor interaction databases (per ADR-022 native-first / open-source-first preference)
6. Replace `routes.ts` skeleton with real handler surface
7. Flip `/ready` to 200
8. Wire the engine into prescription-commit paths (Pharmacy module + Async Consult clinician-commit path)
9. Add audit + domain event emitters per Contracts Pack v5.2 AUDIT_EVENTS / DOMAIN_EVENTS (slice PRD will name the event types)
10. Author migration files (sequentially numbered)

## Branded ID type names (PROVISIONAL)

The branded type names anticipate the slice PRD's entity naming. If the ratified slice PRD picks different names, treat as a Sprint 4+ rename task (find-and-replace + import-path update across downstream consumers). Do not block the slice on the rename.

| Branded type            | Anticipated CDM entity   |
| ----------------------- | ------------------------ |
| `InteractionSignalId`   | `InteractionSignal`      |
| `InteractionOverrideId` | `InteractionOverride`    |
| `InteractionRulesetId`  | `InteractionRuleset`     |

## Spec references

- ADR-001 modular monolith
- ADR-029 AI workload taxonomy (interaction signals = `clinical_decision_support` workload class)
- Master PRD v1.10 §7 (interaction engine as platform-floor)
- I-019 (crisis detection adjacent — both are platform-floor)
- CLAUDE.md "Interaction engine runs BEFORE clinician commits prescription" hard rule
- EHBG §7 (engineering implements per CDM, does not author)

## Sprint reference

Authored Sprint 3 (TLC-007) on the autonomous Scrum cycle while SI-001 / SI-002 / SI-003 remain open upstream. Mirrors the pharmacy module skeleton pattern (TLC-001 in Sprint 1) with the readiness/liveness split applied a-priori (TLC-001 fix-forward at `5615feb` post-Codex MEDIUM finding `pharmacy-blocked-handler`).
