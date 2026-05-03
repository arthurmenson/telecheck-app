/**
 * Audit chain assertion helpers.
 *
 * Used by:
 *   - tests/integration/audit-chain.test.ts
 *   - tests/invariants/i003-audit-append-only.test.ts
 *   - Any test that must verify I-003 (audit append-only) or I-031
 *     (high_pii audit_sensitivity_level on research export events).
 *
 * Schema model:
 *   The `audit_records` table (migrations/002_audit_chain.sql) stores the
 *   AUDIT_EVENTS v5.2 envelope across discrete columns rather than as a
 *   single JSONB envelope blob. The mapping:
 *     envelope.timestamp           → recorded_at TIMESTAMPTZ
 *     envelope.detail              → payload JSONB
 *     envelope.hash_chain.partition       → COALESCE(target_patient_id, 'PLATFORM')
 *     envelope.hash_chain.sequence_number → sequence_number BIGINT
 *     envelope.hash_chain.previous_hash   → prev_hash BYTEA
 *     envelope.hash_chain.record_hash     → record_hash BYTEA
 *
 *   The hash chain is computed by the BEFORE INSERT trigger
 *   `audit_records_hash_insert` in migration 002 — callers SHOULD NOT supply
 *   prev_hash / record_hash / sequence_number; the trigger overwrites whatever
 *   is passed using its own canonical concat_ws('|', ...) serialization.
 *
 *   The chain walker here verifies LINK integrity (each record's prev_hash
 *   matches the previous record's record_hash within the same partition); it
 *   does NOT recompute record_hash from scratch (the trigger's canonicalization
 *   format would have to be mirrored here, which is not maintainable across
 *   schema additions). Tampering that breaks a link surfaces as an I-003
 *   violation; tampering that re-signs a forged record_hash without breaking a
 *   link is out of scope for this walker (it is the database trigger's
 *   responsibility — bypassing the trigger requires SUPERUSER or DISABLE
 *   TRIGGER, both of which are out of the application threat model).
 *
 * Spec references:
 *   - I-003 (audit trail is immutable and append-only; hash chain never broken)
 *   - I-027 (every audit record carries tenant_id)
 *   - I-031 (research data export emits at audit_sensitivity_level: high_pii)
 *   - AUDIT_EVENTS v5.2 §Audit record schema (envelope shape)
 *   - AUDIT_EVENTS v5.2 §Safety classification matrix (Category A/B/C)
 *
 * DEPENDS ON:
 *   - tests/setup.ts (getTestClient)
 *   - migrations/002_audit_chain.sql (audit_records table; trigger; append-only guard)
 */

import { getTestClient } from '../setup.ts';

import type { TenantId } from './tenant-fixtures.ts';

// ---------------------------------------------------------------------------
// AuditRecord — shape returned by the SELECT below; mirrors envelope semantics
// using DB column names. The hash_chain object is reconstructed client-side
// from the discrete columns so call sites that reason about it as an envelope
// (e.g., assertAuditChainIntact) can do so without touching the SQL details.
// ---------------------------------------------------------------------------

export interface AuditRecord {
  audit_id: string;
  /** Mirrors envelope.timestamp; sourced from `recorded_at TIMESTAMPTZ`. */
  timestamp: string;
  tenant_id: string;
  actor_type: string;
  actor_id: string;
  /**
   * Not a real column at v1.0 — kept on the interface for forward-compat with
   * AUDIT_EVENTS v5.2 envelope shape. Currently always `null` from the SELECT.
   */
  actor_tenant_id: string | null;
  target_patient_id: string | null;
  action: string;
  category: 'A' | 'B' | 'C';
  audit_sensitivity_level: 'standard' | 'high_pii';
  resource_type: string | null;
  resource_id: string | null;
  /** Mirrors envelope.detail; sourced from `payload JSONB`. */
  detail: Record<string, unknown>;
  ai_workload_type: string | null;
  autonomy_level: string | null;
  hash_chain: {
    partition: string;
    sequence_number: number;
    /** Hex-encoded SHA-256 of the previous record in this partition. */
    previous_hash: string;
    /** Hex-encoded SHA-256 of this record (computed by the DB trigger). */
    record_hash: string;
  };
}

/**
 * Canonical SELECT that aliases DB columns onto the envelope shape and
 * encodes the bytea hash columns as hex text. Used by every helper here so
 * the field-rename mapping lives in exactly one place.
 */
