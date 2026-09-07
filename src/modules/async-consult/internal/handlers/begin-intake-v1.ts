import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { requirePatientActorContext } from '../../../../lib/auth-context.js';
import { withIdempotentExecution } from '../../../../lib/idempotent-handler.js';
import { KmsOperationError } from '../../../../lib/kms-aws.js';
import { requireTenantContext } from '../../../../lib/tenant-context.js';
import { ConsultDefinitionError } from '../../../forms-intake/index.js';
import { beginCareIntake, careIntakeTransaction } from '../services/clinical-intake-repository.js';
import { CareIntakeError } from '../services/clinical-intake.js';

export function carePatientContext(req: FastifyRequest, reply: FastifyReply) {
  void reply.header('Cache-Control', 'no-store');
  const tenant = requireTenantContext(req);
  const actor = requirePatientActorContext(req);
  if (!req.actorNonce || actor.delegateId !== null || actor.tenantId !== tenant.tenantId)
    throw req.server.httpErrors.forbidden('Care access is unavailable.');
  return {
    tenant,
    accountId: actor.accountId,
    sessionId: actor.sessionId,
    actorNonce: req.actorNonce,
  };
}
export function careRetryKey(req: FastifyRequest): void {
  if (
    !z
      .string()
      .regex(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/u)
      .safeParse(req.headers['idempotency-key']).success
  )
    throw req.server.httpErrors.badRequest('A valid Idempotency-Key is required.');
}

export function careConsultId(req: FastifyRequest): string {
  const parsed = z
    .object({ consult_id: z.string().regex(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/u) })
    .strict()
    .safeParse(req.params);
  if (!parsed.success) throw req.server.httpErrors.badRequest('Invalid care request.');
  return parsed.data.consult_id;
}
export function careIntakeFailure(error: unknown, reply: FastifyReply, requestId: string) {
  const databaseCode = (error as { code?: string })?.code;
  const databaseMessage = (error as { message?: string })?.message;
  const status =
    databaseCode === '42501' && databaseMessage === 'billing_actor_unavailable'
      ? 401
      : error instanceof CareIntakeError
        ? error.code === 'care.invalid_intake'
          ? 400
          : 409
        : error instanceof ConsultDefinitionError
          ? error.statusCode
          : error instanceof KmsOperationError
            ? 503
            : (
                {
                  PT401: 401,
                  PT404: 404,
                  PT409: 409,
                  PT503: 503,
                  '02000': 409,
                  '42501': 403,
                  '23514': 409,
                  '23505': 409,
                  '55P03': 503,
                  '57014': 503,
                } as Record<string, number>
              )[databaseCode ?? ''];
  if (status === undefined) return false;
  const reason = (
    {
      care_payment_required: 'care.payment_required',
      care_consent_required: 'care.consent_required',
      care_consent_changed: 'care.consent_review_required',
      care_form_review_required: 'care.form_review_required',
      forms_definition_unavailable: 'care.form_review_required',
    } as Record<string, string>
  )[databaseMessage ?? ''];
  const code =
    error instanceof CareIntakeError || error instanceof ConsultDefinitionError
      ? error.code
      : (reason ?? 'care.operation_unavailable');
  void reply.code(status).send({
    error: {
      code,
      message: 'The care operation is unavailable. Check its status before retrying.',
      request_id: requestId,
    },
  });
  return true;
}

/** Empty-body operation records the exact published definition before rendering it. */
export async function beginIntakeV1Handler(req: FastifyRequest, reply: FastifyReply) {
  const ctx = carePatientContext(req, reply);
  const consultId = careConsultId(req);
  careRetryKey(req);
  if (
    !z
      .object({})
      .strict()
      .safeParse(req.body ?? {}).success ||
    !z.object({}).strict().safeParse(req.query).success
  )
    throw req.server.httpErrors.badRequest('Invalid care request.');
  return withIdempotentExecution(
    req,
    reply,
    careIntakeFailure,
    async (tx) => ({
      status: 200,
      view: await beginCareIntake(tx, ctx, consultId),
    }),
    careIntakeTransaction(ctx),
  );
}
