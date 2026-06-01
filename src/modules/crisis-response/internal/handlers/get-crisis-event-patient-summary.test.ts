/**
 * get-crisis-event-patient-summary.test.ts — unit tests for the Sprint 2
 * PR 5 patient-scoped counterpart to the staff-scoped read (Sprint 2 PR 1).
 *
 * Covers the handler's composition discipline at unit scope (no real DB),
 * mirroring `get-crisis-event.test.ts` pattern + adding the patient-handler-
 * specific Phase 3.5 fail-closed-on-missing-actorNonce behavior:
 *   §1 happy path: tenant + patient role-gate + tx composes context
 *      helpers in canonical order and queries the patient view.
 *   §2 tenant guard fires before tx open.
 *   §3 patient role-gate fires before tx open.
 *   §4 path-param validation: missing / non-string / non-UUID → 400
 *      before tx open.
 *   §5 row returned by the view is forwarded verbatim (200).
 *   §6 0-row view result → 404 tenant-blind (via httpErrors.notFound).
 *   §7 **MISSING actorNonce → 403 tenant-blind before tx open** (the
 *      patient view's self-scoping predicate requires the SI-010
 *      actor binding; without it the view returns 0 rows for all
 *      inputs, which would be a misleading 404 — fail closed at the
 *      app layer instead). This is the documented divergence from the
 *      staff handler.
 *   §8 actorNonce defined → withActorContext wraps the elevated callback
 *      (composition: withTenantContext → withActorContext → withDbRole
 *      → view query).
 *   §9 42501 from withDbRole acquisition path → tenant-blind 403 (the
 *      I-025 envelope-leak defense — the try/catch wraps the entire
 *      withDbRole call).
 *
 * Mocking strategy: vi.mock the lib/* helpers so the handler's
 * composition is observable + assertable without standing up a real
 * DB. The actual DB-side privilege elevation + view RLS behavior are
 * covered by:
 *   - tests/integration/foundation-role-acquisition.test.ts
 *   - migrations/034_crisis_response_derived_views.sql §4 verification
 *     block (asserts view ownership, security_invoker, grant matrix +
 *     negative column-grant assertions proving the patient_reader does
 *     NOT have SELECT on staff-only columns)
 *
 * Pattern parity: same vi.mock + spy-on-composition approach used in
 * the sibling `get-crisis-event.test.ts`.
 */

