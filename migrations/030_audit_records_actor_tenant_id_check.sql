-- =============================================================================
-- File:    migrations/030_audit_records_actor_tenant_id_check.sql
-- Purpose: Add the F-4 DB-level CHECK constraint that requires non-blank
--          actor_tenant_id for non-system, non-ai_workload actor types.
--          Companion to migration 029.
--
-- Spec:    Closes Phase 2 F-4 R9 HIGH (rolling-deploy safety).
--          - migrations/029_audit_records_actor_tenant_id.sql (forward;
--            adds the column + emitAudit runtime guard)
--          - docs/PHASE_2_ADMIN_JWT_SCOPE_AND_FOLLOW_ONS.md F-4 closure
--          - Codex F-4 R9 HIGH 2026-05-15
--
-- ROLLOUT SEQUENCING (operators MUST follow):
--   Step 1. Apply migration 029 in production.
--   Step 2. Roll out app-code changes so every instance writes the new
--           emitter shape (actor_tenant_id populated for non-system
--           actor types).
--   Step 3. Confirm via audit-records sample query that all rows
--           inserted in the last hour carry actor_tenant_id (excluding
--           system + ai_workload). Stop and triage if any human actor
--           rows have NULL — investigate caller before continuing.
--   Step 4. Apply migration 030 (this file). The CHECK constraint
--           is added as NOT VALID so legacy pre-029 rows are exempt;
--           new rows must pass. After validation by app-level testing,
--           operators MAY run `VALIDATE CONSTRAINT
--           audit_records_actor_tenant_id_required_for_human_actors`
--           in a separate maintenance window — but only after a
--           backfill plan covers any remaining legacy NULL rows.
--
-- RATIONALE — why split from 029:
--   Adding this constraint in migration 029 would reject mid-rollout
--   writes from app instances that are still on the pre-029 emitter
--   (no actor_tenant_id). Those rejections would abort user-visible
--   admin or clinical actions instead of merely losing attribution.
--   By splitting into 030, operators get explicit control over WHEN
--   to enforce the constraint — only after all writers have migrated.
--
-- ROLLBACK:
--   migrations/rollback/030_rollback.sql
-- =============================================================================

ALTER TABLE audit_records
    ADD CONSTRAINT audit_records_actor_tenant_id_required_for_human_actors
    CHECK (
        actor_type IN ('system', 'ai_workload')
        OR (actor_tenant_id IS NOT NULL AND btrim(actor_tenant_id) <> '')
    )
    NOT VALID;
