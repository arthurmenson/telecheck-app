/**
 * identity/audit.ts — module-specific audit envelope emitters.
 *
 * Wraps `lib/audit.ts emitAudit()` for Identity-slice lifecycle events:
 *   - account.created (registration)
 *   - account.activated (post-OTP-verify success)
 *   - session.issued / session.revoked
 *   - otp.issued / otp.consumed / otp.lockout_triggered
 *   - device.registered / device.revoked
 *
 * SPEC ISSUE — placeholder action IDs:
 *   AUDIT_EVENTS v5.2 does NOT enumerate canonical action IDs for
 *   Identity slice events. Identity Spec §9 (Audit) describes WHICH
 *   events must be audited but doesn't pin exact IDs. This module
 *   emits them through `identityAuditPlaceholder()` — a single
 *   sanctioned `as AuditAction` cast site (mirror of forms-intake's
 *   `formsAuditPlaceholder()` pattern).
 *
 *   When AUDIT_EVENTS v5.2 ratifies these IDs:
 *     1. Add the IDs to lib/audit.ts AuditAction
 *     2. Delete `identityAuditPlaceholder()` and the union here
 *     3. Replace each placeholder() call with the bare canonical ID
 *
 *   Inventory: `git grep "identityAuditPlaceholder("`.
 *
 * Spec references:
 *   - Identity & Authentication Spec v1.0 §9 (audit requirements:
 *     registration creates audit; login attempts audited; phone-number
 *     change creates audit; sensitive-action OTPs audited)
 *   - INVARIANTS I-003 (audit append-only; bare suppression forbidden)
 *   - I-027 (every audit record carries tenant_id)
 *   - AUDIT_EVENTS v5.2 (canonical envelope shape; action IDs not yet
 *     enumerated for identity events)
 */

import {
  type AuditAction,
  type AuditDbClient,
  type AuditEnvelope,
  type AuditEnvelopeInput,
  emitAudit,
} from '../../lib/audit.js';
import type { TenantId } from '../../lib/glossary.js';

import type { AccountId, DeviceId, OtpId, SessionId } from './internal/types.js';

// ---------------------------------------------------------------------------
// Placeholder action ID union (closed; expand only when adding new events
// to this module).
// ---------------------------------------------------------------------------

type IdentityAuditActionPlaceholder =
  | 'identity_account_created'
  | 'identity_account_activated'
  | 'identity_session_issued'
  | 'identity_session_revoked'
  | 'identity_otp_issued'
  | 'identity_otp_consumed'
  | 'identity_otp_lockout_triggered'
  | 'identity_device_registered'
  | 'identity_device_revoked'
  // Email + PIN auth path (migration 078; docs/SI-EMAIL-PIN-AUTH.md)
  | 'identity_email_passcode_issued'
  | 'identity_email_passcode_consumed'
  | 'identity_pin_set'
  | 'identity_pin_login_failed'
  | 'identity_pin_lockout_triggered';

/**
 * identityAuditPlaceholder — single sanctioned `as AuditAction` cast site.
 * Mirrors forms-intake/audit.ts formsAuditPlaceholder pattern.
 *
 * When AUDIT_EVENTS v5.2 ratifies the canonical Identity action IDs:
 *   1. Add the IDs to lib/audit.ts AuditAction
 *   2. Delete this function and the union above
 *   3. Replace every `identityAuditPlaceholder('<id>')` with the bare ID
 */
function identityAuditPlaceholder(id: IdentityAuditActionPlaceholder): AuditAction {
  return id as AuditAction;
}

// ---------------------------------------------------------------------------
// Common envelope builder
//
// Identity events are non-AI-actor (the patient or system performing the
// registration / authn flow); pass actor_type accordingly and set
// ai_workload_type / autonomy_level to null since none are I-012 action-class.
// ---------------------------------------------------------------------------

interface IdentityAuditCommon {
  tenant_id: TenantId;
  actor_type: 'patient' | 'system' | 'operator';
  actor_id: string;
  actor_tenant_id: string | null;
  /** Null for pre-account events (registration before account created). */
  target_patient_id: AccountId | string | null;
  country_of_care: string;
  resource_type: string;
  resource_id: string;
  detail: Record<string, unknown>;
}

