/**
 * tenant-config — CCR resolver + tenant-brand + country-profile repo tests.
 *
 * Coverage in this file (3 sections, 9 cases):
 *   §1 country-profile-repo (3 cases) — find US, find GH, list returns ≥2 rows
 *   §2 ccr-resolver (4 cases) — resolveCcrKey override + 3 typed resolvers
 *      (SMS provider override path, payment processor default path, currency
 *      jurisdictional, emergency number jurisdictional)
 *   §3 tenant-brand-repo (2 cases) — findTenantBrand US + Ghana
 *
 * Spec references:
 *   - src/modules/tenant-config/* (target)
 *   - migrations/018_tenant_config.sql (schema seeded by this migration)
 *   - CCR_RUNTIME contract v5.2
 */

import { describe, expect, it } from 'vitest';

import { asTenantId } from '../../src/lib/glossary.ts';
import type { TenantContext } from '../../src/lib/tenant-context.ts';
import { ulid } from '../../src/lib/ulid.ts';
import {
  asCountryCode,
  findCountryProfile,
  findTenantBrand,
  getTenantCountryProfile,
  listCountryProfiles,
  resolveCcrKey,
  resolveCurrencyCode,
  resolveEmergencyNumber,
  resolvePaymentProcessor,
  resolveQuietHours,
  resolveSmsProvider,
} from '../../src/modules/tenant-config/index.ts';
import { TENANT_GHANA, TENANT_US, withTenantContext } from '../helpers/tenant-fixtures.ts';
import { getTestClient } from '../setup.ts';

const T_US = asTenantId(TENANT_US);
const T_GH = asTenantId(TENANT_GHANA);

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

// ---------------------------------------------------------------------------
// §1 — country-profile-repo
// ---------------------------------------------------------------------------

describe('tenant-config §1 country-profile-repo', () => {
  it('§1a findCountryProfile("US") returns regulatory module + currency', async () => {
    const profile = await findCountryProfile(asCountryCode('US'), getTestClient());
    expect(profile).not.toBeNull();
    expect(profile!.regulatory_module).toBe('us_hipaa_state_telehealth');
    expect(profile!.currency_code).toBe('USD');
    expect(profile!.default_payment_processor).toBe('stripe');
  });

  it('§1b findCountryProfile("GH") returns regulatory module + adapter list', async () => {
    const profile = await findCountryProfile(asCountryCode('GH'), getTestClient());
    expect(profile).not.toBeNull();
    expect(profile!.regulatory_module).toBe('gh_dpa_mdc');
    expect(profile!.currency_code).toBe('GHS');
    expect(profile!.default_payment_processor).toBe('paystack');
    expect(profile!.available_sms_providers).toContain('hubtel');
  });

  it('§1c listCountryProfiles returns ≥2 rows', async () => {
    const profiles = await listCountryProfiles(getTestClient());
    expect(profiles.length).toBeGreaterThanOrEqual(2);
    const codes = profiles.map((p) => p.country);
    expect(codes).toContain('US');
    expect(codes).toContain('GH');
  });
});

// ---------------------------------------------------------------------------
// §2 — ccr-resolver
// ---------------------------------------------------------------------------

