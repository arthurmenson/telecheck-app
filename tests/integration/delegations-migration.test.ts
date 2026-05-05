/**
 * migrations/017_delegations.sql — schema-level integration tests.
 *
 * Validates the migration empirically: delegations + delegation_scopes
 * tables, status-timestamp consistency, self-delegation prevention,
 * scope enum, sensitive-category visibility (default-excluded).
 *
 * Coverage in this file (4 sections, 14 cases).
 *
 * Spec references:
 *   - migrations/017_delegations.sql (target)
 *   - Consent Slice PRD v1.0 §6 (delegation) + §6.2 (9 scopes) +
 *     §6.3 (relationship defaults) + §6.4 (sensitive categories)
 *   - CDM v1.2 §3.3 entities 13-14
 */

import { describe, expect, it } from 'vitest';

import type { TenantId } from '../../src/lib/glossary.ts';
import { ulid } from '../../src/lib/ulid.ts';
import { createAccount } from '../../src/modules/identity/internal/repositories/account-repo.ts';
import { asAccountId, type AccountId } from '../../src/modules/identity/internal/types.ts';
import { TENANT_GHANA, TENANT_US, withTenantContext } from '../helpers/tenant-fixtures.ts';
import { uniquePhone } from '../helpers/unique-phone.ts';
import { getTestClient } from '../setup.ts';

const T_US = TENANT_US as TenantId;
const T_GH = TENANT_GHANA as TenantId;

async function seedAccount(tenant: TenantId, country: 'US' | 'GH' = 'US'): Promise<AccountId> {
  const accountId = asAccountId(ulid());
  await withTenantContext(tenant, () =>
    createAccount(
      {
        account_id: accountId,
        tenant_id: tenant,
        phone_e164: uniquePhone(country === 'US' ? '+1' : '+233'),
        first_name: 'A',
        last_name: 'B',
        date_of_birth: '1990-01-01',
        gender: 'prefer_not_to_say',
        country_of_residence: country,
        country_of_care: country,
      },
      async () => {},
      getTestClient(),
    ),
  );
  return accountId;
}

interface InsertDelegationInput {
  delegation_id?: string;
  tenant_id: string;
  grantor_account_id: string;
  delegate_account_id: string;
  relationship_type?: string;
  status?: string;
  accepted_at?: string | null;
  declined_at?: string | null;
  revoked_at?: string | null;
  revoked_reason?: string | null;
}

