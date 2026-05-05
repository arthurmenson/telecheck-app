# Sprint 4 Plan — Telecheck-app autonomous build

**Sprint:** 4
**Sprint goal:** Apply the BLOCKED-aware skeleton recipe a 3rd time (Subscription) + audit crisis-detection (I-019) coverage with a lockdown regression test, while SI-001/002/003 remain open upstream.
**Sprint start commit:** `78e9de9` (Sprint 3 ACCEPTED)
**Commit budget:** 4 (2 story commits × 1.2 slack ≈ 3; +1 PM-rubric update + Sprint 4 plan combined; +1 review/retro)
**Codex strategy:** SKIP per pre-empt rationale on both stories (3rd pattern-mirror skeleton + pure documentation/lockdown test; novelty near-zero)

---

## Promotion Ledger check (verified by PM at kickoff)

SI-001 / SI-002 / SI-003 remain **open** upstream. Latest entry: P-010 (CDM §4.1 reconciliation 2026-05-02). No P-011 / P-012 / P-013. Slice 4 schema work stays blocked.

---

## Stories committed

### TLC-010 — Subscription module skeleton (BLOCKED-aware)

**Estimated commits:** 1
**Decision rule:** 4 (new unblocked slice prep)
**Current state baseline (verified by PM):** `src/modules/subscription/` does NOT exist.

#### Acceptance criteria

- New module directory `src/modules/subscription/` with: `index.ts`, `plugin.ts`, `routes.ts`, `internal/types.ts`, `README.md`
- Branded ID types (anticipated CDM entity inventory): `SubscriptionId`, `SubscriptionScheduleId`, `SubscriptionPauseId`
- Plugin registers under `/v0/subscription` with:
  - `GET /health` → 200 with informational `blocked` metadata
  - `GET /ready` → 503
- Plugin registered in `src/app.ts`; both probes allowlisted in `tenantContextPlugin`
- 2-case plugin smoke test mirroring pharmacy + med-interaction patterns
- README BLOCKED banner explains: Subscription depends on MedicationRequest schema for refill cadence; row shapes await SI-001 closure; branded ID ships now so downstream slices (Pharmacy + Refill, Async Consult) can typed-import
- ZERO repos / services / migrations
- Type-check + lint clean

---

### TLC-012-rescoped — Crisis-detection (I-019) coverage audit + lockdown test

**Estimated commits:** 1
**Decision rule:** 3 (diminishing-returns hygiene) — invariant-coverage discipline
**Current state baseline (verified by PM via grep):**

| File | Function context | Invokes `crisisDetector`? |
| --- | --- | --- |
| `src/lib/crisis-detection.ts:251` | singleton declaration | (declaration) |
| `src/modules/forms-intake/internal/services/submission-service.ts:289` | `scanResponsesForCrisis` walker | **Y** |
| `src/modules/identity/**` | login / accounts / devices / registration | N (no free-text patient-input — out of I-019 scope) |
| `src/modules/consent/**` | consents / delegations | N (structured-acknowledgment-only — out of I-019 scope) |
| chat / community modules | not yet authored | N/A (Sprint 7+) |

PM finding: clean bill of health for current modules. Rescope: documentation + lockdown regression test, not new production code.

#### Acceptance criteria

- New doc `docs/CRISIS_DETECTION_COVERAGE_AUDIT_2026-05-05.md` documenting:
  - I-019 rule citation (platform-floor; never disable, never gate behind config)
  - Per-module audit table (above) with scope-rationale column
  - Gating principle: any future module accepting free-text patient input MUST scan with `crisisDetector` before persistence
  - Sprint reference (TLC-012-rescoped, Sprint 4)
- New regression test `tests/integration/crisis-detection-coverage-lockdown.test.ts` asserting:
  - `submission-service.processSubmission` invokes `crisisDetector.detect` for free-text response fields (the only known I-019 invocation today)
  - Test fails IF a future refactor removes the call (regression lockdown)
- ZERO new production-code paths added
- Type-check + lint clean

---

## Definition of Done — Sprint 4

- [ ] TLC-010 plugin-wiring test passes (2 cases)
- [ ] TLC-012-rescoped lockdown test passes (1+ cases asserting `crisisDetector` invoked)
- [ ] Coverage audit doc filed
- [ ] CI green at sprint end
- [ ] No invariants relaxed (I-019 specifically reaffirmed via lockdown test)
- [ ] No production-code changes outside scope
- [ ] PM rubric updated with Sprint 3 retro lessons (verify-before-authoring sub-rule + wire-protocol vocabulary check)
- [ ] `docs/SPRINT_4_REVIEW.md` filed
- [ ] `docs/SPRINT_4_RETRO.md` filed
- [ ] PM kickoff brief for Sprint 5 (next)
- [-] Codex SKIPPED per pre-empt rationale (rationale enumerated in review doc)

---

## Risks (PM-flagged)

- **Sprint 4 budget might feel too small.** 3 commits projected; acceptable per autonomous-mode discipline favoring short, definitively-scoped sprints. If utilization stays low across Sprint 5+ AND SI-001 remains open, that's a signal we're running out of pre-pave work — Sprint 5+ should pivot to higher-value work (e.g., performance budget verification, ORT v1.5 launch-readiness items that don't depend on schema).
- **TLC-012-rescoped's lockdown test might be over-fitted.** Asserting `crisisDetector.detect` is invoked is necessary but not sufficient — the test must avoid asserting specific argument shapes that would break if `submission-service` legitimately refactors. Mitigation: assert call count + that the function-under-test was called WITH a free-text-like input, not specific argument identity.

---

## Codex skip rationale (Sprint 2/3 retro pattern, applied 4th time)

Both Sprint 4 stories are pattern-mirrors:
- TLC-010 mirrors pharmacy (TLC-001 Sprint 1) + med-interaction (TLC-007 Sprint 3) skeleton recipe — already Codex-reviewed; the only finding (`pharmacy-blocked-handler` MEDIUM) is applied a-priori.
- TLC-012-rescoped is pure documentation + lockdown test on existing production code (no new production paths). Nothing for Codex to adversarially review on the production side.

Test assertions covering Codex's likely findings:
- TLC-010 plugin-wiring smoke test (mirror of `pharmacy-plugin-wiring.test.ts` + `med-interaction-plugin-wiring.test.ts`) — covers plugin registration + `/health` + `/ready` envelopes
- TLC-012-rescoped lockdown test — covers I-019 invocation surface for the single known caller, locking the contract against regression

If Sprint 5 picks higher-novelty work (e.g., Slice 4 schema if SI-001 closes; OR audit-chain-walker extensions; OR I-029 6-condition gate test scaffolding), fire Codex with explicit narrow scope path + 15-min hard cap.
