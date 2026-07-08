/**
 * ai-service-mode-1-chat-audit-injection.test.ts — Mode 1 chat handler
 * audit-failure round-trip regression.
 *
 * Closes the R7 deferred-test gap from PR #160 + PR #162: the round-
 * trip "audit fails → cache rolls back → retry with same Idempotency-
 * Key uses deterministic IDs → only ONE Category A crisis audit
 * emitted across both attempts" invariant.
 *
 * Test pattern: vi.mock the ai-service/audit.ts module so
 * emitMode1ChatResponseAudit consults a shared failure-injection flag
 * before delegating to the real implementation. Flag set by helpers
 * in tests/helpers/mode-1-chat-audit-injection.ts.
 *
 * Coverage:
 *
 *   Group H — Audit-failure injection round-trip
 *     H1 fail-always → POST /v0/ai/chat → 503 with canonical error
 *        envelope (audit emission throws; mapServiceError translates
 *        the typed sentinel to the documented 503 retry-advisory
 *        response)
 *     H2 fail-once round-trip:
 *        a) First POST → 503 (cache reservation rolls back per
 *           withIdempotentExecution discipline)
 *        b) Second POST with same Idempotency-Key + body → 200 with
 *           the SAME deterministic session_id + message_id as the
 *           failed first attempt would have produced (R4 H1 closure
 *           proof at the round-trip level)
 *
 * Spec references:
 *   - PR #160 Codex R1-R6 closure history (handler hardening)
 *   - PR #162 Codex R1 H1 finding (deferred round-trip test)
 *   - AI_LAYERING v5.2 §6 FLOOR-020 + crisis-write exception
 *   - I-003 / I-027 audit invariants
 */

import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { config } from '../../src/lib/config.ts';
import { asTenantId } from '../../src/lib/glossary.ts';
import type { IdempotencyCtx } from '../../src/lib/idempotency.ts';
import { issueAccessToken } from '../../src/lib/jwt.ts';
import { ulid } from '../../src/lib/ulid.ts';
import { deriveDeterministicMode1Uuid } from '../../src/modules/ai-service/internal/handlers/chat.ts';
import { createAccount } from '../../src/modules/identity/internal/repositories/account-repo.ts';
import { asAccountId } from '../../src/modules/identity/internal/types.ts';
import {
  consumeMode1AuditFailureOrThrow,
  resetMode1AuditFailure,
  setMode1AuditFailure,
} from '../helpers/mode-1-chat-audit-injection.ts';
import { TENANT_US, withTenantContext } from '../helpers/tenant-fixtures.ts';
import { uniquePhone } from '../helpers/unique-phone.ts';
import { getTestClient } from '../setup.ts';

// ---------------------------------------------------------------------------
// vi.mock — replace emitMode1ChatResponseAudit with an injecting stub
// ---------------------------------------------------------------------------

// vi.mock is hoisted to the top of the module. The factory imports the
// real implementation via vi.importActual and wraps the Mode 1 emitter
// to consult the failure-injection flag before delegating. Other
// emitters in the same module (none currently other than the
// placeholder helper) are unaffected.
vi.mock('../../src/modules/ai-service/audit.ts', async () => {
  const actual = await vi.importActual<typeof import('../../src/modules/ai-service/audit.ts')>(
    '../../src/modules/ai-service/audit.ts',
  );
  return {
    ...actual,
    emitMode1ChatResponseAudit: async (
      args: Parameters<typeof actual.emitMode1ChatResponseAudit>[0],
      tx: Parameters<typeof actual.emitMode1ChatResponseAudit>[1],
    ): ReturnType<typeof actual.emitMode1ChatResponseAudit> => {
      consumeMode1AuditFailureOrThrow();
      return actual.emitMode1ChatResponseAudit(args, tx);
    },
  };
});

// buildApp must be imported AFTER the vi.mock call so the mock takes
// effect for the app's module graph. Done via dynamic import in beforeAll.

// ---------------------------------------------------------------------------
// Fixtures + helpers
// ---------------------------------------------------------------------------

const T_US = asTenantId(TENANT_US);
const US_HOST = 'heroshealth.com';
const SAFE_TEXT_SHORT = 'What time should I take my medication today?';
// Crisis text reused from ai-service-crisis-gate.test.ts so the
// detector keyword set is shared. Avoids drift if the keyword set
// is revised.
const CRISIS_TEXT_SHORT = "i don't want to live anymore, what should I do";

