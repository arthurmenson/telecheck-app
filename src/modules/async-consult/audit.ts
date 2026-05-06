/**
 * async-consult/audit.ts — module-specific audit envelope emitters.
 *
 * Wraps `lib/audit.ts emitAudit()` for Async Consult slice lifecycle
 * events per Async Consult Slice PRD v1.0 §13 + State Machines v1.1
 * §3 transitions implemented at Sprint 9 (TLC-021c):
 *
 *   - consult.initiated         (transition 1: INITIATED → INTAKE; emitted at initiate)
 *   - consult.intake_submitted  (transition 2: INTAKE → SUBMITTED; emitted at submit)
 *   - consult.abandoned         (transition 3: INTAKE → ABANDONED; emitted at abandon)
 *   - consult.expired           (transition 5: ABANDONED → EXPIRED; scaffolded — call
 *                                 site deferred to Sprint 11+ scheduled `expire` job)
 *
 * SPEC ISSUE: AUDIT_EVENTS v5.2 does NOT enumerate canonical action IDs
 * for these events. Same placeholder pattern as identity/audit.ts +
 * forms-intake/audit.ts + consent/audit.ts — single sanctioned
 * `as AuditAction` cast site via `asyncConsultAuditPlaceholder()`.
 *
 * SI-004 closure path: when AUDIT_EVENTS v5.2 ratifies consult.* event
 * names, replace placeholder strings with canonical names (string
 * replace; trivial if names match verbatim).
 *
 * Spec references:
 *   - Async Consult Slice PRD v1.0 §13 (audit emission requirements)
 *   - State Machines v1.1 §3 (transition vocabulary)
 *   - I-003 (audit append-only; bare suppression forbidden)
 *   - I-027 (every audit record carries tenant_id)
 *   - docs/SI-004-Async-Consult-Audit-Events-Ratification.md (resume gate)
 */

import {
  type AuditAction,
  type AuditDbClient,
  type AuditEnvelope,
  type AuditEnvelopeInput,
  emitAudit,
} from '../../lib/audit.js';
import type { TenantId } from '../../lib/glossary.js';
import type { AccountId } from '../identity/internal/types.js';

import type { ConsultId, ConsultType, ConsultModality } from './internal/types.js';

// ---------------------------------------------------------------------------
// Placeholder action ID union (per SI-004)
// ---------------------------------------------------------------------------

type AsyncConsultAuditActionPlaceholder =
  | 'consult_initiated'
  | 'consult_intake_submitted'
  | 'consult_abandoned'
  | 'consult_expired';

function asyncConsultAuditPlaceholder(id: AsyncConsultAuditActionPlaceholder): AuditAction {
  return id as AuditAction;
}

// ---------------------------------------------------------------------------
// Common envelope builder
// ---------------------------------------------------------------------------

interface AsyncConsultAuditCommon {
  tenant_id: TenantId;
  actor_type: 'patient' | 'delegate' | 'system' | 'operator';
  actor_id: string;
  actor_tenant_id: string | null;
  target_patient_id: AccountId | string | null;
  country_of_care: string;
  resource_id: string;
  detail: Record<string, unknown>;
}

function buildEnvelope(
  action: AuditAction,
  category: 'A' | 'B' | 'C',
  common: AsyncConsultAuditCommon,
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
    resource_type: 'consult',
    resource_id: common.resource_id,
    detail: common.detail,
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
    country_of_care: common.country_of_care,
    break_glass: null,
  };
}

// ---------------------------------------------------------------------------
// Lifecycle emitters (4 events; Sprint 9 supported transitions only)
// ---------------------------------------------------------------------------

/**
 * Emit `consult.initiated` audit event for transition 1
 * (INITIATED → INTAKE on `start_intake` event).
 *
 * Category C (lifecycle event; not Category A safety-critical or
 * Category B governance — patient-initiated workflow start).
 */
