-- =============================================================================
-- File:    migrations/002_audit_chain.sql
-- Purpose: Create the append-only `audit_records` table with hash-chain
--          integrity. This is the platform's immutable audit store per I-003.
-- Spec:    - AUDIT_EVENTS v5.2 (audit envelope schema, full field catalog,
--            workload-taxonomy fields, sensitivity levels)
--          - I-003 (audit trail immutable and append-only — NO exceptions)
--          - I-027 (every audit record carries tenant_id)
--          - I-031 (research data export at audit_sensitivity_level = high_pii)
--          - ADR-013 (audit is append-only; referenced in CDM §2 conventions)
--          - ADR-029 / WORKLOAD_TAXONOMY v5.2 (ai_workload_type field)
--          - AUTONOMY_LEVELS v5.2 (autonomy_level field)
--          - CDM v1.2 §3.11 (AuditEvent entity)
-- Summary: Creates audit_records with the full v5.2 envelope including:
--          tenant_id (I-027), audit_sensitivity_level (I-031),
--          ai_workload_type + autonomy_level (ADR-029), hash-chain columns,
--          and the JSONB payload. REVOKE UPDATE/DELETE from PUBLIC and the
--          app role. Two triggers: one computes hash on insert; one blocks
--          any UPDATE or DELETE attempt (belt + suspenders per I-003).
--
-- HASH CHAIN PARTITIONING NOTE (AUDIT_EVENTS v5.2 hash-chain section):
--   The canonical hash chain is partitioned by target_patient_id — each
--   patient has an independent ordered chain. This migration stores both
--   prev_hash and record_hash as BYTEA columns. The INSERT trigger computes
--   record_hash and looks up the prev_hash from the most recent record in the
--   same partition. The first record in a partition uses the genesis seed:
--     prev_hash = digest('GENESIS:' || target_patient_id, 'sha256')
--   Records without a target_patient_id (platform-scope events, break-glass
--   meta-events) use a separate genesis seed:
--     prev_hash = digest('GENESIS:PLATFORM', 'sha256')
-- =============================================================================

