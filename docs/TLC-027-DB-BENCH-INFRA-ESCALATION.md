# TLC-027 — DB-backed bench infrastructure (Sprint 15+ escalation from TLC-025)

**Status:** ESCALATED 2026-05-05 from Sprint 14 / TLC-025-SCAFFOLD per Codex `perf-bench-r10` adversarial review (2 HIGH + 2 MEDIUM findings against commit `208e9b5`). The Sprint 14 SCAFFOLD attempt was reverted at `af193e7`. TLC-027 is the proper Sprint 15+ rebuild against an environment that includes Postgres for validation.

**Sprint reference:** Sprint 14 / TLC-025 (escalated 2026-05-05) → Sprint 15+ TLC-027.

---

## Why this is escalated, not fix-forward

Sprint 14 attempted to land bench-mode ephemeral Postgres setup as scaffolding-only (no actual DB-backed bench scenarios at Sprint 14; Sprint 15+ adds them post-CI verification). The autonomous shell that authored the SCAFFOLD did NOT have local Postgres available, so verification was limited to lint + tsc + structural-shape correctness against existing `tests/setup.ts` patterns.

Codex `perf-bench-r10` adversarial review surfaced 4 findings (2 HIGH + 2 MEDIUM) against the SCAFFOLD; all 4 are legitimate technical defects:

### r10-A (HIGH): `setupFiles` fail-open when `BENCH_DATABASE_URL` absent

**Finding:** `vitest.bench.config.ts` selected `setupFiles` only when `process.env['BENCH_DATABASE_URL']` was set. If a DB-backed bench file landed without env set, Vitest would load NO DB setup; any benchmark reaching `withTransaction()` would use the normal app pool backed by `DATABASE_URL` from `src/lib/config.ts` — currently a stub in CI (per `perf.yml`) and commonly the dev DB locally. This DEFEATS the setup file's fail-closed guard because the guard never runs.

**Fix path:** Don't gate setup inclusion on env presence. Either split pure and DB-backed bench globs/configs, OR have DB-backed bench files explicitly import/assert the bench setup (so loading them without env fails at module-resolution). CI should have a dedicated job that sets `BENCH_DATABASE_URL` and proves setup executed against Postgres.

### r10-B (HIGH): Savepoint translation breaks production lock semantics

**Finding:** Bench-mode SCAFFOLD called `setTestPool()` (the integration-test pool override that translates `BEGIN/COMMIT/ROLLBACK` to nested savepoints) and opened one outer transaction at session start. The planned primary bench target — `emitAudit` hash chain — uses `pg_advisory_xact_lock` (per migration 002), which is RELEASED at outer-transaction end, not savepoint release. Bench iterations would therefore:
- Hold advisory locks for the whole session (not per-iteration as production does)
- Not measure real commit durability
- Not exercise cross-connection visibility patterns
- Have materially different contention/failure behavior from the production code path being measured

**The bench would measure the wrong thing.** The first DB-backed bench numbers would be misleading.

**Fix path:** Use a real `pg.Pool` against `BENCH_DATABASE_URL` for bench mode (NOT the savepoint-translation override). Add a NEW pool override (`setBenchPool()` in `src/lib/db.ts`) that does NOT translate transaction commands. State cleanup is per-run schema/database teardown OR explicit `TRUNCATE` after the run, NOT one outer transaction around all iterations.

This requires a production-code change in `src/lib/db.ts`, which Sprint 14's plan ruled out, AND requires Postgres validation to verify the new override actually delivers production-equivalent measurement.

### r10-C (MEDIUM): URL collision check is string-equality, not database-identity

**Finding:** The setup file's fail-closed guard rejected `BENCH_DATABASE_URL == DATABASE_URL` and `BENCH_DATABASE_URL == TEST_DATABASE_URL` via STRING equality only. The same physical database can be referenced with different URL formats (different user/password, query string, default-port spelling, host alias, IPv4 vs hostname, etc.) and the guard would pass — leaving a realistic path to polluting dev/test data while believing fail-closed protection worked.

