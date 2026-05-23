-- =============================================================================
-- File:    migrations/041_admin_backend_derived_views.sql
-- Purpose: Create the Admin Backend Basics derived views per CDM v1.10 → v1.11
--          Amendment §4.NEW5-NEW9 (RATIFIED 2026-05-22 P-042).
--
--          PR 2 of the Admin Backend Basics implementation series. Spec
--          enumerates 4 views (3 dashboard + 1 pending-only reviewer view).
--          Per ratifier Option 2 (carryforward from Crisis Response):
--          - admin_crisis_operational_health_v          → CREATED (entities
--            exist post-migrations 032 + 033)
--          - admin_consult_queue_health_v               → DEFERRED (consult /
--            consult_lifecycle_transition / consult_review_claim entities
--            do NOT exist in code repo; SI-021 async-consult slice not yet
--            implemented; recreate verbatim when those entities land)
--          - admin_mode1_volume_health_v                → DEFERRED (Mode 1
--            ai_mode1_conversation entity does NOT exist in code repo;
--            P-036 Mode 1 slice not yet implemented; recreate verbatim
--            when ai_mode1_conversation lands)
--          - forms_template_admin_review_pending_v      → CREATED (entities
--            exist post-migration 040)
--
--          PER RATIFIER DECISION 2026-05-22 — OPTION 2 (additional adaptations
--          on top of "deferred" entities):
--          - View predicate `current_tenant_id_strict('view_name')` →
--            `current_tenant_id()` (code-repo pattern from migration 003)
--          - Audit-table reference `audit_event(action_id, recorded_at)` →
--            `audit_records(action, recorded_at)` per code-repo migration 002
--            (column-name + table-name adaptation; semantic equivalent)
--          - View body otherwise verbatim from CDM §4.NEW5 + §4.NEW9
--          - For pending-only view: security_invoker=false (default) +
--            security_barrier=true per spec §4.NEW9; view-owner needs SELECT
--            on the 2 underlying base tables for the view body to execute
--            under owner privileges
--
-- Spec:    - CDM v1.10 → v1.11 Amendment §4.NEW5 + §4.NEW9 (RATIFIED P-042;
--            telecheckONE/Telecheck Master Bundle FINAL US REGION BASELINE/
--            Telecheck_CDM_v1_10_to_v1_11_Amendment.md)
--          - SI-023 Admin Backend Basics §3.5 (canonical wrapper-only read
--            path discipline) + §7 RBAC grant matrix
--          - I-023 (three-layer tenant isolation; tenant_id on every view row)
--          - I-027 (audit completeness via co-transactional dashboard wrapper
--            INSERT into admin_dashboard_query_execution; lands in PR 4)
--
-- Summary: Creates 2 derived views (admin_crisis_operational_health_v +
--          forms_template_admin_review_pending_v) with security_invoker /
--          security_barrier flags + ownership ALTERs + REVOKE FROM PUBLIC +
--          GRANTs per §7 RBAC grant matrix. Documents the 2 deferred views
--          with TODO markers + foundation-dependency notes. No SECDEF
--          procedures in this migration — those land in PR 3-5.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- PRECONDITIONS:
--   001_tenants.sql                              applied (tenants table)
--   002_audit_chain.sql                          applied (audit_records table)
--   003_rls_helpers.sql                          applied (current_tenant_id())
--   032_crisis_response_rbac_roles.sql           applied (crisis_event read-side roles)
--   033_crisis_response_entities.sql             applied (crisis_event +
--                                                  crisis_event_lifecycle_transition +
--                                                  crisis_sweep_execution +
--                                                  notification_crisis_escalation_obligation)
--   039_admin_backend_rbac_roles.sql             applied (12 admin RBAC roles)
--   040_admin_backend_entities.sql               applied (forms_template_admin_review +
--                                                  forms_template_admin_review_lifecycle_transition)
-- ---------------------------------------------------------------------------

