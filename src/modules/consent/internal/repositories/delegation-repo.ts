/**
 * delegation-repo.ts — DB access for `delegations` + `delegation_scopes`
 * tables (migration 017).
 *
 * Repository pattern (mirror of consent-repo + identity repos).
 *
 * Spec references:
 *   - migrations/017_delegations.sql
 *   - Consent Slice PRD v1.0 §6
 *   - CDM v1.2 §3.3 entities 13-14
 *   - I-023 / I-025
 */

import type { DbClient, DbTransaction } from '../../../../lib/db.js';
import { withTenantBoundConnection } from '../../../../lib/db.js';
import type { TenantId } from '../../../../lib/glossary.js';
import type { AccountId } from '../../../identity/internal/types.js';
import type {
  Delegation,
  DelegationId,
  DelegationRelationshipType,
  DelegationRevocationReason,
  DelegationScope,
  DelegationScopeId,
  DelegationScopeRow,
  DelegationStatus,
  DelegationVisibilityRestrictions,
} from '../types.js';

// ---------------------------------------------------------------------------
// Row mapping
// ---------------------------------------------------------------------------

interface DelegationRow {
  delegation_id: string;
  tenant_id: string;
  grantor_account_id: string;
  delegate_account_id: string;
  relationship_type: string;
  status: string;
  legal_documentation_id: string | null;
  created_at: Date | string;
  accepted_at: Date | string | null;
  declined_at: Date | string | null;
  revoked_at: Date | string | null;
  revoked_reason: string | null;
}

interface ScopeRow {
  delegation_scope_id: string;
  tenant_id: string;
  delegation_id: string;
  scope: string;
  visibility_restrictions: DelegationVisibilityRestrictions | null;
  granted_at: Date | string;
  revoked_at: Date | string | null;
}

function tsToIso(v: Date | string): string {
  return typeof v === 'string' ? v : v.toISOString();
}
function tsToIsoNullable(v: Date | string | null): string | null {
  if (v === null) return null;
  return tsToIso(v);
}

function rowToDelegation(row: DelegationRow): Delegation {
  return {
    delegation_id: row.delegation_id as DelegationId,
    tenant_id: row.tenant_id as TenantId,
    grantor_account_id: row.grantor_account_id as AccountId,
    delegate_account_id: row.delegate_account_id as AccountId,
    relationship_type: row.relationship_type as DelegationRelationshipType,
    status: row.status as DelegationStatus,
    legal_documentation_id: row.legal_documentation_id,
    created_at: tsToIso(row.created_at),
    accepted_at: tsToIsoNullable(row.accepted_at),
    declined_at: tsToIsoNullable(row.declined_at),
    revoked_at: tsToIsoNullable(row.revoked_at),
    revoked_reason: row.revoked_reason as DelegationRevocationReason | null,
  };
}

function rowToScope(row: ScopeRow): DelegationScopeRow {
  return {
    delegation_scope_id: row.delegation_scope_id as DelegationScopeId,
    tenant_id: row.tenant_id as TenantId,
    delegation_id: row.delegation_id as DelegationId,
    scope: row.scope as DelegationScope,
    visibility_restrictions: row.visibility_restrictions,
    granted_at: tsToIso(row.granted_at),
    revoked_at: tsToIsoNullable(row.revoked_at),
  };
}

const DELEGATION_COLUMNS = `
  delegation_id, tenant_id, grantor_account_id, delegate_account_id,
  relationship_type, status, legal_documentation_id,
  created_at, accepted_at, declined_at, revoked_at, revoked_reason
`;

const SCOPE_COLUMNS = `
  delegation_scope_id, tenant_id, delegation_id, scope,
  visibility_restrictions, granted_at, revoked_at
`;

// ---------------------------------------------------------------------------
// CreateDelegationInput
// ---------------------------------------------------------------------------

export interface CreateDelegationInput {
  delegation_id: DelegationId;
  tenant_id: TenantId;
  grantor_account_id: AccountId;
  delegate_account_id: AccountId;
  relationship_type: DelegationRelationshipType;
  legal_documentation_id?: string | null;
}

/**
 * Create a delegation in `pending_acceptance` status. The delegate
 * accepts (or declines) via separate flows that produce status
 * transitions on this row (NOT new rows — delegations are mutable
 * unlike consent records).
 */
export async function createDelegation(
  input: CreateDelegationInput,
  txCallback: (tx: DbTransaction, delegation: Delegation) => Promise<void>,
  externalTx?: DbTransaction,
): Promise<Delegation> {
  const runFn = async (tx: DbClient): Promise<Delegation> => {
    const result = await tx.query<DelegationRow>(
      `INSERT INTO delegations (
          delegation_id, tenant_id, grantor_account_id, delegate_account_id,
          relationship_type, status, legal_documentation_id
       ) VALUES ($1, $2, $3, $4, $5, 'pending_acceptance', $6)
       RETURNING ${DELEGATION_COLUMNS}`,
      [
        input.delegation_id,
        input.tenant_id,
        input.grantor_account_id,
        input.delegate_account_id,
        input.relationship_type,
        input.legal_documentation_id ?? null,
      ],
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw new Error('createDelegation: INSERT returned no rows');
    }
    const delegation = rowToDelegation(row);
    await txCallback(tx, delegation);
    return delegation;
  };
  if (externalTx !== undefined) return runFn(externalTx);
  return withTenantBoundConnection(input.tenant_id, runFn);
}

