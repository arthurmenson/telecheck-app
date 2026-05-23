-- =============================================================================
-- File:    migrations/048_med_interaction_view_mv_access_function.sql
-- Purpose: Create the optional materialized view + SECURITY BARRIER view +
--          SECURITY DEFINER access function for the interaction signal
--          current-state hot-path display per CDM v1.6 â†’ v1.7 Amendment
--          Â§4.NEW5 (RATIFIED 2026-05-21 P-034; SI-019 Sub-decision 9).
--
--          PR 3 of the Med-Interaction Engine implementation series
--          (continued from migration 047 which created the 4 entities +
--          RLS + per-table append-only triggers + monotonic-ordering
--          trigger). Subsequent migrations: raw lifecycle writer SECDEF +
--          anti-bypass grants (PR 4) â†’ 6 reason-specific wrappers (PR 5)
--          â†’ Fastify handler implementation (PR 6+).
--
--          PER SI-019 SUB-DECISION 9 READ-PATH CLASSIFICATION:
--          - STRICT-FRESHNESS consumers (override procedure STEP 4,
--            prescribing decision gates, refill release checks, protocol
--            gates, pharmacy enforcement) MUST query
--            interaction_signal_lifecycle_transition directly under
--            advisory lock. These DO NOT use the MV or view created here.
--          - HOT-PATH DISPLAY consumers (clinician dashboard, pharmacy
--            portal active-signals indicator, patient mobile app summary,
--            admin reporting) use the MV via SECURITY BARRIER view or
--            access function; stale-state labeling required at the UI
--            layer.
--          - PUSH NOTIFICATION consumers use the domain event subscriber
--            (lands when the wrapper layer emits domain events; PR 5+).
--
--          PER RATIFIER OPTION 2 (carryforward from PR 1-2):
--          - current_tenant_id_strict('entity_name') â†’
--            current_tenant_id() (code-repo pattern from migration 003)
--          - cdm_owner / mv_refresh_owner naming: mv_refresh_owner spec
--            name realized as mv_refresh_owner per
--            migration 046 Â§2 cross-slice-collision-safety convention
--          - Custom DOMAIN types (ulid_t, interaction_signal_state_t,
--            interaction_signal_transition_reason_t) are NOT defined in
--            code repo at this checkpoint; access function uses VARCHAR(26)
--            for signal_id (matches column type) + TEXT for the enum
--            columns (matches table column types directly). The spec
--            casts (mv.current_state::interaction_signal_state_t) become
--            no-ops since both source + target are TEXT. A future TYPES
--            amendment cycle should formalize the enums as DOMAIN types
--            backed by CHECK constraints.
--          - MV access discipline preserved: MV itself REVOKE FROM PUBLIC
--            + GRANT SELECT only to mv_refresh_owner (RLS bypass via
--            non-natively-enforced MV; app roles read via SECURITY BARRIER
--            view OR SECDEF access function).
--          - SECDEF access function OWNED BY mv_refresh_owner
--            (mirrors spec) â€” the role with SELECT on the MV.
--
-- Spec:    - SI-019 Medication Interaction & Validation Engine Slice PRD
--            v2.0 (RATIFIED 2026-05-21 P-033) Â§Sub-decision 9 (read-path
--            consumer classification)
--          - CDM v1.6 â†’ v1.7 Amendment Â§4.NEW5 (canonical executable DDL
--            source; RATIFIED 2026-05-21 P-034)
--          - I-023 (three-layer tenant isolation; SECURITY BARRIER view
--            + WHERE tenant_id predicate at view body)
--          - I-035 (transition table is source of truth; MV is non-
--            authoritative read-path optimization)
-- =============================================================================

-- ---------------------------------------------------------------------------
-- PRECONDITIONS:
--   003_rls_helpers.sql                              applied (current_tenant_id())
--   046_med_interaction_rbac_roles.sql               applied (12 roles incl
--                                                      mv_refresh_owner +
--                                                      medication_interaction_signal_viewer)
--   047_med_interaction_entities.sql                 applied
--                                                    (interaction_signal_lifecycle_transition table)
-- ---------------------------------------------------------------------------

