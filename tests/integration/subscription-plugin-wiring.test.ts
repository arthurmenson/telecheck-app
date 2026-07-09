/**
 * subscription slice — plugin wiring smoke test.
 *
 * SI-001 CLOSED (Promotion Ledger P-011; operator-confirmed 2026-07-08). The
 * module now mounts the real OpenAPI v0.2 §20 handler surface under the
 * canonical plural base path `/v0/subscriptions`. This test asserts the
 * liveness/readiness probes reflect the live (not blocked) state:
 *   - GET /v0/subscriptions/health → 200, no `blocked` field.
 *   - GET /v0/subscriptions/ready  → 200 (ratified §20 surface mounted).
 *
 * Endpoint behaviour (auth gates, transitions, tenant isolation, idempotency)
 * is covered by the live-PG suite subscription-http.test.ts; this smoke test
 * only proves the plugin wires into buildApp() and the probes answer.
 *
 * Spec references:
 *   - OpenAPI v0.2 §20 (subscription endpoint contracts; base path)
 *   - src/modules/subscription/README.md
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

describe('subscription slice — §1 plugin wiring', () => {
  it('§1a GET /v0/subscriptions/health returns 200 (liveness) with no blocked field', async () => {
    const r = await app!.inject({
      method: 'GET',
      url: '/v0/subscriptions/health',
      headers: { host: 'localhost' },
    });
    expect(r.statusCode).toBe(200);
    const body = r.json<{ status: string; module: string; blocked?: string }>();
    expect(body.status).toBe('ok');
    expect(body.module).toBe('subscription');
    // SI-001 closed — the blocked field is gone.
    expect(body.blocked).toBeUndefined();
  });

  it('§1b GET /v0/subscriptions/ready returns 200 (ratified §20 surface mounted)', async () => {
    const r = await app!.inject({
      method: 'GET',
      url: '/v0/subscriptions/ready',
      headers: { host: 'localhost' },
    });
    expect(r.statusCode).toBe(200);
    const body = r.json<{ status: string; module: string; blocked?: string }>();
    expect(body.status).toBe('ready');
    expect(body.module).toBe('subscription');
    expect(body.blocked).toBeUndefined();
  });
});
