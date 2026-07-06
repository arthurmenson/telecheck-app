/**
 * with-db-role.test.ts — unit tests for the Option B SET LOCAL ROLE helper.
 *
 * Covers:
 *   §1 allowlist enforcement (assertSliceRole)
 *   §2 SET LOCAL ROLE statement issued with the role name
 *   §3 callback return value propagation
 *   §4 callback throw propagation (no swallowing)
 *
 * Integration tests covering the actual privilege-elevation behavior
 * against a live PostgreSQL with migration 051 applied land in a
 * separate `tests/integration/foundation-role-acquisition.test.ts`
 * (separate PR or future commit; requires TEST_DATABASE_URL + the
 * 18 slice roles + telecheck_app_role present).
 */

import { describe, expect, it, vi } from 'vitest';

import type { DbClient } from './db.js';
import { SLICE_ROLES, assertSliceRole, withDbRole, type SliceRole } from './with-db-role.js';

// Minimal DbClient mock — exposes `query` only.
// `priorRoleResult` controls what the captured `SELECT current_user`
// returns; default 'telecheck_app_role' simulates an outermost
// invocation from the Fastify login role.
function mockTx(opts?: { priorRole?: string; failOnRestore?: boolean }): {
  tx: DbClient;
  calls: { sql: string; params: unknown[] | undefined }[];
} {
  const priorRole = opts?.priorRole ?? 'telecheck_app_role';
  const failOnRestore = opts?.failOnRestore ?? false;
  const calls: { sql: string; params: unknown[] | undefined }[] = [];
  let restoreSeen = false;
  const tx = {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      calls.push({ sql, params });
      // SELECT current_user → return the configured priorRole.
      if (sql === 'SELECT current_user') {
        return { rows: [{ current_user: priorRole }], rowCount: 1 };
      }
      // Detect the RESTORE SET LOCAL ROLE (always to priorRole).
      if (sql === `SET LOCAL ROLE ${priorRole}`) {
        if (!restoreSeen) {
          restoreSeen = true;
          if (failOnRestore) {
            throw new Error('simulated restore failure (e.g., tx aborted)');
          }
        }
      }
      return { rows: [], rowCount: 0 };
    }),
  } as unknown as DbClient;
  return { tx, calls };
}

describe('with-db-role §1 — allowlist enforcement (assertSliceRole)', () => {
  it('accepts every role in SLICE_ROLES', () => {
    for (const role of SLICE_ROLES) {
      expect(() => assertSliceRole(role)).not.toThrow();
    }
  });

  it('rejects strings that are not in SLICE_ROLES', () => {
    const rejects = [
      'postgres',
      'telecheck_app_role',
      'crisis_initiator_wrapper_owner', // wrapper-owner — internal SECDEF, not in allowlist
      'mv_refresh_owner', // wrapper-owner — internal SECDEF, not in allowlist
      'lifecycle_transition_writer_owner', // wrapper-owner — internal SECDEF, not in allowlist
      'arbitrary_role',
      '',
      'crisis_initiator; DROP DATABASE', // injection attempt
      'CRISIS_INITIATOR', // case-sensitive mismatch
      ' crisis_initiator', // whitespace mismatch
    ];
    for (const role of rejects) {
      expect(() => assertSliceRole(role)).toThrow(/not an allowlisted slice role/);
    }
  });

  it('enumerates the allowlist in the rejection error so operators can debug', () => {
    try {
      assertSliceRole('nonexistent_role');
      throw new Error('assertSliceRole did not throw');
    } catch (e: unknown) {
      const msg = (e as Error).message;
      expect(msg).toContain('crisis_initiator');
      expect(msg).toContain('admin_basic_operator');
      expect(msg).toContain('medication_interaction_engine_evaluator');
      expect(msg).toContain('migration 051');
    }
  });
});

