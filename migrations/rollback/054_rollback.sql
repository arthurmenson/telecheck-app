-- Rollback migration 054: revoke actor helper grants from patient_reader.
REVOKE EXECUTE ON FUNCTION current_actor_account_id()        FROM crisis_event_patient_reader;
REVOKE EXECUTE ON FUNCTION current_actor_account_tenant_id() FROM crisis_event_patient_reader;
