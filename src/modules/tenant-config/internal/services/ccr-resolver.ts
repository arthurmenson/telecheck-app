/**
 * ccr-resolver.ts — CCR key resolution per CDM v1.2 §4.4 + Contracts Pack
 * v5.2 CCR_RUNTIME contract.
 *
 * Combines per-tenant ccr_configs overrides with country_profiles defaults
 * to produce a resolved value for any CCR key. The resolver is the canonical
 * lookup surface for downstream slices that need CCR data — e.g.,
 *   - Pharmacy slice asking "which adapter routes prescriptions for this
 *     tenant?" → resolveCcrKey(ctx, 'pharmacy.routing_adapter')
 *   - Notification slice asking "which SMS provider for this tenant?" →
 *     resolveCcrKey(ctx, 'notification.sms_provider')
 *   - Payment slice asking "currency for this tenant?" →
 *     resolvePaymentCurrency(ctx)
 *
 * Resolution order:
 *   1. ccr_configs row matching (tenant_id, config_key) — per-tenant override
 *   2. country_profiles[country_of_care] field if the key has a default
 *   3. null (caller decides whether to fall back to a hardcoded default or
 *      raise — most callers should treat null as "key not configured" and
 *      fail closed per I-009)
 *
 * Spec references:
 *   - CCR_RUNTIME contract v5.2
 *   - CDM v1.2 §4.3 (CountryProfile defaults) + §4.4 (CCRConfig overrides)
 *   - I-009 (CCR resolution is the only path to country/tenant-scoped config)
 */

import type { DbClient } from '../../../../lib/db.js';
import type { TenantContext } from '../../../../lib/tenant-context.js';
import { findCcrConfig } from '../repositories/ccr-config-repo.js';
import { findCountryProfile } from '../repositories/country-profile-repo.js';
import type { CountryProfile } from '../types.js';

// ---------------------------------------------------------------------------
// resolveCcrKey — generic per-key resolver
// ---------------------------------------------------------------------------

/**
 * Resolve a CCR key for the given tenant context, walking the override-then-
 * default chain. Returns the per-tenant override JSONB value if present,
 * else null — country-profile defaults are NOT auto-mapped here because the
 * country_profiles columns are typed (string / array / object) and the CCR
 * key namespace is intentionally untyped JSONB. Use the typed resolvers
 * below (resolvePaymentCurrency, resolveSmsProviders, etc.) for country-
 * profile fallback.
 *
 * @param ctx       - Tenant context (must have tenantId bound)
 * @param configKey - Dotted-namespace CCR key
 * @param externalTx - optional shared transaction
 * @returns The resolved JSONB value or null if no override exists
 */
export async function resolveCcrKey(
  ctx: TenantContext,
  configKey: string,
  externalTx?: DbClient,
): Promise<unknown> {
  const override = await findCcrConfig(ctx.tenantId, configKey, externalTx);
  if (override !== null) return override.config_value;
  return null;
}

// ---------------------------------------------------------------------------
// Typed resolvers — country-profile-backed
// ---------------------------------------------------------------------------

/**
 * Get the full country profile for the tenant's country_of_care. Returns
 * null if the country isn't registered (which shouldn't happen for an
 * active tenant — it's a I-009 invariant violation).
 */
export async function getTenantCountryProfile(
  ctx: TenantContext,
  externalTx?: DbClient,
): Promise<CountryProfile | null> {
  return findCountryProfile(ctx.countryOfCare, externalTx);
}

/**
 * Resolve the SMS provider for a tenant: per-tenant override OR the country
 * profile's first available_sms_providers entry. Returns null if neither
 * is configured (caller fails closed per I-009).
 *
 * The override value is expected to be a string adapter name (e.g.,
 * 'twilio', 'hubtel'). If the override JSONB is non-string, returns null
 * rather than guessing.
 */
export async function resolveSmsProvider(
  ctx: TenantContext,
  externalTx?: DbClient,
): Promise<string | null> {
  const override = await resolveCcrKey(ctx, 'notification.sms_provider', externalTx);
  if (typeof override === 'string') return override;
  const profile = await getTenantCountryProfile(ctx, externalTx);
  if (profile === null) return null;
  return profile.available_sms_providers[0] ?? null;
}

/**
 * Resolve the payment processor for a tenant: per-tenant override OR
 * country_profiles.default_payment_processor.
 */
export async function resolvePaymentProcessor(
  ctx: TenantContext,
  externalTx?: DbClient,
): Promise<string | null> {
  const override = await resolveCcrKey(ctx, 'payment.processor', externalTx);
  if (typeof override === 'string') return override;
  const profile = await getTenantCountryProfile(ctx, externalTx);
  if (profile === null) return null;
  return profile.default_payment_processor;
}

/**
 * Resolve the currency code for a tenant: country_profiles.currency_code
 * (no per-tenant override — currency is jurisdictionally fixed per market).
 */
export async function resolveCurrencyCode(
  ctx: TenantContext,
  externalTx?: DbClient,
): Promise<string | null> {
  const profile = await getTenantCountryProfile(ctx, externalTx);
  if (profile === null) return null;
  return profile.currency_code;
}

/**
 * Resolve the emergency phone number for a tenant. Used by the I-019 crisis-
 * detection surface to render market-appropriate "call XXX in an emergency"
 * copy. country_profiles.emergency_number — no per-tenant override (emergency
 * numbers are jurisdictional, not tenant-configurable).
 */
export async function resolveEmergencyNumber(
  ctx: TenantContext,
  externalTx?: DbClient,
): Promise<string | null> {
  const profile = await getTenantCountryProfile(ctx, externalTx);
  if (profile === null) return null;
  return profile.emergency_number;
}
