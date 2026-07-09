/**
 * handlers.test.ts — pure-unit coverage of the Subscription HTTP handler
 * surface (transition-handlers.ts) with the composition helpers + service
 * mocked. Complements:
 *   - state-machine.test.ts (pure §15 table + guards)
 *   - subscription-http.test.ts (live-PG end-to-end)
 *
 * Focus (no DB): boundary validation (400), actor/scope gating (401/403),
 * and the outcome -> HTTP status mapping (200/202/404/409/400/422), plus
 * that a state-changing handler routes through withIdempotentExecution.
 */

import type { FastifyReply, FastifyRequest } from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — the composition helpers + the service. The service outcome is
// swappable per test so the handler's outcome->status mapping is exercised
// in isolation.
// ---------------------------------------------------------------------------

const mockTx = { query: vi.fn(async () => ({ rows: [], rowCount: 0 })) };

function sampleRow(): Record<string, unknown> {
  const now = new Date('2026-01-01T00:00:00.000Z');
  return {
    id: 'sub_01ARZ3NDEKTSV4RRFFQ69G5FAV',
    tenant_id: 'Telecheck-US',
    patient_id: 'acct_p',
    product_id: 'prd_01ARZ3NDEKTSV4RRFFQ69G5FAV',
    prescription_id: 'mrx_01ARZ3NDEKTSV4RRFFQ69G5FAV',
    cadence: 'monthly',
    unit_price: '199.00',
    currency: 'USD',
    status: 'PAUSED',
    started_at: now,
    paused_at: now,
    pause_until: now,
    cancelled_at: null,
    cancel_reason: null,
    next_renewal_at: null,
    last_fulfilled_at: null,
    preauth_window_months: 12,
    preauth_renewals_remaining: 11,
    payment_method_id: 'pm_x',
    version: 2,
    created_at: now,
    updated_at: now,
  };
}

let transitionOutcome: unknown = { outcome: 'transitioned', row: sampleRow(), eventId: 'sue_x' };

vi.mock('../../../../lib/idempotent-handler.js', () => ({
  withIdempotentExecution: vi.fn(
    async (
      _req: unknown,
      reply: { code: (n: number) => { send: (b: unknown) => unknown } },
      _mapServiceError: unknown,
      body: (tx: unknown, ctx: unknown) => Promise<{ status: number; view: unknown }>,
    ) => {
      const result = await body(mockTx, { tenantId: 'Telecheck-US' });
      return reply.code(result.status).send(result.view);
    },
  ),
}));

vi.mock('../../../../lib/rls.js', () => ({
  withTenantContext: vi.fn(async (_tx: unknown, _tenantId: string, fn: () => Promise<unknown>) =>
    fn(),
  ),
}));

vi.mock('../../../../lib/tenant-context.js', () => ({
  requireTenantContext: vi.fn(() => ({ tenantId: 'Telecheck-US', countryOfCare: 'US' })),
}));

vi.mock('../../../../lib/auth-context.js', async () => {
  const actual = await vi.importActual<typeof import('../../../../lib/auth-context.js')>(
    '../../../../lib/auth-context.js',
  );
  return {
    ...actual,
    resolveActorTenantIdForAudit: vi.fn(() => 'Telecheck-US'),
    requireActorContext: vi.fn((req: { __actor?: unknown }) => {
      if (req.__actor === undefined) {
        throw new actual.UnauthenticatedError();
      }
      return req.__actor;
    }),
  };
});

vi.mock('../service.js', () => ({
  executeSubscriptionTransition: vi.fn(async () => transitionOutcome),
}));

import { UnauthenticatedError, UnauthorizedRoleError } from '../../../../lib/auth-context.js';

import {
  cancelSubscriptionHandler,
  pauseSubscriptionHandler,
  resumeSubscriptionHandler,
  switchSubscriptionHandler,
} from './transition-handlers.js';

// ---------------------------------------------------------------------------
// Reply double
// ---------------------------------------------------------------------------

interface CapturedReply {
  statusCode: number | null;
  body: unknown;
  code: (n: number) => CapturedReply;
  send: (b: unknown) => CapturedReply;
}

