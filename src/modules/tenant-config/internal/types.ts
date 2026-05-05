/**
 * tenant-config — branded ID types + entity row shapes for CDM v1.2 §4.2-§4.6.
 *
 * Five entities, only three currently surfaced in the public interface:
 *   §4.2 TenantBrand     → tenant_brands       (PK = tenant_id, also FK)
 *   §4.3 CountryProfile  → country_profiles    (PK = country ISO code)
 *   §4.4 CCRConfig       → ccr_configs         (PK = id ULID; tenant-scoped)
 *
 * AdapterConfig (§4.5) and TenantUser (§4.6) are scaffolded at the schema
 * layer (migration 019) but their service layers belong with Admin Backend
 * slice v1.1 — encryption-at-rest wiring (adapter_configs) and operator-auth
 * integration (tenant_users) are out of scope for the foundational data layer.
 *
 * Spec references:
 *   - CDM v1.2 §4.2-§4.4
 *   - migrations/018_tenant_config.sql
 */

import type { TenantId } from '../../../lib/glossary.js';

// ---------------------------------------------------------------------------
// Branded ID types
// ---------------------------------------------------------------------------

declare const _ccrConfigIdBrand: unique symbol;
export type CcrConfigId = string & { readonly [_ccrConfigIdBrand]: 'CcrConfigId' };
export function asCcrConfigId(s: string): CcrConfigId {
  return s as CcrConfigId;
}

// CountryProfile uses a 2-char ISO code as PK; type-brand for clarity.
declare const _countryCodeBrand: unique symbol;
export type CountryCode = string & { readonly [_countryCodeBrand]: 'CountryCode' };
export function asCountryCode(s: string): CountryCode {
  return s as CountryCode;
}

// ---------------------------------------------------------------------------
// TenantBrand row shape (CDM §4.2)
// ---------------------------------------------------------------------------

export interface TenantBrand {
  tenant_id: TenantId;
  brand_name: string;
  logo_url: string | null;
  primary_color: string | null;
  secondary_color: string | null;
  accent_color: string | null;
  custom_domain: string | null;
  custom_domain_verified: boolean;
  terms_of_service_url: string | null;
  privacy_policy_url: string | null;
  support_email: string | null;
  support_phone: string | null;
  design_tokens: Record<string, unknown> | null;
  notification_copy_overrides: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
}

// ---------------------------------------------------------------------------
// CountryProfile row shape (CDM §4.3)
// ---------------------------------------------------------------------------

export interface CountryProfile {
  country: CountryCode;
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

// ---------------------------------------------------------------------------
// CCRConfig row shape (CDM §4.4)
// ---------------------------------------------------------------------------

export interface CcrConfig {
  ccr_config_id: CcrConfigId;
  tenant_id: TenantId;
  config_key: string;
  config_value: unknown; // intentionally permissive — JSONB is shape-flexible
  created_at: string;
  updated_at: string;
}
