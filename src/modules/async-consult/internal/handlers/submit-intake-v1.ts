import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { withIdempotentExecution } from '../../../../lib/idempotent-handler.js';
import { admitPatientCareInput } from '../../../crisis-response/index.js';
import {
  careIntakeRepository,
  careIntakeTransaction,
} from '../services/clinical-intake-repository.js';
import { createCareIntakeService } from '../services/clinical-intake.js';

import {
  carePatientContext,
  careConsultId,
  careRetryKey,
  careIntakeFailure,
} from './begin-intake-v1.js';

const admittedRequests = new WeakSet<FastifyRequest>();

/**
 * Route preValidation runs after parsing/authentication and before global
 * idempotency preHandler. A malformed business request or transport retry key
 * must not conceal a detection. Crisis recording owns its separate transaction.
 */
export async function admitCareIntakeV1Request(req: FastifyRequest, reply: FastifyReply) {
  const ctx = carePatientContext(req, reply);
  const key = req.headers['idempotency-key'];
  try {
    const admission = await admitPatientCareInput(
      { ...ctx, ...(typeof key === 'string' ? { idempotencyKey: key } : {}) },
      req.body,
      'form_response',
    );
    if (admission.kind === 'crisis_interruption') {
      return reply
        .code(
          admission.recording_status === 'recorded' && admission.disclosure_status === 'available'
            ? 202
            : 503,
        )
        .send(admission);
    }
    admittedRequests.add(req);
  } catch (error) {
    if (careIntakeFailure(error, reply, req.id)) return reply;
    throw error;
  }
}

/** Plaintext patient ingress; row identity, consent and encryption are server-owned. */
export async function submitIntakeV1Handler(req: FastifyRequest, reply: FastifyReply) {
  const ctx = carePatientContext(req, reply);
  if (!admittedRequests.delete(req))
    throw req.server.httpErrors.serviceUnavailable('Care admission is unavailable.');
  const consultId = careConsultId(req);
  careRetryKey(req);
  if (!z.object({}).strict().safeParse(req.query).success)
    throw req.server.httpErrors.badRequest('Invalid care request.');
  const submit = createCareIntakeService({ repository: careIntakeRepository(ctx) });
  return withIdempotentExecution(
    req,
    reply,
    careIntakeFailure,
    async (tx) => ({ status: 201, view: await submit(tx, ctx, consultId, req.body) }),
    careIntakeTransaction(ctx),
  );
}
