-- Restoring the previous intake wrapper would remove verified-payment gating.
-- Preserve the payment/consult links and admission guard during release recovery.
-- Application rollback requires a compatible release or a reviewed forward fix.
DO $$ BEGIN
  RAISE EXCEPTION 'billing_rollback_requires_reviewed_forward_migration'
    USING ERRCODE = '0A000';
END $$;
