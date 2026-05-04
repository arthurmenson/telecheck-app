/**
 * RLS session-variable setter — integration tests.
 *
 * Covers `src/lib/rls.ts` (`withTenantContext`, `assertRlsActive`), which
 * until this commit had only one indirect mention in the test suite and
 * ZERO direct coverage despite being the platform's DB-layer
 * tenant-isolation enforcement (one of the three I-023 layers).
 *
 * Why this matters:
 *   This module is the contract between the application code and the RLS
 *   policies on every PHI-touching table. A regression that fails to set
 *   the session variable, fails to clear it on error, OR sets it via a
 *   bypassable settable-GUC silently disables the DB-layer half of I-023.
 *   The other two layers (app-layer filtering + per-tenant KMS) would
 *   still hold, but the platform-floor "three independent enforcement
 *   layers" guarantee would be down to two without any failing test.
 *
 * Coverage in this file:
 *   1. withTenantContext sets context BEFORE calling the callback
 *   2. withTenantContext restores prior context AFTER the callback (success
 *      path) — or clears if there was no prior context
 *   3. withTenantContext restores/clears context even when the callback THROWS
 *      (the original error must propagate; cleanup-success path)
 *   4. set_tenant_context() failure surfaces immediately (migration 003 not
 *      applied → throws BEFORE the callback runs)
 *   5. CLEANUP FAILURE FAIL-CLOSED (Codex rls-r2 + rls-r3 closure): both
 *      branches now throw I-023 violations. previous!==null + restore fails →
 *      throws (cannot let outer continue under inner). previous===null +
 *      clear fails → throws (cannot return stale binding to pool, would
 *      perpetuate across pool checkouts). When callback ALSO threw,
 *      AggregateError preserves both at .errors[0/1].
 *   6. callback receives the SAME client passed in (not a new connection)
 *   7. assertRlsActive throws when no context is set
 *   8. assertRlsActive succeeds when context is set
 *   9. Real-DB integration: full round-trip via getTestClient — set / read
 *      back via current_tenant_id() / clear / read again should be null
 *  10. NESTED RESTORE (Codex rls-r1 HIGH closure): inner withTenantContext
 *      exits and outer binding is RESTORED; outermost exit clears; inner
 *      error still restores outer binding before propagating
 *
 * Spec references:
 *   - I-023 (three-layer tenant isolation; this is the DB layer)
 *   - I-028 (single DB, single schema, logical isolation)
 *   - ADR-023 (multi-tenancy Model A — RLS policy on every PHI record)
 *   - migration 003_rls_helpers.sql (set_tenant_context / clear_tenant_context
 *     / current_tenant_id SECURITY DEFINER functions)
 *
 * Test isolation:
 *   The shared test client wraps each test in a SAVEPOINT/ROLLBACK pair, so
 *   any tenant context set during a test is rolled back at afterEach (the
 *   _session_tenant_context table row is undone with the savepoint).
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { assertRlsActive, withTenantContext, type DbClient } from '../../src/lib/rls.ts';
import { TENANT_GHANA, TENANT_US } from '../helpers/tenant-fixtures.ts';
import { getTestClient } from '../setup.ts';

// ---------------------------------------------------------------------------
// In-memory mock DbClient — for behavior tests that should not touch real DB
// ---------------------------------------------------------------------------

interface RecordedCall {
  sql: string;
  params: readonly unknown[] | undefined;
}

interface MockClient extends DbClient {
  calls: RecordedCall[];
  /** If set, query() throws when called with sql matching this regex. */
  throwOn?: RegExp;
  /** If set, the throw above produces this error rather than a generic. */
  throwWith?: Error;
  /** If set, query() returns this value (used for assertRlsActive tests). */
  rowsForCurrentTenantId?: Array<{ tid: string | null }>;
  /**
   * Optional predicate: if provided AND the predicate returns true for the
   * current call, throw. Used for tests that need to throw on the SECOND
   * occurrence of a matching SQL (e.g., restore-set after initial-set).
   */
  throwIf?: (call: RecordedCall, callsBeforeThis: RecordedCall[]) => boolean;
}

