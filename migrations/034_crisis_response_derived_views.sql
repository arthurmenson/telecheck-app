-- =============================================================================
-- File:    migrations/034_crisis_response_derived_views.sql
-- Purpose: Create the 2 Crisis Response derived views per the R1 HIGH-2
--          staff/patient reader-view split from P-040 §4.NEW4 + §4.NEW5
--          (SI-022 v1.0 RATIFIED P-039 + CDM follow-on landing P-040
--          2026-05-21).
--
--          PR 2 of the Crisis Response implementation series.
--
--          Two views:
--          1. `crisis_event_current_state_v` (staff view; tenant-wide;
--             latest-state derived via LATERAL JOIN on
--             crisis_event_lifecycle_transition; SELECT granted ONLY to
--             `crisis_event_staff_reader` per R1 HIGH-2 reader-split).
--          2. `crisis_event_patient_summary_v` (patient view; self-scoped
--             via SI-010 actor identity → patient_id match; SELECT granted
--             ONLY to `crisis_event_patient_reader` per R1 HIGH-2 split).
--
--          PER RATIFIER OPTION 2 (carryforward from migration 033):
--          - Tenant isolation via `current_tenant_id()` (code-repo pattern;
--            NOT spec's `current_tenant_id_strict()`).
--          - Patient self-scoping via `current_actor_account_id()` from
--            SI-010 (code-repo pattern; NOT spec's
--            `verify_session_jwt_and_extract_claims().verified_principal_id`
--            from SI-024.1).
--          - Delegation support DEFERRED — patient view filters only by
--            actor's own account_id at v1.0. The code repo has
--            `delegations` table (migration 017) but the cross-table
--            consent_grant predicate the spec uses doesn't translate
--            cleanly. Delegated-access for crisis events lands in a
--            future PR when the delegation lookup helper is canonicalized.
--          - `security_invoker=true + security_barrier=true` on both views
--            per spec; matches the code repo's other derived-view patterns.
--          - View-owner roles owned by the 2 view-owner roles created in
--            migration 032 (NOT BYPASSRLS — RLS on underlying base tables
--            evaluates against the caller's role, not the view-owner's,
--            because of security_invoker=true).
--
-- Spec:    - SI-022 Crisis Response Slice v1.0 §6 (state machine derived
--            from append-only crisis_event_lifecycle_transition rows per I-035)
--          - CDM v1.9 → v1.10 Amendment §4.NEW4 + §4.NEW5 (canonical
--            executable view DDL source; RATIFIED 2026-05-21 P-040;
--            telecheckONE/Telecheck Master Bundle FINAL US REGION BASELINE/
--            Telecheck_CDM_v1_9_to_v1_10_Amendment.md)
--          - P-040 R1 HIGH-2 closure 2026-05-21 (staff/patient reader-view
--            split — patient view predicate-restricted to caller's own
--            patient_id; staff view tenant-wide; SELECT grants per
--            view-owner role canonical pattern)
--          - I-023 (three-layer tenant isolation; view predicates +
--            base-table RLS via security_invoker=true)
--          - I-025 (tenant-blind error responses; views return zero rows
--            for cross-tenant or non-actor's-patient access — no
--            "exists in another scope" leak)
--          - SI-010 trust anchor (migration 031): current_actor_account_id()
--            + current_actor_account_tenant_id() helpers for the patient
--            view's self-scoping predicate.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- PRECONDITIONS: 003_rls_helpers.sql + 031_session_actor_context.sql +
--                032_crisis_response_rbac_roles.sql + 033_crisis_response_entities.sql
--                all applied. The 2 view-owner roles
--                (crisis_event_current_state_view_owner +
--                crisis_event_patient_summary_view_owner) must exist
--                (created at migration 032).
-- ---------------------------------------------------------------------------

-- =============================================================================
-- §1 — crisis_event_current_state_v (P-040 §4.NEW4 staff tenant-wide view)
--
-- Tenant-wide staff view aggregating each crisis_event with its latest
-- lifecycle_transition state. Derived via LATERAL JOIN on
-- crisis_event_lifecycle_transition ordered by transition_at DESC, id DESC
-- (same ordering the spec's monotonic-ordering trigger enforces at INSERT
-- per migration 033 §6).
--
-- security_invoker=true: view body executes with the calling role's
-- privileges, so RLS policies on the underlying crisis_event and
-- lifecycle_transition tables evaluate against the caller (the staff
-- reader). Combined with security_barrier=true (predicate-pushdown safety
-- against malicious operator injection), this delivers the canonical
-- defense-in-depth: RBAC EXECUTE on the view + base-table RLS on the
-- caller + explicit tenant-scope predicate in the view body.
--
-- Grants: SELECT on the view to crisis_event_staff_reader ONLY (per R1
-- HIGH-2 split — patient roles MUST NOT have SELECT on this view).
-- =============================================================================

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
-- Explicit tenant-scope predicate in view body (defense-in-depth alongside
-- base-table RLS). current_tenant_id() returns the calling session's bound
-- tenant per SI-010 trust anchor (migration 003 + 031).
WHERE ce.tenant_id = current_tenant_id();

ALTER VIEW crisis_event_current_state_v
    OWNER TO crisis_event_current_state_view_owner;

REVOKE ALL ON crisis_event_current_state_v FROM PUBLIC;
GRANT SELECT ON crisis_event_current_state_v TO crisis_event_staff_reader;

COMMENT ON VIEW crisis_event_current_state_v IS
    'P-040 §4.NEW4 staff tenant-wide view: each crisis_event with its latest '
    'lifecycle_transition state. security_invoker=true + security_barrier=true. '
    'SELECT granted ONLY to crisis_event_staff_reader per R1 HIGH-2 reader-split. '
    'Patient roles MUST NOT have SELECT on this view.';

-- =============================================================================
-- §2 — crisis_event_patient_summary_v (P-040 §4.NEW5 patient self-scoped view)
--
-- Self-scoped patient view; the predicate restricts rows to the caller's
-- own patient_id (via SI-010 actor helper).
--
-- PER OPTION 2 ADAPTATION: spec's `consent_grant` predicate for delegated
-- access is OMITTED at v1.0 — code repo's consent model (migrations 016
-- + 017: `consent` + `delegations` tables) doesn't have a canonical
-- crisis-event-consent-grant lookup helper. Patient view at v1.0
-- restricts to the calling actor's own patient_id only. Delegated-access
-- lands in a future PR alongside a canonical delegation-lookup function.
--
-- security_invoker=true: RLS on underlying crisis_event evaluates against
-- the caller (the patient_reader). Combined with the actor-identity
-- predicate, a patient can only see their own crisis_event rows; another
-- patient's rows are filtered out by the WHERE clause + RLS in tandem.
--
-- Grants: SELECT on the view to crisis_event_patient_reader ONLY (per R1
-- HIGH-2 split — staff roles MUST NOT have SELECT on this view).
-- =============================================================================

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
    -- Latest transition state
    latest.to_state                       AS current_state,
    latest.transition_at                  AS current_state_transition_at
    -- Note: intentionally OMITTED from patient view (data-minimization vs staff view):
    -- - server_signal_id (Mode 1 envelope reference; staff diagnostic concern, not patient-facing)
    -- - regulatory_reporting_enabled (tenant config; patient need-to-know is the disposition, not the config flag)
    -- - transition_reason / actor_principal_id (operator-internal; patient sees state, not who/why operator-side)
    -- - intake_payload_* KMS envelope columns (PHI encrypted-at-rest; would need decryption + audit emission to expose to patient; deferred)
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
  -- Self-scoping: patient_id MUST match the calling actor's account_id.
  -- current_actor_account_id() returns the SI-010 trust-anchor-verified
  -- account identity for the calling session (NULL if no actor context
  -- bound — fails closed per RLS pattern).
  -- patient_id is UUID; current_actor_account_id() returns TEXT — cast
  -- with explicit error handling (PostgreSQL ::UUID raises on malformed
  -- input, which surfaces as a tenant-blind permission_denied to the
  -- caller per I-025).
  AND ce.patient_id = (
      SELECT current_actor_account_id()::UUID
  );

