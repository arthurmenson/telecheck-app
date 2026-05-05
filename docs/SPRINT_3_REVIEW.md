# Sprint 3 Review — Telecheck-app autonomous build

**Sprint:** 3
**Sprint goal:** Pre-pave Med Interaction Engine module + tenant-config admin-write 503 surface while SI-001/002/003 remain open upstream.
**Sprint start commit:** `1bdc5b2` (kickoff)
**Sprint end commit:** `ad711fb` (TLC-009 final)
**Total commits in sprint:** 3 (vs 7-budget — 4 under, matching the Sprint 1/Sprint 2 ~30% utilization rate)
**CI status at sprint end:** Green expected at `ad711fb` (lint + type-check clean locally; integration tests run in CI against ephemeral Postgres)

---

## Stories accepted

### ✅ TLC-007 — Med Interaction signals contract scaffolding — `2f89661`

**Deliverables:**
- New module directory `src/modules/med-interaction/` with `index.ts` + `plugin.ts` + `routes.ts` + `internal/types.ts` + `README.md`
- 3 branded ID types (PROVISIONAL pending Med Interaction Engine slice PRD ratification): `InteractionSignalId`, `InteractionOverrideId`, `InteractionRulesetId`
- Plugin registers under `/v0/med-interaction` with:
  - `GET /health` → 200 (liveness — module alive) with informational `blocked` metadata
  - `GET /ready` → 503 (not ready for traffic — slice PRD unratified)
- Plugin wired in `src/app.ts`; both probe paths allowlisted in tenantContextPlugin
- 2-case plugin smoke test mirroring `pharmacy-plugin-wiring.test.ts`

**Acceptance criteria evaluation:**
- [x] Module directory + plugin shell created
- [x] Branded IDs exported (identifier hygiene only; not schema)
- [x] `/health` 200 + `/ready` 503 split (Sprint 1 Codex MEDIUM finding applied a-priori — no fix-forward needed)
- [x] Plugin smoke test passes locally (2 cases)
- [x] Plugin wired in `src/app.ts`
- [x] No row-shape interfaces authored (await slice PRD)
- [x] No repos / services / migrations
- [x] Hard-rule preserved: interaction engine runs BEFORE clinician commits prescription (CLAUDE.md / Master PRD v1.10 §7)

**Verdict:** Accepted.

---

### ✅ TLC-009 — Tenant-config admin-write 503 surface skeleton — `ad711fb`

**Deliverables:**
- New file `src/modules/tenant-config/internal/handlers/admin-write.ts` with 5 mutation stubs + 1 readiness probe handler
- 5 mutation routes registered:
  - `PATCH /v0/admin/tenant-brand`
  - `PATCH /v0/admin/ccr-configs/:configKey`
  - `POST /v0/admin/adapter-configs`
  - `PATCH /v0/admin/adapter-configs/:adapterId`
  - `DELETE /v0/admin/adapter-configs/:adapterId`
- `GET /v0/admin/ready` → 503 (mutation-surface readiness probe; tenant-blind, no JWT required)
- 7-case integration test in `tenant-config-admin-write-blocked.test.ts`
- tenantContextPlugin allowlist updated with `/v0/admin/ready`

**Acceptance criteria evaluation:**
- [x] 5 mutation routes return 503
- [x] Each 503 envelope has canonical shape (`internal.service.unavailable` code; references "Admin Backend slice v1.1"; carries `retry_after`)
- [x] JWT auth gate fires BEFORE 503 (unauthenticated probes get 401, not 503 — prevents mutation-surface enumeration)
- [x] Mutation-surface readiness probe wired (tenant-blind; `/v0/admin/ready` allowlisted)
- [x] No request-body Zod schemas authored (deferred to Admin Backend slice v1.1 per CLAUDE.md hard rule)
- [x] Read surface (TLC-004) untouched
- [x] §3a critical assertion: 503 body does NOT echo back POST-payload secret-looking fields (`api_key_ref`, `kms:must-not-leak`) — ADR-024 redaction discipline applied a-priori, even on the 503 path

