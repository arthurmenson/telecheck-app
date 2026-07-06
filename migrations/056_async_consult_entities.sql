-- =============================================================================
-- File:    migrations/056_async_consult_entities.sql
-- Purpose: Create the 7 Async Consult Sprint-10 entities per SI-020 v0.11
--          (RATIFIED P-037 2026-05-21) as consolidated into the CDM v1.8 → v1.9
--          follow-on amendment (RATIFIED P-038 2026-05-21;
--          `Telecheck_CDM_v1_8_to_v1_9_Amendment.md` §2 / §4.NEW1–NEW7).
--
--          This is PR 2 of the Async Consult Sprint-10 implementation series
--          (PR 1 = migration 055 RBAC roles foundation). Entities only:
--          7 tables + RLS + append-only / hybrid-persistence triggers +
--          invariant-enforcing BEFORE INSERT triggers + wrapper-owner grants.
--          Views + MV land in PR 3; raw lifecycle writer PR 4; wrapper
--          procedures PR 5; Fastify handlers PR 6+. Follows the Crisis
--          Response (033) + Admin Backend (040) + Med-Interaction (047)
--          entities-migration cadence.
--
-- Option 2 adaptations from spec (recorded divergences; same class as the
-- migration 033/040/047 recorded divergences):
--   - id ULID → VARCHAR(26), app-generated (no DB default).
--   - tenant_id tenant_id_t → TEXT NOT NULL REFERENCES tenants(id).
--   - RLS predicate current_tenant_id_strict('<entity>') → current_tenant_id()
--     (code-repo pattern from migration 003) with USING + WITH CHECK.
--   - enforce_append_only() generic → per-table inline block_mutation triggers.
--   - KMS envelope dek_id UUID → VARCHAR(26) (migration 047 §3 convention).
--   - SI-025 identity-model reconciliation (P-045, ratified 2026-06-01 —
--     POST-DATES P-038 and controls identity typing platform-wide):
--       * patient_id UUID REFERENCES patient(tenant_id, id)
--         → patient_id VARCHAR(26) REFERENCES accounts(tenant_id, account_id).
--         (Canonical platform identity is accounts.account_id VARCHAR(26) ULID;
--         spec's `patient` entity does not exist in the code repo. Matches
--         consults.patient_id (020), forms_submission.patient_id (006/012),
--         medication_requests.patient_account_id (025), and the SI-025
--         crisis_event.patient_account_id remediation (053).)
--       * clinician_account_id UUID REFERENCES
--         tenant_account_membership(tenant_id, account_id)
--         → VARCHAR(26) REFERENCES accounts(tenant_id, account_id).
--         (P-038 §12 OQ3 anticipated exactly this: "the exact canonical entity
--         name ... may differ"; the code-repo canonical tenant-scoped account
--         membership table IS accounts with UNIQUE (tenant_id, account_id)
--         from migration 012. Same resolution as migration 047 §3
--         override_by_clinician_account_id.)
--       * delegate_id / sender_account_id / transition_by_actor_id UUID
--         → VARCHAR(26) (actor identity; transition_by_actor_id keeps NO FK —
--         NULL for system/scheduler transitions, per crisis
--         actor_principal_id precedent in migrations 033/053).
--   - program_id UUID REFERENCES program(tenant_id, id) → TEXT NULL, no FK
--     (no program table in code repo; program_id widened to TEXT by
--     migration 010; forms layer treats program_id as opaque TEXT).
--   - payment_intent_id UUID REFERENCES billing_payment_intent(tenant_id, id)
--     → VARCHAR(26) NOT NULL, NO FK. Billing slice canonical entities are
--     explicitly out of P-038 scope ("entity defined in Billing Slice
--     canonical scope") and the table does not exist yet. DEFERRED-FK TODO:
--     add composite FK when the Billing slice lands its payment-intent
--     entity. Wrapper-layer validation (PR 5) enforces tenant-coherence
--     until then.
--   - prescription_details_id / referral_target_id UUID → VARCHAR(26) NULL,
--     no FK (polymorphic / cross-slice per P-038 §12 OQ2 posture: opaque for
--     now; hard FK at the next Med-Interaction / Pharmacy follow-on).
--   - interaction_signals_reviewed_ids UUID[] → VARCHAR(26)[] (matches 047
--     medications_involved VARCHAR(26)[]).
--   - Invariant-enforcing BEFORE INSERT triggers use SECURITY INVOKER +
--     transaction-scoped advisory lock (md5-derived bigint key) + plain
--     SELECT under the lock — NOT spec's SELECT ... FOR UPDATE. The advisory
--     lock provides the serialization (all claim mutations in PR-5 wrappers
--     MUST take the same lock key before touching claim rows), and dropping
--     FOR UPDATE avoids granting UPDATE on consult_review_claim to the
--     decision writer. Matches the migration 033 §6 monotonic-ordering
--     trigger pattern (R1 MED-1 closure there).
--   - Lock-order discipline (deadlock avoidance, documented for PR 4/5):
--     when a single transaction needs both locks, acquire
--     'consult_review_claim:<tenant>:<consult>' BEFORE
--     'consult_lifecycle_transition:<tenant>:<consult>'. The spec'd write
--     order (decision row FIRST, transition row SECOND) yields this order
--     naturally.
--
-- Preconditions: migrations 000–055 applied. Roles from migration 055
-- (13 async-consult roles) exist — preflighted in §0 below per P-038 §10.
--
-- Invariants: I-023 (tenant isolation; composite tenant-scoped FKs),
-- I-026 (KMS envelope on 4 PHI column groups), I-027 (audit tenancy —
-- handler layer), I-035 (append-only; hybrid persistence on
-- consult_review_claim per P-037 R4 closure).
-- =============================================================================

-- =============================================================================
-- §0 — Deployment prerequisites preflight (P-038 §10, adapted)
-- =============================================================================

DO $$
DECLARE
    v_missing_roles TEXT := '';
    v_required_roles TEXT[] := ARRAY[
        'consult_lifecycle_transition_writer_owner',
        'consult_initiation_wrapper_owner',
        'consult_intake_wrapper_owner',
        'consult_ai_preparation_wrapper_owner',
        'consult_claim_wrapper_owner',
        'record_consult_decision_wrapper_owner',
        'async_consult_view_owner',
        'async_consult_mv_refresh_owner',
        'async_consult_patient_initiator',
        'async_consult_delegate_initiator',
        'async_consult_clinician_reviewer',
        'async_consult_patient_reader',
        'async_consult_staff_reader'
    ];
    v_role TEXT;
BEGIN
    FOREACH v_role IN ARRAY v_required_roles LOOP
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = v_role) THEN
            v_missing_roles := v_missing_roles || v_role || ', ';
        END IF;
    END LOOP;
    IF length(v_missing_roles) > 0 THEN
        RAISE EXCEPTION 'migration-056-prerequisite-missing: required roles do not exist (apply migration 055 first): %',
            rtrim(v_missing_roles, ', ')
            USING ERRCODE = 'undefined_object';
    END IF;
    -- async_consult_view_owner MUST NOT have BYPASSRLS (P-036 R7 + SI-024.1 R9 precedent)
    IF (SELECT rolbypassrls FROM pg_roles WHERE rolname = 'async_consult_view_owner') THEN
        RAISE EXCEPTION 'migration-056-preflight: async_consult_view_owner has BYPASSRLS; must be revoked before view ownership per P-036 R7 closure'
            USING ERRCODE = 'insufficient_privilege';
    END IF;
