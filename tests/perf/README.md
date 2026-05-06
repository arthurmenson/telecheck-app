# tests/perf/ — Foundation-layer performance benchmarks

**Sprint 7 / TLC-018.** **SCAFFOLDS** ORT row OR-218 ("Performance and load test plan — interaction engine <2s, emergency <60s under p95 load — scope expanded 2026-04-25 to include AI lab interpretation accuracy regression per ADR-019"; verified at `Telecheck_Operational_Readiness_Todo_v1_5.md:129`).

**OR-218 is NOT closed by this scaffold.** Per Codex `perf-bench-r1` HIGH closure 2026-05-05: a non-blocking bench harness without enforceable thresholds cannot serve as the launch-blocking perf-budget gate that OR-218 demands. The scaffold lands the directory + harness + 1 example bench so slice teams add per-slice benches as they ship; full OR-218 closure happens at Sprint 11 hardening when:

1. Each foundation-layer + slice-layer hot-path has explicit p95 thresholds
2. `npm run bench` is wired into CI as a **required** check
3. Baseline comparison output (via `vitest bench --outputJson <file>` for capture + `vitest bench --compare <baseline-file>` for diff) detects regressions across PRs

Until those three conditions hold, OR-218 remains **OPEN**. Sprint 11 PM kickoff brief MUST re-list OR-218 as launch-blocking and propose the promotion-path stories.

## Operating model (v0.1)

This directory holds **performance benchmarks**, not correctness tests. Benchmarks measure latency / throughput / memory characteristics under representative load. They are **distinct from `tests/integration/`** in three important ways:

| Aspect | Integration tests (`tests/integration/`) | Performance benchmarks (`tests/perf/`) |
| --- | --- | --- |
| Purpose | Assert correctness | Measure latency / throughput |
| Test runner | `vitest run` (read by `npm test`) | `vitest bench` (read by `npm run bench`) |
| API | `it()`, `describe()`, `expect()` | `bench()`, `describe()` |
| CI gate at v0.1 | Blocking (red CI = no merge) | **Non-blocking** (signal only) |
| CI gate at Sprint 11+ | Blocking | Promote to blocking with explicit p95 thresholds (per OR-218 launch-prep) |
| Determinism | Reproducible | Variance-tolerant (multi-run + statistical aggregation) |

## Bench is signal, not gate (at v0.1) — and that's why OR-218 stays OPEN

Per Sprint 7 plan + Sprint 11 hardening tag, the bench harness lands in this commit but **CI does NOT block on bench results at v0.1**. Benchmark variance on shared CI runners is real; promoting to blocking now would create flake-induced merge friction without proportional defect-finding value.

**This is exactly why this scaffold does NOT close OR-218.** A non-blocking harness without enforceable thresholds cannot serve as the launch-blocking gate the ORT row demands. Codex `perf-bench-r1` HIGH (2026-05-05) flagged the original "closes OR-218" framing as overclaim; this README was updated as fix-forward.

The promotion path (Sprint 11 hardening / launch-prep):
1. **Add explicit p95 thresholds** to each bench (e.g., `crisisDetector.detect` p95 < 100μs on representative inputs)
2. **Wire `npm run bench` into CI as a required gate** (separate workflow `.github/workflows/perf.yml` per Sprint 11 / TLC-023b; baseline comparison via `vitest bench --outputJson <new-output>` for capture + `vitest bench --compare <baseline-file>` for diff against committed `tests/perf/baseline.json`)
3. **Add baseline comparison output** so regressions surface in PR reviews even when CI is non-blocking. Per-scenario p95 thresholds enforced by `tests/perf/check-thresholds.ts` reading the captured JSON output.
4. Re-evaluate the OR-218 status at Sprint 11 PM kickoff; only then mark CLOSED in the ORT.

Until those three conditions hold:
- Benches run on-demand locally + in a separate non-blocking CI workflow (when wired)
- Operators read trends, not pass/fail
- OR-218 stays OPEN in the ORT; this scaffold reduces its remaining work but does not retire the row

## Baseline.json provenance + scope

`tests/perf/baseline.json` is regenerated as a unit by `vitest bench --outputJson tests/perf/baseline.json`. Vitest does NOT support partial / additive baseline updates — every regen captures all currently-collected scenarios.

