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

import { withConnection } from './db.js';
import { type TenantId, asTenantId } from './glossary.js';

// ---------------------------------------------------------------------------
// TenantContext type
// ---------------------------------------------------------------------------

export interface TenantContext {
  /** Operating-tenant identifier in `Telecheck-{Country}` format. Mirrors `tenants.id`. */
  tenantId: TenantId;
  /**
   * Operating-tenant display label for platform-admin UI. Mirrors
   * `tenants.display_name`. Typically equals `tenantId`.
   * (Added 2026-05-02 per Codex spec-r3 MEDIUM closure aligning runtime
   * TenantContext with TYPES v5.2 + CDM v1.2 §4.1 field set.)
   */
  displayName: string;
  /** ISO 3166-1 alpha-2 country code driving CCR resolution. */
  countryOfCare: 'US' | 'GH';
  /**
   * AWS KMS key alias for per-tenant encryption (ADR-024).
   * Format: `alias/telecheck-{country_of_care}-data-key`.
   */
  kmsKeyAlias: string;
  /**
   * Consumer-facing DBA name (e.g., "Heros Health"). Mirrors
   * `tenants.consumer_dba`. NEVER render `tenantId` to patients —
   * always use `consumerDba` for patient-facing surfaces.
   */
  consumerDba: string;
  /**
   * Per-country incorporated legal entity (e.g., "Telecheck Health LLC").
   * Mirrors `tenants.legal_entity`. Used by audit-export, regulatory
   * filings, contract metadata (BAAs etc.).
   * (Added 2026-05-02 per Codex spec-r3 MEDIUM closure.)
   */
  legalEntity: string;
  /**
   * Country-instanced consumer subdomain (e.g., "heroshealth.com").
   * Mirrors `tenants.consumer_subdomain`. Drives the subdomain-based
   * tenant resolution below.
   * (Added 2026-05-02 per Codex spec-r3 MEDIUM closure.)
   */
  consumerSubdomain: string;
}

// ---------------------------------------------------------------------------
// STUB: hardcoded day-1 tenant lookup
// STUB: Real implementation queries the `tenants` table via DB connection.
//       This stub is safe only for bootstrap; it throws at runtime on any
//       tenant not in the hardcoded list, which is correct fail-closed behavior.
//       Field set mirrors CDM v1.2 §4.1 1:1 per CDM SPEC ISSUE P-010 closure.
// ---------------------------------------------------------------------------

type SubdomainTenantEntry = {
  tenantId: string;
  displayName: string;
  countryOfCare: 'US' | 'GH';
  kmsKeyAlias: string;
  consumerDba: string;
  legalEntity: string;
  consumerSubdomain: string;
};

/**
 * Phase 2 admin widening (2026-05-15): canonical set of operating-tenant
 * identifiers known to the platform. Used by `authContextPlugin` to
 * validate platform_admin JWTs' home-tenant claim (a platform_admin
 * token issued with a stale/deleted/nonsensical tenant_id should be
 * rejected even though platform_admin is globally scoped — otherwise
 * audit attribution would reference a non-existent tenant).
 *
 * NOTE: derived from SUBDOMAIN_TENANT_MAP values at module-load time
 * so the source of truth remains the subdomain registry.
 */
export const KNOWN_TENANT_IDS: ReadonlySet<string> = new Set<string>([
  'Telecheck-US',
  'Telecheck-Ghana',
]);

