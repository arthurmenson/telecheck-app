/**
 * clinician-role-claim.test.ts — end-to-end test for the clinician-role
 * JWT mechanism per TLC-058 / 2026-05-13.
 *
 * Validates the seam between four layers:
 *   1. accounts.account_type CHECK admits 'clinician' (migration 027).
 *   2. session-service.issueSession looks up account_type and resolves
 *      the JWT role via sessionRoleForAccountType (private mapping).
 *   3. issueAccessToken stamps the resolved role into the JWT claims.
 *   4. verifyAccessToken accepts the canonical role values + rejects
 *      out-of-enum values at the JWT decode boundary.
 *
 * Coverage (4 groups, 10 cases):
 *
 *   Group A — account_type → role mapping at session issuance
 *     A1 account_type='clinician' → JWT carries role='clinician'
 *     A2 account_type='patient'   → JWT carries role='patient'
 *     A3 account_type='delegate'  → JWT carries role='patient' (delegate
 *        actor carries patient role + delegate_id discriminator per RBAC v1.1)
 *
 *   Group B — DB constraint round-trip
 *     B1 accounts INSERT with account_type='clinician' succeeds
 *     B2 accounts INSERT with account_type='admin' (out-of-enum) fails CHECK
 *
 *   Group C — JWT-layer role enum enforcement
 *     C1 verifyAccessToken accepts role='clinician'
 *     C2 verifyAccessToken rejects forged role='admin' as invalid_payload
 *
 *   Group D — Patient-only routes reject clinician JWTs (Codex R1 + R2 HIGH closures)
 *     D1 clinician JWT → 403 on POST /v0/async-consult
 *     D2 clinician JWT → 403 on GET /v0/pharmacy/prescriptions/:id
 *     D3 clinician JWT → 403 on POST /v0/pharmacy/prescriptions/:id/discontinue
 *     D4 clinician JWT → 403 on POST /v0/forms/submissions (Codex R2 HIGH closure)
 *     D5 clinician JWT → 403 on POST /v0/forms/resume (Codex R2 HIGH closure)
 *     D6 clinician JWT → 403 on GET /v0/forms/submissions/:submissionId/snapshot (R3)
 *     D7 clinician JWT → 403 on GET /v0/forms/snapshots/:snapshotId (R3)
 *     D8 patient B → 404 on GET /v0/consent/delegations/:id/scopes for patient A's delegation (R4)
 *     D9 patient B → 404 on POST /v0/consent/delegations/:id/accept (R5: ownership)
 *     D10 patient B → 404 on POST /v0/consent/delegations/:id/revoke (R5)
 *     D11 patient B → 404 on POST /v0/consent/delegations/:id/scopes/grant (R5)
 *     D12 cross-parent revoke-scope: passing own delegation id + victim scope id → 404 (R6)
 *
 * Spec references:
 *   - RBAC v1.1 §1.2 (Clinician role; tenant-scoped) + §6 (multi-tenant)
 *   - Identity & Authentication Spec v1.0 §3.3 (access token claims)
 *   - migrations/027_accounts_account_type_clinician.sql
 *   - migrations/012_accounts.sql (target table)
 *   - I-014 (canonical glossary — 'clinician', not 'doctor'/'physician')
 *   - I-023 (clinicians tenant-scoped via accounts.tenant_id)
 */

import crypto from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { config } from '../../src/lib/config.ts';
import { asTenantId, type TenantId } from '../../src/lib/glossary.ts';
import { verifyAccessToken } from '../../src/lib/jwt.ts';
import { ulid } from '../../src/lib/ulid.ts';
import * as accountRepo from '../../src/modules/identity/internal/repositories/account-repo.ts';
import * as sessionService from '../../src/modules/identity/internal/services/session-service.ts';
import { asAccountId, asSessionId } from '../../src/modules/identity/internal/types.ts';
import { TENANT_US, withTenantContext } from '../helpers/tenant-fixtures.ts';
import { uniquePhone } from '../helpers/unique-phone.ts';
import { getTestClient } from '../setup.ts';

const T_US: TenantId = asTenantId(TENANT_US);

const US_CTX = {
  tenantId: T_US,
  displayName: 'Telecheck-US',
  countryOfCare: 'US' as const,
  kmsKeyAlias: 'alias/telecheck-us-data-key',
  consumerDba: 'Heros Health',
  legalEntity: 'Telecheck Health LLC',
  consumerSubdomain: 'heroshealth.com',
};

