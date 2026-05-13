/**
 * MedicationRequest state machine — focused unit tests for the
 * I-012-gated activation routes + the broader §19 lifecycle.
 *
 * Sprint 35 post-P-011 / SI-001 closure 2026-05-11. Added per Codex
 * pharmacy-scaffold-rebuild post-merge MEDIUM closure 2026-05-13
 * (telecheck-app session `019e1f2b-9c78-7ea0-8bd6-9b08359e9cbb`):
 * the new `validateTransition` is the enforcement point for both I-012
 * activation routes, bound-context attestations, protocol metadata
 * checks, and rejection classification — but had no focused tests.
 * This file fills that gap with explicit happy-path + rejection-class
 * coverage.
 *
 * Pure-unit test (no DB / no Fastify); imports the pharmacy state-
 * machine module directly. Sibling pattern to
 * tests/state-machines/i012-prescribing.test.ts (generic I-012 gate
 * coverage on the legacy src/lib/i012-gate.ts) — this file is
 * pharmacy-route-specific.
 *
 * Test taxonomy:
 *   §1 — Transition shape: invalid from-state rejection, terminal-state
 *        guard, non-I-012-event-with-guard rejection.
 *   §2 — Happy paths: both I-012-gated routes (clinician_approve and
 *        protocol_authorized_prescribing) succeed when all clauses + all
 *        bound-context attestations match.
 *   §3 — I-012 three-clause rejections, one finding per clause:
 *        Clause 1 (autonomy_level string equality);
 *        Clause 2 (confirmation event missing — empty audit_id, wrong
 *          action_id);
 *        Clause 3 (RBAC unauthorized).
 *   §4 — Workload-route cross-check: protocol-route guard with wrong
 *        workload type rejected.
 *   §5 — Bound-context attestation mismatches (the R3 finding closure):
 *        tenant_id, action_id, patient_account_id, actor_id,
 *        protocol_id, protocol_version mismatches each reject with
 *        audit_chain_confirmation_event_missing.
 *   §6 — Guard/event/route discrimination: route mismatch, missing
 *        guard, missing pending_transition.
 *   §7 — Clinician-only-route protocol-metadata guard: pending row with
 *        protocol_id/version on the clinician_approve route rejected
 *        (DB CHECK is the durable boundary; state machine is defense-
 *        in-depth).
 *
 * Spec references:
 *   - State Machines v1.2 §19 MedicationRequest lifecycle
 *   - AUDIT_EVENTS v5.3 §I-012 closure rule (carries forward v5.2 + P-011
 *     amendment adding prescribing.protocol_authorization_granted)
 *   - WORKLOAD_TAXONOMY v5.2 §2.1/§2.2 (canonical workload values)
 *   - AUTONOMY_LEVELS v5.2 (action_with_confirm)
 *   - migrations/025_medication_requests.sql (DB CHECK constraints
 *     mirrored by these tests)
 */

import { describe, expect, it } from 'vitest';

import {
  AUDIT_ACTIONS,
  I012RejectError,
  InvalidTransitionError,
  type I012GuardContext,
  type PendingTransitionContext,
  type TransitionEvent,
  discontinueEventForReason,
  isTerminalState,
  validateTransition,
} from '../../src/modules/pharmacy/internal/state-machine.ts';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const TENANT = 'Telecheck-US';
const ACTION_ID = 'act_01HCANONICALACTIONID0000';
const PATIENT = 'pat_01HCANONICALPATIENTID000';
const CLINICIAN = 'usr_01HCANONICALCLINICIANID0';
const PROTOCOL_ID = 'prot_01HCANONICALPROTOCOLID0';
const PROTOCOL_VERSION = 'v1.0';

const baseClinicianGuard = (): I012GuardContext => ({
  route: 'clinician_approve',
  confirmation_event_audit_id: 'aud_01HCONFIRMATIONEVENTID01',
  attested_tenant_id: TENANT,
  attested_action_id: ACTION_ID,
  attested_patient_account_id: PATIENT,
  attested_actor_id: CLINICIAN,
  confirming_actor_rbac_authorized: true,
});

const baseClinicianPending = (): PendingTransitionContext => ({
  tenant_id: TENANT,
  action_id: ACTION_ID,
  patient_account_id: PATIENT,
  actor_id: CLINICIAN,
  protocol_id: null,
  protocol_version: null,
});

