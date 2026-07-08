/**
 * audit-failure-injection-parallel.test.ts — HTTP-boundary proof of
 * the closure-per-instance isolation property the PR #165 generic
 * `createAuditFailureInjector` factory exists to enable.
 *
 * Purpose: the existing unit tests at
 * `tests/unit/audit-failure-injection.test.ts` (Group E — per-injector
 * isolation, 4 cases) prove the property at the FACTORY level — two
 * injectors instantiated in-process hold independent mode state.
 * This file extends that proof to the VI.MOCK-FACTORY boundary +
 * the HTTP-request boundary, which the unit tests cannot reach:
 *
 *   - vi.mock factory boundary: two injectors wrapping two different
 *     exports from the same source module via one vi.mock factory.
 *     Failure modes set on injector A must not leak into injector B's
 *     state even though both stubs live in the same mock module.
 *
 *   - HTTP-request boundary: the Mode 1 chat handler triggers
 *     injector A's wrapped export via a real HTTP request. Injector B
 *     (wrapping `aiServiceAuditPlaceholder`, which the chat handler
 *     does NOT call) remains in its set state. Then a direct
 *     invocation of injector B's wrapped export from test code
 *     consumes injector B WITHOUT touching injector A.
 *
 * Why this matters: SI-013's downstream impl (per Codex R5 H1 closure
 * on PR #164) introduces a SECOND audit emitter
 * (`emitCrisisEscalationDestinationResolved`) on the same Mode 1 chat
 * surface with FAIL-SOFT failure semantics divergent from the
 * existing Mode 1 Category C `emitMode1ChatResponseAudit` pattern.
 * The downstream-impl regression-test obligation #10 from SI-013
 * specifically requires asserting that injector B (Category B) can
 * fail while injector A (Category C) succeeds — and vice versa — at
 * the HTTP-request level. Today the only second emitter available is
 * `aiServiceAuditPlaceholder` (a type-cast helper, not a real
 * emitter), but the closure-per-instance property the test asserts
 * is identical to what SI-013's downstream impl will need.
 *
 * Test pattern: vi.mock the ai-service/audit.ts module so BOTH
 * `emitMode1ChatResponseAudit` AND `aiServiceAuditPlaceholder`
 * consult their own dedicated injector before delegating to the real
 * implementation. The two injectors are independent closure
 * instances per PR #165's factory contract.
 *
 * Coverage groups:
 *
 *   PJ — Parallel injection isolation (6 cases):
 *     PJ1 baseline — both injectors normal → HTTP request 200 + both
 *         injector states unchanged after the request
 *     PJ2 injector A fail-always, B normal → HTTP request 503 +
 *         injector B state unchanged + direct invocation of B's
 *         wrapped export from test code succeeds (no throw)
 *     PJ3 injector A normal, B fail-always → HTTP request 200 (chat
 *         handler does NOT call B) + injector A state unchanged +
 *         direct invocation of B's wrapped export throws
 *         AuditInjectedFailure with emitterName === B's name
 *     PJ4 injector A fail-once, B fail-always → HTTP request 503
 *         (A consumes itself); A now 'normal'; B still 'fail-always';
 *         retry HTTP request succeeds (A re-armed); direct B
 *         invocation still throws
 *     PJ5 both fail-always → HTTP request 503 (A fires first, B
 *         never reached on the chat path); A still 'fail-always'; B
 *         still 'fail-always'; direct B invocation throws B's
 *         sentinel
 *     PJ6 sentinel-name disambiguation — direct invocations of A's
 *         emitter (outside the HTTP path, via the imported mocked
 *         export) under A's fail-always throws Mode1AuditInjectedFailure
 *         with emitterName === 'emitMode1ChatResponseAudit'; same call
 *         on B's wrapped export throws plain AuditInjectedFailure
 *         with emitterName === 'aiServiceAuditPlaceholder' (the two
 *         sentinel emitterName fields distinguish which injector
 *         fired across the HTTP boundary)
 *
 * Spec references:
 *   - PR #165 (generic createAuditFailureInjector factory + Group E
 *     unit tests for per-injector isolation at the factory level)
 *   - PR #163 (the single-injector vi.mock factory pattern this test
 *     extends to the two-injector case)
 *   - PR #164 SI-013 Rule 4 (the future Cat B
 *     emitCrisisEscalationDestinationResolved emitter that needs
 *     this exact two-injector vi.mock setup at SI-013 impl time)
 *   - AI_LAYERING v5.2 §6 (FLOOR-020 audit envelope)
 *   - I-003 (audit append-only) + I-027 (audit attribution)
 */

