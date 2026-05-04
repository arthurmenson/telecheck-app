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
 * Test approach:
 *   Use the REAL `/v0/forms/resume/:resumeToken` route — a production
 *   endpoint whose URL param is the long token. Submit a 200-char
 *   invalid-but-routable param value; if the route MATCHES (the fix is
 *   in place), the handler runs, verifyResumeToken returns null, and the
 *   handler emits a 404 with message "Form resume state not found."
 *   (custom). If the route DOESN'T match (param-length rejected before
 *   route resolution), setNotFoundHandler fires with the canonical
 *   "The requested resource was not found." message.
 *
 *   Distinguishing the two via the response body's `error.message`
 *   field gives a deterministic regression guard without relying on
 *   any production handler change.
 *
 * Spec references:
 *   - Slice PRD v2.1 §8 (resume token format; ~115 chars typical)
 *   - Codex resume-http-r0 closure 2026-05-04 (the original
 *     maxParamLength diagnostic chain)
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

interface ErrorEnvelope {
  error?: {
    code?: string;
    message?: string;
  };
}

const HANDLER_404_MESSAGE = 'Form resume state not found.';
const SET_NOT_FOUND_HANDLER_MESSAGE = 'The requested resource was not found.';

describe('app.ts — Fastify routerOptions.maxParamLength regression guard', () => {
  it('routes a 200-char URL path param to the handler (NOT setNotFoundHandler)', async () => {
    // 200 chars of base64url-safe content — well above Fastify's
    // 100-char default. The handler MUST receive this and run
    // verifyResumeToken (which returns null for a non-existent token);
    // we expect the handler-emitted 404 message, NOT setNotFoundHandler's.
    const longParam = 'A'.repeat(200);
    const response = await app!.inject({
      method: 'GET',
      url: `/v0/forms/resume/${longParam}`,
      headers: {
        host: 'localhost',
        'x-patient-id': 'pat_unused_for_this_test',
      },
    });

    // 404 either way — but the WHO emitted it differs.
    expect(response.statusCode).toBe(404);

    const body = response.json<ErrorEnvelope>();
    // Handler-emitted 404 — proves the route matched and verifyResumeToken
    // ran. If maxParamLength is at default 100, the param is rejected
    // BEFORE the route matches and we'd see SET_NOT_FOUND_HANDLER_MESSAGE
    // instead. Pin the message diff so the regression is unambiguous.
    expect(body.error?.message).toBe(HANDLER_404_MESSAGE);
    expect(body.error?.message).not.toBe(SET_NOT_FOUND_HANDLER_MESSAGE);
  });

  it('routes a typical resume-token-shaped URL param (~115 chars with one dot) to the handler', async () => {
    // Approximate the production resume-token shape: base64url payload,
    // one dot separator, base64url signature.
    const tokenLike = 'A'.repeat(70) + '.' + 'B'.repeat(43);
    const response = await app!.inject({
      method: 'GET',
      url: `/v0/forms/resume/${tokenLike}`,
      headers: {
        host: 'localhost',
        'x-patient-id': 'pat_unused_for_this_test',
      },
    });

    expect(response.statusCode).toBe(404);
    const body = response.json<ErrorEnvelope>();
    // Same handler-emitted-404 vs setNotFoundHandler-404 distinction.
    expect(body.error?.message).toBe(HANDLER_404_MESSAGE);
  });

  it('still 404s for a TRULY missing route via setNotFoundHandler (sanity counterpart)', async () => {
    // Pin that the maxParamLength bump didn't break setNotFoundHandler
    // entirely — routes that genuinely don't exist still 404 with the
    // canonical envelope message.
    const response = await app!.inject({
      method: 'GET',
      url: '/definitely-not-a-route',
      headers: { host: 'localhost' },
    });
    expect(response.statusCode).toBe(404);
    const body = response.json<ErrorEnvelope>();
    expect(body.error?.message).toBe(SET_NOT_FOUND_HANDLER_MESSAGE);
  });

  it('REGRESSION GUARD — a 101-char URL param ALSO routes to the handler (just above the default 100 ceiling)', async () => {
    // Boundary case — pin that the override raises the ceiling
    // STRICTLY above 100. With Fastify's default, 101 chars would
    // setNotFoundHandler-404; with the override, the handler runs.
    const justAboveDefault = 'A'.repeat(101);
    const response = await app!.inject({
      method: 'GET',
      url: `/v0/forms/resume/${justAboveDefault}`,
      headers: {
        host: 'localhost',
        'x-patient-id': 'pat_unused_for_this_test',
      },
    });
    expect(response.statusCode).toBe(404);
    const body = response.json<ErrorEnvelope>();
    expect(body.error?.message).toBe(HANDLER_404_MESSAGE);
  });
});
