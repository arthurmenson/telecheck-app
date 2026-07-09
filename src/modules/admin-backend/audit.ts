/**
 * admin-backend/audit.ts — module-specific audit envelope emitters for the
 *   Admin Backend Basics slice (SI-023 v1.0 RATIFIED 2026-05-22 P-041).
 *
 * Wraps `lib/audit.ts emitAudit()` for the 4 SI-023 Cat A action IDs per
 * SI-023 §3 normative audit-event enumeration:
 *
 *   1. `admin.dashboard_query_executed`             Cat A (SECDEF read-wrappers)
 *   2. `admin.template_submitted_for_review`        Cat A (Sprint 2 PR 2, on `main`)
 *   3. `admin.template_review_decision`             Cat A (THIS PR — Sprint 2 PR 3)
 *   4. `admin.template_published_via_review_workflow` Cat A (decision approve-path)
 *
 * **PR scope (Sprint 2 PR 3):** emitter (2) landed on `main` with the
 * submit-for-review handler; THIS PR adds emitter (3) — the
 * template-review-decision Cat A event. Emitters (1) and (4) land in the
 * companion PRs that mount their respective wrappers. Adding emitters
 * incrementally keeps each PR's blast radius narrow + preserves Codex's
 * ability to review the canonical action-id resolution discipline (no
 * placeholder casts; ratified IDs only) one action at a time.
 *
 * **Action ID ratification status:** none of the 4 `admin.*` action IDs
 * exist in the `lib/audit.ts` AuditAction union as of Sprint 2 PR 2's
 * baseline. SI-023 §3 enumerates them as ratified slice-spec action IDs
 * but the canonical AUDIT_EVENTS catalog at `Telecheck_Contracts_Pack_v5_00_AUDIT_EVENTS.md`
 * has not yet been amended to include the `admin.*` namespace. Until that
 * amendment lands, this module emits under DESCRIPTIVE-but-not-yet-
 * canonical-catalog IDs through a SINGLE sanctioned cast helper
 * (`adminBackendAuditPlaceholder()`) — identical pattern to
 * forms-intake/audit.ts (`formsAuditPlaceholder()`) and
 * async-consult/audit.ts. The placeholder discipline:
 *
 *   - The cast is contained in ONE function so reviewers can grep for
 *     every unratified emission across the module:
 *       git grep "adminBackendAuditPlaceholder("
 *   - The compile-time `AdminBackendAuditActionPlaceholder` union
 *     enumerates exactly the placeholder strings — typos at call sites
 *     become compile errors.
 *   - When the AUDIT_EVENTS amendment ratifies `admin.*` IDs into the
 *     canonical AuditAction enum, the migration is a 3-step grep
 *     (add to AuditAction → delete this helper + union → replace every
 *     `adminBackendAuditPlaceholder('<id>')` with the bare literal).
 *
 * **I-003 durability:** emitters MUST be called with a `tx` handle so the
 * audit INSERT runs in the same transaction as the SECDEF wrapper call;
 * `emitAudit()` already throws on missing-tx in production (I-003 bare-
 * suppression-forbidden discipline). Callers MUST NOT swallow the throw.
 *
 * Spec references:
 *   - SI-023 Admin Backend Basics Slice v1.0 §3 row 2
 *     `admin.template_submitted_for_review` Cat A (RATIFIED 2026-05-22 P-041)
 *   - SI-023 §4 wrapper-body spec (canonical payload shape)
 *   - CDM v1.10 → v1.11 Amendment §4.NEW8e (RATIFIED 2026-05-22 P-042)
 *   - migrations/043_admin_backend_template_wrappers.sql §1 (the
 *     `submit_forms_template_for_admin_review` SECDEF wrapper)
 *   - I-003 (audit append-only; bare suppression forbidden),
 *     I-027 (every audit record carries tenant_id)
 */

import {
  type AuditAction,
  type AuditDbClient,
  type AuditEnvelope,
  type AuditEnvelopeInput,
  emitAudit,
} from '../../lib/audit.js';
import type { TenantId } from '../../lib/glossary.js';

