# Sprint 14 Review — Telecheck-app autonomous build

**Sprint:** 14
**Sprint goal:** TLC-025 DB-backed bench infrastructure investment.
**Sprint start commit:** `fdb464a` (Sprint 13 review/retro filed; TLC-026 closure path FULLY landed)
**Sprint end commit:** `<this commit>` (Sprint 14 PARTIAL ACCEPTANCE; TLC-025-SCAFFOLD reverted at `af193e7`; escalated to Sprint 15+ TLC-027)
**Total commits in sprint:** 5 (kickoff + SCAFFOLD attempt + revert + TLC-027 escalation doc + this review/retro) of 7 budget = 71% utilization (under-budget by 2)
**CI status at sprint end:** Green expected at `af193e7` (revert restored to Sprint 13 working state; lint clean + tsc clean + self-test PASS)

**ACCEPTANCE: PARTIAL.** Sprint 14 ATTEMPTED TLC-025-SCAFFOLD (commit `208e9b5`) but Codex `perf-bench-r10` adversarial review surfaced 4 legitimate technical defects (2 HIGH + 2 MEDIUM) that require Postgres availability to fix correctly. The SCAFFOLD was REVERTED at `af193e7`; TLC-025 is escalated to Sprint 15+ as TLC-027 (`docs/TLC-027-DB-BENCH-INFRA-ESCALATION.md`). **Second-ever Codex finding-class escalation**, after Sprint 12's TLC-024 r4 → TLC-026.

---

## PM-brief verification gate findings (Sprint 14 — 9th consecutive ALL PASS)

5 cited identifiers verified pre-execution:
- P-008/P-009/P-010 latest 3 ledger entries — verified
- OR-218 — verified
- `tests/perf/README.md:106` bench-mode DB-backed corpus deferral — verified
- `vitest.bench.config.ts:13-18` ephemeral DB setup pattern — verified
- Sprint 13 review + retro at `fdb464a` — verified

9 consecutive PM-brief gate ALL PASS. PM hallucination class remains eradicated.

---

## Sub-stories status (1 of 1 — escalated)

### ⚠️ TLC-025 — DB-backed bench infrastructure — ESCALATED to Sprint 15+ TLC-027

**Sprint 14 attempt:**
1. Authored `tests/perf/db/setup.ts` (300 lines): bench-mode ephemeral Postgres setup mirroring `tests/setup.ts` patterns, with fail-closed env-var enforcement
2. Wired `vitest.bench.config.ts` setupFiles conditional on `BENCH_DATABASE_URL` presence
3. Updated `.env.example` with `TEST_DATABASE_URL` + `BENCH_DATABASE_URL` (both new)
4. Updated `tests/perf/README.md` with `Running DB-backed benches` section + bench corpus matrix flip
5. Committed at `208e9b5`

**Codex r10 verdict:** No-ship. 4 findings:

| Round | Finding | Severity | Status |
| --- | --- | --- | --- |
| r10-A | `setupFiles` fail-open when `BENCH_DATABASE_URL` absent | HIGH | ESCALATED to TLC-027 |
| r10-B | Savepoint translation breaks `pg_advisory_xact_lock` lifetime semantics; bench measures wrong thing for emit-audit hash chain | HIGH | ESCALATED to TLC-027 |
| r10-C | URL collision check is string-equality, not database-identity | MEDIUM | ESCALATED to TLC-027 |
| r10-D | Migration replay treats any "already exists" error as full-file success | MEDIUM | ESCALATED to TLC-027 |

**r10-B is particularly serious:** the SCAFFOLD's `setTestPool()` BEGIN/COMMIT translation holds advisory locks for the whole bench session rather than per-iteration as production does. The first DB-backed bench numbers (planned: emitAudit hash chain) would have been MISLEADING — measuring a different lock-lifetime model than production.

