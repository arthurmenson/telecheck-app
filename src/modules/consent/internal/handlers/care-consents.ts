import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { requirePatientActorContext } from '../../../../lib/auth-context.js';
import { withIdempotentExecution } from '../../../../lib/idempotent-handler.js';
import { requireTenantContext } from '../../../../lib/tenant-context.js';
import {
  careConsentTransaction,
  getCareConsentDecisionDetail,
  getCareConsentStatus,
  listCareConsentHistory,
  recordCareConsentChoices,
  resolveCareConsentInTransaction,
  withdrawCareConsent,
} from '../services/care-consent.js';
import {
  CareConsentChoicesSchema,
  CareConsentContractError,
} from '../services/care-policy-contract.js';

function context(req: FastifyRequest, reply: FastifyReply) {
  void reply.header('Cache-Control', 'no-store');
  const tenant = requireTenantContext(req);
  const actor = requirePatientActorContext(req);
  if (!req.actorNonce || actor.delegateId !== null || actor.tenantId !== tenant.tenantId)
    throw req.server.httpErrors.forbidden('Consent access is unavailable.');
  return {
    tenant,
    accountId: actor.accountId,
    sessionId: actor.sessionId,
    actorNonce: req.actorNonce,
  };
}
function parse<T>(schema: z.ZodType<T>, value: unknown, req: FastifyRequest): T {
  const result = schema.safeParse(value);
  if (!result.success) throw req.server.httpErrors.badRequest('Invalid consent request.');
  return result.data;
}
function mapError(error: unknown, reply: FastifyReply, requestId: string) {
  const code = (error as { code?: string })?.code;
  const status =
    error instanceof CareConsentContractError
      ? error.code === 'consent.policy_changed'
        ? 409
        : 400
      : (
          {
            PT401: 401,
            PT404: 404,
            PT409: 409,
            PT503: 503,
            '42501': 403,
            '22023': 400,
            '23514': 409,
            '23505': 409,
          } as Record<string, number>
        )[code ?? ''];
  if (status === undefined) return false;
  const accountClosure =
    (error as { message?: string })?.message === 'consent_account_closure_required';
  void reply.code(status).send({
    error: {
      code: accountClosure ? 'consent.account_closure_required' : 'consent.operation_unavailable',
      message: accountClosure
        ? 'Withdrawing platform terms requires account closure.'
        : 'The requested consent operation is unavailable.',
      request_id: requestId,
    },
  });
  return true;
}
const scope = z
  .object({
    program_id: z
      .string()
      .regex(/^[0-9A-HJKMNP-TV-Z]{26}$/u)
      .optional(),
  })
  .strict();
export function registerCareConsentPatientRoutes(app: FastifyInstance): void {
  app.get('/care/history/:decision_id', async (req, reply) => {
    const ctx = context(req, reply);
    parse(z.object({}).strict(), req.query, req);
    const params = parse(
      z.object({ decision_id: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/u) }).strict(),
      req.params,
      req,
    );
    try {
      return reply
        .code(200)
        .send(
          await careConsentTransaction(ctx)((tx) =>
            getCareConsentDecisionDetail(tx, ctx, params.decision_id),
          ),
        );
    } catch (error) {
      if (mapError(error, reply, req.id)) return reply;
      throw error;
    }
  });
  app.get('/care/history', async (req, reply) => {
    const ctx = context(req, reply);
    const query = parse(
      z
        .object({
          offset: z
            .string()
            .regex(/^(0|[1-9][0-9]{0,4})$/u)
            .optional(),
        })
        .strict(),
      req.query,
      req,
    );
    const offset = Number(query.offset ?? 0);
    if (offset > 10000) throw req.server.httpErrors.badRequest('Invalid consent page.');
    try {
      return reply
        .code(200)
        .send(await careConsentTransaction(ctx)((tx) => listCareConsentHistory(tx, ctx, offset)));
    } catch (error) {
      if (mapError(error, reply, req.id)) return reply;
      throw error;
    }
  });
  app.get('/care/status', async (req, reply) => {
    const ctx = context(req, reply);
    const query = parse(scope, req.query, req);
    try {
      return reply
        .code(200)
        .send(
          await careConsentTransaction(ctx)((tx) =>
            getCareConsentStatus(tx, ctx, query.program_id ?? null),
          ),
        );
    } catch (error) {
      if (mapError(error, reply, req.id)) return reply;
      throw error;
    }
  });
  app.post('/care/withdraw', async (req, reply) => {
    const ctx = context(req, reply);
    parse(z.object({}).strict(), req.query, req);
    const body = parse(
      z.object({ decision_id: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/u) }).strict(),
      req.body,
      req,
    );
    return withIdempotentExecution(
      req,
      reply,
      mapError,
      async (tx) => ({
        status: 201,
        view: await withdrawCareConsent(tx, ctx, body.decision_id),
      }),
      careConsentTransaction(ctx),
    );
  });
  app.get('/care/terms', async (req, reply) => {
    const ctx = context(req, reply);
    const query = parse(scope, req.query, req);
    try {
      const view = await careConsentTransaction(ctx)((tx) =>
        resolveCareConsentInTransaction(tx, ctx, query.program_id ?? null),
      );
      return reply.code(200).send(view);
    } catch (error) {
      if (mapError(error, reply, req.id)) return reply;
      throw error;
    }
  });
  app.post('/care/choices', async (req, reply) => {
    const ctx = context(req, reply);
    const query = parse(scope, req.query, req);
    const body = parse(CareConsentChoicesSchema, req.body, req);
    return withIdempotentExecution(
      req,
      reply,
      mapError,
      async (tx) => ({
        status: 201,
        view: await recordCareConsentChoices(tx, ctx, query.program_id ?? null, body),
      }),
      careConsentTransaction(ctx),
    );
  });
}
