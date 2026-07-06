-- =============================================================================
-- File:    migrations/057_async_consult_derived_views.sql
-- Purpose: Create the 2 Async Consult caller-class-split derived views per
--          CDM v1.8 → v1.9 amendment (RATIFIED P-038 2026-05-21) §4.NEW8:
--
--          1. `async_consult_staff_summary_v` (staff view; tenant-wide queue
--             visibility for clinician/admin/pharmacy triage; SELECT granted
--             ONLY to `async_consult_staff_reader` per P-038 R5 HIGH-1 split).
--          2. `async_consult_patient_summary_v` (patient/delegate view;
--             self-scoped to the caller's own consults — patient principal
--             via SI-010 actor identity, delegate principal via an active
--             `book_consults` delegation scope; SELECT granted ONLY to
--             `async_consult_patient_reader`).
--
--          PR 3 of the Async Consult Sprint-10 series (PR 1 = 055 roles,
--          PR 2 = 056 entities). Follows the Crisis Response migration 034
--          derived-views cadence + the SI-025/054 patient-reader lessons.
--
-- Option 2 adaptations from spec (recorded divergences):
--   - Tenant isolation via `current_tenant_id()` (code-repo pattern; NOT
--     spec's `current_tenant_id_strict()`).
--   - Caller identity via `current_actor_account_id()` from SI-010
--     (migration 031; code-repo pattern) — NOT spec's
--     `verify_session_jwt_and_extract_claims()` CTE from SI-024.1. TEXT
--     compares TEXT (no ::UUID cast — SI-025 P-045 lesson; patient_id is
--     canonical VARCHAR(26) per migration 056).
--   - Spec's `consent_grant` delegate predicate (P-038 §12 OQ4 anticipated
--     the entity-name divergence) realized against the code-repo canonical
--     `delegations` + `delegation_scopes` tables (migration 017):
--     delegate principal is authorized IFF an active delegation
--     (status='active') from the consult's patient (grantor) to the caller
--     (delegate) carries an unrevoked `book_consults` scope. Unlike the
--     crisis slice (which deferred delegation at v1.0), the async-consult
--     delegate path is implemented here because the SI-020 consult flow is
--     delegate-initiated by design and the delegation tables translate
--     1:1.
--   - `security_invoker=true + security_barrier=true` on both views
--     (crisis 034 pattern): view body executes with the CALLER's
--     privileges, so base-table RLS evaluates against the calling reader
--     role; reader roles get column-level base-table SELECT grants
--     matching each view's data-minimization boundary exactly (P-040 R1
--     HIGH-1 column-grant closure pattern) — ciphertext columns are NOT
--     grantable to either reader.
--   - `consult_current_state_mv` (P-038 §4.NEW9, marked OPTIONAL) is
--     DEFERRED to a hygiene PR. The staff view's LATERAL latest-state
--     derivation is the pilot read path; the MV requires the full
--     migration-048 lockdown apparatus (MV grant sweep + SECDEF access
--     function) and is a read-path optimization, not a correctness
--     surface. Deferral recorded here + in the module README when the
--     handler PR lands.
--
-- Preconditions: migrations 000–056 applied (roles from 055; entities from
--   056; SI-010 helpers from 031; delegations from 017).
--
-- Invariants: I-023 (RLS + view predicates), I-025 (views return zero rows
--   for cross-tenant / non-authorized access — no existence leak), I-026
--   (ciphertext columns excluded from both views AND from reader grants).
-- =============================================================================

-- ---------------------------------------------------------------------------
-- §0 — Preflight: view owner exists + NOBYPASSRLS
-- ---------------------------------------------------------------------------

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'async_consult_view_owner') THEN
        RAISE EXCEPTION 'migration-057-prerequisite-missing: async_consult_view_owner does not exist (apply migration 055 first)'
            USING ERRCODE = 'undefined_object';
    END IF;
    IF (SELECT rolbypassrls FROM pg_roles WHERE rolname = 'async_consult_view_owner') THEN
        RAISE EXCEPTION 'migration-057-preflight: async_consult_view_owner has BYPASSRLS; must be revoked before view ownership per P-036 R7 closure'
            USING ERRCODE = 'insufficient_privilege';
    END IF;
