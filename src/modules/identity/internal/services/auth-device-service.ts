/**
 * auth-device-service.ts — AuthDevice lifecycle orchestration with audit.
 *
 * Wraps auth-device-repo with same-transaction audit emission. Service
 * also enforces the Identity Spec §3.4 multi-device cap: when registering
 * a 4th device, the OLDEST active device is auto-revoked with reason=
 * 'max_devices_evicted' before the new one is inserted.
 */

import type { DbClient, DbTransaction } from '../../../../lib/db.js';
import { withTenantBoundConnection } from '../../../../lib/db.js';
import type { TenantContext } from '../../../../lib/tenant-context.js';
import { emitDeviceRegisteredAudit, emitDeviceRevokedAudit } from '../../audit.js';
import * as deviceRepo from '../repositories/auth-device-repo.js';
import type {
  AccountId,
  AttestationFormat,
  AuthDevice,
  DeviceId,
  DevicePlatform,
  DeviceRevocationReason,
} from '../types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Identity Spec §3.4: max 3 concurrent devices per account. */
const MAX_DEVICES_PER_ACCOUNT = 3;

// ---------------------------------------------------------------------------
// RegisterDeviceInput
// ---------------------------------------------------------------------------

export interface RegisterDeviceInput {
  device_id: DeviceId;
  account_id: AccountId;
  platform: DevicePlatform;
  device_label?: string | null;
  device_public_key: string;
  attestation_format?: AttestationFormat;
}

// ---------------------------------------------------------------------------
// registerDevice — enforces max-3 cap + emits audit
// ---------------------------------------------------------------------------

/**
 * Register a new device for an account. Enforces Identity Spec §3.4
 * multi-device cap: if the account already has 3 active devices, the
 * OLDEST (lowest last_seen_at) is auto-revoked before the new one is
 * inserted.
 *
 * BOTH operations (eviction + registration) emit audit in the same
 * transaction. The eviction audit carries reason='max_devices_evicted'.
 */
export async function registerDevice(
  ctx: TenantContext,
  actor: { actorId: string },
  input: RegisterDeviceInput,
  externalTx?: DbTransaction,
): Promise<AuthDevice> {
  const runFn = async (tx: DbClient): Promise<AuthDevice> => {
    // Enforce max-3-device cap
    const active = await deviceRepo.listActiveDevicesForAccount(ctx.tenantId, input.account_id, tx);
    if (active.length >= MAX_DEVICES_PER_ACCOUNT) {
      // Evict oldest (active is ordered ASC by last_seen_at)
      const oldest = active[0];
      if (oldest !== undefined) {
        const evicted = await deviceRepo.revokeAuthDevice(
          ctx.tenantId,
          oldest.device_id,
          'max_devices_evicted',
          tx,
        );
        if (evicted !== null) {
          await emitDeviceRevokedAudit(
            {
              tenantId: ctx.tenantId,
              accountId: evicted.account_id,
              deviceId: evicted.device_id,
              actorId: actor.actorId,
              countryOfCare: ctx.countryOfCare,
              reason: 'max_devices_evicted',
            },
            tx,
          );
        }
      }
    }

    // Register new device
    const repoInput: deviceRepo.CreateAuthDeviceInput = {
      device_id: input.device_id,
      tenant_id: ctx.tenantId,
      account_id: input.account_id,
      platform: input.platform,
      device_public_key: input.device_public_key,
    };
    if (input.device_label !== undefined) repoInput.device_label = input.device_label;
    if (input.attestation_format !== undefined) {
      repoInput.attestation_format = input.attestation_format;
    }

    return deviceRepo.createAuthDevice(
      repoInput,
      async (innerTx, persisted) => {
        await emitDeviceRegisteredAudit(
          {
            tenantId: ctx.tenantId,
            accountId: persisted.account_id,
            deviceId: persisted.device_id,
            actorId: actor.actorId,
            countryOfCare: ctx.countryOfCare,
            platform: persisted.platform,
          },
          innerTx,
        );
      },
      tx,
    );
  };

  if (externalTx !== undefined) {
    return runFn(externalTx);
  }
  return withTenantBoundConnection(ctx.tenantId, runFn);
}

// ---------------------------------------------------------------------------
// revokeDevice — flip + audit
// ---------------------------------------------------------------------------

export async function revokeDevice(
  ctx: TenantContext,
  actor: { actorId: string },
  deviceId: DeviceId,
  reason: DeviceRevocationReason,
  externalTx?: DbTransaction,
): Promise<AuthDevice | null> {
  const runFn = async (tx: DbClient): Promise<AuthDevice | null> => {
    const revoked = await deviceRepo.revokeAuthDevice(ctx.tenantId, deviceId, reason, tx);
    if (revoked === null) return null;
    await emitDeviceRevokedAudit(
      {
        tenantId: ctx.tenantId,
        accountId: revoked.account_id,
        deviceId: revoked.device_id,
        actorId: actor.actorId,
        countryOfCare: ctx.countryOfCare,
        reason,
      },
      tx,
    );
    return revoked;
  };

  if (externalTx !== undefined) {
    return runFn(externalTx);
  }
  return withTenantBoundConnection(ctx.tenantId, runFn);
}

// ---------------------------------------------------------------------------
// Read paths — pure delegates
// ---------------------------------------------------------------------------

export async function findDeviceById(
  ctx: TenantContext,
  deviceId: DeviceId,
  externalTx?: DbClient,
): Promise<AuthDevice | null> {
  return deviceRepo.findAuthDeviceById(ctx.tenantId, deviceId, externalTx);
}

export async function listActiveDevicesForAccount(
  ctx: TenantContext,
  accountId: AccountId,
  externalTx?: DbClient,
): Promise<AuthDevice[]> {
  return deviceRepo.listActiveDevicesForAccount(ctx.tenantId, accountId, externalTx);
}
