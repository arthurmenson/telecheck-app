/** Patient-owned persisted history; no clinical plaintext or delegated chart access. */
import type { FastifyReply, FastifyRequest } from 'fastify';

import { withActorContext } from '../../../../lib/actor-context-binding.js';
import { requirePatientActorContext, UnauthenticatedError } from '../../../../lib/auth-context.js';
import { withTransaction, type DbTransaction } from '../../../../lib/db.js';
import { withTenantContext } from '../../../../lib/rls.js';
import { requireTenantContext } from '../../../../lib/tenant-context.js';
import { withDbRole } from '../../../../lib/with-db-role.js';

import { makeErrorEnvelope, pgErrorCode } from './v1-shared.js';

interface HistoryRow {
  consult_id: string;
  consult_type: string;
  created_at: string;
  current_state: string | null;
  decision_type: string | null;
  follow_up_message_count: string;
  last_transition_at: string | null;
}

export async function listConsultsV1Handler(req: FastifyRequest, reply: FastifyReply) {
  void reply.header('Cache-Control', 'no-store');
  const ctx = requireTenantContext(req);
  const actor = requirePatientActorContext(req);
  if (actor.delegateId !== null || !req.actorNonce) throw new UnauthenticatedError();
  const nonce = req.actorNonce;
  const query = (req.query ?? {}) as Record<string, unknown>;
  const limit = query['limit'] === undefined ? 25 : Number(query['limit']);
  const offset = query['offset'] === undefined ? 0 : Number(query['offset']);
  if (
    Object.keys(query).some((key) => key !== 'limit' && key !== 'offset') ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 100 ||
    !Number.isInteger(offset) ||
    offset < 0 ||
    offset > 10_000
  ) {
    return reply
      .code(400)
      .send(
        makeErrorEnvelope(
          req.id,
          'internal.request.invalid',
          'Use limit 1..100 and offset 0..10000.',
        ),
      );
  }

  async function requireLivePatient(tx: DbTransaction) {
    const result = await tx.query<{
      tenant_id: string;
      account_id: string;
      session_id: string;
      country_of_care: string;
    }>('SELECT * FROM public.async_consult_assert_live_patient()');
    const live = result.rows[0];
    if (
      result.rows.length !== 1 ||
      live?.tenant_id !== ctx.tenantId ||
      live.account_id !== actor.accountId ||
      live.session_id !== actor.sessionId ||
      live.country_of_care !== ctx.countryOfCare
    )
      throw new UnauthenticatedError();
  }

  try {
    const rows = await withTransaction(async (tx) => {
      await tx.query("SET LOCAL statement_timeout = '5s'");
      await tx.query("SET LOCAL lock_timeout = '2s'");
      return withTenantContext(tx, ctx.tenantId, async () => {
        const isolation = await tx.query<{ value: string }>(
          "SELECT pg_catalog.current_setting('transaction_isolation') AS value",
        );
        if (isolation.rows[0]?.value !== 'read committed') {
          throw req.server.httpErrors.serviceUnavailable('Consultation history is unavailable.');
        }
        return withActorContext(tx, nonce, () =>
          withDbRole(tx, 'async_consult_patient_reader', async () => {
            await requireLivePatient(tx);
            const result = await tx.query<HistoryRow>(
              `SELECT consult_id, consult_type, created_at, current_state, decision_type,
                  follow_up_message_count, last_transition_at
             FROM public.async_consult_patient_summary_v
            WHERE patient_id = $1
            ORDER BY created_at DESC, consult_id DESC LIMIT $2 OFFSET $3`,
              [actor.accountId, limit + 1, offset],
            );
            // Separate READ COMMITTED query, using clock_timestamp(): both
            // revocation and expiry during a blocked read deny disclosure.
            await requireLivePatient(tx);
            return result.rows;
          }),
        );
      });
    });
    return reply
      .code(200)
      .send({ rows: rows.slice(0, limit), limit, offset, has_more: rows.length > limit });
  } catch (error) {
    if (pgErrorCode(error) === 'PT401') throw new UnauthenticatedError();
    if (pgErrorCode(error) === 'PT503') {
      throw req.server.httpErrors.serviceUnavailable('Consultation history is unavailable.');
    }
    if (pgErrorCode(error) === '42501') {
      throw req.server.httpErrors.forbidden('Insufficient scope for this request.');
    }
    throw error;
  }
}
