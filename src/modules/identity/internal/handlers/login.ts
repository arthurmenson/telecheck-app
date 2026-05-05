/**
 * login.ts — POST /v0/identity/login/{start,verify} handlers + session
 * refresh / revoke endpoints.
 *
 * Implements Identity & Authentication Spec v1.0 §3 patient login flow:
 *
 *   POST /login/start
 *     Body: { phone_e164 }
 *     - Look up account by tenant-scoped phone (CDM §5.1)
 *     - Account not found → 400 with NO_ACCOUNT (tenant-blind: same
 *       envelope shape as PHONE_TAKEN to prevent enumeration)
 *     - Account suspended/archived → 400 with ACCOUNT_INACTIVE
 *     - Issue 6-digit OTP with purpose='login', account_id=<resolved>
 *     - Return { otp_id }
 *
 *   POST /login/verify
 *     Body: { phone_e164, code }
 *     - Verify OTP (consumes on success)
 *     - On success: issue a fresh session (refresh-token plaintext +
 *       hash; 30-day TTL); emit identity_session_issued audit
 *     - Return { account: PatientAccountView, refresh_token, session_id }
 *
 *   POST /sessions/refresh
 *     Body: { refresh_token }
 *     - Resolve session by hash; if active+unexpired → return new
 *       PatientSessionView
 *     - Currently a NO-OP rotation (returns the existing session view).
 *       True refresh-token rotation (new plaintext + hash + revoke
 *       previous) lands in a follow-up commit.
 *
 *   POST /sessions/logout
 *     Body: { refresh_token }
 *     - Resolve session by refresh-token plaintext
 *     - Revoke with reason='patient_logout'
 *     - Return 204 (idempotent: phantom token also returns 204 to
 *       prevent enumeration)
 *
 * Spec references:
 *   - Identity & Authentication Spec v1.0 §3 (login + session lifecycle)
 *   - I-003 (audit append-only — every state change emits audit)
 *   - I-025 (tenant-blind error envelope; no account-existence leak)
 */

import type { FastifyReply, FastifyRequest } from 'fastify';

import { withTenantBoundConnection } from '../../../../lib/db.js';
import { requireTenantContext } from '../../../../lib/tenant-context.js';
import { ulid } from '../../../../lib/ulid.js';
import * as accountService from '../services/account-service.js';
import * as otpService from '../services/otp-service.js';
import * as sessionService from '../services/session-service.js';
import { asOtpId, asSessionId } from '../types.js';

// ---------------------------------------------------------------------------
// Sentinel error codes
// ---------------------------------------------------------------------------

const NO_ACCOUNT = 'identity.login.no_account';
const ACCOUNT_INACTIVE = 'identity.login.account_inactive';

// ---------------------------------------------------------------------------
// Body shapes
// ---------------------------------------------------------------------------

interface LoginStartBody {
  phone_e164?: string;
}

interface LoginVerifyBody {
  phone_e164?: string;
  code?: string;
}

interface SessionRefreshBody {
  refresh_token?: string;
}

interface SessionLogoutBody {
  refresh_token?: string;
}

function isString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}

// ---------------------------------------------------------------------------
// POST /login/start
// ---------------------------------------------------------------------------

