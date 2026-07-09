-- =============================================================================
-- File:    migrations/079_ai_provider_credential.sql
-- Purpose: SI-025 Admin-Managed AI Provider Credentials — Phase 1 (backend).
--          Creates the `ai_provider_credential` entity (KMS-enveloped API-key
--          store), its 3 net-new RBAC roles, the SECDEF read wrapper the AI
--          service uses to resolve the active credential at provider-
--          construction time, and all attendant grants + the app-role
--          acquisition bridge for the writer/reader roles.
--
--          Per SI-025 v0.1 (RATIFIER-DIRECTED, Evans 2026-07-09) — TWO forks
--          ratified:
--            1. Storage backend  = App DB, KMS-enveloped (ADR-024 8-field
--               envelope; I-026). Buildable now on staging (local-dev KMS
--               key); pre-go-live migration to AWS Secrets Manager travels
--               with the existing "KMS local-dev -> AWS KMS" hardening item.
--            2. Credential scope = PLATFORM-LEVEL (one provider key set,
--               platform_admin-managed, resolved for every tenant per
--               ADR-020 Anthropic-primary platform-default at v1.0).
--
--          Sub-decisions at the documented defaults (SI-025 §2):
--            - platform_admin-only mutations (single-actor; dual-control a
--              documented hardening option, not v1.0-required).
--            - Cat B governance audit on every mutation (handler layer).
--            - Masked reads only over HTTP; plaintext never returned.
--            - Env-fallback bootstrap (ANTHROPIC_API_KEY) until a DB
--              credential exists -- resolver logic, not schema.
--
-- ============================================================================
-- ** DELIBERATE, DOCUMENTED EXCEPTION -- PLATFORM-SCOPED, NON-TENANT-RLS **
-- ============================================================================
--          `ai_provider_credential` is a PLATFORM-SECURITY asset, NOT PHI and
--          NOT tenant-scoped. It therefore:
--            - carries NO `tenant_id` column,
--            - is NOT under the tenant-RLS regime (no ENABLE/FORCE ROW LEVEL
--              SECURITY, no tenant_isolation policy),
--          and is instead locked down ENTIRELY by role grants:
--            REVOKE ALL ... FROM PUBLIC, then GRANTs ONLY to the specific
--            owner / writer / reader roles below.
--
--          This is the ratified platform-level scope decision (SI-025 §3).
--          The table is added to the I-023 RLS-lockdown test's explicit
--          platform-scoped allow-list (PLATFORM_LEVEL_TABLES_EXCLUDED_FROM_RLS
--          in tests/contracts/rls-policy-coverage-lockdown.test.ts) so it is
--          an EXPLICITLY-EXPECTED non-RLS table, not a rogue one -- §2b of that
--          test would otherwise (correctly) refuse a surprise non-RLS table
--          bearing sensitive data. Because the table has NO RLS the §2a/§2b
--          RLS enumerations skip it automatically; the allow-list entry makes
--          the intent auditable + §3 asserts relrowsecurity=false on it.
--
--          Security posture rests on: (a) plaintext is KMS-enveloped at rest
--          (never stored raw), (b) the plaintext decrypt path is a SECDEF
--          function EXECUTE-granted ONLY to ai_service_credential_reader,
--          (c) masked-only HTTP reads, (d) platform_admin-only mutation
--          EXECUTE at the DB floor via the writer role, (e) REVOKE ALL FROM
--          PUBLIC on the table itself.
--
-- Spec references:
--   - SI-025 Admin-Managed AI Provider Credentials v0.1 (RATIFIER-DIRECTED
--     Evans 2026-07-09; sibling repo:
--     telecheckONE/Telecheck_v1_10_PRD_Update/
--       Telecheck_SI_025_Admin_Managed_AI_Provider_Credentials_v0_1.md) §3/§5
--   - ADR-020 (multi-provider LLM abstraction; Anthropic primary,
--     platform-default at v1.0)
--   - ADR-024 (per-tenant KMS envelope; I-026 8-field envelope shape reused
--     here over a PLATFORM secret rather than a per-tenant PHI record)
--   - migration 055 (role-creation pattern: NOLOGIN + NOBYPASSRLS)
--   - migration 059/065 (SECDEF wrapper owner + REVOKE/GRANT anti-bypass
--     pattern)
--   - migration 064 (app-role acquisition bridge: telecheck_app_role
--     NOINHERIT membership per the 051 §2 Option B pattern; SI-010 helper
--     EXECUTE grants)
--   - migration 071/074 (#variable_conflict use_column OUT-param lesson --
--     applied here to the RETURNS TABLE read wrapper)
--   - I-003 / I-027 (audit append-only + attribution; enforced at the
--     handler layer where the Cat B envelope is emitted)
--
-- Preconditions: 051 (telecheck_app_role foundation) + 055/064 conventions.
-- Rollback: rollback/079_rollback.sql.
-- =============================================================================

