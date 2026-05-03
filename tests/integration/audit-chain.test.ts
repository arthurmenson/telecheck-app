/**
 * Audit chain integrity integration tests.
 *
 * Invariant under test: I-003 (audit trail immutable and append-only).
 *
 * Spec references:
 *   - I-003: "No audit record is deleted, modified, or overwritten. Corrections
 *             are appended as new records referencing the original. The hash chain
 *             is never broken."
 *   - I-027: Every audit record carries tenant_id.
 *   - AUDIT_EVENTS v5.2 §Audit record schema (hash_chain structure):
 *       hash_chain.partition       = target_patient_id
 *       hash_chain.sequence_number = monotonically increasing within partition
 *       hash_chain.previous_hash   = SHA-256 of previous record in partition
 *       hash_chain.record_hash     = SHA-256(record body excluding hash_chain)
 *   - migrations/002_audit_chain.sql (audit_records table; append-only trigger;
 *     database-integration-expert agent).
 *
 * Test scenarios:
 *   1. Insert N records sequentially — assert chain intact after each insertion.
 *   2. Attempt UPDATE on an audit record — assert trigger raises EXCEPTION.
 *   3. Attempt DELETE on an audit record — assert trigger raises EXCEPTION.
 *   4. Tamper with record_hash (simulate out-of-band modification) — assert
 *      assertAuditChainIntact detects the break.
 *   5. Cross-tenant: Tenant A's chain is not polluted by Tenant B's records.
 *
 * DEPENDS ON:
 *   - tests/setup.ts (getTestClient, savepoint wrapping)
 *   - tests/helpers/audit-assertions.ts (assertAuditChainIntact)
 *   - tests/helpers/tenant-fixtures.ts (TENANT_US, TENANT_GHANA, withTenantContext)
 *   - migrations/002_audit_chain.sql (audit_records table with immutability trigger)
 */

import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { assertAuditChainIntact } from '../helpers/audit-assertions.ts';
import { TENANT_GHANA, TENANT_US, withTenantContext } from '../helpers/tenant-fixtures.ts';
import { getTestClient } from '../setup.ts';

// ---------------------------------------------------------------------------
// Helpers for constructing well-formed audit records with correct hash chains
// ---------------------------------------------------------------------------

interface AuditRow {
  audit_id: string;
  tenant_id: string;
  target_patient_id: string;
  action: string;
  category: 'A' | 'B' | 'C';
  partition: string;
  sequence_number: number;
  previous_hash: string;
}

