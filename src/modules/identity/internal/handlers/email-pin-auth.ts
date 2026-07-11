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
 *   - Tenant-blind (I-025): NO endpoint reveals whether an email is registered.
 *     PIN login returns a single INVALID_CREDENTIALS for no-account / wrong-PIN
 *     / locked; registration/start + recovery/start both always return 200
 *     (a passcode is issued only for the relevant account state); a verify
 *     attempt on a non-issuing email fails with the same PASSCODE_FAILED as a
 *     wrong code.
 *   - Audit (I-003): account.created (createAccount), pin.set, session.issued,
 *     pin.login_failed/lockout, passcode.issued/consumed — all same-tx.
 *   - PIN never logged; passcode plaintext emailed once, never persisted.
 *
 * Email delivery: the start endpoints hand the freshly-issued passcode to the
 * configured EmailSender (src/lib/email) AFTER the DB transaction commits, as
 * fire-and-forget — so provider latency never skews the uniform-work response
 * timing (Codex round-6) and a provider outage never fails signup/recovery.
 * Default provider is 'noop' (log-only); staging additionally echoes the code
 * as dev_passcode. Real delivery is a config flip (EMAIL_PROVIDER=resend).
 *
 * Spec references: migration 078; Identity Spec v1.0 §2/§3 (analogue flows);
 * I-003 / I-025; IDEMPOTENCY v5.1; docs/SI-EMAIL-DELIVERY-PROVIDER.md.
 */

import type { FastifyReply, FastifyRequest } from 'fastify';

import { config } from '../../../../lib/config.js';
import type { DbTransaction } from '../../../../lib/db.js';
import { getEmailSender } from '../../../../lib/email/index.js';
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

const INVALID_CREDENTIALS = 'identity.login.invalid_credentials';
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

/** Shared service-error mapper: passcode cooldown → 400; email-unique race →
 *  the tenant-blind PASSCODE_FAILED (NOT a distinct "email taken" — that would
 *  be an enumeration oracle at verify, mirroring the start-side fix). */
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
    // A unique-violation (email already registered) can only surface here as a
    // narrow verify-time race (start never issues a registration passcode for
    // an existing email). Return the same PASSCODE_FAILED envelope as a wrong
    // code so it leaks nothing about existence.
    void reply
      .code(400)
      .send(makeErrorEnvelope(reqId, PASSCODE_FAILED, 'Passcode verification failed.'));
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// POST /registration/email/start
// ---------------------------------------------------------------------------

/**
 * Fire-and-forget passcode-email dispatch. Call AFTER withIdempotentExecution
 * resolves — the tx has committed (never email a rolled-back code) and, on an
 * idempotent replay, the body callback did not run so `code` was never set
 * (no duplicate email). NOT awaited: provider latency must not skew the
 * uniform-work response timing (Codex round-6 enumeration/timing defense), and
 * a provider outage must not fail signup/recovery. The passcode is still
 * issued + persisted regardless; delivery is best-effort.
 */