/**
 * Insert an account with the specified account_type, bypassing the
 * service-layer's audit emission. Returns the new account_id.
 */
async function insertAccount(
  accountType: 'patient' | 'delegate' | 'clinician',
): Promise<ReturnType<typeof asAccountId>> {
  const accountId = asAccountId(ulid());
  await withTenantContext(T_US, () =>
    accountRepo.createAccount(
      {
        account_id: accountId,
        tenant_id: T_US,
        phone_e164: uniquePhone('+1'),
        first_name: 'A',
        last_name: 'B',
        date_of_birth: '1990-01-01',
        gender: 'prefer_not_to_say',
        country_of_residence: 'US',
        country_of_care: 'US',
        account_type: accountType,
      },
      async () => {
        /* no-op */
      },
    ),
  );
  return accountId;
}

// ===========================================================================
// Group A — account_type → role mapping at session issuance
// ===========================================================================

describe('clinician-role-claim — Group A: account_type → role mapping', () => {
  it('A1 account_type=clinician → JWT carries role=clinician', async () => {
    const clinicianId = await insertAccount('clinician');
    const sessionId = asSessionId(ulid());

    const { accessToken } = await sessionService.issueSession(
      US_CTX,
      { actorId: clinicianId },
      {
        session_id: sessionId,
        account_id: clinicianId,
      },
    );

    const result = verifyAccessToken(accessToken, config.jwtSigningKey);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.claims.role).toBe('clinician');
    expect(result.claims.sub).toBe(clinicianId);
    expect(result.claims.tenant_id).toBe(T_US);
  });

  it('A2 account_type=patient → JWT carries role=patient', async () => {
    const patientId = await insertAccount('patient');
    const sessionId = asSessionId(ulid());

    const { accessToken } = await sessionService.issueSession(
      US_CTX,
      { actorId: patientId },
      {
        session_id: sessionId,
        account_id: patientId,
      },
    );

    const result = verifyAccessToken(accessToken, config.jwtSigningKey);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.claims.role).toBe('patient');
  });

  it('A3 account_type=delegate → JWT carries role=patient (RBAC v1.1 §6 delegate flow)', async () => {
    // Delegates carry role='patient' in the session JWT; the
    // delegate-context discriminator (delegate_id claim) is set by
    // higher-level routing, not by issueSession. The session role
    // itself reflects the underlying patient surface authority.
    const delegateId = await insertAccount('delegate');
    const sessionId = asSessionId(ulid());

    const { accessToken } = await sessionService.issueSession(
      US_CTX,
      { actorId: delegateId },
      {
        session_id: sessionId,
        account_id: delegateId,
      },
    );

    const result = verifyAccessToken(accessToken, config.jwtSigningKey);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.claims.role).toBe('patient');
  });
});

// ===========================================================================
// Group B — DB constraint round-trip
// ===========================================================================

describe('clinician-role-claim — Group B: accounts.account_type CHECK', () => {
  it('B1 INSERT with account_type=clinician succeeds (migration 027)', async () => {
    const clinicianId = await insertAccount('clinician');
    // If the CHECK rejected the value, insertAccount would have thrown.
    // Verify the row landed by reading it back.
    const fetched = await withTenantContext(T_US, () =>
      accountRepo.findAccountById(T_US, clinicianId),
    );
    expect(fetched).not.toBeNull();
    expect(fetched?.account_type).toBe('clinician');
  });

  it('B2 INSERT with account_type=admin (out-of-enum) fails CHECK', async () => {
    // Bypass the service layer to attempt an out-of-enum INSERT. The
    // accounts_account_type_check constraint MUST reject.
    const accountId = ulid();
    await expect(
      withTenantContext(T_US, async () => {
        const client = getTestClient();
        await client.query(
          `INSERT INTO accounts (
              account_id, tenant_id, phone_e164,
              first_name, last_name, date_of_birth, gender, locale,
              country_of_residence, country_of_care,
              account_type, status
           ) VALUES ($1, $2, $3,
                     $4, $5, $6, $7, $8,
                     $9, $10,
                     $11, $12)`,
          [
            accountId,
            T_US,
            uniquePhone('+1'),
            'A',
            'B',
            '1990-01-01',
            'prefer_not_to_say',
            'en-US',
            'US',
            'US',
            'admin', // ← not in the CHECK enum
            'active',
          ],
        );
      }),
    ).rejects.toThrow(/accounts_account_type_check/);
  });
});

