/**
 * tests/perf/audit/emit-audit.bench.ts — DB-backed perf bench for
 * `emitAudit` hash-chain append (Sprint 17 / TLC-027 EXECUTE).
 *
 * The first DB-backed bench scenario in the corpus. Validates that the
 * Sprint 17 bench-mode infrastructure (real `pg.Pool` via `setBenchPool`
 * + tracked `schema_migrations_bench` apply + URL canonicalization +
 * always-on setupFiles with `requireBenchDb()` gate) actually works
 * end-to-end against a real Postgres before Sprint 18+ adds more
 * scenarios.
 *
 * Bench scenario:
 *   §9 happy-path single-row append — the canonical `emitAudit`
 *     production path: build envelope, BEGIN, INSERT (with BEFORE-
 *     INSERT trigger recomputing hash chain under
 *     `pg_advisory_xact_lock`), RETURNING, COMMIT. State accumulates
 *     across iterations (audit_records grows) but hash-chain extend
 *     is roughly constant per row (FOR UPDATE on the latest partition
 *     row), so accumulation does NOT bias measurements.
 *
 * Threshold: §9 entry in `tests/perf/check-thresholds.ts` THRESHOLDS
 * is initially generous (50000μs = 50ms) — DB-backed scenarios on
 * shared CI runners with disk + network latency are slower than pure-
 * function. Sprint 18+ tightens after observing CI variance, per the
 * Sprint 13 / TLC-026 + TLC-023c §3 threshold-tightening worksheet
 * pattern.
 *
 * Fail-closed gate: `requireBenchDb()` throws at module-load if
 * BENCH_DATABASE_URL is unset. Closes Codex r10-A — DB-backed bench
 * cannot silently fall back to dev DB.
 *
 * Spec references:
 *   - ORT v1.5 OR-218 (Tier 1 launch-blocking)
 *   - I-003 (audit append-only — bench writes are append-only)
 *   - I-027 (audit_records carry tenant_id — bench seeds Telecheck-US)
 *   - migration 002_audit_chain.sql (hash chain trigger; advisory lock
 *     per partition — what r10-B closure preserves real lifetime for)
 *   - tests/perf/db/setup.ts (bench-mode setup — applies migrations,
 *     seeds Telecheck-US tenant, installs setBenchPool)
 *   - src/lib/db.ts setBenchPool (real pg.Pool override — Sprint 17 NEW)
 *   - tests/perf/check-thresholds.ts THRESHOLDS §9 entry
 *   - docs/TLC-027-DB-BENCH-INFRA-ESCALATION.md (acceptance criteria)
 */

import { bench, describe } from 'vitest';

import { type AuditDbClient, type AuditEnvelopeInput, emitAudit } from '../../../src/lib/audit.ts';
import { withTransaction } from '../../../src/lib/db.ts';
import { asTenantId, type TenantId } from '../../../src/lib/glossary.ts';
import { withTenantContext } from '../../../src/lib/rls.ts';
import { BENCH_APP_ROLE_NAME, requireBenchDb } from '../db/setup.ts';

// r10-A closure: fail-fast at bench-file load if BENCH_DATABASE_URL is
// unset. The `.db.bench.ts` naming convention + the vitest.bench.config
// glob exclusion (Sprint 17 fix-forward) ensures this file isn't loaded
// by the default perf.yml workflow; only the planned Sprint 18+
// perf-db.yml workflow (with BENCH_DATABASE_URL set + Postgres service
// container) loads it.
requireBenchDb();

// ---------------------------------------------------------------------------
// Bench fixture builder
// ---------------------------------------------------------------------------

const T_US: TenantId = asTenantId('Telecheck-US');

/**
 * Minimum-valid Category C operational audit envelope. Same shape as
 * `tests/integration/audit-emit.test.ts` baseInput() but specialized
 * for bench:
 *   - target_patient_id includes a per-iteration unique-enough suffix
 *     so the hash chain partition stays bounded; if all iterations
 *     write to the same partition, the table grows but the chain
 *     pre-lookup `ORDER BY sequence_number DESC LIMIT 1` is still
 *     constant-time given the (partition, sequence_number DESC) index.
 *   - resource_id randomized to avoid accidental UNIQUE violations
 *     downstream when constraint-bearing migrations exist.
 */
function buildBenchInput(): AuditEnvelopeInput {
  // Single shared partition to test the steady-state hash-chain
  // append cost (the production hot path is "Nth row on an existing
  // chain", not "first row in a new chain"). Sprint 18+ may add a
  // second scenario for cold-path (per-iteration unique partition).
  const partitionId = 'pat_bench_steady_001';
  const resourceSuffix = Math.random().toString(36).slice(2, 10);
  return {
    timestamp: new Date().toISOString(),
    tenant_id: T_US,
    actor_type: 'patient',
    actor_id: 'usr_bench_patient_001',
    actor_tenant_id: null,
    target_patient_id: partitionId,
    delegate_context: null,
    action: 'consent_granted',
    category: 'C',
    audit_sensitivity_level: 'standard',
    resource_type: 'consent_record',
    resource_id: `cnst_bench_${resourceSuffix}`,
    detail: { bench: true },
    engine_versions: null,
    ai_workload_type: null,
    autonomy_level: null,
    agent_id: null,
    agent_version: null,
    tool_call_id: null,
    memory_read_set_id: null,
    memory_write_set_id: null,
    supervising_policy_id: null,
    knowledge_source_versions: null,
    signals: null,
    override: null,
    linked_events: [],
    compliance_flags: [],
    country_of_care: 'US',
    break_glass: null,
  };
}

// ---------------------------------------------------------------------------
// Bench scenarios
// ---------------------------------------------------------------------------

describe('emitAudit — DB-backed perf', () => {
  bench(
    '§9 emit-audit happy-path single-row append on existing chain',
    async () => {
      // Production-equivalent code path:
      //   1. withTransaction → BEGIN
      //   2. SET LOCAL ROLE telecheck_bench_app — drop superuser
      //      privilege for the iteration so RLS APPLIES (Codex r11-3
      //      closure; bench measures the constrained path the
      //      production app role takes, not a privileged bypass).
      //      LOCAL means the role auto-resets at COMMIT/ROLLBACK; the
      //      pool gets a fresh-tenant connection back for the next
      //      iteration without leaked role state.
      //   3. withTenantContext('Telecheck-US', ...) — sets RLS
      //      session variable so audit_records INSERT passes the RLS
      //      tenant_id-filter policy.
      //   4. emitAudit → INSERT → BEFORE-INSERT trigger fires hash-chain
      //      computation under pg_advisory_xact_lock → RETURNING reads
      //      back trigger-authoritative columns.
      //   5. COMMIT (releases advisory lock; LOCAL role auto-resets).
      //
      // Real pg_advisory_xact_lock per-iteration lifetime per Codex
      // r10-B closure (setBenchPool returns real pool).
      await withTransaction(async (tx) => {
        await tx.query(`SET LOCAL ROLE ${BENCH_APP_ROLE_NAME}`);
        await withTenantContext(tx, 'Telecheck-US', async () => {
          await emitAudit(buildBenchInput(), tx as unknown as AuditDbClient);
        });
      });
    },
    {
      // Lower iterations than pure-function benches (DB roundtrip +
      // RLS context-set + advisory-lock acquire-release dominates
      // wall time). Vitest still aggregates statistically over the
      // bench window.
      iterations: 50,
      warmupIterations: 5,
    },
  );
});