export async function loginStartHandler(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<unknown> {
  const ctx = requireTenantContext(req);
  const body = (req.body ?? {}) as LoginStartBody;

  if (!isString(body.phone_e164)) {
    return reply.code(400).send({
      error: {
        code: 'internal.request.invalid',
        message: 'phone_e164 is required.',
        request_id: req.id,
      },
    });
  }

  const phone = body.phone_e164;

  // Resolve account by phone in the caller's tenant
  const account = await accountService.findAccountByPhoneE164(ctx, phone);
  if (account === null) {
    // Tenant-blind: do NOT enumerate. Same generic envelope.
    return reply.code(400).send({
      error: {
        code: NO_ACCOUNT,
        message: 'Login could not proceed for this phone number.',
        request_id: req.id,
      },
    });
  }

  if (account.status !== 'active' && account.status !== 'pending_verification') {
    return reply.code(400).send({
      error: {
        code: ACCOUNT_INACTIVE,
        message: 'Account is not active. Contact support.',
        request_id: req.id,
      },
    });
  }

  try {
    const { otp } = await withTenantBoundConnection(ctx.tenantId, (tx) =>
      otpService.issueOtp(
        ctx,
        { actorId: 'system' },
        {
          otp_id: asOtpId(ulid()),
          account_id: account.account_id,
          phone_e164: phone,
          purpose: 'login',
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
// POST /login/verify
// ---------------------------------------------------------------------------

export async function loginVerifyHandler(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<unknown> {
  const ctx = requireTenantContext(req);
  const body = (req.body ?? {}) as LoginVerifyBody;

  if (!isString(body.phone_e164) || !isString(body.code)) {
    return reply.code(400).send({
      error: {
        code: 'internal.request.invalid',
        message: 'phone_e164 and code are required.',
        request_id: req.id,
      },
    });
  }

  const phone = body.phone_e164;
  const code = body.code;

  return withTenantBoundConnection(ctx.tenantId, async (tx) => {
    // Resolve account
    const account = await accountService.findAccountByPhoneE164(ctx, phone, tx);
    if (account === null) {
      return reply.code(400).send({
        error: {
          code: NO_ACCOUNT,
          message: 'Login could not proceed for this phone number.',
          request_id: req.id,
        },
      });
    }

    // Verify OTP (consume on success in same tx)
    const verify = await otpService.verifyOtp(
      ctx,
      { actorId: 'system' },
      { phone_e164: phone, purpose: 'login', code },
      tx,
    );
    if (!verify.ok) {
      return reply.code(400).send({
        error: {
          code: verify.errorCode ?? 'internal.request.invalid',
          message: 'OTP verification failed.',
          request_id: req.id,
        },
      });
    }

    // Issue session in the same tx
    const sessionId = asSessionId(ulid());
    const xff = req.headers['x-forwarded-for'];
    const ipAddress = typeof xff === 'string' ? xff : null;
    const ua = req.headers['user-agent'];
    const userAgent = typeof ua === 'string' ? ua : null;

    const { session, refreshTokenPlaintext, accessToken } = await sessionService.issueSession(
      ctx,
      { actorId: 'system' },
      {
        session_id: sessionId,
        account_id: account.account_id,
        ip_address: ipAddress,
        user_agent: userAgent,
      },
      tx,
    );

    return reply.code(200).send({
      account: accountService.toPatientAccountView(account),
      session: sessionService.toPatientSessionView(session),
      refresh_token: refreshTokenPlaintext,
      access_token: accessToken,
    });
  });
}

// ---------------------------------------------------------------------------
// POST /sessions/refresh
// ---------------------------------------------------------------------------

export async function sessionRefreshHandler(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<unknown> {
  const ctx = requireTenantContext(req);
  const body = (req.body ?? {}) as SessionRefreshBody;

  if (!isString(body.refresh_token)) {
    return reply.code(400).send({
      error: {
        code: 'internal.request.invalid',
        message: 'refresh_token is required.',
        request_id: req.id,
      },
    });
  }

  const session = await sessionService.findActiveSessionByRefreshToken(ctx, body.refresh_token);
  if (session === null) {
    return reply.code(400).send({
      error: {
        code: 'identity.session.invalid_or_expired',
        message: 'Refresh token is invalid or expired.',
        request_id: req.id,
      },
    });
  }

  // No-op rotation at v1.0 — return the existing session view. True
  // refresh-token rotation (new plaintext + hash + revoke previous)
  // lands in a follow-up commit.
  return reply.code(200).send({
    session: sessionService.toPatientSessionView(session),
  });
}

// ---------------------------------------------------------------------------
// POST /sessions/logout
// ---------------------------------------------------------------------------

export async function sessionLogoutHandler(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<unknown> {
  const ctx = requireTenantContext(req);
  const body = (req.body ?? {}) as SessionLogoutBody;

  if (!isString(body.refresh_token)) {
    // Tenant-blind 204: phantom token also gets 204 to prevent
    // enumeration (caller cannot distinguish "your token was already
    // invalid" from "logged out successfully").
    return reply.code(204).send();
  }

  const session = await sessionService.findActiveSessionByRefreshToken(ctx, body.refresh_token);
  if (session === null) {
    return reply.code(204).send();
  }

  await sessionService.revokeSession(
    ctx,
    { actorId: 'system' },
    session.session_id,
    'patient_logout',
  );

  return reply.code(204).send();
}