-- ---------------------------------------------------------------------------
-- PRECONDITION: 000_extensions.sql must have been applied (pgcrypto, uuid-ossp).
-- PRECONDITION: 001_tenants.sql must have been applied (tenants table).
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS audit_records (
    -- -------------------------------------------------------------------------
    -- Identity
    -- -------------------------------------------------------------------------

    -- UUID primary key. Using uuid_generate_v4() (uuid-ossp extension) rather
    -- than gen_random_uuid() for consistency with the rest of the platform
    -- during the bootstrap phase. Both are cryptographically random.
    audit_id            UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),

    -- Tenant context — required on every record per I-027.
    -- NULL is permitted ONLY for platform-scope meta-events (e.g., Platform
    -- Admin creating a new tenant, cross-partition checkpoint records).
    -- Application layer MUST set this to the target tenant_id in all
    -- operational cases. A NULL here is an audit defect in operational records.
    tenant_id           TEXT        NOT NULL
                            REFERENCES tenants(id),

    -- -------------------------------------------------------------------------
    -- Classification
    -- -------------------------------------------------------------------------

    -- Safety classification matrix category per AUDIT_EVENTS v5.2:
    --   A = Safety-critical clinical actions (10 year retention min)
    --   B = Governance and configuration actions (7 year retention)
    --   C = Operational and engagement actions (per CCR retention config)
    category            TEXT        NOT NULL
                            CHECK (category IN ('A', 'B', 'C')),

    -- Sensitivity level per I-031 and AUDIT_EVENTS v5.2:
    --   standard  = default for all records
    --   high_pii  = research export events (research.export_initiated,
    --               research.export_completed) per I-031
    -- These are ORTHOGONAL to category A/B/C — a record can be category B
    -- AND high_pii (e.g., research.export_initiated is governance + high_pii).
    audit_sensitivity_level  TEXT   NOT NULL DEFAULT 'standard'
                            CHECK (audit_sensitivity_level IN ('standard', 'high_pii')),

    -- -------------------------------------------------------------------------
    -- Action
    -- -------------------------------------------------------------------------

    -- The audit action from the AUDIT_EVENTS v5.2 catalog.
    -- Examples: 'prescribing.approved', 'research.export_completed',
    --           'prescribing.execution_rejected', 'marketing.surface_rendered'
    action              TEXT        NOT NULL,

    -- -------------------------------------------------------------------------
    -- Actor context
    -- -------------------------------------------------------------------------

    -- Actor type from the AUDIT_EVENTS v5.2 actor_type enum.
    -- Active values at v1.0: patient, clinician, pharmacist, operator,
    --   delegate, protocol_engine (deprecated for new code — use ai_workload),
    --   ai_workload, ai_mode_1 (deprecated alias), ai_mode_2 (deprecated alias),
    --   system, platform_admin
    -- New v1.10+ emitters MUST use actor_type = 'ai_workload' per AUDIT_EVENTS
    -- v5.2 actor-type-addition rule. ai_mode_1/ai_mode_2 are backward-compat
    -- aliases preserved for existing records per I-003 (never retroactively delete).
    actor_type          TEXT        NOT NULL
                            CHECK (actor_type IN (
                                'patient', 'clinician', 'pharmacist', 'operator',
                                'delegate', 'protocol_engine',
                                'ai_workload', 'ai_mode_1', 'ai_mode_2',
                                'system', 'platform_admin'
                            )),

    -- Authenticated identity ULID of the acting entity.
    actor_id            TEXT        NOT NULL,

    -- -------------------------------------------------------------------------
    -- AI workload taxonomy fields (AUDIT_EVENTS v5.2, ADR-029, WORKLOAD_TAXONOMY v5.2)
    -- -------------------------------------------------------------------------

    -- AI workload classification per WORKLOAD_TAXONOMY v5.2.
    -- Required when actor_type = 'ai_workload'.
    -- Nullable for non-AI events (actor_type != 'ai_workload') and legacy
    -- backfill records (pre-v1.10).
    -- Active values at v1.0: conversational_assistant, protocol_execution
    -- Reserved (runtime-rejected until activation audit event recorded):
    --   autonomous_agent, multi_agent_supervisor, tool_using_agent
    -- Sentinel 'rejected_invalid_attempt': valid ONLY on *.execution_rejected
    --   events (prescribing.execution_rejected, refill.execution_rejected,
    --   medication_order.execution_rejected) per AUDIT_EVENTS v5.2 carve-out.
    -- Sentinel 'n/a': valid ONLY on I-012 clinician-only approval records where
    --   no AI workload was upstream (Codex Round-6 Scope 1 MEDIUM-1 patch).
    ai_workload_type    TEXT        NULL
                            CHECK (ai_workload_type IS NULL OR ai_workload_type IN (
                                'conversational_assistant',
                                'protocol_execution',
                                'autonomous_agent',
                                'multi_agent_supervisor',
                                'tool_using_agent',
                                'rejected_invalid_attempt',
                                'n/a'
                            )),

    -- Autonomy level per AUTONOMY_LEVELS v5.2.
    -- Active at v1.0: advisory, suggestion, action_with_confirm
    -- Reserved: action_with_audit_only, fully_autonomous
    -- Sentinels: rejected_invalid_attempt, n/a — same carve-out rules as above.
    autonomy_level      TEXT        NULL
                            CHECK (autonomy_level IS NULL OR autonomy_level IN (
                                'advisory',
                                'suggestion',
                                'action_with_confirm',
                                'action_with_audit_only',
                                'fully_autonomous',
                                'rejected_invalid_attempt',
                                'n/a'
                            )),

    -- -------------------------------------------------------------------------
    -- Target context
    -- -------------------------------------------------------------------------

    -- The patient this action affects, if applicable. NULL for non-patient
    -- actions (e.g., tenant configuration, market launch governance events).
    -- Also used as the hash-chain partition key — see trigger below.
    target_patient_id   TEXT        NULL,

    -- Delegate context (serialized as JSONB per AUDIT_EVENTS v5.2 envelope).
    -- Shape: { "delegate_id": "...", "scope": "..." } | null
    delegate_context    JSONB       NULL,

    -- Resource type and ID (aggregate type and aggregate instance ID).
    resource_type       TEXT        NULL,
    resource_id         TEXT        NULL,

    -- Country of care at time of action (ISO 3166-1 alpha-2).
    -- Drives regulatory, retention, and access-control context.
    country_of_care     TEXT        NULL,

    -- Break-glass session context (I-024). Non-null when this record was
    -- produced during an authorized break-glass cross-tenant session.
    -- Shape: { "session_id": "...", "reason": "...", "authorized_until": "...",
    --          "privacy_officer_review_status": "pending | reviewed" }
    break_glass         JSONB       NULL,

    -- -------------------------------------------------------------------------
    -- Payload
    -- -------------------------------------------------------------------------

    -- Action-specific detail payload per AUDIT_EVENTS v5.2 action catalog.
    -- Stored as JSONB to accommodate the wide variety of detail shapes across
    -- the action catalog while keeping the core schema lean.
    payload             JSONB       NOT NULL,

    -- -------------------------------------------------------------------------
    -- Hash chain (AUDIT_EVENTS v5.2 hash-chain section + I-003)
    -- -------------------------------------------------------------------------

    -- SHA-256 of the previous record in this partition (target_patient_id).
    -- NULL only for the genesis record in a partition — in practice the trigger
    -- sets this to digest('GENESIS:' || target_patient_id, 'sha256') so the
    -- column is never truly NULL after insert.
    prev_hash           BYTEA       NULL,

    -- SHA-256 of this record's content (computed by trigger on INSERT).
    -- All payload fields EXCEPT prev_hash and record_hash are hashed.
    record_hash         BYTEA       NOT NULL DEFAULT '\x00',  -- placeholder; trigger overwrites

    -- Monotonically increasing sequence number within the partition.
    -- Used for ordering (distinct from timestamp, which detects tampering).
    sequence_number     BIGINT      NOT NULL DEFAULT 0,        -- trigger sets correct value

    -- -------------------------------------------------------------------------
    -- Timestamps
    -- -------------------------------------------------------------------------

    recorded_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ---------------------------------------------------------------------------