describe('with-db-role §2 — SET LOCAL ROLE issued + restored', () => {
  it('issues SELECT current_user, SET LOCAL ROLE, then restores prior role (3 statements, in order)', async () => {
    const { tx, calls } = mockTx();
    await withDbRole(tx, 'crisis_initiator', async () => {
      // callback body irrelevant for this test
    });
    expect(calls).toHaveLength(3);
    expect(calls[0]!.sql).toBe('SELECT current_user');
    expect(calls[1]!.sql).toBe('SET LOCAL ROLE crisis_initiator');
    expect(calls[2]!.sql).toBe('SET LOCAL ROLE telecheck_app_role');
  });

  it('restores to the captured prior role (not hardcoded telecheck_app_role) — supports nesting', async () => {
    // Simulate nested invocation: outer call already SET ROLE to
    // medication_interaction_signal_viewer; inner withDbRole should
    // restore to that outer role, NOT to telecheck_app_role.
    const { tx, calls } = mockTx({ priorRole: 'medication_interaction_signal_viewer' });
    await withDbRole(tx, 'crisis_event_staff_reader', async () => {
      // inner work
    });
    expect(calls[2]!.sql).toBe('SET LOCAL ROLE medication_interaction_signal_viewer');
  });

  it('emits the SET LOCAL ROLE BEFORE invoking the callback', async () => {
    const { tx, calls } = mockTx();
    const callbackOrder: string[] = [];
    await withDbRole(tx, 'admin_basic_operator', async () => {
      callbackOrder.push(
        `during-callback: ${calls.length} call(s) so far — last was: ${calls[calls.length - 1]?.sql ?? '(none)'}`,
      );
    });
    expect(callbackOrder).toEqual([
      'during-callback: 2 call(s) so far — last was: SET LOCAL ROLE admin_basic_operator',
    ]);
  });

  it('refuses an arbitrary string at runtime (defense-in-depth past TypeScript)', async () => {
    const { tx } = mockTx();
    // Cast to SliceRole to simulate a code path that widened the type.
    const tamperedRole = 'postgres' as SliceRole;
    await expect(withDbRole(tx, tamperedRole, async () => undefined)).rejects.toThrow(
      /not an allowlisted slice role/,
    );
  });

  it('aborts elevation if SELECT current_user returns empty (cannot restore safely)', async () => {
    const tx = {
      query: vi.fn(async (sql: string) => {
        if (sql === 'SELECT current_user') {
          return { rows: [], rowCount: 0 };
        }
        return { rows: [], rowCount: 0 };
      }),
    } as unknown as DbClient;
    await expect(withDbRole(tx, 'crisis_initiator', async () => undefined)).rejects.toThrow(
      /could not read current_user/,
    );
    // Critically: SET LOCAL ROLE crisis_initiator was NOT issued.
    const calls = (tx.query as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls).toHaveLength(1);
    expect(calls[0]![0]).toBe('SELECT current_user');
  });
});

describe('with-db-role §3 — callback return propagation', () => {
  it('returns the value the callback returns', async () => {
    const { tx } = mockTx();
    const result = await withDbRole(tx, 'medication_interaction_signal_viewer', async () => {
      return { signal_id: 'sig_abc123', state: 'emitted' };
    });
    expect(result).toEqual({ signal_id: 'sig_abc123', state: 'emitted' });
  });

  it('propagates undefined-returning callbacks', async () => {
    const { tx } = mockTx();
    const result = await withDbRole(tx, 'crisis_event_staff_reader', async () => undefined);
    expect(result).toBeUndefined();
  });
});

