/**
 * error-envelope.ts crossTenantNotFoundError + insufficientTenantScopeError —
 * direct unit coverage on the I-025 envelope builders.
 *
 * Both functions are exported helpers used by handlers that need to
 * emit a tenant-blind 404 (resource exists in another tenant or
 * doesn't exist at all — the envelope must be byte-identical for both
 * cases) or a 403 for unauthorized scope without echoing the requested
 * tenant_id. They're the canonical I-025 envelope shape; a regression
 * that:
 *   - adds a `detail.tenant_id` field
 *   - changes `code` to one that differs by 404-vs-cross-tenant
 *   - includes a stack trace or internal-state hint
 * would all be I-025 violations that cross-tenant existence-leak
 * prevention is supposed to catch.
 *
 * Until this commit BOTH functions had ZERO direct tests. They were
 * exercised only indirectly through `error-envelope-http.test.ts`
 * (which goes through buildApp() and exercises the plugin path), so
 * regressions on the function INTERFACE itself (return shape, key
 * presence/absence, code/message constants) wouldn't surface until
 * the integration test ran.
 *
 * Coverage in this file (3 sections, 12 cases):
 *
 *   §1 crossTenantNotFoundError —
 *      §1a returns the canonical {error: {code, message, trace_id, timestamp}}
 *          shape with no extra keys
 *      §1b code is exactly 'internal.resource.not_found' (pin against typo
 *          regression — different code distinguishable by client = I-025
 *          violation)
 *      §1c message is the canonical "The requested resource was not found."
 *          (pin so a refactor that adds tenant-hinting text is caught)
 *      §1d trace_id is echoed verbatim (callers pass req.id)
 *      §1e timestamp parses as a valid ISO 8601 instant
 *      §1f does NOT include `detail` (would echo internal state) or
 *          `retry_after` keys
 *
 *   §2 insufficientTenantScopeError —
 *      §2a returns the canonical envelope shape
 *      §2b code is exactly 'internal.auth.insufficient_tenant_scope'
 *      §2c message is the canonical "Insufficient scope for this request."
 *          (pin: must NOT mention tenant_id or include the requested value)
 *      §2d does NOT carry a `detail` block (the comment in the source
 *          documents this as the I-025 rule 2 enforcement)
 *      §2e trace_id is echoed verbatim
 *
 *   §3 cross-builder invariants —
 *      §3a both builders produce timestamps that round-trip through Date
 *      §3b both builders are tenant-blind: no Telecheck-* / heros / tenant_id
 *          substring in the JSON-serialized envelope
 *
 * Spec references:
 *   - I-025 (tenant-blind error envelopes — no existence leak via code,
 *     message, or detail)
 *   - ERROR_MODEL v5.1 (canonical envelope shape:
 *     {error: {code, message, detail?, retry_after?, trace_id, timestamp}})
 *   - Master PRD v1.10 §17 + Glossary v5.2 C3 (operating-tenant id never
 *     appears in patient-facing error envelopes)
 */

import { describe, expect, it } from 'vitest';

import {
  crossTenantNotFoundError,
  insufficientTenantScopeError,
} from '../../src/lib/error-envelope.ts';

// ---------------------------------------------------------------------------
// §1 — crossTenantNotFoundError
// ---------------------------------------------------------------------------

describe('crossTenantNotFoundError — tenant-blind 404 envelope', () => {
  it('§1a returns the canonical envelope shape', () => {
    const trace = 'req_abc_123';
    const env = crossTenantNotFoundError(trace);

    expect(env).toBeDefined();
    expect(env.error).toBeDefined();
    expect(env.error.code).toBeTypeOf('string');
    expect(env.error.message).toBeTypeOf('string');
    expect(env.error.trace_id).toBeTypeOf('string');
    expect(env.error.timestamp).toBeTypeOf('string');
  });

  it('§1b code is exactly "internal.resource.not_found"', () => {
    // Pin the canonical code value: a typo or refactor that emits
    // something distinguishable from the plain 404 code (e.g.,
    // 'internal.resource.cross_tenant') is an I-025 violation —
    // clients could differentiate "doesn't exist" from "exists in
    // another tenant" by code matching.
    const env = crossTenantNotFoundError('req_x');
    expect(env.error.code).toBe('internal.resource.not_found');
  });

  it('§1c message is exactly "The requested resource was not found."', () => {
    // Same I-025 reasoning at the message layer: a refactor that
    // varies the message text between cross-tenant and plain-not-found
    // (e.g., "Resource not visible in your scope") leaks existence.
    const env = crossTenantNotFoundError('req_x');
    expect(env.error.message).toBe('The requested resource was not found.');
  });

  it('§1d trace_id is echoed verbatim from the input', () => {
    // Trace IDs are operator-side correlation; callers pass req.id.
    // Echo must be byte-identical so log-grep on the request id
    // reaches the response envelope.
    const trace = 'req_unique_5f8e_2026-05-04';
    const env = crossTenantNotFoundError(trace);
    expect(env.error.trace_id).toBe(trace);
  });

  it('§1e timestamp parses as a valid ISO 8601 instant', () => {
    // ERROR_MODEL v5.1 requires `timestamp` be ISO 8601. Pin via
    // Date.parse round-trip — invalid strings parse to NaN.
    const env = crossTenantNotFoundError('req_x');
    const parsed = Date.parse(env.error.timestamp);
    expect(Number.isNaN(parsed)).toBe(false);
    // The timestamp should be within the last 5 seconds (we just built
    // it). Sanity guard against a regression that hardcodes "1970-01-01"
    // or pulls from a stale cache.
    const ageMs = Date.now() - parsed;
    expect(ageMs).toBeGreaterThanOrEqual(0);
    expect(ageMs).toBeLessThan(5_000);
  });

  it('§1f does NOT include `detail` or `retry_after` keys', () => {
    // ERROR_MODEL v5.1 marks both as optional. For a cross-tenant 404,
    // including `detail` would echo internal state (a regression risk
    // for I-025); including `retry_after` makes no semantic sense for
    // a not-found. Pin their absence to lock the canonical shape.
    const env = crossTenantNotFoundError('req_x');
    expect(env.error).not.toHaveProperty('detail');
    expect(env.error).not.toHaveProperty('retry_after');
  });
});

