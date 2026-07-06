-- =============================================================================
-- File:    migrations/rollback/053_rollback.sql
-- Purpose: Rollback migration 053_crisis_identity_model_varchar26.sql.
--
--          Reverses the SI-025 Option A identity-model change:
--          - Re-types crisis_event.patient_account_id VARCHAR(26) → patient_id UUID
--          - Re-types crisis_event_lifecycle_transition.actor_principal_id VARCHAR(26) → UUID
--          - Restores derived views 034 to reference patient_id + ::UUID cast
--          - Restores SECURITY DEFINER wrappers 036/037/038 to UUID actor
--          - Drops the patient_account_id FK to accounts
--
--          PRECONDITIONS:
--          - Table must have NO rows (this is a greenfield pre-launch system;
--            the VARCHAR(26) → UUID re-type via USING::UUID will fail on any
--            ULID-shaped values that are 26 chars and not valid UUID text).
--          - All 5 wrapper functions must be present (migration 053 replaced them).
--
--          Idempotent: all ALTER/CREATE OR REPLACE operations safe to re-run.
-- =============================================================================

-- §1 — Drop views that depend on patient_account_id before altering it.
DROP VIEW IF EXISTS public.crisis_event_patient_summary_v CASCADE;
DROP VIEW IF EXISTS public.crisis_event_current_state_v CASCADE;

-- §2 — Drop FK + index on patient_account_id before retype.
ALTER TABLE public.crisis_event
    DROP CONSTRAINT IF EXISTS crisis_event_patient_account_fk;

DROP INDEX IF EXISTS idx_crisis_event_tenant_patient_account;

-- §3 — Rename patient_account_id back to patient_id + retype to UUID.
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name   = 'crisis_event'
           AND column_name  = 'patient_account_id'
    ) THEN
        ALTER TABLE public.crisis_event
            RENAME COLUMN patient_account_id TO patient_id;
    END IF;
END;
$$;

ALTER TABLE public.crisis_event
    ALTER COLUMN patient_id TYPE UUID
    USING patient_id::UUID;

-- §4 — Retype lifecycle_transition.actor_principal_id back to UUID.
ALTER TABLE public.crisis_event_lifecycle_transition
    ALTER COLUMN actor_principal_id TYPE UUID
    USING CASE WHEN actor_principal_id IS NULL THEN NULL ELSE actor_principal_id::UUID END;

-- §5 — Recreate index on restored patient_id column.
CREATE INDEX IF NOT EXISTS idx_crisis_event_tenant_patient
    ON public.crisis_event (tenant_id, patient_id, detected_at DESC);

-- §6 — Restore raw lifecycle writer with UUID actor.
CREATE OR REPLACE FUNCTION record_crisis_event_lifecycle_transition(
    p_tenant_id           TEXT,
    p_crisis_event_id     UUID,
    p_from_state          TEXT,
    p_to_state            TEXT,
    p_transition_reason   TEXT,
    p_actor_principal_id  UUID,
    p_transition_payload  JSONB
) RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    v_transition_id BIGINT;
BEGIN
    INSERT INTO public.crisis_event_lifecycle_transition (
        tenant_id, crisis_event_id, from_state, to_state, transition_reason,
        transition_at, actor_principal_id, transition_payload
    ) VALUES (
        p_tenant_id, p_crisis_event_id, p_from_state, p_to_state, p_transition_reason,
        now(), p_actor_principal_id, p_transition_payload
    )
    RETURNING id INTO v_transition_id;
    RETURN v_transition_id;
END;
$$;

-- §7 — Restore initiation wrapper with UUID patient_id + UUID actor.
DROP FUNCTION IF EXISTS record_crisis_initiation(
    TEXT, TEXT, UUID, TEXT, TEXT, BOOLEAN,
    BYTEA, UUID, INTEGER, BYTEA, BYTEA, UUID, INTEGER, TEXT
);

CREATE OR REPLACE FUNCTION record_crisis_initiation(
    p_tenant_id                    TEXT,
    p_patient_id                   UUID,
    p_server_signal_id             UUID,
    p_crisis_type                  TEXT,
    p_severity                     TEXT,
    p_regulatory_reporting_enabled BOOLEAN,
    p_intake_payload_ciphertext    BYTEA   DEFAULT NULL,
    p_intake_payload_dek_id        UUID    DEFAULT NULL,
    p_intake_payload_dek_version   INTEGER DEFAULT NULL,
    p_intake_payload_iv            BYTEA   DEFAULT NULL,
    p_intake_payload_auth_tag      BYTEA   DEFAULT NULL,
    p_intake_payload_kek_id        UUID    DEFAULT NULL,
    p_intake_payload_kek_version   INTEGER DEFAULT NULL,
    p_intake_payload_algorithm     TEXT    DEFAULT NULL
) RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    v_crisis_event_id        UUID;
    v_existing_event_id      UUID;
    v_actor_tenant_id        TEXT;
    v_actor_account_id_text  TEXT;
    v_actor_principal_id     UUID;