-- =============================================================================
-- §1 -- ai_provider_credential entity (PLATFORM-SCOPED; NO tenant_id; NO RLS)
-- =============================================================================

CREATE TABLE IF NOT EXISTS ai_provider_credential (
    id                            VARCHAR(26) PRIMARY KEY,  -- ULID
    provider                      TEXT NOT NULL
        CHECK (provider IN ('anthropic', 'aws_bedrock', 'azure_openai')),
    -- 8-field KMS envelope (I-026 / ADR-024) over the plaintext API key.
    -- Unlike the async-consult intake path (envelope arrives pre-encrypted
    -- from an internal boundary), here the admin PUTs PLAINTEXT and the
    -- handler envelope-encrypts SERVER-SIDE before INSERT.
    key_ciphertext                BYTEA NOT NULL,
    key_kms_envelope_dek_id       VARCHAR(26) NOT NULL,
    key_kms_envelope_iv           BYTEA NOT NULL,
    key_kms_envelope_tag          BYTEA NOT NULL,
    key_kms_envelope_alg          TEXT NOT NULL,
    key_kms_envelope_alg_version  TEXT NOT NULL,
    key_kms_envelope_aad          BYTEA NOT NULL,
    key_kms_envelope_encrypted_at TIMESTAMPTZ NOT NULL,
    -- Non-secret metadata for masked reads + rotation detection.
    key_last4                     TEXT NOT NULL,  -- display only (e.g. 'sk-...AB12')
    key_fingerprint               TEXT NOT NULL,  -- SHA-256(plaintext); rotation/dedup, non-reversible
    status                        TEXT NOT NULL
        CHECK (status IN ('active', 'revoked')),
    created_at                    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at                    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_by                    VARCHAR(26) NOT NULL  -- platform_admin account id
);

-- At most one ACTIVE credential per provider (rotation = revoke old + insert
-- new active, atomically in one tx at the handler layer). Enforced by a
-- PARTIAL UNIQUE INDEX rather than an EXCLUDE constraint: the spec (§3)
-- shows `EXCLUDE (provider WITH =)`, but an equality-only EXCLUDE on a TEXT
-- column needs a GiST opclass (btree_gist), which is NOT installed in this
-- codebase (000_extensions.sql loads uuid-ossp/pgcrypto/pg_trgm/btree_gin
-- only). A partial UNIQUE index gives the IDENTICAL guarantee (<=1 active row
-- per provider) on a plain btree with no new extension dependency — the
-- security-conservative choice. Named to match the spec's constraint name so
-- the intent is greppable. [DEVIATION-FOR-CODEX: EXCLUDE -> partial UNIQUE
-- index; same invariant, avoids a btree_gist dependency.]
CREATE UNIQUE INDEX IF NOT EXISTS ai_provider_credential_one_active_per_provider
    ON ai_provider_credential (provider)
    WHERE status = 'active';

COMMENT ON TABLE ai_provider_credential IS
    'SI-025 platform-scoped AI provider API-key store (KMS-enveloped; I-026). '
    'DELIBERATE non-tenant-RLS exception -- locked down by role grants only '
    '(REVOKE ALL FROM PUBLIC + owner/writer/reader grants). Allow-listed in '
    'the I-023 RLS-lockdown test as an explicit platform-scoped table. '
    'Plaintext is never stored (ciphertext only), never returned by any HTTP '
    'surface (masked reads), and only ever transiently decrypted in-process '
    'via read_active_ai_provider_key() by the AI service.';

-- (The partial UNIQUE index ai_provider_credential_one_active_per_provider
--  above also serves the SECDEF read wrapper's active-credential lookup, so
--  no separate lookup index is needed.)

-- LOCKDOWN -- the table has NO RLS by design; the security boundary is the
-- role-grant matrix. Start from deny-all, then grant precisely.
REVOKE ALL ON ai_provider_credential FROM PUBLIC;

-- =============================================================================
-- §2 -- RBAC roles (3 net-new; NOLOGIN + NOBYPASSRLS per the 055 pattern)
-- =============================================================================

