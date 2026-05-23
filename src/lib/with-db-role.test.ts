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
 * 13 slice roles + telecheck_app_role present).
 */

import { describe, expect, it, vi } from 'vitest';

import { SLICE_ROLES, assertSliceRole, withDbRole, type SliceRole } from './with-db-role.js';
import type { DbClient } from './db.js';

// Minimal DbClient mock — exposes `query` only.
function mockTx(): { tx: DbClient; calls: { sql: string; params: unknown[] | undefined }[] } {
  const calls: { sql: string; params: unknown[] | undefined }[] = [];
  const tx = {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      calls.push({ sql, params });
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

describe('with-db-role §2 — SET LOCAL ROLE issued', () => {
  it('issues SET LOCAL ROLE with the exact role name (no quoting, no params)', async () => {
    const { tx, calls } = mockTx();
    await withDbRole(tx, 'crisis_initiator', async () => {
      // callback body irrelevant for this test
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.sql).toBe('SET LOCAL ROLE crisis_initiator');
    expect(calls[0]!.params).toBeUndefined();
  });

  it('emits the SET LOCAL ROLE BEFORE invoking the callback', async () => {
    const { tx, calls } = mockTx();
    const callbackOrder: string[] = [];
    await withDbRole(tx, 'admin_basic_operator', async () => {
      callbackOrder.push(
        `after-set: ${calls.length} call(s) so far — last was: ${calls[calls.length - 1]?.sql ?? '(none)'}`,
      );
    });
    expect(callbackOrder).toEqual([
      'after-set: 1 call(s) so far — last was: SET LOCAL ROLE admin_basic_operator',
    ]);
  });

  it('refuses an arbitrary string at runtime (defense-in-depth past TypeScript)', async () => {
    const { tx } = mockTx();
    // Cast to SliceRole to simulate a code path that widened the type.
    const tamperedRole = 'postgres' as SliceRole;
    await expect(
      withDbRole(tx, tamperedRole, async () => undefined),
    ).rejects.toThrow(/not an allowlisted slice role/);
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

describe('with-db-role §4 — callback throw propagation (no swallow)', () => {
  it('re-throws errors raised inside the callback', async () => {
    const { tx } = mockTx();
    await expect(
      withDbRole(tx, 'crisis_initiator', async () => {
        throw new Error('simulated wrapper failure');
      }),
    ).rejects.toThrow('simulated wrapper failure');
  });

  it('does NOT issue RESET ROLE after callback throw (rely on tx-end auto-reset)', async () => {
    const { tx, calls } = mockTx();
    await expect(
      withDbRole(tx, 'crisis_acknowledger', async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    // Only the SET LOCAL ROLE should have been issued; no RESET ROLE.
    expect(calls).toHaveLength(1);
    expect(calls[0]!.sql).toBe('SET LOCAL ROLE crisis_acknowledger');
  });
});

describe('with-db-role §5 — allowlist composition', () => {
  it('SLICE_ROLES contains all 7 Crisis + 2 Admin + 4 Med-Interaction = 13 roles', () => {
    expect(SLICE_ROLES).toHaveLength(13);
    // Spot-check one from each slice
    expect(SLICE_ROLES).toContain('crisis_initiator');
    expect(SLICE_ROLES).toContain('admin_basic_operator');
    expect(SLICE_ROLES).toContain('medication_interaction_engine_evaluator');
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
    ];
    for (const role of forbidden) {
      expect(SLICE_ROLES as readonly string[]).not.toContain(role);
    }
  });
});
