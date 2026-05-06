/**
 * consult-service.ts — Async Consult lifecycle orchestration.
 *
 * Sprint 10 / TLC-021d. Composes:
 *   - TLC-021b repos (consult-repo + consult-event-repo)
 *   - TLC-021c state machine (validateTransition + GuardContext)
 *   - audit.ts (4 placeholder events per SI-004)
 *   - events.ts (4 placeholder domain events per SI-004)
 *   - Cross-slice integration: Identity (auth-context), Forms-Intake
 *     (getActiveDeployment), Consent (hasActiveConsent)
 *
 * 7 service operations covering Sprint 9 supported transitions:
 *   - initiate           — INSERTs new consult at INITIATED state
 *   - startIntake        — INITIATED → INTAKE
 *   - submit             — INTAKE → SUBMITTED (with form_complete + active_consent guards)
 *   - abandon            — INTAKE → ABANDONED (with hours_since_activity guard)
 *   - resume             — ABANDONED → INTAKE
 *   - process            — SUBMITTED → PROCESSING
 *   - patientResponds    — AWAITING_DATA → UNDER_REVIEW
 *
 * `expire` (ABANDONED → EXPIRED) is scaffolded in audit.ts + events.ts
 * but the call site (scheduled job) is DEFERRED to Sprint 11+. Refund
 * orchestration depends on Payment slice authoring.
 *
 * Same-transaction audit + domain event emission per I-003 + I-016.
 * Tenant scope via withTransaction + manual set_tenant_context (the
 * canonical pattern verified at submission-service.ts:398-414 by the
 * Sprint 10 SM verification gate).
 *
 * Spec references:
 *   - Async Consult Slice PRD v1.0 §10-§13
 *   - State Machines v1.1 §3 (canonical transition table; SOURCE OF TRUTH)
 *   - I-003 (audit append-only; same-tx with state change)
 *   - I-016 (domain events same-tx; outbox)
 *   - I-023 / I-027 (tenant scoping)
 *   - I-025 (tenant-blind 404 — null returns map to NotFound at handler)
 *   - SI-004 (audit-event placeholder posture)
 *   - SI-005 (schema-gap placeholder posture)
 */

