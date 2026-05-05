/**
 * pharmacy slice — plugin wiring smoke test.
 *
 * Sprint 1 / TLC-001 (Pharmacy module skeleton, blocked-aware).
 *
 * The full pharmacy slice is BLOCKED on SI-001 (MedicationRequest
 * schema gap). At v0.1 we ship the directory + plugin shell so that:
 *   1. The module boundary (per ADR-001) is established now
 *   2. App-level wiring (`src/app.ts`) is stable
 *   3. Cross-module callers can typed-import branded ID types ahead
 *      of full implementation
 *
 * This test asserts the only currently-mounted route returns the
 * documented BLOCKED state — so a premature production deploy
 * surfaces the BLOCKED status to operator monitoring rather than
 * masquerading as a working module.
 *
 * Spec references:
 *   - docs/SI-001-MedicationRequest-Schema-Gap.md
 *   - src/modules/pharmacy/README.md
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

describe('pharmacy slice — §1 plugin wiring', () => {
  it('§1a GET /v0/pharmacy/health returns 200 (liveness — module alive) with SI-001 metadata', async () => {
    const r = await app!.inject({
      method: 'GET',
      url: '/v0/pharmacy/health',
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
    expect(body.module).toBe('pharmacy');
    expect(body.blocked).toBe('SI-001');
    expect(body.blocked_message).toContain('SI-001');
    expect(body.blocked_message).toContain('MedicationRequest');
  });

  it('§1b GET /v0/pharmacy/ready returns 503 (not ready for traffic) while SI-001 open', async () => {
    const r = await app!.inject({
      method: 'GET',
      url: '/v0/pharmacy/ready',
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
    expect(body.module).toBe('pharmacy');
    expect(body.blocked).toBe('SI-001');
    expect(body.blocked_message).toContain('not ready to serve traffic');
  });
});
