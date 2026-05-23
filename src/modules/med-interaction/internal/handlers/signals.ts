/**
 * signals.ts — Med-Interaction signal HTTP handlers (PR 7).
 *
 * Mounted under `/v0/med-interaction` by routes.ts.
 *
 *   GET /v0/med-interaction/signals/:id
 *     Auth: Bearer JWT
 *     Layer B: role ∈ { clinician, tenant_admin, platform_admin }
 *     Returns: 200 + current-state projection
 *              { signal_id, current_state, as_of, transition_reason }
 *     404 (tenant-blind) when the signal does not exist in the caller's
 *         tenant OR the id is not ULID-shaped (I-025 — no existence signal).
 *
 * This is the lowest-risk first endpoint of the Med-Interaction handler
 * series (per cockpit Addendum 81): a pure read via the SECDEF access
 * function from migration 048. No Cat A audit emission is required for
 * reads — the SI-019 §6 audit catalog has no read event (its 6 events are
 * all write/lifecycle events). The write/lifecycle endpoints (signal
 * emission, activation, override, supersede, resolve, expire) land in
 * PR 8+ and DO emit Cat A audit.
 *
 * **Layer B role mapping (SI-019 §RBAC):** the `medication_interaction.
 * signal_viewer` read role is granted to clinician + pharmacist +
 * ai_clinical_assistant + admin per the slice PRD. Of those, only
 * clinician + admin are expressible in the current JWT role enum
 * (patient | clinician | tenant_admin | platform_admin); `pharmacist`
 * and `ai_clinical_assistant` are RBAC v1.x roles that land with their
 * own slices (Pharmacy dispensing surface; AI Mode 2 protocol agent), at
 * which point they are added to this gate. Patients are NOT signal_viewer
 * grantees and are rejected with 403.
 *
 * Spec references:
 *   - SI-019 Medication Interaction Engine Slice PRD v2.0 §5 (endpoints)
 *     + §Sub-decision 9 (read-path classification) + §RBAC (signal_viewer)
 *   - CDM v1.7 §4.NEW5 (access function read-model)
 *   - I-023 / I-025 (tenant scoping; tenant-blind not-found)
 *   - Master PRD v1.10 §17 + Glossary v5.2 C3 (no tenant_id leak)
 */

import type { FastifyReply, FastifyRequest } from 'fastify';

import { requireActorContext, UnauthorizedRoleError } from '../../../../lib/auth-context.js';
import { crossTenantNotFoundError } from '../../../../lib/error-envelope.js';
import { requireTenantContext } from '../../../../lib/tenant-context.js';
import { readSignalCurrentState } from '../repositories/signal-read-repo.js';

// ULID shape — 26 Crockford base32 chars (alphabet excludes I, L, O, U).
// Validating before the DB call (a) prevents a VARCHAR(26) overflow turning
// into a 500 on an over-long id, and (b) lets a malformed id resolve to the
// same tenant-blind 404 as a well-formed-but-absent id (I-025).
const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/i;

/** Layer B: roles entitled to read interaction signals (signal_viewer). */
const SIGNAL_READ_ROLES = ['clinician', 'tenant_admin', 'platform_admin'] as const;

// ---------------------------------------------------------------------------
// GET /v0/med-interaction/signals/:id
// ---------------------------------------------------------------------------

export async function getSignalCurrentStateHandler(
  req: FastifyRequest<{ Params: { id: string } }>,
  reply: FastifyReply,
): Promise<unknown> {
  const ctx = requireTenantContext(req);

  // Layer B authorization BEFORE any slice-role elevation (with-db-role.ts
  // trust-boundary contract: never elevate for an unentitled actor).
  // requireActorContext throws UnauthenticatedError (401) when no/invalid
  // JWT; both 401 and the 403 below are rendered by the global error
  // handler as canonical tenant-blind envelopes.
  const actor = requireActorContext(req);
  if (
    actor.role !== 'clinician' &&
    actor.role !== 'tenant_admin' &&
    actor.role !== 'platform_admin'
  ) {
    throw new UnauthorizedRoleError(SIGNAL_READ_ROLES, actor.role);
  }

  const signalId = req.params.id;
  if (!ULID_RE.test(signalId)) {
    // Malformed id: tenant-blind 404 (do not leak "well-formed but absent"
    // vs "malformed" distinction, and avoid the VARCHAR(26) overflow path).
    return reply.code(404).send(crossTenantNotFoundError(req.id));
  }

  const projection = await readSignalCurrentState(ctx.tenantId, signalId);
  if (projection === null) {
    return reply.code(404).send(crossTenantNotFoundError(req.id));
  }

  // No tenant_id is projected by the access function, so the response is
  // already tenant-blind. as_of serializes to an ISO-8601 string.
  return reply.code(200).send({
    signal_id: projection.signal_id,
    current_state: projection.current_state,
    as_of: projection.as_of,
    transition_reason: projection.transition_reason,
  });
}
