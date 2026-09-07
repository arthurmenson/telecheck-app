import sensible from '@fastify/sensible';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { idempotencyPlugin } from '../../../../lib/idempotency.js';

import { admitCareIntakeV1Request, submitIntakeV1Handler } from './submit-intake-v1.js';

const h = vi.hoisted(() => ({
  admit: vi.fn(),
  submit: vi.fn(),
  transaction: vi.fn(),
  cacheLookup: vi.fn(),
  actor: undefined as Record<string, unknown> | undefined,
  nonce: 'unit-nonce' as string | undefined,
  order: [] as string[],
}));
const tenant = { tenantId: 'Telecheck-US', countryOfCare: 'US' };
const caseId = '01K00000000000000000000001';
const key = '01K00000000000000000000002';
vi.mock('../../../crisis-response/index.js', () => ({ admitPatientCareInput: h.admit }));
vi.mock('../../../../lib/db.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../lib/db.js')>()),
  withTenantBoundConnection: async (_tenant: string, work: (client: unknown) => Promise<unknown>) =>
    work({ query: h.cacheLookup }),
}));
vi.mock('../../../../lib/tenant-context.js', () => ({
  requireTenantContext: () => ({ tenantId: 'Telecheck-US', countryOfCare: 'US' }),
}));
vi.mock('../../../../lib/auth-context.js', () => ({
  requirePatientActorContext: () => {
    if (!h.actor) throw Object.assign(new Error('Authentication required'), { statusCode: 401 });
    if (h.actor['role'] !== 'patient')
      throw Object.assign(new Error('Patient required'), { statusCode: 403 });
    return h.actor;
  },
}));
vi.mock('../../../forms-intake/index.js', () => ({
  ConsultDefinitionError: class extends Error {},
}));
vi.mock('../services/clinical-intake-repository.js', () => ({
  careIntakeRepository: () => ({}),
  careIntakeTransaction: () => h.transaction,
  beginCareIntake: vi.fn(),
}));
vi.mock('../services/clinical-intake.js', () => ({
  createCareIntakeService: () => h.submit,
  CareIntakeError: class extends Error {},
}));
vi.mock('../../../../lib/idempotent-handler.js', () => ({
  withIdempotentExecution: async (
    req: { id: string },
    reply: { code: (value: number) => { send: (value: unknown) => unknown } },
    map: (error: unknown, reply: unknown, id: string) => boolean,
    body: (tx: unknown) => Promise<{ status: number; view: unknown }>,
    run: (work: (tx: unknown) => Promise<unknown>) => Promise<unknown>,
  ) => {
    try {
      const result = (await run(body)) as { status: number; view: unknown };
      return reply.code(result.status).send(result.view);
    } catch (error) {
      if (map(error, reply, req.id)) return reply;
      throw error;
    }
  },
}));

let app: FastifyInstance;
const resources = {
  country_of_care: 'US',
  emergency_number: '911',
  crisis_helplines: [],
  status: 'available',
};
const interrupted = {
  kind: 'crisis_interruption',
  recording_status: 'recorded',
  disclosure_status: 'available',
  crisis_event_id: caseId,
  escalation_status: 'pending',
  detector_version: 'keyword_engineering_v1',
  resources,
};
const input = {
  definition: {
    deployment_id: caseId,
    template_id: key,
    template_version: 1,
    schema_hash: 'a'.repeat(64),
  },
  answers: { reason: 'Synthetic ordinary care question' },
};