END $$;

-- =============================================================================
-- §1 — async_consult_staff_summary_v (P-038 §4.NEW8 view 2; tenant-wide)
--
-- Clinician/admin/pharmacy review-queue read path. Latest lifecycle state
-- derived via LATERAL (matches the ORDER BY the migration 056 continuity
-- trigger's strict-monotonic invariant makes unambiguous).
-- =============================================================================

CREATE OR REPLACE VIEW async_consult_staff_summary_v
WITH (security_invoker = true, security_barrier = true)
AS
SELECT
    c.id                                  AS consult_id,
    c.tenant_id,
    c.patient_id,
    c.consult_type,
    c.created_at,
    latest.to_state                       AS current_state,
    latest_decision.decision_type         AS decision_type,
    (SELECT COUNT(*) FROM public.consult_clinician_decision d
      WHERE d.tenant_id = c.tenant_id AND d.consult_id = c.id
        AND d.decision_type = 'prescribe')                       AS prescribing_count,
    (SELECT COUNT(*) FROM public.consult_follow_up_message m
      WHERE m.tenant_id = c.tenant_id AND m.consult_id = c.id)   AS follow_up_message_count,
    latest.transition_at                  AS last_transition_at
FROM public.consult c
LEFT JOIN LATERAL (
    SELECT to_state, transition_at
      FROM public.consult_lifecycle_transition lt
     WHERE lt.tenant_id = c.tenant_id
       AND lt.consult_id = c.id
     ORDER BY lt.transition_at DESC, lt.id DESC
     LIMIT 1
) latest ON TRUE
LEFT JOIN LATERAL (
    SELECT decision_type
      FROM public.consult_clinician_decision d
     WHERE d.tenant_id = c.tenant_id
       AND d.consult_id = c.id
     ORDER BY d.decided_at DESC
     LIMIT 1
) latest_decision ON TRUE
WHERE c.tenant_id = current_tenant_id();

ALTER VIEW async_consult_staff_summary_v
    OWNER TO async_consult_view_owner;

REVOKE ALL ON async_consult_staff_summary_v FROM PUBLIC;
GRANT SELECT ON async_consult_staff_summary_v TO async_consult_staff_reader;

COMMENT ON VIEW async_consult_staff_summary_v IS
    'P-038 §4.NEW8 staff tenant-wide view: each consult with its latest lifecycle '
    'state + latest decision_type + prescribe/message counts. security_invoker=true '
    '+ security_barrier=true. SELECT granted ONLY to async_consult_staff_reader per '
    'P-038 R5 HIGH-1 caller-class split. Patient/delegate roles MUST NOT have SELECT '
    'on this view (tenant-wide metadata would leak other patients'' consults).';

-- =============================================================================
-- §2 — async_consult_patient_summary_v (P-038 §4.NEW8 view 1; self-scoped)
--
-- Patient/delegate read path. Same projected columns as the staff view
-- (P-038 defines identical column lists for both; the difference is the
-- authorization predicate), restricted to the caller's own consults:
--   (a) patient principal: consult.patient_id == caller's actor account_id
--   (b) delegate principal: an ACTIVE delegation from the consult's patient
--       to the caller carrying an unrevoked book_consults scope
-- =============================================================================

CREATE OR REPLACE VIEW async_consult_patient_summary_v
WITH (security_invoker = true, security_barrier = true)
AS
SELECT
    c.id                                  AS consult_id,
    c.tenant_id,
    c.patient_id,
    c.consult_type,
    c.created_at,
    latest.to_state                       AS current_state,
    latest_decision.decision_type         AS decision_type,
    (SELECT COUNT(*) FROM public.consult_clinician_decision d
      WHERE d.tenant_id = c.tenant_id AND d.consult_id = c.id
        AND d.decision_type = 'prescribe')                       AS prescribing_count,
    (SELECT COUNT(*) FROM public.consult_follow_up_message m
      WHERE m.tenant_id = c.tenant_id AND m.consult_id = c.id)   AS follow_up_message_count,
    latest.transition_at                  AS last_transition_at
FROM public.consult c
LEFT JOIN LATERAL (
    SELECT to_state, transition_at
      FROM public.consult_lifecycle_transition lt
     WHERE lt.tenant_id = c.tenant_id
       AND lt.consult_id = c.id
     ORDER BY lt.transition_at DESC, lt.id DESC
     LIMIT 1
) latest ON TRUE
LEFT JOIN LATERAL (
    SELECT decision_type
      FROM public.consult_clinician_decision d
     WHERE d.tenant_id = c.tenant_id
       AND d.consult_id = c.id
     ORDER BY d.decided_at DESC
     LIMIT 1
) latest_decision ON TRUE
WHERE c.tenant_id = current_tenant_id()
  AND (
    -- (a) Patient principal: caller's SI-010-verified account identity
    --     matches this consult's patient. TEXT = TEXT (VARCHAR(26)
    --     canonical identity per SI-025 P-045 + migration 056; NO ::UUID
    --     cast — the exact defect class SI-025 remediated in crisis).
    --     current_actor_account_id() returns NULL when no actor context is
    --     bound — the predicate then fails closed (NULL = anything is not
    --     TRUE).
    c.patient_id = current_actor_account_id()
    -- (b) Delegate principal: active delegation from the consult's patient
    --     (grantor) to the caller (delegate) with an unrevoked
    --     book_consults scope (P-038 §4.NEW8 delegate clause realized
    --     against migration 017's canonical tables per §12 OQ4).
    OR EXISTS (
        SELECT 1
          FROM public.delegations dg
          JOIN public.delegation_scopes ds
            ON ds.tenant_id = dg.tenant_id
           AND ds.delegation_id = dg.delegation_id
         WHERE dg.tenant_id = c.tenant_id
           AND dg.grantor_account_id = c.patient_id
           AND dg.delegate_account_id = current_actor_account_id()
           AND dg.status = 'active'
           AND ds.scope = 'book_consults'
           AND ds.revoked_at IS NULL
    )
  );

ALTER VIEW async_consult_patient_summary_v
    OWNER TO async_consult_view_owner;

REVOKE ALL ON async_consult_patient_summary_v FROM PUBLIC;
GRANT SELECT ON async_consult_patient_summary_v TO async_consult_patient_reader;

COMMENT ON VIEW async_consult_patient_summary_v IS
    'P-038 §4.NEW8 patient/delegate self-scoped view: caller sees only their own '
    'consults — patient principal via current_actor_account_id() (SI-010 trust '
    'anchor; TEXT-to-TEXT, no ::UUID cast per SI-025 P-045 lesson), delegate '
    'principal via active delegations + unrevoked book_consults delegation_scope '
    '(migration 017 canonical tables per P-038 §12 OQ4). security_invoker=true + '
    'security_barrier=true. SELECT granted ONLY to async_consult_patient_reader per '
    'P-038 R5 HIGH-1 caller-class split. Staff roles MUST NOT have SELECT on this view.';

-- =============================================================================
-- §3 — Reader-role base-table grants (column-level; P-040 R1 HIGH-1 pattern)
--
-- security_invoker=true means the view body executes with the CALLER's
-- privileges — the reader roles need SELECT on exactly the base-table
-- columns the views project/filter on, and NOTHING more. Column-level
-- grants make direct base-table queries against non-view columns
-- (ciphertext envelopes, payment fields, actor metadata) fail with
-- "permission denied for column ..." regardless of path. Ciphertext
-- columns are NOT granted to either reader (I-026 boundary).
-- =============================================================================

-- Both readers: the shared projection columns
GRANT SELECT (id, tenant_id, patient_id, consult_type, created_at)
    ON consult
    TO async_consult_staff_reader, async_consult_patient_reader;
GRANT SELECT (tenant_id, consult_id, to_state, transition_at, id)
    ON consult_lifecycle_transition
    TO async_consult_staff_reader, async_consult_patient_reader;
GRANT SELECT (tenant_id, consult_id, decision_type, decided_at)
    ON consult_clinician_decision
    TO async_consult_staff_reader, async_consult_patient_reader;
GRANT SELECT (tenant_id, consult_id)
    ON consult_follow_up_message
    TO async_consult_staff_reader, async_consult_patient_reader;

-- Patient reader additionally: the delegate-authorization lookup columns
GRANT SELECT (tenant_id, delegation_id, grantor_account_id, delegate_account_id, status)
    ON delegations
    TO async_consult_patient_reader;
GRANT SELECT (tenant_id, delegation_id, scope, revoked_at)
    ON delegation_scopes
    TO async_consult_patient_reader;

-- SI-010 actor-helper EXECUTE for the patient reader (migration 054 lesson:
-- security_invoker=true evaluates the predicate under the reader role, which
-- otherwise lacks EXECUTE on the SI-010 helpers → permission_denied → every
-- patient request 403s even with a valid token).
GRANT EXECUTE ON FUNCTION current_actor_account_id()        TO async_consult_patient_reader;
GRANT EXECUTE ON FUNCTION current_actor_account_tenant_id() TO async_consult_patient_reader;

-- =============================================================================
-- §4 — Verification
-- =============================================================================

DO $$
DECLARE
    v_count INTEGER;
    v_view  TEXT;
BEGIN
    FOREACH v_view IN ARRAY ARRAY['async_consult_staff_summary_v', 'async_consult_patient_summary_v'] LOOP
        IF NOT EXISTS (
            SELECT 1 FROM pg_views WHERE schemaname = 'public' AND viewname = v_view
        ) THEN
            RAISE EXCEPTION 'migration-057-verification: view % missing', v_view
                USING ERRCODE = 'check_violation';
        END IF;
        -- Owner must be async_consult_view_owner
        IF (SELECT viewowner FROM pg_views WHERE schemaname = 'public' AND viewname = v_view)
           <> 'async_consult_view_owner' THEN
            RAISE EXCEPTION 'migration-057-verification: view % owner is not async_consult_view_owner', v_view
                USING ERRCODE = 'check_violation';
        END IF;
        -- security_invoker must be set
        IF NOT EXISTS (
            SELECT 1 FROM pg_class c
            JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = 'public' AND c.relname = v_view
              AND c.reloptions::text LIKE '%security_invoker=true%'
        ) THEN
            RAISE EXCEPTION 'migration-057-verification: view % missing security_invoker=true', v_view
                USING ERRCODE = 'check_violation';
        END IF;
    END LOOP;

    -- Cross-class grant check: patient reader must NOT have SELECT on the
    -- staff view and vice versa (P-038 R5 HIGH-1 split).
    SELECT COUNT(*) INTO v_count
      FROM information_schema.role_table_grants
     WHERE table_schema = 'public'
       AND (   (table_name = 'async_consult_staff_summary_v'   AND grantee = 'async_consult_patient_reader')
            OR (table_name = 'async_consult_patient_summary_v' AND grantee = 'async_consult_staff_reader'));
    IF v_count > 0 THEN
        RAISE EXCEPTION 'migration-057-verification: cross-class view grant detected (% rows) — violates P-038 R5 HIGH-1 caller-class split', v_count
            USING ERRCODE = 'check_violation';
    END IF;
END $$;
