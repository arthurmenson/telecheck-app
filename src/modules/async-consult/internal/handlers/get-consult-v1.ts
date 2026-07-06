/**
 * async-consult/internal/handlers/get-consult-v1.ts —
 *   GET /v1/async-consults/:consult_id — caller-class-routed single
 *   consult read (migration 057 derived views).
 *
 * Caller-class routing (P-038 R5 HIGH-1 split; NO cross-class access):
 *   - patient (incl. a patient acting as delegate) →
 *       async_consult_patient_summary_v under
 *       withDbRole('async_consult_patient_reader'). The view's own
 *       predicate enforces self-scoping: patient principal via SI-010
 *       actor identity, delegate principal via an active book_consults
 *       delegation (migration 057 §2) — the handler does NOT need a
 *       delegate-detection primitive on the read path.
 *   - clinician / tenant_admin / platform_admin →
 *       async_consult_staff_summary_v under
 *       withDbRole('async_consult_staff_reader').
 *
 * Zero rows → tenant-blind 404 (I-025): absent, cross-tenant, and
 * not-authorized-for-caller all produce the identical response.
 *
 * Composition: withTransaction → withTenantContext → [withActorContext]
 * → withDbRole(<caller-class reader>) → SELECT ... WHERE consult_id = $1.
 * Read-only — no audit emission.
 *
 * Endpoint contract:
 *   Method   GET
 *   Path     /v1/async-consults/:consult_id
 *   Returns  200 + consult summary row (tenant_id stripped)
 *            400 malformed consult_id; 401 unauthenticated;
 *            403 on 42501; 404 tenant-blind on zero rows
 *
 * Spec references: migration 057 §1+§2, I-023, I-025, P-038 §4.NEW8.
 */

import type { FastifyReply, FastifyRequest } from 'fastify';

import { withActorContext } from '../../../../lib/actor-context-binding.js';
import { requireActorContext } from '../../../../lib/auth-context.js';
import { withTransaction } from '../../../../lib/db.js';
import { withTenantContext } from '../../../../lib/rls.js';
import { requireTenantContext } from '../../../../lib/tenant-context.js';
import { withDbRole, type SliceRole } from '../../../../lib/with-db-role.js';

import { isUlid, makeErrorEnvelope, pgErrorCode } from './v1-shared.js';

interface ConsultSummaryRow {
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

export async function getConsultV1Handler(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<unknown> {
  const ctx = requireTenantContext(req);

  // Layer B — any authenticated actor; the caller class picks the view +
  // reader role. NO cross-class access: patients can never read the
  // staff view and staff can never read the patient view (the reader
  // roles' SELECT grants enforce this at the DB layer too — migration
  // 057 §4 cross-class grant check).
  const actor = requireActorContext(req);
  const isPatientClass = actor.role === 'patient';
  const readerRole: SliceRole = isPatientClass
    ? 'async_consult_patient_reader'
    : 'async_consult_staff_reader';
  const viewName = isPatientClass
    ? 'async_consult_patient_summary_v'
    : 'async_consult_staff_summary_v';

  const params = (req.params ?? {}) as { consult_id?: string };
  if (!isUlid(params.consult_id)) {
    return reply
      .code(400)
      .send(
        makeErrorEnvelope(
          req.id,
          'internal.request.invalid',
          'Path parameter consult_id must be a 26-char ULID.',
        ),
      );
  }
  const consultId = params.consult_id;

  const rows = await withTransaction<ConsultSummaryRow[]>(async (tx) => {
    return withTenantContext(tx, ctx.tenantId, async () => {
      const runRead = async (): Promise<ConsultSummaryRow[]> => {
        try {
          return await withDbRole(tx, readerRole, async () => {
            // viewName is a two-value literal selected above — never
            // caller-controlled input (identifier interpolation is safe
            // for the same reason withDbRole's allowlist is).
            const result = await tx.query<ConsultSummaryRow>(
              `SELECT consult_id, patient_id, consult_type, created_at,
                      current_state, decision_type, prescribing_count,
                      follow_up_message_count, last_transition_at
                 FROM ${viewName}
                WHERE consult_id = $1`,
              [consultId],
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

  const row = rows[0];
  if (row === undefined) {
    // Tenant-blind 404 (I-025): absent, cross-tenant, and
    // not-authorized-for-this-caller are indistinguishable.
    return reply
      .code(404)
      .send(makeErrorEnvelope(req.id, 'internal.resource.not_found', 'Consult not found.'));
  }

  return reply.code(200).send(row);
}
