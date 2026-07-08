-- =============================================================================
-- File:    migrations/066_ai_mode1_rbac_roles.sql
-- Purpose: Create the 2 net-new RBAC roles required by the Mode 1 persistence
--          entities (AI Service Mode 1 Handler Spec v0.4 RATIFIED at P-035
--          2026-05-21 + CDM v1.7 -> v1.8 + AUDIT_EVENTS v5.9 -> v5.10 +
--          DOMAIN_EVENTS additive + CCR_RUNTIME v5.3 -> v5.4 follow-on
--          amendment RATIFIED at P-036 + P-036a).
--
--          This is PR 1 of the Mode 1 persistence implementation series --
--          pure RBAC role creation. No table DDL, no RLS policies, no view
--          DDL, no grants. The follow-up migration 067 adds the 5 Mode 1
--          conversation entities + the ai_mode1_conversation_state derived
--          view + RLS + append-only triggers + the amendment's grant chain,
--          following the Crisis Response (032 -> 033) + Admin Backend
--          (039 -> 040) + Med-Interaction (046 -> 047) + Async Consult
--          (055 -> 056) roles-then-entities cadence.
--
--          The amendment's Section 6 RBAC table is additive (no RBAC version
--          bump) and enumerates EXACTLY 2 roles -- no more:
--            - ai_mode1_view_owner  (non-BYPASSRLS owner of the
--              ai_mode1_conversation_state PLAIN derived view per the Mode 1
--              spec R7 HIGH-1 closure; holds the owner-only column-level
--              base-table SELECT grants; never granted to humans)
--            - ai_mode1_reader      (SELECT on the derived VIEW ONLY; no
--              base-table access; granted to the Mode 1 service account +
--              clinician dashboard + pharmacy portal + admin roles via the
--              Admin Backend role-assignment surface)
--
--          Neither role exists in the DB from prior migrations (verified
--          against migrations 000-065: migration 064 created
--          `ai_service_account` -- a DIFFERENT role, the SI-010 actor-class
--          bridge for the AI-preparation wrapper -- and only referenced the
--          spec RBAC names R-3 ai_service_mode1 / R-4 ai_service_mode2 in
--          comments, never as DB roles). Both CREATE ROLE statements below
--          are therefore unconditional, mirroring migration 055; no
--          to_regrole() existence guards are required.
--
--          Both roles are NOLOGIN + non-BYPASSRLS per the spec-corpus
--          canonical pattern (matches migrations 032 / 039 / 046 / 055
--          precedent). ai_mode1_view_owner is an owner role -- it exists
--          solely to own the plain view + hold the least-privilege
--          column-level base-table SELECT grants; the amendment's Section 6
--          preflight (executed in migration 067 Section 0) hard-fails if it
--          carries BYPASSRLS. ai_mode1_reader is an application role bound
--          at request time via the application's authContextPlugin (SI-010
--          trust anchor from migration 031); the DB role is the privilege
--          boundary, not a login identity.
--
--          PER RATIFIER OPTION 2 (carryforward from Crisis Response /
--          Admin Backend / Med-Interaction / Async Consult PRs;
--          docs/crisis-response-implementation-plan.md):
--          - Adapt to code-repo conventions: NOLOGIN + non-BYPASSRLS only.
--          - No grants in this migration (granted in their natural phase in
--            migration 067 when the tables + view exist, per the P-040 s8.2
--            R9 HIGH-1 closure pattern every prior slice PR 1 followed).
--          - Role names taken verbatim from the amendment's Section 6 RBAC
--            table; no normalization needed (no dotted-canonical forms).
--
-- Spec:    - AI Service Mode 1 Handler Spec v0.4 RATIFIED (2026-05-21 P-035;
--            sibling repo: telecheckONE/Telecheck Master Bundle FINAL US
--            REGION BASELINE/Telecheck_AI_Service_Mode_1_Handler_Spec_v0_1.md)
--          - CDM v1.7 -> v1.8 + AUDIT_EVENTS v5.9 -> v5.10 + DOMAIN_EVENTS
--            additive + CCR_RUNTIME v5.3 -> v5.4 Amendment (RATIFIED P-036 +
--            P-036a; sibling repo: telecheckONE/Telecheck Master Bundle FINAL
--            US REGION BASELINE/Telecheck_CDM_v1_7_to_v1_8_Amendment.md
--            Section 6 -- the authoritative 2-role enumeration)
--          - I-023 (three-layer tenant isolation)
--          - I-035 (strict append-only on all 5 Mode 1 entities; enforced in
--            migration 067)
-- Summary: Creates 2 net-new RBAC roles:
--          - View owner (1): ai_mode1_view_owner
--          - Application/reader (1): ai_mode1_reader
--
--          Both NOLOGIN + non-BYPASSRLS. NO grants in this migration.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- View-owner role (1) -- owns the ai_mode1_conversation_state PLAIN derived
-- view (migration 067 Section 6) + holds the owner-only column-level SELECT
-- grants on the 3 base tables the view body reads. NOT granted to humans.
-- View ownership + base-table grants land with migration 067; this migration
-- only creates the role principal.
-- -----------------------------------------------------------------------------

