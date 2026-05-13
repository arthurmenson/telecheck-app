/**
 * session-repo.ts — DB access for the `sessions` table (migration 013).
 *
 * Repository pattern (mirror of account-repo.ts):
 *   - Pure DB access; no domain logic
 *   - Returns null on tenant-blind miss
 *   - All SELECTs filter by tenant_id explicitly (defense in depth alongside RLS)
 *
 * Spec references:
 *   - migrations/013_sessions.sql
 *   - CDM v1.2 §3.2 entity 8 "Session"
 *   - Identity & Authentication Spec v1.0 §3.2 (session management)
 *   - I-023 (RLS + tenant filter)
 *   - I-025 (tenant-blind null on miss)
 */

import type { DbClient, DbTransaction } from '../../../../lib/db.js';
import { withTenantBoundConnection } from '../../../../lib/db.js';
import type { TenantId } from '../../../../lib/glossary.js';
import type { AccountId, DeviceId, Session, SessionId, SessionRevocationReason } from '../types.js';

// ---------------------------------------------------------------------------
// Row mapping
// ---------------------------------------------------------------------------

interface SessionRow {
  session_id: string;
  tenant_id: string;
  account_id: string;
  refresh_token_hash: string;
  device_id: string | null;
  ip_address: string | null;
  user_agent: string | null;
  created_at: Date | string;
  last_active_at: Date | string;
  expires_at: Date | string;
  revoked_at: Date | string | null;
  revoked_reason: string | null;
}

function tsToIso(v: Date | string): string {
  return typeof v === 'string' ? v : v.toISOString();
}

function tsToIsoNullable(v: Date | string | null): string | null {
  if (v === null) return null;
  return tsToIso(v);
}

function rowToSession(row: SessionRow): Session {
  return {
    session_id: row.session_id as SessionId,
    tenant_id: row.tenant_id as TenantId,
    account_id: row.account_id as AccountId,
    refresh_token_hash: row.refresh_token_hash,
    device_id: row.device_id === null ? null : (row.device_id as DeviceId),
    ip_address: row.ip_address,
    user_agent: row.user_agent,
    created_at: tsToIso(row.created_at),
    last_active_at: tsToIso(row.last_active_at),
    expires_at: tsToIso(row.expires_at),
    revoked_at: tsToIsoNullable(row.revoked_at),
    revoked_reason: row.revoked_reason as SessionRevocationReason | null,
  };
}

const SESSION_COLUMNS = `
  session_id, tenant_id, account_id, refresh_token_hash,
  device_id, ip_address, user_agent,
  created_at, last_active_at, expires_at,
  revoked_at, revoked_reason
`;

// ---------------------------------------------------------------------------
// CreateSessionInput
// ---------------------------------------------------------------------------

export interface CreateSessionInput {
  session_id: SessionId;
  tenant_id: TenantId;
  account_id: AccountId;
  refresh_token_hash: string; // SHA-256 hex (64 chars)
  device_id?: DeviceId | null;
  ip_address?: string | null;
  user_agent?: string | null;
  expires_at: string; // ISO 8601
}

// ---------------------------------------------------------------------------
// findSessionById
// ---------------------------------------------------------------------------

export async function findSessionById(
  tenantId: TenantId,
  sessionId: SessionId,
  externalTx?: DbClient,
): Promise<Session | null> {
  const runner = externalTx
    ? (fn: (client: DbClient) => Promise<Session | null>) => fn(externalTx)
    : (fn: (client: DbClient) => Promise<Session | null>) =>
        withTenantBoundConnection(tenantId, fn);
  return runner(async (client) => {
    const result = await client.query<SessionRow>(
      `SELECT ${SESSION_COLUMNS}
         FROM sessions
        WHERE tenant_id = $1
          AND session_id = $2`,
      [tenantId, sessionId],
    );
    if (result.rows.length === 0) return null;
    const row = result.rows[0];
    if (row === undefined) return null;
    return rowToSession(row);
  });
}

// ---------------------------------------------------------------------------
// findActiveSessionById — session-liveness primitive for PHI handlers
// ---------------------------------------------------------------------------

/**
 * Resolve the ACTIVE session by session_id. Returns null if no such session
 * exists, is revoked, or is expired. Used by PHI-handling route handlers
 * to enforce session liveness on every request (per-handler call AFTER
 * `requireActorContext()` so a JWT for a revoked / fabricated session_id
 * cannot read PHI until JWT expiry).
 *
 * Caller does not discriminate the three null causes — by I-025 a stale
 * token failure must look the same as a never-existed token failure to
 * the requester. The handler maps null → 401 unauthenticated.
 *
 * Spec references:
 *   - Identity & Authentication Spec v1.0 §3.2 (session lifecycle:
 *     revoked_at, expires_at)
 *   - I-025 (tenant-blind / token-blind error envelopes — three null
 *     causes collapse to a single 401)
 *   - Codex PR-116 R1 HIGH closure (revoked-session bypass on the new
 *     pharmacy PHI read surface)
 */
