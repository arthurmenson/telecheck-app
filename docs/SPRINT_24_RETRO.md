# Sprint 24 Retrospective — Telecheck-app autonomous build

**Sprint:** 24
**Window:** 2026-05-06 (single-day, post-Sprint-23 close).
**Sprint goal:** TLC-045 close last barrier to fully green ci.yml workflow — **FULL ACCEPTANCE.**
**Total commits:** 3 / 5 budgeted (60% utilization).

---

## What went well

- **r1-r2 hypothesis iteration paid off in a single sprint.** The r1 fix (idempotency.ts catch+log) was a reasonable hypothesis based on the file-path origin of the unhandled error, and worth trying. When CI showed the error persisted, the corrected hypothesis (Fastify v5 handler-pattern double-send race) was supported by stack trace evidence + handler-source inspection. The r2 fix (`return reply`) is a 1-line/6-call-site change and closed the issue cleanly. This is the first time in the autonomous arc where a Sprint plan budgeted for hypothesis iteration explicitly. Worked as intended.
- **MILESTONE: fully green ci.yml workflow conclusion for the first time in the autonomous arc.** 5-sprint recovery arc complete: Sprint 19 (91/101) → Sprint 24 (101/101 + 1404/1404 + 0 unhandled errors). Cumulative throughput: ~12 finding-classes closed, 8 PRs landed in CI-recovery scope, 5 of those producing fixes (3 PR shells for sprint close), 0 regressions.
- **Defense-in-depth retained.** r1's catch+log fix in idempotency.ts is preserved even after r2 closed the actual root cause. The aligned-with-design-intent shape (log on failure rather than throw) is the correct shape regardless. If a future change re-exposes a throw in storeIdempotencyRecord, the catch+log gate prevents the throw from poisoning the response pipeline. This is platform-floor hardening, not just bug-fix.
- **PM-brief verification gate landed clean for the 19th consecutive sprint.**

---

## What didn't

- **r1 hypothesis was wrong.** Spent ~30% of sprint budget on a hypothesis that didn't pan out. Lessons: the file-path origin of an unhandled error in vitest's "originated in X" message refers to the test file, not the source file — investigation should look at the handler chain in src/, not just the file mentioned in error.
- **No Codex round.** Three consecutive SKIP-per-§5.2 sprints (Sprint 22 + 23 + 24). All three were defensible (pattern-mirror, narrow stop-gap), but the absence of fresh adversarial-review evidence on a major ci-recovery arc is a thin patch in the audit trail. Sprint 25 should run a Codex retrospective adversarial review on the cumulative Sprint 19→24 changes to backfill.

---

## Process changes for Sprint 25

1. **Codex retrospective adversarial review.** Run Codex on the cumulative Sprint 19→24 change set as a single review. Use the codex-companion script per CLAUDE.md `Codex autoinvocation` rule. Expected scope: tests/setup.ts (advisory-lock additions), src/lib/idempotency.ts (catch+log), src/modules/async-consult/internal/handlers/consults.ts (return reply pattern). If new findings emerge, fold them into a Sprint 25 fix-forward.
2. **TLC-038 priority 1.** PROJECT_CONVENTIONS r3 → r4 codification has 4 demonstrable proof-points to promote (§5.7 shared-root-cause cluster + §5.8 pattern-mirror SKIP + §5.9 Fastify-idiom-mismatch + §5.10 r1-r2 hypothesis iteration). Each is supported by 1+ closed sprint. Sprint 25 should land the doc-only update.
3. **Sprint 25 candidate scope:**
   - **TLC-038** (priority 1): PROJECT_CONVENTIONS r4 codification (4 new sub-rules)
   - **Codex retro** (priority 2): adversarial review on cumulative Sprint 19→24 changes
   - **TLC-042 + TLC-043** (priority 3): re-validate transitively-resolved (likely already passing)
   - **TLC-046** (priority 4, NEW): file `idempotency-redesign-reserve-then-execute` per EHBG §12 — proper redesign for slice-implementation hand-off
   - **TLC-047** (priority 5, NEW candidate): audit other handlers for the `void reply.send(); return;` pattern outside async-consult (likely none per Sprint 24 grep, but verify)

---

## Lessons feeding the PM rubric

**Promotion candidates (Sprint 25 codification):**

> **§5.9 — Fastify-idiom-mismatch finding-class.** When CI surfaces a Node/Fastify lifecycle error (`ERR_HTTP_HEADERS_SENT`, `ECONNRESET`, `ERR_STREAM_PREMATURE_CLOSE`) that isn't a test logic failure, suspect a handler-pattern mismatch with the framework version. For Fastify v5 specifically: `return reply` rather than `return;` after `reply.send()`; never use `void reply.send()` in error-mapping pre-throw branches. Proof point: Sprint 24 TLC-045 r2.
>
> **§5.10 — r1-r2 hypothesis-iteration discipline.** When a fix lands and CI shows the same symptom unchanged, the hypothesis is wrong (not the implementation). Iterate to a corrected hypothesis from CI evidence + source inspection inside the same sprint cap (1 r2 budget). If r2 also misses, escalate to investigation-sprint deferral. Proof point: Sprint 24 TLC-045 (r1 idempotency.ts → wrong; r2 handler-pattern → right).

---

## Codex tracking — Sprint 24 finding ledger

| Round | Sub-story | Severity | Status |
|---|---|---|---|
| (none) | TLC-045 r1 | — | Codex SKIP per §5.2 (narrow stop-gap; defense-in-depth shape) |
| (none) | TLC-045 r2 | — | Codex SKIP per §5.2 (Fastify-v5 idiomatic-pattern fix) |

Total Sprint 24: 0 Codex rounds; 0 findings. **Sprint 25 retrospective Codex round on cumulative Sprint 19→24 scope is queued.**

---

## Final commit cumulative state

- Sprint 24 head: `<TBD>` on `feat/sprint-24-close` (PR #23)
- Sprint commits: 3 (PR #22 r1 `7970fc4` + r2 `189b5ae` + this Sprint 24 close on PR #23) of 5 budget = 60% utilization
- Process docs: SPRINT_24_PLAN.md + SPRINT_24_REVIEW.md + SPRINT_24_RETRO.md
- Code state: r1 catch+log + r2 return-reply fixes landed (`ac80baf`)
- **ci.yml: fully green workflow conclusion + 101/101 + 1404/1404 + 0 errors — autonomous arc enters post-CI-green steady state**
- Sprint 25 hand-off: TLC-038 r4 codification + Codex retrospective adversarial review + low-priority hygiene (TLC-042/043/046/047)
