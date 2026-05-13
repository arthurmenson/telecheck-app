/**
 * prescriptions.ts — Pharmacy slice HTTP read handlers per Sprint 35-36 /
 * TLC-055 PR C.
 *
 * Routes (mounted under /v0/pharmacy by routes.ts):
 *
 *   GET /v0/pharmacy/prescriptions/:id
 *     Auth: Bearer JWT
 *     Returns: 200 + PHI-safe MedicationRequest view
 *              404 (tenant-blind) on not-found / cross-tenant / cross-patient / malformed id
 *
 *   GET /v0/pharmacy/patients/:patientId/prescriptions
 *     Auth: Bearer JWT
 *     Query: ?status=<MedicationRequestStatus>  (optional)
 *            ?limit=<n>                         (optional, default 50, cap 500)
 *     Returns: 200 + { prescriptions: PHI-safe MedicationRequest[] }
 *              400 on invalid query params
 *              404 (tenant-blind) on cross-patient access
 *
 * NOT exposed at PR C (deferred to PR D when the service layer + write
 * surface land together):
 *   - POST /v0/pharmacy/prescriptions/draft
 *   - POST /v0/pharmacy/prescriptions/:id/submit
 *   - POST /v0/pharmacy/prescriptions/:id/transitions
 *   - POST /v0/pharmacy/prescriptions/:id/supersede
 *
 * Deliberate scope decisions for this PR:
 *
 *   1. NO service layer — read handlers call the repo directly. The
 *      async-consult precedent uses a service layer because every endpoint
 *      is a state-mutating write that has to compose audit emission +
 *      domain events + idempotency atomically. Reads need none of those,
 *      so injecting a thin pass-through service module would be ceremonial.
 *      PR D introduces the service layer when the first write handler
 *      lands.
 *
 *   2. NO audit emission for reads. AUDIT_EVENTS v5.3 does not require
 *      Category C read events at the HTTP read-handler layer. Adding it
 *      here would couple read latency to the audit chain insert + violate
 *      the "audit what changed" discipline.
 *
 *   3. Authorization rule for the list endpoint: patient-self-only. JWTs
 *      at v1.0 only carry `role: 'patient'` (see ActorContext); a
 *      clinician role would widen this rule but does not exist yet. So a
 *      request where `actor.accountId !== params.patientId` is rejected
 *      with tenant-blind 404 — matches the cross-patient-blind precedent
 *      from async-consult's ConsultPatientOwnershipError → 404 mapping
 *      (Codex async-consult-r9 closure 2026-05-05).
 *
 *   4. Malformed id → 404 (NOT 400). Distinguishing "malformed id" from
 *      "well-formed id that doesn't exist in your tenant" is a side
 *      channel that an attacker could use to learn id-shape conventions
 *      for other tenants. I-025 tenant-blind error envelopes require both
 *      conditions to look identical to the caller.
 *
 * Spec references:
 *   - Pharmacy + Refill Slice PRD v2.1 §8
 *   - CDM v1.3 §4.16 MedicationRequest
 *   - State Machines v1.2 §19
 *   - ERROR_MODEL v5.1 (envelope shape + canonical codes)
 *   - I-023 / I-027 (three-layer tenant isolation; tenant_id on every record)
 *   - I-025 (tenant-blind error envelopes — DO NOT leak cross-tenant
 *           existence; cross-patient ownership errors map to 404 not 403)
 *   - Master PRD v1.10 §17 + Glossary v5.2 C3 (no tenant_id in patient-facing views)
 *   - AUDIT_EVENTS v5.3 (Category C reads not required at HTTP layer here)
 */

import type { FastifyReply, FastifyRequest } from 'fastify';

import { UnauthenticatedError, requireActorContext } from '../../../../lib/auth-context.js';
import { GlossaryViolationError, asMedicationRequestId } from '../../../../lib/glossary.js';
import { requireTenantContext } from '../../../../lib/tenant-context.js';
import { asSessionId, findActiveSessionById } from '../../../identity/index.js';
import * as medicationRequestRepo from '../repositories/medication-request-repo.js';
import type { MedicationRequest, MedicationRequestStatus } from '../types.js';

