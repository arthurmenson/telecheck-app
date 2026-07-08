# `src/modules/async-consult/` — Async Consult module

Implementation of **Async Consult Slice PRD v1.0** (Canonical for development).

This module owns the platform's asynchronous consult primitive — patient-initiated intake, clinician review, prescription / advice / referral / decline branches, and the patient-responds follow-up cycle. Per the slice PRD, async consult is the first non-blocked clinical workflow on the platform: it does not depend on real-time scheduling (which Sync Video Consult handles) and is the entry point for the Mode 2 protocol-execution agent (per ADR-002, preserved at v1.0 active levels per ADR-029).

## Status: DUAL SURFACE — legacy /v0 complete + Sprint 10 /v1 core handlers landed (PR 6)

**Two route surfaces are mounted by `plugin.ts`:**

1. **`/v0/async-consult` (legacy; implementation-complete at v1.0, Sprint 33-34 close 2026-05-08).** All 6 functional routes against the migration 020 `consults` + `consult_events` tables, with HTTP-level integration tests, service-layer direct integration tests, cross-tenant isolation tests, and idempotency-replay regression on state-changing handlers. Sprint 33 PR-F-prep migrated 5 handlers to the reserve-then-execute idempotency pattern. Sprint 34 PR #51 added comprehensive HTTP integration tests + closed a handler bug where `InvalidTransitionError` and `UnsupportedTransitionError` leaked as 500 responses (now mapped to tenant-blind 409 per I-025) — 4 Codex rounds (r1→r4) including a CI-revealed handler bug closure.

2. **`/v1/async-consults` (Sprint 10 canonical surface; PR 6).** The P-038 canonical entity chain (migrations 055 roles → 056 entities → 057 caller-class views → 058 raw lifecycle writer → 059 SECDEF wrappers → 061 app-role bridge (060 = pharmacy refill entities, merged first)). Six core endpoints per OpenAPI v0.4: initiate / intake / queue / get / claim / decision — all under the canonical composition (withIdempotentExecution or withTransaction → withTenantContext → withActorContext → withDbRole(`async_consult_*` slice role) → SQL → same-tx `async_consult.*` audit emission per AUDIT_EVENTS v5.11 under the restored app role), 42501 → tenant-blind 403 (I-025), Idempotency-Key on all POSTs (IDEMPOTENCY v5.1).

