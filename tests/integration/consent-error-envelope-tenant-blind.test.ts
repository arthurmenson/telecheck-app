/**
 * Consent slice — I-025 tenant-blindness regression for HTTP error envelopes.
 *
 * The existing consent-http.test.ts and delegation-http.test.ts files
 * assert tenant-blindness on the HAPPY PATH bodies. This file closes the
 * gap on the ERROR PATHS — every 4xx envelope from /v0/consent must be
 * tenant-blind: no operating-tenant id (`Telecheck-*`), no consumer DBA
 * (`Heros Health`), no display-name fragment, no country-of-care code in
 * the error message.
 *
 * Pattern mirrors `error-envelope-http.test.ts` cross-tenant existence
 * leak prevention test (which targets /v0/forms/submissions). This file
 * targets /v0/consent.
 *
 * Coverage in this file (1 section, 5 cases):
 *   §1a 401 — POST /consents without Bearer
 *   §1b 400 — POST /consents with invalid consent_type
 *   §1c 404 — POST /consents/revoke with no prior grant
 *   §1d 400 — POST /delegations with invalid relationship_type
 *   §1e 400 — POST /delegations self-delegation rejected
 *
 * Spec references:
 *   - I-025 (tenant-blind error envelopes)
 *   - I-009 (no hardcoded country / tenant assumptions)
 *   - ERROR_MODEL v5.1 (canonical envelope schema)
 *   - Master PRD v1.10 §17 + Glossary v5.2 C3 (tenant.id and consumer_dba
 *     never leak to patient surface — applies transitively to error paths)
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

// ---------------------------------------------------------------------------
// Forbidden substrings — every test below scans the response body for each.
// If any of these appear, the envelope is leaking tenant/DBA structural data.
// ---------------------------------------------------------------------------

const FORBIDDEN_SUBSTRINGS = [
  'Telecheck-US',
  'Telecheck-Ghana',
  'Telecheck Health LLC',
  'Telecheck-Ghana Ltd.',
  'Heros Health',
  'heroshealth.com',
  'ghana.heroshealth.com',
  'alias/telecheck',
];

function assertTenantBlind(body: string): void {
  for (const needle of FORBIDDEN_SUBSTRINGS) {
    expect(body).not.toContain(needle);
  }
}

function uniquePhone(): string {
  const digits = ulid()
    .slice(-9)
    .replace(/[^0-9]/g, '0')
    .padEnd(9, '0');
  return `+1${digits}`;
}

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

// ---------------------------------------------------------------------------
// §1 — Error envelope tenant-blindness
// ---------------------------------------------------------------------------

describe('consent HTTP — §1 I-025 error envelope tenant-blindness', () => {
  it('§1a 401 envelope on POST /consents without Bearer is tenant-blind', async () => {
    const versionId = await seedConsentVersion();
    const response = await app!.inject({
      method: 'POST',
      url: '/v0/consent/consents',
      headers: { host: 'localhost', 'idempotency-key': ulid() },
      payload: {
        consent_type: 'platform',
        consent_version_id: versionId,
        evidence: { timestamp: new Date().toISOString() },
      },
    });
    expect(response.statusCode).toBe(401);
    assertTenantBlind(response.body);
  });

  it('§1b 400 envelope on invalid consent_type is tenant-blind', async () => {
    const { accessToken } = await loginAndGetToken();
    const versionId = await seedConsentVersion();
    const response = await app!.inject({
      method: 'POST',
      url: '/v0/consent/consents',
      headers: {
        host: 'localhost',
        authorization: `Bearer ${accessToken}`,
        'idempotency-key': ulid(),
      },
      payload: {
        consent_type: 'made_up',
        consent_version_id: versionId,
        evidence: { timestamp: new Date().toISOString() },
      },
    });
    expect(response.statusCode).toBe(400);
    assertTenantBlind(response.body);
  });

  it('§1c 404 envelope on revoke-with-no-prior-grant is tenant-blind', async () => {
    const { accessToken } = await loginAndGetToken();
    const versionId = await seedConsentVersion();
    const response = await app!.inject({
      method: 'POST',
      url: '/v0/consent/consents/revoke',
      headers: {
        host: 'localhost',
        authorization: `Bearer ${accessToken}`,
        'idempotency-key': ulid(),
      },
      payload: {
        consent_type: 'platform',
        consent_version_id: versionId,
        reason: 'patient_initiated',
        evidence: { timestamp: new Date().toISOString() },
      },
    });
    expect(response.statusCode).toBe(404);
    assertTenantBlind(response.body);
  });

  it('§1d 400 envelope on invalid delegation relationship_type is tenant-blind', async () => {
    const { accessToken } = await loginAndGetToken();
    const response = await app!.inject({
      method: 'POST',
      url: '/v0/consent/delegations',
      headers: {
        host: 'localhost',
        authorization: `Bearer ${accessToken}`,
        'idempotency-key': ulid(),
      },
      payload: {
        delegate_account_id: ulid(),
        relationship_type: 'made_up',
      },
    });
    expect(response.statusCode).toBe(400);
    assertTenantBlind(response.body);
  });

  it('§1e 400 envelope on self-delegation is tenant-blind (DELEGATION_SELF_FORBIDDEN)', async () => {
    const { accessToken, accountId } = await loginAndGetToken();
    const response = await app!.inject({
      method: 'POST',
      url: '/v0/consent/delegations',
      headers: {
        host: 'localhost',
        authorization: `Bearer ${accessToken}`,
        'idempotency-key': ulid(),
      },
      payload: {
        delegate_account_id: accountId,
        relationship_type: 'spouse_partner',
      },
    });
    expect(response.statusCode).toBe(400);
    assertTenantBlind(response.body);
    // Sentinel code itself is fine (does not contain tenant/DBA structural
    // data — `consent.delegation.self_forbidden` is a stable string).
    const body = response.json<{ error: { code: string } }>();
    expect(body.error.code).toBe('consent.delegation.self_forbidden');
  });
});
