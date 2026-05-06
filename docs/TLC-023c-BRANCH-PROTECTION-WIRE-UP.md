# TLC-023c — Branch protection wire-up for `Performance benchmarks` workflow

**Status:** prepared 2026-05-05 (Sprint 12); extended Sprint 13 / TLC-026 with §2.1 CI baseline capture procedure (2026-05-05); awaiting Evans's emergency-only-access execution.

**Sprint reference:** Sprint 12 / TLC-023c authored this doc. Sprint 11 TLC-023b landed the `perf.yml` workflow. Sprint 13 / TLC-026 landed the in-process closure-path infrastructure (manifest-check helper + self-test mode in `tests/perf/check-thresholds.ts`, wired into `perf.yml`). This doc remains the Evans-side execution playbook; Sprint 14+ executes it.

---

## What this doc covers

1. The exact `gh api` PUT payload to add `Performance benchmarks / bench` as a required status check on `main`
2. CI-runner variance characterization plan (3-5 runs to capture variance distribution before tightening thresholds)
2.1. **CI baseline capture procedure** (Sprint 13 / TLC-026 extension) — `gh run download` flow + manifest-check verification before commit
3. Threshold-tightening worksheet
4. Verification steps post-execution (Sprint 14+ confirms via `gh api` GET)
5. Rollback procedure if the gate flakes

---

## Why this is a doc, not a code commit

`gh api repos/:owner/:repo/branches/main/protection` requires GitHub repo admin access. Per `CLAUDE.md` memory `feedback_risky_actions_pace.md` + the user's standing 1-week emergency-only-availability directive, autonomous Claude Code does NOT have GitHub admin access. This doc unblocks Sprint 12 by separating the **decision** (Sprint 11 + Sprint 12 work landing the workflow + thresholds + this wire-up plan) from the **execution** (Evans runs `gh api` when available).

Sprint 13+ verifies the protection is live via `gh api ... protection` GET.

---

## §1 — gh api wire-up command

### Prerequisite check

```bash
# Confirm the Performance benchmarks workflow has run at least once on main.
gh run list --workflow=perf.yml --branch=main --limit=5

# Confirm the workflow's check-name as it appears in CI.
gh api repos/arthurmenson/telecheck-app/commits/main/check-runs \
  --jq '.check_runs[] | select(.name | contains("Performance")) | .name'
# Expected output: "Performance benchmarks / bench"
```

### Add as required status check

```bash
# Read current branch protection (preserve existing required checks).
gh api repos/arthurmenson/telecheck-app/branches/main/protection \
  --jq '.required_status_checks.contexts'
# Capture output — typically includes "build-and-test", "spec-pointer-validation", etc.

# PUT updated protection with the perf check appended.
# IMPORTANT: include ALL existing contexts in the array; this is a full
# replacement, not an additive merge. Replace <EXISTING_CHECKS_JSON_ARRAY>
# with the array from the previous command + the new check.
gh api -X PUT repos/arthurmenson/telecheck-app/branches/main/protection \
  --field "required_status_checks[strict]=true" \
  --field "required_status_checks[contexts][]=build-and-test" \
  --field "required_status_checks[contexts][]=spec-pointer-validation" \
  --field "required_status_checks[contexts][]=Performance benchmarks / bench" \
  --field "enforce_admins=false" \
  --field "required_pull_request_reviews=null" \
  --field "restrictions=null"
```

**Adjust the `--field "required_status_checks[contexts][]=..."` lines** to match the actual current contexts captured from the GET. The Performance benchmarks check name format is `<workflow name> / <job name>` per `perf.yml:30,34`.

### Verification

```bash
gh api repos/arthurmenson/telecheck-app/branches/main/protection \
  --jq '.required_status_checks.contexts'
# Expected output: includes "Performance benchmarks / bench"
```

---

## §2 — CI-runner variance characterization plan

Sprint 11 TLC-023a authored thresholds based on local Sprint 7 measurements (`tests/perf/check-thresholds.ts:THRESHOLDS`). CI-runner latency distribution may differ:
- Shared GitHub runners are typically 2-4× slower than dev laptops
- Variance band can be 2-10× wider than local on noisy days

### Pre-promotion data-collection

Before flipping branch protection, capture 3-5 main-branch runs of `perf.yml` and inspect the upload artifacts:

