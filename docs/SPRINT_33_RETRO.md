# Sprint 33 — Retrospective

**Sprint:** 33
**Closed:** 2026-05-08
**Final commit:** `049826b` (Merge PR #47 — SI-006 PR-E onSend cache-write removal + Group F lockdown)
**Sprint goal (recap):** Land SI-006 PR-F1 through PR-F4 (per-endpoint TTL overrides + forms-intake migration + identity migration + tenant-config 503-stubs) plus PR-E (legacy onSend cache-write removal + Group F source-grep lockdown). Five PRs across the densest Codex-review-iteration window in the autonomous arc to date.
**Goal achieved:** ✅

---

## What went well

- **5 PRs landed in one sprint.** PR-F1 (`9276b08` + r2 `e3e3bd0` + r3 `fadedf2` + r4 `3463aeb`), PR-F2 (`2eeeaa0` + r2 `54b01b0` + r3 `620c956` + r4 `420d976` + r5 `676b0bc`), PR-F3 (`a29d601` + r2 `5d004ce` + r3 `1d8881d` + r4 `214216c` + r5 `536f374`), PR-F4 (`165b311`), PR-E (`5352681` + r2 `1878e00`). PRs #43, #44, #45, #46, #47 all merged in the sprint window.
- **§5.12 asymptotic-convergence expectation validated under load.** PR-F1 needed 4 Codex rounds; PR-F2 needed 5; PR-F3 needed 5. Per the §5.12 fingerprint, each round closed real new findings rather than oscillating — and the area-under-review was genuinely cross-cutting (idempotency cache TTL + crisis audit durability + identity session refresh + tenant context all touched in the same cycle). The §5.1 cap (5+ rounds = pause) did NOT trigger on these PRs because the distinguishing fingerprint held: cumulative findings monotonically increasing, no fix oscillation, no finding-class re-spelling.
- **PR-F1 closed 3 HIGH findings.** Route-pattern endpoint derivation (r2), legacy-onSend TTL gap (r3), reservation-lock vs cached-response TTL split (r4). The TTL split (r4) was the subtlest of the cycle: prior to the fix, a stuck handler past the override TTL could see another retry purge its reservation and re-execute irreversible side effects, breaking exactly-once. Codex caught it; the fix preserves migration-005 column-default 24h reservation-lock while applying override TTL only at the pending → completed UPDATE.
- **PR-F2 closed 3 HIGH + 1 MEDIUM via the return-cached-vs-throw discipline (§3.8 codification).** r2 closed the crisis-audit durability gap (independent-tx Cat A audit emission per §3.9 draft); r3 closed the duplicate-emit-on-retry HIGH by switching CRISIS_DETECTED + RESPONSE_PAYLOAD_TOO_LARGE + isHandledSentinel from throw to return-as-cached inside the `withIdempotency` body; r4 aligned the cached 4xx envelope shape with the global `error-envelope.ts` shape (MEDIUM). The deferred HIGH (crash-window duplicate Cat A audits) was explicitly carried forward to Sprint 34 PR #49 audit-dedupe.
- **PR-F3 closed 2 HIGH + 3 MEDIUM.** PHONE_TAKEN unmapped error (r2 MEDIUM); SAVEPOINT discipline around phone-takeover catch (r3 HIGH); skip onSend cache for sessionRefreshHandler (r4 MEDIUM); exempt `/v0/identity/sessions/refresh` from preHandler cache (r5 — closed the upgrade-path replay HIGH).
- **PR-E closed 1 MEDIUM at r2.** Group F source-grep lockdown patterns were initially narrow (literal `addHook('onSend',` etc.); r2 broadened to catch spelling variants while running against comment-stripped source — codified as §5.11 comment-stripped source-grep convention in PROJECT_CONVENTIONS r5.
- **PR-F4 closed clean at r1 APPROVE.** Tenant-config admin-write 503-stub markers (`165b311`) — the lightest of the F batch since no business mutation actually occurs (all 5 admin-write handlers fail-closed pending Admin Backend slice v1.1 PRD ratification).

## What didn't go well

- **PR-F2 r5 was a prettier format fix.** `676b0bc` (PR-F2 r5 — prettier format fix on submissions.ts) was an avoidable round — running `npm run format` before pushing the r4 commit would have caught it. Not a Codex round, but it added a CI-cycle to the convergence count.
- **PR-F3 took 5 rounds.** Identity handler retrofit surfaced more interaction-with-existing-code than expected: PHONE_TAKEN unmapping, SAVEPOINT discipline against phone-takeover catch, sessionRefreshHandler cache-skip, sessions-refresh exemption all touched different parts of the identity surface. Each was a real finding; the count reflects identity's interaction density with the idempotency cache.
- **The crash-window duplicate-emit HIGH was deferred from PR-F2 r4 to a follow-on SI.** This was the correct call (the fix required cross-cutting audit_dedupe_markers infrastructure that didn't fit cleanly in the forms-intake PR), but it meant Sprint 33 closed with one acknowledged-deferred HIGH carried into Sprint 34.
- **No `SPRINT_33_PLAN.md` exists in the docs tree.** `[NEEDS VERIFICATION FROM EVANS]` — the Sprint 33 scope is reconstructed from the SI-006 closure doc + commit messages.

## Process changes adopted

- **§3.7 reserve-then-execute** codified as canonical pattern (drafted across PR-A → PR-E; codified Sprint 33-34 close in PROJECT_CONVENTIONS r5). Every state-changing HTTP handler owns its idempotency cache atomically via `withIdempotency` / `withIdempotentExecution`. Legacy preHandler-lookup + onSend-cache-write split is dead.
- **§3.8 return-cached-vs-throw discipline for sentinel paths inside withIdempotency.** Drafted at PR-F2 r3; codified Sprint 33-34. Three sentinel-classes (CRISIS_DETECTED, RESPONSE_PAYLOAD_TOO_LARGE, isHandledSentinel) return `{ status: 4xx, view: errorEnvelope }` rather than throwing, so cached retries replay the same 4xx without re-executing irreversible side effects.
- **§3.9 independent-tx Category A audit emission with dedupe markers.** PR-F2 r2 introduced the independent-tx pattern; the dedupe-markers half landed Sprint 34 PR #49.
- **§5.11 comment-stripped source-grep convention.** PR-E r2 surfaced that narrow regexes miss spelling variants while broad regexes false-positive on doc-comments that intentionally reference removed symbols. The `stripComments(src)` helper closes both gaps at once. Codified Sprint 33-34.
- **§5.12 asymptotic-convergence expectation** codified from cumulative Sprint 32-33 experience. Expected 4-5 Codex rounds per substantive cross-cutting concurrency PR; do NOT trigger §5.1 (5+ rounds = pause) when the iteration shape is productive ("found new HIGH each round, fixed it, surfaced the next").

## Codex review findings closed

| PR | Finding | Severity | Round | Closure commit |
|---|---|---|---|---|
| #43 / PR-F1 | route-pattern endpoint derivation | HIGH | r2 | `e3e3bd0` |
| #43 / PR-F1 | legacy-onSend TTL gap | HIGH | r3 | `fadedf2` |
| #43 / PR-F1 | reservation-lock vs cached-response TTL split | HIGH | r4 | `3463aeb` |
| #44 / PR-F2 | crisis-audit durability (rollback-with-handler-tx) | HIGH | r2 | `54b01b0` |
| #44 / PR-F2 | duplicate-emit-on-retry (return-as-cached for sentinels) | HIGH | r3 | `620c956` |
| #44 / PR-F2 | cached 4xx envelope shape alignment | MEDIUM | r4 | `420d976` |
| #45 / PR-F3 | PHONE_TAKEN unmapped | MEDIUM | r2 | `5d004ce` |
| #45 / PR-F3 | SAVEPOINT discipline around phone-takeover catch | HIGH | r3 | `1d8881d` |
| #45 / PR-F3 | sessionRefreshHandler cache-skip | MEDIUM | r4 | `214216c` |
| #45 / PR-F3 | sessions-refresh preHandler-cache exemption (upgrade-path replay) | HIGH | r5 | `536f374` |
| #45 / PR-F3 | aborted-tx poison (PR-F3 r3 follow-on) | MEDIUM | r3 | `1d8881d` |
| #46 / PR-F4 | tenant-config 503-stub markers | (APPROVE) | r1 | `165b311` |
| #47 / PR-E | onSend cache-write removal + lockdown patterns | MEDIUM | r2 | `1878e00` |

Sprint 33 substantive closures: 7 HIGH + 5 MEDIUM (12 findings across 5 PRs / 11 fix-forward rounds). One acknowledged-deferred HIGH (PR-F2 r4 crash-window duplicate Cat A audits) carried into Sprint 34.

## Carry-forward to next sprint

- **PR #48 cleanup-sweep** — delete `markIdempotencyManagedByHandler` no-op + 31 call sites + extend Group F lockdown to pin its identifier absence. The flag was an interim PR-B r2 closure that became dead code once PR-E removed the legacy onSend path; this PR removes the dead code.
- **PR #49 audit-dedupe SI** — close the PR-F2 r4 deferred HIGH via cross-cutting `audit_dedupe_markers` table + `claimAuditDedupeSlot` helper + bodyHash + per-endpoint TTL alignment.
- **PR #51 async-consult HTTP integration tests** — close the §3 state-machine coverage gap on the async-consult lifecycle.
- **PROJECT_CONVENTIONS r5 promotion** — codify §3.7 / §3.8 / §3.9 / §5.11 / §5.12 patterns now that the cycle has converged.
- **BUILD_VS_SPEC_TRACEABILITY_MATRIX r5 bump** — document Sprint 33-34 cumulative state.
- **SI-006 v0.2 → v0.3 implementation closure section** — add the closure section at the bottom of the SI doc; status flipped from Open to Resolved.

## Sprint reference / cross-links

- `SI-006-Idempotency-Reserve-Then-Execute-Redesign.md` v0.2 (PR-F batch + PR-E faithful to v0.2 design)
- `PROJECT_CONVENTIONS.md` r5 §3.7 / §3.8 / §3.9 / §5.11 / §5.12 (drafted from this sprint's experience; codified Sprint 34)
- `BUILD_VS_SPEC_TRACEABILITY_MATRIX.md` r5 (Sprint 34 cumulative state — Sprint 33 contributions reflected)
- `SPRINT_32_RETRO.md` carry-forward (PR-F1 / F2 / F3 / F4 + PR-E batch) — closed here
- `SPRINT_34_RETRO.md` (next; cleanup-sweep + audit-dedupe SI + async-consult HTTP tests + docs r5 codification)
