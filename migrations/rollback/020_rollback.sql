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

-- Step 1: Drop RLS policies. Both tables use the standard `tenant_isolation`
-- name (matches the 19 other tenant-scoped tables — see Sprint 6 / TLC-016
-- RLS policy coverage lockdown).
DROP POLICY IF EXISTS tenant_isolation ON consult_events;
DROP POLICY IF EXISTS tenant_isolation ON consults;

-- Step 2: Drop triggers + trigger functions.
DROP TRIGGER IF EXISTS consults_updated_at ON consults;

DROP FUNCTION IF EXISTS consults_set_updated_at();

-- Step 3: Drop tables in FK-dependency order.
-- consult_events references consults via FK; must drop first.
DROP TABLE IF EXISTS consult_events;
DROP TABLE IF EXISTS consults;
