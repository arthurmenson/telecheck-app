/**
 * email-passcode-service.ts — issue + verify one-time email passcodes for
 * the email+PIN auth path (migration 078; docs/SI-EMAIL-PIN-AUTH.md). The
 * email analogue of otp-service.ts; reuses the SHA-256 code hashing +
 * timing-safe compare + 6-digit generation primitives from otp-service.
 *
 * Purposes: 'email_registration' (verify a new email at signup) and
 * 'pin_recovery' (authorize a PIN reset). Disciplines mirror the phone OTP:
 * 5-min TTL, 3 attempts, cooldown lockout, one-time consume, tenant-blind.
 *
 * Spec references: migration 078; Identity Spec v1.0 §2.1/§3.1 (OTP analogue);
 * I-003 (audit append-only) / I-025 (tenant-blind).
 */

import type { DbTransaction } from '../../../../lib/db.js';
import type { TenantContext } from '../../../../lib/tenant-context.js';
import { emitEmailPasscodeConsumedAudit, emitEmailPasscodeIssuedAudit } from '../../audit.js';
import * as passcodeRepo from '../repositories/email-passcode-repo.js';
import type { EmailPasscode, EmailPasscodePurpose } from '../repositories/email-passcode-repo.js';

import { generateOtpCode, hashOtpCode, timingSafeHashEqual } from './otp-service.js';

export const PASSCODE_LOCKOUT_ACTIVE = 'identity.email_passcode.lockout_active';
export const PASSCODE_NO_ACTIVE_CHALLENGE = 'identity.email_passcode.no_active_challenge';
export const PASSCODE_INVALID_CODE = 'identity.email_passcode.invalid_code';
export const PASSCODE_LOCKOUT_TRIGGERED = 'identity.email_passcode.lockout_triggered';

/** Passcode lifetime in minutes. Exported so the email template can render
 *  the "expires in N minutes" line from the single source of truth. */
export const PASSCODE_TTL_MINUTES = 5;
const MS_PER_MINUTE = 60 * 1000;

export interface IssuePasscodeInput {
  passcode_id: string;
  account_id?: string | null;
  email: string;
  purpose: EmailPasscodePurpose;
}

/**
 * Issue a new email passcode. Returns the persisted row + the plaintext code
 * (the caller hands it to the email provider and forgets it). Throws
 * PASSCODE_LOCKOUT_ACTIVE (sentinel `.code`) when the (tenant, email, purpose)
 * tuple is in cooldown.
 */
export async function issuePasscode(
  ctx: TenantContext,
  actor: { actorId: string },
  input: IssuePasscodeInput,
  externalTx: DbTransaction,
): Promise<{ passcode: EmailPasscode; codePlaintext: string }> {
  const lockout = await passcodeRepo.findActiveLockout(
    ctx.tenantId,
    input.email,
    input.purpose,
    externalTx,
  );
  if (lockout !== null) {
    const err = new Error(PASSCODE_LOCKOUT_ACTIVE);
    (err as Error & { code: string }).code = PASSCODE_LOCKOUT_ACTIVE;
    throw err;
  }

  // Tuple-wide attempt-budget carry-forward (Codex round-12 HIGH). Issuing a
  // fresh passcode must NOT reset the guessing window: without this, an
  // attacker calls start (3 fresh attempts), spends 1-2 wrong verifies, calls
  // start again, and repeats indefinitely — no row ever reaches
  // attempts_remaining=0, so the 3-attempt cooldown never triggers. By seeding
  // the new challenge with the remaining budget of the latest still-active
  // challenge, the budget decreases monotonically across re-issues until it
  // locks the tuple (or all challenges expire and it legitimately resets).
  const priorActive = await passcodeRepo.findLatestActivePasscode(
    ctx.tenantId,
    input.email,
    input.purpose,
    externalTx,
  );

  const codePlaintext = generateOtpCode();
  const codeHash = hashOtpCode(codePlaintext);
  const expiresAt = new Date(Date.now() + PASSCODE_TTL_MINUTES * MS_PER_MINUTE).toISOString();

  const repoInput: passcodeRepo.CreatePasscodeInput = {
    passcode_id: input.passcode_id,
    tenant_id: ctx.tenantId,
    email: input.email,
    purpose: input.purpose,
    code_hash: codeHash,
    expires_at: expiresAt,
  };
  if (priorActive !== null) repoInput.attempts_remaining = priorActive.attempts_remaining;
  if (input.account_id !== undefined) repoInput.account_id = input.account_id;

  const passcode = await passcodeRepo.createPasscode(
    repoInput,
    async (tx, persisted) => {
      await emitEmailPasscodeIssuedAudit(
        {
          tenantId: ctx.tenantId,
          passcodeId: persisted.passcode_id,
          accountId: persisted.account_id,
          actorId: actor.actorId,
          countryOfCare: ctx.countryOfCare,
          purpose: persisted.purpose,
          email: persisted.email,
        },
        tx,
      );
    },
    externalTx,
  );

  return { passcode, codePlaintext };
}

