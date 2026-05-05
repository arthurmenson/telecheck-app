/**
 * Cross-tenant isolation — identity slice services (I-023 / I-024 / I-025).
 *
 * Sprint 1 / TLC-002. Mirror of consent-cross-tenant-isolation.test.ts
 * shape, scaled to the 4 identity entities.
 *
 * Coverage in this file (4 sections, 8 cases):
 *   §1 account-service (2 cases) — Ghana account; US tries activate;
 *      US findAccountById returns null
 *   §2 session-service (2 cases) — Ghana session; US tries revoke;
 *      US findSessionById returns null
 *   §3 otp-service (2 cases) — Ghana otp; US tries verify; US
 *      findLatestActiveOtp returns null
 *   §4 auth-device-service (2 cases) — Ghana device; US tries revoke;
 *      US listActiveDevicesForAccount returns empty
 *
 * The pattern: seed in Ghana, attack from US, assert null/empty/0-affected
 * + no spurious US-tenant audit emission.
 *
 * Spec references:
 *   - I-023 (three-layer tenant isolation: RLS + app-layer + per-tenant KMS)
 *   - I-024 (cross-actor / break-glass discipline)
 *   - I-025 (tenant-blind error envelopes; null return = "tenant-blind
 *     not-found" surface for service layer)
 *   - Identity Spec §3
 */

import { describe, expect, it } from 'vitest';

import { asTenantId } from '../../src/lib/glossary.ts';
import type { TenantContext } from '../../src/lib/tenant-context.ts';
import { ulid } from '../../src/lib/ulid.ts';
import * as accountRepo from '../../src/modules/identity/internal/repositories/account-repo.ts';
import * as deviceRepo from '../../src/modules/identity/internal/repositories/auth-device-repo.ts';
import * as otpRepo from '../../src/modules/identity/internal/repositories/otp-repo.ts';
import * as sessionRepo from '../../src/modules/identity/internal/repositories/session-repo.ts';
import * as accountService from '../../src/modules/identity/internal/services/account-service.ts';
import * as authDeviceService from '../../src/modules/identity/internal/services/auth-device-service.ts';
import * as otpService from '../../src/modules/identity/internal/services/otp-service.ts';
import * as sessionService from '../../src/modules/identity/internal/services/session-service.ts';
import {
  asAccountId,
  asDeviceId,
  asOtpId,
  asSessionId,
  type AccountId,
} from '../../src/modules/identity/internal/types.ts';
import { TENANT_GHANA, TENANT_US, withTenantContext } from '../helpers/tenant-fixtures.ts';
import { uniquePhone } from '../helpers/unique-phone.ts';
import { getTestClient } from '../setup.ts';

const T_US = asTenantId(TENANT_US);
const T_GH = asTenantId(TENANT_GHANA);

const US_CTX: TenantContext = {
  tenantId: T_US,
  displayName: 'Telecheck-US',
  countryOfCare: 'US',
  kmsKeyAlias: 'alias/telecheck-us-data-key',
  consumerDba: 'Heros Health',
  legalEntity: 'Telecheck Health LLC',
  consumerSubdomain: 'heroshealth.com',
};
const GH_CTX: TenantContext = {
  tenantId: T_GH,
  displayName: 'Telecheck-Ghana',
  countryOfCare: 'GH',
  kmsKeyAlias: 'alias/telecheck-gh-data-key',
  consumerDba: 'Heros Health Ghana',
  legalEntity: 'Telecheck-Ghana Ltd.',
  consumerSubdomain: 'ghana.heroshealth.com',
};

// ---------------------------------------------------------------------------
// Fixture helper
// ---------------------------------------------------------------------------

