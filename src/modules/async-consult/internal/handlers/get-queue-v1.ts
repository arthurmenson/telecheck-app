/**
 * async-consult/internal/handlers/get-queue-v1.ts —
 *   GET /v1/async-consults/queue — staff review-queue read from the
 *   `async_consult_staff_summary_v` derived view (migration 057 §1)
 *   under withDbRole('async_consult_staff_reader').
 *
 * Composition (canonical read stack; admin-backend
 * get-crisis-operational-health precedent):
 *   withTransaction → withTenantContext → [withActorContext] →
 *   withDbRole('async_consult_staff_reader') → SELECT ... FROM view.
 *
 * The view is security_invoker=true + security_barrier=true — the SELECT
 * executes with the reader role's privileges, so base-table RLS + the
 * P-040 column-level grants (migration 057 §3) enforce the
 * data-minimization boundary regardless of what this handler projects.
 *
 * **Caller class (Layer B):** staff only — clinician / tenant_admin /
 * platform_admin. Patient and delegate principals are rejected 403
 * (P-038 R5 HIGH-1 caller-class split: tenant-wide queue metadata would
 * leak other patients' consults). TODO(RBAC widening): the ratified
 * staff set includes pharmacy operators; the ActorRole union does not
 * yet carry a pharmacist role — the pharmacy branch lands with the RBAC
 * v1.1 JWT-role widening.
 *
 * Read-only — NO audit emission (med-interaction GET /signals/:id
 * precedent; the slice audit catalog attests writes).
 *
 * Endpoint contract:
 *   Method   GET
 *   Path     /v1/async-consults/queue?limit=25&offset=0
 *   Query    limit  — 1..100 (default 25)
 *            offset — >= 0   (default 0)
 *   Returns  200 + { rows: [...], limit, offset } — rows carry
 *            consult_id, patient_id, consult_type, created_at,
 *            current_state, decision_type, prescribing_count,
 *            follow_up_message_count, last_transition_at.
 *            tenant_id is projected by the view but STRIPPED from the
 *            HTTP response (I-025 / never render tenant.id).
 *            400 on malformed pagination; 401/403 per Layer B; 403 on 42501.
 *
 * Spec references: migration 057 §1+§3, I-023, I-025, P-038 §4.NEW8.
 */

import type { FastifyReply, FastifyRequest } from 'fastify';

import { withActorContext } from '../../../../lib/actor-context-binding.js';
import { requireActorContext, UnauthorizedRoleError } from '../../../../lib/auth-context.js';
import { withTransaction } from '../../../../lib/db.js';
import { withTenantContext } from '../../../../lib/rls.js';
import { requireTenantContext } from '../../../../lib/tenant-context.js';
import { withDbRole } from '../../../../lib/with-db-role.js';

import { makeErrorEnvelope, pgErrorCode } from './v1-shared.js';

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

/** Row shape projected from async_consult_staff_summary_v (BIGINT counts
 * surface as strings via the pg driver; passed through verbatim per the
 * admin-backend convention). */
interface QueueRow {
  consult_id: string;
  patient_id: string;
  consult_type: string;
  created_at: string;
  current_state: string | null;
  decision_type: string | null;
  prescribing_count: string;
  follow_up_message_count: string;
  last_transition_at: string | null;
}

export interface GetQueueV1Response {
  rows: QueueRow[];
  limit: number;
  offset: number;
}

const STAFF_ROLES: ReadonlySet<string> = new Set(['clinician', 'tenant_admin', 'platform_admin']);

export async function getQueueV1Handler(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<unknown> {
  const ctx = requireTenantContext(req);

  // Layer B — staff callers only.
  const actor = requireActorContext(req);
  if (!STAFF_ROLES.has(actor.role)) {
    throw new UnauthorizedRoleError(['clinician', 'tenant_admin', 'platform_admin'], actor.role);
  }

  // Pagination validation (capped).
  const query = (req.query ?? {}) as { limit?: string; offset?: string };
  const limit = query.limit === undefined ? DEFAULT_LIMIT : Number(query.limit);
  const offset = query.offset === undefined ? 0 : Number(query.offset);
  if (
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > MAX_LIMIT ||
    !Number.isInteger(offset) ||
    offset < 0
  ) {
    return reply
      .code(400)
      .send(
        makeErrorEnvelope(
          req.id,
          'internal.request.invalid',
          `Invalid pagination: limit must be an integer 1..${MAX_LIMIT}; offset must be a non-negative integer.`,
        ),
      );
  }

  const rows = await withTransaction<QueueRow[]>(async (tx) => {
    return withTenantContext(tx, ctx.tenantId, async () => {
      const runRead = async (): Promise<QueueRow[]> => {
        try {
          return await withDbRole(tx, 'async_consult_staff_reader', async () => {
            // tenant_id is intentionally NOT projected (I-025 / never
            // render tenant.id); the view's current_tenant_id() predicate
            // already scopes rows to the bound tenant.
            const result = await tx.query<QueueRow>(
              `SELECT consult_id, patient_id, consult_type, created_at,
                      current_state, decision_type, prescribing_count,
                      follow_up_message_count, last_transition_at
                 FROM async_consult_staff_summary_v
                ORDER BY last_transition_at DESC NULLS LAST, consult_id DESC
                LIMIT $1 OFFSET $2`,
              [limit, offset],
            );
            return result.rows;
          });
        } catch (err) {
          if (pgErrorCode(err) === '42501') {
            throw req.server.httpErrors.forbidden('Insufficient scope for this request.');
          }
          throw err;
        }
      };

      if (req.actorNonce !== undefined) {
        return withActorContext(tx, req.actorNonce, runRead);
      }
      return runRead();
    });
  });

  return reply.code(200).send({ rows, limit, offset } satisfies GetQueueV1Response);
}
