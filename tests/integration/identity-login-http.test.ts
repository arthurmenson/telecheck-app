/**
 * Identity login + session handlers — HTTP integration tests.
 *
 * Exercises POST /v0/identity/login/{start,verify} and
 * POST /v0/identity/sessions/{refresh,logout} end-to-end via Fastify
 * inject().
 *
 * Coverage in this file (4 sections, 11 cases).
 *
 * Spec references:
 *   - src/modules/identity/internal/handlers/login.ts (target)
 *   - Identity & Authentication Spec v1.0 §3
 *   - I-025 (tenant-blind: no account enumeration)
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
