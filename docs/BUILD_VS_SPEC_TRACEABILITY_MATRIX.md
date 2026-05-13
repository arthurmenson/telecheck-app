# Build vs Spec Traceability Matrix

**Living artifact** — amend in place when re-run; bump revision-line below.

**Revision history:**
- **r6 (2026-05-12, Sprint 35 / SI-001 RATIFIED + Pharmacy scaffold rebuild):** SI-001 MedicationRequest schema gap CLOSED via Promotion Ledger entry P-011 (spec corpus commit `879cd57` in `arthurmenson/telecheckONE`; ratified 2026-05-11 after 11 rounds of Codex pre-ratification convergence + 11 rounds of post-merge convergence; 42 findings closed inline across both gates). Pharmacy + Refill v2.1 scaffold landed via this branch's PR (the PR #95 / PR #108 successor): migration 025_medication_requests.sql (Path 1 shape — no `interaction_override_id`; 14 CHECK constraints + 6 composite FKs + 5 indexes + 2 partial UNIQUE indexes; canonical `mrx_<ULID>` pattern enforced at DB layer; state-dependent protocol-binding + interaction-evaluation safety gates; supersession-chain integrity invariants). src/lib/audit.ts bumped AUDIT_EVENTS v5.2 → v5.3 with action-scoped sentinel + actor_type validation. src/modules/pharmacy/internal/state-machine.ts implements State Machines v1.2 §19 with discriminated-union I-012 guard + PendingTransitionContext bound-row attestations + canonical AUDIT_EVENTS v5.3 action IDs. 12 rounds of pre-PR Codex convergence on the scaffold itself; 15 additional findings closed inline + 1 deferred-to-write-path with TLC-055 acceptance criterion (supersession reciprocity constraint trigger).
  - **SI-001 CLOSED:** 5 withdraw-ratification findings + 15 pre-PR-gate findings + 22 spec-corpus post-merge findings = ~42 substantive findings closed inline across the full ratification cycle. The 2026-05-11 first ratification attempt (PRs #95 + #108) was reverted via PR #109; the 2026-05-12 re-ratification supersedes both reverted PRs with the v0.13 RATIFIED state.
  - **State Machines §19 added to canonical State Machines v1.2:** 8 active states; 13 transitions; 2 I-012-gated routes into `active` (clinician_approve and protocol_authorized_prescribing); both routes emit canonical `medication_request.approved.v1` domain event with discriminating `approval_pathway` field.
  - **AUDIT_EVENTS v5.3 amendments:** 7 net-new Category A action IDs (6 medication_request.* + 1 prescribing.protocol_authorization_granted); §I-012 closure rule authoritative set extended with prescribing.protocol_authorization_granted.
  - **`Telecheck-{country}` operating-tenant identifier discipline:** preserved through the spec corpus push.
  - **Cumulative Codex closures across Sprint 35 SI-001 ratification:** ~42 substantive findings (5 withdraw-ratification + 15 spec-corpus pre-ratification + 22 spec-corpus post-merge + 15 pharmacy-scaffold pre-PR + 1 deferred-to-write-path). Long-tail asymptote pattern matched the v1.10.1 hygiene cycle.
- **r5 (2026-05-08, Sprint 33-34 / SI-006 reserve-then-execute closure + audit-dedupe SI):** Sprint 33-34 cumulative state amendment. Reflects 9 PRs landed across both sprints (#43-#51).
  - **SI-006 CLOSED:** Idempotency reserve-then-execute redesign fully landed. PR #43 (TTL overrides + reservation/cache TTL split, 4 Codex rounds), #44 (forms-intake migration + crisis-audit independence + cached-4xx-envelope alignment, 5 Codex rounds), #45 (identity migration + sessionRefresh exempt-paths fix, 5 Codex rounds), #46 (tenant-config 503-stub markers, 1 Codex round), #47 (legacy onSend cache-write removal + Group F lockdown, 2 Codex rounds), #48 (cleanup-sweep: delete `markIdempotencyManagedByHandler` no-op + 31 call sites + lockdown extension, 1 Codex round), #49 (audit-dedupe SI: `audit_dedupe_markers` table + `claimAuditDedupeSlot` helper + bodyHash + per-endpoint TTL alignment, 2 Codex rounds), #50 (CI dependency-review advisory until repo Dependency Graph enabled).
  - **Async-consult HTTP coverage gap closed:** PR #51 added `tests/integration/async-consult-http.test.ts` (552 lines, 6 groups, 13 cases — happy path + state-machine guards + auth + body validation + idempotency replay/body-mismatch + PHI projection); 4 Codex rounds (r1→r4) including a CI-revealed handler bug closure. Handler `mapServiceError` extended to map `InvalidTransitionError` + `UnsupportedTransitionError` → tenant-blind 409 (was: 500 leak). `expectNoTenantLeak(response)` shared helper applied to ALL response surfaces (success + every error envelope).
  - **Cumulative Codex closures across Sprint 33-34:** 18 substantive findings (3 HIGH on PR-F1 + 4 HIGH/1 MEDIUM on PR-F2 + 2 HIGH/3 MEDIUM on PR-F3 + 1 MEDIUM on PR-E + 1 HIGH on dedupe r1 + 4 MEDIUMs across PR-51 r2/r3/r4). One originally-deferred HIGH (PR-F2 r4 crash-window duplicate Category A audits) explicitly closed in PR #49 via the cross-cutting `audit_dedupe_markers` table.
  - **§3 state-machine coverage extended:** async-consult lifecycle (initiate / submit / abandon / resume / patient-responds) now has HTTP-surface coverage on top of the prior service-layer + cross-tenant-isolation tests.
  - **Repo-admin pending:** Dependency Graph enablement in `arthurmenson/telecheck-app` Settings → Code security → Dependency graph. Once flipped, the PR #50 advisory `continue-on-error: true` line in `dependency-review.yml` should be removed to re-arm the gate.
- **r1 (2026-05-05, Sprint 6 / TLC-017):** initial consolidation. Maps each implemented invariant / slice / module / state-machine to the test files covering it. Cross-links existing per-slice status docs.
- **r2 (2026-05-05, Sprint 7):** absorbs **TLC-019 descope** — adds OR-208 back-link as the canonical closure path for "Data-level filtering implementation choice" (this matrix's §1 I-023 row + §2 lib rows already document ADR-023's 3-layer enforcement decision). Also documents **TLC-018 perf scaffold landing** (`tests/perf/`) per OR-218 — but OR-218 itself remains **OPEN** because non-blocking bench harness without enforceable thresholds cannot serve as the launch-blocking gate the ORT row demands (Codex `perf-bench-r1` HIGH closure 2026-05-05).
- **r4 (2026-05-06, Sprint 17 / TLC-027 + OR-218 EXECUTE):** OR-218 FULLY CLOSED. Branch protection PUT landed on main (commit-author Evans via autonomous-Claude-on-Evans-behalf 2026-05-06). Required contexts: `Run benchmarks + threshold check + baseline comparison` + `verify-metadata`. TLC-027 EXECUTE landed via PR #9 closing Codex r10/r11/r12/r13 (4 rounds; 8 findings) — Codex r14 APPROVED clean. Cumulative Codex closures: 47 (26 HIGH + 21 MEDIUM); 2 finding-classes escalated then closed (TLC-024→TLC-026 Sprint 13; TLC-025→TLC-027 Sprint 17). 12 consecutive PM-brief verification gate ALL PASS. Repo flipped public (Evans 2026-05-06) to enable branch protection on free GitHub plan. ORT row OR-218 status: **FULLY CLOSED**.
- **r3 (2026-05-05, Sprint 16 / TLC-029):** Sprint 13/14/15 cumulative state amendment.
  - **OR-218 status:** OPEN; closure path BUILT in-sprint via Sprint 13 / TLC-026 (manifest-check helper + self-test + machine-enforced `baseline-refresh-guard.yml` workflow) — Codex r5→r6→r7→r8 fix-forward chain converged at r9 APPROVED clean. Execution awaits Evans-side `gh api` PUT + 3-5 stable `perf.yml` main runs (Evans Option A constraint per `docs/TLC-023c-BRANCH-PROTECTION-WIRE-UP.md` §1 + §2.1).
  - **2nd Codex finding-class ESCALATED:** TLC-025 r10 → Sprint 15+ TLC-027 (DB-backed bench infra rebuild; first-ever HIGH-severity escalation; pending Postgres availability per `docs/TLC-027-DB-BENCH-INFRA-ESCALATION.md`).
  - **Cumulative Codex closures:** 39 (23 HIGH + 16 MEDIUM); 2 finding-classes escalated (1 closed Sprint 13; 1 pending Sprint 15+).
  - **PROJECT_CONVENTIONS.md bumped r1 → r2** (Sprint 15 / TLC-028) with §5.4 closure-path-overclaim pre-emption pattern + §5.5 structural-constraint-not-code-defect escalation pattern + §6 sub-rule 5 environment-dependency check (PM rubric raised 4 → 5 sub-rules; first new sub-rule since Sprint 6 baseline). SCRUM_OPERATING_MODEL.md amended with three-way differentiated commit-budget calibration ("executable here" / "needs env" PLAN-ONLY / "needs env" EXECUTE).
  - **11 consecutive PM-brief verification gate ALL PASS** (since gate instituted at `804c294` Sprint 6).
  - **3 consecutive env-blocked sprints** (Sprint 13 closure-path / Sprint 14 escalation / Sprint 15 doc codification) — Sprint 16 retro tracks the pattern; surface to Evans when reachable.

**Closes:**
- ORT row **OR-216** ("Build vs spec traceability matrix"; verified at `Telecheck_Operational_Readiness_Todo_v1_5.md:127`)
- ORT row **OR-208** ("Data-level filtering implementation choice (RLS vs view vs app-layer)"; verified at `Telecheck_Operational_Readiness_Todo_v1_5.md:119`) — **absorbed via this matrix; TLC-019 descoped at Sprint 7 PM kickoff** because §1 I-023 row + §2 `tenant-context.ts` / `rls.ts` / `kms.ts` rows already document ADR-023's 3-layer enforcement decision rationale + the test surface that proves it.

**Closes (Sprint 17 r4 amendment 2026-05-06):**
- ORT row **OR-218** ("Performance and load test plan"; `Telecheck_Operational_Readiness_Todo_v1_5.md:129`) — **FULLY CLOSED 2026-05-06**. Sprint 7 / TLC-018 scaffolded `tests/perf/` infra. Sprint 11 / TLC-023a/b landed thresholds + `perf.yml` workflow. Sprint 12 / TLC-024 added `validateTransition` bench scenarios + TLC-023c handoff doc. Sprint 13 / TLC-026 landed in-sprint enforceable code: manifest-check helper + self-test mode (`tests/perf/check-thresholds.ts`) + machine-enforced baseline-refresh metadata guard (`.github/workflows/baseline-refresh-guard.yml` with full-line anchored regex + GH API validation + triple-dot merge-base diff + always-run + early-exit). Sprint 17 / TLC-027 EXECUTE landed bench-mode ephemeral-Postgres infrastructure (real `setBenchPool()` in `src/lib/db.ts`; constrained `telecheck_bench_app` role; atomic migration tracking; canonicalized URL collision guard via `pg-connection-string` parser). **OR-218 EXECUTE 2026-05-06**: branch protection installed via `gh api -X PUT repos/arthurmenson/telecheck-app/branches/main/protection` with required contexts `Run benchmarks + threshold check + baseline comparison` + `verify-metadata`; `strict: true`, `enforce_admins: false`, `allow_force_pushes: false`. Verified via independent GET. Repo flipped public (Evans 2026-05-06) to enable branch protection on free GitHub plan. Activation log in `docs/TLC-023c-BRANCH-PROTECTION-WIRE-UP.md`.

**Sprint 15+ pending escalation (NEW r3):**
- **TLC-027 (escalated from TLC-025 Sprint 14):** DB-backed bench infra rebuild — bench-mode ephemeral Postgres setup with real `pg.Pool` override (replacing `setTestPool()` savepoint translation that breaks `pg_advisory_xact_lock` lifetime semantics for the planned `emitAudit` bench). Acceptance criteria documented in `docs/TLC-027-DB-BENCH-INFRA-ESCALATION.md`. Pending Sprint 15+ env with Postgres availability.

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
| **I-003** | Audit append-only (no UPDATE / no DELETE; hash chain integrity) | `tests/integration/audit-chain.test.ts` (330 LOC; 6 describe blocks) + `tests/integration/audit-chain-walker.test.ts` (869 LOC; HIGH-1 broken-link, HIGH-1 forged-genesis, HIGH-2 record-hash tampering closures asserted) + `tests/invariants/i003-audit-append-only.test.ts` + `tests/integration/consent-audit-chain.test.ts` + **`tests/integration/audit-dedupe.test.ts`** (Sprint 34 / PR #49: 7 groups covering claim semantics + auditAction discrimination + cross-tenant isolation + purge-expired + bodyHash discrimination + post-cache-expiry-different-body) | ✅ comprehensive (Sprint 34 added crash-window duplicate-Category-A protection via `audit_dedupe_markers` cross-cutting infra; closes PR-F2 r4 deferred HIGH) |
| **I-009** | No hardcoded country assumptions; CCR drives all country-conditional config | `tests/integration/tenant-config-resolver.test.ts` + `tests/integration/tenant-config-http.test.ts` + cross-tenant tests assert different country profiles | ✅ comprehensive |
| **I-012** | Reject-unless three-clause rule for prescription/refill/medication-order execution | `tests/state-machines/i012-prescribing.test.ts` | ✅ comprehensive (gate test exists; functional execution BLOCKED on SI-001 — no MedicationRequest schema yet) |
| **I-014** | Canonical vocabulary enforced (forbidden aliases caught) | `tests/contracts/canonical-glossary.test.ts` (static source-grep pattern) + `tests/integration/glossary.test.ts` | ✅ comprehensive |
| **I-016** | Idempotency keys tenant-scoped (4-tuple PK: tenant + key + endpoint + actor) | `tests/integration/idempotency-http.test.ts` (cross-tenant + TTL-expiry + actor + endpoint + body-mismatch + missing-key + replay) + **`tests/integration/idempotency-helper.test.ts`** (Sprint 32 / PR #42: 6 Group A-F cases — same-body race / body-mismatch race / rollback cleanup / expired-row recovery / in-flight detection / **Group F source-grep lockdown** pinning absence of `addHook('onSend')` + `storeIdempotencyRecord` + `_idempotencyKey` stash + `_idempotencyManagedByHandler` flag-read + `markIdempotencyManagedByHandler` identifier post Sprint 33-34 onSend removal + cleanup-sweep) + **`tests/contracts/idempotency-actor-scoping-lockdown.test.ts`** (Sprint 26 TLC-048 actor-scoping HIGH closure) | ✅ comprehensive (post Sprint 33-34: reserve-then-execute is the only path; legacy onSend writer + helper flag both removed under source-grep lockdown; per-endpoint TTL overrides aligned to JWT TTL for auth-flow paths; reservation-lock vs cached-response TTL split prevents stuck-handler dup-execute) |
| **I-019** | Crisis detection platform-floor (every free-text patient-input scans before persistence) | `tests/invariants/i019-crisis-detection.test.ts` + `tests/integration/crisis-detection.test.ts` + `tests/integration/forms-intake-submission.test.ts:890+` (CRITICAL-1 closure) + `tests/integration/forms-intake-submission.test.ts:1098+` (recursive scan closure) + `tests/contracts/crisis-detection-coverage-lockdown.test.ts` (Sprint 4 TLC-012-rescoped) + **Sprint 34 audit-durability hardening:** `runCrisisGate` now (a) emits Category A audit on a fresh INDEPENDENT tx (PR #44 r2 — closes the rolled-back-with-handler-tx HIGH); (b) returns cached 4xx instead of throwing (PR #44 r3 — closes the duplicate-emit-on-retry exactly-once HIGH); (c) claims a `audit_dedupe_markers` slot before emit when `idempotencyCtx` is forwarded by the handler (PR #49 — closes the crash-window duplicate-emit HIGH) | ✅ comprehensive (functional + structural lockdown + crash-window dedupe) |
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
| **Async Consult** | `src/modules/async-consult/plugin.ts` | (per-slice status doc not yet authored; covered in this matrix §3 row) | async-consult-cross-tenant-isolation + async-consult-plugin-wiring + **async-consult-http** (Sprint 34 / PR #51: 6 groups, 13 cases — happy-path + state-machine guards + auth + body validation + idempotency replay/body-mismatch + PHI projection) |

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
| `idempotency.ts` (IDEMPOTENCY v5.1 4-tuple PK; reserve-then-execute pattern) | idempotency-http + **idempotency-helper** (Sprint 32 PR-D Group A-F + Sprint 33 PR-E lockdown extension + Sprint 34 cleanup-sweep helper-deletion lockdown) + idempotency-actor-scoping-lockdown | Sprint 33-34 closed SI-006: legacy onSend cache-write removed; per-endpoint TTL overrides aligned to JWT TTL; reservation-lock vs cached-response TTL split; bodyHash-discriminated audit-dedupe markers for I-019 durability |
| `idempotent-handler.ts` (`withIdempotentExecution` shared helper) | covered transitively via every migrated slice's HTTP test | Body callback signature widened to `(tx, idempotencyCtx)` in Sprint 34 / PR #49 so handlers can forward ctx into service-layer audit-dedupe claims |
| `audit-dedupe.ts` (Sprint 34 PR #49 cross-cutting Category A dedupe) | audit-dedupe (7 groups: claim semantics + auditAction discriminates + cross-tenant isolation + purge-expired + bodyHash + post-cache-expiry-different-body + computeAuditDedupeKey collision safety) | Closes PR-F2 r4 deferred HIGH (crash-window duplicate Category A audits on retry); 6-tuple dedupe key with SHA-256 + ASCII unit-separator; per-endpoint TTL aligned to idempotency cache TTL |
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
| **Async Consult lifecycle** (initiate / submit / abandon / resume / patient-responds; State Machines v1.1 §3 transitions 1-6 + 16) | tests/integration/async-consult-{cross-tenant-isolation,plugin-wiring,http} | ✅ HTTP surface covered Sprint 34 / PR #51; deeper lifecycle paths (start-intake gated on Payment SI-006, process gated on AI Service SI-007) remain fail-closed at v0.1 by design; clinician-decision branches + AWAITING_DATA timeout transitions reserved for future sprint |
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
| **SI-002** | AUDIT_EVENTS placeholder ratification | OPEN — pending P-012 |
| **SI-003** | DOMAIN_EVENTS placeholder ratification | OPEN — pending P-013 |

Spec corpus latest entry verified at `Telecheck_Promotion_Ledger.md` is **P-011** (SI-001 MedicationRequest canonical schema content-change promotion; 2026-05-11; spec corpus commit `879cd57`). P-012 and P-013 remain pending.

### Closed Spec Issues

| Spec Issue | Resolution | Closed at |
| --- | --- | --- |
| **SI-001** | MedicationRequest canonical schema (CDM v1.3 §4.16 + State Machines v1.2 §19 + AUDIT_EVENTS v5.3 + DOMAIN_EVENTS v5.2 in-place); blocked Slice 4 Pharmacy + Subscription | **RATIFIED 2026-05-11 (P-011)** — spec corpus commits `55d9c20` (workstream artifacts) + `879cd57` (P-011 promotion) in `arthurmenson/telecheckONE`. Supersedes the 2026-05-11 first attempt that was reverted via PR #109. Pharmacy + Refill v2.1 scaffold landed via the PR #95 / PR #108 successor PR (this PR; 6 files; ~42 cumulative Codex findings closed across the full ratification cycle). Path 1 ratified (no `interaction_override_id` column; integration via `medication_request.interaction_safety_hold_triggered` domain event per ADR-001). The new clinician I-012 confirmation event `prescribing.protocol_authorization_granted` joins the AUDIT_EVENTS v5.3 authoritative I-012 action-class set under P-011. |
| **SI-006** | Idempotency reserve-then-execute redesign per `docs/SI-006-Idempotency-Reserve-Then-Execute-Redesign.md` v0.2 | **CLOSED Sprint 33-34** (PRs #43-#49 + #51 sequence; 2026-05-08). Final state: handler-driven `withIdempotency` is the only path; legacy onSend cache-write hook + `storeIdempotencyRecord` writer + `markIdempotencyManagedByHandler` flag all removed under Group F source-grep lockdown; per-endpoint TTL overrides; reservation-lock vs cached-response TTL split; cross-cutting `audit_dedupe_markers` table protects Category A audit emissions on idempotency-protected paths. 18 substantive Codex findings closed across 11 PR iterations. |
| **SI-004** | Async Consult audit-events ratification | (resolved during async-consult slice authoring; Sprint 9-10) |
| **SI-005** | Consult / ConsultEvent schema gap | (resolved during async-consult slice authoring; Sprint 9-10) |

---

## §5 — Coverage gaps (sequenced by Sprint 7+ candidate priority)

Per Sprint 5 TLC-015 ORT audit + Sprint 6 author analysis:

| Gap | Closure path | Sprint candidate |
| --- | --- | --- |
| Foundation-layer perf budgets (idempotency, audit, RLS) | OR-218; depends on perf measurement infra | TLC-018 (Sprint 7) |
| Data-filtering implementation status doc | OR-208; ADR-023 implicit closure already exists; doc makes it explicit | TLC-019 (Sprint 7 filler) |
| Slice 4 Pharmacy schema + module + tests | Depends on SI-001 closure upstream | Sprint 7+ if SI-001 closes; Sprint 4-6 of EHBG §10b otherwise |
| ~~Async Consult slice~~ | ~~Slice PRD authoring required; not yet started~~ | ~~Sprint 7+ per EHBG §10b~~ — **CLOSED** Sprint 9-10 (slice authored) + Sprint 34 / PR #51 (HTTP surface coverage) |
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

**As of Sprint 34 close (`04e88e3` PR #51 merge; r5 amend 2026-05-08):**

- **Slices (implementation-complete):** 4 (Forms-Intake, Identity, Consent + Delegation, **Async Consult**)
- **Foundation modules:** 1 (tenant-config: 4 admin reads + 5 admin-write 503 stubs + readiness probe — admin-write awaits Admin Backend slice v1.1 PRD ratification)
- **BLOCKED-aware skeletons:** 3 (pharmacy, med-interaction, subscription — all gated on SI-001)
- **Forward migrations:** 23 (000-022 — Sprint 34 PR #49 added 022 `audit_dedupe_markers`)
- **Rollback migrations:** 23 (matched-pair coverage maintained)
- **Source files (non-test):** 109; **source LOC:** ~27,500
- **Test files:** 101 (across `tests/integration/` + `tests/contracts/` + `tests/invariants/` + `tests/state-machines/` + `tests/perf/`)
- **Test cases:** ~1474+ (Sprint 34 PR #51 added 13 async-consult HTTP cases; PR #49 added 7 audit-dedupe cases; PR #47 added Group F lockdown extension; PR #48 added `markIdempotencyManagedByHandler` absence assertion)
- **Codex findings closed cumulative across all sprints:** ~65+ (47 documented through Sprint 17 r4; +18 Sprint 33-34 — 11 HIGH + 7 MEDIUM across PR-F1 / PR-F2 / PR-F3 / PR-E / dedupe r1 / PR-51 r2-r4)
- **OpenAPI endpoints registered:** 62 substantive + 6 stub-only (skeleton modules) of 187 spec target; ~33% endpoint coverage
- **Closed Spec Issues:** SI-004 + SI-005 (Async Consult slice closure; Sprint 9-10) + **SI-006 (idempotency reserve-then-execute redesign; Sprint 33-34)**
- **Source-grep lockdowns:** 6 (canonical-glossary, crisis-detection-coverage, idempotency-actor-scoping, openapi-conformance, rls-policy-coverage, idempotency-helper Group F — extended Sprint 33-34 with onSend-removal + cleanup-sweep regression pins)
- **Repo-admin pending:** enable Dependency Graph in `arthurmenson/telecheck-app` Settings → Code security → Dependency graph (PR #50 set the workflow to advisory mode in the meantime)

---

## Sprint reference

Authored Sprint 6 (TLC-017) on the autonomous Scrum cycle. Closes ORT row OR-216 ("Build vs spec traceability matrix"). PM-brief verification gate (Evans 2026-05-05 oversight directive) ran at Sprint 6 kickoff and passed cleanly — first sprint without an identifier hallucination since the gate was instituted.
