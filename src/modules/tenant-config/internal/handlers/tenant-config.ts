/**
 * tenant-config HTTP handlers.
 *
 *   GET /v0/tenant-config/me — returns the tenant's brand + country profile
 *                              snapshot for the patient app to render the
 *                              bootstrap shell. NO auth required (brand info
 *                              is needed pre-login to show the right colors
 *                              + support contact). Tenant resolution comes
 *                              from the host header via tenantContextPlugin.
 *
 * Spec references:
 *   - Master PRD v1.10 §17 + Glossary v5.2 C3 (tenant.id never leaks to
 *     patient surfaces; this endpoint serves consumer_dba sourced data)
 *   - I-009 (CCR resolution via tenant-config module's resolver)
 *   - I-025 (tenant-blind error envelopes — preserved through the canonical
 *     errorEnvelopePlugin)
 */

import type { FastifyReply, FastifyRequest } from 'fastify';

import { requireTenantContext } from '../../../../lib/tenant-context.js';
import { findTenantBrand } from '../repositories/tenant-brand-repo.js';
import { getTenantCountryProfile } from '../services/ccr-resolver.js';
import type { CountryProfile, TenantBrand } from '../types.js';

// ---------------------------------------------------------------------------
// Patient-surface views — strip tenant_id per Master PRD v1.10 §17 + C3
// ---------------------------------------------------------------------------

type PatientBrandView = Omit<TenantBrand, 'tenant_id'>;

function brandToPatientView(b: TenantBrand): PatientBrandView {
  const { tenant_id: _stripped, ...rest } = b;
  void _stripped;
  return rest;
}

interface PatientCountryProfileView {
  // Selectively expose only fields the patient app needs at bootstrap.
  // Avoid leaking adapter availability lists or admin-side regulatory module
  // metadata — those are operator-side concerns.
  country: string;
  currency_code: string;
  currency_symbol: string;
  default_locale: string;
  date_format: string;
  time_format: string;
  measurement_units: string;
  emergency_number: string;
  crisis_helplines: CountryProfile['crisis_helplines'];
}

function profileToPatientView(p: CountryProfile): PatientCountryProfileView {
  return {
    country: p.country,
    currency_code: p.currency_code,
    currency_symbol: p.currency_symbol,
    default_locale: p.default_locale,
    date_format: p.date_format,
    time_format: p.time_format,
    measurement_units: p.measurement_units,
    emergency_number: p.emergency_number,
    crisis_helplines: p.crisis_helplines,
  };
}

// ---------------------------------------------------------------------------
// GET /v0/tenant-config/me
// ---------------------------------------------------------------------------

export async function getTenantConfigMeHandler(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<unknown> {
  const ctx = requireTenantContext(req);
  const [brand, profile] = await Promise.all([
    findTenantBrand(ctx.tenantId),
    getTenantCountryProfile(ctx),
  ]);

  // Brand is optional at the API contract level — if a tenant has no brand
  // row, callers should fall back to design-system defaults. We still return
  // 200 with brand=null rather than 404 to keep the patient-app bootstrap
  // simple.
  return reply.code(200).send({
    brand: brand === null ? null : brandToPatientView(brand),
    country_profile: profile === null ? null : profileToPatientView(profile),
  });
}
