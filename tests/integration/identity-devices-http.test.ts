/**
 * Identity device handlers — HTTP integration tests.
 *
 * Exercises POST/GET /v0/identity/devices and DELETE /v0/identity/devices/
 * :deviceId end-to-end via Fastify inject().
 *
 * Coverage in this file (4 sections, 11 cases).
 *
 * Spec references:
 *   - src/modules/identity/internal/handlers/devices.ts (target)
 *   - Identity & Authentication Spec v1.0 §3.1 (biometric) + §3.4 (max 3)
 *   - IDEMPOTENCY v5.1 §1 (cache 4-tuple + replay/body-mismatch — §4)
 *   - SI-006 reserve-then-execute (Sprint 33-34; the §4 idempotency
 *     contract is what PR-F3 migrated to handler-owned `withIdempotency`)
 */

import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../../src/app.ts';
import type { TenantId } from '../../src/lib/glossary.ts';
import type { TenantContext } from '../../src/lib/tenant-context.ts';
import { ulid } from '../../src/lib/ulid.ts';
import * as accountService from '../../src/modules/identity/internal/services/account-service.ts';
import { asAccountId } from '../../src/modules/identity/internal/types.ts';
import { TENANT_US, withTenantContext } from '../helpers/tenant-fixtures.ts';
import { getTestClient } from '../setup.ts';

const T_US = TENANT_US as TenantId;
const US_CTX: TenantContext = {
  tenantId: T_US,
  displayName: 'Telecheck-US',
  countryOfCare: 'US',
  kmsKeyAlias: 'alias/telecheck-us-data-key',
  consumerDba: 'Heros Health',
  legalEntity: 'Telecheck Health LLC',
  consumerSubdomain: 'heroshealth.com',
};

let app: FastifyInstance | null = null;

beforeAll(async () => {
  process.env['NODE_ENV'] = 'test';
  app = await buildApp({ logger: false });
  await app.ready();
});

afterAll(async () => {
  if (app !== null) {
    await app.close();
  }
});

function uniquePhone(): string {
  const digits = ulid()
    .slice(-9)
    .replace(/[^0-9]/g, '0')
    .padEnd(9, '0');
  return `+1${digits}`;
}

