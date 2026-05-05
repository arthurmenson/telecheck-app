/**
 * med-interaction slice — plugin wiring smoke test.
 *
 * Sprint 3 / TLC-007 (Med Interaction signals contract scaffolding,
 * blocked-aware).
 *
 * The full Med Interaction Engine slice is BLOCKED on slice PRD
 * ratification. At v0.1 we ship the directory + plugin shell so that:
 *   1. The module boundary (per ADR-001) is established now
 *   2. App-level wiring (`src/app.ts`) is stable
 *   3. Cross-module callers can typed-import branded ID types ahead
 *      of full implementation (Pharmacy, Async Consult, Mode 2 protocol agents)
 *
 * This test asserts the only currently-mounted routes return the
 * documented BLOCKED state (with the readiness/liveness split applied
 * a-priori per Sprint 1 Codex MEDIUM finding `pharmacy-blocked-handler`).
 *
 * Spec references:
 *   - src/modules/med-interaction/README.md
 *   - ADR-001 (modular monolith)
 *   - Master PRD v1.10 §7 (interaction engine as platform-floor)
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

describe('med-interaction slice — §1 plugin wiring', () => {
  it('§1a GET /v0/med-interaction/health returns 200 (liveness — module alive) with slice-blocked metadata', async () => {
    const r = await app!.inject({
      method: 'GET',
      url: '/v0/med-interaction/health',
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
    expect(body.module).toBe('med-interaction');
    expect(body.blocked).toContain('Med Interaction Engine slice ratification');
    expect(body.blocked_message).toContain('slice PRD');
  });

  it('§1b GET /v0/med-interaction/ready returns 503 (not ready for traffic) while slice PRD unratified', async () => {
    const r = await app!.inject({
      method: 'GET',
      url: '/v0/med-interaction/ready',
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
    expect(body.module).toBe('med-interaction');
    expect(body.blocked).toContain('Med Interaction Engine slice ratification');
    expect(body.blocked_message).toContain('not ready to serve traffic');
  });
});
