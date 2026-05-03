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

-- ---------------------------------------------------------------------------
-- Forward declaration: current_tenant_id() stub
--
-- The RLS policy on audit_records (added below) references current_tenant_id()
-- in its USING / WITH CHECK expressions. Postgres validates policy expressions
-- at CREATE POLICY time, so the function must already exist when this
-- migration runs — but the real implementation lives in migration 003
-- (it depends on the _session_tenant_context table which 003 also creates).
--
-- Stub it here as a fail-closed RAISE so any accidental call prior to 003
-- being applied behaves identically to "no tenant binding". Migration 003
-- replaces this stub via CREATE OR REPLACE FUNCTION with the real
-- session-binding lookup. Adding this stub closed CI failure
-- "Migration 002_audit_chain.sql failed: function current_tenant_id() does
-- not exist" observed on commit f2c7581.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION current_tenant_id()
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = pg_catalog, public
AS $$
BEGIN
    RAISE EXCEPTION 'tenant_context_not_set'
        USING HINT = 'current_tenant_id() stub from migration 002 was invoked. '
                     'Migration 003_rls_helpers.sql replaces this stub with the '
                     'real implementation; if you see this error in production, '
                     'migration 003 was not applied. This is a three-layer '
                     'isolation requirement per I-023.';
END;
$$;

GRANT EXECUTE ON FUNCTION current_tenant_id() TO PUBLIC;

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
-- Composite (tenant_id, target_patient_id, sequence_number) so the trigger's
-- "previous record in partition" lookup (now tenant-scoped per HIGH-1 fix
-- 2026-05-03) hits an index instead of a sequential scan; also serves the
-- patient-self-access read pattern.
CREATE INDEX IF NOT EXISTS idx_audit_tenant_patient_partition
    ON audit_records (tenant_id, target_patient_id, sequence_number)
    WHERE target_patient_id IS NOT NULL;

-- Platform-scope chain walk: same partition shape but for events with no
-- target_patient_id. Predicate matches the trigger's COALESCE(NULL, 'PLATFORM')
-- branch.
CREATE INDEX IF NOT EXISTS idx_audit_tenant_platform_partition
    ON audit_records (tenant_id, sequence_number)
    WHERE target_patient_id IS NULL;

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

-- ---------------------------------------------------------------------------
-- Break-glass cross-tenant audit access — DEFERRED to a later migration
-- ---------------------------------------------------------------------------
-- (Removed v0.3 patch 2026-05-02 per Codex foundation-verify-r2 CRITICAL-2
--  finding: the prior `audit_break_glass_read` policy gated on
--  `current_setting('app.break_glass_active', true) = 'true'` — a settable
--  boolean GUC that any SQL-capable session could assert with a direct
--  `SET app.break_glass_active = true` to bypass the audited helper path.
--  In addition, `set_break_glass_context()` in migration 003 never set
--  this GUC, so the documented audited path did not actually enable the
--  policy either way.
--
--  Cross-tenant break-glass audit reads (per I-024) require:
--    1. A non-spoofable session-tracking table (e.g., `break_glass_sessions`)
--       written ONLY by `set_break_glass_context()` (REVOKE all from PUBLIC)
--       and read by an RLS USING expression that joins against this table
--       on a session_id verified against the durable audit record paired
--       to it.
--    2. A SECURITY DEFINER `is_break_glass_session_valid(session_id)`
--       function that bypasses RLS to verify the session against the
--       durable state — running under FORCE ROW LEVEL SECURITY this
--       requires careful function-owner privilege design.
--    3. Tests proving (a) the audited helper path enables the policy AND
--       (b) direct GUC manipulation does NOT enable the policy.
--
--  This pattern is the responsibility of the Admin Backend slice (per
--  EHBG §10 build sequence; Admin Backend Slice PRD v1.1) where break-
--  glass operator UI and Privacy Officer review workflow live. Until
--  that slice lands, audit reads are STRICTLY tenant-scoped — there
--  is no cross-tenant audit retrieval path. This is the safer default
--  and matches how break-glass actually works at v1.0: an authorized
--  human exports redacted data via a vetted operational process, not
--  via a database query.)
-- ---------------------------------------------------------------------------

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
-- HASH-CHAIN CANONICAL HASH FUNCTION
--
-- Returns the SHA-256 record_hash that the trigger would compute for a row
-- if it were inserted with the given prev_hash + sequence_number. This is the
-- single source of truth for the canonical serialization — both the BEFORE
-- INSERT trigger AND the test-side / application-side chain walker call this
-- function, so trigger and walker can never drift.
--
-- (Added 2026-05-03 per Codex CI-fix adversarial review HIGH-2: the test
--  walker had been simplified to link-only verification, accepting forged
--  record_hashes that were re-signed without breaking link sequence. By
--  exposing the canonicalization as an IMMUTABLE SQL function, the walker
--  can recompute and verify each row's record_hash without mirroring the
--  trigger's `concat_ws('|', ...)` format in TS — that mirror is what the
--  walker simplification was avoiding because it doesn't survive schema
--  additions. The function is the schema-additions choke point: change the
--  serialization here once and trigger + walker stay in lockstep.)
-- ---------------------------------------------------------------------------

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

