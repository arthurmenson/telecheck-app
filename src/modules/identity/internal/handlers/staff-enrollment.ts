import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { requireActorContext } from '../../../../lib/auth-context.js';
import {
  commitAuthorityTransaction,
  type CheckoutPool,
  type CommitAuthority,
} from '../../../../lib/commit-authority-transaction.js';
import type { DbTransaction } from '../../../../lib/db.js';
import { withIdempotentExecution } from '../../../../lib/idempotent-handler.js';
import { requireTenantContext } from '../../../../lib/tenant-context.js';
import { ulid } from '../../../../lib/ulid.js';
import { assertIdentityConnection, identityPool } from '../database.js';
import {
  StaffEnrollmentSchema,
  StaffEnrollmentReceiptSchema,
  StaffRosterQuerySchema,
  StaffRosterSchema,
} from '../services/staff-contract.js';
import { emitStaffEvidence } from '../services/staff-evidence.js';

function context(req: FastifyRequest, reply: FastifyReply) {
  void reply.header('Cache-Control', 'no-store');
  const tenant = requireTenantContext(req);
  const actor = requireActorContext(req);
  if (
    !req.actorNonce ||
    actor.delegateId !== null ||
    actor.role !== 'tenant_admin' ||
    actor.tenantId !== tenant.tenantId
  )
    throw req.server.httpErrors.forbidden('Staff enrollment is unavailable.');
  return { tenant, actor, nonce: req.actorNonce };
}
type Context = ReturnType<typeof context>;
/** Operator context the staff writes are authorised against (tenant, actor, request nonce). */
export type StaffContext = Context;
export async function assertStaffOperator(tx: DbTransaction, ctx: StaffContext, lock: boolean) {
  const result = await tx.query<{ actor: Record<string, unknown> }>(
    'SELECT public.identity_staff_operator($1) AS actor',
    [lock],
  );
  const actor = result.rows[0]?.actor;
  if (
    actor?.['tenant_id'] !== ctx.tenant.tenantId ||
    actor?.['account_id'] !== ctx.actor.accountId ||
    actor?.['session_id'] !== ctx.actor.sessionId ||
    actor?.['country_of_care'] !== ctx.tenant.countryOfCare
  )
    throw Object.assign(new Error('staff_unauthenticated'), { code: 'PT401' });
}
/**
 * Staff enrollment writes on the dedicated identity pool, with operator
 * authority enforced before the work, after it, before disclosing an
 * idempotency outcome — and AT COMMIT.
 *
 * The previous shape ran under withIdentityTransaction (which clears the
 * tenant binding at start and end) with nested withTenantContext /
 * withActorContext, then forced `identity_staff_enrollment_evidence`
 * IMMEDIATE. That trigger calls `identity_staff_operator(FALSE)` first and
 * last (migration 098), which reads `kms_current_actor_context()`; forcing it
 * IMMEDIATE consumed its event and the real COMMIT ran with no operator
 * re-validation — the deferred-authority-trigger defect class (PRs #302/#303/
 * #304, consent, forms). The shared primitive now owns the identity-pool
 * client: assertIdentityConnection() right after BEGIN, tenant + actor
 * bindings held live through COMMIT, and the deferred trigger fires there.
 * The operator check always takes its row share lock (the lock is idempotent
 * within the transaction); an unconfirmed COMMIT surfaces as PT503, which
 * staffFailure already maps to 503. Genuine SQL failures pass through
 * without another query into an aborted transaction.
 */
/** The exact authority the staff-enrollment writes run under. Exported for the real-Postgres COMMIT-authority regression. */
export function staffAuthority(ctx: StaffContext): CommitAuthority {
  return {
    tenantId: ctx.tenant.tenantId,
    nonce: ctx.nonce,
    afterBegin: (tx) => assertIdentityConnection(tx),
    assertLive: (tx) => assertStaffOperator(tx, ctx, true),
    unconfirmed: () =>
      Object.assign(new Error('identity.staff.commit_unconfirmed'), { code: 'PT503' }),
    discardEvent: 'identity.staff.recording_connection.discarded',
  };
}

export function staffTransaction(ctx: StaffContext) {
  return commitAuthorityTransaction(
    staffAuthority(ctx),
    () => identityPool() as unknown as CheckoutPool,
  );
}
export function staffFailure(error: unknown, reply: FastifyReply, requestId: string): boolean {
  const code = (error as { code?: string })?.code;
  const status =
    code === 'PT401'
      ? 401
      : code === '42501'
        ? 403
        : code === '22023'
          ? 400
          : code === '23505' || code === '23514'
            ? 409
            : 503;
  void reply.code(status).send({
    error: {
      code: 'identity.staff.unavailable',
      message: 'The staff operation is unavailable.',
      request_id: requestId,
    },
  });
  return true;
}

export function registerStaffEnrollmentRoutes(app: FastifyInstance) {
  app.post('/staff/enrollments', async (req, reply) => {
    const ctx = context(req, reply);
    const body = StaffEnrollmentSchema.safeParse(req.body);
    if (!body.success || !z.object({}).strict().safeParse(req.query).success)
      throw req.server.httpErrors.badRequest('Invalid staff enrollment request.');
    return withIdempotentExecution(
      req,
      reply,
      staffFailure,
      async (tx) => {
        const result = await tx.query<{ receipt: unknown }>(
          'SELECT public.identity_enroll_clinician($1,$2,$3,$4,$5) AS receipt',
          [
            ulid(),
            body.data.first_name,
            body.data.last_name,
            body.data.phone_e164,
            body.data.email,
          ],
        );
        const receipt = StaffEnrollmentReceiptSchema.parse(result.rows[0]?.receipt);
        await emitStaffEvidence(
          tx,
          ctx.tenant,
          ctx.actor.accountId,
          receipt.account_id,
          'enrolled',
        );
        return { status: 201, view: receipt };
      },
      staffTransaction(ctx),
      'identity_idempotency_keys',
    );
  });
  app.get('/staff/enrollments', async (req, reply) => {
    const ctx = context(req, reply);
    const query = StaffRosterQuerySchema.safeParse(req.query);
    if (!query.success) throw req.server.httpErrors.badRequest('Invalid staff roster request.');
    try {
      const view = await staffTransaction(ctx)(async (tx) => {
        const result = await tx.query<{ roster: unknown }>(
          'SELECT public.identity_staff_roster($1) AS roster',
          [query.data.offset ?? 0],
        );
        const roster = StaffRosterSchema.parse(result.rows[0]?.roster);
        await emitStaffEvidence(
          tx,
          ctx.tenant,
          ctx.actor.accountId,
          ctx.actor.accountId,
          'roster_read',
        );
        return roster;
      });
      return reply.send(view);
    } catch (error) {
      staffFailure(error, reply, req.id);
      return reply;
    }
  });
}