-- =============================================================================
-- R4 HIGH-1 closure 2026-05-23 (Codex R4): explicit BEGIN/COMMIT REMOVED.
-- The R3 wrap was unsafe â€” PostgreSQL does not support nested top-level
-- BEGIN/COMMIT; if a migration runner wraps the file in its own transaction
-- (e.g., Flyway default, Liquibase default, sqitch), the embedded BEGIN
-- only warns + the embedded COMMIT commits the RUNNER'S outer transaction,
-- separating the DDL from the runner's bookkeeping + creating exactly the
-- partial-application hazard the closure was meant to prevent.
--
-- Atomicity contract is now delegated to the migration runner via
-- documented runner-configuration requirement (see docs/
-- med-interaction-implementation-plan.md): apply this migration in a
-- transactional runner (Flyway default, Liquibase default, sqitch). The
-- code-repo's existing migrations (032-047) already assume this contract;
-- no migration in the corpus uses explicit BEGIN/COMMIT.
--
-- Defense-in-depth REMAINS in place even without explicit transaction
-- wrapping:
--   - Â§0 preflight FAILS migration BEFORE CREATE MV if dangerous default
--     ACLs exist (filtered to current_user + public schema per R4 MED-1)
--   - Post-CREATE: immediate REVOKE PUBLIC + aclexplode loop +
--     canonical GRANT (R1 + R2)
--   - Â§5 final verifier asserts canonical end state
-- =============================================================================

