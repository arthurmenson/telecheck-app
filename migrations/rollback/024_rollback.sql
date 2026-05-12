-- =============================================================================
-- File:    migrations/rollback/024_rollback.sql
-- Purpose: Rollback for 024_product_catalog.sql — drop the product_catalog
--          table + its indexes + its RLS policy.
-- Spec:    Companion to migrations/024_product_catalog.sql.
-- Note:    Idempotent — uses IF EXISTS clauses so reapplication is a no-op.
-- Warning: Rolling back this migration removes the canonical product catalog
--          for ALL tenants. Subscription.product_id FK targets become
--          dangling. Any future MedicationRequest.product_catalog_id
--          composite FK (per SI-001 DRAFT v0.2 / TLC-055) becomes dangling.
--          Only roll back if the schema is being re-baselined; never roll
--          back in production while:
--            - any subscriptions row references product_catalog
--            - the pharmacy slice has been wired (Sprint 35+ / TLC-055 live)
-- =============================================================================

DROP POLICY IF EXISTS product_catalog_tenant_isolation ON product_catalog;
DROP INDEX IF EXISTS idx_product_catalog_rxnorm;
DROP INDEX IF EXISTS idx_product_catalog_program;
DROP INDEX IF EXISTS idx_product_catalog_tenant;
DROP TABLE IF EXISTS product_catalog;
