/**
 * Delegation slice HTTP — coverage-gap closeout.
 *
 * The original `delegation-http.test.ts` (commit `3f93e6e`) covered the
 * primary lifecycle but left four endpoints unexercised. This file
 * closes those gaps.
 *
 * Coverage in this file (4 sections, 4 cases):
 *   §1 POST /delegations/:id/decline
 *   §2 GET  /delegations/received  (delegate-side inbound list)
 *   §3 POST /delegations/:id/scopes/:scopeId/revoke
 *   §4 GET  /delegations/:id/scopes
 *
 * Spec references:
 *   - src/modules/consent/internal/handlers/delegations.ts (target)
 *   - Consent Slice PRD v1.0 §6
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
import { uniquePhone } from '../helpers/unique-phone.ts';
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

async function createPatientAndLogin(): Promise<{ accessToken: string; accountId: string }> {
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
  const body = verify.json<{ access_token: string }>();
  return { accessToken: body.access_token, accountId };
}

async function createPatient(): Promise<string> {
  const phone = uniquePhone();
  const accountId = asAccountId(ulid());
  await withTenantContext(T_US, () =>
    accountService.createAccount(
      US_CTX,
      { actorId: 'op_seed' },
      {
        account_id: accountId,
        phone_e164: phone,
        first_name: 'D',
        last_name: 'T',
        date_of_birth: '1980-01-01',
        gender: 'prefer_not_to_say',
      },
      getTestClient(),
    ),
  );
  await withTenantContext(T_US, () =>
    accountService.activateAccount(US_CTX, { actorId: 'op_seed' }, accountId, getTestClient()),
  );
  return accountId;
}

async function inviteDelegation(
  accessToken: string,
  delegateId: string,
): Promise<{ delegationId: string }> {
  const r = await app!.inject({
    method: 'POST',
    url: '/v0/consent/delegations',
    headers: {
      host: 'localhost',
      authorization: `Bearer ${accessToken}`,
      'idempotency-key': ulid(),
    },
    payload: {
      delegate_account_id: delegateId,
      relationship_type: 'spouse_partner',
    },
  });
  return { delegationId: r.json<{ delegation_id: string }>().delegation_id };
}

// ---------------------------------------------------------------------------
// §1 — POST /delegations/:id/decline
// ---------------------------------------------------------------------------

describe('delegation HTTP coverage gaps — §1 decline', () => {
  it('§1a decline transitions pending → declined', async () => {
    // Codex PR-118 R5 closure 2026-05-13: decline now requires the
    // DELEGATE's JWT (ownership check).
    const grantor = await createPatientAndLogin();
    const delegate = await createPatientAndLogin();
    const { delegationId } = await inviteDelegation(grantor.accessToken, delegate.accountId);

    const decline = await app!.inject({
      method: 'POST',
      url: `/v0/consent/delegations/${delegationId}/decline`,
      headers: {
        host: 'localhost',
        authorization: `Bearer ${delegate.accessToken}`,
        'idempotency-key': ulid(),
      },
    });
    expect(decline.statusCode).toBe(200);
    const body = decline.json<{ status: string }>();
    expect(body.status).toBe('declined');
    expect(decline.body).not.toContain('"tenant_id"');
  });
});

// ---------------------------------------------------------------------------
// §2 — GET /delegations/received
// ---------------------------------------------------------------------------

describe('delegation HTTP coverage gaps — §2 received list', () => {
  it('§2a /received lists active inbound delegations for the delegate', async () => {
    // Setup: grantor invites a delegate that we'll log in as.
    const { accessToken: grantorToken } = await createPatientAndLogin();
    const { accessToken: delegateToken, accountId: delegateAccountId } =
      await createPatientAndLogin();

    const { delegationId } = await inviteDelegation(grantorToken, delegateAccountId);

    // Accept (using the DELEGATE's token per Codex PR-118 R5 ownership
    // closure 2026-05-13).
    await app!.inject({
      method: 'POST',
      url: `/v0/consent/delegations/${delegationId}/accept`,
      headers: {
        host: 'localhost',
        authorization: `Bearer ${delegateToken}`,
        'idempotency-key': ulid(),
      },
    });

    const list = await app!.inject({
      method: 'GET',
      url: '/v0/consent/delegations/received',
      headers: { host: 'localhost', authorization: `Bearer ${delegateToken}` },
    });
    expect(list.statusCode).toBe(200);
    const body = list.json<{ delegations: Array<{ delegation_id: string }> }>();
    expect(body.delegations.some((d) => d.delegation_id === delegationId)).toBe(true);
    expect(list.body).not.toContain('"tenant_id"');
  });
});

// ---------------------------------------------------------------------------
// §3 — POST /delegations/:id/scopes/:scopeId/revoke
// ---------------------------------------------------------------------------

describe('delegation HTTP coverage gaps — §3 scope revoke', () => {
  it('§3a scope revoke returns 200 + revoked_at populated', async () => {
    const { accessToken } = await createPatientAndLogin();
    const delegateId = await createPatient();
    const { delegationId } = await inviteDelegation(accessToken, delegateId);

    // Grant a scope first.
    const granted = await app!.inject({
      method: 'POST',
      url: `/v0/consent/delegations/${delegationId}/scopes`,
      headers: {
        host: 'localhost',
        authorization: `Bearer ${accessToken}`,
        'idempotency-key': ulid(),
      },
      payload: { scope: 'view_records' },
    });
    const scopeId = granted.json<{ delegation_scope_id: string }>().delegation_scope_id;

    // Revoke it.
    const revoke = await app!.inject({
      method: 'POST',
      url: `/v0/consent/delegations/${delegationId}/scopes/${scopeId}/revoke`,
      headers: {
        host: 'localhost',
        authorization: `Bearer ${accessToken}`,
        'idempotency-key': ulid(),
      },
    });
    expect(revoke.statusCode).toBe(200);
    const body = revoke.json<{ revoked_at: string | null }>();
    expect(body.revoked_at).not.toBeNull();
    expect(revoke.body).not.toContain('"tenant_id"');
  });

  it('§3b scope revoke on unknown scope returns 404 tenant-blind', async () => {
    const { accessToken } = await createPatientAndLogin();
    const delegateId = await createPatient();
    const { delegationId } = await inviteDelegation(accessToken, delegateId);

    const revoke = await app!.inject({
      method: 'POST',
      url: `/v0/consent/delegations/${delegationId}/scopes/${ulid()}/revoke`,
      headers: {
        host: 'localhost',
        authorization: `Bearer ${accessToken}`,
        'idempotency-key': ulid(),
      },
    });
    expect(revoke.statusCode).toBe(404);
    expect(revoke.body).not.toContain('Telecheck-US');
    expect(revoke.body).not.toContain('Heros Health');
  });
});

// ---------------------------------------------------------------------------
// §4 — GET /delegations/:id/scopes
// ---------------------------------------------------------------------------

describe('delegation HTTP coverage gaps — §4 scope list', () => {
  it('§4a /scopes lists active scopes for a delegation', async () => {
    const { accessToken } = await createPatientAndLogin();
    const delegateId = await createPatient();
    const { delegationId } = await inviteDelegation(accessToken, delegateId);

    // Grant 2 scopes.
    await app!.inject({
      method: 'POST',
      url: `/v0/consent/delegations/${delegationId}/scopes`,
      headers: {
        host: 'localhost',
        authorization: `Bearer ${accessToken}`,
        'idempotency-key': ulid(),
      },
      payload: { scope: 'view_records' },
    });
    await app!.inject({
      method: 'POST',
      url: `/v0/consent/delegations/${delegationId}/scopes`,
      headers: {
        host: 'localhost',
        authorization: `Bearer ${accessToken}`,
        'idempotency-key': ulid(),
      },
      payload: { scope: 'request_refills' },
    });

    const list = await app!.inject({
      method: 'GET',
      url: `/v0/consent/delegations/${delegationId}/scopes`,
      headers: { host: 'localhost', authorization: `Bearer ${accessToken}` },
    });
    expect(list.statusCode).toBe(200);
    const body = list.json<{ scopes: Array<{ scope: string }> }>();
    expect(body.scopes.length).toBeGreaterThanOrEqual(2);
    const scopeNames = body.scopes.map((s) => s.scope).sort();
    expect(scopeNames).toContain('view_records');
    expect(scopeNames).toContain('request_refills');
    expect(list.body).not.toContain('"tenant_id"');
  });
});
