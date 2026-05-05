# Build vs Spec Traceability Matrix

**Living artifact** — amend in place when re-run; bump revision-line below.

**Revision history:**
- **r1 (2026-05-05, Sprint 6 / TLC-017):** initial consolidation. Maps each implemented invariant / slice / module / state-machine to the test files covering it. Cross-links existing per-slice status docs.
- **r2 (2026-05-05, Sprint 7):** absorbs **TLC-019 descope** — adds OR-208 back-link as the canonical closure path for "Data-level filtering implementation choice" (this matrix's §1 I-023 row + §2 lib rows already document ADR-023's 3-layer enforcement decision). Also documents **TLC-018 perf scaffold landing** (`tests/perf/`) per OR-218 — but OR-218 itself remains **OPEN** because non-blocking bench harness without enforceable thresholds cannot serve as the launch-blocking gate the ORT row demands (Codex `perf-bench-r1` HIGH closure 2026-05-05).

**Closes:**
- ORT row **OR-216** ("Build vs spec traceability matrix"; verified at `Telecheck_Operational_Readiness_Todo_v1_5.md:127`)
- ORT row **OR-208** ("Data-level filtering implementation choice (RLS vs view vs app-layer)"; verified at `Telecheck_Operational_Readiness_Todo_v1_5.md:119`) — **absorbed via this matrix; TLC-019 descoped at Sprint 7 PM kickoff** because §1 I-023 row + §2 `tenant-context.ts` / `rls.ts` / `kms.ts` rows already document ADR-023's 3-layer enforcement decision rationale + the test surface that proves it.

**Scaffolds (NOT closes):**
- ORT row **OR-218** ("Performance and load test plan"; `Telecheck_Operational_Readiness_Todo_v1_5.md:129`) — **OPEN**. Sprint 7 / TLC-018 scaffolded `tests/perf/` infra with 1 example bench (`tests/perf/audit/crisis-detect.bench.ts` + `tests/perf/README.md`). Closure path per Sprint 7 retro: Sprint 11 hardening adds (1) explicit p95 thresholds per bench, (2) wires `npm run bench` into CI as required gate, (3) baseline comparison output for regression detection. Until those three conditions hold, OR-218 stays OPEN in the ORT.

**Author:** Scrum Master (Claude Code main turn)
**Source-of-truth pointers:**
- Invariants list: `Telecheck_Contracts_Pack_v5_00_INVARIANTS.md` (v5.2; 22 active + 3 added v1.10 cycle = 25 active platform invariants)
- Slice PRDs: `Telecheck_*_Slice_PRD_v*.md` in the spec corpus
- ADRs: `Telecheck_ADR_Set_v1_0.md` + Addendums 016-019, 020-025, 026, 027, 028, 029
- This repo's per-slice status docs at `docs/*_SLICE_STATUS_2026-05-05.md`

---

## §1 — Platform Invariants → Test Coverage

