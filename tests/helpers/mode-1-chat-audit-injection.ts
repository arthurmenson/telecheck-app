/**
 * mode-1-chat-audit-injection.ts — Mode 1 chat handler audit-failure
 * injection harness.
 *
 * Thin Mode-1-specific wrapper around the generic
 * createAuditFailureInjector factory in
 * `tests/helpers/audit-failure-injection.ts`. Preserved as a
 * named, single-purpose helper so the existing PR #163 test file
 * imports (consumeMode1AuditFailureOrThrow / setMode1AuditFailure /
 * resetMode1AuditFailure) keep their semantics unchanged while the
 * underlying mechanism is now sharable with any future emitter's
 * injector.
 *
 * Future emitter harnesses should follow the same pattern:
 *
 *   import { createAuditFailureInjector } from './audit-failure-injection.ts';
 *
 *   export const fooAuditInjector =
 *     createAuditFailureInjector('emitFooAudit');
 *
 *   // Optional thin re-exports if a per-emitter named API is
 *   // preferred (matches the Mode 1 precedent below):
 *   export const setFooAuditFailure = (m) => fooAuditInjector.set(m);
 *   // ...
 *
 * Purpose: closes the R7 finding deferred from PR #160 (Mode 1 chat
 * handler) — the round-trip "audit fails → cache rolls back → retry
 * with same Idempotency-Key uses deterministic IDs → only ONE
 * Category A crisis audit emitted across both attempts" invariant
 * cannot be exercised without an audit-emission failure injection
 * point.
 *
 * Spec references:
 *   - PR #160 Codex R4 H1 closure (deterministic ID derivation)
 *   - PR #162 Codex R1 H1 finding (the deferred round-trip test)
 *   - PR #163 (this harness's original single-emitter implementation)
 *   - AI_LAYERING v5.2 §6 (FLOOR-020 audit envelope) — the audit
 *     being injected is the Category C `ai_chat_response_emitted`
 *     emission, not the Category A `crisis_detection_trigger`
 *     emission (the latter has its own crisis-gate dedupe protection)
 */

import {
  type AuditFailureMode,
  type AuditFailureInjector,
  AuditInjectedFailure,
  createAuditFailureInjector,
} from './audit-failure-injection.ts';

// ---------------------------------------------------------------------------
// Backwards-compatible sentinel error class (declared FIRST so it can be
// passed to the injector constructor below; the deprecation note still
// applies)
// ---------------------------------------------------------------------------
//
// The PR #163 implementation exported a `Mode1AuditInjectedFailure`
// class. The generic harness consolidates on a single
// `AuditInjectedFailure` whose `emitterName` field disambiguates
// which emitter failed (more useful when a test exercises multiple
// injectors). The class below is retained ONLY for `instanceof
// Mode1AuditInjectedFailure` assertions that may exist in the
// PR #163 test file or downstream — it is a thin subclass of
// `AuditInjectedFailure` so both `instanceof` checks succeed.
//
// New test files should `instanceof AuditInjectedFailure` and read
// `err.emitterName` to identify the emitter — that pattern scales
// to any number of injectors.
//
// IMPORTANT (Codex R1 closure on PR #165): the injector below MUST
// be constructed with `errorCtor: Mode1AuditInjectedFailure` so the
// `consumeOrThrow` path throws THIS subclass, not the generic base.
// Without the errorCtor wiring, `consumeMode1AuditFailureOrThrow`
// would throw `AuditInjectedFailure` and silently break any
// `err instanceof Mode1AuditInjectedFailure` assertion downstream.

/**
 * @deprecated for new test files — use `AuditInjectedFailure` from
 * `./audit-failure-injection.ts` and check `err.emitterName ===
 * 'emitMode1ChatResponseAudit'`. Retained as a thin subclass for
 * backwards compatibility with any `instanceof
 * Mode1AuditInjectedFailure` assertions in the PR #163 test file or
 * downstream callers.
 */
export class Mode1AuditInjectedFailure extends AuditInjectedFailure {
  // Match the generic factory's `AuditInjectedFailureCtor` signature
  // by accepting only `emitterName`. The original PR #163 class
  // accepted an optional message, but the factory never passes one;
  // tests that want a custom message can instantiate this class
  // directly and don't go through the injector.
  constructor(_emitterName: string = 'emitMode1ChatResponseAudit') {
    // `super` accepts (emitterName, message?) — the message is left
    // to the default so AuditInjectedFailure populates it from the
    // emitter name as usual.
    super('emitMode1ChatResponseAudit');
    this.name = 'Mode1AuditInjectedFailure';
  }
}

/**
 * The single injector instance bound to
 * `emitMode1ChatResponseAudit`. Tests + the vi.mock factory both
 * reach the same injector via the named re-exports below (or
 * directly via this handle for new test files).
 *
 * Wired with `errorCtor: Mode1AuditInjectedFailure` per the Codex
 * R1 closure on PR #165 so `consumeOrThrow` throws the subclass
 * (preserving `instanceof Mode1AuditInjectedFailure` for PR #163
 * compatibility) AND continues to satisfy `instanceof
 * AuditInjectedFailure` for any generic catch path.
 */
export const mode1ChatResponseAuditInjector: AuditFailureInjector =
  createAuditFailureInjector('emitMode1ChatResponseAudit', {
    errorCtor: Mode1AuditInjectedFailure,
  });

// ---------------------------------------------------------------------------
// Backwards-compatible named API (PR #163 surface)
// ---------------------------------------------------------------------------
//
// These named re-exports preserve the API the existing PR #163 test
// file imports so the refactor is non-breaking. New test files should
// prefer the generic injector handle above; the named API below is
// retained to avoid churning the existing call sites in a refactor
// that is otherwise purely additive.

/**
 * @deprecated for new test files — prefer the generic
 * `mode1ChatResponseAuditInjector` handle and call its methods
 * directly. Retained for backwards compatibility with the PR #163
 * test file.
 *
 * Re-typed as `AuditFailureMode` (the generic alias) since the
 * underlying enum is identical.
 */
export type Mode1AuditFailureMode = AuditFailureMode;

/** Read the current Mode 1 audit-failure mode. */
export const getMode1AuditFailure = (): Mode1AuditFailureMode =>
  mode1ChatResponseAuditInjector.get();

/** Set the Mode 1 audit-failure mode. */
export const setMode1AuditFailure = (mode: Mode1AuditFailureMode): void =>
  mode1ChatResponseAuditInjector.set(mode);

/** Reset the Mode 1 audit-failure mode to 'normal'. */
export const resetMode1AuditFailure = (): void => mode1ChatResponseAuditInjector.reset();

/**
 * Consume the Mode 1 audit-failure mode (if any) and throw
 * `AuditInjectedFailure` with `emitterName ===
 * 'emitMode1ChatResponseAudit'`. Called from the vi.mock factory
 * wrapping `emitMode1ChatResponseAudit`.
 */
export const consumeMode1AuditFailureOrThrow = (): void =>
  mode1ChatResponseAuditInjector.consumeOrThrow();

// Mode1AuditInjectedFailure declared above (must precede the injector
// instantiation that passes it via errorCtor). Re-exporting nothing
// here intentionally — the class is already exported from its
// declaration site.