import type { DbTransaction } from '../../../../lib/db.js';
import { withTransaction } from '../../../../lib/db.js';
import type { TenantContext } from '../../../../lib/tenant-context.js';
import { ulid } from '../../../../lib/ulid.js';
import { hasActiveConsent } from '../../../consent/index.js';
import {
  type FormSubmissionId,
  verifySubmissionBindingEligibility,
} from '../../../forms-intake/index.js';
import type { AccountId } from '../../../identity/internal/types.js';
import {
  emitConsultAbandonedAudit,
  emitConsultInitiatedAudit,
  emitConsultIntakeSubmittedAudit,
} from '../../audit.js';
import {
  emitConsultAbandonedDomainEvent,
  emitConsultInitiatedDomainEvent,
  emitConsultIntakeSubmittedDomainEvent,
} from '../../events.js';
import * as consultEventRepo from '../repositories/consult-event-repo.js';
import * as consultRepo from '../repositories/consult-repo.js';
import {
  type GuardContext,
  validateTransition,
} from '../state-machine.js';
import {
  asConsultEventId,
  asConsultId,
  type Consult,
  type ConsultEvent,
  type ConsultId,
  type ConsultModality,
  type ConsultType,
} from '../types.js';

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Thrown when the consult is not found (RLS filtered OR doesn't exist). */
export class ConsultNotFoundError extends Error {
  constructor(public readonly consultId: ConsultId) {
    super(`Consult not found: ${consultId}`);
    this.name = 'ConsultNotFoundError';
  }
}

/** Thrown when the optimistic-concurrency UPDATE matches zero rows
 *  (consult was advanced past expected state by another caller).
 */
export class ConsultStateConflictError extends Error {
  constructor(public readonly consultId: ConsultId) {
    super(`Consult state conflict: ${consultId} was modified by another caller`);
    this.name = 'ConsultStateConflictError';
  }
}

/** Thrown when the submit guard fails (form not complete OR consent missing). */
export class SubmitGuardNotSatisfiedError extends Error {
  constructor(
    public readonly consultId: ConsultId,
    public readonly reason: 'form_not_complete' | 'no_active_consent',
  ) {
    super(`Submit guard not satisfied for consult ${consultId}: ${reason}`);
    this.name = 'SubmitGuardNotSatisfiedError';
  }
}

/** Thrown when the abandon guard fails (less than 48h since activity). */
export class AbandonGuardNotSatisfiedError extends Error {
  constructor(
    public readonly consultId: ConsultId,
    public readonly hoursSinceActivity: number,
  ) {
    super(
      `Abandon guard not satisfied for consult ${consultId}: ` +
        `${hoursSinceActivity}h since activity (need >= 48h)`,
    );
    this.name = 'AbandonGuardNotSatisfiedError';
  }
}

/**
 * Thrown when the actor doesn't own the consult (patient_id mismatch
 * AND no delegate grant). Per Codex async-consult-r9 HIGH closure
 * 2026-05-05: prevents same-tenant attackers from mutating consults
 * by knowing another patient's consult_id. Service layer maps to 404
 * (NOT 403) per I-025 tenant-blind error envelope — leaking "exists
 * but not yours" would reveal cross-patient existence to a same-tenant
 * attacker.
 */
export class ConsultPatientOwnershipError extends Error {
  constructor(public readonly consultId: ConsultId) {
    super(`Actor does not own consult ${consultId}`);
    this.name = 'ConsultPatientOwnershipError';
  }
}

/**
 * Thrown when the actor attempts startIntake without proven payment
 * confirmation. Per Codex async-consult-r9 HIGH closure 2026-05-05:
 * Sprint 10 fails closed — startIntake is REJECTED at v0.1 because
 * the Payment slice doesn't exist yet (SI-006 candidate). Operators
 * advance consults manually for testing via direct DB; production
 * service rejects until SI-006 closes.
 */
export class PaymentNotVerifiedError extends Error {
  constructor(public readonly consultId: ConsultId) {
    super(
      `Payment not verified for consult ${consultId}: ` +
        `start_intake is fail-closed at v0.1 pending SI-006 (Payment slice integration). ` +
        `Production callers must wait for SI-006 closure.`,
    );
    this.name = 'PaymentNotVerifiedError';
  }
}

/**
 * Thrown when a forms_submission referenced for binding is not in a
 * terminal status (must be 'submitted' or 'completed' — not
 * 'in_progress' or 'paused'). Per Codex async-consult-r9 HIGH closure
 * 2026-05-05: prevents incomplete submissions from being bound to
 * consults at INTAKE → SUBMITTED.
 */
export class FormSubmissionNotTerminalError extends Error {
  constructor(
    public readonly submissionId: string,
    public readonly status: string,
  ) {
    super(
      `Forms submission ${submissionId} has non-terminal status '${status}'; ` +
        `must be 'submitted' or 'completed' to bind to a consult`,
    );
    this.name = 'FormSubmissionNotTerminalError';
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Compute hours elapsed since the given ISO timestamp. Used to enforce
 * the `abandon` guard (>= 48h) and the `expire` guard (>= 14d × 24).
 */
function hoursSince(isoTimestamp: string): number {
  const elapsedMs = Date.now() - new Date(isoTimestamp).getTime();
  return elapsedMs / (1000 * 60 * 60);
}

/**
 * Verify the actor owns the consult. Per Codex async-consult-r9 HIGH
 * closure 2026-05-05: prevents same-tenant attackers from mutating
 * consults by knowing another patient's consult_id.
 *
 * v0.1 ownership rule: actor.accountId === consult.patient_id.
 * Sprint 11+ adds delegate-grant authorization (a delegate may act on
 * behalf of the patient if a Consent slice delegation grants the
 * scope). For v0.1, only direct patient ownership permits mutation.
 *
 * Throws ConsultPatientOwnershipError on mismatch; the handler layer
 * maps to 404 (NOT 403) per I-025 tenant-blind error envelope —
 * leaking "exists but not yours" would reveal cross-patient existence
 * to a same-tenant attacker.
 */
function assertConsultOwnership(consult: Consult, actorAccountId: AccountId): void {
  if (consult.patient_id !== actorAccountId) {
    throw new ConsultPatientOwnershipError(consult.consult_id);
  }
}

// ---------------------------------------------------------------------------
// initiate — INSERTs new consult at INITIATED state
// ---------------------------------------------------------------------------

export interface InitiateConsultInput {
  account_id: AccountId;
  consult_type: ConsultType;
  modality: ConsultModality;
  current_program_catalog_entry_id: string | null;
}

/**
 * Initiate a new consult. INSERTs the consults row at INITIATED state
 * + emits consult.initiated audit + domain event in the same transaction.
 *
 * Per Master PRD §17 + C3, the returned Consult includes `tenant_id`
 * but the handler-layer projection (Omit<Consult, 'tenant_id'>) strips
 * it before patient-facing serialization. Service layer returns the
 * full row.
 */
export async function initiate(
  ctx: TenantContext,
  actor: { actorId: string },
  input: InitiateConsultInput,
  externalTx?: DbTransaction,
): Promise<Consult> {
  const consultId = asConsultId(ulid());
  return withTransaction(async (tx) => {
    await tx.query('SELECT set_tenant_context($1)', [ctx.tenantId]);

    const consult = await consultRepo.createConsult(
      {
        consult_id: consultId,
        tenant_id: ctx.tenantId,
        patient_id: input.account_id,
        consult_type: input.consult_type,
        modality: input.modality,
        current_program_catalog_entry_id: input.current_program_catalog_entry_id,
      },
      tx,
    );

    // Audit emission BEFORE domain event (mirror consent-service.ts:77,91)
    await emitConsultInitiatedAudit(
      {
        tenantId: ctx.tenantId,
        accountId: input.account_id,
        consultId,
        actorId: actor.actorId,
        countryOfCare: ctx.countryOfCare,
        consultType: input.consult_type,
        modality: input.modality,
        currentProgramCatalogEntryId: input.current_program_catalog_entry_id,
      },
      tx,
    );

    await emitConsultInitiatedDomainEvent(tx, {
      tenantId: ctx.tenantId,
      consultId,
      accountId: input.account_id,
      consultType: input.consult_type,
      modality: input.modality,
      currentProgramCatalogEntryId: input.current_program_catalog_entry_id,
      occurredAt: consult.created_at,
    });

    return consult;
  }, externalTx);
}

// ---------------------------------------------------------------------------
// submit — INTAKE → SUBMITTED (guarded by form_complete + active_consent)
// ---------------------------------------------------------------------------

/**
 * Submit the patient's intake form, transitioning the consult from
 * INTAKE to SUBMITTED. Guarded by:
 *   - form_complete: caller proves the intake submission is complete
 *     (operates on already-completed forms_submission row; service
 *     layer trusts the caller's proof at v0.1 — Sprint 11+ may add a
 *     forms-intake state read here)
 *   - active_consent: hasActiveConsent(ctx, accountId, 'care', null)
 *     returns true (cross-slice consent gate)
 *
 * The intake_form_submission_id is populated on the consults row at
 * the same UPDATE as the state change.
 */
export async function submit(
  ctx: TenantContext,
  actor: { actorId: string; accountId: AccountId },
  consultId: ConsultId,
  intakeFormSubmissionId: FormSubmissionId,
  externalTx?: DbTransaction,
): Promise<Consult> {
  return withTransaction(async (tx) => {
    await tx.query('SELECT set_tenant_context($1)', [ctx.tenantId]);

    // Read current state — null → 404 mapped at handler per I-025
    const current = await consultRepo.findConsultById(ctx.tenantId, consultId, tx);
    if (current === null) throw new ConsultNotFoundError(consultId);

    // Authorization: actor must own this consult (per Codex
    // async-consult-r9 HIGH closure 2026-05-05). Prevents same-tenant
    // attacker who knows another patient's consult_id from advancing
    // it through their own consent context.
    assertConsultOwnership(current, actor.accountId);

    // Guard: form_complete — verify forms_submission status + ownership
    // via the cross-slice authorization-enforcing helper (Codex
    // async-consult-r10 HIGH closure 2026-05-05). The helper enforces
    // all 3 checks INSIDE forms-intake (tenant scope, patient ownership,
    // bind-eligible status) and returns only a minimal {valid, reason?}
    // result — PHI never crosses the module boundary.
    const eligibility = await verifySubmissionBindingEligibility(
      ctx.tenantId,
      intakeFormSubmissionId,
      actor.accountId,
      tx,
    );
    if (!eligibility.valid) {
      if (eligibility.reason === 'wrong_status') {
        throw new FormSubmissionNotTerminalError(
          intakeFormSubmissionId,
          'non-bind-eligible',
        );
      }
      // not_found OR wrong_patient: tenant-blind / cross-patient-blind.
      // Don't distinguish — both surface as form_not_complete.
      throw new SubmitGuardNotSatisfiedError(consultId, 'form_not_complete');
    }

    // Guard: active_consent (cross-slice Consent gate). hasActiveConsent
    // returns boolean — do not invent a consent row if missing.
    const consentActive = await hasActiveConsent(
      ctx,
      actor.accountId,
      'care',
      null,
      tx,
    );
    if (!consentActive) {
      throw new SubmitGuardNotSatisfiedError(consultId, 'no_active_consent');
    }

    // State machine validation with typed GuardContext (proves both guards
    // — at this point form_complete + active_consent have both been
    // verified above; the GuardContext type just commits to those proofs).
    const guardCtx: GuardContext = {
      event: 'submit',
      guard: { form_complete: true, active_consent: true },
    };
    const toState = validateTransition(current.state, 'submit', guardCtx);
    // toState is 'SUBMITTED' if validation succeeds; throws otherwise

    // State UPDATE with optimistic concurrency + intake_form_submission_id
    const updated = await consultRepo.updateConsultState(
      {
        consult_id: consultId,
        tenant_id: ctx.tenantId,
        to_state: toState,
        expected_from_state: current.state,
        intake_form_submission_id: intakeFormSubmissionId,
      },
      tx,
    );
    if (updated === null) throw new ConsultStateConflictError(consultId);

    // ConsultEvent record (state_transition)
    await consultEventRepo.createStateTransitionEvent(
      {
        consult_event_id: asConsultEventId(ulid()),
        consult_id: consultId,
        tenant_id: ctx.tenantId,
        from_state: current.state,
        to_state: toState,
        actor_id: actor.actorId,
      },
      tx,
    );

    // Audit BEFORE domain event
    await emitConsultIntakeSubmittedAudit(
      {
        tenantId: ctx.tenantId,
        accountId: actor.accountId,
        consultId,
        actorId: actor.actorId,
        countryOfCare: ctx.countryOfCare,
        intakeFormSubmissionId,
      },
      tx,
    );

    await emitConsultIntakeSubmittedDomainEvent(tx, {
      tenantId: ctx.tenantId,
      consultId,
      accountId: actor.accountId,
      intakeFormSubmissionId,
      occurredAt: updated.updated_at,
    });

    return updated;
  }, externalTx);
}

// ---------------------------------------------------------------------------
// abandon — INTAKE → ABANDONED (guarded by hours_since_activity >= 48)
// ---------------------------------------------------------------------------

/**
 * Mark a consult as abandoned. Guarded by 48h+ inactivity (computed
 * from `consult.updated_at`). Typically invoked by a scheduled job
 * (not implemented at v0.1; Sprint 11+); v0.1 service exposes the
 * operation for testability and for manual operator-side abandon.
 */
export async function abandon(
  ctx: TenantContext,
  actor: { actorId: string; accountId: AccountId },
  consultId: ConsultId,
  externalTx?: DbTransaction,
): Promise<Consult> {
  return withTransaction(async (tx) => {
    await tx.query('SELECT set_tenant_context($1)', [ctx.tenantId]);

    const current = await consultRepo.findConsultById(ctx.tenantId, consultId, tx);
    if (current === null) throw new ConsultNotFoundError(consultId);

    // Authorization: actor must own this consult (Codex r9 HIGH closure)
    assertConsultOwnership(current, actor.accountId);

    const hoursSinceActivity = hoursSince(current.updated_at);
    if (hoursSinceActivity < 48) {
      throw new AbandonGuardNotSatisfiedError(consultId, hoursSinceActivity);
    }

    const guardCtx: GuardContext = {
      event: 'abandon',
      guard: { hours_since_activity: hoursSinceActivity },
    };
    const toState = validateTransition(current.state, 'abandon', guardCtx);

    const updated = await consultRepo.updateConsultState(
      {
        consult_id: consultId,
        tenant_id: ctx.tenantId,
        to_state: toState,
        expected_from_state: current.state,
      },
      tx,
    );
    if (updated === null) throw new ConsultStateConflictError(consultId);

    await consultEventRepo.createStateTransitionEvent(
      {
        consult_event_id: asConsultEventId(ulid()),
        consult_id: consultId,
        tenant_id: ctx.tenantId,
        from_state: current.state,
        to_state: toState,
        actor_id: actor.actorId,
      },
      tx,
    );

    await emitConsultAbandonedAudit(
      {
        tenantId: ctx.tenantId,
        accountId: actor.accountId,
        consultId,
        countryOfCare: ctx.countryOfCare,
        hoursSinceActivity,
      },
      tx,
    );

    await emitConsultAbandonedDomainEvent(tx, {
      tenantId: ctx.tenantId,
      consultId,
      accountId: actor.accountId,
      hoursSinceActivity,
      occurredAt: updated.updated_at,
    });

    return updated;
  }, externalTx);
}

// ---------------------------------------------------------------------------
// Simple unguarded transitions: startIntake, resume, process, patientResponds
// ---------------------------------------------------------------------------

/**
 * Internal helper for unguarded simple transitions. Reads current state,
 * validates with empty GuardContext (or hardcoded `payment_confirmed:
 * true` for start_intake — see Sprint 10 plan SI-006 candidate flag),
 * UPDATEs state, emits state_transition event. Does NOT emit audit /
 * domain events (those are reserved for the 4 SI-004 placeholder events
 * — initiate / submit / abandon / expire — which ship with their own
 * dedicated service operations).
 */
async function unguardedTransition(
  ctx: TenantContext,
  actor: { actorId: string; accountId: AccountId },
  consultId: ConsultId,
  guardCtx: GuardContext,
  externalTx?: DbTransaction,
): Promise<Consult> {
  return withTransaction(async (tx) => {
    await tx.query('SELECT set_tenant_context($1)', [ctx.tenantId]);

    const current = await consultRepo.findConsultById(ctx.tenantId, consultId, tx);
    if (current === null) throw new ConsultNotFoundError(consultId);

    // Authorization: actor must own this consult (Codex r9 HIGH closure)
    assertConsultOwnership(current, actor.accountId);

    const toState = validateTransition(current.state, guardCtx.event, guardCtx);

    const updated = await consultRepo.updateConsultState(
      {
        consult_id: consultId,
        tenant_id: ctx.tenantId,
        to_state: toState,
        expected_from_state: current.state,
      },
      tx,
    );
    if (updated === null) throw new ConsultStateConflictError(consultId);

    await consultEventRepo.createStateTransitionEvent(
      {
        consult_event_id: asConsultEventId(ulid()),
        consult_id: consultId,
        tenant_id: ctx.tenantId,
        from_state: current.state,
        to_state: toState,
        actor_id: actor.actorId,
      },
      tx,
    );

    return updated;
  }, externalTx);
}

/**
 * INITIATED → INTAKE on `start_intake` event.
 *
 * **FAIL-CLOSED at v0.1** per Codex async-consult-r9 HIGH closure
 * 2026-05-05. The Payment slice does NOT exist yet — there is no
 * production-grade source of truth for `payment_confirmed`. Hard-
 * coding `true` would let unpaid consults advance through the
 * payment-guarded transition with the audit trail recording the
 * transition as if payment had been verified — that's the exact
 * bug Codex flagged.
 *
 * Sprint 11+ closure path: SI-006 candidate (Payment slice
 * authoring + cross-slice payment-verification surface). When
 * SI-006 closes, this function reads the payment status from the
 * Payment slice public interface, constructs the GuardContext only
 * if confirmed, and proceeds.
 *
 * Until then: any caller invoking startIntake gets PaymentNotVerifiedError.
 * Operators can advance consults manually via direct DB during testing
 * (handler-layer integration tests use direct DB seeding for INTAKE
 * state setup rather than going through this service).
 */
export async function startIntake(
  _ctx: TenantContext,
  _actor: { actorId: string; accountId: AccountId },
  consultId: ConsultId,
  _externalTx?: DbTransaction,
): Promise<Consult> {
  // Fail closed. Do NOT advance through the payment guard with a
  // hard-coded value. SI-006 resume gate.
  throw new PaymentNotVerifiedError(consultId);
}

/** ABANDONED → INTAKE on `resume` event (no guard). */
export async function resume(
  ctx: TenantContext,
  actor: { actorId: string; accountId: AccountId },
  consultId: ConsultId,
  externalTx?: DbTransaction,
): Promise<Consult> {
  return unguardedTransition(
    ctx,
    actor,
    consultId,
    { event: 'resume', guard: {} },
    externalTx,
  );
}

/**
 * SUBMITTED → PROCESSING on `process` event (no guard).
 *
 * **System/operational transition** — NOT a patient action. Triggered
 * by the AI service when it picks up a SUBMITTED consult for processing
 * (per State Machines v1.1 §3 row 6 + PRD §1: "AI Mode 2 prepares
 * clinical summary"). Per Codex async-consult-r10 HIGH closure
 * 2026-05-05: this transition does NOT enforce patient ownership —
 * a worker / clinician / AI service actor invoking it cannot be
 * required to "be" the patient.
 *
 * Sprint 10 v0.1 simplification: actor is recorded as a system actor
 * (not validated against consult.patient_id). Sprint 11+ adds explicit
 * RBAC role check ('platform_ai_safety' or 'system_worker') when
 * the AI service ships.
 *
 * No HTTP route exposes this transition at v0.1. The handler surface
 * for `POST /v0/async-consult/:id/process` is intentionally OMITTED
 * — process is internal, not a user-facing operation. AI service
 * (when authored) calls this service function directly with a
 * service-account actor.
 */
export async function process(
  ctx: TenantContext,
  actor: { actorId: string },
  consultId: ConsultId,
  externalTx?: DbTransaction,
): Promise<Consult> {
  return withTransaction(async (tx) => {
    await tx.query('SELECT set_tenant_context($1)', [ctx.tenantId]);

    const current = await consultRepo.findConsultById(ctx.tenantId, consultId, tx);
    if (current === null) throw new ConsultNotFoundError(consultId);

    // No assertConsultOwnership — process is a system/operational
    // transition. The audit chain records actor.actorId (the AI service
    // actor or worker actor) for forensic traceability.

    const guardCtx: GuardContext = { event: 'process', guard: {} };
    const toState = validateTransition(current.state, 'process', guardCtx);

    const updated = await consultRepo.updateConsultState(
      {
        consult_id: consultId,
        tenant_id: ctx.tenantId,
        to_state: toState,
        expected_from_state: current.state,
      },
      tx,
    );
    if (updated === null) throw new ConsultStateConflictError(consultId);

    await consultEventRepo.createStateTransitionEvent(
      {
        consult_event_id: asConsultEventId(ulid()),
        consult_id: consultId,
        tenant_id: ctx.tenantId,
        from_state: current.state,
        to_state: toState,
        actor_id: actor.actorId,
      },
      tx,
    );

    return updated;
  }, externalTx);
}

/** AWAITING_DATA → UNDER_REVIEW on `patient_responds` event (no guard). */
export async function patientResponds(
  ctx: TenantContext,
  actor: { actorId: string; accountId: AccountId },
  consultId: ConsultId,
  externalTx?: DbTransaction,
): Promise<Consult> {
  return unguardedTransition(
    ctx,
    actor,
    consultId,
    { event: 'patient_responds', guard: {} },
    externalTx,
  );
}

// ---------------------------------------------------------------------------
// read — list event history for a consult
// ---------------------------------------------------------------------------

/**
 * List a consult's event history. Used by the GET
 * /v0/async-consult/:id/events handler. Composite FK + RLS + explicit
 * tenant predicate (3 layers per I-023) ensure cross-tenant queries
 * return empty.
 */
export async function listEvents(
  ctx: TenantContext,
  consultId: ConsultId,
  externalTx?: DbTransaction,
): Promise<ConsultEvent[]> {
  return consultEventRepo.listConsultEvents(ctx.tenantId, consultId, externalTx);
}