export interface VerifyPasscodeResult {
  ok: boolean;
  consumed: EmailPasscode | null;
  errorCode: string | null;
}

/**
 * Verify a user-supplied code against the latest active passcode for
 * (tenant, email, purpose). On match: consume + emit consumed audit. On
 * mismatch: decrement attempts (lockout on 0). Tenant-blind: the caller
 * surfaces only the sentinel, never expired-vs-wrong.
 */
export async function verifyPasscode(
  ctx: TenantContext,
  actor: { actorId: string },
  input: { email: string; purpose: EmailPasscodePurpose; code: string },
  externalTx: DbTransaction,
): Promise<VerifyPasscodeResult> {
  // Tuple-wide lockout gate (Codex round-9 HIGH). Excluding a locked row from
  // findLatestActivePasscode is not enough: a user can hold more than one
  // unconsumed passcode (issue A, then issue B — issue only blocks on an
  // ACTIVE lockout, not on an existing active code). If B is then locked, the
  // locked row is skipped and the query falls through to the still-active
  // older code A, letting the correct A bypass the cooldown. Gating on the
  // (tenant, email, purpose) lockout FIRST makes the cooldown tuple-wide:
  // once any passcode for the tuple is locked, no code verifies until it
  // expires. Tenant-blind — an unknown email is simply never locked.
  const activeLockout = await passcodeRepo.findActiveLockout(
    ctx.tenantId,
    input.email,
    input.purpose,
    externalTx,
  );
  if (activeLockout !== null) {
    return { ok: false, consumed: null, errorCode: PASSCODE_LOCKOUT_TRIGGERED };
  }

  const passcode = await passcodeRepo.findLatestActivePasscode(
    ctx.tenantId,
    input.email,
    input.purpose,
    externalTx,
  );
  if (passcode === null) {
    return { ok: false, consumed: null, errorCode: PASSCODE_NO_ACTIVE_CHALLENGE };
  }

  const supplied = hashOtpCode(input.code);
  if (timingSafeHashEqual(supplied, passcode.code_hash)) {
    const consumed = await passcodeRepo.consumePasscode(
      ctx.tenantId,
      passcode.passcode_id,
      externalTx,
    );
    if (consumed !== null) {
      await emitEmailPasscodeConsumedAudit(
        {
          tenantId: ctx.tenantId,
          passcodeId: consumed.passcode_id,
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
      consumed,
      errorCode: consumed === null ? PASSCODE_NO_ACTIVE_CHALLENGE : null,
    };
  }

  const after = await passcodeRepo.decrementAttempts(
    ctx.tenantId,
    passcode.passcode_id,
    externalTx,
  );
  if (after === null) {
    return { ok: false, consumed: null, errorCode: PASSCODE_NO_ACTIVE_CHALLENGE };
  }
  if (after.attempts_remaining === 0 && after.locked_until !== null) {
    return { ok: false, consumed: null, errorCode: PASSCODE_LOCKOUT_TRIGGERED };
  }
  return { ok: false, consumed: null, errorCode: PASSCODE_INVALID_CODE };
}