function buildEnvelope(
  action: AuditAction,
  category: 'A' | 'B' | 'C',
  common: IdentityAuditCommon,
): AuditEnvelopeInput {
  return {
    timestamp: new Date().toISOString(),
    tenant_id: common.tenant_id,
    actor_type: common.actor_type,
    actor_id: common.actor_id,
    actor_tenant_id: common.actor_tenant_id,
    target_patient_id: common.target_patient_id,
    delegate_context: null,
    action,
    category,
    audit_sensitivity_level: 'standard',
    resource_type: common.resource_type,
    resource_id: common.resource_id,
    detail: common.detail,
    engine_versions: null,
    ai_workload_type: null,
    autonomy_level: null,
    agent_id: null,
    agent_version: null,
    tool_call_id: null,
    memory_read_set_id: null,
    memory_write_set_id: null,
    supervising_policy_id: null,
    knowledge_source_versions: null,
    signals: null,
    override: null,
    linked_events: [],
    compliance_flags: [],
    country_of_care: common.country_of_care,
    break_glass: null,
  };
}

// ---------------------------------------------------------------------------
// Account lifecycle emitters
// ---------------------------------------------------------------------------

/**
 * Emit `identity_account_created` — account row inserted at registration.
 * Category C (operational). target_patient_id = the new account_id since
 * the account-id-as-patient-id mapping holds at v1.0 (Account = Patient
 * per CDM §3.2 — separate Patient entity is deferred per Identity Spec
 * §1.X). actor_type='system' for now since the platform is creating the
 * row on the patient's behalf during the OTP-mediated registration flow.
 */
export async function emitAccountCreatedAudit(
  args: {
    tenantId: TenantId;
    accountId: AccountId;
    actorId: string;
    countryOfCare: string;
    // Nullable since migration 078 (email-only accounts have no phone).
    phoneE164: string | null; // recorded in detail for audit trail; PHI but not at high_pii level
    accountType: 'patient' | 'delegate' | 'clinician' | 'tenant_admin' | 'platform_admin';
  },
  tx: AuditDbClient,
): Promise<AuditEnvelope> {
  return emitAudit(
    buildEnvelope(identityAuditPlaceholder('identity_account_created'), 'C', {
      tenant_id: args.tenantId,
      actor_type: 'system',
      actor_id: args.actorId,
      actor_tenant_id: args.tenantId,
      target_patient_id: args.accountId,
      country_of_care: args.countryOfCare,
      resource_type: 'account',
      resource_id: args.accountId,
      detail: {
        phone_e164: args.phoneE164,
        account_type: args.accountType,
      },
    }),
    tx,
  );
}

/**
 * Emit `identity_account_activated` — account flipped from
 * pending_verification → active after successful OTP verify at end of
 * registration flow. Category C (operational).
 */
export async function emitAccountActivatedAudit(
  args: {
    tenantId: TenantId;
    accountId: AccountId;
    actorId: string;
    countryOfCare: string;
  },
  tx: AuditDbClient,
): Promise<AuditEnvelope> {
  return emitAudit(
    buildEnvelope(identityAuditPlaceholder('identity_account_activated'), 'C', {
      tenant_id: args.tenantId,
      actor_type: 'system',
      actor_id: args.actorId,
      actor_tenant_id: args.tenantId,
      target_patient_id: args.accountId,
      country_of_care: args.countryOfCare,
      resource_type: 'account',
      resource_id: args.accountId,
      detail: {},
    }),
    tx,
  );
}

// ---------------------------------------------------------------------------
// Session lifecycle emitters
// ---------------------------------------------------------------------------

export async function emitSessionIssuedAudit(
  args: {
    tenantId: TenantId;
    accountId: AccountId;
    sessionId: SessionId;
    actorId: string;
    countryOfCare: string;
    deviceId: DeviceId | null;
    ipAddress: string | null;
  },
  tx: AuditDbClient,
): Promise<AuditEnvelope> {
  return emitAudit(
    buildEnvelope(identityAuditPlaceholder('identity_session_issued'), 'C', {
      tenant_id: args.tenantId,
      actor_type: 'system',
      actor_id: args.actorId,
      actor_tenant_id: args.tenantId,
      target_patient_id: args.accountId,
      country_of_care: args.countryOfCare,
      resource_type: 'session',
      resource_id: args.sessionId,
      detail: {
        device_id: args.deviceId,
        ip_address: args.ipAddress,
      },
    }),
    tx,
  );
}

