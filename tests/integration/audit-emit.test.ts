/**
 * `lib/audit.ts emitAudit()` — direct integration tests.
 *
 * Until this commit `emitAudit` was exercised only INDIRECTLY through
 * forms-intake-publish.test.ts (and the broader forms-intake suite,
 * via the typed-placeholder helper). The Zod input validation,
 * I-012 closure rule, sentinel-misuse gates, RESEARCH_HIGH_PII
 * auto-enforcement (I-031), production-tx durability gate (I-003), and
 * hash-chain envelope construction were all under test but only via
 * happy-path emissions. None of the FAILURE modes were directly
 * asserted.
 *
 * Why this matters:
 *   `emitAudit` is the single point through which every audit record
 *   in the platform flows. The validation gates inside it ARE the
 *   audit-shape contract — if any of them silently fall through, the
 *   chain stores ill-formed records that the chain walker can't verify
 *   (or worse, accepts records that I-012/I-031 say must be rejected).
 *   Integration tests exercising failures end-to-end is the only
 *   honest way to pin those gates.
 *
 * Coverage in this file:
 *   1. Zod required-field validation — empty tenant_id/actor_id/etc.
 *      throw with the I-003 forbidden-suppression citation.
 *   2. I-012 closure rule — actions in I012_ACTION_CLASS_SET require
 *      ai_workload_type + autonomy_level (use 'n/a' sentinel for
 *      clinician-only); missing fields throw with the §I-012 closure
 *      rule citation.
 *   3. Sentinel rules — `rejected_invalid_attempt` only on
 *      `*.execution_rejected`; `n/a` on workload only when
 *      actor_type != 'ai_workload'.
 *   4. Reserved workload/autonomy types — `autonomous_agent`,
 *      `multi_agent_supervisor`, `tool_using_agent`,
 *      `action_with_audit_only`, `fully_autonomous` all rejected on
 *      successful records; reserved autonomy levels are PERMITTED on
 *      `*.execution_rejected` records (so the rejection envelope can
 *      record what was attempted).
 *   5. RESEARCH_HIGH_PII auto-enforcement (I-031) — `research.export_*`
 *      events with `audit_sensitivity_level='standard'` throw with the
 *      I-031 citation.
 *   6. Production durability gate (I-003) — no tx in non-test env →
 *      throws; in-memory `_emissionLog` only ever fires under
 *      NODE_ENV=test (verified via `assertAuditEmittedFor`).
 *   7. Hash chain envelope construction — first record in a partition
 *      gets genesis hash + sequence_number=1; partition key is
 *      `tenant_id:<patient_id|PLATFORM>`.
 *   8. Real DB persistence — INSERT lands in audit_records;
 *      INSERT...RETURNING reads trigger-authoritative values back into
 *      the wire envelope.
 *
 * Spec references:
 *   - I-003 (audit append-only; bare suppression forbidden)
 *   - I-012 (clinician sign-off required for prescribing-class actions;
 *     closure rule requires ai_workload_type + autonomy_level on every
 *     I-012 record)
 *   - I-027 (every audit record carries tenant_id)
 *   - I-031 (research export events at audit_sensitivity_level=high_pii)
 *   - AUDIT_EVENTS v5.2 §I-012 closure rule, §sentinel rules
 *   - WORKLOAD_TAXONOMY v5.2 §3 (reserved workload types)
 *   - AUTONOMY_LEVELS v5.2 §3 (reserved autonomy levels)
 *   - migration 002_audit_chain.sql (audit_records table + BEFORE INSERT
 *     trigger that recomputes hash chain under pg_advisory_xact_lock)
 */

import crypto from 'node:crypto';

import { afterEach, describe, expect, it } from 'vitest';

import {
  type AuditDbClient,
  type AuditEnvelopeInput,
  assertAuditEmittedFor,
  emitAudit,
} from '../../src/lib/audit.ts';
import { asTenantId, type TenantId } from '../../src/lib/glossary.ts';
import { TENANT_GHANA, TENANT_US, withTenantContext } from '../helpers/tenant-fixtures.ts';
import { getTestClient } from '../setup.ts';

/**
 * Compute the canonical genesis hash for a partition. Mirrors the
 * `computeGenesisHash` helper in audit.ts and the DB trigger's seed
 * (migration 002 audit_records_hash_insert): SHA-256 of
 * `'GENESIS:' || partition_key`. Used by the genesis-equality tests to
 * assert the actual emitted hex matches the canonical derivation —
 * a bare hex-shape check would pass for any 64-char hex digest.
 *
 * (Codex r0 MED closure 2026-05-04: the prior genesis test only
 * asserted /^[0-9a-f]{64}$/ shape; a trigger regression that used the
 * wrong seed, omitted tenant from the partition, or produced any hex
 * digest at all would have passed silently.)
 */
