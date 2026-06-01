/**
 * get-crisis-event.test.ts — unit tests for the Sprint 2 PR 1 first
 * real Fastify handler in the Crisis Response slice.
 *
 * Covers the handler's composition discipline at unit scope (no real DB):
 *   §1 happy path: tenant + clinician role-gate + tx composes context
 *      helpers in canonical order and queries the staff view.
 *   §2 tenant guard fires before tx open.
 *   §3 clinician role-gate fires before tx open.
 *   §4 path-param validation: missing / non-string / non-UUID → 400
 *      before tx open.
 *   §5 row returned by the view is forwarded verbatim (200).
 *   §6 0-row view result → 404 tenant-blind (via httpErrors.notFound).
 *   §7 actorNonce undefined → skip withActorContext but still query
 *      (the staff view does not require the nonce to be bound).
 *   §8 actorNonce defined → withActorContext wraps the elevated callback
 *      (composition: withTenantContext → withActorContext → withDbRole →
 *      view query).
 *
 * Mocking strategy: vi.mock the lib/* helpers so the handler's
 * composition is observable + assertable without standing up a real
 * DB. The actual DB-side privilege elevation + view RLS behavior are
 * covered by:
 *   - tests/integration/foundation-role-acquisition.test.ts (per
 *     migration 051 header's DEFERRED-TO-FOLLOW-UP integration coverage)
 *   - migrations/034_crisis_response_derived_views.sql §4 verification
 *     block (asserts view ownership, security_invoker, grant matrix +
 *     negative column-grant assertions for patient-reader leakage)
 *
 * Pattern parity: same vi.mock + spy-on-composition approach used in
 * `src/modules/admin-backend/internal/handlers/get-crisis-operational-health.test.ts`
 * (the canonical first-handler-post-foundation-051 reference).
 */

