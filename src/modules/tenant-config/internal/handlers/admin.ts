/**
 * tenant-config admin read handlers — Sprint 2 / TLC-004.
 *
 * Read-only HTTP surface for Admin Backend operators to inspect the
 * tenant-config layer. Mutation handlers (POST/PATCH/DELETE) belong with
 * the dedicated Admin Backend slice v1.1 (which owns operator auth +
 * encryption-at-rest wiring for adapter_configs.adapter_config payloads).
 *
 * All routes require Bearer JWT (Tier 1 via `requireActorContext`).
 * Tenant resolution comes from the JWT's tenant_id claim, gated by the
 * tenantContextPlugin's cross-tenant token-forge defense.
 *
 * Routes:
 *   GET /v0/admin/country-profiles    — platform-level country registry list
 *   GET /v0/admin/tenant-brand        — current tenant's brand row
 *   GET /v0/admin/ccr-configs         — current tenant's CCR overrides
 *   GET /v0/admin/adapter-configs     — current tenant's adapter selections
 *
 * Spec references:
 *   - CDM v1.2 §4.2-§4.5
 *   - I-023 / I-025 / I-027
 *   - Master PRD v1.10 §17 + Glossary v5.2 C3 (tenant_id stripped from
 *     patient surfaces; admin surfaces MAY include tenant_id since it's
 *     for the operator's own tenant by JWT)
 */

import type { FastifyReply, FastifyRequest } from 'fastify';

import { requireActorContext } from '../../../../lib/auth-context.js';
import { requireTenantContext } from '../../../../lib/tenant-context.js';
import {
  listAdapterConfigsForTenant,
  type AdapterConfig,
} from '../repositories/adapter-config-repo.js';
import { listCcrConfigsForTenant } from '../repositories/ccr-config-repo.js';
import { listCountryProfiles } from '../repositories/country-profile-repo.js';
import { findTenantBrand } from '../repositories/tenant-brand-repo.js';

// ---------------------------------------------------------------------------
// Adapter-config view — redact the encrypted JSONB payload
// ---------------------------------------------------------------------------

interface AdminAdapterConfigView {
  id: string;
  adapter_type: string;
  adapter_name: string;
  status: string;
  /**
   * Always rendered as `{redacted: true, byte_length: <n>}` at v0.1 to
   * prevent admin UI from rendering decrypted secrets. Real decryption +
   * masked-fields-only rendering lands with Admin Backend slice v1.1.
   */
  adapter_config: { redacted: true; byte_length: number };
  created_at: string;
  updated_at: string;
}

function adapterToAdminView(row: AdapterConfig): AdminAdapterConfigView {
  const serialized = JSON.stringify(row.adapter_config);
  return {
    id: row.id,
    adapter_type: row.adapter_type,
    adapter_name: row.adapter_name,
    status: row.status,
    adapter_config: { redacted: true, byte_length: serialized.length },
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

// ---------------------------------------------------------------------------
// GET /v0/admin/country-profiles
// ---------------------------------------------------------------------------

export async function listCountryProfilesHandler(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<unknown> {
  // Auth required per Tier 1; we don't gate by tenant since
  // country_profiles is platform-level (no RLS).
  requireActorContext(req);
  const profiles = await listCountryProfiles();
  return reply.code(200).send({ country_profiles: profiles });
}

// ---------------------------------------------------------------------------
// GET /v0/admin/tenant-brand
// ---------------------------------------------------------------------------

export async function getTenantBrandHandler(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<unknown> {
  const ctx = requireTenantContext(req);
  requireActorContext(req);
  const brand = await findTenantBrand(ctx.tenantId);
  if (brand === null) {
    return reply.code(404).send({
      error: {
        code: 'internal.resource.not_found',
        message: 'Tenant brand not configured.',
        request_id: req.id,
      },
    });
  }
  return reply.code(200).send({ brand });
}

// ---------------------------------------------------------------------------
// GET /v0/admin/ccr-configs
// ---------------------------------------------------------------------------

export async function listCcrConfigsHandler(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<unknown> {
  const ctx = requireTenantContext(req);
  requireActorContext(req);
  const configs = await listCcrConfigsForTenant(ctx.tenantId);
  return reply.code(200).send({ ccr_configs: configs });
}

// ---------------------------------------------------------------------------
// GET /v0/admin/adapter-configs
// ---------------------------------------------------------------------------

export async function listAdapterConfigsHandler(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<unknown> {
  const ctx = requireTenantContext(req);
  requireActorContext(req);
  const configs = await listAdapterConfigsForTenant(ctx.tenantId);
  // Redact the JSONB payload (per ADR-024 — secrets stay opaque to admin
  // UI at v0.1; full decryption lands with Admin Backend slice).
  const view = configs.map(adapterToAdminView);
  return reply.code(200).send({ adapter_configs: view });
}