const baseProtocolGuard = (): I012GuardContext => ({
  route: 'protocol_authorized_prescribing',
  autonomy_level: 'action_with_confirm',
  ai_workload_type: 'protocol_execution',
  confirmation_event_audit_id: 'aud_01HCONFIRMATIONEVENTID02',
  confirmation_event_action_id: AUDIT_ACTIONS.PRESCRIBING_PROTOCOL_AUTHORIZATION_GRANTED,
  attested_tenant_id: TENANT,
  attested_action_id: ACTION_ID,
  attested_patient_account_id: PATIENT,
  attested_actor_id: CLINICIAN,
  attested_protocol_id: PROTOCOL_ID,
  attested_protocol_version: PROTOCOL_VERSION,
  confirming_actor_rbac_authorized: true,
});

const baseProtocolPending = (): PendingTransitionContext => ({
  tenant_id: TENANT,
  action_id: ACTION_ID,
  patient_account_id: PATIENT,
  actor_id: CLINICIAN,
  protocol_id: PROTOCOL_ID,
  protocol_version: PROTOCOL_VERSION,
});

// ---------------------------------------------------------------------------
// §1 — Transition shape
// ---------------------------------------------------------------------------

describe('MedicationRequest state machine — §1 transition shape', () => {
  it('§1a rejects an invalid from-state for an event', () => {
    expect(() => validateTransition('active', 'submit_for_review')).toThrow(InvalidTransitionError);
  });

  it('§1b rejects all transitions from a terminal state', () => {
    for (const terminal of ['discontinued', 'superseded', 'expired', 'rejected'] as const) {
      expect(isTerminalState(terminal)).toBe(true);
      // Try every event from every terminal state.
      const events: TransitionEvent[] = [
        'submit_for_review',
        'engine_clean',
        'clinician_approve',
        'clinician_decline',
        'clinician_modify',
        'clinician_discontinue',
        'expire_at_window_end',
        'supersede_by_new_prescription',
      ];
      for (const event of events) {
        expect(() => validateTransition(terminal, event)).toThrow(InvalidTransitionError);
      }
    }
  });

  it('§1c rejects non-I-012 events that pass a guard (programmer-error guard)', () => {
    expect(() =>
      validateTransition(
        'draft',
        'submit_for_review',
        baseClinicianGuard(),
        baseClinicianPending(),
      ),
    ).toThrow(/not I-012-gated/);
  });

  it('§1d accepts non-I-012 events that pass no guard', () => {
    expect(validateTransition('draft', 'submit_for_review')).toBe('pending_interaction_check');
    expect(validateTransition('pending_interaction_check', 'engine_clean')).toBe(
      'pending_clinician_review',
    );
    expect(validateTransition('pending_clinician_review', 'clinician_decline')).toBe('rejected');
  });
});

// ---------------------------------------------------------------------------
// §2 — Happy paths (both I-012-gated routes)
// ---------------------------------------------------------------------------

describe('MedicationRequest state machine — §2 I-012 happy paths', () => {
  it('§2a clinician_approve succeeds with bound clinician guard + null protocol metadata', () => {
    expect(
      validateTransition(
        'pending_clinician_review',
        'clinician_approve',
        baseClinicianGuard(),
        baseClinicianPending(),
      ),
    ).toBe('active');
  });

  it('§2b protocol_authorized_prescribing succeeds with bound protocol guard + matching protocol metadata', () => {
    expect(
      validateTransition(
        'pending_clinician_review',
        'protocol_authorized_prescribing',
        baseProtocolGuard(),
        baseProtocolPending(),
      ),
    ).toBe('active');
  });
});

// ---------------------------------------------------------------------------
// §3 — I-012 three-clause rejections (protocol-authorized route)
// ---------------------------------------------------------------------------

