# Sprint 7 Plan — Telecheck-app autonomous build

**Sprint:** 7
**Sprint goal:** Scaffold `tests/perf/` infra (Vitest bench mode) closing OR-218 at the foundation level; absorb OR-208 closure into BUILD_VS_SPEC_TRACEABILITY_MATRIX r2 (TLC-019 descoped).
**Sprint start commit:** `d7ae4eb` (Sprint 6 ACCEPTED)
**Commit budget:** 4 (kickoff + scaffold + bench config + matrix r2 + review/retro = 5 max; PM proposed 4 with 1.2× slack)
**Codex strategy:** FIRE on TLC-018 (novel test infra class — Vitest bench mode first appearance); SKIP on matrix r2 amend (pure docs)

---

## PM-brief verification gate findings (Sprint 7 — 2nd consecutive clean run)

| Identifier | Cited at (PM brief §) | Verified at (source-of-truth) | Match |
| --- | --- | --- | --- |
| OR-208 | §2 (TLC-019 descope) | `Telecheck_Operational_Readiness_Todo_v1_5.md:119` | ✓ |
| OR-218 | §2 (TLC-018) | `Telecheck_Operational_Readiness_Todo_v1_5.md:129` | ✓ |
| tests/perf/** | §3 | does NOT exist (Glob returned 0 files) | ✓ |
| `vitest.config.ts` no `benchmark:` key | §3 | confirmed (already read in earlier sprints) | ✓ |
| Async Consult PRD v1.0 | §5 | `Telecheck_Async_Consult_Slice_PRD_v1_0.md` exists | ✓ |
| P-010 (Promotion Ledger latest) | §1 | confirmed (Sprint 6 verification persists) | ✓ |
| ADR-019 / ADR-023 | §9 | canonical references | ✓ |

**Gate result: ALL PASS.** 2nd consecutive clean PM brief since the gate was instituted (Evans 2026-05-05 oversight directive). PM agent rubric extensions are working as designed.

---

## Promotion Ledger check

SI-001 / SI-002 / SI-003 remain **open** upstream. Latest entry P-010 (CDM §4.1 reconciliation 2026-05-02) — no P-011/012/013. Slice 4 schema work stays blocked.

---

## Stories committed

### TLC-018 — Foundation-layer perf budget infra scaffold (closes OR-218 at foundation level)

**Estimated commits:** 2 (scaffold + Codex fix-forward reserve)
**Decision rule:** 6 (UAT / launch-readiness)
**Current state baseline (PM verified):** `tests/perf/` does NOT exist; `vitest.config.ts` has no `benchmark:` key.

#### Approach (PM-recommended option (b) — scaffold infra)

PM brief listed 3 options; SM accepts option (b). Rationale:
- **Option (a) inline thresholds in integration tests** = flaky on shared CI (variance is real on shared runners; perf assertions inside vitest run would intermittently fail)
- **Option (b) scaffold tests/perf/ + 1 example bench + README** = clean separation; bench is signal not gate; slice teams add per-slice benches when slices ship
- **Option (c) descope** = OR-218 is referenced by ADR-019 + Sprint 11 hardening; deferring the infra scaffolding pushes the cost into Sprint 11 when other launch work has higher priority

#### Acceptance criteria

- New directory `tests/perf/` with:
  - `tests/perf/README.md` — operating model, bench-vs-test distinction, "bench is signal not gate at v0.1", per-slice landing pattern
  - `tests/perf/audit-emit.bench.ts` — example bench using Vitest `bench()` API; targets `emitAudit` hash-chain append latency (already a hot path; existing functional coverage at `tests/integration/audit-chain.test.ts`)
- `vitest.config.ts` extended with a `benchmark:` config block (separate from the existing `test:` block — vitest bench mode reads independently)
- `package.json` script `bench` → `vitest bench` (separate from `test`)
- CI does NOT block on bench results at v0.1 (per Sprint 11 hardening tag — promote to gate when launch-prep budget verification lands)
- Type-check + lint clean
- Codex FIRE on the scaffold (narrow scope: `tests/perf/` + `vitest.config.ts` + `package.json`)

#### Internal-canonicalization-pattern check (PM rubric sub-rule applied)

Bench harness does NOT depend on production-code canonicalization (it's measuring latency, not asserting on transformed values). N/A.

---

### TLC-019 — Data-filtering implementation status doc — DESCOPED at kickoff

**Status:** ❌ DESCOPED (PM verify-before-authoring at kickoff)
**Reason:** `BUILD_VS_SPEC_TRACEABILITY_MATRIX.md:31` (I-023 row) already documents ADR-023's 3-layer enforcement decision rationale + the test surface that proves it. §2 lines 81-83 cite `tenant-context.ts` (Layer 2), `rls.ts` (Layer 1), `kms.ts` (Layer 3) with their test files. KMS Layer 3 blocker captured (Admin Backend v1.1).

**Absorption path:** amend `BUILD_VS_SPEC_TRACEABILITY_MATRIX.md` to revision r2 with a one-line OR-208 reference back-link explicitly closing the ORT row's documentation surface. This avoids authoring a duplicate doc (Sprint 1 retro lesson "verify before authoring" applied to docs work, not just tests).

---

## Definition of Done — Sprint 7

- [ ] TLC-018 `tests/perf/` scaffold + 1 example bench + README authored
- [ ] `vitest.config.ts` extended with `benchmark:` config
- [ ] `package.json` script `bench` added
- [ ] Codex FIRE on TLC-018; HIGH/CRITICAL findings closed in-sprint
- [ ] Traceability matrix r2 amend with OR-208 back-link
- [ ] Lint + type-check clean
- [ ] No invariants relaxed
- [ ] No production-code changes (TLC-018 = test infra; matrix r2 = pure docs)
- [ ] `docs/SPRINT_7_REVIEW.md` filed (with Codex findings + verification gate findings)
- [ ] `docs/SPRINT_7_RETRO.md` filed
- [ ] PM kickoff brief for Sprint 8 (next; pivot decision to Async Consult slice)

---

## Risks (PM-flagged + SM additions)

- **PM Risk 1: Vitest bench mode operational risk.** `vitest bench` requires explicit invocation (separate from `vitest run`). Wire via `bench` npm script; ensure CI does NOT block on bench results at v0.1. Document in scaffold README.
- **PM Risk 2: Bench harness flaky-by-design on shared CI.** If Codex flags this, fall back to soft-asserts marked `// SOFT-PERF` with Sprint 11 hardening tag. Don't block sprint close.
- **SM addition: pre-pave-runway-exhaustion proximity.** TLC-018 + descoped TLC-019 essentially close the Sprint 6 backlog forward-look. After Sprint 7 lands, Sprint 8 must pivot to either:
  - (a) Async Consult slice authoring (PRD v1.0 verified to exist — `Telecheck_Async_Consult_Slice_PRD_v1_0.md`)
  - (b) Surface to Evans: "no further pre-pave; awaiting upstream SI closures + emergency-access vendor integration"

---

## Codex strategy detail

**TLC-018 — FIRE.** Narrow scope:
```
node "C:/Users/menso/.claude/plugins/cache/openai-codex/codex/1.0.4/scripts/codex-companion.mjs" adversarial-review "--background --base d7ae4eb tests/perf/ vitest.config.ts package.json"
```

Hard 15-min cap. If Codex flags the bench harness as flaky-by-design, fix-forward to soft-asserts pattern.

**Matrix r2 amend — SKIP.** Pure docs amendment; no novel surface.
