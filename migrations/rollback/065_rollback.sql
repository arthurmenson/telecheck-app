-- =============================================================================
-- rollback/065_rollback.sql — unwind 065_admin_consult_queue_health_unlock
--
-- Restores the migration 041 §2 / 044 §3 deferred state: no view, no
-- wrapper, wrapper-owner privileges back to the pre-unlock posture. The
-- Fastify handler needs no change — its 42883 → 503 mapping resumes
-- (fail-closed by design).
-- =============================================================================

-- §2 unwind — wrapper + its grants.
DROP FUNCTION IF EXISTS read_admin_consult_queue_health(TEXT, JSONB);
REVOKE INSERT ON admin_dashboard_query_execution
    FROM read_admin_consult_queue_health_wrapper_owner;
REVOKE USAGE ON SEQUENCE admin_dashboard_query_execution_id_seq
    FROM read_admin_consult_queue_health_wrapper_owner;
REVOKE EXECUTE ON FUNCTION current_actor_account_id()
    FROM read_admin_consult_queue_health_wrapper_owner;
REVOKE EXECUTE ON FUNCTION current_actor_account_tenant_id()
    FROM read_admin_consult_queue_health_wrapper_owner;

-- §1 unwind — view + base-table grants.
DROP VIEW IF EXISTS admin_consult_queue_health_v;
REVOKE SELECT ON consult
    FROM read_admin_consult_queue_health_wrapper_owner;
REVOKE SELECT ON consult_lifecycle_transition
    FROM read_admin_consult_queue_health_wrapper_owner;
REVOKE SELECT ON consult_review_claim
    FROM read_admin_consult_queue_health_wrapper_owner;
REVOKE SELECT ON audit_records
    FROM read_admin_consult_queue_health_wrapper_owner;
