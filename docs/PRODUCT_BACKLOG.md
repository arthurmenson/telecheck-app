# Product Backlog — Telecheck-app

**Owner:** project-manager agent
**Last reviewed:** 2026-05-05 (Sprint 8 close → Sprint 9 kickoff prep — **Async Consult slice authoring underway**)
**Story format:** `TLC-NNN — title`

---

## Sprint 2 — DONE (closed 2026-05-05 at 8a0956a; review/retro pending commit)

### TLC-004 — Tenant-config Admin Backend read handlers

**Status:** ✅ done (f12a142)
**Sprint:** Sprint 2
**Estimated commits:** 5
**Actual commits:** 1
**Decision rule:** 3 (diminishing-returns hygiene)

#### Current state baseline (verified 2026-05-05 by PM)

- `tenant-config` module exposes `/health` + `/me` only
- 3 of 4 repos exist: `country-profile-repo`, `tenant-brand-repo`, `ccr-config-repo`
- `adapter-config-repo` does NOT exist (referenced in module README; not authored)
- Admin Backend slice v1.1 owns mutation handlers; READ paths are unblocked

#### Acceptance criteria

- 4 GET handlers wired under `/v0/admin/*` in `tenant-config/routes.ts`:
  - `GET /v0/admin/country-profiles` (list)
  - `GET /v0/admin/tenant-brand`
  - `GET /v0/admin/ccr-configs`
  - `GET /v0/admin/adapter-configs` (scope-amended: author repo OR document deferral to follow-up; scrum master picks at exec time)
- JWT-auth Tier 1 required (`requireActorContext`)
- Cross-tenant test asserts US JWT can't read Ghana brand/configs (I-025 tenant-blindness on body)
- No mutation handlers; no schema migrations
- Test coverage: HTTP integration tests for each new route + 1 cross-tenant case

#### Dependencies

- None

---

### TLC-006 — Forms-intake operator-edit emit-site wiring

**Status:** ✅ done (8a0956a; chose option b — direct-call tests + parallel domain-event emitters)
**Sprint:** Sprint 2
**Estimated commits:** 3
**Actual commits:** 1
**Decision rule:** 3 (diminishing-returns hygiene)

#### Current state baseline (verified 2026-05-05 by PM)

- `emitFormsEligibilityLogicEdited` + `emitFormsApprovalGovernanceEdited` exist in `audit.ts:503,540`
- ZERO callers in `src/` — emitters preserved for spec compliance
- ZERO tests in `tests/` — genuine coverage gap

#### Acceptance criteria (final state)

- ✅ Chose option (b) — "no consumer yet" rationale documented inline in `events.ts` header
- ✅ Parallel domain-event emitters authored: `forms_eligibility_logic.edited`, `forms_approval_governance.edited`
- ✅ 4-case test file `forms-intake-governance-emit.test.ts` covering envelope shape (Category B) + outbox-landing for both events
- ✅ `FORMS_VERSION_AGGREGATE` constant added to events.ts

#### Dependencies

- None

---

## Sprint 1 — DONE (closed 2026-05-05 at ee2be83)

### TLC-001 — Pharmacy module skeleton (blocked-aware)

**Status:** ✅ done (9abf614 + 5615feb fix-forward)
**Sprint:** Sprint 1
**Estimated commits:** 2
**Decision rule:** 4 (new unblocked slice work)

#### Acceptance criteria

- `src/modules/pharmacy/` directory created with: `index.ts`, `plugin.ts`, `routes.ts`, `internal/types.ts`
- All TypeScript-clean: `npm run typecheck` passes
- Plugin registers under `/v0/pharmacy` with a single `/health` route returning `{status: 'ok', module: 'pharmacy', blocked: 'SI-001'}`
- Types stubs include `MedicationRequestId`, `RefillId`, `DispensingId`, `ShipmentId` branded types — schema authoring is BLOCKED on SI-001 so no row-shape interfaces yet
- `README.md` in module root with BLOCKED ON SI-001 banner + scope-on-resume notes
- ZERO migration files added
- Plugin smoke test: `tests/integration/pharmacy-plugin-wiring.test.ts` (1 case — health endpoint returns 200)

#### Dependencies

- SI-001 (open) — full implementation requires schema closure; this skeleton paves the directory

---

### TLC-002 — Identity cross-tenant isolation regression suite

