/**
 * get-mode1-volume-health.test.ts — unit tests for the Sprint 2 PR 4
 * deferred-wrapper handler scaffold (Mode 1 sibling of consult-queue).
 *
 * Structure mirrors get-consult-queue-health.test.ts §1-§9 verbatim
 * (same composition discipline, same fail-closed mapping, same forward-
 * compat post-hygiene happy path). See that file's header for the per-
 * section rationale.
 */

import type { FastifyReply, FastifyRequest } from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../../lib/auth-context.js', () => ({
  requireSliceRoleMembership: vi.fn(),
  resolveActorTenantIdForAudit: vi.fn(),
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
vi.mock('../../audit.js', () => ({
  emitDashboardQueryExecutedAudit: vi.fn(async () => ({})),
}));

import { withActorContext } from '../../../../lib/actor-context-binding.js';
import {
  requireSliceRoleMembership,
  resolveActorTenantIdForAudit,
} from '../../../../lib/auth-context.js';
import { withTransaction } from '../../../../lib/db.js';
import { withTenantContext } from '../../../../lib/rls.js';
import { requireTenantContext } from '../../../../lib/tenant-context.js';
import { withDbRole } from '../../../../lib/with-db-role.js';

import { getMode1VolumeHealthHandler } from './get-mode1-volume-health.js';

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

