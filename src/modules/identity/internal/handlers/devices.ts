/**
 * devices.ts — POST/GET/DELETE /v0/identity/devices handlers per Identity
 * Spec v1.0 §3.1 (biometric unlock) + §3.4 (multi-device cap).
 *
 *   POST /v0/identity/devices
 *     Body: { account_id, platform, device_label?, device_public_key,
 *             attestation_format? }
 *     - Register a device for an account
 *     - Service-layer auto-evicts oldest device with reason=
 *       'max_devices_evicted' when account already has 3 active devices
 *     - Returns the registered AuthDevice (without tenant_id; the
 *       AuthDevice type doesn't carry sensitive PHI fields beyond the
 *       device pubkey, but tenant_id is stripped to match the platform's
 *       patient-surface discipline)
 *
 *   GET /v0/identity/devices?account_id=<id>
 *     - List active devices for an account (oldest-first by last_seen_at)
 *     - account_id supplied as a query param at v1.0 since there's no JWT
 *       yet to resolve actor identity automatically; replaced by JWT-
 *       resolved actor in a follow-up commit
 *
 *   DELETE /v0/identity/devices/:deviceId
 *     - Revoke a device with reason='patient_unregistered'
 *     - Idempotent: phantom device_id returns 204 too (tenant-blind)
 *
 * Spec references:
 *   - Identity & Authentication Spec v1.0 §3.1 / §3.4
 *   - I-003 (audit append-only)
 *   - I-025 (tenant-blind error envelope)
 */

import type { FastifyReply, FastifyRequest } from 'fastify';

import { requireTenantContext } from '../../../../lib/tenant-context.js';
import { ulid } from '../../../../lib/ulid.js';
import * as deviceService from '../services/auth-device-service.js';
import { asAccountId, asDeviceId, type AttestationFormat, type DevicePlatform } from '../types.js';

// ---------------------------------------------------------------------------
// Body / param shapes
// ---------------------------------------------------------------------------

interface RegisterDeviceBody {
  account_id?: string;
  platform?: string;
  device_label?: string | null;
  device_public_key?: string;
  attestation_format?: string;
}

function isString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}

function isPlatform(v: unknown): v is DevicePlatform {
  return v === 'ios' || v === 'android' || v === 'web';
}

function isAttestation(v: unknown): v is AttestationFormat {
  return (
    v === 'none' ||
    v === 'placeholder' ||
    v === 'apple_app_attest' ||
    v === 'android_play_integrity'
  );
}

// ---------------------------------------------------------------------------
// POST /v0/identity/devices
// ---------------------------------------------------------------------------

export async function registerDeviceHandler(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<unknown> {
  const ctx = requireTenantContext(req);
  const body = (req.body ?? {}) as RegisterDeviceBody;

  if (
    !isString(body.account_id) ||
    !isPlatform(body.platform) ||
    !isString(body.device_public_key)
  ) {
    return reply.code(400).send({
      error: {
        code: 'internal.request.invalid',
        message: 'account_id, platform (ios|android|web), and device_public_key required.',
        request_id: req.id,
      },
    });
  }

  const accountId = asAccountId(body.account_id);
  const deviceId = asDeviceId(ulid());

  // Optional attestation_format validation
  const attestationFormat: AttestationFormat | undefined = isAttestation(body.attestation_format)
    ? body.attestation_format
    : undefined;

  const device = await deviceService.registerDevice(
    ctx,
    { actorId: 'system' },
    {
      device_id: deviceId,
      account_id: accountId,
      platform: body.platform,
      device_public_key: body.device_public_key,
      ...(body.device_label !== undefined ? { device_label: body.device_label } : {}),
      ...(attestationFormat !== undefined ? { attestation_format: attestationFormat } : {}),
    },
  );

  // Strip tenant_id to match the platform's patient-surface discipline.
  // AuthDevice doesn't have a dedicated `toPatientView` since it carries
  // no PHI beyond the device public key, but tenant_id MUST NOT leak.
  const { tenant_id: _stripped, ...patientView } = device;
  void _stripped;
  return reply.code(201).send(patientView);
}

// ---------------------------------------------------------------------------
// GET /v0/identity/devices?account_id=<id>
// ---------------------------------------------------------------------------

export async function listDevicesHandler(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<unknown> {
  const ctx = requireTenantContext(req);
  const query = (req.query ?? {}) as { account_id?: string };

  if (!isString(query.account_id)) {
    return reply.code(400).send({
      error: {
        code: 'internal.request.invalid',
        message: 'account_id query parameter is required.',
        request_id: req.id,
      },
    });
  }

  const devices = await deviceService.listActiveDevicesForAccount(
    ctx,
    asAccountId(query.account_id),
  );

  // Strip tenant_id from each device row
  const view = devices.map((d) => {
    const { tenant_id: _stripped, ...rest } = d;
    void _stripped;
    return rest;
  });

  return reply.code(200).send({ devices: view });
}

// ---------------------------------------------------------------------------
// DELETE /v0/identity/devices/:deviceId
// ---------------------------------------------------------------------------

export async function revokeDeviceHandler(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<unknown> {
  const ctx = requireTenantContext(req);
  const params = (req.params ?? {}) as { deviceId?: string };

  if (!isString(params.deviceId)) {
    return reply.code(400).send({
      error: {
        code: 'internal.request.invalid',
        message: 'deviceId path parameter is required.',
        request_id: req.id,
      },
    });
  }

  // Idempotent: revokeDevice returns null on phantom or already-revoked;
  // we still respond 204 to prevent enumeration (tenant-blind).
  await deviceService.revokeDevice(
    ctx,
    { actorId: 'system' },
    asDeviceId(params.deviceId),
    'patient_unregistered',
  );

  return reply.code(204).send();
}