describe('with-db-role §4 — callback throw propagation + restore-on-throw', () => {
  it('re-throws errors raised inside the callback', async () => {
    const { tx } = mockTx();
    await expect(
      withDbRole(tx, 'crisis_initiator', async () => {
        throw new Error('simulated wrapper failure');
      }),
    ).rejects.toThrow('simulated wrapper failure');
  });

  it('STILL restores prior role after callback throw (R1 HIGH-1: defense against catch-and-continue paths)', async () => {
    const { tx, calls } = mockTx();
    await expect(
      withDbRole(tx, 'crisis_acknowledger', async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    // Expect all 3 statements: SELECT current_user, SET LOCAL ROLE,
    // restore SET LOCAL ROLE (the finally block ran).
    expect(calls).toHaveLength(3);
    expect(calls[0]!.sql).toBe('SELECT current_user');
    expect(calls[1]!.sql).toBe('SET LOCAL ROLE crisis_acknowledger');
    expect(calls[2]!.sql).toBe('SET LOCAL ROLE telecheck_app_role');
  });

  it('preserves the original error if restore itself fails (does NOT shadow with finally-throw)', async () => {
    const { tx } = mockTx({ failOnRestore: true });
    await expect(
      withDbRole(tx, 'crisis_initiator', async () => {
        throw new Error('original-fn-error');
      }),
    ).rejects.toThrow('original-fn-error'); // NOT 'simulated restore failure'
  });

  it('on successful fn, restore failure PROPAGATES (R3 HIGH-1: privilege-boundary defense)', async () => {
    // R3 HIGH-1 closure 2026-05-23: when fn succeeds but the role restore
    // fails, the helper MUST surface the failure. Silently returning
    // success would let later code in the same transaction execute under
    // the slice role's privileges — the exact privilege boundary this
    // helper is designed to enforce. (When fn throws, swallow is correct
    // to preserve the original error per the test above.)
    const { tx } = mockTx({ failOnRestore: true });
    await expect(
      withDbRole(tx, 'admin_basic_operator', async () => {
        return 'ok';
      }),
    ).rejects.toThrow(/prior-role restoration failed after successful callback/);
  });
});

describe('with-db-role §5 — allowlist composition', () => {
  it('SLICE_ROLES contains all 7 Crisis + 2 Admin + 4 Med-Interaction + 5 Async-Consult = 18 roles', () => {
    expect(SLICE_ROLES).toHaveLength(18);
    // Spot-check one from each slice
    expect(SLICE_ROLES).toContain('crisis_initiator');
    expect(SLICE_ROLES).toContain('admin_basic_operator');
    expect(SLICE_ROLES).toContain('medication_interaction_engine_evaluator');
    // Async Consult Sprint 10 PR 6 (migration 055 roles + migration 060 bridge)
    expect(SLICE_ROLES).toContain('async_consult_patient_initiator');
    expect(SLICE_ROLES).toContain('async_consult_delegate_initiator');
    expect(SLICE_ROLES).toContain('async_consult_clinician_reviewer');
    expect(SLICE_ROLES).toContain('async_consult_patient_reader');
    expect(SLICE_ROLES).toContain('async_consult_staff_reader');
  });

  it('SLICE_ROLES does NOT contain wrapper-owner / view-owner / writer-owner roles', () => {
    // These are internal SECDEF identities, never SET-ROLEd into by handlers.
    const forbidden = [
      'crisis_initiation_wrapper_owner',
      'crisis_event_current_state_view_owner',
      'crisis_event_lifecycle_transition_writer_owner',
      'admin_basic_operator_wrapper_owner', // doesn't exist; sanity
      'forms_template_admin_review_submit_wrapper_owner',
      'emission_wrapper_owner',
      'lifecycle_transition_writer_owner',
      'mv_refresh_owner',
      // Async Consult (migration 055 §2 wrapper-owner / view-owner identities)
      'consult_lifecycle_transition_writer_owner',
      'consult_initiation_wrapper_owner',
      'consult_intake_wrapper_owner',
      'consult_ai_preparation_wrapper_owner',
      'consult_claim_wrapper_owner',
      'record_consult_decision_wrapper_owner',
      'async_consult_view_owner',
      'async_consult_mv_refresh_owner',
    ];
    for (const role of forbidden) {
      expect(SLICE_ROLES as readonly string[]).not.toContain(role);
    }
  });
});
