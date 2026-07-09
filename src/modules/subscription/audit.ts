/**
 * subscription/audit.ts — module-specific audit envelope emitters.
 *
 * Wraps `lib/audit.ts emitAudit()` for the Subscription slice lifecycle
 * per State Machines v1.1 §15 ("Every transition produces an audit record
 * with tenant_id") + CDM v1.2 §4.8 ("Mirrored into AuditEvent … Category C
 * for operational events; Category A for switch approval and SAFETY_HOLD").
 *
 * SPEC ISSUE (placeholder-action pattern): AUDIT_EVENTS v5.x does NOT
 * enumerate canonical `subscription.*` action IDs (verified by corpus grep
 * 2026-07-08 — zero subscription rows in
 * Telecheck_Contracts_Pack_v5_00_AUDIT_EVENTS.md). Same sanctioned
 * placeholder pattern as identity/forms-intake/consent/async-consult
 * audit.ts (SI-002 umbrella; SI-004 precedent): a single `as AuditAction`
 * cast site via `subscriptionAuditPlaceholder()`. When AUDIT_EVENTS
 * ratifies subscription.* action IDs, replace the placeholder strings with
 * canonical names (string replace; trivial if names match verbatim).
 *
 * Category assignment per §15: switch approval + the SAFETY_HOLD family
 * (enter / release / clinician-terminate) are Category A; every other
 * transition is Category C.
 *
 * Spec references:
 *   - State Machines v1.1 §15 (emission-per-transition rule)
 *   - CDM v1.2 §4.8 (audit mirroring + categories)
 *   - I-003 (audit append-only; bare suppression forbidden)
 *   - I-027 (every audit record carries tenant_id)
 *   - docs/SI-002-AUDIT_EVENTS-Placeholder-Ratification.md (resume gate)
 */

import {
  type AuditAction,
  type AuditDbClient,
  type AuditEnvelope,
  type AuditEnvelopeInput,
  type ActorType,
  emitAudit,
} from '../../lib/audit.js';

import type { SubscriptionTransition } from './internal/state-machine.js';
import { TRANSITION_TABLE } from './internal/state-machine.js';
import type { SubscriptionActorType } from './internal/types.js';

// ---------------------------------------------------------------------------
// Placeholder action ID union (per SI-002 umbrella; §15 emission names with
// the module prefix flattened to the repo placeholder convention)
// ---------------------------------------------------------------------------

type SubscriptionAuditActionPlaceholder =
  | 'subscription_created'
  | 'subscription_activated'
  | 'subscription_declined'
  | 'subscription_period_end' // §15 side-effect emission is refill.initiated (Refill machine); this is the subscription-side trail
  | 'subscription_paused'
  | 'subscription_resumed'
  | 'subscription_pause_expired_cancelled'
  | 'subscription_switching_initiated'
  | 'subscription_switched'
  | 'subscription_switch_declined'
  | 'subscription_cancellation_pending'
  | 'subscription_cancelled'
  | 'subscription_fulfilled'
  | 'subscription_safety_hold'
  | 'subscription_released_from_safety_hold'
  | 'subscription_terminated_clinical'
  | 'subscription_terminated_payment_failure'
  | 'subscription_transition_rejected';

function subscriptionAuditPlaceholder(id: SubscriptionAuditActionPlaceholder): AuditAction {
  return id as AuditAction;
}

/** §15 transition → placeholder audit action. */
const TRANSITION_AUDIT_ACTION: Readonly<
  Record<SubscriptionTransition, SubscriptionAuditActionPlaceholder>
> = {
  clinician_approval: 'subscription_activated',
  clinician_decline: 'subscription_declined',
  period_end: 'subscription_period_end',
  pause_request: 'subscription_paused',
  switch_request: 'subscription_switching_initiated',
  cancel_request: 'subscription_cancellation_pending',
  safety_signal_critical: 'subscription_safety_hold',
  payment_failed_terminal: 'subscription_terminated_payment_failure',
  complete: 'subscription_fulfilled',
  resume: 'subscription_resumed',
  pause_expires: 'subscription_pause_expired_cancelled',
  switch_approve: 'subscription_switched',
  switch_decline: 'subscription_switch_declined',
  end_period: 'subscription_cancelled',
  clinician_release: 'subscription_released_from_safety_hold',
  clinician_terminate: 'subscription_terminated_clinical',
};

