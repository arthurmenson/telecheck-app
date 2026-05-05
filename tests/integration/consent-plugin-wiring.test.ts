/**
 * Consent plugin — wiring test.
 *
 * Verifies the Consent module is registered into the app graph
 * end-to-end via buildApp() + Fastify inject.
 *
 * Coverage in this file (1 section, 2 cases).
 *
 * Spec references:
 *   - src/modules/consent/plugin.ts (target)
 *   - src/app.ts (registration site)
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

describe('consent plugin — wiring', () => {
  it('GET /v0/consent/health returns 200 + module-scoped envelope', async () => {
    const response = await app!.inject({
      method: 'GET',
      url: '/v0/consent/health',
    });
    expect(response.statusCode).toBe(200);
    const body = response.json<{ status: string; module: string }>();
    expect(body.status).toBe('ok');
    expect(body.module).toBe('consent');
  });

  it('GET /v0/consent/health is allowlisted (works without tenant resolution)', async () => {
    const response = await app!.inject({
      method: 'GET',
      url: '/v0/consent/health',
      headers: { host: 'unknown-host.example.com' },
    });
    expect(response.statusCode).toBe(200);
  });
});
