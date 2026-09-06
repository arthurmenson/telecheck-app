-- Separate patient registration from governed role/cohort administration.
-- Corrects migration 081 without rewriting already-applied source history.
BEGIN;
REVOKE INSERT, UPDATE ON public.accounts FROM telecheck_app_role;
GRANT INSERT (
    account_id, tenant_id, phone_e164, email, first_name, last_name,
    date_of_birth, gender, national_id, country_of_residence,
    country_of_care, locale
) ON public.accounts TO telecheck_app_role;
GRANT UPDATE (status, activated_at) ON public.accounts TO telecheck_app_role;
-- account_type defaults to patient; cohort_classification defaults to
-- unclassified. Both remain governed by separate privileged provisioning.
-- updated_at is maintained by the existing trigger, not direct app writes.
COMMIT;
