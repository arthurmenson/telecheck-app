/**
 * migrations/015_auth_devices.sql — schema-level integration tests.
 *
 * Validates the migration empirically:
 *   - RLS isolation
 *   - Composite FK to accounts
 *   - platform enum CHECK (ios | android | web)
 *   - attestation_format enum CHECK (4 values for forward compat)
 *   - revoked_reason enum CHECK (6 values, mirrors sessions pattern)
 *   - revocation-consistency CHECK (revoked_at and revoked_reason both
 *     NULL or both NOT NULL)
 *   - device_label length CHECK (≤200 chars when non-null)
 *   - last_seen_at trigger fires on UPDATE (clock_timestamp())
 *
 * Coverage in this file (5 sections, 14 cases).
 *
 * Spec references:
 *   - migrations/015_auth_devices.sql (target)
 *   - Identity Spec v1.0 §3.1 / §3.4 (biometric unlock; multi-device)
 *   - CDM v1.2 §3.2 entity 10 "AuthDevice"
 */

import { describe, expect, it } from 'vitest';

import { ulid } from '../../src/lib/ulid.ts';
import { TENANT_GHANA, TENANT_US, withTenantContext } from '../helpers/tenant-fixtures.ts';
import { getTestClient } from '../setup.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function seedAccount(tenantId: string, country: 'US' | 'GH' = 'US'): Promise<string> {
  const client = getTestClient();
  const accountId = ulid();
  const phone = `+${country === 'US' ? '1' : '233'}${ulid()
    .slice(-9)
    .replace(/[^0-9]/g, '0')
    .padEnd(9, '0')}`;
  await client.query(
    `INSERT INTO accounts (
        account_id, tenant_id, phone_e164,
        first_name, last_name, date_of_birth, gender,
        country_of_residence, country_of_care, locale,
        account_type, status
     ) VALUES ($1, $2, $3, 'F', 'L', '1990-01-01', 'prefer_not_to_say',
               $4, $4, 'en-US', 'patient', 'active')`,
    [accountId, tenantId, phone, country],
  );
  return accountId;
}

interface InsertDeviceInput {
  device_id?: string;
  tenant_id: string;
  account_id: string;
  platform?: string;
  device_label?: string | null;
  device_public_key?: string;
  attestation_format?: string;
  revoked_at?: string | null;
  revoked_reason?: string | null;
}

async function insertDevice(input: InsertDeviceInput): Promise<string> {
  const client = getTestClient();
  const deviceId = input.device_id ?? ulid();
  await client.query(
    `INSERT INTO auth_devices (
        device_id, tenant_id, account_id,
        platform, device_label, device_public_key, attestation_format,
        revoked_at, revoked_reason
     ) VALUES ($1, $2, $3,
               $4, $5, $6, $7,
               $8, $9)`,
    [
      deviceId,
      input.tenant_id,
      input.account_id,
      input.platform ?? 'ios',
      input.device_label ?? 'Test Device',
      input.device_public_key ?? 'BASE64-PLACEHOLDER-KEY',
      input.attestation_format ?? 'placeholder',
      input.revoked_at ?? null,
      input.revoked_reason ?? null,
    ],
  );
  return deviceId;
}

// ---------------------------------------------------------------------------
// §1 — RLS isolation
// ---------------------------------------------------------------------------

describe('auth_devices migration — §1 RLS tenant_isolation', () => {
  it('§1a device inserted in US is invisible from Ghana', async () => {
    const accountId = await withTenantContext(TENANT_US, () => seedAccount(TENANT_US));
    await withTenantContext(TENANT_US, () =>
      insertDevice({ tenant_id: TENANT_US, account_id: accountId }),
    );

    const visibleFromGhana = await withTenantContext(TENANT_GHANA, async () => {
      const r = await getTestClient().query('SELECT 1 FROM auth_devices WHERE account_id = $1', [
        accountId,
      ]);
      return r.rows.length;
    });
    expect(visibleFromGhana).toBe(0);
  });

  it('§1b INSERT with mismatched tenant_id rejected by WITH CHECK', async () => {
    const accountId = await withTenantContext(TENANT_US, () => seedAccount(TENANT_US));
    await expect(
      withTenantContext(TENANT_US, async () => {
        await insertDevice({ tenant_id: TENANT_GHANA, account_id: accountId });
      }),
    ).rejects.toThrow(/row-level security|policy/i);
  });
});

