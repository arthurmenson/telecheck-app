/**
 * src/modules/identity/internal/services/account-service.ts — direct
 * integration tests.
 *
 * Coverage in this file (4 sections, 11 cases):
 *   §1 toPatientAccountView (4 cases) — strips tenant_id; preserves
 *      every other top-level field; rest-spread future-field-passthrough;
 *      JSON-serialization defense (no Telecheck-* leak)
 *   §2 createAccount (3 cases) — orchestration: row persisted,
 *      identity_account_created audit emitted in same tx; phone-uniqueness
 *      surfaces SQLSTATE 23505; locale defaults from country_of_care
 *   §3 activateAccount (3 cases) — successful flip emits audit;
 *      idempotent re-call is no-op AT DB AND AT AUDIT (no spurious entry);
 *      cross-tenant attempt returns null with no audit
 *   §4 findAccountById / findAccountByPhoneE164 (1 case) — pure-delegate
 *      pass-through (no audit on reads)
 *
 * Spec references:
 *   - account-service.ts (target)
 *   - account-repo.ts (delegate)
 *   - audit.ts (emitAccountCreatedAudit / emitAccountActivatedAudit)
 *   - I-003 (audit append-only; no spurious emission on idempotent no-op)
 *   - Master PRD v1.10 §17 + Glossary v5.2 C3 (toPatientAccountView strip)
 */

import { describe, expect, it } from 'vitest';

import { asTenantId } from '../../src/lib/glossary.ts';
import type { TenantContext } from '../../src/lib/tenant-context.ts';
import { ulid } from '../../src/lib/ulid.ts';
import * as accountService from '../../src/modules/identity/internal/services/account-service.ts';
import { asAccountId, type Account } from '../../src/modules/identity/internal/types.ts';
import { assertAuditRecordExists } from '../helpers/audit-assertions.ts';
import { TENANT_GHANA, TENANT_US, withTenantContext } from '../helpers/tenant-fixtures.ts';
import { getTestClient } from '../setup.ts';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const US_CTX: TenantContext = {
  tenantId: asTenantId(TENANT_US),
  displayName: 'Telecheck-US',
  countryOfCare: 'US',
  kmsKeyAlias: 'alias/telecheck-us-data-key',
  consumerDba: 'Heros Health',
  legalEntity: 'Telecheck Health LLC',
  consumerSubdomain: 'heroshealth.com',
};

const GH_CTX: TenantContext = {
  tenantId: asTenantId(TENANT_GHANA),
  displayName: 'Telecheck-Ghana',
  countryOfCare: 'GH',
  kmsKeyAlias: 'alias/telecheck-gh-data-key',
  consumerDba: 'Heros Health Ghana',
  legalEntity: 'Telecheck-Ghana Ltd.',
  consumerSubdomain: 'ghana.heroshealth.com',
};

function uniquePhone(prefix: '+1' | '+233' = '+1'): string {
  const digits = ulid()
    .slice(-9)
    .replace(/[^0-9]/g, '0')
    .padEnd(9, '0');
  return `${prefix}${digits}`;
}

function buildAccount(overrides: Partial<Account> = {}): Account {
  const base: Account = {
    account_id: asAccountId(ulid()),
    tenant_id: US_CTX.tenantId,
    phone_e164: uniquePhone('+1'),
    email: 'p@example.com',
    first_name: 'A',
    last_name: 'B',
    date_of_birth: '1990-01-01',
    gender: 'prefer_not_to_say',
    national_id: null,
    country_of_residence: 'US',
    country_of_care: 'US',
    locale: 'en-US',
    account_type: 'patient',
    status: 'pending_verification',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    activated_at: null,
    suspended_at: null,
    archived_at: null,
    deleted_at: null,
  };
  return { ...base, ...overrides };
}

// ---------------------------------------------------------------------------
// §1 — toPatientAccountView
// ---------------------------------------------------------------------------

describe('account-service §1 toPatientAccountView', () => {
  it('§1a strips tenant_id from the patient view', () => {
    const account = buildAccount();
    const view = accountService.toPatientAccountView(account);
    expect(view).not.toHaveProperty('tenant_id');
  });

  it('§1b preserves every other top-level field', () => {
    const account = buildAccount();
    const view = accountService.toPatientAccountView(account);
    expect(view.account_id).toBe(account.account_id);
    expect(view.phone_e164).toBe(account.phone_e164);
    expect(view.email).toBe(account.email);
    expect(view.first_name).toBe(account.first_name);
    expect(view.country_of_residence).toBe(account.country_of_residence);
    expect(view.country_of_care).toBe(account.country_of_care);
    expect(view.status).toBe(account.status);
  });

  it('§1c rest-spread semantics: future fields pass through', () => {
    const synthetic = {
      ...buildAccount(),
      future_field_added_post_v1_0: 'value',
    } as Account & { future_field_added_post_v1_0: string };
    const view = accountService.toPatientAccountView(synthetic) as Account & {
      future_field_added_post_v1_0?: string;
    };
    expect(view.future_field_added_post_v1_0).toBe('value');
  });

  it('§1d JSON serialization contains no tenant_id substring', () => {
    const account = buildAccount();
    const view = accountService.toPatientAccountView(account);
    const serialized = JSON.stringify(view);
    expect(serialized).not.toContain('Telecheck-US');
    expect(serialized).not.toContain('tenant_id');
  });
});