export async function emitConsultInitiatedAudit(
  args: {
    tenantId: TenantId;
    accountId: AccountId;
    consultId: ConsultId;
    actorId: string;
    countryOfCare: string;
    consultType: ConsultType;
    modality: ConsultModality;
    currentProgramCatalogEntryId: string | null;
  },
  tx: AuditDbClient,
): Promise<AuditEnvelope> {
  return emitAudit(
    buildEnvelope(asyncConsultAuditPlaceholder('consult_initiated'), 'C', {
      tenant_id: args.tenantId,
      actor_type: 'patient',
      actor_id: args.actorId,
      actor_tenant_id: args.tenantId,
      target_patient_id: args.accountId,
      country_of_care: args.countryOfCare,
      resource_id: args.consultId,
      detail: {
        consult_type: args.consultType,
        modality: args.modality,
        current_program_catalog_entry_id: args.currentProgramCatalogEntryId,
      },
    }),
    tx,
  );
}

/**
 * Emit `consult.intake_submitted` audit event for transition 2
 * (INTAKE → SUBMITTED on `submit` event).
 */
export async function emitConsultIntakeSubmittedAudit(
  args: {
    tenantId: TenantId;
    accountId: AccountId;
    consultId: ConsultId;
    actorId: string;
    countryOfCare: string;
    intakeFormSubmissionId: string;
  },
  tx: AuditDbClient,
): Promise<AuditEnvelope> {
  return emitAudit(
    buildEnvelope(asyncConsultAuditPlaceholder('consult_intake_submitted'), 'C', {
      tenant_id: args.tenantId,
      actor_type: 'patient',
      actor_id: args.actorId,
      actor_tenant_id: args.tenantId,
      target_patient_id: args.accountId,
      country_of_care: args.countryOfCare,
      resource_id: args.consultId,
      detail: {
        intake_form_submission_id: args.intakeFormSubmissionId,
      },
    }),
    tx,
  );
}

/**
 * Emit `consult.abandoned` audit event for transition 3
 * (INTAKE → ABANDONED on `abandon` event after 48h+ no activity).
 *
 * Actor type is 'system' because abandon is triggered by inactivity,
 * not an explicit patient action. The `hours_since_activity` detail
 * captures the elapsed time at the moment of transition.
 */
export async function emitConsultAbandonedAudit(
  args: {
    tenantId: TenantId;
    accountId: AccountId;
    consultId: ConsultId;
    countryOfCare: string;
    hoursSinceActivity: number;
  },
  tx: AuditDbClient,
): Promise<AuditEnvelope> {
  return emitAudit(
    buildEnvelope(asyncConsultAuditPlaceholder('consult_abandoned'), 'C', {
      tenant_id: args.tenantId,
      actor_type: 'system',
      actor_id: 'async-consult.scheduler',
      actor_tenant_id: args.tenantId,
      target_patient_id: args.accountId,
      country_of_care: args.countryOfCare,
      resource_id: args.consultId,
      detail: {
        hours_since_activity: args.hoursSinceActivity,
      },
    }),
    tx,
  );
}

/**
 * Emit `consult.expired` audit event for transition 5
 * (ABANDONED → EXPIRED on `expire` event after 14d+ no activity).
 *
 * Sprint 10 SCAFFOLDS this emitter; the call site (scheduled `expire`
 * job) is DEFERRED to Sprint 11+ per Async Consult Slice PRD §12 +
 * State Machines §3 (action: "Archive, refund payment"). Refund
 * orchestration depends on Payment slice authoring — separate work.
 */
export async function emitConsultExpiredAudit(
  args: {
    tenantId: TenantId;
    accountId: AccountId;
    consultId: ConsultId;
    countryOfCare: string;
    daysSinceAbandoned: number;
  },
  tx: AuditDbClient,
): Promise<AuditEnvelope> {
  return emitAudit(
    buildEnvelope(asyncConsultAuditPlaceholder('consult_expired'), 'C', {
      tenant_id: args.tenantId,
      actor_type: 'system',
      actor_id: 'async-consult.scheduler',
      actor_tenant_id: args.tenantId,
      target_patient_id: args.accountId,
      country_of_care: args.countryOfCare,
      resource_id: args.consultId,
      detail: {
        days_since_abandoned: args.daysSinceAbandoned,
      },
    }),
    tx,
  );
}
