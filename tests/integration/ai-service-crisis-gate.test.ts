/**
 * ai-service-crisis-gate.test.ts — I-019 crisis-detection gate tests
 * per TLC-AI PR F.
 *
 * The gate wraps the platform-singleton `crisisDetector` from
 * src/lib/crisis-detection.ts + emits the canonical
 * `crisis_detection_trigger` Category A audit on positive detection.
 *
 * Contract under test (FLOOR-009 + FLOOR-013 + I-019):
 *   - No-crisis input → returns { kind: 'no_crisis' }, emits NOTHING
 *   - Crisis input → returns { kind: 'crisis', audit_emitted: true },
 *     audit row carries actor_type='ai_workload', category='A',
 *     detection_source matches the surface, ai_workload_type +
 *     autonomy_level populated per FLOOR-020.
 *   - Detection runs across multiple AI detection sources
 *     (ai_chat_input + ai_chat_output + ai_case_prep_input +
 *     ai_case_prep_output) — defense-in-depth on both input AND
 *     output text.
 *
 * Spec references:
 *   - AI_LAYERING v5.2 §4 (FLOOR-009 + FLOOR-013)
 *   - AI_LAYERING v5.2 §6 (FLOOR-020)
 *   - I-019 (platform-floor; always-on)
 *   - I-003 (audit append-only)
 *   - AUDIT_EVENTS v5.3 §Category A `crisis_detection_trigger`
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { asTenantId } from '../../src/lib/glossary.ts';
import { ulid } from '../../src/lib/ulid.ts';
import { type AICrisisDetectionSource, runCrisisGate } from '../../src/modules/ai-service/index.ts';
import { TENANT_US, withTenantContext } from '../helpers/tenant-fixtures.ts';
import { getTestClient } from '../setup.ts';

const T_US = asTenantId(TENANT_US);

beforeAll(() => {
  process.env['NODE_ENV'] = 'test';
});

afterAll(() => {
  /* no-op */
});

interface ContextOverrides {
  patientId?: string;
  resourceId?: string;
  detection_source?: AICrisisDetectionSource;
}

function baseCtx(overrides: ContextOverrides = {}) {
  return {
    tenantId: T_US,
    countryOfCare: 'US',
    aiActorId: 'system:ai_mode_1',
    patientId: overrides.patientId ?? `acct_${ulid()}`,
    resourceType: 'ai_chat_session' as const,
    resourceId: overrides.resourceId ?? `aics_${ulid()}`,
    escalationDestination: 'crisis_helpline_us:988',
  };
}

