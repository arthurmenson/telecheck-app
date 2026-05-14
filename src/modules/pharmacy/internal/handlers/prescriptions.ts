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

import {
  UnauthenticatedError,
  requireClinicianActorContext,
  requirePatientActorContext,
} from '../../../../lib/auth-context.js';
import { GlossaryViolationError, asMedicationRequestId } from '../../../../lib/glossary.js';
import {
  IdempotencyBodyMismatchError,
  IdempotencyInFlightError,
  IdempotencyReplayError,
  buildIdempotencyCtx,
} from '../../../../lib/idempotency.js';
import { withIdempotentExecution } from '../../../../lib/idempotent-handler.js';
import { requireTenantContext } from '../../../../lib/tenant-context.js';
import { asSessionId, findActiveSessionById } from '../../../identity/index.js';
import * as medicationRequestRepo from '../repositories/medication-request-repo.js';
import * as medicationRequestService from '../services/medication-request-service.js';
import { asProductCatalogId } from '../types.js';
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
  actor: ReturnType<typeof requirePatientActorContext>;
}> {
  const ctx = requireTenantContext(req);
  // Patient-only at v1.0 PR C/D — every endpoint in this handler module
  // anchors on the patient actor as the resource subject. PR E adds a
  // sibling helper requireClinicianLiveSession for the clinician write
  // surface; until then, a clinician JWT must NOT authenticate through
  // this path (Codex PR-118 R1 HIGH closure 2026-05-13).
  const actor = requirePatientActorContext(req);
  const live = await findActiveSessionById(ctx, asSessionId(actor.sessionId));
  if (live === null) {
    throw new UnauthenticatedError();
  }
  // Account binding (Codex PR-116 R2 HIGH closure). A live session that
  // doesn't belong to the JWT's account_id MUST NOT authorize reads as
  // that account. Without this check, a future bug that desynchronizes
  // account_id and session_id at token issuance time — or any flow that
  // hands a token to the wrong account — could authorize cross-account
  // reads against a same-tenant live session row. By I-025 this 401 is
  // byte-identical to the missing/revoked/expired 401 above.
  if (live.account_id !== actor.accountId) {
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

// ---------------------------------------------------------------------------
// Service-error mapper for write paths (TLC-055 PR D)
//
// Translates the service-layer typed errors into the canonical
// ERROR_MODEL v5.1 envelope. Per I-025, NotFoundError covers both
// "doesn't exist" AND "cross-patient ownership" — they collapse to
// `internal.resource.not_found` 404 so a same-tenant attacker cannot
// distinguish the two.
// ---------------------------------------------------------------------------

function mapWriteServiceError(err: unknown, reply: FastifyReply, reqId: string): boolean {
  if (err instanceof medicationRequestService.MedicationRequestNotFoundError) {
    void reply
      .code(404)
      .send(makeErrorEnvelope(reqId, 'internal.resource.not_found', NOT_FOUND_MESSAGE));
    return true;
  }
  if (err instanceof medicationRequestService.MedicationRequestInputValidationError) {
    // Codex PR-119 R1 closure 2026-05-13: non-patient account_type as
    // patient_account_id, OR prescribing_consult_id whose consult
    // belongs to a different patient, OR a non-existent
    // patient_account_id. All map to tenant-blind 400 with an
    // IDENTICAL public message (R2 closure 2026-05-13). The service
    // raises distinct `err.reason` values for ops/telemetry, but
    // echoing them publicly would let a same-tenant clinician probe
    // account IDs and distinguish "no such account" from "account
    // exists but isn't a patient" — an existence/type oracle that
    // contradicts I-025. The specific reason stays in the Error
    // object (visible in server-side stack traces / log middleware
    // when one is wired); the public envelope is collapsed.
    void reply
      .code(400)
      .send(
        makeErrorEnvelope(
          reqId,
          'internal.request.invalid',
          'Invalid medication_request input. Verify patient_account_id, ' +
            'product_catalog_id, and prescribing_consult_id reference rows ' +
            'in this tenant and match the canonical type/ownership constraints.',
        ),
      );
    return true;
  }
  if (err instanceof medicationRequestService.MedicationRequestStateConflictError) {
    void reply
      .code(409)
      .send(
        makeErrorEnvelope(
          reqId,
          'internal.resource.conflict',
          'Medication request state conflict.',
        ),
      );
    return true;
  }
  // State-machine InvalidTransitionError + UnsupportedTransitionError
  // bubble out of validateTransition when a caller drives an event the
  // current state doesn't accept. Tenant-blind 409 is the correct
  // semantic — same shape as state-conflict-error above. Mirrors the
  // async-consult handler mapping (consults.ts:160-168).
  if (
    err instanceof Error &&
    (err.name === 'InvalidTransitionError' || err.name === 'UnsupportedTransitionError')
  ) {
    void reply
      .code(409)
      .send(
        makeErrorEnvelope(
          reqId,
          'internal.resource.conflict',
          'Medication request state conflict.',
        ),
      );
    return true;
  }
  // I012RejectError is intentionally NOT mapped here. The approve
  // handler catches it explicitly AFTER `withIdempotentExecution`
  // returns so the rejection audit can emit in a fresh tx without
  // deadlocking on the outer writing tx's audit hash-chain advisory
  // lock (Codex PR G R1 HIGH closure 2026-05-13). Allowing it to
  // propagate here would emit the 409 envelope BEFORE the rejection
  // audit lands, defeating the I-003 / I-012 bare-suppression-forbidden
  // rule.
  return false;
}

// ---------------------------------------------------------------------------
// POST /v0/pharmacy/prescriptions/:id/discontinue
// ---------------------------------------------------------------------------

/**
 * Patient-initiated discontinuation of a medication_request the patient
 * owns. Body is empty — the discontinued_reason is forced to
 * 'patient_request' because the actor IS the patient (per the
 * patient_request_discontinue transition in State Machines v1.2 §19).
 * If a future PR widens this to accept clinician_discontinue or
 * adverse_event_discontinue, the body schema gets a `reason` field then.
 *
 * - 200 + PHI-safe view of the discontinued row on success.
 * - 404 (tenant-blind) on not-found / cross-tenant / cross-patient /
 *   malformed id (collapsed envelope per I-025).
 * - 409 on state-conflict (row not in 'active', concurrent writer
 *   raced the optimistic-concurrency UPDATE, or state machine rejected
 *   the transition).
 * - 401 on missing JWT / dead session / mismatched account binding
 *   (via requireLiveSession).
 *
 * Idempotency-Key REQUIRED per IDEMPOTENCY v5.1 — every state-mutating
 * pharmacy write goes through `withIdempotentExecution`.
 */
export async function discontinueMedicationRequestHandler(
  req: FastifyRequest<{ Params: { id: string } }>,
  reply: FastifyReply,
): Promise<unknown> {
  const { ctx, actor } = await requireLiveSession(req);

  // Body validation (Codex PR-117 R1 HIGH closure). The endpoint
  // forces `discontinued_reason='patient_request'` and event=
  // 'patient_request_discontinue' server-side because that is the
  // only patient-origin discontinue transition at v1.0. A patient
  // POSTing `{ "reason": "adverse_event" }` to express a safety
  // concern would otherwise be silently terminal-discontinued as
  // patient_request — dropping the safety signal AND emitting a
  // misleading audit/domain-event payload (the patient INTENDED to
  // flag an adverse event; the audit chain would record routine
  // patient request). Reject any non-empty body so the patient
  // surface fails loud instead of quietly miscoding the reason.
  //
  // Accepted: missing body, null, `{}`. Anything else → 400
  // internal.request.invalid. The reasons enum is server-controlled
  // for patient-origin writes; if a future PR adds patient
  // adverse-event reporting, model `reason` explicitly then.
  if (
    req.body !== undefined &&
    req.body !== null &&
    (typeof req.body !== 'object' ||
      Array.isArray(req.body) ||
      Object.keys(req.body as Record<string, unknown>).length > 0)
  ) {
    return reply
      .code(400)
      .send(
        makeErrorEnvelope(
          req.id,
          'internal.request.invalid',
          'Discontinue accepts no body. Patient-origin discontinuation forces ' +
            "discontinued_reason='patient_request' server-side; to flag an " +
            'adverse event or different reason, use a route that models that ' +
            'reason explicitly (not yet exposed).',
        ),
      );
  }

  // Validate id at the boundary. Malformed → 404 tenant-blind (same
  // side-channel reasoning as the GET handler).
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

  return withIdempotentExecution(req, reply, mapWriteServiceError, async (tx) => {
    const updated = await medicationRequestService.discontinueByPatient(
      ctx,
      { accountId: actor.accountId },
      id,
      tx,
    );
    return { status: 200, view: toPatientMedicationRequestView(updated) };
  });
}

// ===========================================================================
// Clinician write surface (TLC-055 PR E 2026-05-13)
// ===========================================================================

/**
 * Clinician-side liveness guard. Mirror of requireLiveSession but
 * binds the actor's role to 'clinician' instead of 'patient'.
 * Composes the four defensive layers established in PR C/D:
 *
 *   1. requireTenantContext — tenant resolved from Host header
 *   2. requireClinicianActorContext — JWT carries role='clinician'
 *   3. findActiveSessionById — sessions row exists + not revoked +
 *      not expired (closes the revoked-session bypass)
 *   4. session.account_id === actor.accountId — JWT account binds to
 *      a session owned by the same account (closes the cross-account
 *      session reuse bypass)
 */
async function requireClinicianLiveSession(req: FastifyRequest): Promise<{
  ctx: ReturnType<typeof requireTenantContext>;
  actor: ReturnType<typeof requireClinicianActorContext>;
}> {
  const ctx = requireTenantContext(req);
  const actor = requireClinicianActorContext(req);
  const live = await findActiveSessionById(ctx, asSessionId(actor.sessionId));
  if (live === null) {
    throw new UnauthenticatedError();
  }
  if (live.account_id !== actor.accountId) {
    throw new UnauthenticatedError();
  }
  return { ctx, actor };
}

// ---------------------------------------------------------------------------
// POST /v0/pharmacy/prescriptions — clinician creates a draft
// ---------------------------------------------------------------------------

interface CreateDraftBody {
  patient_account_id?: unknown;
  product_catalog_id?: unknown;
  medication_name?: unknown;
  strength?: unknown;
  formulation?: unknown;
  dose_instructions?: unknown;
  quantity?: unknown;
  quantity_unit?: unknown;
  refills_allowed?: unknown;
  indication?: unknown;
  clinical_notes?: unknown;
  prescribing_consult_id?: unknown;
  // country_of_care: NOT accepted from body (Codex PR-119 R1 HIGH
  // closure 2026-05-13). Derived server-side from ctx.countryOfCare.
  // Any body field with this name is rejected at the validator.
  country_of_care?: unknown;
  protocol_id?: unknown;
  protocol_version?: unknown;
}

function isString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}

function isNonNegativeInteger(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0;
}

function isPositiveInteger(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v > 0;
}

/**
 * Canonical ULID shape: 26 chars from Crockford base32 (digits + A-Z
 * minus I, L, O, U). Codex PR-119 R4 MEDIUM closure 2026-05-13:
 * incoming IDs (patient_account_id, product_catalog_id,
 * prescribing_consult_id) MUST be validated at the boundary so an
 * overlength or malformed value cannot reach the DB and surface a
 * different Postgres error class (e.g., 22001 string-data-right-
 * truncation) than the FK-violation 23503 path. Different DB error
 * classes produce different envelopes → account-existence oracle.
 *
 * The downstream branded types (asAccountId, asProductCatalogId,
 * asDelegationId) currently use unchecked casts; this regex is the
 * application-layer fail-fast gate that prevents oversize/malformed
 * IDs from ever reaching the parameterized queries.
 */
const ULID_PATTERN = /^[0-9A-HJKMNPQRSTVWXYZ]{26}$/;
function isUlidShape(v: unknown): v is string {
  return typeof v === 'string' && ULID_PATTERN.test(v);
}

/**
 * Validate the POST /prescriptions body. Returns either an error
 * message OR a normalized CreateDraftAsClinicianInput. All optional
 * fields default to null. The shape mirrors CDM v1.3 §4.16
 * MedicationRequest constructor inputs.
 *
 * The composite-FK (tenant, patient_account_id), (tenant,
 * product_catalog_id), (tenant, prescribing_consult_id) enforces
 * cross-tenant + non-existence at the DB durable boundary, surfaced
 * to the handler as a Postgres FK violation that maps to 400 (handler
 * catches PostgresError below). I-025 tenant-blindness is preserved
 * because the FK error message doesn't disclose existence in other
 * tenants — only that the FK target wasn't found in THIS tenant.
 */
function parseCreateDraftBody(
  raw: unknown,
):
  | { ok: true; value: medicationRequestService.CreateDraftAsClinicianInput }
  | { ok: false; message: string } {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, message: 'Request body must be a JSON object.' };
  }
  const body = raw as CreateDraftBody;

  // ID shape validation at the boundary (Codex PR-119 R4 MEDIUM
  // closure 2026-05-13). Each ID must match the canonical 26-char
  // Crockford-base32 ULID pattern so an overlength or malformed
  // value never reaches the parameterized SQL (where a different
  // Postgres error class — e.g., 22001 truncation — would otherwise
  // produce a different envelope from the FK-violation 23503 path,
  // recreating the account-existence oracle R3 was meant to close).
  if (!isUlidShape(body.patient_account_id)) {
    return {
      ok: false,
      message: 'patient_account_id (26-char Crockford-base32 ULID) is required.',
    };
  }
  if (!isUlidShape(body.product_catalog_id)) {
    return {
      ok: false,
      message: 'product_catalog_id (26-char Crockford-base32 ULID) is required.',
    };
  }
  if (!isString(body.medication_name)) {
    return { ok: false, message: 'medication_name (non-empty string) is required.' };
  }
  if (!isString(body.strength)) {
    return { ok: false, message: 'strength (non-empty string) is required.' };
  }
  if (!isString(body.formulation)) {
    return { ok: false, message: 'formulation (non-empty string) is required.' };
  }
  if (!isString(body.dose_instructions)) {
    return { ok: false, message: 'dose_instructions (non-empty string) is required.' };
  }
  if (!isPositiveInteger(body.quantity)) {
    return { ok: false, message: 'quantity (positive integer) is required.' };
  }
  if (!isString(body.quantity_unit)) {
    return { ok: false, message: 'quantity_unit (non-empty string) is required.' };
  }
  if (!isNonNegativeInteger(body.refills_allowed)) {
    return { ok: false, message: 'refills_allowed (non-negative integer) is required.' };
  }
  // country_of_care is server-derived from tenant context (Codex
  // PR-119 R1 HIGH closure 2026-05-13). Reject any body value
  // explicitly so callers fail loud rather than silently have their
  // value ignored.
  if (body.country_of_care !== undefined) {
    return {
      ok: false,
      message:
        'country_of_care must not be supplied in the request body — it is ' +
        'derived server-side from the tenant context.',
    };
  }

  // Optional fields. Reject null AND "wrong type"; accept undefined.
  const indication = body.indication;
  if (indication !== undefined && indication !== null && !isString(indication)) {
    return { ok: false, message: 'indication must be a string or null.' };
  }
  const clinicalNotes = body.clinical_notes;
  if (clinicalNotes !== undefined && clinicalNotes !== null && !isString(clinicalNotes)) {
    return { ok: false, message: 'clinical_notes must be a string or null.' };
  }
  const prescribingConsultId = body.prescribing_consult_id;
  if (
    prescribingConsultId !== undefined &&
    prescribingConsultId !== null &&
    !isUlidShape(prescribingConsultId)
  ) {
    return {
      ok: false,
      message: 'prescribing_consult_id must be a 26-char Crockford-base32 ULID, null, or omitted.',
    };
  }

  // protocol_id + protocol_version: BOTH or NEITHER (per migration 025
  // medication_requests_protocol_binding_check pre-active clause).
  const protocolId = body.protocol_id;
  const protocolVersion = body.protocol_version;
  const protocolIdSet = isString(protocolId);
  const protocolVersionSet = isString(protocolVersion);
  if (protocolIdSet !== protocolVersionSet) {
    return {
      ok: false,
      message:
        'protocol_id and protocol_version must be set together or both omitted ' +
        '(per medication_requests protocol-binding CHECK for draft rows).',
    };
  }

  return {
    ok: true,
    value: {
      patient_account_id: body.patient_account_id,
      product_catalog_id: asProductCatalogId(body.product_catalog_id),
      medication_name: body.medication_name,
      strength: body.strength,
      formulation: body.formulation,
      dose_instructions: body.dose_instructions,
      quantity: body.quantity,
      quantity_unit: body.quantity_unit,
      refills_allowed: body.refills_allowed,
      indication: indication === undefined || indication === null ? null : indication,
      clinical_notes: clinicalNotes === undefined || clinicalNotes === null ? null : clinicalNotes,
      prescribing_consult_id:
        prescribingConsultId === undefined || prescribingConsultId === null
          ? null
          : prescribingConsultId,
      // country_of_care derived server-side in service (R1 closure).
      protocol_id: protocolIdSet ? protocolId : null,
      protocol_version: protocolVersionSet ? protocolVersion : null,
    },
  };
}

