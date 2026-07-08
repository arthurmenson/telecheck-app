/**
 * async-consult slice — plugin wiring smoke test.
 *
 * Sprint 8 / TLC-020 (Async Consult slice skeleton — Sprint 1 of 3
 * for this slice).
 *
 * The full Async Consult slice is sequenced across Sprints 8-10:
 *   - Sprint 8 (THIS): module skeleton + plugin shell + branded IDs
 *     + state vocabulary + this smoke test
 *   - Sprint 9: repos + service layer + state-machine transition
 *     logic + initial HTTP handlers
 *   - Sprint 10: full HTTP integration + audit + domain event
 *     emitters + cross-tenant isolation tests
 *
 * At v0.1 we ship the directory + plugin shell so that:
 *   1. The module boundary (per ADR-001) is established now
 *   2. App-level wiring (`src/app.ts`) is stable across sprints
 *   3. Cross-module callers can typed-import branded ID types +
 *      state vocabulary ahead of full implementation
 *      (Pharmacy + Refill, RPM/CCM, Adverse Events, Messaging,
 *      Payment all reference Consult types per PRD §15)
 *
 * This test asserts the only currently-mounted routes return the
 * documented SKELETON state (with the readiness/liveness split applied
 * per Sprint 1 Codex MEDIUM finding `pharmacy-blocked-handler` —
 * 4th application of the standing rule).
 *
 * Spec references:
 *   - Async Consult Slice PRD v1.0
 *   - State Machines v1.1 §3
 *   - src/modules/async-consult/README.md
 *   - ADR-001 (modular monolith)
 */

import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../../src/app.ts';

let app: FastifyInstance | null = null;

beforeAll(async () => {
  process.env['NODE_ENV'] = 'test';
  app = await buildApp({ logger: false });
  await app.ready();
});

afterAll(async () => {
  if (app !== null) {
    await app.close();
  }
});

describe('async-consult slice — §1 plugin wiring', () => {
  it('§1a GET /v0/async-consult/health returns 200 (liveness — module alive) with Sprint 10 dual-surface metadata', async () => {
    const r = await app!.inject({
      method: 'GET',
      url: '/v0/async-consult/health',
      headers: { host: 'localhost' },
    });
    expect(r.statusCode).toBe(200);
    const body = r.json<{
      status: string;
      module: string;
      blocked: string;
      blocked_message: string;
    }>();
    expect(body.status).toBe('ok');
    expect(body.module).toBe('async-consult');
    // Post-/ready-flip: blocked is null (no build-gated blocker); the
    // message documents the dual surface incl. the v1 endpoint set.
    expect(body.blocked).toBeNull();
    expect(body.blocked_message).toContain('/v1/async-consults');
    expect(body.blocked_message).toContain('migrations 055-065');
  });

  it('§1b GET /v0/async-consult/ready returns 200 READY with the spec-gated gap inventory', async () => {
    const r = await app!.inject({
      method: 'GET',
      url: '/v0/async-consult/ready',
      headers: { host: 'localhost' },
    });
    expect(r.statusCode).toBe(200);
    const body = r.json<{
      status: string;
      module: string;
      spec_gated_gaps: string[];
    }>();
    expect(body.status).toBe('ready');
    expect(body.module).toBe('async-consult');
    // The gate flipped because the remaining gaps are SPEC-gated (need
    // SIs / the Consent primitive), not build-gated — and each fails
    // closed at its boundary. The inventory is the honest-status surface.
    expect(body.spec_gated_gaps).toContain('intake_abandon_needs_wrapper_si');
    expect(body.spec_gated_gaps).toContain('claim_reassignment_needs_endpoint_si');
  });

  it('§1c the Sprint 10 /v1/async-consults surface is mounted (all 6 core routes registered)', () => {
    // Route-presence assertions only — behavior is covered by the
    // per-handler unit tests + the (CI-gated) integration suite.
    expect(app!.hasRoute({ method: 'POST', url: '/v1/async-consults/' })).toBe(true);
    expect(app!.hasRoute({ method: 'GET', url: '/v1/async-consults/queue' })).toBe(true);
    expect(app!.hasRoute({ method: 'GET', url: '/v1/async-consults/:consult_id' })).toBe(true);
    expect(app!.hasRoute({ method: 'POST', url: '/v1/async-consults/:consult_id/intake' })).toBe(
      true,
    );
    expect(app!.hasRoute({ method: 'POST', url: '/v1/async-consults/:consult_id/claim' })).toBe(
      true,
    );
    expect(app!.hasRoute({ method: 'POST', url: '/v1/async-consults/:consult_id/decision' })).toBe(
      true,
    );
  });
});
