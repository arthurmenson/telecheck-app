import type { FastifyReply, FastifyRequest } from 'fastify';

import {
  buildIdempotencyCtx,
  IdempotencyBodyMismatchError,
  IdempotencyInFlightError,
  IdempotencyReplayError,
  withIdempotency,
} from '../../../../lib/idempotency.js';
import { requireTenantContext } from '../../../../lib/tenant-context.js';
import { withIdentityTransaction } from '../database.js';
import {
  patientRefreshKeySchema,
  patientRefreshRequestSchema,
} from '../services/patient-refresh-contract.js';
import {
  assertCurrentPatientRotation,
  PatientRefreshUnavailable,
  rotatePatientSession,
} from '../services/patient-refresh-service.js';

export async function patientRefreshNoStore(
  _req: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  void reply.header('Cache-Control', 'no-store');
  void reply.header('Pragma', 'no-cache');
  void reply.header('Expires', '0');
}

export async function patientRefreshHandler(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<unknown> {
  const fail = (status: number, code: string, message: string) =>
    reply.code(status).send({ error: { code, message, request_id: req.id } });
  const parsed = patientRefreshRequestSchema.safeParse(req.body);
  if (
    !parsed.success ||
    !patientRefreshKeySchema.safeParse(req.headers['idempotency-key']).success ||
    Object.keys(req.query as Record<string, unknown>).length !== 0
  )
    return fail(
      400,
      'internal.request.invalid',
      'A refresh token and valid Idempotency-Key are required.',
    );
  const ctx = requireTenantContext(req);
  // Authentication is the opaque body credential, never an optional/stale bearer.
  const key = {
    ...buildIdempotencyCtx(req),
    actorId: 'anonymous',
    endpoint: '/v0/identity/sessions/refresh',
  };
  try {
    const body = await withIdentityTransaction(async (tx) => {
      await tx.query('SELECT set_tenant_context($1)', [ctx.tenantId]);
      let payload: unknown;
      try {
        payload = (
          await withIdempotency(
            tx,
            key,
            async () => ({
              status: 200,
              body: await rotatePatientSession(ctx, parsed.data.refresh_token, tx),
            }),
            'identity_idempotency_keys',
          )
        ).body;
      } catch (error) {
        if (!(error instanceof IdempotencyReplayError) || error.cachedStatus !== 200) throw error;
        payload = error.cachedBody;
      }
      const current = await assertCurrentPatientRotation(ctx, payload, tx);
      const cached = await tx.query<{ live: boolean }>(
        `SELECT EXISTS(SELECT 1 FROM identity_idempotency_keys WHERE tenant_id=$1 AND key=$2
          AND endpoint=$3 AND actor_id='anonymous' AND processing_state='completed'
          AND expires_at>clock_timestamp()) AS live`,
        [ctx.tenantId, key.idempotencyKey, key.endpoint],
      );
      if (cached.rows[0]?.live !== true) throw new PatientRefreshUnavailable();
      return current;
    });
    return reply.code(200).send(body);
  } catch (error) {
    if (error instanceof PatientRefreshUnavailable || error instanceof IdempotencyReplayError)
      return fail(
        401,
        'identity.session.invalid_or_expired',
        'Refresh token is invalid or expired.',
      );
    if (error instanceof IdempotencyBodyMismatchError)
      return fail(
        409,
        'internal.idempotency.body_mismatch',
        'Idempotency key already used with a different request body.',
      );
    if (error instanceof IdempotencyInFlightError)
      return fail(
        409,
        'internal.idempotency.in_flight',
        'The request is still being processed. Retry with the same key.',
      );
    return fail(
      503,
      'identity.authentication.unavailable',
      'Authentication is temporarily unavailable. Please try again.',
    );
  }
}
