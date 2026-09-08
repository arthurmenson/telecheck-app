-- pilot-1-baseline-seed.sql — Pilot 1 synthetic BASELINE for both operating
-- tenants. Runs after every env-purge (both modes) and at Pilot 1 Day-0.
--
-- Per docs/PII_SCREENING_AND_LOG_REDACTION_SPEC.md §Environment purge/reset
-- procedure §Post-purge and §Three-state cohort classification:
--
--   * Every account row names cohort_classification = 'baseline' IN THE SAME
--     INSERT (provisioning contract; CI test 4 — scripts/pilot-1-remediation.test.mjs
--     checks this statically, tests/integration/pilot-1-cohort-remediation.test.ts
--     against real Postgres). A seed never writes 'unclassified' and never
--     writes 'participant' — participants are provisioned by the participant
--     kit, not seeded.
--   * Idempotent: ON CONFLICT (account_id) DO NOTHING. Re-running is a no-op.
--   * Tenant baseline (tenants, tenant_brands, ccr_configs, ...) is
--     `preserved` by env-purge and is created by migration 001; this file
--     REFUSES to run if either operating tenant is missing rather than
--     inventing tenant rows.
--   * Location: scripts/, NOT migrations/ — the test bootstrap and the
--     migration tooling apply every *.sql under migrations/.
--   * Runs under the operator DSN (the cross-tenant role used by
--     verify-pilot-1-baseline.sh); accounts has FORCE RLS, so each tenant's
--     rows are written under that tenant's context.
--
-- Identities (fixed ULIDs; Crockford base32, 26 chars, no I/L/O/U):
--   Telecheck-US
--     01JZZZ000000000000PILOT0C1  clinician      (Pilot Clinician US)
--     01JZZZ000000000000PILOT0A1  tenant_admin   (Pilot Tenant Admin US)
--     01JZZZ000000000000PILOT0P1  patient        (Pilot Baseline Fixture US) — baseline test fixture
--     01JZZZ000000000000PILOTPA1  platform_admin (Pilot Platform Admin) — global scope, home tenant US
--   Telecheck-Ghana
--     01JZZZ000000000000PILOT0C2  clinician      (Pilot Clinician GH)
--     01JZZZ000000000000PILOT0A2  tenant_admin   (Pilot Tenant Admin GH)
--     01JZZZ000000000000PILOT0P2  patient        (Pilot Baseline Fixture GH) — baseline test fixture
--
-- Synthetic contact data only (+1555 / +233555 test ranges, example.invalid).

\set ON_ERROR_STOP on

DO $$
BEGIN
    IF (SELECT COUNT(*) FROM tenants WHERE id IN ('Telecheck-US', 'Telecheck-Ghana') AND status = 'active') <> 2 THEN
        RAISE EXCEPTION 'pilot-1-baseline-seed: both operating tenants (Telecheck-US, Telecheck-Ghana) must exist and be active — tenant baseline is created by migration 001 and preserved by env-purge; refusing to seed accounts';
    END IF;
END $$;

BEGIN;

SELECT set_tenant_context('Telecheck-US');
INSERT INTO accounts (
    account_id, tenant_id, phone_e164, email,
    first_name, last_name, date_of_birth, gender,
    country_of_residence, country_of_care, locale,
    account_type, status, activated_at, cohort_classification
) VALUES
    ('01JZZZ000000000000PILOT0C1', 'Telecheck-US', '+15550200001', 'pilot-clinician-us@example.invalid',
     'Pilot', 'Clinician US', DATE '1985-01-01', 'prefer_not_to_say',
     'US', 'US', 'en-US', 'clinician', 'active', NOW(), 'baseline'),
    ('01JZZZ000000000000PILOT0A1', 'Telecheck-US', '+15550200002', 'pilot-tenant-admin-us@example.invalid',
     'Pilot', 'Tenant Admin US', DATE '1980-01-01', 'prefer_not_to_say',
     'US', 'US', 'en-US', 'tenant_admin', 'active', NOW(), 'baseline'),
    ('01JZZZ000000000000PILOT0P1', 'Telecheck-US', '+15550200003', 'pilot-baseline-fixture-us@example.invalid',
     'Pilot', 'Baseline Fixture US', DATE '1990-01-01', 'prefer_not_to_say',
     'US', 'US', 'en-US', 'patient', 'active', NOW(), 'baseline'),
    ('01JZZZ000000000000PILOTPA1', 'Telecheck-US', '+15550200004', 'pilot-platform-admin@example.invalid',
     'Pilot', 'Platform Admin', DATE '1980-01-01', 'prefer_not_to_say',
     'US', 'US', 'en-US', 'platform_admin', 'active', NOW(), 'baseline')
ON CONFLICT (account_id) DO NOTHING;

SELECT set_tenant_context('Telecheck-Ghana');
INSERT INTO accounts (
    account_id, tenant_id, phone_e164, email,
    first_name, last_name, date_of_birth, gender,
    country_of_residence, country_of_care, locale,
    account_type, status, activated_at, cohort_classification
) VALUES
    ('01JZZZ000000000000PILOT0C2', 'Telecheck-Ghana', '+233550200001', 'pilot-clinician-gh@example.invalid',
     'Pilot', 'Clinician GH', DATE '1985-01-01', 'prefer_not_to_say',
     'GH', 'GH', 'en-GH', 'clinician', 'active', NOW(), 'baseline'),
    ('01JZZZ000000000000PILOT0A2', 'Telecheck-Ghana', '+233550200002', 'pilot-tenant-admin-gh@example.invalid',
     'Pilot', 'Tenant Admin GH', DATE '1980-01-01', 'prefer_not_to_say',
     'GH', 'GH', 'en-GH', 'tenant_admin', 'active', NOW(), 'baseline'),
    ('01JZZZ000000000000PILOT0P2', 'Telecheck-Ghana', '+233550200003', 'pilot-baseline-fixture-gh@example.invalid',
     'Pilot', 'Baseline Fixture GH', DATE '1990-01-01', 'prefer_not_to_say',
     'GH', 'GH', 'en-GH', 'patient', 'active', NOW(), 'baseline')
ON CONFLICT (account_id) DO NOTHING;

SELECT clear_tenant_context();

-- Guard: every seed row present, active, and baseline. A non-baseline seed
-- row would either be purged (participant) or block purge (unclassified);
-- both are seed defects, so the transaction is aborted.
DO $$
DECLARE
    v_bad INTEGER;
    v_all INTEGER;
BEGIN
    SELECT COUNT(*) INTO v_all FROM accounts
     WHERE account_id LIKE '01JZZZ000000000000PILOT%';
    IF v_all <> 7 THEN
        RAISE EXCEPTION 'pilot-1-baseline-seed: expected 7 seed accounts, found %', v_all;
    END IF;
    SELECT COUNT(*) INTO v_bad FROM accounts
     WHERE account_id LIKE '01JZZZ000000000000PILOT%'
       AND (cohort_classification <> 'baseline' OR status <> 'active');
    IF v_bad <> 0 THEN
        RAISE EXCEPTION 'pilot-1-baseline-seed: % seed account(s) are not active baseline rows; aborting', v_bad;
    END IF;
    RAISE NOTICE 'pilot-1-baseline-seed: 7 baseline accounts present (US clinician/tenant_admin/fixture patient/platform_admin; GH clinician/tenant_admin/fixture patient)';
END $$;

COMMIT;