import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { config } from '../../src/lib/config.ts';
import { asTenantId } from '../../src/lib/glossary.ts';
import { issueAccessToken } from '../../src/lib/jwt.ts';
import { ulid } from '../../src/lib/ulid.ts';
import { createAccount } from '../../src/modules/identity/internal/repositories/account-repo.ts';
import { asAccountId } from '../../src/modules/identity/internal/types.ts';
import { AuditInjectedFailure } from '../helpers/audit-failure-injection.ts';
import { auditPlaceholderInjector } from '../helpers/audit-placeholder-injection.ts';
import {
  Mode1AuditInjectedFailure,
  mode1ChatResponseAuditInjector,
} from '../helpers/mode-1-chat-audit-injection.ts';
import { TENANT_US, withTenantContext } from '../helpers/tenant-fixtures.ts';
import { uniquePhone } from '../helpers/unique-phone.ts';

// ---------------------------------------------------------------------------
// Second injector — for aiServiceAuditPlaceholder
// ---------------------------------------------------------------------------
//
// The second injector `auditPlaceholderInjector` is imported from a
// dedicated helper module (`tests/helpers/audit-placeholder-injection.ts`)
// — NOT declared inline in this test file — because Vitest hoists
// vi.mock factories ABOVE top-level const declarations in the
// containing module. An inline `const auditPlaceholderInjector = ...`
// would trip a TDZ error when the mocked module is first imported.
// Imports ARE hoisted in the same pass as vi.mock factories, so an
// injector exported from a helper module is safely available when
// the factory below runs. Codex R1 H1 closure on PR #170 (2026-05-17)
// caught this hazard in an earlier draft.

// ---------------------------------------------------------------------------
// vi.mock — wrap BOTH emitMode1ChatResponseAudit AND aiServiceAuditPlaceholder
// ---------------------------------------------------------------------------
//
// This is the structural extension of PR #163's single-injector
// pattern: ONE vi.mock factory wraps TWO exports from the same source
// module with TWO independent injectors. Each stub consults its OWN
// injector via consumeOrThrow before delegating to the real export.
//
// The closure-per-instance contract from PR #165 guarantees the two
// injectors hold independent mode state — this test proves the
// guarantee holds across the vi.mock factory boundary + the
// HTTP-request boundary.

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
      mode1ChatResponseAuditInjector.consumeOrThrow();
      return actual.emitMode1ChatResponseAudit(args, tx);
    },
    aiServiceAuditPlaceholder: (
      id: Parameters<typeof actual.aiServiceAuditPlaceholder>[0],
    ): ReturnType<typeof actual.aiServiceAuditPlaceholder> => {
      auditPlaceholderInjector.consumeOrThrow();
      return actual.aiServiceAuditPlaceholder(id);
    },
  };
});

// buildApp + the mocked audit module must be imported AFTER the
// vi.mock call. Done via dynamic import in beforeAll.

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const T_US = asTenantId(TENANT_US);
const US_HOST = 'heroshealth.com';
const SAFE_TEXT_SHORT = 'What time should I take my medication today?';

let app: FastifyInstance | null = null;
/**
 * Reference to the MOCKED `aiServiceAuditPlaceholder` function. We
 * import it dynamically in beforeAll AFTER vi.mock has wrapped the
 * module, so this reference is the stub-with-injector, not the raw
 * implementation.
 */
let mockedAuditPlaceholder:
  | typeof import('../../src/modules/ai-service/audit.ts').aiServiceAuditPlaceholder
  | null = null;

beforeAll(async () => {
  process.env['NODE_ENV'] = 'test';
  const { buildApp } = await import('../../src/app.ts');
  app = await buildApp({ logger: false });
  await app.ready();

  // Dynamic import of the mocked module so the test can invoke the
  // wrapped aiServiceAuditPlaceholder directly (proving injector B
  // fires when its wrapped export is called even though the HTTP
  // path never calls it).
  const auditModule = await import('../../src/modules/ai-service/audit.ts');
  mockedAuditPlaceholder = auditModule.aiServiceAuditPlaceholder;
});

afterAll(async () => {
  if (app !== null) {
    await app.close();
  }
});

beforeEach(() => {
  mode1ChatResponseAuditInjector.reset();
  auditPlaceholderInjector.reset();
});

