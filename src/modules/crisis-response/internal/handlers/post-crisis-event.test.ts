/**
 * post-crisis-event.test.ts — unit tests for the Sprint 2 PR 2 first
 * write-path handler in the Crisis Response slice
 * (POST /v0/crisis-events).
 *
 * Covers the handler's composition discipline at unit scope (no real DB):
 *   §1 happy path: tenant + crisis_initiator slice-role gate + body
 *      validation + withIdempotentExecution composes withTenantContext →
 *      withActorContext → withDbRole('crisis_initiator', ...) →
 *      wrapper SELECT → claimResourceLifecycleAuditSlot → audit emit;
 *      response is 201 + { crisis_event_id }.
 *   §2 tenant guard fires before idempotency wrap / tx open.
 *   §3 crisis_initiator slice-role gate fires before idempotency wrap /
 *      tx open.
 *   §4 body validation: missing / non-UUID / non-enum / non-boolean fields
 *      all → 400 BEFORE idempotency wrap; per-field coverage.
 *   §5 Cat A `crisis.detected` audit emitted in the same withDbRole-
 *      wrapping tx as the wrapper SELECT, with correct envelope fields
 *      (tenant_id, actor_tenant_id, target_patient_id, resource_id,
 *      detail.source_surface, action, category) AND correct ordering
 *      (wrapper SELECT → dedupe claim → audit emit). Includes §5c
 *      asserting dedupe-claim failures propagate atomically with the
 *      same I-003 discipline as audit-emit failures.
 *   §6 42501 from withDbRole → tenant-blind 403 via the canonical R2
 *      MED-1 closure pattern (catch wraps ENTIRE withDbRole call);
 *      covers both SET LOCAL ROLE elevation failure AND wrapper LAYER C
 *      tenant-scope guard failure (both surface as 42501).
 *   §7 actorNonce undefined → skip withActorContext but still call
 *      withDbRole + wrapper (parity with GET PR 1 §7).
 *   §8 idempotency-mismatch (wrapper raises SQLSTATE 23505) →
 *      tenant-blind 409 via mapServiceError; envelope does not echo
 *      tenant_id or server_signal_id.
 *   §9 replay-aware audit emission via resource-lifecycle dedupe
 *      (Codex R1 #201 finding 1 closure): wrapper idempotent-replay
 *      returning existing crisis_event_id → claim returns false →
 *      audit emit SKIPPED → 201 + same crisis_event_id. Closes the
 *      duplicate-audit hazard where a new HTTP Idempotency-Key
 *      against the same server_signal_id would otherwise re-emit
 *      `crisis.detected` Cat A.
 *
 * Mocking strategy mirrors get-crisis-event.test.ts §1-§4 pattern: vi.mock
 * the lib/* helpers + the audit emitter so handler composition is
 * observable + assertable without a real DB. Integration tests covering
 * the real DB-side privilege elevation + audit_records persistence + KMS
 * envelope land in Sprint 4 per README "Sprint 4 — Hardening".
 *
 * Pattern parity references:
 *   - get-crisis-event.test.ts (Sprint 2 PR 1 — read handler unit tests)
 *   - src/modules/admin-backend/internal/handlers/get-crisis-operational-
 *     health.test.ts (canonical first-handler-post-foundation-051 ref)
 *   - src/modules/async-consult/internal/handlers/consults.test.ts (POST
 *     handler + withIdempotentExecution mocking pattern; not strictly
 *     followed here because withIdempotentExecution is mocked as a pass-
 *     through that just runs the body callback with the fake tx — that's
 *     sufficient to assert the handler's composition contract)
 */

import type { FastifyReply, FastifyRequest } from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// vi.mock hoists ABOVE imports — declare BEFORE the handler is imported
// so the mocks are in place when the handler module evaluates.
vi.mock('../../../../lib/auth-context.js', () => ({
  requireCrisisInitiatorActorContext: vi.fn(),
  resolveActorTenantIdForAudit: vi.fn(),
}));
vi.mock('../../../../lib/tenant-context.js', () => ({
  requireTenantContext: vi.fn(),
}));
vi.mock('../../../../lib/idempotent-handler.js', () => ({
  withIdempotentExecution: vi.fn(),
}));
vi.mock('../../../../lib/rls.js', () => ({
  withTenantContext: vi.fn(),
}));
vi.mock('../../../../lib/actor-context-binding.js', () => ({
  withActorContext: vi.fn(),
}));
vi.mock('../../../../lib/with-db-role.js', () => ({
  withDbRole: vi.fn(),
}));
vi.mock('../../../../lib/audit-dedupe.js', () => ({
  claimResourceLifecycleAuditSlot: vi.fn(),
}));
vi.mock('../../audit.js', () => ({
  emitCrisisDetectedAudit: vi.fn(),
}));

