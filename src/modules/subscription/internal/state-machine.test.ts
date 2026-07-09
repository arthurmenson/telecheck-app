/**
 * state-machine.test.ts — pure unit coverage of the Subscription state
 * machine (State Machines v1.1 §15). No DB — exercises the transition table,
 * guard helpers, and the §15 invariants directly.
 */

import { describe, expect, it } from 'vitest';

import {
  cadenceInterval,
  checkTransition,
  isValidPauseWindow,
  MAX_PAUSE_DAYS,
  SUBSCRIPTION_TRANSITIONS,
  TERMINAL_STATUSES,
  TRANSITION_TABLE,
  type SubscriptionTransition,
} from './state-machine.js';
import { SUBSCRIPTION_STATUSES, type SubscriptionActorType } from './types.js';

describe('subscription state machine — §15 transition table integrity', () => {
  it('every transition has a table entry with in-vocabulary from/to states', () => {
    for (const t of SUBSCRIPTION_TRANSITIONS) {
      const spec = TRANSITION_TABLE[t];
      expect(spec).toBeDefined();
      expect(SUBSCRIPTION_STATUSES).toContain(spec.from);
      expect(SUBSCRIPTION_STATUSES).toContain(spec.to);
      expect(spec.actorTypes.length).toBeGreaterThan(0);
      expect(['A', 'C']).toContain(spec.auditCategory);
    }
  });

  it('the SAFETY_HOLD family + switch approval are Category A; all others Category C', () => {
    const categoryA: SubscriptionTransition[] = [
      'safety_signal_critical',
      'switch_approve',
      'clinician_release',
      'clinician_terminate',
    ];
    for (const t of SUBSCRIPTION_TRANSITIONS) {
      const expected = categoryA.includes(t) ? 'A' : 'C';
      expect(TRANSITION_TABLE[t].auditCategory).toBe(expected);
    }
  });

  it('SAFETY_HOLD → ACTIVE (clinician_release) is clinician-ONLY (I-001 floor)', () => {
    expect(TRANSITION_TABLE.clinician_release.actorTypes).toEqual(['clinician']);
    // No system/patient release path exists from SAFETY_HOLD to ACTIVE.
    for (const t of SUBSCRIPTION_TRANSITIONS) {
      const spec = TRANSITION_TABLE[t];
      if (spec.from === 'SAFETY_HOLD' && spec.to === 'ACTIVE') {
        expect(spec.actorTypes).toEqual(['clinician']);
      }
    }
  });

  it('terminal states never appear as a transition from-state', () => {
    for (const t of SUBSCRIPTION_TRANSITIONS) {
      expect(TERMINAL_STATUSES).not.toContain(TRANSITION_TABLE[t].from);
    }
  });

  it('the audit-only SPEC-GAP transitions carry a null eventType', () => {
    // §15 emissions with no CDM §4.8 enum value: period_end (refill.initiated),
    // complete (subscription.fulfilled), switch_decline (switch_declined),
    // clinician_terminate (terminated_clinical).
    for (const t of ['period_end', 'complete', 'switch_decline', 'clinician_terminate'] as const) {
      expect(TRANSITION_TABLE[t].eventType).toBeNull();
    }
    // A representative enum-backed transition carries its value.
    expect(TRANSITION_TABLE.pause_request.eventType).toBe('paused');
  });
});

describe('subscription state machine — checkTransition guard', () => {
  it('accepts a valid (from, actor) pair', () => {
    const r = checkTransition('pause_request', 'ACTIVE', 'patient');
    expect(r.ok).toBe(true);
    expect(r.spec?.to).toBe('PAUSED');
  });

  it('rejects a wrong from-state with invalid_from_state', () => {
    const r = checkTransition('pause_request', 'PAUSED', 'patient');
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('invalid_from_state');
  });

  it('rejects a wrong actor with actor_not_permitted', () => {
    // clinician cannot drive the patient-sovereign pause.
    const r = checkTransition('pause_request', 'ACTIVE', 'clinician');
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('actor_not_permitted');
  });

  it('tenant_operator is accepted alongside patient on patient-sovereign transitions', () => {
    for (const t of ['pause_request', 'switch_request', 'cancel_request'] as const) {
      expect(checkTransition(t, 'ACTIVE', 'tenant_operator').ok).toBe(true);
    }
  });

  it('rejects EVERY actor type not listed for each transition (exhaustive)', () => {
    const allActors: SubscriptionActorType[] = [
      'patient',
      'clinician',
      'system',
      'tenant_operator',
      'platform_admin',
    ];
    for (const t of SUBSCRIPTION_TRANSITIONS) {
      const spec = TRANSITION_TABLE[t];
      for (const actor of allActors) {
        const r = checkTransition(t, spec.from, actor);
        if (spec.actorTypes.includes(actor)) {
          expect(r.ok).toBe(true);
        } else {
          expect(r.ok).toBe(false);
          expect(r.reason).toBe('actor_not_permitted');
        }
      }
    }
  });
});

describe('subscription state machine — pause-window guard', () => {
  const base = new Date('2026-07-09T00:00:00Z');

  it('accepts a window inside the 90-day ceiling', () => {
    const until = new Date(base.getTime() + 30 * 24 * 60 * 60 * 1000);
    expect(isValidPauseWindow(base, until)).toBe(true);
  });

  it('accepts exactly the 90-day boundary', () => {
    const until = new Date(base.getTime() + MAX_PAUSE_DAYS * 24 * 60 * 60 * 1000);
    expect(isValidPauseWindow(base, until)).toBe(true);
  });

  it('rejects a window beyond 90 days', () => {
    const until = new Date(base.getTime() + (MAX_PAUSE_DAYS + 1) * 24 * 60 * 60 * 1000);
    expect(isValidPauseWindow(base, until)).toBe(false);
  });

  it('rejects a non-future window', () => {
    expect(isValidPauseWindow(base, base)).toBe(false);
    expect(isValidPauseWindow(base, new Date(base.getTime() - 1000))).toBe(false);
  });
});

describe('subscription state machine — cadenceInterval', () => {
  it('maps each cadence to its Postgres interval literal', () => {
    expect(cadenceInterval('monthly')).toBe('1 month');
    expect(cadenceInterval('quarterly')).toBe('3 months');
    expect(cadenceInterval('biannual')).toBe('6 months');
  });
});