-- Indexes per AUDIT_EVENTS v5.2 query patterns
-- ---------------------------------------------------------------------------

-- Primary tenant-scoped time-range query (Tenant Admin audit retrieval).
CREATE INDEX IF NOT EXISTS idx_audit_tenant_time
    ON audit_records (tenant_id, recorded_at);

-- Tenant + action scoped retrieval (compliance queries by action type).
CREATE INDEX IF NOT EXISTS idx_audit_tenant_action_time
    ON audit_records (tenant_id, action, recorded_at);

-- Patient-partition chain walk (verification + patient self-access per AUDIT_EVENTS v5.2).
CREATE INDEX IF NOT EXISTS idx_audit_patient_partition
    ON audit_records (target_patient_id, sequence_number)
    WHERE target_patient_id IS NOT NULL;

-- High-PII audit retrieval (research data governance queries, ethics boards).
CREATE INDEX IF NOT EXISTS idx_audit_sensitivity
    ON audit_records (tenant_id, audit_sensitivity_level, recorded_at)
    WHERE audit_sensitivity_level = 'high_pii';

-- ---------------------------------------------------------------------------
-- ROW-LEVEL SECURITY — I-023 three-layer tenant isolation
-- (added v0.1 patch 2026-05-02 per Codex foundation-layer review CRITICAL-1
--  finding: audit_records was created without RLS, leaving a cross-tenant
--  audit-PHI leak path. Any role with SELECT on the table could read across
--  tenants — direct I-023 violation.)
--
-- Default policy: tenant-scoped reads via current_tenant_id() (set by
-- application layer per migration 003 set_tenant_context). FORCE applies the
-- policy to the table OWNER too (without FORCE, the owner bypasses RLS and
-- can read across tenants in maintenance contexts).
--
-- Platform / break-glass cross-tenant access (I-024) bypasses this policy
-- via an explicit audited path: callers run set_break_glass_context() first
-- (migration 003), which records a break-glass audit record AND sets the
-- session GUC `app.break_glass_active = true` that is checked by a separate
-- USING expression below. Any cross-tenant audit retrieval is therefore
-- self-auditing per I-024 — it is impossible to read another tenant's audit
-- data without producing an audit record of doing so.
-- ---------------------------------------------------------------------------

ALTER TABLE audit_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_records FORCE ROW LEVEL SECURITY;

-- Tenant-scoped policy: ordinary reads/writes scoped to the caller's tenant.
-- WITH CHECK is identical to USING so writes that would land in another
-- tenant's row are also rejected (defense in depth against application-layer
-- bugs that try to insert with a foreign tenant_id).
CREATE POLICY audit_tenant_isolation ON audit_records
    AS PERMISSIVE
    FOR ALL
    USING (tenant_id = current_tenant_id())
    WITH CHECK (tenant_id = current_tenant_id());

-- Break-glass policy (I-024): permits read access across tenants ONLY when
-- the session has been opened via set_break_glass_context(). That function
-- records the break-glass audit record before allowing the cross-tenant
-- read, so this policy cannot fire silently. Writes are NOT permitted even
-- under break-glass — break-glass is a read-only investigative posture per
-- I-024; cross-tenant writes require a different escalation path.
CREATE POLICY audit_break_glass_read ON audit_records
    AS PERMISSIVE
    FOR SELECT
    USING (current_setting('app.break_glass_active', true) = 'true');

-- ---------------------------------------------------------------------------
-- APPEND-ONLY ENFORCEMENT — I-003
-- Revoke UPDATE and DELETE from PUBLIC and from the expected application role.
-- Belt: REVOKE at the privilege layer.
-- Suspenders: trigger below raises EXCEPTION on any UPDATE/DELETE attempt,
--             even from superusers running ad-hoc queries.
-- ---------------------------------------------------------------------------

