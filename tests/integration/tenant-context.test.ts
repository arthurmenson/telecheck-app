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
 *   §2 Missing-Host-header path — the plugin's `if (!host)` branch
 *      (line 462-472 of tenant-context.ts) is NOT directly tested.
 *      Existing tests cover UNKNOWN-host but not MISSING-host. These
 *      are different code paths (different error code:
 *      `internal.request.missing_host_header` vs
 *      `internal.request.unresolvable_tenant`) and the regression
 *      mode would manifest as wrong-error-code on a malformed client
 *      request. Pin both code values so a refactor that collapses the
 *      branches is caught.
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
// §2 — Missing Host header → distinct internal code
// ---------------------------------------------------------------------------

describe('tenantContextPlugin — missing Host header (distinct from unknown-host)', () => {
  it('§2a returns 400 with code "internal.request.missing_host_header" when Host is empty string', async () => {
    // lightMyRequest may auto-add a default host on inject(); explicitly
    // set the host header to an empty string to force the `if (!host)`
    // branch. The plugin's check is `if (!host)` so '' (falsy) trips it.
    const response = await app!.inject({
      method: 'GET',
      url: '/v0/forms/templates',
      headers: {
        host: '',
        'x-patient-id': 'pat_unused_for_this_test',
      },
    });
    expect(response.statusCode).toBe(400);
    const body = response.json<ErrorEnvelope>();
    expect(body.error?.code).toBe('internal.request.missing_host_header');
    expect(body.error?.message).toContain('Host header');
  });

  it('§2b distinct code from "unresolvable_tenant" — missing-host vs unknown-host are SEPARATE branches', async () => {
    // Sanity counterpart: an UNKNOWN host emits a different code. Pin
    // the diff so a refactor that collapses the two branches into one
    // generic "tenant resolution failed" code is caught.
    const missingHost = await app!.inject({
      method: 'GET',
      url: '/v0/forms/templates',
      headers: { host: '', 'x-patient-id': 'p' },
    });
    const unknownHost = await app!.inject({
      method: 'GET',
      url: '/v0/forms/templates',
      headers: { host: 'unknown-host.example.com', 'x-patient-id': 'p' },
    });
    const missingCode = missingHost.json<ErrorEnvelope>().error?.code;
    const unknownCode = unknownHost.json<ErrorEnvelope>().error?.code;
    expect(missingCode).toBe('internal.request.missing_host_header');
    expect(unknownCode).toBe('internal.request.unresolvable_tenant');
    expect(missingCode).not.toBe(unknownCode);
  });

  it('§2c error envelope is tenant-blind — neither code mentions any tenant identifier', async () => {
    // I-025: the wire envelope must not leak tenant existence info.
    const response = await app!.inject({
      method: 'GET',
      url: '/v0/forms/templates',
      headers: { host: '', 'x-patient-id': 'p' },
    });
    const bodyText = response.body;
    expect(bodyText).not.toContain('Telecheck-US');
    expect(bodyText).not.toContain('Telecheck-Ghana');
    expect(bodyText.toLowerCase()).not.toContain('heros');
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