**Status:** ✅ done (3410b6d, 8 cases)
**Sprint:** Sprint 1
**Estimated commits:** 1
**Decision rule:** 3 (diminishing-returns hygiene)

#### Acceptance criteria

- `tests/integration/identity-cross-tenant-isolation.test.ts` mirrors `consent-cross-tenant-isolation.test.ts` shape
- 4 entities × 2 cases per entity = 8 cases total (account, session, otp, device — read-from-wrong-tenant returns null + write-from-wrong-tenant denied)
- Asserts `withTenantBoundConnection` enforces RLS layer-1 + app-layer tenant filter (I-023)
- Asserts no spurious audit emission in attacking tenant (I-024)
- All 8 cases pass against real Postgres in CI
- No production-code changes

#### Dependencies

- None — pure additive test work

---

### TLC-003 — Forms-intake remaining outbox-landing tests

**Status:** ✅ done (d87a6ba; re-scoped to variant.winner_promoted + variant.retired after PM premise corrected)
**Sprint:** Sprint 1
**Estimated commits:** 2
**Decision rule:** 3 (diminishing-returns hygiene)

#### Acceptance criteria

- 4 new outbox-landing assertions added to existing test files (no new test file):
  - `forms_template.created` in `forms-intake-templates-http.test.ts` or `forms-intake-publish.test.ts`
  - `forms_template.version_published` in `forms-intake-publish.test.ts`
  - `forms_deployment.created` + `forms_deployment.retired` in `forms-intake-deployments-http.test.ts`
- Each assertion follows pattern: query `domain_events_outbox` after the audit-emit code path runs; assert envelope shape (aggregate_type, partition_key, payload fields)
- After this story, ALL 12 forms-intake domain events have explicit outbox-landing coverage
- Updates `FORMS_INTAKE_SLICE_STATUS_2026-05-05.md` with new test count

#### Dependencies

- None

---

## Sprint 1 — sprint review story

### TLC-S1R — Sprint 1 review + retro

**Status:** todo
**Sprint:** Sprint 1
**Estimated commits:** 3
**Decision rule:** sprint-review protocol

#### Acceptance criteria

- Codex adversarial review fires: `node codex-companion.mjs adversarial-review --background --base <sprint-start> src/modules/pharmacy/ tests/integration/identity-cross-tenant-isolation.test.ts tests/integration/forms-intake-templates-http.test.ts tests/integration/forms-intake-publish.test.ts tests/integration/forms-intake-deployments-http.test.ts`
- HIGH/CRITICAL findings addressed in same sprint (commit budget includes fix-forward room)
- `docs/SPRINT_1_REVIEW.md` written
- `docs/SPRINT_1_RETRO.md` written
- PM agent accepts deliverables (or rolls over rejected stories to Sprint 2)

#### Dependencies

- TLC-001, TLC-002, TLC-003 must be DoD-complete first

---

## Sprint 2 — proposed (PM confirms at Sprint 2 kickoff)

### TLC-004 — Tenant-config Admin Backend handlers (read paths)

**Status:** todo
**Sprint:** Sprint 2
**Estimated commits:** 5
**Decision rule:** 3

GET `/v0/admin/country-profiles` (list) + GET `/v0/admin/tenant-brand` + GET `/v0/admin/ccr-configs` + GET `/v0/admin/adapter-configs`. JWT-auth required (Tier 1). Read-only; mutation handlers wait for the dedicated Admin Backend slice.

### TLC-005 — Pharmacy module read-only adapter abstraction

**Status:** blocked
**Sprint:** Sprint 2 (if SI-001 closes) / Sprint 3+ (if not)
**Estimated commits:** 4

`src/modules/pharmacy/internal/adapters/` interface for clinician-network + pharmacy adapter contracts. Pure types + factory pattern; no live integration.

### TLC-006 — Forms-intake `eligibility_logic.edited` + `approval_governance.edited` audit emit sites

**Status:** todo
**Sprint:** Sprint 2
**Estimated commits:** 3
**Decision rule:** 3

The audit emitters EXIST in `src/modules/forms-intake/audit.ts` but no service code calls them. Wire them into a future `editEligibilityLogic` + `editApprovalGovernance` operator-side surface (or document as "no consumer yet — emitters preserved for spec compliance"). Author parallel domain-event emitters too.

---

