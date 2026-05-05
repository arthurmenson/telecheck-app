/**
 * country-profile-repo.ts — read access to the platform-level country_profiles
 * registry per CDM v1.2 §4.3.
 *
 * country_profiles has NO RLS (platform-level), so callers do not need to
 * pre-bind tenant context to read. Used by the CCR resolver service to
 * provide default values that per-tenant ccr_configs override.
 *
 * Spec references:
 *   - migrations/018_tenant_config.sql
 *   - CDM v1.2 §4.3
 */

import type { DbClient } from '../../../../lib/db.js';
import { withTransaction } from '../../../../lib/db.js';
import { asCountryCode, type CountryCode, type CountryProfile } from '../types.js';

const COUNTRY_PROFILE_COLUMNS = `
  country,
  regulatory_module,
  default_payment_processor,
  supported_payment_methods,
  currency_code,
  currency_symbol,
  default_locale,
  date_format,
  time_format,
  measurement_units,
  phone_format,
  address_format,
  emergency_number,
  crisis_helplines,
  default_notification_channels,
  default_quiet_hours,
  available_clinician_network_adapters,
  available_pharmacy_adapters,
  available_sms_providers,
  created_at::text AS created_at,
  updated_at::text AS updated_at
`;

interface CountryProfileRow {
  country: string;
  regulatory_module: string;
  default_payment_processor: string;
  supported_payment_methods: string[];
  currency_code: string;
  currency_symbol: string;
  default_locale: string;
  date_format: string;
  time_format: string;
  measurement_units: string;
  phone_format: string;
  address_format: Record<string, unknown>;
  emergency_number: string;
  crisis_helplines: Array<{ name: string; number: string; available_hours: string }>;
  default_notification_channels: string[];
  default_quiet_hours: Record<string, unknown>;
  available_clinician_network_adapters: string[];
  available_pharmacy_adapters: string[];
  available_sms_providers: string[];
  created_at: string;
  updated_at: string;
}

function rowToCountryProfile(row: CountryProfileRow): CountryProfile {
  return {
    country: asCountryCode(row.country),
    regulatory_module: row.regulatory_module,
    default_payment_processor: row.default_payment_processor,
    supported_payment_methods: row.supported_payment_methods,
    currency_code: row.currency_code,
    currency_symbol: row.currency_symbol,
    default_locale: row.default_locale,
    date_format: row.date_format,
    time_format: row.time_format,
    measurement_units: row.measurement_units,
    phone_format: row.phone_format,
    address_format: row.address_format,
    emergency_number: row.emergency_number,
    crisis_helplines: row.crisis_helplines,
    default_notification_channels: row.default_notification_channels,
    default_quiet_hours: row.default_quiet_hours,
    available_clinician_network_adapters: row.available_clinician_network_adapters,
    available_pharmacy_adapters: row.available_pharmacy_adapters,
    available_sms_providers: row.available_sms_providers,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/**
 * Find a country profile by ISO 3166-1 alpha-2 code. Returns null if not
 * registered (i.e., the market is not supported by the platform).
 *
 * country_profiles has no RLS so this can be called without tenant context.
 *
 * @param country - 2-char uppercase ISO code (e.g., 'US', 'GH')
 * @param externalTx - optional shared transaction
 */
export async function findCountryProfile(
  country: CountryCode | string,
  externalTx?: DbClient,
): Promise<CountryProfile | null> {
  const runner = externalTx
    ? (fn: (client: DbClient) => Promise<CountryProfile | null>) => fn(externalTx)
    : (fn: (client: DbClient) => Promise<CountryProfile | null>) => withTransaction(fn);
  return runner(async (client) => {
    const result = await client.query<CountryProfileRow>(
      `SELECT ${COUNTRY_PROFILE_COLUMNS} FROM country_profiles WHERE country = $1`,
      [country],
    );
    if (result.rows.length === 0) return null;
    const row = result.rows[0];
    if (row === undefined) return null;
    return rowToCountryProfile(row);
  });
}

/**
 * List all registered country profiles. Used by Admin Backend market-rollout
 * surfaces. country_profiles has no RLS so this is platform-readable.
 */
export async function listCountryProfiles(externalTx?: DbClient): Promise<CountryProfile[]> {
  const runner = externalTx
    ? (fn: (client: DbClient) => Promise<CountryProfile[]>) => fn(externalTx)
    : (fn: (client: DbClient) => Promise<CountryProfile[]>) => withTransaction(fn);
  return runner(async (client) => {
    const result = await client.query<CountryProfileRow>(
      `SELECT ${COUNTRY_PROFILE_COLUMNS} FROM country_profiles ORDER BY country`,
    );
    return result.rows.map(rowToCountryProfile);
  });
}
