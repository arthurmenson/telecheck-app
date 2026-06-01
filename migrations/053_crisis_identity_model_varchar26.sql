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
-- §0 — Drop views that depend on the columns being altered.
--
-- PostgreSQL blocks ALTER COLUMN TYPE when a view references the column
-- ("cannot alter type of a column used by a view or rule"). Both derived
-- views from migration 034 SELECT patient_id from crisis_event; they must
-- be dropped before the ALTER COLUMN, then re-created after in §3 and §4.
-- Ownership, grants, and comments are re-established with the CREATE OR
-- REPLACE VIEW statements in §3 and §4.
-- =============================================================================

DROP VIEW IF EXISTS public.crisis_event_patient_summary_v CASCADE;
DROP VIEW IF EXISTS public.crisis_event_current_state_v CASCADE;

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
-- Greenfield safety note (Codex R2 finding 4): this migration applies in the
-- CI test environment which starts with an empty DB (all migrations run fresh,
-- no existing crisis_event rows). The USING clause casts any existing UUID text
-- values to TEXT (36-char strings), which do NOT satisfy the canonical 26-char
-- Crockford ULID pattern and would fail the subsequent FK constraint if any rows
-- existed. For any non-empty dev/staging DB, rows MUST be deleted or migrated
-- to real account_id ULID values before applying this migration. In production
-- this system is pre-launch (greenfield per Master PRD v1.10 §17); no live
-- crisis_event rows exist. CI passes because the test DB is always empty at
-- migration time.
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

-- =============================================================================
-- §5 — Drop OLD record_crisis_initiation(TEXT,UUID,UUID,...) + replace raw
--      lifecycle writer (migration 035) with TEXT actor param (SI-025 P-045).
-- =============================================================================

DROP FUNCTION IF EXISTS record_crisis_initiation(
    TEXT, UUID, UUID, TEXT, TEXT, BOOLEAN,
    BYTEA, UUID, INTEGER, BYTEA, BYTEA, UUID, INTEGER, TEXT
);

-- Drop the old raw lifecycle writer overload before creating the new TEXT-actor one.
-- CREATE OR REPLACE with a different signature creates a new overload rather than
-- replacing the original, leaving a stale UUID-actor INSERT path (Codex R2 finding 2).
DROP FUNCTION IF EXISTS record_crisis_event_lifecycle_transition(
    TEXT, UUID, TEXT, TEXT, TEXT, UUID, JSONB
);

-- Replace raw lifecycle writer: p_actor_principal_id UUID -> TEXT (SI-025 P-045).
-- Must be replaced before the wrappers that call it (they now pass TEXT).
CREATE OR REPLACE FUNCTION record_crisis_event_lifecycle_transition(
    p_tenant_id           TEXT,
    p_crisis_event_id     UUID,
    p_from_state          TEXT,
    p_to_state            TEXT,
    p_transition_reason   TEXT,
    p_actor_principal_id  TEXT,    -- SI-025 P-045
    p_transition_payload  JSONB
) RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    v_transition_id BIGINT;
BEGIN
    -- All business invariants enforced at the table layer:
    -- - CHECK constraint at §6 of migration 033 enforces the 11 valid
    --   (from_state, to_state, transition_reason) triples
    -- - monotonic-ordering trigger at §6 of migration 033 takes an advisory
    --   lock keyed by (tenant_id, crisis_event_id) hash + asserts
    --   NEW.transition_at >= MAX(prior.transition_at) under the lock
    --   (future-dating bounded by 5s clock-skew; backdating rejected)
    -- - append-only trigger at §6 of migration 033 blocks UPDATE/DELETE
    --
    -- This raw writer is the SOLE INSERT path into the table; EXECUTE on
    -- this function is granted ONLY to the 5 wrapper-owner roles (§3 below)
    -- so application roles cannot bypass the wrapper-level LAYER A+B+C
    -- authorization that each state-changing wrapper enforces.
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

-- =============================================================================
-- §2 — Function ownership + writer_owner role grants on lifecycle_transition
-- =============================================================================

ALTER FUNCTION record_crisis_event_lifecycle_transition(
    TEXT, UUID, TEXT, TEXT, TEXT, TEXT, JSONB
) OWNER TO crisis_event_lifecycle_transition_writer_owner;