-- =============================================================================
-- §1 — admin_crisis_operational_health_v (CDM §4.NEW5)
--
-- Tenant-scoped view aggregating canonical crisis-domain entities. Per CDM
-- §4.NEW5 P-042 R3 HIGH-1 closure: view body aggregates each fact source
-- independently via per-tenant scalar/CTE subqueries to avoid 1:N join
-- multiplication corrupting operational counts. Per-severity rollup.
-- security_invoker=true (view body runs under caller privileges via the
-- wrapper-owner) + security_barrier=true (predicate-pushdown safety).
--
-- Aggregation design (verbatim CDM §4.NEW5):
--   - active_events_by_severity: per-(tenant, severity) count of crisis_event
--     rows whose latest lifecycle_transition is in an active state
--   - escalation_backlog: per-tenant count of escalation obligations past
--     undeliverable_deadline + AVG-tier across them
--   - stale_sweeps: per-tenant count of un-completed sweep_execution rows
--     whose claim_expires_at has passed
--   - crisis_audit_24h: per-tenant count of audit rows with action='crisis.*'
--     in the last 24h
--
-- Option 2 syntax adaptations:
--   - current_tenant_id_strict('admin_crisis_operational_health_v') →
--     current_tenant_id() (no entity-name parameter at v0.1)
--   - audit_event.action_id → audit_records.action
--   - audit_event → audit_records
-- =============================================================================

CREATE VIEW admin_crisis_operational_health_v
WITH (security_invoker = true, security_barrier = true)
AS
WITH tenant_scope AS (
    SELECT current_tenant_id() AS tenant_id
),
active_events_by_severity AS (
    SELECT ce.tenant_id, ce.severity,
           COUNT(*) FILTER (WHERE latest.to_state IN ('detected', 'escalated', 'acknowledged', 'responded')) AS active_event_count
      FROM public.crisis_event ce
      JOIN tenant_scope ts ON ts.tenant_id = ce.tenant_id
      LEFT JOIN LATERAL (
          SELECT to_state FROM public.crisis_event_lifecycle_transition
          WHERE tenant_id = ce.tenant_id AND crisis_event_id = ce.id
          ORDER BY transition_at DESC, id DESC LIMIT 1
      ) latest ON TRUE
     GROUP BY ce.tenant_id, ce.severity
),
escalation_backlog AS (
    SELECT nceo.tenant_id, COUNT(*) AS backlog_count, AVG(
        CASE nceo.tier
            WHEN 'care_team'        THEN 1
            WHEN 'clinical_on_call' THEN 2
            WHEN 'regulatory'       THEN 3
            ELSE NULL END
    )::NUMERIC(3,2) AS avg_tier
      FROM public.notification_crisis_escalation_obligation nceo
      JOIN tenant_scope ts ON ts.tenant_id = nceo.tenant_id
     WHERE nceo.undeliverable_deadline < now()
     GROUP BY nceo.tenant_id
),
stale_sweeps AS (
    SELECT cse.tenant_id, COUNT(*) AS stale_count
      FROM public.crisis_sweep_execution cse
      JOIN tenant_scope ts ON ts.tenant_id = cse.tenant_id
     WHERE cse.completed_at IS NULL AND cse.claim_expires_at < now()
     GROUP BY cse.tenant_id
),
crisis_audit_24h AS (
    SELECT ar.tenant_id, COUNT(*) AS audit_count
      FROM public.audit_records ar
      JOIN tenant_scope ts ON ts.tenant_id = ar.tenant_id
     WHERE ar.action LIKE 'crisis.%'
       AND ar.recorded_at > now() - INTERVAL '24 hours'
     GROUP BY ar.tenant_id
)
SELECT
    aes.tenant_id,
    aes.severity,
    aes.active_event_count,
    COALESCE(eb.backlog_count, 0) AS escalation_obligation_backlog_count,
    COALESCE(ss.stale_count, 0) AS stale_sweep_count,
    eb.avg_tier AS active_obligation_avg_tier,
    COALESCE(ca.audit_count, 0) AS crisis_audit_24h_count
FROM active_events_by_severity aes
LEFT JOIN escalation_backlog eb ON eb.tenant_id = aes.tenant_id
LEFT JOIN stale_sweeps      ss ON ss.tenant_id = aes.tenant_id
LEFT JOIN crisis_audit_24h  ca ON ca.tenant_id = aes.tenant_id;

