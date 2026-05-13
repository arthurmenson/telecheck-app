-- =============================================================================
-- File:    migrations/rollback/025_rollback.sql
-- Purpose: Rollback for 025_medication_requests.sql — drop the
--          medication_requests table + its indexes + its RLS policy.
-- Spec:    Companion to migrations/025_medication_requests.sql.
-- Note:    Idempotent — uses a DO block guarded by to_regclass() so the
--          rollback is safe to re-run after a successful rollback or
--          against a partial-apply state where the table was never created.
--          Plain `DROP POLICY IF EXISTS ... ON <table>` only guards the
--          policy name, not the table — running it when the table is absent
--          raises an error. The DO block defends against that.
--          [Pattern established by Codex Finding HIGH on 2026-05-11 PR #101
--          review and applied to all subsequent rollback companions.]
-- Warning: Rolling back this migration removes the canonical MedicationRequest
--          aggregate for ALL tenants. Subscription.prescription_id FK targets
--          become dangling. All downstream slices (Refill, Dispensing,
--          Pharmacy, Med Interaction Engine, Notification, Adverse Events)
--          that have subscribed to medication_request.* events become
--          orphaned. Only roll back if:
--            - the schema is being re-baselined pre-launch
--            - no production patient prescribing data exists
--            - the pharmacy slice has not yet been wired in any tenant
--          Never roll back in production while:
--            - any subscriptions row references medication_requests
--            - any refills, dispensings, or pharmacy_orders row references
--              medication_requests
--            - the pharmacy slice is live in any tenant
-- =============================================================================

DO $$
BEGIN
    IF to_regclass('medication_requests') IS NOT NULL THEN
        DROP POLICY IF EXISTS medication_requests_tenant_isolation ON medication_requests;
    END IF;
END;
$$;

DROP INDEX IF EXISTS uq_medication_requests_superseded_by_unique;
DROP INDEX IF EXISTS uq_medication_requests_supersedes_unique;
DROP INDEX IF EXISTS idx_medication_requests_supersession_chain;
DROP INDEX IF EXISTS idx_medication_requests_tenant_status_active;
DROP INDEX IF EXISTS idx_medication_requests_tenant_consult;
DROP INDEX IF EXISTS idx_medication_requests_tenant_clinician;
DROP INDEX IF EXISTS idx_medication_requests_tenant_patient;

DROP TABLE IF EXISTS medication_requests;
