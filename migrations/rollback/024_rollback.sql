-- =============================================================================
-- File:    migrations/rollback/024_rollback.sql
-- Purpose: Rollback for 024_product_catalog.sql — drop the product_catalog
--          table + its indexes + its RLS policy.
-- Spec:    Companion to migrations/024_product_catalog.sql.
-- Note:    Idempotent — uses a DO block guarded by to_regclass() so the
--          rollback is safe to re-run after a successful rollback or
--          against a partial-apply state where the table was never created.
--          Plain `DROP POLICY IF EXISTS ... ON <table>` only guards the
--          policy name, not the table — running it when the table is
--          absent raises an error. The DO block defends against that.
--          [Codex Finding HIGH on 2026-05-11 PR #101 review.]
-- Warning: Rolling back this migration removes the canonical product catalog
--          for ALL tenants. Subscription.product_id FK targets become
--          dangling. Any future MedicationRequest.product_catalog_id
--          composite FK (per SI-001 DRAFT v0.2 / TLC-055) becomes dangling.
--          Only roll back if the schema is being re-baselined; never roll
--          back in production while:
--            - any subscriptions row references product_catalog
--            - the pharmacy slice has been wired (Sprint 35+ / TLC-055 live)
-- =============================================================================

DO $$
BEGIN
    IF to_regclass('product_catalog') IS NOT NULL THEN
        DROP POLICY IF EXISTS product_catalog_tenant_isolation ON product_catalog;
    END IF;
END;
$$;

DROP INDEX IF EXISTS idx_product_catalog_rxnorm;
DROP INDEX IF EXISTS idx_product_catalog_program;
DROP INDEX IF EXISTS idx_product_catalog_tenant;
DROP TABLE IF EXISTS product_catalog;