// ---------------------------------------------------------------------------
// findDelegationById
// ---------------------------------------------------------------------------

export async function findDelegationById(
  tenantId: TenantId,
  delegationId: DelegationId,
  externalTx?: DbClient,
): Promise<Delegation | null> {
  const runner = externalTx
    ? (fn: (client: DbClient) => Promise<Delegation | null>) => fn(externalTx)
    : (fn: (client: DbClient) => Promise<Delegation | null>) =>
        withTenantBoundConnection(tenantId, fn);
  return runner(async (client) => {
    const result = await client.query<DelegationRow>(
      `SELECT ${DELEGATION_COLUMNS}
         FROM delegations
        WHERE tenant_id = $1
          AND delegation_id = $2`,
      [tenantId, delegationId],
    );
    if (result.rows.length === 0) return null;
    const row = result.rows[0];
    if (row === undefined) return null;
    return rowToDelegation(row);
  });
}

// ---------------------------------------------------------------------------
// listActiveDelegationsForGrantor / Delegate
// ---------------------------------------------------------------------------

export async function listActiveDelegationsForGrantor(
  tenantId: TenantId,
  grantorAccountId: AccountId,
  externalTx?: DbClient,
): Promise<Delegation[]> {
  const runner = externalTx
    ? (fn: (client: DbClient) => Promise<Delegation[]>) => fn(externalTx)
    : (fn: (client: DbClient) => Promise<Delegation[]>) => withTenantBoundConnection(tenantId, fn);
  return runner(async (client) => {
    const result = await client.query<DelegationRow>(
      `SELECT ${DELEGATION_COLUMNS}
         FROM delegations
        WHERE tenant_id = $1
          AND grantor_account_id = $2
          AND status = 'active'
        ORDER BY accepted_at DESC`,
      [tenantId, grantorAccountId],
    );
    return result.rows.map(rowToDelegation);
  });
}

export async function listActiveDelegationsForDelegate(
  tenantId: TenantId,
  delegateAccountId: AccountId,
  externalTx?: DbClient,
): Promise<Delegation[]> {
  const runner = externalTx
    ? (fn: (client: DbClient) => Promise<Delegation[]>) => fn(externalTx)
    : (fn: (client: DbClient) => Promise<Delegation[]>) => withTenantBoundConnection(tenantId, fn);
  return runner(async (client) => {
    const result = await client.query<DelegationRow>(
      `SELECT ${DELEGATION_COLUMNS}
         FROM delegations
        WHERE tenant_id = $1
          AND delegate_account_id = $2
          AND status = 'active'
        ORDER BY accepted_at DESC`,
      [tenantId, delegateAccountId],
    );
    return result.rows.map(rowToDelegation);
  });
}

// ---------------------------------------------------------------------------
// State transitions: accept / decline / revoke
// ---------------------------------------------------------------------------

/**
 * Mark a delegation as accepted. Idempotent: returns null if the row
 * isn't in `pending_acceptance` status (already accepted/declined/
 * revoked → no transition).
 */
export async function acceptDelegation(
  tenantId: TenantId,
  delegationId: DelegationId,
  externalTx?: DbClient,
): Promise<Delegation | null> {
  const runner = externalTx
    ? (fn: (client: DbClient) => Promise<Delegation | null>) => fn(externalTx)
    : (fn: (client: DbClient) => Promise<Delegation | null>) =>
        withTenantBoundConnection(tenantId, fn);
  return runner(async (client) => {
    const result = await client.query<DelegationRow>(
      `UPDATE delegations
          SET status = 'active',
              accepted_at = NOW()
        WHERE tenant_id = $1
          AND delegation_id = $2
          AND status = 'pending_acceptance'
       RETURNING ${DELEGATION_COLUMNS}`,
      [tenantId, delegationId],
    );
    if (result.rows.length === 0) return null;
    const row = result.rows[0];
    if (row === undefined) return null;
    return rowToDelegation(row);
  });
}

export async function declineDelegation(
  tenantId: TenantId,
  delegationId: DelegationId,
  externalTx?: DbClient,
): Promise<Delegation | null> {
  const runner = externalTx
    ? (fn: (client: DbClient) => Promise<Delegation | null>) => fn(externalTx)
    : (fn: (client: DbClient) => Promise<Delegation | null>) =>
        withTenantBoundConnection(tenantId, fn);
  return runner(async (client) => {
    const result = await client.query<DelegationRow>(
      `UPDATE delegations
          SET status = 'declined',
              declined_at = NOW()
        WHERE tenant_id = $1
          AND delegation_id = $2
          AND status = 'pending_acceptance'
       RETURNING ${DELEGATION_COLUMNS}`,
      [tenantId, delegationId],
    );
    if (result.rows.length === 0) return null;
    const row = result.rows[0];
    if (row === undefined) return null;
    return rowToDelegation(row);
  });
}

