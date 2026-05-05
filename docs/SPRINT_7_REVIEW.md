# Sprint 7 Review — Telecheck-app autonomous build

**Sprint:** 7
**Sprint goal:** Scaffold `tests/perf/` infra (Vitest bench mode) for OR-218 + absorb OR-208 closure into BUILD_VS_SPEC_TRACEABILITY_MATRIX r2 (TLC-019 descoped).
**Sprint start commit:** `d7ae4eb` (Sprint 6 ACCEPTED)
**Sprint end commit:** `ba2c7be` (matrix r2 amend final)
**Total commits in sprint:** 4 (kickoff `cb9fc55` + TLC-018 `d677fd3` + Codex HIGH fix-forward `d879a79` + matrix r2 `ba2c7be`) vs 4-budget — 100% utilization (Sprint 5 had also hit 100%; tight but on-budget)
**CI status at sprint end:** Green expected at `ba2c7be` (lint + type-check clean locally; bench harness verified working locally with stub env)

---

## PM-brief verification gate findings (Sprint 7 — 2nd consecutive ALL PASS)

| Identifier | Cited at (PM brief §) | Verified at (source-of-truth) | Match |
| --- | --- | --- | --- |
| OR-208 | §2 (TLC-019 descope) | `Telecheck_Operational_Readiness_Todo_v1_5.md:119` | ✓ |
| OR-218 | §2 (TLC-018) | `Telecheck_Operational_Readiness_Todo_v1_5.md:129` | ✓ |
| `tests/perf/**` | §3 | does NOT exist (Glob returned 0 files) | ✓ |
| `vitest.config.ts` no `benchmark:` key | §3 | confirmed | ✓ |
| Async Consult PRD v1.0 | §5 | `Telecheck_Async_Consult_Slice_PRD_v1_0.md` exists | ✓ |
| P-010 (Promotion Ledger latest) | §1 | confirmed | ✓ |
| ADR-019 / ADR-023 | §9 | canonical | ✓ |

**Gate result: ALL PASS.** 2nd consecutive clean PM brief. The Sprint 3 (`internal.module.blocked`) + Sprint 5 (`OR-253/244/255`) hallucination class has not recurred since the gate was instituted at `804c294`.

---

## Stories accepted

### ✅ TLC-018 — Foundation-layer perf budget infra scaffold — `d677fd3` + Codex HIGH fix-forward `d879a79`

