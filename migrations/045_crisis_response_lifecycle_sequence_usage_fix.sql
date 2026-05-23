-- =============================================================================
-- File:    migrations/045_crisis_response_lifecycle_sequence_usage_fix.sql
-- Purpose: Retroactive hotfix for migration 035 (raw lifecycle writer): grant
--          USAGE on the BIGSERIAL implicit sequence
--          crisis_event_lifecycle_transition_id_seq to the writer-owner role
--          crisis_event_lifecycle_transition_writer_owner.
--
--          MIGRATION 035 granted INSERT + SELECT on
--          crisis_event_lifecycle_transition to the writer-owner role but did
--          NOT grant USAGE on the implicit BIGSERIAL sequence. The SECDEF
--          raw writer record_crisis_event_lifecycle_transition() runs as the
--          writer-owner; its INSERT omits id; PostgreSQL therefore calls
--          nextval() on the sequence under the writer-owner's privileges.
--          INSERT on the table does NOT confer sequence USAGE. Without an
--          explicit USAGE grant on the sequence, the FIRST invocation of the
--          raw writer fails with:
--
--              ERROR: permission denied for sequence crisis_event_lifecycle_transition_id_seq
--
--          This is the IDENTICAL defect closed in migration 042 §2 R1 HIGH-1
--          (Admin Backend PR 3 Codex R3, commit 838c07c on
--          feat/admin-backend-pr3-raw-writer). The Admin Backend raw writer
--          was caught + fixed pre-merge; the equivalent defect in already-
--          merged Crisis Response migration 035 is fixed retroactively here.
--
--          The single USAGE grant in this migration fixes ALL FIVE wrapper
--          invocation paths transitively. Migrations 036, 037, and 038 each
--          define a SECDEF wrapper (initiation, acknowledgement, response,
--          resolution, sweep). Every one of those wrappers invokes the raw
--          writer record_crisis_event_lifecycle_transition() — they do NOT
--          insert into crisis_event_lifecycle_transition directly. Because
--          the SECDEF raw writer runs as writer_owner regardless of which
--          wrapper called it, the nextval() permission check is always
--          against writer_owner. Granting USAGE to writer_owner once fixes
--          all five wrapper-invocation paths.
--
--          The other Crisis Response sequence-related tables do NOT need
--          analogous fixes:
--          - notification_crisis_escalation_obligation: id is
--            UUID PRIMARY KEY DEFAULT gen_random_uuid() (migration 033 §3
--            line 358) — NO implicit sequence; no USAGE grant needed.
--          - notification_crisis_dispatch_ledger: id is
--            UUID PRIMARY KEY DEFAULT gen_random_uuid() (migration 033 §1).
--          - notification_crisis_provider_attempt: id is UUID (migration 033 §2).
--          - crisis_event: id is UUID (migration 033 §4).
--          - crisis_sweep_execution: id is UUID (migration 033 §5).
--          - crisis_event_lifecycle_transition: id is BIGSERIAL (migration
--            033 §6 line 596) — the ONE table needing a sequence USAGE grant.
--
-- Spec:    - SI-022 Crisis Response Slice v1.0 Sub-decision 4.5 (raw canonical
--            lifecycle writer; anti-bypass discipline; runtime-executable
--            requirement)
--          - CDM v1.9 → v1.10 Amendment §3.1 (canonical executable wrapper-
--            body source; RATIFIED 2026-05-21 P-040)
--          - Migration 035 (forward writer definition + INSERT/SELECT grants)
--          - Migration 042 §2 R1 HIGH-1 closure 2026-05-22 (canonical precedent
--            pattern for BIGSERIAL sequence USAGE grant + has_sequence_privilege
--            self-verification + REVOKE-on-rollback)
--          - I-019 (crisis-detection-always-on platform-floor: a runtime-broken
--            raw writer would block crisis lifecycle transitions, violating the
--            platform-floor obligation; this hotfix restores executability)
--          - I-035 (append-only invariant; raw writer is the SOLE INSERT path)
-- =============================================================================

-- ---------------------------------------------------------------------------
-- PRECONDITIONS:
--   - 032_crisis_response_rbac_roles.sql (creates writer_owner role)
--   - 033_crisis_response_entities.sql (creates crisis_event_lifecycle_transition
--     with BIGSERIAL id → implicit sequence
--     crisis_event_lifecycle_transition_id_seq)
--   - 035_crisis_response_raw_lifecycle_writer.sql (creates the SECDEF raw
--     writer + INSERT/SELECT table grants without the USAGE on the sequence)
--   All applied. Subsequent wrapper migrations (036/037/038) may or may not be
--   applied; this hotfix is correct regardless because the USAGE grant flows
--   exclusively through the writer-owner role.
-- ---------------------------------------------------------------------------

