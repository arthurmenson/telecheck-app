/**
 * med-interaction/audit.ts — module-specific audit envelope emitters for the
 *                            Med-Interaction (SI-019) slice.
 *
 * **PR 8 of N — FIRST WRITE-HANDLER PR ESTABLISHES THE CAT A AUDIT PATTERN
 * FOR THE SLICE.**
 *
 * Wraps `lib/audit.ts emitAudit()` for the SI-019 §6 audit catalog:
 *   - interaction_engine_evaluation_completed (Cat A) — emitted when an
 *     engine evaluation completes (success or no-signals)
 *   - interaction_signal_emitted (Cat A) — emitted per signal produced
 *   - interaction_signal_lifecycle_transition_emitted (Cat A) — emitted on
 *     every lifecycle transition (activation, supersession, etc.) per
 *     SI-019 Sub-decision 3 item 5 (Option A add 2026-05-20)
 *
 * **CANONICAL LIFECYCLE AUDIT RULE (R1 Finding 2 closure 2026-05-23):**
 *
 *   The SI-019 lifecycle has multiple write surfaces. The rule below pins
 *   which audit events fire from which handler, in what order, so future
 *   handlers (override, resolve, expire, supersede) follow the same
 *   pattern and tests assert the exact event-emitter call sequence.
 *
 *   Per-handler audit-emission contract:
 *
 *     POST /v0/med-interaction/evaluations         (create-evaluation):
 *       emits EXACTLY ONE audit event:
 *         1. interaction_engine_evaluation_completed
 *       — fires AFTER the INSERT INTO interaction_engine_evaluation
 *         succeeds, in the same transaction. No other audit events.
 *
 *     POST /v0/med-interaction/signals              (emit-signal):
 *       emits EXACTLY ONE audit event:
 *         1. interaction_signal_emitted
 *       — fires AFTER the SECDEF wrapper `record_signal_emission` returns,
 *         in the same transaction. The initial `none → emitted` lifecycle
 *         transition row that `record_signal_emission` INSERTs is NOT
 *         separately attested by an `interaction_signal_lifecycle_transition_emitted`
 *         event — the `interaction_signal_emitted` event carries the same
 *         evidence (signal_id, evaluation_id, severity, check_class).
 *         Double-attesting the initial transition would inflate the audit
 *         chain without adding evidence. (See `emitSignalLifecycleTransitionAudit`
 *         docstring below for the formal statement of this carve-out.)
 *
 *     POST /v0/med-interaction/signals/:id/activate (activate-signal):
 *       emits EXACTLY ONE audit event:
 *         1. interaction_signal_lifecycle_transition_emitted
 *            (from_state='emitted', to_state='active', reason='activation')
 *       — fires AFTER the SECDEF wrapper `record_signal_activation` returns,
 *         in the same transaction.
 *
 *   **PR 9 handlers (supersede / override / resolve / expire — shipped in
 *   the PR 8/PR 9 merge) follow the same one-event-per-handler rule, with
 *   an audit-on-rejection variant for the fail-closed wrappers (I-003
 *   bare-suppression-forbidden — the rejected attempt belongs in the
 *   audit chain):**
 *
 *     POST /v0/med-interaction/signals/:id/supersede (OPERATIONAL):
 *       emits EXACTLY ONE audit event:
 *         1. interaction_signal_lifecycle_transition_emitted
 *            (from_state='active', to_state='superseded', reason='supersession')
 *       — fires AFTER the SECDEF wrapper `record_signal_supersession`
 *         (migration 050 §3) returns, in the same transaction.
 *
 *     POST /v0/med-interaction/signals/:id/resolve (FAIL-CLOSED at v0.1):
 *       emits EXACTLY ONE audit event:
 *         1. interaction_signal_lifecycle_transition_emitted
 *            — operational path (when the wrapper unblocks):
 *              (from_state='active', to_state='resolved', reason='resolution')
 *            — rejection path (current fail-closed wrapper, 0A000/42501):
 *              (from_state='active', to_state='rejected',
 *               reason='resolve_rejected_{feature_not_supported|execute_not_granted}')
 *              emitted in the same tx as the failed wrapper call, then the
 *              error is re-thrown to the tenant-blind 503 mapper (I-025).
 *
 *     POST /v0/med-interaction/signals/:id/expire (FAIL-CLOSED at v0.1):
 *       emits EXACTLY ONE audit event:
 *         1. interaction_signal_lifecycle_transition_emitted
 *            — operational path:
 *              (from_state='active', to_state='expired', reason='expiry')
 *            — rejection path (current fail-closed wrapper, 0A000):
 *              (from_state='active', to_state='rejected',
 *               reason='expire_rejected_feature_not_supported_cadence_config_missing')
 *
 *     POST /v0/med-interaction/signals/:id/override (FAIL-CLOSED at v0.1):
 *       at v0.1 emits EXACTLY ONE audit event:
 *         1. interaction_signal_lifecycle_transition_emitted
 *            — operational path (once the wrapper unblocks):
 *              (from_state='active', to_state='overridden', reason='override')
 *            — rejection path (current fail-closed wrapper, 0A000):
 *              (from_state='active', to_state='rejected',
 *               reason='override_rejected_feature_not_supported_evidence_source_missing')
 *       — **forward contract:** when the override wrapper turns operational
 *         (KMS envelope wiring + SI-024.1 JWT-binding evidence source), the
 *         override handler becomes the ONLY handler that emits TWO audit
 *         events: the canonical `interaction_signal_override` attestation
 *         (AUDIT_EVENTS v5.3 line 151 event — NOT a placeholder) FIRST (it
 *         documents the cause), then the lifecycle transition (it documents
 *         the effect on the state machine). Both in the same tx. Until
 *         then, no interaction_signal_override row is inserted (the
 *         wrapper RAISEs 0A000 before any write), so only the rejection
 *         lifecycle attestation fires.
 *
 *   Tests in the PR 8 + PR 9 series assert the exact emitter-function call
 *   sequence per handler (`auditCalls` mock log shape). Subsequent PRs
 *   that touch these handlers MUST update both the rule above + the
 *   assertion tests if the per-handler audit-event set changes; drift
 *   between the rule and the tests is a defect.
 *
 * The `interaction_signal_override` action ID is already enumerated in the
 * canonical Category A audit catalog (`src/lib/audit.ts`) and is consumed by
 * the override handler when PR 10 lands. The 3 IDs above are NOT yet
 * enumerated in the canonical catalog and are realized as placeholders via
 * the same sanctioned `as AuditAction` cast pattern used by consent/audit.ts
 * + identity/audit.ts + forms-intake/audit.ts. Spec ratification of these
 * IDs into AUDIT_EVENTS v5.9 canonical enum is tracked as an SI follow-on
 * (per the SI-019 §6 catalog enumeration above).
 *
 * **Same-transaction durability contract (carryforward from Option 2):**
 *   The audit emission MUST run in the same DB transaction as the SECDEF
 *   wrapper INSERT it attests to — so a partial commit cannot leave a
 *   wrapper effect without its audit record, and an audit-INSERT failure
 *   rolls back the wrapper effect too. Callers MUST pass `tx` (the
 *   transaction handle from `withTransaction`); `lib/audit.ts emitAudit()`
 *   throws in non-test environments when `tx` is omitted (I-003
 *   bare-suppression-forbidden).
 *
 * **AI workload taxonomy (ADR-029 + WORKLOAD_TAXONOMY v5.2):**
 *   The interaction engine itself is a `clinical_decision_support` workload
 *   class at `advisory` autonomy (the clinician decides; the engine signals).
 *   The override action is at `action_with_confirm` (clinician confirmation
 *   required) but is captured under the existing `interaction_signal_override`
 *   action which has its own taxonomy rules per AUDIT_EVENTS v5.3. The 3
 *   events emitted here are signal-lifecycle attestations, not I-012
 *   action-class records, so they carry `ai_workload_type: null` +
 *   `autonomy_level: null` (the canonical-catalog write-side
 *   `interaction_engine_evaluation` Cat A event uses the same nullable
 *   pattern in `src/lib/audit.ts` line 162).
 *
 * Spec references:
 *   - SI-019 Slice PRD v2.0 §6 (audit catalog enumeration)
 *   - SI-019 Sub-decision 3 (DOMAIN_EVENTS + audit IDs, Option A add)
 *   - CDM v1.6 → v1.7 Amendment §6.NEW2-NEW7 (wrapper signatures these
 *     audit events attest to)
 *   - I-003 (audit append-only; bare suppression forbidden)
 *   - I-027 (every audit record carries tenant_id)
 *   - AUDIT_EVENTS v5.3 (envelope shape; I-012 closure rule)
 *   - Consent/Identity/Forms-Intake audit.ts (placeholder cast precedent)
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
// Placeholder action ID union (sanctioned `as AuditAction` cast site).
// These IDs are cataloged in SI-019 §6 but not yet enumerated in the
// canonical AUDIT_EVENTS v5.3 enum in src/lib/audit.ts. The cast is the
// single sanctioned site for the slice; same pattern as consent/audit.ts
// `consentAuditPlaceholder()`.
// ---------------------------------------------------------------------------

type MedInteractionAuditActionPlaceholder =
  | 'interaction_engine_evaluation_completed'
  | 'interaction_signal_emitted'
  | 'interaction_signal_lifecycle_transition_emitted';

function medInteractionAuditPlaceholder(id: MedInteractionAuditActionPlaceholder): AuditAction {
  return id as AuditAction;
}

// ---------------------------------------------------------------------------
// Common envelope builder. Mirrors the consent/audit.ts shape — keeps the
// boilerplate concentrated so each per-event emitter is just (a) build
// detail + (b) call buildEnvelope + (c) emitAudit(tx).
// ---------------------------------------------------------------------------

interface MedInteractionAuditCommon {
  tenant_id: TenantId;
  actor_type:
    | 'clinician'
    | 'system' // engine-driven emission completes
    | 'ai_workload' // engine as autonomous actor (clinical_decision_support workload)
    | 'platform_admin';
  actor_id: string;
  actor_tenant_id: string | null;
  target_patient_id: string | null;
  country_of_care: string;
  resource_type: string;
  resource_id: string;
  detail: Record<string, unknown>;
}

function buildEnvelope(
  action: AuditAction,
  category: 'A' | 'B' | 'C',
  common: MedInteractionAuditCommon,
): AuditEnvelopeInput {
  return {
    timestamp: new Date().toISOString(),
    tenant_id: common.tenant_id,
    actor_type: common.actor_type,
    actor_id: common.actor_id,
    actor_tenant_id: common.actor_tenant_id,
    target_patient_id: common.target_patient_id,
    delegate_context: null,
    action,
    category,
    audit_sensitivity_level: 'standard',
    resource_type: common.resource_type,
    resource_id: common.resource_id,
    detail: common.detail,
    engine_versions: null,
    // The 3 lifecycle/evaluation events emitted here are signal-state
    // attestations, not I-012 action-class records (which would require
    // ai_workload_type + autonomy_level per the I-012 closure rule). The
    // existing canonical `interaction_engine_evaluation` Cat A event in
    // src/lib/audit.ts uses the same nullable pattern at line 162.
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
    country_of_care: common.country_of_care,
    break_glass: null,
  };
}

// ---------------------------------------------------------------------------
// Cat A — interaction_engine_evaluation_completed
//
// Emitted by POST /v0/med-interaction/evaluations when a new
// interaction_engine_evaluation row is INSERTed. Attests to the engine
// run (triggered by prescribing / refill / protocol_gate / manual /
// lab_update / adverse_event_investigation) that produced the evaluation
// row + downstream signals (signals are attested individually via the
// interaction_signal_emitted event below).
// ---------------------------------------------------------------------------

export async function emitEvaluationCompletedAudit(
  args: {
    tenantId: TenantId;
    evaluationId: string;
    patientId: string | null;
    actorId: string;
    actorTenantId: string;
    countryOfCare: string;
    triggeredBy: string;
    triggeredByResourceId: string;
    engineVersion: string;
    knowledgeBaseVersion: string;
    /**
     * Latency observability — milliseconds between handler entry and
     * evaluation row commit. Mirrors the `duration_ms` field on the
     * canonical `interaction_engine_evaluation` Cat A event in
     * AUDIT_EVENTS v5.3 line 162. Server-computed; not body-supplied.
     * Required (>= 0) per migration 047 §1 CHECK constraint on the
     * column this audit attests to.
     */
    evaluationWindowMs: number;
    signalsProducedCount: number;
  },
  tx: AuditDbClient,
): Promise<AuditEnvelope> {
  return emitAudit(
    buildEnvelope(medInteractionAuditPlaceholder('interaction_engine_evaluation_completed'), 'A', {
      tenant_id: args.tenantId,
      actor_type: 'clinician',
      actor_id: args.actorId,
      actor_tenant_id: args.actorTenantId,
      target_patient_id: args.patientId,
      country_of_care: args.countryOfCare,
      resource_type: 'interaction_engine_evaluation',
      resource_id: args.evaluationId,
      detail: {
        triggered_by: args.triggeredBy,
        triggered_by_resource_id: args.triggeredByResourceId,
        engine_version: args.engineVersion,
        knowledge_base_version: args.knowledgeBaseVersion,
        evaluation_window_ms: args.evaluationWindowMs,
        signals_produced_count: args.signalsProducedCount,
      },
    }),
    tx,
  );
}

