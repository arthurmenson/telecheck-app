/**
 * registration.ts — POST /v0/identity/registration/{start,verify} handlers.
 *
 * Implements Identity & Authentication Spec v1.0 §2 patient registration
 * flow:
 *
 *   POST /registration/start
 *     Body: { phone_e164, first_name, last_name, date_of_birth,
 *             gender, country_of_residence, country_of_care, ... }
 *     - Reject if phone is already registered in this tenant
 *       (PHONE_TAKEN)
 *     - Reject if cooldown lockout is active (OTP_LOCKOUT_ACTIVE)
 *     - Issue 6-digit OTP for the phone with purpose='registration'
 *       (account_id is null at this point)
 *     - Return { otp_id } so the client can correlate the verify call
 *     - The plaintext code is sent to the patient via SMS (stub at
 *       v1.0; SMS provider wiring deferred)
 *
 *   POST /registration/verify
 *     Body: { otp_id, code, phone_e164, profile fields }
 *     - Verify OTP (consumes on success)
 *     - On success: create account in pending_verification status,
 *       then immediately activate it (registration is the activation
 *       trigger per Identity Spec §2.1 line 25)
 *     - Return PatientAccountView (tenant_id stripped)
 *
 * Spec references:
 *   - Identity & Authentication Spec v1.0 §2 (registration)
 *   - I-003 (audit append-only — every state-changing call emits audit)
 *   - I-025 (tenant-blind error envelope)
 *   - Master PRD v1.10 §17 + Glossary v5.2 C3 (PatientAccountView strip)
 *   - SI-006 reserve-then-execute idempotency (POST handlers migrated to
 *     withIdempotentExecution; see src/lib/idempotent-handler.ts).
 */

import type { FastifyReply, FastifyRequest } from 'fastify';

import type { DbTransaction } from '../../../../lib/db.js';
import { withIdempotentExecution } from '../../../../lib/idempotent-handler.js';
import { requireTenantContext } from '../../../../lib/tenant-context.js';
import { ulid } from '../../../../lib/ulid.js';
import * as accountService from '../services/account-service.js';
import * as otpService from '../services/otp-service.js';
import { asAccountId, asOtpId, type Account } from '../types.js';

// ---------------------------------------------------------------------------
// Sentinel error codes (mapped to HTTP envelope shapes by the handlers)
// ---------------------------------------------------------------------------

const PHONE_TAKEN = 'identity.registration.phone_taken';

// ---------------------------------------------------------------------------
// Request body shapes
// ---------------------------------------------------------------------------

interface RegistrationStartBody {
  phone_e164?: string;
}

interface RegistrationVerifyBody {
  otp_id?: string;
  code?: string;
  phone_e164?: string;
  first_name?: string;
  last_name?: string;
  date_of_birth?: string; // YYYY-MM-DD
  gender?: 'female' | 'male' | 'non_binary' | 'prefer_not_to_say';
  email?: string | null;
  national_id?: string | null;
  country_of_residence?: string;
}

function isString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}

// ---------------------------------------------------------------------------
// Error envelope helper
// ---------------------------------------------------------------------------

interface ErrorEnvelopeBody {
  error: { code: string; message: string; request_id: string };
}

function makeErrorEnvelope(reqId: string, code: string, message: string): ErrorEnvelopeBody {
  return { error: { code, message, request_id: reqId } };
}

/**
 * Map service-layer auth-flow errors to HTTP envelopes.
 *
 * The OTP service throws a sentinel Error with message=OTP_LOCKOUT_ACTIVE
 * on cooldown. Per Identity Spec §3 + tenant-blind error discipline, we
 * surface the sentinel code in the envelope but DO NOT include
 * tenant-specific timing or count info.
 */
