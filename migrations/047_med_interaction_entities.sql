-- =============================================================================
-- File:    migrations/047_med_interaction_entities.sql
-- Purpose: Create the 4 net-new Med-Interaction entities (SI-019 v2.0 RATIFIED
--          2026-05-21 P-033 + CDM v1.6 → v1.7 Amendment §4.NEW1-NEW4 RATIFIED
--          2026-05-21 P-034) with RLS + per-table append-only triggers +
--          unified monotonic-ordering trigger on the lifecycle log (3
--          invariants under one advisory lock) + composite tenant-scoped FKs.
--
--          PR 2 of the Med-Interaction Engine implementation series (continued
--          from migration 046 which created the 12 RBAC roles). Subsequent
--          migrations: SECURITY BARRIER view + optional MV + SECDEF access
--          function (PR 3) → raw lifecycle writer SECDEF + anti-bypass
--          grants (PR 4) → 6 reason-specific wrappers (PR 5) → Fastify
--          handler implementation (PR 6+).
--
--          PER RATIFIER OPTION 2 (carryforward from Crisis Response + Admin
--          Backend PRs):
--          - RLS predicate uses `current_tenant_id()` (code-repo pattern
--            from migration 003) — NOT spec's
--            `current_tenant_id_strict(entity_name)` from SI-024.1 v0.8.
--          - Per-table inline append-only trigger functions (audit_chain
--            pattern from migration 002 + Crisis Response migration 033 +
--            Admin Backend migration 040) — NOT spec's generic
--            `enforce_append_only()`.
--          - ULID PK type → VARCHAR(26) (code-repo PK type from migrations
--            006/012/024/etc.) — NOT spec's ULID custom type. ULID values
--            are 26-char Crockford-base32 strings; VARCHAR(26) enforces
--            the length constraint at the column layer.
--          - tenant_id_t domain → TEXT (code-repo convention).
--          - `patient_id` column kept as VARCHAR(26) NOT NULL but FK
--            constraint to `patients(id)` SKIPPED (no patients table in
--            code repo; logical reference only; TODO documented inline for
--            future migration when Identity slice's patient entity lands).
--            This matches Crisis Response migration 033's identical skip
--            pattern (see docs/crisis-response-implementation-plan.md).
--          - `override_by_clinician_account_id` FK → composite
--            `accounts(tenant_id, account_id)` per code-repo accounts table
--            from migration 012 (NOT spec's single-column `accounts(id)`).
--          - `triggered_by_resource_id` kept as VARCHAR(26) NOT NULL but
--            FK SKIPPED — the resource type depends on `triggered_by`
--            value (medication_request / refill / protocol_id / etc.);
--            polymorphic FK pattern not enforced at schema layer.
--          - `medications_involved` array kept as VARCHAR(26)[]; the spec's
--            ULID[] type behavior is equivalent.
--          - KMS envelope columns on interaction_signal_override preserved
--            VERBATIM per CDM §4.NEW3 (8-column flat envelope; mirrors
--            SI-005 + Crisis Response migration 033 §4 pattern).
--          - Functions OWNED BY postgres at v0.1 (NOT spec's cdm_owner;
--            owner-role grants land in PR 3-5 when wrappers/views attach).
--          - Per-table grants from spec §4.NEW1-NEW4 (GRANT INSERT/SELECT
--            to medication_interaction_engine_evaluator / signal_viewer /
--            override_recorder / wrapper_owner / etc.) are CARRIED FORWARD
--            verbatim, with the dotted spec name
--            `medication_interaction.override_recorder` realized as the
--            underscore form per migration 046 §2 recorded divergence.
--            Owner-role grants on the lifecycle_transition table (writer
--            owner INSERT; viewer/wrapper-owner SELECT) are also carried
--            forward.
--
-- Spec:    - SI-019 Medication Interaction & Validation Engine Slice PRD
--            v2.0 (RATIFIED 2026-05-21 P-033;
--            telecheckONE/Telecheck Master Bundle FINAL US REGION BASELINE/
--            Telecheck_Medication_Interaction_Engine_Slice_PRD_v2_0.md §2
--            Sub-decision 1 normative entity definitions + §5 state machine
--            + §OQ7 Option A append-only-only ratification)
--          - CDM v1.6 → v1.7 Amendment §4.NEW1 + §4.NEW2 + §4.NEW3 + §4.NEW4
--            (canonical executable DDL source; RATIFIED 2026-05-21 P-034;
--            telecheckONE/Telecheck Master Bundle FINAL US REGION BASELINE/
--            Telecheck_CDM_v1_6_to_v1_7_Amendment.md)
--          - I-002 (interaction engine runs BEFORE clinician commits
--            medication_request) — schema layer doesn't enforce the
--            ordering invariant; the wrappers + Pharmacy/Async Consult
--            commit-path gates enforce.
--          - I-023 (three-layer tenant isolation; tenant_id on every PHI
--            record)
--          - I-027 (audit append-only)
--          - I-035 (append-only invariant for ratification + audit-bound
--            state machines; interaction_signal +
--            interaction_signal_lifecycle_transition both qualify under
--            I-035 Option A append-only-only per OQ7 ratification)
--          - ADR-021 / SI-005 (per-tenant KMS envelope pattern for PHI
--            encryption-at-rest; 8-column flat envelope on
--            interaction_signal_override.override_rationale_*)
-- Summary: Creates 4 net-new tables with RLS + per-table append-only triggers
--          + monotonic-ordering trigger on lifecycle log + composite tenant-
--          scoped FKs + indexes + carried-forward GRANT INSERT/SELECT per
--          §4.NEW1-NEW4 spec. No SECDEF procedures, no views, no MV in this
--          migration — those land in PR 3-5.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- PRECONDITIONS:
--   001_tenants.sql                              applied (tenants table)
--   003_rls_helpers.sql                          applied (current_tenant_id())
--   012_accounts.sql                             applied (accounts +
--                                                  UNIQUE (tenant_id, account_id))
--   046_med_interaction_rbac_roles.sql           applied (12 admin RBAC roles)
-- ---------------------------------------------------------------------------

-- =============================================================================
-- §1 — interaction_engine_evaluation (CDM §4.NEW1)
--
-- One row per engine invocation. Strict append-only per I-035; row records
-- the engine evaluation context (medication/condition/lab snapshots,
-- knowledge base version, engine version, trigger source).
--
-- Option 2 adaptations from spec:
--   - id ULID → VARCHAR(26)
--   - tenant_id tenant_id_t → TEXT NOT NULL REFERENCES tenants(id)
--   - patient_id ULID NOT NULL REFERENCES patients(id) → VARCHAR(26) NOT NULL
--     (no FK; patients table doesn't exist in code repo)
--   - triggered_by_resource_id ULID → VARCHAR(26) (no FK; polymorphic by
--     triggered_by value)
--   - RLS predicate current_tenant_id_strict(...) → current_tenant_id()
--   - enforce_append_only() generic → per-table inline trigger
-- =============================================================================

CREATE TABLE interaction_engine_evaluation (
    id                          VARCHAR(26)  PRIMARY KEY,
    tenant_id                   TEXT         NOT NULL REFERENCES tenants(id),
    -- patient_id FK SKIPPED per Option 2 (no patients table in code repo;
    -- logical reference only; TODO when Identity slice's patient entity lands).
    patient_id                  VARCHAR(26)  NOT NULL,
    triggered_by                TEXT         NOT NULL CHECK (triggered_by IN (
        'prescribing', 'refill', 'protocol_gate', 'manual_recheck',
        'lab_update', 'adverse_event_investigation'
    )),
    -- triggered_by_resource_id FK SKIPPED per Option 2 (polymorphic by
    -- triggered_by value — medication_request_id / refill_id / protocol_id /
    -- etc.; schema-layer enforcement deferred to wrapper layer).
    triggered_by_resource_id    VARCHAR(26)  NOT NULL,
    evaluated_at                TIMESTAMPTZ  NOT NULL DEFAULT now(),
    evaluation_window_ms        INTEGER      NOT NULL CHECK (evaluation_window_ms >= 0),
    engine_version              TEXT         NOT NULL,    -- semver
    knowledge_base_version      TEXT         NOT NULL,    -- semver
    medication_set_snapshot     JSONB        NOT NULL,
    condition_set_snapshot      JSONB        NOT NULL,
    lab_set_snapshot            JSONB        NOT NULL,    -- includes lab_freshness_status_at_evaluation per signal
    -- Composite UNIQUE for tenant-coherent FKs from child tables (signal,
    -- override, lifecycle_transition all reference (tenant_id, evaluation_id)
    -- or transitively via signal_id).
    CONSTRAINT interaction_engine_evaluation_tenant_id_unique
        UNIQUE (tenant_id, id)
);

CREATE INDEX interaction_engine_evaluation_patient_evaluated_at
    ON interaction_engine_evaluation (tenant_id, patient_id, evaluated_at DESC);

ALTER TABLE interaction_engine_evaluation ENABLE ROW LEVEL SECURITY;
ALTER TABLE interaction_engine_evaluation FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON interaction_engine_evaluation
    USING     (tenant_id = current_tenant_id())
    WITH CHECK (tenant_id = current_tenant_id());

-- Strict append-only per I-035. Per-table inline trigger (Option 2; matches
-- Crisis Response migration 033 + Admin Backend migration 040 pattern).
CREATE OR REPLACE FUNCTION interaction_engine_evaluation_block_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
    RAISE EXCEPTION
        'interaction_engine_evaluation is append-only per I-035 (audit-bound). '
        'UPDATE and DELETE are permanently prohibited.';
END;
$$;

CREATE TRIGGER interaction_engine_evaluation_block_update
    BEFORE UPDATE ON interaction_engine_evaluation
    FOR EACH ROW
    EXECUTE FUNCTION interaction_engine_evaluation_block_mutation();

CREATE TRIGGER interaction_engine_evaluation_block_delete
    BEFORE DELETE ON interaction_engine_evaluation
    FOR EACH ROW
    EXECUTE FUNCTION interaction_engine_evaluation_block_mutation();

-- Per CDM §4.NEW1 GRANT block (Option 2: dotted role names normalized to
-- underscore form per migration 046 §2 recorded divergence).
REVOKE INSERT ON interaction_engine_evaluation FROM PUBLIC;
GRANT INSERT ON interaction_engine_evaluation
    TO medication_interaction_engine_evaluator;
GRANT SELECT ON interaction_engine_evaluation
    TO medication_interaction_engine_evaluator,
       medication_interaction_signal_viewer;

-- =============================================================================
-- §2 — interaction_signal (CDM §4.NEW2)
--
-- One row per signal produced by an evaluation. STRICT append-only per
-- I-035 — NO state column; current lifecycle state is DERIVED from
-- interaction_signal_lifecycle_transition rows (per SI-019 OQ7 Option A
-- ratification 2026-05-20).
-- =============================================================================

CREATE TABLE interaction_signal (
    id                      VARCHAR(26)  PRIMARY KEY,
    tenant_id               TEXT         NOT NULL REFERENCES tenants(id),
    evaluation_id           VARCHAR(26)  NOT NULL,
    check_class             TEXT         NOT NULL CHECK (check_class IN (
        'drug_drug', 'drug_condition', 'drug_lab',
        'pharmacogenomic', 'special_clinical_flag'
    )),
    severity                TEXT         NOT NULL CHECK (severity IN (
        'critical', 'major', 'moderate', 'minor'
    )),
    recommended_action      TEXT         NOT NULL CHECK (recommended_action IN (
        'block', 'warn', 'monitor'
    )),
    medications_involved    VARCHAR(26)[] NOT NULL,
    evidence_sources        JSONB        NOT NULL,    -- knowledge base citations
    signal_payload          JSONB        NOT NULL,    -- structured signal per SI-019 v1.0 §5.1
    -- Composite tenant-scoped FK per I-023 layer 2 (canonical pattern).
    CONSTRAINT interaction_signal_evaluation_tenant_fk
        FOREIGN KEY (tenant_id, evaluation_id)
        REFERENCES interaction_engine_evaluation (tenant_id, id),
    -- Composite UNIQUE for tenant-coherent FKs from child tables.
    CONSTRAINT interaction_signal_tenant_id_unique
        UNIQUE (tenant_id, id)
);

CREATE INDEX interaction_signal_tenant_evaluation
    ON interaction_signal (tenant_id, evaluation_id);
CREATE INDEX interaction_signal_severity_check_class
    ON interaction_signal (tenant_id, severity, check_class);

ALTER TABLE interaction_signal ENABLE ROW LEVEL SECURITY;
ALTER TABLE interaction_signal FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON interaction_signal
    USING     (tenant_id = current_tenant_id())
    WITH CHECK (tenant_id = current_tenant_id());

CREATE OR REPLACE FUNCTION interaction_signal_block_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
    RAISE EXCEPTION
        'interaction_signal is append-only per I-035 (audit-bound; current state '
        'DERIVED from interaction_signal_lifecycle_transition per Option A '
        'ratified at SI-019 OQ7). UPDATE and DELETE are permanently prohibited.';
END;
$$;

CREATE TRIGGER interaction_signal_block_update
    BEFORE UPDATE ON interaction_signal
    FOR EACH ROW
    EXECUTE FUNCTION interaction_signal_block_mutation();

CREATE TRIGGER interaction_signal_block_delete
    BEFORE DELETE ON interaction_signal
    FOR EACH ROW
    EXECUTE FUNCTION interaction_signal_block_mutation();

REVOKE INSERT ON interaction_signal FROM PUBLIC;
GRANT INSERT ON interaction_signal
    TO medication_interaction_engine_evaluator;
GRANT SELECT ON interaction_signal
    TO medication_interaction_engine_evaluator,
       medication_interaction_signal_viewer,
       medication_interaction_override_recorder;

-- =============================================================================
-- §3 — interaction_signal_override (CDM §4.NEW3)
--
-- One row per clinician override of a signal's enforcement action. STRICT
-- append-only per I-035. KMS-encrypted rationale per same envelope pattern
-- as SI-005's consult clinician decision rationale (8-column flat envelope).
--
-- Option 2 adaptation: override_by_clinician_account_id FK realized as
-- composite (tenant_id, account_id) → accounts(tenant_id, account_id) per
-- code-repo accounts table convention.
-- =============================================================================

CREATE TABLE interaction_signal_override (
    id                                          VARCHAR(26)  PRIMARY KEY,
    tenant_id                                   TEXT         NOT NULL REFERENCES tenants(id),
    signal_id                                   VARCHAR(26)  NOT NULL,
    override_by_clinician_account_id            VARCHAR(26)  NOT NULL,
    override_at                                 TIMESTAMPTZ  NOT NULL DEFAULT now(),
    -- 8-column flat KMS envelope (mirrors SI-005 record_consult_clinician_decision
    -- + Crisis Response migration 033 §4 crisis_event.intake_payload pattern).
    override_rationale_kms_envelope_ciphertext  BYTEA        NOT NULL,
    override_rationale_kms_envelope_dek_id      VARCHAR(26)  NOT NULL,
    override_rationale_kms_envelope_iv          BYTEA        NOT NULL,
    override_rationale_kms_envelope_tag         BYTEA        NOT NULL,
    override_rationale_kms_envelope_alg         TEXT         NOT NULL,
    override_rationale_kms_envelope_alg_version TEXT         NOT NULL,
    override_rationale_kms_envelope_aad         BYTEA        NOT NULL,
    override_rationale_kms_envelope_encrypted_at TIMESTAMPTZ NOT NULL,
    -- Composite tenant-scoped FK to interaction_signal.
    CONSTRAINT interaction_signal_override_signal_tenant_fk
        FOREIGN KEY (tenant_id, signal_id)
        REFERENCES interaction_signal (tenant_id, id),
    -- Composite tenant-scoped FK to accounts (Option 2 adaptation).
    CONSTRAINT interaction_signal_override_clinician_account_tenant_fk
        FOREIGN KEY (tenant_id, override_by_clinician_account_id)
        REFERENCES accounts (tenant_id, account_id),
    -- Composite UNIQUE for tenant-coherent FKs from child entities (future).
    CONSTRAINT interaction_signal_override_tenant_id_unique
        UNIQUE (tenant_id, id)
);

CREATE INDEX interaction_signal_override_tenant_signal
    ON interaction_signal_override (tenant_id, signal_id);
CREATE INDEX interaction_signal_override_clinician_recent
    ON interaction_signal_override (tenant_id, override_by_clinician_account_id, override_at DESC);

ALTER TABLE interaction_signal_override ENABLE ROW LEVEL SECURITY;
ALTER TABLE interaction_signal_override FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON interaction_signal_override
    USING     (tenant_id = current_tenant_id())
    WITH CHECK (tenant_id = current_tenant_id());

CREATE OR REPLACE FUNCTION interaction_signal_override_block_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
    RAISE EXCEPTION
        'interaction_signal_override is append-only per I-035 (audit-bound; '
        'override history is the canonical record of clinician decisions and '
        'cannot be retroactively edited). UPDATE and DELETE are permanently prohibited.';
END;
$$;

CREATE TRIGGER interaction_signal_override_block_update
    BEFORE UPDATE ON interaction_signal_override
    FOR EACH ROW
    EXECUTE FUNCTION interaction_signal_override_block_mutation();

CREATE TRIGGER interaction_signal_override_block_delete
    BEFORE DELETE ON interaction_signal_override
    FOR EACH ROW
    EXECUTE FUNCTION interaction_signal_override_block_mutation();

-- Per CDM §4.NEW3 GRANT block (Option 2: dotted role name normalized;
-- wrapper-owner name prefixed per migration 046 §2 recorded divergence).
REVOKE INSERT ON interaction_signal_override FROM PUBLIC;
GRANT INSERT ON interaction_signal_override
    TO interaction_signal_override_wrapper_owner;
GRANT SELECT ON interaction_signal_override
    TO medication_interaction_signal_viewer,
       interaction_signal_override_wrapper_owner;

-- =============================================================================
-- §4 — interaction_signal_lifecycle_transition (CDM §4.NEW4; Option A
--      append-only-only persistence per I-035; SI-019 OQ7 ratification)
--
-- One row per lifecycle state transition. Replaces the UPDATE-on-signal-row
-- pattern that Codex R1 STOP rejected at SI-019; ratified at OQ7 Option A
-- 2026-05-20.
--
-- CHECK constraint enumerates the 6 allowed
-- (transition_reason, from_state, to_state) triples per SI-019 Sub-decision
-- 5 normative state-machine table. UNIQUE (tenant_id, signal_id,
-- transition_at, id) prevents duplicate-INSERT races; advisory-lock pattern
-- at write time per SI-019 Sub-decision 8.5 (lands in PR 4 raw writer).
--
-- Per-Option-2: actor_id realized as VARCHAR(26) without FK (polymorphic
-- by actor_role — clinician/system/engine_evaluator/scheduler; the
-- clinician case maps to accounts but system/scheduler don't).
-- =============================================================================

CREATE TABLE interaction_signal_lifecycle_transition (
    id                          VARCHAR(26)  PRIMARY KEY,
    tenant_id                   TEXT         NOT NULL REFERENCES tenants(id),
    signal_id                   VARCHAR(26)  NOT NULL,
    from_state                  TEXT         NOT NULL CHECK (from_state IN (
        'none',          -- sentinel; ONLY used by initial emission transition
        'emitted', 'active',
        'overridden', 'superseded', 'resolved', 'expired'
    )),
    to_state                    TEXT         NOT NULL CHECK (to_state IN (
        'emitted', 'active',
        'overridden', 'superseded', 'resolved', 'expired'
        -- 'none' is NEVER a valid to_state (no transition ends in pre-existence)
    )),
    transition_reason           TEXT         NOT NULL CHECK (transition_reason IN (
        'emission', 'activation', 'override',
        'superseded_by_evaluation', 'resolution_event', 'time_expiry'
    )),
    transition_at               TIMESTAMPTZ  NOT NULL DEFAULT now(),
    transition_by_actor_id      VARCHAR(26)  NULL,    -- NULL for system-driven transitions
    transition_by_actor_role    TEXT         NOT NULL CHECK (transition_by_actor_role IN (
        'clinician', 'system', 'engine_evaluator', 'scheduler'
    )),
    metadata                    JSONB        NOT NULL,    -- override_id / superseded_by_evaluation_id / discontinuation_event_id / time_window_basis

    -- Composite tenant-scoped FK per I-023 layer 2 (canonical pattern).
    CONSTRAINT interaction_signal_lifecycle_transition_signal_tenant_fk
        FOREIGN KEY (tenant_id, signal_id)
        REFERENCES interaction_signal (tenant_id, id),

    -- CHECK enforces ONLY the allowed 6 (transition_reason, from_state, to_state)
    -- triples per SI-019 Sub-decision 5 normative state-machine table.
    CONSTRAINT interaction_signal_lifecycle_transition_valid_triple CHECK (
        (transition_reason = 'emission'                 AND from_state = 'none'    AND to_state = 'emitted')
     OR (transition_reason = 'activation'               AND from_state = 'emitted' AND to_state = 'active')
     OR (transition_reason = 'override'                 AND from_state = 'active'  AND to_state = 'overridden')
     OR (transition_reason = 'superseded_by_evaluation' AND from_state = 'active'  AND to_state = 'superseded')
     OR (transition_reason = 'resolution_event'         AND from_state = 'active'  AND to_state = 'resolved')
     OR (transition_reason = 'time_expiry'              AND from_state = 'active'  AND to_state = 'expired')
    ),

    -- UNIQUE prevents duplicate INSERT races; advisory-lock pattern at write
    -- time per SI-019 Sub-decision 8.5 (lands in PR 4 raw writer).
    CONSTRAINT interaction_signal_lifecycle_transition_uniq
        UNIQUE (tenant_id, signal_id, transition_at, id)
);

CREATE INDEX interaction_signal_lifecycle_transition_signal_latest
    ON interaction_signal_lifecycle_transition (tenant_id, signal_id, transition_at DESC, id DESC);

ALTER TABLE interaction_signal_lifecycle_transition ENABLE ROW LEVEL SECURITY;
ALTER TABLE interaction_signal_lifecycle_transition FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON interaction_signal_lifecycle_transition
    USING     (tenant_id = current_tenant_id())
    WITH CHECK (tenant_id = current_tenant_id());

CREATE OR REPLACE FUNCTION interaction_signal_lifecycle_transition_block_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
    RAISE EXCEPTION
        'interaction_signal_lifecycle_transition is append-only per I-035 '
        '(audit-bound state machine; Option A append-only-only per OQ7 ratification). '
        'UPDATE and DELETE are permanently prohibited. State changes recorded as new '
        'rows; current state DERIVED from latest row per SI-019 Sub-decision 5.';
END;
$$;

CREATE TRIGGER interaction_signal_lifecycle_transition_block_update
    BEFORE UPDATE ON interaction_signal_lifecycle_transition
    FOR EACH ROW
    EXECUTE FUNCTION interaction_signal_lifecycle_transition_block_mutation();

CREATE TRIGGER interaction_signal_lifecycle_transition_block_delete
    BEFORE DELETE ON interaction_signal_lifecycle_transition
    FOR EACH ROW
    EXECUTE FUNCTION interaction_signal_lifecycle_transition_block_mutation();

-- ---------------------------------------------------------------------------
-- Monotonic-ordering invariant (per Crisis Response migration 033 §6 + Admin
-- Backend migration 040 §3 pattern adapted to Option 2):
-- BEFORE INSERT trigger enforces NEW.transition_at >= MAX(prior.transition_at)
-- per (tenant_id, signal_id) to prevent backdated rows from corrupting
-- current-state derivation. Future-dating tolerated up to 5s clock-skew.
-- Per-(tenant_id, signal_id) advisory transaction lock serializes concurrent
-- inserts so MAX(prior.transition_at) reads see only committed-before-this-tx
-- rows.
--
-- The 6-triple valid-transition CHECK at the table layer enforces the
-- state-machine grammar (which (from_state, to_state, transition_reason)
-- triples are allowed); this trigger enforces the temporal grammar (no
-- backdating; no impossible-future timestamps). Together they pin the
-- lifecycle log to a coherent monotonic state machine.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION interaction_signal_lifecycle_transition_enforce_monotonic_ordering()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER    -- R1 HIGH-1 closure: runs under function-owner privileges so the
                    -- MAX(prior.transition_at) read bypasses RLS visibility filtering.
                    -- Tenant scope enforced by R2 HIGH-1 guard below (early caller-
                    -- tenant-context validation) + R2 HIGH-1 generic-error-message
                    -- discipline (no MAX timestamp exposure in cross-tenant attempts).
                    -- Function OWNER pinned to postgres per R2 MED-1 (ALTER FUNCTION
                    -- below) so the RLS bypass actually fires regardless of who
                    -- applies the migration.
SET search_path = pg_catalog, public
AS $$
DECLARE
    v_max_prior_transition_at TIMESTAMPTZ;
    v_max_clock_skew CONSTANT INTERVAL := INTERVAL '5 seconds';
    v_lock_key BIGINT;
    v_caller_tenant_id        TEXT;
BEGIN
    -- =====================================================================
    -- R2 HIGH-1 closure 2026-05-23 (Codex R2): early caller-tenant guard.
    -- PostgreSQL fires BEFORE INSERT triggers BEFORE evaluating WITH CHECK
    -- clauses, so the prior R1-closure code could leak cross-tenant timing
    -- information via the backdated-exception message: a caller with INSERT
    -- privilege could submit NEW.tenant_id of another tenant + a stale
    -- transition_at; the SECURITY DEFINER MAX read (correctly scoped to
    -- the attacker-supplied NEW.tenant_id via explicit WHERE predicate)
    -- would compute the other tenant's MAX and the backdated-exception
    -- error message would echo the MAX timestamp + the other tenant's
    -- signal_id — exposing existence + timing of rows the caller's
    -- current_tenant_id() does not authorize SELECT on.
    --
    -- Fix: validate caller-tenant context BEFORE any privileged read.
    -- Reject the INSERT early if NEW.tenant_id is not the caller's
    -- current_tenant_id() (i.e., the value the standard SI-010 trust-
    -- anchor wrapper layer would have set). This collapses cross-tenant
    -- INSERT attempts into a generic permission error with no MAX exposure.
    -- The error message intentionally omits the rejected NEW.tenant_id +
    -- the caller's bound tenant to prevent enumeration of valid tenants.
    -- =====================================================================
    v_caller_tenant_id := current_tenant_id();
    IF v_caller_tenant_id IS NULL
       OR v_caller_tenant_id IS DISTINCT FROM NEW.tenant_id THEN
        RAISE EXCEPTION
            'interaction_signal_lifecycle_transition: caller tenant context does '
            'not authorize this INSERT'
            USING ERRCODE = '42501';    -- insufficient_privilege
    END IF;

    -- =====================================================================
    -- R1 HIGH-1 closure 2026-05-23 (Codex R1): SECDEF-bound advisory-locked
    -- monotonic read. Reaches this point only if the caller-tenant guard
    -- above passed, so NEW.tenant_id is the caller's authorized tenant.
    -- =====================================================================

    -- Serialize concurrent inserts per (tenant_id, signal_id) via a
    -- transaction-scoped advisory lock so the MAX(prior.transition_at)
    -- read sees only committed-before-this-tx rows. Without this lock,
    -- two concurrent inserts for the same signal can both read the same
    -- prior MAX before either commits, letting a later-arriving
    -- transaction insert a backdated transition_at and pass the
    -- monotonic check anyway. Advisory lock is auto-released at tx
    -- commit/rollback.
    v_lock_key := ('x' || substr(md5(NEW.tenant_id::text || ':' || NEW.signal_id::text), 1, 16))::bit(64)::bigint;
    PERFORM pg_advisory_xact_lock(v_lock_key);

    -- Future-dating bounded by 5s clock-skew tolerance.
    IF NEW.transition_at > now() + v_max_clock_skew THEN
        RAISE EXCEPTION
            'interaction_signal_lifecycle_transition future-dated: '
            'NEW.transition_at (%) > now() + 5s clock-skew tolerance (%)',
            NEW.transition_at, now() + v_max_clock_skew
            USING ERRCODE = '22008';    -- datetime_field_overflow
    END IF;

    -- Backdating rejected (NEW.transition_at >= MAX(prior.transition_at)).
    -- Read happens UNDER the advisory lock so the MAX is the
    -- committed-predecessor value. WHERE tenant_id = NEW.tenant_id is
    -- the tenant-isolation predicate (RLS bypassed by SECURITY DEFINER).
    -- The R2 caller-tenant guard above guarantees NEW.tenant_id is the
    -- caller's authorized tenant, so this read does not cross tenant
    -- boundaries.
    SELECT MAX(transition_at) INTO v_max_prior_transition_at
      FROM public.interaction_signal_lifecycle_transition
     WHERE tenant_id = NEW.tenant_id AND signal_id = NEW.signal_id;

    IF v_max_prior_transition_at IS NOT NULL
       AND NEW.transition_at < v_max_prior_transition_at THEN
        -- R2 HIGH-1 closure: error message intentionally OMITS MAX timestamp
        -- + signal_id (defense-in-depth — caller-tenant guard above already
        -- prevents cross-tenant attempts, but this avoids in-tenant
        -- timing-side-channel surface for the legitimate-caller case
        -- where a buggy retry could otherwise read its own prior MAX
        -- through an error message). The exception still raises with a
        -- canonical SQLSTATE; the wrapper layer surfaces a tenant-blind
        -- error envelope to the HTTP client per I-025.
        RAISE EXCEPTION
            'interaction_signal_lifecycle_transition backdated: '
            'NEW.transition_at is before MAX(prior.transition_at) for the '
            'target signal in this tenant'
            USING ERRCODE = '22008';
    END IF;

    RETURN NEW;
END;
$$;

-- R2 MED-1 closure 2026-05-23 (Codex R2): pin function owner to postgres so
-- the SECURITY DEFINER RLS bypass actually fires regardless of which role
-- applies the migration. Without this ALTER, a migration-applier that is
-- itself non-BYPASSRLS would own the function and the SECURITY DEFINER
-- semantics would inherit its RLS subjection — recreating the R1 failure
-- mode where MAX returns NULL for tenants with existing rows when
-- current_tenant_id() is unset or mismatched.
ALTER FUNCTION interaction_signal_lifecycle_transition_enforce_monotonic_ordering()
    OWNER TO postgres;

CREATE TRIGGER interaction_signal_lifecycle_transition_monotonic_ordering
    BEFORE INSERT ON interaction_signal_lifecycle_transition
    FOR EACH ROW
    EXECUTE FUNCTION interaction_signal_lifecycle_transition_enforce_monotonic_ordering();

-- Per CDM §4.NEW4 GRANT block (Option 2: wrapper-owner + writer-owner role
-- names prefixed per migration 046 §2 recorded divergence).
REVOKE INSERT ON interaction_signal_lifecycle_transition FROM PUBLIC;
GRANT INSERT ON interaction_signal_lifecycle_transition
    TO interaction_signal_lifecycle_transition_writer_owner;
GRANT SELECT ON interaction_signal_lifecycle_transition
    TO medication_interaction_engine_evaluator,
       medication_interaction_signal_viewer,
       interaction_signal_override_wrapper_owner,
       interaction_signal_lifecycle_transition_writer_owner,
       interaction_signal_mv_refresh_owner;

-- =============================================================================
-- §5 — Verification: count of net-new interaction_* tables = 4
-- =============================================================================

DO $$
DECLARE
    v_created_count INTEGER;
    v_expected_count CONSTANT INTEGER := 4;
BEGIN
    SELECT COUNT(*) INTO v_created_count
      FROM pg_tables
     WHERE schemaname = 'public'
       AND tablename IN (
           'interaction_engine_evaluation',
           'interaction_signal',
           'interaction_signal_override',
           'interaction_signal_lifecycle_transition'
       );

    IF v_created_count <> v_expected_count THEN
        RAISE EXCEPTION
            'migration-047-table-count-mismatch: '
            'expected % interaction_* tables created, found %; '
            'P-034 §4.NEW1-NEW4 require all 4',
            v_expected_count, v_created_count;
    END IF;

    -- Verify all 4 tables have RLS ENABLE + FORCE
    SELECT COUNT(*) INTO v_created_count
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relname IN (
           'interaction_engine_evaluation',
           'interaction_signal',
           'interaction_signal_override',
           'interaction_signal_lifecycle_transition'
       )
       AND c.relrowsecurity = TRUE
       AND c.relforcerowsecurity = TRUE;

    IF v_created_count <> v_expected_count THEN
        RAISE EXCEPTION
            'migration-047-rls-enforcement-incomplete: '
            'expected all % tables to have ENABLE + FORCE RLS, found % compliant',
            v_expected_count, v_created_count;
    END IF;
END $$;

-- R2 MED-1 closure 2026-05-23 (Codex R2): verify monotonic-ordering trigger
-- function is SECURITY DEFINER + OWNED BY postgres + has locked search_path.
-- Without these, the R1 + R2 closure rationale collapses (the SECDEF RLS
-- bypass + cross-tenant guard depend on the function executing under a
-- BYPASSRLS owner with a non-injectable search_path).
DO $$
DECLARE
    v_target_oid          OID := to_regprocedure(
        'public.interaction_signal_lifecycle_transition_enforce_monotonic_ordering()'
    );
    v_owner_name          TEXT;
    v_security_definer    BOOLEAN;
    v_proconfig           TEXT[];
BEGIN
    IF v_target_oid IS NULL THEN
        RAISE EXCEPTION
            'migration-047-monotonic-trigger-function-missing: '
            'interaction_signal_lifecycle_transition_enforce_monotonic_ordering() '
            'not found by signature';
    END IF;

    SELECT r.rolname, p.prosecdef, p.proconfig
      INTO v_owner_name, v_security_definer, v_proconfig
      FROM pg_proc p
      JOIN pg_roles r ON r.oid = p.proowner
     WHERE p.oid = v_target_oid;

    IF v_owner_name <> 'postgres' THEN
        RAISE EXCEPTION
            'migration-047-monotonic-trigger-owner-mismatch: '
            'function owner is % but MUST be postgres for SECURITY DEFINER '
            'RLS-bypass semantics to fire correctly', v_owner_name;
    END IF;

    IF NOT v_security_definer THEN
        RAISE EXCEPTION
            'migration-047-monotonic-trigger-security-definer-missing: '
            'function MUST be SECURITY DEFINER per R1 HIGH-1 closure';
    END IF;

    IF v_proconfig IS NULL
       OR NOT (v_proconfig @> ARRAY['search_path=pg_catalog, public']) THEN
        RAISE EXCEPTION
            'migration-047-monotonic-trigger-search-path-not-locked: '
            'function MUST have proconfig containing '
            '"search_path=pg_catalog, public"; found %', v_proconfig;
    END IF;
END $$;
