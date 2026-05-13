/**
 * consults.ts — Async Consult slice HTTP handlers per Sprint 10 / TLC-021e.
 *
 * Routes (mounted under /v0/async-consult by routes.ts):
 *
 *   POST /v0/async-consult                     (initiate)
 *     Auth: Bearer JWT
 *     Body: { account_id, consult_type, modality, current_program_catalog_entry_id? }
 *     Returns: 201 + PHI-safe Consult view
 *
 *   POST /v0/async-consult/:id/submit
 *     Auth: Bearer JWT
 *     Body: { intake_form_submission_id }
 *     Returns: 200 + updated Consult view
 *
 *   POST /v0/async-consult/:id/abandon
 *     Auth: Bearer JWT
 *     Returns: 200 + updated Consult view
 *
 *   POST /v0/async-consult/:id/resume
 *     Auth: Bearer JWT
 *     Returns: 200 + updated Consult view
 *
 *   POST /v0/async-consult/:id/patient-responds
 *     Auth: Bearer JWT
 *     Returns: 200 + updated Consult view
 *
 *   GET /v0/async-consult/:id/events
 *     Auth: Bearer JWT
 *     Returns: 200 + ConsultEvent[] (PHI-safe; tenant_id stripped)
 *
 * NOT exposed at v0.1 (per Sprint 10 plan + Codex async-consult-r10/r11
 * HIGH closures):
 *   - POST /v0/async-consult/:id/start-intake (fail-closed pending SI-006
 *     Payment slice)
 *   - POST /v0/async-consult/:id/process (fail-closed pending SI-007 AI
 *     Service slice)
 *
 * Spec references:
 *   - Async Consult Slice PRD v1.0 §10
 *   - Master PRD v1.10 §17 + Glossary v5.2 C3 (no tenant_id leak)
 *   - I-025 (tenant-blind 404)
 *   - I-023 / I-027 (tenant scoping)
 */

import type { FastifyReply, FastifyRequest } from 'fastify';

import { requirePatientActorContext } from '../../../../lib/auth-context.js';
import { withIdempotentExecution } from '../../../../lib/idempotent-handler.js';
import { requireTenantContext } from '../../../../lib/tenant-context.js';
import type { AccountId } from '../../../identity/internal/types.js';
import * as consultService from '../services/consult-service.js';
import {
  asConsultId,
  type Consult,
  type ConsultEvent,
  type ConsultId,
  type ConsultModality,
  type ConsultType,
} from '../types.js';

// ---------------------------------------------------------------------------
// PHI-safe views: strip tenant_id per Master PRD §17 + C3
// ---------------------------------------------------------------------------

type PatientConsultView = Omit<Consult, 'tenant_id'>;
type PatientConsultEventView = Omit<ConsultEvent, 'tenant_id'>;

function toPatientConsultView(consult: Consult): PatientConsultView {
  const { tenant_id: _stripped, ...patientView } = consult;
  void _stripped;
  return patientView;
}

function toPatientEventView(event: ConsultEvent): PatientConsultEventView {
  const { tenant_id: _stripped, ...patientView } = event;
  void _stripped;
  return patientView;
}

// ---------------------------------------------------------------------------
// Body validators (manual; Zod schemas would be more declarative but the
// existing module pattern is manual validation per consents.ts)
// ---------------------------------------------------------------------------

interface InitiateBody {
  account_id?: string;
  consult_type?: string;
  modality?: string;
  current_program_catalog_entry_id?: string | null;
}

interface SubmitBody {
  intake_form_submission_id?: string;
}

const VALID_TYPES: ReadonlySet<ConsultType> = new Set(['program', 'general']);
const VALID_MODALITIES: ReadonlySet<ConsultModality> = new Set(['async', 'sync']);

function isString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}

// ---------------------------------------------------------------------------
// Error envelope mapping (canonical error codes per ERROR_MODEL v5.1)
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
 * Map service-layer error classes to HTTP status + error envelope.
 *
 * Per Codex async-consult-r9 HIGH closure 2026-05-05: ConsultPatientOwnershipError
 * maps to 404 (NOT 403) per I-025 tenant-blind error envelope —
 * leaking "exists but not yours" would reveal cross-patient existence
 * to a same-tenant attacker.
 *
 * Other service-layer errors map per the canonical codes.
 */
