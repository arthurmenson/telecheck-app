/** Identity self-service requires a live session owned by an active account. */
import type { FastifyRequest } from 'fastify';

import { requireActorContext, UnauthenticatedError } from '../../../../lib/auth-context.js';
import { requireTenantContext } from '../../../../lib/tenant-context.js';
import * as accountService from '../services/account-service.js';
import * as sessionService from '../services/session-service.js';
import { asAccountId, asSessionId } from '../types.js';

export async function requireIdentitySelfContext(req: FastifyRequest) {
  const ctx = requireTenantContext(req);
  const actor = requireActorContext(req);
  // Global administration does not confer access to another tenant's identity.
  // A delegated clinical context cannot manage the principal's credentials.
  if (
    actor.role === 'ai_service' ||
    actor.delegateId !== null ||
    (actor.adminHomeTenantId !== null && actor.adminHomeTenantId !== ctx.tenantId)
  ) {
    throw new UnauthenticatedError();
  }
  const session = await sessionService.findActiveSessionById(ctx, asSessionId(actor.sessionId));
  if (session === null || session.account_id !== actor.accountId) {
    throw new UnauthenticatedError();
  }
  const account = await accountService.findAccountById(ctx, asAccountId(actor.accountId));
  const expectedRole = account?.account_type === 'delegate' ? 'patient' : account?.account_type;
  if (
    account === null ||
    account.status !== 'active' ||
    account.deleted_at !== null ||
    expectedRole !== actor.role
  ) {
    throw new UnauthenticatedError();
  }
  return { ctx, actor, account };
}