function mapServiceError(err: unknown, reply: FastifyReply, reqId: string): boolean {
  if (err instanceof Error && err.message === otpService.OTP_LOCKOUT_ACTIVE) {
    void reply
      .code(400)
      .send(
        makeErrorEnvelope(
          reqId,
          otpService.OTP_LOCKOUT_ACTIVE,
          'Too many recent attempts. Please wait before requesting a new code.',
        ),
      );
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// POST /registration/start
// ---------------------------------------------------------------------------

/**
 * Issue a registration OTP. The actor is `system` since the platform is
 * acting on the patient's behalf during the OTP-mediated registration
 * flow (no authenticated session exists yet).
 *
 * Returns 400 with PHONE_TAKEN code if the phone is already registered
 * in the tenant. Returns 400 with OTP_LOCKOUT_ACTIVE if the (tenant,
 * phone, registration) tuple is currently in cooldown lockout.
 */
export async function registrationStartHandler(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<unknown> {
  const ctx = requireTenantContext(req);
  const body = (req.body ?? {}) as RegistrationStartBody;

  if (!isString(body.phone_e164)) {
    return reply
      .code(400)
      .send(makeErrorEnvelope(req.id, 'internal.request.invalid', 'phone_e164 is required.'));
  }

  const phone = body.phone_e164;

  return withIdempotentExecution<unknown>(
    req,
    reply,
    mapServiceError,
    async (tx: DbTransaction) => {
      // Phone collision check — service-layer + DB UNIQUE both catch this,
      // but checking up-front gives a cleaner error envelope. Run inside
      // the same tx as the OTP issue so a concurrent registration that
      // commits between this read and the issue still yields the correct
      // PHONE_TAKEN response on the second caller (UNIQUE will throw if
      // they race).
      const existing = await accountService.findAccountByPhoneE164(ctx, phone, tx);
      if (existing !== null) {
        return {
          status: 400,
          view: makeErrorEnvelope(req.id, PHONE_TAKEN, 'Phone number is already registered.'),
        };
      }

      // Issue OTP. issueOtp throws OTP_LOCKOUT_ACTIVE on cooldown — the
      // mapServiceError closure (passed to withIdempotentExecution) maps
      // that to the 400 envelope.
      const { otp } = await otpService.issueOtp(
        ctx,
        { actorId: 'system' },
        {
          otp_id: asOtpId(ulid()),
          account_id: null, // registration: no account yet
          phone_e164: phone,
          purpose: 'registration',
        },
        tx,
      );
      return { status: 200, view: { otp_id: otp.otp_id } };
    },
  );
}

// ---------------------------------------------------------------------------
// POST /registration/verify
// ---------------------------------------------------------------------------

/**
 * Verify the registration OTP and create + activate the account in one
 * transaction. The OTP and the account row + audit emissions ALL share
 * the same transaction, so a failure anywhere rolls back atomically per
 * I-016 (same-tx outbox / audit discipline).
 *
 * Idempotency caveat: per IDEMPOTENCY v5.1, retrying with the same key +
 * same body replays the cached PatientAccountView. Retrying with same
 * key + different body returns 409 body_mismatch (correct: a second
 * caller using the same Idempotency-Key with a different OTP code or
 * profile field is a categorically different request — the client
 * should regenerate the key to retry).
 */
export async function registrationVerifyHandler(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<unknown> {
  const ctx = requireTenantContext(req);
  const body = (req.body ?? {}) as RegistrationVerifyBody;

  // Validate required fields up front
  if (
    !isString(body.code) ||
    !isString(body.phone_e164) ||
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
          'Missing required field(s) on registration verify.',
        ),
      );
  }

  const phone = body.phone_e164;
  const code = body.code;
  const firstName = body.first_name;
  const lastName = body.last_name;
  const dateOfBirth = body.date_of_birth;
  const gender = body.gender;

  return withIdempotentExecution<unknown>(
    req,
    reply,
    mapServiceError,
    async (tx: DbTransaction) => {
      // Step 1: verify OTP. On success, the OTP is consumed inside this tx.
      const verify = await otpService.verifyOtp(
        ctx,
        { actorId: 'system' },
        { phone_e164: phone, purpose: 'registration', code },
        tx,
      );
      if (!verify.ok) {
        // Map sentinel to envelope. Tenant-blind: don't leak whether the
        // challenge expired vs the code was wrong — the wire envelope
        // surfaces the sentinel code only.
        return {
          status: 400,
          view: makeErrorEnvelope(
            req.id,
            verify.errorCode ?? 'internal.request.invalid',
            'OTP verification failed.',
          ),
        };
      }

      // Step 2: create account in pending_verification, then activate.
      // Both INSERT + UPDATE + audit emissions are inside this tx; a
      // failure anywhere atomically rolls back the OTP consumption too.
      const accountId = asAccountId(ulid());

      // SI-006 PR-F3 r3 (Codex review fix 2026-05-07): catch the
      // SQLSTATE 23505 (uq_account_tenant_phone unique violation) that
      // surfaces when two registration verifies race with the same phone.
      // Return a cached PHONE_TAKEN 400 so retries replay the
      // deterministic envelope instead of re-running the conflict-prone
      // INSERT.
      //
      // SAVEPOINT discipline (Codex r2-review HIGH closure 2026-05-07):
      // a failed INSERT puts the surrounding Postgres transaction into
      // the aborted state — every subsequent statement except
      // ROLLBACK / SAVEPOINT / RELEASE fails with "current transaction is
      // aborted". Without containment, withIdempotency's downstream
      // UPDATE-to-completed would fail too, surfacing the original 500
      // and never caching the PHONE_TAKEN envelope.
      //
      // Wrap createAccount in `SAVEPOINT phone_take_check` … on 23505,
      // ROLLBACK TO SAVEPOINT (which clears the aborted state and leaves
      // the outer tx healthy for the idempotency UPDATE); on success,
      // RELEASE the savepoint and proceed. Other 23505 collisions
      // (account_id PK) re-throw to bubble through the standard error
      // path.
      await tx.query('SAVEPOINT phone_take_check');
      let created: Account;
      try {
        created = await accountService.createAccount(
          ctx,
          { actorId: 'system' },
          {
            account_id: accountId,
            phone_e164: phone,
            first_name: firstName,
            last_name: lastName,
            date_of_birth: dateOfBirth,
            gender,
            ...(body.email !== undefined ? { email: body.email } : {}),
            ...(body.national_id !== undefined ? { national_id: body.national_id } : {}),
            ...(body.country_of_residence !== undefined
              ? { country_of_residence: body.country_of_residence }
              : {}),
          },
          tx,
        );
        await tx.query('RELEASE SAVEPOINT phone_take_check');
      } catch (err) {
        // pg DatabaseError exposes `.code` for the SQLSTATE; check for
        // 23505 AND the constraint name to ensure we only swallow the
        // phone-uniqueness collision.
        if (
          err !== null &&
          typeof err === 'object' &&
          'code' in err &&
          (err as { code?: unknown }).code === '23505' &&
          'constraint' in err &&
          (err as { constraint?: unknown }).constraint === 'uq_account_tenant_phone'
        ) {
          // ROLLBACK TO SAVEPOINT clears the aborted state from the
          // failed INSERT and restores the outer tx for the
          // withIdempotency UPDATE-to-completed.
          await tx.query('ROLLBACK TO SAVEPOINT phone_take_check');
          await tx.query('RELEASE SAVEPOINT phone_take_check');
          return {
            status: 400,
            view: makeErrorEnvelope(req.id, PHONE_TAKEN, 'Phone number is already registered.'),
          };
        }
        // Any other failure: roll back the savepoint anyway (so the
        // caller's tx isn't poisoned) and re-throw.
        await tx.query('ROLLBACK TO SAVEPOINT phone_take_check');
        await tx.query('RELEASE SAVEPOINT phone_take_check');
        throw err;
      }

      const activated = await accountService.activateAccount(
        ctx,
        { actorId: 'system' },
        created.account_id,
        tx,
      );

      // activated should be non-null since we just created the account in
      // pending_verification and immediately flipped it; defensive
      // fallback to the created row preserves wire shape if the repo's
      // race-condition guard ever returns null.
      const finalAccount = activated ?? created;

      return { status: 201, view: accountService.toPatientAccountView(finalAccount) };
    },
  );
}
