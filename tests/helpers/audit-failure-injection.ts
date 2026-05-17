/**
 * audit-failure-injection.ts — generic, per-emitter audit-failure
 * injection harness factory.
 *
 * Generalizes the PR #163 Mode 1 chat audit-injection pattern
 * (tests/helpers/mode-1-chat-audit-injection.ts) into a reusable
 * factory so future handlers that combine an operational audit
 * (FLOOR-020 / Category C) with a safety-floor audit (I-019 /
 * Category A — or any other floor-class emission) can exercise the
 * "audit fails → cache rolls back → retry with same Idempotency-Key
 * uses deterministic IDs → only ONE floor-class audit row across
 * both attempts" round-trip invariant without copy-pasting the
 * harness for every emitter.
 *
 * Design — closure-per-emitter:
 *
 *   Each call to createAuditFailureInjector() returns an INDEPENDENT
 *   injector with its own mode state. This guarantees that:
 *
 *     1. Two emitters mocked in the same test file (e.g., the
 *        forthcoming Mode 1 Category B `crisis.escalation_destination_resolved`
 *        emitter from SI-013 alongside the existing Mode 1 Category C
 *        `emitMode1ChatResponseAudit`) do not share failure state.
 *        Setting fail-once on injector A does not consume itself when
 *        injector B's emitter fires — a property the previous shared-
 *        module-state design could not provide.
 *
 *     2. Test files for different handlers cannot accidentally bleed
 *        state across each other. Each test file creates the
 *        injectors it needs and resets them in beforeEach / afterEach.
 *
 *     3. A single emitter can be exercised under multiple distinct
 *        failure modes within one test file by creating multiple
 *        injectors for different scenarios — but the vi.mock factory
 *        determines which injector its stub consults, so this is an
 *        advanced pattern; the common case is one injector per
 *        emitter per test file.
 *
 * Usage from a test file:
 *
 *     // tests/helpers/mode-1-chat-audit-injection.ts (one example)
 *     import { createAuditFailureInjector } from './audit-failure-injection.ts';
 *     export const mode1ChatResponseAuditInjector =
 *       createAuditFailureInjector('emitMode1ChatResponseAudit');
 *
 *     // tests/integration/<handler>.test.ts
 *     import { mode1ChatResponseAuditInjector } from '../helpers/mode-1-chat-audit-injection.ts';
 *
 *     vi.mock('../../src/modules/ai-service/audit.ts', async () => {
 *       const actual = await vi.importActual<...>(...);
 *       return {
 *         ...actual,
 *         emitMode1ChatResponseAudit: async (args, tx) => {
 *           mode1ChatResponseAuditInjector.consumeOrThrow();
 *           return actual.emitMode1ChatResponseAudit(args, tx);
 *         },
 *       };
 *     });
 *
 *     beforeEach(() => mode1ChatResponseAuditInjector.reset());
 *     afterEach(() => mode1ChatResponseAuditInjector.reset());
 *
 *     it('fail-always → 503', async () => {
 *       mode1ChatResponseAuditInjector.set('fail-always');
 *       // ... POST /v0/ai/chat → expect 503 ...
 *     });
 *
 * Spec references:
 *   - PR #163 (closed) — Mode 1 audit-failure injection harness
 *     (single-emitter implementation this module generalizes)
 *   - PR #160 Codex R4 H1 closure (deterministic ID derivation)
 *   - PR #162 Codex R1 H1 finding (deferred round-trip test)
 *   - SI-013 / PR #164 (CCR crisis-helpline keys) — adds the
 *     Mode 1 Category B `crisis.escalation_destination_resolved`
 *     emitter; downstream impl will need an injector for it to test
 *     the fail-soft policy (Rule 4 / Codex R5 H1 closure)
 *   - AI_LAYERING v5.2 §6 (FLOOR-020 audit envelope)
 *   - I-003 (audit append-only) / I-019 (crisis detection floor) /
 *     I-027 (audit attribution)
 */

/**
 * Failure modes for an audit emitter under injection.
 *
 *   'normal'      — the real emitter runs (default; reset at the
 *                   start of each test).
 *   'fail-once'   — the next invocation throws an
 *                   AuditInjectedFailure; subsequent invocations
 *                   revert to 'normal'. Useful for round-trip
 *                   retry tests where attempt 1 must fail and
 *                   attempt 2 must succeed.
 *   'fail-always' — every invocation throws. Useful for asserting
 *                   the handler's tenant-blind error response shape
 *                   under sustained audit-emitter unavailability.
 */
export type AuditFailureMode = 'normal' | 'fail-once' | 'fail-always';

/**
 * Sentinel error thrown when an injected failure fires. The
 * `emitterName` field identifies which emitter's injection point
 * tripped, so assertions in the handler-under-test can verify the
 * RIGHT emitter failed (important when a single test exercises
 * multiple injectors for different emitters).
 */
export class AuditInjectedFailure extends Error {
  readonly emitterName: string;

  constructor(emitterName: string, message?: string) {
    super(message ?? `test: ${emitterName} forced failure (audit-injection harness)`);
    this.name = 'AuditInjectedFailure';
    this.emitterName = emitterName;
  }
}

/**
 * The injector handle returned by createAuditFailureInjector. All
 * methods operate on the injector's OWN closed-over mode state —
 * sibling injectors are independent.
 */
export interface AuditFailureInjector {
  /** The emitter name this injector is bound to (for diagnostics + the sentinel error's `emitterName`). */
  readonly emitterName: string;

  /**
   * Read the current failure-injection mode. Useful for asserting
   * state transitions (e.g., that a 'fail-once' mode self-reset to
   * 'normal' after consuming itself).
   */
  get(): AuditFailureMode;