**Fix path:** Parse and canonicalize URLs; compare actual database target (hostname/address policy, port defaulting, database name). Ideally also verify server-side identity after connect (`inet_server_addr`, `inet_server_port`, `current_database`).

### r10-D (MEDIUM): Migration replay treats any "already exists" as full-file success

**Finding:** `applyMigrations()` caught any error whose message contained `already exists` and moved to the next migration file. Existing migrations contain non-idempotent DDL (`CREATE POLICY`, `CREATE TRIGGER`); migration 007 explicitly documents that migration 002 has a replay hazard. On a non-empty or partially migrated bench DB, a duplicate policy/trigger early in a migration could cause the rest of that migration file to be skipped, leaving later tables/RLS policies/triggers/grants unapplied while setup continues silently.

**Fix path:** Track applied migrations in a `schema_migrations` table; run each migration exactly once. OR make every migration fully idempotent with object-specific guards. Don't treat a generic `already exists` substring as full-file success.

This is a broader concern that affects integration tests too (`tests/setup.ts` has the same pattern). Sprint 15+ retro evaluates whether to fix in `tests/setup.ts` simultaneously.

---

## Why escalation rather than fix-forward in Sprint 14

Per Sprint 12 retro's codified "structural-constraint-not-code-defect escalation" pattern (`docs/SPRINT_12_RETRO.md`):

> When a Codex finding class converges on "this requires data we don't have yet" across 3+ fix-forward rounds, AND each round produces a valid finding while introducing the next round's complaint, AND the underlying constraint is structural (e.g., needs CI calibration; needs a slice that doesn't exist yet; needs a spec ratification upstream), escalate to a Sprint N+1 story rather than continuing iterative fix-forward.

TLC-025-SCAFFOLD's r10 findings are at round 1, not round 3+. The pattern technically requires more rounds before escalating.

**However:** the underlying constraint is structural in the same shape Sprint 12 retro documented:
- r10-A requires CI verification of an actual DB-backed bench end-to-end
- r10-B requires Postgres availability to validate the new pool-override semantics work
- r10-C requires Postgres availability to test canonicalization edge cases
- r10-D requires Postgres availability to test migration-tracking-table behavior

All 4 findings depend on Postgres availability in the validation environment. Continuing fix-forward without Postgres would risk landing more "looks structurally correct, doesn't actually work" code — exactly the closure-path-overclaim recurrence Sprint 13 retro warned about.

**Sprint 14 retro therefore extends the Sprint 12 escalation pattern:** when the underlying constraint is "the validation environment doesn't include the dependency this code interacts with", escalate at round 1 rather than waiting for the structural shape to surface across multiple rounds. Codex r10's findings already PROVE the structural shape — further fix-forward would be data-gathering without payoff.

---

## TLC-027 Sprint 15+ acceptance criteria

Sprint 15+ must execute TLC-027 in an environment that includes Postgres for validation. Acceptance criteria for TLC-027:

1. **Real `pg.Pool` against `BENCH_DATABASE_URL`** (not savepoint-translation override). NEW exported `setBenchPool()` helper in `src/lib/db.ts` that:
   - Returns the real pool from `getPool()` calls
   - Does NOT translate `BEGIN/COMMIT/ROLLBACK`
   - Connection-init hook (`pool.on('connect', ...)`) sets non-superuser role for RLS enforcement
   - Pool-end hook (`pool.on('release', ...)`) is identity (no special handling)

2. **`vitest.bench.config.ts` setupFiles always-on** with explicit DB-backed bench file imports asserting setup is loaded:
   - Pure-function bench files don't import the DB setup (so they run with no Postgres dependency)
   - DB-backed bench files import a `requireBenchDb()` helper that throws if `BENCH_DATABASE_URL` is unset OR if the bench client isn't initialized
   - Splitting via separate `vitest.bench.config.ts` and `vitest.bench.db.config.ts` is the recommended path for CI to run them as separate jobs

3. **URL canonicalization for collision check:**
   - Parse `BENCH_DATABASE_URL`, `DATABASE_URL`, `TEST_DATABASE_URL` via `URL` constructor
   - Canonicalize: lowercase host; default port to 5432 if absent; strip query string + auth credentials; lowercase database name
   - Compare canonicalized triples; reject if any match
   - Optionally: post-connect server-identity check (`SELECT current_database(), inet_server_addr(), inet_server_port()`) to catch host-alias bypasses

