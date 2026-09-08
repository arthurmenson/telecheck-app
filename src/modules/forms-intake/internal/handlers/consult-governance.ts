import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { withActorContext } from '../../../../lib/actor-context-binding.js';
import { requireActorContext } from '../../../../lib/auth-context.js';
import { withTransaction, type DbClient } from '../../../../lib/db.js';
import { withIdempotentExecution } from '../../../../lib/idempotent-handler.js';
import { withTenantContext } from '../../../../lib/rls.js';
import { requireTenantContext } from '../../../../lib/tenant-context.js';
import { ulid } from '../../../../lib/ulid.js';
import { emitFormsGovernanceEvidence } from '../../audit.js';
import {
  ConsultPresentationSchema,
  resolveConsultIntakeDefinition,
} from '../services/consult-definition.js';
import {
  assertFormsGovernanceScope,
  formsGovernanceTransaction,
  recordFormsPublicationEvidence,
} from '../services/publication-evidence.js';

const ulidSchema = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/);
const templateBody = z
  .object({
    program_id: ulidSchema,
    name: z.string().min(1).max(200),
    presentation: ConsultPresentationSchema,
    branching_logic: z.record(z.string(), z.unknown()),
    eligibility_logic: z.record(z.string(), z.unknown()),
    approval_governance: z.record(z.string(), z.unknown()),
  })
  .strict();
const artifactBody = z
  .object({
    kind: z.enum(['clinical_review', 'marketing_copy', 'mode2_contract']),
    template_id: ulidSchema.optional(),
    content: z.record(z.string(), z.unknown()),
    development_only: z.boolean(),
  })
  .strict();
const reviewBody = z
  .object({
    content_hash: z.string().regex(/^[a-f0-9]{64}$/),
    decision: z.enum(['approved', 'rejected']),
  })
  .strict();

function readInput<T>(schema: z.ZodType<T>, value: unknown, req: FastifyRequest): T {
  const result = schema.safeParse(value);
  if (!result.success) throw req.server.httpErrors.badRequest('Invalid form operation input.');
  return result.data;
}

function mapError(error: unknown, reply: FastifyReply): boolean {
  const code = (error as { code?: string })?.code;
  // PT503: the COMMIT's fate is unknown (formsGovernanceTransaction) — tell
  // the caller to check status before retrying, never a 500.
  const status =
    code === '42501'
      ? 403
      : code === '02000'
        ? 404
        : code === '22023'
          ? 400
          : code === '23514'
            ? 409
            : code === 'PT503'
              ? 503
              : undefined;
  if (status === undefined) return false;
  void reply.code(status).send({
    error: {
      code: 'forms.operation_unavailable',
      message: 'The requested form operation is unavailable.',
    },
  });
  return true;
}

function context(req: FastifyRequest) {
  const tenant = requireTenantContext(req);
  const actor = requireActorContext(req);
  if (!req.actorNonce || actor.tenantId !== tenant.tenantId || actor.delegateId !== null)
    throw req.server.httpErrors.forbidden('Insufficient scope for this request.');
  return { tenant, actor, nonce: req.actorNonce };
}

async function mutate(
  req: FastifyRequest,
  reply: FastifyReply,
  intent: string,
  operation: (tx: DbClient) => Promise<Record<string, unknown>>,
): Promise<unknown> {
  const { tenant, actor, nonce } = context(req);
  if (actor.role !== 'tenant_admin' && actor.role !== 'clinician')
    throw req.server.httpErrors.forbidden('Insufficient scope for this request.');
  void reply.header('Cache-Control', 'no-store');
  try {
    await withTransaction((tx) =>
      assertFormsGovernanceScope(
        tx,
        {
          tenantId: tenant.tenantId,
          accountId: actor.accountId,
          sessionId: actor.sessionId,
          actorNonce: nonce,
        },
        intent,
        (req.params as { artifactId?: string }).artifactId ?? null,
      ),
    );
  } catch (error) {
    if (mapError(error, reply)) return reply;
    throw error;
  }
  return withIdempotentExecution(
    req,
    reply,
    mapError,
    (tx) =>
      withTenantContext(tx, tenant.tenantId, () =>
        withActorContext(tx, nonce, async () => {
          const result = await operation(tx);
          const resourceId = String(
            result['template_id'] ?? result['artifact_id'] ?? result['deployment_id'],
          );
          const auditContext = {
            tenantId: tenant.tenantId,
            actorId: actor.accountId,
            actorRole: actor.role === 'clinician' ? ('clinician' as const) : ('operator' as const),
            countryOfCare: tenant.countryOfCare,
          };
          if (intent === 'forms.publication.checked')
            await recordFormsPublicationEvidence(tx, auditContext, resourceId);
          else
            await emitFormsGovernanceEvidence(
              { ...auditContext, resourceId, intent, detail: result },
              tx,
            );
          return { status: 201, view: result };
        }),
      ),
    formsGovernanceTransaction(
      {
        tenantId: tenant.tenantId,
        accountId: actor.accountId,
        sessionId: actor.sessionId,
        actorNonce: nonce,
      },
      intent,
      (req.params as { artifactId?: string }).artifactId ?? null,
    ),
  );
}