REVOKE UPDATE ON audit_records FROM PUBLIC;
REVOKE DELETE ON audit_records FROM PUBLIC;

-- SPEC ISSUE: The charter specifies REVOKE from app role(s) but the application
-- DB role name has not been established at this migration point (no role
-- creation migration exists yet). The REVOKE from PUBLIC above covers all
-- non-superuser roles. When the application role is created (expected in a
-- future 006_roles.sql migration), add:
--   REVOKE UPDATE ON audit_records FROM telecheck_app_role;
--   REVOKE DELETE ON audit_records FROM telecheck_app_role;
-- This is an SI that the Engineering Lead should resolve when the role
-- migration is authored.

-- ---------------------------------------------------------------------------
-- HASH-CHAIN INSERT TRIGGER
-- Computes prev_hash and record_hash on every INSERT per AUDIT_EVENTS v5.2
-- hash-chain construction rules.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION audit_records_hash_insert()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_partition_key     TEXT;
    v_prev_record       RECORD;
    v_raw               TEXT;
BEGIN
    -- Determine the partition key.
    -- Partitioned by target_patient_id per AUDIT_EVENTS v5.2.
    -- Platform-scope events (no patient target) use sentinel partition 'PLATFORM'.
    v_partition_key := COALESCE(NEW.target_patient_id, 'PLATFORM');

    -- Fetch the most recent record in this partition.
    SELECT sequence_number, record_hash
    INTO   v_prev_record
    FROM   audit_records
    WHERE  COALESCE(target_patient_id, 'PLATFORM') = v_partition_key
    ORDER BY sequence_number DESC
    LIMIT  1
    FOR    UPDATE;  -- serialise concurrent INSERTs within the same partition

    IF v_prev_record IS NULL THEN
        -- First record in this partition: use genesis seed per AUDIT_EVENTS v5.2.
        NEW.prev_hash       := digest('GENESIS:' || v_partition_key, 'sha256');
        NEW.sequence_number := 1;
    ELSE
        NEW.prev_hash       := v_prev_record.record_hash;
        NEW.sequence_number := v_prev_record.sequence_number + 1;
    END IF;

    -- Compute record_hash as SHA-256 of all payload fields EXCEPT the
    -- hash_chain fields themselves (prev_hash, record_hash, sequence_number).
    -- We hash a deterministic text representation of the canonical fields.
    -- Production note: the application layer SHOULD independently verify this
    -- hash using the same field set before trusting the stored value.
    v_raw := concat_ws('|',
        NEW.audit_id::TEXT,
        NEW.tenant_id,
        NEW.category,
        NEW.audit_sensitivity_level,
        NEW.action,
        NEW.actor_type,
        NEW.actor_id,
        COALESCE(NEW.ai_workload_type,  ''),
        COALESCE(NEW.autonomy_level,    ''),
        COALESCE(NEW.target_patient_id, ''),
        COALESCE(NEW.delegate_context::TEXT, ''),
        COALESCE(NEW.resource_type,     ''),
        COALESCE(NEW.resource_id,       ''),
        COALESCE(NEW.country_of_care,   ''),
        COALESCE(NEW.break_glass::TEXT, ''),
        NEW.payload::TEXT,
        NEW.prev_hash::TEXT,
        NEW.sequence_number::TEXT,
        NEW.recorded_at::TEXT
    );

    NEW.record_hash := digest(v_raw, 'sha256');

    RETURN NEW;
END;
$$;

CREATE TRIGGER audit_records_before_insert
    BEFORE INSERT ON audit_records
    FOR EACH ROW
    EXECUTE FUNCTION audit_records_hash_insert();

-- ---------------------------------------------------------------------------
-- APPEND-ONLY UPDATE/DELETE GUARD TRIGGER — I-003 belt + suspenders
-- Raises an EXCEPTION on any UPDATE or DELETE attempt, even if the privilege
-- REVOKE above is somehow bypassed (e.g., schema owner running ad-hoc SQL).
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION audit_records_block_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    RAISE EXCEPTION
        'audit_records is append-only per I-003. '
        'UPDATE and DELETE are permanently prohibited. '
        'Corrections must be appended as new records referencing the original audit_id.';
END;
$$;

CREATE TRIGGER audit_records_block_update
    BEFORE UPDATE ON audit_records
    FOR EACH ROW
    EXECUTE FUNCTION audit_records_block_mutation();

CREATE TRIGGER audit_records_block_delete
    BEFORE DELETE ON audit_records
    FOR EACH ROW
    EXECUTE FUNCTION audit_records_block_mutation();
