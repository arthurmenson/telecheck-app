/**
 * routes.test.ts — unit tests for the AI Service route registrar,
 * specifically the Mode 2 case-prep route-mount gate (Codex PR #210
 * R1 NEEDS-WORK closure 2026-05-24).
 *
 * **Scope:** verify the `AI_MODE2_ENABLED` config flag actually gates
 * route registration at `registerAIServiceRoutes` time. Two paths
 * exercised:
 *
 *   §M1 — Default-OFF: `config.aiMode2Enabled === false` keeps the
 *         route DEFINED but NOT mounted; the Fastify router has no
 *         entry for POST /v0/ai/case-prep, so a request returns 404.
 *         /v0/ai/health + /v0/ai/ready report `mode2_case_prep_mounted:
 *         false`.
 *
 *   §M2 — Flag-ON: `config.aiMode2Enabled === true` mounts the route.
 *         /v0/ai/health + /v0/ai/ready report `mode2_case_prep_mounted:
 *         true`. The handler itself is still gated by the existing
 *         auth + crisis + audit lifecycle — flipping the flag does NOT
 *         relax any of those (the stub provider STILL surfaces the
 *         documented AI-RESIL-001 fail-soft envelope per Codex PR #210
 *         R2 validation requirement).
 *
 * **Why unit-isolated (not via `buildApp`):** `config` is loaded as a
 * singleton at module-load time from `src/lib/config.ts`, so changing
 * `process.env` after the test module is imported does NOT flip the
 * flag. Per-test mounting via `vi.doMock` + dynamic import of the
 * route registrar lets us instantiate two Fastify apps with the flag
 * resolved to different values inside the same test run — without the
 * heavyweight `buildApp` setup that requires Postgres + migrations +
 * the global tenant-context plugin.
 *
 * Spec references:
 *   - Codex PR #210 R1 NEEDS-WORK (2026-05-24): clinical-anchor
 *     authorization + real protocol/provider execution NOT implemented;
 *     route gated behind non-production flag until Day-3+ wiring lands.
 *   - C1 cockpit precedent (honest-failure-until-wiring pattern).
 *   - AI_LAYERING v5.2 §2 (Mode 2 protocol_execution architecture).
 *   - ADR-029 (workload taxonomy).
 *   - State Machines v1.2 §19 §19.X (I-012 reject-unless at downstream
 *     prescribing boundary — case-prep is the audit anchor only).
 */

import fastifySensible from '@fastify/sensible';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Hoisted mocks for the case-prep handler dependencies. None of these
// are exercised in §M1 (the handler is never reached) but they MUST be
// importable for the registrar to load when the flag is on (§M2).
vi.mock('../../lib/auth-context.js', () => ({
  requireActorContext: vi.fn(() => {
    throw new Error('not used in route-mount-gate tests');
  }),
}));

vi.mock('../../lib/tenant-context.js', () => ({
  requireTenantContext: vi.fn(() => {
    throw new Error('not used in route-mount-gate tests');
  }),
}));

vi.mock('../../lib/idempotent-handler.js', () => ({
  withIdempotentExecution: vi.fn(),
}));

vi.mock('../../lib/idempotency.js', () => ({
  buildIdempotencyCtx: vi.fn(),
}));

vi.mock('./internal/crisis/gate.js', () => ({
  runCrisisGate: vi.fn(),
}));

vi.mock('./internal/providers/null-provider.js', () => ({
  NullLLMProvider: class {
    readonly name = 'null' as const;
    // eslint-disable-next-line @typescript-eslint/require-await
    async sendCompletion(): Promise<never> {
      throw new Error('not used in route-mount-gate tests');
    }
    // eslint-disable-next-line @typescript-eslint/require-await
    async healthcheck(): Promise<{ healthy: boolean }> {
      return { healthy: false };
    }
  },
}));

vi.mock('./audit.js', () => ({
  emitMode2CasePrepResponseAudit: vi.fn(),
}));

vi.mock('../../lib/glossary.js', () => ({
  asTenantId: (s: string) => s,
}));

// Stub the chat handler so the registrar can wire it up without
// pulling in its real dependency surface (Mode 1 is out-of-scope here).
vi.mock('./internal/handlers/chat.js', () => ({
  mode1ChatHandler: async () => ({}),
}));

// ---------------------------------------------------------------------------
// Test harness — build a minimal Fastify app with the AI Service routes
// registered under a per-test config flag value.
// ---------------------------------------------------------------------------

async function buildAppWithFlag(flagValue: boolean): Promise<FastifyInstance> {
  // Reset modules so the `config` singleton + the registrar see the
  // freshly-mocked flag on dynamic import. `vi.doMock` is dynamic-mock
  // form — registers the mock before the module is required.
  vi.resetModules();

  vi.doMock('../../lib/config.js', () => ({
    config: {
      aiMode2Enabled: flagValue,
    },
  }));

  const { registerAIServiceRoutes } = await import('./routes.js');

  const app = Fastify({ logger: false });
  await app.register(fastifySensible);
  await app.register(registerAIServiceRoutes, { prefix: '/v0/ai' });
  await app.ready();
  return app;
}

