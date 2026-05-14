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

import type { DbClient, DbTransaction } from '../../../../lib/db.js';
import { withTransaction } from '../../../../lib/db.js';
import { asMedicationRequestId } from '../../../../lib/glossary.js';
import type { IdempotencyCtx } from '../../../../lib/idempotency.js';
import { withIdempotency } from '../../../../lib/idempotency.js';
import type { TenantContext } from '../../../../lib/tenant-context.js';
import { ulid } from '../../../../lib/ulid.js';
import { asAccountId, findAccountById } from '../../../identity/index.js';
import {
  emitMedicationRequestDiscontinued,
  emitMedicationRequestDrafted,
  emitMedicationRequestInteractionEvaluationCompleted,
  emitMedicationRequestSubmittedForReview,
  emitMedicationRequestSuperseded,
  emitPrescribingApproved,
  emitPrescribingDeclined,
  emitPrescribingExecutionRejected,
} from '../../audit.js';
import {
  emitMedicationRequestApproved,
  emitMedicationRequestDiscontinued as emitMedicationRequestDiscontinuedDomainEvent,
  emitMedicationRequestInteractionSafetyHoldTriggered,
  emitMedicationRequestSuperseded as emitMedicationRequestSupersededDomainEvent,
} from '../../domain-events.js';
import * as medicationRequestRepo from '../repositories/medication-request-repo.js';
import { I012RejectError } from '../state-machine.js';
import type { MedicationRequest, MedicationRequestId, ProductCatalogId } from '../types.js';

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

/**
 * Body-level validation error — the request inputs are structurally
 * valid (correct types, required fields present) but a cross-row
 * invariant is violated. HTTP layer maps to 400 internal.request.invalid.
 *
 * Cases (Codex PR-119 R1 HIGH/MEDIUM closures 2026-05-13):
 *   - patient_account_id resolves to a non-'patient' account (clinician
 *     or delegate) in the same tenant. medication_requests anchors on
 *     patient accounts only; the durable FK target accounts(tenant_id,
 *     account_id) doesn't discriminate type, so the service must.
 *   - prescribing_consult_id is set but the consult's patient_id ≠
 *     input.patient_account_id (clinician tied draft to another
 *     patient's consult — clinical-provenance corruption).
 *
 * The error message is intentionally generic — per I-025 a same-tenant
 * attacker should not learn whether the offending id exists at all.
 */
