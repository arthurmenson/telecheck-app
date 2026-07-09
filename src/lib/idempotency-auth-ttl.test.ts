/**
 * idempotency-auth-ttl.test.ts — regression guard for the sensitive-response
 * TTL override map (Codex round-10 HIGH, email+PIN auth path).
 *
 * Any identity endpoint whose idempotency-cached response body contains a
 * plaintext bearer token (access_token / refresh_token) MUST resolve to the
 * 900s = access_token-TTL cap, never the 24h DEFAULT_TTL_SECONDS. A new
 * token-returning endpoint that forgets its override silently extends
 * plaintext-token dwell time in `idempotency_keys` by 96x — this test fails
 * closed on that mistake.
 */
import { describe, expect, it } from 'vitest';
import { ttlSecondsForEndpoint } from './idempotency.js';

// 900s = JWT ACCESS_TOKEN_TTL_SECONDS (jwt.ts). The exact cap for any body
// carrying a bearer token.
const SENSITIVE_TTL = 900;
const DEFAULT_TTL = 86400;

// Every identity endpoint that issues a session and returns access_token +
// refresh_token in its response body. Add a row here whenever a new
// token-returning endpoint ships — and it MUST resolve to SENSITIVE_TTL.
const TOKEN_RETURNING_IDENTITY_ENDPOINTS = [
  '/v0/identity/login/verify', // phone OTP login
  '/v0/identity/registration/verify', // phone OTP registration
  '/v0/identity/registration/email/verify', // email+PIN registration (migration 078)
  '/v0/identity/login/pin', // email+PIN login (migration 078)
];

describe('idempotency sensitive-response TTL — token-returning endpoints', () => {
  it.each(TOKEN_RETURNING_IDENTITY_ENDPOINTS)(
    '%s resolves to the 900s access-token cap, not the 24h default',
    (endpoint) => {
      expect(ttlSecondsForEndpoint(endpoint)).toBe(SENSITIVE_TTL);
    },
  );

  it('a non-token identity endpoint falls through to the 24h default', () => {
    // registration/email/start returns only { status: 'ok' } (no tokens), so
    // it is not in the override map and uses the default TTL. This anchors the
    // test against a false pass where every path returns 900.
    expect(ttlSecondsForEndpoint('/v0/identity/registration/email/start')).toBe(DEFAULT_TTL);
  });

  it('path normalization keeps the cap for case / trailing-slash variants', () => {
    expect(ttlSecondsForEndpoint('/v0/identity/login/pin/')).toBe(SENSITIVE_TTL);
    expect(ttlSecondsForEndpoint('/V0/Identity/Login/Pin')).toBe(SENSITIVE_TTL);
  });
});
