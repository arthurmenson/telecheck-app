/**
 * identity slice — domain-event emission integration test.
 *
 * Verifies that the 9 lifecycle events the identity services emit (wired
 * at aec04ce + 663c8fb) actually land in domain_events_outbox alongside
 * the audit chain. Mirror of consent-domain-events.test.ts pattern.
 *
 * Coverage in this file (1 section, 5 cases):
 *   §1a createAccount emits identity.account.created
 *   §1b activateAccount emits identity.account.activated
 *   §1c issueSession emits identity.session.issued
 *   §1d issueOtp emits identity.otp.issued
 *   §1e registerDevice emits identity.device.registered
 *
 * Spec references:
 *   - DOMAIN_EVENTS v5.2 envelope shape
 *   - Identity Spec §3 lifecycle audit emission requirements
 *   - I-016 (events immutable; INSERT failure aborts the tx)
 *   - I-023 (every event carries tenant_id)
 */

import { describe, expect, it } from 'vitest';

import { asTenantId } from '../../src/lib/glossary.ts';
import type { TenantContext } from '../../src/lib/tenant-context.ts';
import { ulid } from '../../src/lib/ulid.ts';
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
import { TENANT_US, withTenantContext } from '../helpers/tenant-fixtures.ts';
import { uniquePhone } from '../helpers/unique-phone.ts';
import { getTestClient } from '../setup.ts';

const T_US = asTenantId(TENANT_US);
const US_CTX: TenantContext = {
  tenantId: T_US,
  displayName: 'Telecheck-US',
  countryOfCare: 'US',
  kmsKeyAlias: 'alias/telecheck-us-data-key',
  consumerDba: 'Heros Health',
  legalEntity: 'Telecheck Health LLC',
  consumerSubdomain: 'heroshealth.com',
};

interface OutboxRow {
  event_type: string;
  aggregate_type: string;
  aggregate_id: string;
  tenant_id: string;
  payload: Record<string, unknown>;
  partition_key: string;
}

async function findOutboxEvent(
  tenantId: string,
  eventType: string,
  aggregateId: string,
): Promise<OutboxRow | null> {
  const r = await getTestClient().query<OutboxRow>(
    `SELECT event_type, aggregate_type, aggregate_id, tenant_id, payload, partition_key
       FROM domain_events_outbox
      WHERE tenant_id = $1 AND event_type = $2 AND aggregate_id = $3
      ORDER BY created_at DESC LIMIT 1`,
    [tenantId, eventType, aggregateId],
  );
  return r.rows[0] ?? null;
}

async function seedAccount(): Promise<{ accountId: AccountId; phone: string }> {
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
  return { accountId, phone };
}

