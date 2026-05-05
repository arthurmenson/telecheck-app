# Sprint 5 Plan — Telecheck-app autonomous build

**Sprint:** 5
**Sprint goal:** Close 2 genuine idempotency invariant gaps (TLC-013) + audit ORT v1.5 launch-readiness items for testable scope (TLC-015) + reset coverage-audit doc filename convention to non-dated living artifact.
**Sprint start commit:** `72981ab` (Sprint 4 ACCEPTED)
**Commit budget:** 4 (1 kickoff/rename + 2 story commits × 1.2 slack ≈ 3 + 1 review/retro = 4)
**Codex strategy:** FIRE on TLC-013 with narrow scope (`tests/integration/idempotency-http.test.ts`); SKIP on TLC-015 (pure research-shaped audit doc)

---

## Promotion Ledger check (verified by PM at kickoff)

SI-001 / SI-002 / SI-003 remain **open** upstream. No P-011 / P-012 / P-013 entries in the Promotion Ledger. Slice 4 schema work stays blocked.

---

## Coverage-audit doc filename convention (resolved)

Choice **(a): rename to non-dated single living doc**:
- `docs/CRISIS_DETECTION_COVERAGE_AUDIT_2026-05-05.md` → `docs/CRISIS_DETECTION_COVERAGE_AUDIT.md`
- Future re-runs amend in place + bump a version-line in the body (analogous to spec corpus version pointers).
- The lockdown test (`tests/contracts/crisis-detection-coverage-lockdown.test.ts:§3a`) currently asserts the dated filename — UPDATE the assertion to the new path AS PART OF the rename commit.
- Rationale: the audit is intended as a living gating-principle artifact (governs future modules); a date-stamped filename breaks the lockdown asserter when the doc gets re-run, defeating the lockdown's purpose.

---

## Stories committed

### TLC-013 — Idempotency invariant lockdown — 2 verified gaps

**Estimated commits:** 1
**Decision rule:** 3 (diminishing-returns hygiene) — invariant-coverage discipline
**Current state baseline (verified by PM):**

| Invariant (IDEMPOTENCY v5.1) | Test exists? | Where |
| --- | --- | --- |
| Missing key on state-change → 400 `internal.idempotency.missing_key` | ✅ | idempotency-http.test.ts §missing-key |
| GET exempt | ✅ | same |
| Same key + same body → replay | ✅ | §replay |
| Same key + different body → 409 `internal.idempotency.body_mismatch` | ✅ | §body mismatch |
| 4-tuple PK: same key + different actor → independent | ✅ | §4-tuple PK, actor case |
| 4-tuple PK: same key + different endpoint → independent | ✅ | §4-tuple PK, endpoint case |
| **4-tuple PK: same key + different TENANT → independent** | ❌ | comment at idempotency-http.test.ts:274–278 explicitly defers ("covered indirectly") |
| **TTL expiry → treated as first request** | ❌ | no test in `idempotency*.test.ts`; relies on SQL `expires_at > NOW()` behavior implicitly |

#### Acceptance criteria

- 2 new test cases in `tests/integration/idempotency-http.test.ts` (or sibling file if required for cross-tenant fixtures):
  - **§NEW: Cross-tenant independence (4-tuple PK, tenant case)** — Same idempotency-key reused across two different tenants on the same endpoint with same actor + same body MUST result in two independent records (not a replay). Mirror the existing §4-tuple PK pattern; substitute tenant variation instead of actor/endpoint variation.
  - **§NEW: TTL expiry treated as first request** — Seed an idempotency-key row with `expires_at` in the past; subsequent request with same key MUST execute fresh (not replay the expired record). This locks the existing `expires_at > NOW()` SQL guard against accidental removal.
- Type-check + lint clean
- No production code changes (pure test additions)

#### Wire-protocol vocabulary check (PM verified)

- `internal.idempotency.missing_key` — verified canonical at `src/lib/idempotency.ts:214`
- `internal.idempotency.body_mismatch` — verified canonical at `src/lib/idempotency.ts:248`
- No new wire-protocol identifiers introduced

---

### TLC-015 — ORT v1.5 launch-readiness items audit (research)

**Estimated commits:** 1
**Decision rule:** 6 (UAT / launch-readiness)

PM read `Telecheck_Operational_Readiness_Tracker_v1_5.md` and identified 5 ORT items testable in this repo (vs. operational/process items that aren't code-side).

#### Acceptance criteria

- New doc `docs/ORT_V1_5_TESTABLE_ITEMS_AUDIT.md` with:
  - List of testable ORT items (5 candidates from PM research):
    - **OR-253:** RLS policy linting CI check (every tenant-scoped table) — 2-commit story
    - **OR-244:** Provider abstraction conformance test suite skeleton — 2-commit story
    - **OR-216:** Build vs spec traceability matrix (audit doc) — 1-commit story
    - **OR-112:** Multi-tenant isolation testing battery (gap-list against existing) — 1-commit story (research)
    - **OR-255:** Per-tenant rate-limit policy scaffolding (`internal.rate_limit.exceeded` already canonical at error-envelope.ts:92) — 2-commit story
  - Per-item: ORT row reference + "what this would test" + "estimated commits" + "depends-on" + "blocked-on (if any)" + recommended sprint slot
  - Out-of-repo items list (operational tasks, vendor account access, AWS deploy access, etc.) — Evans's emergency-only scope
- This story produces an artifact that drives Sprint 6+ planning. Stories from this audit get TLC-NNN IDs in subsequent sprints.

---

## Definition of Done — Sprint 5

- [ ] Coverage-audit doc renamed to non-dated form + lockdown test updated
- [ ] TLC-013 2 new test cases authored
- [ ] TLC-015 audit doc filed
- [ ] CI green at sprint end (Codex FIRE on TLC-013 surface)
- [ ] No invariants relaxed
- [ ] No production-code changes outside scope
- [ ] `docs/SPRINT_5_REVIEW.md` filed (Codex findings included)
- [ ] `docs/SPRINT_5_RETRO.md` filed
- [ ] PM kickoff brief for Sprint 6 (next; depends on TLC-015 audit output)

---

## Codex strategy detail

**TLC-013 — FIRE.** Narrow scope: `tests/integration/idempotency-http.test.ts` + the `expires_at`-related production code (`src/lib/idempotency.ts`).

Invocation: `node "C:/Users/menso/.claude/plugins/cache/openai-codex/codex/1.0.4/scripts/codex-companion.mjs" adversarial-review "--background --base 72981ab tests/integration/idempotency-http.test.ts src/lib/idempotency.ts"`

Hard 15-min cap. If review hasn't completed by sprint review filing time, accept Sprint 5 anyway and surface partial findings as Sprint 6 backlog (per Sprint 2 retro lesson).

**TLC-015 — SKIP.** Pure research-shaped audit doc; no production code paths to adversarially review.

---

## Risks

- **Pre-pave runway shortening.** Sprint 4 retro flagged this. TLC-013 may be the last genuine pre-pave hygiene gap; if Sprint 6 finds none, work pivots to ORT v1.5 items per TLC-015 audit output.
- **TLC-013 cross-tenant test seeding.** The cross-tenant independence test needs idempotency-key fixtures in two tenants. If existing `tests/helpers/` doesn't include cross-tenant idempotency helpers, the test may need to author one — small additional scope; budget includes slack for this.
- **Codex 15-min cap on TLC-013.** Idempotency surface is small (idempotency-http.test.ts is ~280 LOC; idempotency.ts is moderate). Should fit comfortably within 15 min.
