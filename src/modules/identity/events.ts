/**
 * identity/events.ts — module-specific domain event emitters.
 *
 * Wraps `lib/domain-events.ts emitDomainEvent()` for the Identity & Auth
 * slice lifecycle events per Identity Spec §3 + Contracts Pack v5.2
 * DOMAIN_EVENTS:
 *   - identity.account.created, identity.account.activated
 *   - identity.session.issued, identity.session.revoked
 *   - identity.otp.issued, identity.otp.consumed,
 *     identity.otp.lockout_triggered
 *   - identity.device.registered, identity.device.revoked
 *
 * Events are emitted INSIDE the same transaction as the audit emission
 * + the aggregate state change. Rollback discards all together.
 *
 * SPEC ISSUE: DOMAIN_EVENTS v5.2 doesn't yet enumerate the canonical
 * `identity.*` event-type strings — same gap as the audit-side SI-002
 * placeholder pattern. A parallel SI for DOMAIN_EVENTS will be raised
 * when a consumer needs the precise contract.
 *
 * Spec references:
 *   - DOMAIN_EVENTS v5.2 (envelope shape; tenant-scoped partition keys)
 *   - Identity Spec §3 (lifecycle audit emission requirements)
 *   - I-016 (immutable; INSERT failure aborts the tx)
 *   - I-023 (every event carries tenant_id)
 */

import { emitDomainEvent, type DbTransaction } from '../../lib/domain-events.js';
import type { TenantId } from '../../lib/glossary.js';

import type { AccountId, DeviceId, OtpId, SessionId } from './internal/types.js';

// ---------------------------------------------------------------------------
// Aggregate constants
// ---------------------------------------------------------------------------

const ACCOUNT_AGGREGATE = 'account';
const SESSION_AGGREGATE = 'session';
const OTP_AGGREGATE = 'otp';
const DEVICE_AGGREGATE = 'device';

// ---------------------------------------------------------------------------
// Account lifecycle events
// ---------------------------------------------------------------------------

export async function emitAccountCreatedDomainEvent(
  tx: DbTransaction,
  args: {
    tenantId: TenantId;
    accountId: AccountId;
    countryOfCare: string;
    occurredAt: string;
  },
): Promise<void> {
  await emitDomainEvent(tx, {
    tenant_id: args.tenantId,
    aggregate_type: ACCOUNT_AGGREGATE,
    aggregate_id: args.accountId,
    event_type: 'identity.account.created',
    payload: {
      account_id: args.accountId,
      country_of_care: args.countryOfCare,
    },
    occurred_at: args.occurredAt,
  });
}

export async function emitAccountActivatedDomainEvent(
  tx: DbTransaction,
  args: {
    tenantId: TenantId;
    accountId: AccountId;
    occurredAt: string;
  },
): Promise<void> {
  await emitDomainEvent(tx, {
    tenant_id: args.tenantId,
    aggregate_type: ACCOUNT_AGGREGATE,
    aggregate_id: args.accountId,
    event_type: 'identity.account.activated',
    payload: {
      account_id: args.accountId,
    },
    occurred_at: args.occurredAt,
  });
}

// ---------------------------------------------------------------------------
// Session lifecycle events
// ---------------------------------------------------------------------------

export async function emitSessionIssuedDomainEvent(
  tx: DbTransaction,
  args: {
    tenantId: TenantId;
    accountId: AccountId;
    sessionId: SessionId;
    occurredAt: string;
  },
): Promise<void> {
  await emitDomainEvent(tx, {
    tenant_id: args.tenantId,
    aggregate_type: SESSION_AGGREGATE,
    aggregate_id: args.sessionId,
    event_type: 'identity.session.issued',
    payload: {
      account_id: args.accountId,
      session_id: args.sessionId,
    },
    occurred_at: args.occurredAt,
  });
}

