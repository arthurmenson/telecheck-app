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
  it('§1a GET /v0/async-consult/health returns 200 (liveness — module alive) with Sprint 8 skeleton metadata', async () => {
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
    expect(body.blocked).toContain('Async Consult slice authoring');
    expect(body.blocked).toContain('Sprint 1 of 3');
    expect(body.blocked_message).toContain('skeleton state');
  });

  it('§1b GET /v0/async-consult/ready returns 503 (not ready for traffic) while slice in skeleton state', async () => {
    const r = await app!.inject({
      method: 'GET',
      url: '/v0/async-consult/ready',
      headers: { host: 'localhost' },
    });
    expect(r.statusCode).toBe(503);
    const body = r.json<{
      status: string;
      module: string;
      blocked: string;
      blocked_message: string;
    }>();
    expect(body.status).toBe('not_ready');
    expect(body.module).toBe('async-consult');
    expect(body.blocked).toContain('Async Consult slice authoring');
    expect(body.blocked_message).toContain('not ready to serve traffic');
  });
});