**`/ready` FLIPPED TO 200 (post PRs #249/#250/#253):** every buildable ratified endpoint is live (9 of the P-038 §7 11 — the 2 unbuilt need SIs, see below) and the live-PG integration suite covers the full pilot loop over the real SI-010 bind path. The items below are the REMAINING gaps — all spec-gated or platform-wide TODOs, each failing closed at its boundary; per the readiness contract they no longer hold the gate (pharmacy precedent). The `/ready` body carries the machine-readable `spec_gated_gaps` inventory.

- Delegate-initiated flows fail closed (403 + documented TODO in `initiate-consult-v1.ts`) pending a delegate-principal binding primitive from the Consent slice. The read path DOES honor delegates (the migration 057 patient-view predicate authorizes active `book_consults` delegations).
- Intake abandon (P-038 §7 endpoint #3) has NO wrapper spec'd in §3 and the raw lifecycle writer is owner-only — needs an SI before the route can exist.
- ~~`record_consult_ai_preparation_completed` (migration 059 §3) is not exposed — wrapper EXECUTE is owner-only until the AI-service slice role is wired.~~ **CLOSED (migration 064):** POST `/v1/async-consults/:consult_id/ai-preparation` (OpenAPI v0.4 endpoint #4) is live under the `ai_service` caller class — `ai_service_account` slice role + wrapper EXECUTE + app-role bridge + SI-010 actor-enum widening shipped with the handler (`internal/handlers/ai-preparation-v1.ts`) and Cat C `ai_preparation_started`/`_completed` audits. The in-process Mode 1 preparation pipeline (LLM → summary → app-side envelope encryption → this recording surface) remains a hardening follow-on until a real LLM provider replaces NullLLMProvider.
- `reassign_consult_claim` (migration 059 §5) is not exposed — the wrapper is ratified (P-038 §3 row 7) but NO HTTP endpoint is ratified anywhere (not in P-038 §7, not in SI-023 §5); needs an SI.
- KMS envelopes for intake payload + decision rationale are accepted PRE-ENCRYPTED from an internal service boundary (crisis precedent; see `internal/handlers/v1-shared.ts`); app-side envelope encryption is a hardening follow-on.
- ~~Live-PostgreSQL integration tests for the v1 endpoints are pending.~~ **CLOSED:** `tests/integration/async-consult-v1-http.test.ts` — 17 cases (full pilot loop + endpoint #9 + follow-up messages + caller-class gates + I-025 self-scoping) over the real SI-010 bind pool.
- SPEC ISSUE: the 17 `async_consult.*` audit action IDs are ratified in AUDIT_EVENTS v5.11 but not yet enumerated in `src/lib/audit.ts` — module-local placeholder casts per the med-interaction precedent (see `audit.ts` §Sprint 10).
- Claim TTL defaults to 30 minutes pending a CCR-resolved key (TODO in `claim-consult-v1.ts`).

## Module structure (per `src/modules/README.md` template)

```
async-consult/
├── index.ts              ← public interface (cross-module-safe exports)
├── plugin.ts             ← Fastify plugin entry point (registered in src/app.ts under /v0/async-consult)
├── routes.ts             ← Fastify route registration (6 routes + /health + /ready)
├── audit.ts              ← AUDIT_EVENTS v5.2 emitters
├── events.ts             ← DOMAIN_EVENTS v5.2 emitters
└── internal/             ← module-private; no cross-module imports allowed
    ├── types.ts                    ← branded IDs (ConsultId, ConsultEventId) + row-shape types
    ├── state-machine.ts            ← typed-graph state-machine wrapping State Machines v1.1 §3 (~30 transitions, 17 canonical states)
    ├── handlers/
    │   └── consults.ts             ← initiate / submit / abandon / resume / patient-responds + listConsultEvents
    ├── services/
    │   └── consult-service.ts      ← business logic + state-machine guards
    └── repositories/
        ├── consult-repo.ts         ← tenant-scoped DB access for `consults`
        └── consult-event-repo.ts   ← tenant-scoped DB access for `consult_events`
```

## Routes (under `/v0/async-consult`)

| Method | Path                    | Handler                         | Description                                                                       |
| ------ | ----------------------- | ------------------------------- | --------------------------------------------------------------------------------- |
| GET    | `/health`               | inline                          | liveness probe                                                                    |
| GET    | `/ready`                | inline                          | readiness probe                                                                   |
| POST   | `/`                     | `initiateConsultHandler`        | patient initiates a new consult (idempotency-protected)                           |
| POST   | `/:id/submit`           | `submitConsultHandler`          | patient submits the intake (idempotency-protected)                                |
| POST   | `/:id/abandon`          | `abandonConsultHandler`         | patient abandons an in-progress consult (idempotency-protected)                   |
| POST   | `/:id/resume`           | `resumeConsultHandler`          | patient resumes an abandoned consult before expiry (idempotency-protected)        |
| POST   | `/:id/patient-responds` | `patientRespondsConsultHandler` | patient responds to clinician request for additional data (idempotency-protected) |
| GET    | `/:id/events`           | `listConsultEventsHandler`      | list lifecycle events for a consult                                               |

## Routes (under `/v1/async-consults` — Sprint 10 canonical surface, PR 6)

| Method | Path                    | Handler                    | Description                                                                                                                                                                          |
| ------ | ----------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| POST   | `/`                     | `initiateConsultV1Handler` | patient initiates a consult (`record_consult_initiation`; Cat C `async_consult.initiated`)                                                                                           |
| POST   | `/:consult_id/intake`   | `submitIntakeV1Handler`    | intake submission with pre-encrypted KMS envelope (`record_consult_intake_submission`; Cat C `async_consult.intake_submitted`)                                                       |
| GET    | `/queue`                | `getQueueV1Handler`        | staff review queue from `async_consult_staff_summary_v` (paginated; staff callers only)                                                                                              |
| GET    | `/:consult_id`          | `getConsultV1Handler`      | caller-class-routed read (patient/delegate → patient view; staff → staff view; tenant-blind 404)                                                                                     |
| POST   | `/:consult_id/claim`    | `claimConsultV1Handler`    | clinician claim (`claim_consult_for_review`; 55006 → 409 `claim_already_held`; Cat B auto-release + Cat C `async_consult.case_claimed`)                                              |
| POST   | `/:consult_id/decision` | `recordDecisionV1Handler`  | clinician decision (`record_consult_clinician_decision`; Cat A `async_consult.clinician_decision_recorded` [+ `prescribing_recorded` / `rationale_disagreement` per decision shape]) |

## State vocabulary (17 canonical states from State Machines v1.1 §3)

```
INITIATED, INTAKE, ABANDONED, SUBMITTED, PROCESSING, QUEUED,
UNDER_REVIEW, PRESCRIBED, ADVISED, AWAITING_DATA, ESCALATED_TO_SYNC,
DECLINED, REFERRED, FOLLOW_UP, COMPLETED, EXPIRED, CLOSED
```

Per CLAUDE.md hard rule "Slice PRD vs State Machines v1.1 → State Machines wins", the canonical inventory is 17 states (not the 16 listed in PRD v1.0 §12). Differences:

- PRD §12 had `DECISION_MADE`; State Machines §3 absorbs into UNDER_REVIEW branch points
- State Machines §3 adds `EXPIRED` (`ABANDONED → expire → 14d → EXPIRED`)
- State Machines §3 adds `CLOSED` (`AWAITING_DATA → timeout → 14d → CLOSED`)

## Schema

Owned migrations:

- `migrations/020_async_consult.sql` — `consults` + `consult_events` (composite UNIQUE on self for `consult_events` FK; composite FK to `accounts` + `forms_submission`)
- `migrations/021_async_consult_tenant_boundary_constraints.sql` — Codex-driven fix-forward for cross-tenant boundary constraints (idempotent ALTERs covering the upgraded-DB path)

Composite UNIQUE + composite FK pattern per PROJECT_CONVENTIONS r5 §1.1.

## Cross-slice dependency posture

| Dependency                   | Status                  | Notes                                                                                                                                                                                                                    |
| ---------------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Identity & Auth              | ✅ wired                | actor context for clinician + patient                                                                                                                                                                                    |
| Forms/Intake Engine          | ✅ wired                | intake form rendering + submission                                                                                                                                                                                       |
| Consent & Delegation         | ✅ wired                | delegate context + scope-grant matrix                                                                                                                                                                                    |
| AI Clinical Assistant Mode 2 | ⏳ deferred             | awaits AI Service slice authoring                                                                                                                                                                                        |
| Med Interaction Engine       | ⏳ DB-layer in progress | spec RATIFIED (SI-019 v2.0 P-033 + CDM v1.6→v1.7 P-034 2026-05-21); awaits Med-Interaction handler implementation (PR 1 of ~6 — RBAC roles shipped; entities + views + raw writer + wrappers + Fastify handlers pending) |
| Pharmacy + Refill            | ⛔ BLOCKED              | SI-001 (MedicationRequest schema gap)                                                                                                                                                                                    |
| Subscription                 | ⛔ BLOCKED              | SI-001                                                                                                                                                                                                                   |

## Integration test coverage

Located in `tests/integration/`:

- `async-consult-http.test.ts` — comprehensive HTTP coverage: happy path + state-machine guards + auth + body validation + idempotency replay/body-mismatch + PHI projection (552 lines, 13 cases across 6 groups; landed Sprint 34 PR #51)
- `async-consult-cross-tenant-isolation.test.ts` — I-023 / I-024 / I-025 enforcement
- `async-consult-plugin-wiring.test.ts` — plugin smoke test

The handler `mapServiceError` extension to map `InvalidTransitionError` + `UnsupportedTransitionError` → tenant-blind 409 (was: 500 leak) was closed in PR #51 r3. The `expectNoTenantLeak(response)` shared helper is applied to ALL response surfaces (success + every error envelope).

## Spec references

- ADR-001 (modular monolith)
- ADR-002 (two-mode AI architecture; Mode 2 protocol-execution agent — preserved at v1.0 active levels per ADR-029)
- ADR-029 (AI workload taxonomy; prospectively supersedes ADR-002 — Async Consult ships at v1.0 active levels of ADR-002 + ADR-005 + I-012 reject-unless gate)
- Async Consult Slice PRD v1.0
- Canonical Data Model v1.2 §3 entities #15 (Consult) + #16 (ConsultEvent)
- State Machines v1.1 §3 (consult lifecycle — SOURCE OF TRUTH for 17 states + ~30 transitions)
- Contracts Pack v5.2 INVARIANTS (I-003 audit append-only, I-012 prescribing reject-unless three-clause rule, I-019 crisis-detection platform-floor, I-023 / I-024 / I-025 / I-027 tenant isolation), AUDIT_EVENTS, DOMAIN_EVENTS, IDEMPOTENCY (v5.1)
- Tenant Threading Addendum v1.0 §3.X (async consult slice)

## Sprint reference

- Sprint 8 (TLC-020) — initial skeleton authored; first non-blocked slice authoring since Sprint 1 (pre-pave runway exhausted at Sprint 7 retro)
- Sprints 9-10 (TLC-021 / TLC-022) — repos + service + state-machine + initial HTTP handlers; full HTTP integration + audit/domain emitters + cross-tenant isolation tests
- Sprint 33 PR-F-prep — reserve-then-execute idempotency migration (5 handlers)
- Sprint 34 PR #51 — comprehensive HTTP integration tests + handler `InvalidTransitionError` 500-leak fix (4 Codex rounds)
- Sprint 10 (P-038 cadence) PRs 1-5 — canonical DB layer (migrations 055-059: roles, entities, caller-class views, raw lifecycle writer, 6 SECDEF wrappers)
- Sprint 10 PR 6 — /v1/async-consults core handler surface (initiate / intake / queue / get / claim / decision) + migration 061 app-role bridge + per-handler unit tests
