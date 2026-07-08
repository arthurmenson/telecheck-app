/**
 * async-consult/internal/handlers/follow-up-messages-v1.ts —
 *   POST /v1/async-consults/:consult_id/follow-up-messages (endpoint #10)
 *   GET  /v1/async-consults/:consult_id/follow-up-messages (endpoint #11)
 *
 * OpenAPI v0.4 (RATIFIED P-038 §7) rows 10 + 11: patient ↔ clinician
 * follow-up messaging on a consult, backed by the strict-append-only
 * `consult_follow_up_message` entity (migration 056 §7; CDM v1.9
 * §4.NEW7).
 *
 * **No wrapper procedure is spec'd for this table** (P-038 §3 lists no
 * follow-up-message procedure) — writes use the canonical direct-INSERT
 * composition under the sending caller class's slice role, exactly as
 * migration 056 §7's grant comment prescribes (Med-Interaction PR-8
 * create-evaluation precedent):
 *
 *   - patient sender  → withDbRole('async_consult_patient_initiator')
 *   - clinician sender → withDbRole('async_consult_clinician_reviewer')
 *
 * **Ownership enforcement:**
 *   - patient: patient_id is pinned to the SI-010 actor identity — a
 *     patient can only attach messages to their own consult (the
 *     3-column composite FK (tenant_id, consult_id, patient_id) →
 *     consult rejects any other pairing tenant-blindly, 23503 → 409).
 *   - clinician: supplies patient_id from the consult read (binding
 *     hint, not trust anchor — same posture as the decision handler);
 *     the composite FK validates the pairing.
 *   - sender_account_id is ALWAYS the SI-010 actor (never body-supplied);
 *     the 2-column FK (tenant_id, sender_account_id) → accounts keeps it
 *     tenant-real.
 *
 * **Read path (#11):** ratified caller classes are patient / clinician /
 * admin. Migration 056 §7 grants SELECT to the patient + clinician slice
 * roles ONLY — there is no ratified admin SELECT grant on this table, so
 * the admin caller class FAILS CLOSED (403) until a grant migration is
 * ratified (documented gap; do NOT widen unilaterally per the
 * spec-leads-implementation floor). Patient reads are self-scoped
 * app-side (WHERE patient_id = actor) on top of RLS tenant scoping;
 * zero rows → empty list (tenant-blind; a non-owned consult is
 * indistinguishable from a message-less one, I-025).
 *
 * **KMS envelope posture:** message bodies arrive/return PRE-ENCRYPTED
 * as the 8-field envelope (I-026; v1-shared.ts posture — app-side
 * encryption is the standing hardening TODO). GET returns the sealed
 * envelope for client-side decryption.
 *
 * Audit: Cat C `async_consult.follow_up_message_sent` same-tx with the
 * INSERT (AUDIT_EVENTS v5.11 row 15; not sampled — PHI-relevant). Reads
 * emit no audit (read-only precedent).
 *
 * Spec references: migration 056 §7, P-038 §7 endpoints 10-11,
 * AUDIT_EVENTS v5.11 row 15, I-003, I-023, I-025, I-026, I-027, I-035.
 */

import type { FastifyReply, FastifyRequest } from 'fastify';

import { withActorContext } from '../../../../lib/actor-context-binding.js';
import {
  requireActorContext,
  resolveActorTenantIdForAudit,
  UnauthorizedRoleError,
} from '../../../../lib/auth-context.js';
import { withTransaction } from '../../../../lib/db.js';
import { withIdempotentExecution } from '../../../../lib/idempotent-handler.js';
import { withTenantContext } from '../../../../lib/rls.js';
import { requireTenantContext } from '../../../../lib/tenant-context.js';
import { ulid } from '../../../../lib/ulid.js';
import { withDbRole, type SliceRole } from '../../../../lib/with-db-role.js';
import { emitAsyncConsultFollowUpMessageSentAudit } from '../../audit.js';

import {
  decodeKmsEnvelope,
  isUlid,
  makeErrorEnvelope,
  pgErrorCode,
  type ErrorEnvelopeBody,
} from './v1-shared.js';

const SENDER_SLICE_ROLE: Record<'patient' | 'clinician', SliceRole> = {
  patient: 'async_consult_patient_initiator',
  clinician: 'async_consult_clinician_reviewer',
};

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

interface SendFollowUpMessageV1Body {
  patient_id?: string;
  message_envelope?: unknown;
}

