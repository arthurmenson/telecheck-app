/**
 * identity-email-pin-http.test.ts — live-PostgreSQL HTTP integration tests
 * for the email + 6-digit-PIN auth path (migration 078;
 * docs/SI-EMAIL-PIN-AUTH.md). Runs alongside the phone+OTP flow.
 *
 * The one-time passcode is not returned on the wire (email-stub posture), so
 * — mirroring the OTP tests (identity-jwt-end-to-end) — the test issues the
 * passcode via the service to learn the plaintext, then hits the verify
 * endpoint with it.
 *
 * Coverage:
 *   A1 register (email passcode → verify + PIN) → 201 + tokens; account is
 *      email-only (phone NULL), active
 *   A2 weak PIN at register → 400
 *   A3 register with an already-registered email → 400 EMAIL_TAKEN
 *   B1 PIN login (email + correct PIN) → 200 + tokens
 *   B2 PIN login wrong PIN → 401 invalid_credentials; account unchanged
 *   B3 PIN login unknown email → 401 invalid_credentials (tenant-blind, no
 *      enumeration)
 *   C1 lockout: 5 wrong PINs → the 6th is 401 pin_locked
 *   D1 recovery: emailed passcode → set new PIN → 200; login with the new PIN
 *      works and the OLD PIN no longer does
 *   E1 tenant isolation: a US email + PIN cannot log in on the Ghana host
 */

import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../../src/app.ts';
import type { TenantId } from '../../src/lib/glossary.ts';
import type { TenantContext } from '../../src/lib/tenant-context.ts';
import { ulid } from '../../src/lib/ulid.ts';
import type { EmailPasscodePurpose } from '../../src/modules/identity/internal/repositories/email-passcode-repo.ts';
import * as passcodeService from '../../src/modules/identity/internal/services/email-passcode-service.ts';
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

function uniqueEmail(): string {
  return `u${ulid().toLowerCase()}@example.com`;
}

interface InjectResult {
  statusCode: number;
  body: string;
}

async function post(url: string, payload: unknown, host = 'localhost'): Promise<InjectResult> {
  return app!.inject({
    method: 'POST',
    url,
    headers: { host, 'content-type': 'application/json', 'idempotency-key': ulid() },
    payload: payload as object,
  });
}

function json<T>(r: InjectResult): T {
  return JSON.parse(r.body) as T;
}

/** Issue a passcode via the service to learn the plaintext (email-stub). */
async function issuePasscode(email: string, purpose: EmailPasscodePurpose): Promise<string> {
  const { codePlaintext } = await withTenantContext(T_US, () =>
    passcodeService.issuePasscode(
      US_CTX,
      { actorId: 'op_seed' },
      { passcode_id: ulid(), account_id: null, email, purpose },
      getTestClient(),
    ),
  );
  return codePlaintext;
}

/** Full register: issue passcode → verify with PIN. Returns the response. */
async function registerEmailPin(email: string, pin: string): Promise<InjectResult> {
  const code = await issuePasscode(email, 'email_registration');
  const res = await post('/v0/identity/registration/email/verify', {
    email,
    passcode: code,
    pin,
    first_name: 'Ada',
    last_name: 'Lovelace',
    date_of_birth: '1990-01-01',
    gender: 'prefer_not_to_say',
  });
  // TEMP DIAGNOSTIC (remove after root-cause): non-prod 5xx carries the real
  // error message in the envelope; surface it so CI reveals the 500 cause.
  if (res.statusCode !== 201) {
    // eslint-disable-next-line no-console
    console.error('REGISTER_EMAIL_PIN_FAIL', res.statusCode, res.body);
  }
  return res;
}

async function queryAccountByEmail(
  email: string,
): Promise<{ phone_e164: string | null; status: string } | null> {
  return withTenantContext(T_US, async () => {
    const r = await getTestClient().query(
      `SELECT phone_e164, status FROM accounts WHERE tenant_id = $1 AND lower(email) = lower($2)`,
      [T_US, email],
    );
    return (r.rows[0] as { phone_e164: string | null; status: string } | undefined) ?? null;
  });
}

describe('email+PIN — registration', () => {
  it('A1. register (passcode → verify + PIN) → 201 + tokens; email-only account (phone NULL), active', async () => {
    const email = uniqueEmail();
    const res = await registerEmailPin(email, '481975');
    expect(res.statusCode).toBe(201);
    const body = json<{
      account: { account_id: string };
      access_token: string;
      refresh_token: string;
    }>(res);
    expect(body.access_token.length).toBeGreaterThan(0);
    expect(body.refresh_token.length).toBeGreaterThan(0);

    const row = await queryAccountByEmail(email);
    expect(row).not.toBeNull();
    expect(row?.phone_e164).toBeNull();
    expect(row?.status).toBe('active');
  });

  it('A2. weak PIN at register → 400', async () => {
    const email = uniqueEmail();
    const code = await issuePasscode(email, 'email_registration');
    const res = await post('/v0/identity/registration/email/verify', {
      email,
      passcode: code,
      pin: '123456',
      first_name: 'Ada',
      last_name: 'L',
      date_of_birth: '1990-01-01',
      gender: 'prefer_not_to_say',
    });
    expect(res.statusCode).toBe(400);
    expect(json<{ error: { code: string } }>(res).error.code).toBe('identity.pin.weak');
  });

  it('A3. register with an already-registered email → 400 EMAIL_TAKEN', async () => {
    const email = uniqueEmail();
    expect((await registerEmailPin(email, '481975')).statusCode).toBe(201);
    const res = await registerEmailPin(email, '739218');
    expect(res.statusCode).toBe(400);
    expect(json<{ error: { code: string } }>(res).error.code).toBe(
      'identity.registration.email_taken',
    );
  });
});

