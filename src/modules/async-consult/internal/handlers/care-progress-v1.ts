import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { careIntakeTransaction } from '../services/clinical-intake-repository.js';

import { careConsultId, careIntakeFailure, carePatientContext } from './begin-intake-v1.js';

/** Metadata-only resume point: no answers, provider secrets or consent grants. */
export async function careProgressV1Handler(req: FastifyRequest, reply: FastifyReply) {
  const ctx = carePatientContext(req, reply);
  const consultId = careConsultId(req);
  if (!z.object({}).strict().safeParse(req.query).success)
    throw req.server.httpErrors.badRequest('Invalid care request.');
  try {
    const view = await careIntakeTransaction(ctx)(async (tx) => {
      const result = await tx.query<{ progress: Record<string, unknown> }>(
        'SELECT public.care_consult_progress($1) AS progress',
        [consultId],
      );
      if (!result.rows[0]?.progress)
        throw Object.assign(new Error('care_progress_unavailable'), { code: 'PT404' });
      return result.rows[0].progress;
    });
    return reply.send(view);
  } catch (error) {
    if (careIntakeFailure(error, reply, req.id)) return reply;
    throw error;
  }
}