async function seedActiveAccount(): Promise<string> {
  const accountId = asAccountId(ulid());
  await withTenantContext(T_US, () =>
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
  await withTenantContext(T_US, () =>
    accountService.activateAccount(US_CTX, { actorId: 'op_seed' }, accountId, getTestClient()),
  );
  return accountId;
}

// ---------------------------------------------------------------------------
// §1 — POST /v0/identity/devices
// ---------------------------------------------------------------------------

describe('identity devices HTTP — §1 POST /devices', () => {
  it('§1a registers a device → 201 + body has device_id and no tenant_id', async () => {
    const accountId = await seedActiveAccount();
    const response = await app!.inject({
      method: 'POST',
      url: '/v0/identity/devices',
      headers: { host: 'localhost', 'idempotency-key': ulid() },
      payload: {
        account_id: accountId,
        platform: 'ios',
        device_label: 'iPhone 15',
        device_public_key: 'BASE64',
      },
    });
    expect(response.statusCode).toBe(201);
    const body = response.json<{ device_id: string; platform: string }>();
    expect(body.device_id).toBeTruthy();
    expect(body.platform).toBe('ios');
    expect(response.body).not.toContain('"tenant_id"');
    expect(response.body).not.toContain('Telecheck-US');
  });

  it('§1b missing required fields → 400 invalid', async () => {
    const response = await app!.inject({
      method: 'POST',
      url: '/v0/identity/devices',
      headers: { host: 'localhost', 'idempotency-key': ulid() },
      payload: { platform: 'ios' }, // missing account_id + device_public_key
    });
    expect(response.statusCode).toBe(400);
    const body = response.json<{ error: { code: string } }>();
    expect(body.error.code).toBe('internal.request.invalid');
  });

  it('§1c invalid platform → 400 invalid', async () => {
    const accountId = await seedActiveAccount();
    const response = await app!.inject({
      method: 'POST',
      url: '/v0/identity/devices',
      headers: { host: 'localhost', 'idempotency-key': ulid() },
      payload: {
        account_id: accountId,
        platform: 'desktop', // not in enum
        device_public_key: 'BASE64',
      },
    });
    expect(response.statusCode).toBe(400);
  });

  it('§1d 4th device evicts oldest (Identity Spec §3.4 multi-device cap)', async () => {
    const accountId = await seedActiveAccount();
    const deviceIds: string[] = [];

    // Register 4 devices — service auto-evicts the oldest on the 4th
    for (let i = 0; i < 4; i++) {
      const response = await app!.inject({
        method: 'POST',
        url: '/v0/identity/devices',
        headers: { host: 'localhost', 'idempotency-key': ulid() },
        payload: {
          account_id: accountId,
          platform: 'android',
          device_public_key: `BASE64-KEY-${i}`,
        },
      });
      expect(response.statusCode).toBe(201);
      deviceIds.push(response.json<{ device_id: string }>().device_id);
    }

    // List should return only 3 active devices
    const list = await app!.inject({
      method: 'GET',
      url: `/v0/identity/devices?account_id=${accountId}`,
      headers: { host: 'localhost' },
    });
    expect(list.statusCode).toBe(200);
    const listBody = list.json<{ devices: Array<{ device_id: string }> }>();
    expect(listBody.devices).toHaveLength(3);
    // The 1st device (index 0) should be evicted (NOT in active list)
    const activeIds = listBody.devices.map((d) => d.device_id);
    expect(activeIds).not.toContain(deviceIds[0]);
    expect(activeIds).toContain(deviceIds[3]);
  });
});

// ---------------------------------------------------------------------------
// §2 — GET /v0/identity/devices?account_id=<id>
// ---------------------------------------------------------------------------

describe('identity devices HTTP — §2 GET /devices', () => {
  it('§2a lists active devices for an account', async () => {
    const accountId = await seedActiveAccount();
    for (let i = 0; i < 2; i++) {
      await app!.inject({
        method: 'POST',
        url: '/v0/identity/devices',
        headers: { host: 'localhost', 'idempotency-key': ulid() },
        payload: {
          account_id: accountId,
          platform: 'ios',
          device_public_key: `BASE64-${i}`,
        },
      });
    }

    const response = await app!.inject({
      method: 'GET',
      url: `/v0/identity/devices?account_id=${accountId}`,
      headers: { host: 'localhost' },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json<{ devices: Array<{ device_id: string }> }>();
    expect(body.devices).toHaveLength(2);
  });

  it('§2b missing account_id → 400 invalid', async () => {
    const response = await app!.inject({
      method: 'GET',
      url: '/v0/identity/devices',
      headers: { host: 'localhost' },
    });
    expect(response.statusCode).toBe(400);
  });

  it('§2c response body has no tenant_id substring', async () => {
    const accountId = await seedActiveAccount();
    await app!.inject({
      method: 'POST',
      url: '/v0/identity/devices',
      headers: { host: 'localhost', 'idempotency-key': ulid() },
      payload: {
        account_id: accountId,
        platform: 'ios',
        device_public_key: 'BASE64',
      },
    });
    const response = await app!.inject({
      method: 'GET',
      url: `/v0/identity/devices?account_id=${accountId}`,
      headers: { host: 'localhost' },
    });
    expect(response.body).not.toContain('"tenant_id"');
    expect(response.body).not.toContain('Telecheck-US');
  });
});

// ---------------------------------------------------------------------------
// §3 — DELETE /v0/identity/devices/:deviceId
// ---------------------------------------------------------------------------

describe('identity devices HTTP — §3 DELETE /devices/:deviceId', () => {
  it('§3a revokes an active device → 204; subsequent list excludes it', async () => {
    const accountId = await seedActiveAccount();
    const reg = await app!.inject({
      method: 'POST',
      url: '/v0/identity/devices',
      headers: { host: 'localhost', 'idempotency-key': ulid() },
      payload: {
        account_id: accountId,
        platform: 'ios',
        device_public_key: 'BASE64',
      },
    });
    const deviceId = reg.json<{ device_id: string }>().device_id;

    const del = await app!.inject({
      method: 'DELETE',
      url: `/v0/identity/devices/${deviceId}`,
      headers: { host: 'localhost', 'idempotency-key': ulid() },
    });
    expect(del.statusCode).toBe(204);

    const list = await app!.inject({
      method: 'GET',
      url: `/v0/identity/devices?account_id=${accountId}`,
      headers: { host: 'localhost' },
    });
    const ids = list
      .json<{ devices: Array<{ device_id: string }> }>()
      .devices.map((d) => d.device_id);
    expect(ids).not.toContain(deviceId);
  });

  it('§3b phantom deviceId → 204 (idempotent, tenant-blind)', async () => {
    const response = await app!.inject({
      method: 'DELETE',
      url: `/v0/identity/devices/${ulid()}`,
      headers: { host: 'localhost', 'idempotency-key': ulid() },
    });
    expect(response.statusCode).toBe(204);
  });
});

// ---------------------------------------------------------------------------
// §4 — IDEMPOTENCY v5.1 contract on POST /v0/identity/devices
// ---------------------------------------------------------------------------
//
// Sprint 33 PR-F3 migrated `registerDeviceHandler` to `withIdempotency`
// reserve-then-execute. Pre-this-section the cache contract had zero
// HTTP-level coverage on this endpoint (or any identity endpoint). The
// two cases below pin the load-bearing v5.1 invariants:
//
//   §4a same key + same body → cached 201 replay (the `device_id`
//        returned on retry IS the same row — no second registration
//        side effect)
//   §4b same key + different body → 409
//        `internal.idempotency.body_mismatch` (the v5.1 §1 reuse
//        contract — different bodies are categorically different
//        requests and the helper rejects them deterministically)
//
// Spec references:
//   - src/lib/idempotency.ts (withIdempotency reserve-then-execute)
//   - src/lib/idempotent-handler.ts (withIdempotentExecution helper)
//   - IDEMPOTENCY v5.1 §1 (cache 4-tuple PK; same-body replay; different-
//     body 409)
//   - docs/PROJECT_CONVENTIONS.md r5 §3.7 (Reserve-then-execute is the
//     only path for state-changing handlers)
// ---------------------------------------------------------------------------

describe('identity devices HTTP — §4 IDEMPOTENCY v5.1 contract', () => {
  it('§4a same Idempotency-Key + same body → cached 201 replay (same device_id)', async () => {
    const accountId = await seedActiveAccount();
    const idempotencyKey = ulid();
    const payload = {
      account_id: accountId,
      platform: 'ios' as const,
      device_label: 'iPhone 15',
      device_public_key: 'BASE64-replay-test',
    };

    const first = await app!.inject({
      method: 'POST',
      url: '/v0/identity/devices',
      headers: { host: 'localhost', 'idempotency-key': idempotencyKey },
      payload,
    });
    expect(first.statusCode).toBe(201);
    const firstBody = first.json<{ device_id: string }>();
    expect(firstBody.device_id).toBeTruthy();

    // Second request with same key + same body. withIdempotency's
    // preHandler cache-replay fast path short-circuits; the handler
    // body callback does NOT run; no second registerDevice service
    // call happens. The cached response is replayed verbatim.
    const second = await app!.inject({
      method: 'POST',
      url: '/v0/identity/devices',
      headers: { host: 'localhost', 'idempotency-key': idempotencyKey },
      payload,
    });
    expect(second.statusCode).toBe(201);
    const secondBody = second.json<{ device_id: string }>();
    // The same device_id MUST come back — proves a single underlying
    // row was created, not two distinct registrations.
    expect(secondBody.device_id).toBe(firstBody.device_id);

    // PHI projection still holds on the replay path.
    expect(second.body).not.toContain('"tenant_id"');
    expect(second.body).not.toContain('Telecheck-US');
  });

  it('§4b same Idempotency-Key + different body → 409 internal.idempotency.body_mismatch', async () => {
    const accountId = await seedActiveAccount();
    const idempotencyKey = ulid();

    const first = await app!.inject({
      method: 'POST',
      url: '/v0/identity/devices',
      headers: { host: 'localhost', 'idempotency-key': idempotencyKey },
      payload: {
        account_id: accountId,
        platform: 'ios',
        device_public_key: 'BASE64-original',
      },
    });
    expect(first.statusCode).toBe(201);

    // Second request: same key, DIFFERENT body (platform flipped to
    // android, key changed). Per IDEMPOTENCY v5.1 §1: same key +
    // different body → 409 with code internal.idempotency.body_mismatch.
    // The body hash check at withIdempotency reservation time fires
    // BEFORE any business logic runs.
    const second = await app!.inject({
      method: 'POST',
      url: '/v0/identity/devices',
      headers: { host: 'localhost', 'idempotency-key': idempotencyKey },
      payload: {
        account_id: accountId,
        platform: 'android',
        device_public_key: 'BASE64-different',
      },
    });
    expect(second.statusCode).toBe(409);
    const errorBody = second.json<{ error: { code: string } }>();
    expect(errorBody.error.code).toBe('internal.idempotency.body_mismatch');
  });
});
