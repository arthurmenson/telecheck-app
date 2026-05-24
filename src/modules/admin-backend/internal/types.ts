/**
 * admin-backend/internal/types.ts — branded ID types + canonical vocabularies
 * for the Admin Backend Basics module.
 *
 * The DB layer is COMPLETE through migration 044 (see migrations/039-044):
 * 12 RBAC roles + 4 entities + 2 derived views (2 deferred) + raw lifecycle
 * writer + 2 template wrappers + 1 dashboard read-wrapper (2 deferred).
 * This TypeScript layer (Sprint 1) exposes branded IDs + canonical
 * lifecycle-state + decision vocabularies so downstream slices (e.g.,
 * Forms Intake publish flow when it wires the admin-review gate) can
 * compile against typed Admin Backend references before Sprint 2's
 * handler implementation lands.
 *
 * Per Option 2 ratifier decision 2026-05-22 (see
 * docs/crisis-response-implementation-plan.md): the SQL wrappers use SI-010
 * `current_actor_*()` helpers, not SI-024.1 JWT trust anchor. Application
 * layer responsibility for Cat A audit emission (admin.dashboard_query_executed
 * + admin.template_submitted_for_review + admin.template_review_decision +
 * admin.template_published_via_review_workflow); the Fastify route handler
 * in Sprint 2+ MUST wrap the SECDEF call + audit_records INSERT in a single
 * DB transaction.
 *
 * Spec references:
 *   - SI-023 Admin Backend Basics Slice v1.0 (RATIFIED 2026-05-22 P-041)
 *   - CDM v1.10 → v1.11 Amendment §4.NEW1-NEW9 (RATIFIED 2026-05-22 P-042)
 *   - State Machines v1.5 §forms_template_admin_review_lifecycle (5 states
 *     + 5 transition triples)
 *   - I-023, I-025, I-027 (tenant isolation; tenant-blind errors; audit)
 *   - I-035 (append-only lifecycle per migration 040 triggers)
 */

declare const __brand: unique symbol;
type Brand<T, TBrand extends string> = T & { readonly [__brand]: TBrand };

// ---------------------------------------------------------------------------
// Branded ID types — CDM v1.11 §4.NEW1-NEW4
// ---------------------------------------------------------------------------

export type AdminDashboardQueryExecutionId = Brand<bigint, 'AdminDashboardQueryExecutionId'>;
export function asAdminDashboardQueryExecutionId(raw: bigint): AdminDashboardQueryExecutionId {
  return raw as AdminDashboardQueryExecutionId;
}

export type FormsTemplateAdminReviewId = Brand<string, 'FormsTemplateAdminReviewId'>;
export function asFormsTemplateAdminReviewId(raw: string): FormsTemplateAdminReviewId {
  return raw as FormsTemplateAdminReviewId;
}

export type FormsTemplateAdminReviewLifecycleTransitionId = Brand<
  bigint,
  'FormsTemplateAdminReviewLifecycleTransitionId'
>;
export function asFormsTemplateAdminReviewLifecycleTransitionId(
  raw: bigint,
): FormsTemplateAdminReviewLifecycleTransitionId {
  return raw as FormsTemplateAdminReviewLifecycleTransitionId;
}

export type AdminTemplateDecisionIdempotencyKeyId = Brand<
  bigint,
  'AdminTemplateDecisionIdempotencyKeyId'
>;
export function asAdminTemplateDecisionIdempotencyKeyId(
  raw: bigint,
): AdminTemplateDecisionIdempotencyKeyId {
  return raw as AdminTemplateDecisionIdempotencyKeyId;
}

// ---------------------------------------------------------------------------
// forms_template_admin_review_lifecycle — 5 states + 5 transition triples
// CHECK-constrained enum from migration 040 §3.
// ---------------------------------------------------------------------------

export type FormsTemplateAdminReviewState =
  | 'none'
  | 'pending_review'
  | 'approved'
  | 'rejected'
  | 'revision_requested';

export const FORMS_TEMPLATE_ADMIN_REVIEW_STATES: readonly FormsTemplateAdminReviewState[] = [
  'none',
  'pending_review',
  'approved',
  'rejected',
  'revision_requested',
] as const;

export type FormsTemplateAdminReviewTransitionReason =
  | 'initial_submission'
  | 'clinician_decision_approve'
  | 'clinician_decision_reject'
  | 'clinician_decision_request_revision'
  | 'revision_resubmission';

export const FORMS_TEMPLATE_ADMIN_REVIEW_TRANSITION_REASONS: readonly FormsTemplateAdminReviewTransitionReason[] =
  [
    'initial_submission',
    'clinician_decision_approve',
    'clinician_decision_reject',
    'clinician_decision_request_revision',
    'revision_resubmission',
  ] as const;

// ---------------------------------------------------------------------------
// Decision API enum — per CDM §4.NEW8f wrapper signature.
// ---------------------------------------------------------------------------

export type AdminTemplateDecision = 'approve' | 'reject' | 'request_revision';

export const ADMIN_TEMPLATE_DECISIONS: readonly AdminTemplateDecision[] = [
  'approve',
  'reject',
  'request_revision',
] as const;

// ---------------------------------------------------------------------------
// Dashboard names — CHECK constraint enum from migration 040 §1.
// ---------------------------------------------------------------------------

export type AdminDashboardName =
  | 'admin_crisis_operational_health_v'
  | 'admin_consult_queue_health_v'
  | 'admin_mode1_volume_health_v';

export const ADMIN_DASHBOARD_NAMES: readonly AdminDashboardName[] = [
  'admin_crisis_operational_health_v',
  'admin_consult_queue_health_v',
  'admin_mode1_volume_health_v',
] as const;
