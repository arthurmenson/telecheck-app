-- ---------------------------------------------------------------------------
-- Migration 080: Pilot 1 cohort classification for accounts
-- ---------------------------------------------------------------------------
--
-- Adds the three-state cohort_classification column to accounts per
-- docs/PII_SCREENING_AND_LOG_REDACTION_SPEC.md §Three-state cohort
-- classification (ratified 2026-08-30 under Path α; the Codex R20/R22
-- close-out of the Pilot 1 substrate ratification package).
--
-- The column serves as the sole authority for the pilot-1-env-purge
-- scoped-DELETE predicate against accounts:
--   DELETE FROM accounts WHERE cohort_classification = 'participant';
--
-- This preserves baseline (clinician / admin / service / baseline-
-- participant-test-fixture) accounts while removing Pilot 1
-- participant accounts on purge.
--
-- ---------------------------------------------------------------------------
-- Design
-- ---------------------------------------------------------------------------
--
-- Three states:
--   'participant'  — Pilot 1 participant (patient or delegate); purged
--   'baseline'     — legitimate baseline (any account_type); preserved
--   'unclassified' — data-model defect; purge REFUSES until remediated
--
-- Adding as NOT NULL requires a backfill for existing rows. The ratified
-- contract (PII spec §Three-state cohort classification) requires
-- OPERATOR-REVIEWED classification for pre-existing patient/delegate rows,
-- NOT auto-assumption. Backfill therefore SPLITS by account_type:
--
--   - Operator + admin + service account types (clinician, tenant_admin,
--     platform_admin) are unambiguously baseline; auto-classify.
--   - Patient + delegate rows carry potential participant-scope data and
--     MUST be operator-reviewed; auto-classify as 'unclassified' — which
--     forces the audited scripts/pilot-1-marker-remediation.sh path
--     BEFORE Day-0 authorization (verify-pilot-1-baseline.sh will refuse
--     to green until every one is classified explicitly by the operator).
--
-- This preserves the ratified contract even on staging where the operator
-- assumed no participants pre-existed — if any patient/delegate row IS
-- purge-scoped data, forcing operator review catches it. If none are
-- participants, remediation is a one-time bulk-classify to baseline via
-- the audited path (each classification emits a pilot_1.cohort_classification
-- audit event).
--
-- Codex R1 finding (2026-08-31): the initial version blanket-backfilled
-- to 'baseline' — a silent violation of the ratified contract's
-- operator-review requirement. Fixed by the split-by-account_type
-- backfill below.
--
-- ---------------------------------------------------------------------------
-- Spec references
-- ---------------------------------------------------------------------------
--   - docs/PII_SCREENING_AND_LOG_REDACTION_SPEC.md §Purge table
--     classification policy step 5 (mixed-baseline table discipline)
--   - docs/PATH_A_PILOT_COMPLETION_RUNBOOK.md §Pilot 1 startup
--     authorization checklist (cohort-marker integrity verifier)
--   - PII spec §Cohort-classification integrity — fail-closed at every
--     enforcement surface (schema NOT NULL + CHECK is layer 1 of the
--     four-layer defense)
--   - Migrations 012 (accounts), 027, 028 (schema evolution) — this
--     migration builds on their canonical account_id + account_type
--     columns
--
-- ---------------------------------------------------------------------------
-- Rollback
-- ---------------------------------------------------------------------------
--
-- migrations/rollback/080_rollback.sql drops the column + related
-- constraints. Safe because no downstream code depends on the column
-- (the pilot-1-env-purge script fails-closed if the column is absent —
-- see the PII spec §Purge preconditions §Manifest inventory).

BEGIN;

-- ---------------------------------------------------------------------------
-- Step 1 — Add the column as NULLABLE (backfill happens in step 2)
-- ---------------------------------------------------------------------------

ALTER TABLE accounts
    ADD COLUMN cohort_classification TEXT
        CHECK (cohort_classification IN ('participant', 'baseline', 'unclassified'));

-- ---------------------------------------------------------------------------
-- Step 2 — Split-by-account_type backfill per Codex R1 finding
-- ---------------------------------------------------------------------------
--
-- Clinicians, tenant admins, platform admins, and service accounts are
-- unambiguously baseline; auto-classify. Patient + delegate rows carry
-- potential participant-scope data and MUST be operator-reviewed via
-- pilot-1-marker-remediation.sh — auto-classify as 'unclassified' to
-- force the audited path.
--
-- Note: migration 012 (account_type CHECK) currently only allows
-- 'patient' and 'delegate'; migrations 027/028 expand to include
-- clinician/tenant_admin/platform_admin. This CASE handles both
-- worlds — any account_type NOT in the operator-baseline set falls
-- through to 'unclassified' (fail-closed if a new account_type value
-- is introduced without updating this migration).

