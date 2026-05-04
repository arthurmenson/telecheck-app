/**
 * otp-repo.ts — DB access for the `otp_challenges` table (migration 014).
 *
 * Repository pattern (mirror of account-repo.ts / session-repo.ts):
 *   - Pure DB access; no domain logic
 *   - Returns null on tenant-blind miss
 *   - All SELECTs filter by tenant_id explicitly (defense in depth)
 *   - Service-layer code owns rate-limit decisions; this module exposes
 *     the primitives for them
 *
 * Spec references:
 *   - migrations/014_otp.sql
 *   - CDM v1.2 §3.2 entity 9 "OTP"
 *   - Identity & Authentication Spec v1.0 §2.1 / §3.1 (OTP semantics)
 *   - I-023 / I-025
 */

import type { DbClient, DbTransaction } from '../../../../lib/db.js';
import { withTenantBoundConnection } from '../../../../lib/db.js';
import type { TenantId } from '../../../../lib/glossary.js';
import type { AccountId, OtpChallenge, OtpId, OtpPurpose } from '../types.js';

// ---------------------------------------------------------------------------
// Row mapping
// ---------------------------------------------------------------------------

interface OtpRow {
  otp_id: string;
  tenant_id: string;
  account_id: string | null;
  phone_e164: string;
  purpose: string;
  code_hash: string;
  attempts_remaining: number;
  created_at: Date | string;
  expires_at: Date | string;
  consumed_at: Date | string | null;
  locked_until: Date | string | null;
}

function tsToIso(v: Date | string): string {
  return typeof v === 'string' ? v : v.toISOString();
}
function tsToIsoNullable(v: Date | string | null): string | null {
  if (v === null) return null;
  return tsToIso(v);
}

function rowToOtp(row: OtpRow): OtpChallenge {
  return {
    otp_id: row.otp_id as OtpId,
    tenant_id: row.tenant_id as TenantId,
    account_id: row.account_id === null ? null : (row.account_id as AccountId),
    phone_e164: row.phone_e164,
    purpose: row.purpose as OtpPurpose,
    code_hash: row.code_hash,
    attempts_remaining: row.attempts_remaining,
    created_at: tsToIso(row.created_at),
    expires_at: tsToIso(row.expires_at),
    consumed_at: tsToIsoNullable(row.consumed_at),
    locked_until: tsToIsoNullable(row.locked_until),
  };
}

const OTP_COLUMNS = `
  otp_id, tenant_id, account_id, phone_e164,
  purpose, code_hash, attempts_remaining,
  created_at, expires_at, consumed_at, locked_until
`;

// ---------------------------------------------------------------------------
// CreateOtpInput
// ---------------------------------------------------------------------------

export interface CreateOtpInput {
  otp_id: OtpId;
  tenant_id: TenantId;
  account_id?: AccountId | null; // null for registration (no account yet)
  phone_e164: string;
  purpose: OtpPurpose;
  code_hash: string; // SHA-256 hex of the 6-digit code
  expires_at: string; // ISO 8601; service layer computes created_at + 5min
}

// ---------------------------------------------------------------------------
// findLatestActiveOtp — primary verify-lookup path
// ---------------------------------------------------------------------------

/**
 * Resolve the most recent active OTP for the (tenant, phone, purpose)
 * tuple. "Active" = consumed_at IS NULL AND expires_at > NOW(). Returns
 * null if no row matches.
 *
 * Service-layer verify path:
 *   1. Find latest active OTP for (tenant, phone, purpose)
 *   2. If null → reject (no challenge in flight)
 *   3. Compute SHA-256 of user-supplied code, constant-time compare with
 *      row.code_hash
 *   4. On match → consumeOtp() → success
 *   5. On miss → decrementAttempts() → if hits 0, mark locked_until
 */
export async function findLatestActiveOtp(
  tenantId: TenantId,
  phoneE164: string,
  purpose: OtpPurpose,
  externalTx?: DbClient,
): Promise<OtpChallenge | null> {
  const runner = externalTx
    ? (fn: (client: DbClient) => Promise<OtpChallenge | null>) => fn(externalTx)
    : (fn: (client: DbClient) => Promise<OtpChallenge | null>) =>
        withTenantBoundConnection(tenantId, fn);
  return runner(async (client) => {
    const result = await client.query<OtpRow>(
      `SELECT ${OTP_COLUMNS}
         FROM otp_challenges
        WHERE tenant_id = $1
          AND phone_e164 = $2
          AND purpose = $3
          AND consumed_at IS NULL
          AND expires_at > NOW()
        ORDER BY created_at DESC
        LIMIT 1`,
      [tenantId, phoneE164, purpose],
    );
    if (result.rows.length === 0) return null;
    const row = result.rows[0];
    if (row === undefined) return null;
    return rowToOtp(row);
  });
}

// ---------------------------------------------------------------------------
// findActiveLockout — cooldown-check on issuance
// ---------------------------------------------------------------------------

/**
 * Check whether (tenant, phone, purpose) is currently in cooldown lockout.
 * Returns the OTP row that holds the lockout, or null if not locked.
 *
 * Service-layer issue path calls this BEFORE creating a new OTP — if it
 * returns non-null AND `locked_until > NOW()`, the issuance is rejected.
 */
