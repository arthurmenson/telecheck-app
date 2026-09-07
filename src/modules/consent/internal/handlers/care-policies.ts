import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { withActorContext } from '../../../../lib/actor-context-binding.js';
import { requireActorContext } from '../../../../lib/auth-context.js';
import { withTransaction, type DbTransaction } from '../../../../lib/db.js';
import { IdempotencyReplayError } from '../../../../lib/idempotency.js';
import { withIdempotentExecution } from '../../../../lib/idempotent-handler.js';
import { withTenantContext } from '../../../../lib/rls.js';
import { requireTenantContext } from '../../../../lib/tenant-context.js';
import { ulid } from '../../../../lib/ulid.js';
import { withDbRole } from '../../../../lib/with-db-role.js';
import { getTenantCountryProfile } from '../../../tenant-config/index.js';
import { emitCarePolicyEvidence } from '../../audit.js';
import { CarePolicyProposalSchema, hashCarePolicy } from '../services/care-policy-contract.js';

const id = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/u);
const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const receipt = z
  .object({
    policy_id: id,
    content_hash: hash,
    status: z.enum(['draft', 'published', 'superseded', 'withdrawn']),
  })
  .strict();
const publicationReceipt = receipt
  .extend({ superseded: z.array(receipt).max(1).optional() })
  .strict();
type Receipt = z.infer<typeof publicationReceipt>;
type Capability = 'policy_author' | 'policy_reviewer';

function input<T>(schema: z.ZodType<T>, value: unknown, req: FastifyRequest): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw req.server.httpErrors.badRequest('Invalid consent policy request.');
  return parsed.data;
}

function context(req: FastifyRequest) {
  const tenant = requireTenantContext(req);
  const actor = requireActorContext(req);
  if (
    !req.actorNonce ||
    actor.delegateId !== null ||
    actor.tenantId !== tenant.tenantId ||
    actor.role !== 'tenant_admin'
  ) {
    throw req.server.httpErrors.forbidden('Consent policy access is unavailable.');
  }
  return { tenant, actor, nonce: req.actorNonce };
}

function mapError(error: unknown, reply: FastifyReply, requestId: string): boolean {
  const code = (error as { code?: string })?.code;
  const statuses: Record<string, number> = {
    PT401: 401,
    '42501': 403,
    PT404: 404,
    PT409: 409,
    PT503: 503,
    '22023': 400,
    '23514': 409,
    '23505': 409,
  };
  const status = code === undefined ? undefined : statuses[code];
  if (status === undefined) return false;
  void reply.code(status).send({
    error: {
      code: 'consent.policy_unavailable',
      message: 'The requested consent policy operation is unavailable.',
      request_id: requestId,
    },
  });
  return true;
}

async function assertLive(
  tx: DbTransaction,
  ctx: ReturnType<typeof context>,
  capability: Capability,
): Promise<void> {
  const result = await withDbRole(tx, 'consent_care_operator', () =>
    tx.query<{ actor: Record<string, unknown> }>(
      'SELECT public.consent_care_live_actor($1) AS actor',
      [capability],
    ),
  );
  const actor = result.rows[0]?.actor;
  if (
    actor?.['account_id'] !== ctx.actor.accountId ||
    actor?.['session_id'] !== ctx.actor.sessionId ||
    actor?.['tenant_id'] !== ctx.tenant.tenantId ||
    actor?.['country_of_care'] !== ctx.tenant.countryOfCare
  ) {
    throw Object.assign(new Error('consent_unauthenticated'), { code: 'PT401' });
  }
}

/** Both cached receipts and new effects are inside the same live-context boundary. */
async function mutate(
  req: FastifyRequest,
  reply: FastifyReply,
  capability: Capability,
  operation: (tx: DbTransaction, ctx: ReturnType<typeof context>) => Promise<Receipt>,
) {
  const ctx = context(req);
  void reply.header('Cache-Control', 'no-store');
  const run = <T>(work: (tx: DbTransaction) => Promise<T>): Promise<T> =>
    withTransaction((tx) =>
      withTenantContext(tx, ctx.tenant.tenantId, () =>
        withActorContext(tx, ctx.nonce, async () => {
          await tx.query("SET LOCAL statement_timeout='5s'");
          await tx.query("SET LOCAL lock_timeout='2s'");
          await assertLive(tx, ctx, capability);
          let result: T;
          try {
            result = await work(tx);
          } catch (error) {
            if (error instanceof IdempotencyReplayError) await assertLive(tx, ctx, capability);
            throw error;
          }
          // Includes time spent writing the outbox and completing the response cache.
          await assertLive(tx, ctx, capability);
          await tx.query('SET CONSTRAINTS consent_care_policy_evidence IMMEDIATE');
          await assertLive(tx, ctx, capability);
          return result;
        }),
      ),
    );
  return withIdempotentExecution(
    req,
    reply,
    mapError,
    async (tx) => {
      const result = publicationReceipt.parse(await operation(tx, ctx));
      for (const item of [...(result.superseded ?? []), result]) {
        await emitCarePolicyEvidence(
          {
            tenantId: ctx.tenant.tenantId,
            actorId: ctx.actor.accountId,
            countryOfCare: ctx.tenant.countryOfCare,
            policyId: item.policy_id,
            contentHash: item.content_hash,
            status: item.status,
          },
          tx,
        );
      }
      return { status: 201, view: result };
    },
    run,
  );
}

