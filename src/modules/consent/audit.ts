/**
 * consent/audit.ts — module-specific audit envelope emitters.
 *
 * Wraps `lib/audit.ts emitAudit()` for Consent slice lifecycle events
 * per Consent Slice PRD v1.0 §10:
 *   - consent.granted
 *   - consent.revoked
 *   - delegation.invited
 *   - delegation.accepted
 *   - delegation.declined
 *   - delegation.revoked
 *   - delegation.scope_granted
 *   - delegation.scope_revoked
 *
 * SPEC ISSUE: AUDIT_EVENTS v5.2 does NOT enumerate canonical action IDs
 * for these events. Same placeholder pattern as identity/audit.ts +
 * forms-intake/audit.ts — single sanctioned `as AuditAction` cast site
 * via `consentAuditPlaceholder()`.
 *
 * Spec references:
 *   - Consent Slice PRD v1.0 §10 (audit emission requirements)
 *   - I-003 (audit append-only; bare suppression forbidden)
 *   - I-027 (every audit record carries tenant_id)
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

import type {
  ConsentId,
  ConsentType,
  DelegationId,
  DelegationScope,
  DelegationScopeId,
} from './internal/types.js';

// ---------------------------------------------------------------------------
// Placeholder action ID union
// ---------------------------------------------------------------------------

type ConsentAuditActionPlaceholder =
  | 'consent_granted'
  | 'consent_revoked'
  | 'delegation_invited'
  | 'delegation_accepted'
  | 'delegation_declined'
  | 'delegation_revoked'
  | 'delegation_scope_granted'
  | 'delegation_scope_revoked';

function consentAuditPlaceholder(id: ConsentAuditActionPlaceholder): AuditAction {
  return id as AuditAction;
}

// ---------------------------------------------------------------------------
// Common envelope builder
// ---------------------------------------------------------------------------

interface ConsentAuditCommon {
  tenant_id: TenantId;
  actor_type: 'patient' | 'delegate' | 'system' | 'operator';
  actor_id: string;
  actor_tenant_id: string | null;
  target_patient_id: AccountId | string | null;
  country_of_care: string;
  resource_type: string;
  resource_id: string;
  detail: Record<string, unknown>;
}

function buildEnvelope(
  action: AuditAction,
  category: 'A' | 'B' | 'C',
  common: ConsentAuditCommon,
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
// Consent lifecycle emitters
// ---------------------------------------------------------------------------

export async function emitConsentGrantedAudit(
  args: {
    tenantId: TenantId;
    accountId: AccountId;
    consentId: ConsentId;
    actorId: string;
    countryOfCare: string;
    consentType: ConsentType;
    scopeId: string | null;
    consentVersionId: string;
  },
  tx: AuditDbClient,
): Promise<AuditEnvelope> {
  return emitAudit(
    buildEnvelope(consentAuditPlaceholder('consent_granted'), 'C', {
      tenant_id: args.tenantId,
      actor_type: 'patient',
      actor_id: args.actorId,
      actor_tenant_id: args.tenantId,
      target_patient_id: args.accountId,
      country_of_care: args.countryOfCare,
      resource_type: 'consent',
      resource_id: args.consentId,
      detail: {
        consent_type: args.consentType,
        scope_id: args.scopeId,
        consent_version_id: args.consentVersionId,
      },
    }),
    tx,
  );
}

export async function emitConsentRevokedAudit(
  args: {
    tenantId: TenantId;
    accountId: AccountId;
    consentId: ConsentId;
    actorId: string;
    countryOfCare: string;
    consentType: ConsentType;
    scopeId: string | null;
    revocationReason: string;
  },
  tx: AuditDbClient,
): Promise<AuditEnvelope> {
  return emitAudit(
    buildEnvelope(consentAuditPlaceholder('consent_revoked'), 'C', {
      tenant_id: args.tenantId,
      actor_type: 'patient',
      actor_id: args.actorId,
      actor_tenant_id: args.tenantId,
      target_patient_id: args.accountId,
      country_of_care: args.countryOfCare,
      resource_type: 'consent',
      resource_id: args.consentId,
      detail: {
        consent_type: args.consentType,
        scope_id: args.scopeId,
        revocation_reason: args.revocationReason,
      },
    }),
    tx,
  );
}

// ---------------------------------------------------------------------------
// Delegation lifecycle emitters
// ---------------------------------------------------------------------------

export async function emitDelegationInvitedAudit(
  args: {
    tenantId: TenantId;
    grantorAccountId: AccountId;
    delegateAccountId: AccountId;
    delegationId: DelegationId;
    actorId: string;
    countryOfCare: string;
    relationshipType: string;
  },
  tx: AuditDbClient,
): Promise<AuditEnvelope> {
  return emitAudit(
    buildEnvelope(consentAuditPlaceholder('delegation_invited'), 'C', {
      tenant_id: args.tenantId,
      actor_type: 'patient',
      actor_id: args.actorId,
      actor_tenant_id: args.tenantId,
      target_patient_id: args.grantorAccountId,
      country_of_care: args.countryOfCare,
      resource_type: 'delegation',
      resource_id: args.delegationId,
      detail: {
        delegate_account_id: args.delegateAccountId,
        relationship_type: args.relationshipType,
      },
    }),
    tx,
  );
}

export async function emitDelegationAcceptedAudit(
  args: {
    tenantId: TenantId;
    grantorAccountId: AccountId;
    delegateAccountId: AccountId;
    delegationId: DelegationId;
    actorId: string;
    countryOfCare: string;
  },
  tx: AuditDbClient,
): Promise<AuditEnvelope> {
  return emitAudit(
    buildEnvelope(consentAuditPlaceholder('delegation_accepted'), 'C', {
      tenant_id: args.tenantId,
      actor_type: 'delegate',
      actor_id: args.actorId,
      actor_tenant_id: args.tenantId,
      target_patient_id: args.grantorAccountId,
      country_of_care: args.countryOfCare,
      resource_type: 'delegation',
      resource_id: args.delegationId,
      detail: {
        delegate_account_id: args.delegateAccountId,
      },
    }),
    tx,
  );
}

export async function emitDelegationDeclinedAudit(
  args: {
    tenantId: TenantId;
    grantorAccountId: AccountId;
    delegateAccountId: AccountId;
    delegationId: DelegationId;
    actorId: string;
    countryOfCare: string;
  },
  tx: AuditDbClient,
): Promise<AuditEnvelope> {
  return emitAudit(
    buildEnvelope(consentAuditPlaceholder('delegation_declined'), 'C', {
      tenant_id: args.tenantId,
      actor_type: 'delegate',
      actor_id: args.actorId,
      actor_tenant_id: args.tenantId,
      target_patient_id: args.grantorAccountId,
      country_of_care: args.countryOfCare,
      resource_type: 'delegation',
      resource_id: args.delegationId,
      detail: {
        delegate_account_id: args.delegateAccountId,
      },
    }),
    tx,
  );
}

export async function emitDelegationRevokedAudit(
  args: {
    tenantId: TenantId;
    grantorAccountId: AccountId;
    delegationId: DelegationId;
    actorId: string;
    countryOfCare: string;
    reason: string;
  },
  tx: AuditDbClient,
): Promise<AuditEnvelope> {
  return emitAudit(
    buildEnvelope(consentAuditPlaceholder('delegation_revoked'), 'C', {
      tenant_id: args.tenantId,
      actor_type: 'patient',
      actor_id: args.actorId,
      actor_tenant_id: args.tenantId,
      target_patient_id: args.grantorAccountId,
      country_of_care: args.countryOfCare,
      resource_type: 'delegation',
      resource_id: args.delegationId,
      detail: {
        revoked_reason: args.reason,
      },
    }),
    tx,
  );
}

// ---------------------------------------------------------------------------
// Delegation scope emitters
// ---------------------------------------------------------------------------

export async function emitDelegationScopeGrantedAudit(
  args: {
    tenantId: TenantId;
    grantorAccountId: AccountId;
    delegationId: DelegationId;
    delegationScopeId: DelegationScopeId;
    actorId: string;
    countryOfCare: string;
    scope: DelegationScope;
  },
  tx: AuditDbClient,
): Promise<AuditEnvelope> {
  return emitAudit(
    buildEnvelope(consentAuditPlaceholder('delegation_scope_granted'), 'C', {
      tenant_id: args.tenantId,
      actor_type: 'patient',
      actor_id: args.actorId,
      actor_tenant_id: args.tenantId,
      target_patient_id: args.grantorAccountId,
      country_of_care: args.countryOfCare,
      resource_type: 'delegation_scope',
      resource_id: args.delegationScopeId,
      detail: {
        delegation_id: args.delegationId,
        scope: args.scope,
      },
    }),
    tx,
  );
}

export async function emitDelegationScopeRevokedAudit(
  args: {
    tenantId: TenantId;
    grantorAccountId: AccountId;
    delegationId: DelegationId;
    delegationScopeId: DelegationScopeId;
    actorId: string;
    countryOfCare: string;
    scope: DelegationScope;
  },
  tx: AuditDbClient,
): Promise<AuditEnvelope> {
  return emitAudit(
    buildEnvelope(consentAuditPlaceholder('delegation_scope_revoked'), 'C', {
      tenant_id: args.tenantId,
      actor_type: 'patient',
      actor_id: args.actorId,
      actor_tenant_id: args.tenantId,
      target_patient_id: args.grantorAccountId,
      country_of_care: args.countryOfCare,
      resource_type: 'delegation_scope',
      resource_id: args.delegationScopeId,
      detail: {
        delegation_id: args.delegationId,
        scope: args.scope,
      },
    }),
    tx,
  );
}
