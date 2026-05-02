/**
 * tenant-context.ts — Request-time tenant context resolution.
 *
 * Purpose:
 *   Resolves `tenantId`, `countryOfCare`, `kmsKeyAlias`, `consumerDba` from
 *   the incoming request and exposes the resolved context via Fastify decorator
 *   `req.tenantContext`. Fail-closed: if tenant cannot be determined, the
 *   request is rejected with 400 (not defaulted to any tenant) per I-023.
 *
 * Spec references:
 *   - I-023 (three-layer tenant isolation): app-layer filtering is the second
 *     enforcement layer. Resolution MUST happen before any tenant-scoped data
 *     access. Fail closed — do NOT default to any tenant.
 *   - I-025 (tenant-blind errors): resolution failures return tenant-blind
 *     errors; we never confirm whether a tenant exists to an unauthenticated
 *     caller.
 *   - Tenant Threading Addendum v1.0 §3.13 (request routing): subdomain-based
 *     resolution at v1.0; JWT/header-based resolution is layered in later.
 *   - Master PRD v1.10 §17 + Glossary v5.2 C3 brand structure:
 *       * Operating-tenant IDs: `Telecheck-{country}`.
 *       * Consumer DBA sourced from `tenant.consumer_dba`, never from `tenant.id`.
 *       * Bare `Heros` is a FORBIDDEN tenant identifier.
 *   - ADR-023 (multi-tenancy Model A): one DB, logical isolation by tenant_id.
 *   - ADR-024 (per-tenant KMS): kmsKeyAlias resolved per tenant from DB.
 *
 * Resolution strategy (v1.0 — subdomain-based):
 *   1. Extract subdomain from `Host` header.
 *   2. Map subdomain → tenant record (DB lookup or in-memory cache; stub here).
 *   3. Validate tenant status is `active`.
 *   4. Populate `req.tenantContext`.
 *
 *   JWT-based resolution (claims: `tenant_id`) and `X-Telecheck-Tenant-Id`
 *   header override (for machine-to-machine / admin calls) will be layered
 *   in by the auth module once that slice begins.
 *
 * Allowlisted tenant-blind endpoints (no resolution required):
 *   - /health (always allowlisted)
 *   - Additional paths via `allowlistedPaths` plugin option.
 *
 * Open questions for Engineering Lead:
 *   - DB lookup vs cache: currently stubs a hardcoded mapping for the two
 *     day-1 tenants. Real implementation queries the `tenants` table.
 *     Cache-busting on tenant config changes (per System Architecture v1.2 §13)
 *     requires an event subscription — deferred to Tenant Configuration module.
 *   - Should `Telecheck-Ghana` map from `ghana.heroshealth.com` subdomain?
 *     The stub below uses the consumer subdomain pattern from CDM v1.2 v1.10
 *     cycle additions. Confirm the exact subdomain-to-tenant mapping with PD.
 */

import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import { type TenantId, asTenantId } from './glossary.js';

// ---------------------------------------------------------------------------
// TenantContext type
// ---------------------------------------------------------------------------

export interface TenantContext {
  /** Operating-tenant identifier in `Telecheck-{Country}` format. */
  tenantId: TenantId;
  /** ISO 3166-1 alpha-2 country code driving CCR resolution. */
  countryOfCare: 'US' | 'GH';
  /**
   * AWS KMS key alias for per-tenant encryption (ADR-024).
   * Format: `alias/telecheck-{country_of_care}-data-key`.
   */
  kmsKeyAlias: string;
  /**
   * Consumer-facing DBA name (e.g., "Heros Health").
   * Source: `tenant.consumer_dba`. NEVER render `tenantId` to patients —
   * always use `consumerDba` for patient-facing surfaces.
   */
  consumerDba: string;
}

// ---------------------------------------------------------------------------
// STUB: hardcoded day-1 tenant lookup
// STUB: Real implementation queries the `tenants` table via DB connection.
//       This stub is safe only for bootstrap; it throws at runtime on any
//       tenant not in the hardcoded list, which is correct fail-closed behavior.
// ---------------------------------------------------------------------------

type SubdomainTenantEntry = {
  tenantId: string;
  countryOfCare: 'US' | 'GH';
  kmsKeyAlias: string;
  consumerDba: string;
};

/** Maps hostname pattern → tenant entry. Case-insensitive on lookup. */
const SUBDOMAIN_TENANT_MAP: Record<string, SubdomainTenantEntry> = {
  // Telecheck-US: heroshealth.com (consumer DBA: Heros Health)
  'heroshealth.com': {
    tenantId: 'Telecheck-US',
    countryOfCare: 'US',
    kmsKeyAlias: 'alias/telecheck-us-data-key',
    consumerDba: 'Heros Health',
  },
  'www.heroshealth.com': {
    tenantId: 'Telecheck-US',
    countryOfCare: 'US',
    kmsKeyAlias: 'alias/telecheck-us-data-key',
    consumerDba: 'Heros Health',
  },
  // Telecheck-Ghana: ghana.heroshealth.com (consumer DBA: Heros Health Ghana)
  'ghana.heroshealth.com': {
    tenantId: 'Telecheck-Ghana',
    countryOfCare: 'GH',
    kmsKeyAlias: 'alias/telecheck-gh-data-key',
    consumerDba: 'Heros Health Ghana',
  },
  // Local dev / test
  'localhost': {
    tenantId: 'Telecheck-US',
    countryOfCare: 'US',
    kmsKeyAlias: 'alias/telecheck-us-data-key',
    consumerDba: 'Heros Health',
  },
};

