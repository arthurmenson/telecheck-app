/**
 * delegation-service.ts — Delegation lifecycle orchestration with audit
 * emission.
 *
 * Per Consent Slice PRD v1.0 §6.1: delegation is a permission bridge
 * between two accounts, NOT an account hierarchy. A delegate cannot
 * delegate (chain prevention enforced at service layer here).
 *
 * Spec references:
 *   - Consent Slice PRD v1.0 §6
 *   - I-003 (audit append-only)
 *   - I-022 (consent UI clarity)
 */

import type { DbClient, DbTransaction } from '../../../../lib/db.js';
import { withTenantBoundConnection } from '../../../../lib/db.js';
import type { TenantContext } from '../../../../lib/tenant-context.js';
import { ulid } from '../../../../lib/ulid.js';
import type { AccountId } from '../../../identity/internal/types.js';
import {
  emitDelegationAcceptedAudit,
  emitDelegationDeclinedAudit,
  emitDelegationInvitedAudit,
  emitDelegationRevokedAudit,
  emitDelegationScopeGrantedAudit,
  emitDelegationScopeRevokedAudit,
} from '../../audit.js';
import {
  emitDelegationAcceptedDomainEvent,
  emitDelegationDeclinedDomainEvent,
  emitDelegationInvitedDomainEvent,
  emitDelegationRevokedDomainEvent,
  emitDelegationScopeGrantedDomainEvent,
  emitDelegationScopeRevokedDomainEvent,
} from '../../events.js';
import * as delegationRepo from '../repositories/delegation-repo.js';
import {
  asDelegationId,
  asDelegationScopeId,
  type Delegation,
  type DelegationId,
  type DelegationRelationshipType,
  type DelegationRevocationReason,
  type DelegationScope,
  type DelegationScopeId,
  type DelegationScopeRow,
  type DelegationVisibilityRestrictions,
} from '../types.js';

// ---------------------------------------------------------------------------
// Sentinel error codes
// ---------------------------------------------------------------------------

export const DELEGATION_CHAIN_FORBIDDEN = 'consent.delegation.chain_forbidden';
export const DELEGATION_SELF_FORBIDDEN = 'consent.delegation.self_forbidden';

// ---------------------------------------------------------------------------
// InviteDelegateInput
// ---------------------------------------------------------------------------

export interface InviteDelegateInput {
  grantor_account_id: AccountId;
  delegate_account_id: AccountId;
  relationship_type: DelegationRelationshipType;
  legal_documentation_id?: string | null;
}

/**
 * Patient invites a delegate. Creates a delegation row in
 * pending_acceptance status; the delegate must accept it via a
 * separate flow.
 *
 * Service-layer enforces:
 *   - Self-delegation forbidden (DB CHECK also rejects, but service
 *     emits a more useful sentinel)
 *   - Chain prevention per Slice PRD §6.1: if the grantor is
 *     themselves an active delegate of someone else, refuse the
 *     invitation. (DB-level enforcement requires a recursive query;
 *     service-layer check is the authoritative gate.)
 */
export async function inviteDelegate(
  ctx: TenantContext,
  actor: { actorId: string },
  input: InviteDelegateInput,
  externalTx?: DbTransaction,
): Promise<Delegation> {
  if (input.grantor_account_id === input.delegate_account_id) {
    const err = new Error(DELEGATION_SELF_FORBIDDEN);
    (err as Error & { code: string }).code = DELEGATION_SELF_FORBIDDEN;
    throw err;
  }

  const runFn = async (tx: DbClient): Promise<Delegation> => {
    // Chain prevention check: is the grantor a delegate elsewhere?
    const grantorAsDelegate = await delegationRepo.listActiveDelegationsForDelegate(
      ctx.tenantId,
      input.grantor_account_id,
      tx,
    );
    if (grantorAsDelegate.length > 0) {
      const err = new Error(DELEGATION_CHAIN_FORBIDDEN);
      (err as Error & { code: string }).code = DELEGATION_CHAIN_FORBIDDEN;
      throw err;
    }

    const delegationId = asDelegationId(ulid());
    const repoInput: delegationRepo.CreateDelegationInput = {
      delegation_id: delegationId,
      tenant_id: ctx.tenantId,
      grantor_account_id: input.grantor_account_id,
      delegate_account_id: input.delegate_account_id,
      relationship_type: input.relationship_type,
    };
    if (input.legal_documentation_id !== undefined) {
      repoInput.legal_documentation_id = input.legal_documentation_id;
    }

    return delegationRepo.createDelegation(
      repoInput,
      async (innerTx, delegation) => {
        await emitDelegationInvitedAudit(
          {
            tenantId: ctx.tenantId,
            grantorAccountId: delegation.grantor_account_id,
            delegateAccountId: delegation.delegate_account_id,
            delegationId: delegation.delegation_id,
            actorId: actor.actorId,
            countryOfCare: ctx.countryOfCare,
            relationshipType: delegation.relationship_type,
          },
          innerTx,
        );
        await emitDelegationInvitedDomainEvent(innerTx, {
          tenantId: ctx.tenantId,
          delegationId: delegation.delegation_id,
          grantorAccountId: delegation.grantor_account_id,
          delegateAccountId: delegation.delegate_account_id,
          relationshipType: delegation.relationship_type,
          occurredAt: delegation.created_at,
        });
      },
      tx,
    );
  };

  if (externalTx !== undefined) return runFn(externalTx);
  return withTenantBoundConnection(ctx.tenantId, runFn);
}

