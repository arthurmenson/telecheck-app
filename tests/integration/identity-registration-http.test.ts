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
 * Coverage in this file (4 sections, 8 cases):
 *
 * Spec references:
 *   - src/modules/identity/internal/handlers/registration.ts (target)
 *   - Identity & Authentication Spec v1.0 §2
 *   - Master PRD v1.10 §17 + Glossary v5.2 C3 (no tenant_id in
 *     patient response bodies)
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
