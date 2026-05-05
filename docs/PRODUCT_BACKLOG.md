# Product Backlog — Telecheck-app

**Owner:** project-manager agent
**Last reviewed:** 2026-05-05 (Sprint 4 close → Sprint 5 kickoff prep)
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

## Sprint 5 — proposed (PM confirms at Sprint 5 kickoff)

### TLC-013 — Idempotency invariant (I-016) regression test

**Status:** todo (candidate; PM verifies coverage at kickoff)
**Sprint:** Sprint 5
**Estimated commits:** 1-2
**Decision rule:** 3 (diminishing-returns hygiene)

PM verify-before-authoring at kickoff: grep `tests/integration/idempotency*.test.ts` for existing coverage of I-016 invariants (tenant-scoped key namespacing per IDEMPOTENCY v5.1; replay returns identical response; idempotency-key TTL enforced). Author only the genuine gaps; descope if covered.

### TLC-014 — Tenant-isolation regression for tenant-config admin reads

**Status:** todo (candidate; PM verifies at kickoff)
**Sprint:** Sprint 5
**Estimated commits:** 0-1

PM verify-before-authoring: check whether `tests/integration/tenant-config-admin-http.test.ts` §4b cross-tenant case + the existing 9 cases sufficiently cover the admin GET surface. Likely descope candidate.

### TLC-015 — ORT v1.5 launch-readiness items audit (research)

**Status:** todo (candidate)
**Sprint:** Sprint 5
**Estimated commits:** 1 (research) + variable (Sprint 6+ depends on findings)

PM reads `Telecheck_Operational_Readiness_Tracker_v1_5.md` and surfaces which items are testable in this repo (e.g., "rate limiting configured", "idempotency keys tenant-scoped", "audit-chain genesis hash documented"). Output document determines Sprint 6+ work. Research-shaped first; execution scope determined by audit output.

### Process item for Sprint 5 PM kickoff

PM should propose convention for coverage-audit doc filenames: rename to non-dated single living doc OR establish `docs/audits/` folder with dated artifacts. Currently `docs/CRISIS_DETECTION_COVERAGE_AUDIT_2026-05-05.md` is date-stamped but it's intended as a living artifact.

---

## Sprint 6+ — proposed (sequenced through EHBG §10b)

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

### Sprint 4 — closed 2026-05-05

- TLC-010 — Subscription module skeleton (da597c6; 3rd skeleton-recipe application + 2 wiring tests)
- TLC-012-rescoped — Crisis-detection (I-019) coverage audit + lockdown (be6a2dc; coverage audit doc + 9-case static-analysis lockdown)

### Sprint 3 — closed 2026-05-05

- TLC-007 — Med Interaction module skeleton (2f89661; 3 branded IDs + plugin shell + 2 wiring tests)
- TLC-009 — Tenant-config admin-write 503 surface (ad711fb; 5 mutation stubs + readiness probe + 7 tests)

### Sprint 2 — closed 2026-05-05

- TLC-004 — Tenant-config Admin Backend read handlers (f12a142; 4 GET routes + 9 tests + adapter-config-repo + ADR-024 redaction view)
- TLC-006 — Forms-intake operator-edit emit-site wiring (8a0956a; 2 parallel domain-event emitters + 4 envelope-shape tests; chose option (b) lighter path)