-- §2.1 Table-owner / SECDEF-owner role. Owns the table + the read wrapper so
-- SECDEF executes as this role. NOT a login identity; NOT granted to humans.
DO $$
BEGIN
    IF to_regrole('ai_provider_credential_owner') IS NULL THEN
        CREATE ROLE ai_provider_credential_owner NOLOGIN NOBYPASSRLS;
    END IF;
END $$;
COMMENT ON ROLE ai_provider_credential_owner IS
    'SI-025 owner role: owns ai_provider_credential + read_active_ai_provider_key() '
    '(SECDEF owner). NOLOGIN + NOBYPASSRLS per the 055 canonical pattern. '
    'Never logged into; exists solely to scope table ownership + SECDEF identity.';

-- §2.2 Writer role -- the admin handlers elevate to this via withDbRole to
-- perform INSERT/UPDATE (set / rotate / revoke). Bridged to telecheck_app_role.
DO $$
BEGIN
    IF to_regrole('ai_provider_credential_writer') IS NULL THEN
        CREATE ROLE ai_provider_credential_writer NOLOGIN NOBYPASSRLS;
    END IF;
END $$;
COMMENT ON ROLE ai_provider_credential_writer IS
    'SI-025 writer application role: INSERT/UPDATE on ai_provider_credential via '
    'the /v1/admin/ai-providers PUT + DELETE handlers under a withDbRole '
    'elevation. LAYER B (platform_admin-only) is enforced in the handler BEFORE '
    'elevation; the DB EXECUTE/DML floor is this role. Bridged into '
    'telecheck_app_role (NOINHERIT membership) per the 051 §2 Option B pattern.';

-- §2.3 Reader role -- the SOLE grantee of EXECUTE on the SECDEF read wrapper
-- (the plaintext-decrypt path). Bridged to telecheck_app_role so the AI
-- service resolver can elevate to it at provider-construction time.
DO $$
BEGIN
    IF to_regrole('ai_service_credential_reader') IS NULL THEN
        CREATE ROLE ai_service_credential_reader NOLOGIN NOBYPASSRLS;
    END IF;
END $$;
COMMENT ON ROLE ai_service_credential_reader IS
    'SI-025 reader application role: SOLE grantee of EXECUTE on '
    'read_active_ai_provider_key() -- the plaintext-envelope decrypt path used '
    'by the AI service at provider-construction time. Granted NO direct table '
    'privileges (reads flow ONLY through the SECDEF wrapper). Bridged into '
    'telecheck_app_role (NOINHERIT membership) per the 051 §2 Option B pattern.';

-- =============================================================================
-- §3 -- Table ownership + DML grants
-- =============================================================================

ALTER TABLE ai_provider_credential OWNER TO ai_provider_credential_owner;

-- The writer role gets INSERT/UPDATE. NO DELETE -- revocation is an UPDATE to
-- status='revoked' (audit trail is the durable history; rows are retained).
-- Column-level SELECT keeps the ciphertext/envelope columns unreadable to the
-- writer role entirely -- it may read ONLY the non-secret masked-view columns.
GRANT INSERT, UPDATE ON ai_provider_credential TO ai_provider_credential_writer;
GRANT SELECT (id, provider, key_last4, key_fingerprint, status,
              created_at, updated_at, updated_by)
    ON ai_provider_credential TO ai_provider_credential_writer;

-- The reader role gets NO direct table privilege -- it reads ONLY via the
-- SECDEF wrapper (which runs as the owner). This is the anti-bypass posture:
-- the plaintext-bearing envelope columns are reachable exclusively through
-- read_active_ai_provider_key().

-- =============================================================================
-- §4 -- SECDEF read wrapper: read_active_ai_provider_key(p_provider TEXT)
--       Returns the 8-field KMS envelope for the ACTIVE credential of a
--       provider (or no rows if none). EXECUTE only to ai_service_credential_reader.
--
--       #variable_conflict use_column -- the RETURNS TABLE OUT params share
--       names with ai_provider_credential columns; unqualified references in
--       the embedded SELECT would raise 42702 (ambiguous_column) under the
--       default `error` pragma (migration 071/074 lesson). The pragma resolves
--       unqualified collisions to the COLUMN, which is the intended meaning;
--       we ALSO alias-qualify explicitly for reader clarity (belt + braces).
-- =============================================================================

