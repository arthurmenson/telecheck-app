-- =============================================================================
-- File:    migrations/000_extensions.sql
-- Purpose: Install required PostgreSQL extensions for the Telecheck platform.
-- Spec:    No single contract section; foundational for:
--            - uuid-ossp: UUID generation used across all entity PKs
--            - pgcrypto:  SHA-256 hash chain per AUDIT_EVENTS v5.2 hash-chain
--                         section and I-003 (audit append-only integrity)
--            - pg_trgm:   Trigram index support for future fuzzy-text search
--                         (medication names, patient search)
--            - btree_gin: Composite GIN index support for JSONB payload columns
--                         (audit_records.payload, domain_events_outbox.payload)
-- Summary: Idempotent extension installation. No tables created here.
--          Must run before any migration that calls uuid_generate_v4() or
--          digest()/encode() (pgcrypto).
-- =============================================================================

-- Extensions are database-scoped. IF NOT EXISTS makes this idempotent.

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";
CREATE EXTENSION IF NOT EXISTS "btree_gin";
