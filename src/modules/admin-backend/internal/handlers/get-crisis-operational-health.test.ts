/**
 * get-crisis-operational-health.test.ts — unit tests for the Sprint 2
 * PR 1 first Fastify handler.
 *
 * Covers the handler's composition discipline at unit scope (no real DB):
 *   §1 happy path: tenant + admin-role + tx composes context helpers in
 *      the canonical order and invokes the SECDEF wrapper.
 *   §2 tenant guard fires before tx open.
 *   §3 admin-role guard fires before tx open.
 *   §4 wrapper-raised tenant-scope-mismatch propagates (rolls back tx).
 *   §5 actorNonce undefined → skip withActorContext but still call wrapper
 *      (the wrapper's LAYER C check will raise; that path is exercised by
 *      the wrapper's own integration tests in a successor sprint).
 *   §6 actorNonce defined → withActorContext wraps the elevated callback.
 *
 * Mocking strategy: vi.mock the lib/* helpers so the handler's
 * composition is observable + assertable without standing up a real
 * DB. The actual DB-side privilege elevation + LAYER C wrapper
 * behavior are covered by:
 *   - tests/integration/foundation-role-acquisition.test.ts
 *     (per migration 051 header §"DEFERRED TO FOLLOW-UP PRS")
 *   - migration 044 §5 verification block (asserts wrapper ownership,
 *     SECDEF flag, locked search_path, EXECUTE grant matrix)
 *
 * Pattern parity: same vi.mock + spy-on-composition approach used in
 * src/lib/with-db-role.test.ts §2 (which observes the SQL statements
 * issued in order). Here the equivalent observation is the order of
 * helper invocations.
 */

