/**
 * Audit chain assertion helpers.
 *
 * Used by:
 *   - tests/integration/audit-chain.test.ts
 *   - tests/invariants/i003-audit-append-only.test.ts
 *   - Any test that must verify I-003 (audit append-only) or I-031
 *     (high_pii audit_sensitivity_level on research export events).
 *
 * Hash chain model (from AUDIT_EVENTS v5.2 §Audit record schema):
 *   hash_chain.partition       = target_patient_id  (partition key)
 *   hash_chain.sequence_number = monotonically increasing within partition
 *   hash_chain.previous_hash   = SHA-256 of previous record in this partition
 *   hash_chain.record_hash     = SHA-256(all fields excluding hash_chain itself)
 *
 * The walker asserts:
 *   record_hash === SHA-256(previous_hash || canonical_serialization(record_body))
 * where `record_body` is the audit record row with hash_chain removed.
 *
 * Spec references:
 *   - I-003 (audit trail is immutable and append-only; hash chain never broken)
 *   - I-027 (every audit record carries tenant_id)
 *   - I-031 (research data export emits at audit_sensitivity_level: high_pii)
 *   - AUDIT_EVENTS v5.2 §Audit record schema (hash_chain structure)
 *   - AUDIT_EVENTS v5.2 §Safety classification matrix (Category A/B/C)
 *   - AUDIT_EVENTS v5.2 §I-029 binding (status=invalidated + signal_enforcement_trigger)
 *
 * DEPENDS ON:
 *   - tests/setup.ts (getTestClient)
 *   - migrations/002_audit_chain.sql (audit_records table; database-integration-expert)
 *   - Node.js built-in `crypto` for SHA-256 (no additional dependency)
 */

import { createHash } from 'node:crypto';

import { getTestClient } from '../setup.ts';

import type { TenantId } from './tenant-fixtures.ts';

// ---------------------------------------------------------------------------
// AuditRecord — minimal shape matching AUDIT_EVENTS v5.2 schema
// (only the columns needed by these helpers; actual table has more columns)
// ---------------------------------------------------------------------------

export interface AuditRecord {
  audit_id: string;
  timestamp: string;
  tenant_id: string;
  actor_type: string;
  actor_id: string;
  actor_tenant_id: string | null;
  target_patient_id: string | null;
  action: string;
  category: 'A' | 'B' | 'C';
  audit_sensitivity_level: 'standard' | 'high_pii';
  resource_type: string;
  resource_id: string;
  detail: Record<string, unknown>;
  ai_workload_type: string | null;
  autonomy_level: string | null;
  hash_chain: {
    partition: string;
    sequence_number: number;
    previous_hash: string;
    record_hash: string;
  };
}

// ---------------------------------------------------------------------------
// assertAuditChainIntact
// ---------------------------------------------------------------------------

/**
 * Walk all audit records for `tenantId` ordered by partition + sequence_number
 * and verify that the SHA-256 hash chain is unbroken.
 *
 * Throws with a precise message identifying the first broken link:
 *   "I-003 VIOLATION: audit chain broken at audit_id=<id>: ..."
 *
 * Note: the hash is computed over the record body EXCLUDING the hash_chain
 * column itself, serialized as canonical JSON (keys sorted, no whitespace).
 *
 * @param tenantId - Tenant whose audit records are walked.
 */
export async function assertAuditChainIntact(tenantId: TenantId): Promise<void> {
  const client = getTestClient();

  const result = await client.query<AuditRecord>(
    `SELECT *
     FROM audit_records
     WHERE tenant_id = $1
     ORDER BY hash_chain->>'partition', (hash_chain->>'sequence_number')::int`,
    [tenantId],
  );

  const records = result.rows;
  if (records.length === 0) {
    return; // No records to walk — vacuously intact.
  }

  // Group by partition to walk each chain independently.
  const partitions = new Map<string, AuditRecord[]>();
  for (const rec of records) {
    const partition = rec.hash_chain.partition;
    if (!partitions.has(partition)) {
      partitions.set(partition, []);
    }
    partitions.get(partition)!.push(rec);
  }

  for (const [partition, chain] of partitions) {
    let expectedPreviousHash = '0'.repeat(64); // genesis hash

    for (const rec of chain) {
      // Recompute record_hash from the record body (minus hash_chain).
      const { hash_chain: _, ...body } = rec as AuditRecord & { hash_chain: unknown };
      const canonicalBody = canonicalSerialize(body);
      const computedRecordHash = sha256(canonicalBody);

      if (computedRecordHash !== rec.hash_chain.record_hash) {
        throw new Error(
          `I-003 VIOLATION: audit chain tampered at audit_id=${rec.audit_id} ` +
            `(partition=${partition}, seq=${rec.hash_chain.sequence_number}). ` +
            `Expected record_hash=${computedRecordHash}, ` +
            `stored record_hash=${rec.hash_chain.record_hash}`,
        );
      }

      if (rec.hash_chain.previous_hash !== expectedPreviousHash) {
        throw new Error(
          `I-003 VIOLATION: audit chain link broken at audit_id=${rec.audit_id} ` +
            `(partition=${partition}, seq=${rec.hash_chain.sequence_number}). ` +
            `Expected previous_hash=${expectedPreviousHash}, ` +
            `actual previous_hash=${rec.hash_chain.previous_hash}`,
        );
      }

      expectedPreviousHash = rec.hash_chain.record_hash;
    }
  }
}

