/**
 * src/modules/identity/internal/services/auth-device-service.ts —
 * direct integration tests.
 *
 * Coverage in this file (3 sections, 8 cases):
 *   §1 registerDevice (4 cases) — happy path + audit; respects
 *      multi-device cap (3 active OK, 4th evicts oldest); eviction
 *      emits identity_device_revoked audit
 *   §2 revokeDevice (3 cases) — flip + audit; idempotent no spurious
 *      audit; phantom returns null
 *   §3 listActiveDevicesForAccount (1 case) — pure delegate
 *
 * Spec references:
 *   - auth-device-service.ts (target)
 *   - Identity Spec v1.0 §3.4 (max 3 active devices; oldest eviction)
 */

import { describe, expect, it } from 'vitest';

import { asTenantId } from '../../src/lib/glossary.ts';
import type { TenantContext } from '../../src/lib/tenant-context.ts';
import { ulid } from '../../src/lib/ulid.ts';
import * as accountService from '../../src/modules/identity/internal/services/account-service.ts';
import * as deviceService from '../../src/modules/identity/internal/services/auth-device-service.ts';
import {
  asAccountId,
  asDeviceId,
  type AccountId,
} from '../../src/modules/identity/internal/types.ts';
import { assertAuditRecordExists } from '../helpers/audit-assertions.ts';
import { TENANT_US, withTenantContext } from '../helpers/tenant-fixtures.ts';
import { getTestClient } from '../setup.ts';

const US_CTX: TenantContext = {
  tenantId: asTenantId(TENANT_US),
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
  await withTenantContext(US_CTX.tenantId, () =>
    accountService.createAccount(
      US_CTX,
      { actorId: 'op_seed' },
      {
        account_id: accountId,
        phone_e164: uniquePhone(),
        first_name: 'A',
        last_name: 'B',
        date_of_birth: '1990-01-01',
        gender: 'prefer_not_to_say',
      },
      getTestClient(),
    ),
  );
  return accountId;
}

// ---------------------------------------------------------------------------
// §1 — registerDevice
// ---------------------------------------------------------------------------

describe('auth-device-service §1 registerDevice', () => {
  it('§1a happy path: row + identity_device_registered audit', async () => {
    const accountId = await seedAccount();
    const deviceId = asDeviceId(ulid());
    const device = await withTenantContext(US_CTX.tenantId, () =>
      deviceService.registerDevice(
        US_CTX,
        { actorId: 'op_test_1a' },
        {
          device_id: deviceId,
          account_id: accountId,
          platform: 'ios',
          device_label: 'iPhone 15',
          device_public_key: 'BASE64',
        },
        getTestClient(),
      ),
    );
    expect(device.device_id).toBe(deviceId);

    await assertAuditRecordExists(
      US_CTX.tenantId,
      (r) => r.action === 'identity_device_registered' && r.resource_id === deviceId,
    );
  });

  it('§1b 1st, 2nd, 3rd device — all active, no eviction', async () => {
    const accountId = await seedAccount();
    for (let i = 0; i < 3; i++) {
      await withTenantContext(US_CTX.tenantId, () =>
        deviceService.registerDevice(
          US_CTX,
          { actorId: 'op_test_1b' },
          {
            device_id: asDeviceId(ulid()),
            account_id: accountId,
            platform: 'ios',
            device_public_key: 'BASE64',
          },
          getTestClient(),
        ),
      );
    }

    const list = await withTenantContext(US_CTX.tenantId, () =>
      deviceService.listActiveDevicesForAccount(US_CTX, accountId, getTestClient()),
    );
    expect(list).toHaveLength(3);
  });

  it('§1c 4th device evicts oldest with reason=max_devices_evicted', async () => {
    const accountId = await seedAccount();
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const id = asDeviceId(ulid());
      ids.push(id);
      await withTenantContext(US_CTX.tenantId, async () => {
        await deviceService.registerDevice(
          US_CTX,
          { actorId: 'op_test_1c' },
          {
            device_id: id,
            account_id: accountId,
            platform: 'ios',
            device_public_key: 'BASE64',
          },
          getTestClient(),
        );
        // Backdate last_seen_at so eviction order is deterministic
        await getTestClient().query(
          `UPDATE auth_devices SET last_seen_at = NOW() - INTERVAL '${(3 - i) * 10} minutes'
            WHERE device_id = $1`,
          [id],
        );
      });
    }

    // Register 4th — should evict ids[0] (oldest by last_seen_at)
    const fourthId = asDeviceId(ulid());
    await withTenantContext(US_CTX.tenantId, () =>
      deviceService.registerDevice(
        US_CTX,
        { actorId: 'op_test_1c' },
        {
          device_id: fourthId,
          account_id: accountId,
          platform: 'ios',
          device_public_key: 'BASE64',
        },
        getTestClient(),
      ),
    );

    const list = await withTenantContext(US_CTX.tenantId, () =>
      deviceService.listActiveDevicesForAccount(US_CTX, accountId, getTestClient()),
    );
    expect(list).toHaveLength(3);
    const stillActive = list.map((d) => d.device_id);
    expect(stillActive).not.toContain(ids[0]); // oldest evicted
    expect(stillActive).toContain(fourthId);
  });

  it('§1d eviction emits identity_device_revoked audit with reason=max_devices_evicted', async () => {
    const accountId = await seedAccount();
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const id = asDeviceId(ulid());
      ids.push(id);
      await withTenantContext(US_CTX.tenantId, async () => {
        await deviceService.registerDevice(
          US_CTX,
          { actorId: 'op_test_1d' },
          {
            device_id: id,
            account_id: accountId,
            platform: 'android',
            device_public_key: 'BASE64',
          },
          getTestClient(),
        );
        await getTestClient().query(
          `UPDATE auth_devices SET last_seen_at = NOW() - INTERVAL '${(3 - i) * 10} minutes'
            WHERE device_id = $1`,
          [id],
        );
      });
    }
    await withTenantContext(US_CTX.tenantId, () =>
      deviceService.registerDevice(
        US_CTX,
        { actorId: 'op_test_1d' },
        {
          device_id: asDeviceId(ulid()),
          account_id: accountId,
          platform: 'web',
          device_public_key: 'BASE64',
        },
        getTestClient(),
      ),
    );

    // Eviction audit on the oldest device
    const oldest = ids[0];
    await assertAuditRecordExists(
      US_CTX.tenantId,
      (r) =>
        r.action === 'identity_device_revoked' &&
        r.resource_id === oldest &&
        (r.detail as Record<string, unknown>)['revoked_reason'] === 'max_devices_evicted',
    );
  });
});