// ---------------------------------------------------------------------------
// SPEC ISSUE — unratified Admin Backend audit action IDs (placeholder helper)
//
// See file-header docstring for the full discipline. The single sanctioned
// cast helper below routes every unratified `admin.*` emission through one
// grep-able call site (`adminBackendAuditPlaceholder(...)`); the compile-
// time union enumerates exactly the placeholder strings.
// ---------------------------------------------------------------------------

/**
 * Closed union of unratified `admin.*` action IDs used by this module.
 *
 * **Current population (Sprint 4 hardening — all 4 Cat A IDs live):**
 * `admin.dashboard_query_executed` (Sprint 4 — the 3 dashboard reads),
 * `admin.template_submitted_for_review` (PR 2, on `main`),
 * `admin.template_review_decision` (PR 3, on `main`), and the approve-path
 * `admin.template_published_via_review_workflow` (Sprint 4 — emitted from
 * the decision handler's approve branch). All 4 SI-023 §3 Cat A action IDs
 * are now emitted. The union itself is the authoritative inventory of what
 * the canonical AUDIT_EVENTS catalog still owes us (Track-6 SPEC-GATED —
 * bundle AUDIT_EVENTS v5.12 → v5.13 amendment per SI-023 §3; §12 SI
 * candidate). Placeholder-cast has NO runtime impact (naming-provenance
 * gap only — async-consult precedent, which ships /ready READY with 17
 * placeholder-cast IDs).
 */
type AdminBackendAuditActionPlaceholder =
  | 'admin.dashboard_query_executed'
  | 'admin.template_submitted_for_review'
  | 'admin.template_review_decision'
  | 'admin.template_published_via_review_workflow';

/**
 * adminBackendAuditPlaceholder — single sanctioned `as AuditAction` cast
 * site for the admin-backend module.
 *
 * Returns the placeholder string typed as `AuditAction` so it can flow
 * into `emitAudit()` without per-call-site casts. The cast is contained
 * here so reviewers can grep for the source of every unratified emission:
 *
 *   git grep "adminBackendAuditPlaceholder("
 *
 * That same grep is the migration list when AUDIT_EVENTS ratifies `admin.*`
 * IDs into the canonical AuditAction enum (delete this function + replace
 * every call site with the bare literal — TS infers AuditAction).
 *
 * The compile-time `AdminBackendAuditActionPlaceholder` union prevents
 * typos.
 */
export function adminBackendAuditPlaceholder(id: AdminBackendAuditActionPlaceholder): AuditAction {
  return id as AuditAction;
}

// ---------------------------------------------------------------------------
// admin.template_submitted_for_review (Cat A)
//
// Emitted by the Sprint 2 PR 2 handler immediately after the
// `submit_forms_template_for_admin_review` SECDEF wrapper returns. Runs in
// the same transaction as the wrapper call so a partial commit cannot leave
// a `forms_template_admin_review` row + lifecycle_transition row without
// the corresponding audit record (I-003 same-transaction durability).
//
// **Payload schema per SI-023 §3 row 2 (`{review_id UUID, forms_template_id UUID,
// submitter_principal_id UUID}`)** plus the `path` discriminator
// distinguishing `initial_submission` from `revision_resubmission` (per
// the SI-023 §4 spec wrapper body's emit_audit_event_co_transactional call).
//
// **Actor attribution:** the actor identity in this handler is the admin
// operator submitting on behalf of the workflow per SI-023 §5 endpoint #4
// (R6 HIGH-3 closure 2026-05-22 — `admin_basic_operator` role ONLY). The
// canonical SI-024.1 JWT trust anchor that would resolve a strong
// principal_id is deferred per the Option 2 carryforward (the
// `verify_session_jwt_and_extract_claims()` helper is not in the code
// repo); for v0.1 of this handler the `actor_type='operator'` and
// `actor_id` is the actor-context account id (or 'unknown' fallback,
// mirroring the resolveActorIdForAudit pattern in sibling slices).
//
// `target_patient_id` is `null` — template submission is a platform-scope
// governance action (no patient touched); the lib/audit.ts foundation
// maps null to the 'PLATFORM' hash-chain partition sentinel matching the
// DB trigger COALESCE per migration 002.
//
// `ai_workload_type` / `autonomy_level` remain `null` — template submission
// is a deterministic admin-workflow action, not in the I-012 action-class
// set, per the WORKLOAD_TAXONOMY v5.2 nullability rule.
//
// `country_of_care` is sourced from the request's tenant context (tenant
// is the single source of CCR per ADR-024).
// ---------------------------------------------------------------------------

