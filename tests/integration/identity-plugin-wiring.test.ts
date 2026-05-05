/**
 * Identity plugin — wiring test.
 *
 * Verifies the Identity module is registered into the app graph end-to-end:
 *   - identityPlugin loads without error during buildApp()
 *   - GET /v0/identity/health returns 200 with the module-scoped envelope
 *   - The /health probe is allowlisted (works with NO Host header since
 *     the test runs through Fastify inject; the plugin bypasses tenant
 *     resolution per the app.ts allowlist entry)
 *
 * This is the parallel of `app-router-config.test.ts` for the Identity
 * module — proves the plugin is wired correctly without exercising any
 * tenant-scoped state.
 *
 * Spec references:
 *   - src/modules/identity/plugin.ts (target)
 *   - src/app.ts (registration site)
 *   - I-023 (allowlist for tenant-blind health endpoints)
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

describe('identity plugin — wiring', () => {
  it('GET /v0/identity/health returns 200 + module-scoped envelope', async () => {
    const response = await app!.inject({
      method: 'GET',
      url: '/v0/identity/health',
    });
    expect(response.statusCode).toBe(200);
    const body = response.json<{ status: string; module: string }>();
    expect(body.status).toBe('ok');
    expect(body.module).toBe('identity');
  });

  it('GET /v0/identity/health is allowlisted (works without tenant resolution)', async () => {
    // Pass an unknown host — the platform /health uses the same
    // pattern. The /v0/identity/health probe MUST also bypass tenant
    // resolution per the app.ts allowlist entry.
    const response = await app!.inject({
      method: 'GET',
      url: '/v0/identity/health',
      headers: { host: 'unknown-host-not-in-tenants.example.com' },
    });
    expect(response.statusCode).toBe(200);
  });
});
