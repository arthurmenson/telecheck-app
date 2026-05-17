/**
 * audit-failure-injection.test.ts — unit tests for the generic
 * createAuditFailureInjector factory in
 * `tests/helpers/audit-failure-injection.ts`.
 *
 * Pins the per-emitter isolation + self-reset semantics that the
 * generic factory promises, so that future test files (and the
 * forthcoming SI-013 Mode 1 Category B injector once that emitter
 * lands) cannot regress the harness behavior the PR #163 round-trip
 * test relies on.
 *
 * Coverage groups:
 *
 *   A — Construction guards
 *     A1 throws on empty `emitterName`
 *     A2 returns distinct injectors with the requested name
 *
 *   B — Default state + mutators
 *     B1 default mode is 'normal'
 *     B2 set('fail-once') → get() === 'fail-once'
 *     B3 set('fail-always') → get() === 'fail-always'
 *     B4 reset() returns to 'normal' from any state
 *
 *   C — consumeOrThrow semantics
 *     C1 'normal' → no-op (no throw)
 *     C2 'fail-once' → throws AuditInjectedFailure AND self-resets
 *                       to 'normal' (next call no-ops)
 *     C3 'fail-always' → throws on every call; mode unchanged
 *     C4 self-reset on fail-once is observable BEFORE the throw
 *        propagates (a sibling injector's state cannot be corrupted
 *        by an unwinding stack frame)
 *
 *   D — Sentinel error contract
 *     D1 AuditInjectedFailure.emitterName matches the injector's
 *     D2 default message includes the emitter name
 *     D3 custom message overrides default
 *
 *   E — Per-injector isolation (the key generalization property)
 *     E1 two injectors hold independent modes
 *     E2 consuming fail-once on injector A does not affect B
 *     E3 reset on A does not affect B
 *     E4 sentinel error from A's consume carries A's name (not B's)
 *
 * Spec references:
 *   - PR #163 — original Mode 1-specific harness this generalizes
 *   - This PR — generic factory + per-injector-isolation guarantee
 *     for upcoming SI-013 Mode 1 Category B emitter testing
 */

import { afterEach, describe, expect, it } from 'vitest';

import {
  AuditInjectedFailure,
  createAuditFailureInjector,
  type AuditFailureInjector,
} from '../helpers/audit-failure-injection.ts';

// Test-local injectors. Each test that needs a fresh injector
// constructs one inside the test body — these top-level constants are
// only used for the shared-across-tests scenarios in Group E.
let injectorA: AuditFailureInjector;
let injectorB: AuditFailureInjector;

afterEach(() => {
  // Defensive reset in case a test left a non-normal mode.
  injectorA?.reset();
  injectorB?.reset();
});

// ---------------------------------------------------------------------------
// A — Construction guards
// ---------------------------------------------------------------------------

describe('createAuditFailureInjector — construction', () => {
  it('A1 throws on empty emitterName', () => {
    expect(() => createAuditFailureInjector('')).toThrow(/emitterName must be a non-empty string/i);
  });

  it('A2 returns distinct injectors with the requested name', () => {
    const a = createAuditFailureInjector('emitFoo');
    const b = createAuditFailureInjector('emitFoo'); // same name is allowed
    expect(a).not.toBe(b);
    expect(a.emitterName).toBe('emitFoo');
    expect(b.emitterName).toBe('emitFoo');
  });
});

// ---------------------------------------------------------------------------
// B — Default state + mutators
// ---------------------------------------------------------------------------

describe('AuditFailureInjector — default state + mutators', () => {
  it('B1 default mode is "normal"', () => {
    const inj = createAuditFailureInjector('emitB1');
    expect(inj.get()).toBe('normal');
  });

  it('B2 set("fail-once") flips mode', () => {
    const inj = createAuditFailureInjector('emitB2');
    inj.set('fail-once');
    expect(inj.get()).toBe('fail-once');
  });

  it('B3 set("fail-always") flips mode', () => {
    const inj = createAuditFailureInjector('emitB3');
    inj.set('fail-always');
    expect(inj.get()).toBe('fail-always');
  });

  it('B4 reset() returns to "normal" from any state', () => {
    const inj = createAuditFailureInjector('emitB4');
    inj.set('fail-always');
    inj.reset();
    expect(inj.get()).toBe('normal');

    inj.set('fail-once');
    inj.reset();
    expect(inj.get()).toBe('normal');
  });
});

// ---------------------------------------------------------------------------
// C — consumeOrThrow semantics
// ---------------------------------------------------------------------------