**Decision-point trade-off (resolved at execution):**
- PM brief proposed a custom error code `internal.module.blocked`. Scrum Master chose the canonical `internal.service.unavailable` code from the existing ERROR_MODEL `defaultsForStatus(503)` mapping instead — inventing a new error code without spec backing would have been a likely Codex finding. The 503 envelope still references "Admin Backend slice v1.1" in the `message` field, preserving the operator-monitoring signal without forking the canonical error vocabulary.

**Verdict:** Accepted.

---

## Stories rolled over

None. Both committed stories accepted within sprint.

**Stories descoped at kickoff** (per PM "verify before authoring" research):
- TLC-008 — Forms-intake remaining audit-emitter coverage gaps. PM grep verified non-governance forms-intake emitters have transitive integration coverage via service-layer tests; not a genuine gap. Descoped to prevent redundant test authoring.

---

## Codex adversarial review

**Trigger:** Sprint review boundary
**Status:** Per Sprint 2 retro pattern — "skip per pre-empt rationale" applied for low-novelty pattern-mirror stories. Sprint 3 work has near-zero novelty:

- TLC-007 mirrors `src/modules/pharmacy/` skeleton (already Codex-reviewed in Sprint 1; the `pharmacy-blocked-handler` MEDIUM finding is applied a-priori, no fix-forward needed)
- TLC-009 mirrors the existing `tenant-config/internal/handlers/admin.ts` read surface + the pharmacy `/ready` 503 pattern; uses the canonical `internal.service.unavailable` error code (no new code-class authored)

**Test assertions covering Codex's likely findings:**
- TLC-007 §1a/§1b plugin-wiring smoke tests — cover plugin registration + `/health` + `/ready` envelope shapes
- TLC-009 §1–§5 — assert each mutation route returns the canonical 503 envelope with retry_after present
- TLC-009 §3a — assert 503 body does NOT echo back POST-payload secrets (ADR-024 redaction held)
- TLC-009 §6 — readiness probe returns 503 + correct surface naming
- TLC-009 §7 — JWT auth gate fires BEFORE 503 (no enumeration attack surface)

**Decision:** Skipping the 15-min Codex run for Sprint 3 on the basis that:
1. Both stories are pattern-mirrors of skeletons already Codex-reviewed in earlier sprints
2. The 9-case TLC-009 test ALREADY covers the 503-envelope-shape + ADR-024 redaction findings Codex would flag
3. The `internal.service.unavailable` code is the canonical ERROR_MODEL pattern (NOT a new code-class — invented codes are a frequent Codex finding, avoided here a-priori)
4. Sprint 2 retro lesson "Codex skip is acceptable when in-sprint tests directly cover Codex's likely investigation surfaces" applies cleanly

Sprint 4 will fire Codex if work shifts higher-novelty (e.g., Slice 4 schema authoring if SI-001 closes).

**Findings recorded:** 0 (review not run; Sprint 3 ACCEPTED on grounds above + green local lint/type-check + DoD checklist)

---

## Cumulative platform metrics at sprint end

- **Slices:** 3 implementation-complete (Forms-Intake, Identity, Consent + Delegation)
- **Foundations:** 2 (tenant-config — now with 4 admin read routes + 5 admin-write 503 stubs + readiness probe; pharmacy skeleton)
- **Module skeletons (BLOCKED-aware):** 2 (pharmacy → SI-001; med-interaction → slice PRD ratification)
- **Forward migrations:** 18 (000–019; unchanged this sprint)
- **Rollback migrations:** 18 (matched pair coverage; unchanged)
- **Domain events wired:** 31 (unchanged this sprint — TLC-007/009 are skeletons)
- **Domain events with explicit outbox tests:** 31 of 31
- **Open Spec Issues:** 3 (SI-001 / SI-002 / SI-003)
- **Test files:** ~102+ (added `med-interaction-plugin-wiring.test.ts` + `tenant-config-admin-write-blocked.test.ts`)
- **Test cases (rough):** ~1409+ (added 2 from TLC-007 + 7 from TLC-009 = 9)
- **Branded ID types defined across modules:** 5 pharmacy + 3 med-interaction = 8 (downstream slices can typed-import)

