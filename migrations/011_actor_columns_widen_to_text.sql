-- ===========================================================================
-- File:    migrations/011_actor_columns_widen_to_text.sql
-- Purpose: Widen actor-identity columns from VARCHAR(26) to TEXT on forms_*
--          tables — same justification as migration 010's `program_id`
--          widening, applied here to the columns that bind a row to the
--          tenant_user who performed the action.
--
-- Why this is a real fix (not a test-only workaround):
--   Migration 006 declared these columns as VARCHAR(26) under the inline
--   comment "tenant_user_id (ULID)" — the assumption being that
--   tenant_user_id is always a 26-char ULID. In practice:
--
--   - Production tenant_user_id WILL likely become a typed identifier
--     (e.g., `tu_<ULID>` = 30 chars) once the Identity & Auth slice lands,
--     mirroring the `pce_`-prefixed ProgramCatalogEntryId convention from
--     Master PRD v1.10 §10.5. A VARCHAR(26) ceiling forbids that evolution.
--
--   - Integration tests pass descriptive actor IDs (e.g.,
--     `op_http_dep_retire_noactor_create`, 33 chars) for debuggability. CI
--     surfaced this as a NOT NULL → length-overflow cascade (PG 22001
--     "value too long for type character varying(26)") on
--     forms_deployment.deployed_by once the test-pool override (commit
--     4fb39b7) and the deployedBy fix (commit 1d713cb) made the actual
--     INSERT path observable end-to-end.
--
--   The fix is the same as migration 010: widen to TEXT and call out the
--   identifier-type evolution explicitly.
--
-- Tables affected:
--   - forms_template.created_by    VARCHAR(26) → TEXT
--   - forms_template.approved_by   VARCHAR(26) → TEXT (nullable)
--   - forms_deployment.deployed_by VARCHAR(26) → TEXT
--   - forms_variant.created_by     VARCHAR(26) → TEXT
--
-- Spec references:
--   - Master PRD v1.10 §10.5 (typed-identifier convention; not yet codified
--     for tenant_user_id but the schema should not preclude it).
--   - Contracts Pack v5.2 GLOSSARY §tenant_user_id (canonical ID name).
--   - Migration 002 audit_records.actor_id is already TEXT — the canonical
--     audit-trail actor column does NOT have the 26-char ceiling, so this
--     migration brings the forms_* actor columns into alignment.
--   - Migration 005 idempotency_keys.actor_id is also already TEXT.
--
-- Idempotency: ALTER COLUMN ... TYPE TEXT is a no-op when the target type
--   is already TEXT. Safe to re-run via the test setup's auto-discovery.
--
-- Rollback: see migrations/rollback/011_actor_columns_widen_to_text_rollback.sql
--   (narrows back to VARCHAR(26); will fail at runtime if any row carries a
--   value longer than 26 chars).
-- ===========================================================================

ALTER TABLE forms_template
    ALTER COLUMN created_by TYPE TEXT;

ALTER TABLE forms_template
    ALTER COLUMN approved_by TYPE TEXT;

ALTER TABLE forms_deployment
    ALTER COLUMN deployed_by TYPE TEXT;

-- forms_variant may not have been created yet on first migration run if
-- migration ordering ever changes — guard the ALTER with a metadata check.
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name = 'forms_variant'
           AND column_name = 'created_by'
    ) THEN
        EXECUTE 'ALTER TABLE forms_variant ALTER COLUMN created_by TYPE TEXT';
    END IF;
END $$;