**Sprint 14 response: REVERT + ESCALATE.** Per `docs/TLC-027-DB-BENCH-INFRA-ESCALATION.md` rationale:
- Continuing fix-forward without Postgres availability would risk landing more "looks structurally correct, doesn't actually work" code
- The scaffold's design defects need hands-on Postgres validation to fix properly
- r10-A + r10-B require production-code change (`setBenchPool()` in `src/lib/db.ts`) which Sprint 14's plan explicitly ruled out
- The "structural-constraint-not-code-defect escalation pattern" (Sprint 12 retro codification) extends here: when the validation environment doesn't include the dependency this code interacts with, escalate at round 1 rather than waiting for the structural shape to surface across multiple rounds

Sprint 14 reverted `208e9b5` cleanly at `af193e7`. Working tree at `af193e7` is identical to Sprint 14 kickoff (`d433703`) for the SCAFFOLD-modified files.

---

## Codex adversarial review — 0 findings closed in-sprint; 4 ESCALATED

| Round | Finding | Severity | Status |
| --- | --- | --- | --- |
| r10-A | setupFiles fail-open | HIGH | ESCALATED to Sprint 15+ TLC-027 |
| r10-B | Savepoint translation breaks lock semantics | HIGH | ESCALATED to Sprint 15+ TLC-027 |
| r10-C | URL collision check string-equality | MEDIUM | ESCALATED to Sprint 15+ TLC-027 |
| r10-D | Migration replay full-file skip | MEDIUM | ESCALATED to Sprint 15+ TLC-027 |

**Cumulative across all sprints (post-Sprint-14):** 23 HIGH + 16 MEDIUM closed; **2 finding-classes ESCALATED** (TLC-024 r4 → TLC-026 [closed Sprint 13]; TLC-025 r10 → TLC-027 [pending Sprint 15+]).

**Sprint 14 = first sprint in 14 sprints with zero in-sprint Codex closures.** All 4 findings escalated. This is consistent with the structural-constraint pattern: when validation environment is missing, in-sprint fix-forward isn't appropriate.

---

## Definition of Done — Sprint 14

- [x] PM-brief verification gate ran + findings recorded (9/9 ALL PASS)
- [x] TLC-025 attempted (commit `208e9b5`)
- [x] Codex FIRE on SCAFFOLD commit (`perf-bench-r10` review)
- [⚠️] Codex findings closed in-sprint — **0 of 4 closed; 4 escalated**
- [x] SCAFFOLD reverted at `af193e7`
- [x] TLC-027 escalation doc filed (`docs/TLC-027-DB-BENCH-INFRA-ESCALATION.md`)
- [x] Lint + type-check clean post-revert
- [x] No invariants relaxed
- [x] No production-code changes (revert restored that posture)
- [x] `docs/SPRINT_14_REVIEW.md` filed (this doc)
- [ ] `docs/SPRINT_14_RETRO.md` filed (next)
- [ ] PM kickoff brief for Sprint 15

10 of 11 DoD boxes checked at this commit. 1 box pending = retro-doc filing (next).

---

## Cumulative state at Sprint 14 end

- 4 implementation-complete slices (unchanged)
- 21 forward migrations + paired rollbacks (unchanged)
- 35 of 35 domain events with same-tx outbox tests (unchanged)
- 39 Codex findings closed (23 HIGH + 16 MEDIUM); **2 finding-classes escalated** (1 closed Sprint 13; 1 pending Sprint 15+)
- 9 consecutive PM-brief verification gate ALL PASS
- 5 living-doc artifacts (TLC-027 escalation doc added this sprint)
- Sprint 14 commit count: 5 of 7 budgeted (71% utilization; under by 2 — the unused reserves were earmarked for Codex fix-forward that didn't happen due to escalation)

**OR-218 closure progress at Sprint 14 end:** unchanged from Sprint 13. Closure path BUILT; execution awaits Evans-side `gh api` PUT + 3-5 stable `perf.yml` main runs.

**TLC-027 closure progress at Sprint 14 end:** ESCALATED. Sprint 15+ executes against an environment with Postgres availability. Acceptance criteria documented in `docs/TLC-027-DB-BENCH-INFRA-ESCALATION.md` §"TLC-027 Sprint 15+ acceptance criteria".