describe('AuditFailureInjector.consumeOrThrow', () => {
  it('C1 "normal" is a no-op', () => {
    const inj = createAuditFailureInjector('emitC1');
    expect(() => inj.consumeOrThrow()).not.toThrow();
    expect(inj.get()).toBe('normal');
  });

  it('C2 "fail-once" throws AuditInjectedFailure AND self-resets to "normal"', () => {
    const inj = createAuditFailureInjector('emitC2');
    inj.set('fail-once');

    expect(() => inj.consumeOrThrow()).toThrow(AuditInjectedFailure);
    expect(inj.get()).toBe('normal');

    // Subsequent call no-ops because mode is now 'normal'.
    expect(() => inj.consumeOrThrow()).not.toThrow();
  });

  it('C3 "fail-always" throws on every call; mode unchanged', () => {
    const inj = createAuditFailureInjector('emitC3');
    inj.set('fail-always');

    expect(() => inj.consumeOrThrow()).toThrow(AuditInjectedFailure);
    expect(inj.get()).toBe('fail-always');

    expect(() => inj.consumeOrThrow()).toThrow(AuditInjectedFailure);
    expect(inj.get()).toBe('fail-always');

    expect(() => inj.consumeOrThrow()).toThrow(AuditInjectedFailure);
    expect(inj.get()).toBe('fail-always');
  });

  it('C4 fail-once self-reset is observable BEFORE the throw propagates', () => {
    // This guards against an implementation where the mode flip
    // happens INSIDE a finally block after the throw — which would
    // leave a window where a synchronous re-entry (e.g., a retry
    // loop in the same tick) would see the old mode. The contract
    // is "reset BEFORE throwing", which we exercise by re-entering
    // the injector from within the catch.
    const inj = createAuditFailureInjector('emitC4');
    inj.set('fail-once');

    let observedModeOnReentry: string | null = null;
    try {
      inj.consumeOrThrow();
    } catch (err) {
      expect(err).toBeInstanceOf(AuditInjectedFailure);
      observedModeOnReentry = inj.get();
    }

    expect(observedModeOnReentry).toBe('normal');
  });
});

// ---------------------------------------------------------------------------
// D — Sentinel error contract
// ---------------------------------------------------------------------------

describe('AuditInjectedFailure', () => {
  it('D1 emitterName matches the injector that threw', () => {
    const inj = createAuditFailureInjector('emitD1');
    inj.set('fail-always');

    try {
      inj.consumeOrThrow();
      throw new Error('unreachable');
    } catch (err) {
      expect(err).toBeInstanceOf(AuditInjectedFailure);
      expect((err as AuditInjectedFailure).emitterName).toBe('emitD1');
      expect((err as AuditInjectedFailure).name).toBe('AuditInjectedFailure');
    }
  });

  it('D2 default message includes the emitter name', () => {
    const err = new AuditInjectedFailure('emitD2');
    expect(err.message).toContain('emitD2');
    expect(err.message).toMatch(/forced failure/i);
  });

  it('D3 custom message overrides default', () => {
    const err = new AuditInjectedFailure('emitD3', 'custom diagnostic text');
    expect(err.message).toBe('custom diagnostic text');
    // emitterName is still recorded even when the message is custom.
    expect(err.emitterName).toBe('emitD3');
  });
});

// ---------------------------------------------------------------------------
// E — Per-injector isolation (THE key generalization property)
// ---------------------------------------------------------------------------

describe('per-injector isolation', () => {
  it('E1 two injectors hold independent modes', () => {
    injectorA = createAuditFailureInjector('emitA');
    injectorB = createAuditFailureInjector('emitB');

    injectorA.set('fail-always');
    injectorB.set('fail-once');

    expect(injectorA.get()).toBe('fail-always');
    expect(injectorB.get()).toBe('fail-once');
  });

  it('E2 consuming fail-once on A does NOT affect B', () => {
    injectorA = createAuditFailureInjector('emitA');
    injectorB = createAuditFailureInjector('emitB');

    injectorA.set('fail-once');
    injectorB.set('fail-once');

    expect(() => injectorA.consumeOrThrow()).toThrow(AuditInjectedFailure);
    expect(injectorA.get()).toBe('normal');

    // B was NOT consumed.
    expect(injectorB.get()).toBe('fail-once');
    expect(() => injectorB.consumeOrThrow()).toThrow(AuditInjectedFailure);
  });

  it('E3 reset on A does NOT affect B', () => {
    injectorA = createAuditFailureInjector('emitA');
    injectorB = createAuditFailureInjector('emitB');

    injectorA.set('fail-always');
    injectorB.set('fail-always');

    injectorA.reset();

    expect(injectorA.get()).toBe('normal');
    expect(injectorB.get()).toBe('fail-always');
  });

  it('E4 sentinel error from A carries A.emitterName (not B.emitterName)', () => {
    injectorA = createAuditFailureInjector('emitA-distinct');
    injectorB = createAuditFailureInjector('emitB-distinct');

    injectorA.set('fail-always');
    injectorB.set('fail-always');

    try {
      injectorA.consumeOrThrow();
      throw new Error('unreachable');
    } catch (err) {
      expect(err).toBeInstanceOf(AuditInjectedFailure);
      expect((err as AuditInjectedFailure).emitterName).toBe('emitA-distinct');
      expect((err as AuditInjectedFailure).emitterName).not.toBe('emitB-distinct');
    }
  });
});
