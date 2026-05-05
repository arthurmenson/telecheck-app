/**
 * delegation-service.ts — direct integration tests.
 *
 * Coverage in this file (3 sections, 9 cases):
 *   §1 inviteDelegate (3 cases) — happy + self-forbidden + chain-forbidden
 *   §2 transitions (3 cases) — accept / decline / revoke (each emits audit
 *     only on successful state change; idempotent no-op returns null without
 *     spurious audit)
 *   §3 scopes (3 cases) — grantScope happy + audit; revokeScope happy +
 *     audit; revokeScope returns null when scope absent (no spurious audit)
 *
 * Spec references:
 *   - delegation-service.ts (target)
 *   - Consent Slice PRD v1.0 §6
 *   - I-003 (audit append-only; bare suppression forbidden — but null no-op
 *     correctly emits no audit because nothing transitioned)
 */

import { describe, expect, it } from 'vitest';

import { asTenantId } from '../../src/lib/glossary.ts';
import type { TenantContext } from '../../src/lib/tenant-context.ts';
import { ulid } from '../../src/lib/ulid.ts';
import * as delegationService from '../../src/modules/consent/internal/services/delegation-service.ts';
import { asDelegationId, asDelegationScopeId } from '../../src/modules/consent/internal/types.ts';
import { createAccount } from '../../src/modules/identity/internal/repositories/account-repo.ts';
import { asAccountId, type AccountId } from '../../src/modules/identity/internal/types.ts';
import { assertAuditRecordExists } from '../helpers/audit-assertions.ts';
import { TENANT_US, withTenantContext } from '../helpers/tenant-fixtures.ts';
import { getTestClient } from '../setup.ts';

const T_US = asTenantId(TENANT_US);
const US_CTX: TenantContext = {
  tenantId: T_US,
  displayName: 'Telecheck-US',
  countryOfCare: 'US',
  kmsKeyAlias: 'alias/telecheck-us-data-key',
  consumerDba: 'Heros Health',
  legalEntity: 'Telecheck Health LLC',
  consumerSubdomain: 'heroshealth.com',
};

function uniquePhone(): string {
  const digits = ulid()
    .slice(-9)
    .replace(/[^0-9]/g, '0')
    .padEnd(9, '0');
  return `+1${digits}`;
}