export async function emitTemplateSubmittedForReviewAudit(
  args: {
    tenantId: TenantId;
    reviewId: string;
    formsTemplateId: string;
    submitterPrincipalId: string;
    submitterActorTenantId: string;
    countryOfCare: string;
    path: 'initial_submission' | 'revision_resubmission';
  },
  tx: AuditDbClient,
): Promise<AuditEnvelope> {
  const envelope: AuditEnvelopeInput = {
    timestamp: new Date().toISOString(),
    tenant_id: args.tenantId,
    actor_type: 'operator',
    actor_id: args.submitterPrincipalId,
    actor_tenant_id: args.submitterActorTenantId,
    target_patient_id: null,
    delegate_context: null,
    action: adminBackendAuditPlaceholder('admin.template_submitted_for_review'),
    category: 'A',
    audit_sensitivity_level: 'standard',
    resource_type: 'forms_template_admin_review',
    resource_id: args.reviewId,
    detail: {
      review_id: args.reviewId,
      forms_template_id: args.formsTemplateId,
      submitter_principal_id: args.submitterPrincipalId,
      path: args.path,
    },
    engine_versions: null,
    ai_workload_type: null,
    autonomy_level: null,
    agent_id: null,
    agent_version: null,
    tool_call_id: null,
    memory_read_set_id: null,
    memory_write_set_id: null,
    supervising_policy_id: null,
    knowledge_source_versions: null,
    signals: null,
    override: null,
    linked_events: [],
    compliance_flags: [],
    country_of_care: args.countryOfCare,
    break_glass: null,
  };
  return emitAudit(envelope, tx);
}

// ---------------------------------------------------------------------------
// admin.template_review_decision (Cat A)
//
// Emitted by the Sprint 2 PR 3 handler immediately after the
// `record_forms_template_admin_decision` SECDEF wrapper returns. Runs in
// the SAME transaction as the wrapper INSERT so a partial commit cannot
// leave a `forms_template_admin_review` state-transition (or
// approve-path publication) without the corresponding audit record
// (I-003 same-transaction durability).
//
// **Payload schema per SI-023 §3 row 3 (`{review_id UUID, forms_template_id UUID,
// decider_principal_id UUID, decision <approve|reject|request_revision>}`)** plus
// the `decision_payload` echo (review_notes / required_revisions array
// per migration 043 §3 wrapper body).
//
// **Actor attribution:** the actor identity in this handler is the
// `admin_template_reviewer` (per SI-023 §5 endpoint #5; distinct slice
// role from the submit endpoint's `admin_basic_operator`). For v0.1 the
// `actor_type='operator'` and `actor_id` is the actor-context account id
// (or 'unknown' fallback per the resolveActorIdForAudit pattern).
//
// `target_patient_id` is `null` — template review-decision is a platform-
// scope governance action (no patient touched); foundation maps null to
// the 'PLATFORM' hash-chain partition sentinel.
//
// `ai_workload_type` / `autonomy_level` remain `null` — review-decision
// is a deterministic admin-workflow action, not in the I-012 action-
// class set, per WORKLOAD_TAXONOMY v5.2 nullability rule.
// ---------------------------------------------------------------------------

export type TemplateReviewDecision = 'approve' | 'reject' | 'request_revision';

