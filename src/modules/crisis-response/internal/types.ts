/**
 * crisis-response/internal/types.ts — branded ID types + state/crisis vocabulary
 * for the Crisis Response module.
 *
 * The DB layer is COMPLETE through migration 038 (see migrations/032-038):
 * 6 tables + 2 derived views + 6 SECDEF procedures + 15 RBAC roles. This
 * TypeScript layer (Sprint 1) exposes branded IDs + canonical state +
 * canonical crisis-type/severity vocabularies so downstream slices can
 * compile against typed Crisis Response references before Sprint 2's
 * handler implementation lands.
 *
 * Per Option 2 ratifier decision 2026-05-22 (see
 * docs/crisis-response-implementation-plan.md): the SQL wrappers use SI-010
 * `current_actor_*()` helpers, not SI-024.1 JWT trust anchor. Application
 * layer responsibility for FLOOR-020 Cat A audit emission (deferred from
 * SQL wrappers per PR 4-6 commits).
 *
 * Spec references:
 *   - SI-022 Crisis Response Slice v1.0 (RATIFIED 2026-05-21 P-039)
 *   - CDM v1.9 → v1.10 Amendment §4.NEW1-3 + §3.1-3.6 (RATIFIED 2026-05-21 P-040)
 *   - State Machines v1.1 §3 (canonical 6-state lifecycle)
 *   - I-019 (crisis-detection-always-on platform-floor)
 *   - I-035 (append-only lifecycle per migration 033 triggers)
 */

declare const __brand: unique symbol;
type Brand<T, TBrand extends string> = T & { readonly [__brand]: TBrand };

// ---------------------------------------------------------------------------
// Branded ID types — CDM v1.10 §4.NEW1 + §4.NEW2 + §4.NEW3
// ---------------------------------------------------------------------------

export type CrisisEventId = Brand<string, 'CrisisEventId'>;
export function asCrisisEventId(raw: string): CrisisEventId {
  return raw as CrisisEventId;
}

export type CrisisLifecycleTransitionId = Brand<bigint, 'CrisisLifecycleTransitionId'>;
export function asCrisisLifecycleTransitionId(raw: bigint): CrisisLifecycleTransitionId {
  return raw as CrisisLifecycleTransitionId;
}

export type CrisisSweepExecutionId = Brand<string, 'CrisisSweepExecutionId'>;
export function asCrisisSweepExecutionId(raw: string): CrisisSweepExecutionId {
  return raw as CrisisSweepExecutionId;
}

export type ServerSignalId = Brand<string, 'ServerSignalId'>;
export function asServerSignalId(raw: string): ServerSignalId {
  return raw as ServerSignalId;
}

// ---------------------------------------------------------------------------
// Crisis classification — CHECK constraint enum from migration 033 §4
// ---------------------------------------------------------------------------

export type CrisisType =
  | 'suicidal_ideation'
  | 'self_harm'
  | 'violence_threat'
  | 'medical_emergency'
  | 'severe_psychological_distress'
  | 'protocol_safety_floor_breach';

export const CRISIS_TYPES: readonly CrisisType[] = [
  'suicidal_ideation',
  'self_harm',
  'violence_threat',
  'medical_emergency',
  'severe_psychological_distress',
  'protocol_safety_floor_breach',
] as const;

export type CrisisSeverity = 'non_imminent' | 'imminent' | 'life_threatening';

export const CRISIS_SEVERITIES: readonly CrisisSeverity[] = [
  'non_imminent',
  'imminent',
  'life_threatening',
] as const;

// ---------------------------------------------------------------------------
// State machine vocabulary — State Machines v1.1 §3 + migration 033 §6 CHECK
// ---------------------------------------------------------------------------

/**
 * Canonical 6-state crisis lifecycle per SI-022 §6 + migration 033 §6
 * CHECK constraint. `none` is the initial pseudo-state before the first
 * transition (always paired with `initial_detection` reason).
 */
export type CrisisLifecycleState =
  | 'none'
  | 'detected'
  | 'escalated'
  | 'acknowledged'
  | 'responded'
  | 'resolved';

export const CRISIS_LIFECYCLE_STATES: readonly CrisisLifecycleState[] = [
  'none',
  'detected',
  'escalated',
  'acknowledged',
  'responded',
  'resolved',
] as const;

/**
 * Canonical 9 transition_reason values per migration 033 §6 CHECK constraint.
 * Each reason pairs with specific (from_state, to_state) combinations
 * enumerated in 11 triples by the table-layer constraint.
 */
export type CrisisLifecycleTransitionReason =
  | 'initial_detection'
  | 'no_acknowledgement_timeout'
  | 'tier_progression_no_acknowledgement'
  | 'acknowledged_no_response_timeout'
  | 'responded_no_resolution_timeout'
  | 'response_failed'
  | 'clinician_acknowledgement'
  | 'clinician_response'
  | 'clinician_resolution';

// ---------------------------------------------------------------------------
// View row shape — patient-scoped (data-minimized vs staff view)
// (consumed by `internal/handlers/get-crisis-event-patient-summary.ts`)
// ---------------------------------------------------------------------------

/**
 * Row shape returned by `crisis_event_patient_summary_v` (migration 034 §2).
 * This is the **data-minimized** projection the patient view exposes — fewer
 * columns than `crisis_event_current_state_v` (the staff projection consumed
 * by `get-crisis-event.ts`).
 *
 * Columns intentionally OMITTED vs the staff view (per migration 034 §2
 * inline rationale + R1 HIGH-1 column-grant minimization closure 2026-05-22):
 *   - `server_signal_id` — Mode 1 envelope reference; staff-diagnostic
 *     concern, not patient-facing.
 *   - `regulatory_reporting_enabled` — tenant config; patient need-to-know
 *     is the disposition, not the config flag.
 *   - `current_state_transition_reason` — operator-internal; patient sees
 *     state, not who/why operator-side.
 *   - `current_state_actor_principal_id` — operator-internal.
 *   - `intake_payload_*` KMS envelope columns — PHI encrypted-at-rest;
 *     would need decryption + audit emission to expose to patient;
 *     deferred.
 *
 * Nullable `current_state*` reflects the LEFT JOIN LATERAL — see the staff
 * view's `CrisisEventCurrentStateRow` (in
 * `internal/handlers/get-crisis-event.ts`) for the same rationale.
 */
export interface CrisisEventPatientSummaryRow {
  crisis_event_id: string;
  tenant_id: string;
  patient_account_id: string;
  crisis_type: CrisisType;
  severity: CrisisSeverity;
  detected_at: Date;
  current_state: CrisisLifecycleState | null;
  current_state_transition_at: Date | null;
}

// ---------------------------------------------------------------------------
// Sweep wrapper outcome — migration 038 §1 RETURNS TABLE
// ---------------------------------------------------------------------------

/**
 * The 5 outcome values returned by the no-acknowledgement sweep wrapper:
 *   - claimed_new          — first-time claim of a brand-new sweep row
 *   - claimed_takeover     — took over an expired-lease open row
 *   - already_completed    — replay/retry of an already-committed sweep
 *   - completed_no_op      — current state didn't warrant escalation
 *   - completed_escalated  — escalation emitted + sweep marked completed
 */
export type CrisisSweepOutcome =
  | 'claimed_new'
  | 'claimed_takeover'
  | 'already_completed'
  | 'completed_no_op'
  | 'completed_escalated';