/** Maps hostname pattern → tenant entry. Case-insensitive on lookup. */
const SUBDOMAIN_TENANT_MAP: Record<string, SubdomainTenantEntry> = {
  // Telecheck-US: heroshealth.com (consumer DBA: Heros Health)
  'heroshealth.com': {
    tenantId: 'Telecheck-US',
    displayName: 'Telecheck-US',
    countryOfCare: 'US',
    kmsKeyAlias: 'alias/telecheck-us-data-key',
    consumerDba: 'Heros Health',
    legalEntity: 'Telecheck Health LLC',
    consumerSubdomain: 'heroshealth.com',
  },
  'www.heroshealth.com': {
    tenantId: 'Telecheck-US',
    displayName: 'Telecheck-US',
    countryOfCare: 'US',
    kmsKeyAlias: 'alias/telecheck-us-data-key',
    consumerDba: 'Heros Health',
    legalEntity: 'Telecheck Health LLC',
    consumerSubdomain: 'heroshealth.com',
  },
  // Telecheck-Ghana: ghana.heroshealth.com (consumer DBA: Heros Health Ghana)
  'ghana.heroshealth.com': {
    tenantId: 'Telecheck-Ghana',
    displayName: 'Telecheck-Ghana',
    countryOfCare: 'GH',
    kmsKeyAlias: 'alias/telecheck-gh-data-key',
    consumerDba: 'Heros Health Ghana',
    legalEntity: 'Telecheck-Ghana Ltd.',
    consumerSubdomain: 'ghana.heroshealth.com',
  },
  // Local dev / test
  localhost: {
    tenantId: 'Telecheck-US',
    displayName: 'Telecheck-US',
    countryOfCare: 'US',
    kmsKeyAlias: 'alias/telecheck-us-data-key',
    consumerDba: 'Heros Health',
    legalEntity: 'Telecheck Health LLC',
    consumerSubdomain: 'heroshealth.com',
  },
};

function resolveHostFromMap(host: string): SubdomainTenantEntry | null {
  // Strip port if present (e.g., localhost:3000 → localhost)
  const hostname = host.split(':')[0]?.toLowerCase() ?? '';
  return SUBDOMAIN_TENANT_MAP[hostname] ?? null;
}

/**
 * Tri-state result from the DB tenant lookup so the caller can distinguish
 * "DB confirmed this tenant is inactive or unknown" (fail closed; do NOT
 * fall back to the hardcoded map) from "DB was unreachable" (fall back to
 * the map for bootstrap / dev resilience).
 *
 * (Added v0.4 patch 2026-05-02 per Codex foundation-wiring-r2 HIGH finding:
 *  the prior null-vs-throw discrimination conflated DB miss with DB error,
 *  letting a deactivated production tenant continue to resolve via the
 *  hardcoded map. The hardcoded map IS the production hot path for the
 *  day-1 tenants, so a successful DB query that returns zero rows MUST
 *  override the map with a fail-closed result.)
 */
type DbResolution =
  | { kind: 'found'; entry: SubdomainTenantEntry }
  | { kind: 'inactive_or_unknown' }
  | { kind: 'unreachable' };

/**
 * Classify an error from the `pg` library / Node.js socket layer as a
 * true DB-unreachability event vs a reachable-DB error (SQL syntax,
 * schema skew, permission denied, etc.). Only the former should trigger
 * the hardcoded map fallback; the latter MUST fail closed since it
 * indicates a deployment misconfiguration that should not silently
 * serve a stale tenant.
 *
 * Connection-class signals checked (in order of likelihood):
 *   - Node.js system errors: `code` ∈ ECONNREFUSED, ECONNRESET, ETIMEDOUT,
 *     EHOSTUNREACH, ENETUNREACH, ENOTFOUND.
 *   - PostgreSQL SQLSTATE class 08 (Connection Exception): 08000, 08003,
 *     08006, 08001, 08004, 08007.
 *   - PostgreSQL SQLSTATE class 57P01..57P03 (admin shutdown / crash
 *     shutdown / cannot connect now).
 *   - pg's "Connection terminated unexpectedly" message string (no error
 *     code surfaces but the error text is canonical).
 *
 * Anything else (42xxx undefined column, 23xxx integrity violation,
 * 28xxx invalid authorization, etc.) is treated as a reachable-DB error.
 */
function isConnectionError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;

  const e = err as {
    code?: string | undefined;
    message?: string | undefined;
  };

  const code = e.code;
  if (typeof code === 'string') {
    const NODE_CONN_CODES = new Set([
      'ECONNREFUSED',
      'ECONNRESET',
      'ETIMEDOUT',
      'EHOSTUNREACH',
      'ENETUNREACH',
      'ENOTFOUND',
      'EPIPE',
    ]);
    if (NODE_CONN_CODES.has(code)) return true;

    const PG_CONN_SQLSTATES = new Set([
      '08000', // connection_exception
      '08003', // connection_does_not_exist
      '08006', // connection_failure
      '08001', // sqlclient_unable_to_establish_sqlconnection
      '08004', // sqlserver_rejected_establishment_of_sqlconnection
      '08007', // transaction_resolution_unknown
      '57P01', // admin_shutdown
      '57P02', // crash_shutdown
      '57P03', // cannot_connect_now
    ]);
    if (PG_CONN_SQLSTATES.has(code)) return true;
  }

  const message = e.message;
  if (typeof message === 'string') {
    if (
      message.includes('Connection terminated unexpectedly') ||
      message.includes('Client has encountered a connection error') ||
      message.includes('timeout exceeded when trying to connect')
    ) {
      return true;
    }
  }

  return false;
}

