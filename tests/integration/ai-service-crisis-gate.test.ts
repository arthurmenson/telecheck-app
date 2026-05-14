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

import { withTransaction } from '../../src/lib/db.ts';
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

  it('(resourceType, detectionSource) mismatch — safety sentinel still returns, audit fails open with audit_error', async () => {
    // Per Codex PR F R10 HIGH closure 2026-05-13: a caller wiring
    // bug (Mode 1 chat aggregate with a Mode 2 case-prep source, or
    // vice versa) is a programmer error — but on a real positive
    // crisis detection, the gate's contract is "always return the
    // crisis sentinel so the caller surfaces resources." The
    // wiring bug surfaces via `audit_emitted=false` + `audit_error`,
    // NOT by denying the patient the crisis-resource response.
    const ctx = baseCtx(); // resourceType=ai_chat_session
    const r = await runCrisisGate(ctx, "i don't want to live anymore", 'ai_case_prep_input');
    expect(r.kind).toBe('crisis');
    if (r.kind === 'crisis') {
      expect(r.audit_emitted).toBe(false);
      expect(r.audit_error?.message).toMatch(/Refusing to emit a mislabeled FLOOR-020 envelope/);
    }
    expect(await countCrisisAudits(ctx.resourceId)).toBe(0);

    // Reverse direction: Mode 2 aggregate with Mode 1 source.
    const ctx2 = {
      ...baseCtx({ resourceId: `aiwfe_${ulid()}` }),
      aiActorId: 'system:ai_mode_2_case_prep',
      resourceType: 'ai_workflow_execution' as const,
    };
    const r2 = await runCrisisGate(ctx2, "i don't want to live anymore", 'ai_chat_input');
    expect(r2.kind).toBe('crisis');
    if (r2.kind === 'crisis') {
      expect(r2.audit_emitted).toBe(false);
      expect(r2.audit_error?.message).toMatch(/Refusing to emit a mislabeled FLOOR-020 envelope/);
    }
    expect(await countCrisisAudits(ctx2.resourceId)).toBe(0);
  });
});

describe('runCrisisGate — durability (Codex PR F R4 HIGH closure)', () => {
  it('caller transaction rollback does NOT erase the crisis audit', async () => {
    // Per Codex PR F R4 HIGH closure 2026-05-13: the gate's audit
    // emission runs on a fresh, independent transaction. A caller
    // that invokes the gate inside its own business transaction and
    // then rolls back (e.g., rejecting the request mid-handler) MUST
    // still leave the Category A audit durable per I-019 + I-003.
    // The gate no longer accepts an externalTx parameter; the
    // mistake-by-API-design risk is closed at the type level.
    const ctx = baseCtx();

    // Run the gate inside a caller tx, then throw to force rollback.
    const sentinel = Symbol('caller_rollback');
    let outcomeKind: string | undefined;
    try {
      await withTransaction(async (tx) => {
        await tx.query('SELECT set_tenant_context($1)', [T_US]);
        const r = await runCrisisGate(ctx, "i don't want to live anymore", 'ai_chat_input');
        outcomeKind = r.kind;
        throw sentinel; // caller rolls back its tx
      });
    } catch (e) {
      if (e !== sentinel) throw e;
    }

    expect(outcomeKind).toBe('crisis');
    // Even though the caller's tx rolled back, the gate's fresh-
    // transaction audit emit committed independently. The audit row
    // is durable.
    expect(await countCrisisAudits(ctx.resourceId)).toBe(1);
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
    // Per Codex PR F R10 HIGH closure: safety sentinel ALWAYS
    // returns on positive detection. Wiring bugs surface via
    // audit_emitted=false + audit_error, NOT by throwing.
    expect(rFail.kind).toBe('crisis');
    if (rFail.kind === 'crisis') {
      expect(rFail.audit_emitted).toBe(false);
      expect(rFail.audit_error?.message).toMatch(
        /auditDedupeDiscriminator is required for case-prep/,
      );
    }
    expect(await countCrisisAudits(ctxCasePrep.resourceId)).toBe(0);

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
      // Per Codex PR F R10 HIGH closure: safety sentinel ALWAYS
      // returns; validation errors surface via audit_error.
      expect(r.kind).toBe('crisis');
      if (r.kind === 'crisis') {
        expect(r.audit_emitted).toBe(false);
        expect(r.audit_error?.message).toMatch(/auditDedupeDiscriminator must match/);
      }
      expect(await countCrisisAudits(ctx.resourceId)).toBe(0);
    }
  });

  it('idempotencyCtx.tenantId !== ctx.tenantId — safety sentinel returns, audit_error captures the tenant mismatch', async () => {
    // Per Codex PR F R3 HIGH closure 2026-05-13 + R10 HIGH closure:
    // a caller wiring bug that supplied an idempotencyCtx scoped to
    // a different tenant is a programmer error. The safety sentinel
    // still returns on positive detection (so the patient gets the
    // crisis-resource response), but `audit_emitted=false` +
    // `audit_error` surfaces the wiring bug for ops review.
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
      expect(r.audit_emitted).toBe(false);
      expect(r.audit_error?.message).toMatch(/must equal ctx.tenantId/);
    }
    // No audit row was emitted under either tenant.
    expect(await countCrisisAudits(ctx.resourceId)).toBe(0);
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
