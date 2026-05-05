# Async Consult module — SKELETON (Sprint 1 of 3)

## Status (v0.1 skeleton — Sprint 8 / TLC-020)

This module is a **directory skeleton** authored at Sprint 8 (TLC-020) — the 4th application of the blocked-aware skeleton recipe (after pharmacy TLC-001 in Sprint 1, med-interaction TLC-007 in Sprint 3, subscription TLC-010 in Sprint 4). Async Consult is the first **non-blocked** slice authoring since Sprint 1 — pre-pave runway exhausted at Sprint 7 retro; Sprint 8 pivots per Path (b).

## Slice authoring sequencing (Sprints 8 → 9 → 10)

| Sprint | Story | Scope | DoD signal |
| --- | --- | --- | --- |
| **Sprint 8 (THIS)** | TLC-020 | Module skeleton + plugin shell + branded IDs + state vocabulary + plugin smoke test | Plugin smoke test passes (2 cases) |
| **Sprint 9** | TLC-021 | Repos (tenant-scoped) + service layer + state-machine transition logic + initial HTTP handlers (POST /v0/async-consult initiate, POST /v0/async-consult/:id/submit, POST /v0/async-consult/:id/abandon, GET /v0/async-consult/:id) | First end-to-end test passes; State Machines §3 transitions wired |
| **Sprint 10** | TLC-022 | Full HTTP integration (clinician decision endpoints, patient response, follow-up messaging) + audit event emitters + domain event emitters + cross-tenant isolation tests | OR-218 perf benches added per Sprint 11 promotion path |

## What ships at v0.1 (Sprint 8)

- Module directory boundary (per ADR-001 modular monolith)
- Fastify plugin shell registering `/v0/async-consult`
- Liveness probe (`GET /health` → 200) with informational `blocked` metadata
- Readiness probe (`GET /ready` → 503) — Kubernetes/LB will keep traffic off
- Branded ID types (`ConsultId`, `ConsultEventId`) — identifier hygiene only
- State value const enum `CONSULT_STATES` (17 values per State Machines §3) — typed-only, no transition logic
- Plugin smoke test (`tests/integration/async-consult-plugin-wiring.test.ts`)

## What does NOT ship at v0.1 (Sprint 8)

- Row-shape interfaces for Consult / ConsultEvent (await CDM §4 expansion + Sprint 9 authoring)
- Repository files (Sprint 9)
- Service layer (Sprint 9)
- State-machine transition logic (Sprint 9 — ~30 transitions per State Machines §3 transition table at L196-218+)
- HTTP handlers (Sprint 9 + 10)
- Audit event emitters (Sprint 10 — pending AUDIT_EVENTS contract ratification; PRD §13 enumerates 11 events not in canonical contract; SI-004 candidate)
- Domain event emitters (Sprint 10 — same posture)
- Cross-tenant isolation tests (Sprint 10)
- Migration files (Sprint 9 — pending CDM §4 expansion verification at Sprint 9 PM kickoff)

## Why the skeleton ships before the rest

Per EHBG §10b sprint sequencing, slice authoring is split across multiple sprints because:

1. **Module boundary stable on day 1** — `src/app.ts` registers `asyncConsultPlugin` once; plugin internals can evolve without re-touching `app.ts` across sprints
2. **Downstream slices can typed-import branded IDs + state vocabulary** — Pharmacy + Refill, RPM/CCM, Adverse Events, Messaging, Payment all reference Consult types per PRD §15 Dependencies; they can compile clean against typed references before Sprint 9 lands repos/services
3. **Reproducible recipe** — 4th application of the BLOCKED-aware skeleton recipe; near-zero authoring cost for the boundary itself
4. **Liveness/readiness pattern is consistent** — applies the Sprint 1 Codex MEDIUM finding (`pharmacy-blocked-handler`) a-priori (now the standing rule)

## State value vocabulary (17 canonical states from State Machines §3)

```
INITIATED, INTAKE, ABANDONED, SUBMITTED, PROCESSING, QUEUED,
UNDER_REVIEW, PRESCRIBED, ADVISED, AWAITING_DATA, ESCALATED_TO_SYNC,
DECLINED, REFERRED, FOLLOW_UP, COMPLETED, EXPIRED, CLOSED
```

