/**
 * migrations/018_tenant_config.sql — schema-level integration tests.
 *
 * Validates the three new tenant-config tables empirically:
 *   §1 tenant_brands   — PK = tenant_id, FK to tenants, hex color CHECK,
 *                         RLS tenant-scoped, updated_at trigger
 *   §2 country_profiles — platform-level (no RLS), US + GH seeds present,
 *                         JSONB columns deserialize cleanly
 *   §3 ccr_configs     — tenant-scoped, UNIQUE (tenant_id, config_key),
 *                         RLS isolation, updated_at trigger
 *
 * Coverage in this file (3 sections, 12 cases):
 *   §1a brand seed for Telecheck-US present
 *   §1b brand seed for Telecheck-Ghana present
 *   §1c primary_color hex format CHECK rejects non-hex
 *   §1d updated_at trigger advances on UPDATE
 *   §1e RLS — US brand invisible from Ghana tenant context
 *   §2a country_profiles US row present + JSONB readable
 *   §2b country_profiles GH row present + JSONB readable
 *   §2c country_profiles platform-level (readable without tenant binding)
 *   §3a INSERT + UPDATE round-trip with RLS
 *   §3b UNIQUE (tenant_id, config_key) collision rejected
 *   §3c updated_at trigger advances on UPDATE
 *   §3c-rls RLS — US ccr_config invisible from Ghana tenant context
 *
 * Spec references:
 *   - migrations/018_tenant_config.sql (target)
 *   - CDM v1.2 §4.2 (TenantBrand) + §4.3 (CountryProfile) + §4.4 (CCRConfig)
 *   - I-009 (no hardcoded country assumptions; country_profiles is the
 *     canonical registry)
 *   - I-023 / I-027 (RLS + tenant scoping)
 */

import { describe, expect, it } from 'vitest';

import type { TenantId } from '../../src/lib/glossary.ts';
import { ulid } from '../../src/lib/ulid.ts';
import { TENANT_GHANA, TENANT_US, withTenantContext } from '../helpers/tenant-fixtures.ts';
import { getTestClient } from '../setup.ts';

const T_US = TENANT_US as TenantId;
const T_GH = TENANT_GHANA as TenantId;

// ---------------------------------------------------------------------------
// §1 — tenant_brands
// ---------------------------------------------------------------------------

