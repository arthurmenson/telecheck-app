-- =============================================================================
-- File:    migrations/022_audit_dedupe_markers.sql
-- Purpose: Cross-cutting dedupe-marker table for Category A audit events
--          emitted from idempotency-protected request paths.
--
-- Sprint 34 / SI-006 audit-dedupe SI (2026-05-08). Closes the deferred
-- HIGH from Sprint 33 PR-F2 r4: Category A crisis_detection_trigger
-- audits could duplicate across a crash/DB-failure window.
--
-- The hazard (PR-F2 r4 commit message, lines 30-46):
--
--   Crisis audit can duplicate across a crash/DB-failure window. If the
--   process crashes after runCrisisGate commits the independent audit
--   but before the idempotency completion UPDATE flushes, the
--   reservation rolls back/disappears while the audit remains durable.
--   A retry runs the gate again and emits a second audit.
--
-- Why a separate table (not a column on audit_records):
--   audit_records is a hash-chained append-only table (per I-003); its
--   INSERT path runs a BEFORE-INSERT trigger that computes prev_hash +
--   record_hash. Adding a dedupe column would require ON CONFLICT (...)
--   DO NOTHING semantics on the audit_records INSERT — workable, but
--   it pulls the dedupe contract into the chain-management surface and
--   complicates the trigger's reasoning. A separate marker table keeps
--   audit_records semantics unchanged and cleanly isolates the dedupe
--   concern.
--
-- Why a 30-day TTL on markers:
--   The IDEMPOTENCY v5.1 cache TTL is 24h max (per ENDPOINT_TTL_OVERRIDES
--   in src/lib/idempotency.ts; auth-flow paths bound to 900s). Marker
--   TTL must be >= cache TTL so a retry within the cache window always
--   sees the marker. 30 days is a generous safety margin that also
--   exceeds the 24h default by ~30x. Cleanup is via background job or
--   on-demand purge in the claim helper itself.
--
-- Why no RLS on markers:
--   The marker is purely a cross-request claim record; it carries no
--   PHI and no patient-identifiable data beyond tenant_id (and the
--   opaque dedupe_key hash). The tenant_id column is included for
--   operational queries + constraints, not RLS enforcement. Application
--   layer is the only consumer; it scopes by tenant_id when claiming.
--
-- Caller contract (src/lib/audit-dedupe.ts):
--   1. Caller computes a deterministic dedupe_key from idempotency
--      context (tenant_id + idempotency_key + endpoint + actor_id +
--      audit_action). The key SHOULD be a SHA-256 hex digest of the
--      concatenation so it's bounded length + opaque to consumers.
--   2. Caller wraps the audit emission in an INSERT-then-emit pattern:
--        INSERT INTO audit_dedupe_markers (...) ON CONFLICT (...) DO NOTHING
--          RETURNING tenant_id;
--      If RETURNING reports row inserted (no conflict), proceed to
--      emit the actual audit. If RETURNING reports no rows (conflict),
--      skip the emit — a prior attempt already claimed the slot.
--   3. The INSERT MUST commit BEFORE the audit emission within the
--      same connection transaction. If the audit emit fails, the
--      marker stays — that's fine: subsequent retries will skip the
--      emit, but the audit will also be missing. THIS IS A KNOWN
--      LIMITATION — partial-failure cleanup is out of scope for this
--      SI; if a caller must guarantee audit emission, it should use
--      a compensating-action pattern (see Sprint 35 design doc if
--      this becomes a real problem).
--
-- Spec references:
--   - docs/SI-006-Idempotency-Reserve-Then-Execute-Redesign.md (v0.2)
--   - IDEMPOTENCY v5.1 §1 (cache key 4-tuple)
--   - I-003 (audit append-only)
--   - I-019 (crisis detection durability)
--   - AUDIT_EVENTS v5.2 §Category A
-- =============================================================================

CREATE TABLE IF NOT EXISTS audit_dedupe_markers (
    -- Tenant context — every marker is tenant-scoped. References
    -- tenants(id) for FK integrity (cascade behavior is RESTRICT —
    -- a tenant cannot be deleted while it has live markers, matching
    -- the behavior of audit_records FK).
    tenant_id   TEXT        NOT NULL
                    REFERENCES tenants(id),

    -- Deterministic dedupe key. SHA-256 hex digest of the marker tuple
    -- (tenant_id || idempotency_key || endpoint || actor_id ||
    --  audit_action). 64-char hex string. Opaque to anything outside
    -- the claim helper.
    dedupe_key  TEXT        NOT NULL
                    CHECK (length(dedupe_key) BETWEEN 32 AND 128),

    -- When the marker was claimed. Used for cleanup observability
    -- and operational metrics (e.g., "how many markers in the last
    -- N hours").
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- Cleanup horizon. 30 days from creation by default — see header
    -- comment for rationale (must be >= IDEMPOTENCY v5.1 cache TTL).
    -- Background cleanup job purges rows where expires_at <= NOW().
    expires_at  TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '30 days',

    -- (tenant_id, dedupe_key) is the natural primary key for the
    -- claim contract. Including tenant_id in the PK protects against
    -- a degenerate case where two tenants happen to compute the same
    -- dedupe_key (unlikely with SHA-256 + tenant_id in the digest
    -- input, but the constraint makes the cross-tenant claim
    -- impossibility explicit).
    PRIMARY KEY (tenant_id, dedupe_key)
);

-- Cleanup support: indexed on expires_at so a periodic
-- DELETE FROM audit_dedupe_markers WHERE expires_at <= NOW()
-- is fast even at scale. Tenant-aware per the leading column for
-- operational queries.
CREATE INDEX IF NOT EXISTS idx_audit_dedupe_markers_expires
    ON audit_dedupe_markers (tenant_id, expires_at);

-- Documentation comment for ops + future engineers reading the schema.
COMMENT ON TABLE audit_dedupe_markers IS
    'Sprint 34 SI-006 audit-dedupe SI: claim-marker table for Category A audit emissions on idempotency-protected request paths. See migrations/022_audit_dedupe_markers.sql header + src/lib/audit-dedupe.ts for the claim contract.';

COMMENT ON COLUMN audit_dedupe_markers.dedupe_key IS
    'SHA-256 hex of (tenant_id || idempotency_key || endpoint || actor_id || audit_action). Opaque outside the claim helper.';

COMMENT ON COLUMN audit_dedupe_markers.expires_at IS
    '30-day TTL by default. Must be >= IDEMPOTENCY v5.1 cache TTL so retries within the cache window always see the marker. Cleanup is via background job or on-demand purge in the claim helper.';