export async function createDraftHandler(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<unknown> {
  const { ctx, actor } = await requireClinicianLiveSession(req);

  const parsed = parseCreateDraftBody(req.body);
  if (!parsed.ok) {
    return reply
      .code(400)
      .send(makeErrorEnvelope(req.id, 'internal.request.invalid', parsed.message));
  }

  return withIdempotentExecution(req, reply, mapWriteServiceError, async (tx) => {
    try {
      const created = await medicationRequestService.createDraftAsClinician(
        ctx,
        { accountId: actor.accountId },
        parsed.value,
        tx,
      );
      return { status: 201, view: toPatientMedicationRequestView(created) };
    } catch (err) {
      // Map Postgres FK violations (cross-tenant patient/product/consult)
      // to the SAME tenant-blind 400 envelope as MedicationRequest-
      // InputValidationError (Codex PR-119 R3 MEDIUM closure 2026-05-13).
      //
      // R2 collapsed the validation-error message; this branch must also
      // funnel through MedicationRequestInputValidationError so the
      // PUBLIC response is byte-identical to the validation-error path.
      // Otherwise an attacker can mount a 2-payload oracle:
      //   1. Invalid product_catalog_id (constant) + nonexistent
      //      patient_account_id → service validation 400 (collapsed
      //      message; never reaches repo).
      //   2. Same invalid product + EXISTING-patient patient_account_id
      //      → validation passes, FK violation on product fires →
      //      different message via httpErrors.badRequest.
      // The diff reveals "patient_account_id exists vs doesn't" — the
      // very oracle R2 closed for the direct validation path.
      // Re-using the validation error class makes the public envelope
      // identical across both branches.
      if (
        err instanceof Error &&
        'code' in err &&
        (err as Error & { code: string }).code === '23503'
      ) {
        // 23503 = foreign_key_violation. Re-throw as the validation
        // error so mapWriteServiceError emits the collapsed envelope —
        // same public response as the service-layer validation path,
        // closing the FK-error oracle.
        throw new medicationRequestService.MedicationRequestInputValidationError(
          'patient_account_id / product_catalog_id / prescribing_consult_id ' +
            'must reference rows in the same tenant.',
        );
      }
      throw err;
    }
  });
}

// ---------------------------------------------------------------------------
// POST /v0/pharmacy/prescriptions/:id/submit — clinician submits for review
// ---------------------------------------------------------------------------

export async function submitForReviewHandler(
  req: FastifyRequest<{ Params: { id: string } }>,
  reply: FastifyReply,
): Promise<unknown> {
  const { ctx, actor } = await requireClinicianLiveSession(req);

  // Reject non-empty body so a clinician can't slip in additional
  // fields. The submit transition takes no body input.
  if (
    req.body !== undefined &&
    req.body !== null &&
    (typeof req.body !== 'object' ||
      Array.isArray(req.body) ||
      Object.keys(req.body as Record<string, unknown>).length > 0)
  ) {
    return reply
      .code(400)
      .send(
        makeErrorEnvelope(
          req.id,
          'internal.request.invalid',
          'Submit accepts no body — the state transition takes no parameters.',
        ),
      );
  }

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

  return withIdempotentExecution(req, reply, mapWriteServiceError, async (tx) => {
    const updated = await medicationRequestService.submitForReviewAsClinician(
      ctx,
      { accountId: actor.accountId },
      id,
      tx,
    );
    return { status: 200, view: toPatientMedicationRequestView(updated) };
  });
}

// ---------------------------------------------------------------------------
// POST /v0/pharmacy/prescriptions/:id/clinician-discontinue
//
// Clinician-side counterpart to PR D's patient-self discontinue.
// Body: { reason: 'clinical_decision' | 'adverse_event' }
//
//   - 200 + PHI-safe view (status=discontinued, discontinued_reason set).
//   - 400 on missing/invalid reason field.
//   - 401 on missing JWT / dead session / mismatched account binding.
//   - 403 on patient-role JWT.
//   - 404 on not-found / cross-tenant / malformed id.
//   - 409 on row not in 'active' (or concurrent writer raced).
//
// No cross-patient ownership check at v1.0 — RBAC v1.1 §1.2 grants
// clinicians at the tenant broad Rx-management authority. Future
// per-assignment RBAC narrowing ships with the RBAC slice.
// ---------------------------------------------------------------------------

const VALID_CLINICIAN_DISCONTINUE_REASONS =
  new Set<medicationRequestService.ClinicianDiscontinueReason>([
    'clinical_decision',
    'adverse_event',
  ]);

interface ClinicianDiscontinueBody {
  reason?: unknown;
}

export async function clinicianDiscontinueMedicationRequestHandler(
  req: FastifyRequest<{ Params: { id: string } }>,
  reply: FastifyReply,
): Promise<unknown> {
  const { ctx, actor } = await requireClinicianLiveSession(req);

  // Body validation: requires { reason: 'clinical_decision' | 'adverse_event' }.
  // No other fields permitted — extra fields are rejected loud (mirrors
  // PR D's no-body discipline; here the only legitimate field is the
  // reason discriminator).
  const body = (req.body ?? {}) as ClinicianDiscontinueBody;
  if (typeof req.body !== 'object' || req.body === null || Array.isArray(req.body)) {
    return reply
      .code(400)
      .send(
        makeErrorEnvelope(
          req.id,
          'internal.request.invalid',
          'Body must be a JSON object with a `reason` field.',
        ),
      );
  }
  if (
    typeof body.reason !== 'string' ||
    !VALID_CLINICIAN_DISCONTINUE_REASONS.has(
      body.reason as medicationRequestService.ClinicianDiscontinueReason,
    )
  ) {
    return reply
      .code(400)
      .send(
        makeErrorEnvelope(
          req.id,
          'internal.request.invalid',
          'reason must be one of: clinical_decision | adverse_event.',
        ),
      );
  }
  // Reject extra body fields so a clinician can't slip in unmodeled
  // attributes (e.g., a `discontinued_at` override that bypasses the
  // server-derived timestamp).
  const allowedKeys = new Set(['reason']);
  const extraKeys = Object.keys(body).filter((k) => !allowedKeys.has(k));
  if (extraKeys.length > 0) {
    return reply
      .code(400)
      .send(
        makeErrorEnvelope(
          req.id,
          'internal.request.invalid',
          `Unexpected body field(s): ${extraKeys.join(', ')}. Only \`reason\` is accepted.`,
        ),
      );
  }
  const reason = body.reason as medicationRequestService.ClinicianDiscontinueReason;

  // Validate id at the boundary. Malformed → 404 tenant-blind (same
  // side-channel reasoning as the other handlers).
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

  return withIdempotentExecution(req, reply, mapWriteServiceError, async (tx) => {
    const updated = await medicationRequestService.discontinueByClinician(
      ctx,
      { accountId: actor.accountId },
      id,
      reason,
      tx,
    );
    return { status: 200, view: toPatientMedicationRequestView(updated) };
  });
}

// ---------------------------------------------------------------------------
// POST /v0/pharmacy/prescriptions/:id/approve
//
// Clinician-only I-012-gated activation per State Machines v1.2 §19:
//
//   pending_clinician_review --[clinician_approve]--> active
//
// Body is empty — the approval transition takes no parameters. The body
// parser rejects unexpected fields explicitly so a clinician can't
// smuggle in an override of the server-derived prescribed_at or
// approval_pathway.
//
// Returns:
//   - 200 + PHI-safe view (status=active, prescribed_at set,
//     prescribed_by_clinician_account_id set).
//   - 400 on non-empty / non-object body.
//   - 401 on missing JWT / dead session / mismatched account binding.
//   - 403 on patient-role JWT.
//   - 404 on not-found / cross-tenant / malformed id (I-025 collapsed).
//   - 409 on row not in 'pending_clinician_review' OR concurrent writer
//     raced OR I-012 reject-unless violation (the latter is service-
//     layer-bug defense-in-depth; v1.0 clinician-only fields are all
//     service-controlled).
//
// Idempotency-Key REQUIRED per IDEMPOTENCY v5.1. The handler-owned
// idempotency check sits AFTER requireClinicianLiveSession, so a
// revoked-session replay 401s before any cached PHI can be served
// (platform fix landed alongside TLC-055 PR F).
// ---------------------------------------------------------------------------

export async function approveMedicationRequestHandler(
  req: FastifyRequest<{ Params: { id: string } }>,
  reply: FastifyReply,
): Promise<unknown> {
  const { ctx, actor } = await requireClinicianLiveSession(req);

  // Reject non-empty body. The approve transition takes no parameters.
  if (
    req.body !== undefined &&
    req.body !== null &&
    (typeof req.body !== 'object' ||
      Array.isArray(req.body) ||
      Object.keys(req.body as Record<string, unknown>).length > 0)
  ) {
    return reply
      .code(400)
      .send(
        makeErrorEnvelope(
          req.id,
          'internal.request.invalid',
          'Approve accepts no body — the state transition takes no parameters.',
        ),
      );
  }

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

  // Build the idempotency ctx ahead of the writing tx so the post-
  // rollback rejection emitter (if I-012 fires) can stamp a completed
  // idempotency_keys row keyed by the same 4-tuple, making retries
  // replay the cached 409 instead of re-emitting the rejection audit
  // (Codex PR G R3 HIGH closure 2026-05-13). The Idempotency-Key
  // header presence is guaranteed at this point — the global
  // idempotency preHandler returns 400 if it's missing, so the request
  // never reaches this handler without one.
  const idempotencyCtxForRejection = buildIdempotencyCtx(req);

  try {
    return await withIdempotentExecution(req, reply, mapWriteServiceError, async (tx) => {
      const updated = await medicationRequestService.approveAsClinician(
        ctx,
        { accountId: actor.accountId },
        id,
        tx,
      );
      return { status: 200, view: toPatientMedicationRequestView(updated) };
    });
  } catch (err) {
    // I-012 reject-unless violation. The writing tx (inside
    // withIdempotentExecution) has rolled back; the audit hash-chain
    // advisory lock is released. Emit prescribing.execution_rejected
    // in a fresh tx AND atomically write a completed idempotency_keys
    // row so retries replay (per AUDIT_EVENTS v5.3 §I-012 reject-
    // unless rejection-audit-event rule + IDEMPOTENCY v5.1; bare
    // suppression forbidden per I-003).
    //
    // The helper resolves the row's patient_account_id INTERNALLY (in
    // the same fresh tx as the emission) so there is no caller-
    // supplied path that could skip the audit. It also wraps the
    // emission in `withIdempotency` so the rejection-emission
    // operation is itself idempotent: the next retry with the same
    // key + body hits the cached 409 via withIdempotency's replay
    // semantics inside the regular withIdempotentExecution path.
    if (err instanceof Error && err.name === 'I012RejectError') {
      const violatedClauses = ((err as Error & { violated_clauses?: readonly string[] })
        .violated_clauses ?? []) as Parameters<
        typeof medicationRequestService.emitApprovalI012RejectionAudit
      >[3];
      const rejectionEnvelope = makeErrorEnvelope(
        req.id,
        'internal.resource.conflict',
        'Medication request state conflict.',
      );
      try {
        const payload = await medicationRequestService.emitApprovalI012RejectionAudit(
          ctx,
          { accountId: actor.accountId },
          id,
          violatedClauses,
          idempotencyCtxForRejection,
          rejectionEnvelope,
        );
        return reply.code(payload.status).send(payload.body);
      } catch (auditErr) {
        if (
          auditErr instanceof Error &&
          auditErr.name === 'ApprovalI012RejectionAuditAnchorMissingError'
        ) {
          // Fail closed. The row vanished or tenant context drifted
          // between writing-tx rollback and rejection-audit emission;
          // we cannot anchor the canonical I-012 audit, and returning
          // 409 here would suppress the emission silently in violation
          // of I-003 + I-012. Surface 500 with a generic envelope so
          // ops sees the anomaly.
          return reply
            .code(500)
            .send(
              makeErrorEnvelope(
                req.id,
                'internal.server_error',
                'An internal error occurred while processing the request.',
              ),
            );
        }
        // Concurrent retry already completed the rejection emission
        // (cache row exists). Replay the cached body verbatim per
        // IDEMPOTENCY v5.1.
        if (auditErr instanceof IdempotencyReplayError) {
          return reply.code(auditErr.cachedStatus).send(auditErr.cachedBody);
        }
        // Concurrent retry is mid-emission (reservation row is
        // 'pending'). Return the canonical in-flight 409 so the
        // client backs off.
        if (auditErr instanceof IdempotencyInFlightError) {
          return reply
            .code(409)
            .send(makeErrorEnvelope(req.id, 'internal.idempotency.in_flight', auditErr.hint));
        }
        // Body hash mismatch: a retry presented a DIFFERENT body
        // under the same Idempotency-Key. Per IDEMPOTENCY v5.1 this
        // is a contract violation.
        if (auditErr instanceof IdempotencyBodyMismatchError) {
          return reply
            .code(409)
            .send(
              makeErrorEnvelope(
                req.id,
                'internal.idempotency.body_mismatch',
                'Idempotency key already used with a different request body.',
              ),
            );
        }
        throw auditErr;
      }
    }
    throw err;
  }
}
