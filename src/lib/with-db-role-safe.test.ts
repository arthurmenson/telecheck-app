/**
 * with-db-role-safe.test.ts — unit tests for the cross-slice
 *   `withDbRole` + SQLSTATE 42501 → tenant-blind 403 mapping helper.
 *
 * Covers:
 *   §1 happy path — callback returns its value verbatim.
 *   §2 42501 mapping — both pre-callback (SET LOCAL ROLE) and inside-
 *      callback (SECDEF / RLS) raise paths produce
 *      `req.server.httpErrors.forbidden(...)`.
 *   §3 non-42501 error propagation — pg errors with other SQLSTATEs
 *      AND plain `Error` instances propagate unchanged (identity
 *      preserved, no `statusCode` injected).
 *   §4 I-025 envelope-leak defense — the 403 thrown carries the
 *      canonical generic message ('Insufficient scope for this request.')
 *      and does NOT contain any tenant identifier, role name, or
 *      SQLSTATE from the upstream PG error.
 *   §5 `isInsufficientPrivilegeError` type-guard correctness.
 *
 * The mock pattern mirrors `src/lib/with-db-role.test.ts`'s mockTx:
 * a minimal `DbClient` whose `query` records calls + supports a
 * configurable raise path.
 */

import { describe, expect, it, vi } from 'vitest';
import type { FastifyRequest } from 'fastify';

import { isInsufficientPrivilegeError, withDbRoleSafe } from './with-db-role-safe.js';
import type { DbClient } from './db.js';
import type { SliceRole } from './with-db-role.js';

// ---------------------------------------------------------------------------
// Mock tx — captures `SELECT current_user` + `SET LOCAL ROLE` shape so
// withDbRole's internal composition runs end-to-end. Provides hooks for
// (a) raising at the pre-callback SET LOCAL ROLE step (sliceRoleSetRaises)
// and (b) letting the callback raise its own error (caller-supplied fn).
// ---------------------------------------------------------------------------
function mockTx(opts?: {
  priorRole?: string;
  sliceRoleSetRaises?: unknown; // when set, the `SET LOCAL ROLE <slice_role>` query throws this
}): DbClient {
  const priorRole = opts?.priorRole ?? 'telecheck_app_role';
  return {
    query: vi.fn(async (sql: string) => {
      if (sql === 'SELECT current_user') {
        return { rows: [{ current_user: priorRole }], rowCount: 1 };
      }
      // Match the slice-role elevation SET LOCAL ROLE.
      // Pattern: `SET LOCAL ROLE <slice_role>` (NOT the restore back to
      // priorRole). We detect via "does NOT end with priorRole".
      if (
        sql.startsWith('SET LOCAL ROLE ') &&
        sql !== `SET LOCAL ROLE ${priorRole}` &&
        opts?.sliceRoleSetRaises !== undefined
      ) {
        throw opts.sliceRoleSetRaises;
      }
      return { rows: [], rowCount: 0 };
    }),
  } as unknown as DbClient;
}

// ---------------------------------------------------------------------------
// Mock FastifyRequest with the minimal `server.httpErrors.forbidden` surface
// withDbRoleSafe consumes. Returns a typed-error object with statusCode +
// message so callers can assert against the same shape Fastify produces in
// real handlers.
// ---------------------------------------------------------------------------
function mockReq(): FastifyRequest {
  return {
    server: {
      httpErrors: {
        forbidden: (message: string) => {
          const e = new Error(message) as Error & { statusCode: number };
          e.statusCode = 403;
          return e;
        },
      },
    },
  } as unknown as FastifyRequest;
}

const TEST_ROLE: SliceRole = 'crisis_event_staff_reader';

// ---------------------------------------------------------------------------
// §1 — happy path
// ---------------------------------------------------------------------------

