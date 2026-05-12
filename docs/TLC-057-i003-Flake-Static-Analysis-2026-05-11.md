# TLC-057 — i003 REVOKE + TLC-050 Audit-Emit Flake — Static Analysis Report

**Status:** PRELIMINARY — read-only static analysis authored 2026-05-11 ahead of Sprint 35 / TLC-057 empirical investigation. Hypothesis confidence ratings will need validation against actual Postgres reproduction.
**Author:** Autonomous Claude (2026-05-11 nonstop run)
**Companion artifacts:** `docs/TLC-050-Audit-Emit-Platform-Genesis-Flake.md` §"2026-05-11 recurrence log"; `docs/SPRINT_35_PLAN.md` TLC-057.

---

## Summary

The single highest-confidence hypothesis from static analysis is **H3 — `pg_advisory_xact_lock` per-partition state pinned to the outer savepoint-wrapping transaction**, rated **HIGH**, as the cause of Variant A ("deadlock detected" on `config_change_validated`). The trigger at `migrations/002_audit_chain.sql:506` takes `pg_advisory_xact_lock(hashtextextended(v_partition_key, 0))`. Postgres releases xact-scope advisory locks at outer-transaction end, not at savepoint rollback. The test harness opens ONE outer `BEGIN` in `tests/setup.ts:390` and wraps every test in a SAVEPOINT (`tests/setup.ts:395`); the outer tx is never committed during a run. Consequently, every advisory lock taken by the audit trigger across the lifetime of the fork persists until process exit. With vitest `pool: 'forks'` (default parallel, no `singleFork`/`maxForks` cap; `vitest.config.ts:146`) plus the non-randomized `${TENANT_US}:PLATFORM` partition in the still-flaking `platform-scope events` test (`tests/integration/audit-emit.test.ts:760-776`), two forks INSERT into the same partition; the trigger's `pg_advisory_xact_lock` collides with the *other fork's still-held* outer-tx advisory lock + `FOR UPDATE` row lock from a prior emit, producing a classic lock-cycle deadlock. (The deadlock arrives only when ordering of `FOR UPDATE` row acquisition vs advisory-lock acquisition crosses between forks — explaining the intermittent character.)

For Variant B, the highest-confidence cause is **H1 — REVOKE-vs-information_schema visibility race**, rated **MEDIUM**, as a *separate* root cause from Variant A. The `REVOKE UPDATE, DELETE ON audit_records FROM telecheck_test_app` only fires inside `installTestAppRole` (`tests/setup.ts:297`), which IS serialized across forks by a session-level advisory lock (`tests/setup.ts:259`). However, the REVOKE is performed by the BOOTSTRAP process per fork; `information_schema.role_table_grants` reflects the catalog state at the assertion-running fork's snapshot — and a fork that already holds `SET SESSION AUTHORIZATION telecheck_test_app` (set at `tests/setup.ts:345`, BEFORE the REVOKE in some interleavings is even logically observable through `current_user`'s view if migration 001 created the table with prior PUBLIC grants intact in another fork's installTestAppRole-acquired window) can observe stale grants. More likely: migrations apply via the schema_migrations gate (`tests/setup.ts:120-181`), but `installTestAppRole` reads `GRANT ... ON ALL TABLES` which is **bound to the table-set at the moment GRANT runs**. If a *later* fork applies migration 002 first (creating `audit_records`), then a *different* fork ran `installTestAppRole` *before* `audit_records` existed, that fork's grant covers zero rows and its REVOKE on `audit_records` errors-or-noops out (REVOKE on a nonexistent grant is allowed but does nothing). The flake then surfaces as UPDATE-still-granted in that fork's `current_user` view.

**Recommended first TLC-057 fix:** set `poolOptions.forks.singleFork: true` (or `pool: 'forks'` with `maxForks: 1`/`isolate: true` and `fileParallelism: false`) in `vitest.config.ts`. This is a one-line, fully reversible change that eliminates BOTH suspected race surfaces simultaneously. If the flake stops, we have confirmed it is a multi-fork race; the proper longer-term fix is to (a) move REVOKE into a real migration so it lands once at apply-time inside the schema_migrations transaction (`tests/setup.ts:153-160`), AND (b) shorten the harness's outer-tx lifetime to per-file (BEGIN in a per-file `beforeAll`, COMMIT in afterAll) so `pg_advisory_xact_lock` actually releases between files.

