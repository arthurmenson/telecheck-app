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
 *   2. withTenantContext clears context AFTER the callback (success path)
 *   3. withTenantContext clears context even when the callback THROWS
 *      (the original error must propagate; clear-failure must not mask it)
 *   4. set_tenant_context() failure surfaces immediately (migration 003 not
 *      applied → throws BEFORE the callback runs)
 *   5. clear_tenant_context() failure is intentionally swallowed (monitoring
 *      concern; original callback error wins)
 *   6. callback receives the SAME client passed in (not a new connection)
 *   7. assertRlsActive throws when no context is set
 *   8. assertRlsActive succeeds when context is set
 *   9. Real-DB integration: full round-trip via getTestClient — set / read
 *      back via current_tenant_id() / clear / read again should be null
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
}

function makeMockClient(): MockClient {
  const m: MockClient = {
    calls: [],
    query: async (sql: string, params?: readonly unknown[]) => {
      m.calls.push({ sql, params });
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

  it('clear_tenant_context failure is SWALLOWED (callback success result still returns)', async () => {
    const client = makeMockClient();
    client.throwOn = /clear_tenant_context/;
    // The callback succeeds; the clear fails. The wrapper should NOT
    // propagate the clear failure — that would mask perfectly fine
    // application work and turn ops noise into a 500.
    const result = await withTenantContext(client, TENANT_US, async () => 'ok');
    expect(result).toBe('ok');
  });

  it('clear_tenant_context failure does NOT mask the callback error (callback error wins)', async () => {
    // If both the callback AND the clear fail, the original callback error
    // is what surfaces — the clear-failure is monitoring-only.
    const client = makeMockClient();
    client.throwOn = /clear_tenant_context/;
    const cbError = new Error('callback fatal');
    let caught: unknown;
    try {
      await withTenantContext(client, TENANT_US, async () => {
        throw cbError;
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBe(cbError);
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

  it('switches context atomically — Ghana context inside a US-context callback is fully replaced', async () => {
    const client = getTestClient() as unknown as DbClient;
    let observedInner: string | null = null;
    let observedAfterInner: string | null = null;
    await withTenantContext(client, TENANT_US, async (cOuter) => {
      // Nested withTenantContext for Ghana — the inner clear MUST clear the
      // outer's binding too because clear is unconditional. Pinning this
      // behavior so anyone tempted to "preserve outer context on inner clear"
      // breaks the test (the contract is: clear ALWAYS clears).
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
    // Pinning current behavior: after the inner withTenantContext exits,
    // current_tenant_id() is null (the outer's set was overwritten by the
    // inner's set, and the inner's clear cleared it). Anyone wanting nested
    // tenant contexts to behave like a stack must implement that explicitly.
    expect(observedAfterInner).toBeNull();
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