export async function emitSessionRevokedAudit(
  args: {
    tenantId: TenantId;
    accountId: AccountId;
    sessionId: SessionId;
    actorId: string;
    countryOfCare: string;
    reason: string;
  },
  tx: AuditDbClient,
): Promise<AuditEnvelope> {
  return emitAudit(
    buildEnvelope(identityAuditPlaceholder('identity_session_revoked'), 'C', {
      tenant_id: args.tenantId,
      actor_type: 'system',
      actor_id: args.actorId,
      actor_tenant_id: args.tenantId,
      target_patient_id: args.accountId,
      country_of_care: args.countryOfCare,
      resource_type: 'session',
      resource_id: args.sessionId,
      detail: {
        revoked_reason: args.reason,
      },
    }),
    tx,
  );
}

// ---------------------------------------------------------------------------
// OTP lifecycle emitters
// ---------------------------------------------------------------------------

export async function emitOtpIssuedAudit(
  args: {
    tenantId: TenantId;
    otpId: OtpId;
    accountId: AccountId | null; // null on registration (pre-account)
    actorId: string;
    countryOfCare: string;
    purpose: string;
    phoneE164: string;
  },
  tx: AuditDbClient,
): Promise<AuditEnvelope> {
  return emitAudit(
    buildEnvelope(identityAuditPlaceholder('identity_otp_issued'), 'C', {
      tenant_id: args.tenantId,
      actor_type: 'system',
      actor_id: args.actorId,
      actor_tenant_id: args.tenantId,
      target_patient_id: args.accountId,
      country_of_care: args.countryOfCare,
      resource_type: 'otp_challenge',
      resource_id: args.otpId,
      detail: {
        purpose: args.purpose,
        phone_e164: args.phoneE164,
      },
    }),
    tx,
  );
}

export async function emitOtpConsumedAudit(
  args: {
    tenantId: TenantId;
    otpId: OtpId;
    accountId: AccountId | null;
    actorId: string;
    countryOfCare: string;
    purpose: string;
  },
  tx: AuditDbClient,
): Promise<AuditEnvelope> {
  return emitAudit(
    buildEnvelope(identityAuditPlaceholder('identity_otp_consumed'), 'C', {
      tenant_id: args.tenantId,
      actor_type: 'system',
      actor_id: args.actorId,
      actor_tenant_id: args.tenantId,
      target_patient_id: args.accountId,
      country_of_care: args.countryOfCare,
      resource_type: 'otp_challenge',
      resource_id: args.otpId,
      detail: {
        purpose: args.purpose,
      },
    }),
    tx,
  );
}

export async function emitOtpLockoutTriggeredAudit(
  args: {
    tenantId: TenantId;
    otpId: OtpId;
    accountId: AccountId | null;
    actorId: string;
    countryOfCare: string;
    purpose: string;
    phoneE164: string;
  },
  tx: AuditDbClient,
): Promise<AuditEnvelope> {
  return emitAudit(
    buildEnvelope(identityAuditPlaceholder('identity_otp_lockout_triggered'), 'C', {
      tenant_id: args.tenantId,
      actor_type: 'system',
      actor_id: args.actorId,
      actor_tenant_id: args.tenantId,
      target_patient_id: args.accountId,
      country_of_care: args.countryOfCare,
      resource_type: 'otp_challenge',
      resource_id: args.otpId,
      detail: {
        purpose: args.purpose,
        phone_e164: args.phoneE164,
      },
    }),
    tx,
  );
}

// ---------------------------------------------------------------------------
// Device lifecycle emitters
// ---------------------------------------------------------------------------

export async function emitDeviceRegisteredAudit(
  args: {
    tenantId: TenantId;
    accountId: AccountId;
    deviceId: DeviceId;
    actorId: string;
    countryOfCare: string;
    platform: string;
  },
  tx: AuditDbClient,
): Promise<AuditEnvelope> {
  return emitAudit(
    buildEnvelope(identityAuditPlaceholder('identity_device_registered'), 'C', {
      tenant_id: args.tenantId,
      actor_type: 'system',
      actor_id: args.actorId,
      actor_tenant_id: args.tenantId,
      target_patient_id: args.accountId,
      country_of_care: args.countryOfCare,
      resource_type: 'auth_device',
      resource_id: args.deviceId,
      detail: {
        platform: args.platform,
      },
    }),
    tx,
  );
}

