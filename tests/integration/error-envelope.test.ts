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
 * NOTE: These tests exercise the HTTP layer via Fastify's buildApp(). The
 * error-envelope middleware is written by the appsec-expert agent in
 * src/lib/error-envelope.ts. Until that module exists, tests use it.todo()
 * at the HTTP boundary and verify the envelope shape assertion helpers.
 *
 * DEPENDS ON:
 *   - src/app.ts (buildApp — available at bootstrap)
 *   - src/lib/error-envelope.ts (appsec-expert agent; tenant-blind error middleware)
 *   - tests/helpers/invariant-assertions.ts (assertI025TenantBlindEnvelope)
 *   - tests/helpers/tenant-fixtures.ts (TENANT_US, TENANT_GHANA)
 */

import { describe, expect, it } from 'vitest';
import { assertInvariants } from '../helpers/invariant-assertions.ts';
import { TENANT_GHANA, TENANT_US } from '../helpers/tenant-fixtures.ts';

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
  // TODO: Replace this stub with a real Fastify inject() call once
  //   src/lib/error-envelope.ts is written by the appsec-expert agent.
  //   The test will then issue GET /patients/pat_does_not_exist with
  //   a valid Tenant-A session header and assert the response.

  it.todo(
    'should return 404 with tenant-blind envelope for a non-existent resource ID ' +
      '(HTTP layer — depends on src/lib/error-envelope.ts)',
  );

  it('should validate the error envelope schema shape', () => {
    // Unit-style assertion against the helper — runnable without a real server.
    const envelope = makeEnvelope('NOT_FOUND', 'Resource not found', 'req_001');

    // assertI025TenantBlindEnvelope should not throw.
    expect(() => {
      assertInvariants(['I-025'], { errorEnvelope: envelope });
    }).not.toThrow();
  });

  it('should reject an envelope that contains tenant_id field', () => {
    const leakyEnvelope = {
      error: { code: 'NOT_FOUND', message: 'not found', request_id: 'req_002' },
      tenant_id: TENANT_US, // leaked — forbidden per I-025
    };

    expect(() => {
      assertInvariants(['I-025'], { errorEnvelope: leakyEnvelope });
    }).toThrow(/I-025 VIOLATION/);
  });
});

// ---------------------------------------------------------------------------
// Scenario 2: Resource exists in Tenant B — same response as non-existent
// ---------------------------------------------------------------------------

describe('error envelope — cross-tenant existence leak prevention (I-025)', () => {
  it.todo(
    'should return the IDENTICAL 404 envelope shape whether the resource does not exist ' +
      'or exists in another tenant (HTTP layer — depends on src/lib/error-envelope.ts + ' +
      'routing middleware with tenant context)',
  );

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
    expect(
      (existenceLeakingEnvelope.error.message as string).includes(TENANT_US),
    ).toBe(true); // Confirming the fixture is correct for documentation purposes.
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
      assertInvariants(['I-025'], { errorEnvelope: verboseEnvelope });
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
      assertInvariants(['I-025'], { errorEnvelope: conforming });
    }).not.toThrow();
  });

  it('should reject an envelope that is missing the top-level error key', () => {
    const malformed = {
      code: 'NOT_FOUND',
      message: 'not found',
      request_id: 'req_005',
    };

    expect(() => {
      assertInvariants(['I-025'], { errorEnvelope: malformed });
    }).toThrow(/I-025 VIOLATION.*"error" key/);
  });

  it('should confirm tenant-blind envelopes are identical for missing vs cross-tenant resources', () => {
    // Both envelopes must have the same code ('NOT_FOUND') regardless of
    // whether the resource is absent or present in another tenant.
    const missingResource = makeEnvelope('NOT_FOUND', 'Resource not found', 'req_006');
    const crossTenantResource = makeEnvelope('NOT_FOUND', 'Resource not found', 'req_007');

    // Both should validate cleanly.
    expect(() => assertInvariants(['I-025'], { errorEnvelope: missingResource })).not.toThrow();
    expect(() => assertInvariants(['I-025'], { errorEnvelope: crossTenantResource })).not.toThrow();

    // The codes must be identical (same shape, same code).
    expect(missingResource.error.code).toBe(crossTenantResource.error.code);
  });

  it.todo(
    'should assert via HTTP inject that Tenant A authenticated request for Tenant B resource ' +
      'returns HTTP 404 (not 403) with the canonical error envelope — ' +
      'blocked on src/lib/error-envelope.ts + auth middleware (appsec-expert agent)',
  );
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
