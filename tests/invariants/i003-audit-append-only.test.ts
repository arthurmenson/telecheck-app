/**
 * I-003 Audit append-only invariant — REVOKE + trigger verification.
 *
 * Invariant under test: I-003 (Audit trail is immutable and append-only).
 *
 * Spec references:
 *   - I-003: "No audit record is deleted, modified, or overwritten. Corrections
 *             are appended as new records referencing the original. The hash chain
 *             is never broken. There are no exceptions."
 *   - AUDIT_EVENTS v5.2 §Audit record schema (hash_chain structure).
 *   - migrations/002_audit_chain.sql:
 *       (a) Creates audit_records table with discrete columns for the
 *           envelope (recorded_at, payload, prev_hash, record_hash,
 *           sequence_number) — see audit-assertions.ts header for the
 *           envelope-to-column mapping.
 *       (b) Installs `audit_records_block_update` and `audit_records_block_delete`
 *           triggers that raise EXCEPTION on any UPDATE / DELETE.
 *       (c) REVOKE DELETE, UPDATE on audit_records from PUBLIC.
 *
 * Test scenarios:
 *   1. REVOKE verification: the test DB role must not have UPDATE/DELETE
 *      privileges on audit_records (checked via information_schema).
 *   2. Trigger fires on UPDATE: direct pg EXCEPTION expected.
 *   3. Trigger fires on DELETE: direct pg EXCEPTION expected.
 *   4. Append-only correction: a correction record references the original
 *      audit_id; the original is unchanged; chain still valid.
 *   5. Hash chain: assertAuditChainIntact passes after sequential inserts.
 *
 * DEPENDS ON:
 *   - tests/setup.ts (getTestClient)
 *   - tests/helpers/audit-assertions.ts (assertAuditChainIntact)
 *   - tests/helpers/tenant-fixtures.ts (TENANT_US, withTenantContext)
 *   - migrations/002_audit_chain.sql (database-integration-expert agent):
 *       Table + immutability trigger + REVOKE required.
 */

import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { assertAuditChainIntact } from '../helpers/audit-assertions.ts';
import { TENANT_US, withTenantContext } from '../helpers/tenant-fixtures.ts';
import { getTestClient } from '../setup.ts';

// Shared helper: insert a minimal well-formed audit record. The DB BEFORE
// INSERT trigger computes prev_hash / record_hash / sequence_number, so the
// caller does not (and must not) supply them.
async function insertMinimalAuditRecord(opts: {
  auditId?: string;
  action?: string;
  resource_id: string;
  target_patient_id?: string;
  payload?: Record<string, unknown>;
  actor_type?: 'system' | 'clinician';
  actor_id?: string;
}): Promise<string> {
  const client = getTestClient();
  const auditId = opts.auditId ?? randomUUID();

  await client.query(
    `INSERT INTO audit_records
       (audit_id, tenant_id, actor_type, actor_id,
        target_patient_id, action, category,
        audit_sensitivity_level, resource_type, resource_id,
        ai_workload_type, autonomy_level, payload)
     VALUES
       ($1, $2, $3, $4,
        $5, $6, 'A',
        'standard', 'medication_request', $7,
        NULL, NULL, $8::jsonb)`,
    [
      auditId,
      TENANT_US,
      opts.actor_type ?? 'system',
      opts.actor_id ?? 'sys_i003_test',
      opts.target_patient_id ?? `pat_i003_test_${auditId.slice(0, 8)}`,
      opts.action ?? 'prescribing.initiated',
      opts.resource_id,
      JSON.stringify(opts.payload ?? {}),
    ],
  );

  return auditId;
}

// ---------------------------------------------------------------------------
// Scenario 1: REVOKE privilege check
// ---------------------------------------------------------------------------

