/**
 * src/modules/identity/internal/repositories/account-repo.ts — direct
 * integration tests against migration 012.
 *
 * Coverage:
 *   §1 findAccountById — happy path, tenant-blind miss, soft-deleted miss
 *   §2 findAccountByPhoneE164 — happy path, cross-tenant blind miss
 *      (CDM §5.1 tenant-scoped uniqueness)
 *   §3 createAccount — INSERT round-trip via RETURNING; status defaults
 *      to pending_verification; locale defaults from country_of_care;
 *      txCallback fires inside the same transaction
 *   §4 activateAccount — idempotent pending_verification → active flip;
 *      no-op on already-active rows; activated_at populated
 *
 * Spec references:
 *   - account-repo.ts (target)
 *   - migrations/012_accounts.sql
 *   - CDM v1.2 §3.2 entity 7 + §5.1 tenant-scoped uniqueness
 *   - I-023 (RLS + explicit tenant filter)
 *   - I-025 (tenant-blind null on miss)
 */

import { describe, expect, it } from 'vitest';

import type { TenantId } from '../../src/lib/glossary.ts';
import { ulid } from '../../src/lib/ulid.ts';
import {
  activateAccount,
  createAccount,
  findAccountById,
  findAccountByPhoneE164,
} from '../../src/modules/identity/internal/repositories/account-repo.ts';
import { asAccountId, type AccountId } from '../../src/modules/identity/internal/types.ts';
import { TENANT_GHANA, TENANT_US, withTenantContext } from '../helpers/tenant-fixtures.ts';
import { getTestClient } from '../setup.ts';

const T_US = TENANT_US as TenantId;
const T_GH = TENANT_GHANA as TenantId;

function uniquePhone(prefix: '+1' | '+233' = '+1'): string {
  const digits = ulid()
    .slice(-9)
    .replace(/[^0-9]/g, '0')
    .padEnd(9, '0');
  return `${prefix}${digits}`;
}

// ---------------------------------------------------------------------------
// §1 — findAccountById
// ---------------------------------------------------------------------------

