-- =============================================================================
-- File:    migrations/033_crisis_response_entities.sql
-- Purpose: Create the 3 net-new Crisis Response entities (SI-022 v1.0 RATIFIED
--          P-039 + CDM follow-on landing P-040 2026-05-21) plus the 3 P-027
--          §4.66-4.68 notification_crisis_* baseline entities that Crisis
--          Response is the first slice to need.
--
--          PR 1 of the Crisis Response implementation series (migration 032
--          created the 15 RBAC roles; this migration creates the table DDL +
--          RLS + per-table append-only triggers + indexes). Subsequent
--          migrations land derived views (PR 2) → SECDEF wrappers (PR 3+)
--          → Fastify routes + integration tests.
--
--          PER RATIFIER DECISION 2026-05-22 — OPTION 2 (adapt to code-repo
--          patterns rather than build SI-024.1 foundation first):
--          - RLS predicate uses `current_tenant_id()` (code-repo pattern from
--            migration 003) — NOT spec's `current_tenant_id_strict(entity_name)`
--            from SI-024.1 v0.8. Both are tenant-binding mechanisms; SI-010 is
--            the GUC-bound-via-table-keyed-by-pg_backend_pid() shape the code
--            repo currently runs on; SI-024.1 is the JWT-claim-based canonical
--            target. Migration to SI-024.1 happens in a future hygiene cycle.
--          - Per-table inline append-only trigger functions (audit_chain
--            pattern from migration 002) — NOT spec's generic enforce_append_only().
--          - Per-table inline terminal-row-immutable trigger function for
--            crisis_sweep_execution — NOT spec's generic enforce_terminal_row_immutable().
--          - `patient_id` column kept as UUID NOT NULL but FK constraint to
--            `patient(tenant_id, id)` SKIPPED (no patient table exists yet;
--            logical reference only; TODO documented inline for future
--            migration when Identity slice's patient entity lands).
--          - `server_signal_id` column kept as UUID NOT NULL but FK constraint
--            to Mode 1 conversation envelope SKIPPED (Mode 1 entities not in
--            code repo; logical reference only; TODO documented inline).
--          - `notification_crisis_*` 3 tables (P-027 §4.66-4.68 baseline)
--            inline-created here as part of this slice — SI-022 is the first
--            slice that needs them.
--          - `jwt_migration_entity_status` seed SKIPPED at v1.0 (the
--            migration-tracker table itself doesn't exist; added in future
--            foundation hygiene cycle alongside SI-024.1 trust anchor).
--
--          See `docs/crisis-response-implementation-plan.md` for full Option 2
--          adaptation rationale + recorded divergences from spec.
--
-- Spec:    - SI-022 Crisis Response Slice v1.0 (RATIFIED 2026-05-21 P-039;
--            telecheckONE/Telecheck Master Bundle FINAL US REGION BASELINE/
--            Telecheck_SI_022_Crisis_Response_v1_0.md §2 + §6 normative
--            entity definitions + state-machine transition triples)
--          - CDM v1.9 → v1.10 Amendment §4.NEW1 + §4.NEW2 + §4.NEW3 +
--            §4.EXT1 + §4.EXT2 + §4.EXT3 (canonical executable DDL source;
--            RATIFIED 2026-05-21 P-040;
--            telecheckONE/Telecheck Master Bundle FINAL US REGION BASELINE/
--            Telecheck_CDM_v1_9_to_v1_10_Amendment.md)
--          - I-019 (crisis-detection-always-on platform-floor)
--          - I-023 (three-layer tenant isolation; tenant_id on every PHI record)
--          - I-027 (audit append-only)
--          - I-035 (append-only invariant for ratification + audit-bound state
--            machines; crisis_event + crisis_event_lifecycle_transition both
--            qualify as ratification-record entities under I-035)
--          - ADR-021 (per-tenant KMS envelope for PHI encryption-at-rest;
--            8-column flat envelope pattern on crisis_event.intake_payload)
--
-- Summary: Creates 6 net-new tables (3 Crisis Response canonical + 3 P-027
--          notification baseline) with RLS + per-table append-only triggers +
--          composite tenant-scoped FKs + indexes. No SECDEF procedures, no
--          views, no grants in this migration — those land in subsequent PRs.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- PRECONDITION: 001_tenants.sql + 003_rls_helpers.sql + 032_crisis_response_rbac_roles.sql applied.
-- ---------------------------------------------------------------------------

-- =============================================================================
-- §1 — P-027 §4.66 baseline: notification_crisis_dispatch_ledger
--
-- Recorded divergence (Option 2): Crisis Response is the first slice in the
-- code repo to need this entity, so it lands inline here. The spec assumes
-- it already exists (the SI-022 amendment §4.EXT1 is an ALTER TABLE adding
-- a crisis_event_id column). In code-repo state, the table doesn't exist,
-- so we create it from scratch with crisis_event_id already included as a
-- NOT NULL column with FK enforced.
-- =============================================================================

CREATE TABLE notification_crisis_dispatch_ledger (
    id              UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       TEXT    NOT NULL REFERENCES tenants(id),
    -- crisis_event_id FK is added later in this same migration (§5) after
    -- crisis_event table is created. Declared NOT NULL here with deferred
    -- composite FK; cycle-of-dependency resolved by ordered DDL within tx.
    crisis_event_id UUID    NOT NULL,
    server_signal_id UUID   NOT NULL,    -- logical reference to Mode 1 envelope (no FK; see §0 header)
    dispatched_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    dispatch_origin TEXT    NOT NULL CHECK (dispatch_origin IN (
        'initial_detection', 'sweep_escalation', 'manual_replay'
    )),
    sweep_cycle_id  INTEGER NULL,    -- non-null for sweep_escalation; null for initial_detection
    payload_jsonb   JSONB   NULL,
    -- Composite UNIQUE for tenant-coherent FKs from child tables
    CONSTRAINT notification_crisis_dispatch_ledger_tenant_id_unique UNIQUE (tenant_id, id)
);

ALTER TABLE notification_crisis_dispatch_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_crisis_dispatch_ledger FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON notification_crisis_dispatch_ledger
    USING     (tenant_id = current_tenant_id())
    WITH CHECK (tenant_id = current_tenant_id());

-- Append-only per I-027 (audit-bound dispatch trail; corrections via append, not mutation)
CREATE OR REPLACE FUNCTION notification_crisis_dispatch_ledger_block_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
    RAISE EXCEPTION
        'notification_crisis_dispatch_ledger is append-only per I-027. '
        'UPDATE and DELETE are permanently prohibited. '
        'Corrections must be appended as new ledger rows with a different dispatch_origin.';
END;
$$;

CREATE TRIGGER notification_crisis_dispatch_ledger_block_update
    BEFORE UPDATE ON notification_crisis_dispatch_ledger
    FOR EACH ROW
    EXECUTE FUNCTION notification_crisis_dispatch_ledger_block_mutation();

CREATE TRIGGER notification_crisis_dispatch_ledger_block_delete
    BEFORE DELETE ON notification_crisis_dispatch_ledger
    FOR EACH ROW
    EXECUTE FUNCTION notification_crisis_dispatch_ledger_block_mutation();

CREATE INDEX notification_crisis_dispatch_ledger_tenant_dispatched_idx
    ON notification_crisis_dispatch_ledger (tenant_id, dispatched_at DESC);
CREATE INDEX notification_crisis_dispatch_ledger_tenant_event_idx
    ON notification_crisis_dispatch_ledger (tenant_id, crisis_event_id);

-- =============================================================================
-- §2 — P-027 §4.67 baseline: notification_crisis_provider_attempt
--
-- Per-provider delivery attempt log. R28 idempotency UNIQUE constraint per
-- (tenant_id, dispatch_ledger_id, recipient_role, recipient_principal_id,
-- sweep_cycle_id) prevents duplicate attempt rows under retry.
-- =============================================================================

CREATE TABLE notification_crisis_provider_attempt (
    id                       UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id                TEXT    NOT NULL REFERENCES tenants(id),
    dispatch_ledger_id       UUID    NOT NULL,
    crisis_event_id          UUID    NOT NULL,
    recipient_role           TEXT    NOT NULL CHECK (recipient_role IN (
        'care_team', 'clinical_on_call', 'regulatory_reporter', 'emergency_contact'
    )),
    -- Nullable for emergency_contact (no principal-id); non-null for all other recipient_roles (R37)
    recipient_principal_id   UUID    NULL,
    sweep_cycle_id           INTEGER NOT NULL,    -- deterministic per-sweep value (R39)
    attempted_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
    attempt_outcome          TEXT    NOT NULL CHECK (attempt_outcome IN (
        'delivered', 'failed_retryable', 'failed_permanent', 'undeliverable_no_route'
    )),
    provider_response_jsonb  JSONB   NULL,
    -- R37 recipient_principal_id required for addressable roles
    CONSTRAINT notification_crisis_provider_attempt_principal_required_for_addressable_roles
        CHECK (
            recipient_principal_id IS NOT NULL
            OR recipient_role = 'emergency_contact'
        ),
    -- R28 canonical idempotency UNIQUE (named so ON CONFLICT can target it explicitly)
    CONSTRAINT notification_crisis_provider_attempt_idempotency_uk
        UNIQUE (tenant_id, dispatch_ledger_id, recipient_role, recipient_principal_id, sweep_cycle_id),
    -- Composite tenant-scoped FK to dispatch_ledger
    CONSTRAINT notification_crisis_provider_attempt_dispatch_ledger_tenant_fk
        FOREIGN KEY (tenant_id, dispatch_ledger_id)
        REFERENCES notification_crisis_dispatch_ledger(tenant_id, id),
    -- Composite UNIQUE for tenant-coherent FKs from child tables
    CONSTRAINT notification_crisis_provider_attempt_tenant_id_unique UNIQUE (tenant_id, id)
);

ALTER TABLE notification_crisis_provider_attempt ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_crisis_provider_attempt FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON notification_crisis_provider_attempt
    USING     (tenant_id = current_tenant_id())
    WITH CHECK (tenant_id = current_tenant_id());

CREATE OR REPLACE FUNCTION notification_crisis_provider_attempt_block_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
    RAISE EXCEPTION
        'notification_crisis_provider_attempt is append-only per I-027. '
        'UPDATE and DELETE are permanently prohibited. '
        'Retry attempts append new rows; the idempotency UNIQUE constraint prevents duplicates.';
END;
$$;

CREATE TRIGGER notification_crisis_provider_attempt_block_update
    BEFORE UPDATE ON notification_crisis_provider_attempt
    FOR EACH ROW
    EXECUTE FUNCTION notification_crisis_provider_attempt_block_mutation();

CREATE TRIGGER notification_crisis_provider_attempt_block_delete
    BEFORE DELETE ON notification_crisis_provider_attempt
    FOR EACH ROW
    EXECUTE FUNCTION notification_crisis_provider_attempt_block_mutation();

CREATE INDEX notification_crisis_provider_attempt_tenant_event_attempted_idx
    ON notification_crisis_provider_attempt (tenant_id, crisis_event_id, attempted_at DESC);
CREATE INDEX notification_crisis_provider_attempt_tenant_dispatch_idx
    ON notification_crisis_provider_attempt (tenant_id, dispatch_ledger_id);

-- =============================================================================
-- §3 — P-027 §4.68 baseline: notification_crisis_escalation_obligation
--
-- Durable per-obligation work-item table. obligation_generation increments
-- monotonically per crisis_event as escalation tiers progress.
-- undeliverable_deadline is the wall-clock by which the obligation must reach
-- terminal state or trigger tier-progression sweep.
-- =============================================================================

CREATE TABLE notification_crisis_escalation_obligation (
    id                       UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id                TEXT    NOT NULL REFERENCES tenants(id),
    crisis_event_id          UUID    NOT NULL,
    obligation_generation    INTEGER NOT NULL CHECK (obligation_generation >= 0),
    tier                     TEXT    NOT NULL CHECK (tier IN (
        'care_team', 'clinical_on_call', 'regulatory'
    )),
    created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
    undeliverable_deadline   TIMESTAMPTZ NOT NULL,
    terminal_state           TEXT    NULL CHECK (terminal_state IN (
        'acknowledged', 'tier_escalated', 'manually_cleared'
    )),
    terminal_at              TIMESTAMPTZ NULL,
    -- Per-generation uniqueness within a crisis_event
    CONSTRAINT notification_crisis_escalation_obligation_per_generation_uk
        UNIQUE (tenant_id, crisis_event_id, obligation_generation),
    -- Terminal-state coherence: terminal_state non-null IFF terminal_at non-null
    CONSTRAINT notification_crisis_escalation_obligation_terminal_coherence
        CHECK (
            (terminal_state IS NULL AND terminal_at IS NULL)
            OR (terminal_state IS NOT NULL AND terminal_at IS NOT NULL)
        ),
    -- Composite UNIQUE for tenant-coherent FKs from child tables
    CONSTRAINT notification_crisis_escalation_obligation_tenant_id_unique UNIQUE (tenant_id, id)
);

ALTER TABLE notification_crisis_escalation_obligation ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_crisis_escalation_obligation FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON notification_crisis_escalation_obligation
    USING     (tenant_id = current_tenant_id())
    WITH CHECK (tenant_id = current_tenant_id());

-- escalation_obligation is INTENTIONALLY MUTABLE on terminal_state + terminal_at
-- (set once, to record terminal disposition). After both are non-null the row is
-- terminal and no further mutation is permitted (enforced by terminal-row-immutable
-- trigger below).
CREATE OR REPLACE FUNCTION notification_crisis_escalation_obligation_terminal_immutable()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
    -- Only fires WHEN old terminal_state was already set
    IF OLD.terminal_state IS DISTINCT FROM NEW.terminal_state
       OR OLD.terminal_at IS DISTINCT FROM NEW.terminal_at
       OR OLD.id IS DISTINCT FROM NEW.id
       OR OLD.tenant_id IS DISTINCT FROM NEW.tenant_id
       OR OLD.crisis_event_id IS DISTINCT FROM NEW.crisis_event_id
       OR OLD.obligation_generation IS DISTINCT FROM NEW.obligation_generation
       OR OLD.tier IS DISTINCT FROM NEW.tier
       OR OLD.created_at IS DISTINCT FROM NEW.created_at
       OR OLD.undeliverable_deadline IS DISTINCT FROM NEW.undeliverable_deadline THEN
        RAISE EXCEPTION
            'notification_crisis_escalation_obligation row is terminal (terminal_state was already set); '
            'no further mutation is permitted. Append a new obligation row for next-generation escalation.';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER notification_crisis_escalation_obligation_terminal_immutable_check
    BEFORE UPDATE ON notification_crisis_escalation_obligation
    FOR EACH ROW
    WHEN (OLD.terminal_state IS NOT NULL)
    EXECUTE FUNCTION notification_crisis_escalation_obligation_terminal_immutable();

-- DELETE blocked outright (immutable durable work-item record)
CREATE OR REPLACE FUNCTION notification_crisis_escalation_obligation_block_delete()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
    RAISE EXCEPTION
        'notification_crisis_escalation_obligation rows are durable per I-027 + I-035 + R52 audit-trail discipline; '
        'DELETE is permanently prohibited.';
END;
$$;

CREATE TRIGGER notification_crisis_escalation_obligation_block_delete_trigger
    BEFORE DELETE ON notification_crisis_escalation_obligation
    FOR EACH ROW
    EXECUTE FUNCTION notification_crisis_escalation_obligation_block_delete();

CREATE INDEX notification_crisis_escalation_obligation_tenant_event_idx
    ON notification_crisis_escalation_obligation (tenant_id, crisis_event_id, obligation_generation DESC);
CREATE INDEX notification_crisis_escalation_obligation_open_deadline_idx
    ON notification_crisis_escalation_obligation (tenant_id, undeliverable_deadline)
    WHERE terminal_state IS NULL;

-- =============================================================================
-- §4 — Crisis Response canonical: crisis_event (P-040 §4.NEW1)
--
-- The canonical immutable record of crisis detection. One row per detection
-- event (suicidal ideation, self-harm, violence threat, etc.) emitted by
-- Mode 1 FLOOR-020 platform-floor + recorded by record_crisis_initiation()
-- wrapper (lands in subsequent migration).
--
-- PHI handling: intake_payload is the Mode 1 user message that triggered
-- detection (clinical-grade PHI). KMS envelope is the 8-column flat envelope
-- pattern (P-021) — ciphertext + DEK metadata + IV + auth tag + KEK metadata
-- + algorithm. encryption-at-rest enforcement.
--
-- Recorded divergences (Option 2):
-- - patient_id is NOT enforced via FK to patient(tenant_id, id) (patient
--   table doesn't exist in code repo); logical reference only.
-- - server_signal_id is NOT enforced via FK to Mode 1 envelope (Mode 1
--   entities not in code repo); logical reference only.
-- =============================================================================

CREATE TABLE crisis_event (
    id                              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id                       TEXT NOT NULL REFERENCES tenants(id),
    -- Patient identity (logical reference; FK deferred per Option 2 — patient table not in code repo yet)
    patient_id                      UUID NOT NULL,
    -- Mode 1 server-signal envelope reference (logical; FK deferred per Option 2 — Mode 1 entities not in code repo yet)
    server_signal_id                UUID NOT NULL,
    crisis_type                     TEXT NOT NULL CHECK (crisis_type IN (
        'suicidal_ideation', 'self_harm', 'violence_threat', 'medical_emergency',
        'severe_psychological_distress', 'protocol_safety_floor_breach'
    )),
    severity                        TEXT NOT NULL CHECK (severity IN (
        'non_imminent', 'imminent', 'life_threatening'
    )),
    regulatory_reporting_enabled    BOOLEAN NOT NULL,
    detected_at                     TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- KMS envelope for intake_payload PHI (8-column flat envelope per ADR-021 P-021)
    intake_payload_ciphertext       BYTEA   NULL,
    intake_payload_dek_id           UUID    NULL,
    intake_payload_dek_version      INTEGER NULL,
    intake_payload_iv               BYTEA   NULL,
    intake_payload_auth_tag         BYTEA   NULL,
    intake_payload_kek_id           UUID    NULL,
    intake_payload_kek_version      INTEGER NULL,
    intake_payload_algorithm        TEXT    NULL,
    -- KMS envelope coherence: all 8 envelope columns non-null OR all 8 null
    CONSTRAINT crisis_event_kms_envelope_coherence CHECK (
        (intake_payload_ciphertext IS NULL
            AND intake_payload_dek_id IS NULL
            AND intake_payload_dek_version IS NULL
            AND intake_payload_iv IS NULL
            AND intake_payload_auth_tag IS NULL
            AND intake_payload_kek_id IS NULL
            AND intake_payload_kek_version IS NULL
            AND intake_payload_algorithm IS NULL)
        OR
        (intake_payload_ciphertext IS NOT NULL
            AND intake_payload_dek_id IS NOT NULL
            AND intake_payload_dek_version IS NOT NULL
            AND intake_payload_iv IS NOT NULL
            AND intake_payload_auth_tag IS NOT NULL
            AND intake_payload_kek_id IS NOT NULL
            AND intake_payload_kek_version IS NOT NULL
            AND intake_payload_algorithm IS NOT NULL)
    ),
    -- Server-signal uniqueness per tenant prevents duplicate crisis_event rows from FLOOR-020 retries
    CONSTRAINT crisis_event_server_signal_unique UNIQUE (tenant_id, server_signal_id),
    -- Composite tenant-coherent UNIQUE so child tables can compose tenant-scoped FKs
    CONSTRAINT crisis_event_tenant_id_unique UNIQUE (tenant_id, id)
);

ALTER TABLE crisis_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE crisis_event FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON crisis_event
    USING     (tenant_id = current_tenant_id())
    WITH CHECK (tenant_id = current_tenant_id());

-- crisis_event is APPEND-ONLY per I-035 (ratification-record / audit-bound entity).
-- Once detected + recorded, the crisis row is the immutable evidence of the event;
-- updates to detection metadata require a new crisis_event row referencing the
-- original via server_signal_id chain.
CREATE OR REPLACE FUNCTION crisis_event_block_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
    RAISE EXCEPTION
        'crisis_event is append-only per I-035 (ratification-record / audit-bound). '
        'UPDATE and DELETE are permanently prohibited. '
        'Corrections to detection metadata require a new crisis_event row.';
END;
$$;

CREATE TRIGGER crisis_event_block_update
    BEFORE UPDATE ON crisis_event
    FOR EACH ROW
    EXECUTE FUNCTION crisis_event_block_mutation();

CREATE TRIGGER crisis_event_block_delete
    BEFORE DELETE ON crisis_event
    FOR EACH ROW
    EXECUTE FUNCTION crisis_event_block_mutation();

CREATE INDEX crisis_event_patient_detection_idx
    ON crisis_event (tenant_id, patient_id, detected_at DESC);
CREATE INDEX crisis_event_severity_detection_idx
    ON crisis_event (tenant_id, severity, detected_at DESC);

-- =============================================================================
-- §5 — Add cycle-of-dependency FK constraints from §1/§2/§3 to crisis_event
--
-- The 3 notification_crisis_* tables declared crisis_event_id NOT NULL columns
-- in §1-§3 but couldn't reference crisis_event until that table exists in §4.
-- Now that crisis_event exists, add the composite tenant-scoped FK constraints.
-- =============================================================================

ALTER TABLE notification_crisis_dispatch_ledger
    ADD CONSTRAINT notification_crisis_dispatch_ledger_event_tenant_fk
    FOREIGN KEY (tenant_id, crisis_event_id) REFERENCES crisis_event(tenant_id, id);

ALTER TABLE notification_crisis_provider_attempt
    ADD CONSTRAINT notification_crisis_provider_attempt_event_tenant_fk
    FOREIGN KEY (tenant_id, crisis_event_id) REFERENCES crisis_event(tenant_id, id);

ALTER TABLE notification_crisis_escalation_obligation
    ADD CONSTRAINT notification_crisis_escalation_obligation_event_tenant_fk
    FOREIGN KEY (tenant_id, crisis_event_id) REFERENCES crisis_event(tenant_id, id);

-- =============================================================================
-- §6 — Crisis Response canonical: crisis_event_lifecycle_transition (P-040 §4.NEW2)
--
-- Append-only Option A per I-035: the lifecycle is DERIVED from this table's
-- latest-state row (ORDER BY transition_at DESC, id DESC). 11 allowed
-- (from_state, to_state, transition_reason) triples are enforced by a single
-- CHECK constraint matching SI-022 §6 normative state-machine table.
-- =============================================================================

CREATE TABLE crisis_event_lifecycle_transition (
    id                  BIGSERIAL PRIMARY KEY,
    tenant_id           TEXT NOT NULL REFERENCES tenants(id),
    crisis_event_id     UUID NOT NULL,
    from_state          TEXT NOT NULL CHECK (from_state IN (
        'none', 'detected', 'escalated', 'acknowledged', 'responded', 'resolved'
    )),
    to_state            TEXT NOT NULL CHECK (to_state IN (
        'detected', 'escalated', 'acknowledged', 'responded', 'resolved'
    )),
    transition_reason   TEXT NOT NULL CHECK (transition_reason IN (
        'initial_detection',
        'no_acknowledgement_timeout',
        'tier_progression_no_acknowledgement',
        'acknowledged_no_response_timeout',
        'responded_no_resolution_timeout',
        'response_failed',
        'clinician_acknowledgement',
        'clinician_response',
        'clinician_resolution'
    )),
    transition_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    actor_principal_id  UUID NULL,    -- null for system-triggered transitions (sweep escalations)
    transition_payload  JSONB NULL,
    -- 11 allowed (from_state, to_state, transition_reason) triples per SI-022 §6 normative table
    CONSTRAINT crisis_lifecycle_valid_transition CHECK (
        (from_state = 'none' AND to_state = 'detected' AND transition_reason = 'initial_detection')
        OR (from_state = 'detected' AND to_state = 'escalated' AND transition_reason = 'no_acknowledgement_timeout')
        OR (from_state = 'escalated' AND to_state = 'escalated' AND transition_reason = 'tier_progression_no_acknowledgement')
        OR (from_state = 'acknowledged' AND to_state = 'escalated' AND transition_reason = 'acknowledged_no_response_timeout')
        OR (from_state = 'responded' AND to_state = 'escalated' AND transition_reason = 'responded_no_resolution_timeout')
        OR (from_state = 'responded' AND to_state = 'escalated' AND transition_reason = 'response_failed')
        OR (from_state = 'detected' AND to_state = 'acknowledged' AND transition_reason = 'clinician_acknowledgement')
        OR (from_state = 'escalated' AND to_state = 'acknowledged' AND transition_reason = 'clinician_acknowledgement')
        OR (from_state = 'acknowledged' AND to_state = 'responded' AND transition_reason = 'clinician_response')
        OR (from_state = 'responded' AND to_state = 'resolved' AND transition_reason = 'clinician_resolution')
        OR (from_state = 'escalated' AND to_state = 'resolved' AND transition_reason = 'clinician_resolution')
    ),
    CONSTRAINT crisis_lifecycle_crisis_event_tenant_fk
        FOREIGN KEY (tenant_id, crisis_event_id) REFERENCES crisis_event(tenant_id, id)
);

ALTER TABLE crisis_event_lifecycle_transition ENABLE ROW LEVEL SECURITY;
ALTER TABLE crisis_event_lifecycle_transition FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON crisis_event_lifecycle_transition
    USING     (tenant_id = current_tenant_id())
    WITH CHECK (tenant_id = current_tenant_id());

-- Append-only per I-035 (audit-bound state machine)
CREATE OR REPLACE FUNCTION crisis_event_lifecycle_transition_block_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
    RAISE EXCEPTION
        'crisis_event_lifecycle_transition is append-only per I-035 (audit-bound state machine). '
        'UPDATE and DELETE are permanently prohibited. '
        'State changes are recorded as new rows; current state is derived from the latest row.';
END;
$$;

CREATE TRIGGER crisis_event_lifecycle_transition_block_update
    BEFORE UPDATE ON crisis_event_lifecycle_transition
    FOR EACH ROW
    EXECUTE FUNCTION crisis_event_lifecycle_transition_block_mutation();

CREATE TRIGGER crisis_event_lifecycle_transition_block_delete
    BEFORE DELETE ON crisis_event_lifecycle_transition
    FOR EACH ROW
    EXECUTE FUNCTION crisis_event_lifecycle_transition_block_mutation();

-- Monotonic-ordering invariant (per P-038 R2/R4 pattern adapted to code repo):
-- BEFORE INSERT trigger enforces NEW.transition_at >= MAX(prior.transition_at)
-- per (tenant_id, crisis_event_id) to prevent backdated rows from corrupting
-- current-state derivation. Future-dating tolerated up to 5s clock-skew.
CREATE OR REPLACE FUNCTION crisis_event_lifecycle_transition_enforce_monotonic_ordering()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER    -- runs under caller's privileges; reads same table caller is inserting into
SET search_path = pg_catalog, public
AS $$
DECLARE
    v_max_prior_transition_at TIMESTAMPTZ;
    v_max_clock_skew CONSTANT INTERVAL := INTERVAL '5 seconds';
BEGIN
    -- Future-dating bounded by 5s clock-skew tolerance
    IF NEW.transition_at > now() + v_max_clock_skew THEN
        RAISE EXCEPTION
            'crisis_event_lifecycle_transition future-dated: NEW.transition_at (%) > now() + 5s clock-skew tolerance (%)',
            NEW.transition_at, now() + v_max_clock_skew
            USING ERRCODE = '22008';    -- datetime_field_overflow
    END IF;

    -- Backdating rejected (NEW.transition_at >= MAX(prior.transition_at))
    SELECT MAX(transition_at) INTO v_max_prior_transition_at
      FROM public.crisis_event_lifecycle_transition
     WHERE tenant_id = NEW.tenant_id AND crisis_event_id = NEW.crisis_event_id;

    IF v_max_prior_transition_at IS NOT NULL
       AND NEW.transition_at < v_max_prior_transition_at THEN
        RAISE EXCEPTION
            'crisis_event_lifecycle_transition backdated: NEW.transition_at (%) is before MAX(prior.transition_at) (%) for crisis_event %',
            NEW.transition_at, v_max_prior_transition_at, NEW.crisis_event_id
            USING ERRCODE = '22008';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER crisis_event_lifecycle_transition_monotonic_ordering
    BEFORE INSERT ON crisis_event_lifecycle_transition
    FOR EACH ROW
    EXECUTE FUNCTION crisis_event_lifecycle_transition_enforce_monotonic_ordering();

CREATE INDEX crisis_event_lifecycle_event_transition_idx
    ON crisis_event_lifecycle_transition (tenant_id, crisis_event_id, transition_at DESC, id DESC);

-- =============================================================================
-- §7 — Crisis Response canonical: crisis_sweep_execution (P-040 §4.NEW3)
--
-- Durable per-sweep work-item table with lease-takeover + fencing-token
-- semantics. INTENTIONALLY MUTABLE on claim_by_worker_id / claim_expires_at /
-- heartbeat_at / completed_at / sweep_cycle_id_committed during open
-- lifecycle. Once completed_at + sweep_cycle_id_committed are set
-- atomically at STEP F (R47), the row is terminal and immutable
-- (enforced by terminal-row-immutable trigger).
-- =============================================================================

CREATE TABLE crisis_sweep_execution (
    sweep_execution_id                  UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id                           TEXT    NOT NULL REFERENCES tenants(id),
    crisis_event_id                     UUID    NOT NULL,
    scheduled_at                        TIMESTAMPTZ NOT NULL,
    scheduled_for_obligation_generation INTEGER NOT NULL,    -- R52 per-generation uniqueness
    claimed_by_worker_id                TEXT    NULL,
    claim_expires_at                    TIMESTAMPTZ NULL,
    fencing_token                       BIGINT  NOT NULL DEFAULT 1,    -- monotonic per-takeover token (R45)
    heartbeat_at                        TIMESTAMPTZ NULL,
    completed_at                        TIMESTAMPTZ NULL,
    sweep_cycle_id_committed            INTEGER NULL,    -- set atomically with completed_at at STEP F (R47)
    -- Completion coherence: completed_at non-null IFF sweep_cycle_id_committed non-null (R47)
    CONSTRAINT crisis_sweep_execution_completion_coherence CHECK (
        (completed_at IS NULL AND sweep_cycle_id_committed IS NULL)
        OR (completed_at IS NOT NULL AND sweep_cycle_id_committed IS NOT NULL)
    ),
    -- Composite tenant-scoped FK to crisis_event
    CONSTRAINT crisis_sweep_execution_event_tenant_fk
        FOREIGN KEY (tenant_id, crisis_event_id) REFERENCES crisis_event(tenant_id, id)
);

-- R52 per-obligation-generation uniqueness: partial UNIQUE constraint covers only
-- un-completed rows so multiple completed sweeps for the same logical generation
-- can coexist in the table (audit-trail durability) while concurrent scheduling
-- attempts for the same open generation are rejected at the constraint level.
CREATE UNIQUE INDEX crisis_sweep_execution_open_uk
    ON crisis_sweep_execution (tenant_id, crisis_event_id, scheduled_for_obligation_generation)
    WHERE completed_at IS NULL;

CREATE INDEX crisis_sweep_execution_scheduling_idx
    ON crisis_sweep_execution (scheduled_at)
    WHERE completed_at IS NULL;

CREATE INDEX crisis_sweep_execution_event_lookup_idx
    ON crisis_sweep_execution (tenant_id, crisis_event_id, scheduled_at DESC);

ALTER TABLE crisis_sweep_execution ENABLE ROW LEVEL SECURITY;
ALTER TABLE crisis_sweep_execution FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON crisis_sweep_execution
    USING     (tenant_id = current_tenant_id())
    WITH CHECK (tenant_id = current_tenant_id());

-- Terminal-row-immutable trigger: once completed_at is set, the row is terminal
-- and NO further mutation is permitted. This is enforced by per-table inline
-- trigger function (Option 2 — code-repo per-table pattern, not spec's generic
-- enforce_terminal_row_immutable() helper which doesn't exist in code repo yet).
CREATE OR REPLACE FUNCTION crisis_sweep_execution_terminal_immutable()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
    -- Fires only when OLD.completed_at IS NOT NULL (trigger WHEN clause).
    -- Reject ANY change to any column on a terminal row.
    RAISE EXCEPTION
        'crisis_sweep_execution row % is terminal (completed_at was already set at %); '
        'no further mutation is permitted per R47 STEP F triple-guarded commit semantics.',
        OLD.sweep_execution_id, OLD.completed_at;
END;
$$;

CREATE TRIGGER crisis_sweep_execution_terminal_immutable_check
    BEFORE UPDATE ON crisis_sweep_execution
    FOR EACH ROW
    WHEN (OLD.completed_at IS NOT NULL)
    EXECUTE FUNCTION crisis_sweep_execution_terminal_immutable();

-- DELETE blocked outright (durable per-sweep audit record per I-035 + R52)
CREATE OR REPLACE FUNCTION crisis_sweep_execution_block_delete()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
    RAISE EXCEPTION
        'crisis_sweep_execution rows are durable per I-035 + R52 audit-trail discipline; '
        'DELETE is permanently prohibited.';
END;
$$;

CREATE TRIGGER crisis_sweep_execution_block_delete_trigger
    BEFORE DELETE ON crisis_sweep_execution
    FOR EACH ROW
    EXECUTE FUNCTION crisis_sweep_execution_block_delete();

-- =============================================================================
-- §8 — Verification: count of net-new crisis_* + notification_crisis_* tables = 6
-- =============================================================================

DO $$
DECLARE
    v_created_count INTEGER;
    v_expected_count CONSTANT INTEGER := 6;
BEGIN
    SELECT COUNT(*) INTO v_created_count
      FROM pg_tables
     WHERE schemaname = 'public'
       AND tablename IN (
           'crisis_event',
           'crisis_event_lifecycle_transition',
           'crisis_sweep_execution',
           'notification_crisis_dispatch_ledger',
           'notification_crisis_provider_attempt',
           'notification_crisis_escalation_obligation'
       );

    IF v_created_count <> v_expected_count THEN
        RAISE EXCEPTION
            'migration-033-table-count-mismatch: '
            'expected % crisis/notification tables created, found %; '
            'P-040 §4.NEW1-NEW3 + §4.EXT1-EXT3 (adapted Option 2: inline baseline) require all 6',
            v_expected_count, v_created_count;
    END IF;

    -- Verify all 6 tables have RLS ENABLE + FORCE
    SELECT COUNT(*) INTO v_created_count
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relname IN (
           'crisis_event',
           'crisis_event_lifecycle_transition',
           'crisis_sweep_execution',
           'notification_crisis_dispatch_ledger',
           'notification_crisis_provider_attempt',
           'notification_crisis_escalation_obligation'
       )
       AND c.relrowsecurity = TRUE
       AND c.relforcerowsecurity = TRUE;

    IF v_created_count <> v_expected_count THEN
        RAISE EXCEPTION
            'migration-033-rls-enforcement-incomplete: '
            'expected all % tables to have ENABLE + FORCE RLS, found % compliant',
            v_expected_count, v_created_count;
    END IF;
END $$;