export async function emitDeviceRevokedAudit(
  args: {
    tenantId: TenantId;
    accountId: AccountId;
    deviceId: DeviceId;
    actorId: string;
    countryOfCare: string;
    reason: string;
  },
  tx: AuditDbClient,
): Promise<AuditEnvelope> {
  return emitAudit(
    buildEnvelope(identityAuditPlaceholder('identity_device_revoked'), 'C', {
      tenant_id: args.tenantId,
      actor_type: 'system',
      actor_id: args.actorId,
      actor_tenant_id: args.tenantId,
      target_patient_id: args.accountId,
      country_of_care: args.countryOfCare,
      resource_type: 'auth_device',
      resource_id: args.deviceId,
      detail: {
        revoked_reason: args.reason,
      },
    }),
    tx,
  );
}

// ---------------------------------------------------------------------------
// Email + PIN auth path (migration 078; docs/SI-EMAIL-PIN-AUTH.md)
// ---------------------------------------------------------------------------

export async function emitEmailPasscodeIssuedAudit(
  args: {
    tenantId: TenantId;
    passcodeId: string;
    accountId: AccountId | null;
    actorId: string;
    countryOfCare: string;
    purpose: string;
    email: string;
  },
  tx: AuditDbClient,
): Promise<AuditEnvelope> {
  return emitAudit(
    buildEnvelope(identityAuditPlaceholder('identity_email_passcode_issued'), 'C', {
      tenant_id: args.tenantId,
      actor_type: 'system',
      actor_id: args.actorId,
      actor_tenant_id: args.tenantId,
      target_patient_id: args.accountId,
      country_of_care: args.countryOfCare,
      resource_type: 'email_passcode',
      resource_id: args.passcodeId,
      detail: { purpose: args.purpose, email: args.email },
    }),
    tx,
  );
}

export async function emitEmailPasscodeConsumedAudit(
  args: {
    tenantId: TenantId;
    passcodeId: string;
    accountId: AccountId | null;
    actorId: string;
    countryOfCare: string;
    purpose: string;
  },
  tx: AuditDbClient,
): Promise<AuditEnvelope> {
  return emitAudit(
    buildEnvelope(identityAuditPlaceholder('identity_email_passcode_consumed'), 'C', {
      tenant_id: args.tenantId,
      actor_type: 'system',
      actor_id: args.actorId,
      actor_tenant_id: args.tenantId,
      target_patient_id: args.accountId,
      country_of_care: args.countryOfCare,
      resource_type: 'email_passcode',
      resource_id: args.passcodeId,
      detail: { purpose: args.purpose },
    }),
    tx,
  );
}

export async function emitPinSetAudit(
  args: {
    tenantId: TenantId;
    accountId: AccountId;
    actorId: string;
    countryOfCare: string;
    context: 'registration' | 'recovery';
  },
  tx: AuditDbClient,
): Promise<AuditEnvelope> {
  return emitAudit(
    buildEnvelope(identityAuditPlaceholder('identity_pin_set'), 'C', {
      tenant_id: args.tenantId,
      actor_type: 'system',
      actor_id: args.actorId,
      actor_tenant_id: args.tenantId,
      target_patient_id: args.accountId,
      country_of_care: args.countryOfCare,
      resource_type: 'account_pin_credential',
      resource_id: args.accountId,
      detail: { context: args.context },
    }),
    tx,
  );
}

export async function emitPinLoginFailedAudit(
  args: {
    tenantId: TenantId;
    accountId: AccountId;
    actorId: string;
    countryOfCare: string;
    lockedOut: boolean;
  },
  tx: AuditDbClient,
): Promise<AuditEnvelope> {
  const action = args.lockedOut ? 'identity_pin_lockout_triggered' : 'identity_pin_login_failed';
  return emitAudit(
    buildEnvelope(identityAuditPlaceholder(action), 'C', {
      tenant_id: args.tenantId,
      actor_type: 'system',
      actor_id: args.actorId,
      actor_tenant_id: args.tenantId,
      target_patient_id: args.accountId,
      country_of_care: args.countryOfCare,
      resource_type: 'account_pin_credential',
      resource_id: args.accountId,
      detail: { locked_out: args.lockedOut },
    }),
    tx,
  );
}
