-- =============================================================================
-- File:    migrations/005_idempotency_keys.sql
-- Purpose: Create the `idempotency_keys` table for tenant-scoped idempotency
--          per IDEMPOTENCY v5.1. Ensures that repeated identical API requests
--          return the same response without re-processing. Survives server
--          restarts (stored in the primary DB, not a volatile cache).
-- Spec:    - IDEMPOTENCY v5.1 (idempotency key contract, composite key scope,
--            TTL rules, crash semantics, storage requirement)
--          - I-023 (tenant isolation on every PHI-touching table)
--          - ADR-023 (multi-tenancy Model A — same key in different tenants
--            is independent per IDEMPOTENCY v5.1 §1)
--          - CDM v1.2 conventions (tenant_id FK, RLS)
-- Summary: PRIMARY KEY is (tenant_id, key, endpoint, actor_id) — same key
--          string in different tenants, OR for the same tenant on different
--          endpoints, OR submitted by a different actor, produces independent
--          records per IDEMPOTENCY v5.1 §1 scoping rules. Only a same-tenant +
--          same-key + same-endpoint + same-actor + different-body collision
--          is a 409 Conflict. (PK widened from (tenant_id, key) v0.1 patch
--          2026-05-02 per Codex foundation-layer review HIGH-2 finding.)
--          TTL is enforced by a background cleanup job (commented below).
--          RLS enabled with tenant_isolation policy.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- PRECONDITION: 001_tenants.sql applied.
-- PRECONDITION: 003_rls_helpers.sql applied (current_tenant_id() function).
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS idempotency_keys (
    -- -------------------------------------------------------------------------
    -- Primary key — composite (tenant_id, key) per IDEMPOTENCY v5.1:
    -- "Same idempotency key in different tenants produces independent results."
    -- This means (tenant_id='Telecheck-US', key='01HZ...') and
    -- (tenant_id='Telecheck-Ghana', key='01HZ...') are two distinct records.
    -- -------------------------------------------------------------------------

    tenant_id           TEXT        NOT NULL
                            REFERENCES tenants(id),

    -- Client-generated ULID string (per IDEMPOTENCY v5.1 key format).
    -- Max length 26 for ULID; TEXT used to accommodate future format changes.
    key                 TEXT        NOT NULL,

    -- -------------------------------------------------------------------------
    -- Request fingerprint
    -- -------------------------------------------------------------------------

    -- SHA-256 hash of the canonical request body. Used to detect body-mismatch
    -- (same key, different body → 409 Conflict per IDEMPOTENCY v5.1 §1).
    -- Stored as BYTEA (32 bytes for SHA-256) rather than hex TEXT for
    -- compactness and direct binary comparison.
    request_hash        BYTEA       NOT NULL,

    -- -------------------------------------------------------------------------
    -- Stored response
    -- -------------------------------------------------------------------------

    -- HTTP status code of the stored response.
    response_status     INTEGER     NOT NULL,

    -- Response body (may be NULL for responses with empty bodies, e.g., 204).
    response_body       JSONB       NULL,

    -- -------------------------------------------------------------------------
    -- Request scope (for body-mismatch detection per IDEMPOTENCY v5.1 §1)
    -- -------------------------------------------------------------------------

    -- The endpoint path this key was first used against. Keys are scoped per
    -- endpoint — the same key used against different endpoints does not conflict.
    endpoint            TEXT        NOT NULL,

    -- The actor who submitted the original request. Keys are scoped per actor —
    -- the same key from a different actor does not conflict (IDEMPOTENCY v5.1 §1).
    actor_id            TEXT        NOT NULL,

    -- -------------------------------------------------------------------------
    -- Processing state (for crash semantics per IDEMPOTENCY v5.1 crash-semantics)
    -- -------------------------------------------------------------------------

    -- 'pending'   = key was stored but business logic has not completed
    --               (crash scenario 2 — retry triggers rollback and re-process)
    -- 'completed' = key and business result both persisted successfully
    processing_state    TEXT        NOT NULL DEFAULT 'pending'
                            CHECK (processing_state IN ('pending', 'completed')),

    -- -------------------------------------------------------------------------
    -- Timestamps and TTL
    -- -------------------------------------------------------------------------

    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- TTL per IDEMPOTENCY v5.1 §1: "Key TTL: 24 hours."
    -- The cleanup job (see comment below) deletes rows where expires_at < NOW().
    -- 24-hour window is sufficient for all retry scenarios including overnight
    -- offline queuing per IDEMPOTENCY v5.1.
    expires_at          TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '24 hours'),

    -- -------------------------------------------------------------------------
    -- Primary key (4-tuple per IDEMPOTENCY v5.1 §1 scoping rules)
    -- (changed v0.1 patch 2026-05-02 per Codex foundation-layer review HIGH-2
    --  finding: prior PK was (tenant_id, key) which collapsed legitimate
    --  endpoint-distinct and actor-distinct retries into false 409 conflicts.
    --  Same key reused on a different endpoint or by a different actor MUST
    --  be an independent record per IDEMPOTENCY v5.1 §1; only a same-tenant +
    --  same-key + same-endpoint + same-actor + different-body collision is
    --  a 409 Conflict.)
    -- -------------------------------------------------------------------------
    PRIMARY KEY (tenant_id, key, endpoint, actor_id)
);

-- ---------------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------------

-- Cleanup job scan: a plain btree index on expires_at supports the cleanup
-- query (DELETE FROM idempotency_keys WHERE expires_at < NOW();) via index
-- range scan. The cleanup job itself is NOT implemented here; it belongs in
-- the application-layer background worker (or a pg_cron job in production).
--
-- (changed v0.1 patch 2026-05-02 per Codex foundation-layer review HIGH-1
--  finding: the prior partial-index predicate `WHERE expires_at < NOW() +
--  INTERVAL '0'` was rejected by PostgreSQL because NOW() is volatile —
--  index predicates MUST be IMMUTABLE. The migration would fail at apply
--  time, blocking the entire foundation schema. A plain btree on expires_at
--  is sufficient: the cleanup query plan is identical for the typical case
--  where the great majority of rows are unexpired, and the index is also
--  reused by any future expiry-aware lookup.)
CREATE INDEX IF NOT EXISTS idx_idempotency_expires_at
    ON idempotency_keys (expires_at);

-- -------------------------------------------------------------------------
-- Row-Level Security (I-023)
-- idempotency_keys is tenant-scoped. The key + response body may contain
-- enough context to identify patient actions. RLS prevents cross-tenant
-- idempotency record leakage.
-- -------------------------------------------------------------------------

ALTER TABLE idempotency_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE idempotency_keys FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON idempotency_keys
    USING     (tenant_id = current_tenant_id())
    WITH CHECK (tenant_id = current_tenant_id());

-- ---------------------------------------------------------------------------
-- Cleanup job comment (NOT implemented as a DB object):
-- A background worker (application layer or pg_cron) should run periodically:
--
--   -- Set context to platform scope for cross-tenant cleanup;
--   -- or run as the DB owner bypassing RLS (maintenance role).
--   DELETE FROM idempotency_keys
--   WHERE expires_at < NOW();
--
-- This job should run hourly. The 24-hour TTL means a 1-hour cleanup cadence
-- leaves at most 1 hour of expired rows in the table. The partial index
-- idx_idempotency_expired supports this scan efficiently.
-- ---------------------------------------------------------------------------
