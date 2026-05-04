/**
 * auth-device-repo.ts — DB access for the `auth_devices` table (migration 015).
 *
 * Repository pattern (mirror of session-repo.ts / otp-repo.ts):
 *   - Pure DB access; no domain logic
 *   - Returns null on tenant-blind miss
 *   - All SELECTs filter by tenant_id explicitly (defense in depth)
 *
 * Spec references:
 *   - migrations/015_auth_devices.sql
 *   - CDM v1.2 §3.2 entity 10 "AuthDevice"
 *   - Identity & Authentication Spec v1.0 §3.1 / §3.4 (biometric;
 *     multi-device max 3)
 *   - I-023 / I-025
 */

import type { DbClient, DbTransaction } from '../../../../lib/db.js';
import { withTenantBoundConnection } from '../../../../lib/db.js';
import type { TenantId } from '../../../../lib/glossary.js';
import type {
  AccountId,
  AttestationFormat,
  AuthDevice,
  DeviceId,
  DevicePlatform,
  DeviceRevocationReason,
} from '../types.js';

// ---------------------------------------------------------------------------
// Row mapping
// ---------------------------------------------------------------------------

interface AuthDeviceRow {
  device_id: string;
  tenant_id: string;
  account_id: string;
  platform: string;
  device_label: string | null;
  device_public_key: string;
  attestation_format: string;
  created_at: Date | string;
  last_seen_at: Date | string;
  revoked_at: Date | string | null;
  revoked_reason: string | null;
}

function tsToIso(v: Date | string): string {
  return typeof v === 'string' ? v : v.toISOString();
}
function tsToIsoNullable(v: Date | string | null): string | null {
  if (v === null) return null;
  return tsToIso(v);
}

function rowToDevice(row: AuthDeviceRow): AuthDevice {
  return {
    device_id: row.device_id as DeviceId,
    tenant_id: row.tenant_id as TenantId,
    account_id: row.account_id as AccountId,
    platform: row.platform as DevicePlatform,
    device_label: row.device_label,
    device_public_key: row.device_public_key,
    attestation_format: row.attestation_format as AttestationFormat,
    created_at: tsToIso(row.created_at),
    last_seen_at: tsToIso(row.last_seen_at),
    revoked_at: tsToIsoNullable(row.revoked_at),
    revoked_reason: row.revoked_reason as DeviceRevocationReason | null,
  };
}

const DEVICE_COLUMNS = `
  device_id, tenant_id, account_id,
  platform, device_label, device_public_key, attestation_format,
  created_at, last_seen_at, revoked_at, revoked_reason
`;

// ---------------------------------------------------------------------------
// CreateAuthDeviceInput
// ---------------------------------------------------------------------------

export interface CreateAuthDeviceInput {
  device_id: DeviceId;
  tenant_id: TenantId;
  account_id: AccountId;
  platform: DevicePlatform;
  device_label?: string | null;
  device_public_key: string; // base64
  attestation_format?: AttestationFormat;
}

// ---------------------------------------------------------------------------
// findAuthDeviceById
// ---------------------------------------------------------------------------

export async function findAuthDeviceById(
  tenantId: TenantId,
  deviceId: DeviceId,
  externalTx?: DbClient,
): Promise<AuthDevice | null> {
  const runner = externalTx
    ? (fn: (client: DbClient) => Promise<AuthDevice | null>) => fn(externalTx)
    : (fn: (client: DbClient) => Promise<AuthDevice | null>) =>
        withTenantBoundConnection(tenantId, fn);
  return runner(async (client) => {
    const result = await client.query<AuthDeviceRow>(
      `SELECT ${DEVICE_COLUMNS}
         FROM auth_devices
        WHERE tenant_id = $1
          AND device_id = $2`,
      [tenantId, deviceId],
    );
    if (result.rows.length === 0) return null;
    const row = result.rows[0];
    if (row === undefined) return null;
    return rowToDevice(row);
  });
}

// ---------------------------------------------------------------------------
// listActiveDevicesForAccount — multi-device cap enforcement
// ---------------------------------------------------------------------------

/**
 * List active (non-revoked) devices for an account, ordered by
 * last_seen_at ASC. The first row is the OLDEST active device — when
 * issuing a 4th device, service-layer code revokes index 0 with
 * reason='max_devices_evicted' to enforce the 3-device cap per Identity
 * Spec §3.4.
 */
export async function listActiveDevicesForAccount(
  tenantId: TenantId,
  accountId: AccountId,
  externalTx?: DbClient,
): Promise<AuthDevice[]> {
  const runner = externalTx
    ? (fn: (client: DbClient) => Promise<AuthDevice[]>) => fn(externalTx)
    : (fn: (client: DbClient) => Promise<AuthDevice[]>) => withTenantBoundConnection(tenantId, fn);
  return runner(async (client) => {
    const result = await client.query<AuthDeviceRow>(
      `SELECT ${DEVICE_COLUMNS}
         FROM auth_devices
        WHERE tenant_id = $1
          AND account_id = $2
          AND revoked_at IS NULL
        ORDER BY last_seen_at ASC`,
      [tenantId, accountId],
    );
    return result.rows.map(rowToDevice);
  });
}

// ---------------------------------------------------------------------------
// createAuthDevice
// ---------------------------------------------------------------------------

export async function createAuthDevice(
  input: CreateAuthDeviceInput,
  txCallback: (tx: DbTransaction, device: AuthDevice) => Promise<void>,
  externalTx?: DbTransaction,
): Promise<AuthDevice> {
  const runFn = async (tx: DbClient): Promise<AuthDevice> => {
    const result = await tx.query<AuthDeviceRow>(
      `INSERT INTO auth_devices (
          device_id, tenant_id, account_id,
          platform, device_label, device_public_key, attestation_format
       ) VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING ${DEVICE_COLUMNS}`,
      [
        input.device_id,
        input.tenant_id,
        input.account_id,
        input.platform,
        input.device_label ?? null,
        input.device_public_key,
        input.attestation_format ?? 'placeholder',
      ],
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw new Error('createAuthDevice: INSERT returned no rows (unreachable)');
    }
    const device = rowToDevice(row);
    await txCallback(tx, device);
    return device;
  };

  if (externalTx !== undefined) {
    return runFn(externalTx);
  }
  return withTenantBoundConnection(input.tenant_id, runFn);
}

// ---------------------------------------------------------------------------
// revokeAuthDevice
// ---------------------------------------------------------------------------

export async function revokeAuthDevice(
  tenantId: TenantId,
  deviceId: DeviceId,
  reason: DeviceRevocationReason,
  externalTx?: DbClient,
): Promise<AuthDevice | null> {
  const runner = externalTx
    ? (fn: (client: DbClient) => Promise<AuthDevice | null>) => fn(externalTx)
    : (fn: (client: DbClient) => Promise<AuthDevice | null>) =>
        withTenantBoundConnection(tenantId, fn);
  return runner(async (client) => {
    const result = await client.query<AuthDeviceRow>(
      `UPDATE auth_devices
          SET revoked_at = NOW(),
              revoked_reason = $3
        WHERE tenant_id = $1
          AND device_id = $2
          AND revoked_at IS NULL
       RETURNING ${DEVICE_COLUMNS}`,
      [tenantId, deviceId, reason],
    );
    if (result.rows.length === 0) return null;
    const row = result.rows[0];
    if (row === undefined) return null;
    return rowToDevice(row);
  });
}