ALTER VIEW crisis_event_patient_summary_v
    OWNER TO crisis_event_patient_summary_view_owner;

REVOKE ALL ON crisis_event_patient_summary_v FROM PUBLIC;
GRANT SELECT ON crisis_event_patient_summary_v TO crisis_event_patient_reader;

COMMENT ON VIEW crisis_event_patient_summary_v IS
    'P-040 §4.NEW5 patient self-scoped view: caller sees only their own crisis_event rows '
    'via current_actor_account_id() (SI-010 trust anchor). security_invoker=true + '
    'security_barrier=true. SELECT granted ONLY to crisis_event_patient_reader per '
    'R1 HIGH-2 reader-split. Staff roles MUST NOT have SELECT on this view. '
    'Delegated-access (spec consent_grant predicate) DEFERRED — v1.0 patient view restricts '
    'to actor''s own patient_id only; delegation support lands in a future PR alongside a '
    'canonical delegation-lookup function. Data-minimized vs staff view: omits server_signal_id, '
    'regulatory_reporting_enabled, transition_reason, actor_principal_id, intake_payload_* KMS envelope.';

-- =============================================================================
-- §3 — view-owner read grants on underlying tables
--
-- security_invoker=true means the view body executes with the CALLER's
-- privileges (not the view owner's). The view-owner roles therefore do
-- NOT need SELECT grants on the underlying base tables — the readers
-- themselves (crisis_event_staff_reader + crisis_event_patient_reader)
-- need those.
--
-- Grant SELECT on the underlying base tables to the 2 reader roles per
-- the spec's wrapper-only-canonical-read-path (P-040 R1 HIGH-1 closure):
-- direct SELECT on crisis_event / lifecycle_transition is REVOKED from
-- application roles; readers come in through the views only. The views
-- are the SOLE canonical read path for application code.
--
-- Wait — that contradicts security_invoker=true. With security_invoker,
-- the calling role MUST have SELECT on the base tables for the view to
-- work. So we need to grant SELECT on the base tables to the reader roles
-- AND rely on the view body's tenant + actor predicates (plus base-table
-- RLS) for security.
--
-- The code-repo pattern (per migrations 002-029 existing tenant-scoped
-- views) is: grant SELECT on base tables to the reader role; rely on RLS
-- + view predicates for security. We follow that pattern here.
-- =============================================================================