import type { FastifyReply, FastifyRequest } from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// vi.mock hoists ABOVE imports — declare BEFORE the handler is imported
// so the mocks are in place when the handler module evaluates.
vi.mock('../../../../lib/auth-context.js', () => ({
  requirePatientActorContext: vi.fn(),
}));
vi.mock('../../../../lib/tenant-context.js', () => ({
  requireTenantContext: vi.fn(),
}));
vi.mock('../../../../lib/db.js', () => ({
  withTransaction: vi.fn(),
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

// Imports AFTER the vi.mock declarations.
import { withActorContext } from '../../../../lib/actor-context-binding.js';
import { requirePatientActorContext } from '../../../../lib/auth-context.js';
import { withTransaction } from '../../../../lib/db.js';
import { withTenantContext } from '../../../../lib/rls.js';
import { requireTenantContext } from '../../../../lib/tenant-context.js';
import { withDbRole } from '../../../../lib/with-db-role.js';

import { getCrisisEventPatientSummaryHandler } from './get-crisis-event-patient-summary.js';

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

const FAKE_PATIENT_ACTOR = {
  accountId: '01HTEST1PATNT00000000000P0',
  sessionId: 'sess-fake',
  tenantId: 'Telecheck-US',
  role: 'patient' as const,
  countryOfCare: 'US' as const,
  delegateId: null,
  adminTenantBinding: null,
  adminHomeTenantId: null,
};

const VALID_UUID = '11111111-2222-4333-8444-555555555555';
const FAKE_NONCE = 'fake-uuid-v4-nonce';

const SAMPLE_ROW = {
  crisis_event_id: VALID_UUID,
  tenant_id: 'Telecheck-US',
  patient_account_id: '01HTEST1PATNT00000000000P0',
  crisis_type: 'suicidal_ideation',
  severity: 'imminent',
  detected_at: new Date('2026-05-23T12:00:00Z'),
  current_state: 'detected',
  current_state_transition_at: new Date('2026-05-23T12:00:01Z'),
};

interface FakeTx {
  query: ReturnType<typeof vi.fn>;
}

function makeFakeTx(): FakeTx {
  return {
    query: vi.fn(async () => ({ rows: [SAMPLE_ROW], rowCount: 1 })),
  };
}

function makeReq(opts?: {
  params?: Record<string, unknown>;
  actorNonce?: string | undefined;
}): FastifyRequest {
  return {
    params: opts?.params ?? { id: VALID_UUID },
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
 * Install pass-through implementations for the composition helpers so
 * the default behavior in each test is: composition succeeds + the
 * innermost callback runs against the supplied fake tx.
 */
function installDefaultCompositionMocks(tx: FakeTx): void {
  vi.mocked(requireTenantContext).mockReturnValue(
    FAKE_TENANT_CTX as unknown as ReturnType<typeof requireTenantContext>,
  );
  vi.mocked(requirePatientActorContext).mockReturnValue(
    FAKE_PATIENT_ACTOR as unknown as ReturnType<typeof requirePatientActorContext>,
  );
  vi.mocked(withTransaction).mockImplementation(async (fn) =>
    fn(tx as unknown as Parameters<typeof fn>[0]),
  );
  vi.mocked(withTenantContext).mockImplementation(async (_client, _tenantId, fn) =>
    fn(tx as unknown as Parameters<typeof fn>[0]),
  );
  vi.mocked(withActorContext).mockImplementation(async (_tx, _nonce, fn) => fn());
  vi.mocked(withDbRole).mockImplementation(async (_tx, _role, fn) => fn());
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// §1 — happy path: full composition in canonical order
// ---------------------------------------------------------------------------

describe('getCrisisEventPatientSummaryHandler §1 — happy path composition', () => {
  it('§1a invokes requireTenantContext, requirePatientActorContext, then composes withTransaction → withTenantContext → withActorContext → withDbRole, then queries the patient view', async () => {
    const tx = makeFakeTx();
    installDefaultCompositionMocks(tx);
    const req = makeReq({ actorNonce: FAKE_NONCE });
    const reply = makeReply();

    await getCrisisEventPatientSummaryHandler(req, reply);

    expect(requireTenantContext).toHaveBeenCalledWith(req);
    expect(requirePatientActorContext).toHaveBeenCalledWith(req);
    expect(withTransaction).toHaveBeenCalledTimes(1);
    expect(withTenantContext).toHaveBeenCalledTimes(1);
    expect(withTenantContext).toHaveBeenCalledWith(tx, 'Telecheck-US', expect.any(Function));
    expect(withActorContext).toHaveBeenCalledTimes(1);
    expect(withActorContext).toHaveBeenCalledWith(tx, FAKE_NONCE, expect.any(Function));
    expect(withDbRole).toHaveBeenCalledTimes(1);
    expect(withDbRole).toHaveBeenCalledWith(
      tx,
      'crisis_event_patient_reader',
      expect.any(Function),
    );

    // The view query — confirm it targets the patient view + projects the
    // minimized 8-column set (NOT the staff view's 12-column projection).
    expect(tx.query).toHaveBeenCalledTimes(1);
    const [sql, params] = tx.query.mock.calls[0]!;
    expect(sql).toContain('FROM crisis_event_patient_summary_v');
    expect(sql).toContain('WHERE crisis_event_id = $1');
    // Negative assertions — staff-only columns MUST NOT appear in the projection.
    expect(sql).not.toContain('server_signal_id');
    expect(sql).not.toContain('regulatory_reporting_enabled');
    expect(sql).not.toContain('current_state_transition_reason');
    expect(sql).not.toContain('current_state_actor_principal_id');
    expect(params).toEqual([VALID_UUID]);

    expect(reply.code).toHaveBeenCalledWith(200);
    expect(reply.send).toHaveBeenCalledWith(SAMPLE_ROW);
  });
});

// ---------------------------------------------------------------------------
// §2 — tenant guard fires before tx open
// ---------------------------------------------------------------------------

describe('getCrisisEventPatientSummaryHandler §2 — tenant guard precedes tx', () => {
  it('§2a requireTenantContext throw aborts before withTransaction is called', async () => {
    vi.mocked(requireTenantContext).mockImplementation(() => {
      throw new Error('tenantContext absent — programming error');
    });

    await expect(
      getCrisisEventPatientSummaryHandler(makeReq({ actorNonce: FAKE_NONCE }), makeReply()),
    ).rejects.toThrow(/tenantContext absent/);

    expect(requirePatientActorContext).not.toHaveBeenCalled();
    expect(withTransaction).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// §3 — patient role-gate fires before tx open
// ---------------------------------------------------------------------------

describe('getCrisisEventPatientSummaryHandler §3 — patient role-gate precedes tx', () => {
  it('§3a requirePatientActorContext throw aborts before withTransaction is called', async () => {
    vi.mocked(requireTenantContext).mockReturnValue(
      FAKE_TENANT_CTX as unknown as ReturnType<typeof requireTenantContext>,
    );
    vi.mocked(requirePatientActorContext).mockImplementation(() => {
      throw new Error('forbidden: actor role=clinician does not satisfy patient gate');
    });

    await expect(
      getCrisisEventPatientSummaryHandler(makeReq({ actorNonce: FAKE_NONCE }), makeReply()),
    ).rejects.toThrow(/forbidden/);

    expect(withTransaction).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// §4 — path-param validation: missing / non-string / non-UUID → 400
// ---------------------------------------------------------------------------

describe('getCrisisEventPatientSummaryHandler §4 — path-param validation precedes tx', () => {
  it('§4a missing :id param → 400 before withTransaction is called', async () => {
    const tx = makeFakeTx();
    installDefaultCompositionMocks(tx);

    await expect(
      getCrisisEventPatientSummaryHandler(
        makeReq({ params: {}, actorNonce: FAKE_NONCE }),
        makeReply(),
      ),
    ).rejects.toThrow(/`id` is required/);

    expect(withTransaction).not.toHaveBeenCalled();
  });

  it('§4b empty-string :id param → 400 before withTransaction is called', async () => {
    const tx = makeFakeTx();
    installDefaultCompositionMocks(tx);

    await expect(
      getCrisisEventPatientSummaryHandler(
        makeReq({ params: { id: '' }, actorNonce: FAKE_NONCE }),
        makeReply(),
      ),
    ).rejects.toThrow(/`id` is required/);

    expect(withTransaction).not.toHaveBeenCalled();
  });

  it('§4c non-string :id (numeric path coerced to number by router) → 400', async () => {
    const tx = makeFakeTx();
    installDefaultCompositionMocks(tx);

    await expect(
      getCrisisEventPatientSummaryHandler(
        makeReq({ params: { id: 12345 }, actorNonce: FAKE_NONCE }),
        makeReply(),
      ),
    ).rejects.toThrow(/`id` is required/);

    expect(withTransaction).not.toHaveBeenCalled();
  });

  it('§4d non-UUID :id (ULID-shaped, garbage, etc.) → 400 before tx open', async () => {
    const tx = makeFakeTx();
    installDefaultCompositionMocks(tx);

    const nonUuids = [
      '01HXYZ123456789ABCDEFGHJK', // ULID shape (Crockford base32, 26 chars)
      'not-a-uuid',
      '00000000-0000-0000-0000-000000000000Z', // trailing garbage
      '11111111-2222-3333-4444', // too short
      'gggggggg-2222-4333-8444-555555555555', // non-hex chars
    ];
    for (const bad of nonUuids) {
      await expect(
        getCrisisEventPatientSummaryHandler(
          makeReq({ params: { id: bad }, actorNonce: FAKE_NONCE }),
          makeReply(),
        ),
      ).rejects.toThrow(/must be a UUID/);
    }
    expect(withTransaction).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// §5 — row returned by the view is forwarded verbatim (200)
// ---------------------------------------------------------------------------

describe('getCrisisEventPatientSummaryHandler §5 — view row passthrough on 200', () => {
  it('§5a forwards the view row verbatim (no field renaming or coercion)', async () => {
    const tx = makeFakeTx();
    installDefaultCompositionMocks(tx);
    const reply = makeReply();

    await getCrisisEventPatientSummaryHandler(makeReq({ actorNonce: FAKE_NONCE }), reply);

    expect(reply.code).toHaveBeenCalledWith(200);
    expect(reply.send).toHaveBeenCalledWith(SAMPLE_ROW);
  });
});

// ---------------------------------------------------------------------------
// §6 — 0-row view result → 404 tenant-blind
// ---------------------------------------------------------------------------

describe('getCrisisEventPatientSummaryHandler §6 — 0-row result → 404 tenant-blind', () => {
  it('§6a empty view result triggers httpErrors.notFound (I-025 envelope)', async () => {
    const tx = makeFakeTx();
    tx.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    installDefaultCompositionMocks(tx);

    await expect(
      getCrisisEventPatientSummaryHandler(makeReq({ actorNonce: FAKE_NONCE }), makeReply()),
    ).rejects.toThrow(/not found/i);
  });

  it('§6b 404 envelope message does NOT leak tenant_id or patient_id (per I-025)', async () => {
    const tx = makeFakeTx();
    tx.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    installDefaultCompositionMocks(tx);

    try {
      await getCrisisEventPatientSummaryHandler(makeReq({ actorNonce: FAKE_NONCE }), makeReply());
      throw new Error('handler did not throw 404');
    } catch (e: unknown) {
      const msg = (e as Error).message;
      // Must not echo tenantId or patient_id in the not-found message.
      expect(msg).not.toContain('Telecheck-US');
      expect(msg).not.toContain('Telecheck-Ghana');
      expect(msg).not.toContain(FAKE_PATIENT_ACTOR.accountId);
    }
  });
});

// ---------------------------------------------------------------------------
// §7 — MISSING actorNonce → 403 tenant-blind BEFORE tx open (handler-
// specific divergence from the staff handler, which tolerates undefined
// nonce)
// ---------------------------------------------------------------------------

describe('getCrisisEventPatientSummaryHandler §7 — fail-closed on missing actorNonce', () => {
  it('§7a undefined actorNonce throws 403 BEFORE withTransaction is called', async () => {
    const tx = makeFakeTx();
    installDefaultCompositionMocks(tx);

    await expect(
      getCrisisEventPatientSummaryHandler(makeReq({ actorNonce: undefined }), makeReply()),
    ).rejects.toThrow(/insufficient scope/i);

    expect(withTransaction).not.toHaveBeenCalled();
    expect(withActorContext).not.toHaveBeenCalled();
    expect(withDbRole).not.toHaveBeenCalled();
    expect(tx.query).not.toHaveBeenCalled();
  });

  it('§7b 403 envelope message is tenant-blind (no tenant_id / patient_id leak)', async () => {
    const tx = makeFakeTx();
    installDefaultCompositionMocks(tx);

    try {
      await getCrisisEventPatientSummaryHandler(makeReq({ actorNonce: undefined }), makeReply());
      throw new Error('handler did not throw 403');
    } catch (e: unknown) {
      const msg = (e as Error).message;
      expect(msg).not.toContain('Telecheck-US');
      expect(msg).not.toContain('Telecheck-Ghana');
      expect(msg).not.toContain(FAKE_PATIENT_ACTOR.accountId);
    }
  });
});

// ---------------------------------------------------------------------------
// §8 — actorNonce defined → withActorContext wraps the elevated callback
// ---------------------------------------------------------------------------

describe('getCrisisEventPatientSummaryHandler §8 — actor-context wrap order', () => {
  it('§8a withActorContext is invoked OUTSIDE withDbRole (composition: withActorContext → withDbRole → view query)', async () => {
    const tx = makeFakeTx();
    installDefaultCompositionMocks(tx);
    const callOrder: string[] = [];
    vi.mocked(withActorContext).mockImplementation(async (_tx, _nonce, fn) => {
      callOrder.push('withActorContext-enter');
      const out = await fn();
      callOrder.push('withActorContext-exit');
      return out;
    });
    vi.mocked(withDbRole).mockImplementation(async (_tx, _role, fn) => {
      callOrder.push('withDbRole-enter');
      const out = await fn();
      callOrder.push('withDbRole-exit');
      return out;
    });
    tx.query.mockImplementationOnce(async () => {
      callOrder.push('view-query');
      return { rows: [SAMPLE_ROW], rowCount: 1 };
    });

    await getCrisisEventPatientSummaryHandler(makeReq({ actorNonce: FAKE_NONCE }), makeReply());

    expect(callOrder).toEqual([
      'withActorContext-enter',
      'withDbRole-enter',
      'view-query',
      'withDbRole-exit',
      'withActorContext-exit',
    ]);
  });
});

// ---------------------------------------------------------------------------
// §9 — 42501 from withDbRole acquisition path → tenant-blind 403
// (I-025 envelope-leak defense — try/catch wraps the entire withDbRole call)
// ---------------------------------------------------------------------------

describe('getCrisisEventPatientSummaryHandler §9 — 42501 → 403 mapping wraps entire withDbRole', () => {
  it('§9a 42501 raised inside withDbRole (privilege-acquisition path) maps to tenant-blind 403', async () => {
    const tx = makeFakeTx();
    installDefaultCompositionMocks(tx);
    vi.mocked(withDbRole).mockImplementation(async () => {
      // Simulate SET LOCAL ROLE rejection raised during withDbRole's
      // pre-callback elevation step (foundation 051 drift state).
      const e = new Error('permission denied to set role');
      (e as Error & { code: string }).code = '42501';
      throw e;
    });

    await expect(
      getCrisisEventPatientSummaryHandler(makeReq({ actorNonce: FAKE_NONCE }), makeReply()),
    ).rejects.toThrow(/insufficient scope/i);
  });

  it('§9b 42501 raised inside the view-body SELECT path maps to tenant-blind 403', async () => {
    const tx = makeFakeTx();
    installDefaultCompositionMocks(tx);
    tx.query.mockImplementationOnce(async () => {
      const e = new Error('permission denied for view crisis_event_patient_summary_v');
      (e as Error & { code: string }).code = '42501';
      throw e;
    });

    await expect(
      getCrisisEventPatientSummaryHandler(makeReq({ actorNonce: FAKE_NONCE }), makeReply()),
    ).rejects.toThrow(/insufficient scope/i);
  });

  it('§9c non-42501 PG errors propagate to the global handler (no mapping)', async () => {
    const tx = makeFakeTx();
    installDefaultCompositionMocks(tx);
    tx.query.mockImplementationOnce(async () => {
      const e = new Error('connection terminated unexpectedly');
      (e as Error & { code: string }).code = '08006';
      throw e;
    });

    await expect(
      getCrisisEventPatientSummaryHandler(makeReq({ actorNonce: FAKE_NONCE }), makeReply()),
    ).rejects.toThrow(/connection terminated/);
  });
});