/**
 * Look up a tenant by `consumer_subdomain` against the migration 001
 * `tenants` table. Returns a tri-state DbResolution.
 *
 * On DB query success with one or more rows → 'found'.
 * On DB query success with zero rows (tenant doesn't exist OR is inactive)
 *   → 'inactive_or_unknown' — the caller MUST fail closed and NOT fall
 *   back to any hardcoded map.
 * On DB query failure (connection refused, network drop, etc.) →
 *   'unreachable' — the caller MAY fall back to the hardcoded bootstrap
 *   map for resilience during DB outages or local-dev-without-DB cases.
 */
async function resolveHostFromDb(host: string): Promise<DbResolution> {
  const hostname = host.split(':')[0]?.toLowerCase() ?? '';
  if (hostname === '') return { kind: 'inactive_or_unknown' };

  let result: Awaited<ReturnType<typeof withConnection<{ rows: unknown[] }>>>;
  try {
    result = await withConnection(async (client) => {
      return client.query<{
        id: string;
        display_name: string;
        consumer_dba: string;
        legal_entity: string;
        consumer_subdomain: string;
        country_of_care: string;
        kms_key_alias: string;
        status: string;
      }>(
        // Note: NO `status = 'active'` filter here — we look up the tenant
        // unconditionally, then explicitly check status below. This way, a
        // suspended/archived tenant returns 'inactive_or_unknown' (fail
        // closed) rather than 'no row' which the legacy implementation
        // conflated with 'tenant doesn't exist at all'.
        `SELECT id, display_name, consumer_dba, legal_entity, consumer_subdomain,
                country_of_care, kms_key_alias, status
           FROM tenants
          WHERE LOWER(consumer_subdomain) = $1
          LIMIT 1`,
        [hostname],
      );
    });
  } catch (err) {
    // Discriminate true DB-unreachability (network/connection failure) from
    // reachable-DB SQL errors (schema skew, revoked permission, undefined
    // column, etc.). The latter MUST fail closed — they indicate a
    // misconfigured deployment that should never silently serve a stale
    // hardcoded tenant.
    //
    // (Tightened v0.5 patch 2026-05-02 per Codex foundation-wiring-r3 HIGH
    //  finding closure: prior catch-all classified every error as
    //  'unreachable', so a reachable DB with a SQL error could trigger
    //  the hardcoded-map fallback and serve an inactive day-1 tenant.)
    if (isConnectionError(err)) {
      return { kind: 'unreachable' };
    }
    // Reachable DB returned a SQL/schema/permission error. Fail closed.
    // Re-throw so the caller's hook surfaces 500 with a structured log
    // entry. The pool error handler in db.ts also logs at this layer.
    throw err;
  }

  if (result.rows.length === 0) return { kind: 'inactive_or_unknown' };
  const row = result.rows[0] as
    | {
        id: string;
        display_name: string;
        consumer_dba: string;
        legal_entity: string;
        consumer_subdomain: string;
        country_of_care: string;
        kms_key_alias: string;
        status: string;
      }
    | undefined;
  if (row === undefined) return { kind: 'inactive_or_unknown' };

  // Explicit status check (the SQL deliberately does NOT filter so we can
  // distinguish "tenant doesn't exist" from "tenant is suspended/archived"
  // — both fail closed, but the future audit-trail logging may want to
  // surface the distinction).
  if (row.status !== 'active') return { kind: 'inactive_or_unknown' };

  if (row.country_of_care !== 'US' && row.country_of_care !== 'GH') {
    // Defensive: the DB CHECK constraint should already enforce this set,
    // but if the constraint is widened in a future migration without
    // updating this discriminated union, the request must fail closed.
    throw new Error(
      `tenant-context: unsupported country_of_care '${row.country_of_care}' ` +
        `for tenant '${row.id}'. Update the SubdomainTenantEntry union when ` +
        `adding new countries.`,
    );
  }

  return {
    kind: 'found',
    entry: {
      tenantId: row.id,
      displayName: row.display_name,
      countryOfCare: row.country_of_care,
      kmsKeyAlias: row.kms_key_alias,
      consumerDba: row.consumer_dba,
      legalEntity: row.legal_entity,
      consumerSubdomain: row.consumer_subdomain,
    },
  };
}