export async function findActiveLockout(
  tenantId: TenantId,
  phoneE164: string,
  purpose: OtpPurpose,
  externalTx?: DbClient,
): Promise<OtpChallenge | null> {
  const runner = externalTx
    ? (fn: (client: DbClient) => Promise<OtpChallenge | null>) => fn(externalTx)
    : (fn: (client: DbClient) => Promise<OtpChallenge | null>) =>
        withTenantBoundConnection(tenantId, fn);
  return runner(async (client) => {
    const result = await client.query<OtpRow>(
      `SELECT ${OTP_COLUMNS}
         FROM otp_challenges
        WHERE tenant_id = $1
          AND phone_e164 = $2
          AND purpose = $3
          AND locked_until IS NOT NULL
          AND locked_until > NOW()
        ORDER BY locked_until DESC
        LIMIT 1`,
      [tenantId, phoneE164, purpose],
    );
    if (result.rows.length === 0) return null;
    const row = result.rows[0];
    if (row === undefined) return null;
    return rowToOtp(row);
  });
}

// ---------------------------------------------------------------------------
// createOtp
// ---------------------------------------------------------------------------

export async function createOtp(
  input: CreateOtpInput,
  txCallback: (tx: DbTransaction, otp: OtpChallenge) => Promise<void>,
  externalTx?: DbTransaction,
): Promise<OtpChallenge> {
  const runFn = async (tx: DbClient): Promise<OtpChallenge> => {
    const result = await tx.query<OtpRow>(
      `INSERT INTO otp_challenges (
          otp_id, tenant_id, account_id, phone_e164, purpose,
          code_hash, attempts_remaining,
          created_at, expires_at
       ) VALUES (
          $1, $2, $3, $4, $5,
          $6, 3,
          NOW(), $7::timestamptz
       )
       RETURNING ${OTP_COLUMNS}`,
      [
        input.otp_id,
        input.tenant_id,
        input.account_id ?? null,
        input.phone_e164,
        input.purpose,
        input.code_hash,
        input.expires_at,
      ],
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw new Error('createOtp: INSERT returned no rows (unreachable)');
    }
    const otp = rowToOtp(row);
    await txCallback(tx, otp);
    return otp;
  };

  if (externalTx !== undefined) {
    return runFn(externalTx);
  }
  return withTenantBoundConnection(input.tenant_id, runFn);
}

// ---------------------------------------------------------------------------
// consumeOtp — mark consumed_at on successful verify
// ---------------------------------------------------------------------------

/**
 * Mark an OTP as consumed (one-time use). Idempotent: re-calling on an
 * already-consumed row returns null.
 *
 * The WHERE clause includes `consumed_at IS NULL AND expires_at > NOW()`
 * to ensure expired OTPs cannot be consumed (a service-layer race could
 * otherwise consume a JUST-expired OTP if the verify path ran before
 * NOW() advanced).
 */
export async function consumeOtp(
  tenantId: TenantId,
  otpId: OtpId,
  externalTx?: DbClient,
): Promise<OtpChallenge | null> {
  const runner = externalTx
    ? (fn: (client: DbClient) => Promise<OtpChallenge | null>) => fn(externalTx)
    : (fn: (client: DbClient) => Promise<OtpChallenge | null>) =>
        withTenantBoundConnection(tenantId, fn);
  return runner(async (client) => {
    const result = await client.query<OtpRow>(
      `UPDATE otp_challenges
          SET consumed_at = NOW()
        WHERE tenant_id = $1
          AND otp_id = $2
          AND consumed_at IS NULL
          AND expires_at > NOW()
       RETURNING ${OTP_COLUMNS}`,
      [tenantId, otpId],
    );
    if (result.rows.length === 0) return null;
    const row = result.rows[0];
    if (row === undefined) return null;
    return rowToOtp(row);
  });
}

// ---------------------------------------------------------------------------
// decrementAttempts — failed-verify accounting
// ---------------------------------------------------------------------------

/**
 * Decrement attempts_remaining by 1. When it hits 0, set locked_until to
 * NOW() + 15 minutes per Identity Spec §2.1 cooldown rule. Returns the
 * updated row, or null on miss / already-consumed / already-expired.
 *
 * Atomically computes the new value — service-layer code never sees an
 * intermediate state where attempts_remaining was decremented but
 * locked_until wasn't set in the same transaction.
 */
export async function decrementAttempts(
  tenantId: TenantId,
  otpId: OtpId,
  externalTx?: DbClient,
): Promise<OtpChallenge | null> {
  const runner = externalTx
    ? (fn: (client: DbClient) => Promise<OtpChallenge | null>) => fn(externalTx)
    : (fn: (client: DbClient) => Promise<OtpChallenge | null>) =>
        withTenantBoundConnection(tenantId, fn);
  return runner(async (client) => {
    const result = await client.query<OtpRow>(
      `UPDATE otp_challenges
          SET attempts_remaining = attempts_remaining - 1,
              locked_until = CASE
                  WHEN attempts_remaining - 1 <= 0
                      THEN NOW() + INTERVAL '15 minutes'
                  ELSE locked_until
              END
        WHERE tenant_id = $1
          AND otp_id = $2
          AND consumed_at IS NULL
          AND expires_at > NOW()
          AND attempts_remaining > 0
       RETURNING ${OTP_COLUMNS}`,
      [tenantId, otpId],
    );
    if (result.rows.length === 0) return null;
    const row = result.rows[0];
    if (row === undefined) return null;
    return rowToOtp(row);
  });
}