For each invariant: cited canonical name, test files covering it, and current coverage state. Invariants not yet active in this repo (because the slice that exercises them isn't authored) are marked `BLOCKED` with the blocker reference.

| Inv. ID | Canonical name | Test coverage | State |
| --- | --- | --- | --- |
| **I-003** | Audit append-only (no UPDATE / no DELETE; hash chain integrity) | `tests/integration/audit-chain.test.ts` (330 LOC; 6 describe blocks) + `tests/integration/audit-chain-walker.test.ts` (869 LOC; HIGH-1 broken-link, HIGH-1 forged-genesis, HIGH-2 record-hash tampering closures asserted) + `tests/invariants/i003-audit-append-only.test.ts` + `tests/integration/consent-audit-chain.test.ts` | ✅ comprehensive |
| **I-009** | No hardcoded country assumptions; CCR drives all country-conditional config | `tests/integration/tenant-config-resolver.test.ts` + `tests/integration/tenant-config-http.test.ts` + cross-tenant tests assert different country profiles | ✅ comprehensive |
| **I-012** | Reject-unless three-clause rule for prescription/refill/medication-order execution | `tests/state-machines/i012-prescribing.test.ts` | ✅ comprehensive (gate test exists; functional execution BLOCKED on SI-001 — no MedicationRequest schema yet) |
| **I-014** | Canonical vocabulary enforced (forbidden aliases caught) | `tests/contracts/canonical-glossary.test.ts` (static source-grep pattern) + `tests/integration/glossary.test.ts` | ✅ comprehensive |
| **I-016** | Idempotency keys tenant-scoped (4-tuple PK: tenant + key + endpoint + actor) | `tests/integration/idempotency-http.test.ts` (cross-tenant case + TTL expiry case + actor case + endpoint case + body-mismatch case + missing-key case + replay case = full IDEMPOTENCY v5.1 coverage post-Sprint 5 TLC-013) | ✅ comprehensive |
| **I-019** | Crisis detection platform-floor (every free-text patient-input scans before persistence) | `tests/invariants/i019-crisis-detection.test.ts` + `tests/integration/crisis-detection.test.ts` + `tests/integration/forms-intake-submission.test.ts:890+` (CRITICAL-1 closure) + `tests/integration/forms-intake-submission.test.ts:1098+` (recursive scan closure) + `tests/contracts/crisis-detection-coverage-lockdown.test.ts` (Sprint 4 TLC-012-rescoped) | ✅ comprehensive (functional + structural lockdown) |
| **I-023** | Tenant isolation enforced at three layers (RLS + app-layer + per-tenant KMS) | `tests/invariants/i023-tenant-isolation.test.ts` (functional 3-layer tests) + `tests/contracts/rls-policy-coverage-lockdown.test.ts` (Sprint 6 TLC-016: 21 tenant-scoped tables × 3 assertions + count drift detection + platform-level exclusion) + `tests/integration/identity-cross-tenant-isolation.test.ts` (Sprint 1 TLC-002) + `tests/integration/consent-cross-tenant-isolation.test.ts` + `tests/integration/tenant-config-cross-tenant-isolation.test.ts` + `tests/integration/tenant-config-admin-http.test.ts:§4b` | ✅ comprehensive (post-Sprint 6) |
| **I-024** | Cross-tenant access requires break-glass with audit | `tests/integration/identity-cross-tenant-isolation.test.ts` asserts no spurious audit emission in attacking tenant | ⚠️ partial — break-glass workflow itself is BLOCKED on Admin Backend slice v1.1 (TLC-009 already pre-paved 503 surface) |
| **I-025** | Error responses do not leak cross-tenant existence (tenant-blind 404) | `tests/integration/error-envelope-http.test.ts` + `tests/integration/consent-error-envelope-tenant-blind.test.ts` + `tests/integration/idempotency-http.test.ts` (asserts no tenant_id leakage in error paths) | ✅ comprehensive |
| **I-026** | Tenant `country_of_care` is treated as immutable post-creation | `tests/integration/tenant-config-migration.test.ts` + `tests/integration/tenant-config-resolver.test.ts` | ✅ comprehensive |
| **I-027** | Audit records carry tenant_id always | `tests/integration/audit-emit.test.ts` + `tests/integration/audit-chain.test.ts` | ✅ comprehensive |
| **I-029** | Research export 6-condition reject-unless gate (DSA + k-anonymity + permitted-domain + consent-cohort + per-patient consent + per-export grant) | `tests/state-machines/i029-research-export.test.ts` | ⚠️ gate test exists but research-data-partnership module is BLOCKED at `inactive` per ADR-028 v0.5 (CCR launch default; activation requires REC partnership + consent text + DSA template per OR-116/117/118) |
| **I-030** | Asymmetric retraction language for 5th-tier consent (separately revocable; no care impact) | (covered transitively via consent module + research export gate; no dedicated test yet) | ⚠️ partial — research data partnership blocked at inactive; full coverage when activation lands |
| **I-031** | Research data export emits at `audit_sensitivity_level: high_pii` | (covered transitively via i029-research-export gate test) | ⚠️ partial — same blocker as I-029/I-030 |

**Invariants not yet active in this repo** (slice not authored OR upstream blocker):
- I-001 (single physical region per tenant) — operational; ADR-026 sets us-east-1 primary + us-west-2 cold DR
- I-002 (data residency by `country_of_care`) — operational; CCR-driven
- I-004..I-008, I-010..I-011, I-013, I-015, I-017..I-018, I-020..I-022, I-028 — see Contracts Pack v5.2 INVARIANTS for current state; not yet asserted in this repo's tests because the slices that exercise them aren't authored

---

## §2 — Slice / Module → Implementation State

For each slice / module: status, public-interface entry point, test files covering it, and pointer to per-slice status doc.

### Implementation-complete slices (v1.0 done)

| Slice | Plugin entry point | Status doc | Key test files |
| --- | --- | --- | --- |
| **Forms-Intake Engine** | `src/modules/forms-intake/index.ts` | `docs/FORMS_INTAKE_SLICE_STATUS_2026-05-05.md` | forms-intake-templates-http / -deployments-http / -submissions-http / -submission / -resume-http / -snapshot-http / -variants-http / -governance-emit / -events / -admin / -pause / -restore / -publish |
| **Identity & Auth** | `src/modules/identity/plugin.ts` | `docs/IDENTITY_SLICE_STATUS_2026-05-05.md` | identity-{login,registration,devices,accounts-me}-http + identity-{account,session,otp,auth-device}-{repo,service} + identity-jwt-end-to-end + identity-domain-events + identity-cross-tenant-isolation + identity-plugin-wiring |
| **Consent + Delegation** | `src/modules/consent/plugin.ts` | `docs/CONSENT_SLICE_STATUS_2026-05-05.md` | consent-http + consent-service + consent-domain-events + consent-audit-chain + consent-cross-tenant-isolation + consent-error-envelope-tenant-blind + consent-idempotency-replay + consent-migration + consent-plugin-wiring + delegation-http + delegation-service + delegation-http-coverage-gaps + delegations-migration |

### Foundation modules

| Module | Plugin entry point | Test files |
| --- | --- | --- |
| **Tenant-config (read + 503 write)** | `src/modules/tenant-config/plugin.ts` | tenant-config-{http,resolver,migration,admin-http,admin-write-blocked,cross-tenant-isolation,plugin-wiring} |

### BLOCKED-aware module skeletons (ship at v0.1 with /health 200 + /ready 503)

| Module | Plugin entry point | Blocker | Test file |
| --- | --- | --- | --- |
| **Pharmacy** | `src/modules/pharmacy/plugin.ts` | SI-001 (MedicationRequest schema) | pharmacy-plugin-wiring.test.ts |
| **Med Interaction** | `src/modules/med-interaction/index.ts` | Med Interaction Engine slice PRD ratification | med-interaction-plugin-wiring.test.ts |
| **Subscription** | `src/modules/subscription/index.ts` | SI-001 (Subscription binds to MedicationRequest) | subscription-plugin-wiring.test.ts |

### Foundation libraries (`src/lib/`)

| Library | Test files | Notes |
| --- | --- | --- |
| `audit.ts` (Category A/B/C audit emission) | audit-emit + audit-chain + audit-chain-walker | Hash chain integrity comprehensively covered |
| `crisis-detection.ts` (I-019 platform-floor singleton) | crisis-detection + crisis-detection-coverage-lockdown | Functional + structural lockdown |
| `error-envelope.ts` (I-025 tenant-blind error envelopes) | error-envelope + error-envelope-helpers + error-envelope-http + tenant-blind variants in slice tests | |
| `idempotency.ts` (IDEMPOTENCY v5.1 4-tuple PK) | idempotency-http (post-Sprint 5 TLC-013: full invariant coverage incl. cross-tenant + TTL expiry) | |
| `tenant-context.ts` (I-023 Layer 2 app-layer filtering) | tenant-context + tenant-context-http + tenant-isolation | |
| `rls.ts` (I-023 Layer 1 RLS helpers) | rls + i023-tenant-isolation + rls-policy-coverage-lockdown (Sprint 6 TLC-016) | |
| `kms.ts` (I-023 Layer 3 per-tenant KMS) | kms | KMS isolation full assertion BLOCKED on Admin Backend slice v1.1 (encryption-at-rest wiring) |
| `auth-context.ts` (Tier 1 JWT-based actor context) | covered transitively via slice integration tests | |
| `ai-context.ts` (req.aiContext decorator) | ai-context | Tested in isolation; AI-call surfaces depend on Mode 1 / Mode 2 slice |
| `glossary.ts` (canonical type brands) | glossary + canonical-glossary | I-014 enforced |
| `config.ts` (env validation) | config | |
| `db.ts` (pg client) | db-transaction | |
| `logger.ts` (PHI-redacting pino) | logger + logger-env-extension | |

---

## §3 — State Machines → Test Coverage

| State Machine | Test file | State |
| --- | --- | --- |
| Forms submission lifecycle | tests/integration/forms-intake-submission* | ✅ comprehensive |
| Forms template publish gate | tests/integration/forms-intake-publish | ✅ |
| Forms deployment lifecycle | tests/integration/forms-intake-deployments-http | ✅ |
| Forms variant lifecycle | tests/integration/forms-intake-variants-http + forms-intake-events | ✅ |
| Resume token (signed pause/resume) | tests/integration/resume-token + forms-intake-resume + forms-intake-resume-http | ✅ |
| Identity account / session / OTP / device | tests/integration/identity-{account,session,otp,auth-device}-* | ✅ |
| Consent grant / revoke | tests/integration/consent-service + consent-http | ✅ |
| Delegation invite / accept / revoke | tests/integration/delegation-service + delegation-http | ✅ |
| **I-012 prescribing reject-unless gate** | tests/state-machines/i012-prescribing | ✅ gate; functional BLOCKED on SI-001 |
| **I-029 research-export 6-condition gate** | tests/state-machines/i029-research-export | ✅ gate; functional BLOCKED on ADR-028 activation |
| Pharmacy MedicationRequest / Refill / Dispensing / Shipment | — (skeleton only) | BLOCKED on SI-001 |
| Med Interaction signal / override / ruleset | — (skeleton only) | BLOCKED on slice PRD |
| Subscription pause / resume / cancel / switch | — (skeleton only) | BLOCKED on SI-001 |

---

## §4 — Open Spec Issues (upstream-blocking)

Per `docs/SI-*.md` in this repo:

| Spec Issue | What it blocks | Status |
| --- | --- | --- |
| **SI-001** | MedicationRequest schema (CDM v1.2 §4); blocks Slice 4 Pharmacy + Subscription full implementation | OPEN — Promotion Ledger pending P-011 |
| **SI-002** | AUDIT_EVENTS placeholder ratification | OPEN — pending P-012 |
| **SI-003** | DOMAIN_EVENTS placeholder ratification | OPEN — pending P-013 |

Spec corpus latest entry verified at `Telecheck_Promotion_Ledger.md:40` is **P-010** (CDM §4.1 reconciliation; 2026-05-02). No P-011/012/013 — all three SIs remain open.

---

## §5 — Coverage gaps (sequenced by Sprint 7+ candidate priority)

Per Sprint 5 TLC-015 ORT audit + Sprint 6 author analysis:

| Gap | Closure path | Sprint candidate |
| --- | --- | --- |
| Foundation-layer perf budgets (idempotency, audit, RLS) | OR-218; depends on perf measurement infra | TLC-018 (Sprint 7) |
| Data-filtering implementation status doc | OR-208; ADR-023 implicit closure already exists; doc makes it explicit | TLC-019 (Sprint 7 filler) |
| Slice 4 Pharmacy schema + module + tests | Depends on SI-001 closure upstream | Sprint 7+ if SI-001 closes; Sprint 4-6 of EHBG §10b otherwise |
| Async Consult slice | Slice PRD authoring required; not yet started | Sprint 7+ per EHBG §10b |
| Sync Video Consult + LiveKit + AI Scribe | Slice PRD + LiveKit production deployment | Sprint 8 per EHBG §10b |
| Labs + AWS Textract Medical | Slice PRD authoring | Sprint 9 per EHBG §10b |
| Adverse Event + RPM/CCM | Slice PRD authoring | Sprint 10 per EHBG §10b |
| Pen test + accessibility audit + perf budget verification | Counsel + UI/UX work; partly out-of-repo | Sprint 11 hardening |

---

## §6 — Cumulative metrics

**As of Sprint 7 close (`d677fd3` TLC-018 + `d879a79` Codex HIGH fix-forward + r2 amend):**

- **Slices (implementation-complete):** 3 (Forms-Intake, Identity, Consent + Delegation)
- **Foundation modules:** 2 (tenant-config: 4 admin reads + 5 admin-write 503 stubs + readiness probe; pharmacy skeleton — but pharmacy is technically a BLOCKED-aware skeleton)
- **BLOCKED-aware skeletons:** 3 (pharmacy, med-interaction, subscription)
- **Branded ID types defined:** 11 (5 pharmacy + 3 med-interaction + 3 subscription) — downstream slices can typed-import without waiting on schema authoring
- **Forward migrations:** 18 (000-019)
- **Rollback migrations:** 18 (matched-pair coverage)
- **Domain events wired with explicit outbox tests:** 31 of 31
- **Active platform invariants:** 25 (I-001 base + 3 added v1.10 cycle as I-029/030/031); 13 fully covered, 4 partially covered (I-024 / I-029 / I-030 / I-031 — blocked on slice activations), 8+ not yet active in this repo (slice-dependent)
- **Test files (rough count):** ~107 (added rls-policy-coverage-lockdown.test.ts in Sprint 6 + tests/perf/audit/crisis-detect.bench.ts in Sprint 7)
- **Test cases (rough count):** ~1470+ (Sprint 6 added 46 from TLC-016; Sprint 7 added bench scenarios that count separately as 4 bench cases, not test cases)
- **Bench scenarios (Sprint 7 TLC-018):** 4 (§1-§4 in `tests/perf/audit/crisis-detect.bench.ts`)
- **Codex findings closed across all sprints:** 4 (1 Sprint 1 MEDIUM `pharmacy-blocked-handler` / 1 Sprint 5 HIGH `idempotency-r5` / 1 Sprint 6 MEDIUM `rls-policy-r1` / 1 Sprint 7 HIGH `perf-bench-r1`); each closed in-sprint via fix-forward; each surfaced a real bug class the SM had not caught
- **Audit / coverage docs (living artifacts):** 3 (CRISIS_DETECTION_COVERAGE_AUDIT.md, ORT_V1_5_TESTABLE_ITEMS_AUDIT.md, BUILD_VS_SPEC_TRACEABILITY_MATRIX.md — this doc; r2 at Sprint 7)
- **PM-brief verification gate runs:** 2 inaugural runs (Sprint 6 + Sprint 7); both ALL PASS — the Sprint 3 + Sprint 5 hallucination class has not recurred since the gate was instituted at `804c294` (Evans 2026-05-05 oversight directive)

---

## Sprint reference

Authored Sprint 6 (TLC-017) on the autonomous Scrum cycle. Closes ORT row OR-216 ("Build vs spec traceability matrix"). PM-brief verification gate (Evans 2026-05-05 oversight directive) ran at Sprint 6 kickoff and passed cleanly — first sprint without an identifier hallucination since the gate was instituted.