export async function revokeDelegation(
  tenantId: TenantId,
  delegationId: DelegationId,
  reason: DelegationRevocationReason,
  externalTx?: DbClient,
): Promise<Delegation | null> {
  const runner = externalTx
    ? (fn: (client: DbClient) => Promise<Delegation | null>) => fn(externalTx)
    : (fn: (client: DbClient) => Promise<Delegation | null>) =>
        withTenantBoundConnection(tenantId, fn);
  return runner(async (client) => {
    const result = await client.query<DelegationRow>(
      `UPDATE delegations
          SET status = 'revoked',
              revoked_at = NOW(),
              revoked_reason = $3
        WHERE tenant_id = $1
          AND delegation_id = $2
          AND status IN ('pending_acceptance', 'active')
       RETURNING ${DELEGATION_COLUMNS}`,
      [tenantId, delegationId, reason],
    );
    if (result.rows.length === 0) return null;
    const row = result.rows[0];
    if (row === undefined) return null;
    return rowToDelegation(row);
  });
}

// ---------------------------------------------------------------------------
// Scope CRUD
// ---------------------------------------------------------------------------

export interface CreateDelegationScopeInput {
  delegation_scope_id: DelegationScopeId;
  tenant_id: TenantId;
  delegation_id: DelegationId;
  scope: DelegationScope;
  visibility_restrictions?: DelegationVisibilityRestrictions | null;
}

export async function createDelegationScope(
  input: CreateDelegationScopeInput,
  externalTx?: DbTransaction,
): Promise<DelegationScopeRow> {
  const runFn = async (tx: DbClient): Promise<DelegationScopeRow> => {
    const result = await tx.query<ScopeRow>(
      `INSERT INTO delegation_scopes (
          delegation_scope_id, tenant_id, delegation_id, scope,
          visibility_restrictions
       ) VALUES ($1, $2, $3, $4, $5::jsonb)
       RETURNING ${SCOPE_COLUMNS}`,
      [
        input.delegation_scope_id,
        input.tenant_id,
        input.delegation_id,
        input.scope,
        input.visibility_restrictions === null || input.visibility_restrictions === undefined
          ? null
          : JSON.stringify(input.visibility_restrictions),
      ],
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw new Error('createDelegationScope: INSERT returned no rows');
    }
    return rowToScope(row);
  };
  if (externalTx !== undefined) return runFn(externalTx);
  return withTenantBoundConnection(input.tenant_id, runFn);
}

/**
 * List the active (non-revoked) scopes for a delegation.
 */
export async function listActiveScopesForDelegation(
  tenantId: TenantId,
  delegationId: DelegationId,
  externalTx?: DbClient,
): Promise<DelegationScopeRow[]> {
  const runner = externalTx
    ? (fn: (client: DbClient) => Promise<DelegationScopeRow[]>) => fn(externalTx)
    : (fn: (client: DbClient) => Promise<DelegationScopeRow[]>) =>
        withTenantBoundConnection(tenantId, fn);
  return runner(async (client) => {
    const result = await client.query<ScopeRow>(
      `SELECT ${SCOPE_COLUMNS}
         FROM delegation_scopes
        WHERE tenant_id = $1
          AND delegation_id = $2
          AND revoked_at IS NULL
        ORDER BY granted_at ASC`,
      [tenantId, delegationId],
    );
    return result.rows.map(rowToScope);
  });
}

export async function revokeDelegationScope(
  tenantId: TenantId,
  delegationId: DelegationId,
  delegationScopeId: DelegationScopeId,
  externalTx?: DbClient,
): Promise<DelegationScopeRow | null> {
  const runner = externalTx
    ? (fn: (client: DbClient) => Promise<DelegationScopeRow | null>) => fn(externalTx)
    : (fn: (client: DbClient) => Promise<DelegationScopeRow | null>) =>
        withTenantBoundConnection(tenantId, fn);
  return runner(async (client) => {
    // Bind the mutation to the authorized parent delegation (Codex
    // PR-118 R6 HIGH closure 2026-05-13). Previous signature accepted
    // only `delegation_scope_id`, which let a same-tenant attacker
    // who owns delegation X pass their own X as the URL :id (passing
    // the handler's ownership precheck) and a VICTIM's :scopeId from
    // delegation Y — the UPDATE would land on the victim's scope.
    // The AND delegation_id = $2 predicate makes the mutation atomic
    // with the ownership check: a scope_id that doesn't belong to
    // the passed delegation_id matches zero rows and the caller gets
    // tenant-blind null → 404.
    const result = await client.query<ScopeRow>(
      `UPDATE delegation_scopes
          SET revoked_at = NOW()
        WHERE tenant_id = $1
          AND delegation_id = $2
          AND delegation_scope_id = $3
          AND revoked_at IS NULL
       RETURNING ${SCOPE_COLUMNS}`,
      [tenantId, delegationId, delegationScopeId],
    );
    if (result.rows.length === 0) return null;
    const row = result.rows[0];
    if (row === undefined) return null;
    return rowToScope(row);
  });
}
