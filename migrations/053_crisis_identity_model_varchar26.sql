-- =============================================================================
-- File:    migrations/053_crisis_identity_model_varchar26.sql
-- Purpose: SI-025 Option A implementation — re-type crisis slice identity
--          model from UUID to canonical VARCHAR(26) account_id (ULID).
--
-- Ratification: Evans chat-message "ratify" 2026-06-01, Promotion Ledger P-045.
--
-- Problem: `crisis_event.patient_id` + `crisis_event_lifecycle_transition
--          .actor_principal_id` were typed UUID (migration 033), and the
--          patient self-scoping view (034) + SECURITY DEFINER wrappers (036/037)
--          cast `current_actor_account_id()::UUID`. The platform-canonical
--          patient/actor identity is `accounts.account_id VARCHAR(26)` (ULID);
--          a real ULID token raises `invalid_text_representation` on the
--          ::UUID cast and the patient-summary endpoint can never return the
--          patient's own row, and the wrappers cannot bind a real actor.
--          CI was green only because every crisis test fixture used UUID-shaped
--          account_id literals. (SI-025, filed 2026-05-31.)
--
-- Solution (Option A):
--   1. Rename `crisis_event.patient_id UUID` →
--      `crisis_event.patient_account_id VARCHAR(26)` with FK to
--      `accounts(tenant_id, account_id)` — matching the canonical pattern
--      established by `medication_requests.patient_account_id VARCHAR(26)`
--      (migration 025) and `forms_submission.patient_id → accounts.account_id`
--      (migration 012).
--   2. Retype `crisis_event_lifecycle_transition.actor_principal_id UUID` →
--      `VARCHAR(26)` (TEXT-typed; no explicit FK to accounts because system-
--      triggered transitions set this to NULL — see mig 033 §6 line 617
--      "null for system-triggered transitions (sweep escalations)").
--   3. Replace derived view 034 `crisis_event_patient_summary_v` to drop the
--      `::UUID` cast and compare TEXT-to-TEXT.
--   4. Replace view 034 `crisis_event_current_state_v` to reference the
--      renamed `patient_account_id` column.
--   5. Replace SECURITY DEFINER wrappers 036 + 037: change all
--      `v_actor_principal_id UUID` locals to `TEXT` and drop `::UUID` casts.
--
-- Greenfield safety: this system has no production patient data. The column
-- type changes below use ALTER COLUMN ... TYPE with a USING clause that casts
-- any UUID-shaped test data to TEXT (lossless for 36-char UUID strings stored
-- as text; the column is being widened not narrowed).
--
-- Idempotency: all DROP / ALTER / CREATE OR REPLACE operations are safe to
-- re-run; the RENAME includes an existence check via a DO block.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- PRECONDITIONS: migrations 033–037 + 051 applied.
-- ---------------------------------------------------------------------------

-- =============================================================================
-- §1 — crisis_event: rename patient_id → patient_account_id, retype UUID → VARCHAR(26),
--      add FK to accounts, drop+recreate affected index.
-- =============================================================================

-- Drop the index that references the old column name.
DROP INDEX IF EXISTS idx_crisis_event_tenant_patient;

-- Rename the column (idempotent-safe: skip if already renamed).
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name   = 'crisis_event'
           AND column_name  = 'patient_id'
    ) THEN
        ALTER TABLE public.crisis_event
            RENAME COLUMN patient_id TO patient_account_id;
    END IF;
END;
$$;

-- Retype from UUID to VARCHAR(26).
-- USING clause: UUID::TEXT produces a 36-char dash-separated hex string;
-- for test rows already in the table this is lossless. Production rows will
-- have real VARCHAR(26) ULIDs once test fixtures are corrected (step covered
-- in the crisis handler test-fixture update). The constraint below enforces
-- the canonical 26-char Crockford base32 shape going forward.
ALTER TABLE public.crisis_event
    ALTER COLUMN patient_account_id TYPE VARCHAR(26)
    USING patient_account_id::TEXT;

-- Add FK to accounts(tenant_id, account_id) — matching the canonical pattern.
-- Constraint name follows the existing cross-slice convention.
ALTER TABLE public.crisis_event
    ADD CONSTRAINT crisis_event_patient_account_fk
    FOREIGN KEY (tenant_id, patient_account_id)
    REFERENCES public.accounts (tenant_id, account_id)
    DEFERRABLE INITIALLY DEFERRED;

