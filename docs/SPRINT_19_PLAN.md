# Sprint 19 Plan — Telecheck-app autonomous build

**Sprint:** 19
**Sprint goal:** TLC-034 migration-concurrency flake fix (advisory lock around `applyMigrations`) + TLC-035 `.gitattributes` EOL normalization. Two pre-existing main-red issues identified at Sprint 18 retro.
**Sprint start commit:** `4da80e2` (Sprint 18 close; PR #12 merged).
**Branch posture:** feature-branch + PR. Combined into one PR (PR #13) since rebases of TLC-034 alone would themselves trigger the EOL drift TLC-035 fixes.
**Commit budget:** 4 (2 stories × 1.2 slack + 1 cleanup reserve + 1 review/retro).
**Codex strategy:** FIRE on TLC-034 (advisory-lock test-infra is novel-of-class — advisory-lock semantics + per-fork interaction worth adversarial pass); SKIP on TLC-035 (`.gitattributes` is config).

---

## PM-brief verification gate findings (Sprint 19 — 14th consecutive ALL PASS)

5 cited identifiers verified pre-execution:
- P-008/P-009/P-010 latest 3 ledger entries — verified
- OR-218 — verified at `Telecheck_Operational_Readiness_Todo_v1_5.md:129` (FULLY CLOSED post-Sprint-17)
- `tests/setup.ts:applyMigrations` — verified
- `vitest.config.ts:pool: 'forks'` — verified at line 140
- Sprint 18 retro Sprint 19 candidate scope (TLC-034 + TLC-035) at `docs/SPRINT_18_RETRO.md` "Process changes for Sprint 19" — verified

14 consecutive PM-brief gate ALL PASS.

---

## Environment availability check (per PM rubric sub-rule 5)

- Postgres in autonomous shell: still NO (Docker not running)
- gh auth: YES
- Repo public: YES
- Branch protection: ACTIVE on main
- TLC-034 + TLC-035 are both autonomous-shell-actionable (lint + tsc + structural correctness); end-to-end TLC-034 validation requires CI Postgres service container (which has it via ci.yml).

---

## Sub-stories committed

### TLC-034 — migration-concurrency advisory lock

**Estimated commits:** 1 (single fix in tests/setup.ts).
**Codex strategy:** FIRE — advisory-lock test-infra pattern is novel-of-class.

#### Acceptance criteria

- `applyMigrations()` in `tests/setup.ts` wraps the apply loop in `pg_advisory_lock(hashtext('telecheck_test_migrations')::int)` / `pg_advisory_unlock` pair (try/finally)
- Lock-key derivation uses `hashtext()` returning int4; cast to `int` to disambiguate `pg_advisory_lock` overload
- Loop body unchanged (existing IF NOT EXISTS guards make per-fork apply idempotent)
- ci.yml `Build, lint, typecheck, test` job no longer fails with `tuple concurrently updated` on migrations 002/003/018
- Inline comment block documents root cause + rationale + lock-key derivation

### TLC-035 — `.gitattributes` EOL normalization

**Estimated commits:** 1 (NEW `.gitattributes` file + git renormalization).
**Codex strategy:** SKIP per §5.2 (config file).

#### Acceptance criteria

- NEW `.gitattributes` at repo root with:
  - `* text=auto eol=lf` global rule
  - Explicit per-extension rules for ts/tsx/js/json/md/yml/yaml/sql/sh
  - Binary markers for png/jpg/jpeg/gif/ico/pdf/zip/gz
- `git add --renormalize .` applied to fix existing CRLF files in the repo (post-renormalize files have LF in repo regardless of host OS)
- `npm run format:check` clean post-renormalize on all CI-scope files

### Combined-PR rationale

TLC-034 and TLC-035 land in PR #13 together because:
- TLC-034 alone would need at least one rebase before merge (PR #13 was opened after PRs #10/11/12 merge); each rebase risks re-introducing EOL drift
- TLC-035 fixes the root cause of EOL drift; landing it FIRST means subsequent rebases are clean
- Combining is a small PR (~50 lines net change) — Codex can review both atomically

---

## Definition of Done — Sprint 19

- [ ] PM-brief verification gate ran (14/14 ALL PASS)
- [ ] TLC-034 advisory-lock fix landed
- [ ] TLC-035 `.gitattributes` landed
- [ ] PR #13 opened
- [ ] Codex FIRE on TLC-034; closures recorded
- [ ] CI required checks PASS on PR #13
- [ ] CI ci.yml `Build, lint, typecheck, test` PASS on PR #13 (validates TLC-034)
- [ ] `docs/SPRINT_19_REVIEW.md` filed
- [ ] `docs/SPRINT_19_RETRO.md` filed
- [ ] PM kickoff brief for Sprint 20

---

## Sprint 20 hand-off

When Sprint 19 closes:
1. **TLC-032 DB-backed bench expansion** — still deferred (needs Postgres validation; same risk class as Sprint 14 TLC-025 attempt)
2. **Add `Build, lint, typecheck, test` as required-blocking branch-protection check** — once TLC-034 fix + TLC-031 format-fix both merged + ci.yml job stably passing
3. **SI-001/002/003 status check** at PM kickoff (still upstream)
4. **Slice 4 implementation** if any SI closes