---

## Read trace

- `docs/TLC-050-Audit-Emit-Platform-Genesis-Flake.md:10-66` — Variant A + Variant B recurrence log; Sprint 30 partition-key fix only patched the genesis-only test, not the broader platform-scope-events test that also hits `${TENANT_US}:PLATFORM` partition (`tests/integration/audit-emit.test.ts:760-776`). The error string "deadlock detected" in Variant A is NOT `expected 2 to be 1` (Sprint 28 symptom); the recurrence has progressed from sequence-number-collision to lock-cycle deadlock.
- `tests/setup.ts:120-181` (migration apply with advisory lock + schema_migrations idempotency); `tests/setup.ts:250-314` (`installTestAppRole` REVOKE under separate advisory lock); `tests/setup.ts:345` (`SET SESSION AUTHORIZATION ${TEST_APP_ROLE}` — persists per shared client); `tests/setup.ts:387-452` (per-test SAVEPOINT cycle).
- `tests/setup.ts:390` confirms a single long-running `BEGIN` opens on first test and is never committed for the life of the fork's test execution.
- `migrations/002_audit_chain.sql:373-374` (REVOKE only from PUBLIC, not from a named app role); `migrations/002_audit_chain.sql:381-382` (commented-out SPEC ISSUE: `REVOKE ... FROM telecheck_app_role` deferred).
- `migrations/002_audit_chain.sql:495` (partition key derivation), `migrations/002_audit_chain.sql:506` (`pg_advisory_xact_lock(hashtextextended(v_partition_key, 0))` — txn-scope lock), `migrations/002_audit_chain.sql:512-519` (FOR UPDATE on latest partition row).
- `src/lib/db.ts:147-189` translates app-level BEGIN→SAVEPOINT (Sprint 17 / TLC-027). Confirms the savepoint translation is per-fork; advisory xact locks acquired inside the trigger ARE bound to the outer test BEGIN, NOT to the app savepoint.
- `vitest.config.ts:146` — `pool: 'forks'`; no `maxForks`/`singleFork`/`fileParallelism` settings, so default vitest parallelism applies (one fork per CPU core typically).
- `tests/invariants/i003-audit-append-only.test.ts:97-109` — Variant B assertion queries `role_table_grants WHERE grantee = current_user AND privilege_type = 'UPDATE'` and expects 0 rows.
- `migrations/003_rls_helpers.sql` — does not GRANT or REVOKE on `audit_records`; only operates on `_session_tenant_context` and tenant-context functions.

## Hypotheses + confidence ratings

### H1 — REVOKE race
**Confidence:** MEDIUM (for Variant B specifically; not implicated in Variant A)
**Evidence (cite file:line):**
- `tests/setup.ts:297` performs `REVOKE UPDATE, DELETE ON audit_records FROM ${TEST_APP_ROLE}` only in test setup, NOT in any migration. `migrations/002_audit_chain.sql:373-374` only revokes from PUBLIC; `migrations/002_audit_chain.sql:381-382` SPEC ISSUE comments confirm the named-role REVOKE was intentionally deferred.
- The REVOKE is wrapped in the install-role advisory lock (`tests/setup.ts:259`), so two forks cannot mutate catalog rows in parallel. BUT: the advisory lock is acquired AFTER migrations have been applied; the GRANT-then-REVOKE sequence at `tests/setup.ts:275-297` runs once per fork. If Fork-B reaches `installTestAppRole` before Fork-A has applied migration 002 (the schema_migrations gate is independent from the install-role gate and does NOT release a precondition signal), Fork-B's `GRANT ... ON ALL TABLES IN SCHEMA public` covers a smaller table set; the immediate `REVOKE UPDATE, DELETE ON audit_records` then errors silently or no-ops (REVOKE on a nonexistent grant is allowed but has no effect on later-created tables).
- The migrations advisory lock (`tests/setup.ts:120`) and the install-role advisory lock (`tests/setup.ts:259`) use DIFFERENT lock keys — there is NO ordering guarantee that one happens before the other across forks.
**Recommended TLC-057 validation:**
- Add `pg_locks` snapshot logging at the start + end of `installTestAppRole` and at the assertion site of the i003 REVOKE test.
- Log `current_user`, `current_database()`, `pg_backend_pid()`, and the full `role_table_grants` result-set when the assertion fails.
- Reproduce by running `i003-audit-append-only.test.ts` with `tests/integration/audit-emit.test.ts` deliberately racing in parallel (set `maxForks: 4`, fileParallelism: true, repeat=20).

