/**
 * Consent slice — HTTP integration test.
 *
 * Exercises POST /v0/consent/consents (grant) + revoke + GET /me
 * end-to-end via Fastify inject() with Bearer JWT auth.
 *
 * Coverage in this file (3 sections, 7 cases).
 *
 * Spec references:
 *   - src/modules/consent/internal/handlers/consents.ts (target)
 *   - Consent Slice PRD v1.0 §5-§9
 *   - I-025 (tenant-blind error envelopes)
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

/**
 * Register + activate an account, log in, return the JWT access token.
 */
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

  // Issue OTP via service so we know the plaintext code
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
  const versionId = asConsentVersionId(ulid());
  await withTenantContext(T_US, () =>
    createConsentVersion(
      {
        consent_version_id: versionId,
        tenant_id: T_US,
        consent_type: 'platform',
        version_label: 'v1.0',
        terms_text: 'You agree to use Telecheck.',
      },
      getTestClient(),
    ),
  );
  return versionId;
}

// ---------------------------------------------------------------------------
// §1 — POST /consents grant
// ---------------------------------------------------------------------------

describe('consent HTTP — §1 POST /consents grant', () => {
  it('§1a happy path: grant returns 201 + PatientConsentView (no tenant_id)', async () => {
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
        consent_type: 'platform',
        consent_version_id: versionId,
        evidence: {
          timestamp: new Date().toISOString(),
          type: 'in_app',
          device_id: 'd_test',
        },
      },
    });

    expect(response.statusCode).toBe(201);
    const body = response.json<{ consent_id: string; status: string }>();
    expect(body.consent_id).toBeTruthy();
    expect(body.status).toBe('granted');
    expect(response.body).not.toContain('"tenant_id"');
    expect(response.body).not.toContain('Telecheck-US');
  });

  it('§1b 401 without Bearer JWT', async () => {
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
  });

  it('§1c 400 invalid consent_type', async () => {
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
  });

  it('§1d 400 evidence missing timestamp key', async () => {
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
        consent_type: 'platform',
        consent_version_id: versionId,
        evidence: { type: 'in_app' }, // no timestamp
      },
    });
    expect(response.statusCode).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// §2 — POST /consents/revoke
// ---------------------------------------------------------------------------

describe('consent HTTP — §2 POST /consents/revoke', () => {
  it('§2a happy path: grant then revoke', async () => {
    const { accessToken } = await loginAndGetToken();
    const versionId = await seedConsentVersion();

    // Grant first
    await app!.inject({
      method: 'POST',
      url: '/v0/consent/consents',
      headers: {
        host: 'localhost',
        authorization: `Bearer ${accessToken}`,
        'idempotency-key': ulid(),
      },
      payload: {
        consent_type: 'platform',
        consent_version_id: versionId,
        evidence: { timestamp: new Date().toISOString() },
      },
    });

    // Revoke
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
    expect(response.statusCode).toBe(200);
    const body = response.json<{ status: string; revocation_reason: string }>();
    expect(body.status).toBe('revoked');
    expect(body.revocation_reason).toBe('patient_initiated');
  });

  it('§2b 404 when no active consent to revoke', async () => {
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
  });
});

// ---------------------------------------------------------------------------
// §3 — GET /consents/me
// ---------------------------------------------------------------------------

describe('consent HTTP — §3 GET /consents/me', () => {
  it('§3a returns consent history (granted + revoked rows)', async () => {
    const { accessToken } = await loginAndGetToken();
    const versionId = await seedConsentVersion();

    // Grant + revoke
    await app!.inject({
      method: 'POST',
      url: '/v0/consent/consents',
      headers: {
        host: 'localhost',
        authorization: `Bearer ${accessToken}`,
        'idempotency-key': ulid(),
      },
      payload: {
        consent_type: 'platform',
        consent_version_id: versionId,
        evidence: { timestamp: new Date().toISOString() },
      },
    });
    await app!.inject({
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

    const response = await app!.inject({
      method: 'GET',
      url: '/v0/consent/consents/me',
      headers: { host: 'localhost', authorization: `Bearer ${accessToken}` },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json<{ consents: Array<{ status: string }> }>();
    expect(body.consents.length).toBeGreaterThanOrEqual(2);
    expect(response.body).not.toContain('"tenant_id"');
    expect(response.body).not.toContain('Telecheck-US');
  });
});