// ===========================================================================
// Group C — JWT-layer role enum enforcement
// ===========================================================================

describe('clinician-role-claim — Group C: verifyAccessToken role enum', () => {
  it('C1 verifyAccessToken accepts role=clinician', async () => {
    const clinicianId = await insertAccount('clinician');
    const sessionId = asSessionId(ulid());
    const { accessToken } = await sessionService.issueSession(
      US_CTX,
      { actorId: clinicianId },
      {
        session_id: sessionId,
        account_id: clinicianId,
      },
    );
    const result = verifyAccessToken(accessToken, config.jwtSigningKey);
    expect(result.ok).toBe(true);
  });

  it('C2 verifyAccessToken rejects forged role=admin as invalid_payload', async () => {
    const clinicianId = await insertAccount('clinician');
    const sessionId = asSessionId(ulid());
    const { accessToken } = await sessionService.issueSession(
      US_CTX,
      { actorId: clinicianId },
      {
        session_id: sessionId,
        account_id: clinicianId,
      },
    );

    // Forge: replace the role claim with 'admin' and re-sign with the
    // valid key. Only the role-enum check at verify time catches this.
    const segments = accessToken.split('.');
    const payload = JSON.parse(Buffer.from(segments[1]!, 'base64url').toString('utf8')) as Record<
      string,
      unknown
    >;
    payload.role = 'admin';
    const tamperedPayload = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const signingInput = `${segments[0]}.${tamperedPayload}`;
    const sig = crypto
      .createHmac('sha256', config.jwtSigningKey)
      .update(signingInput)
      .digest('base64url');
    const forged = `${signingInput}.${sig}`;

    const result = verifyAccessToken(forged, config.jwtSigningKey);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('invalid_payload');
  });
});

// ===========================================================================
// Group D — Patient-role gates reject clinician JWTs (Codex R1 HIGH closure)
//
// Widening the role enum without role gates would let clinician accounts
// drive patient-only workflows. The fix is `requirePatientActorContext()`
// on every patient handler; these tests prove a clinician JWT cannot
// reach patient-only routes via the auth path.
// ===========================================================================

