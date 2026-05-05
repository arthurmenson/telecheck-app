/**
 * subscription slice — plugin wiring smoke test.
 *
 * Sprint 4 / TLC-010 (Subscription module skeleton, blocked-aware).
 *
 * The full Subscription slice is BLOCKED on SI-001 (Subscription binds
 * to MedicationRequest via medication_request_id for refill cadence
 * and product-catalog binding). At v0.1 we ship the directory + plugin
 * shell so that:
 *   1. The module boundary (per ADR-001) is established now
 *   2. App-level wiring (`src/app.ts`) is stable
 *   3. Cross-module callers can typed-import branded ID types ahead
 *      of full implementation (Async Consult, Admin Backend Tenant
 *      Admin subscription management)
 *
 * This test asserts the only currently-mounted routes return the
 * documented BLOCKED state (with the readiness/liveness split applied
 * a-priori per Sprint 1 Codex MEDIUM finding `pharmacy-blocked-handler` —
 * 3rd application of the standing rule).
 *
 * Spec references:
 *   - docs/SI-001-MedicationRequest-Schema-Gap.md
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
  it('§1a GET /v0/subscription/health returns 200 (liveness — module alive) with SI-001 metadata', async () => {
    const r = await app!.inject({
      method: 'GET',
      url: '/v0/subscription/health',
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
    expect(body.module).toBe('subscription');
    expect(body.blocked).toBe('SI-001');
    expect(body.blocked_message).toContain('SI-001');
    expect(body.blocked_message).toContain('MedicationRequest');
  });

  it('§1b GET /v0/subscription/ready returns 503 (not ready for traffic) while SI-001 open', async () => {
    const r = await app!.inject({
      method: 'GET',
      url: '/v0/subscription/ready',
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
    expect(body.module).toBe('subscription');
    expect(body.blocked).toBe('SI-001');
    expect(body.blocked_message).toContain('not ready to serve traffic');
  });
});
