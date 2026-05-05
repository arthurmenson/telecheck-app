/**
 * Tenant-config admin write handlers — 503-stub HTTP integration tests.
 *
 * Sprint 3 / TLC-009. Admin Backend slice v1.1 owns mutation handler
 * authoring (and ADR-024 encryption-at-rest for adapter_configs.adapter_config
 * payloads). At v0.1 every PATCH/POST/DELETE under /v0/admin/* returns
 * 503 via the canonical tenant-blind error envelope.
 *
 * Coverage in this file (3 sections, 7 cases):
 *   §1 PATCH /v0/admin/tenant-brand                       (1 — JWT-auth gate)
 *   §2 PATCH /v0/admin/ccr-configs/:configKey             (1)
 *   §3 POST /v0/admin/adapter-configs                     (1)
 *   §4 PATCH /v0/admin/adapter-configs/:adapterId         (1)
 *   §5 DELETE /v0/admin/adapter-configs/:adapterId        (1)
 *   §6 GET /v0/admin/ready                                (1 — readiness probe)
 *   §7 401 without JWT (ensures auth gate fires BEFORE 503)
 *
 * Spec references:
 *   - ADR-024 (per-tenant KMS — adapter_config encryption-at-rest)
 *   - Contracts Pack v5.1 ERROR_MODEL (canonical 503 envelope)
 *   - I-025 (tenant-blind error envelopes)
 *   - Pattern mirror: tests/integration/pharmacy-plugin-wiring.test.ts (TLC-001)
 */

import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../../src/app.ts';
import type { TenantId } from '../../src/lib/glossary.ts';
import type { TenantContext } from '../../src/lib/tenant-context.ts';
import { ulid } from '../../src/lib/ulid.ts';
import * as accountService from '../../src/modules/identity/internal/services/account-service.ts';
import * as otpService from '../../src/modules/identity/internal/services/otp-service.ts';
import { asAccountId, asOtpId } from '../../src/modules/identity/internal/types.ts';
import { TENANT_US, withTenantContext } from '../helpers/tenant-fixtures.ts';
import { uniquePhone } from '../helpers/unique-phone.ts';
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

