/**
 * otp-service.ts — OTP issuance + verify orchestration with audit emission
 * and the I-019-equivalent rate-limit/lockout enforcement.
 *
 * Spec references:
 *   - Identity & Authentication Spec v1.0 §2.1 (registration: 6-digit
 *     OTP, 5-min validity, 3 attempts max, 15-min cooldown)
 *   - Identity Spec v1.0 §3.1 (login: same OTP semantics)
 *   - Identity Spec v1.0 §3.5 (account recovery via phone-number-change OTP)
 *   - I-003 (audit append-only)
 */

import crypto from 'node:crypto';

import type { DbClient, DbTransaction } from '../../../../lib/db.js';
import type { TenantContext } from '../../../../lib/tenant-context.js';
import {
  emitOtpConsumedAudit,
  emitOtpIssuedAudit,
  emitOtpLockoutTriggeredAudit,
} from '../../audit.js';
import * as otpRepo from '../repositories/otp-repo.js';
import type { AccountId, OtpChallenge, OtpId, OtpPurpose } from '../types.js';

// ---------------------------------------------------------------------------
// 6-digit OTP code generation + hashing
// ---------------------------------------------------------------------------

/**
 * Generate a fresh random 6-digit OTP. Uses crypto.randomInt to avoid
 * modulo bias from a naive Math.random / randomBytes-mod-1000000 approach.
 */
export function generateOtpCode(): string {
  const code = crypto.randomInt(0, 1_000_000);
  return code.toString().padStart(6, '0');
}

export function hashOtpCode(plaintext: string): string {
  return crypto.createHash('sha256').update(plaintext).digest('hex');
}

/** Constant-time compare of two SHA-256 hex strings. */
export function timingSafeHashEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  return crypto.timingSafeEqual(bufA, bufB);
}

// ---------------------------------------------------------------------------
// Sentinels
// ---------------------------------------------------------------------------

export const OTP_LOCKOUT_ACTIVE = 'identity.otp.lockout_active';
export const OTP_NO_ACTIVE_CHALLENGE = 'identity.otp.no_active_challenge';
export const OTP_INVALID_CODE = 'identity.otp.invalid_code';
export const OTP_LOCKOUT_TRIGGERED = 'identity.otp.lockout_triggered';

// ---------------------------------------------------------------------------
// IssueOtpInput
// ---------------------------------------------------------------------------

const OTP_TTL_MINUTES = 5; // Identity Spec §2.1
const MS_PER_MINUTE = 60 * 1000;

export interface IssueOtpInput {
  otp_id: OtpId;
  /** Null for registration (no account yet); set for login + sensitive flows. */
  account_id?: AccountId | null;
  phone_e164: string;
  purpose: OtpPurpose;
}

// ---------------------------------------------------------------------------
// issueOtp — generate code + create row + emit audit (same tx)
// ---------------------------------------------------------------------------

/**
 * Issue a new OTP. Returns the persisted row PLUS the plaintext code
 * (which the caller passes to the SMS provider and forgets).
 *
 * Throws OTP_LOCKOUT_ACTIVE if the (tenant, phone, purpose) tuple is
 * currently in lockout cooldown — service layer maps to 429-equivalent
 * tenant-blind 400.
 */
export async function issueOtp(
  ctx: TenantContext,
  actor: { actorId: string },
  input: IssueOtpInput,
  externalTx?: DbTransaction,
): Promise<{ otp: OtpChallenge; codePlaintext: string }> {
  // Check cooldown. Repo accepts an optional externalTx; mirror our path
  // to share that tx if provided.
  const lockout = await otpRepo.findActiveLockout(
    ctx.tenantId,
    input.phone_e164,
    input.purpose,
    externalTx,
  );
  if (lockout !== null) {
    const err = new Error(OTP_LOCKOUT_ACTIVE);
    (err as Error & { code: string }).code = OTP_LOCKOUT_ACTIVE;
    throw err;
  }

  const codePlaintext = generateOtpCode();
  const codeHash = hashOtpCode(codePlaintext);
  const expiresAt = new Date(Date.now() + OTP_TTL_MINUTES * MS_PER_MINUTE).toISOString();

  const repoInput: otpRepo.CreateOtpInput = {
    otp_id: input.otp_id,
    tenant_id: ctx.tenantId,
    phone_e164: input.phone_e164,
    purpose: input.purpose,
    code_hash: codeHash,
    expires_at: expiresAt,
  };
  if (input.account_id !== undefined) repoInput.account_id = input.account_id;

  const otp = await otpRepo.createOtp(
    repoInput,
    async (tx, persisted) => {
      await emitOtpIssuedAudit(
        {
          tenantId: ctx.tenantId,
          otpId: persisted.otp_id,
          accountId: persisted.account_id,
          actorId: actor.actorId,
          countryOfCare: ctx.countryOfCare,
          purpose: persisted.purpose,
          phoneE164: persisted.phone_e164,
        },
        tx,
      );
    },
    externalTx,
  );

  return { otp, codePlaintext };
}

// ---------------------------------------------------------------------------
// verifyOtp
// ---------------------------------------------------------------------------