function resolveHostToTenant(host: string): SubdomainTenantEntry | null {
  // Strip port if present (e.g., localhost:3000 → localhost)
  const hostname = host.split(':')[0]?.toLowerCase() ?? '';
  return SUBDOMAIN_TENANT_MAP[hostname] ?? null;
}

// ---------------------------------------------------------------------------
// Plugin options
// ---------------------------------------------------------------------------

export interface TenantContextPluginOptions {
  /**
   * Paths that bypass tenant resolution entirely.
   * `/health` is always allowlisted regardless of this option.
   */
  allowlistedPaths?: string[];
}

// ---------------------------------------------------------------------------
// Fastify plugin
// ---------------------------------------------------------------------------

const tenantContextPluginImpl: FastifyPluginAsync<TenantContextPluginOptions> = async (
  fastify: FastifyInstance,
  opts: TenantContextPluginOptions,
) => {
  const allowlist = new Set<string>([
    '/health',
    ...(opts.allowlistedPaths ?? []),
  ]);

  // Decorate the request with a tenantContext slot.
  // Default value is undefined; resolution populates it in the hook below.
  // Accessing `req.tenantContext` before resolution completes (or on allowlisted
  // routes) returns undefined — callers must check or use `requireTenantContext()`.
  fastify.decorateRequest('tenantContext', undefined);

  fastify.addHook('onRequest', async (request, reply) => {
    const url = request.url.split('?')[0] ?? '';

    // Allowlisted paths skip resolution entirely.
    if (allowlist.has(url)) {
      return;
    }

    // Extract Host header.
    const host = request.headers.host;
    if (!host) {
      // I-023 fail-closed: no Host header = cannot resolve tenant.
      // I-025: tenant-blind error; do not differentiate the reason.
      await reply.code(400).send({
        error: {
          code: 'internal.request.missing_host_header',
          message: 'Request is missing a required Host header.',
          request_id: request.id,
        },
      });
      return;
    }

    const entry = resolveHostToTenant(host);
    if (!entry) {
      // I-023 fail-closed + I-025 tenant-blind: unknown host = 400.
      // Do NOT return 404 or otherwise confirm tenant existence.
      await reply.code(400).send({
        error: {
          code: 'internal.request.unresolvable_tenant',
          message: 'Could not resolve tenant context for this request.',
          request_id: request.id,
        },
      });
      return;
    }

    // Validate and brand the tenant ID.
    let tenantId: TenantId;
    try {
      tenantId = asTenantId(entry.tenantId);
    } catch {
      // Glossary format violation on a tenant in our own map — configuration error.
      request.log.error(
        { host },
        'Tenant map contains invalid tenant ID format — configuration error',
      );
      await reply.code(500).send({
        error: {
          code: 'internal.service.configuration_error',
          message: 'Internal configuration error.',
          request_id: request.id,
        },
      });
      return;
    }

    // Populate the decorator.
    const ctx: TenantContext = {
      tenantId,
      countryOfCare: entry.countryOfCare,
      kmsKeyAlias: entry.kmsKeyAlias,
      consumerDba: entry.consumerDba,
    };

    // @ts-expect-error: Fastify decorateRequest sets up the slot; TS doesn't know
    // the request type has been extended until module augmentation is in place.
    request.tenantContext = ctx;
  });
};

export const tenantContextPlugin = fp(tenantContextPluginImpl, {
  name: 'tenant-context',
  fastify: '5.x',
});

// ---------------------------------------------------------------------------
// Module augmentation for req.tenantContext
// ---------------------------------------------------------------------------

declare module 'fastify' {
  interface FastifyRequest {
    /**
     * Populated by `tenantContextPlugin` for all non-allowlisted requests.
     * Undefined on allowlisted paths (e.g., /health).
     * Handlers requiring tenant context MUST use `requireTenantContext()`.
     */
    tenantContext: TenantContext | undefined;
  }
}

// ---------------------------------------------------------------------------
// Guard helper for route handlers
// ---------------------------------------------------------------------------

/**
 * requireTenantContext — asserts `req.tenantContext` is present and returns it.
 *
 * Use in route handlers that cannot proceed without tenant context.
 * Throws if called on an allowlisted route (programming error, not user error).
 */
export function requireTenantContext(req: FastifyRequest): TenantContext {
  if (!req.tenantContext) {
    throw new Error(
      'requireTenantContext() called but tenantContext is undefined. ' +
        'This is a programming error — either the route is on the allowlist or ' +
        'the tenantContextPlugin did not run before this handler.',
    );
  }
  return req.tenantContext;
}