  /**
   * Set the failure-injection mode. Called from a test before
   * issuing the request that should trip the failure path.
   */
  set(mode: AuditFailureMode): void;

  /**
   * Reset to 'normal' mode. Tests MUST call this in beforeEach +
   * afterEach to prevent mode bleed across test cases — 'fail-once'
   * is self-resetting on consumption, but 'fail-always' is not, and
   * any test that fails partway through (assertion error before the
   * emitter fired) could leave the mode in a non-normal state.
   */
  reset(): void;

  /**
   * Consume the failure mode (if any) and throw the sentinel error.
   * Called by the vi.mock factory's emitter stub BEFORE delegating
   * to the real implementation:
   *
   *     vi.mock('.../audit.ts', async () => {
   *       const actual = await vi.importActual<...>(...);
   *       return {
   *         ...actual,
   *         emitFoo: async (args, tx) => {
   *           fooInjector.consumeOrThrow();
   *           return actual.emitFoo(args, tx);
   *         },
   *       };
   *     });
   *
   * Behavior:
   *   - 'normal'      → no-op (delegates to real emitter)
   *   - 'fail-once'   → mode flips to 'normal' THEN throws
   *   - 'fail-always' → throws (mode unchanged)
   *
   * The fail-once self-reset happens BEFORE the throw so an unwound
   * call stack cannot leave a 'consuming' intermediate state visible
   * to a sibling assertion.
   */
  consumeOrThrow(): void;
}

/**
 * Optional constructor for a sentinel-error subclass. When provided,
 * `consumeOrThrow` instantiates this subclass instead of the default
 * `AuditInjectedFailure`. The subclass MUST extend `AuditInjectedFailure`
 * (so `instanceof AuditInjectedFailure` still holds for callers
 * matching the generic base type) and MUST accept an `emitterName`
 * constructor argument.
 *
 * Use case: a per-emitter wrapper that wants to preserve a legacy
 * `instanceof MyEmitterAuditInjectedFailure` API while still
 * benefiting from the generic factory's state isolation. Mode 1's
 * `Mode1AuditInjectedFailure` is the canonical example (Codex R1
 * closure on PR #165) — the wrapper passes the subclass constructor
 * here so the consume path throws the subclass, not the generic base.
 *
 * Signature: `(emitterName: string) => AuditInjectedFailure`. The
 * subclass's own constructor may accept additional optional
 * arguments (e.g., a custom message) but the factory only passes
 * the emitter name.
 */
export type AuditInjectedFailureCtor = new (emitterName: string) => AuditInjectedFailure;

/**
 * Options for createAuditFailureInjector. Optional — passing no
 * options yields an injector that throws the generic
 * `AuditInjectedFailure` base class.
 */
export interface CreateAuditFailureInjectorOptions {
  /**
   * Custom sentinel-error constructor (Codex R1 closure on PR #165).
   * Passed only the emitter name. When omitted, `consumeOrThrow`
   * throws `AuditInjectedFailure` directly.
   *
   * The constructor SHOULD extend `AuditInjectedFailure` so the
   * `instanceof AuditInjectedFailure` guard in multi-injector test
   * setups continues to work for callers that don't care about the
   * subclass. The factory does not enforce this at construction
   * time (TypeScript's typing on the parameter already does), but
   * a custom error class that breaks the `AuditInjectedFailure`
   * inheritance chain will surprise downstream consumers.
   */
  errorCtor?: AuditInjectedFailureCtor;
}

/**
 * Construct an independent audit-failure injector bound to the
 * given emitter name. Each call returns a fresh injector with its
 * own mode state (no shared module-level globals across injectors).
 *
 * The injector is intended to be instantiated once at module load
 * time in a per-emitter helper file (e.g.,
 * `tests/helpers/mode-1-chat-audit-injection.ts`) and consumed from
 * both the test file (set / reset / get) and the corresponding
 * vi.mock factory (consumeOrThrow).
 *
 * By default `consumeOrThrow` instantiates `AuditInjectedFailure`,
 * which records the emitter name on every sentinel error so multi-
 * injector test setups can disambiguate which emitter failed
 * (`err.emitterName === 'emitFoo'`).
 *
 * If a wrapper needs to preserve a legacy `instanceof
 * SubclassAuditInjectedFailure` API (Mode 1's
 * `Mode1AuditInjectedFailure` is the canonical example from
 * PR #165 Codex R1 closure), pass `options.errorCtor` and the
 * consume path will instantiate that subclass instead.
 */
export function createAuditFailureInjector(
  emitterName: string,
  options: CreateAuditFailureInjectorOptions = {},
): AuditFailureInjector {
  if (typeof emitterName !== 'string' || emitterName.length === 0) {
    throw new Error(
      'createAuditFailureInjector: emitterName must be a non-empty string (used for AuditInjectedFailure.emitterName + diagnostics)',
    );
  }

  const { errorCtor } = options;
  let mode: AuditFailureMode = 'normal';

  const newSentinel = (): AuditInjectedFailure =>
    errorCtor ? new errorCtor(emitterName) : new AuditInjectedFailure(emitterName);

  return {
    emitterName,
    get: () => mode,
    set: (next: AuditFailureMode) => {
      mode = next;
    },
    reset: () => {
      mode = 'normal';
    },
    consumeOrThrow: () => {
      if (mode === 'fail-once') {
        // Self-reset BEFORE throwing so a retry that arrives before
        // the test's catch block can run sees the 'normal' mode.
        mode = 'normal';
        throw newSentinel();
      }
      if (mode === 'fail-always') {
        throw newSentinel();
      }
      // 'normal' — caller delegates to the real emitter.
    },
  };
}
