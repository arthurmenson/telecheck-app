/**
 * src/modules/identity/internal/repositories/auth-device-repo.ts —
 * direct integration tests against migration 015.
 *
 * Coverage in this file (4 sections, 9 cases):
 *   §1 createAuthDevice — round-trip + txCallback + attestation_format
 *      defaults to 'placeholder'
 *   §2 findAuthDeviceById — happy path, phantom miss
 *   §3 listActiveDevicesForAccount — count + ordering by last_seen_at
 *      ASC (oldest first for max-3-device eviction)
 *   §4 revokeAuthDevice — flip + idempotent on already-revoked
 *
 * Spec references:
 *   - auth-device-repo.ts (target)
 *   - migrations/015_auth_devices.sql
 *   - Identity Spec v1.0 §3.1 (biometric / device-bound) + §3.4
 *     (multi-device max 3)
 */

import { describe, expect, it } from 'vitest';

import type { TenantId } from '../../src/lib/glossary.ts';
import { ulid } from '../../src/lib/ulid.ts';
import { createAccount } from '../../src/modules/identity/internal/repositories/account-repo.ts';
import {
  createAuthDevice,
  findAuthDeviceById,
  listActiveDevicesForAccount,
  revokeAuthDevice,
} from '../../src/modules/identity/internal/repositories/auth-device-repo.ts';
import {
  asAccountId,
  asDeviceId,
  type AccountId,
} from '../../src/modules/identity/internal/types.ts';
import { TENANT_US, withTenantContext } from '../helpers/tenant-fixtures.ts';
import { getTestClient } from '../setup.ts';

const T_US = TENANT_US as TenantId;

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
// §1 — createAuthDevice
// ---------------------------------------------------------------------------

describe('auth-device-repo §1 createAuthDevice', () => {
  it('§1a INSERT round-trip with attestation_format defaulting to placeholder', async () => {
    const accountId = await seedAccount();
    const deviceId = asDeviceId(ulid());
    const device = await withTenantContext(T_US, () =>
      createAuthDevice(
        {
          device_id: deviceId,
          tenant_id: T_US,
          account_id: accountId,
          platform: 'ios',
          device_label: 'iPhone 15',
          device_public_key: 'BASE64-KEY',
        },
        async () => {},
        getTestClient(),
      ),
    );
    expect(device.device_id).toBe(deviceId);
    expect(device.platform).toBe('ios');
    expect(device.attestation_format).toBe('placeholder');
    expect(device.device_label).toBe('iPhone 15');
    expect(device.revoked_at).toBeNull();
  });

  it('§1b txCallback fires inside transaction', async () => {
    const accountId = await seedAccount();
    let captured: string | null = null;
    const deviceId = asDeviceId(ulid());
    await withTenantContext(T_US, () =>
      createAuthDevice(
        {
          device_id: deviceId,
          tenant_id: T_US,
          account_id: accountId,
          platform: 'web',
          device_public_key: 'BASE64-KEY',
        },
        async (_tx, persisted) => {
          captured = persisted.device_id;
        },
        getTestClient(),
      ),
    );
    expect(captured).toBe(deviceId);
  });
});

// ---------------------------------------------------------------------------
// §2 — findAuthDeviceById
// ---------------------------------------------------------------------------