describe('MedicationRequest state machine — §3 I-012 three-clause rejections', () => {
  it('§3a clause 1: autonomy_level != action_with_confirm rejected', () => {
    const guard = { ...baseProtocolGuard(), autonomy_level: 'advisory' as const };
    try {
      validateTransition(
        'pending_clinician_review',
        'protocol_authorized_prescribing',
        guard,
        baseProtocolPending(),
      );
      expect.fail('expected I012RejectError');
    } catch (err) {
      expect(err).toBeInstanceOf(I012RejectError);
      expect((err as I012RejectError).violated_clauses).toContain('autonomy_level_string_equality');
    }
  });

  it('§3b clause 2 (wrong action_id): protocol guard with confirmation_event_action_id != prescribing.protocol_authorization_granted rejected', () => {
    const guard = {
      ...baseProtocolGuard(),
      confirmation_event_action_id: AUDIT_ACTIONS.PRESCRIBING_APPROVED, // wrong route's action
    };
    try {
      validateTransition(
        'pending_clinician_review',
        'protocol_authorized_prescribing',
        guard,
        baseProtocolPending(),
      );
      expect.fail('expected I012RejectError');
    } catch (err) {
      expect(err).toBeInstanceOf(I012RejectError);
      expect((err as I012RejectError).violated_clauses).toContain(
        'audit_chain_confirmation_event_missing',
      );
    }
  });

  it('§3c clause 2 (empty audit_id): rejected', () => {
    const guard = { ...baseProtocolGuard(), confirmation_event_audit_id: '' };
    try {
      validateTransition(
        'pending_clinician_review',
        'protocol_authorized_prescribing',
        guard,
        baseProtocolPending(),
      );
      expect.fail('expected I012RejectError');
    } catch (err) {
      expect(err).toBeInstanceOf(I012RejectError);
      expect((err as I012RejectError).violated_clauses).toContain(
        'audit_chain_confirmation_event_missing',
      );
    }
  });

  it('§3d clause 3 (RBAC unauthorized): rejected', () => {
    const guard = {
      ...baseProtocolGuard(),
      confirming_actor_rbac_authorized: false as unknown as true,
    };
    try {
      validateTransition(
        'pending_clinician_review',
        'protocol_authorized_prescribing',
        guard,
        baseProtocolPending(),
      );
      expect.fail('expected I012RejectError');
    } catch (err) {
      expect(err).toBeInstanceOf(I012RejectError);
      expect((err as I012RejectError).violated_clauses).toContain(
        'confirming_actor_rbac_unauthorized',
      );
    }
  });
});

// ---------------------------------------------------------------------------
// §4 — Workload-route cross-check (defense-in-depth)
// ---------------------------------------------------------------------------

describe('MedicationRequest state machine — §4 workload-route cross-check', () => {
  it('§4a protocol route with ai_workload_type != protocol_execution rejected', () => {
    const guard = {
      ...baseProtocolGuard(),
      ai_workload_type: 'conversational_assistant' as const,
    };
    try {
      validateTransition(
        'pending_clinician_review',
        'protocol_authorized_prescribing',
        guard,
        baseProtocolPending(),
      );
      expect.fail('expected I012RejectError');
    } catch (err) {
      expect(err).toBeInstanceOf(I012RejectError);
      expect((err as I012RejectError).violated_clauses).toContain(
        'reserved_level_without_activation_audit_event',
      );
    }
  });
});

// ---------------------------------------------------------------------------
// §5 — Bound-context attestation mismatches (R3 finding closure)
// ---------------------------------------------------------------------------