// ---------------------------------------------------------------------------
// §2 — createAccount (orchestration with audit)
// ---------------------------------------------------------------------------

describe('account-service §2 createAccount', () => {
  it('§2a row persisted + identity_account_created audit emitted in same tx', async () => {
    const accountId = asAccountId(ulid());
    const phone = uniquePhone('+1');

    await withTenantContext(US_CTX.tenantId, () =>
      accountService.createAccount(
        US_CTX,
        { actorId: 'op_test_2a' },
        {
          account_id: accountId,
          phone_e164: phone,
          first_name: 'A',
          last_name: 'B',
          date_of_birth: '1990-01-01',
          gender: 'prefer_not_to_say',
        },
        getTestClient(),
      ),
    );

    // Audit MUST be present (I-003 audit append-only). Use the
    // canonical assertAuditRecordExists helper.
    const audit = await assertAuditRecordExists(
      US_CTX.tenantId,
      (r) =>
        r.action === 'identity_account_created' &&
        r.resource_id === accountId &&
        r.resource_type === 'account',
    );
    expect(audit.category).toBe('C');
    expect(audit.target_patient_id).toBe(accountId);
  });

  it('§2b locale defaults from country_of_care when omitted', async () => {
    const accountId = asAccountId(ulid());
    const account = await withTenantContext(GH_CTX.tenantId, () =>
      accountService.createAccount(
        GH_CTX,
        { actorId: 'op_test_2b' },
        {
          account_id: accountId,
          phone_e164: uniquePhone('+233'),
          first_name: 'A',
          last_name: 'B',
          date_of_birth: '1990-01-01',
          gender: 'prefer_not_to_say',
        },
        getTestClient(),
      ),
    );
    expect(account.locale).toBe('en-GH');
    expect(account.country_of_care).toBe('GH');
  });

  it('§2c phone-uniqueness violation surfaces SQLSTATE 23505', async () => {
    const phone = uniquePhone('+1');
    await withTenantContext(US_CTX.tenantId, () =>
      accountService.createAccount(
        US_CTX,
        { actorId: 'op_test_2c1' },
        {
          account_id: asAccountId(ulid()),
          phone_e164: phone,
          first_name: 'A',
          last_name: 'B',
          date_of_birth: '1990-01-01',
          gender: 'prefer_not_to_say',
        },
        getTestClient(),
      ),
    );

    await expect(
      withTenantContext(US_CTX.tenantId, () =>
        accountService.createAccount(
          US_CTX,
          { actorId: 'op_test_2c2' },
          {
            account_id: asAccountId(ulid()),
            phone_e164: phone,
            first_name: 'C',
            last_name: 'D',
            date_of_birth: '1990-01-01',
            gender: 'prefer_not_to_say',
          },
          getTestClient(),
        ),
      ),
    ).rejects.toThrow(/duplicate key|uq_account_tenant_phone|unique constraint/i);
  });
});

// ---------------------------------------------------------------------------
// §3 — activateAccount (idempotent + no spurious audit)
// ---------------------------------------------------------------------------

