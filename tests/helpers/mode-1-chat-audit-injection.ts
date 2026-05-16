/**
 * mode-1-chat-audit-injection.ts — test harness for forcing
 * emitMode1ChatResponseAudit to fail on demand.
 *
 * Purpose: closes the R7 finding deferred from PR #160 (Mode 1 chat
 * handler) — the round-trip "audit fails → cache rolls back → retry
 * with same Idempotency-Key uses deterministic IDs → only ONE
 * Category A crisis audit emitted across both attempts" invariant
 * cannot be exercised without an audit-emission failure injection
 * point.
 *
 * Pattern: vitest `vi.mock` factory replaces the module-level
 * `emitMode1ChatResponseAudit` binding with a stub that consults a
 * shared mutable flag (`mode1AuditFailureMode`) at call time and
 * either delegates to the real implementation or throws.
 *
 * Usage from a test file:
 *
 *     import {
 *       resetMode1AuditFailure,
 *       setMode1AuditFailure,
 *     } from '../helpers/mode-1-chat-audit-injection.ts';
 *
 *     // (the test file MUST also wire the vi.mock factory — see
 *     // tests/integration/ai-service-mode-1-chat-audit-injection.test.ts
 *     // for the canonical example.)
 *
 *     beforeEach(() => resetMode1AuditFailure());
 *
 *     it('audit failure → 503', async () => {
 *       setMode1AuditFailure('fail-always');
 *       // ... POST /v0/ai/chat → expect 503 ...
 *     });
 *
 * The shared state lives in THIS file (not the test file) so the
 * vi.mock factory and the test code can both import + mutate the
 * same module-level variable. vi.hoisted() works for narrower cases
 * but multi-mode state needs an external module the factory can
 * reference.
 *
 * Spec references:
 *   - PR #160 Codex R4 H1 closure (deterministic ID derivation)
 *   - PR #162 Codex R1 H1 finding (the deferred round-trip test)
 *   - AI_LAYERING v5.2 §6 (FLOOR-020 audit envelope) — the audit
 *     being injected is the Category C `ai_chat_response_emitted`
 *     emission, not the Category A `crisis_detection_trigger`
 *     emission (the latter has its own crisis-gate dedupe protection)
 */

/**
 * Failure modes for the Mode 1 chat response audit.
 *
 *   'normal'      — the real `emitMode1ChatResponseAudit` runs
 *                   (default; reset at the start of each test).
 *   'fail-once'   — the next invocation throws; subsequent invocations
 *                   revert to 'normal'. Useful for round-trip retry
 *                   tests where attempt 1 must fail and attempt 2 must
 *                   succeed.
 *   'fail-always' — every invocation throws. Useful for asserting
 *                   the handler's tenant-blind 503 response shape.
 */
export type Mode1AuditFailureMode = 'normal' | 'fail-once' | 'fail-always';

let mode1AuditFailureMode: Mode1AuditFailureMode = 'normal';

/**
 * Read the current failure-injection mode. Called from the vi.mock
 * factory's stub before deciding whether to throw or delegate to the
 * real implementation. Exported so the test file can also assert on
 * state transitions (e.g., assert mode === 'normal' after a fail-once
 * attempt consumed itself).
 */
export function getMode1AuditFailure(): Mode1AuditFailureMode {
  return mode1AuditFailureMode;
}

/**
 * Set the failure-injection mode. Called from a test before issuing
 * the request that should trigger the failure path.
 */
export function setMode1AuditFailure(mode: Mode1AuditFailureMode): void {
  mode1AuditFailureMode = mode;
}

/**
 * Reset to 'normal' mode. Tests MUST call this in beforeEach +
 * afterEach to prevent mode bleed across test cases — fail-once is
 * self-resetting but fail-always is not, and any test that fails
 * partway through could leave the mode in a non-normal state.
 */
export function resetMode1AuditFailure(): void {
  mode1AuditFailureMode = 'normal';
}

/**
 * The sentinel error class the stub throws when failure is injected.
 * Exported so test assertions can use `instanceof` rather than
 * brittle message-string matching.
 */
export class Mode1AuditInjectedFailure extends Error {
  constructor(message = 'test: emitMode1ChatResponseAudit forced failure') {
    super(message);
    this.name = 'Mode1AuditInjectedFailure';
  }
}

/**
 * Consume the failure mode (if any) and throw the sentinel error.
 * Used by the vi.mock factory's stub:
 *
 *     vi.mock('../../src/modules/ai-service/audit.ts', async () => {
 *       const actual = await vi.importActual<...>(...);
 *       return {
 *         ...actual,
 *         emitMode1ChatResponseAudit: async (args, tx) => {
 *           consumeMode1AuditFailureOrThrow();
 *           return actual.emitMode1ChatResponseAudit(args, tx);
 *         },
 *       };
 *     });
 *
 * Encapsulates the fail-once self-reset logic so it lives in one
 * place (not duplicated across every test file that uses the
 * harness).
 */
export function consumeMode1AuditFailureOrThrow(): void {
  if (mode1AuditFailureMode === 'fail-once') {
    mode1AuditFailureMode = 'normal';
    throw new Mode1AuditInjectedFailure();
  }
  if (mode1AuditFailureMode === 'fail-always') {
    throw new Mode1AuditInjectedFailure();
  }
}