// Imports AFTER the vi.mock declarations.
import { withActorContext } from '../../../../lib/actor-context-binding.js';
import { claimResourceLifecycleAuditSlot } from '../../../../lib/audit-dedupe.js';
import {
  requireCrisisInitiatorActorContext,
  resolveActorTenantIdForAudit,
} from '../../../../lib/auth-context.js';
import { withIdempotentExecution } from '../../../../lib/idempotent-handler.js';
import { withTenantContext } from '../../../../lib/rls.js';
import { requireTenantContext } from '../../../../lib/tenant-context.js';
import { withDbRole } from '../../../../lib/with-db-role.js';
import { emitCrisisDetectedAudit } from '../../audit.js';

import { postCrisisEventHandler } from './post-crisis-event.js';

// ---------------------------------------------------------------------------
// Fixtures + harness
// ---------------------------------------------------------------------------

const FAKE_TENANT_CTX = {
  tenantId: 'Telecheck-US',
  displayName: 'Telecheck-US',
  countryOfCare: 'US' as const,
  kmsKeyAlias: 'alias/telecheck-us-data-key',
  consumerDba: 'Heros Health',
  legalEntity: 'Telecheck Health LLC',
  consumerSubdomain: 'heroshealth.com',
};

const FAKE_CLINICIAN_ACTOR = {
  accountId: '01HTEST0ACT0R000000000000A',
  sessionId: 'sess-fake',
  tenantId: 'Telecheck-US',
  role: 'clinician' as const,
  countryOfCare: 'US' as const,
  delegateId: null,
  adminTenantBinding: null,
  adminHomeTenantId: null,
  // Codex R1 #201 finding 2: requireCrisisInitiatorActorContext
  // returns a CrisisInitiatorActorContext (ActorContext + bound
  // crisis_initiator slice-role identity per SI-022 §7). For Sprint 2
  // PR 2 the JWT role='clinician' branch maps to identity='clinician';
  // future on_call_clinician + ai_mode1_service branches expand here
  // when the JWT-role → DB-slice-role mapping lands.
  crisisInitiatorIdentity: 'clinician' as const,
};

const VALID_PATIENT_ID = '01HTEST0PATNT00000000000P0';
const VALID_SERVER_SIGNAL_ID = '22222222-3333-4444-8555-666666666666';
const RETURNED_CRISIS_EVENT_ID = '33333333-4444-4555-8666-777777777777';

function validBody(overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    patient_account_id: VALID_PATIENT_ID, // SI-025 P-045
    server_signal_id: VALID_SERVER_SIGNAL_ID,
    crisis_type: 'suicidal_ideation',
    severity: 'imminent',
    regulatory_reporting_enabled: true,
    source_surface: 'mode_1_chat',
    ...overrides,
  };
}

interface FakeTx {
  query: ReturnType<typeof vi.fn>;
}

function makeFakeTx(): FakeTx {
  return {
    query: vi.fn(async () => ({
      rows: [{ crisis_event_id: RETURNED_CRISIS_EVENT_ID }],
      rowCount: 1,
    })),
  };
}

function makeReq(opts?: {
  body?: Record<string, unknown> | undefined;
  actorNonce?: string | undefined;
}): FastifyRequest {
  return {
    id: 'req-fake-id',
    body: opts && 'body' in opts ? opts.body : validBody(),
    actorNonce: opts?.actorNonce,
    server: {
      httpErrors: {
        badRequest: (msg: string) => {
          const e = new Error(msg);
          (e as Error & { statusCode: number }).statusCode = 400;
          return e;
        },
        forbidden: (msg: string) => {
          const e = new Error(msg);
          (e as Error & { statusCode: number }).statusCode = 403;
          return e;
        },
        notFound: (msg: string) => {
          const e = new Error(msg);
          (e as Error & { statusCode: number }).statusCode = 404;
          return e;
        },
      },
    },
  } as unknown as FastifyRequest;
}

function makeReply(): FastifyReply {
  const reply = {
    code: vi.fn((_: number) => reply),
    send: vi.fn((body: unknown) => body),
  };
  return reply as unknown as FastifyReply;
}

/**
 * Install pass-through implementations for the composition helpers.
 * Default: composition succeeds + the innermost callback runs against
 * the supplied fake tx + the wrapper SELECT returns the canonical row.
 *
 * `withIdempotentExecution` is mocked as a pass-through that runs the
 * body callback with the fake tx and replies with the resulting
 * { status, view }. This is sufficient to assert the handler's
 * composition contract — integration tests cover the real reserve-
 * then-execute + replay + body-mismatch paths.
 */
