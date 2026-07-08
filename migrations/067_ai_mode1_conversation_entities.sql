-- =============================================================================
-- File:    migrations/067_ai_mode1_conversation_entities.sql
-- Purpose: Create the 5 Mode 1 conversation persistence entities + the
--          ai_mode1_conversation_state PLAIN derived view per AI Service
--          Mode 1 Handler Spec v0.4 (RATIFIED P-035 2026-05-21) as
--          consolidated into the CDM v1.7 -> v1.8 follow-on amendment
--          (RATIFIED P-036 + P-036a;
--          `Telecheck_CDM_v1_7_to_v1_8_Amendment.md` Section 2 /
--          Section 4.NEW1-NEW6).
--
--          This is PR 2 of the Mode 1 persistence implementation series
--          (PR 1 = migration 066 RBAC roles foundation). Entities + view +
--          RLS + strict append-only triggers + the amendment's Section 4.NEW6
--          grant chain. The Mode 1 handler itself (turn admission writer,
--          crisis-detector wiring, LLM invocation, Fastify surface) is
--          explicitly out of the amendment's scope ("Mode 1 implementation in
--          telecheck-app code repo (Phase A foundation)") and lands in later
--          PRs; consequently NO INSERT grants are issued here -- the
--          amendment defines none, and the write path arrives with the Mode 1
--          handler PRs. Follows the Crisis Response (033) + Admin Backend
--          (040) + Med-Interaction (047) + Async Consult (056)
--          entities-migration cadence.
--
-- Option 2 adaptations from spec (recorded divergences; same class as the
-- migration 033/040/047/056 recorded divergences):
--   - tenant_id tenant_id_t -> TEXT NOT NULL REFERENCES tenants(id).
--   - RLS predicate current_tenant_id_strict('<entity>') -> current_tenant_id()
--     (code-repo pattern from migration 003) with USING + WITH CHECK; policy
--     name normalized to `tenant_isolation` per the 033/040/047/056 pattern.
--     This applies to the 5 table policies AND to the view-body WHERE
--     predicate in Section 6.
--   - enforce_append_only() generic -> per-table inline block_mutation
--     triggers (SECURITY DEFINER, locked search_path; migration 033/056
--     convention). Spec's single BEFORE UPDATE OR DELETE trigger becomes the
--     code-repo two-trigger form (block_update + block_delete) per table.
--   - Entity ids KEPT as UUID exactly as the ratified DDL declares
--     (id UUID DEFAULT gen_random_uuid(); turn_admission.id = client-generated
--     UUID idempotency key, no default). This matches the migration 033
--     UUID-for-UUID-spec precedent (crisis_event.id). Migration 056's
--     ULID -> VARCHAR(26) adaptation does NOT apply here: that adaptation was
--     for spec DDL typed ulid_t; the Mode 1 amendment DDL is natively UUID.
--   - SI-025 identity-model reconciliation (P-045, ratified 2026-06-01 --
--     POST-DATES P-036 and controls identity typing platform-wide):
--       * patient_id UUID REFERENCES patient(tenant_id, id)
--         -> patient_id VARCHAR(26) REFERENCES accounts(tenant_id, account_id).
--         (Canonical platform identity is accounts.account_id VARCHAR(26)
--         ULID; spec's `patient` entity does not exist in the code repo.
--         Matches consult.patient_id (056), crisis_event.patient_account_id
--         (053), medication_requests.patient_account_id (025). The
--         amendment's own R2 HIGH-1 note anticipated exactly this: "if
--         patient table doesn't yet have it, the implementation amendment
--         adds it as a baseline prerequisite per the canonical
--         tenant-isolation discipline" -- the code-repo baseline is accounts
--         with UNIQUE (tenant_id, account_id) from migration 012.)
--       * archived_by_user_id UUID -> VARCHAR(26) (actor identity per the
--         SI-025 convention; the spec declares NO FK on this column and none
--         is added -- matches the transition_by_actor_id no-FK precedent in
--         migrations 033/053/056).
--   - crisis_server_signal_id FK to i019_enqueue_ack_log(tenant_id, id)
--     DEFERRED (column kept UUID NULL; severity <-> signal correlation CHECK
--     kept verbatim; FK constraint NOT declared). No table named
--     i019_enqueue_ack_log exists in the code repo and there is no
--     established substitution precedent for it (the Crisis Response slice's
--     nearest surface is crisis_event UNIQUE (tenant_id, server_signal_id)
--     from migration 033, but that is the REVERSE-direction correlation --
--     crisis_event.server_signal_id points AT the Mode 1 signal, and 033
--     itself SKIPPED that FK "Mode 1 entities not in code repo"). The
--     amendment anticipates exactly this: "if naming differs from
--     i019_enqueue_ack_log, ratifier confirms canonical target table name +
--     adjust FK accordingly" (Section 4.NEW4 inline note). DEFERRED-FK TODO:
--     add the tenant-scoped composite FK (DEFERRABLE INITIALLY DEFERRED per
--     the amendment's R1 HIGH-2 closure) once the ratifier confirms the
--     code-repo canonical I-019 enqueue-ack target. Same deferral class as
--     migration 033's patient/server_signal FK skips and migration 041
--     Section 2's deferred views.
--   - Section 3 AUDIT_EVENTS action-ID CHECK amendment
--     (ALTER TABLE audit_events ... audit_events_action_id_check) has NO
--     code-repo surface: the code-repo audit table is audit_records
--     (migration 002) whose `action` column is TEXT with no enumerated CHECK
--     constraint -- action-ID validity is enforced at the app layer
--     (src audit emission path), matching every prior slice migration (none
--     of 033/040/047/056 altered an audit action CHECK). The 11 new action
--     IDs register at the app layer with the Mode 1 handler PRs.
--   - Section 5 CCR_RUNTIME `tenant.ai_provider` key is config-plane data
--     (ccr_configs rows, migration 018 schema), not schema DDL -- lands with
--     the Mode 1 handler / tenant-config PRs, not here.
--   - Section 7 jwt_migration_entity_status 6-row seed SKIPPED: the
--     migration-tracker table itself does not exist in the code repo
--     (established deferral precedent documented in migration 033: "seed
--     SKIPPED at v1.0 (the migration-tracker table itself doesn't exist;
--     added in future foundation hygiene cycle alongside SI-024.1 trust
--     anchor)"). DEFERRED-SEED TODO: when the foundation hygiene cycle lands
--     jwt_migration_entity_status, seed all 6 Mode 1 entries (5 tables + the
--     ai_mode1_conversation_state view per P-036a Evans Option A) with
--     phase_4_cutover_eligible=FALSE + raw_guc_fallback_audited=TRUE.
--
-- Preconditions: migrations 000-066 applied. Roles from migration 066
-- (ai_mode1_view_owner + ai_mode1_reader) exist -- preflighted in Section 0
-- below per the amendment's Section 6 DO-block assertion.
--
-- Invariants: I-023 (tenant isolation; composite tenant-scoped FKs on every
-- child edge per amendment R1/R2/R4 closures), I-027 (audit tenancy --
-- handler layer), I-035 (strict append-only on ALL 5 entities), I-019
-- (crisis-detection floor: detector_result severity <-> signal correlation
-- CHECK), I-026 (user_message / assistant_message KMS-encrypted at rest --
-- handler-layer envelope; columns are TEXT per the ratified DDL).
-- =============================================================================

-- =============================================================================
-- Section 0 -- Deployment prerequisites preflight (P-036 Section 6, adapted)
-- =============================================================================

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ai_mode1_view_owner') THEN
        RAISE EXCEPTION 'migration-067-prerequisite-missing: ai_mode1_view_owner role missing (apply migration 066 first; required for Mode 1 derived view ownership per the post-R7 plain-view design: view-owner-privileged base-table reads + explicit tenant predicate in view body)'
            USING ERRCODE = 'undefined_object';
    END IF;
    IF (SELECT rolbypassrls FROM pg_roles WHERE rolname = 'ai_mode1_view_owner') THEN
        RAISE EXCEPTION 'migration-067-preflight: ai_mode1_view_owner has BYPASSRLS attribute; must be revoked before view ownership assignment per Mode 1 spec R7 HIGH-1 closure'
            USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ai_mode1_reader') THEN
        RAISE EXCEPTION 'migration-067-prerequisite-missing: ai_mode1_reader role missing (apply migration 066 first; required for Mode 1 derived view SELECT grants)'
            USING ERRCODE = 'undefined_object';
    END IF;
END $$;

-- =============================================================================
-- Section 1 -- ai_mode1_conversation (CDM v1.8 Section 4.NEW1; Mode 1 spec
--      Section 6.1 entity 1)
--
-- Conversation envelope; 1 row per conversation; durable identity; immutable
-- post-INSERT (strict append-only per I-035). P1 patient-bound per the SI-018
-- partition rule.
-- =============================================================================

CREATE TABLE ai_mode1_conversation (
    id          UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   TEXT         NOT NULL REFERENCES tenants(id),
    patient_id  VARCHAR(26)  NOT NULL,
    created_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
    CONSTRAINT ai_mode1_conversation_tenant_check CHECK (tenant_id IS NOT NULL),
    -- R2 HIGH-1 closure 2026-05-21: composite tenant-scoped patient FK
    -- (SI-025 adaptation: spec's patient(tenant_id, id) -> code-repo
    -- canonical accounts(tenant_id, account_id), UNIQUE from migration 012).
    CONSTRAINT ai_mode1_conversation_patient_tenant_fk
        FOREIGN KEY (tenant_id, patient_id)
        REFERENCES accounts (tenant_id, account_id),
    CONSTRAINT ai_mode1_conversation_tenant_id_unique UNIQUE (tenant_id, id),
    -- R2 HIGH-2 closure 2026-05-21: composite UNIQUE including patient_id
    -- enables downstream composite FKs from turn_admission + turn_result to
    -- enforce patient identity propagation.
    CONSTRAINT ai_mode1_conversation_tenant_id_patient_unique UNIQUE (tenant_id, id, patient_id)
);

ALTER TABLE ai_mode1_conversation ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_mode1_conversation FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON ai_mode1_conversation
    USING     (tenant_id = current_tenant_id())
    WITH CHECK (tenant_id = current_tenant_id());

CREATE OR REPLACE FUNCTION ai_mode1_conversation_block_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
    RAISE EXCEPTION
        'ai_mode1_conversation is append-only per I-035/I-027 (Mode 1 conversation '
        'envelope; durable identity, immutable post-INSERT). '
        'UPDATE and DELETE are permanently prohibited.';
END;
$$;

CREATE TRIGGER ai_mode1_conversation_block_update
    BEFORE UPDATE ON ai_mode1_conversation
    FOR EACH ROW
    EXECUTE FUNCTION ai_mode1_conversation_block_mutation();

CREATE TRIGGER ai_mode1_conversation_block_delete
    BEFORE DELETE ON ai_mode1_conversation
    FOR EACH ROW
    EXECUTE FUNCTION ai_mode1_conversation_block_mutation();

-- =============================================================================
-- Section 2 -- ai_mode1_conversation_archival_event (CDM v1.8 Section 4.NEW2;
--      Mode 1 spec Section 6.1 entity 2)
--
-- Append-only archival event log; 1 row per archival event (at most one per
-- conversation per the spec UNIQUE); composite tenant-scoped FK to
-- ai_mode1_conversation.
-- =============================================================================

CREATE TABLE ai_mode1_conversation_archival_event (
    id                    UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id             TEXT         NOT NULL REFERENCES tenants(id),
    conversation_id       UUID         NOT NULL,
    archived_at           TIMESTAMPTZ  NOT NULL DEFAULT now(),
    -- SI-025 adaptation: UUID -> VARCHAR(26) actor identity; NO FK per the
    -- ratified DDL (none declared there; none added).
    archived_by_user_id   VARCHAR(26)  NOT NULL,
    archival_reason       TEXT         NOT NULL CHECK (archival_reason IN (
        'patient_retention_policy', 'patient_request', 'tenant_disable'
    )),
    CONSTRAINT ai_mode1_conversation_archival_unique UNIQUE (conversation_id),
    -- R4 MED-1 closure: composite FK enforces tenant_id matches the
    -- conversation's tenant_id.
    CONSTRAINT ai_mode1_conversation_archival_tenant_fk
        FOREIGN KEY (tenant_id, conversation_id)
        REFERENCES ai_mode1_conversation (tenant_id, id)
);

ALTER TABLE ai_mode1_conversation_archival_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_mode1_conversation_archival_event FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON ai_mode1_conversation_archival_event
    USING     (tenant_id = current_tenant_id())
    WITH CHECK (tenant_id = current_tenant_id());

CREATE OR REPLACE FUNCTION ai_mode1_conversation_archival_event_block_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
    RAISE EXCEPTION
        'ai_mode1_conversation_archival_event is append-only per I-035. '
        'UPDATE and DELETE are permanently prohibited.';
END;
$$;

CREATE TRIGGER ai_mode1_conversation_archival_event_block_update
    BEFORE UPDATE ON ai_mode1_conversation_archival_event
    FOR EACH ROW
    EXECUTE FUNCTION ai_mode1_conversation_archival_event_block_mutation();

CREATE TRIGGER ai_mode1_conversation_archival_event_block_delete
    BEFORE DELETE ON ai_mode1_conversation_archival_event
    FOR EACH ROW
    EXECUTE FUNCTION ai_mode1_conversation_archival_event_block_mutation();

-- =============================================================================
-- Section 3 -- ai_mode1_conversation_turn_admission (CDM v1.8 Section 4.NEW3;
--      Mode 1 spec Section 6.1 entity 3)
--
-- Immutable turn admission record; 1 row per turn at admission. id = turn_id
-- (client-generated UUID; idempotency key -- no DB default, per ratified DDL).
-- =============================================================================

CREATE TABLE ai_mode1_conversation_turn_admission (
    id                                UUID         PRIMARY KEY,             -- = turn_id (client-generated UUID; idempotency key)
    tenant_id                         TEXT         NOT NULL REFERENCES tenants(id),
    conversation_id                   UUID         NOT NULL,
    patient_id                        VARCHAR(26)  NOT NULL,
    user_message                      TEXT         NOT NULL,                -- KMS-encrypted at rest per I-026 (handler-layer envelope)
    request_body_hash                 BYTEA        NOT NULL,                -- SHA-256 of canonicalized request body
    history_snapshot_high_water_mark  TIMESTAMPTZ  NOT NULL,
    conversation_history_window       INT          NOT NULL CHECK (conversation_history_window > 0 AND conversation_history_window <= 50),
    client_capabilities               JSONB,
    admitted_at                       TIMESTAMPTZ  NOT NULL DEFAULT now(),
    -- R1 HIGH-1 closure 2026-05-21: composite tenant-scoped FK enforces
    -- tenant_id matches the conversation's tenant_id.
    -- R2 HIGH-2 closure 2026-05-21: composite (tenant_id, conversation_id,
    -- patient_id) FK to conversation enforces patient_id propagates correctly
    -- from the conversation row (preventing an admission row claiming a
    -- different patient than the conversation it belongs to).
    CONSTRAINT ai_mode1_conversation_turn_admission_conversation_patient_fk
        FOREIGN KEY (tenant_id, conversation_id, patient_id)
        REFERENCES ai_mode1_conversation (tenant_id, id, patient_id),
    -- R2 HIGH-1 closure 2026-05-21: composite tenant-scoped patient FK
    -- (SI-025 adaptation: patient -> accounts).
    CONSTRAINT ai_mode1_conversation_turn_admission_patient_tenant_fk
        FOREIGN KEY (tenant_id, patient_id)
        REFERENCES accounts (tenant_id, account_id),
    CONSTRAINT ai_mode1_conversation_turn_admission_unique UNIQUE (tenant_id, conversation_id, id),
    -- Composite UNIQUE on (tenant_id, id) needed for downstream composite FKs
    -- from detector_result.
    CONSTRAINT ai_mode1_conversation_turn_admission_tenant_id_unique UNIQUE (tenant_id, id),
    -- Composite UNIQUE including patient_id enables downstream turn_result
    -- composite FK.
    CONSTRAINT ai_mode1_conversation_turn_admission_tenant_id_patient_unique UNIQUE (tenant_id, id, patient_id),
    -- R4 HIGH-1 closure 2026-05-21: composite UNIQUE including
    -- conversation_id + patient_id enables the downstream turn_result FK
    -- enforcing conversation identity propagation from admission row through
    -- to result row (preventing a result row binding a turn to a different
    -- conversation for the same patient even when individual
    -- (tenant_id, turn_id) + (tenant_id, conversation_id) FKs would pass).
    CONSTRAINT ai_mode1_conversation_turn_admission_tenant_id_conv_patient_unique
        UNIQUE (tenant_id, id, conversation_id, patient_id)
);

CREATE INDEX ai_mode1_conversation_turn_admission_lookup_idx
    ON ai_mode1_conversation_turn_admission (tenant_id, conversation_id, admitted_at DESC);

ALTER TABLE ai_mode1_conversation_turn_admission ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_mode1_conversation_turn_admission FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON ai_mode1_conversation_turn_admission
    USING     (tenant_id = current_tenant_id())
    WITH CHECK (tenant_id = current_tenant_id());

CREATE OR REPLACE FUNCTION ai_mode1_conversation_turn_admission_block_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
    RAISE EXCEPTION
        'ai_mode1_conversation_turn_admission is append-only per I-035 (immutable '
        'turn admission record; replay-safe idempotency anchor). '
        'UPDATE and DELETE are permanently prohibited.';
END;
$$;

CREATE TRIGGER ai_mode1_conversation_turn_admission_block_update
    BEFORE UPDATE ON ai_mode1_conversation_turn_admission
    FOR EACH ROW
    EXECUTE FUNCTION ai_mode1_conversation_turn_admission_block_mutation();

CREATE TRIGGER ai_mode1_conversation_turn_admission_block_delete
    BEFORE DELETE ON ai_mode1_conversation_turn_admission
    FOR EACH ROW
    EXECUTE FUNCTION ai_mode1_conversation_turn_admission_block_mutation();

-- =============================================================================
-- Section 4 -- ai_mode1_conversation_turn_detector_result (CDM v1.8
--      Section 4.NEW4; Mode 1 spec Section 6.1 entity 4)
--
-- Immutable detector result; 1 row per turn after the crisis detector
-- completes; the EXISTENCE of this row IS the canonical "detector_completed"
-- state in the runtime state machine (Mode 1 spec Section 4.2 R1 HIGH-1:
-- llm.invoke() without this row is an invariant violation).
-- =============================================================================

CREATE TABLE ai_mode1_conversation_turn_detector_result (
    turn_id                  UUID         PRIMARY KEY,
    tenant_id                TEXT         NOT NULL REFERENCES tenants(id),
    detector_version         TEXT         NOT NULL,
    severity                 TEXT         CHECK (severity IS NULL OR severity IN (
        'self_harm', 'imminent_harm', 'medical_emergency'
    )),
    -- Set IFF severity NOT NULL. Spec FK target i019_enqueue_ack_log
    -- (tenant-scoped, DEFERRABLE INITIALLY DEFERRED per R1 HIGH-2) is
    -- DEFERRED -- no such table exists in the code repo and no substitution
    -- precedent is established; the amendment's own Section 4.NEW4 note
    -- says "ratifier confirms canonical target table name + adjust FK
    -- accordingly". DEFERRED-FK TODO: add
    --   CONSTRAINT ai_mode1_conversation_turn_detector_result_signal_fk
    --       FOREIGN KEY (tenant_id, crisis_server_signal_id)
    --       REFERENCES <ratifier-confirmed I-019 enqueue-ack table> (tenant_id, id)
    --       DEFERRABLE INITIALLY DEFERRED
    -- once the target lands / is confirmed (nearest existing surface:
    -- crisis_event UNIQUE (tenant_id, server_signal_id), migration 033 --
    -- but that is the reverse-direction correlation, not the ack log).
    crisis_server_signal_id  UUID,
    detector_latency_ms      INT          NOT NULL CHECK (detector_latency_ms >= 0),
    completed_at             TIMESTAMPTZ  NOT NULL DEFAULT now(),
    -- R1 HIGH-1 closure 2026-05-21: composite tenant-scoped FK to the
    -- admission row.
    CONSTRAINT ai_mode1_conversation_turn_detector_result_admission_fk
        FOREIGN KEY (tenant_id, turn_id)
        REFERENCES ai_mode1_conversation_turn_admission (tenant_id, id),
    -- Crisis severity <-> signal_id correlation invariant (I-019 floor):
    CONSTRAINT ai_mode1_conversation_turn_detector_result_signal_iff_severity CHECK (
        (severity IS NULL AND crisis_server_signal_id IS NULL)
        OR (severity IS NOT NULL AND crisis_server_signal_id IS NOT NULL)
    )
);

ALTER TABLE ai_mode1_conversation_turn_detector_result ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_mode1_conversation_turn_detector_result FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON ai_mode1_conversation_turn_detector_result
    USING     (tenant_id = current_tenant_id())
    WITH CHECK (tenant_id = current_tenant_id());

CREATE OR REPLACE FUNCTION ai_mode1_conversation_turn_detector_result_block_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
    RAISE EXCEPTION
        'ai_mode1_conversation_turn_detector_result is append-only per I-035 '
        '(the existence of this row IS the canonical detector_completed state; '
        'I-019 forensic anchor). UPDATE and DELETE are permanently prohibited.';
END;
$$;

CREATE TRIGGER ai_mode1_conversation_turn_detector_result_block_update
    BEFORE UPDATE ON ai_mode1_conversation_turn_detector_result
    FOR EACH ROW
    EXECUTE FUNCTION ai_mode1_conversation_turn_detector_result_block_mutation();

CREATE TRIGGER ai_mode1_conversation_turn_detector_result_block_delete
    BEFORE DELETE ON ai_mode1_conversation_turn_detector_result
    FOR EACH ROW
    EXECUTE FUNCTION ai_mode1_conversation_turn_detector_result_block_mutation();

-- =============================================================================
-- Section 5 -- ai_mode1_conversation_turn_result (CDM v1.8 Section 4.NEW5;
--      Mode 1 spec Section 6.1 entity 5)
--
-- Immutable turn result; 1 row per turn at completion or failure; the
-- existence of this row IS the canonical terminal state.
-- =============================================================================

CREATE TABLE ai_mode1_conversation_turn_result (
    turn_id                 UUID         PRIMARY KEY,
    tenant_id               TEXT         NOT NULL REFERENCES tenants(id),
    conversation_id         UUID         NOT NULL,
    patient_id              VARCHAR(26)  NOT NULL,
    assistant_message       TEXT,                                           -- KMS-encrypted at rest per I-026; null IFF turn_outcome='failed'
    provider                TEXT,                                           -- null IFF turn failed pre-LLM
    model_id                TEXT,
    prompt_token_count      INT          CHECK (prompt_token_count IS NULL OR prompt_token_count >= 0),
    completion_token_count  INT          CHECK (completion_token_count IS NULL OR completion_token_count >= 0),
    total_latency_ms        INT          NOT NULL CHECK (total_latency_ms >= 0),
    turn_outcome            TEXT         NOT NULL CHECK (turn_outcome IN ('completed', 'failed')),
    failure_class           TEXT         CHECK (failure_class IS NULL OR failure_class IN (
        'llm_provider_unavailable', 'crisis_detector_unavailable',
        'internal_error', 'crisis_signal_enqueue_failed'
    )),
    failure_phase           TEXT         CHECK (failure_phase IS NULL OR failure_phase IN (
        'pre_detector', 'pre_llm', 'during_llm', 'post_llm'
    )),
    completed_at            TIMESTAMPTZ  NOT NULL DEFAULT now(),
    -- R4 HIGH-1 closure 2026-05-21: single 4-column composite FK to admission
    -- replaces the two separate composite FKs -- it ALSO enforces
    -- conversation_id propagation (admission.id, admission.conversation_id,
    -- admission.patient_id must all match the result row in one constraint).
    -- Patient_id propagation conversation -> admission is enforced by the
    -- admission's own FK to conversation (R2 HIGH-2), so the chain
    -- conversation -> admission -> result is fully closed.
    CONSTRAINT ai_mode1_conversation_turn_result_admission_full_fk
        FOREIGN KEY (tenant_id, turn_id, conversation_id, patient_id)
        REFERENCES ai_mode1_conversation_turn_admission (tenant_id, id, conversation_id, patient_id),
    -- R2 HIGH-1 closure 2026-05-21: composite tenant-scoped patient FK
    -- (SI-025 adaptation: patient -> accounts).
    CONSTRAINT ai_mode1_conversation_turn_result_patient_tenant_fk
        FOREIGN KEY (tenant_id, patient_id)
        REFERENCES accounts (tenant_id, account_id),
    -- Outcome <-> failure correlation invariants
    CONSTRAINT ai_mode1_conversation_turn_result_completed_no_failure CHECK (
        (turn_outcome = 'completed' AND failure_class IS NULL AND failure_phase IS NULL AND assistant_message IS NOT NULL)
        OR
        (turn_outcome = 'failed' AND failure_class IS NOT NULL AND failure_phase IS NOT NULL AND assistant_message IS NULL)
    )
);

CREATE INDEX ai_mode1_conversation_turn_result_history_idx
    ON ai_mode1_conversation_turn_result (tenant_id, conversation_id, completed_at DESC);

ALTER TABLE ai_mode1_conversation_turn_result ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_mode1_conversation_turn_result FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON ai_mode1_conversation_turn_result
    USING     (tenant_id = current_tenant_id())
    WITH CHECK (tenant_id = current_tenant_id());

CREATE OR REPLACE FUNCTION ai_mode1_conversation_turn_result_block_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
    RAISE EXCEPTION
        'ai_mode1_conversation_turn_result is append-only per I-035 (the existence '
        'of this row IS the canonical terminal state; split-table INSERT-only model). '
        'UPDATE and DELETE are permanently prohibited.';
END;
$$;

CREATE TRIGGER ai_mode1_conversation_turn_result_block_update
    BEFORE UPDATE ON ai_mode1_conversation_turn_result
    FOR EACH ROW
    EXECUTE FUNCTION ai_mode1_conversation_turn_result_block_mutation();

CREATE TRIGGER ai_mode1_conversation_turn_result_block_delete
    BEFORE DELETE ON ai_mode1_conversation_turn_result
    FOR EACH ROW
    EXECUTE FUNCTION ai_mode1_conversation_turn_result_block_mutation();

-- =============================================================================
-- Section 6 -- ai_mode1_conversation_state (CDM v1.8 Section 4.NEW6 derived
--      view; Mode 1 spec Section 6.1 view; R7 HIGH-1 closure; post-P-042
--      audit Finding 3 closure)
--
-- PLAIN derived view (no security_invoker clause) computing last_turn_at +
-- is_archived + archived_at from the base tables. Tenant isolation is
-- enforced via the explicit WHERE predicate in the view body using the
-- CALLING SESSION's GUC (Option 2: current_tenant_id(), migration 003 --
-- adapting spec's current_tenant_id_strict('ai_mode1_conversation_state')),
-- even though base-table queries run with the OWNER's privileges
-- (ai_mode1_view_owner, non-BYPASSRLS -- so base-table RLS ALSO applies to
-- the owner as defense-in-depth). The post-R7 design intentionally REPLACED
-- security_invoker with plain-view + explicit-predicate + view-owner
-- privileges to enforce data-minimization on per-turn timestamps:
-- ai_mode1_reader sees ONLY the view's MAX/EXISTS aggregates and can never
-- enumerate per-turn or per-archival rows (amendment R6 + R7 closures).
-- =============================================================================

CREATE VIEW ai_mode1_conversation_state AS
SELECT
    c.id AS conversation_id,
    c.tenant_id,
    c.patient_id,
    c.created_at,
    (SELECT MAX(r.completed_at) FROM ai_mode1_conversation_turn_result r
     WHERE r.tenant_id = c.tenant_id AND r.conversation_id = c.id) AS last_turn_at,
    EXISTS (SELECT 1 FROM ai_mode1_conversation_archival_event a
            WHERE a.tenant_id = c.tenant_id AND a.conversation_id = c.id) AS is_archived,
    (SELECT MAX(a.archived_at) FROM ai_mode1_conversation_archival_event a
     WHERE a.tenant_id = c.tenant_id AND a.conversation_id = c.id) AS archived_at
FROM ai_mode1_conversation c
WHERE c.tenant_id = current_tenant_id();

ALTER VIEW ai_mode1_conversation_state OWNER TO ai_mode1_view_owner;  -- non-BYPASSRLS role (preflighted in Section 0)
REVOKE ALL ON ai_mode1_conversation_state FROM PUBLIC;
GRANT SELECT ON ai_mode1_conversation_state TO ai_mode1_reader;

-- Owner-only base-table grants (R7 HIGH-1 closure): ai_mode1_view_owner needs
-- SELECT on exactly the columns the view body reads to compute the
-- aggregates; ai_mode1_reader has NO base-table access (cannot bypass the
-- view's aggregation). Explicitly NOT granted user_message +
-- assistant_message + other message-bearing columns even at the owner level
-- -- least-privilege all the way down.
GRANT SELECT (id, tenant_id, patient_id, created_at) ON ai_mode1_conversation TO ai_mode1_view_owner;
GRANT SELECT (tenant_id, conversation_id, completed_at) ON ai_mode1_conversation_turn_result TO ai_mode1_view_owner;
GRANT SELECT (tenant_id, conversation_id, archived_at) ON ai_mode1_conversation_archival_event TO ai_mode1_view_owner;
-- Defense-in-depth: ai_mode1_reader has SELECT on the view ONLY. The view
-- computes aggregates; ai_mode1_reader sees: conversation_id, tenant_id,
-- patient_id, created_at, last_turn_at (MAX), is_archived (EXISTS),
-- archived_at (MAX). ai_mode1_reader CANNOT enumerate per-turn rows or
-- per-archival rows directly; CANNOT see message-bearing columns; CANNOT
-- query base tables at all.

-- =============================================================================
-- Section 7 -- jwt_migration_entity_status seed (P-036 Section 7 + P-036a
--      Evans Option A: 6 entries = 5 tables + the state view)
--
-- SKIPPED: the jwt_migration_entity_status migration-tracker table does not
-- exist in the code repo (established deferral precedent: migration 033
-- header -- "seed SKIPPED at v1.0 (the migration-tracker table itself doesn't
-- exist; added in future foundation hygiene cycle alongside SI-024.1 trust
-- anchor)"). DEFERRED-SEED TODO -- when the tracker table lands, seed:
--
--   INSERT INTO jwt_migration_entity_status (entity_name, phase_4_cutover_eligible, raw_guc_fallback_audited)
--   VALUES
--       ('ai_mode1_conversation',                      FALSE, TRUE),
--       ('ai_mode1_conversation_archival_event',       FALSE, TRUE),
--       ('ai_mode1_conversation_turn_admission',       FALSE, TRUE),
--       ('ai_mode1_conversation_turn_detector_result', FALSE, TRUE),
--       ('ai_mode1_conversation_turn_result',          FALSE, TRUE),
--       ('ai_mode1_conversation_state',                FALSE, TRUE);
--
-- (P-036a cross-slice fix: the view IS included -- post-R7 it carries an
-- explicit tenant-binding predicate in its body and is therefore a tracked
-- migration surface, matching the P-038/P-040/P-042 seed-the-views pattern.)
-- =============================================================================

-- =============================================================================
-- Section 8 -- Verification (matches migration 033/040/047/056 closing-check
--      pattern + the amendment's Section 6 preflight assertions)
-- =============================================================================

DO $$
DECLARE
    v_table TEXT;
    v_tables TEXT[] := ARRAY[
        'ai_mode1_conversation',
        'ai_mode1_conversation_archival_event',
        'ai_mode1_conversation_turn_admission',
        'ai_mode1_conversation_turn_detector_result',
        'ai_mode1_conversation_turn_result'
    ];
    v_count INTEGER;
BEGIN
    -- All 5 tables exist with RLS FORCED
    FOREACH v_table IN ARRAY v_tables LOOP
        IF NOT EXISTS (
            SELECT 1 FROM pg_class c
            JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = 'public' AND c.relname = v_table
              AND c.relrowsecurity AND c.relforcerowsecurity
        ) THEN
            RAISE EXCEPTION 'migration-067-verification: table % missing or RLS not FORCED', v_table
                USING ERRCODE = 'check_violation';
        END IF;
    END LOOP;

    -- Every table has a tenant_isolation policy
    SELECT COUNT(*) INTO v_count
      FROM pg_policies
     WHERE schemaname = 'public'
       AND tablename = ANY (v_tables)
       AND policyname = 'tenant_isolation';
    IF v_count <> 5 THEN
        RAISE EXCEPTION 'migration-067-verification: expected 5 tenant_isolation policies, found %', v_count
            USING ERRCODE = 'check_violation';
    END IF;

    -- Append-only triggers present (2 block triggers per strict table = 10)
    SELECT COUNT(*) INTO v_count
      FROM pg_trigger t
      JOIN pg_class c ON c.oid = t.tgrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relname = ANY (v_tables)
       AND NOT t.tgisinternal;
    IF v_count <> 10 THEN
        RAISE EXCEPTION 'migration-067-verification: expected 10 append-only triggers across the 5 tables, found %', v_count
            USING ERRCODE = 'check_violation';
    END IF;

    -- The derived view exists and is owned by ai_mode1_view_owner
    IF NOT EXISTS (
        SELECT 1 FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        JOIN pg_roles r ON r.oid = c.relowner
        WHERE n.nspname = 'public'
          AND c.relname = 'ai_mode1_conversation_state'
          AND c.relkind = 'v'
          AND r.rolname = 'ai_mode1_view_owner'
    ) THEN
        RAISE EXCEPTION 'migration-067-verification: ai_mode1_conversation_state view missing or not owned by ai_mode1_view_owner'
            USING ERRCODE = 'check_violation';
    END IF;

    -- View owner must remain non-BYPASSRLS post-ownership-assignment
    IF (SELECT rolbypassrls FROM pg_roles WHERE rolname = 'ai_mode1_view_owner') THEN
        RAISE EXCEPTION 'migration-067-verification: ai_mode1_view_owner has BYPASSRLS after view ownership assignment; forbidden per Mode 1 spec R7 HIGH-1 closure'
            USING ERRCODE = 'insufficient_privilege';
    END IF;

    -- ai_mode1_reader: SELECT on the view, NO table-level SELECT on any base
    -- table (column-level grants to the reader would not show here, but none
    -- are issued in this migration -- the amendment's R6/R7 closures assign
    -- base-table access to the OWNER only).
    IF NOT has_table_privilege('ai_mode1_reader', 'public.ai_mode1_conversation_state', 'SELECT') THEN
        RAISE EXCEPTION 'migration-067-verification: ai_mode1_reader lacks SELECT on ai_mode1_conversation_state'
            USING ERRCODE = 'check_violation';
    END IF;
    FOREACH v_table IN ARRAY v_tables LOOP
        IF has_table_privilege('ai_mode1_reader', 'public.' || v_table, 'SELECT') THEN
            RAISE EXCEPTION 'migration-067-verification: ai_mode1_reader has base-table SELECT on % -- violates the R6/R7 data-minimization boundary (view-only access)', v_table
                USING ERRCODE = 'check_violation';
        END IF;
    END LOOP;
END $$;