export async function emitTemplateReviewDecisionAudit(
  args: {
    tenantId: TenantId;
    reviewId: string;
    formsTemplateId: string;
    deciderPrincipalId: string;
    deciderActorTenantId: string;
    countryOfCare: string;
    decision: TemplateReviewDecision;
    decisionPayload: Record<string, unknown>;
  },
  tx: AuditDbClient,
): Promise<AuditEnvelope> {
  const envelope: AuditEnvelopeInput = {
    timestamp: new Date().toISOString(),
    tenant_id: args.tenantId,
    actor_type: 'operator',
    actor_id: args.deciderPrincipalId,
    actor_tenant_id: args.deciderActorTenantId,
    target_patient_id: null,
    delegate_context: null,
    action: adminBackendAuditPlaceholder('admin.template_review_decision'),
    category: 'A',
    audit_sensitivity_level: 'standard',
    resource_type: 'forms_template_admin_review',
    resource_id: args.reviewId,
    detail: {
      review_id: args.reviewId,
      forms_template_id: args.formsTemplateId,
      decider_principal_id: args.deciderPrincipalId,
      decision: args.decision,
      decision_payload: args.decisionPayload,
    },
    engine_versions: null,
    ai_workload_type: null,
    autonomy_level: null,
    agent_id: null,
    agent_version: null,
    tool_call_id: null,
    memory_read_set_id: null,
    memory_write_set_id: null,
    supervising_policy_id: null,
    knowledge_source_versions: null,
    signals: null,
    override: null,
    linked_events: [],
    compliance_flags: [],
    country_of_care: args.countryOfCare,
    break_glass: null,
  };
  return emitAudit(envelope, tx);
}

// ---------------------------------------------------------------------------
// admin.dashboard_query_executed (Cat A) — Sprint 4 hardening
//
// Emitted by each of the 3 dashboard read handlers immediately after the
// SECDEF read-wrapper (read_admin_crisis_operational_health /
// read_admin_consult_queue_health / read_admin_mode1_volume_health)
// returns. Runs in the SAME transaction as the wrapper call so a partial
// commit cannot leave the wrapper's co-transactional
// admin_dashboard_query_execution read-trail INSERT without the
// corresponding Cat A audit envelope (I-003 same-transaction durability +
// FLOOR-020 fail-closed).
//
// **Two distinct records, one transaction:** the SECDEF wrapper itself
// INSERTs an `admin_dashboard_query_execution` row (the I-027 read-trail;
// Sub-decision 3 audit-trail entity). This emitter adds the canonical
// AUDIT_EVENTS v5.x envelope (`admin.dashboard_query_executed` Cat A) —
// the SI-023 §3 row 1 normative audit event. Both live in the same tx as
// the wrapper SELECT; they are complementary, not redundant (read-trail =
// entity row for the completeness tripwire §8.1 class N; audit envelope =
// hash-chained operational audit).
//
// **Payload schema per SI-023 §3 row 1
// (`{dashboard_name TEXT, row_count INTEGER, query_params JSONB}`).**
//
// **Actor attribution:** the executor is the `admin_basic_operator`
// (per SI-023 §5 endpoints 1-3). `actor_type='operator'`; `actor_id` is
// the actor-context account id (or 'unknown' fallback per the
// resolveActorIdForAudit pattern).
//
// `target_patient_id` is `null` — dashboard reads are platform-scope
// operational-monitoring actions (no patient touched); foundation maps
// null to the 'PLATFORM' hash-chain partition sentinel.
//
// `ai_workload_type` / `autonomy_level` remain `null` — dashboard reads
// are deterministic admin-monitoring actions, not in the I-012 action-
// class set, per WORKLOAD_TAXONOMY v5.2 nullability rule.
// ---------------------------------------------------------------------------

/** Canonical dashboard view names per SI-023 §4.NEW1 CHECK constraint. */
export type AdminDashboardName =
  | 'admin_crisis_operational_health_v'
  | 'admin_consult_queue_health_v'
  | 'admin_mode1_volume_health_v';