-- View-owner per §6 RBAC table: SOLE role with SELECT on this view.
ALTER VIEW admin_crisis_operational_health_v
    OWNER TO admin_crisis_operational_health_view_owner;

-- Per-§7 grant-matrix invariant: SELECT REVOKE FROM PUBLIC + GRANT only to
-- the wrapper-owner role. admin_basic_operator gets EXECUTE on the wrapper
-- (lands in PR 4), NOT direct SELECT on the view — wrapper-only canonical
-- read path discipline per SI-023 §3.5.
REVOKE ALL ON admin_crisis_operational_health_v FROM PUBLIC;
GRANT SELECT ON admin_crisis_operational_health_v
    TO read_admin_crisis_operational_health_wrapper_owner;

-- =============================================================================
-- §2 — admin_consult_queue_health_v  (DEFERRED per Option 2)
--
-- Source: CDM §4.NEW6 + SI-023 Sub-decision 2 Surface 2.
--
-- Foundation dependency missing: requires `consult` +
-- `consult_lifecycle_transition` + `consult_review_claim` entities from
-- SI-021 (Async Consult slice; P-038 in spec corpus). Those entities are
-- NOT in the code repo at this checkpoint. A future Option-2 hygiene
-- migration must:
--   (a) implement SI-021 entities (or at minimum the 3 above) in a
--       dedicated PR following the same Option-2 adaptations as
--       Crisis Response;
--   (b) recreate this view verbatim per CDM §4.NEW6 with current_tenant_id()
--       replacing current_tenant_id_strict(...) per the same Option-2
--       discipline used for §1 above;
--   (c) ALTER OWNER TO admin_consult_queue_health_view_owner;
--   (d) GRANT SELECT TO read_admin_consult_queue_health_wrapper_owner.
--
-- The view-owner role + wrapper-owner role were created in migration 039
-- so the §6 RBAC table is internally consistent; only the view body is
-- deferred. Per the §7 grant-matrix invariant, no other role holds SELECT.
--
-- DELIBERATELY NOT CREATED at v0.1.
-- =============================================================================

-- =============================================================================
-- §3 — admin_mode1_volume_health_v  (DEFERRED per Option 2)
--
-- Source: CDM §4.NEW7 + SI-023 Sub-decision 2 Surface 3.
--
-- Foundation dependency missing: requires `ai_mode1_conversation` entity
-- from P-036 Mode 1 (CDM v1.4 / Master PRD v1.10 §13.7 AI workload
-- taxonomy). That entity is NOT in the code repo at this checkpoint.
-- Additionally the spec view body depends on Cat A audit emissions
-- (`mode1.crisis_detection_trigger` + `mode1.safety_floor_response_emitted`)
-- that require P-036 Mode 1 application-layer audit emitters to exist.
--
-- A future Option-2 hygiene migration must:
--   (a) implement ai_mode1_conversation entity + Mode 1 audit emitters;
--   (b) recreate this view verbatim per CDM §4.NEW7;
--   (c) ALTER OWNER TO admin_mode1_volume_health_view_owner;
--   (d) GRANT SELECT TO read_admin_mode1_volume_health_wrapper_owner.
--
-- DELIBERATELY NOT CREATED at v0.1.
-- =============================================================================

-- =============================================================================
-- §4 — forms_template_admin_review_pending_v (CDM §4.NEW9; R7 HIGH-2 closure)
--
-- Reviewer-scoped pending-only review surface. Mechanically enforces
-- SI-023 §7's "pending reviews" prose qualifier — direct SELECT on the
-- base table would expose every review (including approved/rejected
-- terminal history + ai_guardrail_snapshot_jsonb payloads from prior
-- cycles), which is an authorization-scope expansion not intended by §7.
-- This view filters to to_state IN ('pending_review', 'revision_requested')
-- only.
--
-- Per CDM §4.NEW9 + Option 2 adaptations:
--   - security_invoker=false (default; view body runs under view-owner
--     privileges so the LATERAL JOIN to lifecycle_transition can read
--     without requiring the reviewer to hold direct SELECT on it —
--     which would violate the wrapper-only canonical read path).
--   - security_barrier=true: predicate-pushdown safety against malicious
--     functions injected in SELECT lists.
--   - current_tenant_id_strict('forms_template_admin_review_pending_v') →
--     current_tenant_id() (Option 2 GUC-based tenant binding).
--   - View-owner needs SELECT on the 2 underlying base tables for the
--     view body to execute under owner privileges (class-H allowlist).
-- =============================================================================

