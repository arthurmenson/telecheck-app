/**
 * Telecheck Fastify app factory.
 *
 * This module exports `buildApp()` which constructs and configures a Fastify
 * instance WITHOUT binding to a port. Tests import this directly.
 * `src/server.ts` imports this and binds to the configured port.
 *
 * SCAFFOLD STATUS: bootstrap only — middleware (tenant context, audit envelope,
 * idempotency, error envelope) will be added by the appsec-expert agent in the
 * foundation layer commit. No real route handlers exist yet beyond /health.
 *
 * Spec references:
 * - System Architecture v1.2 (modular monolith; module boundary enforcement)
 * - ADR-023 multi-tenancy (RLS + app-layer + per-tenant KMS three-layer enforcement)
 * - ADR-024 country-driven config (CCR resolution at request time)
 * - Tenant Threading Addendum v1.0 (request-time tenant context resolution)
 * - Contracts Pack v5.2 ERROR_MODEL (preserved at v5.1; tenant-blind error envelopes per I-025)
 */

import fastifyHelmet from '@fastify/helmet';
import fastifySensible from '@fastify/sensible';
import Fastify, { type FastifyInstance } from 'fastify';

export interface AppOptions {
  /**
   * Logger configuration. Tests pass `false` to silence; dev/prod use
   * pino with PHI-redacting paths from LOG_REDACT_PATHS env.
   */
  logger?: boolean | object;
}

export async function buildApp(opts: AppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: opts.logger ?? defaultLoggerConfig(),
    // Per I-025 (tenant-blind error responses): suppress framework error
    // detail leakage. Custom error envelope middleware (foundation layer)
    // will replace Fastify's default error serialization with the canonical
    // ERROR_MODEL envelope.
    disableRequestLogging: false,
    // Generate request IDs for trace correlation across audit chain.
    genReqId: () => crypto.randomUUID(),
    // Reject invalid Content-Type early.
    bodyLimit: 1_048_576, // 1 MiB; per-route overrides where needed
  });

  // Security headers
  await app.register(fastifyHelmet, {
    // Production deployments tighten these per OWASP + ADR-022
    contentSecurityPolicy: false, // TODO: configure per surface (admin / patient / clinician)
  });

  // Idiomatic error helpers (sensible 404, etc.)
  await app.register(fastifySensible);

  // ----------------------------------------------------------
  // Foundation middleware (placeholders — appsec-expert agent fills in)
  // ----------------------------------------------------------
  //
  // - Tenant context resolution (per ADR-023 + ADR-024 + Tenant Threading Addendum)
  //   Resolves req.tenantContext = { tenantId, countryOfCare, kmsKeyAlias, ... }
  //   from request (subdomain / JWT / header) and exposes via fastify decorator.
  //
  // - Audit envelope emitter (per AUDIT_EVENTS v5.2 + I-027)
  //   Wraps every state-changing handler; emits envelope with tenant_id,
  //   ai_workload_type (if applicable), autonomy_level (if applicable),
  //   per the I-012 envelope-population rule.
  //
  // - Idempotency middleware (per IDEMPOTENCY contract v5.1)
  //   Tenant-scoped idempotency keys; replays cached response for retried requests.
  //
  // - Error envelope (per ERROR_MODEL v5.1)
  //   Tenant-blind error responses; resource-not-found does not leak cross-tenant
  //   existence per I-025.
  //
  // - I-029 6-condition gate enforcement helper (research data export pipeline)
  //   Reject-unless evaluator emitting research.export_completed(status=invalidated)
  //   with canonical 6-value invalidation_reason enum on failure.
  //
  // - I-012 reject-unless three-clause rule (prescribing/refill/medication-order)
  //   Validator emitting <action_class>.execution_rejected on rejection.

  // ----------------------------------------------------------
  // Module registration (placeholder)
  // ----------------------------------------------------------
  //
  // Modules per System Architecture v1.2 §13. Each module registers its routes
  // via app.register(moduleNamePlugin, { prefix: '/<module>' }).
  // No modules registered yet — this is the bootstrap commit.

  // ----------------------------------------------------------
  // Health endpoint (only real route at bootstrap)
  // ----------------------------------------------------------
  app.get('/health', async () => {
    return {
      status: 'ok',
      service: 'telecheck-app',
      version: process.env['npm_package_version'] ?? '0.0.1',
      // Tenant-blind health endpoint — deliberately no tenant context exposed.
      // Per-tenant readiness checks are scoped to authenticated admin endpoints.
      timestamp: new Date().toISOString(),
    };
  });

  return app;
}

function defaultLoggerConfig(): object {
  const redactPaths = (process.env['LOG_REDACT_PATHS'] ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  return {
    level: process.env['LOG_LEVEL'] ?? 'info',
    redact: {
      // Per AUDIT_EVENTS v5.2 PHI redaction discipline: never log
      // authorization headers, passwords, tokens, or PHI fields.
      paths: redactPaths.length > 0 ? redactPaths : ['req.headers.authorization'],
      remove: true,
    },
    // Pretty print in dev only; production emits structured JSON for ingestion
    // by the audit + observability pipeline.
    transport:
      process.env['NODE_ENV'] === 'development'
        ? {
            target: 'pino-pretty',
            options: {
              translateTime: 'HH:MM:ss',
              ignore: 'pid,hostname',
            },
          }
        : undefined,
  };
}
