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
// What does NOT ship at v0.1 (Sprint 8 skeleton)
// ---------------------------------------------------------------------------
//
// - Row-shape interfaces for Consult / ConsultEvent (await CDM §4
//   field-level expansion + Sprint 9 authoring)
// - Transition state machine (Sprint 9; ~30 transitions per State
//   Machines §3 transition table at L196-218+)
// - Audit event emitters (Sprint 10; 11 events per PRD §13 — currently
//   not in canonical AUDIT_EVENTS contract; SI-004 candidate)
// - Domain event emitters (Sprint 10; same posture)
// - HTTP handler types (POST /v0/async-consult — Sprint 10)
