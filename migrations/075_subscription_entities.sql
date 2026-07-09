-- =============================================================================
-- File:    migrations/075_subscription_entities.sql
-- Purpose: Subscription slice DB layer — `subscriptions` + `subscription_events`
--          per CDM v1.2 §4.7 (Subscription) + §4.8 (SubscriptionEvent)
--          (entities #32 / #33 in CDM §3.12 Ecom & Subscription Management),
--          plus table grants to the migration 074 slice roles and closure of
--          the migration 060 DEFERRED-FK TODO on `refills.subscription_id`.
--
--          SI-001 closure context: this build was unblocked by Promotion
--          Ledger P-011 (SI-001 closed 2026-05-11; migration 025 landed
--          medication_requests — the §4.7 `prescription_id` FK target).
--          Operator (Evans) confirmed 2026-07-08 that P-011 closure
--          authorizes this build.
--
-- Spec:    - CDM v1.2 §4.7 (subscriptions — full SQL inlined there) + §4.8
--            (subscription_events) + §3.12 (inventory)
--          - State Machines v1.1 §15 (Subscription State Machine — 10 states;
--            status enum + PAUSED/CANCELLED lifecycle-date invariants)
--          - Pharmacy + Refill Slice PRD v2.1 §8 (subscription semantics)
--          - Contracts Pack TYPES (§ID conventions: `sub_` subscription /
--            `sue_` subscription event prefixes, added v5.1)
--          - OpenAPI v0.2 §20 (id wire shapes `sub_<ULID>` / `sue_<ULID>`)
--          - ADR-001 (module boundary), ADR-023 (multi-tenancy Model A),
--            I-023 / I-025 / I-027
--          - PROJECT_CONVENTIONS r5 §1.1 (composite UNIQUE + composite FK)
--          - migrations/003_rls_helpers.sql (current_tenant_id())
--          - migrations/012_accounts.sql, 024_product_catalog.sql,
--            025_medication_requests.sql (composite-UNIQUE FK targets)
--          - migrations/060_pharmacy_refill_entities.sql (the deferred
--            refills.subscription_id FK this migration closes)
--          - migrations/074_subscription_rbac_roles.sql (grantee roles)
--
-- Option 2 adaptations from spec (recorded divergences; same class as the
-- migration 033/040/047/056/060/067 recorded divergences):
--   - id VARCHAR(26) → VARCHAR(30), app-generated, canonical-format CHECK.
--     CDM §4.7/§4.8 declare VARCHAR(26), but TYPES (v5.1 additions) defines
--     the `sub_` / `sue_` prefixes and OpenAPI v0.2 §20 shows `sub_<ULID>` /
--     `sue_<ULID>` wire ids — 30 chars total. Same adaptation class as
--     migration 025's mrx_ widening (Codex pharmacy-scaffold-rebuild R6 HIGH
--     closure precedent).
--   - tenant_id VARCHAR(26) → TEXT NOT NULL REFERENCES tenants(id)
--     (056/067 convention).
--   - RLS predicate current_setting('app.tenant_id') → current_tenant_id()
--     (migration 003 hardened helper) with USING + WITH CHECK; policy name
--     `tenant_isolation` (033/040/047/056/060/067 convention).
--   - Single-column FKs → tenant-scoped composite FKs per PROJECT_CONVENTIONS
--     r5 §1.1: patient_id → accounts(tenant_id, account_id) (CDM's
--     `REFERENCES accounts(id)` target does not exist — accounts' PK is
--     account_id with UNIQUE (tenant_id, account_id) from migration 012; the
--     migration 025/067 precedent applies); product_id →
--     product_catalog(tenant_id, id); prescription_id →
--     medication_requests(tenant_id, id) (VARCHAR(30), mrx_-prefixed per 025);
--     subscription_events.subscription_id → subscriptions(tenant_id, id).
--   - GLOSSARY TENSION (recorded, not resolved here): CDM §4.7 ratifies the
--     column name `prescription_id` while GLOSSARY v5.2 forbids the
--     `prescription` alias (canonical term: medication_request). Per the
--     source-of-truth hierarchy, CDM's inlined SQL is authoritative for
--     schema — the column name is kept VERBATIM (`prescription_id`), FK
--     target medication_requests. Renaming would silently fork ratified DDL.
--     Flagged as a §12 Spec Issue candidate in the module README; app-layer
--     code uses medicationRequestId naming.
--   - subscription_events index (subscription_id, occurred_at) →
--     (tenant_id, subscription_id, occurred_at): tenant_id lead per the RLS
--     index discipline (every prior slice migration).
--   - Append-only on subscription_events enforced at the DB layer with the
--     block_update/block_delete trigger pair (033/056/067 convention) —
--     CDM §4.8 declares "Append-only — no UPDATE or DELETE operations".
--
-- SPEC GAP (recorded; §12 Spec Issue candidate — see module README):
--   State Machines v1.1 §15 mandates emissions `subscription.fulfilled`
--   (FULFILLING→ACTIVE complete), `subscription.switch_declined`
--   (SWITCHING→ACTIVE decline), and `subscription.terminated_clinical`
--   (SAFETY_HOLD→CANCELLED) — but CDM §4.8's ratified event_type enum has NO
--   corresponding values ('fulfilled' / 'switch_declined' /
--   'terminated_clinical' absent; nor any period_end value). The CHECK below
--   is CDM-verbatim (13 values). Transitions lacking a ratified event_type
--   record their trail via AUDIT records only (app layer) until the enum is
--   ratified. Fail-closed: no unratified enum value is invented.
--
-- Preconditions: migrations 000-074 applied (001 tenants, 003 rls helpers,
--   012 accounts, 024 product_catalog, 025 medication_requests, 060 refills,
--   074 subscription roles).
-- Invariants: I-023 (RLS + composite tenant-scoped FKs on every child edge),
--   I-025 (tenant-blind errors — handler layer), I-027 (audit tenancy —
--   handler layer), CDM §4.7 constraints (pause window, terminal states),
--   CDM §4.8 append-only.
-- Rollback: migrations/rollback/075_rollback.sql
-- =============================================================================

