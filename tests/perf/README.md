# tests/perf/ — Foundation-layer performance benchmarks

**Sprint 7 / TLC-018.** Closes ORT row OR-218 ("Performance and load test plan — interaction engine <2s, emergency <60s under p95 load — scope expanded 2026-04-25 to include AI lab interpretation accuracy regression per ADR-019"; verified at `Telecheck_Operational_Readiness_Todo_v1_5.md:129`).

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

## Bench is signal, not gate (at v0.1)

Per Sprint 7 plan + Sprint 11 hardening tag, the bench harness lands in this commit but **CI does NOT block on bench results at v0.1**. Benchmark variance on shared CI runners is real; promoting to blocking now would create flake-induced merge friction without proportional defect-finding value.

The promotion path:
- **Sprint 11 hardening / launch-prep** — add explicit p95 thresholds to each bench; wire `npm run bench` into CI pipeline as a gate.
- Until then: benches run on-demand locally + in a separate non-blocking CI workflow (when wired); operators read trends, not pass/fail.

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
