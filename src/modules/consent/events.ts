/**
 * consent/events.ts — module-specific domain event emitters.
 *
 * Wraps `lib/domain-events.ts emitDomainEvent()` for the Consent slice
 * lifecycle events per Consent Slice PRD v1.0 §10 + Contracts Pack v5.2
 * DOMAIN_EVENTS:
 *   - consent.granted, consent.revoked
 *   - delegation.invited, delegation.accepted, delegation.declined,
 *     delegation.revoked
 *   - delegation.scope_granted, delegation.scope_revoked
 *
 * Events are emitted inside the SAME transaction as the audit emission
 * + the aggregate state change. Rollback discards all three together.
 *
 * SPEC ISSUE: DOMAIN_EVENTS v5.2 doesn't yet enumerate the canonical
 * event-type strings for these aggregates — same situation as the audit
 * placeholder pattern. SI-002 covers the audit-side ratification; a
 * parallel SI for DOMAIN_EVENTS will be raised once a consumer exists
 * that needs the precise contract.
 *
 * Spec references:
 *   - DOMAIN_EVENTS v5.2 (envelope shape; tenant-scoped partition key
 *     rules)
 *   - Consent Slice PRD v1.0 §10 (audit emission requirements; the
 *     domain-event surface mirrors the audit surface 1:1 at v1.0)
 *   - I-016 (domain events immutable; INSERT failure aborts the tx)
 *   - I-023 (every event carries tenant_id)
 */

import { emitDomainEvent, type DbTransaction } from '../../lib/domain-events.js';
import type { TenantId } from '../../lib/glossary.js';
import type { AccountId } from '../identity/internal/types.js';

import type {
  ConsentId,
  ConsentType,
  DelegationId,
  DelegationRelationshipType,
  DelegationRevocationReason,
  DelegationScope,
  DelegationScopeId,
} from './internal/types.js';

// ---------------------------------------------------------------------------
// Aggregate constants (DOMAIN_EVENTS v5.2 partition-key derivation)
// ---------------------------------------------------------------------------

const CONSENT_AGGREGATE = 'consent';
const DELEGATION_AGGREGATE = 'delegation';
const DELEGATION_SCOPE_AGGREGATE = 'delegation_scope';

// ---------------------------------------------------------------------------
// consent.granted / consent.revoked
// ---------------------------------------------------------------------------

export async function emitConsentGrantedDomainEvent(
  tx: DbTransaction,
  args: {
    tenantId: TenantId;
    consentId: ConsentId;
    accountId: AccountId;
    consentType: ConsentType;
    scopeId: string | null;
    consentVersionId: string;
    occurredAt: string;
  },
): Promise<void> {
  await emitDomainEvent(tx, {
    tenant_id: args.tenantId,
    aggregate_type: CONSENT_AGGREGATE,
    aggregate_id: args.consentId,
    event_type: 'consent.granted',
    payload: {
      consent_id: args.consentId,
      account_id: args.accountId,
      consent_type: args.consentType,
      scope_id: args.scopeId,
      consent_version_id: args.consentVersionId,
    },
    occurred_at: args.occurredAt,
  });
}

export async function emitConsentRevokedDomainEvent(
  tx: DbTransaction,
  args: {
    tenantId: TenantId;
    consentId: ConsentId;
    accountId: AccountId;
    consentType: ConsentType;
    scopeId: string | null;
    revocationReason: string;
    occurredAt: string;
  },
): Promise<void> {
  await emitDomainEvent(tx, {
    tenant_id: args.tenantId,
    aggregate_type: CONSENT_AGGREGATE,
    aggregate_id: args.consentId,
    event_type: 'consent.revoked',
    payload: {
      consent_id: args.consentId,
      account_id: args.accountId,
      consent_type: args.consentType,
      scope_id: args.scopeId,
      revocation_reason: args.revocationReason,
    },
    occurred_at: args.occurredAt,
  });
}

// ---------------------------------------------------------------------------
// delegation.invited / accepted / declined / revoked
// ---------------------------------------------------------------------------