// ---------------------------------------------------------------------------
// Cat A — interaction_signal_emitted
//
// Emitted by POST /v0/med-interaction/signals on successful call to the
// SECDEF wrapper `record_signal_emission(...)`. One audit record per
// signal (one-to-one with `interaction_signal` row). The signal_id
// references the just-INSERTed row; the lifecycle transition
// (`none → emitted`) is attested by the separate lifecycle event below.
// ---------------------------------------------------------------------------

export async function emitSignalEmittedAudit(
  args: {
    tenantId: TenantId;
    signalId: string;
    evaluationId: string;
    patientId: string | null;
    actorId: string;
    actorTenantId: string;
    countryOfCare: string;
    checkClass: string;
    severity: string;
    recommendedAction: string;
  },
  tx: AuditDbClient,
): Promise<AuditEnvelope> {
  return emitAudit(
    buildEnvelope(medInteractionAuditPlaceholder('interaction_signal_emitted'), 'A', {
      tenant_id: args.tenantId,
      actor_type: 'clinician',
      actor_id: args.actorId,
      actor_tenant_id: args.actorTenantId,
      target_patient_id: args.patientId,
      country_of_care: args.countryOfCare,
      resource_type: 'interaction_signal',
      resource_id: args.signalId,
      detail: {
        evaluation_id: args.evaluationId,
        check_class: args.checkClass,
        severity: args.severity,
        recommended_action: args.recommendedAction,
      },
    }),
    tx,
  );
}

