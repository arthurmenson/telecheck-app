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
-- Adding as NOT NULL requires a backfill for existing rows. Existing
-- (pre-Pilot-1) rows are, by definition, NOT Pilot 1 participants — they
-- are baseline artifacts of prior slice implementation testing. Backfill
-- assigns 'baseline' to every existing row.
--
-- This backfill is safe on staging because:
--   1. Pilot 1 has not yet run — no participant rows exist yet
--   2. Pilot-1-baseline-seed.sql (separate) will insert new participant
--      rows atomically with cohort_classification = 'participant'
--   3. The staging tenant / operator / seed accounts that pre-exist are
--      correctly baseline
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
-- Step 1 — Add the column with a backfill DEFAULT
-- ---------------------------------------------------------------------------

ALTER TABLE accounts
    ADD COLUMN cohort_classification TEXT NOT NULL DEFAULT 'baseline'
        CHECK (cohort_classification IN ('participant', 'baseline', 'unclassified'));

-- The DEFAULT populates every existing row with 'baseline'. This is safe
-- per §Design above: no Pilot 1 participants exist yet at migration time.

-- ---------------------------------------------------------------------------
-- Step 2 — Drop the DEFAULT so future INSERTs must specify the value
-- ---------------------------------------------------------------------------
--
-- Retaining the DEFAULT would risk silent baseline classification of
-- new Pilot 1 participants if a provisioning code path forgot to
-- specify cohort_classification. Fail-closed: every INSERT into
-- accounts MUST specify cohort_classification explicitly, or fail at
-- the NOT NULL constraint.
--
-- The pilot-1-baseline-seed.sql + participant-kit generator (Sprint
-- 1.3) will set the column explicitly for every provisioned row.

ALTER TABLE accounts
    ALTER COLUMN cohort_classification DROP DEFAULT;

-- ---------------------------------------------------------------------------
-- Step 3 — Index for the pilot-1-env-purge scoped-DELETE query
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
-- Step 4 — Column + constraint comments (self-documenting schema)
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
END;
$$;

COMMIT;