```bash
# List recent perf.yml runs on main.
gh run list --workflow=perf.yml --branch=main --limit=5

# Download the bench-output.json artifact from a specific run.
gh run download <run-id> --name bench-output-<run-id>

# Inspect the captured percentiles per scenario.
node -e "
const data = JSON.parse(require('fs').readFileSync('bench-output.json', 'utf8'));
for (const file of data.files || []) {
  for (const group of file.groups || []) {
    for (const bench of group.benchmarks || []) {
      console.log(bench.name, 'p99:', (bench.p99 * 1000).toFixed(2), 'μs');
    }
  }
}
"
```

### What to look for

- **Scenario-by-scenario CI p99 vs threshold** in `check-thresholds.ts:THRESHOLDS`. If CI p99 is consistently <50% of threshold across 5 runs, consider tightening thresholds (50%-of-current is a starting point; go in 2 rounds: 75% then 50%, with a Sprint between to confirm stability).
- **Outlier runs.** If a single run has p99 > threshold while others pass, the workflow IS catching real flake — don't loosen thresholds; investigate the underlying cause (was the runner under load? is there variance in the test setup?).
- **Cold-start vs warm patterns.** First bench scenario in a run may be slower due to JIT warmup. Vitest bench has `warmupIterations` config — verify `vitest.bench.config.ts` accommodates if cold-start is the dominant variance source.

---

## §2.1 — CI baseline capture procedure (Sprint 13 / TLC-026 extension)

Sprint 13 / TLC-026 (commit `4380a73`) landed the manifest-check helper + self-test mode in `tests/perf/check-thresholds.ts`. This section documents the Sprint 14+ baseline-capture flow that executes against that infrastructure.

### Prerequisite: 3-5 stable main runs

```bash
# Verify perf.yml has accumulated 3-5 PASSING runs on main with no flakes.
gh run list --workflow=perf.yml --branch=main --limit=10 \
  --json databaseId,conclusion,createdAt,headSha \
  --jq '.[] | select(.conclusion == "success") | "\(.databaseId)  \(.createdAt)  \(.headSha[0:8])"'
# Expected: 3-5 lines minimum, all "success".
# If <3 success lines: STOP. Wait for additional main pushes to trigger perf.yml.
# If any "failure" interleaved with success: investigate the failing run's
# bench-output.json artifact before treating the success runs as a baseline.
```

### Capture procedure

```bash
# Step 1: Pick a stable run — prefer the most recent of the 3-5 successes.
STABLE_RUN_ID="<run-id-from-the-list-above>"

# Step 2: Download the bench-output.json artifact from that run.
gh run download "$STABLE_RUN_ID" --name "bench-output-${STABLE_RUN_ID}"
# This places bench-output.json in the cwd.

# Step 3: Verify manifest coverage BEFORE treating it as a baseline.
# This is the gate the Sprint 13 helper enforces locally — same code that
# runs in CI, so a missing scenario fails BEFORE you commit.
npx tsx tests/perf/check-thresholds.ts ./bench-output.json
# Expected output: "manifest coverage: 8/8 scenarios verified" + all 8
# thresholds PASS.
# If manifest coverage <8/8: STOP. The CI run is missing scenarios; do
# not commit it as a baseline.
# If any threshold FAIL on the captured CI run: STOP. The baseline would
# encode a regression. Investigate before committing.

# Step 4: Move the captured file to the canonical baseline location.
mv ./bench-output.json tests/perf/baseline.json

# Step 5: Re-verify post-move (sanity check the file rename didn't corrupt).
npx tsx tests/perf/check-thresholds.ts tests/perf/baseline.json
# Same expected output as Step 3.
```

### Commit discipline

```bash
# Step 6: Commit with explicit baseline-refresh scope tag.
git add tests/perf/baseline.json
git commit -m "chore(perf): [scope=baseline-refresh] CI-calibrated baseline from run $STABLE_RUN_ID

Captured from perf.yml run $STABLE_RUN_ID on main (commit <sha-from-step-1>).
Manifest coverage verified locally (8/8 scenarios) before commit.
All 8 thresholds PASS against the captured baseline.

Replaces local-laptop Sprint 7 baseline. Closes the v0.1 trade-off
documented at tests/perf/README.md §'Known v0.1 trade-off'.

Sprint reference: Sprint 14+ TLC-026 execution path (Sprint 13 built
the closure path; this commit executes against it).
"
```

