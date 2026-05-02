-- =============================================================================
-- File:    migrations/rollback/000_rollback.sql
-- Purpose: Rollback for 000_extensions.sql — drop platform extensions.
-- Warning: Dropping extensions in a populated database will fail if any object
--          depends on the extension (e.g., uuid_generate_v4() calls in
--          DEFAULT clauses). Run this rollback ONLY in a freshly reset dev
--          environment BEFORE any other migrations have been applied.
--          Production: never drop extensions — extend instead (new ADR required).
-- =============================================================================

-- Order matters: drop least-depended-on first.
-- pgcrypto and uuid-ossp will fail if tables with DEFAULT uuid_generate_v4()
-- or digest() expressions still exist. Drop tables first (via their own
-- rollbacks) before running this file.

DROP EXTENSION IF EXISTS "btree_gin";
DROP EXTENSION IF EXISTS "pg_trgm";
DROP EXTENSION IF EXISTS "pgcrypto";
DROP EXTENSION IF EXISTS "uuid-ossp";