describe('MedicationRequest state machine — §5 bound-context attestation mismatches', () => {
  const mismatchCases: Array<{
    name: string;
    guardOverride: Partial<I012GuardContext>;
  }> = [
    { name: 'tenant_id mismatch', guardOverride: { attested_tenant_id: 'Telecheck-Ghana' } },
    {
      name: 'action_id mismatch',
      guardOverride: { attested_action_id: 'act_WRONGACTIONID00000000000' },
    },
    {
      name: 'patient_account_id mismatch',
      guardOverride: { attested_patient_account_id: 'pat_WRONGPATIENTID0000000000' },
    },
    {
      name: 'actor_id mismatch',
      guardOverride: { attested_actor_id: 'usr_WRONGACTORID0000000000000' },
    },
  ];

  for (const { name, guardOverride } of mismatchCases) {
    it(`§5.clinician_approve: ${name} rejects with audit_chain_confirmation_event_missing`, () => {
      const guard = { ...baseClinicianGuard(), ...guardOverride } as I012GuardContext;
      try {
        validateTransition(
          'pending_clinician_review',
          'clinician_approve',
          guard,
          baseClinicianPending(),
        );
        expect.fail('expected I012RejectError');
      } catch (err) {
        expect(err).toBeInstanceOf(I012RejectError);
        expect((err as I012RejectError).violated_clauses).toContain(
          'audit_chain_confirmation_event_missing',
        );
      }
    });
  }

  it('§5.protocol_authorized_prescribing: protocol_id mismatch rejects', () => {
    const guard = { ...baseProtocolGuard(), attested_protocol_id: 'prot_WRONGPROTOCOLID00000' };
    try {
      validateTransition(
        'pending_clinician_review',
        'protocol_authorized_prescribing',
        guard,
        baseProtocolPending(),
      );
      expect.fail('expected I012RejectError');
    } catch (err) {
      expect(err).toBeInstanceOf(I012RejectError);
      expect((err as I012RejectError).violated_clauses).toContain(
        'audit_chain_confirmation_event_missing',
      );
    }
  });

  it('§5.protocol_authorized_prescribing: protocol_version mismatch rejects', () => {
    const guard = { ...baseProtocolGuard(), attested_protocol_version: 'v2.0' };
    try {
      validateTransition(
        'pending_clinician_review',
        'protocol_authorized_prescribing',
        guard,
        baseProtocolPending(),
      );
      expect.fail('expected I012RejectError');
    } catch (err) {
      expect(err).toBeInstanceOf(I012RejectError);
      expect((err as I012RejectError).violated_clauses).toContain(
        'audit_chain_confirmation_event_missing',
      );
    }
  });
});

// ---------------------------------------------------------------------------
// §6 — Guard/event/route discrimination
// ---------------------------------------------------------------------------

describe('MedicationRequest state machine — §6 guard/event/route discrimination', () => {
  it('§6a I-012 event with no guard rejected', () => {
    expect(() => validateTransition('pending_clinician_review', 'clinician_approve')).toThrow(
      I012RejectError,
    );
  });

  it('§6b I-012 event with guard but no pending_transition rejected', () => {
    expect(() =>
      validateTransition('pending_clinician_review', 'clinician_approve', baseClinicianGuard()),
    ).toThrow(I012RejectError);
  });

  it('§6c route mismatch: clinician_approve event with protocol guard rejected', () => {
    expect(() =>
      validateTransition(
        'pending_clinician_review',
        'clinician_approve',
        baseProtocolGuard(),
        baseProtocolPending(),
      ),
    ).toThrow(I012RejectError);
  });

  it('§6d route mismatch: protocol_authorized_prescribing event with clinician guard rejected', () => {
    expect(() =>
      validateTransition(
        'pending_clinician_review',
        'protocol_authorized_prescribing',
        baseClinicianGuard(),
        baseClinicianPending(),
      ),
    ).toThrow(I012RejectError);
  });
});

// ---------------------------------------------------------------------------
// §7 — Clinician-only-route protocol-metadata guard (defense-in-depth)
// ---------------------------------------------------------------------------

describe('MedicationRequest state machine — §7 clinician-only-route protocol-metadata guard', () => {
  it('§7a clinician_approve with non-null pending protocol_id rejected (DB CHECK is durable boundary)', () => {
    const pending: PendingTransitionContext = {
      ...baseClinicianPending(),
      protocol_id: PROTOCOL_ID,
      protocol_version: PROTOCOL_VERSION,
    };
    expect(() =>
      validateTransition(
        'pending_clinician_review',
        'clinician_approve',
        baseClinicianGuard(),
        pending,
      ),
    ).toThrow(I012RejectError);
  });
});

// ---------------------------------------------------------------------------
// §8 — discontinueEventForReason helper
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// §9 — Canonical I-012 action_id convention (row.id IS the action_id)
// ---------------------------------------------------------------------------
//
// The state-machine doc-comment on PendingTransitionContext.action_id
// specifies that the I-012 action_id for a MedicationRequest prescribing
// decision IS the row's `id` field (canonical mrx_<ULID>). All audit
// events emitted in service of that prescribing decision share the same
// action_id derived from the row id. This test simulates the service-
// layer's responsibility — derive PendingTransitionContext.action_id
// from the row's id, and prove validateTransition accepts the binding
// when the guard attests the same id, and rejects when they diverge.