-- Staff reader gets FULL table SELECT — the staff view exposes most fields and
-- staff role legitimately needs operator-side diagnostic columns. Tenant
-- isolation enforced by RLS + view body predicate.
GRANT SELECT ON crisis_event                       TO crisis_event_staff_reader;
GRANT SELECT ON crisis_event_lifecycle_transition  TO crisis_event_staff_reader;

-- R1 HIGH-1 closure 2026-05-22 (PR 2 Codex review): patient reader gets
-- COLUMN-LEVEL SELECT grants matching the patient view's minimization boundary
-- exactly. Without column-level grants, the table-level grant would let the
-- patient_reader directly query SELECT actor_principal_id, transition_reason,
-- intake_payload_*, server_signal_id, etc. from the base tables — bypassing
-- the data-minimization boundary the view defines. With column-level grants,
-- direct base-table queries against the omitted columns fail with
-- "permission denied for column ..." regardless of whether the caller goes
-- through the view or the base table.
--
-- patient_reader minimized column set on crisis_event:
--   id, tenant_id, patient_id, crisis_type, severity, detected_at
-- (OMITTED: server_signal_id, regulatory_reporting_enabled, all intake_payload_*
--  KMS envelope columns)
GRANT SELECT (id, tenant_id, patient_id, crisis_type, severity, detected_at)
    ON crisis_event TO crisis_event_patient_reader;

-- patient_reader minimized column set on crisis_event_lifecycle_transition:
--   id, tenant_id, crisis_event_id, to_state, transition_at
-- (Note: id needed for LATERAL ORDER BY tiebreak; tenant_id + crisis_event_id
--  for join predicate; to_state + transition_at for the projection.
--  OMITTED: from_state, transition_reason, actor_principal_id, transition_payload)
GRANT SELECT (id, tenant_id, crisis_event_id, to_state, transition_at)
    ON crisis_event_lifecycle_transition TO crisis_event_patient_reader;

-- =============================================================================
-- §4 — Verification
-- =============================================================================

DO $$
DECLARE
    v_views_created INTEGER;
    v_views_with_security_invoker INTEGER;
    v_views_with_security_barrier INTEGER;
