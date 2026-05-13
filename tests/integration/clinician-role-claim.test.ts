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
 * Coverage (3 groups, 7 cases):
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