## Sprint 3 — DONE (closed 2026-05-05 at ad711fb; review/retro pending commit)

### TLC-007 — Med Interaction signals contract scaffolding

**Status:** ✅ done (2f89661; module skeleton + plugin smoke test)
**Sprint:** Sprint 3
**Estimated commits:** 2
**Actual commits:** 1
**Decision rule:** 4 (new unblocked slice prep)

Branded IDs: `InteractionSignalId`, `InteractionOverrideId`, `InteractionRulesetId`. Plugin under `/v0/med-interaction` with `/health` (200) + `/ready` (503) — Sprint 1 Codex MEDIUM finding applied a-priori. 2-case wiring test mirroring pharmacy skeleton.

### TLC-008 — Forms-intake remaining audit-emitter coverage gaps

**Status:** ❌ DESCOPED at Sprint 3 kickoff
**Reason:** PM verify-before-authoring research showed non-governance forms-intake emitters have transitive integration coverage via service-layer tests; not a genuine gap.

### TLC-009 — Tenant-config admin-write 503 surface skeleton

**Status:** ✅ done (ad711fb; 5 mutation stubs + readiness probe + 7 tests)
**Sprint:** Sprint 3
**Estimated commits:** 2
**Actual commits:** 1
**Decision rule:** 4 (new slice prep) / partially-blocked