// ---------------------------------------------------------------------------
// assertAuditRecordExists
// ---------------------------------------------------------------------------

/**
 * Assert that at least one audit record for `tenantId` satisfies `predicate`.
 * Throws if no matching record is found.
 *
 * Used to assert the "bare suppression forbidden" discipline from I-003:
 * even when an action is rejected (I-012 reject-unless; I-029 invalidation),
 * an audit record MUST be emitted. Tests use this to verify the rejection
 * audit event was persisted.
 *
 * @param tenantId  - Tenant scope for the lookup (I-027: tenant_id is mandatory).
 * @param predicate - Predicate over AuditRecord; must return true for the
 *                    expected record.
 * @returns The matching AuditRecord (first match).
 */
export async function assertAuditRecordExists(
  tenantId: TenantId,
  predicate: (record: AuditRecord) => boolean,
): Promise<AuditRecord> {
  const client = getTestClient();

  const result = await client.query<AuditRecord>(
    `SELECT * FROM audit_records WHERE tenant_id = $1 ORDER BY timestamp DESC`,
    [tenantId],
  );

  const match = result.rows.find(predicate);
  if (match === undefined) {
    throw new Error(
      `I-003 VIOLATION (bare suppression): no audit record found for tenant '${tenantId}' ` +
        `matching the predicate. An audit record MUST be emitted even for rejected actions.`,
    );
  }

  return match;
}

// ---------------------------------------------------------------------------
// assertAuditCategory
// ---------------------------------------------------------------------------

/**
 * Assert that an audit record carries the expected safety classification
 * category (A / B / C) per AUDIT_EVENTS v5.2 §Safety classification matrix.
 *
 * Throws with a precise I-003-referencing message on mismatch.
 *
 * @param record   - The AuditRecord to check.
 * @param category - Expected category: 'A' (safety-critical), 'B' (governance),
 *                   or 'C' (operational).
 */
export function assertAuditCategory(record: AuditRecord, category: 'A' | 'B' | 'C'): void {
  if (record.category !== category) {
    throw new Error(
      `Audit record ${record.audit_id} (action=${record.action}) ` +
        `has category '${record.category}', expected category '${category}'. ` +
        `Verify the action is registered in the correct category in AUDIT_EVENTS v5.2.`,
    );
  }
}

// ---------------------------------------------------------------------------
// assertHighPiiSensitivity
// ---------------------------------------------------------------------------

/**
 * Assert that an audit record carries `audit_sensitivity_level: high_pii`
 * as required by I-031 for research data export events.
 *
 * Throws with an explicit I-031 violation message on mismatch.
 *
 * Spec reference:
 *   I-031: "Every research data export emits an immutable audit record at
 *   audit_sensitivity_level: high_pii (not the ordinary Category B governance class)"
 *
 * Note: research.consent_granted / research.consent_revoked carry 'standard'
 * (not 'high_pii') per AUDIT_EVENTS v5.2 audit-sensitivity reconciliation note
 * (patch 2026-05-02). Only research.export_initiated and research.export_completed
 * carry 'high_pii'. Tests that check consent events must use 'standard'.
 *
 * @param record - The AuditRecord to check.
 */
export function assertHighPiiSensitivity(record: AuditRecord): void {
  if (record.audit_sensitivity_level !== 'high_pii') {
    throw new Error(
      `I-031 VIOLATION: audit record ${record.audit_id} (action=${record.action}) ` +
        `has audit_sensitivity_level='${record.audit_sensitivity_level}', expected 'high_pii'. ` +
        `Research data export events (research.export_initiated, research.export_completed) ` +
        `MUST carry audit_sensitivity_level='high_pii' per I-031.`,
    );
  }
}

// ---------------------------------------------------------------------------
// Internal utilities
// ---------------------------------------------------------------------------

/**
 * Canonical JSON serialization: keys sorted lexicographically, no whitespace.
 * Used for hash chain computation to guarantee deterministic output
 * regardless of insertion order.
 */
function canonicalSerialize(obj: unknown): string {
  if (obj === null || typeof obj !== 'object') {
    return JSON.stringify(obj);
  }
  if (Array.isArray(obj)) {
    return '[' + obj.map(canonicalSerialize).join(',') + ']';
  }
  const keys = Object.keys(obj as Record<string, unknown>).sort();
  const pairs = keys.map((k) => {
    const v = canonicalSerialize((obj as Record<string, unknown>)[k]);
    return `${JSON.stringify(k)}:${v}`;
  });
  return '{' + pairs.join(',') + '}';
}

function sha256(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}
