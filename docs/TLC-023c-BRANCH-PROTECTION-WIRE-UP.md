# TLC-023c — Branch protection wire-up for `Performance benchmarks` workflow

**Status:** prepared 2026-05-05 (Sprint 12); awaiting Evans's emergency-only-access execution.

**Sprint reference:** Sprint 12 / TLC-023c. Closes the third of OR-218's three closure conditions per `tests/perf/README.md:5-11` ("`npm run bench` wired into CI as a **required** gate"). Sprint 11 TLC-023b landed the `perf.yml` workflow; Sprint 12 TLC-023c documents the branch-protection wire-up so Evans can execute when reachable.

---

## What this doc covers

1. The exact `gh api` PUT payload to add `Performance benchmarks / bench` as a required status check on `main`
2. CI-runner variance characterization plan (3-5 runs to capture variance distribution before tightening thresholds)
3. Threshold-tightening worksheet
4. Verification steps post-execution (Sprint 13+ confirms via `gh api` GET)
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
