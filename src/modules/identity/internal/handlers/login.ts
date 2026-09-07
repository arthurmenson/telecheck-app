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
 *     - Return { account: PatientAccountView, refresh_token, session_id,
 *       access_token }
 *
 *   POST /sessions/refresh
 *     Body: { refresh_token }
 *     - Rotate the current patient/delegate credential and issue a new JWT.
 *     - Require an exact-key retry; replay is limited to the current live
 *       rotation within the private 900-second credential cache.
 *
 *   POST /sessions/logout
 *     Body: { refresh_token, refresh_idempotency_key? }
 *     - Resolve session by refresh-token plaintext
 *     - Revoke with reason='patient_logout'
 *     - Return 204 (idempotent: phantom token also returns 204 to
 *       prevent enumeration)
 *
 * Spec references:
 *   - Identity & Authentication Spec v1.0 §3 (login + session lifecycle)
 *   - I-003 (audit append-only — every state change emits audit)
 *   - I-025 (tenant-blind error envelope; no account-existence leak)
 *   - SI-006 reserve-then-execute idempotency (state-changing handlers
 *     migrated to withIdempotentExecution; see src/lib/idempotent-handler.ts).
 *
 * Security note (login/verify): the response cached by withIdempotency
 * INCLUDES the refresh_token plaintext + access_token. This is the
 * documented retry semantic — same Idempotency-Key + same body replays
 * the same tokens (a network-blip retry must not double-issue sessions).
 * The cache row lives in the `idempotency_keys` table under FORCE RLS;
 * cross-tenant replay is blocked. Same-tenant cross-actor replay is
 * blocked by the cache PK (which includes actor_id; pre-auth flows
 * bucket as 'anonymous'). Token TTL bounds exposure to the standard 30-
 * day session lifetime per Identity Spec §3.3. Flagged for security
 * review at SI-006 PR-D2 — see MIGRATION_REPORT.md.
 */

import type { FastifyReply, FastifyRequest } from 'fastify';

import { config } from '../../../../lib/config.js';
import type { DbTransaction } from '../../../../lib/db.js';
import { getSmsSender } from '../../../../lib/sms/index.js';
import type { OtpPurpose } from '../../../../lib/sms/index.js';
import { requireTenantContext } from '../../../../lib/tenant-context.js';
import { ulid } from '../../../../lib/ulid.js';
import { withIdempotentExecution } from '../database.js';
import * as accountService from '../services/account-service.js';
import * as otpService from '../services/otp-service.js';
import { patientRefreshKeySchema } from '../services/patient-refresh-contract.js';
import { logoutPatientSession } from '../services/patient-refresh-service.js';
import * as sessionService from '../services/session-service.js';
import { asOtpId, asSessionId } from '../types.js';

/**
 * Fire-and-forget OTP-SMS dispatch. Call AFTER withIdempotentExecution
 * resolves — the tx has committed (never text a rolled-back code) and, on an
 * idempotent replay, the body callback did not run so `code` was never set.
 * NOT awaited: provider latency must not skew response timing, and a provider
 * outage must not fail login/registration. The OTP is issued + persisted
 * regardless; delivery is best-effort. Mirrors the email dispatch helper.
 */
export function dispatchPasscodeSms(
  req: FastifyRequest,
  args: { to: string; code: string; purpose: OtpPurpose; consumerDba: string },
): void {
  void getSmsSender()
    .sendPasscode({
      to: args.to,
      code: args.code,
      purpose: args.purpose,
      consumerDba: args.consumerDba,
      ttlMinutes: otpService.OTP_TTL_MINUTES,
    })
    .catch((err: unknown) => {
      req.log.error(
        { err, event: 'passcode_sms_dispatch_failed', purpose: args.purpose },
        'passcode SMS dispatch failed',
      );
    });
}

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