-- Recreate the index on the renamed column.
CREATE INDEX IF NOT EXISTS idx_crisis_event_tenant_patient_account
    ON public.crisis_event (tenant_id, patient_account_id, detected_at DESC);

COMMENT ON COLUMN public.crisis_event.patient_account_id IS
    'SI-025 P-045 Option A: canonical VARCHAR(26) ULID account_id '
    'matching accounts(tenant_id, account_id). FK enforced. Replaces '
    'the prior UUID-typed patient_id column (migration 033) whose ::UUID '
    'cast was incompatible with the platform-canonical ULID account_id.';

-- =============================================================================
-- §2 — crisis_event_lifecycle_transition: retype actor_principal_id UUID → VARCHAR(26).
--      No FK: NULL is valid for system-triggered transitions (sweep escalations)
--      per migration 033 §6 comment; ULID principal bound from SI-010.
-- =============================================================================

ALTER TABLE public.crisis_event_lifecycle_transition
    ALTER COLUMN actor_principal_id TYPE VARCHAR(26)
    USING actor_principal_id::TEXT;

COMMENT ON COLUMN public.crisis_event_lifecycle_transition.actor_principal_id IS
    'SI-025 P-045 Option A: canonical VARCHAR(26) ULID account_id of the '
    'actor bound from SI-010 trust anchor. NULL for system-triggered '
    'transitions (sweep escalations). Replaces the prior UUID type whose '
    '::UUID cast was incompatible with platform-canonical ULID account_ids.';

-- =============================================================================
-- §3 — Replace crisis_event_current_state_v (migration 034 §1) to reference
--      the renamed patient_account_id column. All grants + ownership preserved.
-- =============================================================================

CREATE OR REPLACE VIEW crisis_event_current_state_v
WITH (security_invoker = true, security_barrier = true)
AS
SELECT
    ce.id                                 AS crisis_event_id,
    ce.tenant_id,
    ce.patient_account_id,                -- renamed from patient_id (SI-025 P-045)
    ce.server_signal_id,
    ce.crisis_type,
    ce.severity,
    ce.regulatory_reporting_enabled,
    ce.detected_at,
    -- Latest transition state derived under tenant isolation
    latest.to_state                       AS current_state,
    latest.transition_at                  AS current_state_transition_at,
    latest.transition_reason              AS current_state_transition_reason,
    latest.actor_principal_id             AS current_state_actor_principal_id
FROM crisis_event ce
LEFT JOIN LATERAL (
    SELECT to_state, transition_at, transition_reason, actor_principal_id
      FROM crisis_event_lifecycle_transition lt
     WHERE lt.tenant_id = ce.tenant_id
       AND lt.crisis_event_id = ce.id
     ORDER BY lt.transition_at DESC, lt.id DESC
     LIMIT 1
) latest ON TRUE
WHERE ce.tenant_id = current_tenant_id();

ALTER VIEW crisis_event_current_state_v
    OWNER TO crisis_event_current_state_view_owner;

REVOKE ALL ON crisis_event_current_state_v FROM PUBLIC;
GRANT SELECT ON crisis_event_current_state_v TO crisis_event_staff_reader;

COMMENT ON VIEW crisis_event_current_state_v IS
    'P-040 §4.NEW4 staff tenant-wide view: each crisis_event with its latest '
    'lifecycle_transition state. security_invoker=true + security_barrier=true. '
    'SELECT granted ONLY to crisis_event_staff_reader per R1 HIGH-2 reader-split. '
    'Patient roles MUST NOT have SELECT on this view. '
    'SI-025 P-045: patient_id column renamed to patient_account_id.';

-- =============================================================================
-- §4 — Replace crisis_event_patient_summary_v (migration 034 §2) to:
--      a) reference patient_account_id (renamed column),
--      b) drop the ::UUID cast from the self-scoping predicate (the root
--         cause of the SI-025 cast-failure; compare TEXT = TEXT directly).
-- =============================================================================