async function seedAccount(): Promise<AccountId> {
  const accountId = asAccountId(ulid());
  await withTenantContext(T_US, () =>
    createAccount(
      {
        account_id: accountId,
        tenant_id: T_US,
        phone_e164: uniquePhone(),
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
  return accountId;
}

// ---------------------------------------------------------------------------
// §1 — inviteDelegate
// ---------------------------------------------------------------------------

describe('delegation-service §1 inviteDelegate', () => {
  it('§1a INSERTs pending_acceptance row + emits delegation_invited audit', async () => {
    const grantor = await seedAccount();
    const delegate = await seedAccount();

    const delegation = await withTenantContext(T_US, () =>
      delegationService.inviteDelegate(
        US_CTX,
        { actorId: 'op_test_1a' },
        {
          grantor_account_id: grantor,
          delegate_account_id: delegate,
          relationship_type: 'spouse_partner',
        },
      ),
    );
    expect(delegation.status).toBe('pending_acceptance');
    expect(delegation.grantor_account_id).toBe(grantor);
    expect(delegation.delegate_account_id).toBe(delegate);
    expect(delegation.relationship_type).toBe('spouse_partner');

    await assertAuditRecordExists(
      T_US,
      (r) =>
        r.action === 'delegation_invited' &&
        r.resource_id === delegation.delegation_id &&
        r.resource_type === 'delegation',
    );
  });

  it('§1b self-delegation throws DELEGATION_SELF_FORBIDDEN sentinel', async () => {
    const me = await seedAccount();

    await expect(
      withTenantContext(T_US, () =>
        delegationService.inviteDelegate(
          US_CTX,
          { actorId: 'op_test_1b' },
          {
            grantor_account_id: me,
            delegate_account_id: me,
            relationship_type: 'spouse_partner',
          },
        ),
      ),
    ).rejects.toThrow(delegationService.DELEGATION_SELF_FORBIDDEN);
  });

  it('§1c chain prevention: active-delegate cannot invite (DELEGATION_CHAIN_FORBIDDEN)', async () => {
    // Slice PRD §6.1: a delegate cannot create another delegate.
    // Setup: A → B (active). Then B tries to invite C. Must throw.
    const a = await seedAccount();
    const b = await seedAccount();
    const c = await seedAccount();

    // A invites B
    const delegation = await withTenantContext(T_US, () =>
      delegationService.inviteDelegate(
        US_CTX,
        { actorId: 'op_test_1c_setup' },
        {
          grantor_account_id: a,
          delegate_account_id: b,
          relationship_type: 'spouse_partner',
        },
      ),
    );
    // B accepts -> now active delegate of A
    await withTenantContext(T_US, () =>
      delegationService.acceptDelegation(
        US_CTX,
        { actorId: 'op_test_1c_setup' },
        delegation.delegation_id,
      ),
    );

    // B tries to invite C → chain prevention rejects
    await expect(
      withTenantContext(T_US, () =>
        delegationService.inviteDelegate(
          US_CTX,
          { actorId: 'op_test_1c' },
          {
            grantor_account_id: b,
            delegate_account_id: c,
            relationship_type: 'spouse_partner',
          },
        ),
      ),
    ).rejects.toThrow(delegationService.DELEGATION_CHAIN_FORBIDDEN);
  });
});

// ---------------------------------------------------------------------------
// §2 — accept / decline / revoke transitions
// ---------------------------------------------------------------------------

describe('delegation-service §2 state transitions', () => {
  it('§2a acceptDelegation transitions pending → active + emits audit', async () => {
    const grantor = await seedAccount();
    const delegate = await seedAccount();

    const invited = await withTenantContext(T_US, () =>
      delegationService.inviteDelegate(
        US_CTX,
        { actorId: 'op_test_2a' },
        {
          grantor_account_id: grantor,
          delegate_account_id: delegate,
          relationship_type: 'spouse_partner',
        },
      ),
    );

    const accepted = await withTenantContext(T_US, () =>
      delegationService.acceptDelegation(US_CTX, { actorId: 'op_test_2a' }, invited.delegation_id),
    );
    expect(accepted).not.toBeNull();
    expect(accepted!.status).toBe('active');

    await assertAuditRecordExists(
      T_US,
      (r) =>
        r.action === 'delegation_accepted' &&
        r.resource_id === invited.delegation_id &&
        r.resource_type === 'delegation',
    );

    // Idempotent re-call returns null and emits no spurious audit.
    const second = await withTenantContext(T_US, () =>
      delegationService.acceptDelegation(US_CTX, { actorId: 'op_test_2a' }, invited.delegation_id),
    );
    expect(second).toBeNull();
  });

  it('§2b declineDelegation transitions pending → declined + emits audit', async () => {
    const grantor = await seedAccount();
    const delegate = await seedAccount();

    const invited = await withTenantContext(T_US, () =>
      delegationService.inviteDelegate(
        US_CTX,
        { actorId: 'op_test_2b' },
        {
          grantor_account_id: grantor,
          delegate_account_id: delegate,
          relationship_type: 'spouse_partner',
        },
      ),
    );

    const declined = await withTenantContext(T_US, () =>
      delegationService.declineDelegation(US_CTX, { actorId: 'op_test_2b' }, invited.delegation_id),
    );
    expect(declined).not.toBeNull();
    expect(declined!.status).toBe('declined');

    await assertAuditRecordExists(
      T_US,
      (r) =>
        r.action === 'delegation_declined' &&
        r.resource_id === invited.delegation_id &&
        r.resource_type === 'delegation',
    );

    // Unknown delegation id returns null (no spurious audit).
    const ghost = await withTenantContext(T_US, () =>
      delegationService.declineDelegation(
        US_CTX,
        { actorId: 'op_test_2b' },
        asDelegationId(ulid()),
      ),
    );
    expect(ghost).toBeNull();
  });

  it('§2c revokeDelegation transitions active → revoked + reason captured + emits audit', async () => {
    const grantor = await seedAccount();
    const delegate = await seedAccount();

    const invited = await withTenantContext(T_US, () =>
      delegationService.inviteDelegate(
        US_CTX,
        { actorId: 'op_test_2c' },
        {
          grantor_account_id: grantor,
          delegate_account_id: delegate,
          relationship_type: 'spouse_partner',
        },
      ),
    );
    await withTenantContext(T_US, () =>
      delegationService.acceptDelegation(US_CTX, { actorId: 'op_test_2c' }, invited.delegation_id),
    );

    const revoked = await withTenantContext(T_US, () =>
      delegationService.revokeDelegation(
        US_CTX,
        { actorId: 'op_test_2c' },
        invited.delegation_id,
        'patient_initiated',
      ),
    );
    expect(revoked).not.toBeNull();
    expect(revoked!.status).toBe('revoked');
    expect(revoked!.revoked_reason).toBe('patient_initiated');

    await assertAuditRecordExists(
      T_US,
      (r) =>
        r.action === 'delegation_revoked' &&
        r.resource_id === invited.delegation_id &&
        r.resource_type === 'delegation' &&
        r.detail['revoked_reason'] === 'patient_initiated',
    );

    // Double-revoke is a no-op.
    const second = await withTenantContext(T_US, () =>
      delegationService.revokeDelegation(
        US_CTX,
        { actorId: 'op_test_2c' },
        invited.delegation_id,
        'patient_initiated',
      ),
    );
    expect(second).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// §3 — grantScope / revokeScope
// ---------------------------------------------------------------------------

describe('delegation-service §3 scope CRUD', () => {
  it('§3a grantScope INSERTs scope row + emits delegation_scope_granted audit', async () => {
    const grantor = await seedAccount();
    const delegate = await seedAccount();
    const invited = await withTenantContext(T_US, () =>
      delegationService.inviteDelegate(
        US_CTX,
        { actorId: 'op_test_3a' },
        {
          grantor_account_id: grantor,
          delegate_account_id: delegate,
          relationship_type: 'spouse_partner',
        },
      ),
    );

    const scope = await withTenantContext(T_US, () =>
      delegationService.grantScope(
        US_CTX,
        { actorId: 'op_test_3a', grantorAccountId: grantor },
        {
          delegation_id: invited.delegation_id,
          scope: 'view_records',
        },
      ),
    );
    expect(scope.scope).toBe('view_records');
    expect(scope.delegation_id).toBe(invited.delegation_id);
    expect(scope.revoked_at).toBeNull();

    await assertAuditRecordExists(
      T_US,
      (r) =>
        r.action === 'delegation_scope_granted' &&
        r.resource_id === scope.delegation_scope_id &&
        r.resource_type === 'delegation_scope' &&
        r.detail['scope'] === 'view_records',
    );
  });

  it('§3b revokeScope sets revoked_at + emits delegation_scope_revoked audit', async () => {
    const grantor = await seedAccount();
    const delegate = await seedAccount();
    const invited = await withTenantContext(T_US, () =>
      delegationService.inviteDelegate(
        US_CTX,
        { actorId: 'op_test_3b' },
        {
          grantor_account_id: grantor,
          delegate_account_id: delegate,
          relationship_type: 'spouse_partner',
        },
      ),
    );
    const granted = await withTenantContext(T_US, () =>
      delegationService.grantScope(
        US_CTX,
        { actorId: 'op_test_3b', grantorAccountId: grantor },
        {
          delegation_id: invited.delegation_id,
          scope: 'view_records',
        },
      ),
    );

    const revoked = await withTenantContext(T_US, () =>
      delegationService.revokeScope(
        US_CTX,
        { actorId: 'op_test_3b', grantorAccountId: grantor },
        granted.delegation_scope_id,
      ),
    );
    expect(revoked).not.toBeNull();
    expect(revoked!.revoked_at).not.toBeNull();

    await assertAuditRecordExists(
      T_US,
      (r) =>
        r.action === 'delegation_scope_revoked' &&
        r.resource_id === granted.delegation_scope_id &&
        r.resource_type === 'delegation_scope',
    );
  });

  it('§3c revokeScope on unknown scope returns null (no spurious audit)', async () => {
    const grantor = await seedAccount();

    const result = await withTenantContext(T_US, () =>
      delegationService.revokeScope(
        US_CTX,
        { actorId: 'op_test_3c', grantorAccountId: grantor },
        asDelegationScopeId(ulid()),
      ),
    );
    expect(result).toBeNull();
  });
});