END $$;

-- =============================================================================
-- §1 — consult (CDM v1.9 §4.NEW1; SI-020 Sub-decision 1 entity 1)
--
-- One row per consult. Strict append-only per I-035; lifecycle state is
-- DERIVED from consult_lifecycle_transition rows (Option A), never stored
-- on this row.
-- =============================================================================

CREATE TABLE consult (
    id                      VARCHAR(26)  PRIMARY KEY,
    tenant_id               TEXT         NOT NULL REFERENCES tenants(id),
    patient_id              VARCHAR(26)  NOT NULL,
    delegate_id             VARCHAR(26)  NULL,
    consult_type            TEXT         NOT NULL CHECK (consult_type IN ('program_pathway', 'general')),
    program_id              TEXT         NULL,
    initiation_source       TEXT         NOT NULL CHECK (initiation_source IN (
        'program_enrollment', 'care_tab', 'mode_1_handoff', 'medication_detail', 'rpm_ccm_dashboard'
    )),
    consult_fee_cents       INTEGER      NOT NULL CHECK (consult_fee_cents >= 0),
    currency                TEXT         NOT NULL CHECK (length(currency) = 3),
    -- DEFERRED-FK TODO (Billing slice): composite FK to
    -- billing_payment_intent(tenant_id, id) when that entity lands.
    payment_intent_id       VARCHAR(26)  NOT NULL,
    payment_provider        TEXT         NOT NULL CHECK (payment_provider IN (
        'stripe', 'mtn_momo', 'flutterwave', 'mock_local_dev'
    )),
    expected_turnaround_at  TIMESTAMPTZ  NOT NULL,
    created_at              TIMESTAMPTZ  NOT NULL DEFAULT now(),
    CONSTRAINT consult_program_required_when_pathway CHECK (
        (consult_type = 'program_pathway' AND program_id IS NOT NULL)
        OR (consult_type = 'general' AND program_id IS NULL)
    ),
    -- Composite tenant-scoped FKs (I-023 layer 2; SI-025 canonical identity)
    CONSTRAINT consult_patient_tenant_fk
        FOREIGN KEY (tenant_id, patient_id) REFERENCES accounts (tenant_id, account_id),
    CONSTRAINT consult_delegate_tenant_fk
        FOREIGN KEY (tenant_id, delegate_id) REFERENCES accounts (tenant_id, account_id),
    -- Composite UNIQUEs for tenant-coherent child FKs (2-col and 3-col forms)
    CONSTRAINT consult_tenant_id_unique UNIQUE (tenant_id, id),
    CONSTRAINT consult_tenant_id_patient_unique UNIQUE (tenant_id, id, patient_id)
);

CREATE INDEX consult_patient_recent
    ON consult (tenant_id, patient_id, created_at DESC);
CREATE INDEX consult_tenant_created
    ON consult (tenant_id, created_at DESC);

ALTER TABLE consult ENABLE ROW LEVEL SECURITY;
ALTER TABLE consult FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON consult
    USING     (tenant_id = current_tenant_id())
    WITH CHECK (tenant_id = current_tenant_id());

CREATE OR REPLACE FUNCTION consult_block_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
    RAISE EXCEPTION
        'consult is append-only per I-035 (audit-bound; lifecycle state is DERIVED '
        'from consult_lifecycle_transition rows per Option A, SI-020 Sub-decision 5). '
        'UPDATE and DELETE are permanently prohibited.';
END;
$$;

CREATE TRIGGER consult_block_update
    BEFORE UPDATE ON consult
    FOR EACH ROW
    EXECUTE FUNCTION consult_block_mutation();

CREATE TRIGGER consult_block_delete
    BEFORE DELETE ON consult
    FOR EACH ROW
    EXECUTE FUNCTION consult_block_mutation();

-- Writes flow ONLY through record_consult_initiation() (PR 5) owned by
-- consult_initiation_wrapper_owner (SECURITY DEFINER executes with owner
-- privileges → owner needs the table privilege).
REVOKE INSERT ON consult FROM PUBLIC;
GRANT INSERT ON consult TO consult_initiation_wrapper_owner;
-- Wrapper owners that validate consult existence / lookup patient_id inside
-- their procedures (intake, ai-preparation, claim, decision) need SELECT.
GRANT SELECT ON consult
    TO consult_initiation_wrapper_owner,
       consult_intake_wrapper_owner,
       consult_ai_preparation_wrapper_owner,
       consult_claim_wrapper_owner,
       record_consult_decision_wrapper_owner;

-- =============================================================================
-- §2 — consult_intake_submission (CDM v1.9 §4.NEW2; SI-020 Sub-decision 1
--      entity 2). Strict append-only. KMS 8-column flat envelope on
--      intake_payload (I-026; mirrors SI-005 P-021 pattern).
-- =============================================================================