function dispatchPasscodeEmail(
  req: FastifyRequest,
  args: {
    to: string;
    code: string;
    purpose: 'email_registration' | 'pin_recovery';
    consumerDba: string;
  },
): void {
  void getEmailSender()
    .sendPasscode({
      to: args.to,
      code: args.code,
      purpose: args.purpose,
      consumerDba: args.consumerDba,
      ttlMinutes: passcodeService.PASSCODE_TTL_MINUTES,
    })
    .catch((err: unknown) => {
      // Message-only logging (Codex PR#274 r1 HIGH): never serialize the raw
      // error object across this boundary — a runtime transport error can
      // carry the request options (API-key header, passcode body). The sender
      // already rethrows sanitized errors; this is defense-in-depth.
      req.log.error(
        {
          event: 'passcode_email_dispatch_failed',
          purpose: args.purpose,
          reason: err instanceof Error ? err.message : 'unknown',
        },
        'passcode email dispatch failed',
      );
    });
}

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

  // Captured inside the tx callback; read AFTER commit to dispatch the email
  // (never on an idempotent replay, where the callback doesn't run).
  let issuedCode: string | null = null;
  const result = await withIdempotentExecution<unknown>(
    req,
    reply,
    mapServiceError,
    async (tx: DbTransaction) => {
      // registration/start reveals NOTHING about whether the email is already
      // registered — not via the response (always 200), not via a passcode
      // cooldown (swallowed), and not via TIMING (Codex round-6). It therefore
      // does the SAME work for every email: it ALWAYS issues a registration
      // passcode, WITHOUT first looking up the account. A passcode for an
      // already-registered email is harmless — a verify attempt creates a NEW
      // account which fails the unique index → the same PASSCODE_FAILED as a
      // wrong code. (A future refinement could email an already-registered
      // address a "you already have an account, sign in" variant; the API
      // response — and the always-send timing — stay identical.)
      let devPasscode: string | undefined;
      try {
        const { codePlaintext } = await passcodeService.issuePasscode(
          ctx,
          { actorId: 'system' },
          { passcode_id: ulid(), account_id: null, email, purpose: 'email_registration' },
          tx,
        );
        issuedCode = codePlaintext;
        // Staging echoes the code as dev_passcode (AUTH_DEV_OTP_ECHO gate +
        // production fail-fast, same as the OTP dev_otp echo) so the Track-4
        // app can complete the flow without a real email provider.
        if (config.authDevOtpEcho) devPasscode = codePlaintext;
      } catch (err) {
        // A passcode cooldown must NOT surface (it would be a 400 that
        // distinguishes an email that recently requested a code). Swallow it
        // and still return 200. Truly-unexpected errors still propagate.
        if (!(err instanceof Error && err.message === passcodeService.PASSCODE_LOCKOUT_ACTIVE)) {
          throw err;
        }
      }
      return {
        status: 200,
        view:
          devPasscode !== undefined
            ? { status: 'ok', dev_passcode: devPasscode }
            : { status: 'ok' },
      };
    },
  );
  if (issuedCode !== null) {
    dispatchPasscodeEmail(req, {
      to: email,
      code: issuedCode,
      purpose: 'email_registration',
      consumerDba: ctx.consumerDba,
    });
  }
  return result;
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
      const invalid = {
        status: 401,
        view: makeErrorEnvelope(req.id, INVALID_CREDENTIALS, 'Invalid email or PIN.'),
      };

      const account = await accountService.findAccountByEmail(ctx, email, tx);
      const cred =
        account !== null && account.status === 'active'
          ? await pinRepo.findByAccountId(ctx.tenantId, account.account_id, tx)
          : null;

      // Codex HIGH (round-6) work-factor timing oracle fix: EVERY /login/pin
      // request performs exactly ONE scrypt derivation. When there is no
      // active account / credential, burn an equivalent dummy derivation so
      // response latency never reveals whether the email is registered. The
      // real verify below is the other single-scrypt path.
      if (account === null || cred === null) {
        pinService.dummyVerify(pin);
        return invalid;
      }

      const lockedUntil = cred.locked_until === null ? null : new Date(cred.locked_until);
      const locked = pinService.isLockedOut({ failedAttempts: cred.failed_attempts, lockedUntil });
      // Always run the real scrypt (uniform timing, incl. the locked path).
      const pinOk = pinService.verifyPin(pin, cred.pin_hash, cred.pin_salt);

      if (locked || !pinOk) {
        // Locked OR wrong PIN → the identical tenant-blind INVALID_CREDENTIALS
        // (a distinct pin_locked code was an enumeration + lockout-DoS oracle).
        // Account the failure ONLY when NOT already locked — re-incrementing a
        // live cooldown on every probe would let an attacker extend the lock
        // indefinitely (attacker-controlled DoS). The row-atomic increment
        // makes concurrent wrong-PIN attempts each count.
        if (!locked) {
          const state = await pinRepo.recordFailureAtomic(
            ctx.tenantId,
            account.account_id,
            pinService.MAX_PIN_ATTEMPTS,
            pinService.PIN_LOCKOUT_MINUTES,
            tx,
          );
          const lockedNow =
            state.lockedUntil !== null && new Date(state.lockedUntil).getTime() > Date.now();
          await emitPinLoginFailedAudit(
            {
              tenantId: ctx.tenantId,
              accountId: account.account_id,
              actorId: 'system',
              countryOfCare: ctx.countryOfCare,
              lockedOut: lockedNow,
            },
            tx,
          );
        } else {
          // Already locked (Codex round-11 MEDIUM): a probe during the cooldown
          // is still a real failed authentication attempt against a known
          // account, so it MUST leave an append-only audit trail for detection
          // + incident reconstruction (I-003). Emit with lockedOut=true, but do
          // NOT call recordFailureAtomic — re-incrementing would let an attacker
          // extend the lock indefinitely (attacker-controlled DoS). No lockout-
          // state mutation on this path; audit only.
          await emitPinLoginFailedAudit(
            {
              tenantId: ctx.tenantId,
              accountId: account.account_id,
              actorId: 'system',
              countryOfCare: ctx.countryOfCare,
              lockedOut: true,
            },
            tx,
          );
        }
        return invalid;
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

  let issuedCode: string | null = null;
  const result = await withIdempotentExecution<unknown>(
    req,
    reply,
    mapServiceError,
    async (tx: DbTransaction) => {
      // recovery/start reveals NOTHING about existence — not via the response
      // (always 200), not via cooldown (swallowed), and not via TIMING (Codex
      // round-6): it does the SAME work for every email. We look the account up
      // (uniform read, used only to attribute the passcode to an account_id
      // when one exists) and then ALWAYS issue a pin_recovery passcode. For an
      // unknown email the passcode carries account_id=null and a later verify
      // fails at the account lookup → the same PASSCODE_FAILED as a wrong code.
      const account = await accountService.findAccountByEmail(ctx, email, tx);
      const accountId = account !== null && account.status === 'active' ? account.account_id : null;
      let devPasscode: string | undefined;
      try {
        const { codePlaintext } = await passcodeService.issuePasscode(
          ctx,
          { actorId: 'system' },
          { passcode_id: ulid(), account_id: accountId, email, purpose: 'pin_recovery' },
          tx,
        );
        issuedCode = codePlaintext;
        // Staging echoes the code as dev_passcode (AUTH_DEV_OTP_ECHO gate +
        // production fail-fast). Because a passcode is now ALWAYS issued, the
        // echo is present for every email → not even a staging-mode oracle.
        if (config.authDevOtpEcho) devPasscode = codePlaintext;
      } catch (err) {
        // Swallow a passcode cooldown (would otherwise 400) — still 200.
        if (!(err instanceof Error && err.message === passcodeService.PASSCODE_LOCKOUT_ACTIVE)) {
          throw err;
        }
      }
      return {
        status: 200,
        view:
          devPasscode !== undefined
            ? { status: 'ok', dev_passcode: devPasscode }
            : { status: 'ok' },
      };
    },
  );
  // recovery/start always issues a passcode for every email (existent or not),
  // so this always fires when a code was issued — uniform, no existence oracle.
  if (issuedCode !== null) {
    dispatchPasscodeEmail(req, {
      to: email,
      code: issuedCode,
      purpose: 'pin_recovery',
      consumerDba: ctx.consumerDba,
    });
  }
  return result;
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
      // Codex HIGH (round-7): run the passcode verification for EVERY email —
      // registered or not — BEFORE branching on account existence. Since
      // recovery/start now always issues a passcode (account_id=null for
      // unknown emails), an unknown email has a real challenge to consume /
      // decrement, so verify does the same work + state mutation as for a
      // registered email. Skipping it for unknown emails was a state/timing
      // oracle. The combined check below returns the identical PASSCODE_FAILED
      // whether the code was wrong OR the account is missing/inactive.
      const verify = await passcodeService.verifyPasscode(
        ctx,
        { actorId: 'system' },
        { email, purpose: 'pin_recovery', code: passcode },
        tx,
      );
      const account = await accountService.findAccountByEmail(ctx, email, tx);
      if (!verify.ok || account === null || account.status !== 'active') {
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