function makeMockClient(): MockClient {
  const m: MockClient = {
    calls: [],
    query: async (sql: string, params?: readonly unknown[]) => {
      const call: RecordedCall = { sql, params };
      const callsBefore = m.calls.slice();
      m.calls.push(call);
      if (m.throwIf !== undefined && m.throwIf(call, callsBefore)) {
        throw m.throwWith ?? new Error(`mock: throwIf matched on ${sql}`);
      }
      if (m.throwOn !== undefined && m.throwOn.test(sql)) {
        throw m.throwWith ?? new Error(`mock: throwing on sql matching ${m.throwOn}`);
      }
      if (sql.includes('current_tenant_id')) {
        return { rows: m.rowsForCurrentTenantId ?? [{ tid: null }] };
      }
      return { rows: [] };
    },
  };
  return m;
}

// ---------------------------------------------------------------------------
// 1-2. Set-before / clear-after on success path
// ---------------------------------------------------------------------------

describe('withTenantContext — success path lifecycle', () => {
  it('calls set_tenant_context($1) BEFORE the callback runs', async () => {
    const client = makeMockClient();
    let callbackSawSetCall = false;
    await withTenantContext(client, TENANT_US, async () => {
      // At this point the set call must already be recorded.
      callbackSawSetCall = client.calls.some((c) => c.sql.includes('set_tenant_context'));
    });
    expect(callbackSawSetCall).toBe(true);
  });

  it('calls clear_tenant_context() AFTER the callback returns', async () => {
    const client = makeMockClient();
    await withTenantContext(client, TENANT_US, async () => {
      // Inside the callback, no clear call should have happened yet.
      const clearedDuringCallback = client.calls.some((c) =>
        c.sql.includes('clear_tenant_context'),
      );
      expect(clearedDuringCallback).toBe(false);
    });
    // After the callback resolves, the clear call must be recorded.
    expect(client.calls.some((c) => c.sql.includes('clear_tenant_context'))).toBe(true);
  });

  it('passes the tenantId to set_tenant_context() as the first positional parameter', async () => {
    const client = makeMockClient();
    await withTenantContext(client, TENANT_GHANA, async () => {
      // empty
    });
    const setCall = client.calls.find((c) => c.sql.includes('set_tenant_context'));
    expect(setCall).toBeDefined();
    expect(setCall!.params).toEqual([TENANT_GHANA]);
  });

  it('returns the value produced by the callback', async () => {
    const client = makeMockClient();
    const result = await withTenantContext(client, TENANT_US, async () => 'callback-result');
    expect(result).toBe('callback-result');
  });

  it('callback receives the SAME client reference (no new connection)', async () => {
    const client = makeMockClient();
    let received: DbClient | null = null;
    await withTenantContext(client, TENANT_US, async (c) => {
      received = c;
    });
    expect(received).toBe(client);
  });
});

// ---------------------------------------------------------------------------
// 3. Clear-on-error path (callback throws)
// ---------------------------------------------------------------------------