CREATE TABLE consult_intake_submission (
    id                                      VARCHAR(26)  PRIMARY KEY,
    tenant_id                               TEXT         NOT NULL REFERENCES tenants(id),
    consult_id                              VARCHAR(26)  NOT NULL,
    patient_id                              VARCHAR(26)  NOT NULL,
    template_id                             VARCHAR(26)  NOT NULL,
    template_version                        TEXT         NOT NULL,
    -- 8-column flat KMS envelope (I-026)
    intake_payload_ciphertext               BYTEA        NOT NULL,
    intake_payload_kms_envelope_dek_id      VARCHAR(26)  NOT NULL,
    intake_payload_kms_envelope_iv          BYTEA        NOT NULL,
    intake_payload_kms_envelope_tag         BYTEA        NOT NULL,
    intake_payload_kms_envelope_alg         TEXT         NOT NULL,
    intake_payload_kms_envelope_alg_version TEXT         NOT NULL,
    intake_payload_kms_envelope_aad         BYTEA        NOT NULL,
    intake_payload_kms_envelope_encrypted_at TIMESTAMPTZ NOT NULL,
    submitted_at                            TIMESTAMPTZ  NOT NULL DEFAULT now(),
    -- 3-column composite FK propagates patient identity (I-023 chain)
    CONSTRAINT consult_intake_submission_consult_patient_fk
        FOREIGN KEY (tenant_id, consult_id, patient_id)
        REFERENCES consult (tenant_id, id, patient_id),
    CONSTRAINT consult_intake_submission_template_fk
        FOREIGN KEY (tenant_id, template_id)
        REFERENCES forms_template (tenant_id, template_id),
    CONSTRAINT consult_intake_submission_tenant_id_unique UNIQUE (tenant_id, id)
);

CREATE INDEX consult_intake_submission_consult
    ON consult_intake_submission (tenant_id, consult_id, submitted_at DESC);

ALTER TABLE consult_intake_submission ENABLE ROW LEVEL SECURITY;
ALTER TABLE consult_intake_submission FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON consult_intake_submission
    USING     (tenant_id = current_tenant_id())
    WITH CHECK (tenant_id = current_tenant_id());

CREATE OR REPLACE FUNCTION consult_intake_submission_block_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
    RAISE EXCEPTION
        'consult_intake_submission is append-only per I-035. '
        'UPDATE and DELETE are permanently prohibited.';
END;
$$;

CREATE TRIGGER consult_intake_submission_block_update
    BEFORE UPDATE ON consult_intake_submission
    FOR EACH ROW
    EXECUTE FUNCTION consult_intake_submission_block_mutation();

CREATE TRIGGER consult_intake_submission_block_delete
    BEFORE DELETE ON consult_intake_submission
    FOR EACH ROW
    EXECUTE FUNCTION consult_intake_submission_block_mutation();

REVOKE INSERT ON consult_intake_submission FROM PUBLIC;
GRANT INSERT ON consult_intake_submission TO consult_intake_wrapper_owner;
GRANT SELECT ON consult_intake_submission
    TO consult_intake_wrapper_owner,
       consult_ai_preparation_wrapper_owner,
       record_consult_decision_wrapper_owner;

-- =============================================================================
-- §3 — consult_clinical_summary (CDM v1.9 §4.NEW3; SI-020 Sub-decision 1
--      entity 3). Strict append-only. KMS envelope on summary (I-026).
--      AI-authored content: ai_provider + model_id + prepared_by_mode carry
--      the ADR-029 provenance envelope at the schema layer.
-- =============================================================================

CREATE TABLE consult_clinical_summary (
    id                                  VARCHAR(26)  PRIMARY KEY,
    tenant_id                           TEXT         NOT NULL REFERENCES tenants(id),
    consult_id                          VARCHAR(26)  NOT NULL,
    patient_id                          VARCHAR(26)  NOT NULL,
    prepared_by_mode                    TEXT         NOT NULL CHECK (prepared_by_mode IN ('mode_1', 'mode_2')),
    ai_provider                         TEXT         NOT NULL CHECK (ai_provider IN (
        'anthropic', 'aws_bedrock', 'azure_openai', 'null_local_dev'
    )),
    model_id                            TEXT         NOT NULL,
    -- 8-column KMS envelope (I-026)
    summary_ciphertext                  BYTEA        NOT NULL,
    summary_kms_envelope_dek_id         VARCHAR(26)  NOT NULL,
    summary_kms_envelope_iv             BYTEA        NOT NULL,
    summary_kms_envelope_tag            BYTEA        NOT NULL,
    summary_kms_envelope_alg            TEXT         NOT NULL,
    summary_kms_envelope_alg_version    TEXT         NOT NULL,
    summary_kms_envelope_aad            BYTEA        NOT NULL,
    summary_kms_envelope_encrypted_at   TIMESTAMPTZ  NOT NULL,
    interaction_signals_snapshot        JSONB        NOT NULL,
    recommendation                      TEXT         NULL CHECK (recommendation IS NULL OR recommendation IN (
        'prescribe', 'recommend', 'refer', 'decline', 'request_more_data', 'escalate_to_sync'
    )),
    prepared_at                         TIMESTAMPTZ  NOT NULL DEFAULT now(),
    CONSTRAINT consult_clinical_summary_consult_patient_fk
        FOREIGN KEY (tenant_id, consult_id, patient_id)
        REFERENCES consult (tenant_id, id, patient_id),
    CONSTRAINT consult_clinical_summary_tenant_id_unique UNIQUE (tenant_id, id)
);

CREATE INDEX consult_clinical_summary_consult
    ON consult_clinical_summary (tenant_id, consult_id, prepared_at DESC);

ALTER TABLE consult_clinical_summary ENABLE ROW LEVEL SECURITY;
ALTER TABLE consult_clinical_summary FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON consult_clinical_summary
    USING     (tenant_id = current_tenant_id())
    WITH CHECK (tenant_id = current_tenant_id());

CREATE OR REPLACE FUNCTION consult_clinical_summary_block_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
    RAISE EXCEPTION
        'consult_clinical_summary is append-only per I-035. '
        'UPDATE and DELETE are permanently prohibited.';
END;
$$;

