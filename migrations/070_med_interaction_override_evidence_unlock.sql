-- =============================================================================
-- File:    migrations/070_med_interaction_override_evidence_unlock.sql
-- Purpose: Land the DEFERRED override-wrapper evidence checks and turn
--          `record_interaction_signal_override()` OPERATIONAL — the
--          evidence-unlock migration prescribed by migration 050 §6's own
--          fail-closed closure text. Follows the deferral-closure precedent
--          of migrations 065 (admin consult-queue-health) + 069 (admin
--          mode1-volume-health): quote the deferral prescription, show the
--          foundation dependency that forced it has landed, execute the
--          prescription verbatim.
--
--          Migration 050 §6 deferred with (R1 HIGH-1 closure 2026-05-23):
--
--            "SI-019 §6.NEW7 requires (a) medication-still-on-active-list
--             check (Pharmacy active-medication-list view not yet in code
--             repo) AND (b) LAYER B clinician role-membership check
--             (SI-024.1 JWT-binding deferred). Wrapper fail-closed per
--             Codex R1 closure 2026-05-23 to prevent unverified terminal
--             override writes; PR 6+ application-layer evidence checks +
--             LAYER B authorization re-enables this wrapper."
--
--          and pinned the closure pattern (050 §6 R2 CRITICAL closure
--          block-comment):
--
--            "1. Remove the RAISE EXCEPTION above
--             2. Add the 2 evidence checks where the RAISE was
--             3. Remove THIS block comment wrapper to re-enable the INSERT +
--                PERFORM below
--             All three steps MUST happen in the same migration; partial
--             uncomment (just removing the RAISE) would re-introduce the
--             R1 finding."
--
--          BOTH deferral reasons are now closed by landed foundations:
--
--          (a) medication-still-on-active-list — the Pharmacy slice's
--              medication_request entity chain landed at migrations 025/026
--              (append-only supersession discipline; status enum per State
--              Machines v1.2 §19) with the TLC-055 service layer live. The
--              patient's medication list is queryable as medication_requests
--              rows keyed (tenant_id, patient_account_id, product_catalog_id,
--              status); no dedicated "active-medication-list view" object is
--              required for the STEP 3 evidence predicate (mirrors 065 §1's
--              Option-2 adaptation posture: the CHECK targets the landed
--              base entity, not a spec-named view that has no code-repo
--              counterpart).
--
--          (b) LAYER B clinician role-membership — per the ratifier Option 2
--              carryforward recorded in migration 050's header ("SI-024.1
--              JWT-binding ... REPLACED by SI-010 actor binding"), the
--              LAYER B trust anchor in this code repo is the SI-010 actor
--              context (migrations 031/062/063), NOT the spec's
--              verify_session_jwt_and_extract_claims(). The landed
--              realization is two-layer:
--                - Application layer (the Fastify override handler):
--                  requireClinicianActorContext() — the canonical clinician
--                  role gate from src/lib/auth-context.ts (TLC-055 PR E /
--                  TLC-058; used by pharmacy clinician writes + async-consult
--                  claim/record-decision) — rejects non-clinician JWTs with
--                  403 before any DB work.
--                - DB layer (THIS wrapper, defense-in-depth): STEP 4 below
--                  binds p_clinician_account_id to the SI-010-verified actor
--                  (current_actor_account_id()) and requires the accounts row
--                  to be account_type='clinician' AND status='active' in the
--                  caller's tenant (accounts.account_type='clinician' landed
--                  at migration 027). A caller holding EXECUTE cannot forge
--                  another clinician's identity: the SI-010 nonce-bound GUC
--                  is written only by bind_actor_context_role (031 §3 trust
--                  boundary; repaired at 062).
--
--          KMS-envelope note: the 8 override_rationale_kms_envelope_* columns
--          on interaction_signal_override are NOT NULL (migration 047 §3).
--          The handler-layer posture is the established async-consult
--          follow-up-messages precedent (I-026): the rationale arrives
--          PRE-ENCRYPTED as an 8-field wire envelope and is bound verbatim
--          to the 8 wrapper params — plaintext rationale never transits the
--          server (mirrors SI-019 R4 HIGH-2 closure: plaintext rationale
--          column REMOVED; envelope-only persistence).
--
--          NOT unlocked here (deferrals STAND; restated precisely so /ready
--          + README can cite them):
--
--          - record_signal_resolution (050 §4) — SI-019 §6.NEW5 requires
--            3 evidence checks. Check (1) "discontinuation event exists in
--            the medication-discontinuation domain-event log" NOW has a
--            landed source (`medication_request.discontinued.v1` rows in
--            domain_events_outbox, emitted by the Pharmacy module since
--            TLC-055) — BUT the remaining gates hold the wrapper fail-closed:
--            (i) check (3) "protocol-specific washout period elapsed" has NO
--            configuration source in the code repo (no protocol washout
--            table / CCR key); (ii) the app-role caller
--            `medication_interaction_resolution_subscriber` is still not
--            created (migration 055 §0 explicitly declined — Async Consult
--            domain-event subscriber registry absent), so the wrapper has no
--            EXECUTE grantee; (iii) the wrapper's p_discontinuation_event_id
--            is VARCHAR(26) (ULID) while domain_events_outbox.event_id is
--            UUID (recorded SPEC ISSUE in migration 004) — the future unlock
--            migration must reconcile the identifier class.
--          - record_signal_expiry (050 §5) — SI-019 §6.NEW6 requires the
--            per-basis elapsed-time predicate `now() > emission_time +
--            per_basis_duration`; the CCR-driven per-basis cadence config
--            table (duration formula per time_window_basis) is still absent
--            from the code repo. Deferral stands unchanged.
--
--          Option-2 recorded divergences NEW in this migration (flagged for
--          the Codex adversarial sweep + future hygiene reconciliation):
--
--          - STEP 3 predicate reading: interaction_signal.medications_involved
--            is VARCHAR(26)[] (bare ULIDs; migration 047 §2). It CANNOT hold
--            medication_requests row ids (those are `mrx_`-prefixed
--            VARCHAR(30) per migration 025). The only landed 26-char-ULID
--            medication identity is product_catalog.id (migration 024), so
--            STEP 3 reads medications_involved as PRODUCT identities and
--            requires, for EVERY involved product, a live medication_requests
--            row for the signal's patient: status IN
--            ('pending_interaction_check', 'pending_clinician_review',
--            'active'). Rationale: signals fire BEFORE clinician commit per
--            I-002, so the candidate medication is pre-active
--            (pending_clinician_review) at override time — a strict
--            status='active'-only predicate would reject the primary
--            override flow and make the unlock vacuous. Removed/terminal
--            rows (rejected / discontinued / superseded / expired) and
--            missing rows fail the check: if an involved medication has left
--            the list, the interaction evidence is stale and the correct
--            lifecycle path is supersession/resolution, not override.
--            Rejection code `medication_not_on_list` per SI-019 Sub-decision
--            8 (ERRCODE 55000 object_not_in_prerequisite_state → handler
--            maps to tenant-safe 409; same structured-rejection posture as
--            async-consult migration 059's 55006 → 409 precedent).
--          - Patient anchor for STEP 3 comes from
--            interaction_engine_evaluation.patient_id (the signal's parent
--            evaluation), matched against medication_requests
--            .patient_account_id — both VARCHAR(26) account-id space per the
--            landed emit-signal handler contract.
--
-- Spec:    - SI-019 Medication Interaction & Validation Engine Slice PRD
--            v2.0 (RATIFIED 2026-05-21 P-033) §Sub-decision 8 (STEP 0-8;
--            rejection codes medication_not_on_list + unauthorized_role) +
--            §Sub-decision 8.5 (raw writer contract)
--          - CDM v1.6 → v1.7 Amendment §6.NEW7 (RATIFIED 2026-05-21 P-034)
--          - migration 050 §6 (deferral prescription this migration executes)
--          - I-002 (interaction-before-commit; override is the clinician's
--            documented proceed-despite-signal decision on that path)
--          - I-023 (tenant guard), I-025 (structured rejections map to
--            tenant-blind envelopes at the handler), I-027 (Cat A audit
--            emitted app-layer in the same tx per Option 2 carryforward),
--            I-035 (append-only; terminal transition carries its evidence
--            row atomically)
-- Preconditions: 012 (accounts) + 024 (product_catalog) + 025/026
--   (medication_requests) + 027 (account_type='clinician') + 031/062 (SI-010
--   helpers) + 046-050 (med-interaction DB chain) applied.
-- =============================================================================

-- =============================================================================
-- §1 — record_interaction_signal_override() OPERATIONAL body (CDM §6.NEW7)
--
-- Executes the 050 §6 closure pattern: RAISE removed; the 2 evidence checks
-- (STEP 4 LAYER B + STEP 3 medication-still-on-active-list) added where the
-- RAISE was; the block-commented INSERT + PERFORM re-enabled verbatim.
-- Signature is UNCHANGED (14 params) — EXECUTE grants + ownership from 050
-- §6 carry forward across CREATE OR REPLACE.
-- =============================================================================

CREATE OR REPLACE FUNCTION record_interaction_signal_override(
    p_override_id                                VARCHAR(26),
    p_lifecycle_transition_id                    VARCHAR(26),
    p_tenant_id                                  TEXT,
    p_signal_id                                  VARCHAR(26),
    p_clinician_account_id                       VARCHAR(26),
    p_override_rationale_kms_envelope_ciphertext BYTEA,
    p_override_rationale_kms_envelope_dek_id     VARCHAR(26),
    p_override_rationale_kms_envelope_iv         BYTEA,
    p_override_rationale_kms_envelope_tag        BYTEA,
    p_override_rationale_kms_envelope_alg        TEXT,
    p_override_rationale_kms_envelope_alg_version TEXT,
    p_override_rationale_kms_envelope_aad        BYTEA,
    p_override_rationale_kms_envelope_encrypted_at TIMESTAMPTZ,
    p_metadata                                   JSONB
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    v_actor_tenant_id      TEXT;
    v_actor_account_id     TEXT;
    v_lock_key             BIGINT;
    v_latest_to_state      TEXT;
    v_medications_involved VARCHAR(26)[];
    v_patient_id           VARCHAR(26);
    v_missing_count        INTEGER;
BEGIN
    -- STEP 0: SI-010 tenant guard (unchanged from 050 §6).
    v_actor_tenant_id := current_actor_account_tenant_id();
    IF v_actor_tenant_id IS NULL OR v_actor_tenant_id IS DISTINCT FROM p_tenant_id THEN
        RAISE EXCEPTION 'record_interaction_signal_override: tenant scope mismatch'
            USING ERRCODE = '42501';
    END IF;

    -- STEP 4.5: per-(tenant, signal) advisory lock (MUST match raw writer's
    -- lock key per PR 4 R1 closure contract — serializes override creation
    -- with activation decisions). Unchanged from 050 §6.
    v_lock_key := ('x' || substr(md5(p_tenant_id::text || ':' || p_signal_id::text), 1, 16))::bit(64)::bigint;
    PERFORM pg_advisory_xact_lock(v_lock_key);

    -- Evidence: signal's current state is 'active' (only active signals can
    -- be overridden). Unchanged from 050 §6.
    SELECT to_state INTO v_latest_to_state
      FROM public.interaction_signal_lifecycle_transition
     WHERE tenant_id = p_tenant_id AND signal_id = p_signal_id
     ORDER BY transition_at DESC, id DESC
     LIMIT 1;
    IF v_latest_to_state IS DISTINCT FROM 'active' THEN
        RAISE EXCEPTION 'signal_not_active: current_state=%', COALESCE(v_latest_to_state, '<none>')
            USING ERRCODE = '23514';
    END IF;

    -- STEP 4 (evidence check b — LAYER B clinician role-membership,
    -- SI-010-realized per the ratifier Option 2 substitution recorded in
    -- migration 050's header; replaces the RAISE from 050 §6 R1 closure):
    --
    --   (b1) The override MUST be recorded by the authenticated actor
    --        itself — p_clinician_account_id is bound to the SI-010 trust
    --        anchor (current_actor_account_id(); nonce-bound GUC writable
    --        only by bind_actor_context_role per 031 §3 + 062 repair). A
    --        caller with EXECUTE cannot attribute an override to another
    --        clinician.
    --   (b2) That account MUST be a live clinician account in the caller's
    --        tenant (accounts.account_type='clinician' per migration 027;
    --        status='active' — a suspended/archived clinician cannot record
    --        terminal overrides).
    --
    -- Rejection code `unauthorized_role` per SI-019 Sub-decision 8; ERRCODE
    -- 42501 → tenant-blind 403 at the handler (I-025).
    v_actor_account_id := current_actor_account_id();
    IF v_actor_account_id IS NULL
       OR v_actor_account_id IS DISTINCT FROM p_clinician_account_id THEN
        RAISE EXCEPTION
            'unauthorized_role: override must be recorded by the authenticated clinician actor (SI-010 actor binding)'
            USING ERRCODE = '42501';
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM public.accounts
         WHERE tenant_id = p_tenant_id
           AND account_id = p_clinician_account_id
           AND account_type = 'clinician'
           AND status = 'active'
    ) THEN
        RAISE EXCEPTION
            'unauthorized_role: overriding account is not an active clinician account in this tenant'
            USING ERRCODE = '42501';
    END IF;

    -- STEP 3 (evidence check a — medication-still-on-active-list; replaces
    -- the RAISE from 050 §6 R1 closure): EVERY product in the signal's
    -- medications_involved must still be on the signal's patient's
    -- medication list in a live state. See header for the recorded
    -- Option-2 predicate reading (product-identity + live-status set that
    -- includes the I-002 pre-commit pipeline states).
    SELECT s.medications_involved, e.patient_id
      INTO v_medications_involved, v_patient_id
      FROM public.interaction_signal s
      JOIN public.interaction_engine_evaluation e
        ON e.tenant_id = s.tenant_id AND e.id = s.evaluation_id
     WHERE s.tenant_id = p_tenant_id AND s.id = p_signal_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'signal_not_found: signal_id=%', p_signal_id
            USING ERRCODE = '02000';    -- no_data
    END IF;

    IF v_medications_involved IS NULL
       OR COALESCE(array_length(v_medications_involved, 1), 0) = 0 THEN
        -- No medication identities on the signal → the active-list evidence
        -- predicate is unverifiable → fail closed (same posture as the 050
        -- deferral: no terminal override without verifiable evidence).
        RAISE EXCEPTION
            'medication_not_on_list: signal carries no medications_involved to verify'
            USING ERRCODE = '55000';    -- object_not_in_prerequisite_state
    END IF;

    SELECT COUNT(*) INTO v_missing_count
      FROM unnest(v_medications_involved) AS m(product_id)
     WHERE NOT EXISTS (
        SELECT 1 FROM public.medication_requests mr
         WHERE mr.tenant_id = p_tenant_id
           AND mr.patient_account_id = v_patient_id
           AND mr.product_catalog_id = m.product_id
           AND mr.status IN ('pending_interaction_check',
                             'pending_clinician_review',
                             'active')
     );
    IF v_missing_count > 0 THEN
        RAISE EXCEPTION
            'medication_not_on_list: % of % medications_involved have no live medication_request row for this patient',
            v_missing_count, array_length(v_medications_involved, 1)
            USING ERRCODE = '55000';    -- object_not_in_prerequisite_state
    END IF;

    -- STEP 5: INSERT override row FIRST (per SI-019 R4 HIGH-1 closure: write
    -- evidence before terminal transition so a wrapper failure can't leave a
    -- terminal lifecycle row without its evidence). Re-enabled verbatim from
    -- the 050 §6 block comment.
    INSERT INTO public.interaction_signal_override (
        id, tenant_id, signal_id,
        override_by_clinician_account_id,
        override_at,
        override_rationale_kms_envelope_ciphertext,
        override_rationale_kms_envelope_dek_id,
        override_rationale_kms_envelope_iv,
        override_rationale_kms_envelope_tag,
        override_rationale_kms_envelope_alg,
        override_rationale_kms_envelope_alg_version,
        override_rationale_kms_envelope_aad,
        override_rationale_kms_envelope_encrypted_at
    ) VALUES (
        p_override_id, p_tenant_id, p_signal_id,
        p_clinician_account_id,
        clock_timestamp(),
        p_override_rationale_kms_envelope_ciphertext,
        p_override_rationale_kms_envelope_dek_id,
        p_override_rationale_kms_envelope_iv,
        p_override_rationale_kms_envelope_tag,
        p_override_rationale_kms_envelope_alg,
        p_override_rationale_kms_envelope_alg_version,
        p_override_rationale_kms_envelope_aad,
        p_override_rationale_kms_envelope_encrypted_at
    );

    -- STEP 6: call raw writer for 'override' transition; metadata carries
    -- the override_id so audit + domain-event downstream can correlate.
    -- Re-enabled verbatim from the 050 §6 block comment.
    PERFORM record_interaction_signal_lifecycle_transition(
        p_lifecycle_transition_id, p_tenant_id, p_signal_id,
        'overridden', 'override',
        p_clinician_account_id, 'clinician',
        p_metadata || jsonb_build_object('override_id', p_override_id)
    );

    -- STEP 7: unique_violation safety net is the composite UNIQUE on
    -- (tenant_id, id) — a duplicate p_override_id raises 23505 naturally.
    -- STEP 8: caller-managed COMMIT; the handler MUST NOT swallow raised
    -- exceptions (per SI-019 Sub-decision 8 caller transaction discipline —
    -- rejection absorption happens AFTER the caller tx has rolled back).
END;
$$;

-- Ownership + EXECUTE matrix are carried forward by CREATE OR REPLACE
-- (owner override_wrapper_owner; EXECUTE: medication_interaction_
-- override_recorder only) — re-asserted in §3 verification.

-- =============================================================================
-- §2 — Evidence-read grants for the wrapper owner
--
-- The SECDEF body executes as override_wrapper_owner (not BYPASSRLS; RLS
-- tenant predicates still apply via the session tenant GUC). 050 already
-- granted SELECT on interaction_signal_lifecycle_transition + (047 §3)
-- INSERT/SELECT on interaction_signal_override. The new evidence checks
-- read 4 further surfaces:
-- =============================================================================

GRANT SELECT ON interaction_signal              TO override_wrapper_owner;
GRANT SELECT ON interaction_engine_evaluation   TO override_wrapper_owner;
GRANT SELECT ON medication_requests             TO override_wrapper_owner;
GRANT SELECT ON accounts                        TO override_wrapper_owner;

-- Latent live-PG grant fix (surfaced by this PR's live-PostgreSQL
-- integration pass — the first to exercise the operational wrappers):
-- migration 050 §1's record_signal_emission evidence check
-- (`SELECT 1 FROM interaction_signal WHERE tenant_id=... AND id=...`)
-- executes as emission_wrapper_owner, but neither 047 §2 nor 050 §1
-- granted that owner SELECT on interaction_signal — every live emission
-- would fail 42501 inside the SECDEF body. Same grant class 050 §2/§3/§5
-- gave the other wrapper owners for their evidence reads.
GRANT SELECT ON interaction_signal              TO emission_wrapper_owner;

-- =============================================================================
-- §3 — Verification: operational body + ownership + SECDEF + grant matrix
-- =============================================================================

DO $$
DECLARE
    v_oid      OID;
    v_owner    TEXT;
    v_secdef   BOOLEAN;
    v_config   TEXT[];
    v_src      TEXT;
    v_grantee  TEXT;
BEGIN
    v_oid := to_regprocedure(
        'public.record_interaction_signal_override(character varying, character varying, text, '
        || 'character varying, character varying, bytea, character varying, bytea, bytea, text, '
        || 'text, bytea, timestamp with time zone, jsonb)'
    );
    IF v_oid IS NULL THEN
        RAISE EXCEPTION 'migration-070-wrapper-missing: record_interaction_signal_override signature not found';
    END IF;

    SELECT r.rolname, p.prosecdef, p.proconfig, p.prosrc
      INTO v_owner, v_secdef, v_config, v_src
      FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner
     WHERE p.oid = v_oid;

    IF v_owner <> 'override_wrapper_owner' THEN
        RAISE EXCEPTION 'migration-070-ownership-mismatch: owner=%, expected override_wrapper_owner', v_owner;
    END IF;
    IF NOT v_secdef THEN
        RAISE EXCEPTION 'migration-070-secdef-missing';
    END IF;
    IF v_config IS NULL OR NOT (v_config @> ARRAY['search_path=pg_catalog, public']) THEN
        RAISE EXCEPTION 'migration-070-search-path-not-locked: proconfig=%', v_config;
    END IF;

    -- The 050 fail-closed stub is GONE; the 2 evidence checks are present.
    IF position('evidence_check_unavailable_override' IN v_src) > 0 THEN
        RAISE EXCEPTION 'migration-070-stub-still-present: 0A000 fail-closed RAISE was not replaced';
    END IF;
    IF position('medication_not_on_list' IN v_src) = 0
       OR position('unauthorized_role' IN v_src) = 0 THEN
        RAISE EXCEPTION 'migration-070-evidence-checks-missing: STEP 3 / STEP 4 rejection codes not found in body';
    END IF;

    -- EXECUTE matrix: only the owner + medication_interaction_override_recorder.
    FOR v_grantee IN
        SELECT pg_get_userbyid(a.grantee)
          FROM pg_proc p, aclexplode(p.proacl) a
         WHERE p.oid = v_oid AND a.privilege_type = 'EXECUTE'
    LOOP
        IF v_grantee NOT IN ('override_wrapper_owner', 'medication_interaction_override_recorder') THEN
            RAISE EXCEPTION 'migration-070-unexpected-execute-grantee: %', v_grantee;
        END IF;
    END LOOP;

    -- Evidence-read grants present.
    IF NOT (
        has_table_privilege('override_wrapper_owner', 'public.interaction_signal', 'SELECT')
        AND has_table_privilege('override_wrapper_owner', 'public.interaction_engine_evaluation', 'SELECT')
        AND has_table_privilege('override_wrapper_owner', 'public.medication_requests', 'SELECT')
        AND has_table_privilege('override_wrapper_owner', 'public.accounts', 'SELECT')
        AND has_table_privilege('override_wrapper_owner', 'public.interaction_signal_lifecycle_transition', 'SELECT')
        AND has_table_privilege('override_wrapper_owner', 'public.interaction_signal_override', 'INSERT')
    ) THEN
        RAISE EXCEPTION 'migration-070-evidence-grant-missing: override_wrapper_owner lacks a required table privilege';
    END IF;
    IF NOT has_table_privilege('emission_wrapper_owner', 'public.interaction_signal', 'SELECT') THEN
        RAISE EXCEPTION 'migration-070-emission-grant-missing: emission_wrapper_owner lacks SELECT on interaction_signal (050 §1 evidence-check read)';
    END IF;

    -- Negative space: the unlock grants read surfaces to the WRAPPER OWNER
    -- only — the app role gains no direct table access from this migration.
    IF has_table_privilege('medication_interaction_override_recorder', 'public.medication_requests', 'SELECT')
       OR has_table_privilege('medication_interaction_override_recorder', 'public.accounts', 'SELECT') THEN
        RAISE EXCEPTION 'migration-070-app-role-leak: medication_interaction_override_recorder has direct SELECT on an evidence base table';
    END IF;

    RAISE NOTICE 'migration-070: verification passed (override wrapper OPERATIONAL; resolution + expiry deferrals stand)';
END $$;
