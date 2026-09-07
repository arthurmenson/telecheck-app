-- Billing may already have created an external provider operation. Dropping its
-- local reference, event history or financial envelope cannot undo that effect.
-- Disable new payment initiation, retain callback/reconciliation processing and
-- deploy a reviewed forward correction. See BILLING_CONSULT_PREREQUISITE.md.
DO $$ BEGIN
  RAISE EXCEPTION 'billing_rollback_requires_reviewed_forward_migration'
    USING ERRCODE = '0A000';
END $$;
