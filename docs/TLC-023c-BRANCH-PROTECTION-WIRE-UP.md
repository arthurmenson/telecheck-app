# TLC-023c — Branch protection wire-up for `Performance benchmarks` workflow

**Status:** prepared 2026-05-05 (Sprint 12); extended Sprint 13 / TLC-026 with §2.1 CI baseline capture procedure + machine-enforced metadata guard via `.github/workflows/baseline-refresh-guard.yml` (2026-05-05, Codex r6 → r7 → r8 fix-forward chain — full-line anchored labeled-field parsing + GH API validation + triple-dot merge-base diff + always-run + early-exit); **EXECUTED 2026-05-06 by autonomous Claude on Evans's behalf** (Evans authorized "act on my behalf to unblock and continue" + made `arthurmenson/telecheck-app` public to enable branch protection on free GitHub plan).

**Activation log:**
- **2026-05-06 — Sprint 17 / TLC-027 EXECUTE close + OR-218 EXECUTE land.** Branch protection PUT executed via `gh api -X PUT repos/arthurmenson/telecheck-app/branches/main/protection`. Required contexts installed: `Run benchmarks + threshold check + baseline comparison` (perf.yml) + `verify-metadata` (baseline-refresh-guard.yml). `strict: true`, `enforce_admins: false`, `allow_force_pushes: false`. Verified via independent GET. Operating-tenant identifier: arthurmenson@github.com (PAT scopes: `repo`, `read:org`, `gist`).

**Sprint reference:** Sprint 12 / TLC-023c authored this doc. Sprint 11 TLC-023b landed the `perf.yml` workflow. Sprint 13 / TLC-026 landed (a) the in-process closure-path infrastructure — manifest-check helper + self-test mode in `tests/perf/check-thresholds.ts`, wired into `perf.yml` — and (b) `.github/workflows/baseline-refresh-guard.yml` machine-enforcing the §2.1 required metadata via full-line anchored labeled-field parsing + GH API validation + triple-dot merge-base PR diff (closes Codex perf-bench-r6 + r7 + r8 MEDIUM). This doc remains the Evans-side execution playbook; Sprint 14+ executes it.

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

Sprint 13 / TLC-026 landed:
- Manifest-check helper + self-test mode in `tests/perf/check-thresholds.ts` (commit `4380a73` + r5 fix-forward `36b477c` extracting `runGate()` so `selfTest()` exercises the same gate semantics `main()` uses)
- Machine-enforced metadata guard in `.github/workflows/baseline-refresh-guard.yml` (Codex r6 + r7 fix-forward chain) — runs on EVERY PR (no path filter, per r7-B closure), early-exits with success when `tests/perf/baseline.json` is unchanged; otherwise enforces labeled-field parsing + GH API validation (per r7-A closure)

This section documents the Sprint 14+ baseline-capture flow that executes against that infrastructure. The workflow MACHINE-ENFORCES the metadata requirements stated below; loose regex grep on PR text was rejected by Codex r7-A as insufficient (incidental timestamps + hex strings could satisfy the prior pattern). There is no "audit trail discoverable later" loophole.

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

The commit body MUST include three labeled fields the `baseline-refresh-guard.yml` workflow parses with anchored patterns. Loose grep was insufficient (Codex perf-bench-r7 MEDIUM closure: "Run-Id" without label could match any 10+ digit timestamp); labeled fields rule out incidental matches.

```bash
# Step 6: Commit with required metadata. The labeled fields below are
# parsed by the baseline-refresh-guard workflow; the run id is then
# validated against the GitHub Actions API (run must exist, must be
# the Performance benchmarks workflow, must have completed=success,
# and its head_sha must prefix-match the cited Source-SHA).
git add tests/perf/baseline.json
SHORT_SOURCE_SHA="$(git rev-parse --short=7 "$STABLE_RUN_HEAD_SHA")"
git commit -m "chore(perf): [scope=baseline-refresh] CI-calibrated baseline from run $STABLE_RUN_ID

Captured from perf.yml run on main with the metadata below.
Manifest coverage verified locally (8/8 scenarios) before commit.
All 8 thresholds PASS against the captured baseline.

Replaces local-laptop Sprint 7 baseline. Closes the v0.1 trade-off
documented at tests/perf/README.md §'Known v0.1 trade-off'.

Run-Id: $STABLE_RUN_ID
Source-SHA: $SHORT_SOURCE_SHA

Sprint reference: Sprint 14+ TLC-026 execution path (Sprint 13 built
the closure path; this commit executes against it).
"
```

(`STABLE_RUN_HEAD_SHA` here is the `headSha` field from `gh run list` output in Step 1.)

**Required commit/PR metadata (machine-enforced):**
- `[scope=baseline-refresh]` literal tag — anywhere in PR title/body OR any commit message on the PR
- `Run-Id: <10+ digit number>` labeled field — **on its own line** (anchored regex per Codex r8-B closure: leading/trailing whitespace allowed, but the line must consist solely of the label + colon + value). The value is the `STABLE_RUN_ID` from Step 1.
- `Source-SHA: <7-40 char lowercase hex>` labeled field — **on its own line** (same anchoring rules). The value is `git rev-parse --short=7 $STABLE_RUN_HEAD_SHA`, OR the full 40-char hex.