CREATE VIEW forms_template_admin_review_pending_v
WITH (security_barrier = true)
AS
SELECT
    ftar.review_id,
    ftar.tenant_id,
    ftar.forms_template_id,
    ftar.submitter_principal_id,
    ftar.ai_guardrail_snapshot_jsonb,
    ftar.created_at,
    latest.to_state           AS current_state,
    latest.transition_at      AS current_state_transition_at
FROM forms_template_admin_review ftar
JOIN LATERAL (
    SELECT to_state, transition_at
      FROM forms_template_admin_review_lifecycle_transition lt
     WHERE lt.tenant_id = ftar.tenant_id AND lt.review_id = ftar.review_id
     ORDER BY lt.transition_at DESC, lt.id DESC
     LIMIT 1
) latest ON TRUE
WHERE ftar.tenant_id = current_tenant_id()
  AND latest.to_state IN ('pending_review', 'revision_requested');

-- View-owner per §6 RBAC table row 12 (R7 HIGH-2 +1 addition).
ALTER VIEW forms_template_admin_review_pending_v
    OWNER TO forms_template_admin_review_pending_view_owner;

-- Per-§7 grant-matrix invariant: reviewer holds SELECT on the view only
-- (NOT on the base table); view-owner self-grant; no other SELECT grants.
REVOKE ALL ON forms_template_admin_review_pending_v FROM PUBLIC;
GRANT SELECT ON forms_template_admin_review_pending_v TO admin_template_reviewer;

-- View-owner privilege flow (security_invoker=false): the view-owner needs
-- SELECT on the 2 underlying entities so the view body can execute under
-- owner privileges. These grants are class-H allowlisted per CDM §4.NEW9.
GRANT SELECT ON forms_template_admin_review
    TO forms_template_admin_review_pending_view_owner;
GRANT SELECT ON forms_template_admin_review_lifecycle_transition
    TO forms_template_admin_review_pending_view_owner;

-- =============================================================================
-- §5 — Verification
-- =============================================================================

DO $$
DECLARE
    v_created_views_count INTEGER;
    v_expected_views_count CONSTANT INTEGER := 2;    -- 2 created + 2 deferred
    v_deferred_views_count INTEGER;
BEGIN
    -- Verify the 2 created views exist
    SELECT COUNT(*) INTO v_created_views_count
      FROM pg_views
     WHERE schemaname = 'public'
       AND viewname IN (
           'admin_crisis_operational_health_v',
           'forms_template_admin_review_pending_v'
       );

    IF v_created_views_count <> v_expected_views_count THEN
        RAISE EXCEPTION
            'migration-041-view-count-mismatch: '
            'expected % admin-backend views created (admin_crisis_operational_health_v + '
            'forms_template_admin_review_pending_v); found %. The other 2 spec views '
            '(admin_consult_queue_health_v + admin_mode1_volume_health_v) are '
            'DEFERRED per Option 2 carryforward (foundation entities missing).',
            v_expected_views_count, v_created_views_count;
    END IF;

    -- Verify the 2 deferred views are NOT present (documents the deferral
    -- explicitly; if a future migration creates them, this assertion will
    -- have to be updated as part of that hygiene cycle).
    SELECT COUNT(*) INTO v_deferred_views_count
      FROM pg_views
     WHERE schemaname = 'public'
       AND viewname IN (
           'admin_consult_queue_health_v',
           'admin_mode1_volume_health_v'
       );

    IF v_deferred_views_count <> 0 THEN
        RAISE NOTICE
            'migration-041-deferred-view-unexpected: % deferred view(s) already exist. '
            'If a follow-on hygiene migration created them, update this verification block.',
            v_deferred_views_count;
    END IF;
END $$;