CREATE TRIGGER consult_clinical_summary_block_update
    BEFORE UPDATE ON consult_clinical_summary
    FOR EACH ROW
    EXECUTE FUNCTION consult_clinical_summary_block_mutation();

CREATE TRIGGER consult_clinical_summary_block_delete
    BEFORE DELETE ON consult_clinical_summary
    FOR EACH ROW
    EXECUTE FUNCTION consult_clinical_summary_block_mutation();

REVOKE INSERT ON consult_clinical_summary FROM PUBLIC;
GRANT INSERT ON consult_clinical_summary TO consult_ai_preparation_wrapper_owner;
GRANT SELECT ON consult_clinical_summary
    TO consult_ai_preparation_wrapper_owner,
       record_consult_decision_wrapper_owner;

-- =============================================================================
-- §4 — consult_review_claim (CDM v1.9 §4.NEW4; SI-020 Sub-decision 1 entity 4)
--
-- Hybrid-persistence-with-one-way-release per P-037 R4 closure:
--   * identity columns + claimed_at + claim_expires_at: strict append-only
--   * released_at + release_reason: one-way mutable (NULL → non-NULL, once)
--   * DELETE: never
-- Single-active-claim-per-consult enforced by partial UNIQUE index.
-- =============================================================================

CREATE TABLE consult_review_claim (
    id                      VARCHAR(26)  PRIMARY KEY,
    tenant_id               TEXT         NOT NULL REFERENCES tenants(id),
    consult_id              VARCHAR(26)  NOT NULL,
    patient_id              VARCHAR(26)  NOT NULL,
    clinician_account_id    VARCHAR(26)  NOT NULL,
    claimed_at              TIMESTAMPTZ  NOT NULL DEFAULT now(),
    claim_expires_at        TIMESTAMPTZ  NOT NULL,
    released_at             TIMESTAMPTZ  NULL,
    release_reason          TEXT         NULL CHECK (release_reason IS NULL OR release_reason IN (
        'decision_recorded', 'claim_expired', 'reassigned', 'clinician_unavailable'
    )),
    CONSTRAINT consult_review_claim_consult_patient_fk
        FOREIGN KEY (tenant_id, consult_id, patient_id)
        REFERENCES consult (tenant_id, id, patient_id),
    -- SI-025 canonical identity: clinician FK → accounts (P-038 §12 OQ3
    -- resolved to the code-repo canonical membership table; R3 MED-1 closure
    -- tenant-scoping preserved).
    CONSTRAINT consult_review_claim_clinician_tenant_fk
        FOREIGN KEY (tenant_id, clinician_account_id)
        REFERENCES accounts (tenant_id, account_id),
    -- 5-column composite UNIQUE enables the consult_clinician_decision FK
    -- enforcing deciding-clinician == claiming-clinician at schema level.
    CONSTRAINT consult_review_claim_full_identity_unique
        UNIQUE (tenant_id, id, consult_id, patient_id, clinician_account_id),
    CONSTRAINT consult_review_claim_release_fields_together CHECK (
        (released_at IS NULL AND release_reason IS NULL)
        OR (released_at IS NOT NULL AND release_reason IS NOT NULL)
    ),
    CONSTRAINT consult_review_claim_tenant_id_unique UNIQUE (tenant_id, id)
);

-- Single-active-claim-per-consult invariant
CREATE UNIQUE INDEX consult_review_claim_active_per_consult_uniq
    ON consult_review_claim (tenant_id, consult_id, patient_id)
    WHERE released_at IS NULL;

CREATE INDEX consult_review_claim_clinician_active
    ON consult_review_claim (tenant_id, clinician_account_id, claimed_at DESC)
    WHERE released_at IS NULL;

ALTER TABLE consult_review_claim ENABLE ROW LEVEL SECURITY;
ALTER TABLE consult_review_claim FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON consult_review_claim
    USING     (tenant_id = current_tenant_id())
    WITH CHECK (tenant_id = current_tenant_id());

-- Hybrid persistence trigger (P-037 R4 closure; locked search_path per
-- P-038 R4 HIGH-1 closure even though the body has no SELECT).
CREATE OR REPLACE FUNCTION consult_review_claim_one_way_released_at()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
BEGIN
    -- Reject any change to identity columns
    IF NEW.id IS DISTINCT FROM OLD.id
       OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
       OR NEW.consult_id IS DISTINCT FROM OLD.consult_id
       OR NEW.patient_id IS DISTINCT FROM OLD.patient_id
       OR NEW.clinician_account_id IS DISTINCT FROM OLD.clinician_account_id
       OR NEW.claimed_at IS DISTINCT FROM OLD.claimed_at
       OR NEW.claim_expires_at IS DISTINCT FROM OLD.claim_expires_at THEN
        RAISE EXCEPTION 'consult_review_claim identity columns are strict append-only post-INSERT'
            USING ERRCODE = 'TLC27';
    END IF;
    -- One-way release: non-NULL values can never change once set
    IF OLD.released_at IS NOT NULL AND NEW.released_at IS DISTINCT FROM OLD.released_at THEN
        RAISE EXCEPTION 'consult_review_claim.released_at is one-way (NULL -> timestamp); cannot change once set: was % is %',
            OLD.released_at, NEW.released_at
            USING ERRCODE = 'TLC27';
    END IF;
    IF OLD.release_reason IS NOT NULL AND NEW.release_reason IS DISTINCT FROM OLD.release_reason THEN
        RAISE EXCEPTION 'consult_review_claim.release_reason is one-way; cannot change once set'
            USING ERRCODE = 'TLC27';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER consult_review_claim_one_way_released_at
    BEFORE UPDATE ON consult_review_claim
    FOR EACH ROW
    EXECUTE FUNCTION consult_review_claim_one_way_released_at();

CREATE OR REPLACE FUNCTION consult_review_claim_block_delete()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
    RAISE EXCEPTION
        'consult_review_claim rows are never deleted (hybrid persistence per '
        'P-037 R4 closure; release is recorded one-way on released_at). '
        'DELETE is permanently prohibited.';
END;
$$;

CREATE TRIGGER consult_review_claim_no_delete
    BEFORE DELETE ON consult_review_claim
    FOR EACH ROW
    EXECUTE FUNCTION consult_review_claim_block_delete();

