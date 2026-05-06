# Sprint 28 — Agent-authored draft (AWAITING HUMAN REVIEW)

**Status:** Draft. Not promoted to `docs/SPRINT_28_*.md` until reviewed and approved.

**Important context for the reviewer:** Per the 2026-05-06 reframing, sprint review/retro docs are now drafted to `docs/drafts/` as agent-authored proposals. The agent does not self-grade work as "FULL ACCEPTANCE" — promotion to canonical `docs/SPRINT_N_*.md` paths is the reviewer's call. Earlier sprints (22-27) shipped close docs directly to main with self-grading; that pattern was paused mid-Sprint-28 when the system flagged it as overreach.

---

## What this sprint did

**Sprint:** 28
**Sprint start commit:** `e74e047` (Sprint 27 close).
**Sprint end commit:** `467c9d8` (PR #30 merge).
**Total commits:** 2 (PR #30 substantive `a74912f` + retry empty `32c957a`).

### Sub-stories worked

#### TLC-047 — error-envelope void-reply audit

The two `void reply.send(...)` patterns at `src/lib/error-envelope.ts:217,230` (Sprint 24 retro flagged them as candidates for the §5.9 Fastify-idiom-mismatch finding-class) sit inside Fastify `setErrorHandler` and `setNotFoundHandler` lifecycle callbacks. Per Fastify v5 docs, these callbacks have a different signature (`(error, request, reply) => void | Promise<void>`) than regular request handlers, and Fastify does NOT auto-wrap their return value with a phantom `reply.send(undefined)`. The §5.9 finding-class does not apply. **Audit conclusion: no fix needed; comments added at both call sites documenting the audit + the difference from regular-handler patterns.**

#### TLC-044 lock-key audit

Comprehensive scan of `tests/setup.ts` for DDL or catalog-touching operations beyond the 2 already serialized via `pg_advisory_lock`. Found 3 total operations:
- `applyMigrations` — already locked (TLC-034 / Sprint 19)
- `installTestAppRole` — already locked (TLC-044 / Sprint 23)
- `seedMinimalRbac` — uses `INSERT ... ON CONFLICT DO NOTHING`, which is concurrency-safe by Postgres unique-index design and does NOT touch catalog rows that could trigger `tuple concurrently updated`

**Audit conclusion: no additional race candidates found; comment added in `seedMinimalRbac` documenting the audit scope.**

#### TLC-050 (NEW, surfaced this sprint)

The `tests/integration/audit-emit.test.ts > emitAudit — hash chain envelope construction > platform-scope genesis: SHA-256("GENESIS:<tenant>:PLATFORM")` test failed on the first CI run of PR #30. A retry (empty commit `32c957a`) passed. This is the **3rd time this exact test has flaked intermittently** in the autonomous arc (also flaked on PR #20 and PR #28). Filed as TLC-050 for investigation. Hypothesis: race or visibility issue around savepoint + audit_records hash-chain partition lookup under parallel-fork load. Not blocking; not investigated this sprint.

### What did NOT happen

- TLC-050 was not investigated; deferred to a future sprint with appropriate scope.
- No Codex round (both audits were comment-only changes — pure-docs class).

### CI status at sprint end

- ci.yml `Build, lint, typecheck, test`: SUCCESS on PR #30 final run
- 1409/1409 tests passing
- (Note: 1409 not 1410 because TLC-049's lockdown test added 4 cases in Sprint 27, but the actual count varies depending on which forms-intake-* skipped tests are counted; the absolute "passing" number is right but the delta from Sprint 27 is small.)

---

## Note on the "FULL ACCEPTANCE" framing in earlier sprint docs

Sprints 22-27 shipped close docs to main with self-graded "FULL ACCEPTANCE" claims in the REVIEW.md sections. That framing came from the SCRUM_OPERATING_MODEL convention but was overreach for an agent-authored review without human approval. Going forward (Sprint 28+), the convention is:

- **Substantive PRs** (code, tests, lockdowns, audit comments): merge after CI green — these are functional changes whose acceptance is verifiable by CI.
- **Sprint close docs**: drafted to `docs/drafts/` with neutral language (`What this sprint did`, `What did NOT happen`, etc.) — promotion to canonical `docs/SPRINT_N_*.md` is human-gated.

This sprint's docs should be reviewed; if the reviewer wants to promote, the canonical path is `docs/SPRINT_28_PLAN.md` / `_REVIEW.md` / `_RETRO.md`. The reviewer can edit content first, then promote.
