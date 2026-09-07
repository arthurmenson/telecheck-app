import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { requirePatientActorContext } from '../../lib/auth-context.js';
import { requireTenantContext } from '../../lib/tenant-context.js';

import { getPatientCrisisHistory } from './internal/patient-history.js';

export async function registerPatientCrisisHistory(app: FastifyInstance): Promise<void> {
  app.get('/mine', async (req, reply) => {
    void reply.header('Cache-Control', 'no-store');
    const actor = requirePatientActorContext(req);
    const tenant = requireTenantContext(req);
    if (!req.actorNonce || actor.delegateId !== null || actor.tenantId !== tenant.tenantId)
      throw app.httpErrors.forbidden('Crisis history is unavailable.');
    const query = z
      .object({ offset: z.coerce.number().int().min(0).max(10000).default(0) })
      .strict()
      .safeParse(req.query);
    if (!query.success) throw app.httpErrors.badRequest('Invalid crisis history request.');
    try {
      return await getPatientCrisisHistory(
        {
          tenant,
          accountId: actor.accountId,
          sessionId: actor.sessionId,
          actorNonce: req.actorNonce,
        },
        query.data.offset,
      );
    } catch (error) {
      const code = (error as { code?: string })?.code;
      const status = code === 'PT401' ? 401 : code === '42501' ? 403 : 503;
      return reply.code(status).send({
        error: {
          code:
            status === 401
              ? 'crisis.unauthenticated'
              : status === 403
                ? 'crisis.forbidden'
                : 'crisis.history_unavailable',
          message: 'Crisis history could not be loaded. Try again.',
          request_id: req.id,
        },
      });
    }
  });
}