export async function findActiveSessionById(
  tenantId: TenantId,
  sessionId: SessionId,
  externalTx?: DbClient,
): Promise<Session | null> {
  const runner = externalTx
    ? (fn: (client: DbClient) => Promise<Session | null>) => fn(externalTx)
    : (fn: (client: DbClient) => Promise<Session | null>) =>
        withTenantBoundConnection(tenantId, fn);
  return runner(async (client) => {
    const result = await client.query<SessionRow>(
      `SELECT ${SESSION_COLUMNS}
         FROM sessions
        WHERE tenant_id = $1
          AND session_id = $2
          AND revoked_at IS NULL
          AND expires_at > NOW()`,
      [tenantId, sessionId],
    );
    if (result.rows.length === 0) return null;
    const row = result.rows[0];
    if (row === undefined) return null;
    return rowToSession(row);
  });
}

// ---------------------------------------------------------------------------
// findActiveSessionByRefreshHash — primary refresh-token verification path
// ---------------------------------------------------------------------------

/**
 * Resolve the ACTIVE session for a refresh-token hash. Returns null if no
 * such session exists, or it's revoked, or it's expired. The service layer
 * does not need to discriminate the three null causes (per I-025; refresh
 * failures look the same to the caller).
 */
export async function findActiveSessionByRefreshHash(
  tenantId: TenantId,
  refreshTokenHash: string,
  externalTx?: DbClient,
): Promise<Session | null> {
  const runner = externalTx
    ? (fn: (client: DbClient) => Promise<Session | null>) => fn(externalTx)
    : (fn: (client: DbClient) => Promise<Session | null>) =>
        withTenantBoundConnection(tenantId, fn);
  return runner(async (client) => {
    const result = await client.query<SessionRow>(
      `SELECT ${SESSION_COLUMNS}
         FROM sessions
        WHERE tenant_id = $1
          AND refresh_token_hash = $2
          AND revoked_at IS NULL
          AND expires_at > NOW()`,
      [tenantId, refreshTokenHash],
    );
    if (result.rows.length === 0) return null;
    const row = result.rows[0];
    if (row === undefined) return null;
    return rowToSession(row);
  });
}

// ---------------------------------------------------------------------------
// listActiveSessionsForAccount — max-3-device enforcement + admin views
// ---------------------------------------------------------------------------

export async function listActiveSessionsForAccount(
  tenantId: TenantId,
  accountId: AccountId,
  externalTx?: DbClient,
): Promise<Session[]> {
  const runner = externalTx
    ? (fn: (client: DbClient) => Promise<Session[]>) => fn(externalTx)
    : (fn: (client: DbClient) => Promise<Session[]>) => withTenantBoundConnection(tenantId, fn);
  return runner(async (client) => {
    const result = await client.query<SessionRow>(
      `SELECT ${SESSION_COLUMNS}
         FROM sessions
        WHERE tenant_id = $1
          AND account_id = $2
          AND revoked_at IS NULL
        ORDER BY last_active_at DESC`,
      [tenantId, accountId],
    );
    return result.rows.map(rowToSession);
  });
}

// ---------------------------------------------------------------------------
// createSession
// ---------------------------------------------------------------------------

export async function createSession(
  input: CreateSessionInput,
  txCallback: (tx: DbTransaction, session: Session) => Promise<void>,
  externalTx?: DbTransaction,
): Promise<Session> {
  const runFn = async (tx: DbClient): Promise<Session> => {
    const result = await tx.query<SessionRow>(
      `INSERT INTO sessions (
          session_id, tenant_id, account_id, refresh_token_hash,
          device_id, ip_address, user_agent, expires_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::timestamptz)
       RETURNING ${SESSION_COLUMNS}`,
      [
        input.session_id,
        input.tenant_id,
        input.account_id,
        input.refresh_token_hash,
        input.device_id ?? null,
        input.ip_address ?? null,
        input.user_agent ?? null,
        input.expires_at,
      ],
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw new Error('createSession: INSERT returned no rows (unreachable)');
    }
    const session = rowToSession(row);
    await txCallback(tx, session);
    return session;
  };

  if (externalTx !== undefined) {
    return runFn(externalTx);
  }
  return withTenantBoundConnection(input.tenant_id, runFn);
}

// ---------------------------------------------------------------------------
// revokeSession — flip revoked_at + revoked_reason
// ---------------------------------------------------------------------------

/**
 * Mark a session as revoked. Idempotent: re-calling on an already-revoked
 * row returns null (the WHERE clause filters out non-active rows).
 */
export async function revokeSession(
  tenantId: TenantId,
  sessionId: SessionId,
  reason: SessionRevocationReason,
  externalTx?: DbClient,
): Promise<Session | null> {
  const runner = externalTx
    ? (fn: (client: DbClient) => Promise<Session | null>) => fn(externalTx)
    : (fn: (client: DbClient) => Promise<Session | null>) =>
        withTenantBoundConnection(tenantId, fn);
  return runner(async (client) => {
    const result = await client.query<SessionRow>(
      `UPDATE sessions
          SET revoked_at = NOW(),
              revoked_reason = $3
        WHERE tenant_id = $1
          AND session_id = $2
          AND revoked_at IS NULL
       RETURNING ${SESSION_COLUMNS}`,
      [tenantId, sessionId, reason],
    );
    if (result.rows.length === 0) return null;
    const row = result.rows[0];
    if (row === undefined) return null;
    return rowToSession(row);
  });
}