async function countCrisisAudits(resourceId: string): Promise<number> {
  return withTenantContext(T_US, async () => {
    const client = getTestClient();
    const res = await client.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM audit_records
        WHERE tenant_id = $1
          AND resource_id = $2
          AND action = 'crisis_detection_trigger'`,
      [T_US, resourceId],
    );
    return Number.parseInt(res.rows[0]!.n, 10);
  });
}

describe('runCrisisGate — no-crisis path', () => {
  it('benign input → { kind: "no_crisis" }, NO audit emitted', async () => {
    const ctx = baseCtx();
    const result = await runCrisisGate(
      ctx,
      'What does my latest A1c result mean?',
      'ai_chat_input',
    );
    expect(result.kind).toBe('no_crisis');
    expect(await countCrisisAudits(ctx.resourceId)).toBe(0);
  });

  it('empty input → { kind: "no_crisis" }', async () => {
    const ctx = baseCtx();
    const result = await runCrisisGate(ctx, '', 'ai_chat_input');
    expect(result.kind).toBe('no_crisis');
  });
});

describe('runCrisisGate — positive detection path', () => {
  it('suicidal-ideation text → emits crisis_detection_trigger Category A with ai_workload actor', async () => {
    const ctx = baseCtx();
    const result = await runCrisisGate(
      ctx,
      "i don't want to live anymore, what should I do",
      'ai_chat_input',
    );
    expect(result.kind).toBe('crisis');
    if (result.kind === 'crisis') {
      expect(result.audit_emitted).toBe(true);
      expect(result.detection_source).toBe('ai_chat_input');
      expect(result.crisis_type).toBeTruthy();
    }

    // Verify audit row landed with the canonical FLOOR-020 shape.
    await withTenantContext(T_US, async () => {
      const client = getTestClient();
      const rows = await client.query<{
        action: string;
        actor_type: string;
        actor_id: string;
        category: string;
        ai_workload_type: string;
        autonomy_level: string;
      }>(
        `SELECT action, actor_type, actor_id, category, ai_workload_type, autonomy_level
           FROM audit_records
          WHERE tenant_id = $1 AND resource_id = $2 AND action = 'crisis_detection_trigger'`,
        [T_US, ctx.resourceId],
      );
      expect(rows.rows.length).toBe(1);
      const row = rows.rows[0]!;
      expect(row.actor_type).toBe('ai_workload');
      expect(row.actor_id).toBe('system:ai_mode_1');
      expect(row.category).toBe('A');
      // FLOOR-020: ai_workload emissions populate the workload +
      // autonomy envelope. Crisis detection is platform-floor; it
      // runs ATTRIBUTED to the conversational_assistant workload.
      expect(row.ai_workload_type).toBe('conversational_assistant');
      expect(row.autonomy_level).toBe('advisory');
    });
  });

  it('self-harm text → emits crisis audit; detection_source travels through detail', async () => {
    const ctx = baseCtx();
    const result = await runCrisisGate(
      ctx,
      'i have been thinking about hurting myself',
      'ai_chat_output', // post-generation defense-in-depth scan
    );
    expect(result.kind).toBe('crisis');
    if (result.kind === 'crisis') {
      expect(result.detection_source).toBe('ai_chat_output');
    }
    expect(await countCrisisAudits(ctx.resourceId)).toBe(1);

    await withTenantContext(T_US, async () => {
      const client = getTestClient();
      const rows = await client.query<{ payload: Record<string, unknown> }>(
        `SELECT payload FROM audit_records
          WHERE tenant_id = $1 AND resource_id = $2 AND action = 'crisis_detection_trigger'`,
        [T_US, ctx.resourceId],
      );
      expect(rows.rows[0]!.payload['detection_source']).toBe('ai_chat_output');
      // Per FLOOR-020 + I-019, the response_provided flag captures
      // whether the surface delivered crisis resources — the
      // canonical-path value is true.
      expect(rows.rows[0]!.payload['response_provided']).toBe(true);
      // PHI: the text content itself is NOT captured in the audit
      // detail. Verify that the input text doesn't leak.
      const payloadStr = JSON.stringify(rows.rows[0]!.payload);
      expect(payloadStr).not.toContain('hurting myself');
    });
  });

  it('Mode 2 case-prep input + output emit with protocol_execution workload (NOT conversational_assistant)', async () => {
    // Per Codex PR F R1 HIGH closure 2026-05-13: the FLOOR-020
    // (workload_type, autonomy_level) envelope MUST be derived from
    // the resourceType, not hard-coded. Mode 2 case-prep surfaces
    // are `protocol_execution` + `action_with_confirm`; a regression
    // that re-hard-codes `conversational_assistant` + `advisory`
    // for every detection would break audit-filter queries,
    // I-012 correlation, and Mode 2 safety reporting.
    const ctx1 = {
      ...baseCtx({ resourceId: `aiwfe_${ulid()}` }),
      aiActorId: 'system:ai_mode_2_case_prep',
      resourceType: 'ai_workflow_execution' as const,
    };
    const r1 = await runCrisisGate(
      ctx1,
      'patient reports persistent suicidal ideation',
      'ai_case_prep_input',
    );
    expect(r1.kind).toBe('crisis');
    if (r1.kind === 'crisis') {
      expect(r1.detection_source).toBe('ai_case_prep_input');
    }
    expect(await countCrisisAudits(ctx1.resourceId)).toBe(1);

    // Assert FLOOR-020 envelope on the audit row itself.
    await withTenantContext(T_US, async () => {
      const client = getTestClient();
      const rows = await client.query<{
        ai_workload_type: string;
        autonomy_level: string;
      }>(
        `SELECT ai_workload_type, autonomy_level
           FROM audit_records
          WHERE tenant_id = $1 AND resource_id = $2 AND action = 'crisis_detection_trigger'`,
        [T_US, ctx1.resourceId],
      );
      expect(rows.rows[0]!.ai_workload_type).toBe('protocol_execution');
      expect(rows.rows[0]!.autonomy_level).toBe('action_with_confirm');
    });

    const ctx2 = {
      ...baseCtx({ resourceId: `aiwfe_${ulid()}` }),
      aiActorId: 'system:ai_mode_2_case_prep',
      resourceType: 'ai_workflow_execution' as const,
    };
    const r2 = await runCrisisGate(
      ctx2,
      'AI summary mentions thoughts of self-harm; flag for clinician',
      'ai_case_prep_output',
    );
    expect(r2.kind).toBe('crisis');
    if (r2.kind === 'crisis') {
      expect(r2.detection_source).toBe('ai_case_prep_output');
    }
    expect(await countCrisisAudits(ctx2.resourceId)).toBe(1);

    await withTenantContext(T_US, async () => {
      const client = getTestClient();
      const rows = await client.query<{
        ai_workload_type: string;
        autonomy_level: string;
      }>(
        `SELECT ai_workload_type, autonomy_level
           FROM audit_records
          WHERE tenant_id = $1 AND resource_id = $2 AND action = 'crisis_detection_trigger'`,
        [T_US, ctx2.resourceId],
      );
      expect(rows.rows[0]!.ai_workload_type).toBe('protocol_execution');
      expect(rows.rows[0]!.autonomy_level).toBe('action_with_confirm');
    });
  });

  it('(resourceType, detectionSource) mismatch throws loud (no mislabeled emit)', async () => {
    // Mode 1 chat aggregate with a Mode 2 case-prep source is a
    // programmer error — the gate refuses to emit a mislabeled
    // FLOOR-020 envelope. Per Codex PR F R1 HIGH closure.
    const ctx = baseCtx(); // resourceType=ai_chat_session
    await expect(
      runCrisisGate(ctx, "i don't want to live anymore", 'ai_case_prep_input'),
    ).rejects.toThrow(/Refusing to emit a mislabeled FLOOR-020 envelope/);
    // And no audit row was written.
    expect(await countCrisisAudits(ctx.resourceId)).toBe(0);

    // Reverse direction: Mode 2 aggregate with Mode 1 source.
    const ctx2 = {
      ...baseCtx({ resourceId: `aiwfe_${ulid()}` }),
      aiActorId: 'system:ai_mode_2_case_prep',
      resourceType: 'ai_workflow_execution' as const,
    };
    await expect(
      runCrisisGate(ctx2, "i don't want to live anymore", 'ai_chat_input'),
    ).rejects.toThrow(/Refusing to emit a mislabeled FLOOR-020 envelope/);
    expect(await countCrisisAudits(ctx2.resourceId)).toBe(0);
  });
});

describe('runCrisisGate — idempotency dedupe (Codex PR F R1 HIGH closure)', () => {
  it('retry under same idempotencyCtx after positive detection does NOT emit a second audit', async () => {
    // Sprint 34 / SI-006 audit-dedupe pattern: if the caller passes
    // an idempotencyCtx, a retry under the same Idempotency-Key +
    // body + endpoint + actor 5-tuple claims the same dedupe
    // marker, hits ON CONFLICT DO NOTHING, and skips the second
    // emit. The audit is durable from the first attempt; the second
    // call still returns the crisis sentinel (audit_emitted=true)
    // because the audit IS durable — just not freshly emitted.
    const ctx = {
      ...baseCtx(),
      idempotencyCtx: {
        tenantId: T_US,
        idempotencyKey: ulid(),
        endpoint: 'POST /v0/ai/chat',
        actorId: 'patient_abc',
        bodyHash: 'a'.repeat(64),
      },
    };
    const r1 = await runCrisisGate(ctx, "i don't want to live anymore", 'ai_chat_input');
    expect(r1.kind).toBe('crisis');
    expect(await countCrisisAudits(ctx.resourceId)).toBe(1);

    const r2 = await runCrisisGate(ctx, "i don't want to live anymore", 'ai_chat_input');
    expect(r2.kind).toBe('crisis');
    // Audit count UNCHANGED — dedupe marker blocked the second emit.
    expect(await countCrisisAudits(ctx.resourceId)).toBe(1);
  });

  it('retry under DIFFERENT idempotency-key emits a fresh audit (dedupe scoped per key)', async () => {
    const baseCtxShared = baseCtx();
    const ctx1 = {
      ...baseCtxShared,
      idempotencyCtx: {
        tenantId: T_US,
        idempotencyKey: ulid(),
        endpoint: 'POST /v0/ai/chat',
        actorId: 'patient_abc',
        bodyHash: 'a'.repeat(64),
      },
    };
    const r1 = await runCrisisGate(ctx1, "i don't want to live anymore", 'ai_chat_input');
    expect(r1.kind).toBe('crisis');
    expect(await countCrisisAudits(ctx1.resourceId)).toBe(1);

    // Distinct Idempotency-Key → distinct dedupe marker → fresh emit.
    const ctx2 = {
      ...baseCtxShared,
      idempotencyCtx: {
        tenantId: T_US,
        idempotencyKey: ulid(),
        endpoint: 'POST /v0/ai/chat',
        actorId: 'patient_abc',
        bodyHash: 'a'.repeat(64),
      },
    };
    const r2 = await runCrisisGate(ctx2, "i don't want to live anymore", 'ai_chat_input');
    expect(r2.kind).toBe('crisis');
    // Same resource_id → both audits land on it; count goes 1 → 2.
    expect(await countCrisisAudits(ctx2.resourceId)).toBe(2);
  });
});
