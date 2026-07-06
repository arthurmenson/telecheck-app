-- =============================================================================
-- File:    migrations/rollback/060_rollback.sql
-- Purpose: Rollback migration 060_pharmacy_refill_entities.sql.
--
-- Drops the 3 Pharmacy Refill sub-slice entities (refills, dispensings,
-- shipments per SI-007 / P-046) + their trigger functions in reverse
-- dependency order, and removes the §0 adapter_configs composite-UNIQUE
-- fix-forward. RLS policies, triggers, indexes, and table-local constraints
-- drop with their tables.
--
-- Greenfield safety: this system has no production patient data. Rollback
-- destroys refill/dispensing/shipment rows irrecoverably — acceptable ONLY
-- pre-pilot. After first real patient data, forward-fix migrations replace
-- rollbacks per the F4 deploy runbook discipline.
-- =============================================================================

-- Children before parents (FK dependency order)
DROP TABLE IF EXISTS shipments;
DROP TABLE IF EXISTS dispensings;
DROP TABLE IF EXISTS refills;

-- Standalone trigger functions
DROP FUNCTION IF EXISTS refills_block_terminal_mutation();
DROP FUNCTION IF EXISTS dispensings_block_terminal_mutation();
DROP FUNCTION IF EXISTS shipments_block_terminal_mutation();

-- §0 fix-forward reversal (safe: the three dependent composite FKs dropped
-- with their tables above; no other migration references this constraint)
ALTER TABLE adapter_configs
    DROP CONSTRAINT IF EXISTS adapter_configs_tenant_id_id_unique;

-- Verification: none of the 3 tables remain; the §0 constraint is gone
DO $$
DECLARE
    v_remaining INTEGER;
BEGIN
    SELECT COUNT(*) INTO v_remaining
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relkind = 'r'
       AND c.relname IN ('refills', 'dispensings', 'shipments');
    IF v_remaining > 0 THEN
        RAISE EXCEPTION 'migration-060-rollback-incomplete: % pharmacy-refill table(s) remain', v_remaining
            USING ERRCODE = 'check_violation';
    END IF;

    IF EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'adapter_configs_tenant_id_id_unique'
    ) THEN
        RAISE EXCEPTION 'migration-060-rollback-incomplete: adapter_configs_tenant_id_id_unique remains'
            USING ERRCODE = 'check_violation';
    END IF;
END $$;