Embedded label substrings in prose (e.g., a paragraph mentioning "the Run-Id: 1234567890" inline) are **rejected** by the anchored regex. Operators must place each field on its own line in the commit body or PR description.

### Enforcement mechanism

Per Codex perf-bench-r6 + r7 MEDIUM closures 2026-05-05, the metadata above is **machine-enforced** via `.github/workflows/baseline-refresh-guard.yml`. The workflow:

- Triggers `on: pull_request` for ALL PRs to main (no `paths:` filter — Codex r7-B closure: a path-filtered required-check leaves non-baseline PRs hung on a missing context, so the workflow must always produce a check)
- First step inspects `git diff --name-only ${BASE_SHA}...${HEAD_SHA}` (TRIPLE-DOT, merge-base semantics — Codex r8-A closure) for `tests/perf/baseline.json`. If absent, the workflow EARLY-EXITS with success — non-baseline PRs pass instantly with no metadata check. Two-dot diff was rejected by r8-A because it would misclassify an unrelated PR if main itself changed `baseline.json` after the PR branched (the PR head still differs from BASE_SHA for that file even though the PR didn't touch it).
- If `tests/perf/baseline.json` did change in this PR, runs:
  1. **Full-line anchored labeled-field parsing** — regex `^[[:space:]]*[Rr]un-[Ii]d:[[:space:]]*[0-9]{10,}[[:space:]]*$` and `^[[:space:]]*[Ss]ource-[Ss][Hh][Aa]:[[:space:]]*[0-9a-f]{7,40}[[:space:]]*$` (Codex r8-B closure: r7-A's unanchored grep accepted `fooRun-Id: 1234567890` substring matches; r8-B anchors to whole lines so only deliberate metadata fields on their own line satisfy the contract)
  2. **GH API validation** via `gh api /repos/.../actions/runs/{Run-Id}`:
     - Run must exist (gh fail-fasts on 404)
     - `name == "Performance benchmarks"` (rules out citing a CI-yml or unrelated workflow run)
     - `conclusion == "success"` (rules out flaky/cancelled/failed runs)
     - `head_sha` prefix-matches the cited `Source-SHA` (rules out citing a real run with a fabricated/mismatched code-state SHA)

**This replaces the prior doc-only-discipline framing.** The `[scope=baseline-refresh]` tag is no longer "something future operators grep for" — it is a CI-enforced precondition for merging any change to `tests/perf/baseline.json`. Multi-round closure trajectory:
- r3: doc-only churn discipline → revert
- r6: doc-only enforcement claim → add CI workflow with regex grep
- r7-A: regex grep accepts incidental matches → labeled fields + GH API validation
- r7-B: path-filter required-check problem → always-run + early-exit
- r8-A: two-dot diff misclassifies after main updates baseline → triple-dot merge-base diff
- r8-B: labeled fields not actually anchored → full-line anchored regex

**Sprint 14+ branch-protection wire-up** (per TLC-023c §1 PUT command pattern): when Evans executes the required-status-check append, include `Baseline refresh guard / verify-metadata` alongside `Performance benchmarks / bench`. Per r7-B closure, the workflow now runs on every PR (early-exits with success when baseline.json unchanged), so requiring it does NOT block unrelated PRs — every PR produces this check.

### Anti-patterns explicitly forbidden (Codex perf-bench-r2/r3/r6/r7 finding class)

- ❌ **Local-laptop regen committed as baseline.** Codex perf-bench-r2 MEDIUM 2026-05-05 closed this — the v0.1 baseline scope is "CI-calibrated only" until launch. Local regens for self-test fixtures are fine; they do not replace `tests/perf/baseline.json`. (Now also enforced via `Run-Id` API validation: a fake run id fails the gh api lookup; a real run id from a non-perf.yml run fails the workflow-name check.)
- ❌ **Skipping manifest-check verification.** The Sprint 13 helper exists to catch silent gate-bypass; bypassing it during the baseline capture procedure defeats the closure-path-built-Sprint-13 enforcement.
- ❌ **Skipping required metadata.** Closure trajectory: r3 → revert; r6 → workflow with regex grep; r7-A → labeled fields + GH API validation. Required metadata = `[scope=baseline-refresh]` literal tag + `Run-Id:` labeled field + `Source-SHA:` labeled field, all checked by the workflow. Run id is then validated against the GitHub Actions API; cited Source-SHA must prefix-match the run's head_sha.
- ❌ **Citing a cancelled/failed run as baseline.** Codex r7-A closure validates `conclusion == "success"` via API; cancelled/failed runs are rejected before merge.
- ❌ **Citing a perf.yml run with a mismatched Source-SHA.** Codex r7-A closure validates the cited Source-SHA prefix-matches the run's actual `head_sha`. Fabricated short SHAs are rejected.
- ❌ **Citing a non-perf.yml run** (e.g., a ci.yml run id). Codex r7-A closure validates `name == "Performance benchmarks"`. Wrong-workflow citations are rejected.
- ❌ **Committing a baseline from a flaky run.** If `gh run list` output mixes success + failure within the 3-5 window, investigate the failures before treating any success as a baseline. A baseline captured from a "lucky" run encodes survivor bias. (This anti-pattern is operator-discipline; the CI guard validates the cited run was *successful* but does not assess whether the surrounding runs reveal flake. Sprint 14+ retro evaluates whether to extend the guard to require N consecutive prior successes.)

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
