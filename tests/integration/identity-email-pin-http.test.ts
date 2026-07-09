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
  return post('/v0/identity/registration/email/verify', {
    email,
    passcode: code,
    pin,
    first_name: 'Ada',
    last_name: 'Lovelace',
    date_of_birth: '1990-01-01',
    gender: 'prefer_not_to_say',
  });
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

async function queryPinCredential(
  email: string,
): Promise<{ failed_attempts: number; locked_until: string | null } | null> {
  return withTenantContext(T_US, async () => {
    const r = await getTestClient().query(
      `SELECT c.failed_attempts, c.locked_until
         FROM account_pin_credentials c
         JOIN accounts a
           ON a.account_id = c.account_id AND a.tenant_id = c.tenant_id
        WHERE c.tenant_id = $1 AND lower(a.email) = lower($2)`,
      [T_US, email],
    );
    return (
      (r.rows[0] as { failed_attempts: number; locked_until: string | null } | undefined) ?? null
    );
  });
}

async function countLockoutAudits(email: string): Promise<number> {
  return withTenantContext(T_US, async () => {
    const r = await getTestClient().query(
      `SELECT COUNT(*)::int AS n
         FROM audit_records ar
         JOIN accounts a
           ON a.account_id = ar.resource_id AND a.tenant_id = ar.tenant_id
        WHERE ar.tenant_id = $1
          AND lower(a.email) = lower($2)
          AND ar.action = 'identity_pin_lockout_triggered'`,
      [T_US, email],
    );
    return (r.rows[0] as { n: number } | undefined)?.n ?? 0;
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

  it('A3. registration/start is not an enumeration oracle: an already-registered email and a brand-new email return an identical 200 (Codex HIGH)', async () => {
    const registered = uniqueEmail();
    expect((await registerEmailPin(registered, '481975')).statusCode).toBe(201);

    const startRegistered = await post('/v0/identity/registration/email/start', {
      email: registered,
    });
    const startNew = await post('/v0/identity/registration/email/start', { email: uniqueEmail() });
    expect(startRegistered.statusCode).toBe(200);
    expect(startNew.statusCode).toBe(200);
    // Bodies are byte-identical ({ status: 'ok' }; no dev echo in test config).
    expect(startRegistered.body).toBe(startNew.body);
  });

  it('A4. a verify attempt on an already-registered email fails tenant-blind (PASSCODE_FAILED, not an email-taken oracle)', async () => {
    const email = uniqueEmail();
    expect((await registerEmailPin(email, '481975')).statusCode).toBe(201);
    // registerEmailPin issues a registration passcode via the service then
    // verifies — on an existing email the account INSERT hits the unique index
    // and must surface as the same PASSCODE_FAILED as a wrong code.
    const res = await registerEmailPin(email, '739218');
    expect(res.statusCode).toBe(400);
    expect(json<{ error: { code: string } }>(res).error.code).toBe(
      'identity.email_passcode.verification_failed',
    );
  });

  it('A5. registration/start has no induced-lockout oracle: driving a NEW email into passcode cooldown still returns 200 (like a registered email) (Codex HIGH round 5)', async () => {
    const fresh = uniqueEmail();
    // Issue a registration passcode, then exhaust its 3 verify attempts to lock
    // the (tenant, email, email_registration) tuple into cooldown.
    expect((await post('/v0/identity/registration/email/start', { email: fresh })).statusCode).toBe(
      200,
    );
    for (let i = 0; i < 3; i++) {
      await post('/v0/identity/registration/email/verify', {
        email: fresh,
        passcode: '000001',
        pin: '481975',
        first_name: 'A',
        last_name: 'B',
        date_of_birth: '1990-01-01',
        gender: 'prefer_not_to_say',
      });
    }
    // The cooldown must NOT surface — start still returns 200, matching a
    // registered email (which never issues a passcode → never cools down).
    const afterCooldown = await post('/v0/identity/registration/email/start', { email: fresh });
    const registeredEmail = uniqueEmail();
    expect((await registerEmailPin(registeredEmail, '620914')).statusCode).toBe(201);
    const registeredStart = await post('/v0/identity/registration/email/start', {
      email: registeredEmail,
    });
    expect(afterCooldown.statusCode).toBe(200);
    expect(registeredStart.statusCode).toBe(200);
    expect(afterCooldown.body).toBe(registeredStart.body);
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
  it('C1. after 5 wrong PINs, the correct PIN is refused (locked) — 401 invalid_credentials (tenant-blind, not a distinct pin_locked code)', async () => {
    const email = uniqueEmail();
    expect((await registerEmailPin(email, '481975')).statusCode).toBe(201);
    for (let i = 0; i < 5; i++) {
      const r = await post('/v0/identity/login/pin', { email, pin: '000001' });
      expect(r.statusCode).toBe(401);
    }
    // Locked: even the CORRECT PIN is refused — proving the lockout is enforced
    // — but with the SAME code as any invalid attempt (Codex HIGH: no oracle).
    const locked = await post('/v0/identity/login/pin', { email, pin: '481975' });
    expect(locked.statusCode).toBe(401);
    expect(json<{ error: { code: string } }>(locked).error.code).toBe(
      'identity.login.invalid_credentials',
    );
  });

  it('C3. lockout is not an enumeration oracle: a locked registered email and an unknown email return the same status + code after the same attempt pattern (Codex HIGH)', async () => {
    const registered = uniqueEmail();
    const unknown = uniqueEmail();
    expect((await registerEmailPin(registered, '481975')).statusCode).toBe(201);

    const drive = async (email: string): Promise<{ statusCode: number; code: string }> => {
      let last = await post('/v0/identity/login/pin', { email, pin: '000001' });
      for (let i = 0; i < 5; i++) {
        last = await post('/v0/identity/login/pin', { email, pin: '000001' });
      }
      return {
        statusCode: last.statusCode,
        code: json<{ error: { code: string } }>(last).error.code,
      };
    };

    const reg = await drive(registered);
    const unk = await drive(unknown);
    expect(reg.statusCode).toBe(unk.statusCode);
    expect(reg.code).toBe(unk.code);
    expect(reg.code).toBe('identity.login.invalid_credentials');
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

describe('email+PIN — locked-probe audit trail (Codex round-11 MEDIUM)', () => {
  it('C4. a login probe while already locked appends a lockout audit row WITHOUT mutating lockout state', async () => {
    const email = uniqueEmail();
    const pin = '481975';
    expect((await registerEmailPin(email, pin)).statusCode).toBe(201);

    // 5 wrong attempts → the credential locks on the 5th (MAX_PIN_ATTEMPTS).
    for (let i = 0; i < 5; i++) {
      expect((await post('/v0/identity/login/pin', { email, pin: '000001' })).statusCode).toBe(401);
    }

    const afterLock = await queryPinCredential(email);
    expect(afterLock).not.toBeNull();
    expect(afterLock?.locked_until).not.toBeNull();
    const lockoutAuditsBefore = await countLockoutAudits(email);
    expect(lockoutAuditsBefore).toBeGreaterThanOrEqual(1); // the 5th tripped the lock

    // 6th attempt WHILE locked: still a tenant-blind 401, but it must leave an
    // append-only audit trail (detection) and must NOT re-increment attempts or
    // extend the cooldown (no attacker-controlled DoS).
    expect((await post('/v0/identity/login/pin', { email, pin: '000001' })).statusCode).toBe(401);

    const afterProbe = await queryPinCredential(email);
    const lockoutAuditsAfter = await countLockoutAudits(email);

    // Audit row appended for the locked probe.
    expect(lockoutAuditsAfter).toBe(lockoutAuditsBefore + 1);
    // Lockout state unchanged — no re-increment, no cooldown extension.
    expect(afterProbe?.failed_attempts).toBe(afterLock?.failed_attempts);
    expect(afterProbe?.locked_until).toBe(afterLock?.locked_until);
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

describe('email+PIN — recovery/verify is a non-oracle (Codex round-7 HIGH)', () => {
  it('D3. /recovery/pin/verify returns an identical 400 PASSCODE_FAILED for a wrong code on a registered email and on an unknown email', async () => {
    // Registered email, but a wrong passcode → 400 PASSCODE_FAILED.
    const known = uniqueEmail();
    expect((await registerEmailPin(known, '481975')).statusCode).toBe(201);
    await post('/v0/identity/recovery/pin/start', { email: known });
    const knownWrong = await post('/v0/identity/recovery/pin/verify', {
      email: known,
      passcode: '000001',
      new_pin: '620914',
    });

    // Unknown email → recovery/start issued a real (account_id=null) challenge,
    // so verify runs the same passcode consumption before the account lookup
    // fails. Same 400 PASSCODE_FAILED body — no account-existence oracle.
    const unknown = uniqueEmail();
    await post('/v0/identity/recovery/pin/start', { email: unknown });
    const unknownWrong = await post('/v0/identity/recovery/pin/verify', {
      email: unknown,
      passcode: '000001',
      new_pin: '620914',
    });

    expect(knownWrong.statusCode).toBe(400);
    expect(unknownWrong.statusCode).toBe(400);
    // Compare the error code + message (the tenant-blind surface). request_id
    // is intentionally unique per request and is not an existence oracle, so
    // it is normalised out of the comparison.
    const errShape = (body: string) => {
      const { code, message } = JSON.parse(body).error;
      return { code, message };
    };
    expect(errShape(knownWrong.body)).toEqual(errShape(unknownWrong.body));
  });
});

describe('email+PIN — passcode lockout is not bypassed by a correct code (Codex round-8 HIGH)', () => {
  it('D4. once a recovery challenge is locked (3 wrong), the CORRECT code is rejected and the PIN is unchanged', async () => {
    const email = uniqueEmail();
    const oldPin = '481975';
    expect((await registerEmailPin(email, oldPin)).statusCode).toBe(201);

    // Issue a recovery challenge and learn its plaintext.
    const code = await issuePasscode(email, 'pin_recovery');

    // Exhaust the 3 attempts with wrong codes → challenge locks.
    for (let i = 0; i < 3; i++) {
      const wrong = await post('/v0/identity/recovery/pin/verify', {
        email,
        passcode: '000001',
        new_pin: '620914',
      });
      expect(wrong.statusCode).toBe(400);
    }

    // The CORRECT code must now be rejected — the lockout is not bypassable.
    const correctButLocked = await post('/v0/identity/recovery/pin/verify', {
      email,
      passcode: code,
      new_pin: '620914',
    });
    expect(correctButLocked.statusCode).toBe(400);

    // The PIN was never reset: the original PIN still logs in.
    expect((await post('/v0/identity/login/pin', { email, pin: oldPin })).statusCode).toBe(200);
    // And the would-be new PIN does not.
    expect((await post('/v0/identity/login/pin', { email, pin: '620914' })).statusCode).toBe(401);
  });

  it('D5. tuple-wide lockout: with two issued codes, locking the newer one blocks the older correct code too', async () => {
    const email = uniqueEmail();
    const oldPin = '481975';
    expect((await registerEmailPin(email, oldPin)).statusCode).toBe(201);

    // Two unconsumed recovery challenges for the same (email, purpose).
    const codeA = await issuePasscode(email, 'pin_recovery'); // older
    const codeB = await issuePasscode(email, 'pin_recovery'); // newer (targeted by verify)
    expect(codeA).not.toBe(codeB);

    // Burn the 3 attempts against the newest challenge (B) with wrong codes →
    // the (email, purpose) tuple locks.
    for (let i = 0; i < 3; i++) {
      const wrong = await post('/v0/identity/recovery/pin/verify', {
        email,
        passcode: '000001',
        new_pin: '620914',
      });
      expect(wrong.statusCode).toBe(400);
    }

    // The older correct code A must NOT slip through during the cooldown — the
    // lockout is tuple-wide, not per-passcode-row.
    const olderCorrect = await post('/v0/identity/recovery/pin/verify', {
      email,
      passcode: codeA,
      new_pin: '620914',
    });
    expect(olderCorrect.statusCode).toBe(400);

    // PIN unchanged.
    expect((await post('/v0/identity/login/pin', { email, pin: oldPin })).statusCode).toBe(200);
    expect((await post('/v0/identity/login/pin', { email, pin: '620914' })).statusCode).toBe(401);
  });
});
