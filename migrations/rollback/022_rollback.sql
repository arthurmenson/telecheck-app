-- =============================================================================
-- File:    migrations/rollback/022_rollback.sql
-- Purpose: Rollback for 022_audit_dedupe_markers.sql — drop the
--          audit_dedupe_markers table + its supporting index.
-- Spec:    Companion to migrations/022_audit_dedupe_markers.sql.
-- Note:    Idempotent — uses IF EXISTS clauses so reapplication is a no-op.
-- Warning: Rolling back this migration removes the duplicate-audit
--          protection for Category A emissions on idempotency-protected
--          paths. After rollback, a crash between independent audit
--          commit and idempotency completion can re-emit duplicate
--          Category A audits on retry (the original Sprint 33 PR-F2 r4
--          deferred HIGH). Only roll back if the schema is being
--          re-baselined; never roll back in production while
--          src/lib/audit-dedupe.ts is in use.
-- =============================================================================

DROP INDEX IF EXISTS idx_audit_dedupe_markers_expires;
DROP TABLE IF EXISTS audit_dedupe_markers;
