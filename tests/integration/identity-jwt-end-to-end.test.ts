/**
 * Identity slice — JWT end-to-end integration test.
 *
 * Exercises the full Tier 1 auth flow:
 *   1. POST /v0/identity/registration/start + verify (account created)
 *   2. POST /v0/identity/login/start + verify (returns access_token JWT)
 *   3. Use the JWT as Authorization: Bearer <token> on a downstream
 *      forms-intake call → handler resolves actor via req.actorContext
 *      (NOT the x-actor-id header shim)
 *
 * Coverage in this file (3 sections, 6 cases):
 *   §1 login/verify returns access_token + refresh_token
 *   §2 Tier 1 JWT auth: POST /v0/forms/submissions/start with Bearer
 *      JWT works (no x-actor-id / x-patient-id headers needed)
 *   §3 Cross-tenant token forge defense
 *
 * Spec references:
 *   - Identity & Authentication Spec v1.0 §3
 *   - I-023 (tenant_id is JWT claim; verified against request tenant ctx)
 *   - I-025 (tenant-blind 401)
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

/**
 * Register + activate an account, then perform a login round-trip via
 * HTTP, returning the JWT access token + the patient's account_id.
 */
async function loginViaHttp(): Promise<{
  accessToken: string;
  refreshToken: string;
  accountId: string;
  phone: string;
}> {
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

  // Issue OTP for login + capture plaintext code (HTTP /start returns
  // only otp_id; for the test we issue via the service to know the code)
  const otpId = asOtpId(ulid());
  const { codePlaintext } = await withTenantContext(T_US, () =>
    otpService.issueOtp(
      US_CTX,
      { actorId: 'op_seed' },
      { otp_id: otpId, account_id: accountId, phone_e164: phone, purpose: 'login' },
      getTestClient(),
    ),
  );

  const verify = await app!.inject({
    method: 'POST',
    url: '/v0/identity/login/verify',
    headers: { host: 'localhost', 'idempotency-key': ulid() },
    payload: { phone_e164: phone, code: codePlaintext },
  });
  const body = verify.json<{
    access_token: string;
    refresh_token: string;
    account: { account_id: string };
  }>();

  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token,
    accountId: body.account.account_id,
    phone,
  };
}

// ---------------------------------------------------------------------------
// §1 — login/verify returns access_token
// ---------------------------------------------------------------------------

describe('JWT end-to-end — §1 login/verify access_token', () => {
  it('§1a access_token is a three-segment JWT', async () => {
    const { accessToken } = await loginViaHttp();
    const segments = accessToken.split('.');
    expect(segments).toHaveLength(3);
    for (const seg of segments) {
      expect(seg.length).toBeGreaterThan(0);
    }
  });

  it('§1b access_token is distinct from refresh_token', async () => {
    const { accessToken, refreshToken } = await loginViaHttp();
    expect(accessToken).not.toBe(refreshToken);
  });
});

// ---------------------------------------------------------------------------
// §2 — Tier 1 JWT auth on forms-intake calls
// ---------------------------------------------------------------------------

describe('JWT end-to-end — §2 Tier 1 auth on downstream calls', () => {
  it('§2a Bearer JWT successfully authenticates a forms-intake call (no x-actor-id needed)', async () => {
    const { accessToken } = await loginViaHttp();

    // Hit a forms-intake endpoint that calls resolveActorId — list templates.
    // It requires only an actor (any role for v1.0 since auth slices haven't
    // landed for clinician/admin). Tier 1 should resolve via JWT;
    // Tier 2 fallback never fires because actorContext is populated.
    const response = await app!.inject({
      method: 'GET',
      url: '/v0/forms/templates',
      headers: {
        host: 'localhost',
        authorization: `Bearer ${accessToken}`,
        // NO x-actor-id / x-patient-id — JWT replaces them
      },
    });

    // Expectation: NOT 401 (auth succeeded). The exact status depends on
    // whether the patient role can list templates per RBAC; the v1.0
    // bootstrap admin-role check may reject with 403 on some routes.
    // What matters is the auth layer accepted the JWT.
    expect(response.statusCode).not.toBe(401);
  });

  it('§2b expired / malformed JWT → handler proceeds via Tier 2 if test allows it', async () => {
    // Pass a malformed JWT. The auth hook leaves actorContext undefined.
    // Tier 2 then tries x-actor-id; without it (and not in production)
    // returns 401.
    const response = await app!.inject({
      method: 'GET',
      url: '/v0/forms/templates',
      headers: {
        host: 'localhost',
        authorization: 'Bearer not.a.valid.jwt',
        // No x-actor-id either — Tier 2 also fails → 401
      },
    });
    expect(response.statusCode).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// §3 — Cross-tenant token forge defense
// ---------------------------------------------------------------------------

describe('JWT end-to-end — §3 cross-tenant token-forge defense', () => {
  it('§3a JWT issued for Telecheck-US REJECTED when sent to Telecheck-Ghana host', async () => {
    const { accessToken } = await loginViaHttp(); // tenant_id claim = Telecheck-US

    // Send the JWT to a request hitting the Telecheck-Ghana subdomain.
    // The authContextPlugin's tenant_id-vs-actor-context check should
    // detect the mismatch and leave actorContext undefined, so Tier 2
    // fires (no x-actor-id → 401).
    const response = await app!.inject({
      method: 'GET',
      url: '/v0/forms/templates',
      headers: {
        host: 'ghana.heroshealth.com',
        authorization: `Bearer ${accessToken}`,
      },
    });
    // Mismatch → actorContext undefined → Tier 2 401
    expect(response.statusCode).toBe(401);
  });
});
