-- =============================================================================
-- File:    migrations/004_domain_events_outbox.sql
-- Purpose: Create the `domain_events_outbox` table implementing the transactional
--          outbox pattern for reliable domain event publication per DOMAIN_EVENTS
--          v5.2. Events written here are published to the event bus by the
--          outbox relay process, ensuring at-least-once delivery without
--          distributed transaction requirements.
-- Spec:    - DOMAIN_EVENTS v5.2 (event envelope, tenant-scope rules,
--            partition_key convention: composite 'tenant_id:aggregate_id')
--          - I-016 (domain events are immutable once emitted)
--          - I-023 (tenant isolation on every PHI-touching table)
--          - I-028 (single DB, single schema; logical isolation only)
--          - ADR-023 (multi-tenancy Model A)
--          - CDM v1.2 conventions (tenant_id on every entity, RLS)
-- Summary: Creates domain_events_outbox with the DOMAIN_EVENTS v5.2 envelope
--          fields. RLS enabled with tenant_isolation policy (this table IS
--          tenant-scoped — it holds event payloads that contain PHI-adjacent
--          aggregate context). Outbox relay reads unpublished events via
--          partial index on (published_at) WHERE published_at IS NULL.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- PRECONDITION: 001_tenants.sql applied.
-- PRECONDITION: 003_rls_helpers.sql applied (current_tenant_id() function).
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS domain_events_outbox (
    -- -------------------------------------------------------------------------
    -- Identity
    -- -------------------------------------------------------------------------

    -- UUID primary key per DOMAIN_EVENTS v5.2 (event_id is a ULID in the
    -- domain event envelope; stored as UUID here for DB efficiency. The relay
    -- converts to ULID string representation when publishing to the event bus).
    -- SPEC ISSUE: DOMAIN_EVENTS v5.2 specifies event_id as a ULID string. The
    -- outbox stores UUID for index efficiency. The relay must format event_id
    -- as ULID in the published envelope. Engineering Lead should confirm this
    -- mapping is acceptable or if the column should be TEXT(26) ULID.
    event_id            UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),

    -- -------------------------------------------------------------------------
    -- Tenant scope (I-023, I-027)
    -- -------------------------------------------------------------------------

    tenant_id           TEXT        NOT NULL
                            REFERENCES tenants(id),

    -- -------------------------------------------------------------------------
    -- Aggregate identity
    -- -------------------------------------------------------------------------

    -- Canonical aggregate name per DOMAIN_EVENTS v5.2 Glossary
    -- (e.g., 'medication_request', 'refill', 'patient', 'research_export').
    aggregate_type      TEXT        NOT NULL,

    -- Aggregate instance ID (ULID string, matches the aggregate's PK format).
    aggregate_id        TEXT        NOT NULL,

    -- -------------------------------------------------------------------------
    -- Event descriptor
    -- -------------------------------------------------------------------------

    -- Event type in `<aggregate>.<action>.<version>` format per DOMAIN_EVENTS v5.2.
    -- Examples: 'refill.initiated.v1', 'research_export.delivered.v1',
    --           'medication_request.approved.v1'
    event_type          TEXT        NOT NULL,

    -- -------------------------------------------------------------------------
    -- Partition key (DOMAIN_EVENTS v5.2 tenant-scope rules)
    -- -------------------------------------------------------------------------

    -- Composite partition key: 'tenant_id:aggregate_id' per DOMAIN_EVENTS v5.2
    -- tenant-scope rule. "partition_key for tenant-scoped aggregates is composite
    -- (tenant_id:aggregate_id) at the streaming layer to ensure single-tenant
    -- ordering and prevent accidental cross-tenant fan-out."
    -- Set by application layer at INSERT time (not a generated column, since
    -- PostgreSQL generated columns cannot reference other columns in expressions
    -- involving concatenation across nullable TEXT without explicit cast).
    -- Application code: partition_key = `${tenant_id}:${aggregate_id}`
    partition_key       TEXT        NOT NULL,

    -- -------------------------------------------------------------------------
    -- Payload
    -- -------------------------------------------------------------------------

    -- Full DOMAIN_EVENTS v5.2 event envelope stored as JSONB. The envelope
    -- includes: event_id, event_type, aggregate_type, aggregate_id, tenant_id,
    -- partition_key, timestamp, actor, delegate_context, payload, metadata
    -- (correlation_id, causation_id, audit_id, schema_version).
    payload             JSONB       NOT NULL,

    -- -------------------------------------------------------------------------
    -- Relay control columns
    -- -------------------------------------------------------------------------

    -- Timestamp when the outbox relay successfully published this event to the
    -- event bus. NULL = not yet published (used by the partial-index scan).
    published_at        TIMESTAMPTZ NULL,

    -- Number of publish attempts (for retry tracking and dead-letter detection).
    -- Relay increments this on each attempt. Events with attempt_count above
    -- a threshold (e.g., 5) are moved to a dead-letter queue by the relay.
    attempt_count       INTEGER     NOT NULL DEFAULT 0,

    -- -------------------------------------------------------------------------
    -- Timestamps
    -- -------------------------------------------------------------------------

    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ---------------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------------

-- Outbox relay scan — the critical query: find all unpublished events.
-- Partial index keeps this index small and fast (only unpublished rows).
CREATE INDEX IF NOT EXISTS idx_outbox_unpublished
    ON domain_events_outbox (created_at)
    WHERE published_at IS NULL;

-- Tenant + aggregate time-range queries (for debugging, replay, projection builds).
CREATE INDEX IF NOT EXISTS idx_outbox_tenant_aggregate
    ON domain_events_outbox (tenant_id, aggregate_id, created_at);

-- Partition key index for ordered delivery within a partition.
CREATE INDEX IF NOT EXISTS idx_outbox_partition_key
    ON domain_events_outbox (partition_key, created_at)
    WHERE published_at IS NULL;

-- ---------------------------------------------------------------------------
-- Row-Level Security (I-023)
-- The outbox table is tenant-scoped: aggregate payloads contain PHI-adjacent
-- data (aggregate IDs, actor IDs, patient IDs). RLS prevents one tenant's
-- relay worker from reading another tenant's unpublished events.
-- ---------------------------------------------------------------------------

ALTER TABLE domain_events_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE domain_events_outbox FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON domain_events_outbox
    USING     (tenant_id = current_tenant_id())
    WITH CHECK (tenant_id = current_tenant_id());

-- ---------------------------------------------------------------------------
-- Immutability note (I-016)
-- Domain events are immutable once emitted. The outbox pattern provides
-- at-least-once delivery; idempotent consumers handle duplicates. The
-- published_at column is the only mutable field (set by the relay on
-- successful publish). The payload itself is never updated.
-- The relay UPDATES published_at — this is the single permitted mutation.
-- No other columns may be updated; no rows may be deleted until archival.
-- This is enforced at the application/relay layer, not with a DB trigger,
-- because the relay legitimately needs to set published_at.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- Cleanup comment (not implemented — background job responsibility):
-- A nightly cleanup job archives rows where published_at IS NOT NULL AND
-- published_at < NOW() - INTERVAL '7 days' to cold storage (S3 Glacier or
-- equivalent), then DELETEs from the live table. The 7-day window provides
-- a replay buffer for event consumer recovery scenarios.
-- ---------------------------------------------------------------------------