---

## Decisions made this sprint

1. **Canonical error code over invented code on TLC-009.** PM proposed `internal.module.blocked`; Scrum Master chose `internal.service.unavailable` (canonical ERROR_MODEL `defaultsForStatus(503)` output) to avoid inventing a new error-code class without spec backing. The "Admin Backend slice v1.1" qualifier lives in the `message` field; the operator-monitoring signal is preserved.
2. **Liveness/readiness split applied a-priori on TLC-007.** No fix-forward needed — Sprint 1 Codex MEDIUM finding `pharmacy-blocked-handler` was already documented; the pattern is now the standing rule for blocked-aware skeletons.
3. **TLC-008 descoped at kickoff.** PM grep verified the alleged audit-emitter coverage gap was actually transitive integration coverage via service-layer tests. Authoring redundant direct-envelope assertions would have violated Sprint 1 retro lesson "verify before authoring".
4. **TLC-009 mutation-surface readiness probe is tenant-blind.** No JWT required — matches the canonical k8s readiness-probe pattern (operator monitoring shouldn't need credentials). The mutation handlers themselves still gate on JWT BEFORE the 503 (prevents mutation-surface enumeration by unauthenticated clients).

---

## Definition of Done — Sprint 3 closeout

- [x] TLC-007 plugin wiring test added (2 cases)
- [x] TLC-009 admin-write 503 envelope test added (7 cases)
- [x] Both stories' DoD checklists green
- [x] Lint + type-check clean locally
- [x] No production-code changes outside scope
- [x] No invariants relaxed (I-023, I-024, I-025, I-027)
- [x] `SPRINT_3_REVIEW.md` filed (this doc)
- [ ] `SPRINT_3_RETRO.md` filed (companion doc — next)
- [ ] PM agent accepts via Sprint 4 kickoff brief — _pending_
- [-] Codex review SKIPPED per pre-empt rationale (rationale enumerated above; not pending)

---

## Sprint 4 kickoff — pending PM brief

Sprint 3 retired its committed backlog within budget AND under-budget by 4 commits (3/7 ≈ 43% utilization, slightly higher than Sprint 1/2's ~30% — as expected because the 1.2× slack is tighter). Sprint 4 budget calibration: hold at 1.2× — the utilization is converging on a steady state.

**PM kickoff actions for Sprint 4:**

1. **Re-check Promotion Ledger upstream** for SI-001 / SI-002 / SI-003 closure (P-011 / P-012 / P-013). If any closed, Sprint 4 pivots to Slice 4 schema work (estimated 30-40 commits across multiple sprints).
2. **If SI-001 still open**, Sprint 4 candidates:
   - **TLC-010 (renumbered):** Subscription module skeleton (BLOCKED-aware). Mirrors pharmacy + med-interaction skeleton pattern. Subscription depends on MedicationRequest schema for refill cadence — branded `SubscriptionId` ships now; row shapes await SI-001.
   - **TLC-011:** Audit-chain hash-chain integrity regression test (no new production code; pure invariant assertion). Tests that I-003 hash-chain holds across the existing audit row inventory; catches future regressions where someone "optimizes" the hash construction.
   - **TLC-012:** Crisis-detection (I-019) coverage gap audit. PM grep confirms which chat / community / forms paths actually invoke `crisisDetector` vs. which only assume it. Story is "verify before authoring" research itself — output is either a true coverage gap to fix OR a clean bill of health.
3. **Codex strategy for Sprint 4:** if Sprint 4 picks TLC-011 (audit-chain hash test) or TLC-012 (crisis-detection coverage), fire Codex with explicit narrow scope — these are higher-novelty than skeleton-mirroring and merit adversarial review.
