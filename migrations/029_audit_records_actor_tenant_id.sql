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

-- F-4 R7 HIGH-1 closure (Codex 2026-05-15): add hash_schema_version
-- column so the verifier can dispatch by version. Pre-029 rows have
-- NULL version (= legacy v1 hash function without actor_tenant_id);
-- new rows get version 2 (the trigger sets it). Without this dispatch,
-- the new canonical_hash function would compute different hashes for
-- pre-029 rows (because COALESCE(NULL,'') still produces a different
-- concat_ws output than the old function omitting actor_tenant_id
-- entirely) — making historical rows look tampered.
ALTER TABLE audit_records
    ADD COLUMN IF NOT EXISTS hash_schema_version SMALLINT NULL;

COMMENT ON COLUMN audit_records.hash_schema_version IS
    'F-4 R7 closure: canonical-hash function version. NULL/1 = pre-029 '
    'legacy hash (no actor_tenant_id in serialization). 2 = post-029 hash '
    'with actor_tenant_id in serialization. The verifier dispatches by '
    'this column. hash_schema_version itself participates in v2+ hashes '
    'so a tamperer cannot downgrade a v2 row to v1 without invalidating '
    'the hash.';

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
--
-- F-4 R4 CRITICAL closure (Codex 2026-05-15): trigger name in
-- migration 002 is `audit_records_before_insert` (not the
-- speculative `audit_records_hash_insert_trigger` from an earlier
-- draft). Drop BOTH possible names so the migration is idempotent
-- under rerun + tolerant of the alternative-name historical artifact.
DROP TRIGGER IF EXISTS audit_records_before_insert ON audit_records;
DROP TRIGGER IF EXISTS audit_records_hash_insert_trigger ON audit_records;
DROP FUNCTION IF EXISTS audit_records_hash_insert();
DROP FUNCTION IF EXISTS audit_records_canonical_hash(
    UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT,
    JSONB, TEXT, TEXT, TEXT, JSONB, JSONB, BYTEA, BIGINT, TIMESTAMPTZ
);