describe('I-003 — REVOKE: application role must not have UPDATE/DELETE on audit_records', () => {
  // Strict zero-row checks 2026-05-03 (Codex CI-fix adversarial review MEDIUM-1):
  // tests/setup.ts now REVOKEs UPDATE/DELETE on audit_records from telecheck_test_app
  // explicitly. The append-only trigger remains as belt + suspenders, but the
  // privilege layer alone must already deny mutation — that's the production
  // shape I-003 requires.

  it('should confirm UPDATE privilege is revoked from the application DB role', async () => {
    const client = getTestClient();

    const result = await client.query<{ privilege_type: string }>(`
      SELECT privilege_type
      FROM information_schema.role_table_grants
      WHERE table_name = 'audit_records'
        AND grantee = current_user
        AND privilege_type = 'UPDATE'
    `);

    expect(result.rows).toHaveLength(0);
  });

  it('should confirm DELETE privilege is revoked from the application DB role', async () => {
    const client = getTestClient();

    const result = await client.query<{ privilege_type: string }>(`
      SELECT privilege_type
      FROM information_schema.role_table_grants
      WHERE table_name = 'audit_records'
        AND grantee = current_user
        AND privilege_type = 'DELETE'
    `);

    expect(result.rows).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Scenario 2 + 3: Trigger fires on UPDATE / DELETE
// (mirrors tests in audit-chain.test.ts — these are the invariant-level assertions)
// ---------------------------------------------------------------------------

describe('I-003 — trigger: UPDATE and DELETE must raise EXCEPTION', () => {
  it('should raise EXCEPTION on UPDATE attempt (trigger required in 002_audit_chain.sql)', async () => {
    const auditId = await withTenantContext(TENANT_US, () =>
      insertMinimalAuditRecord({ resource_id: `mr_i003_upd_${randomUUID().slice(0, 8)}` }),
    );

    const client = getTestClient();
    await expect(
      client.query(`UPDATE audit_records SET action = 'tampered' WHERE audit_id = $1`, [auditId]),
    ).rejects.toThrow();
  });

  it('should raise EXCEPTION on DELETE attempt (trigger required in 002_audit_chain.sql)', async () => {
    const auditId = await withTenantContext(TENANT_US, () =>
      insertMinimalAuditRecord({ resource_id: `mr_i003_del_${randomUUID().slice(0, 8)}` }),
    );

    const client = getTestClient();
    await expect(
      client.query(`DELETE FROM audit_records WHERE audit_id = $1`, [auditId]),
    ).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Scenario 4: Append-only correction — original unchanged, correction appended
// ---------------------------------------------------------------------------

describe('I-003 — correction pattern: append a new record referencing the original', () => {
  it('should allow appending a correction record that references the original audit_id', async () => {
    const partition = `pat_i003_correction_${randomUUID().slice(0, 8)}`;

    const originalId = await withTenantContext(TENANT_US, () =>
      insertMinimalAuditRecord({
        resource_id: `mr_correction_orig_${partition}`,
        target_patient_id: partition,
        action: 'prescribing.initiated',
      }),
    );

    // Insert a correction record. The correction references the original via
    // payload.corrects_audit_id (per I-003: "Corrections are appended as new
    // records referencing the original").
    await withTenantContext(TENANT_US, () =>
      insertMinimalAuditRecord({
        resource_id: `mr_correction_new_${partition}`,
        target_patient_id: partition,
        action: 'prescribing.modified',
        actor_type: 'clinician',
        actor_id: 'clin_001',
        payload: { corrects_audit_id: originalId },
      }),
    );

    // Original must be unchanged.
    const client = getTestClient();
    const orig = await client.query(`SELECT action FROM audit_records WHERE audit_id = $1`, [
      originalId,
    ]);
    expect(orig.rows).toHaveLength(1);
    expect((orig.rows[0] as { action: string }).action).toBe('prescribing.initiated');

    // Chain must still be intact for the partition we wrote into.
    await withTenantContext(TENANT_US, () => assertAuditChainIntact(TENANT_US));
  });
});

// ---------------------------------------------------------------------------
// Scenario 5: Hash chain intact after sequential inserts
// ---------------------------------------------------------------------------

describe('I-003 — hash chain: remains intact across sequential appends', () => {
  it('should maintain a valid hash chain for I-003 specific test records', async () => {
    const partition = `pat_i003_chain_${randomUUID().slice(0, 8)}`;

    await withTenantContext(TENANT_US, async () => {
      for (let i = 0; i < 5; i++) {
        await insertMinimalAuditRecord({
          resource_id: `mr_i003_chain_${partition}_${i}`,
          target_patient_id: partition,
        });
      }
    });

    await withTenantContext(TENANT_US, () => assertAuditChainIntact(TENANT_US));
  });
});