describe('auth-device-repo §2 findAuthDeviceById', () => {
  it('§2a returns row on same-tenant match', async () => {
    const accountId = await seedAccount();
    const deviceId = asDeviceId(ulid());
    await withTenantContext(T_US, () =>
      createAuthDevice(
        {
          device_id: deviceId,
          tenant_id: T_US,
          account_id: accountId,
          platform: 'android',
          device_public_key: 'BASE64-KEY',
        },
        async () => {},
        getTestClient(),
      ),
    );

    const found = await withTenantContext(T_US, () =>
      findAuthDeviceById(T_US, deviceId, getTestClient()),
    );
    expect(found).not.toBeNull();
    expect(found!.platform).toBe('android');
  });

  it('§2b returns null on phantom device_id', async () => {
    const phantom = asDeviceId(ulid());
    const found = await withTenantContext(T_US, () =>
      findAuthDeviceById(T_US, phantom, getTestClient()),
    );
    expect(found).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// §3 — listActiveDevicesForAccount
// ---------------------------------------------------------------------------

describe('auth-device-repo §3 listActiveDevicesForAccount', () => {
  it('§3a returns devices ordered by last_seen_at ASC (oldest first)', async () => {
    const accountId = await seedAccount();

    // Insert 3 devices; manually adjust last_seen_at to force a known
    // order (PostgreSQL clock_timestamp() at INSERT will produce
    // microsecond differences but they're not deterministic enough
    // for an ORDER BY assertion).
    const deviceIds = [asDeviceId(ulid()), asDeviceId(ulid()), asDeviceId(ulid())];
    await withTenantContext(T_US, async () => {
      const client = getTestClient();
      for (let i = 0; i < deviceIds.length; i++) {
        await createAuthDevice(
          {
            device_id: deviceIds[i]!,
            tenant_id: T_US,
            account_id: accountId,
            platform: 'ios',
            device_public_key: 'BASE64-KEY',
          },
          async () => {},
          client,
        );
        // Set last_seen_at deterministically: device 0 = oldest, 2 = newest.
        // Using INTERVAL offsets so each row is unambiguously ordered.
        await client.query(
          `UPDATE auth_devices
              SET last_seen_at = NOW() - INTERVAL '${(deviceIds.length - i) * 10} minutes'
            WHERE device_id = $1`,
          [deviceIds[i]],
        );
      }
    });

    const list = await withTenantContext(T_US, () =>
      listActiveDevicesForAccount(T_US, accountId, getTestClient()),
    );
    expect(list).toHaveLength(3);
    // ASC: oldest (largest negative offset) first.
    expect(list[0]!.device_id).toBe(deviceIds[0]);
    expect(list[1]!.device_id).toBe(deviceIds[1]);
    expect(list[2]!.device_id).toBe(deviceIds[2]);
  });

  it('§3b excludes revoked devices', async () => {
    const accountId = await seedAccount();
    const deviceId = asDeviceId(ulid());
    await withTenantContext(T_US, () =>
      createAuthDevice(
        {
          device_id: deviceId,
          tenant_id: T_US,
          account_id: accountId,
          platform: 'ios',
          device_public_key: 'BASE64-KEY',
        },
        async () => {},
        getTestClient(),
      ),
    );
    await withTenantContext(T_US, () =>
      revokeAuthDevice(T_US, deviceId, 'patient_unregistered', getTestClient()),
    );

    const list = await withTenantContext(T_US, () =>
      listActiveDevicesForAccount(T_US, accountId, getTestClient()),
    );
    expect(list).toHaveLength(0);
  });

  it('§3c returns empty when account has no devices', async () => {
    const accountId = await seedAccount();
    const list = await withTenantContext(T_US, () =>
      listActiveDevicesForAccount(T_US, accountId, getTestClient()),
    );
    expect(list).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// §4 — revokeAuthDevice
// ---------------------------------------------------------------------------

describe('auth-device-repo §4 revokeAuthDevice', () => {
  it('§4a flips revoked_at + revoked_reason; returns updated row', async () => {
    const accountId = await seedAccount();
    const deviceId = asDeviceId(ulid());
    await withTenantContext(T_US, () =>
      createAuthDevice(
        {
          device_id: deviceId,
          tenant_id: T_US,
          account_id: accountId,
          platform: 'ios',
          device_public_key: 'BASE64-KEY',
        },
        async () => {},
        getTestClient(),
      ),
    );

    const revoked = await withTenantContext(T_US, () =>
      revokeAuthDevice(T_US, deviceId, 'max_devices_evicted', getTestClient()),
    );
    expect(revoked).not.toBeNull();
    expect(revoked!.revoked_at).toBeTruthy();
    expect(revoked!.revoked_reason).toBe('max_devices_evicted');
  });

  it('§4b returns null on already-revoked (idempotent no-op)', async () => {
    const accountId = await seedAccount();
    const deviceId = asDeviceId(ulid());
    await withTenantContext(T_US, () =>
      createAuthDevice(
        {
          device_id: deviceId,
          tenant_id: T_US,
          account_id: accountId,
          platform: 'ios',
          device_public_key: 'BASE64-KEY',
        },
        async () => {},
        getTestClient(),
      ),
    );

    await withTenantContext(T_US, () =>
      revokeAuthDevice(T_US, deviceId, 'patient_unregistered', getTestClient()),
    );
    const second = await withTenantContext(T_US, () =>
      revokeAuthDevice(T_US, deviceId, 'admin_revoked', getTestClient()),
    );
    expect(second).toBeNull();
  });
});
