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
vi.mock('../../../../lib/with-db-role.js', () => ({
  withDbRole: vi.fn(),
}));

// Imports AFTER the vi.mock declarations.
import { requireAdminRole } from '../../../../lib/admin-role.js';
import { withActorContext } from '../../../../lib/actor-context-binding.js';
import { withTransaction } from '../../../../lib/db.js';
import { withTenantContext } from '../../../../lib/rls.js';
import { requireTenantContext } from '../../../../lib/tenant-context.js';
import { withDbRole } from '../../../../lib/with-db-role.js';

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
  vi.mocked(withDbRole).mockImplementation(async (_tx, _role, fn) => fn());
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
    expect(withDbRole).toHaveBeenCalledTimes(1);
    expect(withDbRole).toHaveBeenCalledWith(tx, 'admin_basic_operator', expect.any(Function));

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
// §4 — wrapper raise propagates as tenant-blind 403 (42501 mapping)
//      R1 HIGH-1 closure 2026-05-23: previously this test asserted the raw
//      tenant-scope-mismatch message propagated to the global envelope,
//      which violated I-025 by leaking tenant IDs in the response body in
//      non-prod. Updated to assert 42501 is mapped to a tenant-blind 403
//      via req.server.httpErrors.forbidden() with a generic message that
//      contains no tenant identifiers.
// ---------------------------------------------------------------------------

describe('getCrisisOperationalHealthHandler §4 — wrapper error mapping (42501 → 403)', () => {
  it('§4a wrapper-side 42501 (tenant-scope mismatch / missing actor) maps to 403 tenant-blind; raw PG message + tenant IDs are NOT leaked', async () => {
    const tx = makeFakeTx();
    installDefaultCompositionMocks(tx);

    // Simulate wrapper LAYER C raise: tenant scope mismatch.
    const wrapperError = Object.assign(
      new Error(
        'read_admin_crisis_operational_health: tenant scope mismatch — actor tenant Telecheck-US does not match wrapper p_tenant_id Telecheck-Ghana; cross-tenant read rejected',
      ),
      { code: '42501' },
    );
    tx.query.mockRejectedValueOnce(wrapperError);

    let thrown: unknown;
    try {
      await getCrisisOperationalHealthHandler(
        makeReq({ actorNonce: 'fake-nonce' }),
        makeReply(),
      );
    } catch (e) {
      thrown = e;
    }

    expect(thrown).toBeDefined();
    // Asserted as Fastify forbidden — statusCode 403, generic message.
    const errObj = thrown as { statusCode?: number; message?: string };
    expect(errObj.statusCode).toBe(403);
    // Critical I-025 invariant: message must NOT contain tenant identifiers
    // or raw SQLSTATE/wrapper details from the upstream PG error.
    expect(errObj.message ?? '').not.toContain('Telecheck-US');
    expect(errObj.message ?? '').not.toContain('Telecheck-Ghana');
    expect(errObj.message ?? '').not.toContain('tenant scope mismatch');
    expect(errObj.message ?? '').not.toContain('42501');
    // The generic message can mention "scope" but no tenant ids.
    expect(errObj.message ?? '').toMatch(/scope|forbidden|insufficient/i);
  });

  it('§4b non-42501 PG errors propagate UNCHANGED — identity-preserved, code intact, no 4xx statusCode added (R2 LOW closure)', async () => {
    const tx = makeFakeTx();
    installDefaultCompositionMocks(tx);

    const otherPgError = Object.assign(
      new Error('connection terminated unexpectedly'),
      { code: '57P01' }, // admin_shutdown
    );
    tx.query.mockRejectedValueOnce(otherPgError);

    let thrown: unknown;
    try {
      await getCrisisOperationalHealthHandler(
        makeReq({ actorNonce: 'fake-nonce' }),
        makeReply(),
      );
    } catch (e) {
      thrown = e;
    }

    // R2 LOW closure 2026-05-23: assert identity-preservation + code intact,
    // not just message match. A regression that re-wrapped the error
    // (losing .code, adding a 4xx statusCode that the global envelope
    // would then treat as client-facing) would have passed the prior
    // toThrow(/connection terminated/) assertion. The identity check
    // catches that class of regression.
    expect(thrown).toBe(otherPgError);
    expect((thrown as { code?: string }).code).toBe('57P01');
    // Must NOT have a 4xx statusCode added (would defeat 5xx rollback +
    // tenant-blind 500 default-message replacement in the global envelope).
    expect((thrown as { statusCode?: number }).statusCode).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// §5 — actorNonce undefined → skip withActorContext, still call wrapper
// ---------------------------------------------------------------------------

describe('getCrisisOperationalHealthHandler §5 — missing actorNonce path (fail-closed at wrapper LAYER C)', () => {
  it('§5a undefined actorNonce skips withActorContext but still calls withDbRole + wrapper (the wrapper itself raises if LAYER C cannot resolve actor; tested separately)', async () => {
    const tx = makeFakeTx();
    installDefaultCompositionMocks(tx);

    await getCrisisOperationalHealthHandler(makeReq({ actorNonce: undefined }), makeReply());

    expect(withActorContext).not.toHaveBeenCalled();
    expect(withDbRole).toHaveBeenCalledTimes(1);
    expect(tx.query).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// §6 — actorNonce defined → withActorContext wraps the elevated callback
// ---------------------------------------------------------------------------

describe('getCrisisOperationalHealthHandler §6 — actor-context wrap order', () => {
  it('§6a withActorContext is invoked OUTSIDE withDbRole (composition: withActorContext → withDbRole → wrapper)', async () => {
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
