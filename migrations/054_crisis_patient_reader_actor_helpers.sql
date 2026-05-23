-- =============================================================================
-- File:    migrations/054_crisis_patient_reader_actor_helpers.sql
-- Purpose: Grant EXECUTE on SI-010 actor helper functions to
--          crisis_event_patient_reader so the patient self-scoping view
--          (crisis_event_patient_summary_v) can call current_actor_account_id()
--          when security_invoker=true switches the active role to
--          crisis_event_patient_reader.
--
-- Root cause: migration 031 grants the SI-010 helpers only to
--   telecheck_app_role. When withDbRole() issues SET LOCAL ROLE
--   crisis_event_patient_reader, the view's security_invoker predicate
--   evaluates under that role and lacks EXECUTE on current_actor_account_id()
--   → permission_denied → every patient request 403s even with a valid token.
--   (Codex R1 #203 finding 1 closure.)
--
-- Context: the view crisis_event_patient_summary_v (migration 034, amended by
--   migration 053 SI-025 to use patient_account_id and drop the ::UUID cast)
--   uses current_actor_account_id() in its self-scoping WHERE predicate.
-- =============================================================================

GRANT EXECUTE ON FUNCTION current_actor_account_id()         TO crisis_event_patient_reader;
GRANT EXECUTE ON FUNCTION current_actor_account_tenant_id()  TO crisis_event_patient_reader;

COMMENT ON FUNCTION current_actor_account_id() IS
    'SI-010 trust-anchor bound actor account_id. EXECUTE granted to '
    'telecheck_app_role (migration 031) + crisis_event_patient_reader '
    '(migration 054, required for security_invoker patient summary view).';