async function insertDelegation(input: InsertDelegationInput): Promise<string> {
  const client = getTestClient();
  const id = input.delegation_id ?? ulid();
  await client.query(
    `INSERT INTO delegations (
        delegation_id, tenant_id, grantor_account_id, delegate_account_id,
        relationship_type, status,
        accepted_at, declined_at, revoked_at, revoked_reason
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      id,
      input.tenant_id,
      input.grantor_account_id,
      input.delegate_account_id,
      input.relationship_type ?? 'spouse_partner',
      input.status ?? 'pending_acceptance',
      input.accepted_at ?? null,
      input.declined_at ?? null,
      input.revoked_at ?? null,
      input.revoked_reason ?? null,
    ],
  );
  return id;
}

interface InsertScopeInput {
  delegation_scope_id?: string;
  tenant_id: string;
  delegation_id: string;
  scope?: string;
  visibility_restrictions?: object | null;
}

async function insertDelegationScope(input: InsertScopeInput): Promise<string> {
  const client = getTestClient();
  const id = input.delegation_scope_id ?? ulid();
  await client.query(
    `INSERT INTO delegation_scopes (
        delegation_scope_id, tenant_id, delegation_id,
        scope, visibility_restrictions
     ) VALUES ($1, $2, $3, $4, $5::jsonb)`,
    [
      id,
      input.tenant_id,
      input.delegation_id,
      input.scope ?? 'view_records',
      input.visibility_restrictions === null || input.visibility_restrictions === undefined
        ? null
        : JSON.stringify(input.visibility_restrictions),
    ],
  );
  return id;
}

// ---------------------------------------------------------------------------
// §1 — delegations basic shape + RLS
// ---------------------------------------------------------------------------

describe('delegations migration — §1 basic shape', () => {
  it('§1a happy path: pending_acceptance', async () => {
    const grantor = await seedAccount(T_US);
    const delegate = await seedAccount(T_US);
    await withTenantContext(T_US, () =>
      insertDelegation({
        tenant_id: T_US,
        grantor_account_id: grantor,
        delegate_account_id: delegate,
      }),
    );
  });

  it('§1b row in US invisible from Ghana (RLS)', async () => {
    const grantor = await seedAccount(T_US);
    const delegate = await seedAccount(T_US);
    const id = await withTenantContext(T_US, () =>
      insertDelegation({
        tenant_id: T_US,
        grantor_account_id: grantor,
        delegate_account_id: delegate,
      }),
    );
    const visible = await withTenantContext(T_GH, async () => {
      const r = await getTestClient().query('SELECT 1 FROM delegations WHERE delegation_id = $1', [
        id,
      ]);
      return r.rows.length;
    });
    expect(visible).toBe(0);
  });

  it('§1c relationship_type enum: rejects out-of-set', async () => {
    const grantor = await seedAccount(T_US);
    const delegate = await seedAccount(T_US);
    await expect(
      withTenantContext(T_US, () =>
        insertDelegation({
          tenant_id: T_US,
          grantor_account_id: grantor,
          delegate_account_id: delegate,
          relationship_type: 'made_up',
        }),
      ),
    ).rejects.toThrow(/check constraint|relationship_type/i);
  });
});

// ---------------------------------------------------------------------------
// §2 — Self-delegation prevention
// ---------------------------------------------------------------------------

describe('delegations migration — §2 self-delegation prevention', () => {
  it('§2a grantor == delegate → CHECK rejected', async () => {
    const account = await seedAccount(T_US);
    await expect(
      withTenantContext(T_US, () =>
        insertDelegation({
          tenant_id: T_US,
          grantor_account_id: account,
          delegate_account_id: account,
        }),
      ),
    ).rejects.toThrow(/delegation_no_self|check constraint/i);
  });
});

// ---------------------------------------------------------------------------
// §3 — Status-timestamp consistency CHECK
// ---------------------------------------------------------------------------

describe('delegations migration — §3 status-timestamp consistency', () => {
  it('§3a active without accepted_at rejected', async () => {
    const grantor = await seedAccount(T_US);
    const delegate = await seedAccount(T_US);
    await expect(
      withTenantContext(T_US, () =>
        insertDelegation({
          tenant_id: T_US,
          grantor_account_id: grantor,
          delegate_account_id: delegate,
          status: 'active',
          accepted_at: null,
        }),
      ),
    ).rejects.toThrow(/delegation_status_timestamp_consistent|check constraint/i);
  });

  it('§3b active with accepted_at set → accepted', async () => {
    const grantor = await seedAccount(T_US);
    const delegate = await seedAccount(T_US);
    await withTenantContext(T_US, () =>
      insertDelegation({
        tenant_id: T_US,
        grantor_account_id: grantor,
        delegate_account_id: delegate,
        status: 'active',
        accepted_at: new Date().toISOString(),
      }),
    );
  });

  it('§3c revoked without revoked_at rejected', async () => {
    const grantor = await seedAccount(T_US);
    const delegate = await seedAccount(T_US);
    await expect(
      withTenantContext(T_US, () =>
        insertDelegation({
          tenant_id: T_US,
          grantor_account_id: grantor,
          delegate_account_id: delegate,
          status: 'revoked',
          revoked_at: null,
          revoked_reason: 'patient_initiated',
        }),
      ),
    ).rejects.toThrow(/delegation_status_timestamp_consistent|check constraint/i);
  });

  it('§3d revoked + revoked_at + revoked_reason → accepted', async () => {
    const grantor = await seedAccount(T_US);
    const delegate = await seedAccount(T_US);
    await withTenantContext(T_US, () =>
      insertDelegation({
        tenant_id: T_US,
        grantor_account_id: grantor,
        delegate_account_id: delegate,
        status: 'revoked',
        revoked_at: new Date().toISOString(),
        revoked_reason: 'patient_initiated',
      }),
    );
  });

  it('§3e revoked status without reason rejected', async () => {
    const grantor = await seedAccount(T_US);
    const delegate = await seedAccount(T_US);
    await expect(
      withTenantContext(T_US, () =>
        insertDelegation({
          tenant_id: T_US,
          grantor_account_id: grantor,
          delegate_account_id: delegate,
          status: 'revoked',
          revoked_at: new Date().toISOString(),
          revoked_reason: null,
        }),
      ),
    ).rejects.toThrow(/delegation_revocation_reason_consistent|check constraint/i);
  });

  it('§3f non-revoked status with reason rejected', async () => {
    const grantor = await seedAccount(T_US);
    const delegate = await seedAccount(T_US);
    await expect(
      withTenantContext(T_US, () =>
        insertDelegation({
          tenant_id: T_US,
          grantor_account_id: grantor,
          delegate_account_id: delegate,
          status: 'active',
          accepted_at: new Date().toISOString(),
          revoked_reason: 'patient_initiated', // not allowed when status='active'
        }),
      ),
    ).rejects.toThrow(/delegation_revocation_reason_consistent|check constraint/i);
  });
});

// ---------------------------------------------------------------------------
// §4 — delegation_scopes
// ---------------------------------------------------------------------------

describe('delegation_scopes migration — §4 scopes', () => {
  it('§4a happy path: view_records scope', async () => {
    const grantor = await seedAccount(T_US);
    const delegate = await seedAccount(T_US);
    const delegationId = await withTenantContext(T_US, () =>
      insertDelegation({
        tenant_id: T_US,
        grantor_account_id: grantor,
        delegate_account_id: delegate,
      }),
    );
    await withTenantContext(T_US, () =>
      insertDelegationScope({
        tenant_id: T_US,
        delegation_id: delegationId,
        scope: 'view_records',
      }),
    );
  });

  it('§4b accepts all 9 documented scopes', async () => {
    const scopes = [
      'view_records',
      'request_refills',
      'book_consults',
      'attend_consults',
      'receive_notifications',
      'make_payments',
      'upload_documents',
      'give_consent_on_behalf',
      'view_community',
    ];
    const grantor = await seedAccount(T_US);
    const delegate = await seedAccount(T_US);
    const delegationId = await withTenantContext(T_US, () =>
      insertDelegation({
        tenant_id: T_US,
        grantor_account_id: grantor,
        delegate_account_id: delegate,
      }),
    );
    for (const scope of scopes) {
      await withTenantContext(T_US, () =>
        insertDelegationScope({
          tenant_id: T_US,
          delegation_id: delegationId,
          scope,
        }),
      );
    }
  });

  it("§4c scope enum rejects 'made_up'", async () => {
    const grantor = await seedAccount(T_US);
    const delegate = await seedAccount(T_US);
    const delegationId = await withTenantContext(T_US, () =>
      insertDelegation({
        tenant_id: T_US,
        grantor_account_id: grantor,
        delegate_account_id: delegate,
      }),
    );
    await expect(
      withTenantContext(T_US, () =>
        insertDelegationScope({
          tenant_id: T_US,
          delegation_id: delegationId,
          scope: 'made_up',
        }),
      ),
    ).rejects.toThrow(/check constraint|scope/i);
  });

  it('§4d composite FK to delegations: cross-tenant rejected', async () => {
    // Create a delegation in Ghana
    const ghGrantor = await seedAccount(T_GH, 'GH');
    const ghDelegate = await seedAccount(T_GH, 'GH');
    const ghDelegationId = await withTenantContext(T_GH, () =>
      insertDelegation({
        tenant_id: T_GH,
        grantor_account_id: ghGrantor,
        delegate_account_id: ghDelegate,
      }),
    );
    // Try to scope it from US tenant
    await expect(
      withTenantContext(T_US, () =>
        insertDelegationScope({
          tenant_id: T_US,
          delegation_id: ghDelegationId,
          scope: 'view_records',
        }),
      ),
    ).rejects.toThrow(/foreign key|fk_delegation_scope_delegation|violates/i);
  });

  it('§4e visibility_restrictions JSONB stores sensitive-category allowlist', async () => {
    const grantor = await seedAccount(T_US);
    const delegate = await seedAccount(T_US);
    const delegationId = await withTenantContext(T_US, () =>
      insertDelegation({
        tenant_id: T_US,
        grantor_account_id: grantor,
        delegate_account_id: delegate,
      }),
    );
    // Per Slice PRD §6.4: sensitive categories require explicit grant
    await withTenantContext(T_US, () =>
      insertDelegationScope({
        tenant_id: T_US,
        delegation_id: delegationId,
        scope: 'view_records',
        visibility_restrictions: { sensitive_categories: ['mental_health'] },
      }),
    );
  });
});