BEGIN
    -- Both views exist
    SELECT COUNT(*) INTO v_views_created
      FROM pg_views
     WHERE schemaname = 'public'
       AND viewname IN ('crisis_event_current_state_v', 'crisis_event_patient_summary_v');

    IF v_views_created <> 2 THEN
        RAISE EXCEPTION
            'migration-034-view-count-mismatch: '
            'expected 2 crisis_event_*_v views created, found %; '
            'P-040 §4.NEW4 + §4.NEW5 require both', v_views_created;
    END IF;

    -- Both views have security_invoker=true + security_barrier=true reloptions
    SELECT COUNT(*) INTO v_views_with_security_invoker
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relname IN ('crisis_event_current_state_v', 'crisis_event_patient_summary_v')
       AND c.relkind = 'v'
       AND c.reloptions @> ARRAY['security_invoker=true'];

    IF v_views_with_security_invoker <> 2 THEN
        RAISE EXCEPTION
            'migration-034-security-invoker-missing: '
            'expected both views to have security_invoker=true, found % compliant',
            v_views_with_security_invoker;
    END IF;

    SELECT COUNT(*) INTO v_views_with_security_barrier
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relname IN ('crisis_event_current_state_v', 'crisis_event_patient_summary_v')
       AND c.relkind = 'v'
       AND c.reloptions @> ARRAY['security_barrier=true'];

    IF v_views_with_security_barrier <> 2 THEN
        RAISE EXCEPTION
            'migration-034-security-barrier-missing: '
            'expected both views to have security_barrier=true, found % compliant',
            v_views_with_security_barrier;
    END IF;

    -- View ownership per canonical pattern
    PERFORM 1
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_roles r ON r.oid = c.relowner
     WHERE n.nspname = 'public'
       AND c.relname = 'crisis_event_current_state_v'
       AND r.rolname = 'crisis_event_current_state_view_owner';
    IF NOT FOUND THEN
        RAISE EXCEPTION
            'migration-034-view-ownership: crisis_event_current_state_v ownership MUST be crisis_event_current_state_view_owner';
    END IF;

    PERFORM 1
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_roles r ON r.oid = c.relowner
     WHERE n.nspname = 'public'
       AND c.relname = 'crisis_event_patient_summary_v'
       AND r.rolname = 'crisis_event_patient_summary_view_owner';
    IF NOT FOUND THEN
        RAISE EXCEPTION
            'migration-034-view-ownership: crisis_event_patient_summary_v ownership MUST be crisis_event_patient_summary_view_owner';
    END IF;

    -- Grant matrix: staff_reader has SELECT on staff view + base tables;
    -- patient_reader has SELECT on patient view + base tables.
    -- (Negative assertions — anti-cross-grants — deferred to P-040 §8.1 class P
    -- preflight discipline that would land in a future migration aligning with
    -- the full preflight class enumeration.)
    PERFORM 1 FROM information_schema.role_table_grants
     WHERE grantee = 'crisis_event_staff_reader'
       AND table_name = 'crisis_event_current_state_v'
       AND privilege_type = 'SELECT';
    IF NOT FOUND THEN
        RAISE EXCEPTION
            'migration-034-grant-missing: crisis_event_staff_reader is missing SELECT on crisis_event_current_state_v';
    END IF;

    PERFORM 1 FROM information_schema.role_table_grants
     WHERE grantee = 'crisis_event_patient_reader'
       AND table_name = 'crisis_event_patient_summary_v'
       AND privilege_type = 'SELECT';
    IF NOT FOUND THEN
        RAISE EXCEPTION
            'migration-034-grant-missing: crisis_event_patient_reader is missing SELECT on crisis_event_patient_summary_v';
    END IF;

    -- R1 HIGH-1 closure 2026-05-22: NEGATIVE assertions proving the data-
    -- minimization boundary holds at the privilege layer. patient_reader MUST NOT
    -- have SELECT on staff-only columns of either base table; direct queries
    -- against those columns will fail with permission_denied.
    --
    -- crisis_event omitted-column assertions:
    PERFORM 1 FROM information_schema.role_column_grants
     WHERE grantee = 'crisis_event_patient_reader'
       AND table_name = 'crisis_event'
       AND column_name IN ('server_signal_id', 'regulatory_reporting_enabled',
                           'intake_payload_ciphertext', 'intake_payload_dek_id',
                           'intake_payload_dek_version', 'intake_payload_iv',
                           'intake_payload_auth_tag', 'intake_payload_kek_id',
                           'intake_payload_kek_version', 'intake_payload_algorithm')
       AND privilege_type = 'SELECT';
    IF FOUND THEN
        RAISE EXCEPTION
            'migration-034-grant-leak: crisis_event_patient_reader has SELECT on one or more staff-only columns of crisis_event (server_signal_id / regulatory_reporting_enabled / intake_payload_*); data-minimization boundary violated';
    END IF;
    --
    -- crisis_event_lifecycle_transition omitted-column assertions:
    PERFORM 1 FROM information_schema.role_column_grants
     WHERE grantee = 'crisis_event_patient_reader'
       AND table_name = 'crisis_event_lifecycle_transition'
       AND column_name IN ('from_state', 'transition_reason', 'actor_principal_id', 'transition_payload')
       AND privilege_type = 'SELECT';
    IF FOUND THEN
        RAISE EXCEPTION
            'migration-034-grant-leak: crisis_event_patient_reader has SELECT on one or more operator-internal columns of crisis_event_lifecycle_transition (from_state / transition_reason / actor_principal_id / transition_payload); data-minimization boundary violated';
    END IF;
END $$;