-- ---------------------------------------------------------------------------
-- HASH-CHAIN INSERT TRIGGER
-- Computes prev_hash and record_hash on every INSERT per AUDIT_EVENTS v5.2
-- hash-chain construction rules. Calls audit_records_canonical_hash() for the
-- record_hash so trigger + walker share canonicalization (HIGH-2 fix).
-- ---------------------------------------------------------------------------

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
    -- Determine the partition key.
    -- Partitioned by (tenant_id, target_patient_id) per AUDIT_EVENTS v5.2 +
    -- I-023/I-027 cross-tenant-isolation discipline. Platform-scope events
    -- (no patient target) use sentinel suffix 'PLATFORM'; the tenant_id
    -- prefix keeps tenants' chains independent even at the platform-scope
    -- partition.
    --
    -- (Patch v0.4 — 2026-05-03 per Codex CI-fix adversarial review HIGH-1:
    --  the prior partition was target_patient_id alone, which let two
    --  tenants that ever shared a target_patient_id — or both emitted any
    --  platform-scope record — cross-contaminate hash chains. The trigger
    --  is SECURITY DEFINER and queries public.audit_records directly,
    --  bypassing the caller's RLS view, so the cross-tenant link could
    --  not be detected by tenant-scoped verification. Tenant-scoping the
    --  partition restores I-023/I-027 cryptographic independence.)
    v_partition_key := NEW.tenant_id || ':' || COALESCE(NEW.target_patient_id, 'PLATFORM');

    -- Fetch the most recent record in this partition (now scoped to the
    -- caller's tenant — see partition-key comment above).
    -- Schema-qualified per Codex foundation-verify-r4 HIGH: pg_temp shadow attack.
    SELECT sequence_number, record_hash
    INTO   v_prev_record
    FROM   public.audit_records
    WHERE  tenant_id = NEW.tenant_id
      AND  COALESCE(target_patient_id, 'PLATFORM') = COALESCE(NEW.target_patient_id, 'PLATFORM')
    ORDER BY sequence_number DESC
    LIMIT  1
    FOR    UPDATE;  -- serialise concurrent INSERTs within the same partition

    IF v_prev_record IS NULL THEN
        -- First record in this partition: use genesis seed per AUDIT_EVENTS v5.2.
        -- Genesis seed includes tenant_id so two tenants' first records in the
        -- same patient slot get distinct genesis hashes.
        NEW.prev_hash       := digest('GENESIS:' || v_partition_key, 'sha256');
        NEW.sequence_number := 1;
    ELSE
        NEW.prev_hash       := v_prev_record.record_hash;
        NEW.sequence_number := v_prev_record.sequence_number + 1;
    END IF;

    -- Compute record_hash via the shared canonicalization function so the
    -- chain walker (tests/helpers/audit-assertions.ts) can recompute the
    -- exact same value via SQL and verify per-row integrity.
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
SET search_path = pg_catalog, public
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
