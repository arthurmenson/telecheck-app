/**
 * medication-request-service.ts — pharmacy slice service layer.
 *
 * Sprint 35-36 / TLC-055 PR D — service layer scaffold + the first
 * patient-origin write operation (patient-initiated discontinuation).
 *
 * Per ADR-001 modular monolith, the service layer composes:
 *   1. Repository call (durable boundary; optimistic concurrency)
 *   2. Audit emission (AUDIT_EVENTS v5.3 — `medication_request.discontinued`
 *      for this PR; `I-003` append-only)
 *   3. Domain event emission (DOMAIN_EVENTS v5.2 —
 *      `medication_request.discontinued.v1`)
 * All three run inside the same DB transaction so a failure rolls back
 * the entire patient action atomically. The HTTP layer wraps this in
 * `withIdempotentExecution` for `Idempotency-Key`-based replay.
 *
 * SCOPE — write surface at PR D:
 *   - discontinueByPatient: patient-self discontinue (active → discontinued
 *     via `patient_request_discontinue` event; NOT I-012-gated). This is
 *     the ONE meaningful patient-origin write transition at v1.0 (per
 *     State Machines v1.2 §19); every other write transition needs the
 *     clinician role, which the v1.0 JWT does not yet carry. The clinician
 *     write surface (createDraft / submit / approve / decline / supersede)
 *     lands in TLC-055 PR E once the identity slice ships the clinician
 *     role claim.
 *
 * Spec references:
 *   - State Machines v1.2 §19 (active → discontinued via
 *     `patient_request_discontinue`)
 *   - CDM v1.3 §4.16 MedicationRequest (discontinued_reason enum includes
 *     'patient_request')
 *   - AUDIT_EVENTS v5.3 (medication_request.discontinued Category A;
 *     not I-012-gated)
 *   - DOMAIN_EVENTS v5.2 (medication_request.discontinued.v1)
 *   - I-003 (audit append-only)
 *   - I-023 / I-025 / I-027 (tenant scoping; tenant-blind /
 *     cross-patient-blind error envelopes; tenant_id on every record)
 *   - ADR-001 (modular monolith — service-layer composition)
 *   - src/modules/async-consult/internal/services/consult-service.ts
 *     (precedent for service-layer shape + error classes + ownership check)
 */

import type { DbTransaction } from '../../../../lib/db.js';
import { withTransaction } from '../../../../lib/db.js';
import type { TenantContext } from '../../../../lib/tenant-context.js';
import { emitMedicationRequestDiscontinued } from '../../audit.js';
import { emitMedicationRequestDiscontinued as emitMedicationRequestDiscontinuedDomainEvent } from '../../domain-events.js';
import * as medicationRequestRepo from '../repositories/medication-request-repo.js';
import type { MedicationRequest, MedicationRequestId } from '../types.js';

// ---------------------------------------------------------------------------
// Error classes (mirror async-consult's typed error → HTTP mapping pattern)
// ---------------------------------------------------------------------------

/**
 * The requested medication_request was not found in the actor's tenant.
 * HTTP layer maps to tenant-blind 404 `internal.resource.not_found`.
 *
 * ALSO thrown when the row exists but belongs to a different patient
 * (cross-patient ownership violation). Per I-025 the two conditions
 * collapse to a single envelope — a same-tenant attacker MUST NOT be
 * able to distinguish "doesn't exist" from "exists but not yours".
 */
export class MedicationRequestNotFoundError extends Error {
  constructor(public readonly medicationRequestId: MedicationRequestId) {
    super(`MedicationRequest ${medicationRequestId} not found.`);
    this.name = 'MedicationRequestNotFoundError';
  }
}

/**
 * The requested transition is incompatible with the row's current state.
 * Two causes collapse into this single class because the HTTP layer
 * maps them identically (409):
 *   1. The row's status is not 'active' (e.g., already discontinued,
 *      still in draft) so the patient_request_discontinue event has no
 *      valid `from` state.
 *   2. Concurrent writer raced the UPDATE; the repo's optimistic-
 *      concurrency `WHERE status = expected_from_status` filtered to
 *      zero rows.
 * HTTP layer maps to 409 `internal.resource.conflict`.
 */
export class MedicationRequestStateConflictError extends Error {
  constructor(
    public readonly medicationRequestId: MedicationRequestId,
    public readonly observedStatus: string | null,
  ) {
    super(
      `MedicationRequest ${medicationRequestId} state conflict (observed: ${
        observedStatus ?? 'unknown'
      }).`,
    );
    this.name = 'MedicationRequestStateConflictError';
  }
}

