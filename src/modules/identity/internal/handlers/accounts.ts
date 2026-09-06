/** GET /v0/identity/accounts/me — authenticated, live-session self-read. */
import type { FastifyReply, FastifyRequest } from 'fastify';

import * as accountService from '../services/account-service.js';

import { requireIdentitySelfContext } from './self-context.js';

export async function getMyAccountHandler(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<unknown> {
  const { account } = await requireIdentitySelfContext(req);
  return reply.code(200).send(accountService.toPatientAccountView(account));
}
