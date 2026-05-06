/**
 * async-consult/internal/types.ts — branded ID types + state values at v0.1.
 *
 * Schema authoring for Consult / ConsultEvent row interfaces is BLOCKED
 * pending CDM §4 field-level expansion (the entity inventory at CDM v1.2
 * §3 #15-16 names the entities; field-level row shapes are the slice
 * implementation phase's responsibility, NOT a spec authoring task — per
 * EHBG §7). Sprint 9 + 10 author repos / services / handlers; Sprint 8
 * scope is identifier hygiene + state vocabulary only.
 *
 * Spec references:
 *   - Async Consult Slice PRD v1.0 §12 (PRD's 16-state inventory; subset
 *     of canonical State Machines §3 — DECISION_MADE absorbed into
 *     UNDER_REVIEW branch points)
 *   - State Machines v1.1 §3 (canonical state inventory of 17 states;
 *     SOURCE OF TRUTH per CLAUDE.md hard rule "Slice PRD vs State Machines
 *     v1.1 → State Machines wins")
 *   - CDM v1.2 §3 entities #15 (Consult) + #16 (ConsultEvent)
 *   - ADR-001 (modular monolith — public-interface-only cross-module access)
 *   - ADR-029 (AI workload taxonomy — Async Consult uses Mode 2 per PRD §1)
 */

// ---------------------------------------------------------------------------
// Branded ID types — CDM §3 entities #15 + #16
// ---------------------------------------------------------------------------

declare const _consultIdBrand: unique symbol;
export type ConsultId = string & {
  readonly [_consultIdBrand]: 'ConsultId';
};
export function asConsultId(s: string): ConsultId {
  return s as ConsultId;
}

declare const _consultEventIdBrand: unique symbol;
export type ConsultEventId = string & {
  readonly [_consultEventIdBrand]: 'ConsultEventId';
};
export function asConsultEventId(s: string): ConsultEventId {
  return s as ConsultEventId;
}

// ---------------------------------------------------------------------------
// State value vocabulary — canonical from State Machines v1.1 §3
// ---------------------------------------------------------------------------

/**
 * Canonical Consult state values per `Telecheck_State_Machines_v1_1.md` §3.
 *
 * 17 distinct states. PRD v1.0 §12 lists 16 states — the difference is:
 *   - PRD §12 has `DECISION_MADE` which State Machines §3 absorbs into
 *     UNDER_REVIEW branch points (not a separate state in transition table)
 *   - State Machines §3 adds `EXPIRED` (from `ABANDONED → expire → 14d`,
 *     `Telecheck_State_Machines_v1_1.md:200`) and `CLOSED` (from
 *     `AWAITING_DATA → timeout → 14d`, `Telecheck_State_Machines_v1_1.md:212`)
 *
 * Per CLAUDE.md hard rule: Slice PRD vs State Machines v1.1 → State Machines
 * wins. This export is the canonical reference for downstream code.
 *
 * Sprint 8 scope: typed-only export (no transition logic). Sprint 9 wires
 * the transition state machine itself.
 */
export const CONSULT_STATES = [
  'INITIATED',
  'INTAKE',
  'ABANDONED',
  'SUBMITTED',
  'PROCESSING',
  'QUEUED',
  'UNDER_REVIEW',
  'PRESCRIBED',
  'ADVISED',
  'AWAITING_DATA',
  'ESCALATED_TO_SYNC',
  'DECLINED',
  'REFERRED',
  'FOLLOW_UP',
  'COMPLETED',
  'EXPIRED',
  'CLOSED',
] as const;

/**
 * `ConsultState` is the union of canonical state values.
 *
 * Use this branded type wherever a Consult's state field is read or
 * written. Downstream slices that hold typed references to a Consult's
 * state can compile clean before Sprint 9's transition state machine
 * lands.
 */
export type ConsultState = (typeof CONSULT_STATES)[number];

// ---------------------------------------------------------------------------
// Row-shape interfaces (Sprint 9 / TLC-021b — placeholder per SI-005)
// ---------------------------------------------------------------------------
//
// These row shapes match migration 020 placeholder column set + the named
// composite-FK constraints from migration 020 inline + migration 021 ALTER.
// Per SI-005, the field set is minimal-viable for Sprint 9 implemented
// transitions (1-6 + 16). When SI-005 closes and CDM §4 expands the
// canonical column set, these interfaces grow accordingly.

/**
 * Discriminator for `consult_type` per Async Consult Slice PRD v1.0 §1/§2.
 * 'program' = patient selected a specific program from the catalog;
 * 'general' = open-ended async consult, no program-specific protocol.
 */
export type ConsultType = 'program' | 'general';

/**
 * Discriminator for `modality` per ADR-012 (async ↔ sync conversion).
 * Sprint 9 implements 'async' only; 'sync' conversion lands Sprint 10+.
 */
export type ConsultModality = 'async' | 'sync';

/**
 * Row shape for `consults` table per migration 020 placeholder column set.
 * SI-005 resume gate: when CDM §4 expands the canonical schema, this
 * interface adopts the ratified field set (likely a superset of these).
 */
export interface Consult {
  consult_id: ConsultId;
  tenant_id: string; // TenantId branded type imported by callers
  patient_id: string; // AccountId branded type imported by callers
  consult_type: ConsultType;
  modality: ConsultModality;
  state: ConsultState;
  current_program_catalog_entry_id: string | null;
  intake_form_submission_id: string | null;
  created_at: string; // ISO timestamp
  updated_at: string;
}

/**
 * Discriminator for `event_type` on `consult_events` per migration 020
 * placeholder column set. Sprint 9 only emits `state_transition`;
 * Sprint 10+ may add types for ai-prep, clinician-decision, etc.
 */
export type ConsultEventType = 'state_transition';

/**
 * Row shape for `consult_events` table per migration 020 placeholder
 * column set. Append-only at the application layer (no UPDATE / DELETE
 * in service code) — complements I-003 audit chain integrity for the
 * Consult lifecycle specifically.
 */
export interface ConsultEvent {
  consult_event_id: ConsultEventId;
  consult_id: ConsultId;
  tenant_id: string;
  event_type: ConsultEventType;
  from_state: ConsultState | null;
  to_state: ConsultState | null;
  actor_id: string | null;
  metadata: unknown;
  created_at: string;
}

// ---------------------------------------------------------------------------
// What does NOT ship at v0.1-Sprint-9 (deferred to Sprint 10)
// ---------------------------------------------------------------------------
//
// - Transition logic for transitions 7-15 (clinician decision branches),
//   17 (AWAITING_DATA timeout → CLOSED), 18-23 (terminal/follow-up states).
//   Sprint 10 implements; Sprint 9's state machine throws
//   `unsupported_transition` errors for these.
// - Audit event emitters for the 7 deferred events (PRD §13 events
//   3-9, 11). Sprint 9 emits 4 of 11 (consult.initiated /
//   consult.intake_submitted / consult.abandoned / consult.expired).
//   Per SI-004 placeholder posture; ratified at SI-004 closure.
// - Domain event emitters (Sprint 10; same SI-004 posture).
// - HTTP handlers for clinician decision routes (Sprint 10; PRD §10
//   clinician decision endpoints).
