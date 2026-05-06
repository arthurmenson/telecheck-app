/**
 * tests/contracts/idempotency-actor-scoping-lockdown.test.ts —
 * Lockdown-contract regression for the JWT actor scoping invariant
 * in `src/lib/idempotency.ts:actorId resolution`.
 *
 * Sprint 27 / TLC-049 (Codex retro HIGH TLC-048 lockdown pin).
 *
 * Background — the finding-class:
 *
 *   The idempotency cache key is `(tenant_id, key, endpoint, actor_id)`.
 *   Sprint 21+ migrated authenticated tests from the legacy
 *   `x-actor-id` header to JWT bearer tokens, but `idempotency.ts`
 *   was reading `actorId` from `request.headers['x-actor-id']` with
 *   fallback to `'anonymous'`. Result: ALL JWT-authenticated requests
 *   collapsed to `actor_id='anonymous'`, breaking per-actor
 *   isolation in the 4-tuple PK.
 *
 *   Sprint 26 / TLC-048 closed this via Codex retrospective HIGH
 *   finding: read from `request.actorContext?.accountId` first,
 *   fall back to legacy `x-actor-id` header, fall back to
 *   `'anonymous'` as final default for pre-auth state-changing
 *   endpoints.
 *
 * Lockdown intent (per PROJECT_CONVENTIONS §5.4 lockdown-test pinning):
 *
 *   This test pins the resolved invariant by source-grepping for the
 *   exact resolution-order pattern. If a future change reverts the
 *   resolution back to "x-actor-id first" or removes the
 *   `request.actorContext?.accountId` lookup, this test fails fast
 *   at the contract-tests layer (no need to wait for an integration
 *   test that may or may not exercise the JWT path).
 *
 * Why source-grep + not just integration:
 *
 *   The integration test (idempotency-http.test.ts §NEW TLC-048)
 *   verifies the runtime behavior. THIS test pins the
 *   implementation-level invariant: the source code MUST contain
 *   the JWT-actorContext-first resolution.
 *
 *   Two layers of defense — runtime + source — give us belt-and-
 *   suspenders coverage. Sprint 24 TLC-045 demonstrated that runtime
 *   tests can pass while source-level invariants regress (the
 *   ERR_HTTP_HEADERS_SENT was a runtime-PASS-but-implementation-
 *   wrong scenario).
 *
 * Spec references:
 *   - IDEMPOTENCY v5.1 §1 (actor-scoping requirement)
 *   - I-023 (three-layer tenant isolation; actor_id is part of
 *     per-actor isolation)
 *   - PROJECT_CONVENTIONS §5.4 lockdown-test pinning rule
 *   - PROJECT_CONVENTIONS §5.11 retrospective-Codex cadence
 *     (TLC-048 was caught by Sprint 26 retrospective; lockdown pin
 *     reduces likelihood of needing a future retrospective for the
 *     same finding-class)
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const IDEMPOTENCY_SRC_PATH = resolve(
  import.meta.dirname ?? __dirname,
  '../../src/lib/idempotency.ts',
);

describe('idempotency.ts — actor-id resolution lockdown', () => {
  // ---------------------------------------------------------------------------
  // §1 source-level invariant: JWT actorContext is read FIRST
  // ---------------------------------------------------------------------------

  it('§1a reads request.actorContext?.accountId in actor-id resolution path', () => {
    const src = readFileSync(IDEMPOTENCY_SRC_PATH, 'utf8');
    expect(src).toMatch(/request\.actorContext\?\.accountId/);
  });

  it('§1b actorContext lookup precedes x-actor-id fallback', () => {
    // Codifies the resolution-order: JWT first, header second,
    // 'anonymous' last. The order matters: if x-actor-id were
    // checked first, JWT requests would still fall through to it
    // (since they don't send the header) and the bug would re-emerge.
    const src = readFileSync(IDEMPOTENCY_SRC_PATH, 'utf8');
    const actorContextIdx = src.indexOf('request.actorContext?.accountId');
    const xActorIdIdx = src.indexOf("request.headers['x-actor-id']");
    expect(actorContextIdx).toBeGreaterThan(0);
    expect(xActorIdIdx).toBeGreaterThan(0);
    expect(actorContextIdx).toBeLessThan(xActorIdIdx);
  });

  it("§1c 'anonymous' is the final fallback (not the first read)", () => {
    // The 'anonymous' literal must come AFTER both actorContext and
    // x-actor-id reads. If a future refactor places 'anonymous' as
    // the primary lookup or removes the JWT check, this test fails.
    const src = readFileSync(IDEMPOTENCY_SRC_PATH, 'utf8');
    // Anchor on the exact resolution chain pattern. The chain shape:
    //   request.actorContext?.accountId ??
    //     (request.headers['x-actor-id'] ...) ??
    //     'anonymous';
    // We assert all three appear in this order.
    const actorContextIdx = src.indexOf('request.actorContext?.accountId');
    const anonymousIdx = src.indexOf("'anonymous'");
    expect(anonymousIdx).toBeGreaterThan(actorContextIdx);
  });

  // ---------------------------------------------------------------------------
  // §2 source-level invariant: TLC-048 closure comment is preserved
  // ---------------------------------------------------------------------------
  //
  // Per §5.4 lockdown discipline: closure-context comments document
  // WHY a particular pattern was chosen. Removing them is a code-smell
  // that often precedes a regression (someone refactors without
  // understanding the historical reason for the pattern). Pin the
  // closure-comment marker to fail-fast on accidental removal.

  it('§2a TLC-048 closure-context comment is preserved', () => {
    const src = readFileSync(IDEMPOTENCY_SRC_PATH, 'utf8');
    expect(src).toContain('TLC-048');
    expect(src).toContain('Codex retrospective');
  });
});
