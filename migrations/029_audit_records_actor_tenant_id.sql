-- =============================================================================
-- File:    migrations/029_audit_records_actor_tenant_id.sql
-- Purpose: Add `actor_tenant_id` column to audit_records to persist the
--          F-4 audit-attribution distinction between RESOURCE tenant
--          (audit_records.tenant_id) and ACTOR tenant (audit_records.
--          actor_tenant_id). Closes Phase 2 F-4 deferred follow-on R2
--          HIGH: "Actor tenant attribution is dropped before durable
--          audit persistence."
--
-- Spec:    - AUDIT_EVENTS v5.2 envelope contract carries actor_tenant_id
--          - I-027 (audit records carry tenant_id — the RESOURCE tenant,
--            unchanged)
--          - I-003 (audit append-only — actor_tenant_id is set at INSERT
--            and never UPDATE'd, consistent with the existing immutability
--            contract)
--          - PHASE_2_ADMIN_JWT_SCOPE_AND_FOLLOW_ONS.md F-4 closure
--          - Codex F-4 R2 HIGH closure 2026-05-15
--
-- HISTORY:
--   The AUDIT_EVENTS v5.2 envelope contract defined `actor_tenant_id` as
--   part of the canonical envelope shape, but migration 002 (the audit-
--   records DDL) did not include the column — every audit emitter's
--   in-memory envelope carried actor_tenant_id, but the INSERT didn't
--   project it into the durable row. For tenant-scoped roles
--   (patient/clinician/tenant_admin), actor_tenant_id always equals
--   tenant_id, so the gap was latent. Phase 2 admin widening introduced
--   the platform_admin role which CAN have actor_tenant_id != tenant_id
--   (cross-tenant administrative action). Persisting actor_tenant_id is
--   required for the F-4 attribution semantics to be observable in audit
--   queries / exports / forensics.
--
-- ADDED COLUMN:
--   - actor_tenant_id TEXT NULL — the acting actor's home tenant. Null
--     for system actors and legacy rows. For tenant-scoped human actors
--     equals tenant_id (the resource tenant). For platform_admin
--     cross-tenant actions, this is the admin's home tenant; the
--     resource tenant (audit_records.tenant_id) reflects where the
--     action was applied.
--
-- BACKFILL:
--   For existing rows, actor_tenant_id is left NULL (no information
--   about historical actor home-tenant available). New rows MUST have
--   the column populated by the emitAudit() INSERT (updated in the
--   same PR).
--
-- PRECONDITIONS:
--   migrations/002_audit_chain.sql applied (target table exists).
--
-- ROLLBACK:
--   migrations/rollback/029_rollback.sql
--
-- COMPAT:
--   Non-destructive: adding a nullable column with no default. Existing
--   INSERTs (none expected post-merge — emitAudit is the sole insert
--   path) that don't list actor_tenant_id will default to NULL.
-- =============================================================================

ALTER TABLE audit_records
    ADD COLUMN IF NOT EXISTS actor_tenant_id TEXT NULL;

-- Documentation comment for forensics / replay tooling
COMMENT ON COLUMN audit_records.actor_tenant_id IS
    'F-4 audit attribution: the actor''s home tenant. For tenant-scoped roles '
    '(patient/clinician/tenant_admin) this equals tenant_id (resource tenant). '
    'For platform_admin cross-tenant actions, this is the admin''s home tenant '
    'while tenant_id reflects the resource tenant. NULL for system actors and '
    'pre-migration-029 legacy rows.';
