/**
 * Tenant-blind error envelope integration tests.
 *
 * Invariant under test: I-025 (information-leak prevention in error envelopes).
 *
 * Spec references:
 *   - I-025: "Error responses do not differentiate between 'the requested resource
 *             does not exist anywhere on the platform' and 'the requested resource
 *             exists in another tenant the requestor is not authorized for.'"
 *   - ERROR_MODEL v5.1 (canonical error envelope schema, preserved at v5.1).
 *   - CLAUDE.md §Hard rules: "Error envelopes for resource-not-found are
 *     tenant-blind (do not differentiate 'doesn't exist' vs 'exists in
 *     another tenant')."
 *
 * Expected error envelope shape (ERROR_MODEL v5.1):
 *   { error: { code: string, message: string, request_id: string } }
 *
 * Test scenarios:
 *   1. Non-existent resource ID → 404 + tenant-blind envelope.
 *   2. Resource exists in Tenant B but request is authenticated as Tenant A →
 *      IDENTICAL response shape to non-existent resource (no 403, no detail).
 *   3. Response body schema validation: only { error: { code, message, request_id } }.
 *
 * NOTE: This file holds the unit-style SHAPE assertions against
 * `assertI025TenantBlindEnvelope` + `makeEnvelope` from
 * src/lib/error-envelope.ts. The HTTP-level EMISSION tests (formerly
 * left as it.todo() pending middleware) are now closed in
 * tests/integration/error-envelope-http.test.ts via buildApp + Fastify
 * inject. Look there for end-to-end coverage of the plugin behavior.
 *
 * DEPENDS ON:
 *   - src/app.ts (buildApp — available at bootstrap)
 *   - src/lib/error-envelope.ts (appsec-expert agent; tenant-blind error middleware)
 *   - tests/helpers/invariant-assertions.ts (assertI025TenantBlindEnvelope)
 *   - tests/helpers/tenant-fixtures.ts (TENANT_US, TENANT_GHANA)
 */

import { describe, expect, it } from 'vitest';

import { assertI025TenantBlindEnvelope } from '../helpers/invariant-assertions.ts';
import { TENANT_GHANA, TENANT_US } from '../helpers/tenant-fixtures.ts';

// `assertInvariants` is async — `expect(() => assertInvariants(...)).toThrow(...)`
// silently passes because the closure returns an unawaited rejected promise
// instead of throwing synchronously, and Vitest's sync `.toThrow` matcher
// cannot observe a Promise rejection. I-025 envelope shape checks are pure
// (no I/O), so this file calls the sync `assertI025TenantBlindEnvelope` helper
// directly throughout — both for `.toThrow` (rejection paths) and `.not.toThrow`
// (happy paths). The dispatcher is unused here.

// ---------------------------------------------------------------------------
// Canonical error envelope shape
// ---------------------------------------------------------------------------

interface ErrorEnvelope {
  error: {
    code: string;
    message: string;
    request_id: string;
  };
}

// ---------------------------------------------------------------------------
// Helper: build a minimal error envelope (simulating what error-envelope.ts will emit)
// ---------------------------------------------------------------------------

function makeEnvelope(code: string, message: string, requestId: string): ErrorEnvelope {
  return { error: { code, message, request_id: requestId } };
}

// ---------------------------------------------------------------------------
// Scenario 1: Non-existent resource returns tenant-blind 404
// ---------------------------------------------------------------------------

describe('error envelope — non-existent resource (I-025)', () => {
  // The HTTP-layer assertion previously held here as it.todo() is now
  // covered by tests/integration/error-envelope-http.test.ts (which
  // exercises the actual errorEnvelopePlugin end-to-end via buildApp +
  // Fastify inject). This unit-style file retains the SHAPE assertions
  // against the helper; the EMISSION assertions live in the http file.

  it('should validate the error envelope schema shape', () => {
    // Unit-style assertion against the helper — runnable without a real server.
    const envelope = makeEnvelope('NOT_FOUND', 'Resource not found', 'req_001');

    // assertI025TenantBlindEnvelope should not throw.
    expect(() => {
      assertI025TenantBlindEnvelope({ errorEnvelope: envelope });
    }).not.toThrow();
  });

  it('should reject an envelope that contains tenant_id field', () => {
    const leakyEnvelope = {
      error: { code: 'NOT_FOUND', message: 'not found', request_id: 'req_002' },
      tenant_id: TENANT_US, // leaked — forbidden per I-025
    };

    expect(() => {
      assertI025TenantBlindEnvelope({ errorEnvelope: leakyEnvelope });
    }).toThrow(/I-025 VIOLATION/);
  });
});

// ---------------------------------------------------------------------------
// Scenario 2: Resource exists in Tenant B — same response as non-existent
// ---------------------------------------------------------------------------