async function seedGhanaAccount(): Promise<{ accountId: AccountId; phone: string }> {
  const phone = uniquePhone('+233');
  const accountId = asAccountId(ulid());
  await withTenantContext(T_GH, () =>
    accountService.createAccount(
      GH_CTX,
      { actorId: 'op_gh_seed' },
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
  return { accountId, phone };
}

// ---------------------------------------------------------------------------
// §1 — account-service cross-tenant attempts
// ---------------------------------------------------------------------------

describe('identity cross-tenant isolation §1 account-service', () => {
  it('§1a US ctx cannot activate a Ghana account (returns null + no spurious audit)', async () => {
    const { accountId } = await seedGhanaAccount();

    const result = await withTenantContext(T_US, () =>
      accountService.activateAccount(
        US_CTX,
        { actorId: 'op_us_attacker' },
        accountId,
        getTestClient(),
      ),
    );
    expect(result).toBeNull();

    // No `identity_account_activated` audit row in US tenant for this account
    const us = await getTestClient().query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM audit_records
        WHERE tenant_id = $1
          AND action = 'identity_account_activated'
          AND resource_id = $2`,
      [T_US, accountId],
    );
    expect(us.rows[0]!.count).toBe('0');
  });

  it('§1b US ctx findAccountById on Ghana account returns null (RLS-filtered)', async () => {
    const { accountId } = await seedGhanaAccount();

    const found = await withTenantContext(T_US, () =>
      accountRepo.findAccountById(T_US, accountId, getTestClient()),
    );
    expect(found).toBeNull();

    // Sanity: visible from Ghana ctx
    const ghFound = await withTenantContext(T_GH, () =>
      accountRepo.findAccountById(T_GH, accountId, getTestClient()),
    );
    expect(ghFound).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// §2 — session-service cross-tenant attempts
// ---------------------------------------------------------------------------

describe('identity cross-tenant isolation §2 session-service', () => {
  it('§2a US ctx cannot revoke a Ghana session (returns null + no spurious audit)', async () => {
    const { accountId } = await seedGhanaAccount();
    const sessionId = asSessionId(ulid());
    await withTenantContext(T_GH, () =>
      sessionService.issueSession(
        GH_CTX,
        { actorId: 'op_gh_session' },
        { session_id: sessionId, account_id: accountId },
        getTestClient(),
      ),
    );

    const result = await withTenantContext(T_US, () =>
      sessionService.revokeSession(
        US_CTX,
        { actorId: 'op_us_attacker' },
        sessionId,
        'patient_logout',
        getTestClient(),
      ),
    );
    expect(result).toBeNull();

    const us = await getTestClient().query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM audit_records
        WHERE tenant_id = $1
          AND action = 'identity_session_revoked'
          AND resource_id = $2`,
      [T_US, sessionId],
    );
    expect(us.rows[0]!.count).toBe('0');
  });

  it('§2b US ctx findSessionById on Ghana session returns null (RLS)', async () => {
    const { accountId } = await seedGhanaAccount();
    const sessionId = asSessionId(ulid());
    await withTenantContext(T_GH, () =>
      sessionService.issueSession(
        GH_CTX,
        { actorId: 'op_gh_session_2b' },
        { session_id: sessionId, account_id: accountId },
        getTestClient(),
      ),
    );

    const found = await withTenantContext(T_US, () =>
      sessionRepo.findSessionById(T_US, sessionId, getTestClient()),
    );
    expect(found).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// §3 — otp-service cross-tenant attempts
// ---------------------------------------------------------------------------

describe('identity cross-tenant isolation §3 otp-service', () => {
  it('§3a US ctx verifyOtp on a Ghana-issued OTP returns no_active_challenge', async () => {
    const { accountId, phone } = await seedGhanaAccount();
    const otpId = asOtpId(ulid());
    const { codePlaintext } = await withTenantContext(T_GH, () =>
      otpService.issueOtp(
        GH_CTX,
        { actorId: 'op_gh_otp' },
        { otp_id: otpId, account_id: accountId, phone_e164: phone, purpose: 'login' },
        getTestClient(),
      ),
    );

    // Attack from US ctx with the same phone + correct code — RLS hides
    // the Ghana OTP, so verify reports OTP_NO_ACTIVE_CHALLENGE.
    const result = await withTenantContext(T_US, () =>
      otpService.verifyOtp(
        US_CTX,
        { actorId: 'op_us_attacker' },
        { phone_e164: phone, purpose: 'login', code: codePlaintext },
        getTestClient(),
      ),
    );
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe(otpService.OTP_NO_ACTIVE_CHALLENGE);

    // No `identity_otp_consumed` audit emitted in US tenant
    const us = await getTestClient().query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM audit_records
        WHERE tenant_id = $1
          AND action = 'identity_otp_consumed'
          AND resource_id = $2`,
      [T_US, otpId],
    );
    expect(us.rows[0]!.count).toBe('0');
  });

  it('§3b US ctx findLatestActiveOtp on Ghana phone returns null (RLS)', async () => {
    const { accountId, phone } = await seedGhanaAccount();
    const otpId = asOtpId(ulid());
    await withTenantContext(T_GH, () =>
      otpService.issueOtp(
        GH_CTX,
        { actorId: 'op_gh_otp_3b' },
        { otp_id: otpId, account_id: accountId, phone_e164: phone, purpose: 'login' },
        getTestClient(),
      ),
    );

    const found = await withTenantContext(T_US, () =>
      otpRepo.findLatestActiveOtp(T_US, phone, 'login', getTestClient()),
    );
    expect(found).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// §4 — auth-device-service cross-tenant attempts
// ---------------------------------------------------------------------------

describe('identity cross-tenant isolation §4 auth-device-service', () => {
  it('§4a US ctx cannot revoke a Ghana device (returns null + no spurious audit)', async () => {
    const { accountId } = await seedGhanaAccount();
    const deviceId = asDeviceId(ulid());
    await withTenantContext(T_GH, () =>
      authDeviceService.registerDevice(
        GH_CTX,
        { actorId: 'op_gh_dev' },
        {
          device_id: deviceId,
          account_id: accountId,
          platform: 'ios',
          device_public_key: 'pubkey-test-gh',
        },
        getTestClient(),
      ),
    );

    const result = await withTenantContext(T_US, () =>
      authDeviceService.revokeDevice(
        US_CTX,
        { actorId: 'op_us_attacker' },
        deviceId,
        'patient_unregistered',
        getTestClient(),
      ),
    );
    expect(result).toBeNull();

    const us = await getTestClient().query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM audit_records
        WHERE tenant_id = $1
          AND action = 'identity_device_revoked'
          AND resource_id = $2`,
      [T_US, deviceId],
    );
    expect(us.rows[0]!.count).toBe('0');
  });

  it('§4b US ctx listActiveDevicesForAccount on Ghana account is empty (RLS)', async () => {
    const { accountId } = await seedGhanaAccount();
    const deviceId = asDeviceId(ulid());
    await withTenantContext(T_GH, () =>
      authDeviceService.registerDevice(
        GH_CTX,
        { actorId: 'op_gh_dev_4b' },
        {
          device_id: deviceId,
          account_id: accountId,
          platform: 'android',
          device_public_key: 'pubkey-test-gh-4b',
        },
        getTestClient(),
      ),
    );

    const fromUs = await withTenantContext(T_US, () =>
      deviceRepo.listActiveDevicesForAccount(T_US, accountId, getTestClient()),
    );
    expect(fromUs).toHaveLength(0);

    // Sanity: visible from Ghana
    const fromGh = await withTenantContext(T_GH, () =>
      deviceRepo.listActiveDevicesForAccount(T_GH, accountId, getTestClient()),
    );
    expect(fromGh.length).toBeGreaterThanOrEqual(1);
  });
});