-- =============================================================================
-- Â§0 â€” Pre-CREATE preflight (R3 HIGH-1 closure 2026-05-23; R4 MED-1 scope
-- tightening 2026-05-23):
-- FAILS the migration BEFORE CREATE MATERIALIZED VIEW runs if the database
-- has ALTER DEFAULT PRIVILEGES granting SELECT on relations to non-canonical
-- roles for objects that would be created by the CURRENT migration user in
-- the PUBLIC schema.
--
-- R4 MED-1 scope tightening: filter pg_default_acl rows by
--   defaclrole IN (current migration role's OID, 0 for global defaults)
--   AND defaclnamespace IN (public schema OID, 0 for schema-independent)
-- so unrelated default ACLs in other schemas or for other roles do not
-- spuriously block this migration. Without this filter, an
-- ALTER DEFAULT PRIVILEGES FOR ROLE <unrelated_role> IN SCHEMA <unrelated>
-- would abort migration 048 even though it cannot affect the MV being
-- created here.
--
-- Operators that hit this preflight must FIRST run:
--   ALTER DEFAULT PRIVILEGES FOR ROLE <current_migration_role>
--     IN SCHEMA public REVOKE SELECT ON TABLES FROM PUBLIC;
--   ALTER DEFAULT PRIVILEGES FOR ROLE <current_migration_role>
--     IN SCHEMA public REVOKE SELECT ON TABLES FROM <broad_role>;
-- ... and then retry this migration.
-- =============================================================================
DO $$
DECLARE
    v_current_role_oid     OID  := (SELECT oid FROM pg_roles WHERE rolname = CURRENT_USER);
    v_public_schema_oid    OID  := 'public'::regnamespace;
    v_offending_grantee    TEXT;
BEGIN
    SELECT DISTINCT
        CASE
            WHEN acl.grantee = 0 THEN 'PUBLIC'
            ELSE r.rolname
        END
      INTO v_offending_grantee
      FROM pg_default_acl da
      JOIN aclexplode(da.defaclacl) acl ON TRUE
      LEFT JOIN pg_roles r ON r.oid = acl.grantee
     WHERE da.defaclobjtype = 'r'              -- relations (tables, MVs, views)
       -- R4 MED-1: scope to defaults that can actually affect the MV
       -- created below: either the current migration role's defaults, OR
       -- the global default (defaclrole = 0); AND either the public schema's
       -- defaults, OR the global default (defaclnamespace = 0).
       AND (da.defaclrole = v_current_role_oid OR da.defaclrole = 0)
       AND (da.defaclnamespace = v_public_schema_oid OR da.defaclnamespace = 0)
       AND acl.privilege_type = 'SELECT'
       AND (
              acl.grantee = 0                  -- PUBLIC
           OR (r.rolname IS NOT NULL
               AND r.rolname NOT IN (
                   'postgres',
                   'mv_refresh_owner'
               ))
          )
     LIMIT 1;

    IF v_offending_grantee IS NOT NULL THEN
        RAISE EXCEPTION
            'migration-048-preflight-default-acl-violation: '
            'database has ALTER DEFAULT PRIVILEGES (scoped to current migration '
            'role + public schema) granting SELECT on relations to non-canonical '
            'role %; this would expose the all-tenant '
            'interaction_signal_current_state_mv at CREATE time before the '
            'migration''s REVOKE statements run. Operator MUST run: '
            'ALTER DEFAULT PRIVILEGES FOR ROLE <current-migration-role> '
            'IN SCHEMA public REVOKE SELECT ON TABLES FROM <offending-role>; '
            'THEN retry this migration. Remediation is a one-time database-'
            'configuration fix, not a per-migration workaround.',
            v_offending_grantee;
    END IF;
END $$;

-- =============================================================================
-- Â§1 â€” interaction_signal_current_state_mv (CDM Â§4.NEW5; OPTIONAL MV)
--
-- DISTINCT ON projection of the latest transition row per (tenant_id,
-- signal_id). The ORDER BY tenant_id, signal_id, transition_at DESC, id
-- DESC mirrors the canonical current-state derivation predicate. Materialized
-- views in PostgreSQL do NOT natively enforce RLS â€” direct GRANT SELECT on
-- the MV is a tenant-isolation bypass. So the MV is REVOKEd from PUBLIC and
-- GRANTed only to mv_refresh_owner (which OWNS the SECURITY BARRIER view
-- and the SECDEF access function that app roles use to read it).
-- =============================================================================

CREATE MATERIALIZED VIEW interaction_signal_current_state_mv AS
SELECT DISTINCT ON (tenant_id, signal_id)
    tenant_id,
    signal_id,
    to_state          AS current_state,
    transition_at     AS as_of,
    transition_reason
FROM interaction_signal_lifecycle_transition
ORDER BY tenant_id, signal_id, transition_at DESC, id DESC;

-- R1 + R2 HIGH-1 closures 2026-05-23 (Codex R1 + R2): REVOKE PUBLIC AND any
-- non-canonical grantee immediately after CREATE, BEFORE creating the unique
-- index or any other statement.
--
-- R1 (closed first): under autocommit migration-runner mode, default ALTER
-- DEFAULT PRIVILEGES on tables/views could briefly grant SELECT to PUBLIC
-- between CREATE MV and a later REVOKE. R1 closure: immediate REVOKE PUBLIC.
--
-- R2 (closed alongside R1): ALTER DEFAULT PRIVILEGES can also grant SELECT
-- to broad NON-PUBLIC roles (e.g., `app_readonly`, deployment-tooling role,
-- etc.). A simple `REVOKE FROM PUBLIC` does NOT cover those grants. Without
-- this cleanup, in environments where the migration-applier inherits default-
-- privilege grants, the MV would retain SELECT for those broad roles â€”
-- bypassing tenant isolation since PG MVs don't enforce source-table RLS.
--
-- Closure: REVOKE FROM PUBLIC, THEN scan aclexplode(relacl) for any
-- post-creation grantee that is NOT (a) the MV owner, (b) the intended
-- mv_refresh_owner, or (c) PUBLIC (already handled), and REVOKE SELECT
-- from each. THEN add the canonical GRANT. The Â§5 final verification block
-- is preserved as a defense-in-depth assertion that the end state matches
-- the canonical {owner + mv_refresh_owner} grant set.
REVOKE ALL ON interaction_signal_current_state_mv FROM PUBLIC;

DO $$
DECLARE
    v_inherited_grantee TEXT;
BEGIN
    FOR v_inherited_grantee IN
        SELECT DISTINCT r.rolname
          FROM pg_class c
          JOIN aclexplode(c.relacl) acl ON TRUE
          JOIN pg_roles r ON r.oid = acl.grantee
         WHERE c.oid = to_regclass('public.interaction_signal_current_state_mv')
           AND acl.privilege_type = 'SELECT'
           AND acl.grantee <> c.relowner
           AND acl.grantee <> 0    -- PUBLIC (already revoked above)
           AND r.rolname <> 'mv_refresh_owner'
    LOOP
        EXECUTE format(
            'REVOKE SELECT ON interaction_signal_current_state_mv FROM %I',
            v_inherited_grantee
        );
    END LOOP;
END $$;

GRANT SELECT ON interaction_signal_current_state_mv
    TO mv_refresh_owner;

CREATE UNIQUE INDEX interaction_signal_current_state_mv_pk
    ON interaction_signal_current_state_mv (tenant_id, signal_id);

COMMENT ON MATERIALIZED VIEW interaction_signal_current_state_mv IS
    'CDM v1.7 Â§4.NEW5 optional MV for read-path optimization. Non-authoritative; '
    'the transition table is the source of truth per I-035. STRICT-FRESHNESS '
    'consumers (override / prescribing-gate / refill-release / protocol-gate / '
    'pharmacy-enforcement) MUST query interaction_signal_lifecycle_transition '
    'directly per SI-019 Sub-decision 9 read-path consumer classification. '
    'HOT-PATH DISPLAY consumers read via interaction_signal_current_state_v '
    '(SECURITY BARRIER view) or get_interaction_signal_current_state() SECDEF '
    'access function.';

-- =============================================================================
-- Â§2 â€” interaction_signal_current_state_v (CDM Â§4.NEW5; SECURITY BARRIER view)
--
-- App roles (medication_interaction_signal_viewer) read this view; the WHERE
-- tenant_id = current_tenant_id() predicate at the view body filters to the
-- caller's bound tenant. security_barrier=true prevents predicate pushdown
-- attacks (functions in user-supplied WHERE clauses cannot evaluate against
-- rows from other tenants before the view's tenant predicate filters them).
--
-- Option 2 adaptation: current_tenant_id_strict('entity_name') â†’
-- current_tenant_id() per the code-repo Option 2 carryforward.
-- =============================================================================

CREATE VIEW interaction_signal_current_state_v
    WITH (security_barrier = true)
AS
SELECT
    tenant_id,
    signal_id,
    current_state,
    as_of,
    transition_reason
FROM interaction_signal_current_state_mv
WHERE tenant_id = current_tenant_id();

ALTER VIEW interaction_signal_current_state_v
    OWNER TO mv_refresh_owner;

REVOKE ALL ON interaction_signal_current_state_v FROM PUBLIC;
GRANT SELECT ON interaction_signal_current_state_v
    TO medication_interaction_signal_viewer;

COMMENT ON VIEW interaction_signal_current_state_v IS
    'CDM v1.7 Â§4.NEW5 SECURITY BARRIER view over interaction_signal_current_state_mv. '
    'Tenant predicate enforced at view body via current_tenant_id() (Option 2 '
    'carryforward from current_tenant_id_strict). Granted SELECT to '
    'medication_interaction_signal_viewer; SOLE app-role read path for HOT-PATH '
    'DISPLAY consumers (clinician dashboard, pharmacy portal, patient mobile '
    'app summary, admin reporting) per SI-019 Sub-decision 9.';

-- =============================================================================
-- Â§3 â€” get_interaction_signal_current_state (CDM Â§4.NEW5; SECDEF access function)
--
-- Alternate read path for singleton lookups (e.g., cross-reference from an
-- audit row's signal_id). SECURITY DEFINER + locked search_path + tenant
-- predicate via current_tenant_id() at the function body. STABLE function
-- declaration permits use in WHERE clauses with query-plan caching.
--
-- Option 2 adaptations:
-- - p_signal_id type: spec ulid_t â†’ VARCHAR(26) (matches column type)
-- - return TABLE column types: spec uses custom DOMAIN types
--   (interaction_signal_state_t, interaction_signal_transition_reason_t)
--   not defined in code repo; use TEXT (matches table column types directly).
--   A future TYPES amendment cycle should formalize as DOMAIN types.
-- - Owner: mv_refresh_owner (Option 2 prefix per
--   migration 046 cross-slice-collision-safety).
-- =============================================================================

CREATE OR REPLACE FUNCTION get_interaction_signal_current_state(
    p_signal_id VARCHAR(26)
)
RETURNS TABLE (
    signal_id           VARCHAR(26),
    current_state       TEXT,
    as_of               TIMESTAMPTZ,
    transition_reason   TEXT
)
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = pg_catalog, public
AS $$
    SELECT
        mv.signal_id,
        mv.current_state,
        mv.as_of,
        mv.transition_reason
    FROM public.interaction_signal_current_state_mv mv
    WHERE mv.tenant_id = public.current_tenant_id()
      AND mv.signal_id = p_signal_id;
$$;

ALTER FUNCTION get_interaction_signal_current_state(VARCHAR(26))
    OWNER TO mv_refresh_owner;

REVOKE EXECUTE ON FUNCTION get_interaction_signal_current_state(VARCHAR(26))
    FROM PUBLIC;
GRANT EXECUTE ON FUNCTION get_interaction_signal_current_state(VARCHAR(26))
    TO medication_interaction_signal_viewer;

COMMENT ON FUNCTION get_interaction_signal_current_state(VARCHAR(26)) IS
    'CDM v1.7 Â§4.NEW5 SECDEF access function for singleton current-state '
    'lookups (cross-reference from audit row signal_id). Tenant scope enforced '
    'via current_tenant_id() at function body (Option 2 carryforward). STABLE '
    'permits WHERE-clause use with query-plan caching. Granted EXECUTE to '
    'medication_interaction_signal_viewer; alternate read path to the SECURITY '
    'BARRIER view for singleton lookups per SI-019 Sub-decision 9 read-path '
    'consumer classification.';

-- =============================================================================
-- Â§4 â€” Verification
-- =============================================================================

DO $$
DECLARE
    v_mv_oid                    OID := to_regclass(
        'public.interaction_signal_current_state_mv'
    );
    v_view_oid                  OID := to_regclass(
        'public.interaction_signal_current_state_v'
    );
    v_function_oid              OID := to_regprocedure(
        'public.get_interaction_signal_current_state(character varying)'
    );
    v_function_owner_name       TEXT;
    v_function_security_definer BOOLEAN;
    v_function_proconfig        TEXT[];
BEGIN
    -- ---------- MV ----------
    IF v_mv_oid IS NULL THEN
        RAISE EXCEPTION
            'migration-048-mv-missing: '
            'interaction_signal_current_state_mv not found';
    END IF;

    -- ---------- View ----------
    IF v_view_oid IS NULL THEN
        RAISE EXCEPTION
            'migration-048-view-missing: '
            'interaction_signal_current_state_v not found';
    END IF;

    -- Verify view has security_barrier=true
    IF NOT EXISTS (
        SELECT 1
          FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public'
           AND c.relname = 'interaction_signal_current_state_v'
           AND c.reloptions @> ARRAY['security_barrier=true']
    ) THEN
        RAISE EXCEPTION
            'migration-048-view-security-barrier-missing: '
            'interaction_signal_current_state_v MUST have security_barrier=true';
    END IF;

    -- ---------- Access function ----------
    IF v_function_oid IS NULL THEN
        RAISE EXCEPTION
            'migration-048-access-function-missing: '
            'get_interaction_signal_current_state(character varying) not found';
    END IF;

    SELECT r.rolname, p.prosecdef, p.proconfig
      INTO v_function_owner_name, v_function_security_definer, v_function_proconfig
      FROM pg_proc p
      JOIN pg_roles r ON r.oid = p.proowner
     WHERE p.oid = v_function_oid;

    IF v_function_owner_name <> 'mv_refresh_owner' THEN
        RAISE EXCEPTION
            'migration-048-access-function-owner-mismatch: '
            'owner is % but MUST be mv_refresh_owner',
            v_function_owner_name;
    END IF;

    IF NOT v_function_security_definer THEN
        RAISE EXCEPTION
            'migration-048-access-function-security-definer-missing: '
            'get_interaction_signal_current_state MUST be SECURITY DEFINER';
    END IF;

    IF v_function_proconfig IS NULL
       OR NOT (v_function_proconfig @> ARRAY['search_path=pg_catalog, public']) THEN
        RAISE EXCEPTION
            'migration-048-access-function-search-path-not-locked: '
            'get_interaction_signal_current_state MUST have proconfig containing '
            '"search_path=pg_catalog, public"; found %', v_function_proconfig;
    END IF;
END $$;

-- =============================================================================
-- Â§5 â€” MV access-discipline verification (R1 HIGH-1 closure 2026-05-23)
--
-- Codex R1 flagged that the MV creation has a potential window under
-- autocommit migration-runner mode where default ALTER DEFAULT PRIVILEGES
-- could briefly grant SELECT to PUBLIC or broad roles. The R1 closure
-- moved the REVOKE FROM PUBLIC to fire immediately after CREATE
-- MATERIALIZED VIEW (before CREATE UNIQUE INDEX); this block additionally
-- asserts the post-migration end state: the MV must have NO PUBLIC
-- grants AND exactly ONE non-self grantee (mv_refresh_owner).
-- The verification fails the migration if a permissive default-ACL
-- environment leaked a grant through to the final state â€” catching the
-- worst-case scenario even when the migration-runner ordering doesn't
-- prevent the transient window.
-- =============================================================================

DO $$
DECLARE
    v_mv_oid                   OID := to_regclass('public.interaction_signal_current_state_mv');
    v_unexpected_grantee       TEXT;
    v_unexpected_grantee_count INTEGER;
    v_mv_owner_name            TEXT;
BEGIN
    IF v_mv_oid IS NULL THEN
        RAISE EXCEPTION
            'migration-048-mv-verify-missing: '
            'interaction_signal_current_state_mv not found for access-discipline check';
    END IF;

    -- Resolve MV owner role (relacl + relowner; relacl encodes grantees
    -- including the owner-self grant).
    SELECT r.rolname
      INTO v_mv_owner_name
      FROM pg_class c
      JOIN pg_roles r ON r.oid = c.relowner
     WHERE c.oid = v_mv_oid;

    -- Assert no PUBLIC grant. ACL encoding: PUBLIC grantee shows as empty
    -- string in aclexplode(); we check for any grant with grantee role oid 0
    -- (= PUBLIC).
    PERFORM 1
      FROM pg_class c, aclexplode(c.relacl) acl
     WHERE c.oid = v_mv_oid
       AND acl.grantee = 0
       AND acl.privilege_type = 'SELECT';
    IF FOUND THEN
        RAISE EXCEPTION
            'migration-048-mv-public-grant-violation: '
            'interaction_signal_current_state_mv has SELECT granted to PUBLIC '
            '(via ALTER DEFAULT PRIVILEGES or otherwise). MV must be REVOKEd '
            'from PUBLIC per R1 HIGH-1 closure â€” direct PUBLIC access bypasses '
            'tenant isolation since MVs do not enforce source-table RLS.';
    END IF;

    -- Assert exactly ONE non-owner grantee (mv_refresh_owner).
    -- Owner-self grant is implicit + does not appear in relacl explicitly when
    -- the role hasn't been GRANT-modified; we filter to exclude both the owner
    -- and the PUBLIC pseudo-role.
    SELECT COUNT(DISTINCT acl.grantee), MIN(r.rolname)
      INTO v_unexpected_grantee_count, v_unexpected_grantee
      FROM pg_class c
      JOIN aclexplode(c.relacl) acl ON TRUE
      JOIN pg_roles r ON r.oid = acl.grantee
     WHERE c.oid = v_mv_oid
       AND acl.privilege_type = 'SELECT'
       AND acl.grantee <> c.relowner
       AND acl.grantee <> 0  -- PUBLIC
       AND r.rolname <> 'mv_refresh_owner';

    IF v_unexpected_grantee_count > 0 THEN
        RAISE EXCEPTION
            'migration-048-mv-unexpected-grantee: '
            'interaction_signal_current_state_mv has SELECT granted to '
            'unexpected role(s); first found: %; canonical grantees are '
            'OWNER (mv_refresh_owner) + self only. '
            'App roles must read via interaction_signal_current_state_v '
            '(SECURITY BARRIER view) or get_interaction_signal_current_state() '
            '(SECDEF access function), never directly.',
            v_unexpected_grantee;
    END IF;
END $$;

-- R4 HIGH-1 closure 2026-05-23 (Codex R4): R3 explicit COMMIT REMOVED.
-- See R4 HIGH-1 rationale at top of file: explicit BEGIN/COMMIT is unsafe
-- for transactional migration runners. Atomicity now contracted via runner
-- configuration (documented in docs/med-interaction-implementation-plan.md);
-- defense-in-depth via pre-CREATE preflight + immediate REVOKE + aclexplode
-- loop + Â§5 final verifier remains in place.