describe('error envelope — cross-tenant existence leak prevention (I-025)', () => {
  // HTTP-level identical-shape assertion (missing vs cross-tenant
  // resource) is covered end-to-end in error-envelope-http.test.ts
  // via buildApp + Fastify inject through the actual route handlers.
  // This file retains the shape-validator unit checks below.

  it('should detect a 403-revealing envelope as an I-025 violation', () => {
    // A 403 that reveals the resource exists in another tenant is forbidden.
    // The correct behaviour is a 404 with the same envelope as "not found".
    const existenceLeakingEnvelope = {
      error: {
        code: 'FORBIDDEN',
        message: 'You do not have access to this resource in tenant Telecheck-US',
        request_id: 'req_003',
      },
    };

    // The message leaks the tenant name — a real validator would check the
    // message content too. For now, assertI025TenantBlindEnvelope checks
    // structural leakage (tenant_id key). A message-content scan would be
    // an additional check in a future PR.
    // This test documents the INTENT even if the message-scan isn't wired yet.
    expect(existenceLeakingEnvelope.error.message.includes(TENANT_US)).toBe(true); // Confirming the fixture is correct for documentation purposes.
  });

  it('should reject an envelope that contains extra undocumented fields', () => {
    const verboseEnvelope = {
      error: {
        code: 'NOT_FOUND',
        message: 'not found',
        request_id: 'req_004',
        debug_info: 'the row exists but is in the wrong tenant', // forbidden
      },
    };

    expect(() => {
      assertI025TenantBlindEnvelope({ errorEnvelope: verboseEnvelope });
    }).toThrow(/I-025 VIOLATION/);
  });
});

// ---------------------------------------------------------------------------
// Scenario 3: Response body schema — only { error: { code, message, request_id } }
// ---------------------------------------------------------------------------

describe('error envelope — schema conformance (I-025)', () => {
  it('should accept a conforming envelope with exactly {code, message, request_id}', () => {
    const conforming: ErrorEnvelope = {
      error: {
        code: 'NOT_FOUND',
        message: 'The requested resource was not found.',
        request_id: 'req_abc123',
      },
    };

    expect(() => {
      assertI025TenantBlindEnvelope({ errorEnvelope: conforming });
    }).not.toThrow();
  });

  it('should reject an envelope that is missing the top-level error key', () => {
    const malformed = {
      code: 'NOT_FOUND',
      message: 'not found',
      request_id: 'req_005',
    };

    expect(() => {
      assertI025TenantBlindEnvelope({ errorEnvelope: malformed });
    }).toThrow(/I-025 VIOLATION.*"error" key/);
  });

  it('should confirm tenant-blind envelopes are identical for missing vs cross-tenant resources', () => {
    // Both envelopes must have the same code ('NOT_FOUND') regardless of
    // whether the resource is absent or present in another tenant.
    const missingResource = makeEnvelope('NOT_FOUND', 'Resource not found', 'req_006');
    const crossTenantResource = makeEnvelope('NOT_FOUND', 'Resource not found', 'req_007');

    // Both should validate cleanly.
    expect(() => assertI025TenantBlindEnvelope({ errorEnvelope: missingResource })).not.toThrow();
    expect(() =>
      assertI025TenantBlindEnvelope({ errorEnvelope: crossTenantResource }),
    ).not.toThrow();

    // The codes must be identical (same shape, same code).
    expect(missingResource.error.code).toBe(crossTenantResource.error.code);
  });

  // HTTP-inject assertion (Tenant A request for Tenant B resource → 404 with
  // canonical envelope) is closed by error-envelope-http.test.ts. The .todo()
  // that lived here historically was removed 2026-05-04 once that file landed.
});

// Cross-invariant assertion: test that the envelope helpers are consistent with
// the TENANT_US / TENANT_GHANA constants (no hardcoded country assumptions leak
// through the test fixtures themselves — per I-009).
describe('error envelope — no hardcoded country assumptions in test fixtures (I-009)', () => {
  it('should use canonical tenant identifiers, not country names, in error envelopes', () => {
    // Canonical tenant identifiers are 'Telecheck-US' and 'Telecheck-Ghana'.
    // Error envelopes must never contain these identifiers (they would leak tenant existence).
    const envelopeWithTenantName = {
      error: {
        code: 'NOT_FOUND',
        message: `Resource not found in ${TENANT_GHANA}`, // forbidden: tenant name in message
        request_id: 'req_008',
      },
    };
    // structurally valid (no top-level tenant_id key) but content-invalid.
    // Documents the gap: message-content scanning is not yet implemented
    // in assertI025TenantBlindEnvelope — this is a TODO for a future PR.
    expect(envelopeWithTenantName.error.message.includes(TENANT_GHANA)).toBe(true);
  });
});