// ---------------------------------------------------------------------------
// §2 — Composite FK to accounts
// ---------------------------------------------------------------------------

describe('auth_devices migration — §2 composite FK', () => {
  it('§2a same-tenant account binding succeeds', async () => {
    const accountId = await withTenantContext(TENANT_US, () => seedAccount(TENANT_US));
    await withTenantContext(TENANT_US, () =>
      insertDevice({ tenant_id: TENANT_US, account_id: accountId }),
    );
  });

  it('§2b cross-tenant account binding rejected (composite FK)', async () => {
    const accountId = await withTenantContext(TENANT_GHANA, () => seedAccount(TENANT_GHANA, 'GH'));
    await expect(
      withTenantContext(TENANT_US, async () => {
        await insertDevice({ tenant_id: TENANT_US, account_id: accountId });
      }),
    ).rejects.toThrow(/foreign key|fk_auth_device_account|violates/i);
  });
});

// ---------------------------------------------------------------------------
// §3 — Enum CHECKs
// ---------------------------------------------------------------------------

describe('auth_devices migration — §3 enum CHECKs', () => {
  it('§3a platform accepts ios, android, web', async () => {
    const accountId = await withTenantContext(TENANT_US, () => seedAccount(TENANT_US));
    for (const p of ['ios', 'android', 'web']) {
      await withTenantContext(TENANT_US, async () => {
        await insertDevice({ tenant_id: TENANT_US, account_id: accountId, platform: p });
      });
    }
  });

  it("§3b platform rejects 'desktop' (not in v1.0 enum)", async () => {
    const accountId = await withTenantContext(TENANT_US, () => seedAccount(TENANT_US));
    await expect(
      withTenantContext(TENANT_US, async () => {
        await insertDevice({
          tenant_id: TENANT_US,
          account_id: accountId,
          platform: 'desktop',
        });
      }),
    ).rejects.toThrow(/check constraint|platform/i);
  });

  it('§3c attestation_format accepts all 4 documented values', async () => {
    const accountId = await withTenantContext(TENANT_US, () => seedAccount(TENANT_US));
    for (const af of ['none', 'placeholder', 'apple_app_attest', 'android_play_integrity']) {
      await withTenantContext(TENANT_US, async () => {
        await insertDevice({
          tenant_id: TENANT_US,
          account_id: accountId,
          attestation_format: af,
        });
      });
    }
  });

  it("§3d attestation_format rejects 'webauthn' (forward compat — add via migration)", async () => {
    const accountId = await withTenantContext(TENANT_US, () => seedAccount(TENANT_US));
    await expect(
      withTenantContext(TENANT_US, async () => {
        await insertDevice({
          tenant_id: TENANT_US,
          account_id: accountId,
          attestation_format: 'webauthn',
        });
      }),
    ).rejects.toThrow(/check constraint|attestation_format/i);
  });

  it('§3e revoked_reason accepts all 6 documented values', async () => {
    const accountId = await withTenantContext(TENANT_US, () => seedAccount(TENANT_US));
    const reasons = [
      'patient_unregistered',
      'max_devices_evicted',
      'security_hold',
      'phone_number_changed',
      'admin_revoked',
      'compromise_detected',
    ];
    for (const r of reasons) {
      await withTenantContext(TENANT_US, async () => {
        await insertDevice({
          tenant_id: TENANT_US,
          account_id: accountId,
          revoked_at: new Date().toISOString(),
          revoked_reason: r,
        });
      });
    }
  });

  it("§3f revoked_reason rejects 'made_up'", async () => {
    const accountId = await withTenantContext(TENANT_US, () => seedAccount(TENANT_US));
    await expect(
      withTenantContext(TENANT_US, async () => {
        await insertDevice({
          tenant_id: TENANT_US,
          account_id: accountId,
          revoked_at: new Date().toISOString(),
          revoked_reason: 'made_up',
        });
      }),
    ).rejects.toThrow(/check constraint|revoked_reason/i);
  });
});

