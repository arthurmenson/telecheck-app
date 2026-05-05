/**
 * Tenant-config slice — HTTP integration test.
 *
 * Exercises GET /v0/tenant-config/{health, me} end-to-end via Fastify
 * inject(). The /me endpoint requires NO auth (brand info is needed by the
 * patient app at bootstrap, before login) but IS tenant-scoped (host header
 * resolves to a tenant via tenantContextPlugin).
 *
 * Coverage in this file (3 sections, 5 cases):
 *   §1 health probe
 *   §2 /me US bootstrap
 *   §3 /me Ghana bootstrap + I-025 tenant-blind body assertion
 *
 * Spec references:
 *   - src/modules/tenant-config/internal/handlers/tenant-config.ts (target)
 *   - CDM v1.2 §4.2 + §4.3
 *   - I-025 (tenant-blind body — operating-tenant identifier MUST NOT leak)
 */

import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../../src/app.ts';

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

// ---------------------------------------------------------------------------
// §1 — health
// ---------------------------------------------------------------------------

describe('tenant-config HTTP — §1 health', () => {
  it('§1a GET /v0/tenant-config/health returns ok', async () => {
    const r = await app!.inject({
      method: 'GET',
      url: '/v0/tenant-config/health',
      headers: { host: 'localhost' },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json<{ status: string; module: string }>()).toEqual({
      status: 'ok',
      module: 'tenant-config',
    });
  });
});

// ---------------------------------------------------------------------------
// §2 — /me US bootstrap
// ---------------------------------------------------------------------------

describe('tenant-config HTTP — §2 /me US bootstrap', () => {
  it('§2a returns brand + country_profile for heroshealth.com host', async () => {
    const r = await app!.inject({
      method: 'GET',
      url: '/v0/tenant-config/me',
      headers: { host: 'heroshealth.com' },
    });
    expect(r.statusCode).toBe(200);
    const body = r.json<{
      brand: { brand_name: string; custom_domain: string } | null;
      country_profile: { country: string; currency_code: string; emergency_number: string } | null;
    }>();
    expect(body.brand).not.toBeNull();
    expect(body.brand!.brand_name).toBe('Heros Health');
    expect(body.brand!.custom_domain).toBe('heroshealth.com');
    expect(body.country_profile).not.toBeNull();
    expect(body.country_profile!.country).toBe('US');
    expect(body.country_profile!.currency_code).toBe('USD');
    expect(body.country_profile!.emergency_number).toBe('911');
  });

  it('§2b body does NOT leak operating-tenant identifier (I-025 + §17 C3)', async () => {
    const r = await app!.inject({
      method: 'GET',
      url: '/v0/tenant-config/me',
      headers: { host: 'heroshealth.com' },
    });
    expect(r.body).not.toContain('"tenant_id"');
    expect(r.body).not.toContain('Telecheck-US');
    // The patient-facing brand_name "Heros Health" IS expected in the body —
    // that's the consumer DBA, which is the entire point of the surface.
    // Operating-tenant id "Telecheck-US" must not appear.
  });
});

// ---------------------------------------------------------------------------
// §3 — /me Ghana bootstrap
// ---------------------------------------------------------------------------

describe('tenant-config HTTP — §3 /me Ghana bootstrap', () => {
  it('§3a returns brand + country_profile for ghana.heroshealth.com host', async () => {
    const r = await app!.inject({
      method: 'GET',
      url: '/v0/tenant-config/me',
      headers: { host: 'ghana.heroshealth.com' },
    });
    expect(r.statusCode).toBe(200);
    const body = r.json<{
      brand: { brand_name: string; custom_domain: string } | null;
      country_profile: { country: string; currency_code: string; emergency_number: string } | null;
    }>();
    expect(body.brand!.brand_name).toBe('Heros Health Ghana');
    expect(body.country_profile!.country).toBe('GH');
    expect(body.country_profile!.currency_code).toBe('GHS');
    expect(body.country_profile!.emergency_number).toBe('112');
  });

  it('§3b body does NOT leak Telecheck-Ghana operating-tenant id', async () => {
    const r = await app!.inject({
      method: 'GET',
      url: '/v0/tenant-config/me',
      headers: { host: 'ghana.heroshealth.com' },
    });
    expect(r.body).not.toContain('"tenant_id"');
    expect(r.body).not.toContain('Telecheck-Ghana');
  });
});
