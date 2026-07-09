/**
 * email-pin-auth.ts — the email + 6-digit-PIN auth path (migration 078;
 * docs/SI-EMAIL-PIN-AUTH.md). Runs ALONGSIDE the phone + SMS-OTP path
 * (registration.ts / login.ts), which is unchanged.
 *
 *   POST /registration/email/start   { email } → emailed 6-digit passcode
 *   POST /registration/email/verify  { email, passcode, pin, profile } →
 *        create email account + set PIN + issue session
 *   POST /login/pin                  { email, pin } → issue session (lockout)
 *   POST /recovery/pin/start         { email } → emailed passcode (always 200)
 *   POST /recovery/pin/verify        { email, passcode, new_pin } → reset PIN
 *
 * Disciplines:
 *   - Idempotency: every POST uses withIdempotentExecution (IDEMPOTENCY v5.1).
 *   - Tenant-blind (I-025): PIN login returns a single INVALID_CREDENTIALS for
 *     both no-account and wrong-PIN; recovery/start always returns 200 (no
 *     email-existence enumeration). (Registration/start returns EMAIL_TAKEN,
 *     matching the existing phone flow's PHONE_TAKEN convention.)
 *   - Audit (I-003): account.created (createAccount), pin.set, session.issued,
 *     pin.login_failed/lockout, passcode.issued/consumed — all same-tx.
 *   - PIN never logged; passcode plaintext emailed once, never persisted.
 *
 * Email delivery is a stub (same posture as the SMS OTP stub) — the plaintext
 * passcode is returned to the caller's provider hook, not exposed on the wire.
 *
 * Spec references: migration 078; Identity Spec v1.0 §2/§3 (analogue flows);
 * I-003 / I-025; IDEMPOTENCY v5.1.
 */

import type { FastifyReply, FastifyRequest } from 'fastify';

import type { DbTransaction } from '../../../../lib/db.js';
import { withIdempotentExecution } from '../../../../lib/idempotent-handler.js';
import { requireTenantContext } from '../../../../lib/tenant-context.js';
import { ulid } from '../../../../lib/ulid.js';
import { emitPinLoginFailedAudit, emitPinSetAudit } from '../../audit.js';
import * as pinRepo from '../repositories/pin-credentials-repo.js';
import * as accountService from '../services/account-service.js';
import * as passcodeService from '../services/email-passcode-service.js';
import * as pinService from '../services/pin-service.js';
import * as sessionService from '../services/session-service.js';
import { asAccountId, asSessionId } from '../types.js';

// ---------------------------------------------------------------------------
// Sentinels + helpers
// ---------------------------------------------------------------------------

const EMAIL_TAKEN = 'identity.registration.email_taken';
const INVALID_CREDENTIALS = 'identity.login.invalid_credentials';
const PIN_LOCKED = 'identity.login.pin_locked';
const PASSCODE_FAILED = 'identity.email_passcode.verification_failed';
const WEAK_PIN = 'identity.pin.weak';

interface ErrorEnvelopeBody {
  error: { code: string; message: string; request_id: string };
}
function makeErrorEnvelope(reqId: string, code: string, message: string): ErrorEnvelopeBody {
  return { error: { code, message, request_id: reqId } };
}
function isString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}
const EMAIL_PATTERN = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
function normalizeEmail(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const e = v.trim().toLowerCase();
  return EMAIL_PATTERN.test(e) ? e : null;
}