interface SessionLogoutBody {
  refresh_token?: string;
  refresh_idempotency_key?: string;
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
 * Map service-layer auth-flow errors to HTTP envelopes. The OTP service
 * throws a sentinel Error with message=OTP_LOCKOUT_ACTIVE on cooldown.
 *
 * Per tenant-blind error discipline (I-025) we surface the sentinel code
 * but DO NOT include tenant-specific lockout windows in the message.
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
// POST /login/start
// ---------------------------------------------------------------------------

export async function loginStartHandler(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<unknown> {
  const ctx = requireTenantContext(req);
  const body = (req.body ?? {}) as LoginStartBody;

  if (!isString(body.phone_e164)) {
    return reply
      .code(400)
      .send(makeErrorEnvelope(req.id, 'internal.request.invalid', 'phone_e164 is required.'));
  }

  const phone = body.phone_e164;

  let issuedCode: string | null = null;
  const result = await withIdempotentExecution<unknown>(
    req,
    reply,
    mapServiceError,
    async (tx: DbTransaction) => {
      // Resolve account by phone in the caller's tenant (use the open tx
      // so the read sees any concurrent writes that committed prior).
      const account = await accountService.findAccountByPhoneE164(ctx, phone, tx);
      if (account === null) {
        // Tenant-blind: do NOT enumerate. Same generic envelope.
        return {
          status: 400,
          view: makeErrorEnvelope(
            req.id,
            NO_ACCOUNT,
            'Login could not proceed for this phone number.',
          ),
        };
      }

      if (account.account_type === 'clinician' && account.status === 'pending_verification') {
        return {
          status: 403,
          view: makeErrorEnvelope(
            req.id,
            'identity.staff.authentication_required',
            'Staff authentication setup is required.',
          ),
        };
      }
      if (account.status !== 'active' && account.status !== 'pending_verification') {
        return {
          status: 400,
          view: makeErrorEnvelope(
            req.id,
            ACCOUNT_INACTIVE,
            'Account is not active. Contact support.',
          ),
        };
      }

      // issueOtp throws OTP_LOCKOUT_ACTIVE on cooldown — mapServiceError
      // (passed to withIdempotentExecution) maps that to the 400 envelope.
      const { otp, codePlaintext } = await otpService.issueOtp(
        ctx,
        { actorId: 'system' },
        {
          otp_id: asOtpId(ulid()),
          account_id: account.account_id,
          phone_e164: phone,
          purpose: 'login',
        },
        tx,
      );
      issuedCode = codePlaintext;
      // Staging-only OTP echo (AUTH_DEV_OTP_ECHO; production fail-fast in
      // config.ts): a debugging affordance that coexists with real SMS
      // delivery. When SMS_PROVIDER=telnyx the code is also texted (below);
      // the echo is dropped once testers no longer need it.
      if (config.authDevOtpEcho) {
        return { status: 200, view: { otp_id: otp.otp_id, dev_otp: codePlaintext } };
      }
      return { status: 200, view: { otp_id: otp.otp_id } };
    },
  );
  if (issuedCode !== null) {
    dispatchPasscodeSms(req, {
      to: phone,
      code: issuedCode,
      purpose: 'login',
      consumerDba: ctx.consumerDba,
    });
  }
  return result;
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
    return reply
      .code(400)
      .send(
        makeErrorEnvelope(req.id, 'internal.request.invalid', 'phone_e164 and code are required.'),
      );
  }

  const phone = body.phone_e164;
  const code = body.code;

  return withIdempotentExecution<unknown>(
    req,
    reply,
    mapServiceError,
    async (tx: DbTransaction) => {
      // Resolve account
      const account = await accountService.findAccountByPhoneE164(ctx, phone, tx);
      if (account === null) {
        return {
          status: 400,
          view: makeErrorEnvelope(
            req.id,
            NO_ACCOUNT,
            'Login could not proceed for this phone number.',
          ),
        };
      }

      if (account.account_type === 'clinician' && account.status === 'pending_verification') {
        return {
          status: 403,
          view: makeErrorEnvelope(
            req.id,
            'identity.staff.authentication_required',
            'Staff authentication setup is required.',
          ),
        };
      }
      // Verify OTP (consume on success in same tx)
      const verify = await otpService.verifyOtp(
        ctx,
        { actorId: 'system' },
        { phone_e164: phone, purpose: 'login', code },
        tx,
      );
      if (!verify.ok) {
        return {
          status: 400,
          view: makeErrorEnvelope(
            req.id,
            verify.errorCode ?? 'internal.request.invalid',
            'OTP verification failed.',
          ),
        };
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

      return {
        status: 200,
        view: {
          account: accountService.toPatientAccountView(account),
          session: sessionService.toPatientSessionView(session),
          refresh_token: refreshTokenPlaintext,
          access_token: accessToken,
        },
      };
    },
  );
}

// ---------------------------------------------------------------------------
// POST /sessions/refresh
// ---------------------------------------------------------------------------

export { patientRefreshHandler as sessionRefreshHandler } from './patient-refresh.js';

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
    // Tenant-blind 204 (pre-validation): phantom / missing token gets
    // 204 to prevent enumeration. This path bypasses
    // withIdempotentExecution because there's no business action to
    // reserve — the request is rejected before any service call.
    return reply.code(204).send();
  }

  const refreshToken = body.refresh_token;
  if (
    body.refresh_idempotency_key !== undefined &&
    !patientRefreshKeySchema.safeParse(body.refresh_idempotency_key).success
  )
    return reply.code(204).send();

  return withIdempotentExecution<null>(
    req,
    reply,
    () => {
      void reply
        .code(503)
        .send(
          makeErrorEnvelope(
            req.id,
            'identity.authentication.unavailable',
            'Authentication is temporarily unavailable. Please try again.',
          ),
        );
      return true;
    },
    async (tx: DbTransaction) => {
      // Lookup session inside the tx so the revoke + audit + domain event
      // emissions are atomic with respect to it.
      //
      // findActiveSessionByRefreshToken accepts a DbClient — DbTransaction
      // is assignment-compatible — so we share our tx with it.
      //
      // Use the variant that returns null on phantom; reply 204 in that
      // case (tenant-blind).
      await logoutPatientSession(ctx, refreshToken, body.refresh_idempotency_key, tx);

      return { status: 204, view: null };
    },
  );
}