REVOKE INSERT ON consult_review_claim FROM PUBLIC;
-- claim_consult_for_review() + reassign_consult_claim() (PR 5, owned by
-- consult_claim_wrapper_owner) INSERT new claims and UPDATE-release prior
-- claims (one-way trigger constrains the UPDATE surface).
GRANT INSERT, UPDATE ON consult_review_claim TO consult_claim_wrapper_owner;
GRANT SELECT ON consult_review_claim
    TO consult_claim_wrapper_owner,
       record_consult_decision_wrapper_owner;

-- =============================================================================
-- §5 — consult_clinician_decision (CDM v1.9 §4.NEW5; SI-020 Sub-decision 1
--      entity 5; extends SI-005 P-021). Strict append-only. KMS envelope on
--      decision_rationale (I-026). 5-column composite claim FK enforces
--      deciding-clinician == claiming-clinician.
-- =============================================================================

CREATE TABLE consult_clinician_decision (
    id                                          VARCHAR(26)  PRIMARY KEY,
    tenant_id                                   TEXT         NOT NULL REFERENCES tenants(id),
    consult_id                                  VARCHAR(26)  NOT NULL,
    patient_id                                  VARCHAR(26)  NOT NULL,
    claim_id                                    VARCHAR(26)  NOT NULL,
    clinician_account_id                        VARCHAR(26)  NOT NULL,
    decision_type                               TEXT         NOT NULL CHECK (decision_type IN (
        'prescribe', 'recommend', 'refer', 'decline', 'request_more_data', 'escalate_to_sync'
    )),
    agreement_with_ai_recommendation            TEXT         NOT NULL CHECK (agreement_with_ai_recommendation IN (
        'accepted', 'modified', 'disagreed', 'no_ai_recommendation'
    )),
    -- 8-column KMS envelope (I-026)
    decision_rationale_ciphertext               BYTEA        NOT NULL,
    decision_rationale_kms_envelope_dek_id      VARCHAR(26)  NOT NULL,
    decision_rationale_kms_envelope_iv          BYTEA        NOT NULL,
    decision_rationale_kms_envelope_tag         BYTEA        NOT NULL,
    decision_rationale_kms_envelope_alg         TEXT         NOT NULL,
    decision_rationale_kms_envelope_alg_version TEXT         NOT NULL,
    decision_rationale_kms_envelope_aad         BYTEA        NOT NULL,
    decision_rationale_kms_envelope_encrypted_at TIMESTAMPTZ NOT NULL,
    interaction_signals_reviewed_ids            VARCHAR(26)[] NOT NULL,
    -- DEFERRED-FK TODO: → medication_requests when the prescribe flow binds
    -- (P-038 §12 OQ2 posture: opaque for now).
    prescription_details_id                     VARCHAR(26)  NULL,
    referral_target_id                          VARCHAR(26)  NULL,
    decided_at                                  TIMESTAMPTZ  NOT NULL DEFAULT now(),
    -- 5-column composite tenant-scoped FK: deciding == claiming clinician
    CONSTRAINT consult_clinician_decision_claim_fk
        FOREIGN KEY (tenant_id, claim_id, consult_id, patient_id, clinician_account_id)
        REFERENCES consult_review_claim (tenant_id, id, consult_id, patient_id, clinician_account_id),
    CONSTRAINT consult_clinician_decision_prescription_iff_prescribe CHECK (
        (decision_type = 'prescribe' AND prescription_details_id IS NOT NULL)
        OR (decision_type <> 'prescribe' AND prescription_details_id IS NULL)
    ),
    CONSTRAINT consult_clinician_decision_referral_iff_refer CHECK (
        (decision_type = 'refer' AND referral_target_id IS NOT NULL)
        OR (decision_type <> 'refer' AND referral_target_id IS NULL)
    ),
    CONSTRAINT consult_clinician_decision_tenant_id_unique UNIQUE (tenant_id, id)
);

CREATE INDEX consult_clinician_decision_consult
    ON consult_clinician_decision (tenant_id, consult_id, decided_at DESC);

ALTER TABLE consult_clinician_decision ENABLE ROW LEVEL SECURITY;
ALTER TABLE consult_clinician_decision FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON consult_clinician_decision
    USING     (tenant_id = current_tenant_id())
    WITH CHECK (tenant_id = current_tenant_id());

CREATE OR REPLACE FUNCTION consult_clinician_decision_block_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
    RAISE EXCEPTION
        'consult_clinician_decision is append-only per I-035 (clinical decision '
        'record; audit-bound). UPDATE and DELETE are permanently prohibited.';
END;
$$;

CREATE TRIGGER consult_clinician_decision_block_update
    BEFORE UPDATE ON consult_clinician_decision
    FOR EACH ROW
    EXECUTE FUNCTION consult_clinician_decision_block_mutation();

CREATE TRIGGER consult_clinician_decision_block_delete
    BEFORE DELETE ON consult_clinician_decision
    FOR EACH ROW
    EXECUTE FUNCTION consult_clinician_decision_block_mutation();

-- BEFORE INSERT: claim must exist (5-column composite identity), be
-- unreleased, and be unexpired at decision time (P-038 R1/R3/R4 closures).
-- SECURITY INVOKER + advisory lock + plain SELECT (Option 2 adaptation; the
-- lock — shared with every claim-mutating wrapper in PR 5 — provides the
-- serialization the spec obtained via SELECT ... FOR UPDATE, without
-- granting UPDATE on consult_review_claim to the decision writer).
CREATE OR REPLACE FUNCTION consult_clinician_decision_validate_claim_active()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
DECLARE
    v_claim_released_at TIMESTAMPTZ;
    v_claim_expires_at  TIMESTAMPTZ;
    v_found             BOOLEAN := FALSE;
    v_lock_key          BIGINT;
