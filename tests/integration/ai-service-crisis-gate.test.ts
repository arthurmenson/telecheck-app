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

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { asTenantId } from '../../src/lib/glossary.ts';
import { logger } from '../../src/lib/logger.ts';
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
      // Per Codex PR F R9 HIGH closure 2026-05-13: the gate emits
      // `response_provided: null` (unobserved) because at gate time
      // the response has not been delivered. R6 used `false`, but
      // that's just as wrong as the original `true` — successful
      // deliveries would all show as failures. `null` signals
      // "pending follow-up delivery audit emitted by the handler
      // after the crisis-resource envelope reaches the patient."
      expect(rows.rows[0]!.payload['response_provided']).toBeNull();
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

  it('(resourceType, detectionSource) mismatch — audit STILL emits on the wiring-error fallback path', async () => {
    // Per Codex PR F R12 HIGH closure 2026-05-13: even on a caller
    // wiring bug, the mandatory Category A audit MUST land. The
    // gate falls through to a conservative-default envelope and
    // records the wiring error in audit detail. `audit_emitted`
    // remains `true` (the row is durable); `audit_error` is set so
    // the caller still gets diagnostics for ops triage.
    const ctx = baseCtx(); // resourceType=ai_chat_session
    const r = await runCrisisGate(ctx, "i don't want to live anymore", 'ai_case_prep_input');
    expect(r.kind).toBe('crisis');
    if (r.kind === 'crisis') {
      expect(r.audit_emitted).toBe(true);
      expect(r.audit_error?.message).toMatch(/Refusing to emit a mislabeled FLOOR-020 envelope/);
    }
    // Audit DID land on the fallback path.
    expect(await countCrisisAudits(ctx.resourceId)).toBe(1);

    // Verify the audit detail carries the wiring_error marker.
    await withTenantContext(T_US, async () => {
      const client = getTestClient();
      const rows = await client.query<{ payload: Record<string, unknown> }>(
        `SELECT payload FROM audit_records
          WHERE tenant_id = $1 AND resource_id = $2 AND action = 'crisis_detection_trigger'`,
        [T_US, ctx.resourceId],
      );
      const wiring = rows.rows[0]!.payload['wiring_error'] as
        | { name: string; message: string }
        | undefined;
      expect(wiring).toBeDefined();
      expect(wiring!.message).toMatch(/Refusing to emit a mislabeled FLOOR-020 envelope/);
    });

    // Reverse direction: Mode 2 aggregate with Mode 1 source.
    const ctx2 = {
      ...baseCtx({ resourceId: `aiwfe_${ulid()}` }),
      aiActorId: 'system:ai_mode_2_case_prep',
      resourceType: 'ai_workflow_execution' as const,
    };
    const r2 = await runCrisisGate(ctx2, "i don't want to live anymore", 'ai_chat_input');
    expect(r2.kind).toBe('crisis');
    if (r2.kind === 'crisis') {
      expect(r2.audit_emitted).toBe(true);
      expect(r2.audit_error?.message).toMatch(/Refusing to emit a mislabeled FLOOR-020 envelope/);
    }
    expect(await countCrisisAudits(ctx2.resourceId)).toBe(1);
  });
});

