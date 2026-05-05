/**
 * Consent slice — idempotency replay regression for /v0/consent endpoints.
 *
 * The generic idempotency-http.test.ts proves the plugin works against
 * /v0/forms/templates. This file extends that coverage to the consent
 * slice's mutating endpoints — proving same-key-same-body returns the
 * cached response WITHOUT re-running the handler (no second consent row,
 * no duplicate audit emission), and same-key-different-body returns 409
 * `internal.idempotency.body_mismatch`.
 *
 * Discrimination strategy:
 *   The consent table is append-only per Slice PRD §7.1, so a duplicate
 *   handler-run would write a SECOND `granted` row with a different
 *   consent_id but the same (tenant, account, consent_type, version)
 *   tuple. Counting consent rows with that tuple is the canonical "did
 *   the handler run twice" probe — the audit table is parallel evidence
 *   (a duplicate run emits a second `consent_granted` audit record).
 *
 * Coverage in this file (1 section, 3 cases):
 *   §1a POST /consents replay — same key + same body returns cached
 *       response; consent table has exactly 1 row; audit has exactly 1
 *       consent_granted emission for that consent_id
 *   §1b POST /consents body mismatch — same key + different body returns
 *       409 internal.idempotency.body_mismatch with tenant-blind envelope
 *   §1c POST /delegations replay — same key + same body returns cached
 *       delegation_id; delegations table has exactly 1 matching row
 *
 * Spec references:
 *   - IDEMPOTENCY v5.1 (key format, 4-tuple PK, body-hash check)
 *   - I-003 (audit append-only; cached response replay must NOT re-emit)
 *   - I-025 (tenant-blind error envelopes — verified on the 409 body
 *     mismatch path)
 *   - Consent Slice PRD v1.0 §7.1 (append-only consent history)
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

describe('consent slice — §1 idempotency replay', () => {
  it('§1a POST /consents replay returns cached response + no duplicate row + no duplicate audit', async () => {
    const { accessToken, accountId } = await loginAndGetToken();
    const versionId = await seedConsentVersion();
    const idempotencyKey = ulid();
    const payload = {
      consent_type: 'platform' as const,
      consent_version_id: versionId,
      evidence: { timestamp: new Date().toISOString(), type: 'in_app' as const, device_id: 'd_1a' },
    };

    // First call — real handler runs, consent row + audit emitted.
    const first = await app!.inject({
      method: 'POST',
      url: '/v0/consent/consents',
      headers: {
        host: 'localhost',
        authorization: `Bearer ${accessToken}`,
        'idempotency-key': idempotencyKey,
      },
      payload,
    });
    expect(first.statusCode).toBe(201);
    const firstBody = first.json<{ consent_id: string }>();
    expect(firstBody.consent_id).toBeTruthy();

    // Second call with identical key + body — must replay the cached
    // response without re-running the handler. consent_id must match.
    const second = await app!.inject({
      method: 'POST',
      url: '/v0/consent/consents',
      headers: {
        host: 'localhost',
        authorization: `Bearer ${accessToken}`,
        'idempotency-key': idempotencyKey,
      },
      payload,
    });
    expect(second.statusCode).toBe(201);
    const secondBody = second.json<{ consent_id: string }>();
    expect(secondBody.consent_id).toBe(firstBody.consent_id);

    // Side-effect probe: exactly ONE consent row for this account+version.
    // The consent table is append-only (Slice PRD §7.1) — a duplicate
    // handler-run would write a SECOND `granted` row with a different
    // consent_id, which this query would catch. Wrapped in withTenantContext
    // because the test client's tenant binding from earlier
    // withTenantContext calls in loginAndGetToken may have been rolled back
    // or expired before reaching this assertion (the binding is stored in
    // a tx-scoped row in _session_tenant_context per migration 003).
    const consentCount = await withTenantContext(T_US, async () => {
      const r = await getTestClient().query<{ c: string }>(
        `SELECT COUNT(*)::text AS c FROM consent
           WHERE tenant_id = $1 AND account_id = $2 AND consent_version_id = $3`,
        [T_US, accountId, versionId],
      );
      return Number.parseInt(r.rows[0]!.c, 10);
    });
    expect(consentCount).toBe(1);

    // Parallel audit-side probe: exactly ONE consent_granted audit for
    // this consent_id. A re-run handler would emit a second audit row.
    const auditCount = await withTenantContext(T_US, async () => {
      const r = await getTestClient().query<{ c: string }>(
        `SELECT COUNT(*)::text AS c FROM audit_records
           WHERE tenant_id = $1 AND action = 'consent_granted' AND resource_id = $2`,
        [T_US, firstBody.consent_id],
      );
      return Number.parseInt(r.rows[0]!.c, 10);
    });
    expect(auditCount).toBe(1);
  });

  it('§1b POST /consents same key + different body returns 409 tenant-blind', async () => {
    const { accessToken } = await loginAndGetToken();
    const versionId = await seedConsentVersion();
    const idempotencyKey = ulid();
    const firstPayload = {
      consent_type: 'platform' as const,
      consent_version_id: versionId,
      evidence: { timestamp: new Date().toISOString(), type: 'in_app' as const },
    };

    const first = await app!.inject({
      method: 'POST',
      url: '/v0/consent/consents',
      headers: {
        host: 'localhost',
        authorization: `Bearer ${accessToken}`,
        'idempotency-key': idempotencyKey,
      },
      payload: firstPayload,
    });
    expect(first.statusCode).toBe(201);

    // Second call with same key but DIFFERENT evidence.device_id (different
    // body hash). Must return 409 internal.idempotency.body_mismatch.
    const second = await app!.inject({
      method: 'POST',
      url: '/v0/consent/consents',
      headers: {
        host: 'localhost',
        authorization: `Bearer ${accessToken}`,
        'idempotency-key': idempotencyKey,
      },
      payload: {
        ...firstPayload,
        evidence: { ...firstPayload.evidence, device_id: 'different' },
      },
    });
    expect(second.statusCode).toBe(409);
    const body = second.json<{ error?: { code?: string } }>();
    expect(body.error?.code).toBe('internal.idempotency.body_mismatch');
    // I-025 tenant-blindness on the conflict envelope
    expect(second.body).not.toContain('Telecheck-US');
    expect(second.body).not.toContain('Heros Health');
  });

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