/**
 * Count Category A crisis_detection_trigger audit rows in the
 * configured tenant scoped to a specific patient/resource. Used by
 * H2 to assert exactly-one-audit-across-the-failed-attempt-and-retry
 * (Codex R1 H1 closure 2026-05-16 for PR #163: the original H2
 * didn't trigger or count the Category A audit; this helper closes
 * that gap).
 */
async function countCrisisAuditsForPatient(patientId: string): Promise<number> {
  return withTenantContext(T_US, async () => {
    const client = getTestClient();
    const res = await client.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM audit_records
        WHERE tenant_id = $1
          AND target_patient_id = $2
          AND action = 'crisis_detection_trigger'`,
      [T_US, patientId],
    );
    return Number.parseInt(res.rows[0]!.n, 10);
  });
}

let app: FastifyInstance | null = null;

beforeAll(async () => {
  process.env['NODE_ENV'] = 'test';
  // Dynamic import after the vi.mock factory is registered.
  const { buildApp } = await import('../../src/app.ts');
  app = await buildApp({ logger: false });
  await app.ready();
});

afterAll(async () => {
  if (app !== null) {
    await app.close();
  }
});

beforeEach(() => {
  resetMode1AuditFailure();
});

afterEach(() => {
  // Defense-in-depth: even though beforeEach resets, a test that
  // throws partway through could leave the mode non-normal. Reset
  // again on the way out.
  resetMode1AuditFailure();
});

/**
 * Seed a REAL patient account. The Mode 1 persistence path (migrations
 * 067/068) composite-FKs patient identity to
 * accounts(tenant_id, account_id), so requests that reach the
 * persistence phase must run under an existing account. Mirrors
 * ai-service-mode-1-chat-http.test.ts seedPatientAccount().
 */
async function seedPatientAccount(): Promise<string> {
  const accountId = asAccountId(ulid());
  const phone = uniquePhone('+1');
  await withTenantContext(T_US, () =>
    createAccount(
      {
        account_id: accountId,
        tenant_id: T_US,
        phone_e164: phone,
        first_name: 'A',
        last_name: 'B',
        date_of_birth: '1990-01-01',
        gender: 'prefer_not_to_say',
        country_of_residence: 'US',
        country_of_care: 'US',
      },
      async () => {},
    ),
  );
  return accountId;
}

function mintPatientToken(accountId: string): string {
  return issueAccessToken(
    {
      account_id: accountId,
      tenant_id: T_US,
      session_id: ulid(),
      role: 'patient',
      country_of_care: 'US',
    },
    config.jwtSigningKey,
  );
}

function patientHeaders(token: string, idempotencyKey: string): Record<string, string> {
  return {
    host: US_HOST,
    authorization: `Bearer ${token}`,
    'idempotency-key': idempotencyKey,
    'content-type': 'application/json',
  };
}

// ---------------------------------------------------------------------------
// Group H — Audit-failure injection round-trip
// ---------------------------------------------------------------------------

describe('Mode 1 chat — Group H: audit-failure injection round-trip (R7 round-trip closure)', () => {
  it('H1 fail-always → POST /v0/ai/chat → 503 with canonical error envelope', async () => {
    setMode1AuditFailure('fail-always');

    const accountId = await seedPatientAccount();
    const token = mintPatientToken(accountId);
    const response = await app!.inject({
      method: 'POST',
      url: '/v0/ai/chat',
      headers: patientHeaders(token, ulid()),
      payload: { message_text: SAFE_TEXT_SHORT },
    });
    expect(response.statusCode).toBe(503);
    const body = response.json<{
      error?: { code?: string; message?: string; request_id?: string };
    }>();
    expect(body.error).toBeDefined();
    expect(body.error?.code).toBe('ai_chat.audit_emission_unavailable');
    expect(typeof body.error?.message).toBe('string');
    expect(typeof body.error?.request_id).toBe('string');
  });

  it('H2 fail-once round-trip with CRISIS payload — first attempt 503, retry same key → 200 deterministic IDs, exactly ONE Category A audit', async () => {
    // R1 H1 closure (Codex 2026-05-16 on PR #163): use CRISIS payload
    // (not SAFE) so the Category A crisis_detection_trigger audit
    // actually fires. The deferred R7 invariant is "exactly ONE
    // Category A audit across the failed-attempt + retry pair" —
    // a non-crisis payload would emit zero Category A audits, so
    // the assertion would pass vacuously.
    const accountId = await seedPatientAccount();
    const token = mintPatientToken(accountId);
    const idempotencyKey = ulid();
    const payload = { message_text: CRISIS_TEXT_SHORT };

    // ATTEMPT 1: fail-once consumes itself; FLOOR-020 audit throws;
    // withIdempotentExecution catches the typed
    // Mode1AuditEmissionFailedError via mapServiceError and returns
    // 503; the cache reservation rolls back so the same key + body
    // can retry. The Category A crisis audit was emitted by
    // runCrisisGate INSIDE the same idempotent transaction (and
    // claimed its dedupe marker via idempotencyCtx).
    setMode1AuditFailure('fail-once');
    const r1 = await app!.inject({
      method: 'POST',
      url: '/v0/ai/chat',
      headers: patientHeaders(token, idempotencyKey),
      payload,
    });
    expect(r1.statusCode).toBe(503);

    // ATTEMPT 2: fail-once has self-reset to 'normal'. Same key + body.
    // Handler runs a FRESH lifecycle. Crisis gate re-evaluates the
    // input; per the gate's audit-dedupe protection (forms-intake
    // Sprint 34 / SI-006 pattern threaded to ai-service via
    // idempotencyCtx), the second emit is deduped — the dedupe
    // marker from attempt 1 survives the rollback of attempt 1's
    // outer transaction because dedupe markers commit independently.
    // Net: exactly ONE crisis audit across both attempts.
    const r2 = await app!.inject({
      method: 'POST',
      url: '/v0/ai/chat',
      headers: patientHeaders(token, idempotencyKey),
      payload,
    });
    expect(r2.statusCode).toBe(200);

    // Crisis sentinel response on the successful retry.
    const r2body = r2.json<Record<string, unknown>>();
    expect(r2body['crisis_detected']).toBe(true);
    expect(r2body['escalation_triggered']).toBe(true);

    // R1 H1 closure: assert EXACTLY ONE Category A
    // crisis_detection_trigger audit for this patient across the
    // failed-attempt + successful-retry pair. If the audit emitted
    // twice, the invariant is broken (retries would multiply
    // care-team alerts + escalation noise). If it emitted zero, the
    // test is vacuous.
    const crisisAuditCount = await countCrisisAuditsForPatient(accountId);
    expect(crisisAuditCount).toBe(1);

    const body2 = r2.json<Record<string, unknown>>();

    // Compute the EXPECTED deterministic IDs from the same idempotency
    // context the handler used. buildIdempotencyCtx() produces the 4-tuple
    // + bodyHash that's the input; here we reconstruct the salient fields
    // (the actorId / bodyHash details are abstracted by the handler).
    // What we CAN assert is the cross-attempt stability: if a future
    // refactor reverts deriveDeterministicMode1Uuid to random, r2's IDs would
    // STILL be different from a hypothetical attempt-1-success (no
    // observation of attempt 1's IDs because attempt 1 errored before
    // returning a body). The actual round-trip invariant — that the
    // crisis gate's dedupe key is stable across the failure — is
    // covered at the unit level (Group F in ai-service-mode-1-chat-http.test.ts)
    // AND functionally validated here by the second attempt's success.
    expect(typeof body2['ai_chat_session_id']).toBe('string');
    expect(typeof body2['message_id']).toBe('string');

    // R4 H1 deterministic ID invariant — explicit cross-check: the
    // session_id + message_id the SUCCESSFUL attempt returned MUST
    // match what deriveDeterministicMode1Uuid would produce for the
    // same idempotency context (persistence-era: the ids are the
    // migration-067 conversation/turn UUID primary keys). Reconstruct
    // the IdempotencyCtx the handler built and assert equality.
    //
    // The handler's buildIdempotencyCtx threads: tenantId from
    // tenantContext, idempotencyKey from header, endpoint from url,
    // actorId from actor.accountId, bodyHash from hashBody(rawBody).
    // We can compute the same values from the test inputs.
    //
    // For bodyHash: the lib/idempotency.ts hashBody function is the
    // canonical hasher. Importing it directly to avoid drift.
    const { hashBody } = await import('../../src/lib/idempotency.ts');
    const reconstructedCtx: IdempotencyCtx = {
      tenantId: T_US,
      idempotencyKey,
      endpoint: '/v0/ai/chat',
      actorId: accountId,
      bodyHash: hashBody(JSON.stringify(payload)),
    };
    const expectedSessionId = deriveDeterministicMode1Uuid(reconstructedCtx, 'conversation');
    const expectedMessageId = deriveDeterministicMode1Uuid(reconstructedCtx, 'turn');

    expect(body2['ai_chat_session_id']).toBe(expectedSessionId);
    expect(body2['message_id']).toBe(expectedMessageId);
  });
});