// ---------------------------------------------------------------------------
// State transitions: accept / decline / revoke
// ---------------------------------------------------------------------------

export async function acceptDelegation(
  ctx: TenantContext,
  actor: { actorId: string },
  delegationId: DelegationId,
  externalTx?: DbTransaction,
): Promise<Delegation | null> {
  const runFn = async (tx: DbClient): Promise<Delegation | null> => {
    const accepted = await delegationRepo.acceptDelegation(ctx.tenantId, delegationId, tx);
    if (accepted === null) return null;
    await emitDelegationAcceptedAudit(
      {
        tenantId: ctx.tenantId,
        grantorAccountId: accepted.grantor_account_id,
        delegateAccountId: accepted.delegate_account_id,
        delegationId: accepted.delegation_id,
        actorId: actor.actorId,
        countryOfCare: ctx.countryOfCare,
      },
      tx,
    );
    await emitDelegationAcceptedDomainEvent(tx, {
      tenantId: ctx.tenantId,
      delegationId: accepted.delegation_id,
      grantorAccountId: accepted.grantor_account_id,
      delegateAccountId: accepted.delegate_account_id,
      occurredAt: accepted.accepted_at ?? accepted.created_at,
    });
    return accepted;
  };
  if (externalTx !== undefined) return runFn(externalTx);
  return withTenantBoundConnection(ctx.tenantId, runFn);
}

export async function declineDelegation(
  ctx: TenantContext,
  actor: { actorId: string },
  delegationId: DelegationId,
  externalTx?: DbTransaction,
): Promise<Delegation | null> {
  const runFn = async (tx: DbClient): Promise<Delegation | null> => {
    const declined = await delegationRepo.declineDelegation(ctx.tenantId, delegationId, tx);
    if (declined === null) return null;
    await emitDelegationDeclinedAudit(
      {
        tenantId: ctx.tenantId,
        grantorAccountId: declined.grantor_account_id,
        delegateAccountId: declined.delegate_account_id,
        delegationId: declined.delegation_id,
        actorId: actor.actorId,
        countryOfCare: ctx.countryOfCare,
      },
      tx,
    );
    await emitDelegationDeclinedDomainEvent(tx, {
      tenantId: ctx.tenantId,
      delegationId: declined.delegation_id,
      grantorAccountId: declined.grantor_account_id,
      delegateAccountId: declined.delegate_account_id,
      occurredAt: declined.declined_at ?? declined.created_at,
    });
    return declined;
  };
  if (externalTx !== undefined) return runFn(externalTx);
  return withTenantBoundConnection(ctx.tenantId, runFn);
}

export async function revokeDelegation(
  ctx: TenantContext,
  actor: { actorId: string },
  delegationId: DelegationId,
  reason: DelegationRevocationReason,
  externalTx?: DbTransaction,
): Promise<Delegation | null> {
  const runFn = async (tx: DbClient): Promise<Delegation | null> => {
    const revoked = await delegationRepo.revokeDelegation(ctx.tenantId, delegationId, reason, tx);
    if (revoked === null) return null;
    await emitDelegationRevokedAudit(
      {
        tenantId: ctx.tenantId,
        grantorAccountId: revoked.grantor_account_id,
        delegationId: revoked.delegation_id,
        actorId: actor.actorId,
        countryOfCare: ctx.countryOfCare,
        reason,
      },
      tx,
    );
    await emitDelegationRevokedDomainEvent(tx, {
      tenantId: ctx.tenantId,
      delegationId: revoked.delegation_id,
      grantorAccountId: revoked.grantor_account_id,
      reason,
      occurredAt: revoked.revoked_at ?? revoked.created_at,
    });
    return revoked;
  };
  if (externalTx !== undefined) return runFn(externalTx);
  return withTenantBoundConnection(ctx.tenantId, runFn);
}