describe('with-db-role-safe §1 — happy path', () => {
  it('returns the callback value verbatim when no error is raised', async () => {
    const tx = mockTx();
    const req = mockReq();
    const result = await withDbRoleSafe(tx, TEST_ROLE, req, async () => {
      return { crisis_event_id: 'evt_abc', current_state: 'acknowledged' };
    });
    expect(result).toEqual({
      crisis_event_id: 'evt_abc',
      current_state: 'acknowledged',
    });
  });

  it('propagates undefined-returning callbacks', async () => {
    const tx = mockTx();
    const req = mockReq();
    const result = await withDbRoleSafe(tx, TEST_ROLE, req, async () => undefined);
    expect(result).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// §2 — 42501 mapping (both raise paths covered because the try/catch wraps
//      the entire withDbRole call)
// ---------------------------------------------------------------------------

describe('with-db-role-safe §2 — 42501 maps to tenant-blind 403', () => {
  it('§2a callback-side 42501 (SECDEF wrapper LAYER C / RLS) maps to 403', async () => {
    const tx = mockTx();
    const req = mockReq();
    const wrapperError = Object.assign(
      new Error(
        'read_admin_crisis_operational_health: tenant scope mismatch — actor tenant Telecheck-US does not match wrapper p_tenant_id Telecheck-Ghana',
      ),
      { code: '42501' },
    );
    let thrown: unknown;
    try {
      await withDbRoleSafe(tx, TEST_ROLE, req, async () => {
        throw wrapperError;
      });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeDefined();
    const err = thrown as { statusCode?: number; message?: string };
    expect(err.statusCode).toBe(403);
    expect(err.message).toBe('Insufficient scope for this request.');
  });

  it('§2b pre-callback 42501 (SET LOCAL ROLE failure from 051-drift) maps to 403', async () => {
    // Simulate role-membership skew: SET LOCAL ROLE itself raises 42501
    // BEFORE the callback runs. A try/catch placed inside the callback
    // would miss this — verifying the wrapper boundary is the point.
    const setRoleError = Object.assign(
      new Error('permission denied to set role "crisis_event_staff_reader"'),
      { code: '42501' },
    );
    const tx = mockTx({ sliceRoleSetRaises: setRoleError });
    const req = mockReq();
    let thrown: unknown;
    let callbackInvoked = false;
    try {
      await withDbRoleSafe(tx, TEST_ROLE, req, async () => {
        callbackInvoked = true;
        return 'unreachable';
      });
    } catch (e) {
      thrown = e;
    }
    expect(callbackInvoked).toBe(false); // callback never ran
    expect(thrown).toBeDefined();
    const err = thrown as { statusCode?: number; message?: string };
    expect(err.statusCode).toBe(403);
    expect(err.message).toBe('Insufficient scope for this request.');
  });
});

// ---------------------------------------------------------------------------
// §3 — non-42501 error propagation (identity preserved)
// ---------------------------------------------------------------------------

describe('with-db-role-safe §3 — non-42501 errors propagate unchanged', () => {
  it('pg error with non-42501 SQLSTATE propagates with code intact + no statusCode injected', async () => {
    const tx = mockTx();
    const req = mockReq();
    const otherPgError = Object.assign(
      new Error('connection terminated unexpectedly'),
      { code: '57P01' }, // admin_shutdown
    );
    let thrown: unknown;
    try {
      await withDbRoleSafe(tx, TEST_ROLE, req, async () => {
        throw otherPgError;
      });
    } catch (e) {
      thrown = e;
    }
    // Identity preservation: the SAME object propagates.
    expect(thrown).toBe(otherPgError);
    expect((thrown as { code?: string }).code).toBe('57P01');
    // No statusCode injected — global envelope will format as 500.
    expect((thrown as { statusCode?: number }).statusCode).toBeUndefined();
  });

  it('plain Error (no code) propagates unchanged', async () => {
    const tx = mockTx();
    const req = mockReq();
    const plainError = new Error('something blew up in the callback');
    let thrown: unknown;
    try {
      await withDbRoleSafe(tx, TEST_ROLE, req, async () => {
        throw plainError;
      });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBe(plainError);
    expect((thrown as { statusCode?: number }).statusCode).toBeUndefined();
  });

  it('non-Error throwable (string) propagates unchanged', async () => {
    const tx = mockTx();
    const req = mockReq();
    let thrown: unknown;
    try {
      await withDbRoleSafe(tx, TEST_ROLE, req, async () => {
        throw 'string-error';
      });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBe('string-error');
  });
});

// ---------------------------------------------------------------------------
// §4 — I-025 envelope-leak defense
// ---------------------------------------------------------------------------

describe('with-db-role-safe §4 — I-025 envelope-leak defense', () => {
  it('the 403 message contains NO tenant ids, role names, SQLSTATEs, or PG body from upstream', async () => {
    const tx = mockTx();
    const req = mockReq();
    const leaky = Object.assign(
      new Error(
        'crisis_event_staff_reader: tenant scope mismatch — actor tenant Telecheck-US does not match wrapper p_tenant_id Telecheck-Ghana; cross-tenant read rejected (SQLSTATE 42501)',
      ),
      { code: '42501' },
    );
    let thrown: unknown;
    try {
      await withDbRoleSafe(tx, TEST_ROLE, req, async () => {
        throw leaky;
      });
    } catch (e) {
      thrown = e;
    }
    const msg = (thrown as { message?: string }).message ?? '';
    expect(msg).not.toContain('Telecheck-US');
    expect(msg).not.toContain('Telecheck-Ghana');
    expect(msg).not.toContain('tenant scope mismatch');
    expect(msg).not.toContain('42501');
    expect(msg).not.toContain('crisis_event_staff_reader');
    expect(msg).toBe('Insufficient scope for this request.');
  });
});

// ---------------------------------------------------------------------------
// §5 — isInsufficientPrivilegeError type-guard
// ---------------------------------------------------------------------------

describe('with-db-role-safe §5 — isInsufficientPrivilegeError type guard', () => {
  it('returns true for { code: "42501" }', () => {
    expect(isInsufficientPrivilegeError({ code: '42501' })).toBe(true);
  });

  it('returns true for an Error with code === "42501"', () => {
    expect(
      isInsufficientPrivilegeError(Object.assign(new Error('x'), { code: '42501' })),
    ).toBe(true);
  });

  it('returns false for other SQLSTATEs', () => {
    expect(isInsufficientPrivilegeError({ code: '57P01' })).toBe(false);
    expect(isInsufficientPrivilegeError({ code: '23505' })).toBe(false);
  });

  it('returns false for plain Error (no code)', () => {
    expect(isInsufficientPrivilegeError(new Error('plain'))).toBe(false);
  });

  it('returns false for null / undefined / primitives', () => {
    expect(isInsufficientPrivilegeError(null)).toBe(false);
    expect(isInsufficientPrivilegeError(undefined)).toBe(false);
    expect(isInsufficientPrivilegeError('42501')).toBe(false);
    expect(isInsufficientPrivilegeError(42501)).toBe(false);
  });

  it('returns false for object whose code is a non-string', () => {
    expect(isInsufficientPrivilegeError({ code: 42501 })).toBe(false);
  });
});
