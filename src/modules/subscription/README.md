# Subscription module — BLOCKED ON SI-001

## Status (v0.1 skeleton)

This module is a **directory skeleton** authored at Sprint 4 (TLC-010) — the 3rd application of the blocked-aware skeleton recipe (after pharmacy TLC-001 in Sprint 1 and med-interaction TLC-007 in Sprint 3). The full Subscription surface (state machine, repos, services, HTTP handlers, Pharmacy + Payment adapter wiring) is **BLOCKED** on SI-001 (`docs/SI-001-MedicationRequest-Schema-Gap.md`) — Subscription binds to MedicationRequest via `medication_request_id` for refill cadence and product-catalog binding.

## What ships at v0.1

- Module directory boundary (per ADR-001 modular monolith)
- Fastify plugin shell registering `/v0/subscription`
- Liveness probe (`GET /health` → 200) with informational `blocked` metadata
- Readiness probe (`GET /ready` → 503) — Kubernetes/LB will keep traffic off the module
- Branded ID types (`SubscriptionId`, `SubscriptionScheduleId`, `SubscriptionPauseId`) — identifier hygiene only, not schema
- Plugin smoke test (`tests/integration/subscription-plugin-wiring.test.ts`)

## What does NOT ship at v0.1

- Row-shape interfaces for Subscription / SubscriptionSchedule / SubscriptionPause
- Repository files
- State machine (pause / resume / cancel / switch transitions)
- Real HTTP handlers (POST /subscriptions, PATCH /subscriptions/:id/pause, etc.)
- Payment adapter wiring
- Pharmacy module integration (refill cadence → MedicationRequest)
- Database migrations
- Audit / domain event emitters

## Why this is intentionally a skeleton

Per EHBG §7, engineering does not author canonical schema; the slice PRD owns it. Subscription's row shape depends on MedicationRequest schema (CDM v1.2 §4) — authoring schemas now would silently fork the spec corpus (per the "do NOT silently fork" hard rule in CLAUDE.md). When SI-001 closes (Promotion Ledger P-011), Subscription schema lands as part of Slice 4 schema authoring.

The skeleton lands now so that:

1. **Module boundary is established** under ADR-001 — the public-interface surface is fixed
2. **App-level wiring is stable** — `src/app.ts` registers `subscriptionPlugin` once; plugin internals can evolve without re-touching `app.ts`
3. **Downstream slices can typed-import branded IDs** — Async Consult (TLC-017+), Admin Backend Tenant Admin subscription management (TLC-018+) can hold typed references to `SubscriptionId` ahead of full schema ratification
4. **Liveness/readiness pattern is consistent** — applies the Sprint 1 Codex MEDIUM finding (`pharmacy-blocked-handler`) a-priori; this is now the standing rule across all blocked-aware skeletons

## On-resume notes (when SI-001 closes)

When SI-001 closes (Promotion Ledger P-011 lands):

1. Author CDM §4 row-shape expansion for Subscription / SubscriptionSchedule / SubscriptionPause (spec-side change; not in this repo)
2. Add row-shape interfaces to `src/modules/subscription/internal/types.ts`
3. Author `internal/repositories/` with tenant-scoped repos
4. Author `internal/services/subscription-service.ts` (state-machine + cadence calc)
5. Author migrations (sequentially numbered) for subscriptions, subscription_schedules, subscription_pauses tables
6. Replace `routes.ts` skeleton with real handler surface
7. Flip `/ready` to 200 unconditionally; remove `blocked` field
8. Wire Pharmacy module integration (subscription → next_ship_at → pharmacy_refill_creation)
9. Wire Payment adapter (subscription_pause + subscription_resume billing-side hooks)
10. Add audit + domain event emitters per Contracts Pack v5.2 AUDIT_EVENTS / DOMAIN_EVENTS

## Branded ID type names (PROVISIONAL)

The branded type names anticipate the slice PRD's entity naming. If the ratified slice PRD picks different names, treat as a Sprint 5+ rename task (find-and-replace + import-path update).

| Branded type               | Anticipated CDM entity     |
| -------------------------- | -------------------------- |
| `SubscriptionId`           | `Subscription`             |
| `SubscriptionScheduleId`   | `SubscriptionSchedule`     |
| `SubscriptionPauseId`      | `SubscriptionPause`        |

## Spec references

- ADR-001 modular monolith
- docs/SI-001-MedicationRequest-Schema-Gap.md
- CDM v1.2 §3.5 (Pharmacy & Fulfillment entity inventory)
- Pharmacy + Refill Slice PRD v2.1 §5 (target spec for subscription model)
- EHBG §7 (engineering implements per CDM, does not author)

## Sprint reference

Authored Sprint 4 (TLC-010) on the autonomous Scrum cycle while SI-001 / SI-002 / SI-003 remain open upstream. 3rd application of the BLOCKED-aware skeleton recipe (after pharmacy TLC-001 and med-interaction TLC-007); the recipe is now fixed and reproducible. Liveness/readiness split applied a-priori per Sprint 1 Codex MEDIUM finding `pharmacy-blocked-handler`.