// ---------------------------------------------------------------------------
// Scope CRUD + audit
// ---------------------------------------------------------------------------

export interface GrantScopeInput {
  delegation_id: DelegationId;
  scope: DelegationScope;
  visibility_restrictions?: DelegationVisibilityRestrictions | null;
}

export async function grantScope(
  ctx: TenantContext,
  actor: { actorId: string; grantorAccountId: AccountId },
  input: GrantScopeInput,
  externalTx?: DbTransaction,
): Promise<DelegationScopeRow> {
  const runFn = async (tx: DbClient): Promise<DelegationScopeRow> => {
    const scopeId = asDelegationScopeId(ulid());
    const repoInput: delegationRepo.CreateDelegationScopeInput = {
      delegation_scope_id: scopeId,
      tenant_id: ctx.tenantId,
      delegation_id: input.delegation_id,
      scope: input.scope,
    };
    if (input.visibility_restrictions !== undefined) {
      repoInput.visibility_restrictions = input.visibility_restrictions;
    }
    const created = await delegationRepo.createDelegationScope(repoInput, tx);
    await emitDelegationScopeGrantedAudit(
      {
        tenantId: ctx.tenantId,
        grantorAccountId: actor.grantorAccountId,
        delegationId: created.delegation_id,
        delegationScopeId: created.delegation_scope_id,
        actorId: actor.actorId,
        countryOfCare: ctx.countryOfCare,
        scope: created.scope,
      },
      tx,
    );
    await emitDelegationScopeGrantedDomainEvent(tx, {
      tenantId: ctx.tenantId,
      delegationScopeId: created.delegation_scope_id,
      delegationId: created.delegation_id,
      scope: created.scope,
      occurredAt: created.granted_at,
    });
    return created;
  };
  if (externalTx !== undefined) return runFn(externalTx);
  return withTenantBoundConnection(ctx.tenantId, runFn);
}

export async function revokeScope(
  ctx: TenantContext,
  actor: { actorId: string; grantorAccountId: AccountId },
  delegationScopeId: DelegationScopeId,
  externalTx?: DbTransaction,
): Promise<DelegationScopeRow | null> {
  const runFn = async (tx: DbClient): Promise<DelegationScopeRow | null> => {
    const revoked = await delegationRepo.revokeDelegationScope(ctx.tenantId, delegationScopeId, tx);
    if (revoked === null) return null;
    await emitDelegationScopeRevokedAudit(
      {
        tenantId: ctx.tenantId,
        grantorAccountId: actor.grantorAccountId,
        delegationId: revoked.delegation_id,
        delegationScopeId: revoked.delegation_scope_id,
        actorId: actor.actorId,
        countryOfCare: ctx.countryOfCare,
        scope: revoked.scope,
      },
      tx,
    );
    await emitDelegationScopeRevokedDomainEvent(tx, {
      tenantId: ctx.tenantId,
      delegationScopeId: revoked.delegation_scope_id,
      delegationId: revoked.delegation_id,
      scope: revoked.scope,
      occurredAt: revoked.revoked_at ?? revoked.granted_at,
    });
    return revoked;
  };
  if (externalTx !== undefined) return runFn(externalTx);
  return withTenantBoundConnection(ctx.tenantId, runFn);
}

// ---------------------------------------------------------------------------
// Read paths
// ---------------------------------------------------------------------------

export async function findDelegationById(
  ctx: TenantContext,
  delegationId: DelegationId,
  externalTx?: DbClient,
): Promise<Delegation | null> {
  return delegationRepo.findDelegationById(ctx.tenantId, delegationId, externalTx);
}

export async function listActiveDelegationsForGrantor(
  ctx: TenantContext,
  grantorAccountId: AccountId,
  externalTx?: DbClient,
): Promise<Delegation[]> {
  return delegationRepo.listActiveDelegationsForGrantor(ctx.tenantId, grantorAccountId, externalTx);
}

export async function listActiveDelegationsForDelegate(
  ctx: TenantContext,
  delegateAccountId: AccountId,
  externalTx?: DbClient,
): Promise<Delegation[]> {
  return delegationRepo.listActiveDelegationsForDelegate(
    ctx.tenantId,
    delegateAccountId,
    externalTx,
  );
}

export async function listActiveScopesForDelegation(
  ctx: TenantContext,
  delegationId: DelegationId,
  externalTx?: DbClient,
): Promise<DelegationScopeRow[]> {
  return delegationRepo.listActiveScopesForDelegation(ctx.tenantId, delegationId, externalTx);
}
