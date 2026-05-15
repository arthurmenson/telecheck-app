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

-- ---------------------------------------------------------------------------
-- F-4 R3 HIGH closure (Codex 2026-05-15): persisting actor_tenant_id is
-- not enough — without including it in the hash chain, a malicious or
-- buggy actor could mutate actor_tenant_id post-INSERT without the
-- chain verifier detecting the tampering. Drop + recreate the canonical
-- hash function with actor_tenant_id participating in the canonical
-- serialization. Update the trigger function to pass NEW.actor_tenant_id.
-- ---------------------------------------------------------------------------

-- DROP first because we're changing the function's parameter list signature
-- (Postgres requires a DROP-then-CREATE; CREATE OR REPLACE doesn't support
-- signature changes). The trigger function holds a reference, so we
-- recreate both in dependency order: drop trigger → drop canonical hash
-- → recreate canonical hash with new sig → recreate trigger function
-- → re-bind trigger.
DROP TRIGGER IF EXISTS audit_records_hash_insert_trigger ON audit_records;
DROP FUNCTION IF EXISTS audit_records_hash_insert();
DROP FUNCTION IF EXISTS audit_records_canonical_hash(
    UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT,
    JSONB, TEXT, TEXT, TEXT, JSONB, JSONB, BYTEA, BIGINT, TIMESTAMPTZ
);

CREATE OR REPLACE FUNCTION audit_records_canonical_hash(
    p_audit_id            UUID,
    p_tenant_id           TEXT,
    p_category            TEXT,
    p_audit_sensitivity_level TEXT,
    p_action              TEXT,
    p_actor_type          TEXT,
    p_actor_id            TEXT,
    p_actor_tenant_id     TEXT,
    p_ai_workload_type    TEXT,
    p_autonomy_level      TEXT,
    p_target_patient_id   TEXT,
    p_delegate_context    JSONB,
    p_resource_type       TEXT,
    p_resource_id         TEXT,
    p_country_of_care     TEXT,
    p_break_glass         JSONB,
    p_payload             JSONB,
    p_prev_hash           BYTEA,
    p_sequence_number     BIGINT,
    p_recorded_at         TIMESTAMPTZ
)
RETURNS BYTEA
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog, public
AS $$
    SELECT digest(
        concat_ws('|',
            p_audit_id::TEXT,
            p_tenant_id,
            p_category,
            p_audit_sensitivity_level,
            p_action,
            p_actor_type,
            p_actor_id,
            COALESCE(p_actor_tenant_id, ''),
            COALESCE(p_ai_workload_type,  ''),
            COALESCE(p_autonomy_level,    ''),
            COALESCE(p_target_patient_id, ''),
            COALESCE(p_delegate_context::TEXT, ''),
            COALESCE(p_resource_type,     ''),
            COALESCE(p_resource_id,       ''),
            COALESCE(p_country_of_care,   ''),
            COALESCE(p_break_glass::TEXT, ''),
            p_payload::TEXT,
            p_prev_hash::TEXT,
            p_sequence_number::TEXT,
            p_recorded_at::TEXT
        ),
        'sha256'
    );
$$;

GRANT EXECUTE ON FUNCTION audit_records_canonical_hash(
    UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT,
    JSONB, TEXT, TEXT, TEXT, JSONB, JSONB, BYTEA, BIGINT, TIMESTAMPTZ
) TO PUBLIC;

CREATE OR REPLACE FUNCTION audit_records_hash_insert()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    v_partition_key     TEXT;
    v_prev_record       RECORD;
BEGIN
    v_partition_key := NEW.tenant_id || ':' || COALESCE(NEW.target_patient_id, 'PLATFORM');
    PERFORM pg_advisory_xact_lock(hashtextextended(v_partition_key, 0));

    SELECT sequence_number, record_hash
    INTO   v_prev_record
    FROM   public.audit_records
    WHERE  tenant_id = NEW.tenant_id
      AND  COALESCE(target_patient_id, 'PLATFORM') = COALESCE(NEW.target_patient_id, 'PLATFORM')
    ORDER BY sequence_number DESC
    LIMIT  1
    FOR    UPDATE;

    IF v_prev_record IS NULL THEN
        NEW.prev_hash       := digest('GENESIS:' || v_partition_key, 'sha256');
        NEW.sequence_number := 1;
    ELSE
        NEW.prev_hash       := v_prev_record.record_hash;
        NEW.sequence_number := v_prev_record.sequence_number + 1;
    END IF;

    -- F-4 R3 closure: include actor_tenant_id in canonical hash so
    -- tampering with the column post-INSERT is detected by chain
    -- validation.
    NEW.record_hash := audit_records_canonical_hash(
        NEW.audit_id,
        NEW.tenant_id,
        NEW.category,
        NEW.audit_sensitivity_level,
        NEW.action,
        NEW.actor_type,
        NEW.actor_id,
        NEW.actor_tenant_id,
        NEW.ai_workload_type,
        NEW.autonomy_level,
        NEW.target_patient_id,
        NEW.delegate_context,
        NEW.resource_type,
        NEW.resource_id,
        NEW.country_of_care,
        NEW.break_glass,
        NEW.payload,
        NEW.prev_hash,
        NEW.sequence_number,
        NEW.recorded_at
    );

    RETURN NEW;
END;
$$;

CREATE TRIGGER audit_records_hash_insert_trigger
    BEFORE INSERT ON audit_records
    FOR EACH ROW
    EXECUTE FUNCTION audit_records_hash_insert();