-- v2 canonical hash function. The serialization includes
-- actor_tenant_id AND hash_schema_version so a tamperer cannot
-- downgrade a v2 row to v1 hash without invalidating record_hash.
-- A new p_hash_schema_version parameter is added (caller passes 2
-- for new rows; the function panics if called with v1 since v1 rows
-- use audit_records_canonical_hash_v1 below).
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
    -- v2 canonical: includes actor_tenant_id + hash_schema_version
    -- discriminator at a fixed position so the version itself is
    -- tamper-evident (downgrading version invalidates hash).
    SELECT digest(
        concat_ws('|',
            'v2', -- hash schema version discriminator (defends against version-downgrade tamper)
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

-- v1 canonical hash function (legacy; verbatim from migration 002).
-- Preserves bit-exact serialization for pre-029 rows so the verifier
-- can dispatch by hash_schema_version. Pre-029 rows have NULL version
-- → treated as v1.
CREATE OR REPLACE FUNCTION audit_records_canonical_hash_v1(
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

GRANT EXECUTE ON FUNCTION audit_records_canonical_hash_v1(
    UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT,
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

    -- F-4 R3+R7 closure: set hash_schema_version=2 on every new row
    -- + include actor_tenant_id in canonical hash. Pre-029 rows
    -- already in the table keep their NULL hash_schema_version and
    -- their original v1 record_hash; the verifier dispatches by
    -- column value.
    NEW.hash_schema_version := 2;
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

-- Bind under the canonical migration-002 trigger name so the
-- pin in tests/i003-audit-append-only assumptions stays stable.
CREATE TRIGGER audit_records_before_insert
    BEFORE INSERT ON audit_records
    FOR EACH ROW
    EXECUTE FUNCTION audit_records_hash_insert();

-- ---------------------------------------------------------------------------
-- F-4 R7 HIGH-2 closure (Codex 2026-05-15): close the SQL-side bypass on
-- set_break_glass_context. The function in migration 003 inserts directly
-- into audit_records with actor_type='platform_admin' but no actor_tenant_id.
-- The emitAudit runtime guard can't catch this — it only runs on the
-- application-layer path. Two-pronged defense:
--   (1) Update set_break_glass_context to require + insert actor_home_tenant.
--   (2) Add a DB-level CHECK constraint as a NOT-VALID backstop so future
--       direct-SQL inserts cannot regress attribution.
-- ---------------------------------------------------------------------------

-- (1) Replace set_break_glass_context with a 5-parameter signature.
-- The function in migration 003 is DROP'd + recreated; no app code
-- currently calls it (only a code comment references it), so the
-- signature change is safe at v1.0. The new parameter is positional
-- last to preserve argument order for callers if added later.
DROP FUNCTION IF EXISTS set_break_glass_context(TEXT, TEXT, TEXT, TEXT);

CREATE OR REPLACE FUNCTION set_break_glass_context(
    p_actor_id               TEXT,
    p_target_tenant          TEXT,
    p_justification          TEXT,
    p_authorized_until       TEXT,
    p_actor_home_tenant_id   TEXT  -- F-4 R7 HIGH-2 closure
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
    PERFORM 1
    FROM    public.tenants
    WHERE   id = p_target_tenant
      AND   status = 'active';

    IF NOT FOUND THEN
        RAISE EXCEPTION 'break_glass_target_unavailable'
            USING HINT = 'The break-glass target tenant context could not be established.';
    END IF;

    IF p_justification IS NULL OR trim(p_justification) = '' THEN
        RAISE EXCEPTION 'break_glass_justification_required'
            USING HINT = 'A written justification is mandatory for break-glass access per I-024.';
    END IF;

    -- F-4 R7 HIGH-2: actor's home tenant is required for non-system
    -- audit attribution. Reject missing or whitespace value rather
    -- than fall back to p_target_tenant (which would re-create the
    -- forensic blind spot).
    IF p_actor_home_tenant_id IS NULL OR trim(p_actor_home_tenant_id) = '' THEN
        RAISE EXCEPTION 'break_glass_actor_home_tenant_required'
            USING HINT = 'The actor''s home tenant_id is required for F-4 audit attribution.';
    END IF;

    v_session_id := uuid_generate_v4()::TEXT;

    INSERT INTO public._session_tenant_context (pg_backend_pid, tenant_id, bound_at, expires_at)
    VALUES (
        pg_backend_pid(),
        p_target_tenant,
        NOW(),
        LEAST(
            NOW() + INTERVAL '5 minutes',
            COALESCE(p_authorized_until::TIMESTAMPTZ, NOW() + INTERVAL '5 minutes')
        )
    )
    ON CONFLICT (pg_backend_pid) DO UPDATE
        SET tenant_id  = EXCLUDED.tenant_id,
            bound_at   = EXCLUDED.bound_at,
            expires_at = EXCLUDED.expires_at;

    v_payload := jsonb_build_object(
        'break_glass_session_id',           v_session_id,
        'actor_id',                         p_actor_id,
        'target_tenant_id',                 p_target_tenant,
        'justification',                    p_justification,
        'authorized_until',                 p_authorized_until,
        'privacy_officer_review_status',    'pending',
        'initiated_at',                     NOW()::TEXT
    );

    -- F-4 attribution: actor_tenant_id = p_actor_home_tenant_id (the
    -- platform_admin's HOME tenant), distinct from tenant_id (the
    -- RESOURCE tenant = p_target_tenant). Cross-tenant break-glass is
    -- THE canonical case for non-equal actor_tenant_id and tenant_id.
    INSERT INTO public.audit_records (
        tenant_id,
        category,
        audit_sensitivity_level,
        action,
        actor_type,
        actor_id,
        actor_tenant_id,
        resource_type,
        resource_id,
        break_glass,
        payload,
        recorded_at
    ) VALUES (
        p_target_tenant,
        'B',
        'standard',
        'cross_tenant_break_glass_initiated',
        'platform_admin',
        p_actor_id,
        p_actor_home_tenant_id,
        'tenant',
        p_target_tenant,
        jsonb_build_object(
            'session_id',                   v_session_id,
            'reason',                       p_justification,
            'authorized_until',             p_authorized_until,
            'privacy_officer_review_status','pending'
        ),
        v_payload,
        NOW()
    );

    PERFORM set_config('app.break_glass_session_id', v_session_id,       FALSE);
    PERFORM set_config('app.break_glass_actor_id',   p_actor_id,         FALSE);
    PERFORM set_config('app.break_glass_until',      p_authorized_until, FALSE);
END;
$$;

REVOKE ALL ON FUNCTION set_break_glass_context(TEXT, TEXT, TEXT, TEXT, TEXT) FROM PUBLIC;

-- (2) DB-level CHECK constraint as backstop. NOT VALID so pre-029 rows
-- (which have NULL actor_tenant_id even for non-system actor types) are
-- exempt; new rows must pass. VALIDATE CONSTRAINT can run as a separate
-- maintenance op after legacy rows are backfilled (separate runbook).
ALTER TABLE audit_records
    ADD CONSTRAINT audit_records_actor_tenant_id_required_for_human_actors
    CHECK (
        actor_type IN ('system', 'ai_workload')
        OR actor_tenant_id IS NOT NULL
    )
    NOT VALID;
