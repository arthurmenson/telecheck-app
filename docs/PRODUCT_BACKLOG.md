# Product Backlog — Telecheck-app

**Owner:** project-manager agent
**Last reviewed:** 2026-05-05 (Sprint 1 kickoff)
**Story format:** `TLC-NNN — title`

---

## Sprint 2 — committed (kickoff 2026-05-05)

### TLC-004 — Tenant-config Admin Backend read handlers

**Status:** todo
**Sprint:** Sprint 2
**Estimated commits:** 5
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

**Status:** todo
**Sprint:** Sprint 2
**Estimated commits:** 3
**Decision rule:** 3 (diminishing-returns hygiene)

#### Current state baseline (verified 2026-05-05 by PM)

- `emitFormsEligibilityLogicEdited` + `emitFormsApprovalGovernanceEdited` exist in `audit.ts:503,540`
- ZERO callers in `src/` — emitters preserved for spec compliance
- ZERO tests in `tests/` — genuine coverage gap

#### Acceptance criteria

- Either (a) wire emitters into `template-service.editEligibilityLogic` + `editApprovalGovernance` operator surfaces OR (b) document as "no consumer yet" and add direct-call envelope-shape unit tests covering Category B + audit_sensitivity_level (scrum master picks lighter path)
- Author parallel domain-event emitters: `forms_eligibility_logic.edited`, `forms_approval_governance.edited`
- Outbox-landing tests for both events in `forms-intake-events.test.ts`

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

## Sprint 3+ — proposed (sequenced through EHBG §10b)

| Sprint | EHBG mapping                                                     | Indicative stories                                                                                                                                                                                                        |
| ------ | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 3      | (Pharmacy if SI-001 closes) OR Med Interaction Engine slice prep | TLC-007 Med Interaction signals contract; TLC-008 InteractionOverride entity scaffold                                                                                                                                     |
| 4      | Pharmacy + Refill v2.X part 1                                    | TLC-009 Refill state machine; TLC-010 Pharmacy adapter framework + first US adapter                                                                                                                                       |
| 5      | Pharmacy + Refill part 2 + Subscription                          | TLC-011 Subscription model + state machine; TLC-012 ProductCatalog scaffold                                                                                                                                               |
| 6      | Pharmacy + Refill part 3 + Admin Backend part 1                  | TLC-013 Pause/resume/switch/cancel flows; TLC-014 Admin Backend Platform Admin tenant management UI                                                                                                                       |
| 7      | Async Consult + Admin Backend part 2                             | TLC-015 Async consult workflow; TLC-016 Admin Backend Tenant Admin subscription/refill management                                                                                                                         |
| 8      | Sync Video Consult + Admin Backend part 3                        | TLC-017 LiveKit integration; TLC-018 AI Scribe; TLC-019 Admin Backend catalog/pricing/discount                                                                                                                            |
| 9      | Labs + Admin Backend part 4                                      | TLC-020 Labs upload + AWS Textract; TLC-021 Admin Backend affiliate MVP                                                                                                                                                   |
| 10     | Adverse Event + RPM/CCM                                          | TLC-022 Adverse event detection; TLC-023 RPM/CCM model + alerts                                                                                                                                                           |
| 11     | Hardening + Launch prep                                          | TLC-024 Performance optimization; TLC-025 Security hardening; TLC-026 Accessibility audit; TLC-027 Telecheck-Ghana launch readiness; TLC-028 Telecheck-US (Heros Health DBA) launch readiness; TLC-029 Runbooks finalized |

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

(empty until first sprint review)
