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
import { authContextPlugin } from './lib/auth-context.js';
import { verifyBindActorContextPoolOrThrow } from './lib/db.js';
import { errorEnvelopePlugin } from './lib/error-envelope.js';
import { idempotencyPlugin } from './lib/idempotency.js';
import { tenantContextPlugin } from './lib/tenant-context.js';
import { adminBackendPlugin } from './modules/admin-backend/index.js';
import { aiServicePlugin } from './modules/ai-service/index.js';
import { asyncConsultPlugin } from './modules/async-consult/index.js';
import { consentPlugin } from './modules/consent/plugin.js';
import { crisisResponsePlugin } from './modules/crisis-response/index.js';
import { formsIntakePlugin } from './modules/forms-intake/index.js';
import {
  assertNoPublishGateBypassAtBoot,
  checkPublishGateBypassAtRuntime,
  isPublishRouteUrl,
} from './modules/forms-intake/internal/services/publish-gates-killswitch.js';
import { identityPlugin } from './modules/identity/plugin.js';
import { medInteractionPlugin } from './modules/med-interaction/index.js';
import { pharmacyPlugin } from './modules/pharmacy/plugin.js';
import { subscriptionPlugin } from './modules/subscription/index.js';
import { tenantConfigPlugin } from './modules/tenant-config/plugin.js';

export interface AppOptions {
  /**
   * Logger configuration. Tests pass `false` to silence; dev/prod use
   * pino with PHI-redacting paths from LOG_REDACT_PATHS env.
   */
  logger?: boolean | object;
}