CREATE OR REPLACE VIEW crisis_event_patient_summary_v
WITH (security_invoker = true, security_barrier = true)
AS
SELECT
    ce.id                                 AS crisis_event_id,
    ce.tenant_id,
    ce.patient_account_id,                -- renamed from patient_id (SI-025 P-045)
    ce.crisis_type,
    ce.severity,
    ce.detected_at,
    -- Latest transition state
    latest.to_state                       AS current_state,
    latest.transition_at                  AS current_state_transition_at
    -- Intentionally OMITTED from patient view (data-minimization vs staff view):
    -- server_signal_id, regulatory_reporting_enabled, transition_reason,
    -- actor_principal_id, intake_payload_* KMS envelope columns.
FROM crisis_event ce
LEFT JOIN LATERAL (
    SELECT to_state, transition_at
      FROM crisis_event_lifecycle_transition lt
     WHERE lt.tenant_id = ce.tenant_id
       AND lt.crisis_event_id = ce.id
     ORDER BY lt.transition_at DESC, lt.id DESC
     LIMIT 1
) latest ON TRUE
WHERE ce.tenant_id = current_tenant_id()
  -- Self-scoping: patient_account_id MUST match the calling actor's account_id.
  -- SI-025 P-045 closure: compare VARCHAR(26) TEXT to TEXT directly.
  -- No ::UUID cast — current_actor_account_id() returns TEXT (the VARCHAR(26)
  -- ULID from accounts.account_id); the prior ::UUID cast raised
  -- invalid_text_representation for any real ULID token.
  AND ce.patient_account_id = current_actor_account_id();

ALTER VIEW crisis_event_patient_summary_v
    OWNER TO crisis_event_patient_summary_view_owner;

REVOKE ALL ON crisis_event_patient_summary_v FROM PUBLIC;
GRANT SELECT ON crisis_event_patient_summary_v TO crisis_event_patient_reader;

COMMENT ON VIEW crisis_event_patient_summary_v IS
    'P-040 §4.NEW5 patient self-scoped view: data-minimized crisis_event rows '
    'visible only to the calling patient actor. security_invoker=true + '
    'security_barrier=true. SELECT granted ONLY to crisis_event_patient_reader. '
    'SI-025 P-045: patient_id → patient_account_id; ::UUID cast removed from '
    'self-scoping predicate — compare VARCHAR(26) TEXT to TEXT directly.';

-- =============================================================================
-- §5 — Replace record_crisis_initiation() wrapper (migration 036) to:
--      a) change v_actor_principal_id from UUID to TEXT,
--      b) drop the ::UUID cast.
--      All other logic, grants, and comments preserved verbatim.
-- =============================================================================

-- NOTE: This replaces the function body only (CREATE OR REPLACE). The SECURITY
-- DEFINER, search_path, GRANT EXECUTE, and ownership lines from migration 036
-- remain in effect (PostgreSQL preserves them across CREATE OR REPLACE).

CREATE OR REPLACE FUNCTION record_crisis_initiation(
    p_tenant_id                     TEXT,
    p_patient_account_id            TEXT,   -- SI-025: renamed from p_patient_id; VARCHAR(26) ULID
    p_server_signal_id              UUID,
    p_crisis_type                   TEXT,
    p_severity                      TEXT,
    p_regulatory_reporting_enabled  BOOLEAN,
    p_transition_payload            JSONB DEFAULT NULL,
    -- KMS envelope params (all NULL at v0 wire surface; Sprint 4 lands KMS encryption)
    p_intake_payload_encrypted      BYTEA DEFAULT NULL,
    p_intake_payload_kms_key_alias  TEXT  DEFAULT NULL,
    p_intake_payload_kms_region     TEXT  DEFAULT NULL,
    p_intake_payload_iv             BYTEA DEFAULT NULL,
    p_intake_payload_auth_tag       BYTEA DEFAULT NULL,
    p_intake_payload_schema_version TEXT  DEFAULT NULL,
    p_intake_payload_encrypted_at   TIMESTAMPTZ DEFAULT NULL,
    p_idempotency_key               TEXT  DEFAULT NULL
) RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    v_actor_account_id_text  TEXT;
    v_actor_principal_id     TEXT;    -- SI-025 P-045: was UUID; now TEXT (VARCHAR(26) ULID)
    v_actor_tenant_id        TEXT;
    v_crisis_event_id        UUID;
    v_existing_event_id      UUID;
