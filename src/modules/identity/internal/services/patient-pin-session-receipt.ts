import { createHash } from 'node:crypto';

import type { FastifyRequest } from 'fastify';

import { config } from '../../../../lib/config.js';
import type { DbClient } from '../../../../lib/db.js';
import { verifyAccessToken } from '../../../../lib/jwt.js';

export class PatientPinSessionUnavailable extends Error {
  constructor() {
    super('internal.auth.unauthenticated');
  }
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Cached PIN-login/signup tokens require their original session to remain live. */
export async function assertPatientPinSessionReceipt(
  request: FastifyRequest,
  tx: DbClient,
  receipt: unknown,
): Promise<void> {
  const path = request.routeOptions.url;
  if (path !== '/v0/identity/login/pin' && path !== '/v0/identity/registration/email/verify')
    return;
  const result = object(receipt);
  if (result?.status !== 200 && result?.status !== 201) return;
  const body = object(result.body),
    account = object(body?.account);
  const tenantId = request.tenantContext?.tenantId;
  if (
    !tenantId ||
    typeof body?.access_token !== 'string' ||
    typeof body.refresh_token !== 'string' ||
    typeof body.session_id !== 'string' ||
    typeof account?.account_id !== 'string'
  ) {
    throw new PatientPinSessionUnavailable();
  }
  const verified = verifyAccessToken(body.access_token, config.jwtSigningKey);
  if (
    !verified.ok ||
    verified.claims.role !== 'patient' ||
    verified.claims.tenant_id !== tenantId ||
    verified.claims.sub !== account.account_id ||
    verified.claims.session_id !== body.session_id ||
    (verified.claims.delegate_id ?? null) !== null
  )
    throw new PatientPinSessionUnavailable();
  const values = [
    tenantId,
    account.account_id,
    body.session_id,
    createHash('sha256').update(body.refresh_token).digest('hex'),
  ];
  // Account first matches PIN login/reset. Hold the session against logout too.
  const accountLock = await tx.query(
    `SELECT account_id FROM accounts WHERE tenant_id=$1 AND account_id=$2
      AND account_type IN ('patient','delegate') AND status='active' AND deleted_at IS NULL
      FOR SHARE`,
    values.slice(0, 2),
  );
  if (accountLock.rowCount !== 1) throw new PatientPinSessionUnavailable();
  const locked = await tx.query(
    `SELECT session_id FROM sessions WHERE tenant_id=$1 AND account_id=$2 AND session_id=$3
      AND revoked_at IS NULL AND refresh_token_hash=$4 FOR SHARE`,
    values,
  );
  if (locked.rowCount !== 1) throw new PatientPinSessionUnavailable();
  // A lock wait cannot preserve a session whose wall-clock expiry has passed.
  const live = await tx.query<{ allowed: boolean }>(
    `SELECT EXISTS(SELECT 1 FROM sessions WHERE tenant_id=$1 AND account_id=$2 AND session_id=$3
      AND refresh_token_hash=$4 AND revoked_at IS NULL AND expires_at>clock_timestamp()) AS allowed`,
    values,
  );
  if (live.rows[0]?.allowed !== true) throw new PatientPinSessionUnavailable();
}