describe('runCrisisGate — required-field shape validation (Codex PR F R13 HIGH closure)', () => {
  // Per Codex PR F R13 HIGH closure 2026-05-13: emitAudit rejects
  // empty target_patient_id / resource_id / actor_id and rejects
  // non-2-char country_of_care. The gate validates these up front
  // so an upstream mapping bug surfaces as a wiring_error (with the
  // audit fallback path) rather than crashing the emit and
  // silently losing the I-019 Category A row.
  type Field = 'aiActorId' | 'patientId' | 'resourceId' | 'countryOfCare' | 'tenantId';
  const invalidByField: Array<[Field, unknown, RegExp]> = [
    ['aiActorId', '', /aiActorId must be a non-empty string/],
    ['patientId', '', /patientId must be a non-empty string/],
    ['resourceId', '', /resourceId must be a non-empty string/],
    ['countryOfCare', 'USA', /countryOfCare must be a 2-char/],
    ['countryOfCare', '', /countryOfCare must be a 2-char/],
    ['countryOfCare', 'us', /countryOfCare must be a 2-char/],
  ];
  for (const [field, badValue, expectedMessage] of invalidByField) {
    it(`invalid ctx.${field}=${JSON.stringify(badValue)} surfaces wiring_error (audit still attempts to land)`, async () => {
      const ctx = {
        ...baseCtx(),
        [field]: badValue,
      } as Parameters<typeof runCrisisGate>[0];
      const r = await runCrisisGate(ctx, "i don't want to live anymore", 'ai_chat_input');
      expect(r.kind).toBe('crisis');
      if (r.kind === 'crisis') {
        // The wiring error is captured. Whether the audit actually
        // lands depends on whether the malformed field is one the
        // emitter validates row-level (e.g., countryOfCare is a NOT
        // NULL+length-2 column check — emit will still fail). We
        // assert audit_error captures the wiring error in both
        // cases; the I-019 audit-or-log invariant is satisfied either
        // way (the fallback log fires on the failure branch).
        expect(r.audit_error?.message).toMatch(expectedMessage);
      }
    });
  }
});

describe('runCrisisGate — PHI-leak protection on validation failures (Codex PR F R14 HIGH closure)', () => {
  it('rejected auditDedupeDiscriminator value is NOT echoed into audit detail or log', async () => {
    // Per Codex PR F R14 HIGH closure 2026-05-13: if a caller
    // accidentally passes PHI as the discriminator (e.g., a raw
    // note segment), the validator must reject — but the rejected
    // value MUST NOT enter the append-only audit chain or the
    // production log stream. The error message reports shape
    // metadata only (length + has_illegal_chars).
    const phiLikeDiscriminator = 'patient John Doe SSN 123-45-6789 reports suicidal ideation';
    const ctx = {
      ...baseCtx({ resourceId: `aiwfe_${ulid()}` }),
      aiActorId: 'system:ai_mode_2_case_prep',
      resourceType: 'ai_workflow_execution' as const,
      idempotencyCtx: {
        tenantId: T_US,
        idempotencyKey: ulid(),
        endpoint: 'POST /v0/ai/case-prep',
        actorId: 'clinician_xyz',
        bodyHash: 'g'.repeat(64),
      },
      auditDedupeDiscriminator: phiLikeDiscriminator,
    };

    const errSpy = vi.spyOn(logger, 'error');
    try {
      const r = await runCrisisGate(
        ctx,
        'patient reports persistent suicidal ideation',
        'ai_case_prep_input',
      );
      expect(r.kind).toBe('crisis');

      // The returned audit_error message MUST NOT contain the raw
      // PHI-like discriminator. It must contain the shape metadata.
      if (r.kind === 'crisis') {
        expect(r.audit_error?.message).not.toContain('John Doe');
        expect(r.audit_error?.message).not.toContain('123-45-6789');
        expect(r.audit_error?.message).toMatch(/length=\d+/);
        expect(r.audit_error?.message).toMatch(/has_illegal_chars=true/);
      }

      // The audit payload's wiring_error MUST NOT contain the raw value.
      await withTenantContext(T_US, async () => {
        const client = getTestClient();
        const rows = await client.query<{ payload: Record<string, unknown> }>(
          `SELECT payload FROM audit_records
            WHERE tenant_id = $1 AND resource_id = $2 AND action = 'crisis_detection_trigger'`,
          [T_US, ctx.resourceId],
        );
        if (rows.rows.length > 0) {
          const payloadStr = JSON.stringify(rows.rows[0]!.payload);
          expect(payloadStr).not.toContain('John Doe');
          expect(payloadStr).not.toContain('123-45-6789');
        }
      });

      // The log payload MUST NOT contain the raw value either.
      const allErrorCalls = errSpy.mock.calls;
      const logStr = JSON.stringify(allErrorCalls);
      expect(logStr).not.toContain('John Doe');
      expect(logStr).not.toContain('123-45-6789');
    } finally {
      errSpy.mockRestore();
    }
  });
});

