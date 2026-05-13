/**
 * Identity & Auth — internal type definitions.
 *
 * Mirrors the four CDM v1.2 §3.2 entities scaffolded in migrations
 * 012–015 (accounts, sessions, otp_challenges, auth_devices) at the
 * TypeScript layer. These types are MODULE-PRIVATE — only the
 * `src/modules/identity/index.ts` public-interface re-exports cross
 * the module boundary.
 *
 * Spec references:
 *   - CDM v1.2 §3.2 (Identity & Account: 4 entities)
 *   - Identity & Authentication Spec v1.0 (registration / authn flows)
 *   - migrations/012_accounts.sql + 013_sessions.sql +
 *     014_otp.sql + 015_auth_devices.sql
 */

import type { TenantId } from '../../../lib/glossary.js';

// ---------------------------------------------------------------------------
// Branded ID types (mirror of the forms-intake module's ID branding pattern)
// ---------------------------------------------------------------------------

declare const __brand: unique symbol;
type Brand<T, B> = T & { readonly [__brand]: B };

/** ULID for an account row (PK on accounts.account_id). */
export type AccountId = Brand<string, 'AccountId'>;

/** ULID for a session row (PK on sessions.session_id). */
export type SessionId = Brand<string, 'SessionId'>;

/** ULID for an OTP challenge row (PK on otp_challenges.otp_id). */
export type OtpId = Brand<string, 'OtpId'>;

/** ULID for an auth-device row (PK on auth_devices.device_id). */
export type DeviceId = Brand<string, 'DeviceId'>;

/** Construct an AccountId from a raw ULID string. No validation at v0. */
export function asAccountId(raw: string): AccountId {
  return raw as AccountId;
}
export function asSessionId(raw: string): SessionId {
  return raw as SessionId;
}
export function asOtpId(raw: string): OtpId {
  return raw as OtpId;
}
export function asDeviceId(raw: string): DeviceId {
  return raw as DeviceId;
}

// ---------------------------------------------------------------------------
// Account entity
// ---------------------------------------------------------------------------

export type AccountStatus = 'pending_verification' | 'active' | 'suspended' | 'archived';
export type AccountType = 'patient' | 'delegate' | 'clinician';
export type AccountGender = 'female' | 'male' | 'non_binary' | 'prefer_not_to_say';

export interface Account {
  account_id: AccountId;
  tenant_id: TenantId;
  phone_e164: string;
  email: string | null;
  first_name: string;
  last_name: string;
  date_of_birth: string; // ISO date YYYY-MM-DD (Postgres DATE)
  gender: AccountGender;
  national_id: string | null;
  country_of_residence: string; // ISO 3166-1 alpha-2
  country_of_care: 'US' | 'GH';
  locale: string; // BCP 47 (e.g., 'en-US')
  account_type: AccountType;
  status: AccountStatus;
  created_at: string;
  updated_at: string;
  activated_at: string | null;
  suspended_at: string | null;
  archived_at: string | null;
  deleted_at: string | null;
}

// ---------------------------------------------------------------------------
// Session entity
// ---------------------------------------------------------------------------

export type SessionRevocationReason =
  | 'patient_logout'
  | 'max_devices_exceeded'
  | 'security_hold'
  | 'password_changed'
  | 'phone_number_changed'
  | 'admin_revoked'
  | 'expired'
  | 'compromise_detected';

export interface Session {
  session_id: SessionId;
  tenant_id: TenantId;
  account_id: AccountId;
  refresh_token_hash: string; // SHA-256 hex (64 chars)
  device_id: DeviceId | null;
  ip_address: string | null;
  user_agent: string | null;
  created_at: string;
  last_active_at: string;
  expires_at: string;
  revoked_at: string | null;
  revoked_reason: SessionRevocationReason | null;
}

// ---------------------------------------------------------------------------
// OTP entity
// ---------------------------------------------------------------------------

export type OtpPurpose = 'registration' | 'login' | 'phone_number_change' | 'sensitive_action';

export interface OtpChallenge {
  otp_id: OtpId;
  tenant_id: TenantId;
  account_id: AccountId | null;
  phone_e164: string;
  purpose: OtpPurpose;
  code_hash: string; // SHA-256 hex of the 6-digit code
  attempts_remaining: number; // 0..3
  created_at: string;
  expires_at: string;
  consumed_at: string | null;
  locked_until: string | null;
}

// ---------------------------------------------------------------------------
// AuthDevice entity
// ---------------------------------------------------------------------------

export type DevicePlatform = 'ios' | 'android' | 'web';
export type AttestationFormat =
  | 'none'
  | 'placeholder'
  | 'apple_app_attest'
  | 'android_play_integrity';
export type DeviceRevocationReason =
  | 'patient_unregistered'
  | 'max_devices_evicted'
  | 'security_hold'
  | 'phone_number_changed'
  | 'admin_revoked'
  | 'compromise_detected';

export interface AuthDevice {
  device_id: DeviceId;
  tenant_id: TenantId;
  account_id: AccountId;
  platform: DevicePlatform;
  device_label: string | null;
  device_public_key: string; // base64
  attestation_format: AttestationFormat;
  created_at: string;
  last_seen_at: string;
  revoked_at: string | null;
  revoked_reason: DeviceRevocationReason | null;
}