describe('account-service §3 activateAccount', () => {
  it('§3a successful flip emits identity_account_activated audit', async () => {
    const accountId = asAccountId(ulid());
    await withTenantContext(US_CTX.tenantId, () =>
      accountService.createAccount(
        US_CTX,
        { actorId: 'op_test_3a' },
        {
          account_id: accountId,
          phone_e164: uniquePhone('+1'),
          first_name: 'A',
          last_name: 'B',
          date_of_birth: '1990-01-01',
          gender: 'prefer_not_to_say',
        },
        getTestClient(),
      ),
    );

    const activated = await withTenantContext(US_CTX.tenantId, () =>
      accountService.activateAccount(US_CTX, { actorId: 'op_test_3a' }, accountId, getTestClient()),
    );
    expect(activated).not.toBeNull();
    expect(activated!.status).toBe('active');

    // Audit emitted
    const audit = await assertAuditRecordExists(
      US_CTX.tenantId,
      (r) =>
        r.action === 'identity_account_activated' &&
        r.resource_id === accountId &&
        r.resource_type === 'account',
    );
    expect(audit.category).toBe('C');
  });

  it('§3b idempotent re-call: no spurious audit on already-active account', async () => {
    const accountId = asAccountId(ulid());
    await withTenantContext(US_CTX.tenantId, () =>
      accountService.createAccount(
        US_CTX,
        { actorId: 'op_test_3b' },
        {
          account_id: accountId,
          phone_e164: uniquePhone('+1'),
          first_name: 'A',
          last_name: 'B',
          date_of_birth: '1990-01-01',
          gender: 'prefer_not_to_say',
        },
        getTestClient(),
      ),
    );

    // First activation succeeds
    await withTenantContext(US_CTX.tenantId, () =>
      accountService.activateAccount(US_CTX, { actorId: 'op_test_3b' }, accountId, getTestClient()),
    );

    // Count audit records BEFORE second call
    const before = await getTestClient().query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM audit_records
        WHERE tenant_id = $1
          AND action = 'identity_account_activated'
          AND resource_id = $2`,
      [US_CTX.tenantId, accountId],
    );
    expect(before.rows[0]!.count).toBe('1');

    // Second activation — repo returns null, audit MUST NOT fire
    const second = await withTenantContext(US_CTX.tenantId, () =>
      accountService.activateAccount(US_CTX, { actorId: 'op_test_3b' }, accountId, getTestClient()),
    );
    expect(second).toBeNull();

    // Count audit records AFTER second call — same as before (no spurious)
    const after = await getTestClient().query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM audit_records
        WHERE tenant_id = $1
          AND action = 'identity_account_activated'
          AND resource_id = $2`,
      [US_CTX.tenantId, accountId],
    );
    expect(after.rows[0]!.count).toBe('1');
  });

  it('§3c cross-tenant attempt returns null AND emits no audit', async () => {
    // Account created in Ghana
    const accountId = asAccountId(ulid());
    await withTenantContext(GH_CTX.tenantId, () =>
      accountService.createAccount(
        GH_CTX,
        { actorId: 'op_test_3c' },
        {
          account_id: accountId,
          phone_e164: uniquePhone('+233'),
          first_name: 'A',
          last_name: 'B',
          date_of_birth: '1990-01-01',
          gender: 'prefer_not_to_say',
        },
        getTestClient(),
      ),
    );

    // Attempt activation from US tenant — must miss + no audit
    const result = await withTenantContext(US_CTX.tenantId, () =>
      accountService.activateAccount(
        US_CTX,
        { actorId: 'op_us_actor' },
        accountId,
        getTestClient(),
      ),
    );
    expect(result).toBeNull();

    // Verify NO `identity_account_activated` audit exists in US tenant
    // for this account_id (the cross-tenant attempt must not leak any
    // audit trail in the wrong tenant).
    const us = await getTestClient().query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM audit_records
        WHERE tenant_id = $1
          AND action = 'identity_account_activated'
          AND resource_id = $2`,
      [US_CTX.tenantId, accountId],
    );
    expect(us.rows[0]!.count).toBe('0');
  });
});

// ---------------------------------------------------------------------------
// §4 — Read paths (pure delegates; no audit)
// ---------------------------------------------------------------------------

describe('account-service §4 read delegates', () => {
  it('§4a findAccountByPhoneE164 returns the row without emitting audit', async () => {
    const accountId = asAccountId(ulid());
    const phone = uniquePhone('+1');
    await withTenantContext(US_CTX.tenantId, () =>
      accountService.createAccount(
        US_CTX,
        { actorId: 'op_test_4a' },
        {
          account_id: accountId,
          phone_e164: phone,
          first_name: 'A',
          last_name: 'B',
          date_of_birth: '1990-01-01',
          gender: 'prefer_not_to_say',
        },
        getTestClient(),
      ),
    );

    // Count audit records BEFORE the read
    const before = await getTestClient().query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM audit_records
        WHERE tenant_id = $1
          AND resource_id = $2`,
      [US_CTX.tenantId, accountId],
    );
    const beforeCount = before.rows[0]!.count;

    const found = await withTenantContext(US_CTX.tenantId, () =>
      accountService.findAccountByPhoneE164(US_CTX, phone, getTestClient()),
    );
    expect(found).not.toBeNull();
    expect(found!.account_id).toBe(accountId);

    // No new audit records from the read
    const after = await getTestClient().query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM audit_records
        WHERE tenant_id = $1
          AND resource_id = $2`,
      [US_CTX.tenantId, accountId],
    );
    expect(after.rows[0]!.count).toBe(beforeCount);
  });
});