describe('runCrisisGate — operational signaling (Codex PR F R11 + R12 HIGH closures)', () => {
  it('wiring-error fallback emits crisis_audit_emitted_on_wiring_fallback error log', async () => {
    // Per Codex PR F R12 HIGH closure 2026-05-13: a positive
    // detection on a caller-wiring-error path STILL emits the
    // mandatory Category A audit (on the fallback path) AND fires
    // an error-level log so ops triage doesn't depend on the
    // caller noticing `audit_error`. R11's earlier
    // `crisis_audit_emission_failed` event still fires when the
    // audit emission ITSELF fails (DB error, etc.); R12 separates
    // wiring errors (audit lands, log says "on fallback") from
    // infrastructure errors (audit missing, log says "emission
    // failed").
    const errSpy = vi.spyOn(logger, 'error');
    try {
      const ctx = baseCtx(); // ai_chat_session
      const r = await runCrisisGate(ctx, "i don't want to live anymore", 'ai_case_prep_input');
      expect(r.kind).toBe('crisis');
      if (r.kind === 'crisis') {
        expect(r.audit_emitted).toBe(true); // emitted on fallback path
      }

      const fallbackCall = errSpy.mock.calls.find((args) => {
        const obj = args[0] as Record<string, unknown> | undefined;
        return obj?.['event'] === 'crisis_audit_emitted_on_wiring_fallback';
      });
      expect(fallbackCall).toBeDefined();
      const obj = fallbackCall![0] as Record<string, unknown>;
      expect(obj['tenant_id']).toBe(T_US);
      expect(obj['resource_id']).toBe(ctx.resourceId);
      expect(obj['detection_source']).toBe('ai_case_prep_input');
      expect(typeof obj['wiring_error_message']).toBe('string');
      // PHI: crisis text must NOT appear in the log payload.
      const logStr = JSON.stringify(fallbackCall);
      expect(logStr).not.toContain("don't want to live");
    } finally {
      errSpy.mockRestore();
    }
  });
});