export async function emitDashboardQueryExecutedAudit(
  args: {
    tenantId: TenantId;
    executorPrincipalId: string;
    executorActorTenantId: string;
    countryOfCare: string;
    dashboardName: AdminDashboardName;
    rowCount: number;
    queryParams: Record<string, unknown>;
  },
  tx: AuditDbClient,
): Promise<AuditEnvelope> {
  const envelope: AuditEnvelopeInput = {
    timestamp: new Date().toISOString(),
    tenant_id: args.tenantId,
    actor_type: 'operator',
    actor_id: args.executorPrincipalId,
    actor_tenant_id: args.executorActorTenantId,
    target_patient_id: null,
    delegate_context: null,
    action: adminBackendAuditPlaceholder('admin.dashboard_query_executed'),
    category: 'A',
    audit_sensitivity_level: 'standard',
    resource_type: 'admin_dashboard_query_execution',
    resource_id: args.dashboardName,
    detail: {
      dashboard_name: args.dashboardName,
      row_count: args.rowCount,
      query_params: args.queryParams,
    },
    engine_versions: null,
    ai_workload_type: null,
    autonomy_level: null,
    agent_id: null,
    agent_version: null,
    tool_call_id: null,
    memory_read_set_id: null,
    memory_write_set_id: null,
    supervising_policy_id: null,
    knowledge_source_versions: null,
    signals: null,
    override: null,
    linked_events: [],
    compliance_flags: [],
    country_of_care: args.countryOfCare,
    break_glass: null,
  };
  return emitAudit(envelope, tx);
}

// ---------------------------------------------------------------------------
// admin.template_published_via_review_workflow (Cat A) — Sprint 4 hardening
//
// Emitted by the decision handler's APPROVE branch immediately after the
// `record_forms_template_admin_decision` wrapper returns when
// decision='approve' (the wrapper atomically UPDATEs forms_template.status
// to published — canonical publish path, transition triple #2). Runs in
// the SAME transaction as the wrapper INSERT + the paired
// `admin.template_review_decision` audit (I-003 same-transaction
// durability). Per SI-023 §3 row 4 the publish audit fires IFF the
// decision was approve.
//
// **Payload schema per SI-023 §3 row 4
// (`{review_id UUID, forms_template_id UUID, decider_principal_id UUID}`).**
//
// **Actor attribution:** identical to the decision audit — the
// `admin_template_reviewer` per SI-023 §5 endpoint 5. `actor_type='operator'`.
//
// `target_patient_id` null (platform-scope governance); ai fields null
// (deterministic admin-workflow action).
// ---------------------------------------------------------------------------

export async function emitTemplatePublishedViaReviewWorkflowAudit(
  args: {
    tenantId: TenantId;
    reviewId: string;
    formsTemplateId: string;
    deciderPrincipalId: string;
    deciderActorTenantId: string;
    countryOfCare: string;
  },
  tx: AuditDbClient,
): Promise<AuditEnvelope> {
  const envelope: AuditEnvelopeInput = {
    timestamp: new Date().toISOString(),
    tenant_id: args.tenantId,
    actor_type: 'operator',
    actor_id: args.deciderPrincipalId,
    actor_tenant_id: args.deciderActorTenantId,
    target_patient_id: null,
    delegate_context: null,
    action: adminBackendAuditPlaceholder('admin.template_published_via_review_workflow'),
    category: 'A',
    audit_sensitivity_level: 'standard',
    resource_type: 'forms_template_admin_review',
    resource_id: args.reviewId,
    detail: {
      review_id: args.reviewId,
      forms_template_id: args.formsTemplateId,
      decider_principal_id: args.deciderPrincipalId,
    },
    engine_versions: null,
    ai_workload_type: null,
    autonomy_level: null,
    agent_id: null,
    agent_version: null,
    tool_call_id: null,
    memory_read_set_id: null,
    memory_write_set_id: null,
    supervising_policy_id: null,
    knowledge_source_versions: null,
    signals: null,
    override: null,
    linked_events: [],
    compliance_flags: [],
    country_of_care: args.countryOfCare,
    break_glass: null,
  };
  return emitAudit(envelope, tx);
}