function makeReply(): CapturedReply {
  const r: CapturedReply = {
    statusCode: null,
    body: undefined,
    code(n: number) {
      r.statusCode = n;
      return r;
    },
    send(b: unknown) {
      r.body = b;
      return r;
    },
  };
  return r;
}

const VALID_SUB_ID = 'sub_01ARZ3NDEKTSV4RRFFQ69G5FAV';
const VALID_PRD_ID = 'prd_01ARZ3NDEKTSV4RRFFQ69G5FAV';

function makeReq(
  overrides: Partial<{ params: unknown; body: unknown; actor: unknown }>,
): FastifyRequest {
  return {
    id: 'req-1',
    params: overrides.params ?? { subscription_id: VALID_SUB_ID },
    body: overrides.body ?? {},
    __actor: overrides.actor,
    server: { httpErrors: { forbidden: (m: string) => new Error(m) } },
  } as unknown as FastifyRequest;
}

const PATIENT = { role: 'patient', accountId: 'acct_p', tenantId: 'Telecheck-US' };
const CLINICIAN = { role: 'clinician', accountId: 'acct_c', tenantId: 'Telecheck-US' };

function futureIso(days: number): string {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
}

beforeEach(() => {
  transitionOutcome = { outcome: 'transitioned', row: sampleRow(), eventId: 'sue_x' };
});

// ---------------------------------------------------------------------------
// Auth / actor gating
// ---------------------------------------------------------------------------

describe('transition handlers — actor gating', () => {
  it('unauthenticated → UnauthenticatedError (global handler maps to 401)', async () => {
    const req = makeReq({ actor: undefined });
    await expect(
      pauseSubscriptionHandler(req, makeReply() as unknown as FastifyReply),
    ).rejects.toBeInstanceOf(UnauthenticatedError);
  });

  it('clinician role → UnauthorizedRoleError (no ratified §20 write endpoint)', async () => {
    const req = makeReq({
      actor: CLINICIAN,
      body: { reason: 'travel', pause_until: futureIso(10) },
    });
    await expect(
      pauseSubscriptionHandler(req, makeReply() as unknown as FastifyReply),
    ).rejects.toBeInstanceOf(UnauthorizedRoleError);
  });
});

// ---------------------------------------------------------------------------
// Path-param + body validation (400)
// ---------------------------------------------------------------------------