export class MedicationRequestInputValidationError extends Error {
  constructor(public readonly reason: string) {
    super(`MedicationRequest input validation failed: ${reason}`);
    this.name = 'MedicationRequestInputValidationError';
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

// ---------------------------------------------------------------------------
// createDraftAsClinician — first PR E write operation
//
// Per State Machines v1.2 §19, the draft creation is clinician-origin
// and NOT I-012-gated (the I-012 gate sits at the activation transitions
// clinician_approve / protocol_authorized_prescribing). createDraft just
// captures the prescriber's intended medication; the engine evaluation +
// clinician approval cycle happens after submit_for_review.
//
// Composition (single transaction):
//   1. Generate canonical MedicationRequestId (mrx_<ULID>).
//   2. repo.createDraft inside the tx (composite FKs enforce same-tenant
//      patient, consult, product_catalog at the durable boundary).
//   3. emitAudit medication_request.drafted (Category A, actor_type=clinician).
//
// No domain event emitted at draft creation — DOMAIN_EVENTS v5.2 reserves
// medication_request.approved.v1 for the activation handoff. Draft rows
// are not yet authoritative for downstream subscribers.
// ---------------------------------------------------------------------------

/**
 * createDraft request shape — clinician-supplied fields ONLY. Notably
 * absent (Codex PR-119 R1 HIGH closure 2026-05-13):
 *   - country_of_care: derived server-side from `ctx.countryOfCare`.
 *     Accepting it from the client allowed a US-tenant clinician to
 *     persist a row with `country_of_care: 'GH'` — misrouting CCR
 *     resolution and creating audit/row metadata disagreement.
 */
export interface CreateDraftAsClinicianInput {
  patient_account_id: string;
  product_catalog_id: ProductCatalogId;
  medication_name: string;
  strength: string;
  formulation: string;
  dose_instructions: string;
  quantity: number;
  quantity_unit: string;
  refills_allowed: number;
  indication: string | null;
  clinical_notes: string | null;
  prescribing_consult_id: string | null;
  protocol_id: string | null;
  protocol_version: string | null;
}

/**
 * Verify the prescribing consult belongs to the same patient as the
 * draft anchor. Closes Codex PR-119 R1 MEDIUM — clinician tying a
 * draft to another patient's consult would corrupt clinical
 * provenance. Returns true iff:
 *   - consult exists in this tenant
 *   - consult.patient_id === input patient_account_id
 *
 * Raw SQL because the cross-module surface (async-consult's
 * findConsultById) is internal — exporting it from async-consult's
 * public interface is a separate refactor.
 */
async function consultBelongsToPatient(
  tx: DbClient,
  tenantId: string,
  consultId: string,
  patientAccountId: string,
): Promise<boolean> {
  const result = await tx.query<{ patient_id: string }>(
    `SELECT patient_id
       FROM consults
      WHERE tenant_id = $1 AND id = $2`,
    [tenantId, consultId],
  );
  if (result.rows.length === 0) return false;
  return result.rows[0]?.patient_id === patientAccountId;
}

/**
 * Verify the product_catalog row exists in this tenant. Codex PR-119
 * R5 MEDIUM closure 2026-05-13: previously the service short-circuited
 * on patient validation and let the product FK be discovered at INSERT
 * time. A timing-side-channel attacker could distinguish nonexistent-
 * patient (3 SELECTs, no INSERT) from existing-patient + bad-product
 * (3 SELECTs + INSERT + FK rollback) even when public envelopes were
 * byte-identical. Pre-validating the product in the service equalizes
 * the SQL workload across both probe shapes.
 */
async function productCatalogExists(
  tx: DbClient,
  tenantId: string,
  productCatalogId: string,
): Promise<boolean> {
  const result = await tx.query<{ id: string }>(
    `SELECT id
       FROM product_catalog
      WHERE tenant_id = $1 AND id = $2`,
    [tenantId, productCatalogId],
  );
  return result.rows.length > 0;
}

export async function createDraftAsClinician(
  ctx: TenantContext,
  actor: { accountId: string },
  input: CreateDraftAsClinicianInput,
  externalTx?: DbTransaction,
): Promise<MedicationRequest> {
  return withTransaction(async (tx) => {
    await tx.query('SELECT set_tenant_context($1)', [ctx.tenantId]);

    // Validate all three foreign references BEFORE any state-mutating
    // INSERT (Codex PR-119 R1 HIGH + R5 MEDIUM closures 2026-05-13).
    // Run all SELECTs unconditionally so the SQL workload is identical
    // regardless of which check ultimately fails — closes the timing-
    // side-channel that distinguished nonexistent-patient from
    // existing-patient+bad-product probes even when public envelopes
    // were byte-identical.
    //
    // Invariants enforced here:
    //   - patient_account_id: row exists in this tenant AND
    //     account_type='patient' (R1: durable FK is type-agnostic
    //     post-TLC-058; non-patient would corrupt patient-indexed
    //     medication history).
    //   - product_catalog_id: row exists in this tenant. Previously
    //     deferred to FK 23503 at INSERT; pre-validating equalizes
    //     SQL paths across probe shapes (R5).
    //   - prescribing_consult_id (when set): consult row exists in
    //     this tenant AND consult.patient_id === input.patient_account_id
    //     (R1 MEDIUM: clinician tying a draft to another patient's
    //     consult corrupts clinical provenance).
    //
    // Failure-mode design: each check produces a boolean. We
    // accumulate without short-circuit, then throw a SINGLE generic
    // MedicationRequestInputValidationError after the full validation
    // pass — the public 400 envelope is collapsed at the handler so
    // the err.reason here is internal-only.
    const patientAccount = await findAccountById(ctx, asAccountId(input.patient_account_id), tx);
    const patientOk = patientAccount !== null && patientAccount.account_type === 'patient';

    const productOk = await productCatalogExists(tx, ctx.tenantId, input.product_catalog_id);

    let consultOk = true;
    if (input.prescribing_consult_id !== null) {
      consultOk = await consultBelongsToPatient(
        tx,
        ctx.tenantId,
        input.prescribing_consult_id,
        input.patient_account_id,
      );
    }

    if (!patientOk || !productOk || !consultOk) {
      // Single generic reason — handler collapses to a public message.
      // The server-side reason text is uniform across all failure
      // permutations so even server logs / telemetry don't expose
      // which specific check tripped (defense-in-depth above the
      // public-envelope collapse).
      throw new MedicationRequestInputValidationError(
        'patient_account_id / product_catalog_id / prescribing_consult_id ' +
          'failed tenant + type + ownership validation.',
      );
    }

    const medicationRequestId = asMedicationRequestId(`mrx_${ulid()}`);

    const created = await medicationRequestRepo.createDraft(
      {
        id: medicationRequestId,
        tenant_id: ctx.tenantId,
        patient_account_id: input.patient_account_id,
        product_catalog_id: input.product_catalog_id,
        medication_name: input.medication_name,
        strength: input.strength,
        formulation: input.formulation,
        dose_instructions: input.dose_instructions,
        quantity: input.quantity,
        quantity_unit: input.quantity_unit,
        refills_allowed: input.refills_allowed,
        indication: input.indication,
        clinical_notes: input.clinical_notes,
        prescribing_consult_id: input.prescribing_consult_id,
        // country_of_care derived server-side from tenant context.
        // Accepting it from the body would allow a US-tenant clinician
        // to misroute CCR resolution by passing 'GH'.
        country_of_care: ctx.countryOfCare,
        protocol_id: input.protocol_id,
        protocol_version: input.protocol_version,
      },
      tx,
    );

    await emitMedicationRequestDrafted(
      {
        tenantId: ctx.tenantId,
        patientAccountId: input.patient_account_id,
        medicationRequestId,
        countryOfCare: ctx.countryOfCare,
        clinicianAccountId: actor.accountId,
        detail: {},
      },
      tx,
    );

    return created;
  }, externalTx);
}

// ---------------------------------------------------------------------------
// submitForReviewAsClinician — clinician advances draft → pending_interaction_check
//
// Per State Machines v1.2 §19, submit_for_review is clinician-origin and
// NOT I-012-gated. The transition hands the draft off to the Med
// Interaction Engine (which writes back via recordInteractionEvaluation
// in PR F).
//
// Composition:
//   1. Load by id; verify the row exists.
//   2. Status precondition: must be 'draft'.
//   3. repo.transitionStatus(draft → pending_interaction_check,
//      event=submit_for_review). The repo's validateTransition fires
//      first; the optimistic-concurrency WHERE filters concurrent writers.
//   4. emitAudit medication_request.submitted_for_review.
// ---------------------------------------------------------------------------

export async function submitForReviewAsClinician(
  ctx: TenantContext,
  actor: { accountId: string },
  medicationRequestId: MedicationRequestId,
  externalTx?: DbTransaction,
): Promise<MedicationRequest> {
  return withTransaction(async (tx) => {
    await tx.query('SELECT set_tenant_context($1)', [ctx.tenantId]);

    const current = await medicationRequestRepo.findById(ctx.tenantId, medicationRequestId, tx);
    if (current === null) {
      throw new MedicationRequestNotFoundError(medicationRequestId);
    }
    if (current.status !== 'draft') {
      throw new MedicationRequestStateConflictError(medicationRequestId, current.status);
    }

    const updated = await medicationRequestRepo.transitionStatus(
      {
        id: medicationRequestId,
        tenant_id: ctx.tenantId,
        expected_from_status: 'draft',
        to_status: 'pending_interaction_check',
        event: 'submit_for_review',
      },
      tx,
    );
    if (updated === null) {
      // Concurrent writer raced the optimistic-concurrency UPDATE.
      throw new MedicationRequestStateConflictError(medicationRequestId, null);
    }

    await emitMedicationRequestSubmittedForReview(
      {
        tenantId: ctx.tenantId,
        patientAccountId: current.patient_account_id,
        medicationRequestId,
        countryOfCare: ctx.countryOfCare,
        clinicianAccountId: actor.accountId,
        detail: {},
      },
      tx,
    );

    return updated;
  }, externalTx);
}

// ---------------------------------------------------------------------------
// discontinueByClinician — PR F write operation
//
// Per State Machines v1.2 §19, two non-I-012-gated transitions move an
// active medication_request → discontinued at clinician request:
//
//   - clinician_discontinue       (discontinued_reason='clinical_decision')
//   - adverse_event_discontinue   (discontinued_reason='adverse_event')
//
// The clinician-discontinue surface is the symmetric counterpart to PR D's
// patient-self-discontinue. Differences:
//
//   - Actor: clinician role (not patient). The handler gates on
//     requireClinicianLiveSession.
//   - No cross-patient ownership check at v1.0 — a clinician at the
//     tenant has full Rx-management authority over any active
//     medication_request in their tenant per RBAC v1.1 §1.2. Future
//     RBAC narrowing (per-assignment access) ships with the RBAC slice,
//     not pharmacy.
//   - Reason is caller-supplied (clinical_decision OR adverse_event),
//     unlike PR D which forces patient_request server-side.
//   - Audit actor_type='clinician' (PR D used 'patient').
//
// I-012 NOT applicable — neither transition involves AI execution
// authority. The activation envelope (ai_workload_type, autonomy_level)
// stays whatever the row carried at activation.
// ---------------------------------------------------------------------------

export type ClinicianDiscontinueReason = 'clinical_decision' | 'adverse_event';

function reasonToEvent(
  reason: ClinicianDiscontinueReason,
): 'clinician_discontinue' | 'adverse_event_discontinue' {
  return reason === 'adverse_event' ? 'adverse_event_discontinue' : 'clinician_discontinue';
}

export async function discontinueByClinician(
  ctx: TenantContext,
  actor: { accountId: string },
  medicationRequestId: MedicationRequestId,
  reason: ClinicianDiscontinueReason,
  externalTx?: DbTransaction,
): Promise<MedicationRequest> {
  return withTransaction(async (tx) => {
    await tx.query('SELECT set_tenant_context($1)', [ctx.tenantId]);

    // Step 1: load by id (tenant-scoped via RLS + explicit predicate).
    const current = await medicationRequestRepo.findById(ctx.tenantId, medicationRequestId, tx);
    if (current === null) {
      throw new MedicationRequestNotFoundError(medicationRequestId);
    }

    // Step 2: status precondition — only 'active' rows discontinue.
    if (current.status !== 'active') {
      throw new MedicationRequestStateConflictError(medicationRequestId, current.status);
    }

    const discontinuedAt = new Date();
    const event = reasonToEvent(reason);

    // Step 3: transitionStatus with optimistic-concurrency guard.
    // validateTransition fires inside the repo BEFORE the UPDATE.
    const updated = await medicationRequestRepo.transitionStatus(
      {
        id: medicationRequestId,
        tenant_id: ctx.tenantId,
        expected_from_status: 'active',
        to_status: 'discontinued',
        event,
        discontinued_reason: reason,
        discontinued_at: discontinuedAt,
      },
      tx,
    );
    if (updated === null) {
      // Concurrent writer raced; row's status changed between step 2
      // and step 3 (e.g., patient self-discontinued first).
      throw new MedicationRequestStateConflictError(medicationRequestId, null);
    }

    // Step 4: audit (I-003 append-only). action_id is the row's id per
    // the state-machine §9 convention.
    await emitMedicationRequestDiscontinued(
      {
        tenantId: ctx.tenantId,
        patientAccountId: current.patient_account_id,
        medicationRequestId,
        countryOfCare: ctx.countryOfCare,
        actorType: 'clinician',
        actorId: actor.accountId,
        discontinuedReason: reason,
        detail: {},
      },
      tx,
    );

    // Step 5: domain event (DOMAIN_EVENTS v5.2). partition_key is the
    // tenant-scoped composite tenant_id:aggregate_id.
    await emitMedicationRequestDiscontinuedDomainEvent(tx, {
      tenantId: ctx.tenantId,
      medicationRequestId,
      occurredAt: discontinuedAt,
      patientAccountId: current.patient_account_id,
      discontinuedReason: reason,
      discontinuedByActor: {
        actor_type: 'clinician',
        actor_id: actor.accountId,
      },
    });

    return updated;
  }, externalTx);
}

// ---------------------------------------------------------------------------
// approveAsClinician — PR G I-012-gated activation
//
// Per State Machines v1.2 §19, the clinician-only route into `active`:
//
//   pending_clinician_review --[clinician_approve]--> active
//
// This is the first I-012-gated transition in the pharmacy slice. I-012's
// reject-unless three-clause rule applies (per Master PRD v1.10 §13.7;
// AUDIT_EVENTS v5.3 §I-012 preservation rule; State Machines v1.2 §19):
//
//   (1) AI-participating execution attribution: vacuously satisfied for
//       the clinician-only route — row envelope ai_workload_type=null AND
//       autonomy_level=null per migration 025 CHECK clause (a); audit
//       envelope uses the canonical 'n/a' sentinel per AUDIT_EVENTS v5.3
//       §I-012 closure rule line 127 clinician-confirmation carve-out.
//   (2) Audit-chain confirmation event scoped to action_id: the
//       prescribing.approved emission IS the confirmation event for the
//       clinician_approve route (the clinician is the executing actor;
//       no prior separate event needed). We emit it FIRST inside the same
//       transaction, then thread its audit_id into the I012GuardContext.
//   (3) RBAC-authorized confirming actor: enforced upstream by
//       requireClinicianLiveSession in the handler (tenant context +
//       clinician role + live session + clinician account binding).
//
// On I012RejectError: per I-003 audit append-only + the I-012
// rejection-audit-event rule, prescribing.execution_rejected MUST be
// emitted. The outer write transaction has already rolled back (taking
// the prescribing.approved insert with it), so the rejection audit
// emits in a SEPARATE follow-up transaction so it persists.
//
// Domain event medication_request.approved.v1 carries
// approval_pathway='clinician_reviewed' to discriminate from the Mode 2
// protocol-authorized route.
// ---------------------------------------------------------------------------

export async function approveAsClinician(
  ctx: TenantContext,
  actor: { accountId: string },
  medicationRequestId: MedicationRequestId,
  externalTx?: DbTransaction,
): Promise<MedicationRequest> {
  // Note on the I-012 rejection path (Codex PR G R1 HIGH closure
  // 2026-05-13): the I012RejectError that may bubble out of
  // transitionStatus → validateTransition is NOT caught here. An earlier
  // draft emitted prescribing.execution_rejected from a nested
  // withTransaction inside this catch block, but when the service is
  // called with an externalTx (the idempotency wrapper's outer tx), the
  // outer tx is still open at catch time — the audit hash-chain
  // pg_advisory_xact_lock per (tenant_id, patient_id) partition is still
  // held by the prescribing.approved insert emitted in step 3. The fresh
  // rejection-audit tx tries to acquire the same lock and blocks behind
  // a tx that can only release the lock by returning, which is exactly
  // what the catch block is preventing — a self-block until the
  // statement_timeout fires.
  //
  // Correct discipline: the handler's `emitApprovalI012RejectionAudit`
  // wrapper runs the rejection emission AFTER `withIdempotentExecution`
  // has returned (the outer tx has rolled back, the lock has been
  // released). The service surfaces I012RejectError unchanged; the
  // handler catches it post-rollback, emits the rejection audit in a
  // clean fresh tx, and returns 409. Bare suppression is still
  // forbidden per I-003 — the rejection emission is mandatory on every
  // I012RejectError path that reaches the handler.
  return withTransaction(async (tx) => {
    await tx.query('SELECT set_tenant_context($1)', [ctx.tenantId]);

    // Step 1: load by id (tenant-scoped via RLS + explicit predicate).
    const current = await medicationRequestRepo.findById(ctx.tenantId, medicationRequestId, tx);
    if (current === null) {
      throw new MedicationRequestNotFoundError(medicationRequestId);
    }

    // Step 2: status precondition — only 'pending_clinician_review'
    // rows are approvable. State Machines v1.2 §19 admits no other
    // source state for clinician_approve.
    if (current.status !== 'pending_clinician_review') {
      throw new MedicationRequestStateConflictError(medicationRequestId, current.status);
    }

    const prescribedAt = new Date();

    // Step 3: emit prescribing.approved FIRST (the I-012 confirmation
    // event for the clinician_approve route per the §19 §19.X
    // discrimination: "the confirmation event IS the prescribing.approved
    // emission itself"). action_id == medicationRequestId per the
    // state-machine §9 convention. Workload/autonomy envelope: 'n/a'/'n/a'
    // (clinician-only carve-out; no upstream AI workload contributed).
    const approvedAudit = await emitPrescribingApproved(
      {
        tenantId: ctx.tenantId,
        patientAccountId: current.patient_account_id,
        medicationRequestId,
        countryOfCare: ctx.countryOfCare,
        clinicianAccountId: actor.accountId,
        detail: {},
      },
      tx,
    );

    // Step 4: transitionStatus with the I-012 guard threading the
    // just-emitted audit's id. validateTransition (inside transitionStatus)
    // cross-checks the attested context against the pending_transition
    // and throws I012RejectError on any clause failure. I012RejectError
    // is intentionally NOT caught here (see top-of-function note) — it
    // bubbles to the handler.
    const updated = await medicationRequestRepo.transitionStatus(
      {
        id: medicationRequestId,
        tenant_id: ctx.tenantId,
        expected_from_status: 'pending_clinician_review',
        to_status: 'active',
        event: 'clinician_approve',
        prescribed_by_clinician_account_id: actor.accountId,
        prescribed_at: prescribedAt,
        // activation_envelope intentionally undefined for the
        // clinician-only route per migration 025 CHECK (a) — row
        // ai_workload_type / autonomy_level stay null.
        pending_transition: {
          tenant_id: ctx.tenantId,
          action_id: medicationRequestId,
          patient_account_id: current.patient_account_id,
          actor_id: actor.accountId,
          protocol_id: null,
          protocol_version: null,
        },
        i012_guard: {
          route: 'clinician_approve',
          confirmation_event_audit_id: approvedAudit.audit_id,
          attested_tenant_id: ctx.tenantId,
          attested_action_id: medicationRequestId,
          attested_patient_account_id: current.patient_account_id,
          attested_actor_id: actor.accountId,
          confirming_actor_rbac_authorized: true,
        },
      },
      tx,
    );
    if (updated === null) {
      // Concurrent writer raced the optimistic-concurrency UPDATE
      // (e.g., another clinician approved this row between step 2
      // and step 4, or the row was patient-discontinued).
      throw new MedicationRequestStateConflictError(medicationRequestId, null);
    }

    // Step 5: domain event medication_request.approved.v1 with
    // approval_pathway='clinician_reviewed'. Carries the prescribing
    // snapshot the downstream consumers need (Subscription binds new
    // active rows; Notification dispatches patient + clinician alerts).
    await emitMedicationRequestApproved(tx, {
      tenantId: ctx.tenantId,
      medicationRequestId,
      occurredAt: prescribedAt,
      patientAccountId: current.patient_account_id,
      approvalPathway: 'clinician_reviewed',
      prescriberAccountId: actor.accountId,
      productCatalogId: current.product_catalog_id,
      medication: {
        code: current.product_catalog_id,
        name: current.medication_name,
        strength: current.strength,
        formulation: current.formulation,
      },
      dosing: {
        instructions: current.dose_instructions,
        quantity: current.quantity,
        quantity_unit: current.quantity_unit,
        refills_allowed: current.refills_allowed,
      },
      interactionSignals: [],
      overrides: [],
      protocolId: null,
      protocolVersion: null,
      aiWorkloadType: null,
      autonomyLevel: null,
    });

    return updated;
  }, externalTx);
}

/**
 * Operational error: an `I012RejectError` reached the handler but the
 * post-rollback row lookup that anchors the rejection audit returned
 * null. Per Codex PR G R2 HIGH closure 2026-05-13 this MUST surface as
 * an operational failure rather than silently emit a bare 409 without
 * the canonical I-012 rejection audit (I-003 bare-suppression
 * forbidden + I-012 rejection-audit-event rule).
 *
 * Realistic failure mode: an out-of-band tenant-context mismatch
 * between request arrival and post-rollback lookup, OR a row deletion
 * that should not happen at v1.0 (medication_requests has no DELETE
 * path). The handler logs and returns 500 so ops surface the anomaly.
 */
export class ApprovalI012RejectionAuditAnchorMissingError extends Error {
  constructor(public readonly medicationRequestId: MedicationRequestId) {
    super(
      `Cannot anchor I-012 rejection audit for ${medicationRequestId}: ` +
        'post-rollback patient lookup returned null. The row vanished ' +
        'between writing-tx rollback and rejection-audit emission, OR ' +
        'the tenant context drifted. Audit-chain integrity requires ' +
        'fail-closed semantics on this path.',
    );
    this.name = 'ApprovalI012RejectionAuditAnchorMissingError';
  }
}

/**
 * Emit `prescribing.execution_rejected` for a clinician_approve attempt
 * that failed the I-012 reject-unless three-clause rule, AND atomically
 * persist a completed `idempotency_keys` row keyed by the request's
 * Idempotency-Key 4-tuple so future retries with the same key + body
 * replay the 409 instead of re-emitting the rejection audit.
 *
 * MUST be called by the HTTP handler AFTER `withIdempotentExecution`
 * has returned (the outer writing tx has rolled back; the audit-chain
 * advisory lock has been released).
 *
 * Design (post-Codex PR G R3 HIGH closure 2026-05-13):
 *
 *   1. Open a fresh tx (the outer writing tx has rolled back; the
 *      advisory lock per (tenant_id, patient_id) is released).
 *   2. Call `withIdempotency` inside the fresh tx. The body callback:
 *      - Resolves the row's patient_account_id from a fresh repo
 *        lookup (no caller-supplied path; eliminates the
 *        bare-suppression bypass closed in R2).
 *      - Throws ApprovalI012RejectionAuditAnchorMissingError if the
 *        row is gone (operational anomaly; handler maps to 500).
 *      - Emits prescribing.execution_rejected (Category A; clinician
 *        carve-out workload+autonomy 'n/a').
 *      - Returns `{ status: 409, body: rejectionEnvelope }`. This
 *        body is what `withIdempotency` writes to the idempotency
 *        cache, so the next replay with the same key + body gets
 *        replied verbatim from the cache (no re-emission).
 *   3. Returns `{ status, body }` to the handler so it can `reply`.
 *
 * Concurrent-retry semantics:
 *   - If the original failed request's idempotency reservation was
 *     rolled back along with its writing tx, this fresh call reserves
 *     anew + completes — the canonical happy-path-of-the-failure.
 *   - If a concurrent retry races us, `withIdempotency` throws
 *     `IdempotencyReplayError` (other tx already completed) or
 *     `IdempotencyInFlightError` (other tx is mid-emission); the
 *     handler maps both to a cached-or-409 reply. The audit emits at
 *     most once per (tenant, key, endpoint, actor) 4-tuple.
 *
 * Workload/autonomy envelope: 'n/a'/'n/a' per the clinician-only route.
 *
 * `rejectionEnvelope` is the response body the handler intends to send
 * on a successful audit emission (a `makeErrorEnvelope`-shaped
 * conflict). Caching the envelope means retries get a byte-identical
 * replay including the original request_id — by IDEMPOTENCY v5.1
 * design.
 */
export async function emitApprovalI012RejectionAudit(
  ctx: TenantContext,
  actor: { accountId: string },
  medicationRequestId: MedicationRequestId,
  violatedClauses: I012RejectError['violated_clauses'],
  idempotencyCtx: IdempotencyCtx,
  rejectionEnvelope: unknown,
): Promise<{ status: number; body: unknown }> {
  return withTransaction(async (rejTx) => {
    await rejTx.query('SELECT set_tenant_context($1)', [ctx.tenantId]);
    return withIdempotency(rejTx, idempotencyCtx, async () => {
      const current = await medicationRequestRepo.findById(
        ctx.tenantId,
        medicationRequestId,
        rejTx,
      );
      if (current === null) {
        throw new ApprovalI012RejectionAuditAnchorMissingError(medicationRequestId);
      }
      await emitPrescribingExecutionRejected(
        {
          tenantId: ctx.tenantId,
          patientAccountId: current.patient_account_id,
          medicationRequestId,
          countryOfCare: ctx.countryOfCare,
          attemptedActorType: 'clinician',
          attemptedActorId: actor.accountId,
          attemptedAiWorkloadType: 'n/a',
          attemptedAutonomyLevel: 'n/a',
          violatedClauses,
          confirmationEventState: 'absent',
          rbacRoleCheckResult: 'authorized',
          detail: {},
        },
        rejTx,
      );
      return { status: 409, body: rejectionEnvelope };
    });
  });
}

// ---------------------------------------------------------------------------
// declineByClinician — PR H clinician_decline write operation
//
// State Machines v1.2 §19:
//
//   pending_clinician_review --[clinician_decline]--> rejected (terminal)
//
// NOT I-012-gated: a clinician's deliberate refusal is the OPPOSITE of an
// execution. The audit envelope uses the clinician-only workload+autonomy
// 'n/a' sentinels (mirrors prescribing.declined emitter — actor_type=
// 'clinician'; not an I-012 rejection).
//
// No domain event at v1.0: `rejected` is terminal with no current
// downstream subscribers (Subscription / Notification cascade only fires
// on `medication_request.approved.v1` and `.discontinued.v1`). A
// future medication_request.declined.v1 can be added when a consumer
// (e.g., a clinician dashboard surface that tracks decline rates) lands.
// ---------------------------------------------------------------------------

export interface ClinicianDeclineInput {
  /** Canonical reason code — narrow enum per slice convention. */
  reasonCode: 'unsafe' | 'inappropriate_indication' | 'insufficient_information' | 'other';
  /** Optional free-text rationale (audit detail; not patient-facing). */
  reasonText: string | null;
  /** Optional recommended-action hint (e.g., 'request_more_history'). */
  recommendedAction: string | null;
}

export async function declineByClinician(
  ctx: TenantContext,
  actor: { accountId: string },
  medicationRequestId: MedicationRequestId,
  input: ClinicianDeclineInput,
  externalTx?: DbTransaction,
): Promise<MedicationRequest> {
  return withTransaction(async (tx) => {
    await tx.query('SELECT set_tenant_context($1)', [ctx.tenantId]);

    // Step 1: load (tenant-scoped via RLS + explicit predicate).
    const current = await medicationRequestRepo.findById(ctx.tenantId, medicationRequestId, tx);
    if (current === null) {
      throw new MedicationRequestNotFoundError(medicationRequestId);
    }

    // Step 2: state precondition — only pending_clinician_review rows
    // are declinable. State Machines v1.2 §19 admits no other source
    // state for clinician_decline.
    if (current.status !== 'pending_clinician_review') {
      throw new MedicationRequestStateConflictError(medicationRequestId, current.status);
    }

    // Step 3: transition pending_clinician_review → rejected (terminal).
    // clinician_decline is NOT I-012-gated, so no I012GuardContext +
    // PendingTransitionContext. validateTransition (inside
    // transitionStatus) enforces from/event validity only.
    const updated = await medicationRequestRepo.transitionStatus(
      {
        id: medicationRequestId,
        tenant_id: ctx.tenantId,
        expected_from_status: 'pending_clinician_review',
        to_status: 'rejected',
        event: 'clinician_decline',
      },
      tx,
    );
    if (updated === null) {
      throw new MedicationRequestStateConflictError(medicationRequestId, null);
    }

    // Step 4: audit (I-003 append-only). action_id is the row's id per
    // §9 convention.
    await emitPrescribingDeclined(
      {
        tenantId: ctx.tenantId,
        patientAccountId: current.patient_account_id,
        medicationRequestId,
        countryOfCare: ctx.countryOfCare,
        clinicianAccountId: actor.accountId,
        reasonCode: input.reasonCode,
        reasonText: input.reasonText,
        recommendedAction: input.recommendedAction,
        detail: {},
      },
      tx,
    );

    return updated;
  }, externalTx);
}

// ---------------------------------------------------------------------------
// evaluateInteractionsAsEngine — PR I engine writeback (NO HTTP at v1.0)
//
// State Machines v1.2 §19 admits two engine-driven transitions out of
// pending_interaction_check:
//
//   pending_interaction_check --[engine_clean]-->        pending_clinician_review
//   pending_interaction_check --[engine_safety_hold]-->  pending_clinician_review
//                                                        (with safety_hold flag)
//
// Composition (all in one tx):
//   1. Load row (tenant-scoped). Must be at pending_interaction_check
//      with interaction_signals_status='pending'.
//   2. recordInteractionEvaluation — writes back signals_status +
//      evaluated_at (one-shot per row per migration 025 invariants;
//      the WHERE clause filters already-completed evaluations).
//   3. transitionStatus → pending_clinician_review via engine_clean
//      (signals=clean|caution) or engine_safety_hold (signals=
//      safety_hold).
//   4. Emit medication_request.interaction_evaluation_completed
//      (Category A; actor_type='system'; aiWorkloadType/autonomyLevel
//      null per the deterministic-rules-engine carve-out — the
//      interaction engine is rule-driven at v1.0, not an AI workload).
//   5. If safety_hold: emit
//      medication_request.interaction_safety_hold_triggered.v1 so
//      the Med Interaction Engine slice's override workflow can
//      subscribe (Path 1 integration ratified at SI-001).
//
// Scope at PR I: SERVICE-CALLABLE ONLY (no HTTP). The Med Interaction
// Engine module invokes this directly. A signed system-actor HTTP
// token does not exist at v1.0; an HTTP surface lands in a follow-on
// PR when the system-token issuance lands.
// ---------------------------------------------------------------------------

export interface InteractionEvaluationInput {
  /** Signals the engine produced. Empty array on a clean evaluation. */
  interactionSignals: Array<{
    signal_id: string;
    severity: string;
    check_class: string;
  }>;
  /**
   * Engine decision on the overall row outcome:
   *   - 'clean'        no interactions of concern
   *   - 'caution'      noteworthy but not blocking (clinician informed)
   *   - 'safety_hold'  blocking; clinician override required
   * Drives the state-machine event:
   *   - clean / caution → engine_clean
   *   - safety_hold      → engine_safety_hold
   */
  signalsStatus: 'clean' | 'caution' | 'safety_hold';
  knowledgeBaseVersion: string;
  engineVersion: string;
}

export async function evaluateInteractionsAsEngine(
  ctx: TenantContext,
  medicationRequestId: MedicationRequestId,
  evaluation: InteractionEvaluationInput,
  externalTx?: DbTransaction,
): Promise<MedicationRequest> {
  return withTransaction(async (tx) => {
    await tx.query('SELECT set_tenant_context($1)', [ctx.tenantId]);

    const current = await medicationRequestRepo.findById(ctx.tenantId, medicationRequestId, tx);
    if (current === null) {
      throw new MedicationRequestNotFoundError(medicationRequestId);
    }
    if (
      current.status !== 'pending_interaction_check' ||
      current.interaction_signals_status !== 'pending'
    ) {
      throw new MedicationRequestStateConflictError(medicationRequestId, current.status);
    }

    const evaluatedAt = new Date();
    const event: 'engine_clean' | 'engine_safety_hold' =
      evaluation.signalsStatus === 'safety_hold' ? 'engine_safety_hold' : 'engine_clean';

    const writeback = await medicationRequestRepo.recordInteractionEvaluation(
      {
        id: medicationRequestId,
        tenant_id: ctx.tenantId,
        interaction_signals_status: evaluation.signalsStatus,
        interaction_signals_evaluated_at: evaluatedAt,
      },
      tx,
    );
    if (writeback === null) {
      throw new MedicationRequestStateConflictError(medicationRequestId, null);
    }

    const updated = await medicationRequestRepo.transitionStatus(
      {
        id: medicationRequestId,
        tenant_id: ctx.tenantId,
        expected_from_status: 'pending_interaction_check',
        to_status: 'pending_clinician_review',
        event,
      },
      tx,
    );
    if (updated === null) {
      throw new MedicationRequestStateConflictError(medicationRequestId, null);
    }

    await emitMedicationRequestInteractionEvaluationCompleted(
      {
        tenantId: ctx.tenantId,
        patientAccountId: current.patient_account_id,
        medicationRequestId,
        countryOfCare: ctx.countryOfCare,
        interactionSignalsStatus: evaluation.signalsStatus,
        engineVersion: evaluation.engineVersion,
        knowledgeBaseVersion: evaluation.knowledgeBaseVersion,
        detail: { interaction_signals: evaluation.interactionSignals },
      },
      tx,
    );

    if (evaluation.signalsStatus === 'safety_hold') {
      // prescribed_by_clinician_account_id is NULL on pre-active rows
      // per migration 025 CHECK clause (a); pass it through unchanged.
      // The domain event payload's prescriber_id is nullable per
      // emitMedicationRequestInteractionSafetyHoldTriggered's contract
      // — the Med Interaction Engine slice's override workflow handles
      // the null by routing to whichever clinician picks up the row at
      // pending_clinician_review (Codex PR I R1 HIGH closure
      // 2026-05-13).
      await emitMedicationRequestInteractionSafetyHoldTriggered(tx, {
        tenantId: ctx.tenantId,
        medicationRequestId,
        occurredAt: evaluatedAt,
        patientAccountId: current.patient_account_id,
        prescriberAccountId: current.prescribed_by_clinician_account_id,
        interactionSignals: evaluation.interactionSignals,
        engineVersion: evaluation.engineVersion,
        knowledgeBaseVersion: evaluation.knowledgeBaseVersion,
      });
    }

    return updated;
  }, externalTx);
}

// ---------------------------------------------------------------------------
// supersedeByClinician — PR J supersession write-path
//
// State Machines v1.2 §19:
//
//   active --[supersede_by_new_prescription]--> superseded (terminal-ish)
//
// The supersession workflow is a TWO-ROW write paired with a clinician_
// approve transition on a NEW pending_clinician_review row:
//
//   1. Load BOTH rows.
//      - newMrId must be at status='pending_clinician_review'
//      - oldMrId must be at status='active'
//      - Both must belong to the same tenant (RLS + explicit predicate)
//        AND the same patient (defense-in-depth; the markSuperseded SQL
//        also enforces this).
//      - Anti-self-loop: newMrId !== oldMrId.
//
//   2. Emit prescribing.approved (the I-012 confirmation event for the
//      clinician_approve route on the new row).
//
//   3. transitionStatus on the new row: pending_clinician_review →
//      active via clinician_approve, threading supersedes_id = oldMrId
//      into the activation envelope. Migration 025 CHECK
//      medication_requests_supersedes_id_only_on_replacement permits
//      supersedes_id at status='active' only.
//
//   4. markSuperseded(old_id, new_id): old row status → superseded,
//      superseded_by_id = new_id. The repo function's EXISTS predicate
//      (see medication-request-repo.ts L946+) requires the new row to
//      already be active AND already carry supersedes_id = old_id AND
//      have the same patient — which step 3 has established. The
//      migration 026 deferred CONSTRAINT TRIGGER validates reciprocity
//      at commit time as a durable safety net.
//
//   5. Emit medication_request.approved.v1 with approval_pathway=
//      'clinician_reviewed' (the NEW row got activated).
//
//   6. Emit medication_request.superseded audit + medication_request.
//      superseded.v1 domain event (the OLD row's transition).
//
// I-012 reject-unless three-clause rule applies to the clinician_approve
// transition on the new row — same as the non-supersession path. The
// I012RejectError handling delegates to the existing handler-level
// post-rollback emission via emitApprovalI012RejectionAudit (PR G); this
// service throws unchanged and the handler catches it.
//
// supersessionReason is a free-text rationale (audit + domain event
// detail). At v1.0 we don't enumerate canonical reasons — clinical
// judgment is varied; an enum sweep can land if downstream consumers
// need it.
// ---------------------------------------------------------------------------

export async function supersedeByClinician(
  ctx: TenantContext,
  actor: { accountId: string },
  newMedicationRequestId: MedicationRequestId,
  oldMedicationRequestId: MedicationRequestId,
  supersessionReason: string,
  externalTx?: DbTransaction,
): Promise<MedicationRequest> {
  if (newMedicationRequestId === oldMedicationRequestId) {
    throw new MedicationRequestInputValidationError(
      'supersession self-loop: new and old medication_request ids must differ',
    );
  }

  return withTransaction(async (tx) => {
    await tx.query('SELECT set_tenant_context($1)', [ctx.tenantId]);

    // Step 1: load both rows (tenant-scoped via RLS + explicit predicate).
    const newRow = await medicationRequestRepo.findById(ctx.tenantId, newMedicationRequestId, tx);
    if (newRow === null) {
      throw new MedicationRequestNotFoundError(newMedicationRequestId);
    }
    if (newRow.status !== 'pending_clinician_review') {
      throw new MedicationRequestStateConflictError(newMedicationRequestId, newRow.status);
    }

    const oldRow = await medicationRequestRepo.findById(ctx.tenantId, oldMedicationRequestId, tx);
    if (oldRow === null) {
      // Tenant-blind: a same-tenant clinician fishing for ids gets the
      // same envelope whether the id is unknown or in another tenant.
      throw new MedicationRequestNotFoundError(oldMedicationRequestId);
    }
    if (oldRow.status !== 'active') {
      throw new MedicationRequestStateConflictError(oldMedicationRequestId, oldRow.status);
    }
    // Same-patient guard (defense-in-depth; markSuperseded's SQL EXISTS
    // predicate also enforces this at the durable boundary). I-025
    // collapse: an attacker who learned a same-tenant patient B's row id
    // and tries to supersede with patient A's row gets the same 404 as
    // not-found.
    if (oldRow.patient_account_id !== newRow.patient_account_id) {
      throw new MedicationRequestNotFoundError(oldMedicationRequestId);
    }

    const prescribedAt = new Date();

    // Step 2: emit prescribing.approved (I-012 confirmation event for
    // the clinician_approve transition on the new row).
    const approvedAudit = await emitPrescribingApproved(
      {
        tenantId: ctx.tenantId,
        patientAccountId: newRow.patient_account_id,
        medicationRequestId: newMedicationRequestId,
        countryOfCare: ctx.countryOfCare,
        clinicianAccountId: actor.accountId,
        detail: { supersedes_id: oldMedicationRequestId },
      },
      tx,
    );

    // Step 3: activate the new row WITH supersedes_id threaded into the
    // activation envelope. I-012 guard mirrors the non-supersession
    // approveAsClinician path. I012RejectError bubbles to the handler
    // for post-rollback rejection emission (Codex PR G R1/R2/R3 closures).
    const updated = await medicationRequestRepo.transitionStatus(
      {
        id: newMedicationRequestId,
        tenant_id: ctx.tenantId,
        expected_from_status: 'pending_clinician_review',
        to_status: 'active',
        event: 'clinician_approve',
        prescribed_by_clinician_account_id: actor.accountId,
        prescribed_at: prescribedAt,
        supersedes_id: oldMedicationRequestId,
        pending_transition: {
          tenant_id: ctx.tenantId,
          action_id: newMedicationRequestId,
          patient_account_id: newRow.patient_account_id,
          actor_id: actor.accountId,
          protocol_id: null,
          protocol_version: null,
        },
        i012_guard: {
          route: 'clinician_approve',
          confirmation_event_audit_id: approvedAudit.audit_id,
          attested_tenant_id: ctx.tenantId,
          attested_action_id: newMedicationRequestId,
          attested_patient_account_id: newRow.patient_account_id,
          attested_actor_id: actor.accountId,
          confirming_actor_rbac_authorized: true,
        },
      },
      tx,
    );
    if (updated === null) {
      throw new MedicationRequestStateConflictError(newMedicationRequestId, null);
    }

    // Step 4: mark old row superseded. The repo's EXISTS predicate
    // requires the new row to be active + already carry supersedes_id =
    // oldMrId + same patient — all satisfied by step 3.
    const supersededOld = await medicationRequestRepo.markSuperseded(
      {
        tenant_id: ctx.tenantId,
        old_id: oldMedicationRequestId,
        new_id: newMedicationRequestId,
      },
      tx,
    );
    if (supersededOld === null) {
      // Concurrent writer raced — e.g., the old row was discontinued
      // between step 1's load and step 4's UPDATE.
      throw new MedicationRequestStateConflictError(oldMedicationRequestId, null);
    }

    // Step 5: medication_request.approved.v1 domain event (new row).
    await emitMedicationRequestApproved(tx, {
      tenantId: ctx.tenantId,
      medicationRequestId: newMedicationRequestId,
      occurredAt: prescribedAt,
      patientAccountId: newRow.patient_account_id,
      approvalPathway: 'clinician_reviewed',
      prescriberAccountId: actor.accountId,
      productCatalogId: newRow.product_catalog_id,
      medication: {
        code: newRow.product_catalog_id,
        name: newRow.medication_name,
        strength: newRow.strength,
        formulation: newRow.formulation,
      },
      dosing: {
        instructions: newRow.dose_instructions,
        quantity: newRow.quantity,
        quantity_unit: newRow.quantity_unit,
        refills_allowed: newRow.refills_allowed,
      },
      interactionSignals: [],
      overrides: [],
      protocolId: null,
      protocolVersion: null,
      aiWorkloadType: null,
      autonomyLevel: null,
    });

    // Step 6: medication_request.superseded audit (Category A) + .v1
    // domain event (old row's transition). The audit envelope's
    // medicationRequestId IS the OLD row (the aggregate that
    // transitioned to 'superseded').
    await emitMedicationRequestSuperseded(
      {
        tenantId: ctx.tenantId,
        patientAccountId: newRow.patient_account_id,
        medicationRequestId: oldMedicationRequestId,
        countryOfCare: ctx.countryOfCare,
        clinicianAccountId: actor.accountId,
        newMedicationRequestId,
        supersessionReason,
        detail: {},
      },
      tx,
    );

    await emitMedicationRequestSupersededDomainEvent(tx, {
      tenantId: ctx.tenantId,
      medicationRequestId: oldMedicationRequestId,
      occurredAt: prescribedAt,
      oldMedicationRequestId,
      newMedicationRequestId,
      patientAccountId: newRow.patient_account_id,
      supersessionReason,
    });

    return updated;
  }, externalTx);
}