function installDefaultCompositionMocks(tx: FakeTx): void {
  vi.mocked(requireTenantContext).mockReturnValue(
    FAKE_TENANT_CTX as unknown as ReturnType<typeof requireTenantContext>,
  );
  vi.mocked(requireCrisisInitiatorActorContext).mockReturnValue(
    FAKE_CLINICIAN_ACTOR as unknown as ReturnType<typeof requireCrisisInitiatorActorContext>,
  );
  vi.mocked(resolveActorTenantIdForAudit).mockReturnValue('Telecheck-US');
  vi.mocked(withIdempotentExecution).mockImplementation(async (req, reply, _mapErr, body) => {
    try {
      const result = await body(
        tx as unknown as Parameters<typeof body>[0],
        { tenant_id: 'Telecheck-US' } as unknown as Parameters<typeof body>[1],
      );
      return reply.code(result.status).send(result.view);
    } catch (err) {
      // Forward via the same shape as the real helper's catch-with-
      // mapServiceError path — pull mapServiceError out of the call
      // and invoke it manually since this mock doesn't replicate the
      // full library control flow.
      const map = _mapErr as (e: unknown, r: FastifyReply, reqId: string) => boolean;
      if (map(err, reply, req.id)) return reply;
      throw err;
    }
  });
  vi.mocked(withTenantContext).mockImplementation(async (_client, _tenantId, fn) =>
    fn(tx as unknown as Parameters<typeof fn>[0]),
  );
  vi.mocked(withActorContext).mockImplementation(async (_tx, _nonce, fn) => fn());
  vi.mocked(withDbRole).mockImplementation(async (_tx, _role, fn) => fn());
  // Default: marker claim succeeds (first-attempt path) → audit emits.
  // Replay-aware test cases override to return false to assert the
  // dedupe short-circuit per Codex R1 #201 finding 1 closure.
  vi.mocked(claimResourceLifecycleAuditSlot).mockResolvedValue(true);
  vi.mocked(emitCrisisDetectedAudit).mockResolvedValue({
    audit_id: 'aud_fake',
  } as unknown as Awaited<ReturnType<typeof emitCrisisDetectedAudit>>);
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// §1 — happy path: full composition in canonical order
// ---------------------------------------------------------------------------

describe('postCrisisEventHandler §1 — happy path composition', () => {
  it('§1a invokes requireTenantContext, requireCrisisInitiatorActorContext, withIdempotentExecution, withTenantContext, withActorContext, withDbRole, then queries the wrapper + emits audit', async () => {
    const tx = makeFakeTx();
    installDefaultCompositionMocks(tx);
    const req = makeReq({ actorNonce: 'fake-uuid-v4-nonce' });
    const reply = makeReply();

    await postCrisisEventHandler(req, reply);

    expect(requireTenantContext).toHaveBeenCalledWith(req);
    expect(requireCrisisInitiatorActorContext).toHaveBeenCalledWith(req);
    expect(withIdempotentExecution).toHaveBeenCalledTimes(1);
    expect(withTenantContext).toHaveBeenCalledTimes(1);
    expect(withTenantContext).toHaveBeenCalledWith(tx, 'Telecheck-US', expect.any(Function));
    expect(withActorContext).toHaveBeenCalledTimes(1);
    expect(withActorContext).toHaveBeenCalledWith(tx, 'fake-uuid-v4-nonce', expect.any(Function));
    expect(withDbRole).toHaveBeenCalledTimes(1);
    expect(withDbRole).toHaveBeenCalledWith(tx, 'crisis_initiator', expect.any(Function));

    // The wrapper SELECT.
    expect(tx.query).toHaveBeenCalledTimes(1);
    const [sql, params] = tx.query.mock.calls[0]!;
    expect(sql).toContain('record_crisis_initiation');
    // Sprint 4: the wrapper is ALWAYS called with the full 14-param
    // signature; the 8 KMS envelope params ($7..$14) bind NULL when the
    // optional intake_payload_envelope is absent (migration 033 §4
    // all-NULL CHECK branch — Sprint 2 behavior preserved).
    expect(params).toEqual([
      'Telecheck-US',
      VALID_PATIENT_ID,
      VALID_SERVER_SIGNAL_ID,
      'suicidal_ideation',
      'imminent',
      true,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
    ]);

    // Replay-aware audit dedupe (Codex R1 #201 finding 1 closure): the
    // marker claim happens in the same tx as the audit emit + wrapper
    // INSERT. Keyed on the canonical resource (crisis_event_id) so
    // wrapper-level idempotent replays from different Idempotency-Keys
    // against the same server_signal_id do NOT duplicate the audit row.
    expect(claimResourceLifecycleAuditSlot).toHaveBeenCalledTimes(1);
    expect(claimResourceLifecycleAuditSlot).toHaveBeenCalledWith(tx, {
      tenantId: 'Telecheck-US',
      resourceType: 'crisis_event',
      resourceId: RETURNED_CRISIS_EVENT_ID,
      auditAction: 'crisis.detected',
    });

    // Audit emitted in the same tx (claim succeeded → first-attempt path).
    expect(emitCrisisDetectedAudit).toHaveBeenCalledTimes(1);
    const [auditArgs, auditTx] = vi.mocked(emitCrisisDetectedAudit).mock.calls[0]!;
    expect(auditTx).toBe(tx);
    expect(auditArgs.tenantId).toBe('Telecheck-US');
    // Codex R1 #201 finding 2: the bound SI-022 §7 slice-role identity
    // is threaded into the emitter so actor_type derives from it.
    expect(auditArgs.crisisInitiatorIdentity).toBe('clinician');
    expect(auditArgs.crisisEventId).toBe(RETURNED_CRISIS_EVENT_ID);
    expect(auditArgs.targetPatientId).toBe(VALID_PATIENT_ID);
    expect(auditArgs.serverSignalId).toBe(VALID_SERVER_SIGNAL_ID);
    expect(auditArgs.crisisType).toBe('suicidal_ideation');
    expect(auditArgs.severity).toBe('imminent');
    expect(auditArgs.regulatoryReportingEnabled).toBe(true);
    expect(auditArgs.sourceSurface).toBe('mode_1_chat');

    // 201 + minimal response view.
    expect(reply.code).toHaveBeenCalledWith(201);
    expect(reply.send).toHaveBeenCalledWith({ crisis_event_id: RETURNED_CRISIS_EVENT_ID });
  });
});

// ---------------------------------------------------------------------------
// §2 — tenant guard fires before idempotency wrap / tx open
// ---------------------------------------------------------------------------

describe('postCrisisEventHandler §2 — tenant guard precedes idempotency wrap', () => {
  it('§2a requireTenantContext throw aborts before withIdempotentExecution / clinician gate / body validation', async () => {
    vi.mocked(requireTenantContext).mockImplementation(() => {
      throw new Error('tenantContext absent — programming error');
    });

    await expect(postCrisisEventHandler(makeReq(), makeReply())).rejects.toThrow(
      /tenantContext absent/,
    );

    expect(requireCrisisInitiatorActorContext).not.toHaveBeenCalled();
    expect(withIdempotentExecution).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// §3 — crisis_initiator slice-role gate fires before idempotency wrap / tx open
// ---------------------------------------------------------------------------

describe('postCrisisEventHandler §3 — crisis_initiator slice-role gate precedes idempotency wrap', () => {
  it('§3a requireCrisisInitiatorActorContext throw aborts before withIdempotentExecution', async () => {
    vi.mocked(requireTenantContext).mockReturnValue(
      FAKE_TENANT_CTX as unknown as ReturnType<typeof requireTenantContext>,
    );
    vi.mocked(requireCrisisInitiatorActorContext).mockImplementation(() => {
      throw new Error('forbidden: actor role=patient does not satisfy crisis_initiator gate');
    });

    await expect(postCrisisEventHandler(makeReq(), makeReply())).rejects.toThrow(/forbidden/);

    expect(withIdempotentExecution).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// §4 — body validation precedes idempotency wrap (400 returned directly)
// ---------------------------------------------------------------------------

describe('postCrisisEventHandler §4 — body validation precedes idempotency wrap', () => {
  it.each<[string, Record<string, unknown> | undefined]>([
    ['missing body entirely (undefined)', undefined],
    ['missing patient_account_id', validBody({ patient_account_id: undefined })],
    ['non-ULID patient_account_id', validBody({ patient_account_id: 'not-a-ulid' })],
    ['missing server_signal_id', validBody({ server_signal_id: undefined })],
    ['non-UUID server_signal_id', validBody({ server_signal_id: 'NOT_A_UUID_AT_ALL' })],
    ['missing crisis_type', validBody({ crisis_type: undefined })],
    ['invalid crisis_type', validBody({ crisis_type: 'not_a_valid_type' })],
    ['missing severity', validBody({ severity: undefined })],
    ['invalid severity', validBody({ severity: 'critical_lol' })],
    [
      'non-boolean regulatory_reporting_enabled (string)',
      validBody({ regulatory_reporting_enabled: 'true' }),
    ],
    [
      'missing regulatory_reporting_enabled',
      validBody({ regulatory_reporting_enabled: undefined }),
    ],
    ['missing source_surface', validBody({ source_surface: undefined })],
    ['invalid source_surface', validBody({ source_surface: 'sms' })],
  ])('§4 returns 400 BEFORE idempotency wrap: %s', async (_label, body) => {
    const tx = makeFakeTx();
    installDefaultCompositionMocks(tx);

    const req = makeReq({ body });
    const reply = makeReply();
    await postCrisisEventHandler(req, reply);

    expect(reply.code).toHaveBeenCalledWith(400);
    expect(withIdempotentExecution).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// §5 — Cat A audit emitted in same tx with correct envelope fields
// ---------------------------------------------------------------------------

describe('postCrisisEventHandler §5 — Cat A audit emission in same tx', () => {
  it('§5a emitCrisisDetectedAudit is called AFTER withDbRole returns AND AFTER claimResourceLifecycleAuditSlot (same tx; canonical FLOOR-020 ordering)', async () => {
    const tx = makeFakeTx();
    installDefaultCompositionMocks(tx);
    const callOrder: string[] = [];
    vi.mocked(withDbRole).mockImplementation(async (_tx, _role, fn) => {
      callOrder.push('withDbRole-enter');
      const out = await fn();
      callOrder.push('withDbRole-exit');
      return out;
    });
    vi.mocked(claimResourceLifecycleAuditSlot).mockImplementation(async () => {
      callOrder.push('dedupe-claim');
      return true;
    });
    vi.mocked(emitCrisisDetectedAudit).mockImplementation(async () => {
      callOrder.push('audit-emit');
      return { audit_id: 'aud_fake' } as unknown as Awaited<
        ReturnType<typeof emitCrisisDetectedAudit>
      >;
    });

    await postCrisisEventHandler(makeReq({ actorNonce: 'fake-nonce' }), makeReply());

    expect(callOrder).toEqual([
      'withDbRole-enter',
      'withDbRole-exit',
      'dedupe-claim',
      'audit-emit',
    ]);
  });

  it('§5b audit emit failure propagates (I-003 bare suppression forbidden); response never reaches 201', async () => {
    const tx = makeFakeTx();
    installDefaultCompositionMocks(tx);
    vi.mocked(emitCrisisDetectedAudit).mockRejectedValueOnce(
      new Error('emitAudit: durable INSERT failed for crisis.detected'),
    );

    const reply = makeReply();
    await expect(
      postCrisisEventHandler(makeReq({ actorNonce: 'fake-nonce' }), reply),
    ).rejects.toThrow(/durable INSERT failed/);

    // 201 must NEVER have been sent on the audit-failure path.
    expect(reply.code).not.toHaveBeenCalledWith(201);
  });

  it('§5c dedupe-claim failure propagates (same atomicity contract as audit-emit failure); response never reaches 201', async () => {
    const tx = makeFakeTx();
    installDefaultCompositionMocks(tx);
    vi.mocked(claimResourceLifecycleAuditSlot).mockRejectedValueOnce(
      new Error('audit_dedupe_markers INSERT failed'),
    );

    const reply = makeReply();
    await expect(
      postCrisisEventHandler(makeReq({ actorNonce: 'fake-nonce' }), reply),
    ).rejects.toThrow(/audit_dedupe_markers INSERT failed/);

    expect(emitCrisisDetectedAudit).not.toHaveBeenCalled();
    expect(reply.code).not.toHaveBeenCalledWith(201);
  });
});

// ---------------------------------------------------------------------------
// §6 — 42501 from withDbRole → tenant-blind 403 (R2 MED-1 closure pattern)
// ---------------------------------------------------------------------------

describe('postCrisisEventHandler §6 — 42501 → tenant-blind 403', () => {
  it('§6a 42501 from withDbRole SET LOCAL ROLE elevation → forbidden 403; audit not emitted', async () => {
    const tx = makeFakeTx();
    installDefaultCompositionMocks(tx);
    // SET LOCAL ROLE failure surfaces as 42501 raised from withDbRole
    // itself (BEFORE the callback runs). The R2 MED-1 closure pattern
    // wraps the entire withDbRole call so this is caught + mapped to
    // tenant-blind 403.
    vi.mocked(withDbRole).mockRejectedValueOnce({
      code: '42501',
      message: 'permission denied to set role',
    });

    await expect(
      postCrisisEventHandler(makeReq({ actorNonce: 'fake-nonce' }), makeReply()),
    ).rejects.toThrow(/Insufficient scope/);

    // No audit emitted on the privilege-failure path (no crisis_event
    // row was created).
    expect(emitCrisisDetectedAudit).not.toHaveBeenCalled();
  });

  it('§6b 42501 from wrapper LAYER C tenant-scope guard → forbidden 403; audit not emitted', async () => {
    const tx = makeFakeTx();
    installDefaultCompositionMocks(tx);
    // wrapper LAYER C surfaces inside the withDbRole callback (the
    // wrapper SELECT throws); the same try/catch wrapping the entire
    // withDbRole call maps it to 403 too.
    tx.query.mockImplementationOnce(async () => {
      const err: Error & { code?: string } = new Error(
        'record_crisis_initiation: tenant scope mismatch — ...',
      );
      err.code = '42501';
      throw err;
    });

    await expect(
      postCrisisEventHandler(makeReq({ actorNonce: 'fake-nonce' }), makeReply()),
    ).rejects.toThrow(/Insufficient scope/);

    expect(emitCrisisDetectedAudit).not.toHaveBeenCalled();
  });

  it('§6c non-42501 PG error propagates unchanged (e.g., undefined_function 42883)', async () => {
    const tx = makeFakeTx();
    installDefaultCompositionMocks(tx);
    tx.query.mockImplementationOnce(async () => {
      const err: Error & { code?: string } = new Error(
        'function record_crisis_initiation does not exist',
      );
      err.code = '42883';
      throw err;
    });

    await expect(
      postCrisisEventHandler(makeReq({ actorNonce: 'fake-nonce' }), makeReply()),
    ).rejects.toThrow(/function record_crisis_initiation does not exist/);
  });
});

// ---------------------------------------------------------------------------
// §7 — actorNonce undefined → skip withActorContext but still query wrapper
// ---------------------------------------------------------------------------

describe('postCrisisEventHandler §7 — missing actorNonce skips withActorContext', () => {
  it('§7a undefined actorNonce skips withActorContext but still calls withDbRole + wrapper SELECT + audit emit', async () => {
    const tx = makeFakeTx();
    installDefaultCompositionMocks(tx);

    await postCrisisEventHandler(makeReq({ actorNonce: undefined }), makeReply());

    expect(withActorContext).not.toHaveBeenCalled();
    expect(withDbRole).toHaveBeenCalledTimes(1);
    expect(tx.query).toHaveBeenCalledTimes(1);
    expect(emitCrisisDetectedAudit).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// §8 — idempotency-mismatch SQLSTATE 23505 → tenant-blind 409
// ---------------------------------------------------------------------------

describe('postCrisisEventHandler §8 — idempotency-mismatch → tenant-blind 409', () => {
  it('§8a wrapper raises SQLSTATE 23505 → handler responds 409 with stable code; envelope omits tenant_id + server_signal_id', async () => {
    const tx = makeFakeTx();
    installDefaultCompositionMocks(tx);
    tx.query.mockImplementationOnce(async () => {
      const err: Error & { code?: string } = new Error(
        'record_crisis_initiation: idempotency-mismatch — existing crisis_event for ' +
          '(tenant_id=Telecheck-US, server_signal_id=' +
          VALID_SERVER_SIGNAL_ID +
          ') has different immutable fields',
      );
      err.code = '23505';
      throw err;
    });

    const reply = makeReply();
    await postCrisisEventHandler(makeReq({ actorNonce: 'fake-nonce' }), reply);

    expect(reply.code).toHaveBeenCalledWith(409);
    const sentBody = vi.mocked(reply.send).mock.calls[0]?.[0] as
      | { error?: { code?: string; message?: string } }
      | undefined;
    expect(sentBody?.error?.code).toBe('internal.resource.conflict');
    // I-025: envelope must not echo tenant_id or server_signal_id from
    // the wrapper's message.
    const serializedBody = JSON.stringify(sentBody);
    expect(serializedBody).not.toContain('Telecheck-US');
    expect(serializedBody).not.toContain(VALID_SERVER_SIGNAL_ID);
  });
});

// ---------------------------------------------------------------------------
// §9 — replay-aware audit emission via resource-lifecycle dedupe (Codex R1
// #201 finding 1 closure 2026-05-24)
// ---------------------------------------------------------------------------

describe('postCrisisEventHandler §9 — replay-aware audit emission', () => {
  it('§9a wrapper idempotent-replay returning existing crisis_event_id: claim returns false (marker already committed by prior successful tx) → audit emit is SKIPPED → handler still returns 201 + the same crisis_event_id', async () => {
    const tx = makeFakeTx();
    installDefaultCompositionMocks(tx);
    // Marker INSERT hits ON CONFLICT (a prior successful tx for this
    // canonical crisis_event_id already committed the marker) →
    // claimed=false → audit emit SKIPPED. This is the replay-hazard
    // path: a NEW HTTP Idempotency-Key against the SAME
    // server_signal_id reaches the wrapper, the wrapper returns the
    // existing crisis_event_id via its internal idempotency, and the
    // handler MUST NOT re-emit the lifecycle audit (which would
    // duplicate the audit row in the chain).
    vi.mocked(claimResourceLifecycleAuditSlot).mockResolvedValueOnce(false);

    const reply = makeReply();
    await postCrisisEventHandler(makeReq({ actorNonce: 'fake-nonce' }), reply);

    // Wrapper SELECT still ran (returning the existing event ID).
    expect(tx.query).toHaveBeenCalledTimes(1);
    // Marker claim ran (returned false).
    expect(claimResourceLifecycleAuditSlot).toHaveBeenCalledTimes(1);
    expect(claimResourceLifecycleAuditSlot).toHaveBeenCalledWith(tx, {
      tenantId: 'Telecheck-US',
      resourceType: 'crisis_event',
      resourceId: RETURNED_CRISIS_EVENT_ID,
      auditAction: 'crisis.detected',
    });
    // Audit emit SKIPPED on the dedupe path.
    expect(emitCrisisDetectedAudit).not.toHaveBeenCalled();
    // 201 + same crisis_event_id (matches the originating tx's
    // response shape — wrapper-level idempotent-replay value).
    expect(reply.code).toHaveBeenCalledWith(201);
    expect(reply.send).toHaveBeenCalledWith({
      crisis_event_id: RETURNED_CRISIS_EVENT_ID,
    });
  });

  it('§9b first-attempt path: claim returns true → audit emits once → 201 + crisis_event_id (positive companion of §9a)', async () => {
    const tx = makeFakeTx();
    installDefaultCompositionMocks(tx);
    // Default mock returns true; assert the canonical path explicitly
    // so a regression that flips the default would break this test.
    vi.mocked(claimResourceLifecycleAuditSlot).mockResolvedValueOnce(true);

    const reply = makeReply();
    await postCrisisEventHandler(makeReq({ actorNonce: 'fake-nonce' }), reply);

    expect(claimResourceLifecycleAuditSlot).toHaveBeenCalledTimes(1);
    expect(emitCrisisDetectedAudit).toHaveBeenCalledTimes(1);
    expect(reply.code).toHaveBeenCalledWith(201);
  });

  it('§9c claim is invoked AFTER the wrapper SELECT completes (the resource_id is the wrapper-returned UUID, not a caller-supplied value)', async () => {
    const tx = makeFakeTx();
    installDefaultCompositionMocks(tx);
    const callOrder: string[] = [];
    tx.query.mockImplementationOnce(async () => {
      callOrder.push('wrapper-select');
      return { rows: [{ crisis_event_id: RETURNED_CRISIS_EVENT_ID }], rowCount: 1 };
    });
    vi.mocked(claimResourceLifecycleAuditSlot).mockImplementation(async () => {
      callOrder.push('dedupe-claim');
      return true;
    });

    await postCrisisEventHandler(makeReq({ actorNonce: 'fake-nonce' }), makeReply());

    // Wrapper SELECT MUST run first (the marker's resource_id is the
    // wrapper-returned crisis_event_id, not a caller-supplied UUID).
    expect(callOrder).toEqual(['wrapper-select', 'dedupe-claim']);
  });
});

// ---------------------------------------------------------------------------
// §10 — Sprint 4: optional pre-encrypted intake_payload KMS envelope
// ---------------------------------------------------------------------------

const VALID_DEK_ID = '44444444-5555-4666-8777-888888888888';
const VALID_KEK_ID = '55555555-6666-4777-8888-999999999999';

function validEnvelope(overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    ciphertext_b64: Buffer.from('sealed:intake-payload').toString('base64'),
    dek_id: VALID_DEK_ID,
    dek_version: 1,
    iv_b64: Buffer.from('0123456789ab').toString('base64'),
    auth_tag_b64: Buffer.from('0123456789abcdef').toString('base64'),
    kek_id: VALID_KEK_ID,
    kek_version: 2,
    algorithm: 'AES-256-GCM',
    ...overrides,
  };
}

describe('postCrisisEventHandler §10 — intake_payload KMS envelope (Sprint 4)', () => {
  it('§10a valid envelope: decoded fields bind as wrapper params $7..$14 (BYTEA as Buffers; UUIDs/ints/text passthrough) → 201', async () => {
    const tx = makeFakeTx();
    installDefaultCompositionMocks(tx);
    const reply = makeReply();

    await postCrisisEventHandler(
      makeReq({
        actorNonce: 'fake-nonce',
        body: validBody({ intake_payload_envelope: validEnvelope() }),
      }),
      reply,
    );

    expect(tx.query).toHaveBeenCalledTimes(1);
    const [sql, params] = tx.query.mock.calls[0]! as [string, unknown[]];
    expect(sql).toContain('record_crisis_initiation');
    expect(sql).toContain('$14');
    expect(params).toHaveLength(14);
    expect(Buffer.isBuffer(params[6])).toBe(true);
    expect((params[6] as Buffer).toString()).toBe('sealed:intake-payload');
    expect(params[7]).toBe(VALID_DEK_ID);
    expect(params[8]).toBe(1);
    expect(Buffer.isBuffer(params[9])).toBe(true);
    expect((params[9] as Buffer).toString()).toBe('0123456789ab');
    expect(Buffer.isBuffer(params[10])).toBe(true);
    expect((params[10] as Buffer).toString()).toBe('0123456789abcdef');
    expect(params[11]).toBe(VALID_KEK_ID);
    expect(params[12]).toBe(2);
    expect(params[13]).toBe('AES-256-GCM');
    expect(reply.code).toHaveBeenCalledWith(201);
  });

  it('§10b envelope absent: params $7..$14 are all NULL (Sprint 2 wire behavior preserved) → 201', async () => {
    const tx = makeFakeTx();
    installDefaultCompositionMocks(tx);
    const reply = makeReply();

    await postCrisisEventHandler(makeReq({ actorNonce: 'fake-nonce' }), reply);

    const [, params] = tx.query.mock.calls[0]! as [string, unknown[]];
    expect(params.slice(6)).toEqual([null, null, null, null, null, null, null, null]);
    expect(reply.code).toHaveBeenCalledWith(201);
  });

  it('§10c partial/malformed envelopes → 400 BEFORE any tx work (all-or-none per migration 033 §4 CHECK)', async () => {
    const badEnvelopes: unknown[] = [
      // Missing one of the 8 fields, each.
      (() => {
        const e = validEnvelope();
        delete e['ciphertext_b64'];
        return e;
      })(),
      (() => {
        const e = validEnvelope();
        delete e['dek_id'];
        return e;
      })(),
      (() => {
        const e = validEnvelope();
        delete e['dek_version'];
        return e;
      })(),
      (() => {
        const e = validEnvelope();
        delete e['iv_b64'];
        return e;
      })(),
      (() => {
        const e = validEnvelope();
        delete e['auth_tag_b64'];
        return e;
      })(),
      (() => {
        const e = validEnvelope();
        delete e['kek_id'];
        return e;
      })(),
      (() => {
        const e = validEnvelope();
        delete e['kek_version'];
        return e;
      })(),
      (() => {
        const e = validEnvelope();
        delete e['algorithm'];
        return e;
      })(),
      // Malformed field shapes.
      validEnvelope({ ciphertext_b64: 'not-base64-!!!' }),
      validEnvelope({ dek_id: 'not-a-uuid' }),
      validEnvelope({ dek_version: 0 }),
      validEnvelope({ dek_version: 1.5 }),
      validEnvelope({ kek_version: -1 }),
      validEnvelope({ algorithm: '' }),
      // Non-object envelope roots.
      'a-string',
      42,
      ['an', 'array'],
    ];

    for (const intake_payload_envelope of badEnvelopes) {
      const tx = makeFakeTx();
      installDefaultCompositionMocks(tx);
      const reply = makeReply();

      await postCrisisEventHandler(
        makeReq({
          actorNonce: 'fake-nonce',
          body: validBody({ intake_payload_envelope }),
        }),
        reply,
      );

      expect(reply.code).toHaveBeenCalledWith(400);
      const sentBody = vi.mocked(reply.send).mock.calls[0]?.[0] as
        | { error?: { code?: string; message?: string } }
        | undefined;
      expect(sentBody?.error?.code).toBe('internal.request.invalid');
      expect(sentBody?.error?.message).toContain('intake_payload_envelope');
      // 400 fires at the HTTP boundary — no idempotency slot, no tx, no
      // wrapper call, no audit.
      expect(withIdempotentExecution).not.toHaveBeenCalled();
      expect(tx.query).not.toHaveBeenCalled();
      expect(emitCrisisDetectedAudit).not.toHaveBeenCalled();
      vi.clearAllMocks();
    }
  });

  it('§10d envelope explicitly null is treated as absent (NULL params; no 400)', async () => {
    const tx = makeFakeTx();
    installDefaultCompositionMocks(tx);
    const reply = makeReply();

    await postCrisisEventHandler(
      makeReq({
        actorNonce: 'fake-nonce',
        body: validBody({ intake_payload_envelope: null }),
      }),
      reply,
    );

    const [, params] = tx.query.mock.calls[0]! as [string, unknown[]];
    expect(params.slice(6)).toEqual([null, null, null, null, null, null, null, null]);
    expect(reply.code).toHaveBeenCalledWith(201);
  });
});