describe('MedicationRequest state machine — §9 row.id == action_id convention', () => {
  const ROW_ID = 'mrx_01HABCDEFGHJKMNPQRSTVWXYZ';

  it('§9a service layer derives action_id from row.id; guard with matching attested_action_id succeeds', () => {
    const pending: PendingTransitionContext = {
      tenant_id: TENANT,
      action_id: ROW_ID, // ← derived from MedicationRequest row.id, per convention
      patient_account_id: PATIENT,
      actor_id: CLINICIAN,
      protocol_id: null,
      protocol_version: null,
    };
    const guard: I012GuardContext = {
      route: 'clinician_approve',
      confirmation_event_audit_id: 'aud_01HCONFIRMATIONEVENTID09',
      attested_tenant_id: TENANT,
      attested_action_id: ROW_ID, // ← service layer attests the SAME id
      attested_patient_account_id: PATIENT,
      attested_actor_id: CLINICIAN,
      confirming_actor_rbac_authorized: true,
    };
    expect(
      validateTransition('pending_clinician_review', 'clinician_approve', guard, pending),
    ).toBe('active');
  });

  it('§9b guard whose attested_action_id diverges from row.id rejects (binding broken)', () => {
    const pending: PendingTransitionContext = {
      tenant_id: TENANT,
      action_id: ROW_ID,
      patient_account_id: PATIENT,
      actor_id: CLINICIAN,
      protocol_id: null,
      protocol_version: null,
    };
    const guard: I012GuardContext = {
      route: 'clinician_approve',
      confirmation_event_audit_id: 'aud_01HCONFIRMATIONEVENTID10',
      attested_tenant_id: TENANT,
      attested_action_id: 'mrx_01HZZZZZZZZZZZZZZZZZZZZZZZ', // different row.id — the action_id binding doesn't match
      attested_patient_account_id: PATIENT,
      attested_actor_id: CLINICIAN,
      confirming_actor_rbac_authorized: true,
    };
    try {
      validateTransition('pending_clinician_review', 'clinician_approve', guard, pending);
      expect.fail('expected I012RejectError');
    } catch (err) {
      expect(err).toBeInstanceOf(I012RejectError);
      expect((err as I012RejectError).violated_clauses).toContain(
        'audit_chain_confirmation_event_missing',
      );
    }
  });

  it('§9c protocol route: row.id == action_id convention holds across both I-012 routes', () => {
    const pending: PendingTransitionContext = {
      tenant_id: TENANT,
      action_id: ROW_ID, // ← derived from row.id
      patient_account_id: PATIENT,
      actor_id: CLINICIAN,
      protocol_id: PROTOCOL_ID,
      protocol_version: PROTOCOL_VERSION,
    };
    const guard: I012GuardContext = {
      route: 'protocol_authorized_prescribing',
      autonomy_level: 'action_with_confirm',
      ai_workload_type: 'protocol_execution',
      confirmation_event_audit_id: 'aud_01HCONFIRMATIONEVENTID11',
      confirmation_event_action_id: AUDIT_ACTIONS.PRESCRIBING_PROTOCOL_AUTHORIZATION_GRANTED,
      attested_tenant_id: TENANT,
      attested_action_id: ROW_ID,
      attested_patient_account_id: PATIENT,
      attested_actor_id: CLINICIAN,
      attested_protocol_id: PROTOCOL_ID,
      attested_protocol_version: PROTOCOL_VERSION,
      confirming_actor_rbac_authorized: true,
    };
    expect(
      validateTransition(
        'pending_clinician_review',
        'protocol_authorized_prescribing',
        guard,
        pending,
      ),
    ).toBe('active');
  });
});

// ---------------------------------------------------------------------------
// §8 — discontinueEventForReason helper
// ---------------------------------------------------------------------------

describe('MedicationRequest state machine — §8 discontinueEventForReason', () => {
  it('§8a maps patient_request → patient_request_discontinue', () => {
    expect(discontinueEventForReason('patient_request')).toBe('patient_request_discontinue');
  });
  it('§8b maps adverse_event → adverse_event_discontinue', () => {
    expect(discontinueEventForReason('adverse_event')).toBe('adverse_event_discontinue');
  });
  it('§8c maps clinical_decision → clinician_discontinue', () => {
    expect(discontinueEventForReason('clinical_decision')).toBe('clinician_discontinue');
  });
  it('§8d maps safety_hold → clinician_discontinue (clinician routes the override outcome)', () => {
    expect(discontinueEventForReason('safety_hold')).toBe('clinician_discontinue');
  });
});