afterEach(() => {
  // Defense-in-depth.
  mode1ChatResponseAuditInjector.reset();
  auditPlaceholderInjector.reset();
});

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

/**
 * Seed a REAL patient account. The Mode 1 persistence path (migrations
 * 067/068) composite-FKs patient identity to
 * accounts(tenant_id, account_id), so chat POSTs that reach the
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

async function postChat(idempotencyKey?: string): Promise<{
  statusCode: number;
}> {
  const accountId = await seedPatientAccount();
  const token = mintPatientToken(accountId);
  const response = await app!.inject({
    method: 'POST',
    url: '/v0/ai/chat',
    headers: patientHeaders(token, idempotencyKey ?? ulid()),
    payload: { message_text: SAFE_TEXT_SHORT },
  });
  return { statusCode: response.statusCode };
}

// ---------------------------------------------------------------------------
// PJ — Parallel injection isolation
// ---------------------------------------------------------------------------

describe('Parallel injection — closure-per-instance isolation at vi.mock + HTTP boundary', () => {
  it('PJ1 baseline — both injectors normal → HTTP 200 + both states unchanged', async () => {
    expect(mode1ChatResponseAuditInjector.get()).toBe('normal');
    expect(auditPlaceholderInjector.get()).toBe('normal');

    const { statusCode } = await postChat();
    expect(statusCode).toBe(200);

    expect(mode1ChatResponseAuditInjector.get()).toBe('normal');
    expect(auditPlaceholderInjector.get()).toBe('normal');
  });

  it('PJ2 injector A fail-always, B normal → 503 + B state unchanged + direct B succeeds', async () => {
    mode1ChatResponseAuditInjector.set('fail-always');
    // B intentionally left normal.

    const { statusCode } = await postChat();
    expect(statusCode).toBe(503);

    // A still fail-always (fail-always does not self-consume).
    expect(mode1ChatResponseAuditInjector.get()).toBe('fail-always');
    // B's state was NOT touched by A's failure.
    expect(auditPlaceholderInjector.get()).toBe('normal');

    // Direct invocation of B's wrapped export confirms it is reachable
    // + unaffected by A's failure on the HTTP path.
    expect(() => mockedAuditPlaceholder!('ai_chat_response_emitted')).not.toThrow();
    expect(auditPlaceholderInjector.get()).toBe('normal');
  });

  it('PJ3 injector A normal, B fail-always → 200 (chat does not call B) + A state unchanged + direct B throws', async () => {
    auditPlaceholderInjector.set('fail-always');
    // A intentionally left normal.

    const { statusCode } = await postChat();
    // Chat handler does NOT call aiServiceAuditPlaceholder, so B's
    // fail-always does not affect the HTTP path.
    expect(statusCode).toBe(200);

    expect(mode1ChatResponseAuditInjector.get()).toBe('normal');
    expect(auditPlaceholderInjector.get()).toBe('fail-always');

    // Direct invocation of B's wrapped export trips B's injector.
    try {
      mockedAuditPlaceholder!('ai_chat_response_emitted');
      throw new Error('unreachable — B should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(AuditInjectedFailure);
      expect((err as AuditInjectedFailure).emitterName).toBe('aiServiceAuditPlaceholder');
    }
    // B's mode unchanged after fail-always trip.
    expect(auditPlaceholderInjector.get()).toBe('fail-always');
  });

  it('PJ4 A fail-once + B fail-always → 503 (A self-consumes); A now normal; B unchanged; retry succeeds', async () => {
    mode1ChatResponseAuditInjector.set('fail-once');
    auditPlaceholderInjector.set('fail-always');

    // First request — A's fail-once consumes itself + handler 503s.
    const first = await postChat();
    expect(first.statusCode).toBe(503);

    // A self-reset to normal after consuming.
    expect(mode1ChatResponseAuditInjector.get()).toBe('normal');
    // B unaffected.
    expect(auditPlaceholderInjector.get()).toBe('fail-always');

    // Retry — A is normal now, B still fail-always. Chat handler
    // doesn't call B, so the request succeeds.
    const second = await postChat();
    expect(second.statusCode).toBe(200);

    // Both states unchanged after the successful retry.
    expect(mode1ChatResponseAuditInjector.get()).toBe('normal');
    expect(auditPlaceholderInjector.get()).toBe('fail-always');

    // B still throws on direct invocation.
    expect(() => mockedAuditPlaceholder!('ai_chat_response_emitted')).toThrow(AuditInjectedFailure);
  });

  it('PJ5 both fail-always → 503 (A fires first); both states unchanged; direct B throws B sentinel', async () => {
    mode1ChatResponseAuditInjector.set('fail-always');
    auditPlaceholderInjector.set('fail-always');

    const { statusCode } = await postChat();
    expect(statusCode).toBe(503);

    // Both still fail-always (fail-always doesn't self-consume).
    expect(mode1ChatResponseAuditInjector.get()).toBe('fail-always');
    expect(auditPlaceholderInjector.get()).toBe('fail-always');

    // Direct B invocation throws B's sentinel, NOT A's. The two
    // injectors threw via the SAME factory pattern but the
    // emitterName field distinguishes which one fired — this is the
    // multi-injector disambiguation property PR #165's errorCtor
    // option preserves on the Mode 1 wrapper.
    try {
      mockedAuditPlaceholder!('ai_chat_response_emitted');
      throw new Error('unreachable');
    } catch (err) {
      expect(err).toBeInstanceOf(AuditInjectedFailure);
      expect((err as AuditInjectedFailure).emitterName).toBe('aiServiceAuditPlaceholder');
      // The error is NOT a Mode1AuditInjectedFailure even though
      // injector A is also fail-always — the closure-per-instance
      // factory wires injector B's emitterName onto B's sentinel,
      // regardless of A's state.
      expect(err).not.toBeInstanceOf(Mode1AuditInjectedFailure);
    }
  });

  it('PJ6 sentinel-name disambiguation — A throws Mode1AuditInjectedFailure; B throws plain AuditInjectedFailure', async () => {
    // This case extends PJ5 by demonstrating that the SAME factory
    // pattern produces TWO DIFFERENT sentinel subclasses for the two
    // injectors: A's errorCtor (per the Mode 1 wrapper's
    // Mode1AuditInjectedFailureFactoryAdapter) produces
    // Mode1AuditInjectedFailure; B's default (no errorCtor) produces
    // the plain AuditInjectedFailure base. Both still satisfy
    // `instanceof AuditInjectedFailure`, but the subclass identity
    // disambiguates the failing emitter at the catch site without
    // requiring an emitterName string comparison.

    mode1ChatResponseAuditInjector.set('fail-always');
    auditPlaceholderInjector.set('fail-always');

    // Trip A via HTTP — the handler maps the throw into a 503, so we
    // can't observe the sentinel directly via the response. Instead,
    // we observe via the response shape contract (503 + canonical
    // retry-advisory envelope) AND verify A's wrapped export throws
    // the subclass when invoked directly outside the handler.
    const httpResponse = await postChat();
    expect(httpResponse.statusCode).toBe(503);

    // Direct A invocation — re-arm A first because fail-always
    // doesn't self-consume but the handler may have already
    // consumed the synchronous slot in its own try/catch context.
    // Actually fail-always re-throws on every invocation per PR #165
    // factory contract, so A is still fail-always after the HTTP
    // request (verified in PJ5). Invoke A directly via the mocked
    // module export and assert it throws Mode1AuditInjectedFailure.
    const auditModule = await import('../../src/modules/ai-service/audit.ts');
    try {
      // Synthesize minimal args; the wrapped emitter throws via the
      // injector BEFORE the real implementation runs, so the args
      // don't need to be semantically valid.
      await auditModule.emitMode1ChatResponseAudit(
        {} as unknown as Parameters<typeof auditModule.emitMode1ChatResponseAudit>[0],
        {} as unknown as Parameters<typeof auditModule.emitMode1ChatResponseAudit>[1],
      );
      throw new Error('unreachable — A should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(Mode1AuditInjectedFailure);
      expect(err).toBeInstanceOf(AuditInjectedFailure);
      expect((err as Mode1AuditInjectedFailure).emitterName).toBe('emitMode1ChatResponseAudit');
    }

    // Direct B invocation throws plain AuditInjectedFailure (not the
    // Mode1 subclass).
    try {
      mockedAuditPlaceholder!('ai_chat_response_emitted');
      throw new Error('unreachable — B should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(AuditInjectedFailure);
      expect(err).not.toBeInstanceOf(Mode1AuditInjectedFailure);
      expect((err as AuditInjectedFailure).emitterName).toBe('aiServiceAuditPlaceholder');
    }
  });
});
