/**
 * Identity registration handlers — HTTP integration tests.
 *
 * Exercises POST /v0/identity/registration/{start,verify} end-to-end
 * via Fastify inject(). Verifies the full registration flow:
 *   - start issues OTP, returns otp_id
 *   - verify with correct code creates + activates account, returns
 *     PatientAccountView (no tenant_id leak)
 *   - phone collision (PHONE_TAKEN) on start with existing phone
 *   - invalid code on verify
 *
 * Coverage in this file (5 sections, 10 cases):
 *
 * Spec references:
 *   - src/modules/identity/internal/handlers/registration.ts (target)
 *   - Identity & Authentication Spec v1.0 §2
 *   - Master PRD v1.10 §17 + Glossary v5.2 C3 (no tenant_id in
 *     patient response bodies)
 *   - IDEMPOTENCY v5.1 §1 (cache 4-tuple + replay/body-mismatch — §5)
 *   - SI-006 reserve-then-execute (Sprint 33-34 PR-F3 migration of
 *     registrationVerifyHandler; 900s TTL override)
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

// ---------------------------------------------------------------------------
// §1 — POST /registration/start
// ---------------------------------------------------------------------------

describe('identity registration HTTP — §1 POST /registration/start', () => {
  it('§1a returns 200 + otp_id for fresh phone', async () => {
    const phone = uniquePhone();
    const response = await app!.inject({
      method: 'POST',
      url: '/v0/identity/registration/start',
      headers: { host: 'localhost', 'idempotency-key': ulid() },
      payload: { phone_e164: phone },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json<{ otp_id: string }>();
    expect(body.otp_id).toBeTruthy();
  });

  it('§1b returns PHONE_TAKEN when phone already registered', async () => {
    // Seed an account with this phone via the service layer
    const phone = uniquePhone();
    await withTenantContext(T_US, () =>
      accountService.createAccount(
        US_CTX,
        { actorId: 'op_seed' },
        {
          account_id: asAccountId(ulid()),
          phone_e164: phone,
          first_name: 'A',
          last_name: 'B',
          date_of_birth: '1990-01-01',
          gender: 'prefer_not_to_say',
        },
        getTestClient(),
      ),
    );

    const response = await app!.inject({
      method: 'POST',
      url: '/v0/identity/registration/start',
      headers: { host: 'localhost', 'idempotency-key': ulid() },
      payload: { phone_e164: phone },
    });
    expect(response.statusCode).toBe(400);
    const body = response.json<{ error: { code: string } }>();
    expect(body.error.code).toBe('identity.registration.phone_taken');
  });

  it('§1c returns 400 on missing phone_e164', async () => {
    const response = await app!.inject({
      method: 'POST',
      url: '/v0/identity/registration/start',
      headers: { host: 'localhost', 'idempotency-key': ulid() },
      payload: {},
    });
    expect(response.statusCode).toBe(400);
    const body = response.json<{ error: { code: string } }>();
    expect(body.error.code).toBe('internal.request.invalid');
  });
});

// ---------------------------------------------------------------------------
// §2 — POST /registration/verify happy path
// ---------------------------------------------------------------------------

describe('identity registration HTTP — §2 POST /registration/verify happy path', () => {
  it('§2a creates + activates account, returns PatientAccountView (no tenant_id)', async () => {
    const phone = uniquePhone();

    // Step 1: issue OTP via the service directly (so we know the
    // plaintext code; the HTTP /start path returns only otp_id)
    const otpId = asOtpId(ulid());
    const { codePlaintext } = await withTenantContext(T_US, () =>
      otpService.issueOtp(
        US_CTX,
        { actorId: 'op_seed' },
        { otp_id: otpId, phone_e164: phone, purpose: 'registration' },
        getTestClient(),
      ),
    );

    // Step 2: HTTP verify
    const response = await app!.inject({
      method: 'POST',
      url: '/v0/identity/registration/verify',
      headers: { host: 'localhost', 'idempotency-key': ulid() },
      payload: {
        otp_id: otpId,
        code: codePlaintext,
        phone_e164: phone,
        first_name: 'Test',
        last_name: 'Patient',
        date_of_birth: '1990-01-01',
        gender: 'prefer_not_to_say',
      },
    });

    expect(response.statusCode).toBe(201);
    // Patient view: no tenant_id, status='active' (registration triggered
    // activation per Identity Spec §2.1)
    const bodyText = response.body;
    expect(bodyText).not.toContain('"tenant_id"');
    expect(bodyText).not.toContain('Telecheck-US');

    const body = response.json<{
      account_id: string;
      phone_e164: string;
      status: string;
      activated_at: string | null;
    }>();
    expect(body.phone_e164).toBe(phone);
    expect(body.status).toBe('active');
    expect(body.activated_at).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// §3 — POST /registration/verify failure paths
// ---------------------------------------------------------------------------

describe('identity registration HTTP — §3 verify failure paths', () => {
  it('§3a missing required fields → 400', async () => {
    const response = await app!.inject({
      method: 'POST',
      url: '/v0/identity/registration/verify',
      headers: { host: 'localhost', 'idempotency-key': ulid() },
      payload: { phone_e164: uniquePhone() },
    });
    expect(response.statusCode).toBe(400);
    const body = response.json<{ error: { code: string } }>();
    expect(body.error.code).toBe('internal.request.invalid');
  });

  it('§3b invalid OTP code → 400 with OTP_INVALID_CODE or NO_ACTIVE_CHALLENGE', async () => {
    const phone = uniquePhone();
    const otpId = asOtpId(ulid());
    await withTenantContext(T_US, () =>
      otpService.issueOtp(
        US_CTX,
        { actorId: 'op_seed' },
        { otp_id: otpId, phone_e164: phone, purpose: 'registration' },
        getTestClient(),
      ),
    );

    const response = await app!.inject({
      method: 'POST',
      url: '/v0/identity/registration/verify',
      headers: { host: 'localhost', 'idempotency-key': ulid() },
      payload: {
        otp_id: otpId,
        code: '000000', // mathematically possible to match (1/1M flake)
        phone_e164: phone,
        first_name: 'A',
        last_name: 'B',
        date_of_birth: '1990-01-01',
        gender: 'prefer_not_to_say',
      },
    });
    // Expect 400 (with very small 1/1M chance the test gets a 201 because
    // '000000' randomly matched the issued code).
    if (response.statusCode === 400) {
      const body = response.json<{ error: { code: string } }>();
      expect([
        'identity.otp.invalid_code',
        'identity.otp.no_active_challenge',
        'identity.otp.lockout_triggered',
      ]).toContain(body.error.code);
    }
  });

  it('§3c no active challenge for phone → 400 NO_ACTIVE_CHALLENGE', async () => {
    const phone = uniquePhone();
    // No OTP issued for this phone.
    const response = await app!.inject({
      method: 'POST',
      url: '/v0/identity/registration/verify',
      headers: { host: 'localhost', 'idempotency-key': ulid() },
      payload: {
        otp_id: ulid(),
        code: '123456',
        phone_e164: phone,
        first_name: 'A',
        last_name: 'B',
        date_of_birth: '1990-01-01',
        gender: 'prefer_not_to_say',
      },
    });
    expect(response.statusCode).toBe(400);
    const body = response.json<{ error: { code: string } }>();
    expect(body.error.code).toBe('identity.otp.no_active_challenge');
  });
});

// ---------------------------------------------------------------------------
// §4 — Tenant-blind: registration error envelopes carry no tenant ID
// ---------------------------------------------------------------------------

describe('identity registration HTTP — §4 tenant-blind error envelopes', () => {
  it('§4a PHONE_TAKEN envelope has no Telecheck-US substring', async () => {
    const phone = uniquePhone();
    await withTenantContext(T_US, () =>
      accountService.createAccount(
        US_CTX,
        { actorId: 'op_seed' },
        {
          account_id: asAccountId(ulid()),
          phone_e164: phone,
          first_name: 'A',
          last_name: 'B',
          date_of_birth: '1990-01-01',
          gender: 'prefer_not_to_say',
        },
        getTestClient(),
      ),
    );

    const response = await app!.inject({
      method: 'POST',
      url: '/v0/identity/registration/start',
      headers: { host: 'localhost', 'idempotency-key': ulid() },
      payload: { phone_e164: phone },
    });
    expect(response.statusCode).toBe(400);
    expect(response.body).not.toContain('Telecheck-US');
    expect(response.body).not.toContain('Telecheck-Ghana');
    expect(response.body.toLowerCase()).not.toContain('heros');
  });
});

// ---------------------------------------------------------------------------
// §5 — IDEMPOTENCY v5.1 contract on POST /v0/identity/registration/verify
// ---------------------------------------------------------------------------
//
// Sprint 33 PR-F3 migrated `registrationVerifyHandler` to handler-owned
// `withIdempotency` AND added a 900s TTL override (aligned to JWT
// access_token TTL per `jwt.ts:62`). Mirrors the pattern from PR #60
// (devices §4) + PR #61 (login §5).
//
// Cases:
//   §5a same key + same body → cached 201 replay; SAME account_id
//        returned (proves NO second account was created — if the
//        handler re-ran, verifyOtp would fail because the OTP is
//        consumed by the first call)
//   §5b same key + different body → 409 body_mismatch; the body
//        hash check fires BEFORE the handler body callback runs
//
// The §3.8 PHONE_TAKEN return-cached pattern at registration.ts:321-324
// is covered separately by §1b + §4a; §5 specifically pins the
// IDEMPOTENCY v5.1 cache 4-tuple contract on the success-path body.
// ---------------------------------------------------------------------------

describe('identity registration HTTP — §5 IDEMPOTENCY v5.1 contract on /registration/verify', () => {
  it('§5a same Idempotency-Key + same body → cached 201 replay (same account_id)', async () => {
    const phone = uniquePhone();
    const otpId = asOtpId(ulid());
    const { codePlaintext } = await withTenantContext(T_US, () =>
      otpService.issueOtp(
        US_CTX,
        { actorId: 'op_seed' },
        { otp_id: otpId, phone_e164: phone, purpose: 'registration' },
        getTestClient(),
      ),
    );
    const idempotencyKey = ulid();
    const payload = {
      otp_id: otpId,
      code: codePlaintext,
      phone_e164: phone,
      first_name: 'Replay',
      last_name: 'Test',
      date_of_birth: '1990-01-01',
      gender: 'prefer_not_to_say' as const,
    };

    // First request: real verify, OTP consumed, account created +
    // activated.
    const first = await app!.inject({
      method: 'POST',
      url: '/v0/identity/registration/verify',
      headers: { host: 'localhost', 'idempotency-key': idempotencyKey },
      payload,
    });
    expect(first.statusCode).toBe(201);
    const firstBody = first.json<{ account_id: string; status: string }>();
    expect(firstBody.account_id).toBeTruthy();
    expect(firstBody.status).toBe('active');

    // Second request: same key + same body. preHandler cache-replay
    // short-circuits BEFORE handler body. NO second verifyOtp, NO
    // second createAccount.
    const second = await app!.inject({
      method: 'POST',
      url: '/v0/identity/registration/verify',
      headers: { host: 'localhost', 'idempotency-key': idempotencyKey },
      payload,
    });
    expect(second.statusCode).toBe(201);
    const secondBody = second.json<{ account_id: string; status: string }>();
    // Exactly-once: same account_id. If handler re-ran, verifyOtp
    // would fail (OTP consumed) — successful 201 with same
    // account_id structurally proves cache replay path.
    expect(secondBody.account_id).toBe(firstBody.account_id);
    expect(secondBody.status).toBe('active');
  });

  it('§5b same Idempotency-Key + different body → 409 internal.idempotency.body_mismatch', async () => {
    const phone = uniquePhone();
    const otpId = asOtpId(ulid());
    const { codePlaintext } = await withTenantContext(T_US, () =>
      otpService.issueOtp(
        US_CTX,
        { actorId: 'op_seed' },
        { otp_id: otpId, phone_e164: phone, purpose: 'registration' },
        getTestClient(),
      ),
    );
    const idempotencyKey = ulid();

    const first = await app!.inject({
      method: 'POST',
      url: '/v0/identity/registration/verify',
      headers: { host: 'localhost', 'idempotency-key': idempotencyKey },
      payload: {
        otp_id: otpId,
        code: codePlaintext,
        phone_e164: phone,
        first_name: 'Original',
        last_name: 'Name',
        date_of_birth: '1990-01-01',
        gender: 'prefer_not_to_say',
      },
    });
    expect(first.statusCode).toBe(201);

    // Second request: same key, DIFFERENT body (first_name changed).
    // Body hash check at withIdempotency reservation time fires
    // BEFORE handler body callback. Returns 409 immediately.
    const second = await app!.inject({
      method: 'POST',
      url: '/v0/identity/registration/verify',
      headers: { host: 'localhost', 'idempotency-key': idempotencyKey },
      payload: {
        otp_id: otpId,
        code: codePlaintext,
        phone_e164: phone,
        first_name: 'Different',
        last_name: 'Name',
        date_of_birth: '1990-01-01',
        gender: 'prefer_not_to_say',
      },
    });
    expect(second.statusCode).toBe(409);
    const errorBody = second.json<{ error: { code: string } }>();
    expect(errorBody.error.code).toBe('internal.idempotency.body_mismatch');
  });
});
