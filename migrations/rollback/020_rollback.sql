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

-- Step 1: Drop named constraints in dependency order — composite FKs
-- before the parent UNIQUE they reference. Per Codex async-consult-r3
-- HIGH closure 2026-05-05: constraints are named in both migration 020
-- inline and migration 021 ALTER, so this rollback's drop-by-name pattern
-- works across both apply paths (fresh-DB + upgraded-DB).
ALTER TABLE consult_events DROP CONSTRAINT IF EXISTS consult_events_tenant_consult_fk;
ALTER TABLE consults       DROP CONSTRAINT IF EXISTS consults_tenant_intake_fk;
ALTER TABLE consults       DROP CONSTRAINT IF EXISTS consults_tenant_patient_fk;
ALTER TABLE consults       DROP CONSTRAINT IF EXISTS consults_tenant_id_id_unique;

-- Step 2: Drop RLS policies. Both tables use the standard `tenant_isolation`
-- name (matches the 19 other tenant-scoped tables — see Sprint 6 / TLC-016
-- RLS policy coverage lockdown).
DROP POLICY IF EXISTS tenant_isolation ON consult_events;
DROP POLICY IF EXISTS tenant_isolation ON consults;

-- Step 3: Drop triggers + trigger functions.
DROP TRIGGER IF EXISTS consults_updated_at ON consults;

DROP FUNCTION IF EXISTS consults_set_updated_at();

-- Step 4: Drop tables in FK-dependency order.
-- consult_events references consults via FK; must drop first.
DROP TABLE IF EXISTS consult_events;
DROP TABLE IF EXISTS consults;
