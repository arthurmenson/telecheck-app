-- =============================================================================
-- File:    migrations/074_subscription_rbac_roles.sql
-- Purpose: Create the 4 application roles for the Subscription slice
--          (CDM v1.2 §4.7 Subscription + §4.8 SubscriptionEvent; State
--          Machines v1.1 §15 Subscription State Machine; OpenAPI v0.2 §20
--          Subscriptions module; Pharmacy + Refill Slice PRD v2.1 §8).
--
--          This is PR-part 1 of the Subscription slice implementation
--          (074 roles → 075 entities + grants → 076 app-role bridge +
--          actor-helper grants), following the Async Consult cadence
--          (055 → 056 → 061/063) adapted to the direct-INSERT (non-SECDEF)
--          write path.
--
--          SI-001 closure context: the Subscription module skeleton was
--          BLOCKED on SI-001 (MedicationRequest schema gap). SI-001 closed
--          at Promotion Ledger P-011 (2026-05-11; migration 025 landed
--          medication_requests). Operator (Evans) confirmed 2026-07-08 that
--          P-011 closure authorizes this build.
--
--          ROLE-NAMING NOTE (documented divergence, 055-precedent class):
--          RBAC Permissions Matrix v1.2 names NO subscription-specific
--          roles (verified by corpus grep 2026-07-08 — zero subscription
--          rows). Per the established minimal-application-roles pattern
--          (migration 055 header discipline), this migration creates the
--          MINIMAL role set implied by the ratified transition actor
--          classes in State Machines v1.1 §15 (patient / clinician /
--          system) plus the OpenAPI §20.1 staff read path (Tenant Admin /
--          Tenant Operator / Tenant Billing tenant-wide list). When a
--          future RBAC bump ratifies canonical subscription role names,
--          rename via a follow-up migration (find-and-replace class).
--
--          WRITE-PATH NOTE (documented decision): Pharmacy + Refill Slice
--          PRD v2.1 §8 does NOT prescribe SECDEF wrapper procedures for
--          subscription writes (contrast P-038 §3 for Async Consult).
--          The Subscription slice therefore uses the direct-INSERT/UPDATE
--          composition under a slice role (the migration 056-§7 /
--          pharmacy-precedent class): handlers compose
--          withTransaction → withTenantContext → withActorContext →
--          withDbRole(<subscription role>) → plain SQL, with RLS
--          ENABLE+FORCE on every table (075) as the enforcement floor.
--          No wrapper-owner roles are needed.
--
--          All 4 roles are NOLOGIN + non-BYPASSRLS per the canonical
--          pattern (matches 032/039/046/055/066). NO grants in this
--          migration — table grants land with the entities (075), and
--          telecheck_app_role membership bridges land in 076, per the
--          natural-phase grant discipline (P-040 §8.2 R9 HIGH-1 closure
--          pattern).
--
-- Spec:    - CDM v1.2 §4.7 (subscriptions) + §4.8 (subscription_events) +
--            §3.12 (Ecom & Subscription Management inventory)
--          - State Machines v1.1 §15 (transition actor classes; SAFETY_HOLD
--            release is clinician-only per I-001 floor)
--          - OpenAPI v0.2 §20 (endpoint auth classes)
--          - Pharmacy + Refill Slice PRD v2.1 §8
--          - Promotion Ledger P-011 (SI-001 closure)
--          - I-023 (three-layer tenant isolation)
-- Rollback: migrations/rollback/074_rollback.sql
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Application roles (4) — assigned to end-user / service principals at request
-- time via authContextPlugin (SI-010 trust anchor); the DB roles are the
-- privilege boundary, never direct login identities.
-- -----------------------------------------------------------------------------