-- writer_owner needs INSERT (the function body inserts) + SELECT (the
-- SECURITY INVOKER monotonic-ordering trigger reads MAX(transition_at)
-- under the caller's identity = writer_owner when this SECDEF runs).
GRANT INSERT ON crisis_event_lifecycle_transition TO crisis_event_lifecycle_transition_writer_owner;
GRANT SELECT ON crisis_event_lifecycle_transition TO crisis_event_lifecycle_transition_writer_owner;

-- =============================================================================
-- §3 — Anti-bypass EXECUTE grant matrix (P-040 §3.1 + P-038 §3.1 canonical
-- pattern): the raw writer is callable ONLY by the 5 wrapper-owner roles.
-- =============================================================================

REVOKE EXECUTE ON FUNCTION record_crisis_event_lifecycle_transition(
    TEXT, UUID, TEXT, TEXT, TEXT, TEXT, JSONB
) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION record_crisis_event_lifecycle_transition(
    TEXT, UUID, TEXT, TEXT, TEXT, TEXT, JSONB
) TO crisis_initiation_wrapper_owner,
     crisis_acknowledgement_wrapper_owner,
     crisis_response_wrapper_owner,
     crisis_resolution_wrapper_owner,
     crisis_sweep_wrapper_owner;

COMMENT ON FUNCTION record_crisis_event_lifecycle_transition(
    TEXT, UUID, TEXT, TEXT, TEXT, TEXT, JSONB
) IS
    'P-040 §3.1 + SI-022 Sub-decision 4.5 raw canonical lifecycle writer. '
    'SECURITY DEFINER + locked search_path. SOLE INSERT path into '
    'crisis_event_lifecycle_transition. EXECUTE granted ONLY to the 5 wrapper-'
    'owner roles (anti-bypass per P-034 §3 + P-038 §3 + P-040 §3 pattern); '
    'application roles never call this directly. All business invariants '
    '(11 valid triples + monotonic-ordering + append-only) enforced at the '
    'table layer via migration 033 triggers + CHECK constraint.';


-- =============================================================================
-- §6 — Replace record_crisis_initiation (migration 036) with new TEXT
--      p_patient_account_id param and TEXT actor. Grants + ownership preserved.
-- =============================================================================
CREATE OR REPLACE FUNCTION record_crisis_initiation(
    p_tenant_id                    TEXT,
    p_patient_account_id           TEXT,    -- SI-025 P-045
    p_server_signal_id             UUID,
    p_crisis_type                  TEXT,
    p_severity                     TEXT,
    p_regulatory_reporting_enabled BOOLEAN,
    -- KMS envelope for intake_payload PHI (all 8 columns or all NULL per
    -- the table's CHECK constraint at migration 033 §4)
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
    v_actor_principal_id     TEXT;    -- SI-025 P-045: was UUID
BEGIN
    -- ---------------------------------------------------------------------
    -- LAYER B — bind actor identity from SI-010 trust anchor; caller cannot
    -- supply or forge the principal_id. current_actor_account_id() returns
    -- the verified-bound account identity for the current PG backend, or
    -- NULL if no actor context bound (fail-closed per SI-010 pattern).
    -- ---------------------------------------------------------------------
    v_actor_account_id_text := current_actor_account_id();
    IF v_actor_account_id_text IS NULL THEN
        RAISE EXCEPTION
            'record_crisis_initiation: no actor account bound for current backend; authContextPlugin must bind before SECDEF wrapper invocation'
            USING ERRCODE = '42501';
    END IF;
    -- account_id is stored as TEXT in SI-010 _session_actor_context (variable-shape
    -- identifier per code-repo convention); the lifecycle_transition.actor_principal_id
    -- column is UUID. Cast with explicit error message on malformed input.
    BEGIN
        v_actor_principal_id := v_actor_account_id_text;  -- SI-025 P-045: TEXT
    EXCEPTION
        WHEN invalid_text_representation THEN
            RAISE EXCEPTION
                'record_crisis_initiation: bound actor account_id % is not a valid UUID; cannot record as lifecycle actor_principal_id',
                v_actor_account_id_text
                USING ERRCODE = '42501';
    END;

    -- ---------------------------------------------------------------------
    -- LAYER C — tenant scope match (defense-in-depth alongside LAYER A
    -- EXECUTE grant which restricts to crisis_initiator role members).
    -- current_actor_account_tenant_id() returns NULL if no actor context
    -- is bound for the current PG backend (fails closed per SI-010
    -- trust-anchor pattern).
    -- ---------------------------------------------------------------------
    v_actor_tenant_id := current_actor_account_tenant_id();
    IF v_actor_tenant_id IS NULL THEN
        RAISE EXCEPTION
            'record_crisis_initiation: no actor tenant bound for current backend'
            USING ERRCODE = '42501';
    END IF;
    IF v_actor_tenant_id IS DISTINCT FROM p_tenant_id THEN
        RAISE EXCEPTION
            'record_crisis_initiation: tenant scope mismatch — actor tenant % does not match wrapper p_tenant_id %; cross-tenant initiation rejected',
            v_actor_tenant_id, p_tenant_id
            USING ERRCODE = '42501';
    END IF;

    -- ---------------------------------------------------------------------
    -- Idempotency check: FLOOR-020 retries land on the existing crisis_event
    -- via UNIQUE(tenant_id, server_signal_id). R3 HIGH-1 closure 2026-05-22:
    -- a canonical idempotent replay must verify that the immutable initiation
    -- payload (patient_id + crisis_type + severity + regulatory_reporting_enabled
    -- + KMS envelope) matches the existing row exactly. A duplicate server
    -- signal with different patient or classification is NOT a valid replay
    -- — it's a caller bug or attempted misattribution and must fail closed.
    -- IS NOT DISTINCT FROM handles the all-NULL KMS envelope case (table CHECK
    -- at migration 033 §4 allows all-NULL or all-set).
    -- ---------------------------------------------------------------------
    SELECT id INTO v_existing_event_id
      FROM public.crisis_event
     WHERE tenant_id = p_tenant_id
       AND server_signal_id = p_server_signal_id
       AND patient_account_id = p_patient_account_id
       AND crisis_type = p_crisis_type
       AND severity = p_severity
       AND regulatory_reporting_enabled = p_regulatory_reporting_enabled
       AND intake_payload_ciphertext  IS NOT DISTINCT FROM p_intake_payload_ciphertext
       AND intake_payload_dek_id      IS NOT DISTINCT FROM p_intake_payload_dek_id
       AND intake_payload_dek_version IS NOT DISTINCT FROM p_intake_payload_dek_version
       AND intake_payload_iv          IS NOT DISTINCT FROM p_intake_payload_iv
       AND intake_payload_auth_tag    IS NOT DISTINCT FROM p_intake_payload_auth_tag
       AND intake_payload_kek_id      IS NOT DISTINCT FROM p_intake_payload_kek_id
       AND intake_payload_kek_version IS NOT DISTINCT FROM p_intake_payload_kek_version
       AND intake_payload_algorithm   IS NOT DISTINCT FROM p_intake_payload_algorithm;
    IF v_existing_event_id IS NOT NULL THEN
        -- All immutable fields match — canonical idempotent replay.
        RETURN v_existing_event_id;
    END IF;
    -- If a row with the same (tenant_id, server_signal_id) exists but DOES NOT
    -- match all immutable fields, the next INSERT will hit unique_violation +
    -- the EXCEPTION handler below performs the same field-match check + raises
    -- idempotency-mismatch if the existing row doesn't match. This catches both
    -- the pre-INSERT-lookup race (server_signal exists but fields differ) and
    -- the concurrent-INSERT race (two callers race; loser's handler runs).

    -- ---------------------------------------------------------------------
    -- Insert new crisis_event row. CHECK constraints at table layer
    -- (migration 033 §4) enforce crisis_type enum, severity enum, KMS
    -- envelope coherence (all 8 columns or all NULL).
    -- ---------------------------------------------------------------------
    BEGIN
        INSERT INTO public.crisis_event (
            tenant_id, patient_account_id, server_signal_id,
            crisis_type, severity, regulatory_reporting_enabled,
            intake_payload_ciphertext, intake_payload_dek_id,
            intake_payload_dek_version, intake_payload_iv,
            intake_payload_auth_tag, intake_payload_kek_id,
            intake_payload_kek_version, intake_payload_algorithm
        ) VALUES (
            p_tenant_id, p_patient_account_id, p_server_signal_id,
            p_crisis_type, p_severity, p_regulatory_reporting_enabled,
            p_intake_payload_ciphertext, p_intake_payload_dek_id,
            p_intake_payload_dek_version, p_intake_payload_iv,
            p_intake_payload_auth_tag, p_intake_payload_kek_id,
            p_intake_payload_kek_version, p_intake_payload_algorithm
        )
        RETURNING id INTO v_crisis_event_id;
    EXCEPTION
        WHEN unique_violation THEN
            -- Concurrent FLOOR-020 retry won the race OR caller submitted a
            -- duplicate server_signal_id with different immutable fields.
            -- R3 HIGH-1 closure 2026-05-22: re-read with FULL immutable-field
            -- match (same predicate as pre-INSERT check); if no match found
            -- the existing row diverges from this caller's payload — raise
            -- idempotency-mismatch + roll back the transaction.
            SELECT id INTO v_crisis_event_id
              FROM public.crisis_event
             WHERE tenant_id = p_tenant_id
               AND server_signal_id = p_server_signal_id
               AND patient_account_id = p_patient_account_id
               AND crisis_type = p_crisis_type
               AND severity = p_severity
               AND regulatory_reporting_enabled = p_regulatory_reporting_enabled
               AND intake_payload_ciphertext  IS NOT DISTINCT FROM p_intake_payload_ciphertext
               AND intake_payload_dek_id      IS NOT DISTINCT FROM p_intake_payload_dek_id
               AND intake_payload_dek_version IS NOT DISTINCT FROM p_intake_payload_dek_version
               AND intake_payload_iv          IS NOT DISTINCT FROM p_intake_payload_iv
               AND intake_payload_auth_tag    IS NOT DISTINCT FROM p_intake_payload_auth_tag
               AND intake_payload_kek_id      IS NOT DISTINCT FROM p_intake_payload_kek_id
               AND intake_payload_kek_version IS NOT DISTINCT FROM p_intake_payload_kek_version
               AND intake_payload_algorithm   IS NOT DISTINCT FROM p_intake_payload_algorithm;

            IF v_crisis_event_id IS NULL THEN
                RAISE EXCEPTION
                    'record_crisis_initiation: idempotency-mismatch — existing crisis_event for (tenant_id=%, server_signal_id=%) has different immutable fields than the supplied payload; caller MUST resolve the conflict before retrying',
                    p_tenant_id, p_server_signal_id
                    USING ERRCODE = '23505';  -- unique_violation (canonical for idempotency conflict)
            END IF;

            -- Field-match confirmed; canonical idempotent replay.
            RETURN v_crisis_event_id;
    END;

    -- ---------------------------------------------------------------------
    -- Emit `none → detected / initial_detection` lifecycle transition via
    -- the raw writer (migration 035). The raw writer's monotonic-ordering
    -- trigger takes an advisory lock keyed by (tenant_id, crisis_event_id)
    -- and asserts ordering invariants under it.
    -- ---------------------------------------------------------------------
    PERFORM public.record_crisis_event_lifecycle_transition(
        p_tenant_id,
        v_crisis_event_id,
        'none',
        'detected',
        'initial_detection',
        v_actor_principal_id,  -- bound from SI-010 (R1 HIGH-1 closure); caller cannot forge
        NULL  -- transition_payload — caller's audit emission carries the descriptive payload
    );

    RETURN v_crisis_event_id;
END;
$$;

-- =============================================================================
-- §2 — Function ownership + initiation_wrapper_owner role grants
-- =============================================================================

ALTER FUNCTION record_crisis_initiation(
    TEXT, TEXT, UUID, TEXT, TEXT, BOOLEAN,
    BYTEA, UUID, INTEGER, BYTEA, BYTEA, UUID, INTEGER, TEXT
) OWNER TO crisis_initiation_wrapper_owner;

-- initiation_wrapper_owner needs:
-- - INSERT + SELECT on crisis_event (for the new-row INSERT + idempotency check)
-- - EXECUTE on record_crisis_event_lifecycle_transition (granted at migration 035 §3)
-- - EXECUTE on current_actor_account_id() + current_actor_account_tenant_id() SI-010
--   helpers (migration 031 only grants these to telecheck_app_role; wrapper-owner
--   needs explicit grants for SECURITY DEFINER execution under its own identity).
--   R2 HIGH-1 closure 2026-05-22 (PR 4 Codex review): without these grants the
--   internal-actor-binding from R1 HIGH-1 closure would fail at runtime with
--   permission_denied for function ... on every legitimate caller.
GRANT INSERT, SELECT ON crisis_event TO crisis_initiation_wrapper_owner;
GRANT EXECUTE ON FUNCTION current_actor_account_id() TO crisis_initiation_wrapper_owner;
GRANT EXECUTE ON FUNCTION current_actor_account_tenant_id() TO crisis_initiation_wrapper_owner;

-- =============================================================================
-- §3 — Anti-bypass EXECUTE grant matrix: ONLY crisis_initiator application role
-- =============================================================================

REVOKE EXECUTE ON FUNCTION record_crisis_initiation(
    TEXT, TEXT, UUID, TEXT, TEXT, BOOLEAN,
    BYTEA, UUID, INTEGER, BYTEA, BYTEA, UUID, INTEGER, TEXT
) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION record_crisis_initiation(
    TEXT, TEXT, UUID, TEXT, TEXT, BOOLEAN,
    BYTEA, UUID, INTEGER, BYTEA, BYTEA, UUID, INTEGER, TEXT
) TO crisis_initiator;

COMMENT ON FUNCTION record_crisis_initiation(
    TEXT, TEXT, UUID, TEXT, TEXT, BOOLEAN,
    BYTEA, UUID, INTEGER, BYTEA, BYTEA, UUID, INTEGER, TEXT
) IS
    'P-040 §3.2 + SI-022 Sub-decision 4 record_crisis_initiation wrapper. '
    'SECURITY DEFINER + locked search_path. SOLE entry point for new crisis_event rows. '
    'EXECUTE granted ONLY to crisis_initiator role (application-layer authContextPlugin '
    'manages membership: clinician + on-call clinician + ai_mode1_service). '
    'Idempotent via crisis_event UNIQUE(tenant_id, server_signal_id) — FLOOR-020 retries '
    'return existing crisis_event_id. Audit emission for Cat A crisis.detected event '
    'deferred to application layer (PR 7+ Fastify route + emitAudit() wrap in single tx).';


-- =============================================================================
-- §7 — Replace 3 mid-lifecycle wrappers (migration 037): drop ::UUID actor cast.
-- =============================================================================
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
    v_latest_actor           TEXT;    -- SI-025 P-045: was UUID
    v_transition_id          BIGINT;
BEGIN
    -- LAYER B — bind actor identity from SI-010 (caller cannot forge).
    v_actor_account_id_text := current_actor_account_id();
    IF v_actor_account_id_text IS NULL THEN
        RAISE EXCEPTION 'record_crisis_acknowledgement_claim: no actor account bound'
            USING ERRCODE = '42501';
    END IF;
    -- SI-025 P-045: TEXT; no ::UUID cast.
    v_actor_principal_id := v_actor_account_id_text;;

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

    -- SELECT FOR UPDATE on parent crisis_event row — serializes concurrent
    -- mid-lifecycle wrapper calls for the same crisis_event. The advisory
    -- lock at the lifecycle_transition monotonic-ordering trigger is a
    -- second layer (per-event hash-key); the row lock here is the primary
    -- serialization point + matches the canonical P-040 pattern.
    PERFORM 1 FROM public.crisis_event
     WHERE tenant_id = p_tenant_id AND id = p_crisis_event_id
       FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'record_crisis_acknowledgement_claim: crisis_event % not found for tenant %', p_crisis_event_id, p_tenant_id
            USING ERRCODE = '02000';  -- no_data
    END IF;

    -- Read latest lifecycle state under lock.
    SELECT to_state, actor_principal_id
      INTO v_latest_to_state, v_latest_actor
      FROM public.crisis_event_lifecycle_transition
     WHERE tenant_id = p_tenant_id AND crisis_event_id = p_crisis_event_id
     ORDER BY transition_at DESC, id DESC
     LIMIT 1;

    -- Idempotent replay: if latest is already acknowledged BY THIS ACTOR,
    -- treat as canonical replay + return the latest transition id without
    -- inserting a duplicate. Latest acknowledged by ANOTHER actor is a
    -- race condition where another claimer won — surface as serialization
    -- conflict for the loser.
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
                USING ERRCODE = '40001';  -- serialization_failure (retry-safe semantic; another caller won)
        END IF;
    END IF;

    -- Validate latest is in the allowed from-state set for acknowledgement.
    IF v_latest_to_state IS NULL OR v_latest_to_state NOT IN ('detected', 'escalated') THEN
        RAISE EXCEPTION 'record_crisis_acknowledgement_claim: cannot acknowledge crisis_event % from state %; allowed from-states are detected, escalated',
            p_crisis_event_id, COALESCE(v_latest_to_state, '<NULL/none>')
            USING ERRCODE = '40001';
    END IF;

    -- Emit the transition.
    v_transition_id := public.record_crisis_event_lifecycle_transition(
        p_tenant_id,
        p_crisis_event_id,
        v_latest_to_state,                    -- from_state (detected OR escalated)
        'acknowledged',                       -- to_state
        'clinician_acknowledgement',          -- transition_reason
        v_actor_principal_id,                 -- bound from SI-010
        p_transition_payload
    );

    RETURN v_transition_id;
END;
$$;

ALTER FUNCTION record_crisis_acknowledgement_claim(TEXT, UUID, JSONB)
    OWNER TO crisis_acknowledgement_wrapper_owner;
-- R1 HIGH-1 closure 2026-05-22 (PR 5 Codex review): SELECT + UPDATE on crisis_event.
-- PostgreSQL SELECT ... FOR UPDATE requires UPDATE privilege on the locked table
-- (even if the append-only trigger from migration 033 blocks any actual UPDATE at
-- runtime — the GRANT prerequisite is checked separately). Without UPDATE, every
-- wrapper call fails at runtime with permission_denied on the row-lock acquisition.
-- Matches the canonical P-042 R8 HIGH-1 closure pattern from the spec corpus.
GRANT SELECT, UPDATE ON crisis_event               TO crisis_acknowledgement_wrapper_owner;
GRANT SELECT ON crisis_event_lifecycle_transition  TO crisis_acknowledgement_wrapper_owner;
GRANT EXECUTE ON FUNCTION current_actor_account_id()         TO crisis_acknowledgement_wrapper_owner;
GRANT EXECUTE ON FUNCTION current_actor_account_tenant_id()  TO crisis_acknowledgement_wrapper_owner;
REVOKE EXECUTE ON FUNCTION record_crisis_acknowledgement_claim(TEXT, UUID, JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION record_crisis_acknowledgement_claim(TEXT, UUID, JSONB) TO crisis_acknowledger;

COMMENT ON FUNCTION record_crisis_acknowledgement_claim(TEXT, UUID, JSONB) IS
    'P-040 §3.3 record_crisis_acknowledgement_claim — clinician/care-team claims '
    'detected/escalated crisis. SECDEF + actor bound from SI-010 + SELECT FOR UPDATE '
    'on parent row + latest-state validation + natural idempotency on same-actor replay. '
    'Audit emission for Cat A crisis.acknowledged deferred to application layer.';

-- =============================================================================
-- §2 — record_crisis_response()
--
-- Clinician records first-response after acknowledgement. Single allowed
-- from-state: acknowledged → responded (clinician_response).
-- =============================================================================

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
        RAISE EXCEPTION 'record_crisis_response: no actor account bound' USING ERRCODE = '42501';
    END IF;
    BEGIN v_actor_principal_id := v_actor_account_id_text;  -- SI-025 P-045: TEXT
    EXCEPTION WHEN invalid_text_representation THEN
        RAISE EXCEPTION 'record_crisis_response: bound actor account_id % is not a valid UUID', v_actor_account_id_text
            USING ERRCODE = '42501';
    END;

    v_actor_tenant_id := current_actor_account_tenant_id();
    IF v_actor_tenant_id IS NULL THEN
        RAISE EXCEPTION 'record_crisis_response: no actor tenant bound' USING ERRCODE = '42501';
    END IF;
    IF v_actor_tenant_id IS DISTINCT FROM p_tenant_id THEN
        RAISE EXCEPTION 'record_crisis_response: tenant scope mismatch'
            USING ERRCODE = '42501';
    END IF;

    PERFORM 1 FROM public.crisis_event
     WHERE tenant_id = p_tenant_id AND id = p_crisis_event_id
       FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'record_crisis_response: crisis_event % not found', p_crisis_event_id
            USING ERRCODE = '02000';
    END IF;

    SELECT to_state, actor_principal_id
      INTO v_latest_to_state, v_latest_actor
      FROM public.crisis_event_lifecycle_transition
     WHERE tenant_id = p_tenant_id AND crisis_event_id = p_crisis_event_id
     ORDER BY transition_at DESC, id DESC
     LIMIT 1;

    -- Idempotent replay for same actor.
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
            RAISE EXCEPTION 'record_crisis_response: crisis_event % already responded by another actor; race lost', p_crisis_event_id
                USING ERRCODE = '40001';
        END IF;
    END IF;

    -- Only acknowledged → responded allowed per spec §6 triple #9.
    IF v_latest_to_state IS DISTINCT FROM 'acknowledged' THEN
        RAISE EXCEPTION 'record_crisis_response: cannot respond from state %; must be acknowledged',
            COALESCE(v_latest_to_state, '<NULL/none>')
            USING ERRCODE = '40001';
    END IF;

    v_transition_id := public.record_crisis_event_lifecycle_transition(
        p_tenant_id, p_crisis_event_id,
        'acknowledged', 'responded', 'clinician_response',
        v_actor_principal_id, p_transition_payload
    );

    RETURN v_transition_id;
END;
$$;

ALTER FUNCTION record_crisis_response(TEXT, UUID, JSONB)
    OWNER TO crisis_response_wrapper_owner;
GRANT SELECT, UPDATE ON crisis_event               TO crisis_response_wrapper_owner;  -- UPDATE required for SELECT FOR UPDATE (R1 HIGH-1)
GRANT SELECT ON crisis_event_lifecycle_transition  TO crisis_response_wrapper_owner;
GRANT EXECUTE ON FUNCTION current_actor_account_id()         TO crisis_response_wrapper_owner;
GRANT EXECUTE ON FUNCTION current_actor_account_tenant_id()  TO crisis_response_wrapper_owner;
REVOKE EXECUTE ON FUNCTION record_crisis_response(TEXT, UUID, JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION record_crisis_response(TEXT, UUID, JSONB) TO crisis_responder;

COMMENT ON FUNCTION record_crisis_response(TEXT, UUID, JSONB) IS
    'P-040 §3.4 record_crisis_response — clinician records first-response. '
    'SECDEF + same closure-of-defects pattern as acknowledgement wrapper. '
    'Audit emission for Cat A crisis.responded deferred to application layer.';

-- =============================================================================
-- §3 — record_crisis_resolution()
--
-- Clinician resolves the crisis. Two allowed from-states:
-- responded → resolved (clinician_resolution; triple #10)
-- escalated → resolved (clinician_resolution; triple #11)
-- =============================================================================

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
        RAISE EXCEPTION 'record_crisis_resolution: no actor account bound' USING ERRCODE = '42501';
    END IF;
    BEGIN v_actor_principal_id := v_actor_account_id_text;  -- SI-025 P-045: TEXT
    EXCEPTION WHEN invalid_text_representation THEN
        RAISE EXCEPTION 'record_crisis_resolution: bound actor account_id % is not a valid UUID', v_actor_account_id_text
            USING ERRCODE = '42501';
    END;

    v_actor_tenant_id := current_actor_account_tenant_id();
    IF v_actor_tenant_id IS NULL THEN
        RAISE EXCEPTION 'record_crisis_resolution: no actor tenant bound' USING ERRCODE = '42501';
    END IF;
    IF v_actor_tenant_id IS DISTINCT FROM p_tenant_id THEN
        RAISE EXCEPTION 'record_crisis_resolution: tenant scope mismatch' USING ERRCODE = '42501';
    END IF;

    PERFORM 1 FROM public.crisis_event
     WHERE tenant_id = p_tenant_id AND id = p_crisis_event_id
       FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'record_crisis_resolution: crisis_event % not found', p_crisis_event_id
            USING ERRCODE = '02000';
    END IF;

    SELECT to_state, actor_principal_id
      INTO v_latest_to_state, v_latest_actor
      FROM public.crisis_event_lifecycle_transition
     WHERE tenant_id = p_tenant_id AND crisis_event_id = p_crisis_event_id
     ORDER BY transition_at DESC, id DESC
     LIMIT 1;

    -- Idempotent replay for same actor (resolved is terminal — any further
    -- mutation is rejected by state-machine CHECK; same-actor retry returns
    -- the existing row).
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
            RAISE EXCEPTION 'record_crisis_resolution: crisis_event % already resolved by another actor; race lost', p_crisis_event_id
                USING ERRCODE = '40001';
        END IF;
    END IF;

    -- Two allowed from-states: responded OR escalated.
    IF v_latest_to_state IS NULL OR v_latest_to_state NOT IN ('responded', 'escalated') THEN
        RAISE EXCEPTION 'record_crisis_resolution: cannot resolve from state %; allowed from-states are responded, escalated',
            COALESCE(v_latest_to_state, '<NULL/none>')
            USING ERRCODE = '40001';
    END IF;

    v_transition_id := public.record_crisis_event_lifecycle_transition(
        p_tenant_id, p_crisis_event_id,
        v_latest_to_state, 'resolved', 'clinician_resolution',
        v_actor_principal_id, p_transition_payload
    );

    RETURN v_transition_id;
END;
$$;

ALTER FUNCTION record_crisis_resolution(TEXT, UUID, JSONB)
    OWNER TO crisis_resolution_wrapper_owner;
GRANT SELECT, UPDATE ON crisis_event               TO crisis_resolution_wrapper_owner;  -- UPDATE required for SELECT FOR UPDATE (R1 HIGH-1)
GRANT SELECT ON crisis_event_lifecycle_transition  TO crisis_resolution_wrapper_owner;
GRANT EXECUTE ON FUNCTION current_actor_account_id()         TO crisis_resolution_wrapper_owner;
GRANT EXECUTE ON FUNCTION current_actor_account_tenant_id()  TO crisis_resolution_wrapper_owner;
REVOKE EXECUTE ON FUNCTION record_crisis_resolution(TEXT, UUID, JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION record_crisis_resolution(TEXT, UUID, JSONB) TO crisis_resolver;

COMMENT ON FUNCTION record_crisis_resolution(TEXT, UUID, JSONB) IS
    'P-040 §3.5 record_crisis_resolution — clinician resolves crisis from '
    'responded OR escalated. SECDEF + same closure-of-defects pattern. '
    'Audit emission for Cat A crisis.resolved deferred to application layer.';


-- =============================================================================
-- §8 — Replace sweep wrapper (migration 038): drop ::UUID actor cast.
-- =============================================================================
CREATE OR REPLACE FUNCTION execute_crisis_no_acknowledgement_sweep(
    p_tenant_id                     TEXT,
    p_crisis_event_id               UUID,
    p_target_obligation_generation  INTEGER,
    p_worker_id                     TEXT,
    p_claim_ttl_seconds             INTEGER DEFAULT 60
)
RETURNS TABLE (
    sweep_execution_id   UUID,
    fencing_token        BIGINT,
    outcome              TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    v_actor_account_id_text  TEXT;
    v_actor_principal_id     TEXT;    -- SI-025 P-045: was UUID
    v_actor_tenant_id        TEXT;
    v_latest_to_state        TEXT;
    v_to_state               TEXT;
    v_transition_reason      TEXT;
    v_sweep_row              RECORD;
    v_existing_sweep_id      UUID;
    v_returning_sweep_id     UUID;
    v_returning_fencing      BIGINT;
    v_returning_outcome      TEXT;
BEGIN
    -- LAYER B — bind actor (sweep scheduler worker).
    v_actor_account_id_text := current_actor_account_id();
    IF v_actor_account_id_text IS NULL THEN
        RAISE EXCEPTION 'execute_crisis_no_acknowledgement_sweep: no actor account bound'
            USING ERRCODE = '42501';
    END IF;
    -- SI-025 P-045: TEXT; no ::UUID cast.
    v_actor_principal_id := v_actor_account_id_text;;

    -- LAYER C — tenant scope.
    v_actor_tenant_id := current_actor_account_tenant_id();
    IF v_actor_tenant_id IS NULL THEN
        RAISE EXCEPTION 'execute_crisis_no_acknowledgement_sweep: no actor tenant bound'
            USING ERRCODE = '42501';
    END IF;
    IF v_actor_tenant_id IS DISTINCT FROM p_tenant_id THEN
        RAISE EXCEPTION 'execute_crisis_no_acknowledgement_sweep: tenant scope mismatch'
            USING ERRCODE = '42501';
    END IF;

    IF p_claim_ttl_seconds <= 0 OR p_claim_ttl_seconds > 600 THEN
        RAISE EXCEPTION 'execute_crisis_no_acknowledgement_sweep: p_claim_ttl_seconds % out of range [1, 600]', p_claim_ttl_seconds
            USING ERRCODE = '22023';  -- invalid_parameter_value
    END IF;

    -- Parent-row lock — serializes concurrent sweep workers + acknowledgement/
    -- response/resolution wrappers for the same crisis_event.
    PERFORM 1 FROM public.crisis_event
     WHERE tenant_id = p_tenant_id AND id = p_crisis_event_id
       FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'execute_crisis_no_acknowledgement_sweep: crisis_event % not found for tenant %', p_crisis_event_id, p_tenant_id
            USING ERRCODE = '02000';
    END IF;

    -- =====================================================================
    -- §1.1 — Claim or take-over phase
    --
    -- Try to find an open sweep_execution row for this (tenant, event, generation).
    -- - If exists with claim_expires_at >= now() AND claimed_by_worker_id <> p_worker_id:
    --     another worker holds a valid lease; reject this attempt (40001 retry-safe).
    -- - If exists with claim_expires_at < now() OR claim_expires_at IS NULL:
    --     take over by UPDATEing claimed_by_worker_id + claim_expires_at +
    --     incrementing fencing_token.
    -- - If no row exists: INSERT a new claim with fencing_token = 1.
    -- =====================================================================

    -- R1 HIGH-1 closure 2026-05-22: idempotent replay guard for already-
    -- completed sweep. A retry after successful completion (or a scheduler
    -- redelivery of the same generation) must NOT mint a new open row that
    -- would emit a duplicate escalation. Return the existing completed
    -- sweep's info with outcome='already_completed' instead.
    SELECT cse.sweep_execution_id, cse.fencing_token
      INTO v_existing_sweep_id, v_returning_fencing
      FROM public.crisis_sweep_execution cse
     WHERE cse.tenant_id = p_tenant_id
       AND cse.crisis_event_id = p_crisis_event_id
       AND cse.scheduled_for_obligation_generation = p_target_obligation_generation
       AND cse.completed_at IS NOT NULL
     ORDER BY cse.completed_at DESC, cse.sweep_execution_id DESC
     LIMIT 1;
    IF v_existing_sweep_id IS NOT NULL THEN
        sweep_execution_id := v_existing_sweep_id;
        fencing_token      := v_returning_fencing;
        outcome            := 'already_completed';
        RETURN NEXT;
        RETURN;
    END IF;

    SELECT sweep_execution_id, claimed_by_worker_id, claim_expires_at, fencing_token, completed_at
      INTO v_sweep_row
      FROM public.crisis_sweep_execution
     WHERE tenant_id = p_tenant_id
       AND crisis_event_id = p_crisis_event_id
       AND scheduled_for_obligation_generation = p_target_obligation_generation
       AND completed_at IS NULL    -- only open rows; partial UNIQUE index allows at most one
     FOR UPDATE;

    IF FOUND THEN
        -- Another worker may hold a valid lease.
        IF v_sweep_row.claim_expires_at IS NOT NULL
           AND v_sweep_row.claim_expires_at >= now()
           AND v_sweep_row.claimed_by_worker_id IS DISTINCT FROM p_worker_id THEN
            RAISE EXCEPTION 'execute_crisis_no_acknowledgement_sweep: sweep_execution_id % for crisis_event % gen % currently leased by worker % until %; retry after expiry',
                v_sweep_row.sweep_execution_id, p_crisis_event_id, p_target_obligation_generation,
                v_sweep_row.claimed_by_worker_id, v_sweep_row.claim_expires_at
                USING ERRCODE = '40001';
        END IF;

        -- Take over the lease (claim expired, or same worker reclaiming).
        UPDATE public.crisis_sweep_execution
           SET claimed_by_worker_id = p_worker_id,
               claim_expires_at     = now() + (p_claim_ttl_seconds || ' seconds')::INTERVAL,
               fencing_token        = v_sweep_row.fencing_token + 1,
               heartbeat_at         = now()
         WHERE sweep_execution_id = v_sweep_row.sweep_execution_id
         RETURNING sweep_execution_id, fencing_token
              INTO v_returning_sweep_id, v_returning_fencing;
        v_returning_outcome := 'claimed_takeover';
    ELSE
        -- New claim: insert a fresh row. R2 HIGH-1 closure 2026-05-22:
        -- two scheduler workers can race for the FIRST claim — both pass the
        -- completed-row guard + open-row SELECT (no rows exist yet), both
        -- reach this INSERT. The partial UNIQUE on (tenant, event, generation)
        -- WHERE completed_at IS NULL allows only one to succeed; the loser
        -- raises unique_violation. Without a handler, the loser leaks raw
        -- SQLSTATE 23505. Wrap in EXCEPTION block + re-read winning row to
        -- determine controlled outcome.
        BEGIN
            INSERT INTO public.crisis_sweep_execution (
                tenant_id, crisis_event_id, scheduled_at,
                scheduled_for_obligation_generation,
                claimed_by_worker_id, claim_expires_at,
                fencing_token, heartbeat_at
            ) VALUES (
                p_tenant_id, p_crisis_event_id, now(),
                p_target_obligation_generation,
                p_worker_id, now() + (p_claim_ttl_seconds || ' seconds')::INTERVAL,
                1,    -- initial fencing_token
                now()
            )
            RETURNING crisis_sweep_execution.sweep_execution_id, crisis_sweep_execution.fencing_token
                 INTO v_returning_sweep_id, v_returning_fencing;
            v_returning_outcome := 'claimed_new';
        EXCEPTION
            WHEN unique_violation THEN
                -- R4 HIGH-1 closure 2026-05-22: discriminate the violated
                -- constraint. Only the partial UNIQUE index from migration 033
                -- §7 (`crisis_sweep_execution_open_uk`) represents a first-claim
                -- race; any other unique_violation indicates schema drift,
                -- corruption, or an unrelated integrity failure that MUST be
                -- re-raised to preserve the real diagnostic — silently
                -- swallowing it could mask a real bug + drop a required sweep.
                DECLARE
                    v_constraint_name TEXT;
                BEGIN
                    GET STACKED DIAGNOSTICS v_constraint_name = CONSTRAINT_NAME;
                    IF v_constraint_name IS DISTINCT FROM 'crisis_sweep_execution_open_uk' THEN
                        -- Unrelated unique violation; re-raise with diagnostic.
                        RAISE EXCEPTION 'execute_crisis_no_acknowledgement_sweep: unexpected unique_violation on constraint %; not the canonical first-claim race; preserving original failure',
                            v_constraint_name
                            USING ERRCODE = '23505';  -- canonical unique_violation
                    END IF;
                END;

                -- R3 HIGH-1 closure 2026-05-22: race-loser re-read. The partial
                -- UNIQUE constraint only enforces uniqueness on OPEN rows, so the
                -- winning row that just caused our unique_violation MUST be open.
                -- Re-read OPEN row FIRST + return 40001 lease-conflict if found.
                -- ONLY if no open row exists (winner finished in the gap before
                -- we caught the violation) do we fall back to the most-recent
                -- completed row + return already_completed.
                SELECT cse.sweep_execution_id, cse.fencing_token, cse.claimed_by_worker_id, cse.claim_expires_at
                  INTO v_returning_sweep_id, v_returning_fencing,
                       v_sweep_row.claimed_by_worker_id, v_sweep_row.claim_expires_at
                  FROM public.crisis_sweep_execution cse
                 WHERE cse.tenant_id = p_tenant_id
                   AND cse.crisis_event_id = p_crisis_event_id
                   AND cse.scheduled_for_obligation_generation = p_target_obligation_generation
                   AND cse.completed_at IS NULL;
                IF FOUND THEN
                    -- Winner still holds the open lease — return controlled 40001.
                    RAISE EXCEPTION 'execute_crisis_no_acknowledgement_sweep: concurrent first-claim race lost; sweep_execution_id % currently leased by worker % until %; retry after expiry',
                        v_returning_sweep_id, v_sweep_row.claimed_by_worker_id, v_sweep_row.claim_expires_at
                        USING ERRCODE = '40001';
                END IF;

                -- No open row — winner finished completion in the gap. Find
                -- the most-recent COMPLETED row (ordered by completed_at DESC,
                -- not by sweep_execution_id which is UUID and not a recency
                -- signal) and return already_completed.
                SELECT cse.sweep_execution_id, cse.fencing_token
                  INTO v_returning_sweep_id, v_returning_fencing
                  FROM public.crisis_sweep_execution cse
                 WHERE cse.tenant_id = p_tenant_id
                   AND cse.crisis_event_id = p_crisis_event_id
                   AND cse.scheduled_for_obligation_generation = p_target_obligation_generation
                   AND cse.completed_at IS NOT NULL
                 ORDER BY cse.completed_at DESC, cse.sweep_execution_id DESC
                 LIMIT 1;
                IF v_returning_sweep_id IS NOT NULL THEN
                    sweep_execution_id := v_returning_sweep_id;
                    fencing_token      := v_returning_fencing;
                    outcome            := 'already_completed';
                    RETURN NEXT;
                    RETURN;
                END IF;

                -- Should be unreachable — unique_violation implies a colliding
                -- row exists, and we just searched all states.
                RAISE EXCEPTION 'execute_crisis_no_acknowledgement_sweep: unique_violation re-read found no colliding row — invariant violation; investigate sweep_execution data integrity'
                    USING ERRCODE = 'XX000';  -- internal_error
        END;
    END IF;

    -- =====================================================================
    -- §1.2 — Lifecycle emission phase
    --
    -- Read latest lifecycle state under the parent FOR UPDATE lock. The
    -- sweep escalates ONLY if current state is detected or escalated.
    -- Other states (acknowledged/responded/resolved) are no-ops — the
    -- sweep simply commits with outcome 'completed_no_op'.
    -- =====================================================================

    SELECT to_state
      INTO v_latest_to_state
      FROM public.crisis_event_lifecycle_transition
     WHERE tenant_id = p_tenant_id AND crisis_event_id = p_crisis_event_id
     ORDER BY transition_at DESC, id DESC
     LIMIT 1;

    IF v_latest_to_state = 'detected' THEN
        -- Triple #2 — detected → escalated (no_acknowledgement_timeout)
        v_to_state := 'escalated';
        v_transition_reason := 'no_acknowledgement_timeout';
    ELSIF v_latest_to_state = 'escalated' THEN
        -- Triple #3 — escalated → escalated (tier_progression_no_acknowledgement)
        v_to_state := 'escalated';
        v_transition_reason := 'tier_progression_no_acknowledgement';
    ELSE
        -- Latest is acknowledged/responded/resolved (or NULL — shouldn't happen
        -- post-initiation but treat defensively). No escalation; mark sweep
        -- completed with no-op outcome.
        UPDATE public.crisis_sweep_execution
           SET completed_at             = now(),
               sweep_cycle_id_committed = v_returning_fencing,    -- using fencing_token as cycle id
               heartbeat_at             = now()
         WHERE sweep_execution_id = v_returning_sweep_id
           AND fencing_token       = v_returning_fencing;          -- guard against takeover during processing

        IF NOT FOUND THEN
            -- Another worker took over since our claim; abort.
            RAISE EXCEPTION 'execute_crisis_no_acknowledgement_sweep: lease lost during processing; another worker may have taken over sweep_execution_id %',
                v_returning_sweep_id
                USING ERRCODE = '40001';
        END IF;

        sweep_execution_id := v_returning_sweep_id;
        fencing_token      := v_returning_fencing;
        outcome            := 'completed_no_op';
        RETURN NEXT;
        RETURN;
    END IF;

    -- Emit escalation transition via raw writer.
    PERFORM public.record_crisis_event_lifecycle_transition(
        p_tenant_id,
        p_crisis_event_id,
        v_latest_to_state,
        v_to_state,
        v_transition_reason,
        v_actor_principal_id,
        NULL  -- transition_payload
    );

    -- =====================================================================
    -- §1.3 — STEP F atomic completion
    --
    -- Set completed_at + sweep_cycle_id_committed in a single UPDATE,
    -- guarded by fencing_token to detect lease-takeover races. If the
    -- UPDATE affects zero rows, another worker took over our claim
    -- during processing and we must abort without committing.
    -- =====================================================================

    UPDATE public.crisis_sweep_execution
       SET completed_at             = now(),
           sweep_cycle_id_committed = v_returning_fencing,
           heartbeat_at             = now()
     WHERE sweep_execution_id = v_returning_sweep_id
       AND fencing_token       = v_returning_fencing;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'execute_crisis_no_acknowledgement_sweep: lease lost during processing; another worker may have taken over sweep_execution_id %',
            v_returning_sweep_id
            USING ERRCODE = '40001';
    END IF;

    sweep_execution_id := v_returning_sweep_id;
    fencing_token      := v_returning_fencing;
    outcome            := 'completed_escalated';
    RETURN NEXT;
    RETURN;
END;
$$;

-- =============================================================================
-- §2 — Function ownership + sweep_wrapper_owner role grants
-- =============================================================================

ALTER FUNCTION execute_crisis_no_acknowledgement_sweep(TEXT, UUID, INTEGER, TEXT, INTEGER)
    OWNER TO crisis_sweep_wrapper_owner;

-- sweep_wrapper_owner needs:
-- - SELECT + UPDATE on crisis_event (SELECT FOR UPDATE parent row)
-- - INSERT + SELECT + UPDATE on crisis_sweep_execution (claim + take-over + STEP F)
-- - SELECT on crisis_event_lifecycle_transition (latest-state read)
-- - EXECUTE on SI-010 helpers
-- - EXECUTE on raw writer (granted at migration 035 §3 — verified below)
GRANT SELECT, UPDATE ON crisis_event                       TO crisis_sweep_wrapper_owner;
GRANT INSERT, SELECT, UPDATE ON crisis_sweep_execution     TO crisis_sweep_wrapper_owner;
GRANT SELECT ON crisis_event_lifecycle_transition          TO crisis_sweep_wrapper_owner;
GRANT EXECUTE ON FUNCTION current_actor_account_id()        TO crisis_sweep_wrapper_owner;
GRANT EXECUTE ON FUNCTION current_actor_account_tenant_id() TO crisis_sweep_wrapper_owner;

-- =============================================================================
-- §3 — Anti-bypass: EXECUTE granted ONLY to crisis_sweep_scheduler app role
-- =============================================================================

REVOKE EXECUTE ON FUNCTION execute_crisis_no_acknowledgement_sweep(TEXT, UUID, INTEGER, TEXT, INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION execute_crisis_no_acknowledgement_sweep(TEXT, UUID, INTEGER, TEXT, INTEGER) TO crisis_sweep_scheduler;

COMMENT ON FUNCTION execute_crisis_no_acknowledgement_sweep(TEXT, UUID, INTEGER, TEXT, INTEGER) IS
    'P-040 §3.6 + SI-022 Sub-decision 4 + Sub-decision 6 no-acknowledgement sweep wrapper. '
    'SECDEF + lease-takeover semantics + fencing-token + STEP F atomic completion. '
    'Application-layer sweep scheduler invokes this with target obligation generation; '
    'wrapper claims/takes-over the sweep row, emits escalation if current state warrants, '
    'and commits completion guarded by fencing_token race detection. Audit emission for '
    'Cat A crisis.no_acknowledgement_escalation deferred to application layer.';


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


-- =============================================================================
-- §7 -- Replace execute_crisis_no_acknowledgement_sweep (migration 038):
--      v_actor_principal_id UUID -> TEXT; drop ::UUID cast block (SI-025 P-045).
-- =============================================================================

CREATE OR REPLACE FUNCTION execute_crisis_no_acknowledgement_sweep(
    p_tenant_id                     TEXT,
    p_crisis_event_id               UUID,
    p_target_obligation_generation  INTEGER,
    p_worker_id                     TEXT,
    p_claim_ttl_seconds             INTEGER DEFAULT 60
)
RETURNS TABLE (
    sweep_execution_id   UUID,
    fencing_token        BIGINT,
    outcome              TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    v_actor_account_id_text  TEXT;
    v_actor_principal_id     TEXT;    -- SI-025 P-045: was UUID; no ::UUID cast
    v_actor_tenant_id        TEXT;
    v_latest_to_state        TEXT;
    v_to_state               TEXT;
    v_transition_reason      TEXT;
    v_sweep_row              RECORD;
    v_existing_sweep_id      UUID;
    v_returning_sweep_id     UUID;
    v_returning_fencing      BIGINT;
    v_returning_outcome      TEXT;
BEGIN
    -- LAYER B — bind actor (sweep scheduler worker).
    v_actor_account_id_text := current_actor_account_id();
    IF v_actor_account_id_text IS NULL THEN
        RAISE EXCEPTION 'execute_crisis_no_acknowledgement_sweep: no actor account bound'
            USING ERRCODE = '42501';
    END IF;
    -- SI-025 P-045: assign TEXT directly; no ::UUID cast.
    v_actor_principal_id := v_actor_account_id_text;

    -- LAYER C — tenant scope.
    v_actor_tenant_id := current_actor_account_tenant_id();
    IF v_actor_tenant_id IS NULL THEN
        RAISE EXCEPTION 'execute_crisis_no_acknowledgement_sweep: no actor tenant bound'
            USING ERRCODE = '42501';
    END IF;
    IF v_actor_tenant_id IS DISTINCT FROM p_tenant_id THEN
        RAISE EXCEPTION 'execute_crisis_no_acknowledgement_sweep: tenant scope mismatch'
            USING ERRCODE = '42501';
    END IF;

    IF p_claim_ttl_seconds <= 0 OR p_claim_ttl_seconds > 600 THEN
        RAISE EXCEPTION 'execute_crisis_no_acknowledgement_sweep: p_claim_ttl_seconds % out of range [1, 600]', p_claim_ttl_seconds
            USING ERRCODE = '22023';  -- invalid_parameter_value
    END IF;

    -- Parent-row lock — serializes concurrent sweep workers + acknowledgement/
    -- response/resolution wrappers for the same crisis_event.
    PERFORM 1 FROM public.crisis_event
     WHERE tenant_id = p_tenant_id AND id = p_crisis_event_id
       FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'execute_crisis_no_acknowledgement_sweep: crisis_event % not found for tenant %', p_crisis_event_id, p_tenant_id
            USING ERRCODE = '02000';
    END IF;

    -- =====================================================================
    -- §1.1 — Claim or take-over phase
    --
    -- Try to find an open sweep_execution row for this (tenant, event, generation).
    -- - If exists with claim_expires_at >= now() AND claimed_by_worker_id <> p_worker_id:
    --     another worker holds a valid lease; reject this attempt (40001 retry-safe).
    -- - If exists with claim_expires_at < now() OR claim_expires_at IS NULL:
    --     take over by UPDATEing claimed_by_worker_id + claim_expires_at +
    --     incrementing fencing_token.
    -- - If no row exists: INSERT a new claim with fencing_token = 1.
    -- =====================================================================

    -- R1 HIGH-1 closure 2026-05-22: idempotent replay guard for already-
    -- completed sweep. A retry after successful completion (or a scheduler
    -- redelivery of the same generation) must NOT mint a new open row that
    -- would emit a duplicate escalation. Return the existing completed
    -- sweep's info with outcome='already_completed' instead.
    SELECT cse.sweep_execution_id, cse.fencing_token
      INTO v_existing_sweep_id, v_returning_fencing
      FROM public.crisis_sweep_execution cse
     WHERE cse.tenant_id = p_tenant_id
       AND cse.crisis_event_id = p_crisis_event_id
       AND cse.scheduled_for_obligation_generation = p_target_obligation_generation
       AND cse.completed_at IS NOT NULL
     ORDER BY cse.completed_at DESC, cse.sweep_execution_id DESC
     LIMIT 1;
    IF v_existing_sweep_id IS NOT NULL THEN
        sweep_execution_id := v_existing_sweep_id;
        fencing_token      := v_returning_fencing;
        outcome            := 'already_completed';
        RETURN NEXT;
        RETURN;
    END IF;

    SELECT sweep_execution_id, claimed_by_worker_id, claim_expires_at, fencing_token, completed_at
      INTO v_sweep_row
      FROM public.crisis_sweep_execution
     WHERE tenant_id = p_tenant_id
       AND crisis_event_id = p_crisis_event_id
       AND scheduled_for_obligation_generation = p_target_obligation_generation
       AND completed_at IS NULL    -- only open rows; partial UNIQUE index allows at most one
     FOR UPDATE;

    IF FOUND THEN
        -- Another worker may hold a valid lease.
        IF v_sweep_row.claim_expires_at IS NOT NULL
           AND v_sweep_row.claim_expires_at >= now()
           AND v_sweep_row.claimed_by_worker_id IS DISTINCT FROM p_worker_id THEN
            RAISE EXCEPTION 'execute_crisis_no_acknowledgement_sweep: sweep_execution_id % for crisis_event % gen % currently leased by worker % until %; retry after expiry',
                v_sweep_row.sweep_execution_id, p_crisis_event_id, p_target_obligation_generation,
                v_sweep_row.claimed_by_worker_id, v_sweep_row.claim_expires_at
                USING ERRCODE = '40001';
        END IF;

        -- Take over the lease (claim expired, or same worker reclaiming).
        UPDATE public.crisis_sweep_execution
           SET claimed_by_worker_id = p_worker_id,
               claim_expires_at     = now() + (p_claim_ttl_seconds || ' seconds')::INTERVAL,
               fencing_token        = v_sweep_row.fencing_token + 1,
               heartbeat_at         = now()
         WHERE sweep_execution_id = v_sweep_row.sweep_execution_id
         RETURNING sweep_execution_id, fencing_token
              INTO v_returning_sweep_id, v_returning_fencing;
        v_returning_outcome := 'claimed_takeover';
    ELSE
        -- New claim: insert a fresh row. R2 HIGH-1 closure 2026-05-22:
        -- two scheduler workers can race for the FIRST claim — both pass the
        -- completed-row guard + open-row SELECT (no rows exist yet), both
        -- reach this INSERT. The partial UNIQUE on (tenant, event, generation)
        -- WHERE completed_at IS NULL allows only one to succeed; the loser
        -- raises unique_violation. Without a handler, the loser leaks raw
        -- SQLSTATE 23505. Wrap in EXCEPTION block + re-read winning row to
        -- determine controlled outcome.
        BEGIN
            INSERT INTO public.crisis_sweep_execution (
                tenant_id, crisis_event_id, scheduled_at,
                scheduled_for_obligation_generation,
                claimed_by_worker_id, claim_expires_at,
                fencing_token, heartbeat_at
            ) VALUES (
                p_tenant_id, p_crisis_event_id, now(),
                p_target_obligation_generation,
                p_worker_id, now() + (p_claim_ttl_seconds || ' seconds')::INTERVAL,
                1,    -- initial fencing_token
                now()
            )
            RETURNING crisis_sweep_execution.sweep_execution_id, crisis_sweep_execution.fencing_token
                 INTO v_returning_sweep_id, v_returning_fencing;
            v_returning_outcome := 'claimed_new';
        EXCEPTION
            WHEN unique_violation THEN
                -- R4 HIGH-1 closure 2026-05-22: discriminate the violated
                -- constraint. Only the partial UNIQUE index from migration 033
                -- §7 (`crisis_sweep_execution_open_uk`) represents a first-claim
                -- race; any other unique_violation indicates schema drift,
                -- corruption, or an unrelated integrity failure that MUST be
                -- re-raised to preserve the real diagnostic — silently
                -- swallowing it could mask a real bug + drop a required sweep.
                DECLARE
                    v_constraint_name TEXT;
                BEGIN
                    GET STACKED DIAGNOSTICS v_constraint_name = CONSTRAINT_NAME;
                    IF v_constraint_name IS DISTINCT FROM 'crisis_sweep_execution_open_uk' THEN
                        -- Unrelated unique violation; re-raise with diagnostic.
                        RAISE EXCEPTION 'execute_crisis_no_acknowledgement_sweep: unexpected unique_violation on constraint %; not the canonical first-claim race; preserving original failure',
                            v_constraint_name
                            USING ERRCODE = '23505';  -- canonical unique_violation
                    END IF;
                END;

                -- R3 HIGH-1 closure 2026-05-22: race-loser re-read. The partial
                -- UNIQUE constraint only enforces uniqueness on OPEN rows, so the
                -- winning row that just caused our unique_violation MUST be open.
                -- Re-read OPEN row FIRST + return 40001 lease-conflict if found.
                -- ONLY if no open row exists (winner finished in the gap before
                -- we caught the violation) do we fall back to the most-recent
                -- completed row + return already_completed.
                SELECT cse.sweep_execution_id, cse.fencing_token, cse.claimed_by_worker_id, cse.claim_expires_at
                  INTO v_returning_sweep_id, v_returning_fencing,
                       v_sweep_row.claimed_by_worker_id, v_sweep_row.claim_expires_at
                  FROM public.crisis_sweep_execution cse
                 WHERE cse.tenant_id = p_tenant_id
                   AND cse.crisis_event_id = p_crisis_event_id
                   AND cse.scheduled_for_obligation_generation = p_target_obligation_generation
                   AND cse.completed_at IS NULL;
                IF FOUND THEN
                    -- Winner still holds the open lease — return controlled 40001.
                    RAISE EXCEPTION 'execute_crisis_no_acknowledgement_sweep: concurrent first-claim race lost; sweep_execution_id % currently leased by worker % until %; retry after expiry',
                        v_returning_sweep_id, v_sweep_row.claimed_by_worker_id, v_sweep_row.claim_expires_at
                        USING ERRCODE = '40001';
                END IF;

                -- No open row — winner finished completion in the gap. Find
                -- the most-recent COMPLETED row (ordered by completed_at DESC,
                -- not by sweep_execution_id which is UUID and not a recency
                -- signal) and return already_completed.
                SELECT cse.sweep_execution_id, cse.fencing_token
                  INTO v_returning_sweep_id, v_returning_fencing
                  FROM public.crisis_sweep_execution cse
                 WHERE cse.tenant_id = p_tenant_id
                   AND cse.crisis_event_id = p_crisis_event_id
                   AND cse.scheduled_for_obligation_generation = p_target_obligation_generation
                   AND cse.completed_at IS NOT NULL
                 ORDER BY cse.completed_at DESC, cse.sweep_execution_id DESC
                 LIMIT 1;
                IF v_returning_sweep_id IS NOT NULL THEN
                    sweep_execution_id := v_returning_sweep_id;
                    fencing_token      := v_returning_fencing;
                    outcome            := 'already_completed';
                    RETURN NEXT;
                    RETURN;
                END IF;

                -- Should be unreachable — unique_violation implies a colliding
                -- row exists, and we just searched all states.
                RAISE EXCEPTION 'execute_crisis_no_acknowledgement_sweep: unique_violation re-read found no colliding row — invariant violation; investigate sweep_execution data integrity'
                    USING ERRCODE = 'XX000';  -- internal_error
        END;
    END IF;

    -- =====================================================================
    -- §1.2 — Lifecycle emission phase
    --
    -- Read latest lifecycle state under the parent FOR UPDATE lock. The
    -- sweep escalates ONLY if current state is detected or escalated.
    -- Other states (acknowledged/responded/resolved) are no-ops — the
    -- sweep simply commits with outcome 'completed_no_op'.
    -- =====================================================================

    SELECT to_state
      INTO v_latest_to_state
      FROM public.crisis_event_lifecycle_transition
     WHERE tenant_id = p_tenant_id AND crisis_event_id = p_crisis_event_id
     ORDER BY transition_at DESC, id DESC
     LIMIT 1;

    IF v_latest_to_state = 'detected' THEN
        -- Triple #2 — detected → escalated (no_acknowledgement_timeout)
        v_to_state := 'escalated';
        v_transition_reason := 'no_acknowledgement_timeout';
    ELSIF v_latest_to_state = 'escalated' THEN
        -- Triple #3 — escalated → escalated (tier_progression_no_acknowledgement)
        v_to_state := 'escalated';
        v_transition_reason := 'tier_progression_no_acknowledgement';
    ELSE
        -- Latest is acknowledged/responded/resolved (or NULL — shouldn't happen
        -- post-initiation but treat defensively). No escalation; mark sweep
        -- completed with no-op outcome.
        UPDATE public.crisis_sweep_execution
           SET completed_at             = now(),
               sweep_cycle_id_committed = v_returning_fencing,    -- using fencing_token as cycle id
               heartbeat_at             = now()
         WHERE sweep_execution_id = v_returning_sweep_id
           AND fencing_token       = v_returning_fencing;          -- guard against takeover during processing

        IF NOT FOUND THEN
            -- Another worker took over since our claim; abort.
            RAISE EXCEPTION 'execute_crisis_no_acknowledgement_sweep: lease lost during processing; another worker may have taken over sweep_execution_id %',
                v_returning_sweep_id
                USING ERRCODE = '40001';
        END IF;

        sweep_execution_id := v_returning_sweep_id;
        fencing_token      := v_returning_fencing;
        outcome            := 'completed_no_op';
        RETURN NEXT;
        RETURN;
    END IF;

    -- Emit escalation transition via raw writer.
    PERFORM public.record_crisis_event_lifecycle_transition(
        p_tenant_id,
        p_crisis_event_id,
        v_latest_to_state,
        v_to_state,
        v_transition_reason,
        v_actor_principal_id,   -- TEXT per SI-025 P-045
        NULL  -- transition_payload
    );

    -- =====================================================================
    -- §1.3 — STEP F atomic completion
    --
    -- Set completed_at + sweep_cycle_id_committed in a single UPDATE,
    -- guarded by fencing_token to detect lease-takeover races. If the
    -- UPDATE affects zero rows, another worker took over our claim
    -- during processing and we must abort without committing.
    -- =====================================================================

    UPDATE public.crisis_sweep_execution
       SET completed_at             = now(),
           sweep_cycle_id_committed = v_returning_fencing,
           heartbeat_at             = now()
     WHERE sweep_execution_id = v_returning_sweep_id
       AND fencing_token       = v_returning_fencing;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'execute_crisis_no_acknowledgement_sweep: lease lost during processing; another worker may have taken over sweep_execution_id %',
            v_returning_sweep_id
            USING ERRCODE = '40001';
    END IF;

    sweep_execution_id := v_returning_sweep_id;
    fencing_token      := v_returning_fencing;
    outcome            := 'completed_escalated';
    RETURN NEXT;
    RETURN;
END;
$$;

COMMENT ON FUNCTION execute_crisis_no_acknowledgement_sweep IS
    'SECURITY DEFINER crisis sweep wrapper (migration 038). SI-025 P-045: v_actor_principal_id changed from UUID to TEXT; ::UUID cast removed.';
