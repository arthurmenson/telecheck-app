# Sprint 6 Review — Telecheck-app autonomous build

**Sprint:** 6
**Sprint goal:** Author RLS policy static-analysis lockdown closing OR-112 + OR-236 + consolidate slice status docs into a build-vs-spec traceability matrix (OR-216).
**Sprint start commit:** `804c294` (PM oversight changes)
**Sprint end commit:** `c9bf34c` (TLC-017 final)
**Total commits in sprint:** 4 (kickoff `b03958e` + TLC-016 `75640ef` + Codex MEDIUM fix-forward `2dece96` + TLC-017 `c9bf34c`) vs 7-budget — 57% utilization (back below the Sprint 5 100% spike)
**CI status at sprint end:** Green expected at `c9bf34c` (lint + type-check clean locally; integration + 2 new contract tests run in CI)

---

## PM-brief verification gate findings (Sprint 6 inaugural run)

Per `docs/SCRUM_OPERATING_MODEL.md` §"PM-brief verification gate" landed at `804c294`. The SM mechanically verified every PM-cited identifier against its source-of-truth file BEFORE accepting the brief.

| Identifier | Cited at (PM brief §) | Verified at (source-of-truth) | Match |
| --- | --- | --- | --- |
| OR-112 | §2 | `Telecheck_Operational_Readiness_Todo_v1_5.md:89` | ✓ |
| OR-236 | §2 | `Telecheck_Operational_Readiness_Todo_v1_5.md:94` | ✓ |
| OR-216 | §2 | `Telecheck_Operational_Readiness_Todo_v1_5.md:127` | ✓ |
| P-010 | §1 | `Telecheck_Promotion_Ledger.md:40` | ✓ |
| 21 tenant-scoped tables | §4 | `grep "CREATE POLICY.*ON " migrations/*.sql` | ✓ |
| 3 policy-name conventions | §5 | grep migrations/ confirms split | ✓ |
| Existing test gap | §3 | `tests/invariants/i023-tenant-isolation.test.ts:232-275` (audit_records only + soft-fails) | ✓ |
| ADR-023 / I-023 | §9 | canonical (already cited throughout codebase) | ✓ |

