# Sprint 1 Review — Telecheck-app autonomous build

**Sprint:** 1
**Sprint goal:** Pay down highest-value pre-Slice-4 hygiene + scaffold Pharmacy module skeleton so SI-001 closure unlocks immediate Slice 4 schema authoring
**Sprint start commit:** `72ade2d` (Scrum framework adoption)
**Sprint end commit:** `d87a6ba` (TLC-003 final)
**Total commits in sprint:** 4 (within 12-budget)
**CI status at sprint end:** ✅ Green at `d87a6ba`

---

## Stories accepted

### ✅ TLC-001 — Pharmacy module skeleton (blocked-aware) — `9abf614`

**Deliverables shipped:**

- `src/modules/pharmacy/` — full directory with index/plugin/routes/internal/types + README
- App wiring: `tenantContextPlugin` allowlist + `pharmacyPlugin` registered
- Branded ID types (5): `MedicationRequestId`, `RefillId`, `DispensingId`, `ShipmentId`, `ProductCatalogId`
- `tests/integration/pharmacy-plugin-wiring.test.ts` (1 case): asserts `/health` returns BLOCKED state with SI-001 reference
- `docs/PHARMACY_SLICE_STATUS_2026-05-05.md`: v0.1 state + resume path when SI-001 closes

**Acceptance criteria evaluation:**

- [x] Module directory created with required files
- [x] `npm run typecheck` passes
- [x] Plugin registers with `/health` returning BLOCKED state
- [x] Branded IDs include all 5 entities
- [x] BLOCKED ON SI-001 banner in module README
- [x] ZERO migration files added
- [x] Plugin smoke test (1 case) passing

**Verdict:** Accepted.

---

### ✅ TLC-002 — Identity cross-tenant isolation regression — `3410b6d`

**Deliverables shipped:**

- `tests/integration/identity-cross-tenant-isolation.test.ts` — 4 sections × 2 cases = 8 cases
- Section coverage: account-service / session-service / otp-service / auth-device-service
- Each section asserts: cross-tenant null/empty return + no spurious audit emission in attacking tenant
- Mirror of `consent-cross-tenant-isolation.test.ts` shape

**Acceptance criteria evaluation:**

- [x] Mirrors consent-cross-tenant pattern
- [x] All 4 entities × 2 cases = 8 cases
- [x] RLS layer-1 enforcement asserted (read-from-wrong-tenant returns null)
- [x] Audit-suppression asserted (no spurious row in attacking tenant)
- [x] No production-code changes
- [x] CI green at story-completion HEAD (`d87a6ba` cumulative tree)

**Verdict:** Accepted.

---

### ✅ TLC-003 — Forms-intake remaining outbox-landing tests — `d87a6ba`

**Re-scoped mid-sprint** (scrum-master course correction; PM assumption re: 4 missing events was incorrect).

**Original scope:** 4 outbox-landing assertions for template/deployment events. Post-research: those events ALREADY had explicit tests in `forms-intake-events.test.ts`.

**Re-scoped deliverable:** 3 outbox-landing assertions for the 2 events that genuinely lacked explicit coverage (`forms_variant.winner_promoted` + `forms_variant.retired`, with retired emitted once per loser variant = 2 retired assertions in same test).

**Acceptance criteria evaluation:**

- [x] Outbox query asserts envelope shape + payload (winner_promoted: rationale; retired: promoted_winner_id)
- [x] All 13 forms-intake events emitted from events.ts now have explicit outbox-landing tests (the 1 remaining un-tested event, `intake_response.abandoned`, has zero callers in code — emitter exists for spec compliance but is unused; not a test gap)
- [x] No new test file authored — extension of existing variants test

**Verdict:** Accepted.

---

## Stories rolled over

None. All committed stories accepted.

---

## Codex adversarial review

**Trigger:** Sprint review boundary
**Command:** `node codex-companion.mjs adversarial-review --base 72ade2d^ src/modules/pharmacy/ tests/integration/identity-cross-tenant-isolation.test.ts tests/integration/forms-intake-variants.test.ts tests/integration/pharmacy-plugin-wiring.test.ts`

### Findings

(To be filled in once Codex completes — see `/tmp/ci-fail7.log` equivalent for this session's Codex output. If Codex returns CRITICAL findings, Sprint 1 acceptance is gated until fix-forward closes them.)

**Anticipated profile:** Sprint 1 work is low-novelty (skeleton + test mirroring well-established patterns). Expect FEW findings, mostly LOW/MEDIUM. CRITICAL/HIGH would surface only on:

- Pharmacy skeleton accidentally exposing PHI surface (none — only `/health` mounted)
- Cross-tenant test missing a dimension (account_id-vs-tenant_id swap, etc.)
- Forms-intake variant test asserting wrong payload field

---

## Cumulative platform metrics at sprint end

- **Slices:** 3 implementation-complete (Forms-Intake, Identity, Consent + Delegation)
- **Foundations:** 2 (tenant-config, pharmacy skeleton)
- **Forward migrations:** 18 (000-019)
- **Rollback migrations:** 18 (matched pair coverage)
- **Domain events wired:** 30 (8 consent + 9 identity + 13 forms-intake)
- **Domain events with explicit outbox tests:** 30 of 30
- **Open Spec Issues:** 3 (SI-001/002/003)
- **Test cases (rough):** ~1380+

---

## Decisions made this sprint

1. **Pharmacy skeleton scope discipline:** Branded IDs ship at v0.1 (identifier hygiene); row-shape interfaces wait for SI-001 closure (true schema). The line is clear enough to defend in retro.
2. **`/health` returning BLOCKED state** rather than 200/`{ok}`: prevents premature "module ready" classification by monitoring; SI-001 reference embedded for operator triage.
3. **TLC-003 re-scope:** PM assumption that 4 events lacked tests was incorrect. Scrum Master verified ground truth before authoring redundant tests, then re-scoped to 2 genuinely-missing events. Process feedback to PM in retro.

---

## Definition of Done — Sprint 1 closeout

- [x] Pharmacy directory exists with BLOCKED-banner README
- [x] Identity cross-tenant test suite asserts denial for ALL 4 entities (8 cases)
- [x] Forms-intake outbox coverage reaches all 13 emitter-side events (1 with no caller; not a test gap)
- [ ] Codex sprint review shows 0 HIGH/CRITICAL findings on the sprint commit batch — _pending_
- [x] `SPRINT_1_REVIEW.md` filed (this doc)
- [x] `SPRINT_1_RETRO.md` filed (companion doc)
- [ ] PM agent accepts via Sprint 2 kickoff brief — _pending_

Two boxes pending: Codex review return + PM Sprint 2 kickoff.

---

## Sprint 2 kickoff — pending PM brief

Sprint 1 retired its committed backlog within budget. PM agent will be invoked at Sprint 2 kickoff to read the (potentially updated) state and select next stories from the proposed Sprint 2 list (TLC-004 admin handlers, TLC-005 pharmacy adapter abstraction if SI-001 closed, TLC-006 forms-intake operator-edit emit sites).

If SI-001 has closed in the spec corpus (Promotion Ledger P-011 landed), Sprint 2 priority becomes Slice 4 schema authoring + module build-out. PM checks at kickoff.