4. **Migration tracking via `schema_migrations` table:**
   - First migration creates `schema_migrations` table if absent
   - Each subsequent migration checks for its filename in the table; skips if applied; INSERTs after successful application
   - Replay-on-failure semantics: if a migration partially applies, the row isn't INSERTed; next setup run re-attempts and fails explicitly rather than silently skipping
   - Same fix should apply to `tests/setup.ts` simultaneously (broader scope; Sprint 15+ retro evaluates)

5. **End-to-end CI verification job:**
   - NEW `.github/workflows/perf-db.yml` (or extend `perf.yml`) with a Postgres service container
   - Sets `BENCH_DATABASE_URL` to the service container
   - Runs `npm run bench:db` (NEW script that invokes `vitest bench --run -c vitest.bench.db.config.ts`)
   - Validates the scaffold's migration-apply + seed + role wiring works end-to-end
   - Same `continue-on-error: true` posture as `perf.yml` at v0.1; required-blocking at Sprint N+ (TBD)

6. **First DB-backed bench scenario lands AFTER scaffold is verified:**
   - Candidate: `tests/perf/audit/emit-audit.bench.ts` with §1 happy-path single-row append
   - THRESHOLDS expansion in `check-thresholds.ts` (§9 emit-audit happy path)
   - Self-test PASS for 9 scenarios

---

## Sprint 14 closing state

- Sprint 14 commit ledger: kickoff `d433703` + SCAFFOLD `208e9b5` + revert `af193e7` + Sprint 14 PARTIAL ACCEPTANCE review/retro + this escalation doc
- TLC-025-SCAFFOLD attempt: REVERTED. Working tree at `af193e7` is identical to `d433703` (Sprint 14 kickoff baseline) for the SCAFFOLD-modified files
- Codex closures:
  - r10-A HIGH (escalated to TLC-027 Sprint 15+)
  - r10-B HIGH (escalated to TLC-027 Sprint 15+)
  - r10-C MEDIUM (escalated to TLC-027 Sprint 15+)
  - r10-D MEDIUM (escalated to TLC-027 Sprint 15+)
- Codex finding ledger: 39 closed (23 HIGH + 16 MEDIUM); **2 finding-classes ESCALATED** (TLC-024 r4 → TLC-026 [closed Sprint 13]; TLC-025 r10 → TLC-027 [Sprint 15+])

---

## Sprint 15 PM kickoff hand-off

Sprint 15 PM kickoff verifies:
1. Is there CI/test environment access with Postgres available? (If autonomous Claude still doesn't have it, TLC-027 is BLOCKED on environment until Evans is reachable.)
2. Has `perf.yml` accumulated 3-5 stable main runs? (OR-218 execution path; Evans Option A continues from Sprint 13.)
3. SI-001/002/003 status check.

If Postgres availability is unblocked: execute TLC-027 acceptance criteria above.
If still blocked: defer to Sprint 16+; pivot Sprint 15 to other available work.

---

## Spec references

- ORT v1.5 OR-218 (Tier 1 launch-blocking)
- `tests/perf/README.md` §"Bench-mode DB-backed corpus"
- `vitest.bench.config.ts` (separate-config rationale + Sprint 14 reverted update)
- `tests/setup.ts` (the integration-test pattern TLC-025-SCAFFOLD attempted to mirror; r10-D applies here too)
- `src/lib/db.ts` setTestPool() (the override pattern that DOESN'T fit bench mode per r10-B)
- `migrations/002_audit_chain.sql` (`pg_advisory_xact_lock` per-partition; the lifecycle r10-B identified)
- `docs/SPRINT_12_RETRO.md` (structural-constraint-not-code-defect escalation pattern; this escalation extends it)
- `docs/SPRINT_13_RETRO.md` (closure-path-overclaim pre-emption pattern; r10 demonstrates the recurrence at the SCAFFOLD architecture layer)
