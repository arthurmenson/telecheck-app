/**
 * session-service.ts — Session lifecycle orchestration with audit emission.
 *
 * Wraps session-repo with same-transaction audit emission. Service layer
 * also handles refresh-token hashing (callers pass the plaintext opaque
 * value; this module hashes before INSERT).
 *
 * Spec references:
 *   - Identity & Authentication Spec v1.0 §3.2 (session management)
 *   - Identity Spec v1.0 §3.4 (multi-device max 3)
 *   - I-003 (audit append-only)
 */

import crypto from 'node:crypto';

import { config } from '../../../../lib/config.js';
import type { DbClient, DbTransaction } from '../../../../lib/db.js';
import { type AccessTokenRole, issueAccessToken } from '../../../../lib/jwt.js';
import type { TenantContext } from '../../../../lib/tenant-context.js';
import { emitSessionIssuedAudit, emitSessionRevokedAudit } from '../../audit.js';
import { emitSessionIssuedDomainEvent, emitSessionRevokedDomainEvent } from '../../events.js';
import * as accountRepo from '../repositories/account-repo.js';
import * as sessionRepo from '../repositories/session-repo.js';
import type {
  AccountId,
  AccountType,
  DeviceId,
  Session,
  SessionId,
  SessionRevocationReason,
} from '../types.js';

// ---------------------------------------------------------------------------
// account_type → session role mapping (TLC-058 / 2026-05-13; Phase 2 admin
// widening 2026-05-15 closes F-1 deferred follow-on)
//
// Centralizes the single source of truth for "what role does this account
// log in as?". `issueSession` calls this with the resolved account_type
// when issuing the JWT — no caller passes a role directly, so a future
// account_type addition only needs to update this map.
//
// Mapping rationale (per RBAC v1.1):
//   - 'patient'        → 'patient' session
//   - 'clinician'      → 'clinician' session
//   - 'delegate'       → 'patient' session (delegates use the patient
//                        session role; the delegate_id claim distinguishes
//                        them. The delegate's PRIMARY surface authority is
//                        still the patient's account they're acting on
//                        behalf of.)
//   - 'tenant_admin'   → 'tenant_admin' session (Phase 2 R3 closure: the
//                        admin_tenant_binding claim is the admin's home
//                        tenant, supplied by issueSession from ctx.tenantId
//                        at issue time)
//   - 'platform_admin' → 'platform_admin' session (Phase 2 R3 closure:
//                        admin_tenant_binding is NULL; global scope; the
//                        JWT tenant_id claim carries the admin's home
//                        tenant for audit attribution)
//
// When the pharmacist / operator / research-data-steward roles land,
// both this map and the AccessTokenRole enum need to widen in the
// same PR.
// ---------------------------------------------------------------------------

function sessionRoleForAccountType(accountType: AccountType): AccessTokenRole {
  switch (accountType) {
    case 'patient':
      return 'patient';
    case 'clinician':
      return 'clinician';
    case 'delegate':
      return 'patient';
    case 'tenant_admin':
      return 'tenant_admin';
    case 'platform_admin':
      return 'platform_admin';
  }
}

/**
 * For a given AccountType, resolve the admin_tenant_binding JWT claim.
 *
 * Phase 2 R3 closure: tenant_admin binding = the admin's home tenant
 * (= ctx.tenantId at session-issuance time). platform_admin binding
 * is NULL (global scope). Non-admin roles have no binding.
 *
 * The home-tenant model means a tenant_admin can only administer their
 * own home tenant. If a future ADR introduces cross-tenant administrative
 * assignments (e.g., a single tenant_admin row scoped to a DIFFERENT
 * tenant), this function needs to consult a new accounts.admin_tenant_binding
 * column.
 */
function adminTenantBindingForAccountType(
  accountType: AccountType,
  homeTenantId: string,
): string | null {
  switch (accountType) {
    case 'tenant_admin':
      return homeTenantId;
    case 'platform_admin':
    case 'patient':
    case 'clinician':
    case 'delegate':
      return null;
  }
}

// ---------------------------------------------------------------------------
// Refresh-token discipline
// ---------------------------------------------------------------------------

/**
 * Generate a cryptographically random opaque refresh token. Returns the
 * plaintext string (returned to client ONCE at issuance) and its SHA-256
 * hex hash (stored server-side). The plaintext MUST never be logged or
 * persisted; only the hash lives in the sessions row.
 */
export function generateRefreshToken(): { plaintext: string; hash: string } {
  const plaintext = crypto.randomBytes(32).toString('base64url');
  const hash = crypto.createHash('sha256').update(plaintext).digest('hex');
  return { plaintext, hash };
}

/** Hash an opaque refresh-token plaintext into the canonical SHA-256 hex form. */
export function hashRefreshToken(plaintext: string): string {
  return crypto.createHash('sha256').update(plaintext).digest('hex');
}

// ---------------------------------------------------------------------------
// Patient-safe session view (strips tenant_id)
// ---------------------------------------------------------------------------