import type { FastifyReply, FastifyRequest } from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// vi.mock hoists ABOVE imports — declare BEFORE the handler is imported
// so the mocks are in place when the handler module evaluates.
vi.mock('../../../../lib/admin-role.js', () => ({
  requireAdminRole: vi.fn(),
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
// Mock the shared `withDbRoleSafe` helper (src/lib/with-db-role-safe.ts)
// rather than the underlying `withDbRole`. The handler now calls
// `withDbRoleSafe`, which composes `withDbRole` + the canonical SQLSTATE
// 42501 → tenant-blind 403 mapping; the mapping is unit-tested in
// src/lib/with-db-role-safe.test.ts so the §4 wrapper-side 42501 mapping
// tests below now exercise the path through the real helper boundary
// (covered indirectly via the unit test of with-db-role-safe).
vi.mock('../../../../lib/with-db-role-safe.js', () => ({
  withDbRoleSafe: vi.fn(),
}));

// Imports AFTER the vi.mock declarations.
import { requireAdminRole } from '../../../../lib/admin-role.js';
import { withActorContext } from '../../../../lib/actor-context-binding.js';
import { withTransaction } from '../../../../lib/db.js';
import { withTenantContext } from '../../../../lib/rls.js';
import { requireTenantContext } from '../../../../lib/tenant-context.js';
import { withDbRoleSafe } from '../../../../lib/with-db-role-safe.js';

import { getCrisisOperationalHealthHandler } from './get-crisis-operational-health.js';

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

const SAMPLE_ROWS = [
  {
    tenant_id: 'Telecheck-US',
    severity: 'high',
    active_event_count: '3',
    escalation_obligation_backlog_count: '1',
    stale_sweep_count: '0',
    active_obligation_avg_tier: '2.5',
    crisis_audit_24h_count: '17',
  },
];

interface FakeTx {
  query: ReturnType<typeof vi.fn>;
}

function makeFakeTx(): FakeTx {
  return {
    query: vi.fn(async () => ({ rows: SAMPLE_ROWS, rowCount: SAMPLE_ROWS.length })),
  };
}

function makeReq(opts?: { actorNonce?: string | undefined }): FastifyRequest {
  // Minimal Fastify httpErrors mock — only the methods the handler calls
  // are populated; each returns a typed Error with statusCode set per
  // @fastify/sensible convention (the production plugin is registered in
  // src/app.ts; tests don't bootstrap the full Fastify instance).
  const httpErrors = {
    forbidden: (msg?: string) => Object.assign(new Error(msg ?? 'Forbidden'), { statusCode: 403 }),
    notFound: (msg?: string) => Object.assign(new Error(msg ?? 'Not Found'), { statusCode: 404 }),
    badRequest: (msg?: string) => Object.assign(new Error(msg ?? 'Bad Request'), { statusCode: 400 }),
  };
  return {
    actorNonce: opts?.actorNonce,
    server: { httpErrors },
  } as unknown as FastifyRequest;
}

function makeReply(): FastifyReply {
  return {} as unknown as FastifyReply;
}

/**
 * Install pass-through implementations for the composition helpers so the
 * default behavior in each test is: composition succeeds + the innermost
 * callback runs against the supplied fake tx.
 */
function installDefaultCompositionMocks(tx: FakeTx): void {
  vi.mocked(requireTenantContext).mockReturnValue(
    FAKE_TENANT_CTX as unknown as ReturnType<typeof requireTenantContext>,
  );
  vi.mocked(requireAdminRole).mockReturnValue('platform_admin');
  vi.mocked(withTransaction).mockImplementation(async (fn) =>
    fn(tx as unknown as Parameters<typeof fn>[0]),
  );
  vi.mocked(withTenantContext).mockImplementation(async (_client, _tenantId, fn) =>
    // Production handler now uses the outer `tx` (from withTransaction)
    // inside the inner callback rather than the rls.ts narrow client —
    // see the production code's "Note on `tx` reuse" comment. The
    // callback still receives a client per the rls.ts signature; pass
    // the same fake tx through for parity even though the handler
    // doesn't consume it.
    fn(tx as unknown as Parameters<typeof fn>[0]),
  );
  vi.mocked(withActorContext).mockImplementation(async (_tx, _nonce, fn) => fn());
  // withDbRoleSafe signature: (tx, role, req, fn) — see src/lib/with-db-role-safe.ts.
  vi.mocked(withDbRoleSafe).mockImplementation(async (_tx, _role, _req, fn) => fn());
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// §1 — happy path: full composition in canonical order
// ---------------------------------------------------------------------------

describe('getCrisisOperationalHealthHandler §1 — happy path composition', () => {
  it('§1a invokes requireTenantContext, requireAdminRole, then composes withTransaction → withTenantContext → withActorContext → withDbRole, then calls the SECDEF wrapper', async () => {
    const tx = makeFakeTx();
    installDefaultCompositionMocks(tx);
    const req = makeReq({ actorNonce: 'fake-uuid-v4-nonce' });

    const result = await getCrisisOperationalHealthHandler(req, makeReply());

    expect(requireTenantContext).toHaveBeenCalledWith(req);
    expect(requireAdminRole).toHaveBeenCalledWith(req);
    expect(withTransaction).toHaveBeenCalledTimes(1);
    expect(withTenantContext).toHaveBeenCalledTimes(1);
    expect(withTenantContext).toHaveBeenCalledWith(
      tx,
      'Telecheck-US',
      expect.any(Function),
    );
    expect(withActorContext).toHaveBeenCalledTimes(1);
    expect(withActorContext).toHaveBeenCalledWith(tx, 'fake-uuid-v4-nonce', expect.any(Function));
    // withDbRoleSafe is called with (tx, role, req, fn) per the shared
    // helper's signature (src/lib/with-db-role-safe.ts).
    expect(withDbRoleSafe).toHaveBeenCalledTimes(1);
    expect(withDbRoleSafe).toHaveBeenCalledWith(
      tx,
      'admin_basic_operator',
      req,
      expect.any(Function),
    );

    // The wrapper call: SELECT * FROM read_admin_crisis_operational_health($1, $2)
    expect(tx.query).toHaveBeenCalledTimes(1);
    const [sql, params] = tx.query.mock.calls[0]!;
    expect(sql).toBe('SELECT * FROM read_admin_crisis_operational_health($1, $2)');
    expect(params).toEqual(['Telecheck-US', {}]);

    // Response shape mirrors the SECDEF rollup rows verbatim.
    expect(result).toEqual({ rows: SAMPLE_ROWS });
  });

  it('§1b returns an empty rows[] when the wrapper returns no rows (no active crisis events in the 24h window)', async () => {
    const tx = makeFakeTx();
    tx.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    installDefaultCompositionMocks(tx);

    const result = await getCrisisOperationalHealthHandler(
      makeReq({ actorNonce: 'fake-nonce' }),
      makeReply(),
    );
    expect(result).toEqual({ rows: [] });
  });
});

// ---------------------------------------------------------------------------
// §2 — tenant guard fires before tx open
// ---------------------------------------------------------------------------

describe('getCrisisOperationalHealthHandler §2 — tenant guard precedes tx', () => {
  it('§2a requireTenantContext throw aborts before withTransaction is called', async () => {
    vi.mocked(requireTenantContext).mockImplementation(() => {
      throw new Error('tenantContext absent — programming error');
    });

    await expect(
      getCrisisOperationalHealthHandler(makeReq(), makeReply()),
    ).rejects.toThrow(/tenantContext absent/);

    expect(requireAdminRole).not.toHaveBeenCalled();
    expect(withTransaction).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// §3 — admin-role guard fires before tx open
// ---------------------------------------------------------------------------

describe('getCrisisOperationalHealthHandler §3 — admin-role guard precedes tx', () => {
  it('§3a requireAdminRole throw aborts before withTransaction is called', async () => {
    vi.mocked(requireTenantContext).mockReturnValue(
      FAKE_TENANT_CTX as unknown as ReturnType<typeof requireTenantContext>,
    );
    vi.mocked(requireAdminRole).mockImplementation(() => {
      throw new Error('forbidden: actor lacks admin role');
    });

    await expect(
      getCrisisOperationalHealthHandler(makeReq(), makeReply()),
    ).rejects.toThrow(/forbidden/);

    expect(withTransaction).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// §4 — errors from withDbRoleSafe propagate to the global envelope
//
// Pre-refactor (2026-05-23) this section asserted the inline 42501 → 403
// mapping that lived directly in this handler. The cross-slice refactor
// 2026-05-24 extracted that mapping into the shared `withDbRoleSafe`
// helper (src/lib/with-db-role-safe.ts) + tested it there. The handler-
// level assertion now verifies only the propagation contract: whatever
// withDbRoleSafe throws is what the handler throws, unchanged.
//
// The substantive coverage of "42501 is mapped to a tenant-blind 403
// with no leaked tenant identifiers" + "non-42501 PG errors propagate
// with identity preserved" lives in src/lib/with-db-role-safe.test.ts
// (§2 + §3 + §4 there).
// ---------------------------------------------------------------------------

describe('getCrisisOperationalHealthHandler §4 — error propagation from withDbRoleSafe', () => {
  it('§4a propagates whatever withDbRoleSafe throws (handler does not wrap, transform, or swallow)', async () => {
    const tx = makeFakeTx();
    installDefaultCompositionMocks(tx);

    // Simulate withDbRoleSafe raising the canonical mapped 403 (this is
    // what the real helper produces for SQLSTATE 42501).
    const forbidden = Object.assign(
      new Error('Insufficient scope for this request.'),
      { statusCode: 403 },
    );
    vi.mocked(withDbRoleSafe).mockImplementationOnce(async () => {
      throw forbidden;
    });

    let thrown: unknown;
    try {
      await getCrisisOperationalHealthHandler(
        makeReq({ actorNonce: 'fake-nonce' }),
        makeReply(),
      );
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBe(forbidden);
  });

  it('§4b propagates non-42501 PG errors unchanged (identity-preserved, code intact, no 4xx statusCode added)', async () => {
    const tx = makeFakeTx();
    installDefaultCompositionMocks(tx);

    const otherPgError = Object.assign(
      new Error('connection terminated unexpectedly'),
      { code: '57P01' }, // admin_shutdown
    );
    // withDbRoleSafe propagates non-42501 errors unchanged (see its §3
    // unit tests); simulate that contract here.
    vi.mocked(withDbRoleSafe).mockImplementationOnce(async () => {
      throw otherPgError;
    });

    let thrown: unknown;
    try {
      await getCrisisOperationalHealthHandler(
        makeReq({ actorNonce: 'fake-nonce' }),
        makeReply(),
      );
    } catch (e) {
      thrown = e;
    }

    expect(thrown).toBe(otherPgError);
    expect((thrown as { code?: string }).code).toBe('57P01');
    expect((thrown as { statusCode?: number }).statusCode).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// §5 — actorNonce undefined → skip withActorContext, still call wrapper
// ---------------------------------------------------------------------------

describe('getCrisisOperationalHealthHandler §5 — missing actorNonce path (fail-closed at wrapper LAYER C)', () => {
  it('§5a undefined actorNonce skips withActorContext but still calls withDbRoleSafe + wrapper (the wrapper itself raises if LAYER C cannot resolve actor; tested separately)', async () => {
    const tx = makeFakeTx();
    installDefaultCompositionMocks(tx);

    await getCrisisOperationalHealthHandler(makeReq({ actorNonce: undefined }), makeReply());

    expect(withActorContext).not.toHaveBeenCalled();
    expect(withDbRoleSafe).toHaveBeenCalledTimes(1);
    expect(tx.query).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// §6 — actorNonce defined → withActorContext wraps the elevated callback
// ---------------------------------------------------------------------------

describe('getCrisisOperationalHealthHandler §6 — actor-context wrap order', () => {
  it('§6a withActorContext is invoked OUTSIDE withDbRoleSafe (composition: withActorContext → withDbRoleSafe → wrapper)', async () => {
    const tx = makeFakeTx();
    installDefaultCompositionMocks(tx);
    const callOrder: string[] = [];
    vi.mocked(withActorContext).mockImplementation(async (_tx, _nonce, fn) => {
      callOrder.push('withActorContext-enter');
      const out = await fn();
      callOrder.push('withActorContext-exit');
      return out;
    });
    vi.mocked(withDbRoleSafe).mockImplementation(async (_tx, _role, _req, fn) => {
      callOrder.push('withDbRole-enter');
      const out = await fn();
      callOrder.push('withDbRole-exit');
      return out;
    });
    tx.query.mockImplementationOnce(async () => {
      callOrder.push('wrapper-call');
      return { rows: SAMPLE_ROWS, rowCount: SAMPLE_ROWS.length };
    });

    await getCrisisOperationalHealthHandler(
      makeReq({ actorNonce: 'fake-nonce' }),
      makeReply(),
    );

    expect(callOrder).toEqual([
      'withActorContext-enter',
      'withDbRole-enter',
      'wrapper-call',
      'withDbRole-exit',
      'withActorContext-exit',
    ]);
  });
});