BEGIN
    -- Same per-consult advisory lock as claim_consult_for_review() +
    -- reassign_consult_claim() (PR 5) — serializes decision insertion against
    -- concurrent claim release/reassignment (P-038 R3 HIGH-1 closure).
    v_lock_key := ('x' || substr(md5('consult_review_claim:' || NEW.tenant_id || ':' || NEW.consult_id), 1, 16))::bit(64)::bigint;
    PERFORM pg_advisory_xact_lock(v_lock_key);

    SELECT TRUE, released_at, claim_expires_at
        INTO v_found, v_claim_released_at, v_claim_expires_at
        FROM public.consult_review_claim
        WHERE tenant_id = NEW.tenant_id
          AND id = NEW.claim_id
          AND consult_id = NEW.consult_id
          AND patient_id = NEW.patient_id
          AND clinician_account_id = NEW.clinician_account_id;

    IF NOT v_found THEN
        RAISE EXCEPTION 'consult_clinician_decision cannot reference claim with mismatched composite identity: tenant_id=%, claim_id=%, consult_id=%, patient_id=%, clinician_account_id=%',
            NEW.tenant_id, NEW.claim_id, NEW.consult_id, NEW.patient_id, NEW.clinician_account_id
            USING ERRCODE = 'check_violation';
    END IF;
    IF v_claim_released_at IS NOT NULL THEN
        RAISE EXCEPTION 'consult_clinician_decision cannot reference released claim: claim_id=%', NEW.claim_id
            USING ERRCODE = 'check_violation';
    END IF;
    IF v_claim_expires_at < NEW.decided_at THEN
        RAISE EXCEPTION 'consult_clinician_decision cannot reference expired claim: claim_id=% expired=%, decided=%',
            NEW.claim_id, v_claim_expires_at, NEW.decided_at
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER consult_clinician_decision_validate_claim_active
    BEFORE INSERT ON consult_clinician_decision
    FOR EACH ROW
    EXECUTE FUNCTION consult_clinician_decision_validate_claim_active();

REVOKE INSERT ON consult_clinician_decision FROM PUBLIC;
GRANT INSERT ON consult_clinician_decision TO record_consult_decision_wrapper_owner;
GRANT SELECT ON consult_clinician_decision TO record_consult_decision_wrapper_owner;

-- =============================================================================
-- §6 — consult_lifecycle_transition (CDM v1.9 §4.NEW6; SI-020 Sub-decision 1
--      entity 6; Option A append-only-only per I-035). Current state is
--      DERIVED: latest row by (transition_at DESC, id DESC).
-- =============================================================================

CREATE TABLE consult_lifecycle_transition (
    id                          VARCHAR(26)  PRIMARY KEY,
    tenant_id                   TEXT         NOT NULL REFERENCES tenants(id),
    consult_id                  VARCHAR(26)  NOT NULL,
    from_state                  TEXT         NOT NULL CHECK (from_state IN (
        'none', 'initiated', 'intake', 'abandoned', 'submitted', 'processing', 'queued',
        'under_review', 'decision_made', 'prescribed', 'advised', 'awaiting_data',
        'escalated_to_sync', 'declined', 'referred', 'follow_up', 'completed', 'resumed', 'expired'
    )),
    to_state                    TEXT         NOT NULL CHECK (to_state IN (
        'initiated', 'intake', 'abandoned', 'submitted', 'processing', 'queued',
        'under_review', 'decision_made', 'prescribed', 'advised', 'awaiting_data',
        'escalated_to_sync', 'declined', 'referred', 'follow_up', 'completed', 'resumed', 'expired'
        -- 'none' is NEVER a valid to_state
    )),
    transition_reason           TEXT         NOT NULL,
    transition_at               TIMESTAMPTZ  NOT NULL DEFAULT now(),
    -- NULL for system/scheduler transitions (crisis actor_principal_id
    -- precedent, migrations 033/053); no FK by design.
    transition_by_actor_id      VARCHAR(26)  NULL,
    transition_by_actor_role    TEXT         NOT NULL CHECK (transition_by_actor_role IN (
        'patient', 'delegate', 'clinician', 'system', 'ai_service', 'scheduler'
    )),
    metadata                    JSONB        NOT NULL DEFAULT '{}'::jsonb,
    CONSTRAINT consult_lifecycle_transition_consult_fk
        FOREIGN KEY (tenant_id, consult_id) REFERENCES consult (tenant_id, id),
    -- 22 allowed (transition_reason, from_state, to_state) triples
    -- (State Machines v1.3 consult_lifecycle; P-038 §7)
    CONSTRAINT consult_lifecycle_transition_valid_triple CHECK (
        (transition_reason = 'initiation'                  AND from_state = 'none'              AND to_state = 'initiated')
     OR (transition_reason = 'intake_started'              AND from_state = 'initiated'         AND to_state = 'intake')
     OR (transition_reason = 'intake_abandoned'            AND from_state = 'intake'            AND to_state = 'abandoned')
     OR (transition_reason = 'intake_resumed'              AND from_state = 'abandoned'         AND to_state = 'intake')
     OR (transition_reason = 'intake_submitted'            AND from_state = 'intake'            AND to_state = 'submitted')
     OR (transition_reason = 'ai_processing_started'       AND from_state = 'submitted'         AND to_state = 'processing')
     OR (transition_reason = 'ai_processing_completed'     AND from_state = 'processing'        AND to_state = 'queued')
     OR (transition_reason = 'clinician_claimed'           AND from_state = 'queued'            AND to_state = 'under_review')
     OR (transition_reason = 'decision_recorded'           AND from_state = 'under_review'      AND to_state = 'decision_made')
     OR (transition_reason = 'prescribed_outcome'          AND from_state = 'decision_made'     AND to_state = 'prescribed')
     OR (transition_reason = 'advised_outcome'             AND from_state = 'decision_made'     AND to_state = 'advised')
     OR (transition_reason = 'declined_outcome'            AND from_state = 'decision_made'     AND to_state = 'declined')
     OR (transition_reason = 'referred_outcome'            AND from_state = 'decision_made'     AND to_state = 'referred')
     OR (transition_reason = 'additional_data_requested'   AND from_state = 'under_review'      AND to_state = 'awaiting_data')
     OR (transition_reason = 'patient_data_resubmitted'    AND from_state = 'awaiting_data'     AND to_state = 'submitted')
     OR (transition_reason = 'escalated_to_sync_outcome'   AND from_state = 'decision_made'     AND to_state = 'escalated_to_sync')
     OR (transition_reason = 'follow_up_started'           AND from_state = 'prescribed'        AND to_state = 'follow_up')
     OR (transition_reason = 'follow_up_started'           AND from_state = 'advised'           AND to_state = 'follow_up')
     OR (transition_reason = 'follow_up_message_sent'      AND from_state = 'follow_up'         AND to_state = 'follow_up')
     OR (transition_reason = 'follow_up_completed'         AND from_state = 'follow_up'         AND to_state = 'completed')
     OR (transition_reason = 'consult_completed'           AND from_state IN ('declined', 'referred', 'escalated_to_sync') AND to_state = 'completed')
     OR (transition_reason = 'intake_expired'              AND from_state = 'abandoned'         AND to_state = 'expired')
    ),
    CONSTRAINT consult_lifecycle_transition_uniq UNIQUE (tenant_id, consult_id, transition_at, id)
);