export type PatientSessionView = Omit<Session, 'tenant_id'>;

export function toPatientSessionView(session: Session): PatientSessionView {
  const { tenant_id: _stripped, ...patientView } = session;
  void _stripped;
  return patientView;
}

// ---------------------------------------------------------------------------
// IssueSessionInput
// ---------------------------------------------------------------------------

export interface IssueSessionInput {
  session_id: SessionId;
  account_id: AccountId;
  device_id?: DeviceId | null;
  ip_address?: string | null;
  user_agent?: string | null;
}

/**
 * Per Identity Spec §3.2: refresh-token TTL is 30 days from issuance.
 * Service-layer constant — when a tenant-config knob lands for this,
 * change here.
 */
const REFRESH_TOKEN_TTL_DAYS = 30;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// issueSession
// ---------------------------------------------------------------------------

/**
 * Issue a new session for an account. Generates a fresh refresh token,
 * hashes it, persists the session row with same-transaction audit
 * emission, and returns:
 *   - the persisted Session
 *   - the plaintext refresh token (returned to client ONCE; never
 *     persisted server-side beyond the SHA-256 hash)
 *   - a fresh JWT access token (15-min TTL per Identity Spec §3.2;
 *     stateless verification via verifyAccessToken)
 *
 * The access token's session_id claim binds it to the persisted
 * session row, so the auth hook can verify session liveness against
 * the DB on every request (revocation propagates immediately).
 */
export async function issueSession(
  ctx: TenantContext,
  actor: { actorId: string },
  input: IssueSessionInput,
  externalTx?: DbTransaction,
): Promise<{
  session: Session;
  refreshTokenPlaintext: string;
  accessToken: string;
}> {
  const { plaintext, hash } = generateRefreshToken();
  const expiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_DAYS * MS_PER_DAY).toISOString();

  const repoInput: sessionRepo.CreateSessionInput = {
    session_id: input.session_id,
    tenant_id: ctx.tenantId,
    account_id: input.account_id,
    refresh_token_hash: hash,
    expires_at: expiresAt,
  };
  if (input.device_id !== undefined) repoInput.device_id = input.device_id;
  if (input.ip_address !== undefined) repoInput.ip_address = input.ip_address;
  if (input.user_agent !== undefined) repoInput.user_agent = input.user_agent;

  let resolvedRole: AccessTokenRole | null = null;
  let resolvedAdminTenantBinding: string | null = null;
  const session = await sessionRepo.createSession(
    repoInput,
    async (tx, persisted) => {
      // Resolve the role for this session from the persisted account's
      // account_type. Lookup happens INSIDE the same transaction as the
      // sessions INSERT so the role is consistent with the account at
      // session-issuance time (TLC-058 / 2026-05-13; Phase 2 admin
      // widening 2026-05-15 closes F-1). The account MUST exist (it was
      // just referenced by the sessions FK), but null-guard defensively
      // so a missing row throws a typed error rather than producing a
      // malformed JWT later.
      const account = await accountRepo.findAccountById(ctx.tenantId, persisted.account_id, tx);
      if (account === null) {
        throw new Error(
          `issueSession: account ${String(persisted.account_id)} not found in tenant ` +
            `${String(ctx.tenantId)} immediately after session INSERT — FK constraint ` +
            'would have failed earlier. This is a programming error; investigate.',
        );
      }
      resolvedRole = sessionRoleForAccountType(account.account_type);
      resolvedAdminTenantBinding = adminTenantBindingForAccountType(
        account.account_type,
        ctx.tenantId,
      );

      await emitSessionIssuedAudit(
        {
          tenantId: ctx.tenantId,
          accountId: persisted.account_id,
          sessionId: persisted.session_id,
          actorId: actor.actorId,
          countryOfCare: ctx.countryOfCare,
          deviceId: persisted.device_id,
          ipAddress: persisted.ip_address,
        },
        tx,
      );
      await emitSessionIssuedDomainEvent(tx, {
        tenantId: ctx.tenantId,
        accountId: persisted.account_id,
        sessionId: persisted.session_id,
        occurredAt: persisted.created_at,
      });
    },
    externalTx,
  );

  if (resolvedRole === null) {
    // Defensive: the txCallback always sets resolvedRole, but a future
    // refactor could regress this contract; fail loud rather than mint
    // a malformed JWT.
    throw new Error(
      'issueSession: resolvedRole was not set after createSession completed. ' +
        'This is a programming error; the txCallback must populate resolvedRole.',
    );
  }

  // Issue the JWT access token using the persisted session_id + the
  // role resolved from accounts.account_type. The signing key is
  // platform-wide (production fail-closed gated in config.ts) — same
  // key signs across all tenants; tenant_id is a claim INSIDE the JWT,
  // not part of the signing input.
  //
  // Phase 2 admin widening (2026-05-15; F-1 closure): for tenant_admin
  // accounts, admin_tenant_binding is the home tenant (ctx.tenantId).
  // For platform_admin, admin_tenant_binding is null (global scope; the
  // JWT's tenant_id claim is the admin's home tenant for audit
  // attribution per Phase 2 R3 closure). For non-admin roles,
  // admin_tenant_binding is null. issueAccessToken enforces the
  // role/binding consistency rules and throws on mismatch.
  const accessToken = issueAccessToken(
    {
      account_id: session.account_id,
      tenant_id: session.tenant_id,
      session_id: session.session_id,
      role: resolvedRole,
      country_of_care: ctx.countryOfCare,
      ...(resolvedAdminTenantBinding !== null
        ? { admin_tenant_binding: resolvedAdminTenantBinding }
        : {}),
    },
    config.jwtSigningKey,
  );

  return { session, refreshTokenPlaintext: plaintext, accessToken };
}