// ---------------------------------------------------------------------------
// Session-liveness guard (Codex PR-116 R1 HIGH closure)
//
// Closes a pre-existing platform gap surfaced by the new pharmacy PHI
// read surface: `requireActorContext()` only validates JWT signature,
// expiry, and tenant match — it does NOT check that the JWT's session_id
// claim corresponds to a still-active session row. A token from a
// revoked or deleted session, or any validly-signed token with a
// fabricated session_id, would otherwise read patient medication_request
// rows until JWT expiry (TTL-bounded ≠ immediate revocation).
//
// `requireLiveSession` is the per-handler defense-in-depth: it calls
// `requireActorContext()`, then resolves the session via the identity
// module's `findActiveSessionById` (filters revoked_at + expires_at at
// the SQL layer). If the lookup returns null, throw
// `UnauthenticatedError` so the error envelope plugin renders a
// tenant-blind 401. By I-025 the three null causes (revoked / expired /
// nonexistent) MUST collapse to a single envelope.
//
// Architectural note (intentional scope decision): the canonical fix is
// to move the liveness check into `authContextPlugin` so EVERY handler
// using `requireActorContext` benefits — but that is a cross-cutting
// auth change affecting async-consult / consent / identity test
// harnesses that mint synthetic JWTs without seeding session rows. PR C
// closes the gap at the pharmacy-handler layer (the new PHI surface).
// The platform-wide migration is a follow-on (tracked as the next
// auth-context hardening pass).
// ---------------------------------------------------------------------------

async function requireLiveSession(req: FastifyRequest): Promise<{
  ctx: ReturnType<typeof requireTenantContext>;
  actor: ReturnType<typeof requireActorContext>;
}> {
  const ctx = requireTenantContext(req);
  const actor = requireActorContext(req);
  const live = await findActiveSessionById(ctx, asSessionId(actor.sessionId));
  if (live === null) {
    throw new UnauthenticatedError();
  }
  return { ctx, actor };
}

// ---------------------------------------------------------------------------
// PHI-safe view: strip tenant_id per Master PRD §17 + Glossary v5.2 C3
// ---------------------------------------------------------------------------

type PatientMedicationRequestView = Omit<MedicationRequest, 'tenant_id'>;

function toPatientMedicationRequestView(mr: MedicationRequest): PatientMedicationRequestView {
  const { tenant_id: _stripped, ...patientView } = mr;
  void _stripped;
  return patientView;
}

// ---------------------------------------------------------------------------
// Error envelope (canonical codes per ERROR_MODEL v5.1)
// ---------------------------------------------------------------------------

interface ErrorEnvelopeBody {
  error: {
    code: string;
    message: string;
    request_id: string;
  };
}

function makeErrorEnvelope(reqId: string, code: string, message: string): ErrorEnvelopeBody {
  return { error: { code, message, request_id: reqId } };
}

/**
 * Canonical message for tenant-blind / cross-patient-blind 404. Identical
 * string across all four conditions (not-found, cross-tenant, cross-patient,
 * malformed id) — the caller MUST NOT be able to distinguish them.
 */
const NOT_FOUND_MESSAGE = 'Medication request not found.';

// ---------------------------------------------------------------------------
// Query param validation
// ---------------------------------------------------------------------------

const VALID_STATUSES: ReadonlySet<MedicationRequestStatus> = new Set<MedicationRequestStatus>([
  'draft',
  'pending_interaction_check',
  'pending_clinician_review',
  'active',
  'discontinued',
  'superseded',
  'expired',
  'rejected',
]);

interface ListQuery {
  status?: string;
  limit?: string;
}

interface ParsedListQuery {
  status: MedicationRequestStatus | undefined;
  limit: number | undefined;
}

type ParseResult = { ok: true; value: ParsedListQuery } | { ok: false; message: string };

/**
 * Parse + validate list-endpoint query params.
 *
 * - `status`: optional; must be one of MedicationRequestStatus.
 * - `limit`: optional; must be a positive integer. The repo clamps to
 *   [1, 500] internally so an oversized value is NOT a 400 — only
 *   non-numeric / non-integer / non-positive values are rejected.
 */
