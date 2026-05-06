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

## Bench corpus at v0.1

| Bench file | Sprint | Target | Scenarios |
| --- | --- | --- | --- |
| `tests/perf/audit/crisis-detect.bench.ts` | 7 / TLC-018 | `crisisDetector.detect` (I-019 hot path) | §1–§4 (4 scenarios) |
| `tests/perf/state-machine/validate-transition.bench.ts` | 12 / TLC-024 | `validateTransition` (Async Consult slice hot path) | §5–§8 (1 happy + 3 reject paths) |

8 bench scenarios total. Per-scenario p95 thresholds enforced by `tests/perf/check-thresholds.ts` against vitest bench `--outputJson` capture.

**Bench-mode DB-backed corpus** is NOT yet provided at v0.1. Targets that require Postgres (e.g., `emitAudit` hash chain, `withTenantBoundConnection`, idempotency lookup, repo CRUD) are deferred to Sprint 13+ pending bench-mode ephemeral-DB setup investment.

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
| `idempotency.lookupIdempotencyRecord` | ⚠️ partial | DB-backed; needs ephemeral Postgres in bench harness — defer to Sprint 8+ |
| `emitAudit` (hash chain) | ⚠️ partial | DB-backed for FOR UPDATE serialization — same blocker |
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