export async function buildApp(opts: AppOptions = {}): Promise<FastifyInstance> {
  // SI-011 publish-gates bypass kill-switch (defense-in-depth layer 1).
  //
  // BEFORE any Fastify instance is constructed, scan the process env for
  // any FORMS_PUBLISH_GATES_BYPASS or FORMS_PUBLISH_GATES_TEST_OVERRIDE_*
  // env var presence in NODE_ENV !== 'test'. If detected, throw a
  // canonical sentinel error — the Fastify instance is never built,
  // the HTTP listener never binds, the process exits non-zero. Every
  // bypass attempt is therefore visible in boot logs (canonical code
  // `forms.publish.bypass_in_production`) before any request is served.
  //
  // SI-011 §"Production environment guard (kill-switch)" specifies this
  // as layer 1 of four; layer 2 is the runtime check inside
  // publishVersion() (see template-service.ts).
  assertNoPublishGateBypassAtBoot(process.env);

  // SI-010 bind-pool startup probe (Codex R2 closure 2026-05-15).
  //
  // BEFORE Fastify accepts traffic, verify the bind pool is reachable,
  // the connection authenticates as a role that is NOT
  // telecheck_app_role, and that role has EXECUTE on bind_actor_context().
  // Catches misconfigurations (wrong password, unreachable host, wrong
  // role, missing GRANT, missing migration 031) at boot rather than
  // letting the listener bind and then failing every authenticated
  // request silently.
  //
  // When config.bindActorContextDatabaseUrl is undefined (dev/test
  // opt-in), the probe is a no-op. Production fail-fast on missing
  // URL is enforced at loadConfig() time.
  await verifyBindActorContextPoolOrThrow();

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
    // Fastify's default `maxParamLength` (100) is too small for resume
    // tokens carried in `:resumeToken` path params. Resume tokens are
    // HMAC-signed `<base64url(payload)>.<base64url(signature)>` strings
    // — typical length 115+ chars. With the default 100-char ceiling,
    // any URL like `/v0/forms/resume/<long-token>` silently 404s before
    // reaching the handler, surfacing as `internal.resource.not_found`
    // from setNotFoundHandler. Raise to 512 — comfortably accommodates
    // the resume token plus any future signed-URL params per
    // forms-intake-resume-r0 closure 2026-05-04 (forensically isolated
    // via local Fastify reproduction: token at 100 chars matches, 101+
    // 404s).
    routerOptions: { maxParamLength: 512 },
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

  // 3.5. SI-011 kill-switch layer 2a (early request guard).
  //
  // Fires on EVERY request, BEFORE the tenant-context plugin's onRequest
  // hook (which performs a tenant-resolution DB lookup). If the request
  // URL matches the forms publish route AND a forbidden
  // FORMS_PUBLISH_GATES_BYPASS or FORMS_PUBLISH_GATES_TEST_OVERRIDE_*
  // env var is present in NODE_ENV !== 'test', reject with 503 BEFORE
  // any DB read happens (no tenant resolution, no idempotency reservation,
  // no publish-related write).
  //
  // The early hook intentionally does NOT emit a Category B audit at this
  // layer — audit emission requires a resolved tenant context (per I-027)
  // which requires the tenant-context DB lookup that this hook is
  // designed to short-circuit. Instead, this layer emits a structured
  // error-level log carrying the forensic detail (forbidden var names,
  // observed NODE_ENV, request URL); SIEM shipping turns the log into
  // immutable forensic record. The layer-2b runtime check inside the
  // publish handler emits the Cat B audit when reached (which happens in
  // the test/dev scenarios where NODE_ENV=test allows the bypass, OR if
  // this hook is somehow bypassed and the request reaches the handler).
  //
  // Why scoped to publish-route URL match (not every request): the
  // bypass env vars only AFFECT the publish path. Rejecting unrelated
  // routes (e.g., /v0/forms/templates GET, /v0/identity/health) would
  // be over-broad. The boot-hook already prevents the process from
  // serving ANY request when a bypass var is present at startup;
  // layer-2a covers the post-boot injection case scoped to the only
  // route whose semantics the bypass alters.
  app.addHook('onRequest', async (req) => {
    if (!isPublishRouteUrl(req.url)) {
      return;
    }
    const result = checkPublishGateBypassAtRuntime(process.env);
    if (result.mode === 'forbidden') {
      req.log.error(
        {
          forbidden_vars: result.forbiddenVars,
          node_env_observed: result.nodeEnv ?? null,
          url: req.url,
          layer: 'forms_publish_killswitch_layer_2a_pre_tenant_context',
        },
        'forms.publish.bypass_attempt_in_production',
      );
      // Throw via Fastify httpErrors so errorEnvelopePlugin serializes
      // the response per the canonical ERROR_MODEL v5.1 envelope (with
      // trace_id, timestamp, retry_after for 503). This keeps the
      // bypass-attempt response wire-compatible with every other 503
      // on the platform — operators + SIEM can rely on the canonical
      // envelope shape even on the forensic tripwire path.
      throw req.server.httpErrors.serviceUnavailable(
        'Form template publishing is not yet enabled in this environment.',
      );
    }
  });

  // 4. Tenant context resolution — fail-closed per I-023
  //    /health is always allowlisted (tenant-blind endpoint)
  await app.register(tenantContextPlugin, {
    allowlistedPaths: [
      // Extend here when new tenant-blind routes are added.
      // /health is automatically allowlisted by the plugin.
      '/v0/identity/health',
      '/v0/consent/health',
      '/v0/tenant-config/health',
      '/v0/pharmacy/health',
      '/v0/pharmacy/ready',
      '/v0/med-interaction/health',
      '/v0/med-interaction/ready',
      '/v0/subscription/health',
      '/v0/subscription/ready',
      '/v0/async-consult/health',
      '/v0/async-consult/ready',
      '/v0/crisis-events/health',
      '/v0/crisis-events/ready',
      '/v0/admin-backend/health',
      '/v0/admin-backend/ready',
      '/v0/admin/ready',
      '/v0/ai/health',
      '/v0/ai/ready',
    ],
  });

  // 5. Auth context — JWT verification populates req.actorContext when
  //    a valid Bearer token is present. Fail-soft: missing / invalid
  //    token leaves actorContext undefined (handlers that require auth
  //    use requireActorContext() to enforce). Replaces the pre-auth
  //    x-actor-id / x-patient-id header stubs gated by
  //    ALLOW_ACTOR_HEADER_AUTH.
  await app.register(authContextPlugin);

  // 6. Idempotency — tenant-scoped per IDEMPOTENCY v5.1
  await app.register(idempotencyPlugin);

  // 7. AI context decorator — opt-in per route handler
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

  // Identity & Auth Slice — routes mounted under /v0/identity.
  // Currently registers only a module health probe (/v0/identity/health).
  // Full registration / login / session / device routes land in
  // subsequent commits.
  await app.register(identityPlugin);

  // Consent & Delegated Access Slice — routes mounted under /v0/consent.
  // Currently registers only a module health probe (/v0/consent/health).
  // Full consent grant/revoke + delegation invite/accept/revoke + scope
  // routes land in subsequent commits.
  await app.register(consentPlugin);

  // Tenant Config — routes mounted under /v0/tenant-config.
  // Provides /me endpoint for patient-app bootstrap (brand + country
  // profile snapshot). The CCR resolver service is the canonical CCR-key
  // lookup surface for cross-module consumers — see
  // src/modules/tenant-config/index.ts.
  await app.register(tenantConfigPlugin);

  // Pharmacy + Refill Slice — routes mounted under /v0/pharmacy.
  // SKELETON ONLY at v0.1: only /health is mounted; full implementation
  // (POST /prescriptions, POST /refills, etc.) is BLOCKED on SI-001
  // (MedicationRequest schema gap in CDM v1.2). See
  // docs/SI-001-MedicationRequest-Schema-Gap.md for the resume path.
  await app.register(pharmacyPlugin);

  // Med Interaction Engine — routes mounted under /v0/med-interaction.
  // SKELETON ONLY at v0.1: only /health (200) + /ready (503) are mounted;
  // full implementation (POST /signals/check, override workflow, ruleset
  // resolver, vendor adapter abstraction) is BLOCKED on Med Interaction
  // Engine slice PRD ratification. See src/modules/med-interaction/README.md.
  // Platform-floor hard rule: the interaction engine runs BEFORE clinician
  // commits a prescription (Master PRD v1.10 §7).
  await app.register(medInteractionPlugin);

  // AI Service Slice — routes mounted under /v0/ai.
  // SCAFFOLD ONLY at PR A: only /health (200) + /ready (503) are
  // mounted. Subsequent PRs land:
  //   - PR B: Mode 1 /chat stub (conversational_assistant workload)
  //   - PR C: Mode 2 /case-prep stub (protocol_execution workload)
  //   - PR D: real Anthropic provider integration (ADR-020
  //     multi-provider abstraction; Bedrock + Azure OpenAI resilience)
  //   - PR E: guardrail-template repo + Conservative Default
  //     enforcement (AI-GUARD-001..005)
  //   - PR F: crisis-detection scaffold (FLOOR-009 / I-019; runs
  //     independent of guardrails per FLOOR-013)
  // Per AI_LAYERING v5.2 §10 supersession scope statement, v1.0 admits
  // exactly two active workload types (conversational_assistant +
  // protocol_execution); reserved types require successor ADR +
  // activation audit event per ADR-029.
  await app.register(aiServicePlugin);

  // Subscription — routes mounted under /v0/subscription.
  // SKELETON ONLY at v0.1: only /health (200) + /ready (503) are mounted;
  // full implementation (POST /subscriptions, PATCH .../pause|resume|cancel|switch
  // + state machine + Pharmacy + Payment adapter wiring) is BLOCKED on
  // SI-001 (MedicationRequest schema gap — Subscription binds via
  // medication_request_id). See src/modules/subscription/README.md.
  await app.register(subscriptionPlugin);

  // Async Consult — routes mounted under /v0/async-consult.
  // SKELETON at v0.1 (Sprint 8 / TLC-020): only /health (200) + /ready (503)
  // are mounted. Sprint 1 of 3 for this slice — Sprint 9 adds repos /
  // service layer / state machine + initial HTTP handlers; Sprint 10 adds
  // full integration + audit + domain event emitters. See
  // src/modules/async-consult/README.md for the multi-sprint sequencing.
  await app.register(asyncConsultPlugin);

  // Crisis Response Slice (SI-022) — routes mounted under /v0/crisis-events.
  // DB layer COMPLETE through migration 038 (6 tables + 2 views + 6 SECDEF
  // procedures + 15 RBAC roles + 18 rounds of Codex APPROVE). Sprint 1
  // (this commit) registers /health (200) + /ready (503) so app-level
  // wiring works; Sprint 2+ adds initiate/acknowledge/respond/resolve/sweep
  // handlers + Cat A audit emission + KMS envelope for intake_payload. See
  // src/modules/crisis-response/README.md +
  // docs/crisis-response-implementation-plan.md for the multi-sprint plan.
  await app.register(crisisResponsePlugin);

  // ----------------------------------------------------------
  // Admin Backend Basics module (SI-023 v1.0 + CDM v1.10 → v1.11
  // Amendment; ratified P-041 + P-042). DB layer COMPLETE through
  // migration 044 (4 tables + 2 views + 4 SECDEF procedures + 12 RBAC
  // roles + 14 rounds of Codex APPROVE across PRs 1-5). Sprint 1
  // (this commit) registers /health (200) + /ready (503) so app-level
  // wiring works; Sprint 2+ adds 5 endpoints (3 dashboard reads + 2
  // template wrappers) + Cat A audit emission + LAYER B role-membership
  // check. See src/modules/admin-backend/README.md for the multi-sprint
  // plan + Option 2 carryforward divergences from spec.
  // ----------------------------------------------------------
  await app.register(adminBackendPlugin);

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