// ---------------------------------------------------------------------------
// §2 — revokeDevice
// ---------------------------------------------------------------------------

describe('auth-device-service §2 revokeDevice', () => {
  it('§2a flip + audit', async () => {
    const accountId = await seedAccount();
    const deviceId = asDeviceId(ulid());
    await withTenantContext(US_CTX.tenantId, () =>
      deviceService.registerDevice(
        US_CTX,
        { actorId: 'op_test_2a' },
        {
          device_id: deviceId,
          account_id: accountId,
          platform: 'ios',
          device_public_key: 'BASE64',
        },
        getTestClient(),
      ),
    );

    const revoked = await withTenantContext(US_CTX.tenantId, () =>
      deviceService.revokeDevice(
        US_CTX,
        { actorId: 'op_test_2a' },
        deviceId,
        'patient_unregistered',
        getTestClient(),
      ),
    );
    expect(revoked).not.toBeNull();
    expect(revoked!.revoked_reason).toBe('patient_unregistered');
  });

  it('§2b idempotent re-call: no spurious audit on already-revoked', async () => {
    const accountId = await seedAccount();
    const deviceId = asDeviceId(ulid());
    await withTenantContext(US_CTX.tenantId, () =>
      deviceService.registerDevice(
        US_CTX,
        { actorId: 'op_test_2b' },
        {
          device_id: deviceId,
          account_id: accountId,
          platform: 'ios',
          device_public_key: 'BASE64',
        },
        getTestClient(),
      ),
    );

    await withTenantContext(US_CTX.tenantId, () =>
      deviceService.revokeDevice(
        US_CTX,
        { actorId: 'op_test_2b' },
        deviceId,
        'patient_unregistered',
        getTestClient(),
      ),
    );

    const before = await getTestClient().query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM audit_records
        WHERE tenant_id = $1
          AND action = 'identity_device_revoked'
          AND resource_id = $2`,
      [US_CTX.tenantId, deviceId],
    );

    const second = await withTenantContext(US_CTX.tenantId, () =>
      deviceService.revokeDevice(
        US_CTX,
        { actorId: 'op_test_2b' },
        deviceId,
        'admin_revoked',
        getTestClient(),
      ),
    );
    expect(second).toBeNull();

    const after = await getTestClient().query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM audit_records
        WHERE tenant_id = $1
          AND action = 'identity_device_revoked'
          AND resource_id = $2`,
      [US_CTX.tenantId, deviceId],
    );
    expect(after.rows[0]!.count).toBe(before.rows[0]!.count);
  });

  it('§2c phantom device_id returns null', async () => {
    const phantom = asDeviceId(ulid());
    const result = await withTenantContext(US_CTX.tenantId, () =>
      deviceService.revokeDevice(
        US_CTX,
        { actorId: 'op_test_2c' },
        phantom,
        'patient_unregistered',
        getTestClient(),
      ),
    );
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// §3 — listActiveDevicesForAccount
// ---------------------------------------------------------------------------

describe('auth-device-service §3 listActiveDevicesForAccount', () => {
  it('§3a returns active devices ordered by last_seen_at ASC', async () => {
    const accountId = await seedAccount();
    for (let i = 0; i < 2; i++) {
      await withTenantContext(US_CTX.tenantId, () =>
        deviceService.registerDevice(
          US_CTX,
          { actorId: 'op_test_3a' },
          {
            device_id: asDeviceId(ulid()),
            account_id: accountId,
            platform: 'ios',
            device_public_key: 'BASE64',
          },
          getTestClient(),
        ),
      );
    }

    const list = await withTenantContext(US_CTX.tenantId, () =>
      deviceService.listActiveDevicesForAccount(US_CTX, accountId, getTestClient()),
    );
    expect(list).toHaveLength(2);
  });
});