### H2 — Migration apply ordering
**Confidence:** LOW
**Evidence (cite file:line):**
- `tests/setup.ts:143-172` applies each migration inside its own `BEGIN ... COMMIT` block. The schema_migrations row INSERT is in the same transaction as the migration SQL apply, so partial applies cannot leak. The migration advisory lock (`tests/setup.ts:120`) serializes the entire apply loop across forks; the `applied.has(file)` short-circuit at `tests/setup.ts:144` is read INSIDE the lock, so the second fork sees the first fork's committed schema_migrations rows.
- The TLC-034 fix-forward in the header comment block (`tests/setup.ts:90-119`) reads as exactly the closure I would expect for this hypothesis.
**Recommended TLC-057 validation:**
- Spot-check the `schema_migrations` table content after a failed run — if all migrations are listed there + checksums match, H2 is fully ruled out.

### H3 — pg_advisory_xact_lock cross-test pollution / outer-tx lifetime
**Confidence:** HIGH (for Variant A)
**Evidence (cite file:line):**
- `migrations/002_audit_chain.sql:506` uses `pg_advisory_xact_lock` — xact-scope. Released at OUTER `COMMIT`/`ROLLBACK`, NOT at SAVEPOINT release/rollback (this is documented Postgres behavior).
- `tests/setup.ts:390` opens a single `BEGIN` once for the lifetime of the fork (set on first `beforeEach`). Every `audit_records` INSERT from every test in every file thereafter takes the partition's xact-lock against THAT outer transaction; locks accumulate (one per distinct partition touched) and are never released until the fork process exits.
- The still-flaking `platform-scope events` test at `tests/integration/audit-emit.test.ts:760-776` uses fixed `${TENANT_US}:PLATFORM` partition (`uniqueResource` is NOT part of the partition key — verified against the trigger at `migrations/002_audit_chain.sql:495`). Sprint 30's defensive fix at `audit-emit.test.ts:681` (the `genesis` test) randomized the tenant — but the `events` test at line 760 was NOT touched by Sprint 30. The TLC-050 doc §"2026-05-11 recurrence log" appears to conflate the two tests.
- Variant A error "deadlock detected" is **distinct** from the original Sprint 28 "expected 2 to be 1" symptom; the chain has progressed from sequence-collision (now fixed for the genesis test) to actual Postgres-detected lock-cycle. This matches what cross-fork advisory-lock-on-shared-outer-tx would produce when combined with `FOR UPDATE` on the same partition's tail row.
- The Sprint 30 update at `docs/TLC-050-Audit-Emit-Platform-Genesis-Flake.md:57` explicitly RULED OUT "advisory-lock cross-fork state" — but the rule-out reasoning relied on advisory locks being txn-scope and released at txn end. **That reasoning assumed the outer txn ENDS between tests, which it does NOT in this harness.** This is a direct contradiction with the working hypothesis in the TLC-050 recurrence log.
**Recommended TLC-057 validation:**
- Log `pg_locks WHERE locktype = 'advisory'` immediately before and after the failing INSERT.
- Repro target: set `maxForks: 4`, `fileParallelism: true`, run `audit-emit.test.ts` + `i003-audit-append-only.test.ts` + any other test that INSERTs into audit_records on the `${TENANT_US}:PLATFORM` partition, repeat 50 times.
- Confirm Postgres `deadlock_timeout` (default 1s) is the latency floor of the failures.

