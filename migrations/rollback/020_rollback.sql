-- =============================================================================
-- File:    migrations/rollback/020_rollback.sql
-- Purpose: Rollback for 020_async_consult.sql — drop consults +
--          consult_events tables and all dependent objects (RLS, triggers,
--          indexes).
-- Spec:    Companion to migrations/020_async_consult.sql.
-- Warning: DESTRUCTIVE. All Async Consult slice instance data
--          (per-patient consult state machine progress, transition
--          history) will be permanently lost. Audit chain rows
--          referencing the dropped consults remain in audit_records
--          (I-003 append-only) but become orphaned references.
--          Sign-off: Platform Privacy Officer + Engineering Lead.
-- =============================================================================

-- Drop order:
--   consult_events → consults (FK)
--   consults       → tenants (001), accounts (012)

-- Note on constraint drops (Codex async-consult-r4 HIGH closure 2026-05-05):
-- Earlier rollback drafts explicitly dropped the named composite UNIQUE +
-- composite FKs before the table drops. That pattern was unsafe across
-- partial-apply states because `ALTER TABLE ... DROP CONSTRAINT IF EXISTS`
-- aborts when the TABLE itself doesn't exist (`IF EXISTS` applies to the
-- constraint, not the table). DROP TABLE IF EXISTS at Step 4 below handles
-- constraint cleanup automatically as part of the table teardown — that's
-- table-existence-safe and matches the migration 019 rollback discipline.

-- Step 1: Drop RLS policies. Both tables use the standard `tenant_isolation`
-- name (matches the 19+ other tenant-scoped tables — see Sprint 6 / TLC-016
-- RLS policy coverage lockdown).
--
-- Note (Codex async-consult-r5 HIGH closure 2026-05-05): DROP POLICY
-- IF EXISTS guards the POLICY name, not the target table — if the table
-- is missing (partial-apply state), the statement aborts before the
-- guarded trigger/table cleanup at Steps 2-3 can run. Universal rule
-- for migration rollbacks: ANY operation against a table (DROP POLICY,
-- DROP TRIGGER, ALTER TABLE DROP CONSTRAINT, etc.) requires a
-- to_regclass() existence check in rollback contexts. DROP TABLE IF
-- EXISTS itself is the only table-targeting statement that's
-- table-existence-safe by default.
DO $$
BEGIN
    IF to_regclass('consult_events') IS NOT NULL THEN
        DROP POLICY IF EXISTS tenant_isolation ON consult_events;
    END IF;
END$$;

DO $$
BEGIN
    IF to_regclass('consults') IS NOT NULL THEN
        DROP POLICY IF EXISTS tenant_isolation ON consults;
    END IF;
END$$;

-- Step 2: Drop triggers + trigger functions. DROP TRIGGER IF EXISTS
-- aborts if the table is missing (same hazard as constraint DROPs);
-- guard with to_regclass per Codex async-consult-r4 HIGH closure.
DO $$
BEGIN
    IF to_regclass('consults') IS NOT NULL THEN
        DROP TRIGGER IF EXISTS consults_updated_at ON consults;
    END IF;
END$$;

DROP FUNCTION IF EXISTS consults_set_updated_at();

-- Step 3: Drop tables in FK-dependency order.
-- consult_events references consults via FK; must drop first. DROP TABLE
-- IF EXISTS cascades constraint cleanup automatically — the named
-- composite UNIQUE + composite FKs added at TLC-021a fix-forward rounds
-- get torn down here without needing explicit ALTER TABLE DROP CONSTRAINT
-- (which would have aborted on missing-table partial-apply states).
DROP TABLE IF EXISTS consult_events;
DROP TABLE IF EXISTS consults;
