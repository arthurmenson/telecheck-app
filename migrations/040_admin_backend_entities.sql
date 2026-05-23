-- =============================================================================
-- File:    migrations/040_admin_backend_entities.sql
-- Purpose: Create the 4 net-new Admin Backend Basics entities (SI-023 v1.0
--          RATIFIED 2026-05-22 P-041 + CDM v1.10 → v1.11 Amendment §4.NEW1-NEW4
--          RATIFIED 2026-05-22 P-042) with RLS + per-table append-only triggers
--          + unified lifecycle-invariants trigger (3 invariants under a single
--          advisory lock) + one-active-review-per-template defense-in-depth
--          (LAYER 2) + composite tenant-scoped FKs.
--
--          PR 1 of the Admin Backend Basics implementation series (continued
--          from migration 039 which created the 12 RBAC roles). Subsequent
--          migrations: derived views (PR 2) → raw lifecycle writer (PR 3) →
--          3 dashboard read-wrappers (PR 4) → 2 template wrappers (PR 5) →
--          Fastify module scaffold (PR 6).
--
--          PER RATIFIER DECISION 2026-05-22 — OPTION 2 (carryforward from
--          Crisis Response PRs):
--          - RLS predicate uses `current_tenant_id()` (code-repo pattern from
--            migration 003) — NOT spec's `current_tenant_id_strict(entity_name)`
--            from SI-024.1 v0.8. Both are tenant-binding mechanisms; SI-010 is
--            the GUC-bound-via-table-keyed-by-pg_backend_pid() shape the code
--            repo currently runs on; SI-024.1 is the JWT-claim-based canonical
--            target. Migration to SI-024.1 happens in a future hygiene cycle.
--          - Per-table inline append-only trigger functions (audit_chain
--            pattern from migration 002) — NOT spec's generic enforce_append_only().
--          - `forms_template_id VARCHAR(26)` (code-repo PK type from migration
--            006) — NOT spec's UUID. Composite FK to forms_template(tenant_id,
--            template_id), which exists in code repo via migration 006.
--          - `*_principal_id VARCHAR(26)` (code-repo PK type for accounts from
--            migration 012) — NOT spec's UUID/principal(tenant_id, id).
--            Composite FK to accounts(tenant_id, account_id) per the code-repo
--            convention. The accounts table covers patient + delegate + clinician
--            + admin types (post-migrations 027 + 028).
--          - Functions are OWNED BY postgres at v0.1 (LEFT for later PRs to
--            ALTER OWNER TO the appropriate admin owner roles from 039 when
--            the corresponding wrappers/views attach and need EXECUTE privileges).
--
-- Spec:    - SI-023 Admin Backend Basics Slice v1.0 (RATIFIED 2026-05-22 P-041;
--            telecheckONE/Telecheck Master Bundle FINAL US REGION BASELINE/
--            Telecheck_SI_023_Admin_Backend_Basics_v1_0.md §4 + §6 normative
--            entity definitions + state-machine transition triples)
--          - CDM v1.10 → v1.11 Amendment §4.NEW1-NEW4 (canonical executable
--            DDL source; RATIFIED 2026-05-22 P-042;
--            telecheckONE/Telecheck Master Bundle FINAL US REGION BASELINE/
--            Telecheck_CDM_v1_10_to_v1_11_Amendment.md)
--          - I-023 (three-layer tenant isolation; tenant_id on every PHI record)
--          - I-027 (audit append-only; admin_dashboard_query_execution)
--          - I-035 (append-only invariant for ratification + audit-bound state
--            machines; forms_template_admin_review_lifecycle_transition)
--
-- Summary: Creates 4 net-new tables (admin_dashboard_query_execution +
--          forms_template_admin_review + forms_template_admin_review_lifecycle_transition
--          + admin_template_decision_idempotency_key) with RLS + per-table
--          append-only triggers + unified lifecycle-invariants trigger (3
--          invariants under one advisory lock) + one-active-review-per-template
--          LAYER 2 defense-in-depth trigger + composite tenant-scoped FKs +
--          indexes. No SECDEF procedures, no views, no grants in this migration
--          — those land in subsequent PRs.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- PRECONDITIONS:
--   001_tenants.sql                              applied (tenants table)
--   003_rls_helpers.sql                          applied (current_tenant_id())
--   006_forms_intake.sql                         applied (forms_template + UNIQUE (tenant_id, template_id))
--   012_accounts.sql                             applied (accounts + UNIQUE (tenant_id, account_id))
--   039_admin_backend_rbac_roles.sql             applied (12 admin RBAC roles)
-- ---------------------------------------------------------------------------