/**
 * Two-tier resolver with DB as the AUTHORITATIVE status check + the
 * hardcoded SUBDOMAIN_TENANT_MAP as a bootstrap-only fallback:
 *
 *   - DB query 'found' → return the DB entry (authoritative; status =
 *     'active' confirmed).
 *   - DB query 'inactive_or_unknown' → return null (FAIL CLOSED — do NOT
 *     fall back to the map; a tenant deactivated in the DB MUST stop
 *     resolving even if it appears in the hardcoded map).
 *   - DB query 'unreachable' → fall back to the map for bootstrap +
 *     local-dev-without-DB resilience. Returns null if the map also
 *     misses; the caller (the Fastify hook) returns 400 — fail closed
 *     per I-023.
 *
 * (Tightened v0.4 patch 2026-05-02 per Codex foundation-wiring-r2 HIGH
 *  finding closure: the prior null-on-zero-rows path let the hardcoded
 *  map override DB deactivation for the day-1 hosts.)
 */
async function resolveHostToTenant(host: string): Promise<SubdomainTenantEntry | null> {
  const dbResult = await resolveHostFromDb(host);
  switch (dbResult.kind) {
    case 'found':
      return dbResult.entry;
    case 'inactive_or_unknown':
      // Production: fail closed — the DB is authoritative, and a host that
      // doesn't appear in `tenants.consumer_subdomain` (with status='active')
      // MUST NOT silently resolve via the hardcoded bootstrap map. This
      // preserves the Codex foundation-wiring-r2 HIGH closure: a
      // deactivated production tenant cannot be re-activated by the map.
      //
      // Non-production (test / development): the SUBDOMAIN_TENANT_MAP
      // intentionally contains DEV-ONLY aliases (e.g., 'localhost', the
      // www-prefix variant) that are NOT real production subdomains and
      // therefore are NOT seeded into `tenants.consumer_subdomain`. Falling
      // back to the map here lets HTTP test fixtures using `host: 'localhost'`
      // resolve to Telecheck-US without forcing every test to use the
      // production-hostname `heroshealth.com`. This is bounded: the map
      // is a fixed compile-time set of aliases; it cannot be widened by
      // a misconfigured deployment, and the production branch above
      // guarantees this fallback NEVER fires in production. (Codex
      // tenant-mapping-r0 closure 2026-05-04 — restores test ergonomics
      // without weakening production fail-closed.)
      if (process.env['NODE_ENV'] === 'production') {
        return null;
      }
      return resolveHostFromMap(host);
    case 'unreachable':
      // Bootstrap fallback ONLY in non-production environments (covers
      // local dev without DB and brief connection blips during dev/test
      // bootstrap). In production, a 'unreachable' DB MUST fail closed —
      // serving the hardcoded map could mask a deployment-breaking
      // outage and let stale tenant config persist.
      // (Tightened v0.5 patch 2026-05-02 per Codex foundation-wiring-r3
      //  HIGH finding closure: prior code allowed map fallback in any
      //  environment, including production.)
      if (process.env['NODE_ENV'] === 'production') {
        return null;
      }
      return resolveHostFromMap(host);
  }
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
  const allowlist = new Set<string>(['/health', ...(opts.allowlistedPaths ?? [])]);

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

    const entry = await resolveHostToTenant(host);
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

    // Populate the decorator with the full CDM §4.1 field set.
    const ctx: TenantContext = {
      tenantId,
      displayName: entry.displayName,
      countryOfCare: entry.countryOfCare,
      kmsKeyAlias: entry.kmsKeyAlias,
      consumerDba: entry.consumerDba,
      legalEntity: entry.legalEntity,
      consumerSubdomain: entry.consumerSubdomain,
    };

    // Fastify decorateRequest sets up the slot at registration time; the
    // request type is extended via module augmentation declared elsewhere
    // in this file (search for `declare module 'fastify'`).
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
