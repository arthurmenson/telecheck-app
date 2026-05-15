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

-- 1. Drop the trigger + new function bodies (depend on the columns
--    we're about to remove + the new canonical-hash signature we're
--    about to drop). Also drop the F-4 CHECK constraint + the new
--    set_break_glass_context signature.
ALTER TABLE audit_records
    DROP CONSTRAINT IF EXISTS audit_records_actor_tenant_id_required_for_human_actors;
DROP FUNCTION IF EXISTS set_break_glass_context(TEXT, TEXT, TEXT, TEXT, TEXT);
DROP TRIGGER IF EXISTS audit_records_before_insert ON audit_records;
DROP TRIGGER IF EXISTS audit_records_hash_insert_trigger ON audit_records;
DROP FUNCTION IF EXISTS audit_records_hash_insert();
DROP FUNCTION IF EXISTS audit_records_canonical_hash(
    UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT,
    JSONB, TEXT, TEXT, TEXT, JSONB, JSONB, BYTEA, BIGINT, TIMESTAMPTZ
);
DROP FUNCTION IF EXISTS audit_records_canonical_hash_v1(
    UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT,
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

-- 4b. Recreate pre-029 set_break_glass_context (4-parameter signature
-- without actor_home_tenant). Verbatim from migration 003.
CREATE OR REPLACE FUNCTION set_break_glass_context(
    p_actor_id          TEXT,
    p_target_tenant     TEXT,
    p_justification     TEXT,
    p_authorized_until  TEXT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    v_session_id    TEXT;
    v_payload       JSONB;
BEGIN
    PERFORM 1 FROM public.tenants WHERE id = p_target_tenant AND status = 'active';
    IF NOT FOUND THEN
        RAISE EXCEPTION 'break_glass_target_unavailable';
    END IF;
    IF p_justification IS NULL OR trim(p_justification) = '' THEN
        RAISE EXCEPTION 'break_glass_justification_required';
    END IF;
    v_session_id := uuid_generate_v4()::TEXT;
    INSERT INTO public._session_tenant_context (pg_backend_pid, tenant_id, bound_at, expires_at)
    VALUES (pg_backend_pid(), p_target_tenant, NOW(),
            LEAST(NOW() + INTERVAL '5 minutes',
                  COALESCE(p_authorized_until::TIMESTAMPTZ, NOW() + INTERVAL '5 minutes')))
    ON CONFLICT (pg_backend_pid) DO UPDATE
        SET tenant_id = EXCLUDED.tenant_id, bound_at = EXCLUDED.bound_at, expires_at = EXCLUDED.expires_at;
    v_payload := jsonb_build_object(
        'break_glass_session_id', v_session_id, 'actor_id', p_actor_id,
        'target_tenant_id', p_target_tenant, 'justification', p_justification,
        'authorized_until', p_authorized_until,
        'privacy_officer_review_status', 'pending', 'initiated_at', NOW()::TEXT);
    INSERT INTO public.audit_records (
        tenant_id, category, audit_sensitivity_level, action,
        actor_type, actor_id, resource_type, resource_id,
        break_glass, payload, recorded_at
    ) VALUES (
        p_target_tenant, 'B', 'standard', 'cross_tenant_break_glass_initiated',
        'platform_admin', p_actor_id, 'tenant', p_target_tenant,
        jsonb_build_object('session_id', v_session_id, 'reason', p_justification,
                           'authorized_until', p_authorized_until,
                           'privacy_officer_review_status', 'pending'),
        v_payload, NOW()
    );
    PERFORM set_config('app.break_glass_session_id', v_session_id,       FALSE);
    PERFORM set_config('app.break_glass_actor_id',   p_actor_id,         FALSE);
    PERFORM set_config('app.break_glass_until',      p_authorized_until, FALSE);
END;
$$;
REVOKE ALL ON FUNCTION set_break_glass_context(TEXT, TEXT, TEXT, TEXT) FROM PUBLIC;

-- 5. Finally drop the columns (no longer referenced by any function or
--    trigger).
ALTER TABLE audit_records
    DROP COLUMN IF EXISTS actor_tenant_id;

ALTER TABLE audit_records
    DROP COLUMN IF EXISTS hash_schema_version;