503 stubs for PATCH/POST/DELETE under `/v0/admin/*` using canonical `internal.service.unavailable` envelope (NOT a new error code class — chose canonical pattern over PM's proposed `internal.module.blocked`). JWT auth fires BEFORE 503 (no enumeration attack). Mutation-surface readiness probe at `/v0/admin/ready`. ADR-024 redaction discipline applied a-priori on the 503 path.

---

## Sprint 4 — DONE (closed 2026-05-05 at be6a2dc; review/retro pending commit)

### TLC-010 — Subscription module skeleton (BLOCKED-aware)

**Status:** ✅ done (da597c6; 3 branded IDs + plugin shell + 2 wiring tests)
**Sprint:** Sprint 4
**Estimated commits:** 1
**Actual commits:** 1
**Decision rule:** 4 (new slice prep)

3rd application of the BLOCKED-aware skeleton recipe (pharmacy → med-interaction → subscription). Recipe is now fixed and reproducible.

### TLC-011 — Audit-chain hash-chain integrity regression test (I-003)

**Status:** ❌ DESCOPED at Sprint 4 kickoff
**Reason:** PM verify-before-authoring research showed existing `audit-chain.test.ts` (330 LOC, 6 describe blocks) + `audit-chain-walker.test.ts` (869 LOC, 8 describe blocks) already cover hash-chain integrity comprehensively (HIGH-1 broken-link, HIGH-1 forged-genesis, HIGH-2 record-hash tampering all asserted). Authoring would have duplicated existing coverage.

### TLC-012 — Crisis-detection (I-019) coverage RESCOPED

**Status:** ✅ done (be6a2dc; coverage audit doc + 9-case static-analysis lockdown test)
**Sprint:** Sprint 4
**Estimated commits:** 1
**Actual commits:** 1
**Decision rule:** 3 (diminishing-returns hygiene) / invariant-coverage

PM grep at kickoff: clean bill of health for current modules (only `submission-service:289` invokes `crisisDetector`). Story rescoped from "fix gap" to "documentation + lockdown regression test" because no genuine gap exists. Static-analysis lockdown pattern (sibling to `canonical-glossary.test.ts`) — runs without DB; catches source-level regressions.

---

## Sprint 5 — DONE (closed 2026-05-05 at 1eab1a6; review/retro pending commit)

### TLC-013 — Idempotency invariant lockdown (close 2 IDEMPOTENCY v5.1 gaps)

**Status:** ✅ done (3e37433 + 0f4a757 Codex HIGH fix-forward; Codex re-verify APPROVE)
**Sprint:** Sprint 5
**Actual commits:** 2 (story + fix-forward)

Cross-tenant 4-tuple PK case + TTL expiry case. Codex idempotency-r5 HIGH closed via distinct-payload TTL test rewrite.

### TLC-014 — Tenant-config admin-read tenant-isolation regression

**Status:** ❌ DESCOPED at Sprint 5 kickoff
**Reason:** PM verified §4b adapter-configs cross-tenant case structurally proves the same RLS pattern for ccr-configs + tenant-brand. Authoring would duplicate.

### TLC-015 — ORT v1.5 launch-readiness items audit

**Status:** ✅ done (1eab1a6; audit doc filed with 4 verified-real Sprint 6+ candidates)
**Sprint:** Sprint 5
**Actual commits:** 1

Research-shaped audit. PM brief had hallucinated 3 ORT IDs (OR-253/244/255 — don't exist); SM read ORT directly, surfaced 5 real testable items (OR-112/216/218/208/236) and 4 Sprint 6+ candidates.

---

## Sprint 6 — DONE (closed 2026-05-05 at c9bf34c; review/retro pending commit)

### TLC-016 — RLS policy coverage lockdown

**Status:** ✅ done (75640ef + 2dece96 Codex MEDIUM fix-forward; re-verify APPROVE)
**Sprint:** Sprint 6
**Actual commits:** 2 (story + fix-forward)
**Decision rule:** 3

DB-backed contract test (sibling to canonical-glossary.test.ts pattern but DB-backed because pg_class + pg_policies are runtime catalog tables). 21 tenant-scoped tables × 2 assertions + count drift detection + platform-level exclusion = 46 cases. 3 distinct policy-name conventions handled correctly. Closes OR-112 + OR-236.

### TLC-017 — Build-vs-spec traceability matrix

**Status:** ✅ done (c9bf34c; living-doc convention r1)
**Sprint:** Sprint 6
**Actual commits:** 1
**Decision rule:** 6

Consolidates existing per-slice status docs into a single traceability matrix mapping each implemented invariant / slice / module / state-machine to test files. 13 invariants tabulated, 12 state machines, 3 complete slices + 3 BLOCKED-aware skeletons + 13 foundation libraries. Closes OR-216.

---

## Sprint 7 — DONE (closed 2026-05-05 at ba2c7be; review/retro pending commit)

### TLC-018 — Perf budget infra scaffold (SCAFFOLDS OR-218; does NOT close)

**Status:** ✅ done (d677fd3 + d879a79 Codex HIGH fix-forward; re-verify APPROVE)
**Sprint:** Sprint 7
**Actual commits:** 2 (story + fix-forward)
**Decision rule:** 6 (UAT / launch-readiness)

Vitest bench mode scaffolding (separate `vitest.bench.config.ts` because per-mode setupFiles override doesn't apply in Vitest 2). 1 example bench at `tests/perf/audit/crisis-detect.bench.ts` with 4 scenarios. `npm run bench` script wired. Bench is signal-not-gate at v0.1; OR-218 stays OPEN until Sprint 11 hardening adds (1) p95 thresholds, (2) CI gate wiring, (3) baseline comparison output. Codex perf-bench-r1 HIGH closed via reframe ("scaffolds OR-218 infra; closure deferred to Sprint 11").

### TLC-019 — Data-filtering implementation status doc

**Status:** ❌ DESCOPED at Sprint 7 PM kickoff
**Reason:** PM verified BUILD_VS_SPEC_TRACEABILITY_MATRIX.md §1 I-023 row + §2 lib rows already document ADR-023's 3-layer enforcement. Authoring duplicate would violate "verify before authoring". Absorbed into matrix r2 with OR-208 back-link.

### Matrix r2 amend (TLC-019 absorption + OR-218 status correction)

**Status:** ✅ done (ba2c7be)
**Sprint:** Sprint 7
**Actual commits:** 1
**Decision rule:** Sprint 7 retro process change

Living-doc amend in place (4th amend across the 3 living docs). Closes OR-208 (matrix is canonical closure path); flags OR-218 as scaffolded-not-closed; updates §6 cumulative metrics with Sprint 7 deltas.

---

## Sprint 8 — DONE (closed 2026-05-05 at 2a44164; review/retro pending commit)

### TLC-020 — Async Consult slice skeleton (Sprint 1 of 3)

**Status:** ✅ done (2a44164; Codex APPROVE first-try)
**Sprint:** Sprint 8
**Actual commits:** 1 (cleanest Codex run yet)
**Decision rule:** 4 (new unblocked slice work)

4th application of the BLOCKED-aware skeleton recipe. 2 branded IDs (ConsultId, ConsultEventId per CDM §3 #15-16) + 17-state CONSULT_STATES vocabulary (canonical from State Machines v1.1 §3) + plugin shell + smoke test. Sprint 9 + 10 continue the slice authoring.

---

## Sprint 9 — proposed (PM confirms at Sprint 9 kickoff; verification gate runs)

### TLC-021 — Async Consult slice authoring (Sprint 2 of 3)

**Status:** todo (candidate; PM verifies at Sprint 9 kickoff)
**Sprint:** Sprint 9
**Estimated commits:** 5-8
**Decision rule:** 4 (new unblocked slice work)

Repos + service layer + state machine transition logic + initial HTTP handlers. PM kickoff actions:
- Re-check Promotion Ledger for SI-001 closure (P-011)
- Verify CDM §4 Consult / ConsultEvent expansion exists; if not, file SI-005 candidate
- Read State Machines §3 transition table FULLY (L196-218+; ~30 transitions with guards + actions)
- Verify Identity / Forms-Intake / Consent public interfaces for cross-slice integration
- Decide audit-event SI-004 placeholder posture (option (c) from Sprint 8 retro: author with placeholder events + file SI-004 doc)

Likely Sprint 9 sub-stories (PM may sequence at kickoff):
- TLC-021a: Migration `migrations/020_async_consult.sql` (only if CDM §4 verified)
- TLC-021b: Repos (consult-repo + consult-event-repo; tenant-scoped)
- TLC-021c: State machine transition logic
- TLC-021d: Service layer (initiate / submit / abandon / read)
- TLC-021e: Initial HTTP handlers
- TLC-021f: Per-handler integration tests

---

## Sprint 10 — proposed (PM confirms at Sprint 10 kickoff)

### TLC-022 — Async Consult slice authoring (Sprint 3 of 3)

**Status:** todo (candidate)
**Sprint:** Sprint 10
**Estimated commits:** 5-10

Full HTTP integration (clinician decision endpoints, patient response, follow-up messaging) + audit event emitters + domain event emitters + cross-tenant isolation tests. Audit event vocabulary either ratified via SI-004 closure OR placeholder events with SI-004 doc as resume gate (decision deferred to Sprint 9 PM kickoff per Sprint 8 retro).

---

## Sprint 11+ — proposed (sequenced through EHBG §10b)

**Status flag at Sprint 7 close (HISTORICAL — Sprint 8 executed Path b):** the testable-without-upstream-blockers backlog is depleted. Three pivot paths were considered:

### Path (a) — Slice 4 schema authoring (if SI-001 closes upstream)

PM checks Promotion Ledger for P-011 entry. If it lands between Sprint 7 close and Sprint 8 kickoff, Slice 4 schema authoring becomes the priority path.

### Path (b) — Async Consult slice authoring (RECOMMENDED if SI-001 still open)

**Status:** todo (candidate; PM verifies PRD section refs at Sprint 8 kickoff)
**Sprint:** Sprint 8 (estimated Sprint A; full slice spans Sprint 8-10)
**Estimated commits:** 5-10 per sprint × ~3 sprints = 15-30 total
**Decision rule:** 4 (new unblocked slice work)

PRD verified to exist at `Telecheck Master Bundle FINAL US REGION BASELINE/Telecheck_Async_Consult_Slice_PRD_v1_0.md` (Sprint 7 PM brief §5; SM verification gate confirmed). Sprint sequencing per Forms-Intake / Identity / Consent precedent:
- **Sprint 8 (TLC-020):** Module skeleton + state machine + branded ID types + plugin smoke test
- **Sprint 9 (TLC-021):** Repos + service layer + initial HTTP handlers
- **Sprint 10 (TLC-022):** Full HTTP integration tests + audit + domain event emitters + cross-tenant isolation tests + Codex FIRE per iteration

PM-brief verification gate at Sprint 8 kickoff MUST verify the Async Consult PRD section refs the SM cites (per Sprint 5 retro spec-corpus identifier sub-rule extended to slice PRD section refs).

### Path (c) — Surface emergency-access blockers to Evans

If neither (a) nor (b) is viable (e.g., Async Consult PRD turns out to depend on un-authored upstream slice contracts), surface to Evans the remaining work that requires his emergency-only involvement:
- Vendor account credentials (LiveKit, Anthropic API, AWS Bedrock, Twilio/Hubtel, etc.)
- AWS deploy access for production cutover
- Counsel work (DPIA, threat model, etc.) that's out-of-repo

### Process items for Sprint 8 PM kickoff

- Verification gate runs again per `SCRUM_OPERATING_MODEL.md`
- Sprint 7 retro process change: SM closure-language audit before commit (don't ship "closes <X>" if the doc itself says "non-blocking" + X is launch-blocking)
- Sprint 7 retro process change: pre-commit local-run for new infra (lint+typecheck alone insufficient for test runners / build configs / scripts)
- Sprint 7 retro process change: vitest config block addition checklist (audit existing comments for `*/` glob-comment-terminator constraint pattern)

---

## Sprint 9+ — proposed (sequenced through EHBG §10b)

| Sprint | EHBG mapping                                                     | Indicative stories                                                                                                                                                                                                        |
| ------ | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 4      | Pharmacy + Refill v2.X part 1 (if SI-001 closes)                 | TLC-010 MedicationRequest schema + state machine; TLC-011 Refill state machine + repo                                                                                                                                     |
| 5      | Pharmacy + Refill part 2 + Subscription                          | TLC-012 Pharmacy adapter framework + first US adapter; TLC-013 Subscription model + state machine                                                                                                                         |
| 6      | Pharmacy + Refill part 3 + Admin Backend part 1                  | TLC-014 Pause/resume/switch/cancel flows; TLC-015 ProductCatalog scaffold; TLC-016 Admin Backend Platform Admin tenant management UI                                                                                      |
| 7      | Async Consult + Admin Backend part 2                             | TLC-017 Async consult workflow; TLC-018 Admin Backend Tenant Admin subscription/refill management                                                                                                                         |
| 8      | Sync Video Consult + Admin Backend part 3                        | TLC-019 LiveKit integration; TLC-020 AI Scribe; TLC-021 Admin Backend catalog/pricing/discount                                                                                                                            |
| 9      | Labs + Admin Backend part 4                                      | TLC-022 Labs upload + AWS Textract; TLC-023 Admin Backend affiliate MVP                                                                                                                                                   |
| 10     | Adverse Event + RPM/CCM                                          | TLC-024 Adverse event detection; TLC-025 RPM/CCM model + alerts                                                                                                                                                           |
| 11     | Hardening + Launch prep                                          | TLC-026 Performance optimization; TLC-027 Security hardening; TLC-028 Accessibility audit; TLC-029 Telecheck-Ghana launch readiness; TLC-030 Telecheck-US (Heros Health DBA) launch readiness; TLC-031 Runbooks finalized |

PM may resequence based on SI closures + emergent priorities.

---

## Blocked / waiting upstream

| Story / area               | Blocking SI / dependency                                                                                |
| -------------------------- | ------------------------------------------------------------------------------------------------------- |
| Slice 4 schema (real impl) | SI-001 — MedicationRequest schema + state machine + AUDIT_EVENTS action IDs + DOMAIN_EVENTS event types |
| AUDIT_EVENTS rename sweep  | SI-002 closure (P-012 in spec corpus)                                                                   |
| DOMAIN_EVENTS rename sweep | SI-003 closure (P-013 in spec corpus)                                                                   |
| Vendor integration tests   | Vendor account credentials (emergency-only — Evans's scope)                                             |
| Production cutover         | AWS deployment access (emergency-only — Evans's scope)                                                  |

---

## Done (rolling archive — last 3 sprints visible)

### Sprint 8 — closed 2026-05-05

- TLC-020 — Async Consult slice skeleton (2a44164; Codex APPROVE first-try; 4th recipe application; first non-blocked slice authoring since Sprint 1)

### Sprint 7 — closed 2026-05-05

- TLC-018 — Perf budget infra scaffold (d677fd3 + d879a79 fix-forward; Codex HIGH closed; re-verify APPROVE; SCAFFOLDS OR-218 — does NOT close)
- TLC-019 — DESCOPED at PM kickoff (matrix already covers)
- Matrix r2 amend (ba2c7be; closes OR-208 via absorption; flags OR-218 status correction)

### Sprint 6 — closed 2026-05-05

- TLC-016 — RLS policy coverage lockdown (75640ef + 2dece96 fix-forward; Codex MEDIUM closed; re-verify APPROVE; 46 cases across 21 tenant-scoped tables)
- TLC-017 — Build-vs-spec traceability matrix (c9bf34c; living-doc convention r1; closes OR-216)
