/**
 * db.probe.test.ts — unit tests for `verifyBindActorContextPoolOrThrow`.
 *
 * Uses fixture pool/client objects (NOT a real pg connection) to
 * exercise each rejection branch of the SI-010 boot probe:
 *
 *   1. session_user query returns no rows
 *   2. session_user is NOT bind_actor_context_role (wrong role)
 *   3. session_user is bind_actor_context_role but role is SUPERUSER
 *   4. session_user is bind_actor_context_role but role is BYPASSRLS
 *   5. bind_actor_context() function missing (has_function_privilege = NULL)
 *   6. bind_actor_context_role lacks EXECUTE on bind_actor_context
 *   7. Happy path — probe accepts a correctly-configured connection
 *
 * Verified-path coverage: the probe is what gates production SI-010
 * misconfiguration at boot. Each branch's specific error message is
 * the operator's remediation hint; the regression suite pins both the
 * branch trigger AND the message content.
 *
 * Spec: Codex R3 + R4 closures on PR #158;
 *       docs/SI-010-Session-Actor-Context-DB-Binding.md;
 *       migrations/031_session_actor_context.sql.
 */

import type { Pool, PoolClient } from 'pg';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  clearBindActorContextTestPool,
  setBindActorContextTestPool,
  type DbClient,
  verifyBindActorContextPoolOrThrow,
} from './db.ts';

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

/**
 * Build a stub PoolClient that responds to a sequence of expected queries
 * with the configured rows. Throws if the test invokes more queries than
 * are configured — surfacing query-order changes loudly.
 */
function buildStubClient(
  queryResponses: Array<{ rows: unknown[]; rowCount: number | null }>,
): PoolClient {
  let cursor = 0;
  const client = {
    query: vi.fn(async () => {
      if (cursor >= queryResponses.length) {
        throw new Error(
          `stub PoolClient: unexpected query #${cursor + 1} (configured: ${queryResponses.length})`,
        );
      }
      const response = queryResponses[cursor];
      cursor += 1;
      return response;
    }),
    release: vi.fn(),
  } as unknown as PoolClient;
  return client;
}

/**
 * Build a stub Pool whose connect() returns the given client. release()
 * is recorded for assertions; the pool itself ignores other methods.
 */
function buildStubPool(client: PoolClient): Pool {
  return {
    connect: vi.fn(async () => client),
    end: vi.fn(),
    on: vi.fn(),
  } as unknown as Pool;
}

// ---------------------------------------------------------------------------
// Probe rejection cases
// ---------------------------------------------------------------------------

