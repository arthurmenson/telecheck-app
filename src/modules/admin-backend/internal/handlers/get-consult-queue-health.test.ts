/**
 * get-consult-queue-health.test.ts — unit tests for the Sprint 2 PR 4
 * deferred-wrapper handler scaffold.
 *
 * Covers the handler's composition discipline at unit scope (no real DB)
 * + the v0.1 fail-closed mapping for the deferred wrapper:
 *
 *   §1 happy path (POST-HYGIENE state): wrapper exists + returns rows;
 *      handler composes context helpers in canonical order + returns
 *      { rows: [...] }. Proves the scaffold needs ZERO change when the
 *      future Option-2 hygiene migration lands the wrapper.
 *   §2 tenant guard fires before tx open.
 *   §3 admin-role guard fires before tx open.
 *   §4 wrapper UNDEFINED at v0.1 (PG SQLSTATE 42883) → 503 tenant-blind.
 *      THIS is the live v0.1 state per migration 044 §3.
 *   §5 wrapper RAISEs 0A000 (forward-compat future stub state) → 503
 *      tenant-blind.
 *   §6 wrapper-level 42501 (tenant scope mismatch / role gap) → 403
 *      tenant-blind (mirrors get-crisis-operational-health.ts R1 HIGH-1
 *      + R2 MED-1 closure pattern).
 *   §7 other PG errors propagate UNCHANGED (no 503/403 wrapping).
 *   §8 actorNonce undefined → skip withActorContext but still call wrapper.
 *   §9 composition order: withActorContext OUTSIDE withDbRole.
 *
 * Mocking strategy + harness: parity with
 * get-crisis-operational-health.test.ts (vi.mock the lib/* helpers so
 * composition is observable + assertable without standing up a real DB).
 */

import type { FastifyReply, FastifyRequest } from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// vi.mock hoists ABOVE imports.
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

import { withActorContext } from '../../../../lib/actor-context-binding.js';
import { requireAdminRole } from '../../../../lib/admin-role.js';
import { withTransaction } from '../../../../lib/db.js';
import { withTenantContext } from '../../../../lib/rls.js';
import { requireTenantContext } from '../../../../lib/tenant-context.js';
import { withDbRole } from '../../../../lib/with-db-role.js';

import { getConsultQueueHealthHandler } from './get-consult-queue-health.js';

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

