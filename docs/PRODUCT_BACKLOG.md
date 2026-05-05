# Product Backlog — Telecheck-app

**Owner:** project-manager agent
**Last reviewed:** 2026-05-05 (Sprint 5 close → Sprint 6 kickoff prep)
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

## Sprint 6 — proposed (PM confirms at Sprint 6 kickoff)

Sprint 6 candidates are pre-validated by TLC-015 ORT audit (`docs/ORT_V1_5_TESTABLE_ITEMS_AUDIT.md`):

### TLC-016 — RLS policy static-analysis lockdown (OR-112 + OR-236)

**Status:** todo (candidate; PM verifies at kickoff per "verify before authoring")
**Sprint:** Sprint 6
**Estimated commits:** 1-2
**Decision rule:** 3

Static-analysis test (sibling to canonical-glossary.test.ts pattern) asserting every tenant-scoped table in migrations/ has a corresponding RLS POLICY row. PM verify-before-authoring at kickoff: confirm no existing test asserts this; if there is, descope. Codex FIRE on narrow scope (novel test class).

### TLC-017 — Build-vs-spec traceability matrix consolidation (OR-216)

**Status:** todo (candidate)
**Sprint:** Sprint 6
**Estimated commits:** 1
**Decision rule:** 6

Consolidate existing slice status docs into a single traceability matrix mapping each implemented invariant / endpoint / state-machine to the test file(s) covering it.

### TLC-018 — Foundation-layer perf budget tests (OR-218)

**Status:** todo (candidate; lower priority)
**Sprint:** Sprint 6 OR Sprint 7
**Estimated commits:** 2-3

Per-foundation-layer perf assertions (idempotency lookup, audit emit, RLS query) under representative load. Lower priority because most surfaces depend on unauthored slices.

### TLC-019 — Data-filtering implementation status doc (OR-208)

**Status:** todo (candidate; lowest priority)
**Sprint:** Sprint 6 (filler) OR Sprint 7
**Estimated commits:** 1
**Decision rule:** 6

Status doc capturing ADR-023's 3-layer enforcement decision rationale + the test surface that proves it. ADR-023 implicit closure already exists; this doc makes it explicit.

### Process item for Sprint 6 PM kickoff

Extend PM rubric "wire-protocol vocabulary check" sub-rule to cover spec-corpus identifiers (ORT row IDs, ADR numbers, Promotion Ledger entry IDs, slice PRD section references). Sprint 5 retro deliverable. PM brief at Sprint 6 should include explicit verification of any spec-corpus identifier cited.

Also: PM brief should include `internal canonicalization patterns` check when test depends on internal API contracts (URL canonicalization, header normalization, key formatting). Sprint 5 retro process change #2.

---

## Sprint 7+ — proposed (sequenced through EHBG §10b)

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

### Sprint 5 — closed 2026-05-05

- TLC-013 — Idempotency invariant lockdown (3e37433 + 0f4a757 fix-forward; Codex HIGH closed; re-verify APPROVE)
- TLC-015 — ORT v1.5 testable items audit (1eab1a6; 4 verified-real Sprint 6+ candidates surfaced)

### Sprint 4 — closed 2026-05-05

- TLC-010 — Subscription module skeleton (da597c6; 3rd skeleton-recipe application + 2 wiring tests)
- TLC-012-rescoped — Crisis-detection (I-019) coverage audit + lockdown (be6a2dc; coverage audit doc + 9-case static-analysis lockdown)

### Sprint 3 — closed 2026-05-05

- TLC-007 — Med Interaction module skeleton (2f89661; 3 branded IDs + plugin shell + 2 wiring tests)
- TLC-009 — Tenant-config admin-write 503 surface (ad711fb; 5 mutation stubs + readiness probe + 7 tests)