function computeGenesisHashHex(partitionKey: string): string {
  return crypto.createHash('sha256').update(`GENESIS:${partitionKey}`).digest('hex');
}

// `TENANT_US` / `TENANT_GHANA` come from tenant-fixtures.ts as plain
// strings; the `AuditEnvelopeInput.tenant_id` field is the branded
// `TenantId` type from glossary.ts. Cast once at module scope so each
// test can use the branded values directly.
const T_US: TenantId = asTenantId(TENANT_US);
const T_GHANA: TenantId = asTenantId(TENANT_GHANA);

// ---------------------------------------------------------------------------
// Common helpers
// ---------------------------------------------------------------------------

/**
 * Build a minimum-valid Category C operational audit input. Specific tests
 * override only the fields they're exercising; the baseline is benign so
 * a passing baseline + a failing override clearly attribute the failure
 * to the override.
 */
function baseInput(overrides: Partial<AuditEnvelopeInput> = {}): AuditEnvelopeInput {
  return {
    timestamp: new Date().toISOString(),
    tenant_id: T_US,
    actor_type: 'patient',
    actor_id: 'usr_test_patient_001',
    actor_tenant_id: null,
    target_patient_id: 'pat_test_001',
    delegate_context: null,
    action: 'consent_granted', // canonical Category C; not in I-012 set; not high_pii
    category: 'C',
    audit_sensitivity_level: 'standard',
    resource_type: 'consent_record',
    resource_id: `cnst_${Math.random().toString(36).slice(2, 12)}`,
    detail: { test: true },
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
    ...overrides,
  };
}

/** Cast getTestClient() to the AuditDbClient shape the lib expects. */
function getTx(): AuditDbClient {
  return getTestClient() as unknown as AuditDbClient;
}

afterEach(() => {
  // The shared-client savepoint in tests/setup.ts undoes any audit_records
  // INSERTs from the previous test. The in-memory _emissionLog from
  // audit.ts is process-global and persists across tests — we don't reset
  // it here because each test asserts against its OWN unique resource_id,
  // so cross-test leakage doesn't cause false positives.
});

// ---------------------------------------------------------------------------
// 1. Zod required-field validation
// ---------------------------------------------------------------------------

