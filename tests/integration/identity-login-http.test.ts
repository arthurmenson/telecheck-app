/**
 * Identity login + session handlers — HTTP integration tests.
 *
 * Exercises POST /v0/identity/login/{start,verify} and
 * POST /v0/identity/sessions/{refresh,logout} end-to-end via Fastify
 * inject().
 *
 * Coverage in this file (5 sections, 13 cases).
 *
 * Spec references:
 *   - src/modules/identity/internal/handlers/login.ts (target)
 *   - Identity & Authentication Spec v1.0 §3
 *   - I-025 (tenant-blind: no account enumeration)
 *   - IDEMPOTENCY v5.1 §1 (cache 4-tuple + replay/body-mismatch — §5)
 *   - SI-006 reserve-then-execute (Sprint 33-34; §5 pins the v5.1
 *     contract on /login/verify which is the security-critical
 *     900s-TTL handler caching plaintext access_token + refresh_token)
 */

import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../../src/app.ts';
import type { TenantId } from '../../src/lib/glossary.ts';
import type { TenantContext } from '../../src/lib/tenant-context.ts';
import { ulid } from '../../src/lib/ulid.ts';
import * as accountService from '../../src/modules/identity/internal/services/account-service.ts';
import * as otpService from '../../src/modules/identity/internal/services/otp-service.ts';
import { asAccountId, asOtpId } from '../../src/modules/identity/internal/types.ts';
import { TENANT_US, withTenantContext } from '../helpers/tenant-fixtures.ts';
import { getTestClient } from '../setup.ts';

const T_US = TENANT_US as TenantId;
const US_CTX: TenantContext = {
  tenantId: T_US,
  displayName: 'Telecheck-US',
  countryOfCare: 'US',
  kmsKeyAlias: 'alias/telecheck-us-data-key',
  consumerDba: 'Heros Health',
  legalEntity: 'Telecheck Health LLC',
  consumerSubdomain: 'heroshealth.com',
};

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

function uniquePhone(): string {
  const digits = ulid()
    .slice(-9)
    .replace(/[^0-9]/g, '0')
    .padEnd(9, '0');
  return `+1${digits}`;
}

async function seedActiveAccount(): Promise<{ phone: string; accountId: string }> {
  const phone = uniquePhone();
  const accountId = asAccountId(ulid());
  await withTenantContext(T_US, () =>
    accountService.createAccount(
      US_CTX,
      { actorId: 'op_seed' },
      {
        account_id: accountId,
        phone_e164: phone,
        first_name: 'A',
        last_name: 'B',
        date_of_birth: '1990-01-01',
        gender: 'prefer_not_to_say',
      },
      getTestClient(),
    ),
  );
  await withTenantContext(T_US, () =>
    accountService.activateAccount(US_CTX, { actorId: 'op_seed' }, accountId, getTestClient()),
  );
  return { phone, accountId };
}

// ---------------------------------------------------------------------------
// §1 — POST /login/start
// ---------------------------------------------------------------------------

