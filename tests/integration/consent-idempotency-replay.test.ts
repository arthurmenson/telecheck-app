/**
 * Retired consent routes cannot create or replay caller-authored grants.
 * Versioned-policy replay/conflict acceptance is covered with actual HTTP
 * and restricted database logins in scripts/verify-care-consent.mjs.
 * Existing delegation replay remains independently verified below.
 */

import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../../src/app.ts';
import type { TenantId } from '../../src/lib/glossary.ts';
import type { TenantContext } from '../../src/lib/tenant-context.ts';
import { ulid } from '../../src/lib/ulid.ts';
import { createConsentVersion } from '../../src/modules/consent/internal/repositories/consent-repo.ts';
import {
  asConsentVersionId,
  type ConsentVersionId,
} from '../../src/modules/consent/internal/types.ts';
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

async function loginAndGetToken(): Promise<{ accessToken: string; accountId: string }> {
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

async function seedConsentVersion(): Promise<ConsentVersionId> {
  const id = asConsentVersionId(ulid());
  await withTenantContext(T_US, () =>
    createConsentVersion(
      {
        consent_version_id: id,
        tenant_id: T_US,
        consent_type: 'platform',
        version_label: 'v1.0',
        terms_text: 'Terms.',
      },
      getTestClient(),
    ),
  );
  return id;
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
        first_name: 'Delegate',
        last_name: 'Test',
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

// ---------------------------------------------------------------------------
// §1 — Idempotency replay regression for /v0/consent
// ---------------------------------------------------------------------------

describe('consent route retirement and delegation replay', () => {
  for (const changedBody of [false, true]) {
    it(`legacy consent requests remain retired with changedBody=${changedBody}`, async () => {
      const { accessToken, accountId } = await loginAndGetToken();
      const versionId = await seedConsentVersion();
      const idempotencyKey = ulid();
      const payload = {
        consent_type: 'platform',
        consent_version_id: versionId,
        evidence: { timestamp: new Date().toISOString(), type: 'in_app', device_id: 'original' },
      };
      for (const retry of [false, true]) {
        const response = await app!.inject({
          method: 'POST',
          url: '/v0/consent/consents',
          headers: {
            host: 'localhost',
            authorization: `Bearer ${accessToken}`,
            'idempotency-key': idempotencyKey,
          },
          payload:
            retry && changedBody
              ? { ...payload, evidence: { ...payload.evidence, device_id: 'changed' } }
              : payload,
        });
        expect(response.statusCode).toBe(410);
        expect(response.json().error.code).toBe('consent.versioned_policy_required');
        expect(response.headers['cache-control']).toBe('no-store');
        expect(response.body).not.toContain('Telecheck-US');
        expect(response.body).not.toContain('Heros Health');
      }
      const counts = await withTenantContext(T_US, () =>
        getTestClient().query<{ grants: number; audits: number }>(
          `SELECT
           (SELECT count(*)::int FROM consent WHERE tenant_id=$1 AND account_id=$2 AND consent_version_id=$3) AS grants,
           (SELECT count(*)::int FROM audit_records WHERE tenant_id=$1 AND actor_id=$2 AND action='consent_granted') AS audits`,
          [T_US, accountId, versionId],
        ),
      );
      expect(counts.rows[0]).toEqual({ grants: 0, audits: 0 });
    });
  }

  it('§1c POST /delegations replay returns cached delegation_id + no duplicate row', async () => {
    const { accessToken } = await loginAndGetToken();
    const delegateId = await createPatient();
    const idempotencyKey = ulid();
    const payload = {
      delegate_account_id: delegateId,
      relationship_type: 'spouse_partner' as const,
    };

    const first = await app!.inject({
      method: 'POST',
      url: '/v0/consent/delegations',
      headers: {
        host: 'localhost',
        authorization: `Bearer ${accessToken}`,
        'idempotency-key': idempotencyKey,
      },
      payload,
    });
    expect(first.statusCode).toBe(201);
    const firstBody = first.json<{ delegation_id: string }>();

    const second = await app!.inject({
      method: 'POST',
      url: '/v0/consent/delegations',
      headers: {
        host: 'localhost',
        authorization: `Bearer ${accessToken}`,
        'idempotency-key': idempotencyKey,
      },
      payload,
    });
    expect(second.statusCode).toBe(201);
    const secondBody = second.json<{ delegation_id: string }>();
    expect(secondBody.delegation_id).toBe(firstBody.delegation_id);

    // Exactly ONE delegation row for the (grantor, delegate) tuple. A
    // duplicate handler-run would write a second pending_acceptance row.
    const count = await withTenantContext(T_US, async () => {
      const r = await getTestClient().query<{ c: string }>(
        `SELECT COUNT(*)::text AS c FROM delegations
           WHERE tenant_id = $1 AND delegate_account_id = $2`,
        [T_US, delegateId],
      );
      return Number.parseInt(r.rows[0]!.c, 10);
    });
    expect(count).toBe(1);
  });
});