describe('emitAudit — Zod required-field validation', () => {
  it('throws when tenant_id is empty (I-027)', async () => {
    await expect(emitAudit(baseInput({ tenant_id: '' as unknown as TenantId }))).rejects.toThrow(
      /tenant_id is required on every audit record \(I-027\)/,
    );
  });

  it('throws when actor_id is empty', async () => {
    await expect(emitAudit(baseInput({ actor_id: '' }))).rejects.toThrow(/actor_id/);
  });

  it('throws when actor_type is empty', async () => {
    await expect(
      emitAudit(baseInput({ actor_type: '' as unknown as AuditEnvelopeInput['actor_type'] })),
    ).rejects.toThrow(/actor_type/);
  });

  it('throws when action is empty', async () => {
    await expect(emitAudit(baseInput({ action: '' as never }))).rejects.toThrow(/action/);
  });

  it('throws when resource_type is empty', async () => {
    await expect(emitAudit(baseInput({ resource_type: '' }))).rejects.toThrow(/resource_type/);
  });

  it('throws when resource_id is empty', async () => {
    await expect(emitAudit(baseInput({ resource_id: '' }))).rejects.toThrow(/resource_id/);
  });

  it('throws when category is not A | B | C', async () => {
    await expect(emitAudit(baseInput({ category: 'X' as unknown as 'A' }))).rejects.toThrow();
  });

  it('throws when audit_sensitivity_level is not standard | high_pii', async () => {
    await expect(
      emitAudit(baseInput({ audit_sensitivity_level: 'private' as unknown as 'standard' })),
    ).rejects.toThrow();
  });

  it('throws when country_of_care is not 2 chars (ISO 3166-1 alpha-2)', async () => {
    await expect(emitAudit(baseInput({ country_of_care: 'USA' }))).rejects.toThrow(
      /country_of_care must be ISO 3166-1 alpha-2/,
    );
    await expect(emitAudit(baseInput({ country_of_care: 'U' }))).rejects.toThrow(
      /country_of_care must be ISO 3166-1 alpha-2/,
    );
  });

  it('ACCEPTS target_patient_id === null (platform-scope events)', async () => {
    // Patch v0.4 closure: prior schema rejected null and forced callers
    // to pass an empty string that itself failed min(1). Pinning the
    // null acceptance so it doesn't regress.
    const env = await emitAudit(
      baseInput({
        target_patient_id: null,
        action: 'config_change_validated',
        resource_type: 'config',
        category: 'B',
      }),
    );
    expect(env.target_patient_id).toBeNull();
  });

  it('error message cites the I-003 bare-suppression rule', async () => {
    try {
      await emitAudit(baseInput({ tenant_id: '' as unknown as TenantId }));
      expect.fail('expected throw');
    } catch (err) {
      expect((err as Error).message).toMatch(/I-003 forbids suppression/);
    }
  });

  it('throws when timestamp is empty', async () => {
    await expect(emitAudit(baseInput({ timestamp: '' }))).rejects.toThrow(/timestamp/);
  });

  it('throws when detail is not an object (Zod z.record)', async () => {
    await expect(
      emitAudit(
        baseInput({
          detail: 'not-an-object' as unknown as Record<string, unknown>,
        }),
      ),
    ).rejects.toThrow(/detail/);
  });

  // -----------------------------------------------------------------------
  // SPEC ISSUE — schema-not-validated fields (Codex r0 HIGH closure)
  //
  // The Zod schema in audit.ts currently validates 12 fields. The
  // remaining envelope fields (timestamp format beyond non-empty,
  // linked_events array shape, compliance_flags array shape, ai context
  // bundle, engine_versions, signals, override, break_glass) are
  // TypeScript-typed but NOT runtime-validated. A regression upstream
  // that produces e.g. `linked_events: 'malformed'` would silently
  // pass Zod and reach the DB INSERT, where it'd either fail at JSON
  // serialization or land malformed in the row.
  //
  // Tests below PIN current schema-permissive behavior — when the
  // schema is tightened (Engineering Lead amendment), each test flips
  // from permissive to strict. The test names start with "SPEC ISSUE:"
  // so they're grep-able.
  // -----------------------------------------------------------------------

  it('SPEC ISSUE: malformed timestamp (non-ISO) currently PASSES Zod (only min(1) checked)', async () => {
    // The schema validates `timestamp: z.string().min(1)` — a
    // non-empty string passes, even if it isn't a valid ISO 8601
    // timestamp. Pinning so a future tightening of the schema (e.g.
    // `z.string().datetime()`) is a deliberate change.
    const env = await emitAudit(baseInput({ timestamp: 'not-iso-format' }));
    expect(env.timestamp).toBe('not-iso-format');
  });

  it('SPEC ISSUE: linked_events as a non-array currently PASSES Zod (field not in schema)', async () => {
    // linked_events is TypeScript-typed as AuditLinkedEvent[] but the
    // Zod schema doesn't include it. A buggy producer of `linked_events:
    // 'oops'` would slip through. Pinning so the gap is grep-able.
    // Cast through unknown to bypass TS — the runtime is what we're testing.
    const env = await emitAudit(
      baseInput({
        linked_events: 'not-an-array' as unknown as AuditEnvelopeInput['linked_events'],
      }),
    );
    expect(env).toBeDefined();
  });

  it('SPEC ISSUE: compliance_flags as a non-array currently PASSES Zod (field not in schema)', async () => {
    const env = await emitAudit(
      baseInput({
        compliance_flags: 'not-an-array' as unknown as AuditEnvelopeInput['compliance_flags'],
      }),
    );
    expect(env).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// 2. I-012 closure rule — workload field validation
// ---------------------------------------------------------------------------

describe('emitAudit — I-012 closure rule', () => {
  // I-012 action-class set per AUDIT_EVENTS v5.2 §I-012 closure rule
  // (lib/audit.ts I012_ACTION_CLASS_SET).
  const I012_ACTIONS = [
    'prescribing.initiated',
    'prescribing.approved',
    'prescribing.declined',
    'prescribing.modified',
    'refill.approved',
    'refill.declined',
    'protocol_authorized_prescribing',
    'protocol_authorized_refill_renewal',
    'protocol_authorized_dispensing_release',
  ] as const;

  for (const action of I012_ACTIONS) {
    it(`throws when ai_workload_type is null on I-012 action "${action}"`, async () => {
      await expect(
        emitAudit(
          baseInput({
            action,
            category: 'A',
            actor_type: 'clinician',
            ai_workload_type: null,
            autonomy_level: 'n/a',
          }),
        ),
      ).rejects.toThrow(/I-012 closure rule violation: ai_workload_type is required/);
    });

    it(`throws when autonomy_level is null on I-012 action "${action}"`, async () => {
      await expect(
        emitAudit(
          baseInput({
            action,
            category: 'A',
            actor_type: 'clinician',
            ai_workload_type: 'n/a',
            autonomy_level: null,
          }),
        ),
      ).rejects.toThrow(/I-012 closure rule violation: autonomy_level is required/);
    });
  }

  it('ACCEPTS clinician-only I-012 record with both fields = "n/a"', async () => {
    // The documented use of the n/a sentinel: clinician-only approvals
    // with no AI workload upstream.
    const env = await emitAudit(
      baseInput({
        action: 'prescribing.approved',
        category: 'A',
        actor_type: 'clinician',
        ai_workload_type: 'n/a',
        autonomy_level: 'n/a',
      }),
    );
    expect(env.ai_workload_type).toBe('n/a');
    expect(env.autonomy_level).toBe('n/a');
  });

  it('ACCEPTS protocol-execution I-012 record with action_with_confirm', async () => {
    const env = await emitAudit(
      baseInput({
        action: 'prescribing.initiated',
        category: 'A',
        actor_type: 'clinician',
        ai_workload_type: 'protocol_execution',
        autonomy_level: 'action_with_confirm',
      }),
    );
    expect(env.ai_workload_type).toBe('protocol_execution');
  });

  it('error cites AUDIT_EVENTS v5.2 §I-012 closure rule', async () => {
    try {
      await emitAudit(
        baseInput({
          action: 'prescribing.approved',
          category: 'A',
          actor_type: 'clinician',
          ai_workload_type: null,
          autonomy_level: 'n/a',
        }),
      );
      expect.fail('expected throw');
    } catch (err) {
      expect((err as Error).message).toMatch(/AUDIT_EVENTS v5\.2 §I-012 closure rule/);
    }
  });
});

// ---------------------------------------------------------------------------
// 3. Sentinel rules
// ---------------------------------------------------------------------------

describe('emitAudit — sentinel rules', () => {
  it('throws when "rejected_invalid_attempt" workload appears on a non-rejection I-012 record', async () => {
    await expect(
      emitAudit(
        baseInput({
          action: 'prescribing.approved',
          category: 'A',
          actor_type: 'clinician',
          ai_workload_type: 'rejected_invalid_attempt',
          autonomy_level: 'n/a',
        }),
      ),
    ).rejects.toThrow(
      /Sentinel "rejected_invalid_attempt" is only valid on \*\.execution_rejected/,
    );
  });

  it('throws when "rejected_invalid_attempt" autonomy appears on a non-rejection I-012 record', async () => {
    await expect(
      emitAudit(
        baseInput({
          action: 'refill.approved',
          category: 'A',
          actor_type: 'clinician',
          ai_workload_type: 'n/a',
          autonomy_level: 'rejected_invalid_attempt',
        }),
      ),
    ).rejects.toThrow(
      /Sentinel "rejected_invalid_attempt" is only valid on \*\.execution_rejected/,
    );
  });

  it('ACCEPTS "rejected_invalid_attempt" on prescribing.execution_rejected', async () => {
    const env = await emitAudit(
      baseInput({
        action: 'prescribing.execution_rejected',
        category: 'A',
        actor_type: 'clinician',
        ai_workload_type: 'rejected_invalid_attempt',
        autonomy_level: 'rejected_invalid_attempt',
      }),
    );
    expect(env.ai_workload_type).toBe('rejected_invalid_attempt');
    expect(env.autonomy_level).toBe('rejected_invalid_attempt');
  });

  it('throws when "n/a" workload paired with actor_type=ai_workload (sentinel contradiction)', async () => {
    await expect(
      emitAudit(
        baseInput({
          action: 'prescribing.initiated',
          category: 'A',
          actor_type: 'ai_workload',
          ai_workload_type: 'n/a',
          autonomy_level: 'action_with_confirm',
        }),
      ),
    ).rejects.toThrow(/Sentinel "n\/a" for ai_workload_type is only valid for clinician-only/);
  });
});

// ---------------------------------------------------------------------------
// 4. Reserved workload / autonomy types
// ---------------------------------------------------------------------------

describe('emitAudit — reserved workload / autonomy types', () => {
  for (const wl of ['autonomous_agent', 'multi_agent_supervisor', 'tool_using_agent'] as const) {
    it(`throws when reserved workload type "${wl}" appears on a successful record`, async () => {
      await expect(
        emitAudit(
          baseInput({
            action: 'prescribing.approved',
            category: 'A',
            actor_type: 'ai_workload',
            ai_workload_type: wl,
            autonomy_level: 'action_with_confirm',
          }),
        ),
      ).rejects.toThrow(
        new RegExp(`Reserved ai_workload_type "${wl}" cannot appear on audit records at v1\\.0`),
      );
    });
  }

  for (const lvl of ['action_with_audit_only', 'fully_autonomous'] as const) {
    it(`throws when reserved autonomy level "${lvl}" appears on a successful record`, async () => {
      await expect(
        emitAudit(
          baseInput({
            action: 'prescribing.approved',
            category: 'A',
            actor_type: 'clinician',
            ai_workload_type: 'protocol_execution',
            autonomy_level: lvl,
          }),
        ),
      ).rejects.toThrow(
        new RegExp(`Reserved autonomy_level "${lvl}" cannot appear on audit records at v1\\.0`),
      );
    });
  }

  it('ALLOWS reserved autonomy level on *.execution_rejected (rejection envelope records what was attempted)', async () => {
    // The whole point of execution_rejected events: capture the attempted
    // (and now-rejected) state. Reserved levels are valid IN THIS CONTEXT
    // because the rejection IS the safety guard, not the absence of the
    // attempt. Pinning so the carve-out for execution_rejected doesn't
    // accidentally regress to "all reserved values forbidden".
    const env = await emitAudit(
      baseInput({
        action: 'prescribing.execution_rejected',
        category: 'A',
        actor_type: 'clinician',
        ai_workload_type: 'rejected_invalid_attempt',
        autonomy_level: 'fully_autonomous', // attempted-but-rejected
      }),
    );
    expect(env.autonomy_level).toBe('fully_autonomous');
  });

  // -----------------------------------------------------------------------
  // ASYMMETRY PIN — reserved workload values are STILL rejected on
  // *.execution_rejected (Codex r0 HIGH closure)
  //
  // The reserved-value carve-out for execution_rejected applies ONLY to
  // autonomy levels (the implementation has `&& !isExecutionRejected` on
  // the autonomy check, but NOT on the workload check). The asymmetry is
  // documented in i012-gate.ts `resolveEnvelopeWorkloadType` /
  // `resolveEnvelopeAutonomyLevel`:
  //
  //   - resolveEnvelopeWorkloadType ERASES reserved workload values to
  //     the `rejected_invalid_attempt` sentinel before audit emission.
  //   - resolveEnvelopeAutonomyLevel PRESERVES reserved autonomy values.
  //
  // So the canonical pattern for *.execution_rejected with a reserved
  // attempted workload is: workload='rejected_invalid_attempt' (sentinel)
  // + autonomy=<attempted reserved value>. The tests below pin BOTH
  // sides of this contract (tested already on autonomy above; tested
  // here for workload).
  // -----------------------------------------------------------------------

  for (const wl of ['autonomous_agent', 'multi_agent_supervisor', 'tool_using_agent'] as const) {
    it(`STILL throws when reserved workload "${wl}" appears on *.execution_rejected (asymmetry pin — workload is erased, autonomy is preserved)`, async () => {
      // The validation gate doesn't make a carve-out for workload on
      // execution_rejected; reserved workload values must arrive as the
      // sentinel `rejected_invalid_attempt` instead. If a future change
      // adds the same `&& !isExecutionRejected` carve-out to workload,
      // this test fails and the asymmetry change is deliberate.
      await expect(
        emitAudit(
          baseInput({
            action: 'prescribing.execution_rejected',
            category: 'A',
            actor_type: 'clinician',
            ai_workload_type: wl,
            autonomy_level: 'rejected_invalid_attempt',
          }),
        ),
      ).rejects.toThrow(
        new RegExp(`Reserved ai_workload_type "${wl}" cannot appear on audit records at v1\\.0`),
      );
    });
  }
});

// ---------------------------------------------------------------------------
// 5. RESEARCH_HIGH_PII auto-enforcement (I-031)
// ---------------------------------------------------------------------------

describe('emitAudit — RESEARCH_HIGH_PII enforcement (I-031)', () => {
  for (const action of ['research.export_initiated', 'research.export_completed'] as const) {
    it(`throws when "${action}" carries audit_sensitivity_level='standard' (must be high_pii)`, async () => {
      await expect(
        emitAudit(
          baseInput({
            action,
            category: 'B',
            audit_sensitivity_level: 'standard',
            actor_type: 'operator',
            actor_id: 'usr_research_steward',
            target_patient_id: null,
            resource_type: 'research_export',
          }),
        ),
      ).rejects.toThrow(
        new RegExp(`I-031 violation: research export event "${action.replace('.', '\\.')}"`),
      );
    });

    it(`ACCEPTS "${action}" with audit_sensitivity_level='high_pii'`, async () => {
      const env = await emitAudit(
        baseInput({
          action,
          category: 'B',
          audit_sensitivity_level: 'high_pii',
          actor_type: 'operator',
          actor_id: 'usr_research_steward',
          target_patient_id: null,
          resource_type: 'research_export',
        }),
      );
      expect(env.audit_sensitivity_level).toBe('high_pii');
    });
  }
});

// ---------------------------------------------------------------------------
// 6. Production durability gate (I-003)
// ---------------------------------------------------------------------------

describe('emitAudit — production durability gate (I-003)', () => {
  it('NODE_ENV=test allows in-memory emission (no tx)', async () => {
    // Test environment: omitting tx falls through to _emissionLog.
    // assertAuditEmittedFor surfaces the in-memory log.
    expect(process.env['NODE_ENV']).toBe('test');
    const id = `res_${Math.random().toString(36).slice(2, 12)}`;
    await emitAudit(baseInput({ resource_id: id }));
    // Won't throw — the assertion finds the log entry.
    assertAuditEmittedFor(id, 'consent_granted');
  });

  it('non-test NODE_ENV refuses emission without tx (I-003 violation)', async () => {
    const original = process.env['NODE_ENV'];
    try {
      process.env['NODE_ENV'] = 'production';
      await expect(emitAudit(baseInput())).rejects.toThrow(
        /I-003 requires same-transaction durable persistence/,
      );
    } finally {
      process.env['NODE_ENV'] = original;
    }
  });

  it('non-test NODE_ENV emits cleanly when tx is provided', async () => {
    const original = process.env['NODE_ENV'];
    try {
      process.env['NODE_ENV'] = 'production';
      const id = `res_prod_${Math.random().toString(36).slice(2, 12)}`;
      await withTenantContext(TENANT_US, async () => {
        const env = await emitAudit(baseInput({ resource_id: id }), getTx());
        expect(env.resource_id).toBe(id);
        // Hash chain populated with trigger-authoritative values from RETURNING.
        expect(env.hash_chain.record_hash).toMatch(/^[0-9a-f]{64}$/);
        expect(env.hash_chain.previous_hash).toMatch(/^[0-9a-f]{64}$/);
        expect(env.hash_chain.sequence_number).toBeGreaterThanOrEqual(1);
      });
    } finally {
      process.env['NODE_ENV'] = original;
    }
  });
});

// ---------------------------------------------------------------------------
// 7. Hash chain envelope construction
// ---------------------------------------------------------------------------

describe('emitAudit — hash chain envelope construction', () => {
  it('first record in a partition gets sequence_number=1 + EXACT genesis previous_hash', async () => {
    // Codex r0 MED closure: assert the EXACT SHA-256 derivation, not
    // just hex-shape. Previously a trigger regression using the wrong
    // seed (or omitting tenant from the partition) would have produced
    // a different hex digest and silently passed.
    const uniquePatient = `pat_genesis_${Math.random().toString(36).slice(2, 10)}`;
    const partitionKey = `${TENANT_US}:${uniquePatient}`;
    const expectedGenesis = computeGenesisHashHex(partitionKey);
    await withTenantContext(TENANT_US, async () => {
      const env = await emitAudit(
        baseInput({
          target_patient_id: uniquePatient,
          resource_id: `cnst_genesis_${uniquePatient}`,
        }),
        getTx(),
      );
      expect(env.hash_chain.sequence_number).toBe(1);
      expect(env.hash_chain.previous_hash).toBe(expectedGenesis);
      expect(env.hash_chain.partition).toBe(partitionKey);
    });
  });

  it('platform-scope genesis: SHA-256("GENESIS:<tenant>:PLATFORM")', async () => {
    // Sprint 30 / TLC-050 fix (Codex Sprint 30 verification of Agent X
    // diagnosis): use a unique throwaway tenant per test invocation so
    // the partition key `${tenant}:PLATFORM` cannot collide with any
    // other test in the run that emits a platform-scope audit record.
    //
    // Why this is the right fix: the trigger at
    // migrations/002_audit_chain.sql:480-506 partitions hash chains by
    // `tenant_id || ':' || COALESCE(target_patient_id, 'PLATFORM')`.
    // The patient-scope sibling test at line 659 already correctly
    // uses a `uniquePatient` random suffix to avoid cross-test
    // collision; this test was the only hash-chain-genesis test using
    // a fixed `TENANT_US:PLATFORM` partition. Randomizing the
    // resource_id (which is NOT part of the partition key) doesn't
    // isolate the partition. Codex Sprint 30 verification ruled out
    // the RELEASE SAVEPOINT cross-test theory; the real cause is
    // partition-key non-uniqueness in this single test fixture.
    //
    // Fresh-tenant insertion: the savepoint cycle rolls back this
    // INSERT at test end, so no leakage.
    const uniqueTenantStr = `Telecheck-Genesis-${Math.random().toString(36).slice(2, 10)}`;
    const uniqueTenant: TenantId = asTenantId(uniqueTenantStr);
    const client = getTestClient();
    await client.query(
      `INSERT INTO tenants (id, display_name, consumer_dba, legal_entity, consumer_subdomain, country_of_care, kms_key_alias, status, activated_at)
       VALUES ($1, $1, $1, 'Test Genesis', $1, 'US', 'alias/test-genesis-key', 'active', NOW())`,
      [uniqueTenantStr],
    );
    const expectedGenesis = computeGenesisHashHex(`${uniqueTenantStr}:PLATFORM`);
    const uniqueResource = `cfg_genesis_${Math.random().toString(36).slice(2, 12)}`;
    await withTenantContext(uniqueTenant, async () => {
      const env = await emitAudit(
        baseInput({
          target_patient_id: null,
          action: 'config_change_validated',
          resource_type: 'config',
          resource_id: uniqueResource,
          category: 'B',
          tenant_id: uniqueTenant,
        }),
        getTx(),
      );
      expect(env.hash_chain.sequence_number).toBe(1);
      expect(env.hash_chain.previous_hash).toBe(expectedGenesis);
      expect(env.hash_chain.partition).toBe(`${uniqueTenantStr}:PLATFORM`);
    });
  });

  it('second record in same partition gets sequence_number=2 + previous_hash = first record_hash', async () => {
    const uniquePatient = `pat_chain_${Math.random().toString(36).slice(2, 10)}`;
    await withTenantContext(TENANT_US, async () => {
      const first = await emitAudit(
        baseInput({ target_patient_id: uniquePatient, resource_id: `r1_${uniquePatient}` }),
        getTx(),
      );
      const second = await emitAudit(
        baseInput({ target_patient_id: uniquePatient, resource_id: `r2_${uniquePatient}` }),
        getTx(),
      );
      expect(second.hash_chain.sequence_number).toBe(2);
      expect(second.hash_chain.previous_hash).toBe(first.hash_chain.record_hash);
    });
  });

  it('platform-scope events (target_patient_id=null) use the PLATFORM partition', async () => {
    const uniqueResource = `cfg_${Math.random().toString(36).slice(2, 12)}`;
    await withTenantContext(TENANT_US, async () => {
      const env = await emitAudit(
        baseInput({
          target_patient_id: null,
          action: 'config_change_validated',
          resource_type: 'config',
          resource_id: uniqueResource,
          category: 'B',
        }),
        getTx(),
      );
      expect(env.hash_chain.partition).toBe(`${TENANT_US}:PLATFORM`);
      expect(env.target_patient_id).toBeNull();
    });
  });

  it('different tenants share NO chain — same patient_id under different tenant gets its own genesis', async () => {
    const sharedPatient = `pat_xtenant_${Math.random().toString(36).slice(2, 10)}`;

    const usEnv = await withTenantContext(TENANT_US, () =>
      emitAudit(
        baseInput({
          tenant_id: T_US,
          target_patient_id: sharedPatient,
          resource_id: `r_us_${sharedPatient}`,
        }),
        getTx(),
      ),
    );

    const ghanaEnv = await withTenantContext(TENANT_GHANA, () =>
      emitAudit(
        baseInput({
          tenant_id: T_GHANA,
          target_patient_id: sharedPatient,
          resource_id: `r_gh_${sharedPatient}`,
          country_of_care: 'GH',
        }),
        getTx(),
      ),
    );

    // Both records are first-in-partition for their respective tenants.
    expect(usEnv.hash_chain.sequence_number).toBe(1);
    expect(ghanaEnv.hash_chain.sequence_number).toBe(1);
    // Partition keys differ by tenant prefix — proves the tenant-scoped
    // partition derivation (HIGH-1 closure 2026-05-03).
    expect(usEnv.hash_chain.partition).toBe(`${TENANT_US}:${sharedPatient}`);
    expect(ghanaEnv.hash_chain.partition).toBe(`${TENANT_GHANA}:${sharedPatient}`);
    expect(usEnv.hash_chain.partition).not.toBe(ghanaEnv.hash_chain.partition);
    // Genesis hashes derive from the partition key, so cross-tenant
    // genesis values are different deterministic SHA-256 digests.
    // Asserting the exact pair pins the tenant-scoped seed: a
    // tenant-blind seed (e.g. just `GENESIS:<patient_id>`) would
    // produce IDENTICAL genesis values for both tenants and silently
    // collapse the chain isolation.
    expect(usEnv.hash_chain.previous_hash).toBe(
      computeGenesisHashHex(`${TENANT_US}:${sharedPatient}`),
    );
    expect(ghanaEnv.hash_chain.previous_hash).toBe(
      computeGenesisHashHex(`${TENANT_GHANA}:${sharedPatient}`),
    );
    expect(usEnv.hash_chain.previous_hash).not.toBe(ghanaEnv.hash_chain.previous_hash);
  });
});

// ---------------------------------------------------------------------------
// 8. Real-DB persistence + INSERT...RETURNING (HIGH-5 closure)
// ---------------------------------------------------------------------------

describe('emitAudit — real-DB persistence', () => {
  it('audit_id, action, and tenant_id are persisted to audit_records exactly as supplied', async () => {
    const uniqueResource = `cnst_persist_${Math.random().toString(36).slice(2, 12)}`;
    await withTenantContext(TENANT_US, async () => {
      const env = await emitAudit(baseInput({ resource_id: uniqueResource }), getTx());
      // Read back via the shared client.
      const client = getTestClient();
      const { rows } = await client.query<{
        audit_id: string;
        action: string;
        tenant_id: string;
        category: string;
      }>(
        `SELECT audit_id, action, tenant_id, category
           FROM audit_records
          WHERE audit_id = $1`,
        [env.audit_id],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]!.action).toBe(env.action);
      expect(rows[0]!.tenant_id).toBe(env.tenant_id);
      expect(rows[0]!.category).toBe(env.category);
    });
  });

  it('returned hash_chain values come from INSERT...RETURNING (trigger-authoritative; HIGH-5)', async () => {
    // The trigger recomputes record_hash, prev_hash, and sequence_number
    // server-side. The wire envelope MUST reflect those — not the
    // pre-computed values from the app side. Verify by reading the row
    // back and comparing.
    const uniquePatient = `pat_high5_${Math.random().toString(36).slice(2, 10)}`;
    await withTenantContext(TENANT_US, async () => {
      const env = await emitAudit(
        baseInput({ target_patient_id: uniquePatient, resource_id: `r_${uniquePatient}` }),
        getTx(),
      );
      const client = getTestClient();
      const { rows } = await client.query<{
        record_hash_hex: string;
        prev_hash_hex: string;
        sequence_number: number;
      }>(
        `SELECT encode(record_hash, 'hex') AS record_hash_hex,
                encode(prev_hash,   'hex') AS prev_hash_hex,
                sequence_number
           FROM audit_records
          WHERE audit_id = $1`,
        [env.audit_id],
      );
      expect(rows).toHaveLength(1);
      // The wire envelope's hash_chain matches the stored row exactly.
      expect(env.hash_chain.record_hash).toBe(rows[0]!.record_hash_hex);
      expect(env.hash_chain.previous_hash).toBe(rows[0]!.prev_hash_hex);
      expect(env.hash_chain.sequence_number).toBe(Number(rows[0]!.sequence_number));
    });
  });

  it('INSERT failure surfaces with action + tenant + audit_id context (I-003)', async () => {
    // Trigger an FK-style failure by passing a tenant_id that doesn't
    // exist in the tenants table. The audit_records table has a FK
    // constraint, so this fails at INSERT time, not at Zod time.
    // Cast bypasses asTenantId's runtime check on tenant ID format —
    // we want the FK violation to fire at INSERT time, not at glossary
    // validation time.
    //
    // Wrap in withTenantContext(TENANT_US) so the RLS WITH CHECK on
    // audit_records can call `current_tenant_id()` (it requires a live
    // binding else throws `tenant_context_not_set`). With a binding set
    // to TENANT_US, the RLS check then sees `tenant_id != current_tenant_id()`
    // for the bogus row and rejects with `new row violates row-level
    // security policy`. Codex audit-emit-r1 closure 2026-05-04: prior
    // version did not set context, so RLS bare-failed on
    // `tenant_context_not_set` BEFORE the catch could wrap it.
    const bogusTenant = 'Telecheck-XX' as unknown as TenantId;
    await withTenantContext(TENANT_US, async () => {
      await expect(emitAudit(baseInput({ tenant_id: bogusTenant }), getTx())).rejects.toThrow(
        // Wrapped error must include action, tenant, and audit_id for
        // upstream debugging — and must cite the I-003 abort rule.
        new RegExp(
          `emitAudit: durable INSERT failed for action "consent_granted".*${bogusTenant}.*I-003 forbids`,
          's',
        ),
      );
    });
  });
});