// ---------------------------------------------------------------------------
// Cat A — interaction_signal_lifecycle_transition_emitted
//
// Emitted by every handler that calls a lifecycle SECDEF wrapper that
// inserts a new `interaction_signal_lifecycle_transition` row:
//   - POST /v0/med-interaction/signals/:id/activate (emitted → active)
//   - POST /v0/med-interaction/signals/:id/supersede (active → superseded)
//   - POST /v0/med-interaction/signals/:id/resolve (active → resolved;
//     wrapper FAIL-CLOSED at v0.1 — rejection path attested with
//     to_state='rejected' per I-003 bare-suppression-forbidden)
//   - POST /v0/med-interaction/signals/:id/expire (active → expired;
//     wrapper FAIL-CLOSED at v0.1 — rejection path attested)
//   - POST /v0/med-interaction/signals/:id/override (active → overridden;
//     wrapper FAIL-CLOSED at v0.1 — rejection path attested)
//
// **Formal initial-emission carve-out (R1 Finding 2 closure 2026-05-23):**
//   The initial `none → emitted` transition row INSERTed atomically by
//   `record_signal_emission` (migration 050 §1) is NOT separately attested
//   by this event. The `interaction_signal_emitted` event above carries
//   the same evidence (signal_id, evaluation_id, severity, check_class)
//   AND is the canonical surface that downstream consumers (projection
//   refresher; patient-facing signal-list push surface) read for
//   "this signal exists." Emitting a paired `..._lifecycle_transition_emitted`
//   event on initial emission would (a) double-attest the same business
//   evidence in the audit chain and (b) force every consumer to dedupe
//   the (interaction_signal_emitted, lifecycle_transition_emitted) pair
//   on every emission. The carve-out is enforced by the per-handler
//   audit-emission contract — emit-signal.ts emits ONLY
//   interaction_signal_emitted; only the *non-initial* lifecycle
//   transitions (activate, supersede, resolve, expire, override) emit
//   this event. The override-driven `active → overridden` transition
//   is ALSO attested by the canonical `interaction_signal_override`
//   event (AUDIT_EVENTS v5.3 line 151) per the override-handler two-event
//   forward contract documented in the file-level CANONICAL LIFECYCLE
//   AUDIT RULE (binding once the override wrapper turns operational; at
//   v0.1 the fail-closed wrapper RAISEs 0A000 before any write, so only
//   the rejection lifecycle attestation fires).
// ---------------------------------------------------------------------------

export async function emitSignalLifecycleTransitionAudit(
  args: {
    tenantId: TenantId;
    signalId: string;
    transitionId: string;
    patientId: string | null;
    actorId: string;
    actorTenantId: string;
    countryOfCare: string;
    fromState: string;
    toState: string;
    transitionReason: string;
  },
  tx: AuditDbClient,
): Promise<AuditEnvelope> {
  return emitAudit(
    buildEnvelope(
      medInteractionAuditPlaceholder('interaction_signal_lifecycle_transition_emitted'),
      'A',
      {
        tenant_id: args.tenantId,
        actor_type: 'clinician',
        actor_id: args.actorId,
        actor_tenant_id: args.actorTenantId,
        target_patient_id: args.patientId,
        country_of_care: args.countryOfCare,
        resource_type: 'interaction_signal_lifecycle_transition',
        resource_id: args.transitionId,
        detail: {
          signal_id: args.signalId,
          from_state: args.fromState,
          to_state: args.toState,
          transition_reason: args.transitionReason,
        },
      },
    ),
    tx,
  );
}