// ---------------------------------------------------------------------------
// §2 — insufficientTenantScopeError
// ---------------------------------------------------------------------------

describe('insufficientTenantScopeError — tenant-blind 403 envelope', () => {
  it('§2a returns the canonical envelope shape', () => {
    const env = insufficientTenantScopeError('req_xyz');
    expect(env.error).toBeDefined();
    expect(env.error.code).toBeTypeOf('string');
    expect(env.error.message).toBeTypeOf('string');
    expect(env.error.trace_id).toBeTypeOf('string');
    expect(env.error.timestamp).toBeTypeOf('string');
  });

  it('§2b code is exactly "internal.auth.insufficient_tenant_scope"', () => {
    // Pin the canonical code. Note: the generic 403 code is
    // 'internal.auth.insufficient_scope' (without "_tenant_"); the
    // tenant-specific variant must remain distinct from the generic
    // one for operator-side correlation, but neither leaks tenant
    // existence to the patient surface (which only sees status + code).
    const env = insufficientTenantScopeError('req_x');
    expect(env.error.code).toBe('internal.auth.insufficient_tenant_scope');
  });

  it('§2c message is exactly "Insufficient scope for this request."', () => {
    // The message MUST NOT contain "tenant_id" / "Telecheck-" / the
    // requested tenant identifier. The source-code comment documents
    // this as I-025 rule 2 enforcement.
    const env = insufficientTenantScopeError('req_x');
    expect(env.error.message).toBe('Insufficient scope for this request.');
    expect(env.error.message.toLowerCase()).not.toContain('tenant_id');
    expect(env.error.message).not.toContain('Telecheck-');
  });

  it('§2d does NOT carry a `detail` block (I-025 rule 2)', () => {
    // The function comment documents this explicitly:
    //   "Intentionally no detail — echoing the requested tenant_id here
    //    would confirm the tenant exists (I-025 violation)."
    // Pin via not.toHaveProperty so a refactor that adds a detail block
    // (even an empty one) is flagged.
    const env = insufficientTenantScopeError('req_x');
    expect(env.error).not.toHaveProperty('detail');
  });

  it('§2e trace_id is echoed verbatim from the input', () => {
    const trace = 'req_403_correlation_id_2026';
    const env = insufficientTenantScopeError(trace);
    expect(env.error.trace_id).toBe(trace);
  });
});

// ---------------------------------------------------------------------------
// §3 — cross-builder invariants
// ---------------------------------------------------------------------------

describe('error-envelope helpers — cross-builder invariants', () => {
  it('§3a both builders produce timestamps that round-trip through Date.parse', () => {
    // Defense in depth: if either builder regresses to a non-ISO
    // timestamp, this test catches it without the I-025-specific
    // assertions in §1e/§2 having to repeat the check.
    const a = crossTenantNotFoundError('a');
    const b = insufficientTenantScopeError('b');
    expect(Number.isNaN(Date.parse(a.error.timestamp))).toBe(false);
    expect(Number.isNaN(Date.parse(b.error.timestamp))).toBe(false);
  });

  it('§3b both builders are tenant-blind in their JSON-serialized output', () => {
    // Belt-and-suspenders: stringifying the envelope MUST NOT contain
    // any tenant identifier substring. Catches a regression where a
    // future refactor accidentally interpolates the requested tenant
    // into the trace_id, message, or any other field. (Per I-025 rule
    // 2, neither builder should EVER carry tenant identity in the
    // outbound envelope.)
    const a = crossTenantNotFoundError('req_a');
    const b = insufficientTenantScopeError('req_b');
    const sa = JSON.stringify(a);
    const sb = JSON.stringify(b);

    for (const serialized of [sa, sb]) {
      expect(serialized).not.toContain('Telecheck-US');
      expect(serialized).not.toContain('Telecheck-Ghana');
      expect(serialized.toLowerCase()).not.toContain('heros');
      // The literal substring 'tenant_id' would surface only if the
      // builder accidentally serialized a tenant_id field; pin its
      // absence.
      expect(serialized).not.toContain('tenant_id');
    }
  });

  it('§3c trace_id round-trip preserves callers passing empty / unusual strings', () => {
    // The builders are pure pass-throughs on trace_id; pin that they
    // don't sanitize, drop, or transform the input. This is intentional
    // — callers control the trace_id format (req.id is a Fastify-
    // generated random string, but tests / replay tooling may pass
    // synthetic values).
    expect(crossTenantNotFoundError('').error.trace_id).toBe('');
    expect(
      insufficientTenantScopeError('a-very-long-trace-id-' + '0'.repeat(100)).error.trace_id,
    ).toBe('a-very-long-trace-id-' + '0'.repeat(100));
  });
});
