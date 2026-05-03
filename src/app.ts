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

import { aiContextPlugin } from './lib/ai-context.js';
import { errorEnvelopePlugin } from './lib/error-envelope.js';
import { idempotencyPlugin } from './lib/idempotency.js';
import { tenantContextPlugin } from './lib/tenant-context.js';
import { formsIntakePlugin } from './modules/forms-intake/index.js';

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
  // Foundation middleware (registered in order per security discipline)
  // ----------------------------------------------------------
  //
  // Registration order is load-bearing:
  //   1. helmet         — security headers (already registered above)
  //   2. sensible       — idiomatic error helpers (already registered above)
  //   3. errorEnvelope  — must run before ANY route so all errors use the
  //                       canonical I-025 tenant-blind envelope.
  //   4. tenantContext  — must run before any tenant-scoped route handler.
  //                       Fail-closed (I-023): requests with unresolvable
  //                       tenant are rejected before reaching route handlers.
  //   5. idempotency    — runs after tenantContext (needs tenantId for the
  //                       tenant-scoped cache key per IDEMPOTENCY v5.1).
  //   6. aiContext      — provides req.aiContext decorator for AI routes;
  //                       populated on-demand per route (opt-in).
  //
  // Audit emission (audit.ts / emitAudit) is called by individual route handlers
  // and gate functions — not registered as a plugin here.
  // Crisis detection (crisis-detection.ts / crisisDetector) is called inline
  // in chat/community/forms handlers — platform-floor, always-on per I-019.
  // RLS (rls.ts / withTenantContext) is called in data-access functions per I-023.

  // 3. Error envelope — tenant-blind per I-025 + ERROR_MODEL v5.1
  await app.register(errorEnvelopePlugin);

  // 4. Tenant context resolution — fail-closed per I-023
  //    /health is always allowlisted (tenant-blind endpoint)
  await app.register(tenantContextPlugin, {
    allowlistedPaths: [
      // Extend here when new tenant-blind routes are added.
      // /health is automatically allowlisted by the plugin.
    ],
  });

  // 5. Idempotency — tenant-scoped per IDEMPOTENCY v5.1
  await app.register(idempotencyPlugin);

  // 6. AI context decorator — opt-in per route handler
  await app.register(aiContextPlugin);

  // ----------------------------------------------------------
  // Module registration
  // ----------------------------------------------------------
  //
  // Modules per System Architecture v1.2 §13. Each module registers its routes
  // via its own Fastify plugin. Registration order matters when modules
  // subscribe to each other's domain events — producers register before
  // consumers. The forms-intake module is the foundational v1.0 slice (per
  // EHBG §10b sprint plan); subsequent slices register after it.

  // Forms / Intake Engine Slice PRD v2.1 — routes mounted under /v0/forms.
  await app.register(formsIntakePlugin);

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
