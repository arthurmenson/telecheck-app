# Sprint 8 Plan — Telecheck-app autonomous build

**Sprint:** 8
**Sprint goal:** Pivot to **Async Consult slice authoring** (Sprint 1 of 3) — TLC-020 skeleton + state machine constants + branded ID types + plugin smoke test. Pre-pave runway is exhausted (Sprint 7 retro confirmed).
**Sprint start commit:** `5cfa986` (Sprint 7 ACCEPTED)
**Commit budget:** 6 (kickoff + scaffold + smoke test + Codex fix-forward reserve + review/retro + 1 slack; PM proposed 1.3× because new module class + first slice authoring since Sprint 1)
**Codex strategy:** FIRE on TLC-020 (first new slice authoring since Sprint 1; novel module class; state-machine-bearing skeleton)

---

## PM-brief verification gate findings (Sprint 8 — 3rd consecutive ALL PASS)

| Identifier | Cited at (PM brief §) | Verified at (source-of-truth) | Match |
| --- | --- | --- | --- |
| Async Consult PRD §1 | §3 | `Telecheck_Async_Consult_Slice_PRD_v1_0.md:11` ("Purpose and strategic role") | ✓ |
| Async Consult PRD §12 | §3 | `Telecheck_Async_Consult_Slice_PRD_v1_0.md:418` ("States and transitions") | ✓ |
| Async Consult PRD §13 | §3 | `Telecheck_Async_Consult_Slice_PRD_v1_0.md:441` ("Audit") | ✓ |
| Async Consult PRD §15 | §3 | `Telecheck_Async_Consult_Slice_PRD_v1_0.md:497` ("Dependencies") | ✓ |
| State Machines §3 | §3 | `Telecheck_State_Machines_v1_1.md:159` ("Async Consult State Machine") | ✓ |
| EXPIRED transition | §3 | `Telecheck_State_Machines_v1_1.md:200` ("ABANDONED → expire → 14d → EXPIRED") | ✓ |
| CDM Consult #15 | §3 | `Telecheck_Canonical_Data_Model_v1_2.md:84` ("Consult / Care Delivery") | ✓ |
| CDM ConsultEvent #16 | §3 | `Telecheck_Canonical_Data_Model_v1_2.md:85` ("ConsultEvent / Care Delivery") | ✓ |
| `src/modules/async-consult/` | §4 | does NOT exist (Glob returned 0 files) | ✓ |
| P-010 (no P-011/012/013) | §1 | confirmed via grep of stale-claim references | ✓ |

**Gate result: ALL PASS.** 3rd consecutive clean PM brief. The Sprint 3 + Sprint 5 hallucination class has not recurred.

**SM verification correction:** PM brief §3 said "16 states in PRD §12 + EXPIRED in State Machines = 17". Fuller read shows State Machines §3 transition table at L196-218 enumerates **17 distinct states**: INITIATED / INTAKE / ABANDONED / SUBMITTED / PROCESSING / QUEUED / UNDER_REVIEW / PRESCRIBED / ADVISED / AWAITING_DATA / ESCALATED_TO_SYNC / DECLINED / REFERRED / FOLLOW_UP / COMPLETED / **EXPIRED** / **CLOSED**. PRD §12's `DECISION_MADE` is absorbed into UNDER_REVIEW branch points in §3; State Machines adds `CLOSED` (timeout target from AWAITING_DATA at `Telecheck_State_Machines_v1_1.md:212`). Per CLAUDE.md hard rule "Slice PRD vs State Machines v1.1 → State Machines wins" — skeleton uses the State Machines §3 list of 17.

---

## Promotion Ledger check

SI-001 / SI-002 / SI-003 remain **open** upstream. Latest entry P-010. Slice 4 schema work stays blocked. Path (b) Async Consult slice authoring is the right pivot.

---

## Story committed

### TLC-020 — Async Consult slice skeleton (Sprint 1 of 3)

**Estimated commits:** 1-2 (skeleton + Codex fix-forward reserve)
**Decision rule:** 4 (new unblocked slice work)
**Current state baseline (PM verified):** `src/modules/async-consult/` does NOT exist; OpenAPI v0.2 has no `/v0/consult` or `/v0/async-consult` paths (collision check passed).

#### Acceptance criteria (skeleton recipe; mirrors pharmacy / med-interaction / subscription)

- New module directory `src/modules/async-consult/` with:
  - `index.ts` — public-interface re-exports (branded IDs + state values + plugin)
  - `plugin.ts` — Fastify plugin shell registering `/v0/async-consult`
  - `routes.ts` — `/health` 200 + `/ready` 503 (slice not implementation-ready at v0.1)
  - `internal/types.ts` — branded ID types `ConsultId`, `ConsultEventId` + state value const enum
  - `README.md` — Sprint 8/9/10 scope split + on-resume notes
- Plugin wired into `src/app.ts`; both probe paths allowlisted in tenantContextPlugin
- 2-case plugin smoke test mirroring pharmacy + med-interaction + subscription patterns

#### State value const enum (canonical from State Machines §3 — 17 states)