BEGIN
    -- LAYER B — bind actor identity from SI-010.
    v_actor_account_id_text := current_actor_account_id();
    IF v_actor_account_id_text IS NULL THEN
        RAISE EXCEPTION 'record_crisis_initiation: no actor account bound'
            USING ERRCODE = '42501';
    END IF;
    -- SI-025 P-045: assign TEXT directly; no ::UUID cast.
    -- current_actor_account_id() returns the VARCHAR(26) ULID from
    -- accounts.account_id; casting to UUID raised invalid_text_representation
    -- for any real token and was the root-cause failure of SI-025.
    v_actor_principal_id := v_actor_account_id_text;

    -- LAYER C — tenant scope match.
    v_actor_tenant_id := current_actor_account_tenant_id();
    IF v_actor_tenant_id IS NULL THEN
        RAISE EXCEPTION 'record_crisis_initiation: no actor tenant bound'
            USING ERRCODE = '42501';
    END IF;
    IF v_actor_tenant_id IS DISTINCT FROM p_tenant_id THEN
        RAISE EXCEPTION 'record_crisis_initiation: tenant scope mismatch — actor tenant % vs p_tenant_id %',
            v_actor_tenant_id, p_tenant_id
            USING ERRCODE = '42501';
    END IF;

    -- Idempotency: check for existing crisis_event with same (tenant_id, server_signal_id).
    SELECT id INTO v_existing_event_id
      FROM public.crisis_event
     WHERE tenant_id      = p_tenant_id
       AND server_signal_id = p_server_signal_id
     LIMIT 1;
    IF v_existing_event_id IS NOT NULL THEN
        RETURN v_existing_event_id;
    END IF;

    -- INSERT new crisis_event (patient_account_id per SI-025 P-045).
    INSERT INTO public.crisis_event (
        id,
        tenant_id,
        patient_account_id,              -- SI-025: renamed column
        server_signal_id,
        crisis_type,
        severity,
        regulatory_reporting_enabled,
        detected_at,
        intake_payload_encrypted,
        intake_payload_kms_key_alias,
        intake_payload_kms_region,
        intake_payload_iv,
        intake_payload_auth_tag,
        intake_payload_schema_version,
        intake_payload_encrypted_at
    ) VALUES (
        gen_random_uuid(),
        p_tenant_id,
        p_patient_account_id,
        p_server_signal_id,
        p_crisis_type,
        p_severity,
        p_regulatory_reporting_enabled,
        NOW(),
        p_intake_payload_encrypted,
        p_intake_payload_kms_key_alias,
        p_intake_payload_kms_region,
        p_intake_payload_iv,
        p_intake_payload_auth_tag,
        p_intake_payload_schema_version,
        p_intake_payload_encrypted_at
    )
    RETURNING id INTO v_crisis_event_id;

    -- INSERT initial lifecycle_transition (detected).
    PERFORM public.record_crisis_event_lifecycle_transition(
        p_tenant_id,
        v_crisis_event_id,
        'none',
        'detected',
        'initial_detection',
        v_actor_principal_id,   -- TEXT (VARCHAR(26) ULID) per SI-025 P-045
        p_transition_payload
    );

    RETURN v_crisis_event_id;
END;
$$;

COMMENT ON FUNCTION record_crisis_initiation IS
    'SECURITY DEFINER crisis-initiation wrapper (migration 036). '
    'SI-025 P-045: p_patient_id renamed to p_patient_account_id (VARCHAR(26) ULID); '
    'v_actor_principal_id changed from UUID to TEXT; ::UUID cast removed.';

-- =============================================================================
-- §6 — Replace the 3 mid-lifecycle wrappers (migration 037) to:
--      a) change v_actor_principal_id from UUID to TEXT,
--      b) drop ::UUID cast.
-- record_crisis_acknowledgement_claim / record_crisis_response /
-- record_crisis_resolution — each independently replicated.
-- =============================================================================

-- §6a — record_crisis_acknowledgement_claim()
CREATE OR REPLACE FUNCTION record_crisis_acknowledgement_claim(
    p_tenant_id           TEXT,
    p_crisis_event_id     UUID,
    p_transition_payload  JSONB DEFAULT NULL
) RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    v_actor_account_id_text  TEXT;
    v_actor_principal_id     TEXT;    -- SI-025 P-045: was UUID
    v_actor_tenant_id        TEXT;
    v_latest_to_state        TEXT;
    v_latest_actor           TEXT;    -- SI-025 P-045: was UUID (matches actor_principal_id column)
    v_transition_id          BIGINT;
