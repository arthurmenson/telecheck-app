-- =============================================================================
-- File:    migrations/rollback/004_rollback.sql
-- Purpose: Rollback for 004_domain_events_outbox.sql — drop the outbox table.
-- Warning: DESTRUCTIVE. Any unpublished events in the outbox will be lost.
--          If there are unpublished events, drain the outbox (wait for the
--          relay to publish all pending rows) before running this rollback.
--          Dev/test environments only. Never run against a live system.
-- =============================================================================

-- Drop the RLS policy before dropping the table (policy depends on the table).
DROP POLICY IF EXISTS tenant_isolation ON domain_events_outbox;

-- Drop indexes (CASCADE via DROP TABLE, but explicit for clarity).
DROP TABLE IF EXISTS domain_events_outbox;