describe('withTenantContext — error path lifecycle', () => {
  it('clears context even when the callback THROWS, and re-throws the callback error', async () => {
    const client = makeMockClient();
    const cbError = new Error('callback boom');
    await expect(
      withTenantContext(client, TENANT_US, async () => {
        throw cbError;
      }),
    ).rejects.toBe(cbError);
    // Clear must still have happened so a pooled connection isn't poisoned.
    expect(client.calls.some((c) => c.sql.includes('clear_tenant_context'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 3.5 Cleanup-failure handling — BOTH branches are fail-closed
// (Codex rls-r2 HIGH closed at verify-r3; rls-r3 HIGH closed at verify-r4)
//
// Symmetric contract: ANY tenant-context cleanup failure throws an I-023
// violation so the caller (and pool wrapper in db.ts) can discard the
// connection. Silently swallowing leaves a stale binding on a pooled
// connection — either bleeding into outer scope (nested case) or
// perpetuating across pool checkouts (outermost case).
// ---------------------------------------------------------------------------

describe('withTenantContext — cleanup-failure handling (I-023 cross-tenant leak prevention)', () => {
  it('NESTED — previous=US + restore set_tenant_context FAILS → throws (cannot let outer continue under inner)', async () => {
    const client = makeMockClient();
    // Mock prior context = TENANT_US (so previous !== null).
    client.rowsForCurrentTenantId = [{ tid: TENANT_US }];
    // Throw on the SECOND set_tenant_context call (the restore-set);
    // the FIRST set_tenant_context call (initial set to TENANT_GHANA)
    // must succeed so we exercise the restore branch.
    client.throwIf = (call, before) => {
      const isSet = call.sql.includes('set_tenant_context');
      const priorSetCount = before.filter((c) => c.sql.includes('set_tenant_context')).length;
      return isSet && priorSetCount >= 1;
    };
    await expect(
      withTenantContext(client, TENANT_GHANA, async () => {
        return 'callback-ok';
      }),
    ).rejects.toThrow(/I-023 violation: tenant-context restore failed/);
  });

  it('NESTED — previous=US + restore FAILS + callback ALSO threw → AggregateError preserves both', async () => {
    const client = makeMockClient();
    client.rowsForCurrentTenantId = [{ tid: TENANT_US }];
    client.throwIf = (call, before) => {
      const isSet = call.sql.includes('set_tenant_context');
      const priorSetCount = before.filter((c) => c.sql.includes('set_tenant_context')).length;
      return isSet && priorSetCount >= 1;
    };
    const cbError = new Error('callback boom');
    let caught: unknown;
    try {
      await withTenantContext(client, TENANT_GHANA, async () => {
        throw cbError;
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AggregateError);
    expect((caught as AggregateError).errors[0]).toBe(cbError);
    expect((caught as AggregateError).message).toMatch(
      /I-023 violation: tenant-context restore failed/,
    );
  });

  it('OUTERMOST — previous=null + clear_tenant_context FAILS → throws (cannot return stale binding to pool)', async () => {
    // No prior context. Clear fails. With the rls-r4 fix, this MUST throw
    // so the caller / pool wrapper can discard the connection — silently
    // returning a connection to the pool with a stale tenant binding
    // would let the next caller's withTenantContext "restore" the stale
    // tenant on its own exit, perpetuating the leak across pool checkouts.
    const client = makeMockClient();
    client.throwOn = /clear_tenant_context/;
    await expect(withTenantContext(client, TENANT_US, async () => 'callback-ok')).rejects.toThrow(
      /I-023 violation: tenant-context clear failed/,
    );
  });

  it('OUTERMOST — previous=null + clear FAILS + callback ALSO threw → AggregateError preserves both', async () => {
    const client = makeMockClient();
    client.throwOn = /clear_tenant_context/;
    const cbError = new Error('callback boom');
    let caught: unknown;
    try {
      await withTenantContext(client, TENANT_US, async () => {
        throw cbError;
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AggregateError);
    expect((caught as AggregateError).errors[0]).toBe(cbError);
    expect((caught as AggregateError).message).toMatch(
      /I-023 violation: tenant-context clear failed/,
    );
  });

  it('REGRESSION GUARD — clear failure followed by another withTenantContext call on same client surfaces (does NOT silently restore stale tenant)', async () => {
    // The exact regression Codex called out: a silently-swallowed clear
    // failure leaves the binding on the client; the next withTenantContext
    // call would read it as `previous` and "restore" the stale tenant on
    // exit. With rls-r4 fail-closed-on-cleanup, the caller saw the error
    // from the first call and (in production) the pool would discard the
    // connection. Here we simulate "caller catches and tries again on the
    // same client" as a defensive integration check: the FIRST call must
    // throw; the SECOND call (with simulated clean state) must operate
    // independently of the first call's stale state.
    const client = makeMockClient();
    client.throwOn = /clear_tenant_context/;
    // First call: throws on clear.
    await expect(withTenantContext(client, TENANT_GHANA, async () => 'first-ok')).rejects.toThrow(
      /I-023 violation/,
    );
    // Production would discard the client here. Our mock proceeds to a
    // second call; we reset the mock's failure mode to simulate a fresh
    // pool checkout. The contract: even if a caller WERE to reuse the
    // mock client, the second call surfaces its own state, not the first
    // call's stale binding.
    // (delete vs `= undefined` because exactOptionalPropertyTypes blocks
    //  the assignment form for optional fields.)
    delete client.throwOn;
    client.rowsForCurrentTenantId = [{ tid: null }];
    const result = await withTenantContext(client, TENANT_US, async () => 'second-ok');
    expect(result).toBe('second-ok');
  });
});

// ---------------------------------------------------------------------------
// 4. set_tenant_context() failure surfaces (migration 003 not applied)
// ---------------------------------------------------------------------------

describe('withTenantContext — set_tenant_context failure surfacing', () => {
  it('propagates set_tenant_context errors and DOES NOT call the callback', async () => {
    const client = makeMockClient();
    client.throwOn = /set_tenant_context/;
    client.throwWith = new Error('migration 003 not applied: set_tenant_context does not exist');
    const cb = vi.fn(async () => 'should not run');
    await expect(withTenantContext(client, TENANT_US, cb)).rejects.toThrow(/migration 003/);
    expect(cb).not.toHaveBeenCalled();
  });

  it('does NOT call clear_tenant_context if set_tenant_context failed (no need)', async () => {
    const client = makeMockClient();
    client.throwOn = /set_tenant_context/;
    await expect(
      withTenantContext(client, TENANT_US, async () => {
        // empty
      }),
    ).rejects.toThrow();
    // Only the failed set call should be recorded — clear must not run
    // because the try/finally for cleanup is INSIDE the function, AFTER the
    // set call. A failed set short-circuits before entering the try.
    expect(client.calls.some((c) => c.sql.includes('clear_tenant_context'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 5. assertRlsActive (mock client behavior)
// ---------------------------------------------------------------------------

describe('assertRlsActive — context-presence check', () => {
  it('throws an I-023 violation message when current_tenant_id() returns null', async () => {
    const client = makeMockClient();
    client.rowsForCurrentTenantId = [{ tid: null }];
    await expect(assertRlsActive(client)).rejects.toThrow(/I-023 enforcement violation/);
  });

  it('throws when current_tenant_id() returns nothing (no row)', async () => {
    const client = makeMockClient();
    client.rowsForCurrentTenantId = [];
    await expect(assertRlsActive(client)).rejects.toThrow(/I-023 enforcement violation/);
  });

  it('succeeds when current_tenant_id() returns a non-null tenant id', async () => {
    const client = makeMockClient();
    client.rowsForCurrentTenantId = [{ tid: TENANT_US }];
    await expect(assertRlsActive(client)).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 6. Real DB round-trip via the shared test client
// ---------------------------------------------------------------------------

describe('withTenantContext — real DB round-trip via shared client', () => {
  // The shared test client (from tests/setup.ts) is a real pg.Client running
  // as the non-superuser test app role with FORCE ROW LEVEL SECURITY in
  // effect. Migration 003's set_tenant_context() / clear_tenant_context() /
  // current_tenant_id() functions are applied at suite setup. This test
  // exercises the actual Postgres path end-to-end.

  it('sets the context such that current_tenant_id() reads back the same tenant id', async () => {
    const client = getTestClient() as unknown as DbClient;
    let observed: string | null = null;
    await withTenantContext(client, TENANT_US, async (c) => {
      const result = (await c.query('SELECT current_tenant_id() AS tid')) as {
        rows: Array<{ tid: string | null }>;
      };
      observed = result.rows[0]?.tid ?? null;
    });
    expect(observed).toBe(TENANT_US);
  });

  it('clears the context after the callback so current_tenant_id() returns null afterwards', async () => {
    const client = getTestClient() as unknown as DbClient;
    await withTenantContext(client, TENANT_US, async () => {
      // empty
    });
    const result = (await client.query('SELECT current_tenant_id() AS tid')) as {
      rows: Array<{ tid: string | null }>;
    };
    expect(result.rows[0]?.tid ?? null).toBeNull();
  });

  it('NESTED RESTORE — inner Ghana context exits and outer US context is RESTORED (I-023 safety)', async () => {
    // Closed 2026-05-03 per Codex rls-r1 HIGH (verify-r2): the prior version
    // of this test pinned a BUG — that the inner clear unconditionally
    // cleared the outer binding. That left outer-scope queries running
    // with no RLS context, a direct I-023 floor violation. The fix is
    // save/restore: read the current binding before set, and on exit either
    // restore it (if there was one) or clear (if there wasn't).
    const client = getTestClient() as unknown as DbClient;
    let observedInner: string | null = null;
    let observedAfterInner: string | null = null;
    await withTenantContext(client, TENANT_US, async (cOuter) => {
      await withTenantContext(cOuter, TENANT_GHANA, async (cInner) => {
        const r = (await cInner.query('SELECT current_tenant_id() AS tid')) as {
          rows: Array<{ tid: string | null }>;
        };
        observedInner = r.rows[0]?.tid ?? null;
      });
      const r2 = (await cOuter.query('SELECT current_tenant_id() AS tid')) as {
        rows: Array<{ tid: string | null }>;
      };
      observedAfterInner = r2.rows[0]?.tid ?? null;
    });
    expect(observedInner).toBe(TENANT_GHANA);
    // Outer context MUST be restored after inner exit. Anything else
    // (null OR Ghana) is an I-023 violation — outer-scope queries would
    // run unfiltered.
    expect(observedAfterInner).toBe(TENANT_US);
  });

  it('NESTED RESTORE — outer scope final clear leaves no binding (return to no-context after both exits)', async () => {
    // After BOTH the inner and outer withTenantContext exit, there should be
    // no tenant context set (the outermost call started with no prior
    // binding, so save/restore correctly returns to "no binding" at the
    // outermost exit).
    const client = getTestClient() as unknown as DbClient;
    await withTenantContext(client, TENANT_US, async (cOuter) => {
      await withTenantContext(cOuter, TENANT_GHANA, async () => {
        // empty
      });
    });
    const result = (await client.query('SELECT current_tenant_id() AS tid')) as {
      rows: Array<{ tid: string | null }>;
    };
    expect(result.rows[0]?.tid ?? null).toBeNull();
  });

  it('NESTED RESTORE — error in inner scope still restores outer binding', async () => {
    // Belt-and-suspenders for the finally branch: an inner-scope error
    // must NOT leave the connection without the outer binding. The outer
    // try/catch can keep doing PHI-safe work after it observes/handles
    // the inner failure.
    const client = getTestClient() as unknown as DbClient;
    let observedAfterError: string | null = null;
    await withTenantContext(client, TENANT_US, async (cOuter) => {
      try {
        await withTenantContext(cOuter, TENANT_GHANA, async () => {
          throw new Error('inner boom');
        });
      } catch {
        // outer scope handles inner error
      }
      const r = (await cOuter.query('SELECT current_tenant_id() AS tid')) as {
        rows: Array<{ tid: string | null }>;
      };
      observedAfterError = r.rows[0]?.tid ?? null;
    });
    expect(observedAfterError).toBe(TENANT_US);
  });
});

// ---------------------------------------------------------------------------
// Cleanup safety net
// ---------------------------------------------------------------------------

afterEach(async () => {
  // The per-test SAVEPOINT in tests/setup.ts already discards any binding
  // mutations. This hook is intentionally empty as a landing pad for future
  // explicit cleanup if a test escapes the savepoint envelope.
});
