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
 *     - Resolve session by hash; if active+unexpired → return new
 *       PatientSessionView
 *     - Currently a NO-OP rotation (returns the existing session view).
 *       NOT migrated to the SI-006 idempotency helper at this commit
 *       because it is read-only at v1.0 — no state mutation, no audit.
 *       When real refresh-token rotation lands (new plaintext + hash +
 *       revoke previous), migrate this handler to withIdempotentExecution.
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

import type { DbTransaction } from '../../../../lib/db.js';
import { markIdempotencyManagedByHandler } from '../../../../lib/idempotency.js';
import { withIdempotentExecution } from '../../../../lib/idempotent-handler.js';
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
  // SI-006 reserve-then-execute: mark at the TOP so the legacy onSend
  // hook never writes a cache row regardless of which path we take
  // (validation 400, NO_ACCOUNT 400, ACCOUNT_INACTIVE 400, lockout 400,
  // success 200). withIdempotentExecution owns the cache write for
  // every path that returns a value from body().
  markIdempotencyManagedByHandler(req);

  const ctx = requireTenantContext(req);
  const body = (req.body ?? {}) as LoginStartBody;

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
      const { otp } = await otpService.issueOtp(
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
      return { status: 200, view: { otp_id: otp.otp_id } };
    },
  );
}

// ---------------------------------------------------------------------------
// POST /login/verify
// ---------------------------------------------------------------------------

export async function loginVerifyHandler(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<unknown> {
  // SI-006 reserve-then-execute: mark at the TOP. See loginStartHandler.
  markIdempotencyManagedByHandler(req);

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

/**
 * NOT migrated to withIdempotentExecution at this commit — the v1.0
 * implementation is a pure read (no state mutation, no audit emission;
 * "no-op rotation" returns the existing session view). Migrating a
 * read-only path provides no transactional benefit and is a small risk
 * (the cached response includes session metadata; replaying it at all
 * is wrong if the session state changes between requests).
 *
 * When real refresh-token rotation lands (issue new plaintext + hash;
 * revoke previous; emit identity_session_rotated audit), migrate this
 * handler to the same pattern as loginVerifyHandler. Until then, the
 * legacy onSend cache write applies — and is acceptable because the
 * response is invariant for the same refresh_token (it's a read).
 */
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
  // SI-006 reserve-then-execute: mark at the TOP. Phantom-token branch
  // also returns from inside the helper so the cache row is written for
  // every code path that produces a 204.
  markIdempotencyManagedByHandler(req);

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

  return withIdempotentExecution<null>(
    req,
    reply,
    () => false,
    async (tx: DbTransaction) => {
      // Lookup session inside the tx so the revoke + audit + domain event
      // emissions are atomic with respect to it.
      //
      // findActiveSessionByRefreshToken accepts a DbClient — DbTransaction
      // is assignment-compatible — so we share our tx with it.
      //
      // Use the variant that returns null on phantom; reply 204 in that
      // case (tenant-blind).
      const session = await sessionService.findActiveSessionByRefreshToken(ctx, refreshToken, tx);
      if (session === null) {
        return { status: 204, view: null };
      }

      await sessionService.revokeSession(
        ctx,
        { actorId: 'system' },
        session.session_id,
        'patient_logout',
        tx,
      );

      return { status: 204, view: null };
    },
  );
}
