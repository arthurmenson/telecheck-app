/**
 * jwt-fixtures.ts — Test-only JWT minting helper.
 *
 * Replaces the Tier 2 `x-actor-id` / `x-patient-id` header shim in
 * integration tests with direct JWT issuance via `issueAccessToken` from
 * src/lib/jwt.ts. Tests that exercise authenticated endpoints can use
 * this helper to mint a token with the required actor identity + role
 * without going through the full OTP / login round-trip (which exists in
 * `tests/integration/identity-jwt-end-to-end.test.ts` as the canonical
 * end-to-end coverage).
 *
 * Why direct JWT minting in tests (and not a full login round-trip per
 * test case):
 *   - The login round-trip exists ONCE in the identity-jwt-end-to-end
 *     test, which is the canonical coverage for the auth flow itself.
 *   - Every other test cares about the SURFACE under test (forms-intake,
 *     consent, pharmacy, etc.), not the auth flow. Going through OTP
 *     for every test inflates wall-clock dramatically + couples those
 *     suites to the Identity slice's internals.
 *   - The JWT signing key is the same in test + dev (`config.jwtSigningKey`
 *     from `.env.test` / fallback). Minting directly produces a valid
 *     JWT identical in shape to the login-issued one.
 *
 * ## Trust-boundary note (Codex PR #133 R1 HIGH discussion 2026-05-14)
 *
 * This helper mints tokens with a SYNTHETIC `session_id` (a fresh ULID
 * by default) WITHOUT seeding a row in the `sessions` table or
 * confirming the `account_id` exists in the `accounts` table. This is
 * an intentional parity with the current production
 * `authContextPlugin` behavior:
 *
 *   - **Production verification path** (`src/lib/auth-context.ts`)
 *     verifies the JWT signature + expiry + tenant_id-claim-vs-
 *     request-tenant match. It does NOT consult the sessions table on
 *     every request (by design — the JWT itself is the per-request
 *     cache; session liveness is enforced by the 15-minute JWT TTL +
 *     the login-flow's session creation).
 *   - Therefore a JWT signed with the canonical key + correct tenant
 *     match + non-expired exp will authenticate in production even if
 *     the underlying session row has been deleted post-issuance.
 *   - This helper produces tokens with identical semantic shape to
 *     production-issued tokens. The synthetic `session_id` is
 *     indistinguishable from a production-issued one as far as the
 *     verification hook is concerned.
 *
 * **When this matters / when this helper needs to evolve:** if a
 * future PR adds session-liveness checking (e.g., a denylist of
 * revoked sessions consulted on every auth hook invocation, or a
 * direct sessions-table lookup), this helper will need a DB-backed
 * companion that seeds a `sessions` row before minting. Until then,
 * tests using this helper exercise the same trust boundary as
 * production.
 *
 * **Canonical end-to-end coverage:** `tests/integration/identity-jwt-
 * end-to-end.test.ts` exercises the full OTP → login → JWT → forms-
 * intake-call path. That test is the proof-of-correctness for the
 * end-to-end auth flow; all other tests are surface-focused and use
 * this helper for token-shape parity without paying the OTP-flow cost
 * per case.
 *
 * Spec references:
 *   - Identity & Authentication Spec v1.0 §3.3 (token claims)
 *   - I-023 (tenant_id is a JWT claim; verified against request tenant ctx)
 *   - I-025 (tenant-blind 401 envelope)
 *   - src/lib/jwt.ts (issueAccessToken — the production issuance path)
 *   - src/lib/auth-context.ts (authContextPlugin — the verification hook)
 *   - tests/integration/identity-jwt-end-to-end.test.ts (canonical
 *     end-to-end coverage via real OTP / login flow)
 */

import { config } from '../../src/lib/config.js';
import type { TenantId } from '../../src/lib/glossary.js';
import { issueAccessToken, type AccessTokenRole } from '../../src/lib/jwt.js';
import { ulid } from '../../src/lib/ulid.js';

/**
 * Inputs for minting a test JWT.
 *
 * All fields are required EXCEPT `sessionId` (auto-generated as a fresh
 * ULID per call) and `delegateId` (defaults to null for non-delegate
 * test cases). This matches the production semantics where the
 * session-service issues a session row + binds it to the JWT.
 */
export interface MintTestJwtInput {
  /** The authenticated patient/clinician account_id. */
  accountId: string;
  /** Tenant the actor is acting within. */
  tenantId: TenantId;
  /**
   * Country-of-care for the actor's session per CCR. Defaults are NOT
   * provided — tests must specify so cross-CCR test cases (Telecheck-US
   * vs Telecheck-Ghana) don't accidentally inherit a stale value.
   */
  countryOfCare: 'US' | 'GH';
  /**
   * Role for this session. Patient and clinician supported at v1.0;
   * admin roles (tenant_admin, platform_admin) land when the Identity
   * slice extends `AccessTokenRole` past TLC-058.
   */
  role: AccessTokenRole;
  /**
   * Session ID. Optional — defaults to a fresh ULID. Tests that need
   * to assert on the session_id claim (e.g., session-revocation tests)
   * can supply a known value.
   */
  sessionId?: string;
  /**
   * Delegate context for tests exercising delegated-access surfaces.
   * Defaults to null (non-delegate session — the common case).
   */
  delegateId?: string | null;
}

/**
 * Mint a JWT access token for use in integration tests.
 *
 * Returns a three-segment HS256 JWT string suitable for use as the
 * `Authorization: Bearer <token>` header value. The signing key is
 * `config.jwtSigningKey` — the same key the production verification
 * hook (`authContextPlugin`) uses, so minted tokens verify cleanly.
 *
 * @example
 *   const token = mintTestJwt({
 *     accountId: 'acct_abc',
 *     tenantId: T_US,
 *     countryOfCare: 'US',
 *     role: 'patient',
 *   });
 *   const response = await app.inject({
 *     method: 'POST',
 *     url: '/v0/forms/submissions',
 *     headers: {
 *       host: US_HOST,
 *       authorization: `Bearer ${token}`,
 *     },
 *     payload: {...},
 *   });
 */
export function mintTestJwt(input: MintTestJwtInput): string {
  return issueAccessToken(
    {
      account_id: input.accountId,
      tenant_id: input.tenantId,
      session_id: input.sessionId ?? ulid(),
      role: input.role,
      country_of_care: input.countryOfCare,
      ...(input.delegateId !== undefined ? { delegate_id: input.delegateId } : {}),
    },
    config.jwtSigningKey,
  );
}

/**
 * Convenience: build an `Authorization: Bearer <token>` header value
 * directly. Saves callers from repeating the template string in every
 * test case.
 *
 * @example
 *   const response = await app.inject({
 *     method: 'POST',
 *     url: '/v0/forms/submissions',
 *     headers: {
 *       host: US_HOST,
 *       ...bearerAuthHeader({ accountId, tenantId: T_US, countryOfCare: 'US', role: 'patient' }),
 *     },
 *     payload: {...},
 *   });
 */
export function bearerAuthHeader(input: MintTestJwtInput): { authorization: string } {
  return { authorization: `Bearer ${mintTestJwt(input)}` };
}