// Post-hygiene sample row (shape matches the migration 069 wrapper's
// RETURNS TABLE — CDM §4.NEW7/§4.NEW8d ratified columns).
const SAMPLE_ROWS = [
  {
    tenant_id: 'Telecheck-US',
    active_conversation_count_24h: '42',
    crisis_detection_trigger_count_24h: '2',
    safety_floor_response_emitted_count_24h: '2',
    conversation_duration_p50_seconds_24h: '312.50',
    conversation_duration_p95_seconds_24h: '1840.25',
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
    // Sprint 4: handler reads req.actorContext?.accountId ?? req.headers
    // ['x-actor-id'] for Cat A audit attribution — provide empty defaults.
    actorContext: undefined,
    headers: {},
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
  vi.mocked(requireSliceRoleMembership).mockImplementation((_req, role) => role);
  vi.mocked(resolveActorTenantIdForAudit).mockReturnValue('Telecheck-US');
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
// §1 — happy path (post-hygiene state)
// ---------------------------------------------------------------------------

describe('getMode1VolumeHealthHandler §1 — happy path composition', () => {
  it('§1a invokes guards, then composes withTransaction → withTenantContext → withActorContext → withDbRole, then calls the SECDEF wrapper', async () => {
    const tx = makeFakeTx();
    installDefaultCompositionMocks(tx);
    const req = makeReq({ actorNonce: 'fake-uuid-v4-nonce' });

    const result = await getMode1VolumeHealthHandler(req, makeReply());

    expect(requireTenantContext).toHaveBeenCalledWith(req);
    expect(requireSliceRoleMembership).toHaveBeenCalledWith(req, 'admin_basic_operator');
    expect(withTransaction).toHaveBeenCalledTimes(1);
    expect(withTenantContext).toHaveBeenCalledTimes(1);
    expect(withTenantContext).toHaveBeenCalledWith(tx, 'Telecheck-US', expect.any(Function));
    expect(withActorContext).toHaveBeenCalledTimes(1);
    expect(withActorContext).toHaveBeenCalledWith(tx, 'fake-uuid-v4-nonce', expect.any(Function));
    expect(withDbRole).toHaveBeenCalledTimes(1);
    expect(withDbRole).toHaveBeenCalledWith(tx, 'admin_basic_operator', expect.any(Function));

    expect(tx.query).toHaveBeenCalledTimes(1);
    const [sql, params] = tx.query.mock.calls[0]!;
    expect(sql).toBe('SELECT * FROM read_admin_mode1_volume_health($1, $2)');
    expect(params).toEqual(['Telecheck-US', {}]);

    expect(result).toEqual({ rows: SAMPLE_ROWS });
  });

  it('§1b returns empty rows[] when the wrapper returns no rows', async () => {
    const tx = makeFakeTx();
    tx.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    installDefaultCompositionMocks(tx);

    const result = await getMode1VolumeHealthHandler(
      makeReq({ actorNonce: 'fake-nonce' }),
      makeReply(),
    );
    expect(result).toEqual({ rows: [] });
  });
});

// ---------------------------------------------------------------------------
// §2 — tenant guard precedes tx
// ---------------------------------------------------------------------------

describe('getMode1VolumeHealthHandler §2 — tenant guard precedes tx', () => {
  it('§2a requireTenantContext throw aborts before withTransaction', async () => {
    vi.mocked(requireTenantContext).mockImplementation(() => {
      throw new Error('tenantContext absent — programming error');
    });

    await expect(getMode1VolumeHealthHandler(makeReq(), makeReply())).rejects.toThrow(
      /tenantContext absent/,
    );

    expect(requireSliceRoleMembership).not.toHaveBeenCalled();
    expect(withTransaction).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// §3 — admin-role guard precedes tx
// ---------------------------------------------------------------------------

describe('getMode1VolumeHealthHandler §3 — admin-role guard precedes tx', () => {
  it('§3a requireSliceRoleMembership throw aborts before withTransaction', async () => {
    vi.mocked(requireTenantContext).mockReturnValue(
      FAKE_TENANT_CTX as unknown as ReturnType<typeof requireTenantContext>,
    );
    vi.mocked(requireSliceRoleMembership).mockImplementation(() => {
      throw new Error('forbidden: actor lacks admin role');
    });

    await expect(getMode1VolumeHealthHandler(makeReq(), makeReply())).rejects.toThrow(/forbidden/);

    expect(withTransaction).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// §4 — 42883 (undefined_function) → 503 (LIVE v0.1 STATE per migration 044 §4)
// ---------------------------------------------------------------------------

describe('getMode1VolumeHealthHandler §4 — 42883 → 503 (live v0.1 state)', () => {
  it('§4a wrapper-undefined (SQLSTATE 42883) maps to 503 tenant-blind', async () => {
    const tx = makeFakeTx();
    installDefaultCompositionMocks(tx);

    const undefinedFnError = Object.assign(
      new Error('function read_admin_mode1_volume_health(text, jsonb) does not exist'),
      { code: '42883' },
    );
    tx.query.mockRejectedValueOnce(undefinedFnError);

    let thrown: unknown;
    try {
      await getMode1VolumeHealthHandler(makeReq({ actorNonce: 'fake-nonce' }), makeReply());
    } catch (e) {
      thrown = e;
    }

    const errObj = thrown as { statusCode?: number; message?: string };
    expect(errObj.statusCode).toBe(503);
    expect(errObj.message ?? '').not.toContain('Telecheck-US');
    expect(errObj.message ?? '').not.toContain('Telecheck-Ghana');
    expect(errObj.message ?? '').not.toContain('42883');
    expect(errObj.message ?? '').not.toContain('does not exist');
    expect(errObj.message ?? '').toMatch(/unavailable|temporarily/i);
  });
});

// ---------------------------------------------------------------------------
// §5 — 0A000 (feature_not_supported) → 503 (forward-compat future stub state)
// ---------------------------------------------------------------------------

describe('getMode1VolumeHealthHandler §5 — 0A000 → 503 (forward-compat)', () => {
  it('§5a wrapper-stub-raise (SQLSTATE 0A000) maps to 503 tenant-blind', async () => {
    const tx = makeFakeTx();
    installDefaultCompositionMocks(tx);

    const featureNotSupportedError = Object.assign(
      new Error(
        'read_admin_mode1_volume_health: data source not yet available pending Mode 1 slice landing',
      ),
      { code: '0A000' },
    );
    tx.query.mockRejectedValueOnce(featureNotSupportedError);

    let thrown: unknown;
    try {
      await getMode1VolumeHealthHandler(makeReq({ actorNonce: 'fake-nonce' }), makeReply());
    } catch (e) {
      thrown = e;
    }

    const errObj = thrown as { statusCode?: number; message?: string };
    expect(errObj.statusCode).toBe(503);
    expect(errObj.message ?? '').not.toContain('Telecheck-US');
    expect(errObj.message ?? '').not.toContain('0A000');
    expect(errObj.message ?? '').not.toContain('Mode 1 slice');
  });
});

// ---------------------------------------------------------------------------
// §6 — 42501 → 403 tenant-blind
// ---------------------------------------------------------------------------

describe('getMode1VolumeHealthHandler §6 — 42501 → 403 tenant-blind', () => {
  it('§6a 42501 (tenant scope mismatch / role gap) maps to 403; raw PG details NOT leaked', async () => {
    const tx = makeFakeTx();
    installDefaultCompositionMocks(tx);

    const wrapperError = Object.assign(
      new Error(
        'read_admin_mode1_volume_health: tenant scope mismatch — actor tenant Telecheck-US does not match wrapper p_tenant_id Telecheck-Ghana',
      ),
      { code: '42501' },
    );
    tx.query.mockRejectedValueOnce(wrapperError);

    let thrown: unknown;
    try {
      await getMode1VolumeHealthHandler(makeReq({ actorNonce: 'fake-nonce' }), makeReply());
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
// §7 — other PG errors propagate UNCHANGED
// ---------------------------------------------------------------------------

describe('getMode1VolumeHealthHandler §7 — non-mapped PG errors propagate unchanged', () => {
  it('§7a connection-terminated (SQLSTATE 57P01) propagates with code intact', async () => {
    const tx = makeFakeTx();
    installDefaultCompositionMocks(tx);

    const otherPgError = Object.assign(new Error('connection terminated unexpectedly'), {
      code: '57P01',
    });
    tx.query.mockRejectedValueOnce(otherPgError);

    let thrown: unknown;
    try {
      await getMode1VolumeHealthHandler(makeReq({ actorNonce: 'fake-nonce' }), makeReply());
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

describe('getMode1VolumeHealthHandler §8 — missing actorNonce path', () => {
  it('§8a undefined actorNonce skips withActorContext but still calls withDbRole + wrapper', async () => {
    const tx = makeFakeTx();
    installDefaultCompositionMocks(tx);

    await getMode1VolumeHealthHandler(makeReq({ actorNonce: undefined }), makeReply());

    expect(withActorContext).not.toHaveBeenCalled();
    expect(withDbRole).toHaveBeenCalledTimes(1);
    expect(tx.query).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// §9 — composition order
// ---------------------------------------------------------------------------

describe('getMode1VolumeHealthHandler §9 — actor-context wrap order', () => {
  it('§9a withActorContext OUTSIDE withDbRole', async () => {
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

    await getMode1VolumeHealthHandler(makeReq({ actorNonce: 'fake-nonce' }), makeReply());

    expect(callOrder).toEqual([
      'withActorContext-enter',
      'withDbRole-enter',
      'wrapper-call',
      'withDbRole-exit',
      'withActorContext-exit',
    ]);
  });
});
