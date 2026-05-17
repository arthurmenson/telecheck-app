/**
 * mode-1-chat-audit-injection.test.ts — wrapper-level pinning of
 * the PR #163 backwards-compatible sentinel error contract
 * (Mode1AuditInjectedFailure) on the refactored Mode 1 harness.
 *
 * Added per Codex R1 closure on PR #165: the previous version of
 * the Mode 1 wrapper delegated `consumeMode1AuditFailureOrThrow`
 * directly to the generic injector's `consumeOrThrow`, which threw
 * the generic `AuditInjectedFailure` base class instead of the
 * `Mode1AuditInjectedFailure` subclass the PR #163 surface
 * promised. These tests assert that:
 *
 *   - `consumeMode1AuditFailureOrThrow` throws an
 *     `instanceof Mode1AuditInjectedFailure` (not just the generic
 *     base)
 *   - The thrown error ALSO satisfies
 *     `instanceof AuditInjectedFailure` so generic catch paths
 *     still match
 *   - `err.name === 'Mode1AuditInjectedFailure'` so any
 *     name-string assertion downstream still passes
 *   - `err.emitterName === 'emitMode1ChatResponseAudit'`
 *   - fail-once self-reset semantics are preserved through the
 *     wrapper (matches the generic factory's C2 + C4 contracts)
 *
 * This file lives next to the generic-factory unit tests
 * (`audit-failure-injection.test.ts`) so the contract is exercised
 * without spinning up the integration harness — the PR #163
 * integration test will continue to exercise the wrapper end-to-
 * end against a real Postgres + Fastify stack.
 *
 * Spec references:
 *   - PR #163 (original Mode 1 harness)
 *   - PR #165 Codex R1 closure (errorCtor wiring on the generic
 *     factory + wrapper-level pinning)
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AuditInjectedFailure } from '../helpers/audit-failure-injection.ts';
import {
  consumeMode1AuditFailureOrThrow,
  getMode1AuditFailure,
  Mode1AuditInjectedFailure,
  mode1ChatResponseAuditInjector,
  resetMode1AuditFailure,
  setMode1AuditFailure,
} from '../helpers/mode-1-chat-audit-injection.ts';

beforeEach(() => resetMode1AuditFailure());
afterEach(() => resetMode1AuditFailure());

describe('Mode 1 wrapper — sentinel error contract (PR #163 backwards compat)', () => {
  it('consumeMode1AuditFailureOrThrow throws Mode1AuditInjectedFailure on fail-always', () => {
    setMode1AuditFailure('fail-always');

    try {
      consumeMode1AuditFailureOrThrow();
      throw new Error('unreachable — consume should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(Mode1AuditInjectedFailure);
      // Subclass still satisfies the generic base — multi-injector
      // catch paths that match the base must continue to work.
      expect(err).toBeInstanceOf(AuditInjectedFailure);
      // name-string assertions continue to match.
      expect((err as Mode1AuditInjectedFailure).name).toBe('Mode1AuditInjectedFailure');
      // emitterName carries through to the subclass.
      expect((err as Mode1AuditInjectedFailure).emitterName).toBe('emitMode1ChatResponseAudit');
    }
  });

  it('consumeMode1AuditFailureOrThrow throws Mode1AuditInjectedFailure on fail-once', () => {
    setMode1AuditFailure('fail-once');

    expect(() => consumeMode1AuditFailureOrThrow()).toThrow(Mode1AuditInjectedFailure);
    // Self-reset: subsequent consume is a no-op.
    expect(getMode1AuditFailure()).toBe('normal');
    expect(() => consumeMode1AuditFailureOrThrow()).not.toThrow();
  });

  it('fail-once self-reset is observable BEFORE the throw propagates (mirrors generic C4)', () => {
    setMode1AuditFailure('fail-once');

    let observedModeOnReentry: string | null = null;
    try {
      consumeMode1AuditFailureOrThrow();
    } catch (err) {
      expect(err).toBeInstanceOf(Mode1AuditInjectedFailure);
      observedModeOnReentry = getMode1AuditFailure();
    }

    expect(observedModeOnReentry).toBe('normal');
  });

  it('normal mode is a no-op', () => {
    expect(getMode1AuditFailure()).toBe('normal');
    expect(() => consumeMode1AuditFailureOrThrow()).not.toThrow();
  });

  it('Mode1AuditInjectedFailure can be instantiated directly with default emitter name', () => {
    // Construction path used by callers that want to manufacture
    // the sentinel error directly (not via the injector).
    const err = new Mode1AuditInjectedFailure();
    expect(err).toBeInstanceOf(Mode1AuditInjectedFailure);
    expect(err).toBeInstanceOf(AuditInjectedFailure);
    expect(err.name).toBe('Mode1AuditInjectedFailure');
    expect(err.emitterName).toBe('emitMode1ChatResponseAudit');
    // Default message comes from the class's own default, NOT the
    // generic base's `${emitterName} forced failure` template — so
    // a downstream test asserting on the exact PR #163 message
    // string continues to pass.
    expect(err.message).toBe('test: emitMode1ChatResponseAudit forced failure');
  });

  it('Mode1AuditInjectedFailure preserves PR #163 legacy custom-message contract (Codex R2 M1)', () => {
    // The original PR #163 class accepted `(message?: string)` and
    // passed it to the parent Error. A previous interim refactor
    // normalized the signature to `(_emitterName?: string)` which
    // silently broke `new Mode1AuditInjectedFailure('custom diagnostic')`
    // (the custom message was discarded). Codex R2 M1 reopened the
    // legacy surface so direct construction with a custom message
    // continues to carry that message into Error.message verbatim.
    const err = new Mode1AuditInjectedFailure('custom diagnostic text');
    expect(err).toBeInstanceOf(Mode1AuditInjectedFailure);
    expect(err).toBeInstanceOf(AuditInjectedFailure);
    expect(err.message).toBe('custom diagnostic text');
    // emitterName is still bound — the custom message does not
    // change the emitter identity.
    expect(err.emitterName).toBe('emitMode1ChatResponseAudit');
  });

  it('factory adapter produces canonical sentinel message (not the literal emitter-name string)', () => {
    // Regression guard for the Codex R2 M1 closure design:
    // Mode1AuditInjectedFailureFactoryAdapter must IGNORE the
    // emitter name the factory passes (the class is already bound
    // to it) and call the no-argument parent constructor to get
    // the canonical default sentinel message. A regression where
    // the adapter forwarded its argument to the public
    // (message?: string) constructor would put the literal string
    // 'emitMode1ChatResponseAudit' into err.message — wrong.
    setMode1AuditFailure('fail-always');

    try {
      consumeMode1AuditFailureOrThrow();
      throw new Error('unreachable');
    } catch (err) {
      expect(err).toBeInstanceOf(Mode1AuditInjectedFailure);
      // Canonical default message — NOT the literal emitter-name string.
      expect((err as Mode1AuditInjectedFailure).message).toBe(
        'test: emitMode1ChatResponseAudit forced failure',
      );
      expect((err as Mode1AuditInjectedFailure).message).not.toBe('emitMode1ChatResponseAudit');
    }
  });

  it('exposes the same injector handle via the generic + named APIs', () => {
    // Sanity-check: tests that already imported the injector directly
    // (advanced use case) and tests that use the named API must hit
    // the SAME state. A regression where the named functions wrapped
    // a different injector than the exported handle would silently
    // break state isolation.
    expect(mode1ChatResponseAuditInjector.get()).toBe('normal');
    setMode1AuditFailure('fail-always');
    expect(mode1ChatResponseAuditInjector.get()).toBe('fail-always');
    mode1ChatResponseAuditInjector.reset();
    expect(getMode1AuditFailure()).toBe('normal');
  });
});