-- =============================================================================
-- Section 0 — Prerequisite preflight (067 Section 0 pattern)
-- =============================================================================

DO $$
BEGIN
    IF to_regrole('subscription_patient_manager') IS NULL
       OR to_regrole('subscription_clinician_reviewer') IS NULL
       OR to_regrole('subscription_system_scheduler') IS NULL
       OR to_regrole('subscription_staff_reader') IS NULL THEN
        RAISE EXCEPTION 'migration-075-prerequisite-missing: subscription slice roles '
            'missing (apply migration 074 first)'
            USING ERRCODE = 'undefined_object';
    END IF;
    IF to_regclass('public.medication_requests') IS NULL THEN
        RAISE EXCEPTION 'migration-075-prerequisite-missing: medication_requests missing '
            '(apply migration 025 first; SI-001 / P-011 target)'
            USING ERRCODE = 'undefined_object';
    END IF;
END $$;

-- =============================================================================
-- Section 1 — subscriptions (CDM v1.2 §4.7)
-- =============================================================================

CREATE TABLE subscriptions (
    -- Identity: canonical sub_<26-char Crockford ULID> per TYPES v5.1 prefix
    -- additions + OpenAPI v0.2 §20 wire shape (Option 2 widening, see header).
    id                          VARCHAR(30)    PRIMARY KEY,
    tenant_id                   TEXT           NOT NULL REFERENCES tenants(id),
    patient_id                  VARCHAR(26)    NOT NULL,

    -- What is being subscribed to (CDM §4.7)
    product_id                  VARCHAR(26)    NOT NULL,
    -- CDM-verbatim column name; FK target is medication_requests (see the
    -- GLOSSARY TENSION note in the header).
    prescription_id             VARCHAR(30)    NOT NULL,

    -- Cadence and pricing
    cadence                     VARCHAR(20)    NOT NULL,
    unit_price                  DECIMAL(10, 2) NOT NULL,
    currency                    CHAR(3)        NOT NULL,

    -- State machine (State Machines v1.1 §15 — authoritative state set)
    status                      VARCHAR(30)    NOT NULL,

    -- Lifecycle dates
    started_at                  TIMESTAMPTZ    NOT NULL,
    paused_at                   TIMESTAMPTZ,
    pause_until                 TIMESTAMPTZ,
    cancelled_at                TIMESTAMPTZ,
    cancel_reason               VARCHAR(100),
    next_renewal_at             TIMESTAMPTZ,
    last_fulfilled_at           TIMESTAMPTZ,

    -- Pre-authorization (per medication class)
    preauth_window_months       INTEGER        NOT NULL,
    preauth_renewals_remaining  INTEGER        NOT NULL,

    -- Payment (opaque handle; `mock_local_dev` staging posture — the real
    -- payment adapter is the standing Track-5 gap; no FK target exists)
    payment_method_id           VARCHAR(100),

    -- Optimistic concurrency (CDM §4.7)
    version                     INTEGER        NOT NULL DEFAULT 1,

    created_at                  TIMESTAMPTZ    NOT NULL DEFAULT NOW(),
    updated_at                  TIMESTAMPTZ    NOT NULL DEFAULT NOW(),

    -- Composite UNIQUE for downstream composite-FK pattern per
    -- PROJECT_CONVENTIONS r5 §1.1 (used by subscription_events below and by
    -- the refills.subscription_id FK closed in Section 3).
    CONSTRAINT subscriptions_tenant_id_id_unique UNIQUE (tenant_id, id),

    -- Composite FK: patient must belong to same tenant (012 target)
    CONSTRAINT subscriptions_tenant_patient_fk
        FOREIGN KEY (tenant_id, patient_id)
        REFERENCES accounts (tenant_id, account_id),

    -- Composite FK: product must belong to same tenant (024 target)
    CONSTRAINT subscriptions_tenant_product_fk
        FOREIGN KEY (tenant_id, product_id)
        REFERENCES product_catalog (tenant_id, id),

    -- Composite FK: medication request must belong to same tenant (025 target)
    CONSTRAINT subscriptions_tenant_prescription_fk
        FOREIGN KEY (tenant_id, prescription_id)
        REFERENCES medication_requests (tenant_id, id),

    -- Canonical id shape at the durable boundary (025 R9 MEDIUM precedent)
    CONSTRAINT subscriptions_id_canonical_format CHECK (
        id ~ '^sub_[0-7][0-9A-HJKMNPQRSTVWXYZ]{25}$'
    ),

    -- State enum per State Machines v1.1 §15 (10 states)
    CONSTRAINT subscriptions_status_valid CHECK (
        status IN (
            'DRAFT',
            'ACTIVE',
            'FULFILLING',
            'PAUSED',
            'SWITCHING',
            'CANCELLATION_PENDING',
            'CANCELLED',
            'DECLINED',
            'PAYMENT_FAILED_TERMINAL',
            'SAFETY_HOLD'
        )
    ),

    -- Cadence enum per CDM §4.7
    CONSTRAINT subscriptions_cadence_valid CHECK (
        cadence IN ('monthly', 'quarterly', 'biannual')
    ),

    -- Currency ISO 4217 shape (per-tenant CCR resolves the value)
    CONSTRAINT subscriptions_currency_valid CHECK (currency ~ '^[A-Z]{3}$'),

    -- Cheap defense-in-depth numeric guards (025 precedent class)
    CONSTRAINT subscriptions_unit_price_nonnegative CHECK (unit_price >= 0),
    CONSTRAINT subscriptions_preauth_window_positive CHECK (preauth_window_months > 0),
    CONSTRAINT subscriptions_preauth_renewals_nonnegative CHECK (preauth_renewals_remaining >= 0),
    CONSTRAINT subscriptions_version_positive CHECK (version >= 1),

    -- CDM §4.7 invariant: `pause_until` is required when status = PAUSED
    -- (paused_at is required with it — the 90-day window anchors on it).
    CONSTRAINT subscriptions_paused_fields_set_when_paused CHECK (
        status <> 'PAUSED' OR (paused_at IS NOT NULL AND pause_until IS NOT NULL)
    ),

    -- CDM §4.7 invariant: maximum pause duration is 90 days from paused_at
    -- (tenant-configurable DOWN, not up — the tenant-config narrowing is
    -- handler-layer; the 90-day ceiling is the durable floor).
    CONSTRAINT subscriptions_pause_window_max_90_days CHECK (
        paused_at IS NULL
        OR pause_until IS NULL
        OR pause_until <= paused_at + INTERVAL '90 days'
    ),

    -- Terminal-state coherence: CANCELLED rows carry cancelled_at
    -- (CDM §4.7: CANCELLED is terminal; re-enrollment creates a new row).
    CONSTRAINT subscriptions_cancelled_at_set_when_cancelled CHECK (
        status <> 'CANCELLED' OR cancelled_at IS NOT NULL
    )
);