-- =============================================================================
-- §1 — Grant USAGE on the BIGSERIAL implicit sequence to the writer-owner
-- =============================================================================

GRANT USAGE ON SEQUENCE crisis_event_lifecycle_transition_id_seq
    TO crisis_event_lifecycle_transition_writer_owner;

COMMENT ON SEQUENCE crisis_event_lifecycle_transition_id_seq IS
    'Implicit BIGSERIAL sequence for crisis_event_lifecycle_transition.id. '
    'USAGE granted to crisis_event_lifecycle_transition_writer_owner via '
    'migration 045 (retroactive hotfix to migration 035). The SECDEF raw '
    'writer record_crisis_event_lifecycle_transition() runs as writer_owner; '
    'its INSERT omits id, so PostgreSQL calls nextval() under writer_owner''s '
    'privileges. INSERT on the table does NOT confer sequence USAGE — this '
    'explicit grant is required for runtime executability. Five wrapper '
    'invocation paths (initiation/ack/response/resolution/sweep) all go '
    'through the same SECDEF raw writer, so the single USAGE grant fixes '
    'all five transitively. Canonical precedent: migration 042 §2 R1 HIGH-1 '
    'closure (Admin Backend PR 3 Codex R3, commit 838c07c).';

-- =============================================================================
-- §2 — Self-verification
--
-- Asserts: writer_owner HAS USAGE on the target sequence. Without this grant
-- the raw writer's first invocation would fail with "permission denied for
-- sequence" at runtime.
-- =============================================================================

DO $$
DECLARE
    v_sequence_oid          OID := to_regclass(
        'public.crisis_event_lifecycle_transition_id_seq'
    );
BEGIN
    -- Precondition: the sequence must exist. If migration 033 has not been
    -- applied (or the sequence was renamed), bail out clearly.
    IF v_sequence_oid IS NULL THEN
        RAISE EXCEPTION
            'migration-045-sequence-missing: '
            'public.crisis_event_lifecycle_transition_id_seq not found by '
            'to_regclass; migration 033 must be applied first';
    END IF;

    -- Precondition: the writer-owner role must exist. If migration 032 has
    -- not been applied, bail out clearly.
    IF NOT EXISTS (
        SELECT 1 FROM pg_roles
         WHERE rolname = 'crisis_event_lifecycle_transition_writer_owner'
    ) THEN
        RAISE EXCEPTION
            'migration-045-role-missing: '
            'crisis_event_lifecycle_transition_writer_owner role not found; '
            'migration 032 must be applied first';
    END IF;

    -- Canonical assertion: writer_owner has USAGE on the implicit sequence.
    -- has_sequence_privilege() reports the effective privilege (including
    -- privileges inherited through role membership), so this assertion
    -- catches both direct grants and any future role-restructuring drift.
    IF NOT has_sequence_privilege(
        'crisis_event_lifecycle_transition_writer_owner',
        'public.crisis_event_lifecycle_transition_id_seq',
        'USAGE'
    ) THEN
        RAISE EXCEPTION
            'migration-045-sequence-usage-missing: '
            'crisis_event_lifecycle_transition_writer_owner does NOT have '
            'USAGE on crisis_event_lifecycle_transition_id_seq; '
            'record_crisis_event_lifecycle_transition() SECDEF raw writer '
            'nextval call will fail at runtime with permission denied for '
            'sequence — migration 045 grant did not take effect';
    END IF;

    -- Belt-and-braces: assert the grant is also visible in
    -- information_schema.role_usage_grants (direct grant, not just
    -- inherited). This catches a future hygiene cycle that might revoke
    -- the direct grant while leaving an indirect path via role membership;
    -- per the canonical pattern, the writer-owner role must hold the grant
    -- DIRECTLY so anti-bypass auditing remains tractable.
    IF NOT EXISTS (
        SELECT 1
          FROM information_schema.role_usage_grants
         WHERE object_schema = 'public'
           AND object_name = 'crisis_event_lifecycle_transition_id_seq'
           AND object_type = 'SEQUENCE'
           AND privilege_type = 'USAGE'
           AND grantee = 'crisis_event_lifecycle_transition_writer_owner'
    ) THEN
        RAISE EXCEPTION
            'migration-045-direct-grant-missing: '
            'crisis_event_lifecycle_transition_writer_owner does not hold a '
            'DIRECT USAGE grant on crisis_event_lifecycle_transition_id_seq '
            '(only inherited via role membership). Direct grant required for '
            'tractable anti-bypass auditing; canonical precedent migration '
            '042 §2 establishes the direct-grant pattern.';
    END IF;
END $$;