export async function emitDelegationInvitedDomainEvent(
  tx: DbTransaction,
  args: {
    tenantId: TenantId;
    delegationId: DelegationId;
    grantorAccountId: AccountId;
    delegateAccountId: AccountId;
    relationshipType: DelegationRelationshipType;
    occurredAt: string;
  },
): Promise<void> {
  await emitDomainEvent(tx, {
    tenant_id: args.tenantId,
    aggregate_type: DELEGATION_AGGREGATE,
    aggregate_id: args.delegationId,
    event_type: 'delegation.invited',
    payload: {
      delegation_id: args.delegationId,
      grantor_account_id: args.grantorAccountId,
      delegate_account_id: args.delegateAccountId,
      relationship_type: args.relationshipType,
    },
    occurred_at: args.occurredAt,
  });
}

export async function emitDelegationAcceptedDomainEvent(
  tx: DbTransaction,
  args: {
    tenantId: TenantId;
    delegationId: DelegationId;
    grantorAccountId: AccountId;
    delegateAccountId: AccountId;
    occurredAt: string;
  },
): Promise<void> {
  await emitDomainEvent(tx, {
    tenant_id: args.tenantId,
    aggregate_type: DELEGATION_AGGREGATE,
    aggregate_id: args.delegationId,
    event_type: 'delegation.accepted',
    payload: {
      delegation_id: args.delegationId,
      grantor_account_id: args.grantorAccountId,
      delegate_account_id: args.delegateAccountId,
    },
    occurred_at: args.occurredAt,
  });
}

export async function emitDelegationDeclinedDomainEvent(
  tx: DbTransaction,
  args: {
    tenantId: TenantId;
    delegationId: DelegationId;
    grantorAccountId: AccountId;
    delegateAccountId: AccountId;
    occurredAt: string;
  },
): Promise<void> {
  await emitDomainEvent(tx, {
    tenant_id: args.tenantId,
    aggregate_type: DELEGATION_AGGREGATE,
    aggregate_id: args.delegationId,
    event_type: 'delegation.declined',
    payload: {
      delegation_id: args.delegationId,
      grantor_account_id: args.grantorAccountId,
      delegate_account_id: args.delegateAccountId,
    },
    occurred_at: args.occurredAt,
  });
}

export async function emitDelegationRevokedDomainEvent(
  tx: DbTransaction,
  args: {
    tenantId: TenantId;
    delegationId: DelegationId;
    grantorAccountId: AccountId;
    reason: DelegationRevocationReason;
    occurredAt: string;
  },
): Promise<void> {
  await emitDomainEvent(tx, {
    tenant_id: args.tenantId,
    aggregate_type: DELEGATION_AGGREGATE,
    aggregate_id: args.delegationId,
    event_type: 'delegation.revoked',
    payload: {
      delegation_id: args.delegationId,
      grantor_account_id: args.grantorAccountId,
      revoked_reason: args.reason,
    },
    occurred_at: args.occurredAt,
  });
}

// ---------------------------------------------------------------------------
// delegation.scope_granted / scope_revoked
// ---------------------------------------------------------------------------

export async function emitDelegationScopeGrantedDomainEvent(
  tx: DbTransaction,
  args: {
    tenantId: TenantId;
    delegationScopeId: DelegationScopeId;
    delegationId: DelegationId;
    scope: DelegationScope;
    occurredAt: string;
  },
): Promise<void> {
  await emitDomainEvent(tx, {
    tenant_id: args.tenantId,
    aggregate_type: DELEGATION_SCOPE_AGGREGATE,
    aggregate_id: args.delegationScopeId,
    event_type: 'delegation.scope_granted',
    payload: {
      delegation_scope_id: args.delegationScopeId,
      delegation_id: args.delegationId,
      scope: args.scope,
    },
    occurred_at: args.occurredAt,
  });
}

export async function emitDelegationScopeRevokedDomainEvent(
  tx: DbTransaction,
  args: {
    tenantId: TenantId;
    delegationScopeId: DelegationScopeId;
    delegationId: DelegationId;
    scope: DelegationScope;
    occurredAt: string;
  },
): Promise<void> {
  await emitDomainEvent(tx, {
    tenant_id: args.tenantId,
    aggregate_type: DELEGATION_SCOPE_AGGREGATE,
    aggregate_id: args.delegationScopeId,
    event_type: 'delegation.scope_revoked',
    payload: {
      delegation_scope_id: args.delegationScopeId,
      delegation_id: args.delegationId,
      scope: args.scope,
    },
    occurred_at: args.occurredAt,
  });
}
