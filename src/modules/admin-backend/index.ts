/**
 * Admin Backend Basics module — public interface.
 *
 * Per ADR-001: cross-module callers consume the Admin Backend module ONLY
 * through this file. At Sprint 1 (PR 6 — this commit) the exported surface
 * is the Fastify plugin (for app.ts wiring) + branded ID types + canonical
 * lifecycle-state / decision / dashboard-name vocabularies (so downstream
 * slices — Forms Intake when its publish flow wires the admin-review gate;
 * future ops surfaces — can compile against typed Admin Backend references
 * before Sprint 2's handler implementation lands).
 *
 * **Status at v0.1 (Sprint 1):** SKELETON — module shell only. The DB
 * layer is complete (migrations 039-044: 12 RBAC roles + 4 entities +
 * 2 derived views (2 deferred) + raw lifecycle writer + 2 template
 * wrappers + 1 dashboard read-wrapper (2 deferred); 5 PRs merged with
 * Codex APPROVE). The Sprint 2+ application-layer work is:
 *
 *   - Sprint 2 — POST /v1/admin/templates/{template_id}/submit-for-review
 *     (wraps submit_forms_template_for_admin_review) +
 *     POST /v1/admin/template-reviews/{review_id}/decision (wraps
 *     record_forms_template_admin_decision)
 *   - Sprint 3 — GET /v1/admin/dashboards/crisis-operational-health
 *     (wraps read_admin_crisis_operational_health). The other 2 dashboard
 *     endpoints (consult-queue-health + mode1-volume-health) are
 *     DEFERRED per Option 2 carryforward — their underlying SECDEF
 *     wrappers + views are deferred until consult + Mode 1 entities land.
 *   - Sprint 4 — full Cat A audit emission (admin.dashboard_query_executed
 *     + admin.template_submitted_for_review + admin.template_review_decision
 *     + admin.template_published_via_review_workflow) + LAYER B role-
 *     membership check + cross-tenant isolation tests + idempotency-replay
 *     regression on decision wrapper
 *
 * Per Option 2 ratifier decision 2026-05-22: SQL wrappers use SI-010
 * `current_actor_*()` helpers, not SI-024.1 JWT trust anchor. Application
 * layer is responsible for Cat A audit emission (must wrap the SECDEF
 * wrapper call + the audit_records INSERT in a single DB transaction).
 *
 * Spec references:
 *   - SI-023 Admin Backend Basics Slice v1.0 (RATIFIED 2026-05-22 P-041)
 *   - CDM v1.10 → v1.11 Amendment (RATIFIED 2026-05-22 P-042)
 *   - docs/crisis-response-implementation-plan.md (Option 2 adaptation
 *     rationale + recorded divergences from spec)
 *   - I-023, I-025, I-027 (tenant isolation; tenant-blind errors; audit)
 *   - I-035 (append-only lifecycle per migration 040 triggers)
 *   - ADR-001 (modular monolith — public-interface-only cross-module access)
 */

export { adminBackendPlugin } from './plugin.js';

// Branded ID types
export type {
  AdminDashboardQueryExecutionId,
  FormsTemplateAdminReviewId,
  FormsTemplateAdminReviewLifecycleTransitionId,
  AdminTemplateDecisionIdempotencyKeyId,
} from './internal/types.js';
export {
  asAdminDashboardQueryExecutionId,
  asFormsTemplateAdminReviewId,
  asFormsTemplateAdminReviewLifecycleTransitionId,
  asAdminTemplateDecisionIdempotencyKeyId,
} from './internal/types.js';

// Canonical vocabularies
export type {
  FormsTemplateAdminReviewState,
  FormsTemplateAdminReviewTransitionReason,
  AdminTemplateDecision,
  AdminDashboardName,
} from './internal/types.js';
export {
  FORMS_TEMPLATE_ADMIN_REVIEW_STATES,
  FORMS_TEMPLATE_ADMIN_REVIEW_TRANSITION_REASONS,
  ADMIN_TEMPLATE_DECISIONS,
  ADMIN_DASHBOARD_NAMES,
} from './internal/types.js';