### H4 — Savepoint-translation masks REVOKE state
**Confidence:** LOW
**Evidence (cite file:line):**
- The Variant B assertion at `tests/invariants/i003-audit-append-only.test.ts:100` queries `information_schema.role_table_grants` via the SHARED test client (`getTestClient()`), NOT through the app pool (`getPool()`/`withTransaction`). The savepoint-translation layer at `src/lib/db.ts:147-189` is bypassed by direct test-client queries. So the savepoint translation cannot be implicated in Variant B's REVOKE-check failure.
- The savepoint layer DOES interact with audit emit (which routes through `withTransaction` → translated BEGIN→SAVEPOINT, see `src/lib/audit.ts:688-714`). But REVOKE / GRANT are catalog-level not row-level; not subject to savepoint visibility rules.
**Recommended TLC-057 validation:**
- Confirm by reading the Variant B test file directly — `getTestClient().query(...)` calls the shared pg.Client unmodified; savepoint translation is not engaged.

### H5 — vitest parallelism (pool: 'forks')
**Confidence:** HIGH (necessary precondition for H1 and H3)
**Evidence (cite file:line):**
- `vitest.config.ts:146` sets `pool: 'forks'` with no parallelism cap. Vitest 2/4 defaults to `os.cpus().length` forks for `pool: 'forks'`.
- Each fork shares `TEST_DATABASE_URL` (one Postgres database) but opens its own pg.Client (`tests/setup.ts:331-332`), runs its own setup (`tests/setup.ts:336-345`), and opens its own outer BEGIN (`tests/setup.ts:390`).
- The setup serializes migrations + role install via advisory locks (`tests/setup.ts:120, 259`), but does NOT serialize the test execution itself — that's the point of parallelism.
- Both Variant A's deadlock (cross-fork advisory-lock on shared partition) and Variant B's REVOKE-not-visible (cross-fork catalog-visibility timing) require multiple forks against shared DB.
**Recommended TLC-057 validation:**
- Set `poolOptions.forks.singleFork: true` OR `poolOptions.forks.maxForks: 1` OR `fileParallelism: false` in `vitest.config.ts`. Run the same workload for ~50 iterations and confirm zero recurrence.

### H6 — Variant A and Variant B have DIFFERENT root causes
**Confidence:** MEDIUM
**Evidence (cite file:line):**
- Variant A symptom: `deadlock detected` on INSERT (audit-emit.test.ts platform-scope test, `tests/integration/audit-emit.test.ts:760`). Direct evidence points at `pg_advisory_xact_lock` + outer-tx lifetime.
- Variant B symptom: `expected length 0, got 1` on `role_table_grants` lookup (i003-audit-append-only.test.ts, `tests/invariants/i003-audit-append-only.test.ts:97`). Direct evidence points at REVOKE-not-yet-applied or REVOKE-applied-but-stale-snapshot.
- The TLC-050 doc §"2026-05-11 recurrence log:39" hypothesizes a SHARED root cause ("pg-test-setup race conditions in tests/setup.ts migration apply + role grant/revoke ordering"). Static analysis does NOT support this conflation: the migration apply path uses one advisory lock and the install-role path uses a different one; the failure modes have different surfaces and different fix surfaces.
- Both can ROOT in the broader "multi-fork against shared DB" condition (H5), but the proximate mechanisms differ.

## Recommended fix order for TLC-057

1. **Disable file-level parallelism as a diagnostic.** In `vitest.config.ts`, set `fileParallelism: false` (or equivalently `poolOptions: { forks: { singleFork: true } }`). Run CI ~20 times. **Expected outcome:** flake disappears entirely on both variants. This confirms H5 as the necessary precondition. **Cost:** test suite serializes (slower CI), so this is a diagnostic, not the final fix.

2. **End the harness outer transaction per file instead of per process.** Move the `BEGIN` from the global `beforeEach` (`tests/setup.ts:387-430`) into a per-file `beforeAll`, and add a matching `COMMIT` (or `ROLLBACK`) in `afterAll`. This forces `pg_advisory_xact_lock`s acquired by the audit trigger to RELEASE between files — closing H3's mechanism. Combined with re-enabling parallelism, this should both fix Variant A AND restore CI speed. **Test:** run with parallelism back ON for 50 iterations; verify zero deadlocks.

