/**
 * forms-intake/internal/handlers/snapshots.ts — patient-facing snapshot read handlers.
 *
 * Endpoints (per Slice PRD v2.1 §3 actor list — patients view what they submitted;
 * §4 snapshot layer — immutable point-in-time view):
 *   - GET /v0/forms/submissions/:submissionId/snapshot — read by submission
 *   - GET /v0/forms/snapshots/:snapshotId — read by snapshot id
 *
 * Both endpoints return the patient-safe projection of the snapshot row
 * (`PatientFormSnapshotView`) which type-strips `tenant_id` so internal
 * operating-tenant identity never leaks through the API contract per
 * Master PRD v1.10 §17 + Glossary v5.2 C3 brand-structure rule.
 *
 * **Clinician-facing variants are NOT registered here.** Per Slice PRD §3,
 * clinician case-review surfaces have their own auth boundary that ships
 * with the clinician slice (or after the Identity & Auth slice gates RBAC).
 * The `getSnapshotForSubmissionAsClinician` and `getSnapshotByIdAsClinician`
 * service entry points exist for that future wiring.
 */

import type { FastifyReply, FastifyRequest } from 'fastify';

import { requirePatientActorContext } from '../../../../lib/auth-context.js';
import { requireTenantContext } from '../../../../lib/tenant-context.js';
import {
  type PatientFormSnapshotView,
  getSnapshotByIdAsPatient,
  getSnapshotForSubmissionAsPatient,
  snapshotToPatientView,
} from '../services/snapshot-service.js';
import type { PatientId } from '../types.js';

/**
 * Resolve the patient identity for a snapshot read. Production fail-closed
 * gated by `ALLOW_ACTOR_HEADER_AUTH` (mirrors `submissions.ts`'s
 * `resolvePatient`). Replaced by Identity & Auth slice when it lands.
 *
 * Snapshot reads do NOT carry a delegate distinction — the snapshot is
 * the immutable record of what the patient submitted. Even when a
 * delegate completed the form, the snapshot belongs to the patient_id.
 */
function resolvePatientId(req: FastifyRequest): PatientId {
  // Tier 1: JWT actor (preferred). Patient's account_id IS the
  // patient_id at v1.0 (Account = Patient per CDM §3.2).
  //
  // Role-gated (Codex PR-118 R3 HIGH closure 2026-05-13): snapshot
  // reads here are PATIENT-facing — the file-level docstring states
  // clinician case-review surfaces have their own auth boundary +
  // dedicated service entry points. A clinician JWT must NOT pass
  // through this resolver as the patient anchor: doing so could
  // expose a clinician-anchored snapshot (legacy or corrupted) on a
  // patient surface, and at minimum violates the role boundary.
  if (req.actorContext !== undefined) {
    const patientActor = requirePatientActorContext(req);
    return patientActor.accountId;
  }
  const isProd = process.env['NODE_ENV'] === 'production';
  const optIn = process.env['ALLOW_ACTOR_HEADER_AUTH'] === 'true';
  if (isProd && !optIn) {
    throw req.server.httpErrors.unauthorized(
      'Patient identity could not be authenticated for this request.',
    );
  }
  const patientHeader = req.headers['x-patient-id'];
  const patientId =
    typeof patientHeader === 'string' && patientHeader.length > 0 ? patientHeader : null;
  if (patientId === null) {
    throw req.server.httpErrors.unauthorized('No patient identity resolved for this request.');
  }
  return patientId;
}

/**
 * GET /v0/forms/submissions/:submissionId/snapshot — patient reads the
 * immutable snapshot of a submission they own.
 *
 * Service-layer ownership cross-check + tenant-blind null-on-miss per
 * I-025 is handled by `getSnapshotForSubmissionAsPatient`. Handler:
 *   1. Resolves tenant via `requireTenantContext` (I-023 fail-closed).
 *   2. Resolves patient via the `x-patient-id` shim.
 *   3. Calls service; null → 404 with the canonical envelope.
 *   4. Projects to PatientFormSnapshotView before returning so
 *      `tenant_id` never leaves the boundary.
 */
export async function getSnapshotForSubmissionHandler(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<unknown> {
  const ctx = requireTenantContext(req);
  const patientId = resolvePatientId(req);

  const params = req.params as Record<string, unknown>;
  const submissionIdParam = params['submissionId'];
  if (typeof submissionIdParam !== 'string' || submissionIdParam.length === 0) {
    throw req.server.httpErrors.badRequest('Path param `submissionId` is required.');
  }

  const snapshot = await getSnapshotForSubmissionAsPatient(ctx, patientId, submissionIdParam);
  if (snapshot === null) {
    throw req.server.httpErrors.notFound('Form snapshot not found.');
  }
  const patientView: PatientFormSnapshotView = snapshotToPatientView(snapshot);
  return reply.code(200).send(patientView);
}

/**
 * GET /v0/forms/snapshots/:snapshotId — patient reads a snapshot by id.
 *
 * Same ownership cross-check pattern as the by-submission handler:
 * `getSnapshotByIdAsPatient` resolves the underlying submission and
 * verifies patient_id match before returning. Tenant-blind null-on-miss
 * per I-025; PatientFormSnapshotView projection on success.
 */
export async function getSnapshotByIdHandler(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<unknown> {
  const ctx = requireTenantContext(req);
  const patientId = resolvePatientId(req);

  const params = req.params as Record<string, unknown>;
  const snapshotIdParam = params['snapshotId'];
  if (typeof snapshotIdParam !== 'string' || snapshotIdParam.length === 0) {
    throw req.server.httpErrors.badRequest('Path param `snapshotId` is required.');
  }

  const snapshot = await getSnapshotByIdAsPatient(ctx, patientId, snapshotIdParam);
  if (snapshot === null) {
    throw req.server.httpErrors.notFound('Form snapshot not found.');
  }
  const patientView: PatientFormSnapshotView = snapshotToPatientView(snapshot);
  return reply.code(200).send(patientView);
}