// ---------------------------------------------------------------------------
// discontinueByPatient — the single PR D write operation
// ---------------------------------------------------------------------------

/**
 * Patient-initiated discontinuation of an active medication_request.
 *
 * Composition (all in one transaction):
 *   1. Load row by id (tenant-scoped). Null → tenant-blind not-found.
 *   2. Ownership check: row.patient_account_id MUST match actor.accountId.
 *      Mismatch → MedicationRequestNotFoundError (cross-patient-blind
 *      per I-025; collapsed into the not-found envelope).
 *   3. Status precondition: row.status MUST be 'active'. Otherwise
 *      MedicationRequestStateConflictError (HTTP 409).
 *   4. repo.transitionStatus(active → discontinued,
 *      event=patient_request_discontinue, discontinued_reason='patient_request',
 *      discontinued_at=NOW()). Null result indicates concurrent writer
 *      raced → 409.
 *   5. emitAudit medication_request.discontinued (actor_type='patient',
 *      discontinued_reason='patient_request'). I-027 tenant scoping;
 *      I-003 append-only.
 *   6. emitDomainEvent medication_request.discontinued.v1.
 *
 * Returns the updated row (status='discontinued').
 *
 * I-012 NOT applicable here — patient_request_discontinue is not an
 * I-012-gated event (no AI involvement, no execution-authority grant).
 */
export async function discontinueByPatient(
  ctx: TenantContext,
  actor: { accountId: string },
  medicationRequestId: MedicationRequestId,
  externalTx?: DbTransaction,
): Promise<MedicationRequest> {
  return withTransaction(async (tx) => {
    await tx.query('SELECT set_tenant_context($1)', [ctx.tenantId]);

    // Step 1: load by id (tenant-scoped via RLS + explicit predicate).
    const current = await medicationRequestRepo.findById(ctx.tenantId, medicationRequestId, tx);
    if (current === null) {
      throw new MedicationRequestNotFoundError(medicationRequestId);
    }

    // Step 2: cross-patient ownership check. I-025 collapses into the
    // not-found envelope at the HTTP layer.
    if (current.patient_account_id !== actor.accountId) {
      throw new MedicationRequestNotFoundError(medicationRequestId);
    }

    // Step 3: status precondition. The state-machine transition table
    // says patient_request_discontinue requires from='active'.
    if (current.status !== 'active') {
      throw new MedicationRequestStateConflictError(medicationRequestId, current.status);
    }

    const discontinuedAt = new Date();

    // Step 4: transitionStatus with optimistic-concurrency guard.
    // validateTransition fires inside the repo BEFORE the UPDATE.
    const updated = await medicationRequestRepo.transitionStatus(
      {
        id: medicationRequestId,
        tenant_id: ctx.tenantId,
        expected_from_status: 'active',
        to_status: 'discontinued',
        event: 'patient_request_discontinue',
        discontinued_reason: 'patient_request',
        discontinued_at: discontinuedAt,
      },
      tx,
    );
    if (updated === null) {
      // Concurrent writer raced; the row's status changed between
      // step 3 and step 4 (e.g., a clinician discontinued it).
      throw new MedicationRequestStateConflictError(medicationRequestId, null);
    }

    // Step 5: audit (I-003 append-only). action_id is the row's id per
    // the state-machine §9 convention.
    await emitMedicationRequestDiscontinued(
      {
        tenantId: ctx.tenantId,
        patientAccountId: actor.accountId,
        medicationRequestId,
        countryOfCare: ctx.countryOfCare,
        actorType: 'patient',
        actorId: actor.accountId,
        discontinuedReason: 'patient_request',
        detail: {
          /* canonical envelope fields handled by buildEnvelope */
        },
      },
      tx,
    );

    // Step 6: domain event (DOMAIN_EVENTS v5.2). partition_key is the
    // tenant-scoped composite `${tenant_id}:${aggregate_id}`.
    await emitMedicationRequestDiscontinuedDomainEvent(tx, {
      tenantId: ctx.tenantId,
      medicationRequestId,
      occurredAt: discontinuedAt,
      patientAccountId: actor.accountId,
      discontinuedReason: 'patient_request',
      discontinuedByActor: {
        actor_type: 'patient',
        actor_id: actor.accountId,
      },
    });

    return updated;
  }, externalTx);
}