// Post-hygiene sample row (shape matches the row interface in the handler).
const SAMPLE_ROWS = [
  {
    tenant_id: 'Telecheck-US',
    queue_status: 'waiting',
    active_consults_count: '7',
    sla_breach_count: '0',
    avg_wait_seconds: '120.5',
    oldest_unclaimed_age_seconds: '480',
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
  const httpErrors = {
    forbidden: (msg?: string) => Object.assign(new Error(msg ?? 'Forbidden'), { statusCode: 403 }),
    serviceUnavailable: (msg?: string) =>
      Object.assign(new Error(msg ?? 'Service Unavailable'), { statusCode: 503 }),
    notFound: (msg?: string) => Object.assign(new Error(msg ?? 'Not Found'), { statusCode: 404 }),
    badRequest: (msg?: string) =>
      Object.assign(new Error(msg ?? 'Bad Request'), { statusCode: 400 }),
  };
  return {
    actorNonce: opts?.actorNonce,
    server: { httpErrors },
  } as unknown as FastifyRequest;
}

function makeReply(): FastifyReply {
  return {} as unknown as FastifyReply;
}

function installDefaultCompositionMocks(tx: FakeTx): void {
  vi.mocked(requireTenantContext).mockReturnValue(
    FAKE_TENANT_CTX as unknown as ReturnType<typeof requireTenantContext>,
  );
  vi.mocked(requireAdminRole).mockReturnValue('platform_admin');
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
// §1 — happy path (post-hygiene state: wrapper exists)
// ---------------------------------------------------------------------------

describe('getConsultQueueHealthHandler §1 — happy path composition (post-hygiene state)', () => {
  it('§1a invokes guards, then composes withTransaction → withTenantContext → withActorContext → withDbRole, then calls the SECDEF wrapper', async () => {
    const tx = makeFakeTx();
    installDefaultCompositionMocks(tx);
    const req = makeReq({ actorNonce: 'fake-uuid-v4-nonce' });

    const result = await getConsultQueueHealthHandler(req, makeReply());

    expect(requireTenantContext).toHaveBeenCalledWith(req);
    expect(requireAdminRole).toHaveBeenCalledWith(req);
    expect(withTransaction).toHaveBeenCalledTimes(1);
    expect(withTenantContext).toHaveBeenCalledTimes(1);
    expect(withTenantContext).toHaveBeenCalledWith(tx, 'Telecheck-US', expect.any(Function));
    expect(withActorContext).toHaveBeenCalledTimes(1);
    expect(withActorContext).toHaveBeenCalledWith(tx, 'fake-uuid-v4-nonce', expect.any(Function));
    expect(withDbRole).toHaveBeenCalledTimes(1);
    expect(withDbRole).toHaveBeenCalledWith(tx, 'admin_basic_operator', expect.any(Function));

    expect(tx.query).toHaveBeenCalledTimes(1);
    const [sql, params] = tx.query.mock.calls[0]!;
    expect(sql).toBe('SELECT * FROM read_admin_consult_queue_health($1, $2)');
    expect(params).toEqual(['Telecheck-US', {}]);

    expect(result).toEqual({ rows: SAMPLE_ROWS });
  });

  it('§1b returns empty rows[] when the wrapper returns no rows', async () => {
    const tx = makeFakeTx();
    tx.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    installDefaultCompositionMocks(tx);

    const result = await getConsultQueueHealthHandler(
      makeReq({ actorNonce: 'fake-nonce' }),
      makeReply(),
    );
    expect(result).toEqual({ rows: [] });
  });
});

// ---------------------------------------------------------------------------
// §2 — tenant guard fires before tx open
// ---------------------------------------------------------------------------

describe('getConsultQueueHealthHandler §2 — tenant guard precedes tx', () => {
  it('§2a requireTenantContext throw aborts before withTransaction is called', async () => {
    vi.mocked(requireTenantContext).mockImplementation(() => {
      throw new Error('tenantContext absent — programming error');
    });

    await expect(getConsultQueueHealthHandler(makeReq(), makeReply())).rejects.toThrow(
      /tenantContext absent/,
    );

    expect(requireAdminRole).not.toHaveBeenCalled();
    expect(withTransaction).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// §3 — admin-role guard fires before tx open
// ---------------------------------------------------------------------------

describe('getConsultQueueHealthHandler §3 — admin-role guard precedes tx', () => {
  it('§3a requireAdminRole throw aborts before withTransaction is called', async () => {
    vi.mocked(requireTenantContext).mockReturnValue(
      FAKE_TENANT_CTX as unknown as ReturnType<typeof requireTenantContext>,
    );
    vi.mocked(requireAdminRole).mockImplementation(() => {
      throw new Error('forbidden: actor lacks admin role');
    });

    await expect(getConsultQueueHealthHandler(makeReq(), makeReply())).rejects.toThrow(/forbidden/);

    expect(withTransaction).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// §4 — wrapper UNDEFINED at v0.1 (PG SQLSTATE 42883) → 503 tenant-blind
//      THIS IS THE LIVE v0.1 STATE per migration 044 §3.
// ---------------------------------------------------------------------------

describe('getConsultQueueHealthHandler §4 — 42883 undefined_function → 503 (live v0.1 state)', () => {
  it('§4a wrapper-undefined (SQLSTATE 42883) maps to 503 tenant-blind; message contains no tenant identifiers', async () => {
    const tx = makeFakeTx();
    installDefaultCompositionMocks(tx);

    const undefinedFnError = Object.assign(
      new Error('function read_admin_consult_queue_health(text, jsonb) does not exist'),
      { code: '42883' },
    );
    tx.query.mockRejectedValueOnce(undefinedFnError);

    let thrown: unknown;
    try {
      await getConsultQueueHealthHandler(makeReq({ actorNonce: 'fake-nonce' }), makeReply());
    } catch (e) {
      thrown = e;
    }

    expect(thrown).toBeDefined();
    const errObj = thrown as { statusCode?: number; message?: string };
    expect(errObj.statusCode).toBe(503);
    // I-025 invariant: message must NOT contain tenant identifiers or
    // raw SQLSTATE/PG details.
    expect(errObj.message ?? '').not.toContain('Telecheck-US');
    expect(errObj.message ?? '').not.toContain('Telecheck-Ghana');
    expect(errObj.message ?? '').not.toContain('42883');
    expect(errObj.message ?? '').not.toContain('does not exist');
    expect(errObj.message ?? '').toMatch(/unavailable|temporarily/i);
  });
});

// ---------------------------------------------------------------------------
// §5 — wrapper RAISEs 0A000 (future stub state) → 503 tenant-blind
// ---------------------------------------------------------------------------

describe('getConsultQueueHealthHandler §5 — 0A000 feature_not_supported → 503 (forward-compat)', () => {
  it('§5a wrapper-stub-raise (SQLSTATE 0A000) maps to 503 tenant-blind', async () => {
    const tx = makeFakeTx();
    installDefaultCompositionMocks(tx);

    const featureNotSupportedError = Object.assign(
      new Error(
        'read_admin_consult_queue_health: data source not yet available pending consult slice landing',
      ),
      { code: '0A000' },
    );
    tx.query.mockRejectedValueOnce(featureNotSupportedError);

    let thrown: unknown;
    try {
      await getConsultQueueHealthHandler(makeReq({ actorNonce: 'fake-nonce' }), makeReply());
    } catch (e) {
      thrown = e;
    }

    const errObj = thrown as { statusCode?: number; message?: string };
    expect(errObj.statusCode).toBe(503);
    expect(errObj.message ?? '').not.toContain('Telecheck-US');
    expect(errObj.message ?? '').not.toContain('0A000');
    expect(errObj.message ?? '').not.toContain('consult slice');
  });
});

// ---------------------------------------------------------------------------
// §6 — 42501 (LAYER C / role gap) → 403 tenant-blind
// ---------------------------------------------------------------------------

describe('getConsultQueueHealthHandler §6 — 42501 → 403 tenant-blind (mirrors PR 1)', () => {
  it('§6a 42501 (tenant scope mismatch / role gap) maps to 403; raw PG details + tenant IDs NOT leaked', async () => {
    const tx = makeFakeTx();
    installDefaultCompositionMocks(tx);

    const wrapperError = Object.assign(
      new Error(
        'read_admin_consult_queue_health: tenant scope mismatch — actor tenant Telecheck-US does not match wrapper p_tenant_id Telecheck-Ghana',
      ),
      { code: '42501' },
    );
    tx.query.mockRejectedValueOnce(wrapperError);

    let thrown: unknown;
    try {
      await getConsultQueueHealthHandler(makeReq({ actorNonce: 'fake-nonce' }), makeReply());
    } catch (e) {
      thrown = e;
    }

    const errObj = thrown as { statusCode?: number; message?: string };
    expect(errObj.statusCode).toBe(403);
    expect(errObj.message ?? '').not.toContain('Telecheck-US');
    expect(errObj.message ?? '').not.toContain('Telecheck-Ghana');
    expect(errObj.message ?? '').not.toContain('42501');
    expect(errObj.message ?? '').toMatch(/scope|forbidden|insufficient/i);
  });
});

// ---------------------------------------------------------------------------
// §7 — other PG errors propagate UNCHANGED (no 503/403 wrapping)
// ---------------------------------------------------------------------------

describe('getConsultQueueHealthHandler §7 — non-mapped PG errors propagate unchanged', () => {
  it('§7a connection-terminated (SQLSTATE 57P01) propagates with code intact + no statusCode added', async () => {
    const tx = makeFakeTx();
    installDefaultCompositionMocks(tx);

    const otherPgError = Object.assign(
      new Error('connection terminated unexpectedly'),
      { code: '57P01' }, // admin_shutdown
    );
    tx.query.mockRejectedValueOnce(otherPgError);

    let thrown: unknown;
    try {
      await getConsultQueueHealthHandler(makeReq({ actorNonce: 'fake-nonce' }), makeReply());
    } catch (e) {
      thrown = e;
    }

    expect(thrown).toBe(otherPgError);
    expect((thrown as { code?: string }).code).toBe('57P01');
    expect((thrown as { statusCode?: number }).statusCode).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// §8 — actorNonce undefined path
// ---------------------------------------------------------------------------

describe('getConsultQueueHealthHandler §8 — missing actorNonce path', () => {
  it('§8a undefined actorNonce skips withActorContext but still calls withDbRole + wrapper', async () => {
    const tx = makeFakeTx();
    installDefaultCompositionMocks(tx);

    await getConsultQueueHealthHandler(makeReq({ actorNonce: undefined }), makeReply());

    expect(withActorContext).not.toHaveBeenCalled();
    expect(withDbRole).toHaveBeenCalledTimes(1);
    expect(tx.query).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// §9 — composition order: withActorContext OUTSIDE withDbRole
// ---------------------------------------------------------------------------

describe('getConsultQueueHealthHandler §9 — actor-context wrap order', () => {
  it('§9a withActorContext invoked OUTSIDE withDbRole (composition: withActorContext → withDbRole → wrapper)', async () => {
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

    await getConsultQueueHealthHandler(makeReq({ actorNonce: 'fake-nonce' }), makeReply());

    expect(callOrder).toEqual([
      'withActorContext-enter',
      'withDbRole-enter',
      'wrapper-call',
      'withDbRole-exit',
      'withActorContext-exit',
    ]);
  });
});
