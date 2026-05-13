/**
 * pharmacy/domain-events.ts — module-specific domain event emitters.
 *
 * Sprint 35 / TLC-055 part A. Wraps `lib/domain-events.ts
 * emitDomainEvent()` for the canonical DOMAIN_EVENTS v5.2
 * MedicationRequest events. Per P-011 / SI-001 closure 2026-05-11 the
 * DOMAIN_EVENTS pack was AMENDED in place (no version bump — additive
 * enum extension only); 4 net-new event types were added:
 *   - medication_request.discontinued.v1
 *   - medication_request.superseded.v1
 *   - medication_request.expired.v1
 *   - medication_request.interaction_safety_hold_triggered.v1
 * The pre-existing `medication_request.approved.v1` is REUSED for the
 * activation handoff in BOTH I-012-gated routes (clinician_approve AND
 * protocol_authorized_prescribing) via its `approval_pathway` field —
 * subscribers (Subscription, Notification, Adverse Events) consume the
 * single event and branch on `approval_pathway` when route-specific
 * behavior is required.
 *
 * Partition key: every emitter here uses the tenant-scoped composite
 * `${tenant_id}:${medication_request_id}` per the canonical partition-
 * key composition rule for tenant-bound aggregates.
 *
 * Spec references:
 *   - DOMAIN_EVENTS v5.2 (amended in-place under P-011)
 *   - migrations/004_domain_events_outbox.sql (target table)
 *   - State Machines v1.2 §19 (each transition's success_domain_event)
 *   - I-016 (domain events immutable once emitted)
 *   - I-023 (every event carries tenant_id)
 */

import {
  type DbTransaction,
  type DomainEventEnvelope,
  emitDomainEvent,
} from '../../lib/domain-events.js';

import type {
  AIWorkloadType,
  AutonomyLevel,
  MedicationRequestDiscontinuedReason,
  MedicationRequestId,
  ProductCatalogId,
} from './internal/types.js';

// ---------------------------------------------------------------------------
// Shared envelope-building helpers
// ---------------------------------------------------------------------------

interface MedicationRequestDomainEventCommon {
  tenantId: string;
  medicationRequestId: MedicationRequestId;
  /** Business-clock timestamp of when the event occurred. */
  occurredAt: Date;
}