**Gate result: ALL PASS.** First clean PM brief since the gate was instituted (Evans's 2026-05-05 oversight directive). The hallucination class from Sprint 3 (`internal.module.blocked`) and Sprint 5 (`OR-253/244/255`) did NOT recur. The new PM rubric sub-rules (spec-corpus identifier check + internal-canonicalization-pattern check) plus the SM verification gate appear to be working as designed.

---

## Stories accepted

### ✅ TLC-016 — RLS policy coverage lockdown — `75640ef` + Codex MEDIUM fix-forward `2dece96`

**Deliverables:**
- New test `tests/contracts/rls-policy-coverage-lockdown.test.ts` (265 LOC, 46 cases):
  - §1 Per-table assertions (21 tables × 2 cases = 42 cases)
  - §2 Count drift detection (2 cases — forward + reverse)
  - §3 Platform-level exclusion lockdown (2 cases — `tenants` + `country_profiles`)
- Codex `rls-policy-r1` MEDIUM finding closed via fix-forward at `2dece96` (replaced soft-skip with hard `expect(r.rows.length).toBe(1)`)
- Codex re-verify on `2dece96`: APPROVE / Ship

**Acceptance criteria evaluation:**
- [x] Per-table RLS assertions across all 21 tenant-scoped tables (`relrowsecurity = true` AND `relforcerowsecurity = true` AND ≥1 policy)
- [x] Count drift detection (catches policy-drop AND rogue platform-level RLS regressions)
- [x] Platform-level exclusion lockdown (`tenants`, `country_profiles`)
- [x] Policy-name convention handled correctly — does NOT assert fixed name (3 distinct names exist in production: `tenant_isolation` ×19 / `audit_tenant_isolation` ×1 / `tenant_users_visibility` ×1)
- [x] Codex FIRE returned 1 MEDIUM (`rls-policy-r1`); fix-forward applied in-sprint despite strict severity gating (rationale documented below)
- [x] Codex re-verify APPROVED
- [x] Type-check + lint clean
- [x] No production code changes (pure DB-catalog test)

**Severity-gating deviation (documented):**
Strict reading of `SCRUM_OPERATING_MODEL.md` severity gating: `MEDIUM = defer to next sprint backlog with rationale`. Sprint 6 deviated:

- This test is a security-adjacent contract lockdown
- Its whole value proposition is catching the class of failure Codex flagged (false-green on missing assertions)
- Fix is 1-line and trivial
- Sprint 7 backlog deferral would leave the test live with a known false-green path

Sprint 6 retro proposes a sub-rule: **MEDIUM-on-contract-lockdown-surfaces = fix-forward when trivial.** General MEDIUM-deferral rule remains for non-contract-lockdown surfaces.

**Verdict:** Accepted.

---

### ✅ TLC-017 — Build-vs-spec traceability matrix — `c9bf34c`

**Deliverables:**
- New doc `docs/BUILD_VS_SPEC_TRACEABILITY_MATRIX.md` (165 LOC):
  - §1 Platform invariants → test coverage (13 invariants tabulated; 13 comprehensive / 4 partial / blockers explicit)
  - §2 Slice / module → implementation state (3 complete slices + 2 foundation modules + 3 BLOCKED-aware skeletons + 13 foundation libraries)
  - §3 State machines → test coverage (12 state machines; 9 covered; 3 BLOCKED on SI-001 / slice PRD)
  - §4 Open Spec Issues (3 — SI-001/002/003 all open per Promotion_Ledger.md:40 = P-010 latest)
  - §5 Coverage gaps sequenced by Sprint 7+ priority
  - §6 Cumulative metrics
- Living-doc convention applied (non-dated single artifact + revision-history r1)
- Cross-links existing slice status docs (does NOT duplicate them)

**Acceptance criteria evaluation:**
- [x] Per-invariant table populated
- [x] Per-slice table populated
- [x] Per-state-machine table populated
- [x] Open SIs enumerated with verified Promotion Ledger state
- [x] Coverage gaps sequenced for Sprint 7+
- [x] Living-doc convention applied

**Verdict:** Accepted.

---

## Stories rolled over

None. Both committed stories accepted within sprint.

**Stories deferred to Sprint 7** (per Sprint 6 plan + TLC-015 audit sequencing):
- **TLC-018** Foundation-layer perf budget tests (lower priority; needs measurement infra)
- **TLC-019** Data-filtering implementation status doc (lowest priority; ADR-023 implicit closure already exists)

---

## Codex adversarial review

**Trigger:** Sprint plan called for FIRE on TLC-016 (real new-coverage; novel test class — first DB-backed contract lockdown).

**Round 1 (against base `804c294`):**
- Verdict: **needs-attention**
- 1 MEDIUM finding: §3 platform-level table existence is soft-skipped (file:line cited correctly)
- 0 HIGH / 0 CRITICAL findings
- Total review time: ~30s

**Round 2 (re-verify against `75640ef` after fix-forward `2dece96`):**
- Verdict: **approve / ship**
- 0 substantive findings

**Cumulative Codex stats across all sprints:**
- Sprint 1: 1 MEDIUM (`pharmacy-blocked-handler`) — fix-forward at `5615feb`
- Sprint 2/3/4: SKIPPED per pre-empt rationale
- Sprint 5: 1 HIGH (`idempotency-r5`) — fix-forward at `0f4a757`
- Sprint 6: 1 MEDIUM (`rls-policy-r1`) — fix-forward at `2dece96` (severity-gating deviation documented)

3 Codex findings total; all closed in-sprint via fix-forward; each surfaced a real bug class the SM had not caught.

**Lesson reinforced:** Codex earns its keep on real new-coverage stories. The SKIP heuristic for pattern-mirror / docs-only / lockdown-on-existing-code work continues to hold.

---

## Cumulative platform metrics at sprint end

- **Slices:** 3 implementation-complete (Forms-Intake, Identity, Consent + Delegation)
- **Foundations:** 2 (tenant-config — read + 503 write surfaces; pharmacy skeleton)
- **Module skeletons (BLOCKED-aware):** 3 (pharmacy, med-interaction, subscription)
- **Forward migrations:** 18 (000-019; unchanged)
- **Rollback migrations:** 18 (matched-pair coverage; unchanged)
- **Domain events wired:** 31 of 31 (unchanged)
- **Open Spec Issues:** 3 (SI-001/002/003)
- **Test files:** ~106 (added rls-policy-coverage-lockdown.test.ts)
- **Test cases (rough):** ~1470+ (added 46 from TLC-016)
- **Branded ID types:** 11 (unchanged)
- **Audit / coverage docs (living artifacts):** 3 (CRISIS_DETECTION_COVERAGE_AUDIT + ORT_V1_5_TESTABLE_ITEMS_AUDIT + BUILD_VS_SPEC_TRACEABILITY_MATRIX)
- **Cumulative Codex findings closed:** 3 (1 Sprint 1 MEDIUM + 1 Sprint 5 HIGH + 1 Sprint 6 MEDIUM)

---

## Decisions made this sprint

1. **PM-brief verification gate inaugural run: ALL PASS.** First clean PM brief since the gate was instituted. The Sprint 3 + Sprint 5 hallucination class did not recur.
2. **Severity-gating deviation: MEDIUM-on-contract-lockdown-surface = fix-forward when trivial.** Documented in TLC-016 fix-forward commit; Sprint 6 retro will propose this as a standing sub-rule.
3. **Living-doc convention applied 3rd time** (CRISIS_DETECTION_COVERAGE_AUDIT.md → ORT_V1_5_TESTABLE_ITEMS_AUDIT.md → BUILD_VS_SPEC_TRACEABILITY_MATRIX.md). Pattern is reproducible.
4. **Policy-name convention NOT asserted in lockdown test.** PM brief identified the 3-name reality; SM applied it correctly. Sprint 5 retro internal-canonicalization-pattern rubric sub-rule did real work this sprint.

---

## Definition of Done — Sprint 6 closeout

- [x] PM-brief verification gate ran + findings recorded
- [x] TLC-016 RLS lockdown test authored
- [x] TLC-016 Codex MEDIUM closed in-sprint via fix-forward
- [x] TLC-016 Codex re-verify APPROVED
- [x] TLC-017 traceability matrix doc filed
- [x] Lint + type-check clean
- [x] No invariants relaxed (I-023 reaffirmed via lockdown)
- [x] No production-code changes outside scope
- [x] `SPRINT_6_REVIEW.md` filed (this doc)
- [ ] `SPRINT_6_RETRO.md` filed (companion doc — next)
- [ ] PM kickoff brief for Sprint 7 (verification gate runs again)
- [-] (Severity gating deviation explicitly documented for retro discussion)

---

## Sprint 7 kickoff — pending PM brief

Sprint 6 utilization 57% (4/7) — back below the Sprint 5 100% spike. The 1.2× slack appears stable; hold for Sprint 7. Sprint 7 candidates pre-validated by TLC-015 audit + TLC-017 traceability matrix:

1. **TLC-018** Foundation-layer perf budget tests (OR-218; lower priority — needs measurement infra; Codex FIRE-eligible if infra is novel)
2. **TLC-019** Data-filtering implementation status doc (OR-208; lowest priority; ADR-023 implicit closure already exists; Codex SKIP)
3. **Pre-pave runway is now mostly exhausted.** TLC-016 was the highest-leverage gap. After Sprint 7, work may pivot to:
   - **Slice 4 schema authoring** if SI-001 closes upstream (PM checks Promotion Ledger for P-011)
   - **Operational items requiring Evans's emergency access** (vendor account credentials, AWS deploy access — out-of-repo)
   - **Higher-novelty closure work** like authoring the Async Consult slice if the slice PRD lands

**Sprint 7 PM kickoff actions:**
- PM-brief verification gate runs again per `SCRUM_OPERATING_MODEL.md`
- PM grep verifies any cited identifiers against source-of-truth files
- If pre-pave runway is exhausted AND SI-001 is still open, PM should propose Sprint 7 as either:
  - (a) TLC-018 + TLC-019 closure (last 2 pre-pave items), then surface "no further pre-pave; awaiting upstream" finding
  - (b) Pivot directly to surfacing "no further pre-pave; awaiting upstream" without authoring TLC-018/019 (deferred to a future when the slices that need them are closer to ratification)
