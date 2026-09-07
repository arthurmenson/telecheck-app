import { config } from '../../../../lib/config.js';
import type { DbTransaction } from '../../../../lib/db.js';
import { canonicalBodyForHash, hashBody } from '../../../../lib/idempotency.js';
import { issueAccessToken, verifyAccessToken } from '../../../../lib/jwt.js';
import type { TenantContext } from '../../../../lib/tenant-context.js';
import { emitSessionRotatedAudit } from '../../audit.js';
import { emitSessionRotatedDomainEvent } from '../../events.js';
import * as sessionRepo from '../repositories/session-repo.js';
import type { Session } from '../types.js';

import { patientRefreshReplySchema, type PatientRefreshReply } from './patient-refresh-contract.js';
import { generateRefreshToken, hashRefreshToken, revokeSession } from './session-service.js';

export class PatientRefreshUnavailable extends Error {
  constructor() {
    super('identity.session.invalid_or_expired');
  }
}

export async function rotatePatientSession(
  ctx: TenantContext,
  refreshToken: string,
  tx: DbTransaction,
): Promise<PatientRefreshReply> {
  const token = generateRefreshToken();
  const session = await sessionRepo.rotatePatientRefreshToken(
    ctx.tenantId,
    hashRefreshToken(refreshToken),
    token.hash,
    tx,
  );
  if (!session) throw new PatientRefreshUnavailable();
  await emitSessionRotatedAudit(
    {
      tenantId: ctx.tenantId,
      accountId: session.account_id,
      sessionId: session.session_id,
      countryOfCare: ctx.countryOfCare,
      expiresAt: session.expires_at,
    },
    tx,
  );
  await emitSessionRotatedDomainEvent(tx, {
    tenantId: ctx.tenantId,
    accountId: session.account_id,
    sessionId: session.session_id,
    occurredAt: session.last_active_at,
    expiresAt: session.expires_at,
  });
  return {
    session: projection(session),
    access_token: issueAccessToken(
      {
        account_id: session.account_id,
        tenant_id: ctx.tenantId,
        session_id: session.session_id,
        role: 'patient',
        country_of_care: ctx.countryOfCare,
      },
      config.jwtSigningKey,
    ),
    refresh_token: token.plaintext,
  };
}

function projection(session: Session): PatientRefreshReply['session'] {
  return {
    session_id: session.session_id,
    account_id: session.account_id,
    created_at: session.created_at,
    last_active_at: session.last_active_at,
    expires_at: session.expires_at,
  };
}

/** A cached rotation is recoverable only while its exact successor remains current. */
export async function assertCurrentPatientRotation(
  ctx: TenantContext,
  value: unknown,
  tx: DbTransaction,
): Promise<PatientRefreshReply> {
  const parsed = patientRefreshReplySchema.safeParse(value);
  if (!parsed.success) throw new PatientRefreshUnavailable();
  const body = parsed.data;
  const session = await sessionRepo.lockCurrentPatientSession(
    ctx.tenantId,
    body.session.account_id,
    body.session.session_id,
    tx,
  );
  if (
    !session ||
    session.refresh_token_hash !== hashRefreshToken(body.refresh_token) ||
    session.created_at !== body.session.created_at ||
    session.expires_at !== body.session.expires_at
  )
    throw new PatientRefreshUnavailable();
  const verified = verifyAccessToken(body.access_token, config.jwtSigningKey);
  if (
    !verified.ok ||
    verified.claims.role !== 'patient' ||
    verified.claims.sub !== session.account_id ||
    verified.claims.session_id !== session.session_id ||
    verified.claims.tenant_id !== ctx.tenantId ||
    verified.claims.country_of_care !== ctx.countryOfCare ||
    verified.claims.delegate_id != null ||
    verified.claims.admin_tenant_binding != null
  )
    throw new PatientRefreshUnavailable();
  return body;
}

/** A pending rotation's exact receipt can revoke its successor after a lost reply. */
export async function logoutPatientSession(
  ctx: TenantContext,
  refreshToken: string,
  refreshKey: string | undefined,
  tx: DbTransaction,
): Promise<void> {
  const direct = await sessionRepo.findActiveSessionByRefreshHash(
    ctx.tenantId,
    hashRefreshToken(refreshToken),
    tx,
  );
  let live: Session | null = null;
  if (direct) {
    // The opaque credential matched at admission; keep its exact session through
    // a concurrent rotation's account lock, then revoke that same device session.
    live = await sessionRepo.lockSessionForRevocation(
      ctx.tenantId,
      direct.account_id,
      direct.session_id,
      tx,
    );
  } else if (refreshKey) {
    const bodyHash = hashBody(canonicalBodyForHash({ refresh_token: refreshToken }));
    const lookup = () =>
      tx.query<{ response_body: unknown }>(
        `SELECT response_body FROM identity_idempotency_keys WHERE tenant_id=$1 AND key=$2
        AND endpoint='/v0/identity/sessions/refresh' AND actor_id='anonymous'
        AND request_hash=decode($3,'hex') AND processing_state='completed' AND response_status=200
        AND expires_at>clock_timestamp()`,
        [ctx.tenantId, refreshKey, bodyHash],
      );
    const parsed = patientRefreshReplySchema.safeParse((await lookup()).rows[0]?.response_body);
    if (!parsed.success) return;
    const body = parsed.data;
    live = await sessionRepo.lockSessionForRevocation(
      ctx.tenantId,
      body.session.account_id,
      body.session.session_id,
      tx,
    );
    const verified = verifyAccessToken(body.access_token, config.jwtSigningKey);
    if (
      !live ||
      !verified.ok ||
      verified.claims.role !== 'patient' ||
      verified.claims.sub !== live.account_id ||
      verified.claims.session_id !== live.session_id ||
      verified.claims.tenant_id !== ctx.tenantId ||
      verified.claims.country_of_care !== ctx.countryOfCare ||
      verified.claims.delegate_id != null ||
      verified.claims.admin_tenant_binding != null ||
      (await lookup()).rowCount !== 1
    )
      return;
  }
  if (live) await revokeSession(ctx, { actorId: 'system' }, live.session_id, 'patient_logout', tx);
}