export function registerConsultGovernanceRoutes(app: FastifyInstance): void {
  app.post('/consult-templates', async (req, reply) => {
    const body = readInput(templateBody, req.body, req);
    if (
      process.env['NODE_ENV'] === 'production' &&
      body.approval_governance['development_only'] !== false
    )
      throw req.server.httpErrors.badRequest(
        'Development templates cannot be created in production.',
      );
    return mutate(req, reply, 'forms.consult_template.created', async (tx) => {
      const result = await tx.query<{ result: Record<string, unknown> }>(
        'SELECT public.forms_create_consult_template($1,$2,$3,$4,$5,$6,$7) AS result',
        [
          ulid(),
          body.program_id,
          body.name,
          body.presentation,
          body.branching_logic,
          body.eligibility_logic,
          body.approval_governance,
        ],
      );
      return result.rows[0]!.result;
    });
  });
  app.post('/consult-templates/:templateId/publish', async (req, reply) => {
    const { templateId } = readInput(z.object({ templateId: ulidSchema }), req.params, req);
    readInput(z.object({}).strict(), req.body ?? {}, req);
    return mutate(req, reply, 'forms.publication.checked', async (tx) => {
      const result = await tx.query<{
        result: { published: { template_id: string; template_version: number } };
      }>('SELECT public.forms_publish_template($1) AS result', [templateId]);
      return {
        template_id: result.rows[0]!.result.published.template_id,
        template_version: result.rows[0]!.result.published.template_version,
        status: 'published',
      };
    });
  });
  app.post('/consult-templates/:templateId/deploy', async (req, reply) => {
    const { templateId } = readInput(z.object({ templateId: ulidSchema }), req.params, req);
    readInput(z.object({}).strict(), req.body ?? {}, req);
    return mutate(req, reply, 'forms.consult_template.deployed', async (tx) => {
      const result = await tx.query<{ result: Record<string, unknown> }>(
        'SELECT public.forms_deploy_consult_template($1,$2) AS result',
        [templateId, ulid()],
      );
      return result.rows[0]!.result;
    });
  });
  app.get('/consult-definitions', async (req, reply) => {
    const { tenant, actor, nonce } = context(req);
    const selection = readInput(
      z
        .object({ kind: z.enum(['general_consult', 'program']), programId: ulidSchema.optional() })
        .strict(),
      req.query,
      req,
    );
    void reply.header('Cache-Control', 'no-store');
    try {
      return await withTransaction((tx) =>
        resolveConsultIntakeDefinition(
          tx,
          {
            tenantId: tenant.tenantId,
            accountId: actor.accountId,
            sessionId: actor.sessionId,
            actorNonce: nonce,
            countryOfCare: tenant.countryOfCare,
          },
          {
            kind: selection.kind,
            ...(selection.programId === undefined ? {} : { programId: selection.programId }),
          },
        ),
      );
    } catch (error) {
      if (mapError(error, reply)) return reply;
      throw error;
    }
  });
  app.post('/consult-deployments/:deploymentId/retire', async (req, reply) => {
    const { deploymentId } = readInput(z.object({ deploymentId: ulidSchema }), req.params, req);
    readInput(z.object({}).strict(), req.body ?? {}, req);
    return mutate(req, reply, 'forms.consult_template.retired', async (tx) => {
      const result = await tx.query<{ result: Record<string, unknown> }>(
        'SELECT public.forms_retire_consult_deployment($1) AS result',
        [deploymentId],
      );
      return result.rows[0]!.result;
    });
  });
  app.post('/governance/artifacts', async (req, reply) => {
    const body = readInput(artifactBody, req.body, req);
    if (process.env['NODE_ENV'] === 'production' && body.development_only)
      throw req.server.httpErrors.badRequest(
        'Development artifacts cannot be created in production.',
      );
    return mutate(req, reply, 'forms.governance.submitted', async (tx) => {
      const result = await tx.query<{ result: Record<string, unknown> }>(
        'SELECT public.forms_submit_governance_artifact($1,$2,$3,$4) AS result',
        [body.kind, body.template_id ?? null, body.content, body.development_only],
      );
      return result.rows[0]!.result;
    });
  });
  app.get('/governance/artifacts/:artifactId', async (req, reply) => {
    const { tenant, nonce } = context(req);
    const { artifactId } = readInput(z.object({ artifactId: z.uuid() }), req.params, req);
    void reply.header('Cache-Control', 'no-store');
    try {
      return await withTransaction((tx) =>
        withTenantContext(tx, tenant.tenantId, () =>
          withActorContext(
            tx,
            nonce,
            async () =>
              (
                await tx.query<{ result: unknown }>(
                  'SELECT public.forms_read_governance_artifact($1) AS result',
                  [artifactId],
                )
              ).rows[0]!.result,
          ),
        ),
      );
    } catch (error) {
      if (mapError(error, reply)) return reply;
      throw error;
    }
  });
  app.post('/governance/artifacts/:artifactId/decision', async (req, reply) => {
    const { artifactId } = readInput(z.object({ artifactId: z.uuid() }), req.params, req);
    const body = readInput(reviewBody, req.body, req);
    return mutate(req, reply, 'forms.governance.reviewed', async (tx) => {
      const result = await tx.query<{ result: Record<string, unknown> }>(
        'SELECT public.forms_review_governance_artifact($1,$2,$3) AS result',
        [artifactId, body.content_hash, body.decision],
      );
      return result.rows[0]!.result;
    });
  });
}
