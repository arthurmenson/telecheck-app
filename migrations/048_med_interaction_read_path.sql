-- =============================================================================
-- File:    migrations/048_med_interaction_read_path.sql
-- Purpose: Create the Med-Interaction read-path projection surfaces per CDM
--          v1.6 → v1.7 Amendment §4.NEW5 (RATIFIED 2026-05-21 P-034) +
--          SI-019 v2.0 Sub-decision 9 (RATIFIED 2026-05-21 P-033):
--            1. interaction_signal_current_state_mv  — optional rebuildable
--               materialized view (current state per signal; non-authoritative
--               hot-path-DISPLAY read path).
--            2. interaction_signal_current_state_v    — SECURITY BARRIER view
--               (tenant-scoped app-facing read surface; set queries).
--            3. get_interaction_signal_current_state() — SECURITY DEFINER
--               access function (singleton-lookup read surface).
--
--          PR 3 of the Med-Interaction Engine implementation series (continued
--          from migration 046 RBAC roles + migration 047 entities). Subsequent
--          migrations: raw lifecycle writer SECDEF + anti-bypass grants
--          (PR 4) → 6 reason-specific wrappers (PR 5) → Fastify handlers
--          (PR 6+). Mirrors Crisis Response (034) + Admin Backend (041)
--          derived-view cadence.
--
--          NON-AUTHORITATIVE per I-035: interaction_signal_lifecycle_transition
--          is the source of truth. The MV is rebuildable + droppable at any
--          time without data loss. STRICT-FRESHNESS consumers (override
--          procedure, prescribing decision gates, refill release checks,
--          protocol gates, pharmacy enforcement) MUST query the transition
--          table directly per SI-019 Sub-decision 9 read-path consumer
--          classification — NOT this MV. The MV / view / function are for
--          HOT-PATH DISPLAY only (clinician dashboard, pharmacy portal
--          active-signals indicator, patient mobile summary, admin reporting),
--          where stale-state labeling is the caller's responsibility.
--
--          PER RATIFIER OPTION 2 (carryforward from Crisis Response + Admin
--          Backend PRs; docs/crisis-response-implementation-plan.md):
--          - `current_tenant_id_strict('interaction_signal_current_state_mv')`
--            (spec R5 HIGH-1 SI-024.1 JWT trust anchor) → `current_tenant_id()`
--            (code-repo GUC trust anchor from migration 003). The code repo
--            does not yet carry the SI-024.1 v0.8 JWT-binding helpers; the
--            cutover to current_tenant_id_strict() happens in a later
--            foundation hygiene cycle (same posture as migrations 047 / 041 /
--            034). The tenant predicate remains the trust boundary for MV
--            access (PostgreSQL materialized views do not enforce RLS).
--          - `ulid_t` (param + return-column types) → VARCHAR(26) (code-repo
--            PK type; migrations 047 / 006 / 012 / etc.).
--          - `interaction_signal_state_t` / `interaction_signal_transition_reason_t`
--            (declared return domains) → TEXT. The MV columns are already TEXT
--            (inherited from the transition table's TEXT + CHECK columns), so
--            the spec R1 MED-1 explicit casts become no-ops and are omitted;
--            the app-facing CHECK-equivalence is enforced upstream at the
--            transition table. A future TYPES amendment cycle formalizing
--            DOMAIN types would reintroduce them as no-op casts.
--          - MV owned by the migration applier (postgres); explicit SELECT
--            granted to mv_refresh_owner (the refresh/reconciliation scheduler
--            role from migration 046). The SECURITY BARRIER view is also
--            applier-owned so its owner-privilege read of the MV succeeds
--            (applier owns the MV); app roles never get direct MV SELECT.
--          - SECDEF access function OWNED BY mv_refresh_owner per spec §4.NEW5
--            ALTER; mv_refresh_owner holds the explicit MV SELECT grant so the
--            SECURITY DEFINER read resolves under a role that can see the MV.
--
-- Spec:    - CDM v1.6 → v1.7 Amendment §4.NEW5 (canonical executable DDL
--            source; RATIFIED 2026-05-21 P-034; sibling repo: telecheckONE/
--            Telecheck Master Bundle FINAL US REGION BASELINE/
--            Telecheck_CDM_v1_6_to_v1_7_Amendment.md)
--          - SI-019 Medication Interaction & Validation Engine Slice PRD v2.0
--            §Sub-decision 9 (read-path consumer classification; RATIFIED
--            2026-05-21 P-033)
--          - I-023 (three-layer tenant isolation; tenant predicate enforced
--            at the view + access-function layer because the MV itself is
--            non-RLS-enforced)
--          - I-035 (append-only invariant; the MV is a non-authoritative
--            projection of the append-only transition log)
-- Summary: Creates 1 materialized view + 1 SECURITY BARRIER view + 1 SECURITY
--          DEFINER access function + the unique index required for REFRESH
--          MATERIALIZED VIEW CONCURRENTLY, with REVOKE-FROM-PUBLIC + targeted
--          GRANTs + the function owner ALTER. No SECDEF write procedures in
--          this migration — those land in PR 4-5.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- PRECONDITIONS:
--   001_tenants.sql                              applied (tenants table)
--   003_rls_helpers.sql                          applied (current_tenant_id())
--   046_med_interaction_rbac_roles.sql           applied (medication_interaction_signal_viewer
--                                                  + mv_refresh_owner roles)
--   047_med_interaction_entities.sql             applied (interaction_signal_lifecycle_transition)
-- ---------------------------------------------------------------------------

-- =============================================================================
-- §1 — interaction_signal_current_state_mv (CDM §4.NEW5 materialized view)
--
-- DISTINCT ON (tenant_id, signal_id) ordered by (transition_at DESC, id DESC)
-- yields the latest lifecycle row per signal — the same ordering predicate the
-- canonical current-state derivation uses (migration 047 §4 trigger + spec
-- Sub-decision 5). current_state = the latest to_state.
-- =============================================================================

CREATE MATERIALIZED VIEW interaction_signal_current_state_mv AS
SELECT DISTINCT ON (tenant_id, signal_id)
    tenant_id,
    signal_id,
    to_state          AS current_state,
    transition_at     AS as_of,
    transition_reason
FROM public.interaction_signal_lifecycle_transition
ORDER BY tenant_id, signal_id, transition_at DESC, id DESC;

-- UNIQUE index required for REFRESH MATERIALIZED VIEW CONCURRENTLY (per spec
-- refresh model: 30s schedule OR incremental via the
-- signal_lifecycle_transition_emitted.v1 domain-event subscriber).
CREATE UNIQUE INDEX interaction_signal_current_state_mv_pk
    ON interaction_signal_current_state_mv (tenant_id, signal_id);

-- MV access restricted: PostgreSQL materialized views do NOT natively enforce
-- RLS, so a direct GRANT SELECT on the MV is a tenant-isolation bypass (per
-- SI-019 R2 HIGH-2 closure). Direct access limited to mv_refresh_owner only
-- (the refresh/reconciliation scheduler + the SECDEF access-function owner);
-- app roles read via the SECURITY BARRIER view OR the SECDEF access function
-- below — both of which apply the current_tenant_id() predicate.
REVOKE ALL ON interaction_signal_current_state_mv FROM PUBLIC;
GRANT SELECT ON interaction_signal_current_state_mv TO mv_refresh_owner;

-- =============================================================================
-- §2 — interaction_signal_current_state_v (CDM §4.NEW5 SECURITY BARRIER view)
--
-- App-facing set-query read surface (clinician dashboard list-all-active, etc.).
-- security_barrier=true ensures the tenant predicate is applied before any
-- user-supplied predicate with side effects (predicate-pushdown safety).
-- View is applier-owned (postgres); since the applier owns the MV, the
-- owner-privilege read of the MV succeeds without granting app roles direct
-- MV SELECT. The current_tenant_id() predicate is the tenant trust boundary.
--
-- Option 2: current_tenant_id_strict('interaction_signal_current_state_mv')
--           → current_tenant_id() (code-repo GUC trust anchor).
-- =============================================================================

CREATE VIEW interaction_signal_current_state_v
    WITH (security_barrier = true) AS
SELECT
    tenant_id,
    signal_id,
    current_state,
    as_of,
    transition_reason
FROM public.interaction_signal_current_state_mv
WHERE tenant_id = current_tenant_id();

REVOKE ALL ON interaction_signal_current_state_v FROM PUBLIC;
GRANT SELECT ON interaction_signal_current_state_v
    TO medication_interaction_signal_viewer;

-- =============================================================================
-- §3 — get_interaction_signal_current_state() (CDM §4.NEW5 SECDEF access fn)
--
-- Alternate read pattern for singleton lookups (e.g., cross-reference from an
-- audit row to a single signal's current state). SECURITY DEFINER + OWNED BY
-- mv_refresh_owner so the MV read resolves under the role that holds the MV
-- SELECT grant. The current_tenant_id() predicate is the tenant trust boundary
-- (the MV is non-RLS-enforced; the function is the access boundary).
--
-- Option 2 adaptations:
--   - p_signal_id ulid_t → VARCHAR(26)
--   - RETURNS TABLE column domains (interaction_signal_state_t /
--     interaction_signal_transition_reason_t) → TEXT; MV columns are already
--     TEXT, so the spec R1 MED-1 explicit casts are no-ops and omitted.
--   - current_tenant_id_strict(...) → public.current_tenant_id()
--   - search_path locked to pg_catalog, pg_temp; all object references are
--     schema-qualified (public.) so no public on the search_path is required.
-- =============================================================================

CREATE FUNCTION get_interaction_signal_current_state(p_signal_id VARCHAR(26))
RETURNS TABLE(
    signal_id          VARCHAR(26),
    current_state      TEXT,
    as_of              TIMESTAMPTZ,
    transition_reason  TEXT
) AS $$
    SELECT
        mv.signal_id,
        mv.current_state,
        mv.as_of,
        mv.transition_reason
    FROM public.interaction_signal_current_state_mv mv
    WHERE mv.tenant_id = public.current_tenant_id()
      AND mv.signal_id = p_signal_id;
$$ LANGUAGE sql SECURITY DEFINER STABLE SET search_path = pg_catalog, pg_temp;

ALTER FUNCTION public.get_interaction_signal_current_state(VARCHAR(26))
    OWNER TO mv_refresh_owner;
REVOKE EXECUTE ON FUNCTION public.get_interaction_signal_current_state(VARCHAR(26))
    FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_interaction_signal_current_state(VARCHAR(26))
    TO medication_interaction_signal_viewer;

-- =============================================================================
-- §4 — Verification
--
-- Asserts the 3 read-path surfaces exist with the correct properties:
--   1. MV exists + has the UNIQUE index (REFRESH CONCURRENTLY precondition)
--      + direct SELECT is NOT granted to PUBLIC or to the signal_viewer role
--      (tenant-isolation-bypass anti-drift).
--   2. SECURITY BARRIER view exists + security_barrier reloption is set.
--   3. Access function exists + is SECURITY DEFINER + OWNED BY mv_refresh_owner
--      + has a locked search_path (OID-gated via to_regprocedure).
-- =============================================================================

DO $$
DECLARE
    v_mv_oid              OID := to_regclass('public.interaction_signal_current_state_mv');
    v_view_oid            OID := to_regclass('public.interaction_signal_current_state_v');
    v_uniq_index_present  BOOLEAN;
    v_view_reloptions     TEXT[];
    v_mv_public_select     BOOLEAN;
    v_mv_viewer_select     BOOLEAN;
BEGIN
    -- 1. MV present
    IF v_mv_oid IS NULL THEN
        RAISE EXCEPTION
            'migration-048-mv-missing: interaction_signal_current_state_mv not created';
    END IF;

    -- UNIQUE index present (REFRESH CONCURRENTLY precondition)
    SELECT EXISTS (
        SELECT 1
          FROM pg_index i
          JOIN pg_class ic ON ic.oid = i.indexrelid
         WHERE i.indrelid = v_mv_oid
           AND i.indisunique
           AND ic.relname = 'interaction_signal_current_state_mv_pk'
    ) INTO v_uniq_index_present;

    IF NOT v_uniq_index_present THEN
        RAISE EXCEPTION
            'migration-048-mv-unique-index-missing: '
            'interaction_signal_current_state_mv_pk UNIQUE index absent; '
            'REFRESH MATERIALIZED VIEW CONCURRENTLY would fail';
    END IF;

    -- Anti-drift: direct MV SELECT must NOT be held by PUBLIC or by the
    -- app-facing signal_viewer role (MV is a tenant-isolation bypass surface).
    v_mv_public_select := has_table_privilege('public', v_mv_oid, 'SELECT');
    v_mv_viewer_select := has_table_privilege(
        'medication_interaction_signal_viewer', v_mv_oid, 'SELECT');

    IF v_mv_public_select THEN
        RAISE EXCEPTION
            'migration-048-mv-public-select-leak: PUBLIC holds SELECT on the MV '
            '(tenant-isolation bypass; MVs do not enforce RLS)';
    END IF;
    IF v_mv_viewer_select THEN
        RAISE EXCEPTION
            'migration-048-mv-viewer-select-leak: medication_interaction_signal_viewer '
            'holds DIRECT SELECT on the MV; app roles must read only via the '
            'SECURITY BARRIER view / SECDEF access function (tenant-scoped)';
    END IF;

    -- 2. View present + security_barrier set
    IF v_view_oid IS NULL THEN
        RAISE EXCEPTION
            'migration-048-view-missing: interaction_signal_current_state_v not created';
    END IF;

    SELECT c.reloptions INTO v_view_reloptions
      FROM pg_class c WHERE c.oid = v_view_oid;

    IF v_view_reloptions IS NULL
       OR NOT (v_view_reloptions @> ARRAY['security_barrier=true']) THEN
        RAISE EXCEPTION
            'migration-048-view-not-security-barrier: '
            'interaction_signal_current_state_v missing security_barrier=true; found %',
            v_view_reloptions;
    END IF;
END $$;

-- Access-function shape: SECURITY DEFINER + OWNED BY mv_refresh_owner +
-- locked search_path. OID-gated via to_regprocedure with the exact signature.
DO $$
DECLARE
    v_fn_oid           OID := to_regprocedure(
        'public.get_interaction_signal_current_state(character varying)');
    v_owner_name       TEXT;
    v_security_definer BOOLEAN;
    v_proconfig        TEXT[];
BEGIN
    IF v_fn_oid IS NULL THEN
        RAISE EXCEPTION
            'migration-048-access-function-missing: '
            'get_interaction_signal_current_state(varchar) not found by signature';
    END IF;

    SELECT r.rolname, p.prosecdef, p.proconfig
      INTO v_owner_name, v_security_definer, v_proconfig
      FROM pg_proc p
      JOIN pg_roles r ON r.oid = p.proowner
     WHERE p.oid = v_fn_oid;

    IF v_owner_name <> 'mv_refresh_owner' THEN
        RAISE EXCEPTION
            'migration-048-access-function-owner-mismatch: '
            'owner is % but MUST be mv_refresh_owner (holds the MV SELECT grant '
            'the SECURITY DEFINER read depends on)', v_owner_name;
    END IF;

    IF NOT v_security_definer THEN
        RAISE EXCEPTION
            'migration-048-access-function-not-secdef: '
            'get_interaction_signal_current_state MUST be SECURITY DEFINER';
    END IF;

    IF v_proconfig IS NULL
       OR NOT (v_proconfig @> ARRAY['search_path=pg_catalog, pg_temp']) THEN
        RAISE EXCEPTION
            'migration-048-access-function-search-path-not-locked: '
            'function MUST have proconfig containing "search_path=pg_catalog, pg_temp"; found %',
            v_proconfig;
    END IF;
END $$;
