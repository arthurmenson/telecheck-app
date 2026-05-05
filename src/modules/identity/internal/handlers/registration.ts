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
 */

import type { FastifyReply, FastifyRequest } from 'fastify';

import { withTenantBoundConnection } from '../../../../lib/db.js';
import { requireTenantContext } from '../../../../lib/tenant-context.js';
import { ulid } from '../../../../lib/ulid.js';
import * as accountService from '../services/account-service.js';
import * as otpService from '../services/otp-service.js';
import { asAccountId, asOtpId } from '../types.js';

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
    return reply.code(400).send({
      error: {
        code: 'internal.request.invalid',
        message: 'phone_e164 is required.',
        request_id: req.id,
      },
    });
  }

  // Phone collision check — service-layer + DB UNIQUE both catch this,
  // but checking up-front gives a cleaner error envelope.
  const existing = await accountService.findAccountByPhoneE164(ctx, body.phone_e164);
  if (existing !== null) {
    return reply.code(400).send({
      error: {
        code: PHONE_TAKEN,
        message: 'Phone number is already registered.',
        request_id: req.id,
      },
    });
  }

  // Issue OTP. issueOtp throws OTP_LOCKOUT_ACTIVE on cooldown.
  // Use withTenantBoundConnection so set_tenant_context() is called on
  // the connection BEFORE the INSERT — the otp_challenges RLS policy's
  // WITH CHECK clause requires current_tenant_id() to match the row's
  // tenant_id, which only works when the tenant context is bound.
  try {
    const phone = body.phone_e164;
    const { otp } = await withTenantBoundConnection(ctx.tenantId, (tx) =>
      otpService.issueOtp(
        ctx,
        { actorId: 'system' },
        {
          otp_id: asOtpId(ulid()),
          account_id: null, // registration: no account yet
          phone_e164: phone,
          purpose: 'registration',
        },
        tx,
      ),
    );
    return reply.code(200).send({ otp_id: otp.otp_id });
  } catch (err) {
    if (err instanceof Error && err.message === otpService.OTP_LOCKOUT_ACTIVE) {
      return reply.code(400).send({
        error: {
          code: otpService.OTP_LOCKOUT_ACTIVE,
          message: 'Too many recent attempts. Please wait before requesting a new code.',
          request_id: req.id,
        },
      });
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// POST /registration/verify
// ---------------------------------------------------------------------------

/**
 * Verify the registration OTP and create + activate the account in one
 * transaction. The OTP and the account row + audit emissions ALL share
 * the same transaction, so a failure anywhere rolls back atomically per
 * I-016 (same-tx outbox / audit discipline).
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
    return reply.code(400).send({
      error: {
        code: 'internal.request.invalid',
        message: 'Missing required field(s) on registration verify.',
        request_id: req.id,
      },
    });
  }

  const phone = body.phone_e164;
  const code = body.code;
  const firstName = body.first_name;
  const lastName = body.last_name;
  const dateOfBirth = body.date_of_birth;
  const gender = body.gender;

  return withTenantBoundConnection(ctx.tenantId, async (tx) => {
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
      return reply.code(400).send({
        error: {
          code: verify.errorCode ?? 'internal.request.invalid',
          message: 'OTP verification failed.',
          request_id: req.id,
        },
      });
    }

    // Step 2: create account in pending_verification, then activate.
    // Both INSERT + UPDATE + audit emissions are inside this tx; a
    // failure anywhere atomically rolls back the OTP consumption too.
    const accountId = asAccountId(ulid());
    const created = await accountService.createAccount(
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

    return reply.code(201).send(accountService.toPatientAccountView(finalAccount));
  });
}