describe('identity slice — §1 domain-event emission', () => {
  it('§1a createAccount emits identity.account.created in outbox', async () => {
    const { accountId } = await seedAccount();

    const event = await findOutboxEvent(T_US, 'identity.account.created', accountId);
    expect(event).not.toBeNull();
    expect(event!.aggregate_type).toBe('account');
    expect(event!.partition_key).toBe(`${T_US}:${accountId}`);
    expect(event!.payload['account_id']).toBe(accountId);
    expect(event!.payload['country_of_care']).toBe('US');
  });

  it('§1b activateAccount emits identity.account.activated in outbox', async () => {
    const { accountId } = await seedAccount();
    await withTenantContext(T_US, () =>
      accountService.activateAccount(US_CTX, { actorId: 'op_act' }, accountId, getTestClient()),
    );

    const event = await findOutboxEvent(T_US, 'identity.account.activated', accountId);
    expect(event).not.toBeNull();
    expect(event!.payload['account_id']).toBe(accountId);
  });

  it('§1c issueSession emits identity.session.issued in outbox', async () => {
    const { accountId } = await seedAccount();
    const sessionId = asSessionId(ulid());
    await withTenantContext(T_US, () =>
      sessionService.issueSession(
        US_CTX,
        { actorId: 'op_session' },
        { session_id: sessionId, account_id: accountId },
        getTestClient(),
      ),
    );

    const event = await findOutboxEvent(T_US, 'identity.session.issued', sessionId);
    expect(event).not.toBeNull();
    expect(event!.aggregate_type).toBe('session');
    expect(event!.payload['account_id']).toBe(accountId);
    expect(event!.payload['session_id']).toBe(sessionId);
  });

  it('§1d issueOtp emits identity.otp.issued in outbox', async () => {
    const { accountId, phone } = await seedAccount();
    const otpId = asOtpId(ulid());
    await withTenantContext(T_US, () =>
      otpService.issueOtp(
        US_CTX,
        { actorId: 'op_otp' },
        { otp_id: otpId, account_id: accountId, phone_e164: phone, purpose: 'login' },
        getTestClient(),
      ),
    );

    const event = await findOutboxEvent(T_US, 'identity.otp.issued', otpId);
    expect(event).not.toBeNull();
    expect(event!.aggregate_type).toBe('otp');
    expect(event!.payload['account_id']).toBe(accountId);
    expect(event!.payload['purpose']).toBe('login');
  });

  it('§1e registerDevice emits identity.device.registered in outbox', async () => {
    const { accountId } = await seedAccount();
    const deviceId = asDeviceId(ulid());
    await withTenantContext(T_US, () =>
      authDeviceService.registerDevice(
        US_CTX,
        { actorId: 'op_dev' },
        {
          device_id: deviceId,
          account_id: accountId,
          platform: 'ios',
          device_public_key: 'pubkey-test',
        },
        getTestClient(),
      ),
    );

    const event = await findOutboxEvent(T_US, 'identity.device.registered', deviceId);
    expect(event).not.toBeNull();
    expect(event!.aggregate_type).toBe('device');
    expect(event!.payload['account_id']).toBe(accountId);
    expect(event!.payload['platform']).toBe('ios');
  });

  it('§1f revokeSession emits identity.session.revoked in outbox', async () => {
    const { accountId } = await seedAccount();
    const sessionId = asSessionId(ulid());
    await withTenantContext(T_US, () =>
      sessionService.issueSession(
        US_CTX,
        { actorId: 'op_session_rev' },
        { session_id: sessionId, account_id: accountId },
        getTestClient(),
      ),
    );
    await withTenantContext(T_US, () =>
      sessionService.revokeSession(
        US_CTX,
        { actorId: 'op_session_rev' },
        sessionId,
        'patient_logout',
        getTestClient(),
      ),
    );

    const event = await findOutboxEvent(T_US, 'identity.session.revoked', sessionId);
    expect(event).not.toBeNull();
    expect(event!.payload['revoked_reason']).toBe('patient_logout');
    expect(event!.payload['session_id']).toBe(sessionId);
  });

  it('§1g verifyOtp success emits identity.otp.consumed in outbox', async () => {
    const { accountId, phone } = await seedAccount();
    const otpId = asOtpId(ulid());
    const { codePlaintext } = await withTenantContext(T_US, () =>
      otpService.issueOtp(
        US_CTX,
        { actorId: 'op_otp_consume' },
        { otp_id: otpId, account_id: accountId, phone_e164: phone, purpose: 'login' },
        getTestClient(),
      ),
    );
    const result = await withTenantContext(T_US, () =>
      otpService.verifyOtp(
        US_CTX,
        { actorId: 'op_otp_consume' },
        { phone_e164: phone, purpose: 'login', code: codePlaintext },
        getTestClient(),
      ),
    );
    expect(result.ok).toBe(true);

    const event = await findOutboxEvent(T_US, 'identity.otp.consumed', otpId);
    expect(event).not.toBeNull();
    expect(event!.payload['account_id']).toBe(accountId);
  });

  it('§1h verifyOtp lockout emits identity.otp.lockout_triggered in outbox', async () => {
    const { accountId, phone } = await seedAccount();
    const otpId = asOtpId(ulid());
    await withTenantContext(T_US, () =>
      otpService.issueOtp(
        US_CTX,
        { actorId: 'op_otp_lock' },
        { otp_id: otpId, account_id: accountId, phone_e164: phone, purpose: 'login' },
        getTestClient(),
      ),
    );
    // 3 wrong attempts triggers lockout
    for (let i = 0; i < 3; i++) {
      await withTenantContext(T_US, () =>
        otpService.verifyOtp(
          US_CTX,
          { actorId: 'op_otp_lock' },
          { phone_e164: phone, purpose: 'login', code: '000000' },
          getTestClient(),
        ),
      );
    }

    const event = await findOutboxEvent(T_US, 'identity.otp.lockout_triggered', otpId);
    expect(event).not.toBeNull();
    expect(event!.payload['account_id']).toBe(accountId);
  });

  it('§1i revokeDevice emits identity.device.revoked in outbox', async () => {
    const { accountId } = await seedAccount();
    const deviceId = asDeviceId(ulid());
    await withTenantContext(T_US, () =>
      authDeviceService.registerDevice(
        US_CTX,
        { actorId: 'op_dev_rev' },
        {
          device_id: deviceId,
          account_id: accountId,
          platform: 'ios',
          device_public_key: 'pubkey-test',
        },
        getTestClient(),
      ),
    );
    await withTenantContext(T_US, () =>
      authDeviceService.revokeDevice(
        US_CTX,
        { actorId: 'op_dev_rev' },
        deviceId,
        'patient_unregistered',
        getTestClient(),
      ),
    );

    const event = await findOutboxEvent(T_US, 'identity.device.revoked', deviceId);
    expect(event).not.toBeNull();
    expect(event!.payload['revoked_reason']).toBe('patient_unregistered');
    expect(event!.payload['device_id']).toBe(deviceId);
  });
});
