-- =============================================================================
-- rollback/064_rollback.sql — unwind 064_ai_service_actor_and_ai_prep_wiring
--
-- Reverses, in dependency order:
--   §4 bridge membership + helper EXECUTE grants
--   §3 wrapper EXECUTE grant
--   §2 ai_service_account role
--   §1 actor-role enum widening (table CHECK + bind_actor_context body
--      restored to the migration 031 five-value enum)
--
-- Precondition for the §1 CHECK restore: no live `_session_actor_context`
-- row carries actor_role='ai_service' (rows expire within minutes by
-- design; the sweep below clears any stragglers before re-adding the
-- narrow CHECK).
-- =============================================================================

-- §4 unwind
REVOKE EXECUTE ON FUNCTION _current_actor_context_row() FROM ai_service_account;
REVOKE EXECUTE ON FUNCTION current_actor_account_id() FROM ai_service_account;
REVOKE EXECUTE ON FUNCTION current_actor_account_tenant_id() FROM ai_service_account;
REVOKE EXECUTE ON FUNCTION current_actor_role() FROM ai_service_account;
REVOKE EXECUTE ON FUNCTION current_actor_admin_home_tenant_id() FROM ai_service_account;
REVOKE ai_service_account FROM telecheck_app_role;

-- §3 unwind (restores the 059 §3 owner-only posture)
REVOKE EXECUTE ON FUNCTION record_consult_ai_preparation_completed(
    VARCHAR(26), TEXT, VARCHAR(26), VARCHAR(26), TEXT, TEXT, TEXT, BYTEA, VARCHAR(26), BYTEA, BYTEA, TEXT, TEXT, BYTEA, TIMESTAMPTZ, JSONB, TEXT, VARCHAR(26), VARCHAR(26), VARCHAR(26), TEXT
) FROM ai_service_account;

-- §2 unwind
DROP ROLE IF EXISTS ai_service_account;

-- §1 unwind — clear any live ai_service context rows, then restore the
-- five-value CHECK + the 031 bind_actor_context validation.
DELETE FROM _session_actor_context WHERE actor_role = 'ai_service';

ALTER TABLE _session_actor_context
    DROP CONSTRAINT IF EXISTS _session_actor_context_actor_role_check;
ALTER TABLE _session_actor_context
    ADD CONSTRAINT _session_actor_context_actor_role_check
    CHECK (actor_role IN (
        'patient', 'clinician', 'tenant_admin', 'platform_admin', 'delegate'
    ));

-- Restore the migration 031 bind_actor_context body verbatim (five-value
-- role validation).
CREATE OR REPLACE FUNCTION bind_actor_context(
    p_actor_account_id            TEXT,
    p_actor_account_tenant_id     TEXT,
    p_actor_role                  TEXT,
    p_actor_admin_home_tenant_id  TEXT,
    p_session_id                  TEXT,
    p_nonce                       UUID,
    p_ttl_seconds                 INTEGER DEFAULT 300
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
    IF session_user = 'telecheck_app_role' THEN
        RAISE EXCEPTION 'bind_actor_context: forbidden session_user %', session_user
            USING HINT = 'bind_actor_context must be invoked from a dedicated authContextPlugin pool whose session_user is NOT the application primary role. Configure the auth pool to log in as bind_actor_context_role directly.';
    END IF;

    DELETE FROM _session_actor_context
     WHERE nonce IN (
         SELECT nonce
           FROM _session_actor_context
          WHERE expires_at < NOW()
          LIMIT 100
     );

    IF p_actor_account_id IS NULL OR p_actor_account_id = '' THEN
        RAISE EXCEPTION 'bind_actor_context: actor_account_id required';
    END IF;
    IF p_actor_account_tenant_id IS NULL OR p_actor_account_tenant_id = '' THEN
        RAISE EXCEPTION 'bind_actor_context: actor_account_tenant_id required';
    END IF;
    IF p_actor_role IS NULL OR p_actor_role NOT IN (
        'patient', 'clinician', 'tenant_admin', 'platform_admin', 'delegate'
    ) THEN
        RAISE EXCEPTION 'bind_actor_context: invalid actor_role %', p_actor_role;
    END IF;
    IF p_actor_admin_home_tenant_id = '' THEN
        p_actor_admin_home_tenant_id := NULL;
    END IF;
    IF p_session_id IS NULL OR p_session_id = '' THEN
        RAISE EXCEPTION 'bind_actor_context: session_id required';
    END IF;
    IF p_nonce IS NULL THEN
        RAISE EXCEPTION 'bind_actor_context: nonce required';
    END IF;
    IF p_ttl_seconds IS NULL OR p_ttl_seconds <= 0 THEN
        RAISE EXCEPTION 'bind_actor_context: ttl_seconds must be positive';
    END IF;

    INSERT INTO _session_actor_context AS s
      (nonce, actor_account_id, actor_account_tenant_id,
       actor_role, actor_admin_home_tenant_id, session_id, expires_at)
    VALUES
      (p_nonce, p_actor_account_id,
       p_actor_account_tenant_id, p_actor_role, p_actor_admin_home_tenant_id,
       p_session_id, NOW() + (p_ttl_seconds * INTERVAL '1 second'))
    ON CONFLICT (nonce) DO UPDATE
      SET expires_at = EXCLUDED.expires_at,
          bound_at = NOW()
      WHERE s.actor_account_id            IS NOT DISTINCT FROM EXCLUDED.actor_account_id
        AND s.actor_account_tenant_id     IS NOT DISTINCT FROM EXCLUDED.actor_account_tenant_id
        AND s.actor_role                  IS NOT DISTINCT FROM EXCLUDED.actor_role
        AND s.actor_admin_home_tenant_id  IS NOT DISTINCT FROM EXCLUDED.actor_admin_home_tenant_id
        AND s.session_id                  IS NOT DISTINCT FROM EXCLUDED.session_id;

    PERFORM 1
      FROM _session_actor_context s
     WHERE s.nonce                        = p_nonce
       AND s.actor_account_id             = p_actor_account_id
       AND s.actor_account_tenant_id      = p_actor_account_tenant_id
       AND s.actor_role                   = p_actor_role
       AND s.actor_admin_home_tenant_id  IS NOT DISTINCT FROM p_actor_admin_home_tenant_id
       AND s.session_id                   = p_session_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'bind_actor_context: nonce_collision_with_different_identity'
            USING HINT = 'A row with the same nonce already exists but with different actor identity. Re-binding the same nonce to a different actor is forbidden; generate a fresh UUID for each request.';
    END IF;
END;
$$;

REVOKE ALL ON FUNCTION bind_actor_context(TEXT, TEXT, TEXT, TEXT, TEXT, UUID, INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION bind_actor_context(TEXT, TEXT, TEXT, TEXT, TEXT, UUID, INTEGER) TO bind_actor_context_role;
