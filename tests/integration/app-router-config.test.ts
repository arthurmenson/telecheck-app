/**
 * app.ts Fastify routerOptions — maxParamLength regression guard.
 *
 * Pin the `routerOptions: { maxParamLength: 512 }` constructor option in
 * `src/app.ts` so a future refactor that drops it surfaces here at unit-
 * test speed instead of cascading silently through every long-token
 * URL test.
 *
 * Why this matters:
 *   Fastify's default `maxParamLength` is 100 chars (find-my-way 9.x).
 *   Resume tokens are HMAC-signed payload+sig pairs that run ~115 chars.
 *   Tokens longer than 100 chars hit Fastify's ROUTER-level path-param
 *   length check BEFORE the handler runs — the request silently 404s
 *   via setNotFoundHandler, and the test failure mode is "expected 200
 *   to be 404" rather than a clear "param too long" diagnostic.
 *
 *   This was the residual root cause of CI's last-stretch resume-http
 *   failures (closed in commit 7af2dca via a local-Fastify reproduction).
 *   Without a regression guard, a future refactor that simplifies
 *   `buildApp()` and drops the routerOptions field would silently
 *   reintroduce the bug.
 *
 * What this test pins:
 *   - The buildApp() instance accepts a 200-char URL path param without
 *     404'ing (proves the param-length ceiling is well above the 100
 *     default + above realistic resume-token length of ~115).
 *   - Specifically reaches the route handler instead of setNotFoundHandler.
 *
 * What this test does NOT pin (out of scope):
 *   - The actual resume-token path's behavior (covered by
 *     forms-intake-resume-http.test.ts).
 *   - Other Fastify constructor options (bodyLimit, genReqId, etc.) —
 *     each gets a separate test if/when it becomes load-bearing.
 *
 * Spec references:
 *   - Slice PRD v2.1 §8 (resume token format; ~115 chars typical)
 *   - Codex resume-http-r0 closure 2026-05-04 (the original maxParamLength
 *     diagnostic chain)
 */

import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../../src/app.ts';

let app: FastifyInstance | null = null;

beforeAll(async () => {
  process.env['NODE_ENV'] = 'test';
  app = await buildApp({ logger: false });
  await app.ready();

  // Register a probe route that captures the path param. Normal app
  // routes are mounted under /v0/forms; we add this probe under a
  // different prefix so it doesn't collide with any production route.
  // Routes registered AFTER buildApp().ready() require explicit
  // re-readiness; we register inside an inner plugin to avoid
  // interfering with the production route surface.
  app.get('/probe-router/:longParam', async (req) => {
    const params = req.params as { longParam: string };
    return { length: params.longParam.length, sample: params.longParam.slice(0, 20) };
  });
  await app.ready();
});

afterAll(async () => {
  if (app !== null) {
    await app.close();
  }
});

describe('app.ts — Fastify routerOptions.maxParamLength regression guard', () => {
  it('matches a 200-char URL path param (well above Fastify default of 100)', async () => {
    // 200 chars of base64url-safe content (matches what real resume
    // tokens contain; the dot separator could appear, but for the
    // routerOptions guard we test pure path-segment length).
    const longParam = 'A'.repeat(200);
    const response = await app!.inject({
      method: 'GET',
      url: `/probe-router/${longParam}`,
      headers: { host: 'localhost' },
    });
    // 200 = handler reached. 404 with internal.resource.not_found
    // would mean Fastify's setNotFoundHandler fired (param-length
    // rejected by find-my-way before route matching).
    expect(response.statusCode).toBe(200);
    const body = response.json<{ length: number; sample: string }>();
    expect(body.length).toBe(200);
    expect(body.sample).toBe('A'.repeat(20));
  });

  it('matches a typical resume-token-shaped URL param (~115 chars with one dot)', async () => {
    // Approximate the production resume-token shape: base64url payload,
    // one dot separator, base64url signature. Total ~115 chars.
    const tokenLike = 'A'.repeat(70) + '.' + 'B'.repeat(43);
    const response = await app!.inject({
      method: 'GET',
      url: `/probe-router/${tokenLike}`,
      headers: { host: 'localhost' },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json<{ length: number }>();
    expect(body.length).toBe(tokenLike.length);
  });

  it('still 404s for a TRULY missing route (sanity: setNotFoundHandler still works)', async () => {
    // Counterpart — pin that the change didn't break setNotFoundHandler
    // entirely. Routes that genuinely don't exist still 404.
    const response = await app!.inject({
      method: 'GET',
      url: '/definitely-not-a-route',
      headers: { host: 'localhost' },
    });
    expect(response.statusCode).toBe(404);
  });
});