/** Shared service-error mapper: passcode cooldown → 400; email unique → EMAIL_TAKEN. */
function mapServiceError(err: unknown, reply: FastifyReply, reqId: string): boolean {
  if (err instanceof Error && err.message === passcodeService.PASSCODE_LOCKOUT_ACTIVE) {
    void reply
      .code(400)
      .send(
        makeErrorEnvelope(
          reqId,
          passcodeService.PASSCODE_LOCKOUT_ACTIVE,
          'Too many recent attempts. Please wait before requesting a new code.',
        ),
      );
    return true;
  }
  if (
    err !== null &&
    typeof err === 'object' &&
    'code' in err &&
    (err as { code?: unknown }).code === '23505'
  ) {
    void reply
      .code(400)
      .send(makeErrorEnvelope(reqId, EMAIL_TAKEN, 'Email is already registered.'));
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// POST /registration/email/start
// ---------------------------------------------------------------------------

export async function emailRegistrationStartHandler(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<unknown> {
  const ctx = requireTenantContext(req);
  const email = normalizeEmail((req.body as { email?: unknown } | undefined)?.email);
  if (email === null) {
    return reply
      .code(400)
      .send(makeErrorEnvelope(req.id, 'internal.request.invalid', 'A valid email is required.'));
  }

  return withIdempotentExecution<unknown>(
    req,
    reply,
    mapServiceError,
    async (tx: DbTransaction) => {
      const existing = await accountService.findAccountByEmail(ctx, email, tx);
      if (existing !== null) {
        return {
          status: 400,
          view: makeErrorEnvelope(req.id, EMAIL_TAKEN, 'Email is already registered.'),
        };
      }
      const { passcode } = await passcodeService.issuePasscode(
        ctx,
        { actorId: 'system' },
        { passcode_id: ulid(), account_id: null, email, purpose: 'email_registration' },
        tx,
      );
      // The plaintext code goes to the email provider (stub); wire response
      // carries only the correlation id.
      return { status: 200, view: { passcode_id: passcode.passcode_id } };
    },
  );
}

// ---------------------------------------------------------------------------
// POST /registration/email/verify
// ---------------------------------------------------------------------------

interface EmailRegVerifyBody {
  email?: string;
  passcode?: string;
  pin?: string;
  first_name?: string;
  last_name?: string;
  date_of_birth?: string;
  gender?: 'female' | 'male' | 'non_binary' | 'prefer_not_to_say';
  country_of_residence?: string;
}

export async function emailRegistrationVerifyHandler(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<unknown> {
  const ctx = requireTenantContext(req);
  const body = (req.body ?? {}) as EmailRegVerifyBody;
  const email = normalizeEmail(body.email);

  if (
    email === null ||
    !isString(body.passcode) ||
    !isString(body.pin) ||
    !isString(body.first_name) ||
    !isString(body.last_name) ||
    !isString(body.date_of_birth) ||
    !isString(body.gender)
  ) {
    return reply
      .code(400)
      .send(
        makeErrorEnvelope(
          req.id,
          'internal.request.invalid',
          'email, passcode, pin, first_name, last_name, date_of_birth, gender are required.',
        ),
      );
  }
  if (!pinService.isAcceptablePin(body.pin)) {
    return reply
      .code(400)
      .send(
        makeErrorEnvelope(
          req.id,
          WEAK_PIN,
          'PIN must be exactly 6 digits and not a trivially guessable sequence.',
        ),
      );
  }

  const passcode = body.passcode;
  const pin = body.pin;
  const firstName = body.first_name;
  const lastName = body.last_name;
  const dateOfBirth = body.date_of_birth;
  const gender = body.gender;

  return withIdempotentExecution<unknown>(
    req,
    reply,
    mapServiceError,
    async (tx: DbTransaction) => {
      const verify = await passcodeService.verifyPasscode(
        ctx,
        { actorId: 'system' },
        { email, purpose: 'email_registration', code: passcode },
        tx,
      );
      if (!verify.ok) {
        return {
          status: 400,
          view: makeErrorEnvelope(req.id, PASSCODE_FAILED, 'Passcode verification failed.'),
        };
      }

      const accountId = asAccountId(ulid());
      // Create the email-only account (phone omitted → NULL), then activate.
      const created = await accountService.createAccount(
        ctx,
        { actorId: 'system' },
        {
          account_id: accountId,
          email,
          first_name: firstName,
          last_name: lastName,
          date_of_birth: dateOfBirth,
          gender,
          ...(body.country_of_residence !== undefined
            ? { country_of_residence: body.country_of_residence }
            : {}),
        },
        tx,
      );
      const activated = await accountService.activateAccount(
        ctx,
        { actorId: 'system' },
        created.account_id,
        tx,
      );
      const finalAccount = activated ?? created;

      // Set the PIN (scrypt) + audit, same tx.
      const hashed = pinService.hashPin(pin);
      await pinRepo.upsertPinCredential(
        {
          account_id: finalAccount.account_id,
          tenant_id: ctx.tenantId,
          pin_hash: hashed.pinHash,
          pin_salt: hashed.pinSalt,
          algorithm: hashed.algorithm,
        },
        tx,
      );
      await emitPinSetAudit(
        {
          tenantId: ctx.tenantId,
          accountId: finalAccount.account_id,
          actorId: 'system',
          countryOfCare: ctx.countryOfCare,
          context: 'registration',
        },
        tx,
      );

      // Log the new patient in.
      const { session, refreshTokenPlaintext, accessToken } = await sessionService.issueSession(
        ctx,
        { actorId: finalAccount.account_id },
        { session_id: asSessionId(ulid()), account_id: finalAccount.account_id },
        tx,
      );

      return {
        status: 201,
        view: {
          account: accountService.toPatientAccountView(finalAccount),
          session_id: session.session_id,
          refresh_token: refreshTokenPlaintext,
          access_token: accessToken,
        },
      };
    },
  );
}

// ---------------------------------------------------------------------------
// POST /login/pin
// ---------------------------------------------------------------------------

export async function pinLoginHandler(req: FastifyRequest, reply: FastifyReply): Promise<unknown> {
  const ctx = requireTenantContext(req);
  const body = (req.body ?? {}) as { email?: string; pin?: string };
  const email = normalizeEmail(body.email);
  const pin = body.pin;

  if (email === null || !pinService.isValidPinShape(pin)) {
    // Shape failure → the same tenant-blind invalid-credentials envelope (no
    // distinction between malformed and wrong, to avoid probing).
    return reply
      .code(401)
      .send(makeErrorEnvelope(req.id, INVALID_CREDENTIALS, 'Invalid email or PIN.'));
  }

  return withIdempotentExecution<unknown>(
    req,
    reply,
    mapServiceError,
    async (tx: DbTransaction) => {
      const account = await accountService.findAccountByEmail(ctx, email, tx);
      if (account === null || account.status !== 'active') {
        return {
          status: 401,
          view: makeErrorEnvelope(req.id, INVALID_CREDENTIALS, 'Invalid email or PIN.'),
        };
      }
      const cred = await pinRepo.findByAccountId(ctx.tenantId, account.account_id, tx);
      if (cred === null) {
        return {
          status: 401,
          view: makeErrorEnvelope(req.id, INVALID_CREDENTIALS, 'Invalid email or PIN.'),
        };
      }

      const lockedUntil = cred.locked_until === null ? null : new Date(cred.locked_until);
      if (pinService.isLockedOut({ failedAttempts: cred.failed_attempts, lockedUntil })) {
        return {
          status: 401,
          view: makeErrorEnvelope(
            req.id,
            PIN_LOCKED,
            'Too many failed attempts. Please try again later or reset your PIN.',
          ),
        };
      }

      if (!pinService.verifyPin(pin, cred.pin_hash, cred.pin_salt)) {
        const next = pinService.nextFailureState({
          failedAttempts: cred.failed_attempts,
          lockedUntil,
        });
        await pinRepo.recordFailure(
          ctx.tenantId,
          account.account_id,
          next.failedAttempts,
          next.lockedUntil === null ? null : next.lockedUntil.toISOString(),
          tx,
        );
        await emitPinLoginFailedAudit(
          {
            tenantId: ctx.tenantId,
            accountId: account.account_id,
            actorId: 'system',
            countryOfCare: ctx.countryOfCare,
            lockedOut: next.lockedUntil !== null,
          },
          tx,
        );
        return {
          status: 401,
          view: makeErrorEnvelope(req.id, INVALID_CREDENTIALS, 'Invalid email or PIN.'),
        };
      }

      // Success — clear the lockout counter + issue a session.
      await pinRepo.recordSuccess(ctx.tenantId, account.account_id, tx);
      const { session, refreshTokenPlaintext, accessToken } = await sessionService.issueSession(
        ctx,
        { actorId: account.account_id },
        { session_id: asSessionId(ulid()), account_id: account.account_id },
        tx,
      );
      return {
        status: 200,
        view: {
          account: accountService.toPatientAccountView(account),
          session_id: session.session_id,
          refresh_token: refreshTokenPlaintext,
          access_token: accessToken,
        },
      };
    },
  );
}

// ---------------------------------------------------------------------------
// POST /recovery/pin/start — always 200 (no email-existence enumeration)
// ---------------------------------------------------------------------------

export async function pinRecoveryStartHandler(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<unknown> {
  const ctx = requireTenantContext(req);
  const email = normalizeEmail((req.body as { email?: unknown } | undefined)?.email);
  if (email === null) {
    return reply
      .code(400)
      .send(makeErrorEnvelope(req.id, 'internal.request.invalid', 'A valid email is required.'));
  }

  return withIdempotentExecution<unknown>(
    req,
    reply,
    mapServiceError,
    async (tx: DbTransaction) => {
      const account = await accountService.findAccountByEmail(ctx, email, tx);
      // Issue a passcode ONLY if the account exists — but ALWAYS return 200 so
      // a caller cannot learn whether the email is registered (I-025 enumeration
      // defense; this diverges intentionally from registration/start).
      if (account !== null && account.status === 'active') {
        await passcodeService.issuePasscode(
          ctx,
          { actorId: 'system' },
          { passcode_id: ulid(), account_id: account.account_id, email, purpose: 'pin_recovery' },
          tx,
        );
      }
      return { status: 200, view: { status: 'ok' } };
    },
  );
}

// ---------------------------------------------------------------------------
// POST /recovery/pin/verify — verify passcode + set a new PIN
// ---------------------------------------------------------------------------

export async function pinRecoveryVerifyHandler(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<unknown> {
  const ctx = requireTenantContext(req);
  const body = (req.body ?? {}) as { email?: string; passcode?: string; new_pin?: string };
  const email = normalizeEmail(body.email);

  if (email === null || !isString(body.passcode) || !isString(body.new_pin)) {
    return reply
      .code(400)
      .send(
        makeErrorEnvelope(
          req.id,
          'internal.request.invalid',
          'email, passcode, and new_pin are required.',
        ),
      );
  }
  if (!pinService.isAcceptablePin(body.new_pin)) {
    return reply
      .code(400)
      .send(
        makeErrorEnvelope(
          req.id,
          WEAK_PIN,
          'PIN must be exactly 6 digits and not a trivially guessable sequence.',
        ),
      );
  }

  const passcode = body.passcode;
  const newPin = body.new_pin;

  return withIdempotentExecution<unknown>(
    req,
    reply,
    mapServiceError,
    async (tx: DbTransaction) => {
      const account = await accountService.findAccountByEmail(ctx, email, tx);
      // Verify the passcode regardless (tenant-blind: same failure envelope
      // whether the account is missing or the code is wrong).
      if (account === null || account.status !== 'active') {
        return {
          status: 400,
          view: makeErrorEnvelope(req.id, PASSCODE_FAILED, 'Passcode verification failed.'),
        };
      }
      const verify = await passcodeService.verifyPasscode(
        ctx,
        { actorId: 'system' },
        { email, purpose: 'pin_recovery', code: passcode },
        tx,
      );
      if (!verify.ok) {
        return {
          status: 400,
          view: makeErrorEnvelope(req.id, PASSCODE_FAILED, 'Passcode verification failed.'),
        };
      }

      const hashed = pinService.hashPin(newPin);
      await pinRepo.upsertPinCredential(
        {
          account_id: account.account_id,
          tenant_id: ctx.tenantId,
          pin_hash: hashed.pinHash,
          pin_salt: hashed.pinSalt,
          algorithm: hashed.algorithm,
        },
        tx,
      );
      await emitPinSetAudit(
        {
          tenantId: ctx.tenantId,
          accountId: account.account_id,
          actorId: 'system',
          countryOfCare: ctx.countryOfCare,
          context: 'recovery',
        },
        tx,
      );
      return { status: 200, view: { status: 'ok' } };
    },
  );
}