const policyView = z
  .object({
    policy_id: id,
    content_hash: hash,
    status: receipt.shape.status,
    content: CarePolicyProposalSchema,
    author_id: id,
    reviewer_id: id.nullable(),
    created_at: z.string(),
    published_at: z.string().nullable(),
    withdrawn_at: z.string().nullable(),
  })
  .strict();

export function registerCarePolicyRoutes(app: FastifyInstance): void {
  app.post('/governance/care-policies/:policyId/withdraw', async (req, reply) => {
    const { policyId } = input(z.object({ policyId: id }).strict(), req.params, req);
    const body = input(z.object({ policy_hash: hash }).strict(), req.body, req);
    return mutate(req, reply, 'policy_reviewer', async (tx) =>
      withDbRole(tx, 'consent_care_operator', async () => {
        const result = await tx.query<{ result: unknown }>(
          'SELECT public.consent_care_withdraw_policy($1,$2) AS result',
          [policyId, body.policy_hash],
        );
        return publicationReceipt.parse(result.rows[0]?.result);
      }),
    );
  });
  app.post('/governance/care-policies', async (req, reply) => {
    const body = input(CarePolicyProposalSchema, req.body, req);
    if (process.env['NODE_ENV'] === 'production' && body.development_only) {
      throw req.server.httpErrors.badRequest(
        'Development consent policies cannot be created in production.',
      );
    }
    return mutate(req, reply, 'policy_author', async (tx, ctx) => {
      const profile = await getTenantCountryProfile(ctx.tenant, tx);
      if (
        body.country_of_care !== ctx.tenant.countryOfCare ||
        body.locale !== profile?.default_locale
      ) {
        throw req.server.httpErrors.badRequest('Consent policy country or locale is unavailable.');
      }
      const result = await withDbRole(tx, 'consent_care_operator', () =>
        tx.query<{ result: unknown }>(
          'SELECT public.consent_care_create_policy($1,$2::jsonb,$3) AS result',
          [ulid(), body, hashCarePolicy(body)],
        ),
      );
      return publicationReceipt.parse(result.rows[0]?.result);
    });
  });
  app.get('/governance/care-policies/:policyId', async (req, reply) => {
    const ctx = context(req);
    const { policyId } = input(z.object({ policyId: id }).strict(), req.params, req);
    input(z.object({}).strict(), req.query, req);
    void reply.header('Cache-Control', 'no-store');
    try {
      const result = await withTransaction((tx) =>
        withTenantContext(tx, ctx.tenant.tenantId, () =>
          withActorContext(tx, ctx.nonce, () =>
            withDbRole(tx, 'consent_care_operator', async () => {
              await tx.query("SET LOCAL statement_timeout='5s'");
              await tx.query("SET LOCAL lock_timeout='2s'");
              const rows = await tx.query<{ result: unknown }>(
                'SELECT public.consent_care_get_policy($1) AS result',
                [policyId],
              );
              const view = policyView.parse(rows.rows[0]?.result);
              if (hashCarePolicy(view.content) !== view.content_hash)
                throw new Error('consent_policy_integrity_failed');
              return view;
            }),
          ),
        ),
      );
      return reply.code(200).send(result);
    } catch (error) {
      if (mapError(error, reply, req.id)) return reply;
      throw error;
    }
  });
  app.post('/governance/care-policies/:policyId/publish', async (req, reply) => {
    const { policyId } = input(z.object({ policyId: id }).strict(), req.params, req);
    const body = input(z.object({ policy_hash: hash }).strict(), req.body, req);
    return mutate(req, reply, 'policy_reviewer', async (tx) =>
      withDbRole(tx, 'consent_care_operator', async () => {
        const current = await tx.query<{ result: unknown }>(
          'SELECT public.consent_care_get_policy($1) AS result',
          [policyId],
        );
        const view = policyView.parse(current.rows[0]?.result);
        if (process.env['NODE_ENV'] === 'production' && view.content.development_only)
          throw req.server.httpErrors.badRequest(
            'Development consent policies cannot be published in production.',
          );
        const result = await tx.query<{ result: unknown }>(
          'SELECT public.consent_care_publish_policy($1,$2,$3::jsonb) AS result',
          [policyId, body.policy_hash, JSON.stringify(view.content.terms.map(() => ulid()))],
        );
        return publicationReceipt.parse(result.rows[0]?.result);
      }),
    );
  });
}
