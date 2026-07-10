-- seed-staging-accounts.sql — synthetic test identities for the staging
-- environment ONLY. Idempotent (ON CONFLICT DO NOTHING). NEVER run against
-- a production database: these are fixed, well-known ULIDs with synthetic
-- PHI, intended for the authenticated E2E smoke (scripts/staging-e2e-smoke.sh).
--
-- Identities (Telecheck-US):
--   01JZZZ00000000000000000P01  patient         (Staging Patient)
--   01JZZZ00000000000000000C01  clinician       (Staging Clinician)
--   01JZZZ00000000000000000A02  platform_admin  (Staging Platform Admin)
--     — SI-025 Phase 2: lets the clinician/admin console OTP-log-in as a
--       platform_admin (phone +15550100003) to reach Settings → AI Providers.
--       platform_admin is global scope (admin_tenant_binding NULL); its home
--       tenant is Telecheck-US.
--
-- Identities (Telecheck-Ghana — second operating tenant, GH country of care,
-- host ghana.87.99.159.214.sslip.io via TENANT_HOST_OVERRIDES on staging):
--   01JZZZ00000000000000000P02  patient    (Staging Patient GH)
--   01JZZZ00000000000000000C02  clinician  (Staging Clinician GH)
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
    ),
    (
        '01JZZZ00000000000000000A02', 'Telecheck-US', '+15550100003',
        'staging-platform-admin@example.invalid',
        'Staging', 'Platform Admin', DATE '1980-01-01', 'prefer_not_to_say',
        'US', 'US', 'en-US',
        'platform_admin', 'active', NOW()
    ),
    (
        '01JZZZ00000000000000000P02', 'Telecheck-Ghana', '+233550100001',
        'staging-patient-gh@example.invalid',
        'Staging', 'Patient GH', DATE '1990-01-01', 'prefer_not_to_say',
        'GH', 'GH', 'en-GH',
        'patient', 'active', NOW()
    ),
    (
        '01JZZZ00000000000000000C02', 'Telecheck-Ghana', '+233550100002',
        'staging-clinician-gh@example.invalid',
        'Staging', 'Clinician GH', DATE '1985-01-01', 'prefer_not_to_say',
        'GH', 'GH', 'en-GH',
        'clinician', 'active', NOW()
    )
ON CONFLICT (account_id) DO NOTHING;

-- Synthetic forms templates — consult_intake_submission carries a composite
-- FK (tenant_id, template_id) → forms_template; the E2E smoke's intake step
-- needs a real per-tenant target row (one per operating tenant; distinct
-- template_id because forms_template PK is template_id alone). program_id
-- is the same platform-level ProgramCatalogEntry in both rows — Pattern A:
-- a platform program ported across tenants (per the GLP-1 Program Porting
-- Checklist worked example), tenant-instanced via the template row.
INSERT INTO forms_template (
    template_id, tenant_id, program_id, country_of_care,
    template_version, name, description, created_by
) VALUES
    (
        '01JZZZ0000000000000000TP01', 'Telecheck-US', '01JZZZ0000000000000000PR01',
        'US', 1, 'Staging E2E synthetic intake template',
        'Staging-only synthetic template for the authenticated consult-flow smoke.',
        '01JZZZ00000000000000000C01'
    ),
    (
        '01JZZZ0000000000000000TP02', 'Telecheck-Ghana', '01JZZZ0000000000000000PR01',
        'GH', 1, 'Staging E2E synthetic intake template (Ghana)',
        'Staging-only synthetic template for the Telecheck-Ghana consult-flow smoke.',
        '01JZZZ00000000000000000C02'
    )
ON CONFLICT (template_id) DO NOTHING;

-- Verification: all five synthetic accounts present and active (patient +
-- clinician per operating tenant, plus the SI-025 platform_admin on US).
DO $$
DECLARE
    v_count INTEGER;
BEGIN
    SELECT COUNT(*) INTO v_count
      FROM accounts
     WHERE account_id IN (
               '01JZZZ00000000000000000P01', '01JZZZ00000000000000000C01',
               '01JZZZ00000000000000000A02',
               '01JZZZ00000000000000000P02', '01JZZZ00000000000000000C02'
           )
       AND status = 'active';
    IF v_count <> 5 THEN
        RAISE EXCEPTION 'seed-staging-accounts: expected 5 active seed accounts, found %', v_count;
    END IF;
    RAISE NOTICE 'seed-staging-accounts: 5 active synthetic accounts present (US patient/clinician/platform_admin + Ghana patient/clinician)';
END $$;