import type { FastifyReply, FastifyRequest } from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// vi.mock hoists ABOVE imports — declare BEFORE the handler is imported
// so the mocks are in place when the handler module evaluates.
vi.mock('../../../../lib/auth-context.js', () => ({
  requireClinicianActorContext: vi.fn(),
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
import { requireClinicianActorContext } from '../../../../lib/auth-context.js';
import { withTransaction } from '../../../../lib/db.js';
import { withTenantContext } from '../../../../lib/rls.js';
import { requireTenantContext } from '../../../../lib/tenant-context.js';
import { withDbRole } from '../../../../lib/with-db-role.js';

import { getCrisisEventHandler } from './get-crisis-event.js';

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
  accountId: '01TESTACTOR0000000ACCOUNTID0',
  sessionId: 'sess-fake',
  tenantId: 'Telecheck-US',
  role: 'clinician' as const,
  countryOfCare: 'US' as const,
  delegateId: null,
  adminTenantBinding: null,
  adminHomeTenantId: null,
};

const VALID_UUID = '01TESTPATIENT00000ACCOUNTID0';

const SAMPLE_ROW = {
  crisis_event_id: VALID_UUID,
  tenant_id: 'Telecheck-US',
  patient_id: '01TESTPATIENT01111ACCOUNTID0',
  server_signal_id: '88888888-aaaa-4bbb-8ccc-dddddddddddd',
  crisis_type: 'suicidal_ideation',
  severity: 'imminent',
  regulatory_reporting_enabled: true,
  detected_at: new Date('2026-05-23T12:00:00Z'),
  current_state: 'detected',
  current_state_transition_at: new Date('2026-05-23T12:00:01Z'),
  current_state_transition_reason: 'initial_detection',
  current_state_actor_principal_id: 'mode-1-server-signal-emitter',
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
  vi.mocked(requireClinicianActorContext).mockReturnValue(
    FAKE_CLINICIAN_ACTOR as unknown as ReturnType<typeof requireClinicianActorContext>,
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

describe('getCrisisEventHandler §1 — happy path composition', () => {
  it('§1a invokes requireTenantContext, requireClinicianActorContext, then composes withTransaction → withTenantContext → withActorContext → withDbRole, then queries the staff view', async () => {
    const tx = makeFakeTx();
    installDefaultCompositionMocks(tx);
    const req = makeReq({ actorNonce: 'fake-uuid-v4-nonce' });
    const reply = makeReply();

    await getCrisisEventHandler(req, reply);

    expect(requireTenantContext).toHaveBeenCalledWith(req);
    expect(requireClinicianActorContext).toHaveBeenCalledWith(req);
    expect(withTransaction).toHaveBeenCalledTimes(1);
    expect(withTenantContext).toHaveBeenCalledTimes(1);
    expect(withTenantContext).toHaveBeenCalledWith(tx, 'Telecheck-US', expect.any(Function));
    expect(withActorContext).toHaveBeenCalledTimes(1);
    expect(withActorContext).toHaveBeenCalledWith(tx, 'fake-uuid-v4-nonce', expect.any(Function));
    expect(withDbRole).toHaveBeenCalledTimes(1);
    expect(withDbRole).toHaveBeenCalledWith(tx, 'crisis_event_staff_reader', expect.any(Function));

    // The view query.
    expect(tx.query).toHaveBeenCalledTimes(1);
    const [sql, params] = tx.query.mock.calls[0]!;
    expect(sql).toContain('FROM crisis_event_current_state_v');
    expect(sql).toContain('WHERE crisis_event_id = $1');
    expect(params).toEqual([VALID_UUID]);

    expect(reply.code).toHaveBeenCalledWith(200);
    expect(reply.send).toHaveBeenCalledWith(SAMPLE_ROW);
  });
});

// ---------------------------------------------------------------------------
// §2 — tenant guard fires before tx open
// ---------------------------------------------------------------------------

describe('getCrisisEventHandler §2 — tenant guard precedes tx', () => {
  it('§2a requireTenantContext throw aborts before withTransaction is called', async () => {
    vi.mocked(requireTenantContext).mockImplementation(() => {
      throw new Error('tenantContext absent — programming error');
    });

    await expect(getCrisisEventHandler(makeReq(), makeReply())).rejects.toThrow(
      /tenantContext absent/,
    );

    expect(requireClinicianActorContext).not.toHaveBeenCalled();
    expect(withTransaction).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// §3 — clinician role-gate fires before tx open
// ---------------------------------------------------------------------------

describe('getCrisisEventHandler §3 — clinician role-gate precedes tx', () => {
  it('§3a requireClinicianActorContext throw aborts before withTransaction is called', async () => {
    vi.mocked(requireTenantContext).mockReturnValue(
      FAKE_TENANT_CTX as unknown as ReturnType<typeof requireTenantContext>,
    );
    vi.mocked(requireClinicianActorContext).mockImplementation(() => {
      throw new Error('forbidden: actor role=patient does not satisfy clinician gate');
    });

    await expect(getCrisisEventHandler(makeReq(), makeReply())).rejects.toThrow(/forbidden/);

    expect(withTransaction).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// §4 — path-param validation: missing / non-string / non-UUID → 400
// ---------------------------------------------------------------------------

describe('getCrisisEventHandler §4 — path-param validation precedes tx', () => {
  it('§4a missing :id param → 400 before withTransaction is called', async () => {
    const tx = makeFakeTx();
    installDefaultCompositionMocks(tx);

    await expect(getCrisisEventHandler(makeReq({ params: {} }), makeReply())).rejects.toThrow(
      /`id` is required/,
    );

    expect(withTransaction).not.toHaveBeenCalled();
  });

  it('§4b empty-string :id param → 400 before withTransaction is called', async () => {
    const tx = makeFakeTx();
    installDefaultCompositionMocks(tx);

    await expect(
      getCrisisEventHandler(makeReq({ params: { id: '' } }), makeReply()),
    ).rejects.toThrow(/`id` is required/);

    expect(withTransaction).not.toHaveBeenCalled();
  });

  it('§4c non-string :id (numeric path coerced to number by router) → 400', async () => {
    const tx = makeFakeTx();
    installDefaultCompositionMocks(tx);

    await expect(
      getCrisisEventHandler(makeReq({ params: { id: 12345 } }), makeReply()),
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
        getCrisisEventHandler(makeReq({ params: { id: bad } }), makeReply()),
      ).rejects.toThrow(/must be a UUID/);
    }
    expect(withTransaction).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// §5 — row returned by the view is forwarded verbatim (200)
// ---------------------------------------------------------------------------

describe('getCrisisEventHandler §5 — view row passthrough on 200', () => {
  it('§5a forwards the view row verbatim (no field renaming or coercion)', async () => {
    const tx = makeFakeTx();
    installDefaultCompositionMocks(tx);
    const reply = makeReply();

    await getCrisisEventHandler(makeReq({ actorNonce: 'fake-nonce' }), reply);

    expect(reply.code).toHaveBeenCalledWith(200);
    expect(reply.send).toHaveBeenCalledWith(SAMPLE_ROW);
  });
});

// ---------------------------------------------------------------------------
// §6 — 0-row view result → 404 tenant-blind
// ---------------------------------------------------------------------------

describe('getCrisisEventHandler §6 — 0-row result → 404 tenant-blind', () => {
  it('§6a empty view result triggers httpErrors.notFound (I-025 envelope)', async () => {
    const tx = makeFakeTx();
    tx.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    installDefaultCompositionMocks(tx);

    await expect(
      getCrisisEventHandler(makeReq({ actorNonce: 'fake-nonce' }), makeReply()),
    ).rejects.toThrow(/not found/i);
  });

  it('§6b 404 envelope message does NOT leak tenant_id (per I-025)', async () => {
    const tx = makeFakeTx();
    tx.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    installDefaultCompositionMocks(tx);

    try {
      await getCrisisEventHandler(makeReq({ actorNonce: 'fake-nonce' }), makeReply());
      throw new Error('handler did not throw 404');
    } catch (e: unknown) {
      const msg = (e as Error).message;
      // Must not echo tenantId in the not-found message.
      expect(msg).not.toContain('Telecheck-US');
      expect(msg).not.toContain('Telecheck-Ghana');
    }
  });
});

// ---------------------------------------------------------------------------
// §7 — actorNonce undefined → skip withActorContext, still query view
// ---------------------------------------------------------------------------

describe('getCrisisEventHandler §7 — missing actorNonce skips withActorContext', () => {
  it('§7a undefined actorNonce skips withActorContext but still calls withDbRole + view query', async () => {
    const tx = makeFakeTx();
    installDefaultCompositionMocks(tx);

    await getCrisisEventHandler(makeReq({ actorNonce: undefined }), makeReply());

    expect(withActorContext).not.toHaveBeenCalled();
    expect(withDbRole).toHaveBeenCalledTimes(1);
    expect(tx.query).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// §8 — actorNonce defined → withActorContext wraps the elevated callback
// ---------------------------------------------------------------------------

describe('getCrisisEventHandler §8 — actor-context wrap order', () => {
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

    await getCrisisEventHandler(makeReq({ actorNonce: 'fake-nonce' }), makeReply());

    expect(callOrder).toEqual([
      'withActorContext-enter',
      'withDbRole-enter',
      'view-query',
      'withDbRole-exit',
      'withActorContext-exit',
    ]);
  });
});