function computeRecordHash(body: Record<string, unknown>): string {
  const keys = Object.keys(body).sort();
  const canonical =
    '{' + keys.map((k) => `${JSON.stringify(k)}:${JSON.stringify(body[k])}`).join(',') + '}';
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

async function insertAuditRecord(row: AuditRow): Promise<string> {
  const client = getTestClient();

  const body: Record<string, unknown> = {
    audit_id: row.audit_id,
    timestamp: new Date().toISOString(),
    tenant_id: row.tenant_id,
    actor_type: 'system',
    actor_id: 'sys_chain_test',
    actor_tenant_id: null,
    target_patient_id: row.target_patient_id,
    delegate_context: null,
    action: row.action,
    category: row.category,
    audit_sensitivity_level: 'standard',
    resource_type: 'medication_request',
    resource_id: `mr_chain_test_${row.sequence_number}`,
    detail: {},
    ai_workload_type: null,
    autonomy_level: null,
  };

  const record_hash = computeRecordHash(body);

  await client.query(
    `INSERT INTO audit_records
       (audit_id, timestamp, tenant_id, actor_type, actor_id, actor_tenant_id,
        target_patient_id, delegate_context, action, category,
        audit_sensitivity_level, resource_type, resource_id, detail,
        ai_workload_type, autonomy_level, hash_chain)
     VALUES
       ($1, NOW(), $2, 'system', 'sys_chain_test', NULL,
        $3, NULL, $4, $5,
        'standard', 'medication_request', $6, '{}',
        NULL, NULL,
        jsonb_build_object(
          'partition', $7,
          'sequence_number', $8,
          'previous_hash', $9,
          'record_hash', $10
        ))`,
    [
      row.audit_id,
      row.tenant_id,
      row.target_patient_id,
      row.action,
      row.category,
      `mr_chain_test_${row.sequence_number}`,
      row.partition,
      row.sequence_number,
      row.previous_hash,
      record_hash,
    ],
  );

  return record_hash;
}

// ---------------------------------------------------------------------------
// Scenario 1: Sequential insertions — chain intact
// ---------------------------------------------------------------------------

describe('audit chain — sequential insertions remain intact (I-003)', () => {
  it('should maintain a valid hash chain across N sequential audit records', async () => {
    const N = 5;
    const patient = 'pat_chain_test_001';
    let previousHash = '0'.repeat(64); // genesis hash

    for (let i = 1; i <= N; i++) {
      previousHash = await insertAuditRecord({
        audit_id: `aud_chain_test_seq_${i}`,
        tenant_id: TENANT_US,
        target_patient_id: patient,
        action: 'prescribing.initiated',
        category: 'A',
        partition: patient,
        sequence_number: i,
        previous_hash: previousHash,
      });
    }

    await withTenantContext(TENANT_US, async () => {
      await assertAuditChainIntact(TENANT_US);
    });
  });
});

// ---------------------------------------------------------------------------
// Scenario 2: UPDATE attempt — trigger must raise EXCEPTION
// ---------------------------------------------------------------------------

describe('audit chain — UPDATE forbidden by trigger (I-003)', () => {
  it('should raise EXCEPTION when UPDATE is attempted on an audit record', async () => {
    await withTenantContext(TENANT_US, async () => {
      await insertAuditRecord({
        audit_id: 'aud_chain_test_update_target',
        tenant_id: TENANT_US,
        target_patient_id: 'pat_update_test',
        action: 'prescribing.approved',
        category: 'A',
        partition: 'pat_update_test',
        sequence_number: 1,
        previous_hash: '0'.repeat(64),
      });
    });

    const client = getTestClient();

    // Expect the UPDATE to fail. The audit_records table must have a trigger
    // that raises an exception per I-003. The expected Postgres SQLSTATE is
    // '55000' (object_not_in_prerequisite_state) or a custom '45000'
    // (unhandled_exception). Either indicates the trigger fired.
    await expect(
      client.query(
        `UPDATE audit_records SET action = 'tampered_action'
         WHERE audit_id = 'aud_chain_test_update_target'`,
      ),
    ).rejects.toThrow();
    // The specific error message from the trigger in 002_audit_chain.sql
    // is expected to be "audit_records is append-only" or similar.
  });
});

// ---------------------------------------------------------------------------
// Scenario 3: DELETE attempt — trigger must raise EXCEPTION
// ---------------------------------------------------------------------------

describe('audit chain — DELETE forbidden by trigger (I-003)', () => {
  it('should raise EXCEPTION when DELETE is attempted on an audit record', async () => {
    await withTenantContext(TENANT_US, async () => {
      await insertAuditRecord({
        audit_id: 'aud_chain_test_delete_target',
        tenant_id: TENANT_US,
        target_patient_id: 'pat_delete_test',
        action: 'refill.approved',
        category: 'A',
        partition: 'pat_delete_test',
        sequence_number: 1,
        previous_hash: '0'.repeat(64),
      });
    });

    const client = getTestClient();

    await expect(
      client.query(`DELETE FROM audit_records WHERE audit_id = 'aud_chain_test_delete_target'`),
    ).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Scenario 4: Hash desync — assertAuditChainIntact detects tampering
// ---------------------------------------------------------------------------

describe('audit chain — hash chain walker detects desync (I-003)', () => {
  it('should detect a broken hash chain when record_hash is stale', async () => {
    // If the DB trigger does not prevent UPDATE of hash_chain itself
    // (e.g., the trigger only blocks UPDATE of non-hash_chain columns),
    // this test exercises the chain walker catching the discrepancy.
    //
    // More likely scenario: a test environment where the trigger was not
    // applied (the worker agent's migration hasn't landed yet). We simulate
    // the detection by constructing a chain where the expected hash doesn't
    // match the stored hash.

    // Insert a well-formed record.
    const patient = 'pat_hash_desync_001';
    await insertAuditRecord({
      audit_id: 'aud_desync_test_001',
      tenant_id: TENANT_US,
      target_patient_id: patient,
      action: 'prescribing.initiated',
      category: 'A',
      partition: patient,
      sequence_number: 1,
      previous_hash: '0'.repeat(64),
    });

    // Insert a second record with a previous_hash that references the first,
    // but intentionally use a WRONG record_hash for the second record to
    // simulate out-of-band tampering. This will cause the walker to throw
    // on the second record because the recomputed hash won't match.
    const client = getTestClient();
    await client.query(
      `INSERT INTO audit_records
         (audit_id, timestamp, tenant_id, actor_type, actor_id,
          action, category, audit_sensitivity_level, resource_type, resource_id, detail,
          hash_chain)
       VALUES
         ('aud_desync_test_002', NOW(), $1, 'system', 'sys_tamper',
          'prescribing.approved', 'A', 'standard', 'medication_request', 'mr_desync', '{}',
          jsonb_build_object(
            'partition', $2,
            'sequence_number', 2,
            'previous_hash', 'aaaa0000000000000000000000000000000000000000000000000000000000000000',
            'record_hash', 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef'
          ))`,
      [TENANT_US, patient],
    );

    // The chain walker should throw because record_hash does not match
    // the recomputed SHA-256 of the record body.
    await expect(
      withTenantContext(TENANT_US, () => assertAuditChainIntact(TENANT_US)),
    ).rejects.toThrow(/I-003 VIOLATION/);
  });
});

// ---------------------------------------------------------------------------
// Scenario 5: Cross-tenant chain isolation
// ---------------------------------------------------------------------------

describe('audit chain — cross-tenant isolation (I-023, I-027)', () => {
  it("should not include Tenant B records in Tenant A's chain walk", async () => {
    const patientA = 'pat_chain_xten_us_001';
    const patientB = 'pat_chain_xten_gh_001';

    // Insert one record per tenant, same patient slot name to confirm no bleed.
    await withTenantContext(TENANT_US, async () => {
      await insertAuditRecord({
        audit_id: 'aud_xten_us_001',
        tenant_id: TENANT_US,
        target_patient_id: patientA,
        action: 'prescribing.initiated',
        category: 'A',
        partition: patientA,
        sequence_number: 1,
        previous_hash: '0'.repeat(64),
      });
    });

    await withTenantContext(TENANT_GHANA, async () => {
      await insertAuditRecord({
        audit_id: 'aud_xten_gh_001',
        tenant_id: TENANT_GHANA,
        target_patient_id: patientB,
        action: 'prescribing.initiated',
        category: 'A',
        partition: patientB,
        sequence_number: 1,
        previous_hash: '0'.repeat(64),
      });
    });

    // Each tenant's chain should walk cleanly independently.
    await withTenantContext(TENANT_US, () => assertAuditChainIntact(TENANT_US));
    await withTenantContext(TENANT_GHANA, () => assertAuditChainIntact(TENANT_GHANA));

    // TENANT_US context should NOT see TENANT_GHANA's record.
    const client = getTestClient();
    const usView = await withTenantContext(TENANT_US, async () => {
      const r = await client.query(
        `SELECT audit_id FROM audit_records WHERE audit_id = 'aud_xten_gh_001'`,
      );
      return r.rows as unknown[];
    });
    expect(usView).toHaveLength(0);
  });
});