describe('clinician-role-claim — Group D: patient-only routes reject clinician JWTs', () => {
  it('D1 clinician JWT → 403 on POST /v0/async-consult (patient-initiate)', async () => {
    // App fixture needed for HTTP-layer assertions. Lazy-import to keep
    // the unit-style §A-C tests from spinning up the app when only the
    // service-layer + DB layers are under test.
    const { buildApp } = await import('../../src/app.ts');
    const app = await buildApp({ logger: false });
    try {
      await app.ready();

      const clinicianId = await insertAccount('clinician');
      const sessionId = asSessionId(ulid());
      const { accessToken } = await sessionService.issueSession(
        US_CTX,
        { actorId: clinicianId },
        {
          session_id: sessionId,
          account_id: clinicianId,
        },
      );

      const r = await app.inject({
        method: 'POST',
        url: '/v0/async-consult',
        headers: {
          host: 'heroshealth.com',
          authorization: `Bearer ${accessToken}`,
          'idempotency-key': ulid(),
        },
        payload: {
          account_id: clinicianId,
          consult_type: 'general',
          modality: 'async',
        },
      });

      expect(r.statusCode).toBe(403);
      const body = r.json<{ error: { code: string } }>();
      expect(body.error.code).toBe('internal.auth.insufficient_scope');
    } finally {
      await app.close();
    }
  });

  it('D2 clinician JWT → 403 on GET /v0/pharmacy/prescriptions/:id (patient-self read)', async () => {
    const { buildApp } = await import('../../src/app.ts');
    const app = await buildApp({ logger: false });
    try {
      await app.ready();

      const clinicianId = await insertAccount('clinician');
      const sessionId = asSessionId(ulid());
      const { accessToken } = await sessionService.issueSession(
        US_CTX,
        { actorId: clinicianId },
        {
          session_id: sessionId,
          account_id: clinicianId,
        },
      );

      const r = await app.inject({
        method: 'GET',
        url: `/v0/pharmacy/prescriptions/mrx_${ulid()}`,
        headers: {
          host: 'heroshealth.com',
          authorization: `Bearer ${accessToken}`,
        },
      });

      expect(r.statusCode).toBe(403);
      const body = r.json<{ error: { code: string } }>();
      expect(body.error.code).toBe('internal.auth.insufficient_scope');
    } finally {
      await app.close();
    }
  });

  it('D3 clinician JWT → 403 on POST /v0/pharmacy/prescriptions/:id/discontinue (patient-self write)', async () => {
    const { buildApp } = await import('../../src/app.ts');
    const app = await buildApp({ logger: false });
    try {
      await app.ready();

      const clinicianId = await insertAccount('clinician');
      const sessionId = asSessionId(ulid());
      const { accessToken } = await sessionService.issueSession(
        US_CTX,
        { actorId: clinicianId },
        {
          session_id: sessionId,
          account_id: clinicianId,
        },
      );

      const r = await app.inject({
        method: 'POST',
        url: `/v0/pharmacy/prescriptions/mrx_${ulid()}/discontinue`,
        headers: {
          host: 'heroshealth.com',
          authorization: `Bearer ${accessToken}`,
          'idempotency-key': ulid(),
        },
        payload: {},
      });

      expect(r.statusCode).toBe(403);
      const body = r.json<{ error: { code: string } }>();
      expect(body.error.code).toBe('internal.auth.insufficient_scope');
    } finally {
      await app.close();
    }
  });

  it('D4 clinician JWT → 403 on POST /v0/forms/submissions (Codex R2 HIGH closure)', async () => {
    // Forms-intake submissions.ts:resolvePatient previously trusted any
    // actorContext as the patient anchor. R2 closure: requirePatient-
    // ActorContext gate inside resolvePatient; clinician JWT must 403.
    const { buildApp } = await import('../../src/app.ts');
    const app = await buildApp({ logger: false });
    try {
      await app.ready();

      const clinicianId = await insertAccount('clinician');
      const sessionId = asSessionId(ulid());
      const { accessToken } = await sessionService.issueSession(
        US_CTX,
        { actorId: clinicianId },
        {
          session_id: sessionId,
          account_id: clinicianId,
        },
      );

      const r = await app.inject({
        method: 'POST',
        url: '/v0/forms/submissions',
        headers: {
          host: 'heroshealth.com',
          authorization: `Bearer ${accessToken}`,
          'idempotency-key': ulid(),
        },
        // Body shape is irrelevant — the role gate runs at resolvePatient
        // BEFORE the body is validated. A clinician JWT must 403 here
        // regardless of body content.
        payload: { deployment_id: ulid(), responses: {} },
      });

      expect(r.statusCode).toBe(403);
      const body = r.json<{ error: { code: string } }>();
      expect(body.error.code).toBe('internal.auth.insufficient_scope');
    } finally {
      await app.close();
    }
  });

  it('D5 clinician JWT → 403 on POST /v0/forms/resume (Codex R2 HIGH closure)', async () => {
    // resume.ts:resolveActorId previously trusted any actorContext.
    // R2 closure: requirePatientActorContext gate; clinician 403.
    const { buildApp } = await import('../../src/app.ts');
    const app = await buildApp({ logger: false });
    try {
      await app.ready();

      const clinicianId = await insertAccount('clinician');
      const sessionId = asSessionId(ulid());
      const { accessToken } = await sessionService.issueSession(
        US_CTX,
        { actorId: clinicianId },
        {
          session_id: sessionId,
          account_id: clinicianId,
        },
      );

      const r = await app.inject({
        method: 'POST',
        url: '/v0/forms/resume',
        headers: {
          host: 'heroshealth.com',
          authorization: `Bearer ${accessToken}`,
          'idempotency-key': ulid(),
          'x-patient-id': ulid(),
        },
        payload: { resumeToken: 'irrelevant-the-gate-fires-first' },
      });

      expect(r.statusCode).toBe(403);
      const body = r.json<{ error: { code: string } }>();
      expect(body.error.code).toBe('internal.auth.insufficient_scope');
    } finally {
      await app.close();
    }
  });

  it('D6 clinician JWT → 403 on GET /v0/forms/submissions/:submissionId/snapshot (Codex R3 HIGH closure)', async () => {
    // Patient-facing snapshot read — file-level docstring on
    // snapshots.ts says clinician case-review uses a different auth
    // boundary. R3 closure: requirePatientActorContext gate.
    const { buildApp } = await import('../../src/app.ts');
    const app = await buildApp({ logger: false });
    try {
      await app.ready();

      const clinicianId = await insertAccount('clinician');
      const sessionId = asSessionId(ulid());
      const { accessToken } = await sessionService.issueSession(
        US_CTX,
        { actorId: clinicianId },
        {
          session_id: sessionId,
          account_id: clinicianId,
        },
      );

      const r = await app.inject({
        method: 'GET',
        url: `/v0/forms/submissions/${ulid()}/snapshot`,
        headers: {
          host: 'heroshealth.com',
          authorization: `Bearer ${accessToken}`,
        },
      });

      expect(r.statusCode).toBe(403);
      const body = r.json<{ error: { code: string } }>();
      expect(body.error.code).toBe('internal.auth.insufficient_scope');
    } finally {
      await app.close();
    }
  });

  it('D8 patient B → 404 on GET /v0/consent/delegations/:id/scopes for patient A delegation (R4)', async () => {
    // Codex R4 surfaced this beyond the role-gate sweep: even with
    // requirePatientActorContext blocking clinicians, the handler
    // listed scopes by tenant+delegation_id only — same-tenant
    // patient B could enumerate patient A's delegation scopes. R4
    // closure: ownership check (actor must be grantor or delegate).
    const { buildApp } = await import('../../src/app.ts');
    const app = await buildApp({ logger: false });
    try {
      await app.ready();

      // Patient A is grantor, patient C is delegate (the two parties
      // bound to the delegation). Patient B is uninvolved.
      const patientA = await insertAccount('patient');
      const patientC = await insertAccount('patient');
      const patientB = await insertAccount('patient');

      // Seed an active delegation A → C directly (bypasses the
      // invite/accept flow for fixture brevity).
      const delegationId = ulid();
      await withTenantContext(T_US, async () => {
        const client = getTestClient();
        await client.query(
          `INSERT INTO delegations (
              delegation_id, tenant_id, grantor_account_id, delegate_account_id,
              relationship_type, status, accepted_at
           ) VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
          [delegationId, T_US, patientA, patientC, 'spouse_partner', 'active'],
        );
      });

      // Mint a token for patient B (the uninvolved third party).
      const sessionIdB = asSessionId(ulid());
      const { accessToken: tokenB } = await sessionService.issueSession(
        US_CTX,
        { actorId: patientB },
        {
          session_id: sessionIdB,
          account_id: patientB,
        },
      );

      // Patient B requests the scopes for patient A's delegation.
      // Without the ownership check, this would return [] (empty
      // array since no scopes are seeded); with R4 closure, it
      // returns tenant-blind 404.
      const r = await app.inject({
        method: 'GET',
        url: `/v0/consent/delegations/${delegationId}/scopes`,
        headers: {
          host: 'heroshealth.com',
          authorization: `Bearer ${tokenB}`,
        },
      });

      expect(r.statusCode).toBe(404);
      const body = r.json<{ error: { code: string } }>();
      expect(body.error.code).toBe('internal.resource.not_found');
    } finally {
      await app.close();
    }
  });

  it('D7 clinician JWT → 403 on GET /v0/forms/snapshots/:snapshotId (Codex R3 HIGH closure)', async () => {
    const { buildApp } = await import('../../src/app.ts');
    const app = await buildApp({ logger: false });
    try {
      await app.ready();

      const clinicianId = await insertAccount('clinician');
      const sessionId = asSessionId(ulid());
      const { accessToken } = await sessionService.issueSession(
        US_CTX,
        { actorId: clinicianId },
        {
          session_id: sessionId,
          account_id: clinicianId,
        },
      );

      const r = await app.inject({
        method: 'GET',
        url: `/v0/forms/snapshots/${ulid()}`,
        headers: {
          host: 'heroshealth.com',
          authorization: `Bearer ${accessToken}`,
        },
      });

      expect(r.statusCode).toBe(403);
      const body = r.json<{ error: { code: string } }>();
      expect(body.error.code).toBe('internal.auth.insufficient_scope');
    } finally {
      await app.close();
    }
  });

  it('D9 patient B → 404 on POST /v0/consent/delegations/:id/accept for patient A delegation (R5)', async () => {
    // Cross-patient acceptance attempt — patient B tries to accept a
    // pending delegation between A (grantor) and C (delegate).
    const { buildApp } = await import('../../src/app.ts');
    const app = await buildApp({ logger: false });
    try {
      await app.ready();
      const patientA = await insertAccount('patient');
      const patientC = await insertAccount('patient');
      const patientB = await insertAccount('patient');
      const delegationId = ulid();
      await withTenantContext(T_US, async () => {
        const client = getTestClient();
        await client.query(
          `INSERT INTO delegations (
              delegation_id, tenant_id, grantor_account_id, delegate_account_id,
              relationship_type, status
           ) VALUES ($1, $2, $3, $4, $5, $6)`,
          [delegationId, T_US, patientA, patientC, 'spouse_partner', 'pending_acceptance'],
        );
      });
      const sessionIdB = asSessionId(ulid());
      const { accessToken: tokenB } = await sessionService.issueSession(
        US_CTX,
        { actorId: patientB },
        { session_id: sessionIdB, account_id: patientB },
      );
      const r = await app.inject({
        method: 'POST',
        url: `/v0/consent/delegations/${delegationId}/accept`,
        headers: {
          host: 'heroshealth.com',
          authorization: `Bearer ${tokenB}`,
          'idempotency-key': ulid(),
        },
        payload: {},
      });
      expect(r.statusCode).toBe(404);
      const body = r.json<{ error: { code: string } }>();
      expect(body.error.code).toBe('internal.resource.not_found');
    } finally {
      await app.close();
    }
  });

  it('D10 patient B → 404 on POST /v0/consent/delegations/:id/revoke for patient A delegation (R5)', async () => {
    const { buildApp } = await import('../../src/app.ts');
    const app = await buildApp({ logger: false });
    try {
      await app.ready();
      const patientA = await insertAccount('patient');
      const patientC = await insertAccount('patient');
      const patientB = await insertAccount('patient');
      const delegationId = ulid();
      await withTenantContext(T_US, async () => {
        const client = getTestClient();
        await client.query(
          `INSERT INTO delegations (
              delegation_id, tenant_id, grantor_account_id, delegate_account_id,
              relationship_type, status, accepted_at
           ) VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
          [delegationId, T_US, patientA, patientC, 'spouse_partner', 'active'],
        );
      });
      const sessionIdB = asSessionId(ulid());
      const { accessToken: tokenB } = await sessionService.issueSession(
        US_CTX,
        { actorId: patientB },
        { session_id: sessionIdB, account_id: patientB },
      );
      const r = await app.inject({
        method: 'POST',
        url: `/v0/consent/delegations/${delegationId}/revoke`,
        headers: {
          host: 'heroshealth.com',
          authorization: `Bearer ${tokenB}`,
          'idempotency-key': ulid(),
        },
        payload: { reason: 'patient_initiated' },
      });
      expect(r.statusCode).toBe(404);
      const body = r.json<{ error: { code: string } }>();
      expect(body.error.code).toBe('internal.resource.not_found');
    } finally {
      await app.close();
    }
  });

  it('D11 patient B → 404 on POST /v0/consent/delegations/:id/scopes (grant) for patient A delegation (R5)', async () => {
    const { buildApp } = await import('../../src/app.ts');
    const app = await buildApp({ logger: false });
    try {
      await app.ready();
      const patientA = await insertAccount('patient');
      const patientC = await insertAccount('patient');
      const patientB = await insertAccount('patient');
      const delegationId = ulid();
      await withTenantContext(T_US, async () => {
        const client = getTestClient();
        await client.query(
          `INSERT INTO delegations (
              delegation_id, tenant_id, grantor_account_id, delegate_account_id,
              relationship_type, status, accepted_at
           ) VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
          [delegationId, T_US, patientA, patientC, 'spouse_partner', 'active'],
        );
      });
      const sessionIdB = asSessionId(ulid());
      const { accessToken: tokenB } = await sessionService.issueSession(
        US_CTX,
        { actorId: patientB },
        { session_id: sessionIdB, account_id: patientB },
      );
      const r = await app.inject({
        method: 'POST',
        url: `/v0/consent/delegations/${delegationId}/scopes`,
        headers: {
          host: 'heroshealth.com',
          authorization: `Bearer ${tokenB}`,
          'idempotency-key': ulid(),
        },
        payload: { scope: 'view_medications' },
      });
      expect(r.statusCode).toBe(404);
      const body = r.json<{ error: { code: string } }>();
      expect(body.error.code).toBe('internal.resource.not_found');
    } finally {
      await app.close();
    }
  });

  it('D12 cross-parent revoke-scope: own delegation id + victim scope id → 404 + victim scope unchanged (R6)', async () => {
    // Subtle attack uncovered by Codex R6: handler verified actor is
    // grantor of the URL :id (delegation id), but the underlying
    // UPDATE filtered ONLY by scope_id. So a patient who owns
    // delegation X could pass their own X as :id (passes ownership)
    // and a victim's :scopeId from delegation Y — and the UPDATE
    // would still land on the victim's scope.
    //
    // Fix verified here: revokeDelegationScope now binds the UPDATE
    // to (tenant_id, delegation_id, scope_id) so the mismatched pair
    // matches zero rows and the caller gets 404. The victim's scope
    // MUST remain active after the failed attempt.
    const { buildApp } = await import('../../src/app.ts');
    const app = await buildApp({ logger: false });
    try {
      await app.ready();

      // Victim setup: delegation Y owned by patient A → delegate C, with
      // an active scope.
      const patientA = await insertAccount('patient');
      const patientC = await insertAccount('patient');
      const victimDelegationId = ulid();
      const victimScopeId = ulid();
      await withTenantContext(T_US, async () => {
        const client = getTestClient();
        await client.query(
          `INSERT INTO delegations (
              delegation_id, tenant_id, grantor_account_id, delegate_account_id,
              relationship_type, status, accepted_at
           ) VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
          [victimDelegationId, T_US, patientA, patientC, 'spouse_partner', 'active'],
        );
        await client.query(
          `INSERT INTO delegation_scopes (
              delegation_scope_id, tenant_id, delegation_id, scope, granted_at
           ) VALUES ($1, $2, $3, $4, NOW())`,
          [victimScopeId, T_US, victimDelegationId, 'view_medications'],
        );
      });

      // Attacker setup: delegation X owned by patient B (the attacker)
      // as grantor → patient D as delegate.
      const patientB = await insertAccount('patient');
      const patientD = await insertAccount('patient');
      const attackerDelegationId = ulid();
      await withTenantContext(T_US, async () => {
        const client = getTestClient();
        await client.query(
          `INSERT INTO delegations (
              delegation_id, tenant_id, grantor_account_id, delegate_account_id,
              relationship_type, status, accepted_at
           ) VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
          [attackerDelegationId, T_US, patientB, patientD, 'spouse_partner', 'active'],
        );
      });

      // Patient B's token (B is attacker; owns attackerDelegationId).
      const sessionIdB = asSessionId(ulid());
      const { accessToken: tokenB } = await sessionService.issueSession(
        US_CTX,
        { actorId: patientB },
        { session_id: sessionIdB, account_id: patientB },
      );

      // Attack: URL :id = attacker's delegation (passes ownership);
      // URL :scopeId = victim's scope (from a different delegation).
      const r = await app.inject({
        method: 'DELETE',
        url: `/v0/consent/delegations/${attackerDelegationId}/scopes/${victimScopeId}`,
        headers: {
          host: 'heroshealth.com',
          authorization: `Bearer ${tokenB}`,
          'idempotency-key': ulid(),
        },
      });

      // Expected: 404 (the UPDATE matches zero rows because the scope
      // belongs to a different delegation_id).
      expect(r.statusCode).toBe(404);

      // Critical assertion: victim's scope MUST remain active. If the
      // mutation had landed, revoked_at would be set. Read directly
      // from the DB to bypass any handler-layer filtering.
      const stillActive = await withTenantContext(T_US, async () => {
        const client = getTestClient();
        const result = await client.query<{ revoked_at: Date | null }>(
          `SELECT revoked_at FROM delegation_scopes WHERE delegation_scope_id = $1`,
          [victimScopeId],
        );
        return result.rows[0]?.revoked_at;
      });
      expect(stillActive ?? null).toBeNull();
    } finally {
      await app.close();
    }
  });
});