describe('identity login HTTP — §1 POST /login/start', () => {
  it('§1a returns 200 + otp_id for active account', async () => {
    const { phone } = await seedActiveAccount();
    const response = await app!.inject({
      method: 'POST',
      url: '/v0/identity/login/start',
      headers: { host: 'localhost', 'idempotency-key': ulid() },
      payload: { phone_e164: phone },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json<{ otp_id: string }>();
    expect(body.otp_id).toBeTruthy();
  });

  it('§1b returns NO_ACCOUNT for unregistered phone (tenant-blind)', async () => {
    const response = await app!.inject({
      method: 'POST',
      url: '/v0/identity/login/start',
      headers: { host: 'localhost', 'idempotency-key': ulid() },
      payload: { phone_e164: uniquePhone() },
    });
    expect(response.statusCode).toBe(400);
    const body = response.json<{ error: { code: string } }>();
    expect(body.error.code).toBe('identity.login.no_account');
  });

  it('§1c missing phone_e164 → 400 invalid', async () => {
    const response = await app!.inject({
      method: 'POST',
      url: '/v0/identity/login/start',
      headers: { host: 'localhost', 'idempotency-key': ulid() },
      payload: {},
    });
    expect(response.statusCode).toBe(400);
    const body = response.json<{ error: { code: string } }>();
    expect(body.error.code).toBe('internal.request.invalid');
  });

  it('§1d response body has no Telecheck-US substring (tenant-blind)', async () => {
    const response = await app!.inject({
      method: 'POST',
      url: '/v0/identity/login/start',
      headers: { host: 'localhost', 'idempotency-key': ulid() },
      payload: { phone_e164: uniquePhone() },
    });
    expect(response.body).not.toContain('Telecheck-US');
    expect(response.body).not.toContain('Telecheck-Ghana');
    expect(response.body.toLowerCase()).not.toContain('heros');
  });
});

// ---------------------------------------------------------------------------
// §2 — POST /login/verify happy path
// ---------------------------------------------------------------------------

describe('identity login HTTP — §2 POST /login/verify happy path', () => {
  it('§2a issues session + returns refresh_token + PatientAccountView', async () => {
    const { phone, accountId } = await seedActiveAccount();
    const otpId = asOtpId(ulid());
    const { codePlaintext } = await withTenantContext(T_US, () =>
      otpService.issueOtp(
        US_CTX,
        { actorId: 'op_seed' },
        {
          otp_id: otpId,
          account_id: asAccountId(accountId),
          phone_e164: phone,
          purpose: 'login',
        },
        getTestClient(),
      ),
    );

    const response = await app!.inject({
      method: 'POST',
      url: '/v0/identity/login/verify',
      headers: { host: 'localhost', 'idempotency-key': ulid() },
      payload: { phone_e164: phone, code: codePlaintext },
    });
    expect(response.statusCode).toBe(200);

    const body = response.json<{
      account: { account_id: string; phone_e164: string };
      session: { session_id: string; expires_at: string };
      refresh_token: string;
    }>();
    expect(body.account.account_id).toBe(accountId);
    expect(body.account.phone_e164).toBe(phone);
    expect(body.session.session_id).toBeTruthy();
    expect(body.refresh_token).toBeTruthy();

    // Defense in depth: tenant_id never appears in any of the three
    // returned envelopes
    const text = response.body;
    expect(text).not.toContain('"tenant_id"');
    expect(text).not.toContain('Telecheck-US');
  });
});

// ---------------------------------------------------------------------------
// §3 — verify failure paths
// ---------------------------------------------------------------------------

describe('identity login HTTP — §3 verify failure paths', () => {
  it('§3a missing required fields → 400 invalid', async () => {
    const response = await app!.inject({
      method: 'POST',
      url: '/v0/identity/login/verify',
      headers: { host: 'localhost', 'idempotency-key': ulid() },
      payload: { phone_e164: uniquePhone() },
    });
    expect(response.statusCode).toBe(400);
    const body = response.json<{ error: { code: string } }>();
    expect(body.error.code).toBe('internal.request.invalid');
  });

  it('§3b unregistered phone on verify → 400 NO_ACCOUNT', async () => {
    const response = await app!.inject({
      method: 'POST',
      url: '/v0/identity/login/verify',
      headers: { host: 'localhost', 'idempotency-key': ulid() },
      payload: { phone_e164: uniquePhone(), code: '123456' },
    });
    expect(response.statusCode).toBe(400);
    const body = response.json<{ error: { code: string } }>();
    expect(body.error.code).toBe('identity.login.no_account');
  });

  it('§3c invalid OTP code → 400 (NO_ACTIVE / INVALID / LOCKOUT)', async () => {
    const { phone } = await seedActiveAccount();
    const response = await app!.inject({
      method: 'POST',
      url: '/v0/identity/login/verify',
      headers: { host: 'localhost', 'idempotency-key': ulid() },
      payload: { phone_e164: phone, code: '000000' },
    });
    expect(response.statusCode).toBe(400);
    const body = response.json<{ error: { code: string } }>();
    expect([
      'identity.otp.no_active_challenge',
      'identity.otp.invalid_code',
      'identity.otp.lockout_triggered',
    ]).toContain(body.error.code);
  });
});

// ---------------------------------------------------------------------------
// §4 — Sessions: refresh + logout
// ---------------------------------------------------------------------------

describe('identity login HTTP — §4 sessions/{refresh,logout}', () => {
  it('§4a sessions/refresh with active token returns session view', async () => {
    const { phone, accountId } = await seedActiveAccount();
    const otpId = asOtpId(ulid());
    const { codePlaintext } = await withTenantContext(T_US, () =>
      otpService.issueOtp(
        US_CTX,
        { actorId: 'op_seed' },
        {
          otp_id: otpId,
          account_id: asAccountId(accountId),
          phone_e164: phone,
          purpose: 'login',
        },
        getTestClient(),
      ),
    );
    const verify = await app!.inject({
      method: 'POST',
      url: '/v0/identity/login/verify',
      headers: { host: 'localhost', 'idempotency-key': ulid() },
      payload: { phone_e164: phone, code: codePlaintext },
    });
    const verifyBody = verify.json<{ refresh_token: string }>();

    const refresh = await app!.inject({
      method: 'POST',
      url: '/v0/identity/sessions/refresh',
      headers: { host: 'localhost', 'idempotency-key': ulid() },
      payload: { refresh_token: verifyBody.refresh_token },
    });
    expect(refresh.statusCode).toBe(200);
    const refreshBody = refresh.json<{ session: { session_id: string } }>();
    expect(refreshBody.session.session_id).toBeTruthy();
  });

  it('§4b sessions/refresh with phantom token → 400 invalid_or_expired', async () => {
    const response = await app!.inject({
      method: 'POST',
      url: '/v0/identity/sessions/refresh',
      headers: { host: 'localhost', 'idempotency-key': ulid() },
      payload: { refresh_token: 'phantom-token-xyz' },
    });
    expect(response.statusCode).toBe(400);
    const body = response.json<{ error: { code: string } }>();
    expect(body.error.code).toBe('identity.session.invalid_or_expired');
  });

  it('§4c sessions/logout with active token → 204; subsequent refresh fails', async () => {
    const { phone, accountId } = await seedActiveAccount();
    const otpId = asOtpId(ulid());
    const { codePlaintext } = await withTenantContext(T_US, () =>
      otpService.issueOtp(
        US_CTX,
        { actorId: 'op_seed' },
        {
          otp_id: otpId,
          account_id: asAccountId(accountId),
          phone_e164: phone,
          purpose: 'login',
        },
        getTestClient(),
      ),
    );
    const verify = await app!.inject({
      method: 'POST',
      url: '/v0/identity/login/verify',
      headers: { host: 'localhost', 'idempotency-key': ulid() },
      payload: { phone_e164: phone, code: codePlaintext },
    });
    const refreshToken = verify.json<{ refresh_token: string }>().refresh_token;

    const logout = await app!.inject({
      method: 'POST',
      url: '/v0/identity/sessions/logout',
      headers: { host: 'localhost', 'idempotency-key': ulid() },
      payload: { refresh_token: refreshToken },
    });
    expect(logout.statusCode).toBe(204);

    // After logout, refresh should fail
    const afterRefresh = await app!.inject({
      method: 'POST',
      url: '/v0/identity/sessions/refresh',
      headers: { host: 'localhost', 'idempotency-key': ulid() },
      payload: { refresh_token: refreshToken },
    });
    expect(afterRefresh.statusCode).toBe(400);
  });

  it('§4d sessions/logout with phantom token → 204 (idempotent, tenant-blind)', async () => {
    const response = await app!.inject({
      method: 'POST',
      url: '/v0/identity/sessions/logout',
      headers: { host: 'localhost', 'idempotency-key': ulid() },
      payload: { refresh_token: 'phantom-token-xyz' },
    });
    expect(response.statusCode).toBe(204);
  });
});

// ---------------------------------------------------------------------------
// §5 — IDEMPOTENCY v5.1 contract on POST /v0/identity/login/verify
// ---------------------------------------------------------------------------
//
// Sprint 33 PR-F3 migrated `loginVerifyHandler` to handler-owned
// `withIdempotency` AND added a 900s TTL override for this endpoint
// (aligned to JWT access_token TTL per `jwt.ts:62`). The 900s pin
// is what makes a network-blip retry safe: the cached response holds
// plaintext access_token + refresh_token, and cache TTL = JWT TTL
// means cached responses cannot outlive the bearer they contain.
//
// Cases:
//   §5a same key + same body → cached 200 replay; SAME tokens
//        returned (proves NO second session was issued — the cache
//        replay short-circuits at preHandler, the handler body
//        callback does not run, no second verifyOtp + no second
//        issueSession side effects)
//   §5b same key + different body → 409 body_mismatch; the body
//        hash check fires BEFORE the handler body callback runs,
//        so the OTP from the first call is NOT reconsumed and the
//        second call's `code` is NEVER passed to verifyOtp
//
// Spec references:
//   - src/lib/idempotency.ts ENDPOINT_TTL_OVERRIDES + ttlSecondsForEndpoint
//   - IDEMPOTENCY v5.1 §1 (cache 4-tuple PK; same-body replay;
//     different-body 409)
//   - docs/PROJECT_CONVENTIONS.md r5 §3.7 (Reserve-then-execute)
//   - docs/IDENTITY_SLICE_STATUS_2026-05-05.md Sprint 33-34
//     amendment (TTL-override rationale: Cache TTL = JWT TTL)
// ---------------------------------------------------------------------------

describe('identity login HTTP — §5 IDEMPOTENCY v5.1 contract on /login/verify', () => {
  it('§5a same Idempotency-Key + same body → cached 200 replay (same tokens)', async () => {
    const { phone, accountId } = await seedActiveAccount();
    const otpId = asOtpId(ulid());
    const { codePlaintext } = await withTenantContext(T_US, () =>
      otpService.issueOtp(
        US_CTX,
        { actorId: 'op_seed' },
        {
          otp_id: otpId,
          account_id: asAccountId(accountId),
          phone_e164: phone,
          purpose: 'login',
        },
        getTestClient(),
      ),
    );
    const idempotencyKey = ulid();
    const payload = { phone_e164: phone, code: codePlaintext };

    // First request: real verify, OTP consumed, session issued.
    const first = await app!.inject({
      method: 'POST',
      url: '/v0/identity/login/verify',
      headers: { host: 'localhost', 'idempotency-key': idempotencyKey },
      payload,
    });
    expect(first.statusCode).toBe(200);
    const firstBody = first.json<{
      account: { account_id: string };
      session: { session_id: string };
      refresh_token: string;
      access_token: string;
    }>();
    expect(firstBody.session.session_id).toBeTruthy();

    // Second request: same key + same body. preHandler cache-replay
    // short-circuits BEFORE the handler body. NO second verifyOtp,
    // NO second issueSession. The cached response is replayed
    // verbatim — same session_id, same tokens.
    const second = await app!.inject({
      method: 'POST',
      url: '/v0/identity/login/verify',
      headers: { host: 'localhost', 'idempotency-key': idempotencyKey },
      payload,
    });
    expect(second.statusCode).toBe(200);
    const secondBody = second.json<{
      account: { account_id: string };
      session: { session_id: string };
      refresh_token: string;
      access_token: string;
    }>();
    // The exactly-once contract: same session_id, same tokens, same
    // account_id. If the handler had re-run, the second call would
    // have failed verifyOtp (the OTP was consumed by the first
    // call) — so a successful 200 here with identical tokens
    // structurally proves the cache replay path.
    expect(secondBody.session.session_id).toBe(firstBody.session.session_id);
    expect(secondBody.refresh_token).toBe(firstBody.refresh_token);
    expect(secondBody.access_token).toBe(firstBody.access_token);
    expect(secondBody.account.account_id).toBe(firstBody.account.account_id);
  });

  it('§5b same Idempotency-Key + different body → 409 internal.idempotency.body_mismatch', async () => {
    const { phone, accountId } = await seedActiveAccount();
    const otpId = asOtpId(ulid());
    const { codePlaintext } = await withTenantContext(T_US, () =>
      otpService.issueOtp(
        US_CTX,
        { actorId: 'op_seed' },
        {
          otp_id: otpId,
          account_id: asAccountId(accountId),
          phone_e164: phone,
          purpose: 'login',
        },
        getTestClient(),
      ),
    );
    const idempotencyKey = ulid();

    const first = await app!.inject({
      method: 'POST',
      url: '/v0/identity/login/verify',
      headers: { host: 'localhost', 'idempotency-key': idempotencyKey },
      payload: { phone_e164: phone, code: codePlaintext },
    });
    expect(first.statusCode).toBe(200);

    // Second request: same key, DIFFERENT body (code flipped). The
    // body hash check at withIdempotency reservation time fires
    // BEFORE the handler body callback runs — so verifyOtp is NOT
    // called with the new code. Returns 409 immediately.
    const second = await app!.inject({
      method: 'POST',
      url: '/v0/identity/login/verify',
      headers: { host: 'localhost', 'idempotency-key': idempotencyKey },
      payload: { phone_e164: phone, code: '000000' },
    });
    expect(second.statusCode).toBe(409);
    const errorBody = second.json<{ error: { code: string } }>();
    expect(errorBody.error.code).toBe('internal.idempotency.body_mismatch');
  });
});