// ---------------------------------------------------------------------------
// revokeSession
// ---------------------------------------------------------------------------

/**
 * Revoke an active session. Idempotent: returns null on already-revoked
 * (the repo's WHERE filter excludes non-active rows).
 *
 * Audit emission ONLY fires on successful flip. No spurious "revoked"
 * audit on already-revoked re-call.
 */
export async function revokeSession(
  ctx: TenantContext,
  actor: { actorId: string },
  sessionId: SessionId,
  reason: SessionRevocationReason,
  externalTx?: DbTransaction,
): Promise<Session | null> {
  if (externalTx === undefined) {
    const { withTenantBoundConnection } = await import('../../../../lib/db.js');
    return withTenantBoundConnection(ctx.tenantId, async (tx) => {
      const revoked = await sessionRepo.revokeSession(ctx.tenantId, sessionId, reason, tx);
      if (revoked === null) return null;
      await emitSessionRevokedAudit(
        {
          tenantId: ctx.tenantId,
          accountId: revoked.account_id,
          sessionId: revoked.session_id,
          actorId: actor.actorId,
          countryOfCare: ctx.countryOfCare,
          reason,
        },
        tx,
      );
      await emitSessionRevokedDomainEvent(tx, {
        tenantId: ctx.tenantId,
        accountId: revoked.account_id,
        sessionId: revoked.session_id,
        revokedReason: reason,
        occurredAt: revoked.revoked_at ?? revoked.created_at,
      });
      return revoked;
    });
  }

  const revoked = await sessionRepo.revokeSession(ctx.tenantId, sessionId, reason, externalTx);
  if (revoked === null) return null;
  await emitSessionRevokedAudit(
    {
      tenantId: ctx.tenantId,
      accountId: revoked.account_id,
      sessionId: revoked.session_id,
      actorId: actor.actorId,
      countryOfCare: ctx.countryOfCare,
      reason,
    },
    externalTx,
  );
  await emitSessionRevokedDomainEvent(externalTx, {
    tenantId: ctx.tenantId,
    accountId: revoked.account_id,
    sessionId: revoked.session_id,
    revokedReason: reason,
    occurredAt: revoked.revoked_at ?? revoked.created_at,
  });
  return revoked;
}

// ---------------------------------------------------------------------------
// Read paths — pure delegates (no audit on reads)
// ---------------------------------------------------------------------------

export async function findSessionById(
  ctx: TenantContext,
  sessionId: SessionId,
  externalTx?: DbClient,
): Promise<Session | null> {
  return sessionRepo.findSessionById(ctx.tenantId, sessionId, externalTx);
}

/**
 * Active-only variant of findSessionById — returns null if the session is
 * revoked or expired. Used by PHI-handling route handlers to enforce
 * session liveness on every request, defending against revoked-session-id
 * tokens that still pass JWT signature/expiry. Codex PR-116 R1 HIGH
 * closure: the auth hook is JWT-stateless by design so PHI handlers
 * opt-in to liveness via this helper.
 */
export async function findActiveSessionById(
  ctx: TenantContext,
  sessionId: SessionId,
  externalTx?: DbClient,
): Promise<Session | null> {
  return sessionRepo.findActiveSessionById(ctx.tenantId, sessionId, externalTx);
}

/**
 * Find an active session by refresh-token PLAINTEXT (the service layer
 * hashes here so callers pass the wire-shape value). Returns null on
 * miss / revoked / expired.
 */
export async function findActiveSessionByRefreshToken(
  ctx: TenantContext,
  refreshTokenPlaintext: string,
  externalTx?: DbClient,
): Promise<Session | null> {
  const hash = hashRefreshToken(refreshTokenPlaintext);
  return sessionRepo.findActiveSessionByRefreshHash(ctx.tenantId, hash, externalTx);
}

export async function listActiveSessionsForAccount(
  ctx: TenantContext,
  accountId: AccountId,
  externalTx?: DbClient,
): Promise<Session[]> {
  return sessionRepo.listActiveSessionsForAccount(ctx.tenantId, accountId, externalTx);
}