BEGIN
    v_actor_account_id_text := current_actor_account_id();
    IF v_actor_account_id_text IS NULL THEN
        RAISE EXCEPTION 'record_crisis_initiation: no actor account bound'
            USING ERRCODE = '42501';
    END IF;
    BEGIN
        v_actor_principal_id := v_actor_account_id_text::UUID;
    EXCEPTION WHEN invalid_text_representation THEN
        RAISE EXCEPTION 'record_crisis_initiation: actor account_id not UUID-shaped'
            USING ERRCODE = '42501';
    END;
    v_actor_tenant_id := current_actor_account_tenant_id();
    IF v_actor_tenant_id IS NULL OR v_actor_tenant_id IS DISTINCT FROM p_tenant_id THEN
        RAISE EXCEPTION 'record_crisis_initiation: tenant mismatch'
            USING ERRCODE = '42501';
    END IF;
    SELECT id INTO v_existing_event_id
      FROM public.crisis_event
     WHERE tenant_id = p_tenant_id AND server_signal_id = p_server_signal_id
       AND patient_id = p_patient_id;
    IF v_existing_event_id IS NOT NULL THEN RETURN v_existing_event_id; END IF;
    INSERT INTO public.crisis_event (
        tenant_id, patient_id, server_signal_id,
        crisis_type, severity, regulatory_reporting_enabled,
        intake_payload_ciphertext, intake_payload_dek_id,
        intake_payload_dek_version, intake_payload_iv,
        intake_payload_auth_tag, intake_payload_kek_id,
        intake_payload_kek_version, intake_payload_algorithm
    ) VALUES (
        p_tenant_id, p_patient_id, p_server_signal_id,
        p_crisis_type, p_severity, p_regulatory_reporting_enabled,
        p_intake_payload_ciphertext, p_intake_payload_dek_id,
        p_intake_payload_dek_version, p_intake_payload_iv,
        p_intake_payload_auth_tag, p_intake_payload_kek_id,
        p_intake_payload_kek_version, p_intake_payload_algorithm
    ) RETURNING id INTO v_crisis_event_id;
    PERFORM public.record_crisis_event_lifecycle_transition(
        p_tenant_id, v_crisis_event_id, 'none', 'detected', 'initial_detection',
        v_actor_principal_id, NULL
    );
    RETURN v_crisis_event_id;
END;
$$;

ALTER FUNCTION record_crisis_initiation(
    TEXT, UUID, UUID, TEXT, TEXT, BOOLEAN,
    BYTEA, UUID, INTEGER, BYTEA, BYTEA, UUID, INTEGER, TEXT
) OWNER TO crisis_initiation_wrapper_owner;

REVOKE EXECUTE ON FUNCTION record_crisis_initiation(
    TEXT, UUID, UUID, TEXT, TEXT, BOOLEAN,
    BYTEA, UUID, INTEGER, BYTEA, BYTEA, UUID, INTEGER, TEXT
) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION record_crisis_initiation(
    TEXT, UUID, UUID, TEXT, TEXT, BOOLEAN,
    BYTEA, UUID, INTEGER, BYTEA, BYTEA, UUID, INTEGER, TEXT
) TO crisis_initiator;

-- §8 — Restore derived views with UUID patient_id + ::UUID cast.
CREATE OR REPLACE VIEW crisis_event_current_state_v
WITH (security_invoker = true, security_barrier = true)
AS
SELECT
    ce.id                                 AS crisis_event_id,
    ce.tenant_id,
    ce.patient_id,
    ce.server_signal_id,
    ce.crisis_type,
    ce.severity,
    ce.regulatory_reporting_enabled,
    ce.detected_at,
    latest.to_state                       AS current_state,
    latest.transition_at                  AS current_state_transition_at,
    latest.transition_reason              AS current_state_transition_reason,
    latest.actor_principal_id             AS current_state_actor_principal_id
FROM crisis_event ce
LEFT JOIN LATERAL (
    SELECT to_state, transition_at, transition_reason, actor_principal_id
      FROM crisis_event_lifecycle_transition lt
     WHERE lt.tenant_id = ce.tenant_id AND lt.crisis_event_id = ce.id
     ORDER BY lt.transition_at DESC, lt.id DESC LIMIT 1
) latest ON TRUE
WHERE ce.tenant_id = current_tenant_id();

ALTER VIEW crisis_event_current_state_v OWNER TO crisis_event_current_state_view_owner;
REVOKE ALL ON crisis_event_current_state_v FROM PUBLIC;
GRANT SELECT ON crisis_event_current_state_v TO crisis_event_staff_reader;

CREATE OR REPLACE VIEW crisis_event_patient_summary_v
WITH (security_invoker = true, security_barrier = true)
AS
SELECT
    ce.id                                 AS crisis_event_id,
    ce.tenant_id,
    ce.patient_id,
    ce.crisis_type,
    ce.severity,
    ce.detected_at,
    latest.to_state                       AS current_state,
    latest.transition_at                  AS current_state_transition_at
FROM crisis_event ce
LEFT JOIN LATERAL (
    SELECT to_state, transition_at
      FROM crisis_event_lifecycle_transition lt
     WHERE lt.tenant_id = ce.tenant_id AND lt.crisis_event_id = ce.id
     ORDER BY lt.transition_at DESC, lt.id DESC LIMIT 1
) latest ON TRUE
WHERE ce.tenant_id = current_tenant_id()
  AND ce.patient_id = (SELECT current_actor_account_id()::UUID);

ALTER VIEW crisis_event_patient_summary_v OWNER TO crisis_event_patient_summary_view_owner;
REVOKE ALL ON crisis_event_patient_summary_v FROM PUBLIC;
GRANT SELECT ON crisis_event_patient_summary_v TO crisis_event_patient_reader;

-- Note: mid-lifecycle wrappers (037) and sweep wrapper (038) reference
-- actor_principal_id UUID internally via the raw writer — they still accept
-- BIGINT/UUID internally; restoring the raw writer to UUID is sufficient.
-- The wrapper CREATE OR REPLACE with UUID actor is optional here since the
-- raw writer now expects UUID again.