BEGIN
    -- LAYER B — bind actor identity from SI-010.
    v_actor_account_id_text := current_actor_account_id();
    IF v_actor_account_id_text IS NULL THEN
        RAISE EXCEPTION 'record_crisis_acknowledgement_claim: no actor account bound'
            USING ERRCODE = '42501';
    END IF;
    -- SI-025 P-045: TEXT assignment; no ::UUID cast.
    v_actor_principal_id := v_actor_account_id_text;

    -- LAYER C — tenant scope match.
    v_actor_tenant_id := current_actor_account_tenant_id();
    IF v_actor_tenant_id IS NULL THEN
        RAISE EXCEPTION 'record_crisis_acknowledgement_claim: no actor tenant bound'
            USING ERRCODE = '42501';
    END IF;
    IF v_actor_tenant_id IS DISTINCT FROM p_tenant_id THEN
        RAISE EXCEPTION 'record_crisis_acknowledgement_claim: tenant scope mismatch — actor tenant % vs wrapper p_tenant_id %',
            v_actor_tenant_id, p_tenant_id
            USING ERRCODE = '42501';
    END IF;

    -- SELECT FOR UPDATE on parent crisis_event row.
    PERFORM 1 FROM public.crisis_event
     WHERE tenant_id = p_tenant_id AND id = p_crisis_event_id
       FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'record_crisis_acknowledgement_claim: crisis_event % not found for tenant %', p_crisis_event_id, p_tenant_id
            USING ERRCODE = '02000';
    END IF;

    -- Read latest lifecycle state under lock.
    SELECT to_state, actor_principal_id
      INTO v_latest_to_state, v_latest_actor
      FROM public.crisis_event_lifecycle_transition
     WHERE tenant_id = p_tenant_id AND crisis_event_id = p_crisis_event_id
     ORDER BY transition_at DESC, id DESC
     LIMIT 1;

    -- Idempotent replay: same-actor already acknowledged.
    IF v_latest_to_state = 'acknowledged' THEN
        IF v_latest_actor = v_actor_principal_id THEN
            SELECT id INTO v_transition_id
              FROM public.crisis_event_lifecycle_transition
             WHERE tenant_id = p_tenant_id AND crisis_event_id = p_crisis_event_id
               AND to_state = 'acknowledged'
             ORDER BY transition_at DESC, id DESC
             LIMIT 1;
            RETURN v_transition_id;
        ELSE
            RAISE EXCEPTION 'record_crisis_acknowledgement_claim: crisis_event % already acknowledged by another actor %; concurrent-claim race lost',
                p_crisis_event_id, v_latest_actor
                USING ERRCODE = '40001';
        END IF;
    END IF;

    -- Validate from-state.
    IF v_latest_to_state IS NULL OR v_latest_to_state NOT IN ('detected', 'escalated') THEN
        RAISE EXCEPTION 'record_crisis_acknowledgement_claim: cannot acknowledge crisis_event % from state %; allowed from-states are detected, escalated',
            p_crisis_event_id, COALESCE(v_latest_to_state, '<NULL/none>')
            USING ERRCODE = '40001';
    END IF;

    -- Emit the transition.
    v_transition_id := public.record_crisis_event_lifecycle_transition(
        p_tenant_id,
        p_crisis_event_id,
        v_latest_to_state,
        'acknowledged',
        'clinician_acknowledgement',
        v_actor_principal_id,   -- TEXT per SI-025 P-045
        p_transition_payload
    );

    RETURN v_transition_id;
END;
$$;

-- §6b — record_crisis_response()
CREATE OR REPLACE FUNCTION record_crisis_response(
    p_tenant_id           TEXT,
    p_crisis_event_id     UUID,
    p_transition_payload  JSONB DEFAULT NULL
) RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    v_actor_account_id_text  TEXT;
    v_actor_principal_id     TEXT;    -- SI-025 P-045: was UUID
    v_actor_tenant_id        TEXT;
    v_latest_to_state        TEXT;
    v_latest_actor           TEXT;    -- SI-025 P-045: was UUID
    v_transition_id          BIGINT;