CREATE ROLE subscription_patient_manager NOLOGIN NOBYPASSRLS;
COMMENT ON ROLE subscription_patient_manager IS
    'Subscription slice application role: patient principal managing their own '
    'subscription. Write path for the patient-sovereign transitions per State '
    'Machines v1.1 §15 — pause_request (ACTIVE→PAUSED), resume (PAUSED→ACTIVE, '
    'early), switch_request (ACTIVE→SWITCHING), cancel_request '
    '(ACTIVE→CANCELLATION_PENDING) — plus DRAFT creation on behalf of the '
    'checkout orchestration (the POST /subscriptions HTTP surface itself is '
    'ratified under the OpenAPI v0.2 Payments module and is NOT mounted by this '
    'slice; see src/modules/subscription/README.md). Self-scoping (patient sees '
    'only own rows) is enforced at the handler layer (WHERE patient_id = '
    'verified actor identity) on top of tenant RLS.';

CREATE ROLE subscription_clinician_reviewer NOLOGIN NOBYPASSRLS;
COMMENT ON ROLE subscription_clinician_reviewer IS
    'Subscription slice application role: clinician principal executing the '
    'clinical-review transitions per State Machines v1.1 §15 — '
    'clinician_approval (DRAFT→ACTIVE), clinician_decline (DRAFT→DECLINED), '
    'switch approve/decline (SWITCHING→ACTIVE), clinician_release '
    '(SAFETY_HOLD→ACTIVE; clinician-ONLY per the §15 I-001-floor guard), '
    'clinician_terminate (SAFETY_HOLD→CANCELLED). No HTTP surface at v0.2 '
    '(OpenAPI v0.2 §20 ratifies no clinician subscription endpoints) — reached '
    'via the module''s exported service functions.';

CREATE ROLE subscription_system_scheduler NOLOGIN NOBYPASSRLS;
COMMENT ON ROLE subscription_system_scheduler IS
    'Subscription slice application role: system/scheduler principal executing '
    'the time- and event-driven transitions per State Machines v1.1 §15 — '
    'period_end (ACTIVE→FULFILLING), complete (FULFILLING→ACTIVE), auto-resume '
    'at pause_until (PAUSED→ACTIVE), pause_expires (PAUSED→CANCELLED), '
    'end_period (CANCELLATION_PENDING→CANCELLED), payment_failed_terminal '
    '(ACTIVE→PAYMENT_FAILED_TERMINAL), safety_signal_critical '
    '(ACTIVE→SAFETY_HOLD). No HTTP surface — reached via exported service '
    'functions (future scheduler / domain-event subscriber wiring).';

CREATE ROLE subscription_staff_reader NOLOGIN NOBYPASSRLS;
COMMENT ON ROLE subscription_staff_reader IS
    'Subscription slice application role: tenant-staff tenant-wide read path '
    'per OpenAPI v0.2 §20.1 (Tenant Admin / Tenant Operator / Tenant Billing '
    'list + get + event history). Patients read under '
    'subscription_patient_manager with handler-layer self-scoping instead.';

-- =============================================================================
-- Verification — exactly 4 net-new roles, all non-BYPASSRLS (046/055 pattern).
-- =============================================================================

DO $$
DECLARE
    v_count INTEGER;
BEGIN
    SELECT COUNT(*) INTO v_count
      FROM pg_roles
     WHERE rolname IN (
         'subscription_patient_manager',
         'subscription_clinician_reviewer',
         'subscription_system_scheduler',
         'subscription_staff_reader'
     );
    IF v_count <> 4 THEN
        RAISE EXCEPTION
            'migration-074-subscription-rbac-count-mismatch: expected 4 roles, found %',
            v_count;
    END IF;

    IF EXISTS (
        SELECT 1 FROM pg_roles
         WHERE rolname IN (
             'subscription_patient_manager',
             'subscription_clinician_reviewer',
             'subscription_system_scheduler',
             'subscription_staff_reader'
         )
           AND rolbypassrls
    ) THEN
        RAISE EXCEPTION
            'migration-074-subscription-role-has-bypassrls: subscription slice roles '
            'must be non-BYPASSRLS (I-023 three-layer enforcement floor).';
    END IF;
END $$;
