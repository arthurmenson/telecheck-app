-- =============================================================================
-- File:    migrations/rollback/029_rollback.sql
-- Purpose: Roll back migration 029 — drop the actor_tenant_id column AND
--          restore the pre-029 canonical-hash function signature + trigger
--          function body. Closes Codex F-4 R4 HIGH: "Rollback drops the
--          column but does not restore the old trigger/function contract."
--
-- Without the function restoration, the post-rollback INSERT trigger would
-- still reference NEW.actor_tenant_id (a column that no longer exists),
-- breaking every audit_records INSERT.
--
-- WARNING: This drops attribution data captured by F-4. If
--          actor_tenant_id was populated in any rows (post-migration
--          rows from emitAudit), that data is permanently lost. Only
--          roll back if the F-4 work is being abandoned.
--
-- Spec:    Companion to migrations/029_audit_records_actor_tenant_id.sql.
-- =============================================================================

-- 1. Drop the trigger + new function bodies (depend on the column we're
--    about to remove + the new canonical-hash signature we're about to
--    drop).
DROP TRIGGER IF EXISTS audit_records_before_insert ON audit_records;
DROP TRIGGER IF EXISTS audit_records_hash_insert_trigger ON audit_records;
DROP FUNCTION IF EXISTS audit_records_hash_insert();
DROP FUNCTION IF EXISTS audit_records_canonical_hash(
    UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT,
    JSONB, TEXT, TEXT, TEXT, JSONB, JSONB, BYTEA, BIGINT, TIMESTAMPTZ
);

-- 2. Recreate the pre-029 canonical-hash function (signature WITHOUT
--    p_actor_tenant_id; body matches migration 002 verbatim).
CREATE OR REPLACE FUNCTION audit_records_canonical_hash(
    p_audit_id            UUID,
    p_tenant_id           TEXT,
    p_category            TEXT,
    p_audit_sensitivity_level TEXT,
    p_action              TEXT,
    p_actor_type          TEXT,
    p_actor_id            TEXT,
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
    UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT,
    JSONB, TEXT, TEXT, TEXT, JSONB, JSONB, BYTEA, BIGINT, TIMESTAMPTZ
) TO PUBLIC;

-- 3. Recreate the pre-029 trigger function (without NEW.actor_tenant_id
--    reference).
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

    NEW.record_hash := audit_records_canonical_hash(
        NEW.audit_id,
        NEW.tenant_id,
        NEW.category,
        NEW.audit_sensitivity_level,
        NEW.action,
        NEW.actor_type,
        NEW.actor_id,
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

-- 4. Rebind the trigger under the canonical migration-002 name.
CREATE TRIGGER audit_records_before_insert
    BEFORE INSERT ON audit_records
    FOR EACH ROW
    EXECUTE FUNCTION audit_records_hash_insert();

-- 5. Finally drop the column (no longer referenced by any function or
--    trigger).
ALTER TABLE audit_records
    DROP COLUMN IF EXISTS actor_tenant_id;