-- Indexes per CDM §4.7 (tenant-lead per the RLS index discipline)
CREATE INDEX idx_subscriptions_tenant ON subscriptions (tenant_id);
CREATE INDEX idx_subscriptions_patient ON subscriptions (tenant_id, patient_id);
CREATE INDEX idx_subscriptions_status_renewal ON subscriptions (tenant_id, status, next_renewal_at);
CREATE INDEX idx_subscriptions_product ON subscriptions (tenant_id, product_id);

ALTER TABLE subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscriptions FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON subscriptions
    USING     (tenant_id = current_tenant_id())
    WITH CHECK (tenant_id = current_tenant_id());

-- =============================================================================
-- Section 2 — subscription_events (CDM v1.2 §4.8; append-only)
-- =============================================================================

CREATE TABLE subscription_events (
    -- Identity: canonical sue_<ULID> per TYPES v5.1 + OpenAPI §20.7.
    id              VARCHAR(30) PRIMARY KEY,
    tenant_id       TEXT        NOT NULL REFERENCES tenants(id),
    subscription_id VARCHAR(30) NOT NULL,

    -- CDM §4.8 event_type enum — VERBATIM 13 values (see the SPEC GAP note
    -- in the header for the §15 emissions that have no enum value).
    event_type      VARCHAR(50) NOT NULL,
    event_data      JSONB       NOT NULL,
    actor_type      VARCHAR(20) NOT NULL,
    actor_id        VARCHAR(26),

    occurred_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT subscription_events_tenant_id_id_unique UNIQUE (tenant_id, id),

    -- Composite FK: parent subscription must belong to same tenant
    CONSTRAINT subscription_events_tenant_subscription_fk
        FOREIGN KEY (tenant_id, subscription_id)
        REFERENCES subscriptions (tenant_id, id),

    CONSTRAINT subscription_events_id_canonical_format CHECK (
        id ~ '^sue_[0-7][0-9A-HJKMNPQRSTVWXYZ]{25}$'
    ),

    CONSTRAINT subscription_events_event_type_valid CHECK (
        event_type IN (
            'created',
            'activated',
            'paused',
            'resumed',
            'switching_initiated',
            'switched',
            'cancellation_pending',
            'cancelled',
            'declined',
            'payment_failed',
            'terminated_payment_failure',
            'safety_hold',
            'released_from_safety_hold'
        )
    ),

    CONSTRAINT subscription_events_actor_type_valid CHECK (
        actor_type IN ('patient', 'clinician', 'system', 'tenant_operator', 'platform_admin')
    ),

    -- Non-system actors must be attributed; system events may be anonymous.
    CONSTRAINT subscription_events_actor_id_set_for_humans CHECK (
        actor_type = 'system' OR actor_id IS NOT NULL
    )
);