function parseListQuery(raw: ListQuery): ParseResult {
  let status: MedicationRequestStatus | undefined;
  if (raw.status !== undefined) {
    if (typeof raw.status !== 'string') {
      return { ok: false, message: 'Invalid query param: status must be a string.' };
    }
    if (!VALID_STATUSES.has(raw.status as MedicationRequestStatus)) {
      return {
        ok: false,
        message:
          'Invalid query param: status must be one of ' +
          'draft | pending_interaction_check | pending_clinician_review | ' +
          'active | discontinued | superseded | expired | rejected.',
      };
    }
    status = raw.status as MedicationRequestStatus;
  }

  let limit: number | undefined;
  if (raw.limit !== undefined) {
    if (typeof raw.limit !== 'string') {
      return { ok: false, message: 'Invalid query param: limit must be a positive integer.' };
    }
    // Require strict integer form — `parseInt('abc', 10)` returns NaN
    // which the check below catches, but `parseInt('10.5', 10)` returns
    // 10, which we want to reject as malformed. Regex enforces digits-only.
    if (!/^\d+$/.test(raw.limit)) {
      return { ok: false, message: 'Invalid query param: limit must be a positive integer.' };
    }
    const parsed = Number.parseInt(raw.limit, 10);
    if (!Number.isFinite(parsed) || parsed < 1) {
      return { ok: false, message: 'Invalid query param: limit must be a positive integer.' };
    }
    limit = parsed;
  }

  return { ok: true, value: { status, limit } };
}

// ---------------------------------------------------------------------------
// GET /v0/pharmacy/prescriptions/:id
// ---------------------------------------------------------------------------

export async function getMedicationRequestByIdHandler(
  req: FastifyRequest<{ Params: { id: string } }>,
  reply: FastifyReply,
): Promise<unknown> {
  const { ctx, actor } = await requireLiveSession(req);

  // Validate the id at the boundary. A malformed id MUST produce the
  // SAME 404 envelope as a well-formed-but-not-found id — otherwise an
  // attacker can side-channel id-shape conventions from another tenant
  // (I-025).
  let id;
  try {
    id = asMedicationRequestId(req.params.id);
  } catch (err) {
    if (err instanceof GlossaryViolationError) {
      return reply
        .code(404)
        .send(makeErrorEnvelope(req.id, 'internal.resource.not_found', NOT_FOUND_MESSAGE));
    }
    throw err;
  }

  const mr = await medicationRequestRepo.findById(ctx.tenantId, id);

  // Tenant-blind 404 — not-found and cross-tenant (RLS filtered) both
  // emit the same envelope from this branch.
  if (mr === null) {
    return reply
      .code(404)
      .send(makeErrorEnvelope(req.id, 'internal.resource.not_found', NOT_FOUND_MESSAGE));
  }

  // Cross-patient-blind 404. The row exists in the actor's tenant, but
  // belongs to a different patient. I-025 forbids leaking "exists but
  // not yours" to a same-tenant attacker; the cross-patient case must
  // be indistinguishable from not-found.
  if (mr.patient_account_id !== actor.accountId) {
    return reply
      .code(404)
      .send(makeErrorEnvelope(req.id, 'internal.resource.not_found', NOT_FOUND_MESSAGE));
  }

  return reply.code(200).send(toPatientMedicationRequestView(mr));
}

// ---------------------------------------------------------------------------
// GET /v0/pharmacy/patients/:patientId/prescriptions
// ---------------------------------------------------------------------------

export async function listMedicationRequestsForPatientHandler(
  req: FastifyRequest<{ Params: { patientId: string }; Querystring: ListQuery }>,
  reply: FastifyReply,
): Promise<unknown> {
  const { ctx, actor } = await requireLiveSession(req);

  // Authorization (patient-self-only at v1.0; widens when clinician role
  // lands). Cross-patient → 404 tenant-blind, identical envelope to
  // every other not-found case so a same-tenant attacker cannot
  // distinguish "this patient exists, you can't see them" from "no
  // such patient".
  if (req.params.patientId !== actor.accountId) {
    return reply
      .code(404)
      .send(makeErrorEnvelope(req.id, 'internal.resource.not_found', NOT_FOUND_MESSAGE));
  }

  const parsed = parseListQuery(req.query);
  if (!parsed.ok) {
    return reply
      .code(400)
      .send(makeErrorEnvelope(req.id, 'internal.request.invalid', parsed.message));
  }

  const options: { status?: MedicationRequestStatus; limit?: number } = {};
  if (parsed.value.status !== undefined) options.status = parsed.value.status;
  if (parsed.value.limit !== undefined) options.limit = parsed.value.limit;
  const rows = await medicationRequestRepo.listForPatient(
    ctx.tenantId,
    req.params.patientId,
    options,
  );

  return reply.code(200).send({ prescriptions: rows.map(toPatientMedicationRequestView) });
}