function mapServiceError(err: unknown, reply: FastifyReply, reqId: string): boolean {
  if (err instanceof consultService.ConsultNotFoundError) {
    void reply
      .code(404)
      .send(makeErrorEnvelope(reqId, 'internal.resource.not_found', 'Consult not found.'));
    return true;
  }
  if (err instanceof consultService.ConsultPatientOwnershipError) {
    // Tenant-blind / cross-patient-blind: 404, not 403
    void reply
      .code(404)
      .send(makeErrorEnvelope(reqId, 'internal.resource.not_found', 'Consult not found.'));
    return true;
  }
  if (err instanceof consultService.ConsultStateConflictError) {
    void reply
      .code(409)
      .send(makeErrorEnvelope(reqId, 'internal.resource.conflict', 'Consult state conflict.'));
    return true;
  }
  // State-machine InvalidTransitionError + UnsupportedTransitionError
  // (from internal/state-machine.ts) bubble out of unguardedTransition
  // when a caller drives an event that the current state doesn't accept
  // (e.g., POST /:id/patient-responds on a consult in INITIATED rather
  // than AWAITING_DATA). Pre-Sprint-34 these slipped to Fastify's global
  // 500 handler — tenant-blind 409 is the correct semantic (the
  // resource is in a state that doesn't allow this transition; same
  // shape as ConsultStateConflictError above). Per Sprint 34 PR-51 r4
  // CI-revealed handler-mapping gap (closes a 500 leak surfaced by
  // tests/integration/async-consult-http.test.ts B3).
  if (
    err instanceof Error &&
    (err.name === 'InvalidTransitionError' || err.name === 'UnsupportedTransitionError')
  ) {
    void reply
      .code(409)
      .send(makeErrorEnvelope(reqId, 'internal.resource.conflict', 'Consult state conflict.'));
    return true;
  }
  if (
    err instanceof consultService.SubmitGuardNotSatisfiedError ||
    err instanceof consultService.AbandonGuardNotSatisfiedError ||
    err instanceof consultService.FormSubmissionNotTerminalError
  ) {
    void reply
      .code(422)
      .send(
        makeErrorEnvelope(
          reqId,
          'internal.request.semantically_invalid',
          'Transition guard not satisfied.',
        ),
      );
    return true;
  }
  if (
    err instanceof consultService.PaymentNotVerifiedError ||
    err instanceof consultService.AiServiceNotWiredError
  ) {
    // Both are v0.1 fail-closed transitions awaiting upstream slice
    // ratification (SI-006 Payment / SI-007 AI Service).
    void reply
      .code(503)
      .send(
        makeErrorEnvelope(
          reqId,
          'internal.service.unavailable',
          'This transition is not yet enabled in this environment.',
        ),
      );
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// POST /v0/async-consult — initiate
// ---------------------------------------------------------------------------

export async function initiateConsultHandler(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<unknown> {
  const ctx = requireTenantContext(req);
  const actor = requirePatientActorContext(req);
  const body = (req.body ?? {}) as InitiateBody;

  if (
    !isString(body.account_id) ||
    !isString(body.consult_type) ||
    !VALID_TYPES.has(body.consult_type as ConsultType) ||
    !isString(body.modality) ||
    !VALID_MODALITIES.has(body.modality as ConsultModality)
  ) {
    return reply
      .code(400)
      .send(
        makeErrorEnvelope(
          req.id,
          'internal.request.invalid',
          'Invalid initiate body: account_id (string), consult_type (program|general), and modality (async|sync) are required.',
        ),
      );
  }

  // Authorization: account_id in body MUST match authenticated actor.
  if (body.account_id !== actor.accountId) {
    return reply
      .code(400)
      .send(makeErrorEnvelope(req.id, 'internal.request.invalid', 'Invalid initiate body.'));
  }

  return withIdempotentExecution(req, reply, mapServiceError, async (tx) => {
    const consult = await consultService.initiate(
      ctx,
      { actorId: actor.accountId },
      {
        account_id: actor.accountId as AccountId,
        consult_type: body.consult_type as ConsultType,
        modality: body.modality as ConsultModality,
        current_program_catalog_entry_id: body.current_program_catalog_entry_id ?? null,
      },
      tx,
    );
    return { status: 201, view: toPatientConsultView(consult) };
  });
}

// ---------------------------------------------------------------------------
// POST /v0/async-consult/:id/submit
// ---------------------------------------------------------------------------

export async function submitConsultHandler(
  req: FastifyRequest<{ Params: { id: string } }>,
  reply: FastifyReply,
): Promise<unknown> {
  const ctx = requireTenantContext(req);
  const actor = requirePatientActorContext(req);
  const consultId = asConsultId(req.params.id);
  const body = (req.body ?? {}) as SubmitBody;

  if (!isString(body.intake_form_submission_id)) {
    return reply
      .code(400)
      .send(
        makeErrorEnvelope(
          req.id,
          'internal.request.invalid',
          'Invalid submit body: intake_form_submission_id (string) is required.',
        ),
      );
  }

  return withIdempotentExecution(req, reply, mapServiceError, async (tx) => {
    const consult = await consultService.submit(
      ctx,
      { actorId: actor.accountId, accountId: actor.accountId as AccountId },
      consultId,
      body.intake_form_submission_id as string,
      tx,
    );
    return { status: 200, view: toPatientConsultView(consult) };
  });
}

// ---------------------------------------------------------------------------
// POST /v0/async-consult/:id/abandon
// ---------------------------------------------------------------------------

export async function abandonConsultHandler(
  req: FastifyRequest<{ Params: { id: string } }>,
  reply: FastifyReply,
): Promise<unknown> {
  const ctx = requireTenantContext(req);
  const actor = requirePatientActorContext(req);
  const consultId = asConsultId(req.params.id);

  return withIdempotentExecution(req, reply, mapServiceError, async (tx) => {
    const consult = await consultService.abandon(
      ctx,
      { actorId: actor.accountId, accountId: actor.accountId as AccountId },
      consultId,
      tx,
    );
    return { status: 200, view: toPatientConsultView(consult) };
  });
}

// ---------------------------------------------------------------------------
// POST /v0/async-consult/:id/resume
// ---------------------------------------------------------------------------

export async function resumeConsultHandler(
  req: FastifyRequest<{ Params: { id: string } }>,
  reply: FastifyReply,
): Promise<unknown> {
  const ctx = requireTenantContext(req);
  const actor = requirePatientActorContext(req);
  const consultId = asConsultId(req.params.id);

  return withIdempotentExecution(req, reply, mapServiceError, async (tx) => {
    const consult = await consultService.resume(
      ctx,
      { actorId: actor.accountId, accountId: actor.accountId as AccountId },
      consultId,
      tx,
    );
    return { status: 200, view: toPatientConsultView(consult) };
  });
}

// ---------------------------------------------------------------------------
// POST /v0/async-consult/:id/patient-responds
// ---------------------------------------------------------------------------

export async function patientRespondsConsultHandler(
  req: FastifyRequest<{ Params: { id: string } }>,
  reply: FastifyReply,
): Promise<unknown> {
  const ctx = requireTenantContext(req);
  const actor = requirePatientActorContext(req);
  const consultId = asConsultId(req.params.id);

  return withIdempotentExecution(req, reply, mapServiceError, async (tx) => {
    const consult = await consultService.patientResponds(
      ctx,
      { actorId: actor.accountId, accountId: actor.accountId as AccountId },
      consultId,
      tx,
    );
    return { status: 200, view: toPatientConsultView(consult) };
  });
}

// ---------------------------------------------------------------------------
// GET /v0/async-consult/:id/events
// ---------------------------------------------------------------------------

export async function listConsultEventsHandler(
  req: FastifyRequest<{ Params: { id: string } }>,
  reply: FastifyReply,
): Promise<unknown> {
  const ctx = requireTenantContext(req);
  const actor = requirePatientActorContext(req);
  const consultId: ConsultId = asConsultId(req.params.id);

  // Service layer enforces patient ownership (Codex async-consult-r13
  // HIGH closure 2026-05-05). ConsultNotFoundError + ConsultPatientOwnershipError
  // both map to tenant-blind 404 per I-025.
  try {
    const events = await consultService.listEvents(
      ctx,
      { accountId: actor.accountId as AccountId },
      consultId,
    );
    return reply.code(200).send({ events: events.map(toPatientEventView) });
  } catch (err) {
    if (mapServiceError(err, reply, req.id)) return reply;
    throw err;
  }
}