describe('transition handlers — validation (400)', () => {
  it('pause: malformed subscription_id → 400', async () => {
    const reply = makeReply();
    await pauseSubscriptionHandler(
      makeReq({
        actor: PATIENT,
        params: { subscription_id: 'not-a-sub' },
        body: { reason: 'travel', pause_until: futureIso(10) },
      }),
      reply as unknown as FastifyReply,
    );
    expect(reply.statusCode).toBe(400);
  });

  it('pause: missing pause_until → 400', async () => {
    const reply = makeReply();
    await pauseSubscriptionHandler(
      makeReq({ actor: PATIENT, body: { reason: 'travel' } }),
      reply as unknown as FastifyReply,
    );
    expect(reply.statusCode).toBe(400);
  });

  it('pause: invalid reason enum → 400', async () => {
    const reply = makeReply();
    await pauseSubscriptionHandler(
      makeReq({ actor: PATIENT, body: { reason: 'not_a_reason', pause_until: futureIso(10) } }),
      reply as unknown as FastifyReply,
    );
    expect(reply.statusCode).toBe(400);
  });

  it('switch: missing/invalid new_product_id → 400', async () => {
    const reply = makeReply();
    await switchSubscriptionHandler(
      makeReq({ actor: PATIENT, body: { new_product_id: 'bad', reason: 'preference' } }),
      reply as unknown as FastifyReply,
    );
    expect(reply.statusCode).toBe(400);
  });

  it('cancel: deflection_attempted true without deflection_outcome → 400', async () => {
    const reply = makeReply();
    await cancelSubscriptionHandler(
      makeReq({ actor: PATIENT, body: { reason: 'financial', deflection_attempted: true } }),
      reply as unknown as FastifyReply,
    );
    expect(reply.statusCode).toBe(400);
  });

  it('cancel: non-boolean deflection_attempted → 400', async () => {
    const reply = makeReply();
    await cancelSubscriptionHandler(
      makeReq({ actor: PATIENT, body: { reason: 'financial' } }),
      reply as unknown as FastifyReply,
    );
    expect(reply.statusCode).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Outcome -> HTTP status mapping
// ---------------------------------------------------------------------------

describe('transition handlers — outcome mapping', () => {
  it('transitioned → 200 with a tenant-blind view (pause)', async () => {
    const reply = makeReply();
    await pauseSubscriptionHandler(
      makeReq({ actor: PATIENT, body: { reason: 'travel', pause_until: futureIso(10) } }),
      reply as unknown as FastifyReply,
    );
    expect(reply.statusCode).toBe(200);
    expect((reply.body as { status: string }).status).toBe('PAUSED');
    expect((reply.body as Record<string, unknown>).tenant_id).toBeUndefined();
    expect((reply.body as Record<string, unknown>).payment_method_id).toBeUndefined();
  });

  it('transitioned → 202 for switch (success status is 202)', async () => {
    transitionOutcome = {
      outcome: 'transitioned',
      row: { ...sampleRow(), status: 'SWITCHING' },
      eventId: 'sue_x',
    };
    const reply = makeReply();
    await switchSubscriptionHandler(
      makeReq({ actor: PATIENT, body: { new_product_id: VALID_PRD_ID, reason: 'preference' } }),
      reply as unknown as FastifyReply,
    );
    expect(reply.statusCode).toBe(202);
    expect((reply.body as { status: string }).status).toBe('SWITCHING');
  });

  it('not_found → 404 tenant-blind (resume)', async () => {
    transitionOutcome = { outcome: 'not_found' };
    const reply = makeReply();
    await resumeSubscriptionHandler(makeReq({ actor: PATIENT }), reply as unknown as FastifyReply);
    expect(reply.statusCode).toBe(404);
    expect((reply.body as { error: { code: string } }).error.code).toBe(
      'internal.resource.not_found',
    );
  });

  it('invalid_state → 409 INVALID_STATE_TRANSITION (resume)', async () => {
    transitionOutcome = {
      outcome: 'invalid_state',
      currentStatus: 'CANCELLED',
      expectedFrom: 'PAUSED',
    };
    const reply = makeReply();
    await resumeSubscriptionHandler(makeReq({ actor: PATIENT }), reply as unknown as FastifyReply);
    expect(reply.statusCode).toBe(409);
    expect((reply.body as { error: { code: string } }).error.code).toBe(
      'internal.subscription.invalid_state_transition',
    );
  });

  it('guard_failed(invalid_pause_duration) → 400 (pause)', async () => {
    transitionOutcome = { outcome: 'guard_failed', reason: 'invalid_pause_duration' };
    const reply = makeReply();
    await pauseSubscriptionHandler(
      makeReq({ actor: PATIENT, body: { reason: 'travel', pause_until: futureIso(10) } }),
      reply as unknown as FastifyReply,
    );
    expect(reply.statusCode).toBe(400);
    expect((reply.body as { error: { code: string } }).error.code).toBe(
      'internal.subscription.invalid_pause_duration',
    );
  });

  it('guard_failed(actor_not_permitted) → 403 (resume)', async () => {
    transitionOutcome = { outcome: 'guard_failed', reason: 'actor_not_permitted' };
    const reply = makeReply();
    await resumeSubscriptionHandler(makeReq({ actor: PATIENT }), reply as unknown as FastifyReply);
    expect(reply.statusCode).toBe(403);
  });

  it('guard_failed(other business rule) → 422 (resume)', async () => {
    transitionOutcome = { outcome: 'guard_failed', reason: 'payment_method_missing' };
    const reply = makeReply();
    await resumeSubscriptionHandler(makeReq({ actor: PATIENT }), reply as unknown as FastifyReply);
    expect(reply.statusCode).toBe(422);
  });
});