describe('runCrisisGate — durability (Codex PR F R4 HIGH closure; R13 MEDIUM revision)', () => {
  // Codex PR F R13 MEDIUM closure 2026-05-13: a previous version of
  // this test invoked the gate inside a caller `withTransaction(...)`
  // that then threw to force rollback, and asserted the audit row
  // survived. That assertion CANNOT be proven in this test harness:
  // setTestPool translates app-level BEGIN/COMMIT/ROLLBACK into
  // SAVEPOINT/RELEASE/ROLLBACK TO SAVEPOINT on a SHARED client, so
  // the gate's `withTransaction(emit)` becomes a savepoint inside
  // the outer one. ROLLBACK TO outer-savepoint would undo the
  // RELEASE'd inner audit insert, producing a false negative or
  // false positive depending on harness timing.
  //
  // The production code path is unchanged and is still correct:
  // `withTransaction` opens a NEW pool connection that COMMITS
  // independently of any caller tx. The TYPE-LEVEL guarantee — the
  // gate no longer accepts an `externalTx` parameter, so callers
  // CANNOT join the gate's audit to their own tx — is what closes
  // R4 by construction. The behavior assertion belongs in the
  // bench/real-pool harness when that lands; documenting the test-
  // harness limitation here so a future reader doesn't reintroduce
  // the misleading test.
  it.skip('caller transaction rollback durability — needs real-pool harness (see comment)', () => {
    // Intentionally skipped per R13 MEDIUM closure. Real-pool
    // durability assertion lives in the bench/integration-pool
    // harness when a future PR wires it.
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

  it('input + output scans within the SAME request both emit (dedupe discriminates by detectionSource)', async () => {
    // Per Codex PR F R2 HIGH closure 2026-05-13: the gate is called
    // TWICE per request — once on patient/clinician input BEFORE
    // the LLM call (ai_chat_input or ai_case_prep_input), once on
    // AI output BEFORE surfacing (ai_chat_output or
    // ai_case_prep_output) — both under the SAME Idempotency-Key.
    // If the dedupe key didn't include detectionSource, the output-
    // side emission would be silently suppressed by the input-side
    // marker, violating I-019's "emit on every positive detection"
    // contract.
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

    // Patient input trips crisis.
    const r1 = await runCrisisGate(ctx, "i don't want to live anymore", 'ai_chat_input');
    expect(r1.kind).toBe('crisis');
    expect(await countCrisisAudits(ctx.resourceId)).toBe(1);

    // AI output ALSO trips crisis (defense-in-depth scan). Same
    // resource_id, same idempotency context — but different
    // detectionSource. Must emit a SECOND audit.
    const r2 = await runCrisisGate(
      ctx,
      'i am sorry to hear you are thinking about hurting yourself',
      'ai_chat_output',
    );
    expect(r2.kind).toBe('crisis');
    expect(await countCrisisAudits(ctx.resourceId)).toBe(2);

    // But a retry of the input-side scan (same detectionSource +
    // same idempotencyCtx) MUST still dedupe.
    const r3 = await runCrisisGate(ctx, "i don't want to live anymore", 'ai_chat_input');
    expect(r3.kind).toBe('crisis');
    expect(await countCrisisAudits(ctx.resourceId)).toBe(2); // unchanged
  });

  it('same Idempotency-Key + same detectionSource across DIFFERENT resources emits per-resource audit', async () => {
    // Per Codex PR F R5 HIGH closure 2026-05-13: a handler that
    // scans multiple resource aggregates inside a single idempotent
    // request (e.g., batch case-prep over several consults) MUST
    // emit one audit per resource. The dedupe identity includes
    // resourceId in the auditAction discriminator so two distinct
    // resources can't collide on the same marker.
    const baseIdempotency = {
      tenantId: T_US,
      idempotencyKey: ulid(),
      endpoint: 'POST /v0/ai/case-prep-batch',
      actorId: 'clinician_xyz',
      bodyHash: 'b'.repeat(64),
    };
    const ctx1 = {
      ...baseCtx({ resourceId: `aiwfe_${ulid()}` }),
      aiActorId: 'system:ai_mode_2_case_prep',
      resourceType: 'ai_workflow_execution' as const,
      idempotencyCtx: baseIdempotency,
      // R7: case-prep + idempotency requires discriminator.
      auditDedupeDiscriminator: 'chief_complaint',
    };
    const r1 = await runCrisisGate(
      ctx1,
      'patient reports persistent suicidal ideation',
      'ai_case_prep_input',
    );
    expect(r1.kind).toBe('crisis');
    expect(await countCrisisAudits(ctx1.resourceId)).toBe(1);

    // Different resource_id, same Idempotency-Key + same source —
    // MUST emit a fresh audit (not silently dedupe).
    const ctx2 = {
      ...baseCtx({ resourceId: `aiwfe_${ulid()}` }),
      aiActorId: 'system:ai_mode_2_case_prep',
      resourceType: 'ai_workflow_execution' as const,
      idempotencyCtx: baseIdempotency,
      auditDedupeDiscriminator: 'chief_complaint',
    };
    const r2 = await runCrisisGate(
      ctx2,
      'patient reports persistent suicidal ideation',
      'ai_case_prep_input',
    );
    expect(r2.kind).toBe('crisis');
    expect(await countCrisisAudits(ctx2.resourceId)).toBe(1);
  });

  it('case-prep + idempotencyCtx WITHOUT auditDedupeDiscriminator — safety sentinel returns, audit_error populated', async () => {
    // Per Codex PR F R7 HIGH closure 2026-05-13: case-prep sources
    // scan multiple segments per consult. Without a per-segment
    // discriminator the dedupe key would silently suppress later
    // positive scans. Make this fail-closed at the API surface
    // rather than relying on every caller to remember a doc-only
    // rule.
    const ctxCasePrep = {
      ...baseCtx({ resourceId: `aiwfe_${ulid()}` }),
      aiActorId: 'system:ai_mode_2_case_prep',
      resourceType: 'ai_workflow_execution' as const,
      idempotencyCtx: {
        tenantId: T_US,
        idempotencyKey: ulid(),
        endpoint: 'POST /v0/ai/case-prep',
        actorId: 'clinician_xyz',
        bodyHash: 'd'.repeat(64),
      },
      // NO auditDedupeDiscriminator — fails inside safety envelope.
    };
    const rFail = await runCrisisGate(
      ctxCasePrep,
      'patient reports persistent suicidal ideation',
      'ai_case_prep_input',
    );
    // Per Codex PR F R12 HIGH closure: audit STILL emits on the
    // wiring-error fallback path so I-019 holds. audit_error
    // surfaces the validation message for ops triage.
    expect(rFail.kind).toBe('crisis');
    if (rFail.kind === 'crisis') {
      expect(rFail.audit_emitted).toBe(true);
      expect(rFail.audit_error?.message).toMatch(
        /auditDedupeDiscriminator is required for case-prep/,
      );
    }
    expect(await countCrisisAudits(ctxCasePrep.resourceId)).toBe(1);

    // Mode 1 chat WITHOUT discriminator + idempotencyCtx is fine —
    // chat is single-scan per source per request by design.
    const ctxChat = {
      ...baseCtx(),
      idempotencyCtx: {
        tenantId: T_US,
        idempotencyKey: ulid(),
        endpoint: 'POST /v0/ai/chat',
        actorId: 'patient_abc',
        bodyHash: 'e'.repeat(64),
      },
    };
    const r = await runCrisisGate(ctxChat, "i don't want to live anymore", 'ai_chat_input');
    expect(r.kind).toBe('crisis');
  });

  it('multi-segment scan of the SAME resource emits per-segment via auditDedupeDiscriminator', async () => {
    // Per Codex PR F R6 HIGH closure 2026-05-13: a handler that scans
    // multiple segments of the same resource for the same source
    // within one idempotent request (e.g., case-prep over
    // chief_complaint + history_of_present_illness + review_of_systems
    // separately on the same consult) MUST emit one audit per
    // segment. The caller-supplied `auditDedupeDiscriminator` (a
    // non-PHI segment id) extends the dedupe key so each segment
    // claims its own marker.
    const shared = baseCtx({ resourceId: `aiwfe_${ulid()}` });
    const idempotency = {
      tenantId: T_US,
      idempotencyKey: ulid(),
      endpoint: 'POST /v0/ai/case-prep',
      actorId: 'clinician_xyz',
      bodyHash: 'c'.repeat(64),
    };
    const baseCaseCtx = {
      ...shared,
      aiActorId: 'system:ai_mode_2_case_prep',
      resourceType: 'ai_workflow_execution' as const,
      idempotencyCtx: idempotency,
    };

    // Segment 1: chief_complaint
    const r1 = await runCrisisGate(
      { ...baseCaseCtx, auditDedupeDiscriminator: 'chief_complaint' },
      'patient reports persistent suicidal ideation',
      'ai_case_prep_input',
    );
    expect(r1.kind).toBe('crisis');
    expect(await countCrisisAudits(shared.resourceId)).toBe(1);

    // Segment 2: history_of_present_illness — same resource, same
    // source, same idempotency, DIFFERENT discriminator → fresh audit.
    const r2 = await runCrisisGate(
      { ...baseCaseCtx, auditDedupeDiscriminator: 'history_of_present_illness' },
      'patient describes thoughts of self-harm over the past week',
      'ai_case_prep_input',
    );
    expect(r2.kind).toBe('crisis');
    expect(await countCrisisAudits(shared.resourceId)).toBe(2);

    // Retry of segment 1 (same discriminator) → still deduped.
    const r3 = await runCrisisGate(
      { ...baseCaseCtx, auditDedupeDiscriminator: 'chief_complaint' },
      'patient reports persistent suicidal ideation',
      'ai_case_prep_input',
    );
    expect(r3.kind).toBe('crisis');
    expect(await countCrisisAudits(shared.resourceId)).toBe(2); // unchanged
  });

  it('invalid auditDedupeDiscriminator — safety sentinel returns, audit_error populated', async () => {
    // Per Codex PR F R8 HIGH closure 2026-05-13: discriminator must
    // match /^[A-Za-z0-9_.-]{1,64}$/. Empty / whitespace / colon-
    // bearing values could either match the no-discriminator case
    // OR collide via colon-concatenation in the dedupe key.
    const ctxFor = (discriminator: string) => ({
      ...baseCtx({ resourceId: `aiwfe_${ulid()}` }),
      aiActorId: 'system:ai_mode_2_case_prep',
      resourceType: 'ai_workflow_execution' as const,
      idempotencyCtx: {
        tenantId: T_US,
        idempotencyKey: ulid(),
        endpoint: 'POST /v0/ai/case-prep',
        actorId: 'clinician_xyz',
        bodyHash: 'f'.repeat(64),
      },
      auditDedupeDiscriminator: discriminator,
    });

    const invalid = [
      '', // empty
      '   ', // whitespace
      'has spaces', // space
      'colon:value', // colon (would split the auditAction)
      'a'.repeat(65), // too long
      'bad/char', // slash
      'tab\there', // tab
    ];
    for (const v of invalid) {
      const ctx = ctxFor(v);
      const r = await runCrisisGate(
        ctx,
        'patient reports persistent suicidal ideation',
        'ai_case_prep_input',
      );
      // Per Codex PR F R12 HIGH closure: audit STILL emits on the
      // fallback path. audit_error surfaces the validation message
      // for ops triage.
      expect(r.kind).toBe('crisis');
      if (r.kind === 'crisis') {
        expect(r.audit_emitted).toBe(true);
        expect(r.audit_error?.message).toMatch(/auditDedupeDiscriminator must match/);
      }
      expect(await countCrisisAudits(ctx.resourceId)).toBe(1);
    }
  });

  it('idempotencyCtx.tenantId !== ctx.tenantId — audit STILL emits on fallback path, under the gate tenant', async () => {
    // Per Codex PR F R3 + R12 HIGH closures 2026-05-13: a caller
    // wiring bug that supplied an idempotencyCtx scoped to a
    // different tenant doesn't skip the audit — it just disables
    // dedupe (the marker can't safely be claimed under the wrong
    // tenant) and records the wiring error in audit detail. The
    // audit row lands under ctx.tenantId (the gate's authoritative
    // tenant), so cross-tenant data never leaks.
    const ctx = {
      ...baseCtx(), // tenantId = T_US
      idempotencyCtx: {
        tenantId: 'Telecheck-Ghana', // WRONG tenant
        idempotencyKey: ulid(),
        endpoint: 'POST /v0/ai/chat',
        actorId: 'patient_abc',
        bodyHash: 'a'.repeat(64),
      },
    };
    const r = await runCrisisGate(ctx, "i don't want to live anymore", 'ai_chat_input');
    expect(r.kind).toBe('crisis');
    if (r.kind === 'crisis') {
      expect(r.audit_emitted).toBe(true);
      expect(r.audit_error?.message).toMatch(/must equal ctx.tenantId/);
    }
    // Audit DID emit under T_US (the gate's tenantId, NOT the bad
    // idempotencyCtx tenant). countCrisisAudits queries T_US so
    // this confirms the audit landed under the right tenant.
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