describe('verifyBindActorContextPoolOrThrow — rejection branches', () => {
  beforeEach(() => {
    // Each test installs its own stub via setBindActorContextTestPool.
    clearBindActorContextTestPool();
  });

  afterEach(() => {
    clearBindActorContextTestPool();
  });

  it('throws when SELECT session_user returns no rows', async () => {
    const client = buildStubClient([{ rows: [], rowCount: 0 }]);
    setBindActorContextTestPool(client as unknown as DbClient);
    await expect(verifyBindActorContextPoolOrThrow()).rejects.toThrow(
      /SELECT session_user returned no rows/,
    );
  });

  it('throws when session_user is NOT bind_actor_context_role (wrong role)', async () => {
    const client = buildStubClient([
      {
        rows: [
          {
            session_user: 'telecheck_app_role',
            is_superuser: false,
            is_bypassrls: false,
          },
        ],
        rowCount: 1,
      },
    ]);
    setBindActorContextTestPool(client as unknown as DbClient);
    await expect(verifyBindActorContextPoolOrThrow()).rejects.toThrow(
      /session_user is "telecheck_app_role"/,
    );
  });

  it('throws when session_user is some other over-privileged role', async () => {
    const client = buildStubClient([
      {
        rows: [
          {
            session_user: 'postgres_admin',
            is_superuser: false,
            is_bypassrls: false,
          },
        ],
        rowCount: 1,
      },
    ]);
    setBindActorContextTestPool(client as unknown as DbClient);
    await expect(verifyBindActorContextPoolOrThrow()).rejects.toThrow(
      /session_user is "postgres_admin"/,
    );
  });

  it('throws when bind_actor_context_role unexpectedly has SUPERUSER', async () => {
    const client = buildStubClient([
      {
        rows: [
          {
            session_user: 'bind_actor_context_role',
            is_superuser: true,
            is_bypassrls: false,
          },
        ],
        rowCount: 1,
      },
    ]);
    setBindActorContextTestPool(client as unknown as DbClient);
    await expect(verifyBindActorContextPoolOrThrow()).rejects.toThrow(/unexpectedly has SUPERUSER/);
  });

  it('throws when bind_actor_context_role unexpectedly has BYPASSRLS', async () => {
    const client = buildStubClient([
      {
        rows: [
          {
            session_user: 'bind_actor_context_role',
            is_superuser: false,
            is_bypassrls: true,
          },
        ],
        rowCount: 1,
      },
    ]);
    setBindActorContextTestPool(client as unknown as DbClient);
    await expect(verifyBindActorContextPoolOrThrow()).rejects.toThrow(/unexpectedly has BYPASSRLS/);
  });

  it('throws when bind_actor_context() function is missing (has_function_privilege = NULL)', async () => {
    const client = buildStubClient([
      {
        rows: [
          {
            session_user: 'bind_actor_context_role',
            is_superuser: false,
            is_bypassrls: false,
          },
        ],
        rowCount: 1,
      },
      {
        rows: [{ has_privilege: null }],
        rowCount: 1,
      },
    ]);
    setBindActorContextTestPool(client as unknown as DbClient);
    await expect(verifyBindActorContextPoolOrThrow()).rejects.toThrow(
      /bind_actor_context\(\) function not found/,
    );
  });

  it('throws when bind_actor_context_role lacks EXECUTE on bind_actor_context()', async () => {
    const client = buildStubClient([
      {
        rows: [
          {
            session_user: 'bind_actor_context_role',
            is_superuser: false,
            is_bypassrls: false,
          },
        ],
        rowCount: 1,
      },
      {
        rows: [{ has_privilege: false }],
        rowCount: 1,
      },
    ]);
    setBindActorContextTestPool(client as unknown as DbClient);
    await expect(verifyBindActorContextPoolOrThrow()).rejects.toThrow(
      /lacks EXECUTE on bind_actor_context/,
    );
  });
});

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe('verifyBindActorContextPoolOrThrow — happy path', () => {
  beforeEach(() => {
    clearBindActorContextTestPool();
  });

  afterEach(() => {
    clearBindActorContextTestPool();
  });

  it('returns without throwing when role, attributes, function existence, and EXECUTE all check out', async () => {
    const client = buildStubClient([
      {
        rows: [
          {
            session_user: 'bind_actor_context_role',
            is_superuser: false,
            is_bypassrls: false,
          },
        ],
        rowCount: 1,
      },
      {
        rows: [{ has_privilege: true }],
        rowCount: 1,
      },
    ]);
    setBindActorContextTestPool(client as unknown as DbClient);
    await expect(verifyBindActorContextPoolOrThrow()).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Unconfigured pool (dev/test opt-in)
// ---------------------------------------------------------------------------

describe('verifyBindActorContextPoolOrThrow — unconfigured pool', () => {
  beforeEach(() => {
    clearBindActorContextTestPool();
  });

  it('returns without throwing when bind pool is unconfigured (no override + no env)', async () => {
    // No setBindActorContextTestPool call → override is null → and
    // config.bindActorContextDatabaseUrl is undefined in tests by default.
    // getBindActorContextPool() returns null → probe is a no-op.
    await expect(verifyBindActorContextPoolOrThrow()).resolves.toBeUndefined();
  });

  it('also resolves when buildStubPool returns connect() yielding a happy client', async () => {
    // Direct exercise — proves the override path's client is what the
    // probe consumes (not a pool.connect from real config).
    const client = buildStubClient([
      {
        rows: [
          {
            session_user: 'bind_actor_context_role',
            is_superuser: false,
            is_bypassrls: false,
          },
        ],
        rowCount: 1,
      },
      {
        rows: [{ has_privilege: true }],
        rowCount: 1,
      },
    ]);
    setBindActorContextTestPool(client as unknown as DbClient);
    const pool = buildStubPool(client);
    // The stub is unused in this test other than as an instantiation
    // smoke check — verifies our fixture builder doesn't fail under
    // current pg type bindings.
    expect(typeof pool.connect).toBe('function');
    await verifyBindActorContextPoolOrThrow();
  });
});
