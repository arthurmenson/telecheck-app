-- Reverse before 081 when reverting the Identity runtime package.
BEGIN;
REVOKE INSERT (
    account_id, tenant_id, phone_e164, email, first_name, last_name,
    date_of_birth, gender, national_id, country_of_residence,
    country_of_care, locale
) ON public.accounts FROM telecheck_app_role;
REVOKE UPDATE (status, activated_at) ON public.accounts FROM telecheck_app_role;
GRANT INSERT, UPDATE ON public.accounts TO telecheck_app_role;
COMMIT;