BEGIN
    v_actor_account_id_text := current_actor_account_id();
    IF v_actor_account_id_text IS NULL THEN
        RAISE EXCEPTION 'record_crisis_response: no actor account bound'
            USING ERRCODE = '42501';
    END IF;
    v_actor_principal_id := v_actor_account_id_text;  -- TEXT; no ::UUID

    v_actor_tenant_id := current_actor_account_tenant_id();
    IF v_actor_tenant_id IS NULL THEN
        RAISE EXCEPTION 'record_crisis_response: no actor tenant bound'
            USING ERRCODE = '42501';
    END IF;
    IF v_actor_tenant_id IS DISTINCT FROM p_tenant_id THEN
        RAISE EXCEPTION 'record_crisis_response: tenant scope mismatch — actor tenant % vs p_tenant_id %',
            v_actor_tenant_id, p_tenant_id
            USING ERRCODE = '42501';
    END IF;

    PERFORM 1 FROM public.crisis_event
     WHERE tenant_id = p_tenant_id AND id = p_crisis_event_id
       FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'record_crisis_response: crisis_event % not found for tenant %', p_crisis_event_id, p_tenant_id
            USING ERRCODE = '02000';
    END IF;

    SELECT to_state, actor_principal_id
      INTO v_latest_to_state, v_latest_actor
      FROM public.crisis_event_lifecycle_transition
     WHERE tenant_id = p_tenant_id AND crisis_event_id = p_crisis_event_id
     ORDER BY transition_at DESC, id DESC
     LIMIT 1;

    IF v_latest_to_state = 'responded' THEN
        IF v_latest_actor = v_actor_principal_id THEN
            SELECT id INTO v_transition_id
              FROM public.crisis_event_lifecycle_transition
             WHERE tenant_id = p_tenant_id AND crisis_event_id = p_crisis_event_id
               AND to_state = 'responded'
             ORDER BY transition_at DESC, id DESC
             LIMIT 1;
            RETURN v_transition_id;
        ELSE
            RAISE EXCEPTION 'record_crisis_response: crisis_event % already responded by another actor %; concurrent race lost',
                p_crisis_event_id, v_latest_actor
                USING ERRCODE = '40001';
        END IF;
    END IF;

    IF v_latest_to_state IS NULL OR v_latest_to_state NOT IN ('acknowledged') THEN
        RAISE EXCEPTION 'record_crisis_response: cannot respond to crisis_event % from state %; allowed from-state is acknowledged',
            p_crisis_event_id, COALESCE(v_latest_to_state, '<NULL/none>')
            USING ERRCODE = '40001';
    END IF;

    v_transition_id := public.record_crisis_event_lifecycle_transition(
        p_tenant_id,
        p_crisis_event_id,
        v_latest_to_state,
        'responded',
        'clinician_response',
        v_actor_principal_id,   -- TEXT per SI-025 P-045
        p_transition_payload
    );

    RETURN v_transition_id;
END;
$$;

-- §6c — record_crisis_resolution()
CREATE OR REPLACE FUNCTION record_crisis_resolution(
    p_tenant_id           TEXT,
    p_crisis_event_id     UUID,
    p_transition_payload  JSONB DEFAULT NULL
) RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    v_actor_account_id_text  TEXT;
    v_actor_principal_id     TEXT;    -- SI-025 P-045: was UUID
    v_actor_tenant_id        TEXT;
    v_latest_to_state        TEXT;
    v_latest_actor           TEXT;    -- SI-025 P-045: was UUID
    v_transition_id          BIGINT;