```typescript
export const CONSULT_STATES = [
  'INITIATED', 'INTAKE', 'ABANDONED', 'SUBMITTED', 'PROCESSING',
  'QUEUED', 'UNDER_REVIEW', 'PRESCRIBED', 'ADVISED', 'AWAITING_DATA',
  'ESCALATED_TO_SYNC', 'DECLINED', 'REFERRED', 'FOLLOW_UP', 'COMPLETED',
  'EXPIRED', 'CLOSED',
] as const;
export type ConsultState = (typeof CONSULT_STATES)[number];
```

PRD §12's `DECISION_MADE` intentionally OMITTED — per Slice-PRD-vs-State-Machines hierarchy + State Machines §3 absorbs it into UNDER_REVIEW branch points.

#### Out of scope (Sprint 9 + 10)

- Repos / services / handlers (Sprint 9)
- State machine transition logic (Sprint 9)
- Audit event emitters (Sprint 10 — pending AUDIT_EVENTS contract ratification or SI-004 if missing)
- Domain event emitters (Sprint 10 — same)
- Schema migrations (depends on CDM §4 expansion for Consult / ConsultEvent — verify state at Sprint 9 kickoff)
- Cross-tenant isolation tests (Sprint 10 — once handlers exist to test)

#### Wire-protocol vocabulary check (skeleton level)

- **State values** (17): all canonical per State Machines §3 ✓
- **Audit event_types** (PRD §13 enumerates 11): NOT verified in canonical AUDIT_EVENTS contract; **SKELETON only at Sprint 8 — defer to Sprint 9-10; likely SI-004 if AUDIT_EVENTS contract doesn't carry them**
- **Domain event_types**: same posture as audit
- **Error codes**: only canonical liveness/readiness payloads; no novel error codes

#### Internal-canonicalization-pattern check

Skeleton recipe mirror locations:
- Pharmacy: `src/modules/pharmacy/` (TLC-001 Sprint 1)
- Med-interaction: `src/modules/med-interaction/` (TLC-007 Sprint 3)
- Subscription: `src/modules/subscription/` (TLC-010 Sprint 4)
- Plugin smoke test pattern: `tests/integration/{pharmacy,med-interaction,subscription}-plugin-wiring.test.ts`

The recipe is fixed and reproducible (Sprint 4 retro stated this; this is the 4th application).

---

## Definition of Done — Sprint 8

- [ ] PM-brief verification gate ran + findings recorded (this doc §"PM-brief verification gate findings")
- [ ] TLC-020 module skeleton authored (index + plugin + routes + internal/types + README)
- [ ] Branded IDs `ConsultId`, `ConsultEventId` exported
- [ ] State value const enum `CONSULT_STATES` (17 states) exported
- [ ] Plugin smoke test (2 cases) authored
- [ ] Plugin wired in `src/app.ts`; tenantContextPlugin allowlist updated
- [ ] Codex FIRE on TLC-020; HIGH/CRITICAL findings closed in-sprint
- [ ] Lint + type-check clean
- [ ] No invariants relaxed
- [ ] No production-code changes outside scope
- [ ] `docs/SPRINT_8_REVIEW.md` filed (with verification gate + Codex findings)
- [ ] `docs/SPRINT_8_RETRO.md` filed
- [ ] PM kickoff brief for Sprint 9 (verification gate runs again; Sprint 9 = repos + services + initial handlers)

---

## Risks (PM-flagged + SM additions)

- **PM Risk 1: Audit event vocabulary deferred.** PRD §13 enumerates 11 events; AUDIT_EVENTS contract grep returned 0 matches. If Codex flags this at Sprint 8 review, fix-forward reframe to "SKELETON only — wire-protocol ratification deferred to Sprint 9-10 / SI-004 candidate". Same defense pattern as TLC-018 Sprint 7 closure-language fix-forward.
- **PM Risk 2: State machine §3 transition table at L196-218.** PM read 50 lines; full ~30-transition surface not yet enumerated in this brief. Sprint 9 must do full §3 read when authoring transition logic.
- **SM addition: cross-slice dependencies.** Async Consult §15 lists 14 dependencies (Identity, Forms/Intake, AI Mode 1+2, Med-Interaction, Herb-Drug, Pharmacy, Refill, Consent, Labs, RPM/CCM, Adverse Events, Payment, Messaging). Skeleton ships without wiring any of these — Sprint 9 + 10 wire the available ones (Identity, Forms/Intake, Consent are available; Pharmacy/Refill BLOCKED on SI-001; Med-Interaction skeleton-only; Labs/RPM/Adverse Events not yet authored). Sprint 8 just exports branded IDs so callers can typed-import without authoring.

---

## Codex strategy detail

**TLC-020 — FIRE.** Narrow scope:
```
node "C:/Users/menso/.claude/plugins/cache/openai-codex/codex/1.0.4/scripts/codex-companion.mjs" adversarial-review "--background --base 5cfa986 src/modules/async-consult/ src/app.ts tests/integration/async-consult-plugin-wiring.test.ts"
```

Hard 15-min cap. Codex likely findings to anticipate:
- State value enum not aligning with State Machines §3 → SM verified the alignment a-priori
- Audit event vocabulary missing canonical refs → SM flagged as deferred-to-Sprint-9; should not block
- Closure-language overclaim ("closes Async Consult slice") — Sprint 7 TLC-018 lesson applied a-priori; commit message will say "Sprint 1 of 3; full slice integration spans Sprints 8-10"