CREATE ROLE ai_mode1_view_owner NOLOGIN NOBYPASSRLS;
COMMENT ON ROLE ai_mode1_view_owner IS
    'P-036 Section 6 view-owner role: owns the ai_mode1_conversation_state PLAIN derived view '
    '(non-BYPASSRLS per Mode 1 spec R7 HIGH-1 closure). Plain views execute base-table queries '
    'with the OWNER''s privileges, so this role holds the owner-only column-level SELECT grants '
    'on ai_mode1_conversation + ai_mode1_conversation_turn_result + '
    'ai_mode1_conversation_archival_event -- exactly the view''s SELECT list; explicitly NOT '
    'granted the PHI-bearing user_message / assistant_message columns even at the owner level '
    '(least-privilege all the way down). Tenant isolation inside the view body is enforced via '
    'the calling session''s GUC (current_tenant_id()), and RLS on the base tables applies to '
    'this owner because it is non-BYPASSRLS. Created by migration; not granted to humans; held '
    'by the service-account-owner pattern. Migration 067 Section 0 preflight hard-fails if this '
    'role is missing or carries BYPASSRLS.';

-- -----------------------------------------------------------------------------
-- Reader application role (1) -- SELECT on the derived VIEW ONLY. No
-- base-table access of any kind (cannot bypass the view's MAX/EXISTS
-- aggregation; cannot enumerate per-turn timestamps or per-archival entries;
-- cannot see message-bearing columns even indirectly) per the amendment's
-- R6 + R7 data-minimization closures. Grant lands with migration 067.
-- -----------------------------------------------------------------------------

CREATE ROLE ai_mode1_reader NOLOGIN NOBYPASSRLS;
COMMENT ON ROLE ai_mode1_reader IS
    'P-036 Section 6 application role: read access to the ai_mode1_conversation_state derived '
    'view via the plain-view + view-owner-privileges pattern (post-R7 design; the '
    '"SECURITY INVOKER semantics" descriptor was REMOVED per the post-P-042 audit Finding 3 '
    'closure 2026-05-22). Has SELECT on the VIEW ONLY -- no base-table grants; cannot query '
    'the Mode 1 base tables directly, cannot bypass the view''s aggregation, cannot see '
    'message-bearing columns even indirectly (amendment R6 HIGH-1 + R7 HIGH-1 closures). '
    'Granted to the Mode 1 service account + clinician dashboard role + pharmacy portal role + '
    'admin role via the Admin Backend role-assignment surface per the amendment Section 6 '
    '"Granted to" column.';

-- =============================================================================
-- Verification: count of net-new Mode 1 roles should be exactly 2, and the
-- view owner must be non-BYPASSRLS at creation time. This DO block fails
-- loudly on partial apply, extra roles, or missing roles. Mirrors the
-- migration 055 verification pattern.
-- =============================================================================

DO $$
DECLARE
    v_created_count INTEGER;
    v_expected_count CONSTANT INTEGER := 2;
BEGIN
    SELECT COUNT(*) INTO v_created_count
      FROM pg_roles
     WHERE rolname IN (
         'ai_mode1_view_owner',
         'ai_mode1_reader'
     );

    IF v_created_count <> v_expected_count THEN
        RAISE EXCEPTION
            'migration-066-ai-mode1-rbac-count-mismatch: '
            'expected % Mode 1 roles created, found %; '
            'P-036 Section 6 RBAC table requires both (1 view owner + 1 reader)',
            v_expected_count, v_created_count;
    END IF;

    -- ai_mode1_view_owner non-BYPASSRLS preflight: the amendment's Section 6
    -- DO-block assertion is the view-creation-time gate (executed again in
    -- migration 067 Section 0 before ALTER VIEW ... OWNER TO). At PR 1 (this
    -- migration) the role is just-created with NOBYPASSRLS, so this is a
    -- belt-and-braces assertion of the canonical posture.
    IF (SELECT rolbypassrls FROM pg_roles WHERE rolname = 'ai_mode1_view_owner') THEN
        RAISE EXCEPTION
            'migration-066-ai-mode1-view-owner-has-bypassrls: '
            'ai_mode1_view_owner has BYPASSRLS at PR-1 creation time, which violates the '
            'canonical view-owner posture (P-036 Section 6 preflight requires '
            'rolbypassrls=false before view ownership assignment per the Mode 1 spec R7 '
            'HIGH-1 closure). The CREATE ROLE statement above declares NOBYPASSRLS -- if '
            'this assertion fires, the role was modified after creation or the migration '
            'was edited.';
    END IF;
END $$;