describe('tenant-config §2 ccr-resolver', () => {
  it('§2a resolveCcrKey returns per-tenant override when present', async () => {
    // Insert override
    await withTenantContext(T_US, () =>
      getTestClient().query(
        `INSERT INTO ccr_configs (id, tenant_id, config_key, config_value)
         VALUES ($1, $2, $3, $4::jsonb)`,
        [ulid(), T_US, 'test.override.key', JSON.stringify({ overridden: true })],
      ),
    );

    const result = await withTenantContext(T_US, () =>
      resolveCcrKey(US_CTX, 'test.override.key', getTestClient()),
    );
    expect(result).toEqual({ overridden: true });
  });

  it('§2b resolveSmsProvider falls back to country profile default', async () => {
    // No override seeded — should fall back to country profile's first
    // available_sms_providers entry.
    const result = await withTenantContext(T_US, () => resolveSmsProvider(US_CTX, getTestClient()));
    expect(result).toBe('twilio'); // Per the seed in migration 018
  });

  it('§2c resolvePaymentProcessor returns Paystack for Ghana tenant', async () => {
    const result = await withTenantContext(T_GH, () =>
      resolvePaymentProcessor(GH_CTX, getTestClient()),
    );
    expect(result).toBe('paystack');
  });

  it('§2d2 resolveQuietHours falls back to country profile default', async () => {
    // No override seeded — falls back to country_profiles.default_quiet_hours
    // which the migration seeds as { start: '21:00', end: '07:00',
    // timezone_anchor: 'patient_local' } for both US and GH.
    const result = await withTenantContext(T_US, () => resolveQuietHours(US_CTX, getTestClient()));
    expect(result).not.toBeNull();
    expect(result!.start).toBe('21:00');
    expect(result!.end).toBe('07:00');
    expect(result!.timezone_anchor).toBe('patient_local');
  });

  it('§2d3 resolveQuietHours uses per-tenant override when shape is valid', async () => {
    await withTenantContext(T_US, () =>
      getTestClient().query(
        `INSERT INTO ccr_configs (id, tenant_id, config_key, config_value)
         VALUES ($1, $2, $3, $4::jsonb)`,
        [
          ulid(),
          T_US,
          'notification.quiet_hours_override',
          JSON.stringify({ start: '22:00', end: '06:00', timezone_anchor: 'tenant_local' }),
        ],
      ),
    );
    const result = await withTenantContext(T_US, () => resolveQuietHours(US_CTX, getTestClient()));
    expect(result).not.toBeNull();
    expect(result!.start).toBe('22:00');
    expect(result!.timezone_anchor).toBe('tenant_local');
  });

  it('§2d4 resolveQuietHours rejects malformed override and falls through', async () => {
    // Insert a malformed override (missing timezone_anchor)
    await withTenantContext(T_US, () =>
      getTestClient().query(
        `INSERT INTO ccr_configs (id, tenant_id, config_key, config_value)
         VALUES ($1, $2, $3, $4::jsonb)`,
        [ulid(), T_US, 'notification.quiet_hours_override', JSON.stringify({ start: '23:00' })],
      ),
    );
    const result = await withTenantContext(T_US, () => resolveQuietHours(US_CTX, getTestClient()));
    // Defensive: malformed override → falls through to country profile default
    expect(result!.start).toBe('21:00');
  });

  it('§2d resolveCurrencyCode + resolveEmergencyNumber are jurisdictional', async () => {
    const usCurrency = await withTenantContext(T_US, () =>
      resolveCurrencyCode(US_CTX, getTestClient()),
    );
    const usEmergency = await withTenantContext(T_US, () =>
      resolveEmergencyNumber(US_CTX, getTestClient()),
    );
    const ghCurrency = await withTenantContext(T_GH, () =>
      resolveCurrencyCode(GH_CTX, getTestClient()),
    );
    const ghEmergency = await withTenantContext(T_GH, () =>
      resolveEmergencyNumber(GH_CTX, getTestClient()),
    );
    expect(usCurrency).toBe('USD');
    expect(usEmergency).toBe('911');
    expect(ghCurrency).toBe('GHS');
    expect(ghEmergency).toBe('112');
  });
});

// ---------------------------------------------------------------------------
// §3 — tenant-brand-repo
// ---------------------------------------------------------------------------

describe('tenant-config §3 tenant-brand-repo', () => {
  it('§3a findTenantBrand returns Heros Health for US tenant', async () => {
    const brand = await withTenantContext(T_US, () => findTenantBrand(T_US, getTestClient()));
    expect(brand).not.toBeNull();
    expect(brand!.brand_name).toBe('Heros Health');
    expect(brand!.custom_domain).toBe('heroshealth.com');
  });

  it('§3b findTenantBrand returns Heros Health Ghana for GH tenant', async () => {
    const brand = await withTenantContext(T_GH, () => findTenantBrand(T_GH, getTestClient()));
    expect(brand).not.toBeNull();
    expect(brand!.brand_name).toBe('Heros Health Ghana');
    expect(brand!.custom_domain).toBe('ghana.heroshealth.com');
  });
});

// Importing getTenantCountryProfile to ensure it's exported (smoke test).
void getTenantCountryProfile;