async function loginToken(ctx: TenantContext, phonePrefix: string): Promise<string> {
  const phone = uniquePhone(phonePrefix);
  const accountId = asAccountId(ulid());
  await withTenantContext(ctx.tenantId, () =>
    accountService.createAccount(
      ctx,
      { actorId: 'op_seed' },
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
  await withTenantContext(ctx.tenantId, () =>
    accountService.activateAccount(ctx, { actorId: 'op_seed' }, accountId, getTestClient()),
  );
  const otpId = asOtpId(ulid());
  const { codePlaintext } = await withTenantContext(ctx.tenantId, () =>
    otpService.issueOtp(
      ctx,
      { actorId: 'op_seed' },
      { otp_id: otpId, account_id: accountId, phone_e164: phone, purpose: 'login' },
      getTestClient(),
    ),
  );
  const verify = await app!.inject({
    method: 'POST',
    url: '/v0/identity/login/verify',
    headers: {
      host: 'heroshealth.com',
      'idempotency-key': ulid(),
    },
    payload: { phone_e164: phone, code: codePlaintext },
  });
  const body = verify.json<{ access_token: string }>();
  return body.access_token;
}

interface ErrorEnvelope {
  error: {
    code: string;
    message: string;
    trace_id: string;
    timestamp: string;
    retry_after?: string;
  };
}

function expect503Envelope(envelope: ErrorEnvelope): void {
  expect(envelope.error.code).toBe('internal.service.unavailable');
  expect(envelope.error.message).toContain('Admin Backend slice v1.1');
  expect(envelope.error.message).toContain('not yet implemented');
  expect(envelope.error.trace_id).toBeDefined();
  expect(envelope.error.timestamp).toBeDefined();
  // Per ERROR_MODEL: 503 envelopes carry a retry_after hint
  expect(envelope.error.retry_after).toBeDefined();
}

// ---------------------------------------------------------------------------
// §1 PATCH /v0/admin/tenant-brand
// ---------------------------------------------------------------------------

describe('tenant-config admin-write — §1 PATCH /v0/admin/tenant-brand', () => {
  it('§1a returns 503 with Admin Backend slice v1.1 blocked envelope', async () => {
    const token = await loginToken(US_CTX, '+1');
    const r = await app!.inject({
      method: 'PATCH',
      url: '/v0/admin/tenant-brand',
      headers: { host: 'heroshealth.com', authorization: `Bearer ${token}` },
      payload: { brand_name: 'Should Not Be Accepted' },
    });
    expect(r.statusCode).toBe(503);
    expect503Envelope(r.json<ErrorEnvelope>());
  });
});

// ---------------------------------------------------------------------------
// §2 PATCH /v0/admin/ccr-configs/:configKey
// ---------------------------------------------------------------------------

describe('tenant-config admin-write — §2 PATCH /v0/admin/ccr-configs/:configKey', () => {
  it('§2a returns 503 with Admin Backend slice v1.1 blocked envelope', async () => {
    const token = await loginToken(US_CTX, '+1');
    const r = await app!.inject({
      method: 'PATCH',
      url: '/v0/admin/ccr-configs/some.key',
      headers: { host: 'heroshealth.com', authorization: `Bearer ${token}` },
      payload: { config_value: { ignored: true } },
    });
    expect(r.statusCode).toBe(503);
    expect503Envelope(r.json<ErrorEnvelope>());
  });
});

// ---------------------------------------------------------------------------
// §3 POST /v0/admin/adapter-configs
// ---------------------------------------------------------------------------

describe('tenant-config admin-write — §3 POST /v0/admin/adapter-configs', () => {
  it('§3a returns 503 with Admin Backend slice v1.1 blocked envelope', async () => {
    const token = await loginToken(US_CTX, '+1');
    const r = await app!.inject({
      method: 'POST',
      url: '/v0/admin/adapter-configs',
      headers: { host: 'heroshealth.com', authorization: `Bearer ${token}` },
      payload: {
        adapter_type: 'pharmacy',
        adapter_name: 'truepill',
        adapter_config: { api_key_ref: 'kms:must-not-leak' },
      },
    });
    expect(r.statusCode).toBe(503);
    const env = r.json<ErrorEnvelope>();
    expect503Envelope(env);
    // Critical: even though we sent a "secret"-looking payload, the 503
    // envelope MUST NOT echo it back. ADR-024 redaction discipline applies
    // a-priori, even on the 503 path.
    expect(r.body).not.toContain('kms:must-not-leak');
    expect(r.body).not.toContain('api_key_ref');
  });
});

// ---------------------------------------------------------------------------
// §4 PATCH /v0/admin/adapter-configs/:adapterId
// ---------------------------------------------------------------------------

describe('tenant-config admin-write — §4 PATCH /v0/admin/adapter-configs/:adapterId', () => {
  it('§4a returns 503 with Admin Backend slice v1.1 blocked envelope', async () => {
    const token = await loginToken(US_CTX, '+1');
    const r = await app!.inject({
      method: 'PATCH',
      url: `/v0/admin/adapter-configs/${ulid()}`,
      headers: { host: 'heroshealth.com', authorization: `Bearer ${token}` },
      payload: { status: 'inactive' },
    });
    expect(r.statusCode).toBe(503);
    expect503Envelope(r.json<ErrorEnvelope>());
  });
});

// ---------------------------------------------------------------------------
// §5 DELETE /v0/admin/adapter-configs/:adapterId
// ---------------------------------------------------------------------------

describe('tenant-config admin-write — §5 DELETE /v0/admin/adapter-configs/:adapterId', () => {
  it('§5a returns 503 with Admin Backend slice v1.1 blocked envelope', async () => {
    const token = await loginToken(US_CTX, '+1');
    const r = await app!.inject({
      method: 'DELETE',
      url: `/v0/admin/adapter-configs/${ulid()}`,
      headers: { host: 'heroshealth.com', authorization: `Bearer ${token}` },
    });
    expect(r.statusCode).toBe(503);
    expect503Envelope(r.json<ErrorEnvelope>());
  });
});

// ---------------------------------------------------------------------------
// §6 GET /v0/admin/ready
// ---------------------------------------------------------------------------

describe('tenant-config admin-write — §6 GET /v0/admin/ready', () => {
  it('§6a returns 503 indicating mutation surface is not ready (no JWT required)', async () => {
    const r = await app!.inject({
      method: 'GET',
      url: '/v0/admin/ready',
      headers: { host: 'heroshealth.com' },
    });
    expect(r.statusCode).toBe(503);
    const body = r.json<{
      status: string;
      surface: string;
      blocked: string;
      blocked_message: string;
    }>();
    expect(body.status).toBe('not_ready');
    expect(body.surface).toBe('admin-write');
    expect(body.blocked).toContain('Admin Backend slice v1.1');
    expect(body.blocked_message).toContain('Read surface');
  });
});

// ---------------------------------------------------------------------------
// §7 Auth gate fires BEFORE 503 — unauthenticated mutation probes can't
//    enumerate the mutation surface
// ---------------------------------------------------------------------------

describe('tenant-config admin-write — §7 JWT auth gate fires before 503', () => {
  it('§7a PATCH /v0/admin/tenant-brand without JWT returns 401, not 503', async () => {
    const r = await app!.inject({
      method: 'PATCH',
      url: '/v0/admin/tenant-brand',
      headers: { host: 'heroshealth.com' },
      payload: { brand_name: 'X' },
    });
    expect(r.statusCode).toBe(401);
  });
});