beforeEach(async () => {
  vi.clearAllMocks();
  h.order.length = 0;
  h.nonce = 'unit-nonce';
  h.actor = {
    accountId: '01K00000000000000000000003',
    sessionId: key,
    role: 'patient',
    tenantId: tenant.tenantId,
    delegateId: null,
  };
  h.admit.mockImplementation(async () => {
    h.order.push('admission');
    return { kind: 'no_detection' };
  });
  h.cacheLookup.mockImplementation(async () => {
    h.order.push('cache');
    return { rows: [] };
  });
  h.transaction.mockImplementation(async (work) => {
    h.order.push('business');
    return work({});
  });
  h.submit.mockResolvedValue({ submission_id: caseId, status: 'submitted' });
  app = Fastify({ logger: false });
  await app.register(sensible);
  app.addHook('onRequest', async (req) => {
    Object.assign(req, { actorContext: h.actor, actorNonce: h.nonce, tenantContext: tenant });
  });
  await app.register(idempotencyPlugin);
  app.post(
    '/v1/async-consults/:consult_id/intake',
    {
      config: { careBoundary: 'patient' },
      bodyLimit: 1_048_576,
      preValidation: admitCareIntakeV1Request,
    },
    submitIntakeV1Handler,
  );
  app.post('/unit-without-admission/:consult_id', submitIntakeV1Handler);
  await app.ready();
});
afterEach(async () => {
  await app.close();
});
function request(
  body: unknown = input,
  headers: Record<string, string> = { 'idempotency-key': key },
  url = `/v1/async-consults/${caseId}/intake`,
) {
  return app.inject({ method: 'POST', url, headers, payload: JSON.stringify(body) });
}
// This unit harness uses the real Fastify lifecycle and idempotency preHandler;
// actual Identity, PostgreSQL, crisis persistence and KMS are runtime acceptance.
describe('plaintext intake admission boundary', () => {
  it('submits after crisis admission and idempotency checks, with a private response', async () => {
    const response = await request(input, {
      'idempotency-key': key,
      'content-type': 'application/json',
    });
    expect(response.statusCode).toBe(201);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(h.order).toEqual(['admission', 'business']);
    expect(h.admit).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: h.actor!['accountId'],
        actorNonce: h.nonce,
        idempotencyKey: key,
      }),
      input,
      'form_response',
    );
    expect(h.submit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ accountId: h.actor!['accountId'] }),
      caseId,
      input,
    );
    expect(response.json()).toEqual({ submission_id: caseId, status: 'submitted' });
  });
  it.each([{}, { 'idempotency-key': 'invalid' }, { 'idempotency-key': key }])(
    'interrupts before idempotency validation for headers %j',
    async (headers) => {
      h.admit.mockResolvedValue(interrupted);
      const body = { unrelated_unknown_field: 'Synthetic trigger text', answers: false };
      const response = await request(body, { ...headers, 'content-type': 'application/json' });
      expect(response.statusCode).toBe(202);
      expect(response.json()).toEqual(interrupted);
      expect(h.admit.mock.calls[0]?.[1]).toEqual(body);
      expect(h.cacheLookup).not.toHaveBeenCalled();
      expect(h.transaction).not.toHaveBeenCalled();
    },
  );
  it.each(['not_recorded', 'unconfirmed'])(
    'blocks ordinary care with resources when recording is %s',
    async (recording) => {
      const result = {
        kind: 'crisis_interruption',
        recording_status: recording,
        escalation_status: recording === 'unconfirmed' ? 'unconfirmed' : 'not_queued',
        resources,
        detector_version: 'keyword_engineering_v1',
      };
      h.admit.mockResolvedValue(result);
      const response = await request({}, { 'content-type': 'application/json' });
      expect(response.statusCode).toBe(503);
      expect(response.json()).toEqual(result);
      expect(response.json()).not.toHaveProperty('crisis_event_id');
      expect(h.submit).not.toHaveBeenCalled();
    },
  );
  it('returns a truthful unavailable receipt when recording succeeded but disclosure is unavailable', async () => {
    const { crisis_event_id: _event, ...recorded } = interrupted;
    h.admit.mockResolvedValue({ ...recorded, disclosure_status: 'unavailable' });
    const response = await request(input, { 'content-type': 'application/json' });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      recording_status: 'recorded',
      escalation_status: 'pending',
      disclosure_status: 'unavailable',
    });
    expect(response.json()).not.toHaveProperty('crisis_event_id');
    expect(h.submit).not.toHaveBeenCalled();
    expect(h.cacheLookup).not.toHaveBeenCalled();
  });
  it('scans an invalid case path and query before business rejection', async () => {
    h.admit.mockResolvedValue(interrupted);
    const response = await request(
      input,
      { 'content-type': 'application/json' },
      '/v1/async-consults/invalid/intake?unknown=yes',
    );
    expect(response.statusCode).toBe(202);
    expect(h.transaction).not.toHaveBeenCalled();
  });
  it.each(['missing', 'invalid'])(
    'rejects %s ordinary retry keys only after admission',
    async (kind) => {
      const response = await request(input, {
        'content-type': 'application/json',
        ...(kind === 'invalid' ? { 'idempotency-key': 'invalid' } : {}),
      });
      expect(response.statusCode).toBe(400);
      expect(h.admit).toHaveBeenCalledOnce();
      expect(h.submit).not.toHaveBeenCalled();
    },
  );
  it.each(['clinician', 'tenant_admin', 'platform_admin'])(
    'rejects %s before patient crisis admission',
    async (role) => {
      h.actor!['role'] = role;
      const response = await request(input, {
        'idempotency-key': key,
        'content-type': 'application/json',
      });
      expect(response.statusCode).toBe(403);
      expect(h.admit).not.toHaveBeenCalled();
    },
  );
  it('requires authentication before crisis admission', async () => {
    h.actor = undefined;
    const response = await request(input, { 'content-type': 'application/json' });
    expect(response.statusCode).toBe(401);
    expect(h.admit).not.toHaveBeenCalled();
  });
  it.each(['delegate', 'nonce', 'tenant'])(
    'rejects unavailable %s scope before admission',
    async (scope) => {
      if (scope === 'delegate') h.actor!['delegateId'] = key;
      if (scope === 'nonce') h.nonce = undefined;
      if (scope === 'tenant') h.actor!['tenantId'] = 'Telecheck-Ghana';
      const response = await request(input, { 'content-type': 'application/json' });
      expect(response.statusCode).toBe(403);
      expect(h.admit).not.toHaveBeenCalled();
    },
  );
  it('rejects an expired admission session with no ordinary transaction', async () => {
    h.admit.mockRejectedValue(
      Object.assign(new Error('crisis_unauthenticated'), { code: 'PT401' }),
    );
    const response = await request(input, {
      'idempotency-key': key,
      'content-type': 'application/json',
    });
    expect(response.statusCode).toBe(401);
    expect(h.submit).not.toHaveBeenCalled();
    expect(response.body).not.toContain('crisis_unauthenticated');
  });
  it('cannot call the handler through a route missing admission', async () => {
    const response = await request(
      input,
      { 'idempotency-key': key, 'content-type': 'application/json' },
      `/unit-without-admission/${caseId}`,
    );
    expect(response.statusCode).toBe(503);
    expect(h.submit).not.toHaveBeenCalled();
  });
  it('maps consent withdrawal during work to a safe actionable conflict', async () => {
    h.submit.mockRejectedValue(
      Object.assign(new Error('care_consent_required'), { code: 'PT409' }),
    );
    const response = await request(input, {
      'idempotency-key': key,
      'content-type': 'application/json',
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('care.consent_required');
  });
  it.each([
    ['billing_actor_unavailable', '42501', 401],
    ['unrelated_permission_failure', '42501', 403],
    ['billing_actor_unavailable', '55P03', 503],
  ])(
    'maps only a confirmed Billing identity denial to session expiry (%s/%s)',
    async (message, code, status) => {
      h.submit.mockRejectedValue(Object.assign(new Error(message), { code }));
      const response = await request(input, {
        'idempotency-key': key,
        'content-type': 'application/json',
      });
      expect(response.statusCode).toBe(status);
      expect(response.body).not.toContain(message);
    },
  );
  it('enforces the parser admission limit without running business work', async () => {
    const response = await request(
      { text: 'a'.repeat(1_048_577) },
      { 'content-type': 'application/json' },
    );
    expect(response.statusCode).toBe(413);
    expect(h.admit).not.toHaveBeenCalled();
    expect(h.submit).not.toHaveBeenCalled();
  });
});
