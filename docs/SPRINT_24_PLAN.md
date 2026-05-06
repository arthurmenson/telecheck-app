# Sprint 24 Plan — Telecheck-app autonomous build

**Sprint:** 24
**Sprint goal:** TLC-045 close the last barrier between 101/101 ci.yml file-level (Sprint 23 milestone) and **fully green ci.yml workflow conclusion** — fix the unhandled Fastify `ERR_HTTP_HEADERS_SENT` error in the §3b POST /abandon code path.
**Sprint start commit:** `47273e7` (Sprint 23 close; PR #21 merged).
**Branch posture:** feature-branch + PR.
**Commit budget:** 5 (1 investigation/r1 + 1 r2 fix-forward + 1 sprint close + 2 reserves; "executable here" 1.2× / 2-reserves with one r2 budget for redirect on hypothesis miss).
**Codex strategy:** SKIP per §5.2 — narrow stop-gap fix on known v0 limitation; novel-of-class authoring rule does not trigger. (TLC-045's proper fix — reserve-then-execute idempotency redesign — is a separate slice-implementation concern filed via EHBG §12 SI/DSI escalation; not in scope for Sprint 24.)

---

## PM-brief verification gate findings (Sprint 24 — 19th consecutive ALL PASS)

5 cited identifiers verified pre-execution:
- P-008/P-009/P-010 latest 3 ledger entries — verified
- OR-218 — FULLY CLOSED at `Telecheck_Operational_Readiness_Todo_v1_5.md:129`
- Sprint 23 retro Sprint 24 candidate scope (TLC-045 priority 1) — verified
- `src/lib/idempotency.ts:onSend` (suspected source) — verified
- `src/modules/async-consult/internal/handlers/consults.ts:mapServiceError` (actual root cause) — verified at file

19 consecutive PM-brief gate ALL PASS.

---

## Sub-stories committed

### TLC-045 — Fastify ERR_HTTP_HEADERS_SENT in §3b path (FULL ACCEPTANCE)

**Estimated commits:** 2 (r1 hypothesis attempt + r2 root-cause fix-forward).

#### r1 (`7970fc4`) — idempotency.ts catch+log

**Initial hypothesis:** the storeIdempotencyRecord call in idempotency.ts onSend hook was throwing on DB error, and Fastify converting that throw to an error response was calling safeWriteHead on already-sent headers.

**Fix attempt:** wrap storeIdempotencyRecord in try/catch; emit fastify.log.error on failure; return payload normally.

**Result:** did NOT close the unhandled error. Ran ci.yml on r1 — `ERR_HTTP_HEADERS_SENT` still fires. Hypothesis was wrong; the throw is not from idempotency.ts.

**Decision:** keep r1 as defense-in-depth (logging vs throwing is the better shape regardless), iterate to r2 with corrected hypothesis.

#### r2 (`189b5ae`) — `return reply` after mapServiceError

**Corrected hypothesis:** the bug is in the async-consult handler error-mapping pattern. Pattern:
```typescript
catch (err) {
  if (mapServiceError(err, reply, req.id)) return;
  throw err;
}
```
And `mapServiceError` uses `void reply.code(404).send(...)` then `return true`. The handler then `return;`s undefined.

In Fastify v5: when a handler returns undefined and the reply hasn't finished its onSend pipeline, Fastify treats undefined as "no response yet" and schedules ANOTHER `reply.send(undefined)`. When that second send's onSendEnd fires, `safeWriteHead` throws because the first send already wrote headers → ERR_HTTP_HEADERS_SENT.

**Fix:** change `return;` to `return reply;` at all 6 mapServiceError call sites in `src/modules/async-consult/internal/handlers/consults.ts`. This signals to Fastify "I've handled the response, don't auto-wrap my return value."

**Result:** ci.yml `Build, lint, typecheck, test` SUCCESS. **Fully green ci.yml workflow conclusion for the first time in the autonomous arc.**

#### Acceptance criteria

- ✅ r1 idempotency.ts catch+log defensive fix landed
- ✅ r2 `return reply` Fastify-idiomatic pattern fix landed
- ✅ ci.yml workflow conclusion: SUCCESS
- ✅ All 1404 tests passing
- ✅ Zero unhandled errors
- ✅ PR #22 opened + merged (`ac80baf`)

---

## Definition of Done — Sprint 24

- [x] PM-brief verification gate ran (19/19 ALL PASS)
- [x] r1 fix landed (initial hypothesis attempt)
- [x] r2 fix-forward landed (corrected hypothesis)
- [x] PR #22 merged (`ac80baf`)
- [x] ci.yml: fully green workflow conclusion
- [x] `docs/SPRINT_24_PLAN.md` filed (this doc)
- [ ] `docs/SPRINT_24_REVIEW.md` filed (next)
- [ ] `docs/SPRINT_24_RETRO.md` filed (next)

---

## Sprint 25 hand-off

When Sprint 24 closes, the autonomous arc enters **post-CI-green steady state**. Remaining Sprint 25 candidates:

1. **TLC-038** (priority 1): PROJECT_CONVENTIONS r3 → r4 codification — promote §5.7 (shared-root-cause cluster) + §5.8 (pattern-mirror SKIP) + §5.9 (Fastify-idiom-mismatch class). Three+ proof-points each now.
2. **TLC-042 + TLC-043** (priority 2): re-validate post-merges. With ci.yml fully green, both should be transitively resolved; quick verification sprint.
3. **TLC-046** (priority 3, NEW candidate): file `idempotency-redesign-reserve-then-execute` issue per EHBG §12 SI/DSI escalation. The v0 onSend cache pattern is best-effort by design and not transactionally-safe. The proper fix is the reserve-then-execute redesign that runs the idempotency state machine inside the business transaction. This is a SLICE-implementation concern — not in scope for the autonomous arc; should hand off to the first slice with serious concurrent-write semantics.
4. **TLC-044 lock-key audit** (priority 4): confirm no other test-setup operations have parallel-fork races (audit the rest of `tests/setup.ts` + any plugin's tests/-side install sequences).