CREATE INDEX consult_lifecycle_transition_latest
    ON consult_lifecycle_transition (tenant_id, consult_id, transition_at DESC, id DESC);

ALTER TABLE consult_lifecycle_transition ENABLE ROW LEVEL SECURITY;
ALTER TABLE consult_lifecycle_transition FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON consult_lifecycle_transition
    USING     (tenant_id = current_tenant_id())
    WITH CHECK (tenant_id = current_tenant_id());

CREATE OR REPLACE FUNCTION consult_lifecycle_transition_block_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
    RAISE EXCEPTION
        'consult_lifecycle_transition is append-only per I-035 (audit-bound state '
        'machine; current state is DERIVED from the latest row). '
        'UPDATE and DELETE are permanently prohibited.';
END;
$$;

CREATE TRIGGER consult_lifecycle_transition_block_update
    BEFORE UPDATE ON consult_lifecycle_transition
    FOR EACH ROW
    EXECUTE FUNCTION consult_lifecycle_transition_block_mutation();

CREATE TRIGGER consult_lifecycle_transition_block_delete
    BEFORE DELETE ON consult_lifecycle_transition
    FOR EACH ROW
    EXECUTE FUNCTION consult_lifecycle_transition_block_mutation();

-- BEFORE INSERT: state continuity + strict monotonic transition_at
-- (P-038 R1 HIGH-2 / R2 HIGH-1 / R3 HIGH-2 / R4 HIGH-1 closures).
-- Defense-in-depth: enforced regardless of caller, even direct INSERTs by
-- the writer owner.
CREATE OR REPLACE FUNCTION consult_lifecycle_transition_continuity()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
DECLARE
    v_latest_to_state       TEXT;
    v_latest_transition_at  TIMESTAMPTZ;
    v_max_clock_skew CONSTANT INTERVAL := INTERVAL '5 seconds';
    v_lock_key              BIGINT;
BEGIN
    -- Per-consult advisory lock serializes concurrent transition inserts so
    -- the latest-row read below sees the committed predecessor.
    v_lock_key := ('x' || substr(md5('consult_lifecycle_transition:' || NEW.tenant_id || ':' || NEW.consult_id), 1, 16))::bit(64)::bigint;
    PERFORM pg_advisory_xact_lock(v_lock_key);

    -- Future-dating bounded by 5s clock-skew tolerance (dominance-attack guard)
    IF NEW.transition_at > now() + v_max_clock_skew THEN
        RAISE EXCEPTION 'consult_lifecycle_transition: transition_at=% is more than 5s in the future (clock_skew_or_future_dated); consult_id=%',
            NEW.transition_at, NEW.consult_id
            USING ERRCODE = '22008';    -- datetime_field_overflow
    END IF;

    SELECT to_state, transition_at
        INTO v_latest_to_state, v_latest_transition_at
        FROM public.consult_lifecycle_transition
        WHERE tenant_id = NEW.tenant_id AND consult_id = NEW.consult_id
        ORDER BY transition_at DESC, id DESC
        LIMIT 1;

    IF v_latest_to_state IS NULL THEN
        -- No prior transition; only the initial emission is allowed
        IF NEW.from_state <> 'none' THEN
            RAISE EXCEPTION 'consult_lifecycle_transition: first transition must have from_state=none; got from_state=% for consult_id=%',
                NEW.from_state, NEW.consult_id
                USING ERRCODE = 'check_violation';
        END IF;
    ELSE
        -- Continuity: new from_state MUST equal current latest to_state
        IF NEW.from_state IS DISTINCT FROM v_latest_to_state THEN
            RAISE EXCEPTION 'consult_lifecycle_transition continuity violation: from_state=% does not match latest to_state=% for consult_id=%',
                NEW.from_state, v_latest_to_state, NEW.consult_id
                USING ERRCODE = 'check_violation';
        END IF;
        -- No transitions FROM terminal states
        IF v_latest_to_state IN ('completed', 'expired') THEN
            RAISE EXCEPTION 'consult_lifecycle_transition: cannot transition from terminal state %; consult_id=%',
                v_latest_to_state, NEW.consult_id
                USING ERRCODE = 'check_violation';
        END IF;
        -- STRICT monotonic ordering: equal timestamps forbidden (ULID/UUID
        -- tie-break ambiguity would corrupt current-state derivation).
        IF NEW.transition_at <= v_latest_transition_at THEN
            RAISE EXCEPTION 'consult_lifecycle_transition: transition_at=% must be STRICTLY greater than latest transition_at=% (equal or backdated forbidden); consult_id=%',
                NEW.transition_at, v_latest_transition_at, NEW.consult_id
                USING ERRCODE = 'check_violation';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER consult_lifecycle_transition_continuity
    BEFORE INSERT ON consult_lifecycle_transition
    FOR EACH ROW
    EXECUTE FUNCTION consult_lifecycle_transition_continuity();