function buildBaseInput(
  args: MedicationRequestDomainEventCommon,
  eventType: string,
  payload: Record<string, unknown>,
): {
  tenant_id: string;
  aggregate_type: string;
  aggregate_id: string;
  event_type: string;
  payload: Record<string, unknown>;
  occurred_at: string;
} {
  return {
    tenant_id: args.tenantId,
    aggregate_type: 'MedicationRequest',
    aggregate_id: args.medicationRequestId,
    event_type: eventType,
    payload,
    occurred_at: args.occurredAt.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// medication_request.approved.v1 — REUSED for both I-012-gated routes
// ---------------------------------------------------------------------------

/**
 * Emit `medication_request.approved.v1` for the activation handoff. Per
 * the canonical DOMAIN_EVENTS v5.2 payload definition (telecheckONE
 * `Telecheck_Contracts_Pack_v5_00_DOMAIN_EVENTS.md` lines 135-149), this
 * event carries `approval_pathway: "clinician_reviewed | protocol_authorized"`
 * to discriminate the two I-012-gated routes. Subscribers (Subscription
 * binds new active rows; Notification informs patient + clinician;
 * Adverse Events baseline-tracks) consume this single canonical event
 * for BOTH execution authorities.
 *
 * The P-011 amendment to DOMAIN_EVENTS v5.2 explicitly RETAINED this event
 * (no new `medication_request.activated` event was added) — splitting
 * routes into separate events would have duplicated subscriber workflows
 * for the same business handoff.
 */
export async function emitMedicationRequestApproved(
  tx: DbTransaction,
  args: MedicationRequestDomainEventCommon & {
    approvalPathway: 'clinician_reviewed' | 'protocol_authorized';
    patientAccountId: string;
    prescriberAccountId: string;
    productCatalogId: ProductCatalogId;
    medication: {
      code: string;
      name: string;
      strength: string;
      formulation: string;
    };
    dosing: {
      instructions: string;
      quantity: number;
      quantity_unit: string;
      refills_allowed: number;
    };
    interactionSignals: Array<{ signal_id: string; severity: string }>;
    overrides: Array<{ signal_id: string; rationale: string }>;
    /** For protocol-authorized route: the protocol that authorized the
     *  prescribing decision. Null on the clinician-only route. */
    protocolId: string | null;
    protocolVersion: string | null;
    /** Mirrors the row's I-012 envelope; null/null for the clinician-only
     *  path; protocol_execution/action_with_confirm for the protocol-
     *  authorized path. */
    aiWorkloadType: AIWorkloadType | null;
    autonomyLevel: AutonomyLevel | null;
  },
): Promise<DomainEventEnvelope> {
  return emitDomainEvent(
    tx,
    buildBaseInput(args, 'medication_request.approved.v1', {
      medication_request_id: args.medicationRequestId,
      patient_id: args.patientAccountId,
      prescriber_id: args.prescriberAccountId,
      approval_pathway: args.approvalPathway,
      product_catalog_id: args.productCatalogId,
      medication: args.medication,
      dosing: args.dosing,
      interaction_signals: args.interactionSignals,
      overrides: args.overrides,
      protocol_id: args.protocolId,
      protocol_version: args.protocolVersion,
      ai_workload_type: args.aiWorkloadType,
      autonomy_level: args.autonomyLevel,
    }),
  );
}

// ---------------------------------------------------------------------------
// medication_request.discontinued.v1 — net-new at P-011
// ---------------------------------------------------------------------------

export async function emitMedicationRequestDiscontinued(
  tx: DbTransaction,
  args: MedicationRequestDomainEventCommon & {
    patientAccountId: string;
    discontinuedReason: MedicationRequestDiscontinuedReason;
    discontinuedByActor: {
      actor_type: 'clinician' | 'patient' | 'system';
      actor_id: string;
    };
  },
): Promise<DomainEventEnvelope> {
  return emitDomainEvent(
    tx,
    buildBaseInput(args, 'medication_request.discontinued.v1', {
      medication_request_id: args.medicationRequestId,
      patient_id: args.patientAccountId,
      discontinued_reason: args.discontinuedReason,
      discontinued_at: args.occurredAt.toISOString(),
      discontinued_by_actor: args.discontinuedByActor,
    }),
  );
}

// ---------------------------------------------------------------------------
// medication_request.superseded.v1 — net-new at P-011
// ---------------------------------------------------------------------------

export async function emitMedicationRequestSuperseded(
  tx: DbTransaction,
  args: MedicationRequestDomainEventCommon & {
    /** The id of the row that was superseded (matches `medicationRequestId`
     *  here; the canonical aggregate is the old row whose state transitioned
     *  to 'superseded'). */
    oldMedicationRequestId: MedicationRequestId;
    /** The id of the new replacement row. */
    newMedicationRequestId: MedicationRequestId;
    patientAccountId: string;
    supersessionReason: string;
  },
): Promise<DomainEventEnvelope> {
  return emitDomainEvent(
    tx,
    buildBaseInput(args, 'medication_request.superseded.v1', {
      old_medication_request_id: args.oldMedicationRequestId,
      new_medication_request_id: args.newMedicationRequestId,
      patient_id: args.patientAccountId,
      supersession_reason: args.supersessionReason,
      superseded_at: args.occurredAt.toISOString(),
    }),
  );
}

// ---------------------------------------------------------------------------
// medication_request.expired.v1 — net-new at P-011
// ---------------------------------------------------------------------------

export async function emitMedicationRequestExpired(
  tx: DbTransaction,
  args: MedicationRequestDomainEventCommon & {
    patientAccountId: string;
    /** The medication_request's validity-window-end timestamp. */
    expiresAtWindowEnd: Date;
  },
): Promise<DomainEventEnvelope> {
  return emitDomainEvent(
    tx,
    buildBaseInput(args, 'medication_request.expired.v1', {
      medication_request_id: args.medicationRequestId,
      patient_id: args.patientAccountId,
      expired_at: args.occurredAt.toISOString(),
      expires_at_window_end: args.expiresAtWindowEnd.toISOString(),
    }),
  );
}

// ---------------------------------------------------------------------------
// medication_request.interaction_safety_hold_triggered.v1 — net-new at P-011
// ---------------------------------------------------------------------------

/**
 * Emit `medication_request.interaction_safety_hold_triggered.v1` when the
 * Med Interaction Engine flips the row's `interaction_signals_status` to
 * `'safety_hold'`. This is the Path 1 integration mechanism (ratified
 * at SI-001 v1.0) — the Med Interaction Engine slice subscribes to this
 * event and owns the override workflow + override table. Pharmacy does
 * NOT carry a row-level FK to the override entity (clean module-boundary
 * separation per ADR-001).
 */
export async function emitMedicationRequestInteractionSafetyHoldTriggered(
  tx: DbTransaction,
  args: MedicationRequestDomainEventCommon & {
    patientAccountId: string;
    prescriberAccountId: string;
    interactionSignals: Array<{
      signal_id: string;
      severity: string;
      check_class: string;
    }>;
    engineVersion: string;
    knowledgeBaseVersion: string;
  },
): Promise<DomainEventEnvelope> {
  return emitDomainEvent(
    tx,
    buildBaseInput(args, 'medication_request.interaction_safety_hold_triggered.v1', {
      medication_request_id: args.medicationRequestId,
      patient_id: args.patientAccountId,
      prescriber_id: args.prescriberAccountId,
      interaction_signals: args.interactionSignals,
      interaction_signals_status: 'safety_hold',
      engine_version: args.engineVersion,
      knowledge_base_version: args.knowledgeBaseVersion,
      triggered_at: args.occurredAt.toISOString(),
    }),
  );
}
