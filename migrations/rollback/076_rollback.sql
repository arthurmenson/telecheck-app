-- =============================================================================
-- File:    migrations/rollback/076_rollback.sql
-- Purpose: Rollback migration 076_subscription_entities.sql.
--
-- Re-opens the migration 060 DEFERRED-FK TODO (drops the refills FK + narrows
-- the column back to VARCHAR(26)), then drops subscription_events before
-- subscriptions (FK dependency order), then the standalone trigger function.
-- RLS policies, triggers, indexes, constraints, and table grants drop with
-- their tables, leaving the migration 075 roles grant-free (a precondition
-- for 075's rollback DROP ROLE).
--
-- Greenfield safety: this system has no production patient data. Rollback
-- destroys subscription rows irrecoverably — acceptable ONLY pre-pilot.
-- After first real patient data, forward-fix migrations replace rollbacks
-- per the F4 deploy runbook discipline.
-- =============================================================================

-- Re-open the 060 deferred FK (Section 3 of 076)
ALTER TABLE refills DROP CONSTRAINT IF EXISTS refills_tenant_subscription_fk;
ALTER TABLE refills ALTER COLUMN subscription_id TYPE VARCHAR(26);

-- Children before parents
DROP TABLE IF EXISTS subscription_events;
DROP TABLE IF EXISTS subscriptions;

-- Standalone trigger function
DROP FUNCTION IF EXISTS subscription_events_block_mutation();

DO $$
DECLARE
    v_remaining INTEGER;
BEGIN
    SELECT COUNT(*) INTO v_remaining
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relkind = 'r'
       AND c.relname IN ('subscriptions', 'subscription_events');
    IF v_remaining <> 0 THEN
        RAISE EXCEPTION 'rollback-076-verification: % subscription table(s) remain', v_remaining;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'refills_tenant_subscription_fk') THEN
        RAISE EXCEPTION 'rollback-076-verification: refills_tenant_subscription_fk still present';
    END IF;
END $$;