-- INSERT restricted to the raw lifecycle writer owner (P-038 §3: all
-- transition writes flow through record_consult_lifecycle_transition(),
-- PR 4). SELECT needed by the writer owner for the continuity trigger's
-- SECURITY INVOKER read, and by wrapper owners for state validation.
REVOKE INSERT ON consult_lifecycle_transition FROM PUBLIC;
GRANT INSERT ON consult_lifecycle_transition TO consult_lifecycle_transition_writer_owner;
GRANT SELECT ON consult_lifecycle_transition
    TO consult_lifecycle_transition_writer_owner,
       consult_initiation_wrapper_owner,
       consult_intake_wrapper_owner,
       consult_ai_preparation_wrapper_owner,
       consult_claim_wrapper_owner,
       record_consult_decision_wrapper_owner;

-- =============================================================================
-- §7 — consult_follow_up_message (CDM v1.9 §4.NEW7; SI-020 Sub-decision 1
--      entity 7). Strict append-only. KMS envelope on message (I-026).
-- =============================================================================

CREATE TABLE consult_follow_up_message (
    id                                  VARCHAR(26)  PRIMARY KEY,
    tenant_id                           TEXT         NOT NULL REFERENCES tenants(id),
    consult_id                          VARCHAR(26)  NOT NULL,
    patient_id                          VARCHAR(26)  NOT NULL,
    sender_role                         TEXT         NOT NULL CHECK (sender_role IN ('patient', 'clinician')),
    sender_account_id                   VARCHAR(26)  NOT NULL,
    -- 8-column KMS envelope (I-026)
    message_ciphertext                  BYTEA        NOT NULL,
    message_kms_envelope_dek_id         VARCHAR(26)  NOT NULL,
    message_kms_envelope_iv             BYTEA        NOT NULL,
    message_kms_envelope_tag            BYTEA        NOT NULL,
    message_kms_envelope_alg            TEXT         NOT NULL,
    message_kms_envelope_alg_version    TEXT         NOT NULL,
    message_kms_envelope_aad            BYTEA        NOT NULL,
    message_kms_envelope_encrypted_at   TIMESTAMPTZ  NOT NULL,
    sent_at                             TIMESTAMPTZ  NOT NULL DEFAULT now(),
    CONSTRAINT consult_follow_up_message_consult_patient_fk
        FOREIGN KEY (tenant_id, consult_id, patient_id)
        REFERENCES consult (tenant_id, id, patient_id),
    CONSTRAINT consult_follow_up_message_sender_tenant_fk
        FOREIGN KEY (tenant_id, sender_account_id)
        REFERENCES accounts (tenant_id, account_id),
    CONSTRAINT consult_follow_up_message_tenant_id_unique UNIQUE (tenant_id, id)
);

CREATE INDEX consult_follow_up_message_consult
    ON consult_follow_up_message (tenant_id, consult_id, sent_at DESC);

ALTER TABLE consult_follow_up_message ENABLE ROW LEVEL SECURITY;
ALTER TABLE consult_follow_up_message FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON consult_follow_up_message
    USING     (tenant_id = current_tenant_id())
    WITH CHECK (tenant_id = current_tenant_id());

CREATE OR REPLACE FUNCTION consult_follow_up_message_block_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
    RAISE EXCEPTION
        'consult_follow_up_message is append-only per I-035. '
        'UPDATE and DELETE are permanently prohibited.';
END;
$$;

CREATE TRIGGER consult_follow_up_message_block_update
    BEFORE UPDATE ON consult_follow_up_message
    FOR EACH ROW
    EXECUTE FUNCTION consult_follow_up_message_block_mutation();

CREATE TRIGGER consult_follow_up_message_block_delete
    BEFORE DELETE ON consult_follow_up_message
    FOR EACH ROW
    EXECUTE FUNCTION consult_follow_up_message_block_mutation();

-- No wrapper procedure is spec'd for follow-up messages (P-038 §3 lists 7
-- procedures; none for this table). Writes use the canonical direct-INSERT
-- composition (withDbRole under the sending app role), matching the
-- Med-Interaction PR-8 create-evaluation precedent.
REVOKE INSERT ON consult_follow_up_message FROM PUBLIC;
GRANT INSERT ON consult_follow_up_message
    TO async_consult_patient_initiator,     -- patient sends
       async_consult_clinician_reviewer;    -- clinician sends
GRANT SELECT ON consult_follow_up_message
    TO async_consult_patient_initiator,
       async_consult_clinician_reviewer;

-- =============================================================================
-- §8 — Verification (matches migration 033/040/047 closing-check pattern)
-- =============================================================================

DO $$
DECLARE
    v_table TEXT;
    v_tables TEXT[] := ARRAY[
        'consult', 'consult_intake_submission', 'consult_clinical_summary',
        'consult_review_claim', 'consult_clinician_decision',
        'consult_lifecycle_transition', 'consult_follow_up_message'
    ];
    v_count INTEGER;
BEGIN
    -- All 7 tables exist with RLS FORCED
    FOREACH v_table IN ARRAY v_tables LOOP
        IF NOT EXISTS (
            SELECT 1 FROM pg_class c
            JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = 'public' AND c.relname = v_table
              AND c.relrowsecurity AND c.relforcerowsecurity
        ) THEN
            RAISE EXCEPTION 'migration-056-verification: table % missing or RLS not FORCED', v_table
                USING ERRCODE = 'check_violation';
        END IF;
    END LOOP;

    -- Every table has a tenant_isolation policy
    SELECT COUNT(*) INTO v_count
      FROM pg_policies
     WHERE schemaname = 'public'
       AND tablename = ANY (v_tables)
       AND policyname = 'tenant_isolation';
    IF v_count <> 7 THEN
        RAISE EXCEPTION 'migration-056-verification: expected 7 tenant_isolation policies, found %', v_count
            USING ERRCODE = 'check_violation';
    END IF;

    -- Invariant triggers present (2 block triggers per strict table = 12;
    -- + one-way UPDATE + no-delete on review_claim = 2; + continuity INSERT
    -- on lifecycle_transition = 1; + validate-claim INSERT on decision = 1)
    SELECT COUNT(*) INTO v_count
      FROM pg_trigger t
      JOIN pg_class c ON c.oid = t.tgrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relname = ANY (v_tables)
       AND NOT t.tgisinternal;
    IF v_count <> 16 THEN
        RAISE EXCEPTION 'migration-056-verification: expected 16 user triggers across the 7 tables, found %', v_count
            USING ERRCODE = 'check_violation';
    END IF;
END $$;