**Per Codex perf-bench-r2 + r3 MEDIUM closures 2026-05-05:** committed baseline scope at v0.1 is **crisis-detect scenarios ONLY** (Sprint 11 capture; 4 scenarios). The validate-transition scenarios (TLC-024) intentionally do NOT have a committed baseline at v0.1 because:

1. Local-dev-laptop measurements would weaken regression detection if committed (Codex r2 MEDIUM)
2. Doc-only discipline ("commit message rationale") is not enforceable (Codex r3 MEDIUM)
3. Real baseline values come from CI calibration at Sprint 13+ (after `perf.yml` has 3-5 stable runs on main)

**Sprint 13+ baseline expansion path (split: Sprint 13 BUILDS closure path; Sprint 14+ EXECUTES):**

Sprint 13 / TLC-026 lands the **closure-path infrastructure** so Sprint 14+ (or whenever CI variance data + Evans's `gh api` access converge) executes against a ready foundation:
- **Manifest-check helper** in `tests/perf/check-thresholds.ts`: `verifyManifestCoverage()` fails the gate if any expected scenario lacks a measured task in bench output. Runs BEFORE the per-threshold loop in `main()`. Codex perf-bench-r4 MEDIUM recommended fix; landed Sprint 13 (within TLC-026 scope).
- **Self-test mode** (`--self-test` CLI flag) covers §A good / §B missing-scenario / §C tail-missing / §D malformed-values fixtures so a regression in `check-thresholds.ts` itself surfaces before the bench harness even starts. `perf.yml` runs `--self-test` as a separate step BEFORE the bench step.

Sprint 14+ EXECUTES once 3-5 stable `perf.yml` main runs accumulate AND Evans is reachable for `gh api` execution:
- Capture the baseline from a controlled CI run (`gh run download <stable-run-id> --name bench-output-<id>`)
- Commit the CI-calibrated baseline (now covers all 8 scenarios — crisis-detect + validate-transition)
- Tighten thresholds based on observed CI variance (worksheet in `docs/TLC-023c-BRANCH-PROTECTION-WIRE-UP.md` §3)
- Evans flips the gate to required-blocking via the `gh api` PUT in `docs/TLC-023c-BRANCH-PROTECTION-WIRE-UP.md` §1
- Surface the "ready to flip" message when the variance data converges (Option A: SM signals; Evans executes)

**At v0.1 (Sprint 11 + Sprint 12 + Sprint 13):**
- Threshold gate (`check-thresholds.ts`) is the absolute correctness floor — works against any captured bench output, baseline-or-not
- Manifest-check helper (Sprint 13 / TLC-026) ensures the expected-vs-measured scenario set is verified BEFORE per-threshold checks — prevents silent gate-bypass when a bench file is removed or a scenario name drifts
- `--compare baseline.json` runs but only diffs against the 4 crisis-detect scenarios; validate-transition `--compare` output shows "no baseline match" at v0.1 (acceptable signal noise; no enforcement value lost because threshold gate covers all 8 scenarios)
- Future commits that regenerate baseline.json need `--scope=baseline-refresh` rationale in the commit message AND must come from a CI-calibrated capture, not a local run

### Known v0.1 trade-off (Codex perf-bench-r2/r3/r4 acknowledged; Sprint 13 closure path BUILT, Sprint 14+ EXECUTES)

Codex iteration produced 3 valid MEDIUM findings across rounds r2-r4 on the perf gate's relative-regression coverage. The findings converge on a structural observation: **at v0.1 there is no perfect baseline strategy**:

- **Commit local-laptop baseline:** weakens relative-regression detection for the captured scenarios (Codex r2)
- **Revert baseline + doc-only discipline:** discipline is not enforceable (Codex r3)
- **Revert baseline + scope to crisis-detect only:** validate-transition has no relative-regression coverage; first CI-calibrated baseline could encode already-regressed behavior (Codex r4)

**v0.1 trade-off accepted:** `check-thresholds.ts` absolute floor is the v0.1 enforcement boundary. Validate-transition relative-regression coverage was **escalated to Sprint 13 TLC-026** (Sprint 12 retro recorded this as the first-ever Codex escalation in 12 sprints, codifying the new "structural-constraint-not-code-defect" escalation pattern in `docs/PROJECT_CONVENTIONS.md`).

**Sprint 13 / TLC-026 BUILT the closure path (this commit):**

1. **Manifest-check helper landed:** `verifyManifestCoverage()` in `tests/perf/check-thresholds.ts` fails the gate if any expected scenario lacks a measured task in bench output. Runs BEFORE the per-threshold loop in `main()`. Closes the Codex perf-bench-r4 MEDIUM recommended fix.
2. **Self-test mode landed (`--self-test` CLI flag):** in-memory fixtures cover §A good / §B missing-scenario / §C tail-missing / §D malformed-values so a regression in `check-thresholds.ts` itself surfaces before the bench harness even starts. Wired into `.github/workflows/perf.yml` as a separate step BEFORE the bench step.
3. **Branch-protection handoff doc preserved:** `docs/TLC-023c-BRANCH-PROTECTION-WIRE-UP.md` (§1 PUT command + §2 CI variance plan + §3 threshold-tightening worksheet + §4 rollback procedure) is the Evans-side execution playbook. Untouched by Sprint 13 — referenced from Sprint 14+ when execution lands.

**Sprint 14+ EXECUTES the closure path** (deferred per Evans Option A constraint — no `gh auth` in the autonomous shell; SM surfaces "ready to flip" when CI variance data converges):

1. Capture baseline from a controlled CI run (after `perf.yml` has 3-5 stable main runs)
2. Tighten thresholds based on observed CI variance (worksheet in `docs/TLC-023c-BRANCH-PROTECTION-WIRE-UP.md` §3)
3. Evans executes the `gh api` PUT to flip `Performance benchmarks / bench` to required-blocking on `main`
4. ORT row OR-218 status flips from "scaffolded; closure path built" to "FULLY CLOSED" in the traceability matrix

Sprint 12 retro recorded this as **the first finding class where iterative fix-forward couldn't close in-sprint** because the underlying constraint (need real CI variance data to make non-arbitrary trade-offs) is structural, not a code defect. Sprint 13 closure-path landing demonstrates the escalation pattern's payoff: the Sprint 13 work is enforceable code (manifest helper + self-test) rather than a continuation of doc-only discipline that Codex r3 correctly flagged as unenforceable.

## Bench corpus at v0.1

| Bench file | Sprint | Target | Scenarios |
| --- | --- | --- | --- |
| `tests/perf/audit/crisis-detect.bench.ts` | 7 / TLC-018 | `crisisDetector.detect` (I-019 hot path) | §1–§4 (4 scenarios) |
| `tests/perf/state-machine/validate-transition.bench.ts` | 12 / TLC-024 | `validateTransition` (Async Consult slice hot path) | §5–§8 (1 happy + 3 reject paths) |
| `tests/perf/audit/emit-audit.bench.ts` | 17 / TLC-027 | `emitAudit` hash-chain append (DB-backed) | §9 (happy-path single-row append) |

9 bench scenarios total (8 pure-function + 1 DB-backed). Per-scenario p95 thresholds enforced by `tests/perf/check-thresholds.ts` against vitest bench `--outputJson` capture.

**Bench-mode DB-backed corpus** infrastructure landed Sprint 17 / TLC-027 (rebuilt from the reverted Sprint 14 / TLC-025 attempt; closes Codex `perf-bench-r10` 2 HIGH + 2 MEDIUM findings). Real `pg.Pool` via `setBenchPool()` (no savepoint translation), URL canonicalization, schema_migrations tracking, always-on setupFiles with `requireBenchDb()` gate.

### Running DB-backed benches

```bash
# 1. Provision a dedicated bench Postgres (DO NOT reuse dev or test DB)
createdb telecheck_bench

# 2. Set BENCH_DATABASE_URL in your .env (or shell env)
export BENCH_DATABASE_URL=postgresql://telecheck_bench:password@localhost:5432/telecheck_bench

# 3. Run benches as usual
npm run bench
```

`tests/perf/db/setup.ts` runs as `setupFiles` always (Sprint 17 / TLC-027 r10-A closure: was conditional on env presence, which fail-opened). The setup file's `beforeAll` fast-exits with success when `BENCH_DATABASE_URL` is unset, so pure-function benches still run with no Postgres dependency. DB-backed bench files explicitly call `requireBenchDb()` — throws clear actionable error when env is unset rather than silently falling back to dev DB.

**Fail-closed canonicalized URL collision check** (r10-C closure): `BENCH_DATABASE_URL` MUST canonicalize-differently from `DATABASE_URL` and `TEST_DATABASE_URL` (host:port/db comparison; auth credentials, query strings, host-alias variations normalized out).

**Tracked migration apply** (r10-D closure): bench DB has its own `schema_migrations_bench` table; each migration applies at most once; partial-apply failures leave the row un-INSERTed so the next session re-attempts and fails explicitly rather than silently skipping.

**Sprint 18+ DB-backed bench expansion path:**
- §10+ `idempotency.lookupIdempotencyRecord` — DB-backed; pre-populate per-tenant fixture; bench the lookup + miss + replay paths
- §11+ `withTenantBoundConnection` — RLS context-set + first-query latency
- §12+ repo CRUD on a representative table (e.g., consent_records insert + read)
- Threshold tightening: after `perf.yml` accumulates 3-5 stable runs of §9, capture observed p95, set tightened ceiling per Sprint 13 / TLC-023c §3 worksheet

## Per-slice landing pattern

When a new slice ships, slice authors add a per-slice benchmark file under `tests/perf/<slice>/<surface>.bench.ts`. Pattern:

```typescript
import { bench, describe } from 'vitest';
import { hotFunction } from '../../../src/modules/<slice>/.../service.ts';

describe('<slice> — <surface> latency', () => {
  bench('<scenario>', () => {
    hotFunction(/* representative input */);
  });
});
```

The example bench at `tests/perf/audit/crisis-detect.bench.ts` shows the pattern — **measures `crisisDetector.detect` latency**, the hot path that runs on every patient free-text input (per I-019 platform-floor; sees every form response string before persistence).

## What's testable today (v0.1) vs. what waits

| Surface | Bench-able now? | Why / why not |
| --- | --- | --- |
| `crisisDetector.detect` | ✅ yes | Pure function; no DB; hot path; example bench landed |
| `idempotency.lookupIdempotencyRecord` | ⚠️ infra ready | Sprint 17 bench-mode DB infra landed; first scenario Sprint 18+ |
| `emitAudit` (hash chain) | ✅ yes | Sprint 17 / TLC-027 §9 happy-path single-row append landed (`tests/perf/audit/emit-audit.bench.ts`) |
| `tenant-context` resolution | ✅ yes | Pure function (host-header → tenant lookup); host-header parsing benchable now |
| `errorEnvelope.buildErrorEnvelope` | ✅ yes | Pure function |
| Per-slice service handlers | ⛔ no until slice ships | E.g., `med-interaction.signal.check` BLOCKED on Med Interaction Engine slice PRD ratification |
| AI lab interpretation accuracy regression (per ADR-019) | ⛔ no until Labs slice ships | Slice not yet authored |

## Why scaffold over inline-asserts

Sprint 7 PM brief offered three options: (a) inline thresholds in integration tests, (b) scaffold infra, (c) descope. SM accepted option (b):

- **Option (a) — inline thresholds in integration tests**: flaky on shared CI; threshold drift is a known anti-pattern; mixing correctness + perf in one runner couples gating semantics inappropriately
- **Option (b) — scaffold infra (this directory)**: clean separation; bench-as-signal at v0.1 + bench-as-gate at Sprint 11; per-slice teams add benches with zero re-derivation cost
- **Option (c) — descope**: rejected because OR-218 is referenced by ADR-019 and Sprint 11 hardening will need the infra. Deferring to Sprint 11 pushes the scaffolding cost into launch-prep when other priorities will be higher.

## Spec references

- ORT v1.5 OR-218 (Performance and load test plan; Tier 1 launch-blocking)
- ADR-019 (AI lab interpretation accuracy regression — referenced by OR-218 scope expansion 2026-04-25)
- `Telecheck_Master_Platform_PRD_v1_10.md` §7 (interaction engine <2s SLA reference)

## Sprint reference

Authored Sprint 7 (TLC-018) on the autonomous Scrum cycle while SI-001 / SI-002 / SI-003 remain open upstream. PM-brief verification gate was the 2nd consecutive clean run (Evans 2026-05-05 oversight directive). After Sprint 7 closes, pre-pave runway is exhausted and Sprint 8+ work pivots to Async Consult slice authoring (PRD v1.0 verified to exist in spec corpus).