**Required commit-message attributes:**
- `[scope=baseline-refresh]` tag in the subject (so future operators can grep `git log --oneline | grep baseline-refresh` to enumerate every regen)
- The exact `STABLE_RUN_ID` from Step 1 (so the baseline's CI-runner provenance is auditable)
- The `headSha` from `gh run list` (so the baseline is bound to a specific commit's worth of code, not a moving target)

### Anti-patterns explicitly forbidden

- ❌ **Local-laptop regen committed as baseline.** Codex perf-bench-r2 MEDIUM 2026-05-05 closed this — the v0.1 baseline scope is "CI-calibrated only" until launch. Local regens for self-test fixtures are fine; they do not replace `tests/perf/baseline.json`.
- ❌ **Skipping manifest-check verification.** The Sprint 13 helper exists to catch silent gate-bypass; bypassing it during the baseline capture procedure defeats the closure-path-built-Sprint-13 enforcement.
- ❌ **Skipping the `[scope=baseline-refresh]` tag.** Codex perf-bench-r3 MEDIUM 2026-05-05 closed the prior doc-only-discipline failure mode by replacing it with grep-able commit-message tag enforcement.
- ❌ **Committing a baseline from a flaky run.** If the `gh run list` output mixes success + failure within the 3-5 window, investigate the failures before treating any success as a baseline. A baseline captured from a "lucky" run encodes survivor bias.

---

## §3 — Threshold-tightening worksheet

After 3-5 stable runs:

| Scenario | Current p99 ceiling | Median CI p99 measured | Suggested tightened ceiling | Rationale |
| --- | --- | --- | --- | --- |
| §1 short clean (~35 chars) | 2μs | TBD | TBD | Tighten only if CI p99 < 1μs across all 5 runs |
| §2 short crisis (~24 chars) | 1.5μs | TBD | TBD | — |
| §3 long clean (~5KB) | 200μs | TBD | TBD | — |
| §4 long crisis end (~5KB) | 300μs | TBD | TBD | — |

Update `tests/perf/check-thresholds.ts:THRESHOLDS` with the tightened values; re-run locally + watch for green CI before flipping the branch protection.

After Sprint 12 TLC-024 lands, also include `validate-transition` scenarios (§5-§8) in the worksheet.

---

## §4 — Rollback procedure

If the gate flakes more than 1× per 10 runs after promotion to blocking:

```bash
# Step 1: Remove the perf check from required status checks.
# Re-issue the PUT command from §1 with the perf context REMOVED from the
# contexts[] array.

# Step 2: Investigate the flake.
# Capture the failing run's bench-output.json artifact + inspect the
# specific scenario that breached threshold.

# Step 3: Retune thresholds OR fix the regression.
# If CI variance widened (no real regression): widen thresholds (e.g.,
# 1.5x current ceiling) and re-promote after 3 stable runs.
# If real regression: investigate the underlying production code change
# that landed alongside; revert or fix-forward.
```

---

## §5 — Sprint 13+ verification

When Evans executes the `gh api` PUT:

1. Sprint 13 PM kickoff verifies via `gh api ... protection | jq '.required_status_checks.contexts'`
2. Sprint 13 retro records the date of activation in this doc's "Status" line at top
3. ORT row OR-218 status flips from "scaffolded; 2 of 3 conditions closed" to "FULLY CLOSED" in `BUILD_VS_SPEC_TRACEABILITY_MATRIX.md` r3 amend

---

## §6 — Spec references

- ORT v1.5 OR-218 (Tier 1 launch-blocking; verified at `Telecheck_Operational_Readiness_Todo_v1_5.md:129`)
- `tests/perf/README.md` (operating model + closure path)
- Sprint 11 TLC-023a/b — landed thresholds + workflow
- Sprint 12 TLC-023c — this doc + execution-pending state
- Codex closures: `perf-thresholds-r1` + `perf-yml-r1`

---

## §7 — Authoring discipline note

This doc is a **handoff artifact** for asynchronous coordination with Evans. Future autonomous Claude Code instances should:
- NOT attempt to execute the `gh api` command themselves (no admin access)
- Update the "Status" line at top when execution lands
- Append a §"Activation log" with the date Evans executed + first-run-on-main verification result
