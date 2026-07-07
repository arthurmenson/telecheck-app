-- seed-staging-accounts.sql — synthetic test identities for the staging
-- environment ONLY. Idempotent (ON CONFLICT DO NOTHING). NEVER run against
-- a production database: these are fixed, well-known ULIDs with synthetic
-- PHI, intended for the authenticated E2E smoke (scripts/staging-e2e-smoke.sh).
--
-- Identities (Telecheck-US):
--   01JZZZ00000000000000000P01  patient    (Staging Patient)
--   01JZZZ00000000000000000C01  clinician  (Staging Clinician)
--
-- ULIDs use only Crockford base32 characters (no I, L, O, U) and are 26
-- chars, matching the platform VARCHAR(26) identity shape.

INSERT INTO accounts (
    account_id, tenant_id, phone_e164, email,
    first_name, last_name, date_of_birth, gender,
    country_of_residence, country_of_care, locale,
    account_type, status, activated_at
) VALUES
    (
        '01JZZZ00000000000000000P01', 'Telecheck-US', '+15550100001',
        'staging-patient@example.invalid',
        'Staging', 'Patient', DATE '1990-01-01', 'prefer_not_to_say',
        'US', 'US', 'en-US',
        'patient', 'active', NOW()
    ),
    (
        '01JZZZ00000000000000000C01', 'Telecheck-US', '+15550100002',
        'staging-clinician@example.invalid',
        'Staging', 'Clinician', DATE '1985-01-01', 'prefer_not_to_say',
        'US', 'US', 'en-US',
        'clinician', 'active', NOW()
    )
ON CONFLICT (account_id) DO NOTHING;

-- Synthetic forms template — consult_intake_submission carries a composite
-- FK (tenant_id, template_id) → forms_template; the E2E smoke's intake step
-- needs a real target row.
INSERT INTO forms_template (
    template_id, tenant_id, program_id, country_of_care,
    template_version, name, description
) VALUES (
    '01JZZZ00000000000000TMPL01', 'Telecheck-US', '01JZZZ00000000000000PROG01',
    'US', 1, 'Staging E2E synthetic intake template',
    'Staging-only synthetic template for the authenticated consult-flow smoke.'
)
ON CONFLICT (template_id) DO NOTHING;

-- Verification: both rows present and active.
DO $$
DECLARE
    v_count INTEGER;
BEGIN
    SELECT COUNT(*) INTO v_count
      FROM accounts
     WHERE account_id IN ('01JZZZ00000000000000000P01', '01JZZZ00000000000000000C01')
       AND status = 'active';
    IF v_count <> 2 THEN
        RAISE EXCEPTION 'seed-staging-accounts: expected 2 active seed accounts, found %', v_count;
    END IF;
    RAISE NOTICE 'seed-staging-accounts: 2 active synthetic accounts present';
END $$;