export interface VerifyOtpResult {
  ok: boolean;
  consumedOtp: OtpChallenge | null;
  /** Sentinel from { OTP_NO_ACTIVE_CHALLENGE | OTP_INVALID_CODE | OTP_LOCKOUT_TRIGGERED } */
  errorCode: string | null;
  attemptsRemaining: number;
}

/**
 * Verify a user-supplied OTP code against the most recent active
 * challenge for (tenant, phone, purpose). Three outcomes:
 *
 *   1. No active challenge → ok=false, errorCode=OTP_NO_ACTIVE_CHALLENGE
 *
 *   2. Active challenge AND code matches → ok=true; consumedOtp set;
 *      `identity_otp_consumed` audit emitted in same tx.
 *
 *   3. Active challenge AND code mismatches → attempts decremented;
 *      ok=false, errorCode=OTP_INVALID_CODE (or OTP_LOCKOUT_TRIGGERED
 *      when this attempt drained attempts to 0). On lockout-triggered,
 *      `identity_otp_lockout_triggered` audit is emitted.
 */
export async function verifyOtp(
  ctx: TenantContext,
  actor: { actorId: string },
  input: { phone_e164: string; purpose: OtpPurpose; code: string },
  externalTx?: DbTransaction,
): Promise<VerifyOtpResult> {
  const otp = await otpRepo.findLatestActiveOtp(
    ctx.tenantId,
    input.phone_e164,
    input.purpose,
    externalTx,
  );
  if (otp === null) {
    return {
      ok: false,
      consumedOtp: null,
      errorCode: OTP_NO_ACTIVE_CHALLENGE,
      attemptsRemaining: 0,
    };
  }

  const supplied = hashOtpCode(input.code);
  if (timingSafeHashEqual(supplied, otp.code_hash)) {
    // Match — consume + emit audit
    if (externalTx === undefined) {
      const { withTenantBoundConnection } = await import('../../../../lib/db.js');
      return withTenantBoundConnection(ctx.tenantId, async (tx) => {
        const consumed = await otpRepo.consumeOtp(ctx.tenantId, otp.otp_id, tx);
        if (consumed !== null) {
          await emitOtpConsumedAudit(
            {
              tenantId: ctx.tenantId,
              otpId: consumed.otp_id,
              accountId: consumed.account_id,
              actorId: actor.actorId,
              countryOfCare: ctx.countryOfCare,
              purpose: consumed.purpose,
            },
            tx,
          );
        }
        return {
          ok: consumed !== null,
          consumedOtp: consumed,
          errorCode: consumed === null ? OTP_NO_ACTIVE_CHALLENGE : null,
          attemptsRemaining: consumed?.attempts_remaining ?? 0,
        };
      });
    }
    const consumed = await otpRepo.consumeOtp(ctx.tenantId, otp.otp_id, externalTx);
    if (consumed !== null) {
      await emitOtpConsumedAudit(
        {
          tenantId: ctx.tenantId,
          otpId: consumed.otp_id,
          accountId: consumed.account_id,
          actorId: actor.actorId,
          countryOfCare: ctx.countryOfCare,
          purpose: consumed.purpose,
        },
        externalTx,
      );
    }
    return {
      ok: consumed !== null,
      consumedOtp: consumed,
      errorCode: consumed === null ? OTP_NO_ACTIVE_CHALLENGE : null,
      attemptsRemaining: consumed?.attempts_remaining ?? 0,
    };
  }

  // Code mismatch — decrement attempts; if hits 0, emit lockout audit
  if (externalTx === undefined) {
    const { withTenantBoundConnection } = await import('../../../../lib/db.js');
    return withTenantBoundConnection(ctx.tenantId, async (tx) => {
      return decrementWithAudit(ctx, actor, otp, tx);
    });
  }
  return decrementWithAudit(ctx, actor, otp, externalTx);
}

async function decrementWithAudit(
  ctx: TenantContext,
  actor: { actorId: string },
  otp: OtpChallenge,
  tx: DbClient,
): Promise<VerifyOtpResult> {
  const after = await otpRepo.decrementAttempts(ctx.tenantId, otp.otp_id, tx);
  if (after === null) {
    return {
      ok: false,
      consumedOtp: null,
      errorCode: OTP_NO_ACTIVE_CHALLENGE,
      attemptsRemaining: 0,
    };
  }
  if (after.attempts_remaining === 0 && after.locked_until !== null) {
    await emitOtpLockoutTriggeredAudit(
      {
        tenantId: ctx.tenantId,
        otpId: after.otp_id,
        accountId: after.account_id,
        actorId: actor.actorId,
        countryOfCare: ctx.countryOfCare,
        purpose: after.purpose,
        phoneE164: after.phone_e164,
      },
      tx,
    );
    return {
      ok: false,
      consumedOtp: null,
      errorCode: OTP_LOCKOUT_TRIGGERED,
      attemptsRemaining: 0,
    };
  }
  return {
    ok: false,
    consumedOtp: null,
    errorCode: OTP_INVALID_CODE,
    attemptsRemaining: after.attempts_remaining,
  };
}