-- =============================================================================
-- §1 — admin_dashboard_query_execution (CDM §4.NEW1; SI-023 Sub-decision 3)
--
-- Append-only audit-trail entity recording who-viewed-what-when on admin
-- dashboards. Satisfies I-027 audit completeness on admin read paths via
-- co-transactional INSERT inside the canonical SECDEF read-wrappers
-- (Sub-decision 3.5 of SI-023, landing in PR 4).
--
-- Standalone entity (no FK from lifecycle log or idempotency entities).
-- Composite FK to accounts(tenant_id, account_id) for executor_principal_id
-- (NOT spec's principal(tenant_id, id) — Option 2 adaptation).
-- =============================================================================

CREATE TABLE admin_dashboard_query_execution (
    id                      BIGSERIAL    PRIMARY KEY,
    tenant_id               TEXT         NOT NULL REFERENCES tenants(id),
    executor_principal_id   VARCHAR(26)  NOT NULL,
    dashboard_name          TEXT         NOT NULL CHECK (dashboard_name IN (
        'admin_crisis_operational_health_v',
        'admin_consult_queue_health_v',
        'admin_mode1_volume_health_v'
    )),
    query_params_jsonb      JSONB        NULL,
    row_count               INTEGER      NOT NULL,
    executed_at             TIMESTAMPTZ  NOT NULL DEFAULT now(),
    -- Composite tenant-scoped FK to accounts (Option 2: principal(tenant_id, id)
    -- in spec → accounts(tenant_id, account_id) in code repo). The composite FK
    -- prevents cross-tenant binding (an executor in tenant A cannot record a
    -- query execution under tenant B's tenant_id).
    CONSTRAINT admin_dashboard_query_principal_tenant_fk
        FOREIGN KEY (tenant_id, executor_principal_id)
        REFERENCES accounts(tenant_id, account_id)
);

ALTER TABLE admin_dashboard_query_execution ENABLE ROW LEVEL SECURITY;
ALTER TABLE admin_dashboard_query_execution FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON admin_dashboard_query_execution
    USING     (tenant_id = current_tenant_id())
    WITH CHECK (tenant_id = current_tenant_id());

-- Append-only per I-027 (audit-bound dashboard read trail; corrections only via
-- append of new rows, never via UPDATE/DELETE).
CREATE OR REPLACE FUNCTION admin_dashboard_query_execution_block_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
    RAISE EXCEPTION
        'admin_dashboard_query_execution is append-only per I-027 (audit-bound). '
        'UPDATE and DELETE are permanently prohibited.';
END;
$$;

CREATE TRIGGER admin_dashboard_query_execution_block_update
    BEFORE UPDATE ON admin_dashboard_query_execution
    FOR EACH ROW
    EXECUTE FUNCTION admin_dashboard_query_execution_block_mutation();

CREATE TRIGGER admin_dashboard_query_execution_block_delete
    BEFORE DELETE ON admin_dashboard_query_execution
    FOR EACH ROW
    EXECUTE FUNCTION admin_dashboard_query_execution_block_mutation();

CREATE INDEX admin_dashboard_query_tenant_dashboard_time_idx
    ON admin_dashboard_query_execution (tenant_id, dashboard_name, executed_at DESC);

-- =============================================================================
-- §2 — forms_template_admin_review (CDM §4.NEW2; SI-023 Sub-decision 4)
--
-- Review lifecycle root entity. INSERT-only at the schema layer per the
-- BEFORE UPDATE/DELETE append-only trigger. Canonical current_state is
-- DERIVED from the latest forms_template_admin_review_lifecycle_transition
-- row (NOT stored as a column on this table).
--
-- One-active-review-per-template enforcement is layered:
--   - LAYER 1: parent-template FOR UPDATE serialization in the submit + decision
--              SECDEF wrappers (lands in PR 5).
--   - LAYER 2: BEFORE INSERT trigger defense-in-depth on this table
--              (enforce_one_active_review_per_template, attached in §3 below
--              after the lifecycle_transition table exists).
--
-- Composite UNIQUE (tenant_id, review_id) so child tables can compose tenant-
-- scoped FKs that prevent cross-tenant binding of lifecycle rows + idempotency
-- rows.
-- =============================================================================

CREATE TABLE forms_template_admin_review (
    review_id                       UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id                       TEXT         NOT NULL REFERENCES tenants(id),
    forms_template_id               VARCHAR(26)  NOT NULL,
    submitter_principal_id          VARCHAR(26)  NOT NULL,
    ai_guardrail_snapshot_jsonb     JSONB        NULL,
    created_at                      TIMESTAMPTZ  NOT NULL DEFAULT now(),
    -- Composite tenant-scoped FK to forms_template (Option 2: spec's UUID +
    -- forms_template(tenant_id, id) → code-repo VARCHAR(26) +
    -- forms_template(tenant_id, template_id) per migration 006).
    CONSTRAINT forms_template_admin_review_template_tenant_fk
        FOREIGN KEY (tenant_id, forms_template_id)
        REFERENCES forms_template(tenant_id, template_id),
    -- Composite tenant-scoped FK to accounts (Option 2: principal(tenant_id, id)
    -- in spec → accounts(tenant_id, account_id) in code repo).
    CONSTRAINT forms_template_admin_review_submitter_principal_tenant_fk
        FOREIGN KEY (tenant_id, submitter_principal_id)
        REFERENCES accounts(tenant_id, account_id),
    -- Composite UNIQUE for tenant-coherent FKs from child tables (lifecycle +
    -- idempotency). The (tenant_id, review_id) pair is the canonical tenant-
    -- scoped foreign-key target.
    CONSTRAINT forms_template_admin_review_tenant_id_unique
        UNIQUE (tenant_id, review_id)
);

ALTER TABLE forms_template_admin_review ENABLE ROW LEVEL SECURITY;
ALTER TABLE forms_template_admin_review FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON forms_template_admin_review
    USING     (tenant_id = current_tenant_id())
    WITH CHECK (tenant_id = current_tenant_id());

-- Append-only per I-035 (ratification-record entity; review root never mutates;
-- lifecycle state changes recorded as new rows in lifecycle_transition).
CREATE OR REPLACE FUNCTION forms_template_admin_review_block_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
    RAISE EXCEPTION
        'forms_template_admin_review is append-only per I-035 (ratification-record entity). '
        'UPDATE and DELETE are permanently prohibited. '
        'Lifecycle state changes are recorded as new rows in '
        'forms_template_admin_review_lifecycle_transition; current state is derived '
        'from the latest row.';
END;
$$;

CREATE TRIGGER forms_template_admin_review_block_update
    BEFORE UPDATE ON forms_template_admin_review
    FOR EACH ROW
    EXECUTE FUNCTION forms_template_admin_review_block_mutation();

CREATE TRIGGER forms_template_admin_review_block_delete
    BEFORE DELETE ON forms_template_admin_review
    FOR EACH ROW
    EXECUTE FUNCTION forms_template_admin_review_block_mutation();

CREATE INDEX forms_template_admin_review_tenant_template_idx
    ON forms_template_admin_review (tenant_id, forms_template_id, created_at DESC);

-- =============================================================================
-- §3 — forms_template_admin_review_lifecycle_transition (CDM §4.NEW3;
--       append-only Option A per I-035)
--
-- Append-only lifecycle log. CHECK constraint enumerates the 5 allowed
-- (from_state, to_state, transition_reason) triples per SI-023 §6 normative
-- table (1 initial-submission + 3 decision triples + 1 revision-resubmission
-- cycle-back). Unified `forms_template_admin_review_lifecycle_invariants()`
-- BEFORE INSERT trigger function covers 3 invariants under a single advisory
-- lock window + READ COMMITTED isolation precondition (R12/R13/R14/R15/R16
-- spec closure cascade):
--   - Future-date bounded by 5s clock-skew tolerance
--   - Backdate rejected (NEW.transition_at >= MAX(prior.transition_at))
--   - State-continuity (NEW.from_state matches current latest.to_state,
--     or NEW.from_state='none' when no prior rows exist)
-- =============================================================================

CREATE TABLE forms_template_admin_review_lifecycle_transition (
    id                      BIGSERIAL    PRIMARY KEY,
    tenant_id               TEXT         NOT NULL REFERENCES tenants(id),
    review_id               UUID         NOT NULL,
    from_state              TEXT         NOT NULL CHECK (from_state IN (
        'none', 'pending_review', 'approved', 'rejected', 'revision_requested'
    )),
    to_state                TEXT         NOT NULL CHECK (to_state IN (
        'pending_review', 'approved', 'rejected', 'revision_requested'
    )),
    transition_reason       TEXT         NOT NULL CHECK (transition_reason IN (
        'initial_submission',
        'clinician_decision_approve',
        'clinician_decision_reject',
        'clinician_decision_request_revision',
        'revision_resubmission'
    )),
    transition_at           TIMESTAMPTZ  NOT NULL DEFAULT now(),
    actor_principal_id      VARCHAR(26)  NOT NULL,
    transition_payload      JSONB        NULL,
    -- 5 allowed (from_state, to_state, transition_reason) triples per SI-023 §6
    -- normative table + CDM §4.NEW3 valid-transition CHECK.
    CONSTRAINT forms_template_admin_review_lifecycle_valid_transition CHECK (
        (from_state = 'none' AND to_state = 'pending_review' AND transition_reason = 'initial_submission')
        OR (from_state = 'pending_review' AND to_state = 'approved' AND transition_reason = 'clinician_decision_approve')
        OR (from_state = 'pending_review' AND to_state = 'rejected' AND transition_reason = 'clinician_decision_reject')
        OR (from_state = 'pending_review' AND to_state = 'revision_requested' AND transition_reason = 'clinician_decision_request_revision')
        OR (from_state = 'revision_requested' AND to_state = 'pending_review' AND transition_reason = 'revision_resubmission')
    ),
    -- Composite tenant-scoped FK to forms_template_admin_review.
    CONSTRAINT forms_template_admin_review_lifecycle_review_tenant_fk
        FOREIGN KEY (tenant_id, review_id)
        REFERENCES forms_template_admin_review(tenant_id, review_id),
    -- Composite tenant-scoped FK to accounts (Option 2: principal → accounts).
    CONSTRAINT forms_template_admin_review_lifecycle_actor_principal_tenant_fk
        FOREIGN KEY (tenant_id, actor_principal_id)
        REFERENCES accounts(tenant_id, account_id)
);

ALTER TABLE forms_template_admin_review_lifecycle_transition ENABLE ROW LEVEL SECURITY;
ALTER TABLE forms_template_admin_review_lifecycle_transition FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON forms_template_admin_review_lifecycle_transition
    USING     (tenant_id = current_tenant_id())
    WITH CHECK (tenant_id = current_tenant_id());

-- Append-only per I-035 (audit-bound state-machine log).
CREATE OR REPLACE FUNCTION forms_template_admin_review_lifecycle_transition_block_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
    RAISE EXCEPTION
        'forms_template_admin_review_lifecycle_transition is append-only per I-035 '
        '(audit-bound state machine). UPDATE and DELETE are permanently prohibited. '
        'State changes are recorded as new rows; current state is derived from the latest row.';
END;
$$;

CREATE TRIGGER forms_template_admin_review_lifecycle_transition_block_update
    BEFORE UPDATE ON forms_template_admin_review_lifecycle_transition
    FOR EACH ROW
    EXECUTE FUNCTION forms_template_admin_review_lifecycle_transition_block_mutation();

CREATE TRIGGER forms_template_admin_review_lifecycle_transition_block_delete
    BEFORE DELETE ON forms_template_admin_review_lifecycle_transition
    FOR EACH ROW
    EXECUTE FUNCTION forms_template_admin_review_lifecycle_transition_block_mutation();

CREATE INDEX forms_template_admin_review_lifecycle_review_transition_idx
    ON forms_template_admin_review_lifecycle_transition (tenant_id, review_id, transition_at DESC, id DESC);

-- ---------------------------------------------------------------------------
-- Unified lifecycle-invariants trigger function — covers 3 invariants under a
-- single advisory lock window per (tenant_id, review_id):
--   1. Future-date bounded by 5s clock-skew tolerance
--   2. Backdate rejected (NEW.transition_at >= MAX(prior.transition_at))
--   3. State-continuity (NEW.from_state matches current latest.to_state,
--      or NEW.from_state='none' when no prior rows exist)
--
-- READ COMMITTED isolation precondition: this function is designed to run
-- under PostgreSQL's default READ COMMITTED isolation; under SERIALIZABLE/
-- REPEATABLE READ the advisory-lock + MAX-read pattern is unnecessary
-- (snapshot would already exclude concurrent inserters) and the unified
-- guard would not behave as designed.
--
-- Per Option 2: function OWNED BY postgres at v0.1 (not spec's cdm_owner).
-- Future PR may ALTER OWNER TO an appropriate owner role.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION forms_template_admin_review_lifecycle_invariants()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER    -- runs under caller's privileges; reads same table caller is inserting into
SET search_path = pg_catalog, public
AS $$
DECLARE
    v_lock_key BIGINT;
    v_max_prior_transition_at TIMESTAMPTZ;
    v_latest_to_state TEXT;
    v_max_clock_skew CONSTANT INTERVAL := INTERVAL '5 seconds';
BEGIN
    -- READ COMMITTED precondition. Under SERIALIZABLE / REPEATABLE READ the
    -- advisory-lock + MAX-read pattern below would not behave as designed
    -- (snapshot semantics would already exclude concurrent inserters).
    IF current_setting('transaction_isolation') NOT IN ('read committed', 'read uncommitted') THEN
        RAISE EXCEPTION
            'forms-template-admin-review-lifecycle-isolation-violation: this code path '
            'MUST run under READ COMMITTED; current isolation is %; SI-023 wrappers + '
            'raw writer assume canonical PostgreSQL default isolation',
            current_setting('transaction_isolation')
            USING ERRCODE = '0B000';    -- invalid_transaction_initiation
    END IF;

    -- Per-(tenant_id, review_id) advisory lock. Serializes concurrent inserts
    -- so the MAX(prior.transition_at) + latest-to_state reads observe only
    -- committed-before-this-tx rows. Auto-released at tx commit/rollback.
    v_lock_key := ('x' || substr(md5(NEW.tenant_id::text || ':' || NEW.review_id::text), 1, 16))::bit(64)::bigint;
    PERFORM pg_advisory_xact_lock(v_lock_key);

    -- Invariant 1: future-date bounded by 5s clock-skew tolerance.
    IF NEW.transition_at > now() + v_max_clock_skew THEN
        RAISE EXCEPTION
            'forms-template-admin-review-lifecycle-future-dated: '
            'NEW.transition_at (%) > now() + 5s clock-skew tolerance (%)',
            NEW.transition_at, now() + v_max_clock_skew
            USING ERRCODE = '22008';    -- datetime_field_overflow
    END IF;

    -- Invariant 2: backdate rejected.
    SELECT MAX(transition_at) INTO v_max_prior_transition_at
      FROM public.forms_template_admin_review_lifecycle_transition
     WHERE tenant_id = NEW.tenant_id AND review_id = NEW.review_id;
    IF v_max_prior_transition_at IS NOT NULL
       AND NEW.transition_at < v_max_prior_transition_at THEN
        RAISE EXCEPTION
            'forms-template-admin-review-lifecycle-backdated: '
            'NEW.transition_at (%) is before MAX(prior.transition_at) (%) for review %',
            NEW.transition_at, v_max_prior_transition_at, NEW.review_id
            USING ERRCODE = '22008';
    END IF;

    -- Invariant 3: state-continuity.
    SELECT to_state INTO v_latest_to_state
      FROM public.forms_template_admin_review_lifecycle_transition
     WHERE tenant_id = NEW.tenant_id AND review_id = NEW.review_id
     ORDER BY transition_at DESC, id DESC
     LIMIT 1;

    IF v_latest_to_state IS NULL THEN
        -- No prior rows; first transition MUST have from_state='none'.
        IF NEW.from_state <> 'none' THEN
            RAISE EXCEPTION
                'forms-template-admin-review-lifecycle-bad-initial-state: '
                'NEW.from_state=% but no prior rows exist for review %; '
                'first transition MUST have from_state=none',
                NEW.from_state, NEW.review_id
                USING ERRCODE = '23514';    -- check_violation
        END IF;
    ELSE
        IF NEW.from_state IS DISTINCT FROM v_latest_to_state THEN
            RAISE EXCEPTION
                'forms-template-admin-review-lifecycle-state-continuity-violation: '
                'NEW.from_state=% but current latest to_state=% for review %',
                NEW.from_state, v_latest_to_state, NEW.review_id
                USING ERRCODE = '23514';    -- check_violation
        END IF;
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER forms_template_admin_review_lifecycle_invariants_trigger
    BEFORE INSERT ON forms_template_admin_review_lifecycle_transition
    FOR EACH ROW
    EXECUTE FUNCTION forms_template_admin_review_lifecycle_invariants();

-- ---------------------------------------------------------------------------
-- One-active-review-per-template LAYER 2 defense-in-depth trigger function.
-- BEFORE INSERT on forms_template_admin_review. Attached here (after the
-- lifecycle_transition table exists, since the LATERAL-derived latest-state
-- check queries the lifecycle_transition table).
--
-- LAYER 1 is the parent-template FOR UPDATE serialization point acquired by
-- BOTH the submit + decision SECDEF wrappers (lands in PR 5).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION enforce_one_active_review_per_template()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
DECLARE
    v_existing_active_review_id UUID;
BEGIN
    SELECT ftar.review_id INTO v_existing_active_review_id
      FROM public.forms_template_admin_review ftar
      JOIN LATERAL (
          SELECT to_state
            FROM public.forms_template_admin_review_lifecycle_transition lt
           WHERE lt.tenant_id = ftar.tenant_id AND lt.review_id = ftar.review_id
           ORDER BY lt.transition_at DESC, lt.id DESC
           LIMIT 1
      ) latest ON TRUE
     WHERE ftar.tenant_id = NEW.tenant_id
       AND ftar.forms_template_id = NEW.forms_template_id
       AND latest.to_state IN ('pending_review', 'revision_requested')
       AND ftar.review_id IS DISTINCT FROM NEW.review_id;
    IF FOUND THEN
        RAISE EXCEPTION
            'admin-template-review-duplicate-active: '
            'template % already has an active admin review %',
            NEW.forms_template_id, v_existing_active_review_id
            USING ERRCODE = '23505';    -- unique_violation
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER forms_template_admin_review_one_active_check
    BEFORE INSERT ON forms_template_admin_review
    FOR EACH ROW
    EXECUTE FUNCTION enforce_one_active_review_per_template();

-- =============================================================================
-- §4 — admin_template_decision_idempotency_key (CDM §4.NEW4; canonical
--       IDEMPOTENCY contract per P-027)
--
-- Idempotency-key entity backing the `record_forms_template_admin_decision`
-- wrapper retry-safety contract. NOT NULL idempotency_key + composite UNIQUE
-- on (tenant_id, review_id, idempotency_key). Wrapper signature in PR 5 MUST
-- declare `p_idempotency_key TEXT NOT NULL` (no DEFAULT NULL); API endpoint
-- MUST reject calls without `Idempotency-Key` HTTP header (400 Bad Request);
-- double-layered prevents NULL-key retries entirely.
-- =============================================================================

CREATE TABLE admin_template_decision_idempotency_key (
    id                          BIGSERIAL    PRIMARY KEY,
    tenant_id                   TEXT         NOT NULL REFERENCES tenants(id),
    review_id                   UUID         NOT NULL,
    idempotency_key             TEXT         NOT NULL,
    decision                    TEXT         NOT NULL CHECK (decision IN (
        'approve', 'reject', 'request_revision'
    )),
    decision_payload_jsonb      JSONB        NULL,
    decided_at                  TIMESTAMPTZ  NOT NULL DEFAULT now(),
    decider_principal_id        VARCHAR(26)  NOT NULL,
    CONSTRAINT admin_template_decision_idempotency_review_tenant_fk
        FOREIGN KEY (tenant_id, review_id)
        REFERENCES forms_template_admin_review(tenant_id, review_id),
    CONSTRAINT admin_template_decision_idempotency_principal_tenant_fk
        FOREIGN KEY (tenant_id, decider_principal_id)
        REFERENCES accounts(tenant_id, account_id),
    -- Composite UNIQUE per (tenant_id, review_id, idempotency_key). The
    -- wrapper retry-safety contract resolves to an existing row via this key;
    -- any retry collides here.
    CONSTRAINT admin_template_decision_idempotency_uk
        UNIQUE (tenant_id, review_id, idempotency_key)
);

ALTER TABLE admin_template_decision_idempotency_key ENABLE ROW LEVEL SECURITY;
ALTER TABLE admin_template_decision_idempotency_key FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON admin_template_decision_idempotency_key
    USING     (tenant_id = current_tenant_id())
    WITH CHECK (tenant_id = current_tenant_id());

-- Append-only per IDEMPOTENCY contract (idempotency rows are durable; a
-- prior decision row is the resolution authority for a replayed call).
CREATE OR REPLACE FUNCTION admin_template_decision_idempotency_key_block_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
    RAISE EXCEPTION
        'admin_template_decision_idempotency_key is append-only per IDEMPOTENCY contract. '
        'UPDATE and DELETE are permanently prohibited. '
        'Replayed calls resolve via the existing row (idempotency_key collision).';
END;
$$;

CREATE TRIGGER admin_template_decision_idempotency_key_block_update
    BEFORE UPDATE ON admin_template_decision_idempotency_key
    FOR EACH ROW
    EXECUTE FUNCTION admin_template_decision_idempotency_key_block_mutation();

CREATE TRIGGER admin_template_decision_idempotency_key_block_delete
    BEFORE DELETE ON admin_template_decision_idempotency_key
    FOR EACH ROW
    EXECUTE FUNCTION admin_template_decision_idempotency_key_block_mutation();

CREATE INDEX admin_template_decision_idempotency_review_idx
    ON admin_template_decision_idempotency_key (tenant_id, review_id, decided_at DESC);

-- =============================================================================
-- §5 — Verification: count of net-new admin/forms_template_admin_* tables = 4
-- =============================================================================

DO $$
DECLARE
    v_created_count INTEGER;
    v_expected_count CONSTANT INTEGER := 4;
BEGIN
    SELECT COUNT(*) INTO v_created_count
      FROM pg_tables
     WHERE schemaname = 'public'
       AND tablename IN (
           'admin_dashboard_query_execution',
           'forms_template_admin_review',
           'forms_template_admin_review_lifecycle_transition',
           'admin_template_decision_idempotency_key'
       );

    IF v_created_count <> v_expected_count THEN
        RAISE EXCEPTION
            'migration-040-table-count-mismatch: '
            'expected % admin tables created, found %; '
            'P-042 §4.NEW1-NEW4 require all 4 '
            '(admin_dashboard_query_execution + forms_template_admin_review + '
            'forms_template_admin_review_lifecycle_transition + '
            'admin_template_decision_idempotency_key)',
            v_expected_count, v_created_count;
    END IF;

    -- Verify all 4 tables have RLS ENABLE + FORCE
    SELECT COUNT(*) INTO v_created_count
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relname IN (
           'admin_dashboard_query_execution',
           'forms_template_admin_review',
           'forms_template_admin_review_lifecycle_transition',
           'admin_template_decision_idempotency_key'
       )
       AND c.relrowsecurity = TRUE
       AND c.relforcerowsecurity = TRUE;

    IF v_created_count <> v_expected_count THEN
        RAISE EXCEPTION
            'migration-040-rls-enforcement-incomplete: '
            'expected all % tables to have ENABLE + FORCE RLS, found % compliant',
            v_expected_count, v_created_count;
    END IF;
END $$;