function mapSendServiceError(err: unknown, reply: FastifyReply, reqId: string): boolean {
  const code = pgErrorCode(err);
  if (code === '23503') {
    // Composite FK: (consult, patient) pairing or sender account does
    // not reference a tenant-real row. Tenant-blind 409 (I-025) — do
    // not differentiate which reference failed.
    void reply
      .code(409)
      .send(
        makeErrorEnvelope(
          reqId,
          'internal.resource.conflict',
          'Message does not match an eligible consult for this account.',
        ),
      );
    return true;
  }
  return false;
}

interface SendFollowUpMessageV1View {
  message_id: string;
}

/** POST /v1/async-consults/:consult_id/follow-up-messages (endpoint #10). */
export async function sendFollowUpMessageV1Handler(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<unknown> {
  const ctx = requireTenantContext(req);

  // Layer B — patient or clinician senders only (P-038 §7 row 10).
  // Delegate-principal sends are deferred with the same Consent-slice
  // primitive gap the initiate route documents (fail closed).
  const actor = requireActorContext(req);
  if (actor.role !== 'patient' && actor.role !== 'clinician') {
    throw new UnauthorizedRoleError(['patient', 'clinician'], actor.role);
  }
  if (actor.role === 'patient' && actor.delegateId !== null) {
    throw req.server.httpErrors.forbidden(
      'Delegate follow-up messaging is not yet supported on this endpoint.',
    );
  }
  const senderRole = actor.role;

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

  // Body validation. patient_id resolution is caller-class-split:
  //   - patient: pinned to the SI-010 actor; a body-supplied patient_id
  //     that disagrees is a 400 (self-scoping is not caller-overridable).
  //   - clinician: required in the body (binding hint; FK-validated).
  const body = (req.body ?? {}) as SendFollowUpMessageV1Body;
  const envelope = decodeKmsEnvelope(body.message_envelope);
  let patientId: string;
  if (senderRole === 'patient') {
    if (body.patient_id !== undefined && body.patient_id !== actor.accountId) {
      return reply
        .code(400)
        .send(
          makeErrorEnvelope(
            req.id,
            'internal.request.invalid',
            'patient_id must be omitted (or match the authenticated patient) on ' +
              'patient-sent messages.',
          ),
        );
    }
    patientId = actor.accountId;
  } else {
    if (!isUlid(body.patient_id)) {
      return reply
        .code(400)
        .send(
          makeErrorEnvelope(
            req.id,
            'internal.request.invalid',
            'patient_id (26-char ULID) is required on clinician-sent messages.',
          ),
        );
    }
    patientId = body.patient_id;
  }
  if (envelope === null) {
    return reply
      .code(400)
      .send(
        makeErrorEnvelope(
          req.id,
          'internal.request.invalid',
          'Invalid message body: a complete message_envelope (ciphertext_b64, dek_id, ' +
            'iv_b64, tag_b64, alg, alg_version, aad_b64, encrypted_at) is required.',
        ),
      );
  }

  const actorTenantId = resolveActorTenantIdForAudit(req, ctx.tenantId);
  const actorNonce = req.actorNonce;

  return withIdempotentExecution<SendFollowUpMessageV1View | ErrorEnvelopeBody>(
    req,
    reply,
    mapSendServiceError,
    async (tx) => {
      const messageId = ulid();

      await withTenantContext(tx, ctx.tenantId, async () => {
        const runInsert = async (): Promise<void> => {
          try {
            await withDbRole(tx, SENDER_SLICE_ROLE[senderRole], async () => {
              await tx.query(
                `INSERT INTO consult_follow_up_message (
                   id, tenant_id, consult_id, patient_id, sender_role, sender_account_id,
                   message_ciphertext, message_kms_envelope_dek_id, message_kms_envelope_iv,
                   message_kms_envelope_tag, message_kms_envelope_alg,
                   message_kms_envelope_alg_version, message_kms_envelope_aad,
                   message_kms_envelope_encrypted_at
                 ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
                [
                  messageId,
                  ctx.tenantId,
                  consultId,
                  patientId,
                  senderRole,
                  actor.accountId, // sender_account_id — SI-010 actor, never body-supplied
                  envelope.ciphertext,
                  envelope.dekId,
                  envelope.iv,
                  envelope.tag,
                  envelope.alg,
                  envelope.algVersion,
                  envelope.aad,
                  envelope.encryptedAt.toISOString(),
                ],
              );
            });
          } catch (err) {
            if (pgErrorCode(err) === '42501') {
              throw req.server.httpErrors.forbidden('Insufficient scope for this request.');
            }
            throw err;
          }
        };

        if (typeof actorNonce === 'string' && actorNonce.length > 0) {
          await withActorContext(tx, actorNonce, runInsert);
        } else {
          await runInsert();
        }
      });

      // Same-tx Cat C audit under the restored app role (I-003).
      await emitAsyncConsultFollowUpMessageSentAudit(
        {
          tenantId: ctx.tenantId,
          messageId,
          consultId,
          patientId,
          senderRole,
          senderAccountId: actor.accountId,
          actorTenantId,
          countryOfCare: ctx.countryOfCare,
        },
        tx,
      );

      return {
        status: 201,
        view: { message_id: messageId },
      };
    },
  );
}

interface FollowUpMessageRow {
  message_id: string;
  sender_role: string;
  sender_account_id: string;
  message_envelope: {
    ciphertext_b64: string;
    dek_id: string;
    iv_b64: string;
    tag_b64: string;
    alg: string;
    alg_version: string;
    aad_b64: string;
    encrypted_at: string;
  };
  sent_at: string;
}

interface FollowUpMessageDbRow {
  id: string;
  sender_role: string;
  sender_account_id: string;
  message_ciphertext: Buffer;
  message_kms_envelope_dek_id: string;
  message_kms_envelope_iv: Buffer;
  message_kms_envelope_tag: Buffer;
  message_kms_envelope_alg: string;
  message_kms_envelope_alg_version: string;
  message_kms_envelope_aad: Buffer;
  message_kms_envelope_encrypted_at: string;
  sent_at: string;
}

function toWireRow(row: FollowUpMessageDbRow): FollowUpMessageRow {
  return {
    message_id: row.id,
    sender_role: row.sender_role,
    sender_account_id: row.sender_account_id,
    message_envelope: {
      ciphertext_b64: Buffer.from(row.message_ciphertext).toString('base64'),
      dek_id: row.message_kms_envelope_dek_id,
      iv_b64: Buffer.from(row.message_kms_envelope_iv).toString('base64'),
      tag_b64: Buffer.from(row.message_kms_envelope_tag).toString('base64'),
      alg: row.message_kms_envelope_alg,
      alg_version: row.message_kms_envelope_alg_version,
      aad_b64: Buffer.from(row.message_kms_envelope_aad).toString('base64'),
      encrypted_at: new Date(row.message_kms_envelope_encrypted_at).toISOString(),
    },
    sent_at: new Date(row.sent_at).toISOString(),
  };
}

/** GET /v1/async-consults/:consult_id/follow-up-messages (endpoint #11). */
export async function listFollowUpMessagesV1Handler(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<unknown> {
  const ctx = requireTenantContext(req);

  // Layer B — the ratified caller classes are patient / clinician /
  // admin, but migration 056 §7 grants SELECT only to the patient +
  // clinician slice roles. Admin callers fail closed (403) until a
  // SELECT-grant migration is ratified — see file docstring.
  const actor = requireActorContext(req);
  if (actor.role !== 'patient' && actor.role !== 'clinician') {
    throw new UnauthorizedRoleError(['patient', 'clinician'], actor.role);
  }
  const readerRole = actor.role;

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

  const rows = await withTransaction<FollowUpMessageDbRow[]>(async (tx) => {
    return withTenantContext(tx, ctx.tenantId, async () => {
      const runRead = async (): Promise<FollowUpMessageDbRow[]> => {
        try {
          return await withDbRole(tx, SENDER_SLICE_ROLE[readerRole], async () => {
            // Patient reads are self-scoped app-side (patient_id =
            // actor) on top of RLS tenant scoping; clinician reads are
            // tenant-wide per the staff review model. tenant_id is not
            // projected (I-025).
            const projection = `SELECT id, sender_role, sender_account_id,
                      message_ciphertext, message_kms_envelope_dek_id,
                      message_kms_envelope_iv, message_kms_envelope_tag,
                      message_kms_envelope_alg, message_kms_envelope_alg_version,
                      message_kms_envelope_aad, message_kms_envelope_encrypted_at,
                      sent_at
                 FROM consult_follow_up_message`;
            const result =
              readerRole === 'patient'
                ? await tx.query<FollowUpMessageDbRow>(
                    `${projection}
                WHERE tenant_id = $1 AND consult_id = $2 AND patient_id = $3
                ORDER BY sent_at ASC, id ASC
                LIMIT $4 OFFSET $5`,
                    [ctx.tenantId, consultId, actor.accountId, limit, offset],
                  )
                : await tx.query<FollowUpMessageDbRow>(
                    `${projection}
                WHERE tenant_id = $1 AND consult_id = $2
                ORDER BY sent_at ASC, id ASC
                LIMIT $3 OFFSET $4`,
                    [ctx.tenantId, consultId, limit, offset],
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

      if (typeof req.actorNonce === 'string' && req.actorNonce.length > 0) {
        return withActorContext(tx, req.actorNonce, runRead);
      }
      return runRead();
    });
  });

  return reply.code(200).send({
    rows: rows.map(toWireRow),
    limit,
    offset,
  });
}
