/**
 * tenant-context.ts — direct unit + HTTP-edge-case coverage on
 * `requireTenantContext()` (the pure-function exported guard) and the
 * `tenantContextPlugin` Fastify hook's Host-header edge cases that the
 * existing `tenant-context-http.test.ts` doesn't yet pin.
 *
 * Existing coverage in `tenant-context-http.test.ts` covers:
 *   - /health allowlist (with and without Host)
 *   - Unknown host → 400 with tenant-blind error envelope
 *   - heroshealth.com / www.heroshealth.com / localhost / ghana.heroshealth.com
 *     → correct-tenant resolution (tenant-discriminating via seeded data)
 *   - No tenant identifier leak in plugin error envelopes
 *
 * Gaps this file closes:
 *   §1 `requireTenantContext()` — the pure-function guard is the
 *      primary handler-side helper for asserting `req.tenantContext`
 *      is populated. Used by every state-changing handler in the
 *      forms-intake module; a regression that lets it return undefined
 *      (or pass through a phantom value) is a tenant-isolation gate
 *      bypass at runtime. Currently exercised only INDIRECTLY through
 *      every handler test that reads `ctx.tenantId`.
 *
 *   §2 Unknown-host envelope tenant-blindness (I-025) — the existing
 *      `tenant-context-http.test.ts` asserts only that an error code
 *      is present on the unknown-host 400; it does NOT assert the
 *      response body is free of tenant-identifier substrings. A
 *      regression that swapped to a more verbose error message
 *      ("Tenant Telecheck-US is not active") could pass the existing
 *      assertions but would be an I-025 violation. Pin via explicit
 *      not-contains assertions on `Telecheck-*` and `heros`.
 *
 *      (Note: the missing-Host-header branch — `if (!host)` in the
 *      plugin — is NOT covered here; lightMyRequest auto-fills `host`
 *      to `localhost` when an empty string is passed via inject(),
 *      so the branch can't be reached through the integration entry
 *      point. Direct coverage would require constructing a raw
 *      FastifyRequest stub against the hook function — out of scope
 *      for this commit.)
 *
 *   §3 Case-insensitive Host matching — `resolveHostFromMap` does
 *      `host.split(':')[0]?.toLowerCase()`. A refactor that drops
 *      `.toLowerCase()` would silently break `Host: HEROSHEALTH.COM`
 *      (or any uppercase subdomain) without any test catching it.
 *      Pin via inject with explicit uppercase host headers.
 *
 *   §4 Port-stripping — same `host.split(':')[0]` line. Real browsers
 *      and curl emit `Host: heroshealth.com:8080` when port != 80/443;
 *      a regression that drops the split would silently 400 every
 *      such request. Pin via Host: localhost:3000 / Host:
 *      heroshealth.com:443 etc.
 *
 *   §5 Port-stripping with combined uppercase+port (defense-in-depth).
 *
 * Spec references:
 *   - I-023 (three-layer tenant isolation; HTTP layer = layer 1;
 *     fail-closed when resolution fails)
 *   - I-025 (tenant-blind error envelopes; missing-host vs unknown-host
 *     errors carry distinct internal codes but neither leaks tenant
 *     existence to the caller)
 *   - Master PRD v1.10 §17 + Glossary v5.2 C3 (operating-tenant id
 *     never appears in patient-facing error envelopes)
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../../src/app.ts';
import { asTenantId } from '../../src/lib/glossary.ts';
import { type TenantContext, requireTenantContext } from '../../src/lib/tenant-context.ts';

// ---------------------------------------------------------------------------
// Test app lifecycle (HTTP-level cases share one app)
// ---------------------------------------------------------------------------

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
    request_id?: string;
  };
}

// ---------------------------------------------------------------------------
// §1 — requireTenantContext (pure function)
// ---------------------------------------------------------------------------

describe('requireTenantContext — pure-function guard', () => {
  // Helper: build a minimal FastifyRequest stub carrying just enough to
  // exercise the guard. `requireTenantContext` only inspects
  // `req.tenantContext`, so a `{ tenantContext }` shape is sufficient.
  function makeStubReq(ctx: TenantContext | undefined): FastifyRequest {
    return { tenantContext: ctx } as unknown as FastifyRequest;
  }

  const VALID_CTX: TenantContext = {
    tenantId: asTenantId('Telecheck-US'),
    displayName: 'Telecheck-US',
    countryOfCare: 'US',
    kmsKeyAlias: 'alias/telecheck-us-data-key',
    consumerDba: 'Heros Health',
    legalEntity: 'Telecheck Health LLC',
    consumerSubdomain: 'heroshealth.com',
  };

  it('§1a returns the populated TenantContext verbatim on the happy path', () => {
    const req = makeStubReq(VALID_CTX);
    const result = requireTenantContext(req);
    expect(result).toBe(VALID_CTX); // identity, not deep-equal — proves no defensive copy
    expect(result.tenantId).toBe('Telecheck-US');
    expect(result.consumerDba).toBe('Heros Health');
  });

  it('§1b throws when req.tenantContext is undefined', () => {
    const req = makeStubReq(undefined);
    expect(() => requireTenantContext(req)).toThrow();
  });

  it('§1c error message cites "programming error" + the two probable causes (allowlist or plugin not run)', () => {
    // Pin the diagnostic message text so a refactor that swaps to a
    // generic Error('tenant context missing') still works at runtime
    // but loses the operator-facing diagnostic. The two-cause hint is
    // the discriminator that lets on-call distinguish "I forgot to
    // remove a path from the allowlist" from "the plugin order in
    // app.ts is wrong".
    const req = makeStubReq(undefined);
    let thrown: unknown = null;
    try {
      requireTenantContext(req);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    const message = (thrown as Error).message;
    expect(message).toContain('programming error');
    expect(message.toLowerCase()).toContain('allowlist');
    expect(message).toContain('tenantContextPlugin');
  });

  it('§1d does NOT mutate req.tenantContext on the happy path', () => {
    const req = makeStubReq(VALID_CTX);
    requireTenantContext(req);
    // Identity preserved — the guard MUST be a read-only inspection.
    expect((req as { tenantContext: TenantContext }).tenantContext).toBe(VALID_CTX);
    expect((req as { tenantContext: TenantContext }).tenantContext.tenantId).toBe('Telecheck-US');
  });
});

// ---------------------------------------------------------------------------
// §2 — Unknown-host fail-closed envelope tenant-blindness
// ---------------------------------------------------------------------------
//
// Note: the missing-Host-header branch (`if (!host)` in the plugin) is
// genuinely difficult to exercise via Fastify's `inject()` — lightMyRequest
// auto-fills the host header to `localhost` if the caller passes an empty
// string. Direct missing-host coverage would require a lower-level test
// against `request.headers` in isolation; out of scope for this file. The
// existing `tenant-context-http.test.ts` covers the unknown-host path; this
// section adds a tighter check on the I-025 tenant-blindness of that
// envelope (the existing test only asserts code presence, not content).

describe('tenantContextPlugin — unknown-host envelope is tenant-blind', () => {
  it('§2a unknown-host envelope carries no tenant identifier substring (I-025)', async () => {
    // I-025: the wire envelope must not leak any signal of which
    // operating tenant exists. The existing `tenant-context-http.test.ts`
    // asserts only that an error code is present; this test pins that
    // the response BODY does not contain `Telecheck-`, the consumer
    // DBA names, or related leak vectors.
    const response = await app!.inject({
      method: 'GET',
      url: '/v0/forms/templates',
      headers: { host: 'unknown-host.example.com', 'x-patient-id': 'p' },
    });
    expect(response.statusCode).toBe(400);
    const bodyText = response.body;
    expect(bodyText).not.toContain('Telecheck-US');
    expect(bodyText).not.toContain('Telecheck-Ghana');
    expect(bodyText.toLowerCase()).not.toContain('heros');
    // Code itself is allowed to be specific (`unresolvable_tenant`); the
    // PROHIBITED leakage is rendering the actual tenant identifier.
    const body = response.json<ErrorEnvelope>();
    expect(body.error?.code).toBe('internal.request.unresolvable_tenant');
  });
});

// ---------------------------------------------------------------------------
// §3 — Case-insensitive Host matching (resolveHostFromMap.toLowerCase())
// ---------------------------------------------------------------------------

describe('tenantContextPlugin — case-insensitive Host matching', () => {
  it('§3a Host: HEROSHEALTH.COM (uppercase) resolves successfully (handler reaches normal 200/404 path)', async () => {
    // The plugin lowercases the host before lookup. A regression that
    // drops `.toLowerCase()` would silently 400 every uppercase Host
    // header. We assert the response is NOT 400-with-unresolvable —
    // any other status proves the plugin matched the host successfully
    // and forwarded to the handler.
    const response = await app!.inject({
      method: 'GET',
      url: '/v0/forms/templates',
      headers: { host: 'HEROSHEALTH.COM', 'x-patient-id': 'pat_x' },
    });
    expect(response.statusCode).not.toBe(400);
    // And the response body must NOT contain the unresolvable-tenant
    // code (which would also cause a non-400 if the handler path was
    // a different code, but the body is the canonical proof).
    const body = response.body;
    expect(body).not.toContain('internal.request.unresolvable_tenant');
    expect(body).not.toContain('internal.request.missing_host_header');
  });

  it('§3b Host: Heroshealth.Com (mixed case) also resolves', async () => {
    const response = await app!.inject({
      method: 'GET',
      url: '/v0/forms/templates',
      headers: { host: 'Heroshealth.Com', 'x-patient-id': 'pat_x' },
    });
    expect(response.statusCode).not.toBe(400);
    expect(response.body).not.toContain('unresolvable_tenant');
  });

  it('§3c Host: LOCALHOST (uppercase localhost) resolves to the dev tenant', async () => {
    // The bootstrap-only `localhost` map entry must also be
    // case-insensitive. This is the convenience path test runners use;
    // an uppercase regression here breaks every test fixture using
    // `host: 'localhost'` if the real host arrives capitalized in some
    // proxy chain.
    const response = await app!.inject({
      method: 'GET',
      url: '/v0/forms/templates',
      headers: { host: 'LOCALHOST', 'x-patient-id': 'pat_x' },
    });
    expect(response.statusCode).not.toBe(400);
    expect(response.body).not.toContain('unresolvable_tenant');
  });
});

// ---------------------------------------------------------------------------
// §4 — Port stripping (resolveHostFromMap host.split(':')[0])
// ---------------------------------------------------------------------------

describe('tenantContextPlugin — port stripping in Host header', () => {
  it('§4a Host: heroshealth.com:443 resolves successfully (port stripped before lookup)', async () => {
    const response = await app!.inject({
      method: 'GET',
      url: '/v0/forms/templates',
      headers: { host: 'heroshealth.com:443', 'x-patient-id': 'pat_x' },
    });
    expect(response.statusCode).not.toBe(400);
    expect(response.body).not.toContain('unresolvable_tenant');
  });

  it('§4b Host: localhost:3000 resolves (the typical local-dev shape)', async () => {
    // This pins the dev convenience: `npm run dev` listens on :3000
    // and a curl to `http://localhost:3000` sets `Host: localhost:3000`.
    // Without port stripping, dev would 400 on every request.
    const response = await app!.inject({
      method: 'GET',
      url: '/v0/forms/templates',
      headers: { host: 'localhost:3000', 'x-patient-id': 'pat_x' },
    });
    expect(response.statusCode).not.toBe(400);
    expect(response.body).not.toContain('unresolvable_tenant');
  });

  it('§4c Host: ghana.heroshealth.com:8443 resolves to Telecheck-Ghana', async () => {
    // Port-stripping must work for non-default ports too. Pin the
    // ghana-subdomain mapping survives the strip.
    const response = await app!.inject({
      method: 'GET',
      url: '/v0/forms/templates',
      headers: { host: 'ghana.heroshealth.com:8443', 'x-patient-id': 'pat_x' },
    });
    expect(response.statusCode).not.toBe(400);
    expect(response.body).not.toContain('unresolvable_tenant');
  });
});

// ---------------------------------------------------------------------------
// §5 — Combined: case-insensitive AND port-stripping (defense in depth)
// ---------------------------------------------------------------------------

describe('tenantContextPlugin — Host header normalization combined', () => {
  it('§5a Host: HEROSHEALTH.COM:443 (uppercase + port) still resolves', async () => {
    // Regression guard for any refactor that fixes one normalization
    // (e.g., split before lowercase) but breaks the other. The plugin
    // does `host.split(':')[0]?.toLowerCase()` — both must hold.
    const response = await app!.inject({
      method: 'GET',
      url: '/v0/forms/templates',
      headers: { host: 'HEROSHEALTH.COM:443', 'x-patient-id': 'pat_x' },
    });
    expect(response.statusCode).not.toBe(400);
    expect(response.body).not.toContain('unresolvable_tenant');
    expect(response.body).not.toContain('missing_host_header');
  });

  it('§5b Host: GHANA.HEROSHEALTH.COM:8443 (uppercase ghana subdomain + port) also resolves', async () => {
    const response = await app!.inject({
      method: 'GET',
      url: '/v0/forms/templates',
      headers: { host: 'GHANA.HEROSHEALTH.COM:8443', 'x-patient-id': 'pat_x' },
    });
    expect(response.statusCode).not.toBe(400);
    expect(response.body).not.toContain('unresolvable_tenant');
  });
});