BEGIN
    v_actor_account_id_text := current_actor_account_id();
    IF v_actor_account_id_text IS NULL THEN
        RAISE EXCEPTION 'record_crisis_resolution: no actor account bound'
            USING ERRCODE = '42501';
    END IF;
    v_actor_principal_id := v_actor_account_id_text;  -- TEXT; no ::UUID

    v_actor_tenant_id := current_actor_account_tenant_id();
    IF v_actor_tenant_id IS NULL THEN
        RAISE EXCEPTION 'record_crisis_resolution: no actor tenant bound'
            USING ERRCODE = '42501';
    END IF;
    IF v_actor_tenant_id IS DISTINCT FROM p_tenant_id THEN
        RAISE EXCEPTION 'record_crisis_resolution: tenant scope mismatch — actor tenant % vs p_tenant_id %',
            v_actor_tenant_id, p_tenant_id
            USING ERRCODE = '42501';
    END IF;

    PERFORM 1 FROM public.crisis_event
     WHERE tenant_id = p_tenant_id AND id = p_crisis_event_id
       FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'record_crisis_resolution: crisis_event % not found for tenant %', p_crisis_event_id, p_tenant_id
            USING ERRCODE = '02000';
    END IF;

    SELECT to_state, actor_principal_id
      INTO v_latest_to_state, v_latest_actor
      FROM public.crisis_event_lifecycle_transition
     WHERE tenant_id = p_tenant_id AND crisis_event_id = p_crisis_event_id
     ORDER BY transition_at DESC, id DESC
     LIMIT 1;

    IF v_latest_to_state = 'resolved' THEN
        IF v_latest_actor = v_actor_principal_id THEN
            SELECT id INTO v_transition_id
              FROM public.crisis_event_lifecycle_transition
             WHERE tenant_id = p_tenant_id AND crisis_event_id = p_crisis_event_id
               AND to_state = 'resolved'
             ORDER BY transition_at DESC, id DESC
             LIMIT 1;
            RETURN v_transition_id;
        ELSE
            RAISE EXCEPTION 'record_crisis_resolution: crisis_event % already resolved by another actor %; concurrent race lost',
                p_crisis_event_id, v_latest_actor
                USING ERRCODE = '40001';
        END IF;
    END IF;

    IF v_latest_to_state IS NULL OR v_latest_to_state NOT IN ('responded', 'escalated') THEN
        RAISE EXCEPTION 'record_crisis_resolution: cannot resolve crisis_event % from state %; allowed from-states are responded, escalated',
            p_crisis_event_id, COALESCE(v_latest_to_state, '<NULL/none>')
            USING ERRCODE = '40001';
    END IF;

    v_transition_id := public.record_crisis_event_lifecycle_transition(
        p_tenant_id,
        p_crisis_event_id,
        v_latest_to_state,
        'resolved',
        'clinician_resolution',
        v_actor_principal_id,   -- TEXT per SI-025 P-045
        p_transition_payload
    );

    RETURN v_transition_id;
END;
$$;

-- =============================================================================
-- §7 — Verification assertions (run at migration time; abort if any fail).
-- =============================================================================

DO $$
DECLARE
    v_patient_col_type   TEXT;
    v_actor_col_type     TEXT;
BEGIN
    -- Assert crisis_event.patient_account_id is VARCHAR(26).
    SELECT data_type || '(' || character_maximum_length::TEXT || ')'
      INTO v_patient_col_type
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name   = 'crisis_event'
       AND column_name  = 'patient_account_id';

    IF v_patient_col_type IS NULL THEN
        RAISE EXCEPTION 'MIGRATION 053 ASSERTION FAILED: crisis_event.patient_account_id column does not exist. Re-check §1 ALTER COLUMN.';
    END IF;
    IF v_patient_col_type NOT LIKE 'character varying%' THEN
        RAISE EXCEPTION 'MIGRATION 053 ASSERTION FAILED: crisis_event.patient_account_id type is %, expected character varying(26).', v_patient_col_type;
    END IF;

    -- Assert the old patient_id column is gone.
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name   = 'crisis_event'
           AND column_name  = 'patient_id'
    ) THEN
        RAISE EXCEPTION 'MIGRATION 053 ASSERTION FAILED: old crisis_event.patient_id column still exists after rename. Re-check §1 RENAME.';
    END IF;

    -- Assert crisis_event_lifecycle_transition.actor_principal_id is VARCHAR(26).
    SELECT data_type || '(' || COALESCE(character_maximum_length::TEXT, 'unlimited') || ')'
      INTO v_actor_col_type
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name   = 'crisis_event_lifecycle_transition'
       AND column_name  = 'actor_principal_id';

    IF v_actor_col_type IS NULL THEN
        RAISE EXCEPTION 'MIGRATION 053 ASSERTION FAILED: crisis_event_lifecycle_transition.actor_principal_id column does not exist.';
    END IF;
    IF v_actor_col_type NOT LIKE 'character varying%' THEN
        RAISE EXCEPTION 'MIGRATION 053 ASSERTION FAILED: crisis_event_lifecycle_transition.actor_principal_id type is %, expected character varying(26).', v_actor_col_type;
    END IF;

    RAISE NOTICE 'Migration 053 verification passed: patient_account_id=% actor_principal_id=%',
        v_patient_col_type, v_actor_col_type;
END;
$$;