CREATE OR REPLACE FUNCTION read_active_ai_provider_key(
    p_provider TEXT
)
RETURNS TABLE (
    key_ciphertext                BYTEA,
    key_kms_envelope_dek_id       VARCHAR(26),
    key_kms_envelope_iv           BYTEA,
    key_kms_envelope_tag          BYTEA,
    key_kms_envelope_alg          TEXT,
    key_kms_envelope_alg_version  TEXT,
    key_kms_envelope_aad          BYTEA,
    key_kms_envelope_encrypted_at TIMESTAMPTZ,
    key_last4                     TEXT,
    key_fingerprint               TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
#variable_conflict use_column
BEGIN
    -- Validate the provider argument fail-closed (defense in depth; the
    -- table CHECK also enforces the enum at write time). An unrecognized
    -- provider returns no rows (same as no active credential) rather than
    -- surfacing a distinguishable error.
    IF p_provider IS NULL OR p_provider NOT IN ('anthropic', 'aws_bedrock', 'azure_openai') THEN
        RETURN;  -- empty result set
    END IF;

    RETURN QUERY
        SELECT c.key_ciphertext,
               c.key_kms_envelope_dek_id,
               c.key_kms_envelope_iv,
               c.key_kms_envelope_tag,
               c.key_kms_envelope_alg,
               c.key_kms_envelope_alg_version,
               c.key_kms_envelope_aad,
               c.key_kms_envelope_encrypted_at,
               c.key_last4,
               c.key_fingerprint
          FROM ai_provider_credential c
         WHERE c.provider = p_provider
           AND c.status = 'active'
         LIMIT 1;  -- one-active-per-provider EXCLUDE guarantees <=1
END;
$$;

ALTER FUNCTION read_active_ai_provider_key(TEXT)
    OWNER TO ai_provider_credential_owner;

-- LAYER A anti-bypass: ONLY ai_service_credential_reader may EXECUTE the
-- plaintext-envelope read path.
REVOKE EXECUTE ON FUNCTION read_active_ai_provider_key(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION read_active_ai_provider_key(TEXT)
    TO ai_service_credential_reader;

COMMENT ON FUNCTION read_active_ai_provider_key(TEXT) IS
    'SI-025 §5 SECDEF read wrapper: returns the KMS envelope for the ACTIVE '
    'credential of p_provider (<=1 row per the one-active-per-provider EXCLUDE). '
    'SOLE path to the ciphertext-bearing columns. EXECUTE ONLY to '
    'ai_service_credential_reader. Platform-scoped (no tenant LAYER C guard -- '
    'the credential is a platform asset resolved for every tenant per ADR-020). '
    '#variable_conflict use_column applied per the 071/074 OUT-param lesson.';

-- =============================================================================
-- §5 -- App-role acquisition bridge (051 §2 / 064 §4 Option B pattern)
--      telecheck_app_role gains NOINHERIT membership in the writer + reader
--      roles so the application can `SET LOCAL ROLE` into them (via withDbRole)
--      after LAYER B authorization. NO passive privilege (NOINHERIT).
-- =============================================================================

DO $$
DECLARE
    v_pg_major INTEGER := current_setting('server_version_num')::INTEGER / 10000;
BEGIN
    IF to_regrole('telecheck_app_role') IS NULL THEN
        RAISE EXCEPTION 'migration-079-precondition-failed: telecheck_app_role '
            'does not exist; apply migration 051 before 079.';
    END IF;

    IF v_pg_major >= 16 THEN
        -- PG 16+: explicit per-membership INHERIT FALSE + SET TRUE (051 R2
        -- HIGH-1 closure carryforward; idempotent -- normalizes pre-existing
        -- membership too).
        EXECUTE 'GRANT ai_provider_credential_writer TO telecheck_app_role WITH INHERIT FALSE, SET TRUE';
        EXECUTE 'GRANT ai_service_credential_reader TO telecheck_app_role WITH INHERIT FALSE, SET TRUE';
    ELSE
        -- PG 15: plain GRANT; role-level NOINHERIT on telecheck_app_role
        -- provides the no-inherit posture. Guard against duplicate grant.
        IF NOT EXISTS (
            SELECT 1 FROM pg_auth_members m
              JOIN pg_roles r ON r.oid = m.roleid
              JOIN pg_roles mem ON mem.oid = m.member
             WHERE r.rolname = 'ai_provider_credential_writer'
               AND mem.rolname = 'telecheck_app_role'
        ) THEN
            EXECUTE 'GRANT ai_provider_credential_writer TO telecheck_app_role';
        END IF;
        IF NOT EXISTS (
            SELECT 1 FROM pg_auth_members m
              JOIN pg_roles r ON r.oid = m.roleid
              JOIN pg_roles mem ON mem.oid = m.member
             WHERE r.rolname = 'ai_service_credential_reader'
               AND mem.rolname = 'telecheck_app_role'
        ) THEN
            EXECUTE 'GRANT ai_service_credential_reader TO telecheck_app_role';
        END IF;
    END IF;
    RAISE NOTICE 'migration-079: telecheck_app_role bridged into writer + reader roles';
END $$;

-- =============================================================================
-- Verification -- fail loudly on partial apply / missing objects / grant skew.
-- =============================================================================

DO $$
DECLARE
    v_read_fn_oid OID;
BEGIN
    -- §1 table exists + is NON-RLS (the deliberate exception).
    IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = 'ai_provider_credential' AND relkind = 'r') THEN
        RAISE EXCEPTION 'migration-079-verification-failed: ai_provider_credential table missing';
    END IF;
    IF (SELECT relrowsecurity FROM pg_class WHERE relname = 'ai_provider_credential') THEN
        RAISE EXCEPTION 'migration-079-verification-failed: ai_provider_credential has RLS enabled -- '
            'this table is a DELIBERATE platform-scoped non-RLS exception (SI-025 §3); RLS must be OFF';
    END IF;

    -- §1 partial UNIQUE index present (one-active-per-provider guarantee).
    IF NOT EXISTS (
        SELECT 1 FROM pg_class
         WHERE relname = 'ai_provider_credential_one_active_per_provider'
           AND relkind = 'i'
    ) THEN
        RAISE EXCEPTION 'migration-079-verification-failed: one-active-per-provider partial unique index missing';
    END IF;

    -- §2 the 3 roles exist.
    IF to_regrole('ai_provider_credential_owner') IS NULL
       OR to_regrole('ai_provider_credential_writer') IS NULL
       OR to_regrole('ai_service_credential_reader') IS NULL THEN
        RAISE EXCEPTION 'migration-079-verification-failed: one or more SI-025 roles not created';
    END IF;

    -- §3 owner owns the table.
    IF (SELECT pg_get_userbyid(relowner) FROM pg_class WHERE relname = 'ai_provider_credential')
       <> 'ai_provider_credential_owner' THEN
        RAISE EXCEPTION 'migration-079-verification-failed: ai_provider_credential not owned by ai_provider_credential_owner';
    END IF;

    -- §4 read wrapper exists + is SECDEF + reader holds EXECUTE + PUBLIC does not.
    SELECT oid INTO v_read_fn_oid FROM pg_proc
     WHERE proname = 'read_active_ai_provider_key' AND pronamespace = 'public'::regnamespace;
    IF v_read_fn_oid IS NULL THEN
        RAISE EXCEPTION 'migration-079-verification-failed: read_active_ai_provider_key missing';
    END IF;
    IF NOT (SELECT prosecdef FROM pg_proc WHERE oid = v_read_fn_oid) THEN
        RAISE EXCEPTION 'migration-079-verification-failed: read_active_ai_provider_key not SECURITY DEFINER';
    END IF;
    IF NOT has_function_privilege('ai_service_credential_reader', v_read_fn_oid, 'EXECUTE') THEN
        RAISE EXCEPTION 'migration-079-verification-failed: ai_service_credential_reader lacks read-wrapper EXECUTE';
    END IF;
    IF has_function_privilege('public', v_read_fn_oid, 'EXECUTE') THEN
        RAISE EXCEPTION 'migration-079-verification-failed: PUBLIC retains read-wrapper EXECUTE (anti-bypass breached)';
    END IF;

    -- §5 bridge memberships present.
    IF NOT EXISTS (
        SELECT 1 FROM pg_auth_members m
          JOIN pg_roles r ON r.oid = m.roleid
          JOIN pg_roles mem ON mem.oid = m.member
         WHERE r.rolname = 'ai_provider_credential_writer' AND mem.rolname = 'telecheck_app_role'
    ) THEN
        RAISE EXCEPTION 'migration-079-verification-failed: telecheck_app_role lacks writer membership';
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_auth_members m
          JOIN pg_roles r ON r.oid = m.roleid
          JOIN pg_roles mem ON mem.oid = m.member
         WHERE r.rolname = 'ai_service_credential_reader' AND mem.rolname = 'telecheck_app_role'
    ) THEN
        RAISE EXCEPTION 'migration-079-verification-failed: telecheck_app_role lacks reader membership';
    END IF;

    RAISE NOTICE 'migration-079: verification passed (ai_provider_credential platform-scoped store wired end-to-end)';
END $$;