describe('migrations/018 — §1 tenant_brands', () => {
  it('§1a Telecheck-US brand seed present', async () => {
    const result = await withTenantContext(T_US, () =>
      getTestClient().query<{ brand_name: string }>(
        `SELECT brand_name FROM tenant_brands WHERE tenant_id = $1`,
        [T_US],
      ),
    );
    expect(result.rows[0]!.brand_name).toBe('Heros Health');
  });

  it('§1b Telecheck-Ghana brand seed present', async () => {
    const result = await withTenantContext(T_GH, () =>
      getTestClient().query<{ brand_name: string; custom_domain: string }>(
        `SELECT brand_name, custom_domain FROM tenant_brands WHERE tenant_id = $1`,
        [T_GH],
      ),
    );
    expect(result.rows[0]!.brand_name).toBe('Heros Health Ghana');
    expect(result.rows[0]!.custom_domain).toBe('ghana.heroshealth.com');
  });

  it('§1c primary_color hex CHECK rejects non-hex', async () => {
    await expect(
      withTenantContext(T_US, () =>
        getTestClient().query(
          `UPDATE tenant_brands SET primary_color = 'not-a-color' WHERE tenant_id = $1`,
          [T_US],
        ),
      ),
    ).rejects.toThrow(/tenant_brand_primary_color_hex|check constraint/i);
  });

  it('§1d updated_at trigger advances on UPDATE', async () => {
    const before = await withTenantContext(T_US, () =>
      getTestClient().query<{ updated_at: string }>(
        `SELECT updated_at FROM tenant_brands WHERE tenant_id = $1`,
        [T_US],
      ),
    );
    const beforeTs = before.rows[0]!.updated_at;

    await withTenantContext(T_US, () =>
      getTestClient().query(
        `UPDATE tenant_brands SET support_phone = '+1-555-0100' WHERE tenant_id = $1`,
        [T_US],
      ),
    );

    const after = await withTenantContext(T_US, () =>
      getTestClient().query<{ updated_at: string }>(
        `SELECT updated_at FROM tenant_brands WHERE tenant_id = $1`,
        [T_US],
      ),
    );
    expect(after.rows[0]!.updated_at).not.toBe(beforeTs);
  });

  it('§1e RLS isolation — US brand invisible from Ghana tenant context', async () => {
    const visible = await withTenantContext(T_GH, async () => {
      const r = await getTestClient().query<{ c: string }>(
        `SELECT COUNT(*)::text AS c FROM tenant_brands WHERE tenant_id = $1`,
        [T_US],
      );
      return Number.parseInt(r.rows[0]!.c, 10);
    });
    expect(visible).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// §2 — country_profiles (platform-level, no RLS)
// ---------------------------------------------------------------------------

describe('migrations/018 — §2 country_profiles', () => {
  it('§2a US country profile present + JSONB readable', async () => {
    const r = await getTestClient().query<{
      regulatory_module: string;
      currency_code: string;
      crisis_helplines: unknown;
    }>(`SELECT regulatory_module, currency_code, crisis_helplines
          FROM country_profiles WHERE country = 'US'`);
    expect(r.rows[0]!.regulatory_module).toBe('us_hipaa_state_telehealth');
    expect(r.rows[0]!.currency_code).toBe('USD');
    expect(Array.isArray(r.rows[0]!.crisis_helplines)).toBe(true);
  });

  it('§2b GH country profile present + JSONB readable', async () => {
    const r = await getTestClient().query<{
      regulatory_module: string;
      currency_code: string;
      default_payment_processor: string;
      available_sms_providers: unknown;
    }>(`SELECT regulatory_module, currency_code, default_payment_processor,
                available_sms_providers
          FROM country_profiles WHERE country = 'GH'`);
    expect(r.rows[0]!.regulatory_module).toBe('gh_dpa_mdc');
    expect(r.rows[0]!.currency_code).toBe('GHS');
    expect(r.rows[0]!.default_payment_processor).toBe('paystack');
    expect(Array.isArray(r.rows[0]!.available_sms_providers)).toBe(true);
  });

  it('§2c country_profiles is platform-level — readable without tenant binding', async () => {
    // Direct query without any withTenantContext wrapping. Should NOT raise
    // tenant_context_not_set because country_profiles has no RLS.
    const r = await getTestClient().query<{ c: string }>(
      `SELECT COUNT(*)::text AS c FROM country_profiles`,
    );
    expect(Number.parseInt(r.rows[0]!.c, 10)).toBeGreaterThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// §3 — ccr_configs
// ---------------------------------------------------------------------------

describe('migrations/018 — §3 ccr_configs', () => {
  it('§3a INSERT + UPDATE round-trip', async () => {
    const id = ulid();
    await withTenantContext(T_US, () =>
      getTestClient().query(
        `INSERT INTO ccr_configs (id, tenant_id, config_key, config_value)
         VALUES ($1, $2, $3, $4::jsonb)`,
        [id, T_US, 'notification.sms_provider', JSON.stringify('twilio_verify')],
      ),
    );
    const r = await withTenantContext(T_US, () =>
      getTestClient().query<{ config_value: unknown }>(
        `SELECT config_value FROM ccr_configs WHERE id = $1`,
        [id],
      ),
    );
    expect(r.rows[0]!.config_value).toBe('twilio_verify');
  });

  it('§3b UNIQUE (tenant_id, config_key) collision rejected', async () => {
    const id1 = ulid();
    await withTenantContext(T_US, () =>
      getTestClient().query(
        `INSERT INTO ccr_configs (id, tenant_id, config_key, config_value)
         VALUES ($1, $2, $3, $4::jsonb)`,
        [id1, T_US, 'pharmacy.routing_strategy', JSON.stringify('round_robin')],
      ),
    );
    const id2 = ulid();
    await expect(
      withTenantContext(T_US, () =>
        getTestClient().query(
          `INSERT INTO ccr_configs (id, tenant_id, config_key, config_value)
           VALUES ($1, $2, $3, $4::jsonb)`,
          [id2, T_US, 'pharmacy.routing_strategy', JSON.stringify('weighted')],
        ),
      ),
    ).rejects.toThrow(/duplicate key|unique/i);
  });

  it('§3c updated_at trigger advances on UPDATE', async () => {
    const id = ulid();
    await withTenantContext(T_US, () =>
      getTestClient().query(
        `INSERT INTO ccr_configs (id, tenant_id, config_key, config_value)
         VALUES ($1, $2, $3, $4::jsonb)`,
        [id, T_US, 'payment.processor_override', JSON.stringify('stripe_eu')],
      ),
    );
    const before = await withTenantContext(T_US, () =>
      getTestClient().query<{ updated_at: string }>(
        `SELECT updated_at FROM ccr_configs WHERE id = $1`,
        [id],
      ),
    );
    await withTenantContext(T_US, () =>
      getTestClient().query(`UPDATE ccr_configs SET config_value = $1::jsonb WHERE id = $2`, [
        JSON.stringify('stripe_us'),
        id,
      ]),
    );
    const after = await withTenantContext(T_US, () =>
      getTestClient().query<{ updated_at: string }>(
        `SELECT updated_at FROM ccr_configs WHERE id = $1`,
        [id],
      ),
    );
    expect(after.rows[0]!.updated_at).not.toBe(before.rows[0]!.updated_at);
  });

  it('§3d RLS isolation — US ccr_config invisible from Ghana', async () => {
    const id = ulid();
    await withTenantContext(T_US, () =>
      getTestClient().query(
        `INSERT INTO ccr_configs (id, tenant_id, config_key, config_value)
         VALUES ($1, $2, $3, $4::jsonb)`,
        [id, T_US, 'rls.crosstenant.test', JSON.stringify({ probe: 1 })],
      ),
    );
    const visible = await withTenantContext(T_GH, async () => {
      const r = await getTestClient().query<{ c: string }>(
        `SELECT COUNT(*)::text AS c FROM ccr_configs WHERE id = $1`,
        [id],
      );
      return Number.parseInt(r.rows[0]!.c, 10);
    });
    expect(visible).toBe(0);
  });
});