export async function emitSessionRevokedDomainEvent(
  tx: DbTransaction,
  args: {
    tenantId: TenantId;
    accountId: AccountId;
    sessionId: SessionId;
    revokedReason: string;
    occurredAt: string;
  },
): Promise<void> {
  await emitDomainEvent(tx, {
    tenant_id: args.tenantId,
    aggregate_type: SESSION_AGGREGATE,
    aggregate_id: args.sessionId,
    event_type: 'identity.session.revoked',
    payload: {
      account_id: args.accountId,
      session_id: args.sessionId,
      revoked_reason: args.revokedReason,
    },
    occurred_at: args.occurredAt,
  });
}

// ---------------------------------------------------------------------------
// OTP lifecycle events
// ---------------------------------------------------------------------------

export async function emitOtpIssuedDomainEvent(
  tx: DbTransaction,
  args: {
    tenantId: TenantId;
    accountId: AccountId;
    otpId: OtpId;
    purpose: string;
    occurredAt: string;
  },
): Promise<void> {
  await emitDomainEvent(tx, {
    tenant_id: args.tenantId,
    aggregate_type: OTP_AGGREGATE,
    aggregate_id: args.otpId,
    event_type: 'identity.otp.issued',
    payload: {
      account_id: args.accountId,
      otp_id: args.otpId,
      purpose: args.purpose,
    },
    occurred_at: args.occurredAt,
  });
}

export async function emitOtpConsumedDomainEvent(
  tx: DbTransaction,
  args: {
    tenantId: TenantId;
    accountId: AccountId;
    otpId: OtpId;
    occurredAt: string;
  },
): Promise<void> {
  await emitDomainEvent(tx, {
    tenant_id: args.tenantId,
    aggregate_type: OTP_AGGREGATE,
    aggregate_id: args.otpId,
    event_type: 'identity.otp.consumed',
    payload: {
      account_id: args.accountId,
      otp_id: args.otpId,
    },
    occurred_at: args.occurredAt,
  });
}

export async function emitOtpLockoutTriggeredDomainEvent(
  tx: DbTransaction,
  args: {
    tenantId: TenantId;
    accountId: AccountId;
    otpId: OtpId;
    occurredAt: string;
  },
): Promise<void> {
  await emitDomainEvent(tx, {
    tenant_id: args.tenantId,
    aggregate_type: OTP_AGGREGATE,
    aggregate_id: args.otpId,
    event_type: 'identity.otp.lockout_triggered',
    payload: {
      account_id: args.accountId,
      otp_id: args.otpId,
    },
    occurred_at: args.occurredAt,
  });
}

// ---------------------------------------------------------------------------
// Device lifecycle events
// ---------------------------------------------------------------------------

export async function emitDeviceRegisteredDomainEvent(
  tx: DbTransaction,
  args: {
    tenantId: TenantId;
    accountId: AccountId;
    deviceId: DeviceId;
    platform: string;
    occurredAt: string;
  },
): Promise<void> {
  await emitDomainEvent(tx, {
    tenant_id: args.tenantId,
    aggregate_type: DEVICE_AGGREGATE,
    aggregate_id: args.deviceId,
    event_type: 'identity.device.registered',
    payload: {
      account_id: args.accountId,
      device_id: args.deviceId,
      platform: args.platform,
    },
    occurred_at: args.occurredAt,
  });
}

export async function emitDeviceRevokedDomainEvent(
  tx: DbTransaction,
  args: {
    tenantId: TenantId;
    accountId: AccountId;
    deviceId: DeviceId;
    revokedReason: string;
    occurredAt: string;
  },
): Promise<void> {
  await emitDomainEvent(tx, {
    tenant_id: args.tenantId,
    aggregate_type: DEVICE_AGGREGATE,
    aggregate_id: args.deviceId,
    event_type: 'identity.device.revoked',
    payload: {
      account_id: args.accountId,
      device_id: args.deviceId,
      revoked_reason: args.revokedReason,
    },
    occurred_at: args.occurredAt,
  });
}