const ENVELOPE_SELECT = `
  SELECT
    audit_id,
    recorded_at::text                     AS timestamp,
    tenant_id,
    actor_type,
    actor_id,
    NULL::text                            AS actor_tenant_id,
    target_patient_id,
    action,
    category,
    audit_sensitivity_level,
    resource_type,
    resource_id,
    payload                               AS detail,
    ai_workload_type,
    autonomy_level,
    COALESCE(target_patient_id, 'PLATFORM') AS partition,
    sequence_number,
    encode(prev_hash, 'hex')              AS previous_hash,
    encode(record_hash, 'hex')            AS record_hash
  FROM audit_records
`;

interface RawRow {
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
  resource_type: string | null;
  resource_id: string | null;
  detail: Record<string, unknown>;
  ai_workload_type: string | null;
  autonomy_level: string | null;
  partition: string;
  sequence_number: number | string;
  previous_hash: string;
  record_hash: string;
}

function rawRowToAuditRecord(row: RawRow): AuditRecord {
  return {
    audit_id: row.audit_id,
    timestamp: row.timestamp,
    tenant_id: row.tenant_id,
    actor_type: row.actor_type,
    actor_id: row.actor_id,
    actor_tenant_id: row.actor_tenant_id,
    target_patient_id: row.target_patient_id,
    action: row.action,
    category: row.category,
    audit_sensitivity_level: row.audit_sensitivity_level,
    resource_type: row.resource_type,
    resource_id: row.resource_id,
    detail: row.detail,
    ai_workload_type: row.ai_workload_type,
    autonomy_level: row.autonomy_level,
    hash_chain: {
      partition: row.partition,
      // pg returns BIGINT as a string by default; cast to number for the test surface.
      sequence_number:
        typeof row.sequence_number === 'string'
          ? Number.parseInt(row.sequence_number, 10)
          : row.sequence_number,
      previous_hash: row.previous_hash,
      record_hash: row.record_hash,
    },
  };
}

// ---------------------------------------------------------------------------
// assertAuditChainIntact
// ---------------------------------------------------------------------------

/**
 * Walk all audit records for `tenantId` ordered by partition + sequence_number
 * and verify that the SHA-256 hash chain LINKS are intact:
 *   for each record after the first in a partition,
 *     record.hash_chain.previous_hash MUST equal the prior record.hash_chain.record_hash.
 *
 * Throws with a precise message identifying the first broken link:
 *   "I-003 VIOLATION: audit chain broken at audit_id=<id>: ..."
 *
 * The first record in a partition uses a genesis seed derived by the DB
 * trigger as `digest('GENESIS:' || partition_key, 'sha256')`. Tests that need
 * to check the genesis derivation explicitly should compute that value
 * themselves; the walker only requires the genesis previous_hash to be
 * non-empty (the trigger will not insert a NULL).
 *
 * @param tenantId - Tenant whose audit records are walked.
 */
export async function assertAuditChainIntact(tenantId: TenantId): Promise<void> {
  const client = getTestClient();

  const result = await client.query<RawRow>(
    `${ENVELOPE_SELECT} WHERE tenant_id = $1 ORDER BY COALESCE(target_patient_id, 'PLATFORM'), sequence_number`,
    [tenantId],
  );

  const records = result.rows.map(rawRowToAuditRecord);
  if (records.length === 0) {
    return; // No records to walk — vacuously intact.
  }

  // Group by partition to walk each chain independently.
  const partitions = new Map<string, AuditRecord[]>();
  for (const rec of records) {
    const partition = rec.hash_chain.partition;
    let chain = partitions.get(partition);
    if (chain === undefined) {
      chain = [];
      partitions.set(partition, chain);
    }
    chain.push(rec);
  }

  for (const [partition, chain] of partitions) {
    // Track the previous record's record_hash. For the first record we accept
    // whatever previous_hash the trigger wrote (the trigger uses a genesis
    // seed derived from the partition key — verifying the seed value would
    // require duplicating the trigger's text format here).
    let expectedPreviousHash: string | null = null;

    for (const rec of chain) {
      if (rec.hash_chain.previous_hash === undefined || rec.hash_chain.previous_hash.length === 0) {
        throw new Error(
          `I-003 VIOLATION: audit record ${rec.audit_id} (partition=${partition}, ` +
            `seq=${rec.hash_chain.sequence_number}) has empty previous_hash. ` +
            'The DB trigger should have written a genesis seed or a real prior hash.',
        );
      }

      if (expectedPreviousHash !== null && rec.hash_chain.previous_hash !== expectedPreviousHash) {
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

  const result = await client.query<RawRow>(
    `${ENVELOPE_SELECT} WHERE tenant_id = $1 ORDER BY recorded_at DESC`,
    [tenantId],
  );

  const records = result.rows.map(rawRowToAuditRecord);
  const match = records.find(predicate);
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