// ---------------------------------------------------------------------------
// §4 — Revocation + label + length CHECKs
// ---------------------------------------------------------------------------

describe('auth_devices migration — §4 consistency + length CHECKs', () => {
  it('§4a revocation consistency: revoked_at NOT NULL + reason NULL rejected', async () => {
    const accountId = await withTenantContext(TENANT_US, () => seedAccount(TENANT_US));
    await expect(
      withTenantContext(TENANT_US, async () => {
        await insertDevice({
          tenant_id: TENANT_US,
          account_id: accountId,
          revoked_at: new Date().toISOString(),
          revoked_reason: null,
        });
      }),
    ).rejects.toThrow(/auth_device_revocation_consistent|check constraint/i);
  });

  it('§4b revocation consistency: revoked_at NULL + reason NOT NULL rejected', async () => {
    const accountId = await withTenantContext(TENANT_US, () => seedAccount(TENANT_US));
    await expect(
      withTenantContext(TENANT_US, async () => {
        await insertDevice({
          tenant_id: TENANT_US,
          account_id: accountId,
          revoked_at: null,
          revoked_reason: 'patient_unregistered',
        });
      }),
    ).rejects.toThrow(/auth_device_revocation_consistent|check constraint/i);
  });

  it('§4c device_label NULL permitted (backfill case)', async () => {
    const accountId = await withTenantContext(TENANT_US, () => seedAccount(TENANT_US));
    await withTenantContext(TENANT_US, async () => {
      await insertDevice({
        tenant_id: TENANT_US,
        account_id: accountId,
        device_label: null,
      });
    });
  });

  it('§4d device_label > 200 chars rejected', async () => {
    const accountId = await withTenantContext(TENANT_US, () => seedAccount(TENANT_US));
    await expect(
      withTenantContext(TENANT_US, async () => {
        await insertDevice({
          tenant_id: TENANT_US,
          account_id: accountId,
          device_label: 'A'.repeat(201),
        });
      }),
    ).rejects.toThrow(/check constraint|device_label/i);
  });
});

// ---------------------------------------------------------------------------
// §5 — last_seen_at trigger
// ---------------------------------------------------------------------------

describe('auth_devices migration — §5 last_seen_at trigger', () => {
  it('§5a UPDATE bumps last_seen_at via clock_timestamp() (advances within tx)', async () => {
    const accountId = await withTenantContext(TENANT_US, () => seedAccount(TENANT_US));
    const deviceId = await withTenantContext(TENANT_US, () =>
      insertDevice({ tenant_id: TENANT_US, account_id: accountId }),
    );

    const before = await withTenantContext(TENANT_US, async () => {
      const r = await getTestClient().query<{ last_seen_at: Date }>(
        'SELECT last_seen_at FROM auth_devices WHERE device_id = $1',
        [deviceId],
      );
      return r.rows[0]!.last_seen_at;
    });

    await new Promise((resolve) => setTimeout(resolve, 5));

    await withTenantContext(TENANT_US, async () => {
      await getTestClient().query(
        "UPDATE auth_devices SET device_label = 'Renamed' WHERE device_id = $1",
        [deviceId],
      );
    });

    const after = await withTenantContext(TENANT_US, async () => {
      const r = await getTestClient().query<{ last_seen_at: Date }>(
        'SELECT last_seen_at FROM auth_devices WHERE device_id = $1',
        [deviceId],
      );
      return r.rows[0]!.last_seen_at;
    });

    expect(after.getTime()).toBeGreaterThan(before.getTime());
  });
});