/** subscription_events actor_type → audit envelope ActorType. */
function toAuditActorType(actorType: SubscriptionActorType): ActorType {
  switch (actorType) {
    case 'patient':
      return 'patient';
    case 'clinician':
      return 'clinician';
    case 'system':
      return 'system';
    case 'tenant_operator':
      return 'operator';
    case 'platform_admin':
      return 'platform_admin';
  }
}

// ---------------------------------------------------------------------------
// Common envelope builder (async-consult buildEnvelope precedent)
// ---------------------------------------------------------------------------

export interface SubscriptionAuditCommon {
  tenantId: string;
  subscriptionId: string;
  patientId: string;
  actorType: SubscriptionActorType;
  /** SI-010 verified actor identity; 'system' for scheduler transitions. */
  actorId: string;
  actorTenantId: string | null;
  countryOfCare: string;
  detail: Record<string, unknown>;
}

function buildEnvelope(
  action: AuditAction,
  category: 'A' | 'C',
  common: SubscriptionAuditCommon,
): AuditEnvelopeInput {
  return {
    timestamp: new Date().toISOString(),
    tenant_id: common.tenantId as AuditEnvelopeInput['tenant_id'],
    actor_type: toAuditActorType(common.actorType),
    actor_id: common.actorId,
    actor_tenant_id: common.actorTenantId,
    target_patient_id: common.patientId,
    delegate_context: null,
    action,
    category,
    audit_sensitivity_level: 'standard',
    resource_type: 'subscription',
    resource_id: common.subscriptionId,
    detail: common.detail,
    engine_versions: null,
    // No AI participation on any subscription transition at v1.0 (Mode 2
    // protocol-authorized subscription approval is NOT ratified; switch is
    // always human-clinician-reviewed per §15).
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
    country_of_care: common.countryOfCare,
    break_glass: null,
  };
}

// ---------------------------------------------------------------------------
// Emitters
// ---------------------------------------------------------------------------

/**
 * Emit the audit record for DRAFT-row creation (`created` event; Category C).
 * Same-tx with the INSERT per the canonical composition (audit emitted AFTER
 * withDbRole returns, under the restored app role; a throw rolls the INSERT
 * back — I-003 bare suppression forbidden).
 */
export async function emitSubscriptionCreatedAudit(
  common: SubscriptionAuditCommon,
  tx: AuditDbClient,
): Promise<AuditEnvelope> {
  return emitAudit(
    buildEnvelope(subscriptionAuditPlaceholder('subscription_created'), 'C', common),
    tx,
  );
}

/**
 * Emit the audit record for a §15 state transition. Category comes from the
 * transition table (A for switch approval + SAFETY_HOLD family; C otherwise).
 */
export async function emitSubscriptionTransitionAudit(
  transition: SubscriptionTransition,
  common: SubscriptionAuditCommon,
  tx: AuditDbClient,
): Promise<AuditEnvelope> {
  const spec = TRANSITION_TABLE[transition];
  return emitAudit(
    buildEnvelope(
      subscriptionAuditPlaceholder(TRANSITION_AUDIT_ACTION[transition]),
      spec.auditCategory,
      common,
    ),
    tx,
  );
}

/**
 * Emit the REJECTION audit for a guard-failed transition attempt (I-003:
 * bare suppression on rejection is forbidden — rejected state-machine
 * attempts leave a trail). Category C (operational rejection; the request
 * never reached a Category A clinical surface).
 *
 * NOTE: emitted on the 409 INVALID_STATE_TRANSITION path only — malformed
 * requests (400) and tenant-blind 404s do not reach the state machine.
 */
export async function emitSubscriptionTransitionRejectedAudit(
  transition: SubscriptionTransition,
  common: SubscriptionAuditCommon,
  tx: AuditDbClient,
): Promise<AuditEnvelope> {
  return emitAudit(
    buildEnvelope(subscriptionAuditPlaceholder('subscription_transition_rejected'), 'C', {
      ...common,
      detail: {
        ...common.detail,
        rejected_transition: transition,
        rejection: 'invalid_state_transition',
      },
    }),
    tx,
  );
}