3. **Move REVOKE into a real migration.** The `REVOKE UPDATE, DELETE ON audit_records FROM telecheck_test_app` belongs alongside the table creation in a migration that runs inside the schema_migrations gate at `tests/setup.ts:153`. This eliminates the cross-fork REVOKE-visibility window entirely. Concretely: add a `migrations/00X_test_role.sql` (or extend `003_rls_helpers.sql`) that `CREATE ROLE IF NOT EXISTS telecheck_test_app` + `REVOKE UPDATE, DELETE ON audit_records FROM telecheck_test_app`. Delete the corresponding lines from `tests/setup.ts:263-297`. **Test:** the i003 REVOKE check should always pass; Variant B should not recur.

4. **Use `pg_advisory_lock` (session-scope) instead of `pg_advisory_xact_lock` inside the trigger** ONLY IF (2) cannot be cleanly delivered. This is a riskier change because it diverges test-mode and production-mode trigger behavior; deprioritize unless (2) is blocked.

5. **Add `pg_locks` + `current_user` + `pg_backend_pid()` diagnostic logging** at the trigger boundary and the i003 assertion boundary, gated behind `TLC057_DEBUG=1`. Land first so the TLC-057 engineer has empirical telemetry when the next recurrence happens.

6. **Audit the rest of the audit-emit test surface for un-randomized partition keys.** `tests/integration/audit-emit.test.ts:760` (platform-scope events) is the obvious one Sprint 30 missed. Sweep for any other `target_patient_id: null` + fixed-tenant test. Sprint 30's fix-forward should be applied uniformly (random tenant per test).

## What this analysis CANNOT close

- **No empirical reproduction in this shell.** No Postgres environment is available; the hypothesis confidence ratings above are derived strictly from code-reading. The HIGH rating on H3 is grounded in documented Postgres semantics (`pg_advisory_xact_lock` lifetime tied to enclosing transaction, not savepoint) plus the unambiguous code-trace showing one long-lived `BEGIN` in the harness. It still needs Postgres validation.
- **Cannot rule in H6 (different root causes) without empirical timing data.** Static analysis suggests the two variants have distinct proximate mechanisms (advisory-lock-deadlock vs catalog-visibility-race), but both could share the multi-fork precondition; calling them "one root cause" or "two" is empirically determinable from variant-incidence patterns under the (1) fix.
- **The Sprint 30 conclusion explicitly rules out "advisory-lock cross-fork state".** My analysis contradicts that rule-out because Sprint 30's reasoning assumed `pg_advisory_xact_lock` releases at txn end (true) without examining the test harness's actual outer-tx lifetime (one BEGIN per fork process, never COMMIT during run — `tests/setup.ts:390`). The TLC-057 engineer should reconcile this with Codex's Sprint 30 review.
- **`information_schema.role_table_grants` snapshot semantics** under concurrent `GRANT`/`REVOKE` from another backend are not exhaustively documented; H1's exact mechanism may differ from the proposed REVOKE-on-nonexistent-grant path. Postgres reproduction with two backends running interleaved GRANT/REVOKE/SELECT-from-information_schema is the only honest validation.

## Spec references

- I-003 (audit append-only) — `Telecheck_Contracts_Pack_v5_00_INVARIANTS.md` §I-003
- AUDIT_EVENTS v5.2 §hash-chain construction + canonical sequence_number derivation
- ADR-023 (multi-tenant, RLS-enforced; test harness must run under non-superuser per `tests/setup.ts:248-345`)
- `migrations/002_audit_chain.sql` §audit_records_hash_insert trigger (partition + advisory-lock); §audit_records_block_mutation trigger (I-003 belt+suspenders)
- `tests/setup.ts` (per-fork bootstrap: migrations + role install + outer BEGIN + per-test SAVEPOINT)
- `src/lib/db.ts:101-217` (setTestPool + BEGIN→SAVEPOINT translation per TLC-027)
- `vitest.config.ts:146` (pool: 'forks', no parallelism cap)
- TLC-050 (this flake's tracker; §"2026-05-11 recurrence log")
- TLC-034 (migration apply serialization)
- TLC-044 (install-role serialization)
- TLC-027 (savepoint-translation pool wrapper)
- Sprint 30 partition-key fix at `tests/integration/audit-emit.test.ts:681-742` (genesis test only; `events` test at line 760 NOT addressed)
