/**
 * tenant-config module — public interface for downstream slices.
 *
 * Surfaces tenant-scoped + platform-level CCR config data per CDM v1.2 §4.2-§4.4.
 * Cross-module callers MUST import from here, not from `./internal/*`.
 *
 * The CCR resolver service is the canonical lookup surface for any CCR key —
 * downstream slices should never read country_profiles or ccr_configs directly.
 *
 * Schema for adapter_configs (§4.5) and tenant_users (§4.6) lands in
 * migration 019; their service layers belong with Admin Backend slice v1.1
 * (encryption-at-rest wiring + operator auth integration are out of scope
 * for this foundational data layer).
 *
 * Spec references:
 *   - ADR-001 (modular monolith — public-interface-only cross-module access)
 *   - CDM v1.2 §4.2-§4.4
 *   - Contracts Pack v5.2 CCR_RUNTIME
 */

export type {
  CountryCode,
  CountryProfile,
  CcrConfigId,
  CcrConfig,
  TenantBrand,
} from './internal/types.js';

export { asCountryCode, asCcrConfigId } from './internal/types.js';

// Canonical CCR key constants per Contracts Pack v5.2 CCR_RUNTIME.
// Use these instead of hardcoded literals to avoid typos that silently
// return null from the resolver.
export { CCR_KEYS, type CcrKey } from './internal/ccr-keys.js';

// CCR resolver — canonical CCR key lookup
export {
  resolveCcrKey,
  getTenantCountryProfile,
  resolveSmsProvider,
  resolvePaymentProcessor,
  resolveCurrencyCode,
  resolveEmergencyNumber,
} from './internal/services/ccr-resolver.js';

// Tenant brand fetch (used by patient/clinician UI)
export { findTenantBrand } from './internal/repositories/tenant-brand-repo.js';

// Country profile read (admin-side market rollout UI)
export {
  findCountryProfile,
  listCountryProfiles,
} from './internal/repositories/country-profile-repo.js';

// Fastify plugin for app.ts wiring
export { tenantConfigPlugin } from './plugin.js';