UPDATE accounts
SET cohort_classification = CASE
    WHEN account_type IN ('clinician', 'tenant_admin', 'platform_admin', 'service')
        THEN 'baseline'
    ELSE
        'unclassified'
END
WHERE cohort_classification IS NULL;

-- ---------------------------------------------------------------------------
-- Step 3 — Add NOT NULL constraint now that every row has a value
-- ---------------------------------------------------------------------------
--
-- No DEFAULT is set — every future INSERT MUST specify
-- cohort_classification explicitly. Provisioning code paths that
-- forget the field fail loudly at the NOT NULL constraint rather
-- than silently baseline-classifying.

ALTER TABLE accounts
    ALTER COLUMN cohort_classification SET NOT NULL;

-- ---------------------------------------------------------------------------
-- Step 4 — Index for the pilot-1-env-purge scoped-DELETE query
-- ---------------------------------------------------------------------------
--
-- The scoped DELETE runs during Pilot 1 env-purge (both routine-reset
-- and incident-mode); a partial index on cohort_classification =
-- 'participant' keeps the query fast even as accounts grows across
-- other slice testing.
--
-- Also useful for the runtime marker-integrity gate:
--   SELECT COUNT(*) FROM accounts WHERE cohort_classification = 'unclassified';
-- runs in scripts/verify-pilot-1-baseline.sh at Day-0 startup and as
-- env-purge preflight.

CREATE INDEX IF NOT EXISTS idx_accounts_cohort_participant
    ON accounts (tenant_id, account_id)
    WHERE cohort_classification = 'participant';

CREATE INDEX IF NOT EXISTS idx_accounts_cohort_unclassified
    ON accounts (tenant_id, account_id, account_type)
    WHERE cohort_classification = 'unclassified';

-- ---------------------------------------------------------------------------
-- Step 5 — Column + constraint comments (self-documenting schema)
-- ---------------------------------------------------------------------------

COMMENT ON COLUMN accounts.cohort_classification IS
    'Pilot 1 cohort classification (three-state) per PII spec §Three-state '
    'cohort classification. participant = Pilot 1 participant (patient or '
    'delegate); purged by pilot-1-env-purge. baseline = legitimate baseline '
    '(clinician, admin, service, or baseline-participant-test-fixture); '
    'preserved by purge. unclassified = data-model defect; purge REFUSES '
    'via scripts/verify-pilot-1-baseline.sh preflight until remediated by '
    'scripts/pilot-1-marker-remediation.sh (audit event: '
    'pilot_1.cohort_classification). Sprint 1.3 migration 080; ratified '
    '2026-08-30 under Path α.';

-- ---------------------------------------------------------------------------
-- Verification (idempotent; safe on re-apply)
-- ---------------------------------------------------------------------------

DO $$
DECLARE
    unclassified_patient_delegate_count INT;
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'accounts'
          AND column_name = 'cohort_classification'
    ) THEN
        RAISE EXCEPTION 'migration 080 failed: cohort_classification column not added';
    END IF;

    -- Every existing row must have a non-null classification.
    IF EXISTS (
        SELECT 1 FROM accounts WHERE cohort_classification IS NULL
    ) THEN
        RAISE EXCEPTION 'migration 080 failed: cohort_classification is NULL for at least one existing row';
    END IF;

    -- Every patient/delegate row must be either 'participant' (impossible
    -- at migration time — no INSERTs happened yet) or 'unclassified'
    -- (per the operator-review requirement from PII spec + Codex R1).
    -- If any patient/delegate row is 'baseline' at migration exit, the
    -- backfill violated the ratified contract.
    SELECT COUNT(*)
    INTO unclassified_patient_delegate_count
    FROM accounts
    WHERE account_type IN ('patient', 'delegate')
      AND cohort_classification = 'baseline';

    IF unclassified_patient_delegate_count > 0 THEN
        RAISE EXCEPTION 'migration 080 failed: % patient/delegate row(s) auto-classified as baseline; contract requires operator review via pilot-1-marker-remediation.sh',
            unclassified_patient_delegate_count;
    END IF;

    RAISE NOTICE 'migration 080 verify: patient/delegate rows requiring operator review = %',
        (SELECT COUNT(*) FROM accounts
         WHERE account_type IN ('patient', 'delegate')
           AND cohort_classification = 'unclassified');
END;
$$;

COMMIT;