describe('email+PIN — login', () => {
  it('B1. PIN login (email + correct PIN) → 200 + tokens', async () => {
    const email = uniqueEmail();
    const pin = '481975';
    expect((await registerEmailPin(email, pin)).statusCode).toBe(201);

    const res = await post('/v0/identity/login/pin', { email, pin });
    expect(res.statusCode).toBe(200);
    const body = json<{ access_token: string; account: { account_id: string } }>(res);
    expect(body.access_token.length).toBeGreaterThan(0);
  });

  it('B2. wrong PIN → 401 invalid_credentials', async () => {
    const email = uniqueEmail();
    expect((await registerEmailPin(email, '481975')).statusCode).toBe(201);
    const res = await post('/v0/identity/login/pin', { email, pin: '000001' });
    expect(res.statusCode).toBe(401);
    expect(json<{ error: { code: string } }>(res).error.code).toBe(
      'identity.login.invalid_credentials',
    );
  });

  it('B3. unknown email → 401 invalid_credentials (tenant-blind; no enumeration)', async () => {
    const res = await post('/v0/identity/login/pin', { email: uniqueEmail(), pin: '481975' });
    expect(res.statusCode).toBe(401);
    expect(json<{ error: { code: string } }>(res).error.code).toBe(
      'identity.login.invalid_credentials',
    );
  });
});

describe('email+PIN — lockout', () => {
  it('C1. 5 wrong PINs → the 6th attempt is 401 pin_locked', async () => {
    const email = uniqueEmail();
    expect((await registerEmailPin(email, '481975')).statusCode).toBe(201);
    for (let i = 0; i < 5; i++) {
      const r = await post('/v0/identity/login/pin', { email, pin: '000001' });
      expect(r.statusCode).toBe(401);
    }
    const locked = await post('/v0/identity/login/pin', { email, pin: '481975' });
    expect(locked.statusCode).toBe(401);
    expect(json<{ error: { code: string } }>(locked).error.code).toBe('identity.login.pin_locked');
  });
});

describe('email+PIN — recovery', () => {
  it('D1. emailed passcode → set new PIN → 200; new PIN works, old PIN does not', async () => {
    const email = uniqueEmail();
    const oldPin = '481975';
    const newPin = '620914';
    expect((await registerEmailPin(email, oldPin)).statusCode).toBe(201);

    const code = await issuePasscode(email, 'pin_recovery');
    const reset = await post('/v0/identity/recovery/pin/verify', {
      email,
      passcode: code,
      new_pin: newPin,
    });
    expect(reset.statusCode).toBe(200);

    expect((await post('/v0/identity/login/pin', { email, pin: newPin })).statusCode).toBe(200);
    expect((await post('/v0/identity/login/pin', { email, pin: oldPin })).statusCode).toBe(401);
  });
});

describe('email+PIN — tenant isolation (I-023/I-025)', () => {
  it('E1. a US email+PIN cannot log in on the Ghana host', async () => {
    const email = uniqueEmail();
    const pin = '481975';
    expect((await registerEmailPin(email, pin)).statusCode).toBe(201);
    // Same credentials, Ghana host → resolves Telecheck-Ghana, where the
    // account does not exist → tenant-blind 401.
    const res = await post('/v0/identity/login/pin', { email, pin }, 'ghana.heroshealth.com');
    expect(res.statusCode).toBe(401);
  });
});

describe('email+PIN — lockout counting boundary (Codex HIGH: row-atomic accounting)', () => {
  it('C2. 4 wrong attempts do NOT lock — the 5th (correct) PIN still logs in', async () => {
    const email = uniqueEmail();
    const pin = '481975';
    expect((await registerEmailPin(email, pin)).statusCode).toBe(201);
    for (let i = 0; i < 4; i++) {
      expect((await post('/v0/identity/login/pin', { email, pin: '000001' })).statusCode).toBe(401);
    }
    // Not locked at 4 — a correct PIN succeeds (and resets the counter).
    expect((await post('/v0/identity/login/pin', { email, pin })).statusCode).toBe(200);
  });
});

describe('email+PIN — recovery/start is a non-oracle (Codex HIGH)', () => {
  it('D2. /recovery/pin/start returns an identical 200 for a lockout-active registered email and an unknown email', async () => {
    const email = uniqueEmail();
    expect((await registerEmailPin(email, '481975')).statusCode).toBe(201);

    // Drive the recovery passcode into cooldown: issue one, then exhaust its
    // 3 verify attempts with wrong codes.
    expect((await post('/v0/identity/recovery/pin/start', { email })).statusCode).toBe(200);
    for (let i = 0; i < 3; i++) {
      await post('/v0/identity/recovery/pin/verify', {
        email,
        passcode: '000001',
        new_pin: '620914',
      });
    }

    // Registered-but-locked: MUST still be 200 with the same body (not 400).
    const locked = await post('/v0/identity/recovery/pin/start', { email });
    expect(locked.statusCode).toBe(200);
    // Unknown email: 200 with the same body.
    const unknown = await post('/v0/identity/recovery/pin/start', { email: uniqueEmail() });
    expect(unknown.statusCode).toBe(200);
    expect(locked.body).toBe(unknown.body);
  });
});