describe('account-repo §1 findAccountById', () => {
  it('§1a returns the row when same-tenant and not deleted', async () => {
    const accountId = asAccountId(ulid());
    await withTenantContext(T_US, () =>
      createAccount(
        {
          account_id: accountId,
          tenant_id: T_US,
          phone_e164: uniquePhone('+1'),
          first_name: 'A',
          last_name: 'B',
          date_of_birth: '1990-01-01',
          gender: 'prefer_not_to_say',
          country_of_residence: 'US',
          country_of_care: 'US',
        },
        async () => {},
        getTestClient(),
      ),
    );

    const found = await withTenantContext(T_US, () =>
      findAccountById(T_US, accountId, getTestClient()),
    );
    expect(found).not.toBeNull();
    expect(found!.account_id).toBe(accountId);
    expect(found!.status).toBe('pending_verification');
  });

  it('§1b returns null when account_id missing (tenant-blind miss)', async () => {
    const phantomId = asAccountId(ulid());
    const found = await withTenantContext(T_US, () =>
      findAccountById(T_US, phantomId, getTestClient()),
    );
    expect(found).toBeNull();
  });

  it('§1c returns null when account exists in different tenant (RLS-blind miss)', async () => {
    const accountId = asAccountId(ulid());
    await withTenantContext(T_GH, () =>
      createAccount(
        {
          account_id: accountId,
          tenant_id: T_GH,
          phone_e164: uniquePhone('+233'),
          first_name: 'A',
          last_name: 'B',
          date_of_birth: '1990-01-01',
          gender: 'prefer_not_to_say',
          country_of_residence: 'GH',
          country_of_care: 'GH',
        },
        async () => {},
        getTestClient(),
      ),
    );

    const fromUS = await withTenantContext(T_US, () =>
      findAccountById(T_US, accountId, getTestClient()),
    );
    expect(fromUS).toBeNull();
  });

  it('§1d returns null when row is soft-deleted', async () => {
    const accountId = asAccountId(ulid());
    await withTenantContext(T_US, () =>
      createAccount(
        {
          account_id: accountId,
          tenant_id: T_US,
          phone_e164: uniquePhone('+1'),
          first_name: 'A',
          last_name: 'B',
          date_of_birth: '1990-01-01',
          gender: 'prefer_not_to_say',
          country_of_residence: 'US',
          country_of_care: 'US',
        },
        async () => {},
        getTestClient(),
      ),
    );

    await withTenantContext(T_US, async () => {
      await getTestClient().query('UPDATE accounts SET deleted_at = NOW() WHERE account_id = $1', [
        accountId,
      ]);
    });

    const found = await withTenantContext(T_US, () =>
      findAccountById(T_US, accountId, getTestClient()),
    );
    expect(found).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// §2 — findAccountByPhoneE164
// ---------------------------------------------------------------------------

describe('account-repo §2 findAccountByPhoneE164', () => {
  it('§2a returns the row when same-tenant phone match', async () => {
    const phone = uniquePhone('+1');
    const accountId = asAccountId(ulid());
    await withTenantContext(T_US, () =>
      createAccount(
        {
          account_id: accountId,
          tenant_id: T_US,
          phone_e164: phone,
          first_name: 'A',
          last_name: 'B',
          date_of_birth: '1990-01-01',
          gender: 'prefer_not_to_say',
          country_of_residence: 'US',
          country_of_care: 'US',
        },
        async () => {},
        getTestClient(),
      ),
    );

    const found = await withTenantContext(T_US, () =>
      findAccountByPhoneE164(T_US, phone, getTestClient()),
    );
    expect(found).not.toBeNull();
    expect(found!.account_id).toBe(accountId);
    expect(found!.phone_e164).toBe(phone);
  });

  it('§2b returns null when phone exists in DIFFERENT tenant (CDM §5.1)', async () => {
    // Same phone, two tenants → two distinct rows. Lookup in tenant US
    // for a phone seeded in tenant Ghana returns null, NOT the Ghana row.
    const phone = uniquePhone('+1');
    await withTenantContext(T_GH, () =>
      createAccount(
        {
          account_id: asAccountId(ulid()),
          tenant_id: T_GH,
          phone_e164: phone,
          first_name: 'A',
          last_name: 'B',
          date_of_birth: '1990-01-01',
          gender: 'prefer_not_to_say',
          country_of_residence: 'GH',
          country_of_care: 'GH',
        },
        async () => {},
        getTestClient(),
      ),
    );

    const fromUS = await withTenantContext(T_US, () =>
      findAccountByPhoneE164(T_US, phone, getTestClient()),
    );
    expect(fromUS).toBeNull();
  });

  it('§2c returns null when phone never registered', async () => {
    const found = await withTenantContext(T_US, () =>
      findAccountByPhoneE164(T_US, uniquePhone('+1'), getTestClient()),
    );
    expect(found).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// §3 — createAccount
// ---------------------------------------------------------------------------

describe('account-repo §3 createAccount', () => {
  it('§3a INSERT round-trip via RETURNING with schema-applied defaults', async () => {
    const accountId = asAccountId(ulid());
    const phone = uniquePhone('+1');
    const account = await withTenantContext(T_US, () =>
      createAccount(
        {
          account_id: accountId,
          tenant_id: T_US,
          phone_e164: phone,
          first_name: 'A',
          last_name: 'B',
          date_of_birth: '1990-01-01',
          gender: 'prefer_not_to_say',
          country_of_residence: 'US',
          country_of_care: 'US',
        },
        async () => {},
        getTestClient(),
      ),
    );

    expect(account.account_id).toBe(accountId);
    expect(account.phone_e164).toBe(phone);
    // Schema defaults
    expect(account.status).toBe('pending_verification');
    expect(account.account_type).toBe('patient');
    expect(account.activated_at).toBeNull();
    expect(account.created_at).toBeTruthy();
    // Row mapping: date_of_birth as YYYY-MM-DD (not full ISO)
    expect(account.date_of_birth).toBe('1990-01-01');
  });

  it('§3b locale defaults from country_of_care when not supplied', async () => {
    const accountId = asAccountId(ulid());
    const account = await withTenantContext(T_GH, () =>
      createAccount(
        {
          account_id: accountId,
          tenant_id: T_GH,
          phone_e164: uniquePhone('+233'),
          first_name: 'A',
          last_name: 'B',
          date_of_birth: '1990-01-01',
          gender: 'prefer_not_to_say',
          country_of_residence: 'GH',
          country_of_care: 'GH',
        },
        async () => {},
        getTestClient(),
      ),
    );
    expect(account.locale).toBe('en-GH');
  });

  it('§3c txCallback fires inside the same transaction with the persisted account', async () => {
    let captured: AccountId | null = null;
    const accountId = asAccountId(ulid());
    await withTenantContext(T_US, () =>
      createAccount(
        {
          account_id: accountId,
          tenant_id: T_US,
          phone_e164: uniquePhone('+1'),
          first_name: 'A',
          last_name: 'B',
          date_of_birth: '1990-01-01',
          gender: 'prefer_not_to_say',
          country_of_residence: 'US',
          country_of_care: 'US',
        },
        async (_tx, persisted) => {
          captured = persisted.account_id;
        },
        getTestClient(),
      ),
    );
    expect(captured).toBe(accountId);
  });

  it('§3d phone-uniqueness violation surfaces SQLSTATE 23505', async () => {
    const phone = uniquePhone('+1');
    await withTenantContext(T_US, () =>
      createAccount(
        {
          account_id: asAccountId(ulid()),
          tenant_id: T_US,
          phone_e164: phone,
          first_name: 'A',
          last_name: 'B',
          date_of_birth: '1990-01-01',
          gender: 'prefer_not_to_say',
          country_of_residence: 'US',
          country_of_care: 'US',
        },
        async () => {},
        getTestClient(),
      ),
    );

    await expect(
      withTenantContext(T_US, () =>
        createAccount(
          {
            account_id: asAccountId(ulid()),
            tenant_id: T_US,
            phone_e164: phone, // duplicate
            first_name: 'C',
            last_name: 'D',
            date_of_birth: '1990-01-01',
            gender: 'prefer_not_to_say',
            country_of_residence: 'US',
            country_of_care: 'US',
          },
          async () => {},
          getTestClient(),
        ),
      ),
    ).rejects.toThrow(/duplicate key|uq_account_tenant_phone|unique constraint/i);
  });
});

// ---------------------------------------------------------------------------
// §4 — activateAccount
// ---------------------------------------------------------------------------

describe('account-repo §4 activateAccount', () => {
  it('§4a flips pending_verification → active and sets activated_at', async () => {
    const accountId = asAccountId(ulid());
    await withTenantContext(T_US, () =>
      createAccount(
        {
          account_id: accountId,
          tenant_id: T_US,
          phone_e164: uniquePhone('+1'),
          first_name: 'A',
          last_name: 'B',
          date_of_birth: '1990-01-01',
          gender: 'prefer_not_to_say',
          country_of_residence: 'US',
          country_of_care: 'US',
        },
        async () => {},
        getTestClient(),
      ),
    );

    const activated = await withTenantContext(T_US, () =>
      activateAccount(T_US, accountId, getTestClient()),
    );
    expect(activated).not.toBeNull();
    expect(activated!.status).toBe('active');
    expect(activated!.activated_at).toBeTruthy();
  });

  it('§4b returns null on already-active account (idempotent no-op)', async () => {
    const accountId = asAccountId(ulid());
    await withTenantContext(T_US, () =>
      createAccount(
        {
          account_id: accountId,
          tenant_id: T_US,
          phone_e164: uniquePhone('+1'),
          first_name: 'A',
          last_name: 'B',
          date_of_birth: '1990-01-01',
          gender: 'prefer_not_to_say',
          country_of_residence: 'US',
          country_of_care: 'US',
        },
        async () => {},
        getTestClient(),
      ),
    );

    // First activation succeeds
    await withTenantContext(T_US, () => activateAccount(T_US, accountId, getTestClient()));

    // Second activation → null (already active; the WHERE filters it out)
    const second = await withTenantContext(T_US, () =>
      activateAccount(T_US, accountId, getTestClient()),
    );
    expect(second).toBeNull();
  });

  it('§4c returns null on cross-tenant attempt', async () => {
    const accountId = asAccountId(ulid());
    await withTenantContext(T_GH, () =>
      createAccount(
        {
          account_id: accountId,
          tenant_id: T_GH,
          phone_e164: uniquePhone('+233'),
          first_name: 'A',
          last_name: 'B',
          date_of_birth: '1990-01-01',
          gender: 'prefer_not_to_say',
          country_of_residence: 'GH',
          country_of_care: 'GH',
        },
        async () => {},
        getTestClient(),
      ),
    );

    const fromUS = await withTenantContext(T_US, () =>
      activateAccount(T_US, accountId, getTestClient()),
    );
    expect(fromUS).toBeNull();
  });

  it('§4d returns null on phantom account_id', async () => {
    const phantom = asAccountId(ulid());
    const result = await withTenantContext(T_US, () =>
      activateAccount(T_US, phantom, getTestClient()),
    );
    expect(result).toBeNull();
  });
});
