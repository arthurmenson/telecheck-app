# TLC-050 — `audit-emit.test.ts > platform-scope genesis` intermittent flake

**Filed:** 2026-05-06 (Sprint 28)
**Severity:** Medium (intermittent — does not block when CI is retried)
**Owner:** Unassigned
**Status:** Defensive fix landed Sprint 30; root-cause investigation deferred pending recurrence

---

## Sprint 30 update (2026-05-06)

Independent verification by Agent X (Claude SME) and Codex (cross-family) ruled out three of the four hypotheses listed below:

- **Hypothesis #4 (Postgres SEQUENCE leak):** RULED OUT. Codex confirmed `migrations/002_audit_chain.sql:247-250` defines `sequence_number BIGINT NOT NULL DEFAULT 0`; trigger at lines 470-559 uses `pg_advisory_xact_lock(...)` + `SELECT MAX(sequence_number) ... FOR UPDATE`. No SEQUENCE involvement; fully transactional.
- **Hypothesis #1 (advisory-lock cross-fork state):** RULED OUT as stated. `pg_advisory_xact_lock` releases at txn end and does not carry sequence state across connections.
- **Hypothesis #3 (within-file parallel `it()`):** RULED OUT. `grep` for `it.concurrent|test.concurrent` returns zero matches; vitest runs `it()` blocks sequentially within file by default.

Agent X proposed a different cross-test-file pollution mechanism via RELEASE SAVEPOINT semantics. **Codex challenged this** — the cleanup path in `tests/setup.ts:432-447` does `ROLLBACK TO SAVEPOINT` BEFORE `RELEASE SAVEPOINT`, so RELEASE happens on already-rolled-back state and does not finalize dirty changes.

**Codex's actual diagnosis (the one we acted on):** the trigger at `migrations/002_audit_chain.sql:480-506` partitions hash chains by `tenant_id || ':' || COALESCE(target_patient_id, 'PLATFORM')`. The failing test at `tests/integration/audit-emit.test.ts:681-698` used fixed `TENANT_US:PLATFORM` and only randomized `resource_id` — which is NOT part of the partition key. The patient-scope sibling test at line 659 already correctly randomizes `target_patient_id`; the platform-scope test was the only one not randomizing a partition input.

**Defensive fix applied** (Sprint 30 corrective PR): the platform-genesis test now generates a unique throwaway tenant per invocation, INSERTs it into the `tenants` table within the savepoint, and uses that tenant's `:PLATFORM` partition for the genesis assertion. Mirrors the `uniquePatient` pattern at line 659. The savepoint rolls back the tenant INSERT at test end; no leakage.

**What this leaves open:** I do not have direct evidence of what *triggered* the flake on the specific failing CI runs — Codex's diagnosis explains why the test was *fragile to* cross-test pollution but not what specifically polluted the partition. The defensive fix removes the fragility regardless. If the flake recurs on a different test surface, that would suggest a deeper isolation issue worth investigating.

---

## Symptom

`tests/integration/audit-emit.test.ts > emitAudit — hash chain envelope construction > platform-scope genesis: SHA-256("GENESIS:<tenant>:PLATFORM")` fails intermittently in CI with:

```
expected 2 to be 1
  at toBe (audit-emit.test.ts:696)
```

The assertion is `expect(env.hash_chain.sequence_number).toBe(1)`. The actual value is occasionally `2`, suggesting a prior record exists in the `${TENANT_US}:PLATFORM` hash-chain partition when the test's `emitAudit` runs.

## Observed history

- **PR #20 (Sprint 23 / TLC-044):** flaked once; passed on first run after merge.
- **PR #28 (Sprint 27 / TLC-046+TLC-049):** flaked once; passed on retry.
- **PR #30 (Sprint 28 / TLC-047+TLC-044 audit):** flaked once; passed on retry.
- **All other PRs in Sprint 19→28 arc:** passed cleanly.

## Why this isn't blocking

- The flake is intermittent (passes on retry without code change).
- The arc has used the retry-clears-flake heuristic to ship 3 separate PRs cleanly.
- The actual hash-chain logic in `src/lib/audit.ts` has been Codex-audited multiple times (HIGH-1, HIGH-3, HIGH-4, HIGH-5 closures 2026-05-03) and uses `pg_advisory_xact_lock` per partition for serialization — the sequencing is provably correct under sequential load.

## Hypothesis space

1. **Savepoint visibility race under parallel forks.** Vitest runs files in separate forks; each fork has its own pg.Client + outer BEGIN + per-test SAVEPOINT cycle. A prior test's audit_records INSERT is rolled back at savepoint-rollback time — but if the partition's hash-chain serialization point (`pg_advisory_xact_lock`) holds state across forks, a sequence_number computed in one fork might leak.
2. **Read-snapshot leak from beforeAll seed.** If migration seed data inserts an audit_records row in `Telecheck-US:PLATFORM` partition, the genesis test's expected-sequence-number-1 assumption is violated. (Probably ruled out — no other PRs that flake show consistent sequence_number=2; intermittent suggests racing with another test, not seeded data.)
3. **Test file ordering / parallel `it()` execution within fork.** Vitest can run `it()` blocks in parallel within a single file under some configurations. If two `it()` blocks both write to `${TENANT_US}:PLATFORM` and one's savepoint-rollback runs after the other's emitAudit query, the latter sees the former's pre-rollback row.
4. **Postgres SEQUENCE leak.** If `audit_records` has a Postgres SEQUENCE column for `sequence_number`, sequences are NOT transactional — they advance even when the inserting tx rolls back. (Unlikely if the trigger computes sequence_number from MAX(...) per partition; verify in `migrations/002_audit_chain.sql`.)

## Investigation steps when picked up

1. Read `migrations/002_audit_chain.sql` (or wherever the trigger lives) — verify sequence_number is computed from MAX(...) WHERE partition = ..., not a SEQUENCE.
2. Add log-injection to `getPreviousHashForPartition` in `src/lib/audit.ts` to capture what the query sees when sequence_number != 1.
3. Run the test in parallel-stress mode (10x repetition with vitest --bail false) to see if the flake reproduces locally.
4. Check whether vitest's `pool: 'forks'` + per-fork pg.Client + shared TEST_DATABASE_URL allows cross-fork visibility of pre-commit rows under any default isolation level.
5. If hypothesis #1 confirmed: serialize the genesis test (or the whole audit-emit hash-chain block) via a `pg_advisory_lock` on `'audit_emit_test_hash_chain'` similar to TLC-034 / TLC-044 patterns.

## Mitigation in the meantime

- CI retries on this test almost always pass.
- The autonomous arc uses empty-commit-retry to clear the flake.
- File this ticket; document the retry-pattern in PROJECT_CONVENTIONS r5 (next codification cycle) so future readers don't waste time investigating each occurrence.

## Spec references

- AUDIT_EVENTS v5.2 §hash-chain (sequence_number + previous_hash construction)
- I-003 (audit append-only)
- migrations/002_audit_chain.sql (trigger-side hash-chain serialization)
- src/lib/audit.ts:393 `getPreviousHashForPartition` (app-side prior-hash lookup)
- PROJECT_CONVENTIONS §5.7 shared-root-cause cluster discipline (TLC-050 may share root cause with similar parallel-fork race finding-classes; investigate together if more candidates surface)