PRD v1.0 §12 lists 16 states; the difference between PRD §12 and State Machines §3:
- **PRD §12 has `DECISION_MADE`** — State Machines §3 absorbs this into UNDER_REVIEW branch points (transitions go from UNDER_REVIEW directly to PRESCRIBED / ADVISED / AWAITING_DATA / ESCALATED_TO_SYNC / DECLINED / REFERRED, not via a DECISION_MADE intermediate state)
- **State Machines §3 adds `EXPIRED`** — `ABANDONED → expire → 14d → EXPIRED` (`Telecheck_State_Machines_v1_1.md:200`)
- **State Machines §3 adds `CLOSED`** — `AWAITING_DATA → timeout → 14d → CLOSED` (`Telecheck_State_Machines_v1_1.md:212`)

Per CLAUDE.md hard rule "Slice PRD vs State Machines v1.1 → State Machines wins", the canonical inventory is 17 states (State Machines §3).

## Cross-slice dependency posture (per PRD §15)

PRD §15 lists 14 cross-slice dependencies. Skeleton ships without wiring any of them. Sprint 9 + 10 wire the available ones:

| Dependency | Available today? | Wire-up sprint |
| --- | --- | --- |
| Identity & Auth | ✅ (Sprint 1) | Sprint 9 (auth context for clinician + patient) |
| Forms/Intake Engine | ✅ (Sprint 0) | Sprint 9 (intake form rendering) |
| Consent & Delegation | ✅ (Sprint 1) | Sprint 9 (delegate context) |
| AI Clinical Assistant Mode 2 | ⚠️ no module yet | Sprint 10+ (or AI Service slice authoring) |
| Med Interaction Engine | ⚠️ skeleton only | Sprint 10+ when Med-Interaction service ships |
| Pharmacy + Refill | ⚠️ BLOCKED on SI-001 | Sprint 4 of EHBG §10b (whenever SI-001 closes) |
| Subscription | ⚠️ skeleton only | Sprint 10+ |
| Labs, RPM/CCM, Adverse Events, Payment, Messaging | ⛔ not yet authored | Sprint 11+ per EHBG §10b |
| Herb-Drug | ⛔ not yet authored | Sprint 11+ |

## On-resume notes (Sprint 9 kickoff)

When Sprint 9 begins:

1. Read State Machines §3 transition table fully (`Telecheck_State_Machines_v1_1.md:196-218+`) — all ~30 transitions
2. Author `internal/state-machine.ts` with the transition table as a typed graph + guards
3. Author `internal/repositories/consult-repo.ts` + `internal/repositories/consult-event-repo.ts` (tenant-scoped per I-023)
4. Author `internal/services/consult-service.ts` — initiate / submit / abandon / read
5. Add HTTP handlers under `internal/handlers/consult.ts` — POST /v0/async-consult, GET /v0/async-consult/:id, POST /v0/async-consult/:id/submit, POST /v0/async-consult/:id/abandon
6. Author migration `migrations/020_async_consult.sql` — verify CDM §4 expansion exists at PM kickoff (if not, file SI-005 candidate)
7. Wire Identity (req.actorContext) + Forms/Intake (intake form rendering) + Consent (delegate context) cross-slice dependencies
8. Author tenant-scoped integration tests + cross-tenant isolation tests
9. Codex FIRE on every Sprint 9 commit (slice authoring novelty)

## Spec references

- ADR-001 modular monolith
- ADR-029 AI workload taxonomy (Mode 2 prep per PRD §1)
- Async Consult Slice PRD v1.0
- State Machines v1.1 §3 (canonical state inventory — SOURCE OF TRUTH)
- CDM v1.2 §3 entities #15 (Consult) + #16 (ConsultEvent)
- I-023 / I-025 / I-027 platform invariants
- EHBG §10b sprint plan (Async Consult sequencing per multi-sprint slice precedent)

## Sprint reference

Authored Sprint 8 (TLC-020) on the autonomous Scrum cycle. **First non-blocked slice authoring since Sprint 1** (pre-pave runway exhausted at Sprint 7 retro). PM-brief verification gate was the 3rd consecutive clean run (Evans 2026-05-05 oversight directive). Sprint 9 + 10 continue the slice; Sprint 11 hardening adds OR-218 perf benches.