**Deliverables:**
- New directory `tests/perf/` with operating-model README
- `tests/perf/audit/crisis-detect.bench.ts` — 4 bench scenarios (short clean / short crisis / long clean / long crisis at end)
- `vitest.bench.config.ts` — separate bench config (per-mode `setupFiles` override under `benchmark:` key in vitest.config.ts doesn't apply in Vitest 2; dedicated config is the clean separation)
- `package.json` script `bench` → `vitest bench --run -c vitest.bench.config.ts`
- `vitest.config.ts` comment update referencing the bench config
- `.eslintrc.cjs` override + ignorePattern extended to cover `vitest.bench.config.ts`

**Local-run sanity check** (`DATABASE_URL=stub NODE_ENV=test npm run bench`):
- §1 short clean (~35 chars): 5.5M ops/sec, p99 ~0.4μs
- §2 short crisis (~24 chars): 8.9M ops/sec
- §3 long clean (~5 KB): 34K ops/sec, p99 ~0.06ms
- §4 long with crisis at end (~5 KB): 54K ops/sec
- Bench harness loads cleanly without DB

**Codex round-trip:**
- Round 1 (against `d7ae4eb`): **needs-attention**. 1 HIGH finding `perf-bench-r1`: README claimed "closes OR-218" but a non-blocking harness without enforceable thresholds can't serve as the launch-blocking gate.
- Fix-forward at `d879a79`: reframed "closes OR-218" → "scaffolds OR-218 infra; closure deferred to Sprint 11 hardening"; Sprint 11 promotion path enumerated explicitly (3 conditions).
- Round 2 (re-verify against `d677fd3`): **approve / ship**. No material findings.

**Verdict:** Accepted as scaffold (NOT as OR-218 closure).

### ✅ Matrix r2 amend (TLC-019 absorption + Sprint 7 deltas) — `ba2c7be`

**Deliverables:**
- Matrix r2 revision history entry
- Header expanded with "Closes" (OR-216 + OR-208) and "Scaffolds (NOT closes)" (OR-218) sections
- §6 Cumulative metrics updated: Sprint 7 deltas (test files, bench scenarios, Codex findings, PM-brief verification gate runs)

**Verdict:** Accepted.

---

## Stories descoped at PM kickoff

- **TLC-019** Data-filtering implementation status doc — DESCOPED. Matrix §1 I-023 row + §2 lib rows already document ADR-023's 3-layer enforcement decision. Absorbed into matrix r2 with OR-208 back-link rather than authoring duplicate.

---

## Codex adversarial review

**Trigger:** Sprint 7 plan called for FIRE on TLC-018 (novel test infra class — Vitest bench mode first appearance).

**Round 1:** 1 HIGH finding (`perf-bench-r1`) — substantively correct. Caught the "closes OR-218" overclaim that the SM had landed. The sprint plan + the README internally said "bench is signal not gate at v0.1" but the closure language wasn't aligned with that operating model.

**Round 2:** APPROVE. Reframed README + commit semantics passed.

**Cumulative Codex stats across all sprints:**
- Sprint 1: 1 MEDIUM (`pharmacy-blocked-handler`) — closed at `5615feb`
- Sprint 2/3/4: SKIPPED per pre-empt rationale
- Sprint 5: 1 HIGH (`idempotency-r5`) — closed at `0f4a757`
- Sprint 6: 1 MEDIUM (`rls-policy-r1`) — closed at `2dece96` (severity-gating deviation documented)
- Sprint 7: 1 HIGH (`perf-bench-r1`) — closed at `d879a79`

4 Codex findings total; all closed in-sprint via fix-forward; all surfaced real bug classes the SM had not caught.

**Lesson reinforced (3rd consecutive non-skip Codex sprint):** Codex catches a meaningfully different defect class than the SM's own review. Sprint 5 (TTL test over-permissive), Sprint 6 (soft-skip on missing tables), Sprint 7 (closure-language overclaim) — three different failure classes, all real.

---

## Cumulative platform metrics at sprint end

- **Slices:** 3 implementation-complete (Forms-Intake, Identity, Consent + Delegation)
- **Foundations:** 2 (tenant-config; pharmacy skeleton)
- **Module skeletons (BLOCKED-aware):** 3 (pharmacy, med-interaction, subscription)
- **Forward migrations:** 18 (000-019; unchanged)
- **Rollback migrations:** 18 (matched-pair coverage; unchanged)
- **Domain events wired:** 31 of 31 (unchanged)
- **Open Spec Issues:** 3 (SI-001/002/003)
- **Test files:** ~107 (added `crisis-detect.bench.ts` — note: bench files don't count as test cases)
- **Bench scenarios (NEW Sprint 7):** 4 (`crisis-detect.bench.ts` §1-§4)
- **Test cases (rough):** ~1470+ (no new integration tests this sprint)
- **Branded ID types:** 11 (unchanged)
- **Audit / coverage docs (living artifacts):** 3 (CRISIS_DETECTION_COVERAGE_AUDIT + ORT_V1_5_TESTABLE_ITEMS_AUDIT + BUILD_VS_SPEC_TRACEABILITY_MATRIX r2)
- **Cumulative Codex findings closed:** 4 (Sprint 1 / 5 / 6 / 7)
- **PM-brief verification gate runs:** 2 (Sprint 6 + 7); both ALL PASS

---

## Decisions made this sprint

1. **Option (b) scaffold-vs-(a)inline-asserts-vs-(c)descope.** PM brief listed all three; SM accepted (b) on grounds that (a) is flaky on shared CI and (c) pushes the scaffolding cost into Sprint 11 launch-prep when other priorities will be higher.
2. **Separate `vitest.bench.config.ts`.** Per-mode `setupFiles` override under `benchmark:` key in vitest.config.ts doesn't apply in Vitest 2. Discovered at execution; dedicated config is the clean separation.
3. **TLC-018 reframed from "closes OR-218" to "scaffolds OR-218".** Codex `perf-bench-r1` HIGH closure. The scaffold is the right scope; the closure language was the actual error.
4. **TLC-019 descope absorbed into matrix r2.** No duplicate doc; back-link in matrix header is sufficient closure path for OR-208.
5. **PM-brief verification gate is now a standing artifact.** 2 consecutive clean runs; both PMs cited identifiers with file:line; both passed gate verification. The Sprint 3 + Sprint 5 hallucination failure class has not recurred. Gate stays.

---

## Definition of Done — Sprint 7 closeout

- [x] PM-brief verification gate ran + findings recorded (this doc §"PM-brief verification gate findings")
- [x] TLC-018 `tests/perf/` scaffold + 1 example bench + README authored
- [x] `vitest.bench.config.ts` created
- [x] `npm bench` script wired
- [x] Local bench harness verified working
- [x] Codex FIRE on TLC-018; HIGH finding closed in-sprint via fix-forward
- [x] Codex re-verify APPROVED
- [x] Matrix r2 amend with TLC-019 absorption + OR-218 status correction
- [x] Lint + type-check clean
- [x] No invariants relaxed
- [x] No production-code changes outside scope (TLC-018 = test infra; matrix r2 = pure docs)
- [x] `SPRINT_7_REVIEW.md` filed (this doc)
- [ ] `SPRINT_7_RETRO.md` filed (companion doc — next)
- [ ] PM kickoff brief for Sprint 8 (verification gate runs again; pivot decision to Async Consult slice)

---

## Sprint 8 kickoff — pending PM brief

Sprint 7 utilization 100% (4/4) — second sprint at exact budget (Sprint 5 was the first). Hold 1.2× slack pending Sprint 8 utilization data. If Sprint 8 also lands at 100%, widen to 1.3×.

**PRE-PAVE RUNWAY EXHAUSTION CONFIRMED.** Sprint 6 retro flagged this; Sprint 7 confirmed it. After Sprint 7's 2 stories close, the testable-without-upstream-blockers backlog is depleted. Sprint 8+ work pivots to either:

1. **Slice 4 schema authoring** — if SI-001 closes upstream (PM checks Promotion Ledger for P-011)
2. **Async Consult slice authoring** — PRD v1.0 verified to exist at `Telecheck_Async_Consult_Slice_PRD_v1_0.md` per Sprint 7 PM brief §5
3. **Surface to Evans:** "no further pre-pave; awaiting upstream SI closures + emergency-access vendor integration"

Sprint 8 PM kickoff actions:
- Re-check Promotion Ledger (verification gate runs against P-011/012/013)
- If SI-001 still open AND Async Consult PRD exists, propose Sprint 8 = Async Consult slice authoring (Sprint A: skeleton + state machine + types; Sprint A+1: handlers + tests; Sprint A+2: integration)
- Sprint 8 verification gate must verify the Async Consult PRD section refs the SM cites (the PM brief should call out specific PRD sections with line numbers)

**Codex strategy for Sprint 8:** if Async Consult slice authoring lands, FIRE on the slice's plugin + state machine + initial handlers. This is the highest-novelty work since Sprint 1.