let app: FastifyInstance | null = null;

afterEach(async () => {
  if (app !== null) {
    await app.close();
    app = null;
  }
  vi.doUnmock('../../lib/config.js');
});

// ===========================================================================
// §M1 — Default-OFF: route is DEFINED but NOT mounted; Fastify returns 404.
// ===========================================================================

describe('AI Service routes — §M1 Mode 2 case-prep mount gate (OFF)', () => {
  beforeEach(async () => {
    app = await buildAppWithFlag(false);
  });

  it('POST /v0/ai/case-prep returns 404 when AI_MODE2_ENABLED=false', async () => {
    const r = await app!.inject({
      method: 'POST',
      url: '/v0/ai/case-prep',
      payload: { consult_id: 'cons_test', protocol_id: 'p_test' },
    });
    expect(r.statusCode).toBe(404);
  });

  it('/health honestly reports mode2_case_prep_mounted=false', async () => {
    const r = await app!.inject({ method: 'GET', url: '/v0/ai/health' });
    expect(r.statusCode).toBe(200);
    const body = r.json<{
      mode2_case_prep_mounted: boolean;
      mode2_case_prep_mount_gate: string;
      mode2_case_prep_day3_prerequisites: string[];
    }>();
    expect(body.mode2_case_prep_mounted).toBe(false);
    expect(body.mode2_case_prep_mount_gate).toBe('AI_MODE2_ENABLED');
    expect(body.mode2_case_prep_day3_prerequisites).toHaveLength(3);
    expect(body.mode2_case_prep_day3_prerequisites[0]).toContain('clinical_anchor_authorization');
    expect(body.mode2_case_prep_day3_prerequisites[1]).toContain('real_protocol_provider_execution');
    expect(body.mode2_case_prep_day3_prerequisites[2]).toContain(
      'verified_audit_emission_discipline',
    );
  });

  it('/ready honestly reports mode2_case_prep_mounted=false + AI_MODE2_ENABLED gate', async () => {
    const r = await app!.inject({ method: 'GET', url: '/v0/ai/ready' });
    expect(r.statusCode).toBe(503);
    const body = r.json<{
      mode2_case_prep_mounted: boolean;
      mode2_case_prep_mount_gate: string;
      pending: string;
    }>();
    expect(body.mode2_case_prep_mounted).toBe(false);
    expect(body.mode2_case_prep_mount_gate).toBe('AI_MODE2_ENABLED');
    expect(body.pending).toContain('AI_MODE2_ENABLED');
  });
});

// ===========================================================================
// §M2 — Flag-ON: route is mounted; /health + /ready report true.
// ===========================================================================

describe('AI Service routes — §M2 Mode 2 case-prep mount gate (ON)', () => {
  beforeEach(async () => {
    app = await buildAppWithFlag(true);
  });

  it('POST /v0/ai/case-prep is mounted when AI_MODE2_ENABLED=true (no 404 route-miss)', async () => {
    // The handler itself throws at requireTenantContext (stubbed to
    // throw above), so we expect a 500 from Fastify's default error
    // path — crucially NOT a 404. The presence of the route in the
    // router is what we're verifying; the handler's lifecycle is
    // covered by `case-prep.test.ts`.
    //
    // (In real production with the flag flipped, the handler reaches
    // requireTenantContext via the global tenantContextPlugin, then
    // requireActorContext for JWT-role gating, then crisis gate, then
    // the stub NullLLMProvider — which still surfaces the documented
    // AI-RESIL-001 fail-soft envelope. Codex PR #210 R2 validates that
    // honest-failure path remains intact when the flag is on.)
    const r = await app!.inject({
      method: 'POST',
      url: '/v0/ai/case-prep',
      payload: { consult_id: 'cons_test', protocol_id: 'p_test' },
    });
    expect(r.statusCode).not.toBe(404);
  });

  it('/health honestly reports mode2_case_prep_mounted=true when the flag is on', async () => {
    const r = await app!.inject({ method: 'GET', url: '/v0/ai/health' });
    expect(r.statusCode).toBe(200);
    const body = r.json<{ mode2_case_prep_mounted: boolean }>();
    expect(body.mode2_case_prep_mounted).toBe(true);
  });

  it('/ready honestly reports mode2_case_prep_mounted=true when the flag is on', async () => {
    const r = await app!.inject({ method: 'GET', url: '/v0/ai/ready' });
    expect(r.statusCode).toBe(503);
    const body = r.json<{ mode2_case_prep_mounted: boolean }>();
    expect(body.mode2_case_prep_mounted).toBe(true);
  });
});
