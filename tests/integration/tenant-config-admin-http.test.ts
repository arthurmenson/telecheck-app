/**
 * Tenant-config admin read handlers — HTTP integration tests.
 *
 * Sprint 2 / TLC-004. Covers the 4 GET routes under /v0/admin/*:
 *   - GET /v0/admin/country-profiles  (platform-level list)
 *   - GET /v0/admin/tenant-brand      (current tenant's brand)
 *   - GET /v0/admin/ccr-configs       (current tenant's overrides)
 *   - GET /v0/admin/adapter-configs   (current tenant's adapters; redacted)
 *
 * Coverage in this file (4 sections, 9 cases):
 *   §1 country-profiles (2)
 *   §2 tenant-brand (2)
 *   §3 ccr-configs (2)
 *   §4 adapter-configs (3 — redaction + cross-tenant)
 *
 * Spec references:
 *   - CDM v1.2 §4.2-§4.5
 *   - I-023 / I-025 / I-027
 *   - ADR-024 (per-tenant KMS — adapter_config payload redacted at v0.1)
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
import { TENANT_GHANA, TENANT_US, withTenantContext } from '../helpers/tenant-fixtures.ts';
import { uniquePhone } from '../helpers/unique-phone.ts';
import { getTestClient } from '../setup.ts';

const T_US = TENANT_US as TenantId;
const T_GH = TENANT_GHANA as TenantId;

const US_CTX: TenantContext = {
  tenantId: T_US,
  displayName: 'Telecheck-US',
  countryOfCare: 'US',
  kmsKeyAlias: 'alias/telecheck-us-data-key',
  consumerDba: 'Heros Health',
  legalEntity: 'Telecheck Health LLC',
  consumerSubdomain: 'heroshealth.com',
};
const GH_CTX: TenantContext = {
  tenantId: T_GH,
  displayName: 'Telecheck-Ghana',
  countryOfCare: 'GH',
  kmsKeyAlias: 'alias/telecheck-gh-data-key',
  consumerDba: 'Heros Health Ghana',
  legalEntity: 'Telecheck-Ghana Ltd.',
  consumerSubdomain: 'ghana.heroshealth.com',
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
      host: ctx.tenantId === T_US ? 'heroshealth.com' : 'ghana.heroshealth.com',
      'idempotency-key': ulid(),
    },
    payload: { phone_e164: phone, code: codePlaintext },
  });
  const body = verify.json<{ access_token: string }>();
  return body.access_token;
}

// ---------------------------------------------------------------------------
// §1 country-profiles
// ---------------------------------------------------------------------------

describe('tenant-config admin HTTP — §1 GET /v0/admin/country-profiles', () => {
  it('§1a returns 200 with country profile list when JWT-auth is valid', async () => {
    const token = await loginToken(US_CTX, '+1');
    const r = await app!.inject({
      method: 'GET',
      url: '/v0/admin/country-profiles',
      headers: { host: 'heroshealth.com', authorization: `Bearer ${token}` },
    });
    expect(r.statusCode).toBe(200);
    const body = r.json<{ country_profiles: Array<{ country: string }> }>();
    expect(body.country_profiles.length).toBeGreaterThanOrEqual(2);
    const codes = body.country_profiles.map((p) => p.country);
    expect(codes).toContain('US');
    expect(codes).toContain('GH');
  });

  it('§1b returns 401 without Bearer JWT', async () => {
    const r = await app!.inject({
      method: 'GET',
      url: '/v0/admin/country-profiles',
      headers: { host: 'heroshealth.com' },
    });
    expect(r.statusCode).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// §2 tenant-brand
// ---------------------------------------------------------------------------

describe('tenant-config admin HTTP — §2 GET /v0/admin/tenant-brand', () => {
  it('§2a US tenant operator sees Heros Health brand', async () => {
    const token = await loginToken(US_CTX, '+1');
    const r = await app!.inject({
      method: 'GET',
      url: '/v0/admin/tenant-brand',
      headers: { host: 'heroshealth.com', authorization: `Bearer ${token}` },
    });
    expect(r.statusCode).toBe(200);
    const body = r.json<{ brand: { brand_name: string; custom_domain: string } }>();
    expect(body.brand.brand_name).toBe('Heros Health');
    expect(body.brand.custom_domain).toBe('heroshealth.com');
  });

  it('§2b Ghana tenant operator sees Heros Health Ghana brand (cross-tenant isolation)', async () => {
    const token = await loginToken(GH_CTX, '+233');
    const r = await app!.inject({
      method: 'GET',
      url: '/v0/admin/tenant-brand',
      headers: { host: 'ghana.heroshealth.com', authorization: `Bearer ${token}` },
    });
    expect(r.statusCode).toBe(200);
    const body = r.json<{ brand: { brand_name: string } }>();
    expect(body.brand.brand_name).toBe('Heros Health Ghana');
    // Body MUST NOT leak the OTHER tenant's brand (I-025 + §17 C3)
    expect(r.body).not.toContain('Heros Health LLC'); // US legal entity
  });
});

// ---------------------------------------------------------------------------
// §3 ccr-configs
// ---------------------------------------------------------------------------

describe('tenant-config admin HTTP — §3 GET /v0/admin/ccr-configs', () => {
  it('§3a empty list when no overrides; 200 OK', async () => {
    const token = await loginToken(US_CTX, '+1');
    const r = await app!.inject({
      method: 'GET',
      url: '/v0/admin/ccr-configs',
      headers: { host: 'heroshealth.com', authorization: `Bearer ${token}` },
    });
    expect(r.statusCode).toBe(200);
    const body = r.json<{ ccr_configs: Array<unknown> }>();
    expect(Array.isArray(body.ccr_configs)).toBe(true);
  });

  it('§3b returns the seeded override for the tenant', async () => {
    // Seed an override directly via SQL
    await withTenantContext(T_US, () =>
      getTestClient().query(
        `INSERT INTO ccr_configs (id, tenant_id, config_key, config_value)
         VALUES ($1, $2, $3, $4::jsonb)`,
        [ulid(), T_US, 'admin.test.key', JSON.stringify({ admin_seeded: true })],
      ),
    );
    const token = await loginToken(US_CTX, '+1');
    const r = await app!.inject({
      method: 'GET',
      url: '/v0/admin/ccr-configs',
      headers: { host: 'heroshealth.com', authorization: `Bearer ${token}` },
    });
    expect(r.statusCode).toBe(200);
    const body = r.json<{ ccr_configs: Array<{ config_key: string }> }>();
    const keys = body.ccr_configs.map((c) => c.config_key);
    expect(keys).toContain('admin.test.key');
  });
});

// ---------------------------------------------------------------------------
// §4 adapter-configs
// ---------------------------------------------------------------------------

describe('tenant-config admin HTTP — §4 GET /v0/admin/adapter-configs', () => {
  it('§4a returns 200 with redacted adapter_config payload', async () => {
    // Seed an adapter config with a "secret"-looking payload
    const adapterId = ulid();
    await withTenantContext(T_US, () =>
      getTestClient().query(
        `INSERT INTO adapter_configs (id, tenant_id, adapter_type, adapter_name,
                                       adapter_config, status)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6)`,
        [
          adapterId,
          T_US,
          'pharmacy',
          'truepill',
          JSON.stringify({ api_key_ref: 'kms:plaintext-leak-canary' }),
          'active',
        ],
      ),
    );
    const token = await loginToken(US_CTX, '+1');
    const r = await app!.inject({
      method: 'GET',
      url: '/v0/admin/adapter-configs',
      headers: { host: 'heroshealth.com', authorization: `Bearer ${token}` },
    });
    expect(r.statusCode).toBe(200);
    const body = r.json<{
      adapter_configs: Array<{
        adapter_name: string;
        adapter_config: { redacted: boolean; byte_length: number };
      }>;
    }>();
    const truepill = body.adapter_configs.find((a) => a.adapter_name === 'truepill');
    expect(truepill).toBeDefined();
    expect(truepill!.adapter_config.redacted).toBe(true);
    expect(truepill!.adapter_config.byte_length).toBeGreaterThan(0);
    // Critical: the canary string from the seeded payload MUST NOT appear
    // in the response body anywhere.
    expect(r.body).not.toContain('plaintext-leak-canary');
    expect(r.body).not.toContain('api_key_ref');
  });

  it('§4b cross-tenant isolation — US operator never sees Ghana adapter rows', async () => {
    // Seed a Ghana-tenant adapter
    const ghAdapterId = ulid();
    await withTenantContext(T_GH, () =>
      getTestClient().query(
        `INSERT INTO adapter_configs (id, tenant_id, adapter_type, adapter_name,
                                       adapter_config, status)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6)`,
        [ghAdapterId, T_GH, 'sms', 'hubtel', JSON.stringify({ ghana_only: true }), 'active'],
      ),
    );
    const usToken = await loginToken(US_CTX, '+1');
    const r = await app!.inject({
      method: 'GET',
      url: '/v0/admin/adapter-configs',
      headers: { host: 'heroshealth.com', authorization: `Bearer ${usToken}` },
    });
    expect(r.statusCode).toBe(200);
    const body = r.json<{ adapter_configs: Array<{ id: string }> }>();
    expect(body.adapter_configs.find((a) => a.id === ghAdapterId)).toBeUndefined();
  });

  it('§4c 401 without JWT', async () => {
    const r = await app!.inject({
      method: 'GET',
      url: '/v0/admin/adapter-configs',
      headers: { host: 'heroshealth.com' },
    });
    expect(r.statusCode).toBe(401);
  });
});