-- CDM §4.8 indexes (tenant-lead adaptation recorded in header)
CREATE INDEX idx_subscription_events_subscription
    ON subscription_events (tenant_id, subscription_id, occurred_at);
CREATE INDEX idx_subscription_events_tenant_type
    ON subscription_events (tenant_id, event_type);

ALTER TABLE subscription_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscription_events FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON subscription_events
    USING     (tenant_id = current_tenant_id())
    WITH CHECK (tenant_id = current_tenant_id());

-- Append-only enforcement (CDM §4.8: "Append-only — no UPDATE or DELETE
-- operations"); 033/056/067 two-trigger convention.
CREATE OR REPLACE FUNCTION subscription_events_block_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
    RAISE EXCEPTION
        'subscription_events is append-only per CDM v1.2 §4.8 (subscription '
        'state-transition event log; audit/analytics/replay surface). '
        'UPDATE and DELETE are permanently prohibited.';
END;
$$;

CREATE TRIGGER subscription_events_block_update
    BEFORE UPDATE ON subscription_events
    FOR EACH ROW
    EXECUTE FUNCTION subscription_events_block_mutation();

CREATE TRIGGER subscription_events_block_delete
    BEFORE DELETE ON subscription_events
    FOR EACH ROW
    EXECUTE FUNCTION subscription_events_block_mutation();

-- =============================================================================
-- Section 3 — Close the migration 060 DEFERRED-FK TODO:
--   refills.subscription_id → subscriptions (tenant_id, id)
--
-- Migration 060 declared: "DEFERRED-FK TODO: add composite FK
-- (tenant_id, subscription_id) REFERENCES subscriptions (tenant_id, id) when
-- the Subscription slice lands (same class as 056's payment_intent_id
-- deferred FK)." The Subscription slice lands here.
--
-- Width note: 060 typed refills.subscription_id VARCHAR(26) anticipating a
-- plain-ULID id; the ratified TYPES prefix (`sub_`) makes subscription ids
-- 30 chars — widen before the FK (safe widening; greenfield, and the 060
-- partial index on (tenant_id, subscription_id) survives a type widen).
--
-- The 060-deferred subscription-consistency trigger (refill's
-- medication_request must match the subscription's prescription binding)
-- remains a NAMED FOLLOW-UP: it lands with the refill write path (SI-007
-- handler PRs) where the transactional write semantics it guards live —
-- same rationale as the migration 025 R12 reciprocity-trigger deferral.
-- =============================================================================

ALTER TABLE refills
    ALTER COLUMN subscription_id TYPE VARCHAR(30);

ALTER TABLE refills
    ADD CONSTRAINT refills_tenant_subscription_fk
        FOREIGN KEY (tenant_id, subscription_id)
        REFERENCES subscriptions (tenant_id, id);

-- =============================================================================
-- Section 4 — Table grants to the migration 074 slice roles (direct-INSERT
-- write path; see 074 header WRITE-PATH NOTE). RLS (FORCEd above) remains the
-- tenant floor beneath every grant.
--
--   subscription_patient_manager    INSERT (DRAFT create on behalf of the
--                                   checkout orchestration) + UPDATE
--                                   (patient-sovereign transitions) + SELECT
--                                   (self-scoped reads; handler adds the
--                                   patient_id predicate)
--   subscription_clinician_reviewer UPDATE + SELECT (clinical transitions)
--   subscription_system_scheduler   UPDATE + SELECT (time/event transitions)
--   subscription_staff_reader       SELECT only
--   (all three writers)             INSERT on subscription_events (the log
--                                   row rides the same tx as its transition)
--   (all four roles)                SELECT on subscription_events (§20.7)
-- =============================================================================

GRANT INSERT, UPDATE, SELECT ON subscriptions TO subscription_patient_manager;
GRANT UPDATE, SELECT ON subscriptions TO subscription_clinician_reviewer;
GRANT UPDATE, SELECT ON subscriptions TO subscription_system_scheduler;
GRANT SELECT ON subscriptions TO subscription_staff_reader;

GRANT INSERT, SELECT ON subscription_events TO subscription_patient_manager;
GRANT INSERT, SELECT ON subscription_events TO subscription_clinician_reviewer;
GRANT INSERT, SELECT ON subscription_events TO subscription_system_scheduler;
GRANT SELECT ON subscription_events TO subscription_staff_reader;

-- =============================================================================
-- Section 5 — Verification (067 Section 8 closing-check pattern)
-- =============================================================================

DO $$
DECLARE
    v_table  TEXT;
    v_tables TEXT[] := ARRAY['subscriptions', 'subscription_events'];
    v_count  INTEGER;
BEGIN
    -- Both tables exist with RLS FORCEd + a tenant_isolation policy
    FOREACH v_table IN ARRAY v_tables LOOP
        IF NOT EXISTS (
            SELECT 1 FROM pg_class c
            JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = 'public' AND c.relname = v_table
              AND c.relrowsecurity AND c.relforcerowsecurity
        ) THEN
            RAISE EXCEPTION 'migration-075-verification: table % missing or RLS not FORCED', v_table
                USING ERRCODE = 'check_violation';
        END IF;
    END LOOP;

    SELECT COUNT(*) INTO v_count
      FROM pg_policies
     WHERE schemaname = 'public'
       AND tablename = ANY (v_tables)
       AND policyname = 'tenant_isolation';
    IF v_count <> 2 THEN
        RAISE EXCEPTION 'migration-075-verification: expected 2 tenant_isolation policies, found %', v_count
            USING ERRCODE = 'check_violation';
    END IF;

    -- Append-only trigger pair present on subscription_events
    SELECT COUNT(*) INTO v_count
      FROM pg_trigger t
      JOIN pg_class c ON c.oid = t.tgrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relname = 'subscription_events'
       AND NOT t.tgisinternal;
    IF v_count <> 2 THEN
        RAISE EXCEPTION 'migration-075-verification: expected 2 append-only triggers on subscription_events, found %', v_count
            USING ERRCODE = 'check_violation';
    END IF;

    -- The 060 deferred FK is closed
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'refills_tenant_subscription_fk'
    ) THEN
        RAISE EXCEPTION 'migration-075-verification: refills_tenant_subscription_fk missing (Section 3 did not apply)'
            USING ERRCODE = 'check_violation';
    END IF;

    -- Grant posture: staff reader is SELECT-only on both tables
    IF has_table_privilege('subscription_staff_reader', 'public.subscriptions', 'INSERT, UPDATE, DELETE')
       OR has_table_privilege('subscription_staff_reader', 'public.subscription_events', 'INSERT, UPDATE, DELETE') THEN
        RAISE EXCEPTION 'migration-075-verification: subscription_staff_reader holds a write privilege — must be read-only'
            USING ERRCODE = 'check_violation';
    END IF;
END $$;
