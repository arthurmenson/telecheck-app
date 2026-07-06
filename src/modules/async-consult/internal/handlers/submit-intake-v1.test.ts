/**
 * submit-intake-v1.test.ts — unit tests for
 * POST /v1/async-consults/:consult_id/intake.
 *
 * Verifies: guard precedence (401/403/delegate 403/400 including partial
 * KMS envelope), canonical composition, 18-param wrapper call with
 * decoded envelope Buffers, same-tx Cat C async_consult.intake_submitted
 * emission, 42501 → 403, and the mapServiceError contract for the
 * 23514 state guard (asserted via the mapper the handler passes to
 * withIdempotentExecution).
 */

import type { FastifyReply, FastifyRequest } from 'fastify';
import { describe, expect, it, vi, beforeEach } from 'vitest';

import { submitIntakeV1Handler } from './submit-intake-v1.js';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const wrapperCalls: string[] = [];
const recordedQueries: { sql: string; params: unknown[] | undefined }[] = [];
const auditCalls: { fn: string; args: unknown }[] = [];
/** The mapServiceError fn the handler passed to withIdempotentExecution. */
let capturedMapServiceError:
  | ((err: unknown, reply: FastifyReply, reqId: string) => boolean)
  | null = null;

let queryResponder: (
  sql: string,
  params?: unknown[],
) => Promise<{ rows: unknown[]; rowCount: number | null }> = async () => ({
  rows: [],
  rowCount: 1,
});

const mockTx = {
  query: vi.fn(async (sql: string, params?: unknown[]) => {
    recordedQueries.push({ sql, params });
    return queryResponder(sql, params);
  }),
};

vi.mock('../../../../lib/idempotent-handler.js', () => ({
  withIdempotentExecution: vi.fn(
    async (
      _req: unknown,
      reply: { code: (n: number) => { send: (b: unknown) => unknown } },
      mapServiceError: (err: unknown, reply: FastifyReply, reqId: string) => boolean,
      body: (tx: unknown, ctx: unknown) => Promise<{ status: number; view: unknown }>,
    ) => {
      capturedMapServiceError = mapServiceError;
      wrapperCalls.push('withIdempotentExecution:start');
      const result = await body(mockTx, { tenantId: 'Telecheck-US' });
      wrapperCalls.push('withIdempotentExecution:end');
      return reply.code(result.status).send(result.view);
    },
  ),
}));

vi.mock('../../../../lib/rls.js', () => ({
  withTenantContext: vi.fn(async (_tx: unknown, tenantId: string, fn: () => Promise<unknown>) => {
    wrapperCalls.push(`withTenantContext:${tenantId}`);
    return fn();
  }),
}));

vi.mock('../../../../lib/actor-context-binding.js', () => ({
  withActorContext: vi.fn(async (_tx: unknown, nonce: string, fn: () => Promise<unknown>) => {
    wrapperCalls.push(`withActorContext:${nonce}`);
    return fn();
  }),
}));

vi.mock('../../../../lib/with-db-role.js', () => ({
  withDbRole: vi.fn(async (_tx: unknown, role: string, fn: () => Promise<unknown>) => {
    wrapperCalls.push(`withDbRole:${role}`);
    return fn();
  }),
}));

vi.mock('../../../../lib/tenant-context.js', () => ({
  requireTenantContext: vi.fn(() => ({
    tenantId: 'Telecheck-US',
    countryOfCare: 'US' as const,
  })),
}));

vi.mock('../../../../lib/auth-context.js', () => ({
  requirePatientActorContext: vi.fn((req: { actorContext?: { role?: string } }) => {
    const actor = req.actorContext;
    if (actor === undefined) {
      const e = new Error('Authentication is required.') as Error & { statusCode: number };
      e.statusCode = 401;
      throw e;
    }
    if (actor.role !== 'patient') {
      const e = new Error('This endpoint requires role=patient.') as Error & {
        statusCode: number;
      };
      e.statusCode = 403;
      throw e;
    }
    return actor;
  }),
  resolveActorTenantIdForAudit: vi.fn(() => 'Telecheck-US'),
}));

let ulidCounter = 0;
vi.mock('../../../../lib/ulid.js', () => ({
  ulid: vi.fn(() => `01HFG6Z3Q8B7H9P2W4V5K6N7T${(ulidCounter++ % 10).toString()}`),
}));

vi.mock('../../audit.js', () => ({
  emitAsyncConsultIntakeSubmittedAudit: vi.fn(async (args: unknown, _tx: unknown) => {
    auditCalls.push({ fn: 'emitAsyncConsultIntakeSubmittedAudit', args });
    return { audit_id: 'aud_test' };
  }),
}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PATIENT_ULID = '01HFG6Z3Q8B7H9P2W4V5K6N7TB';
const CONSULT_ULID = '01HFG6Z3Q8B7H9P2W4V5K6N7TD';
const TEMPLATE_ULID = '01HFG6Z3Q8B7H9P2W4V5K6N7TE';
const DEK_ULID = '01HFG6Z3Q8B7H9P2W4V5K6N7TF';

function makeEnvelope(): Record<string, unknown> {
  return {
    ciphertext_b64: Buffer.from('sealed-intake-payload').toString('base64'),
    dek_id: DEK_ULID,
    iv_b64: Buffer.from('0123456789ab').toString('base64'),
    tag_b64: Buffer.from('0123456789abcdef').toString('base64'),
    alg: 'AES-256-GCM',
    alg_version: '1',
    aad_b64: Buffer.from('tenant:Telecheck-US').toString('base64'),
    encrypted_at: '2026-07-06T00:00:00.000Z',
  };
}

function makeValidBody(): Record<string, unknown> {
  return {
    template_id: TEMPLATE_ULID,
    template_version: '3',
    intake_payload_envelope: makeEnvelope(),
  };
}

function makeReq(opts?: {
  body?: unknown;
  consultId?: string;
  actor?: { role: string; delegateId?: string | null } | null;
  actorNonce?: string;
}): FastifyRequest {
  const actorSpec = opts?.actor === undefined ? { role: 'patient', delegateId: null } : opts.actor;
  return {
    id: 'req_test',
    body: opts?.body ?? makeValidBody(),
    params: { consult_id: opts?.consultId ?? CONSULT_ULID },
    headers: {},
    actorContext:
      actorSpec === null
        ? undefined
        : {
            accountId: PATIENT_ULID,
            sessionId: 'sess_test',
            tenantId: 'Telecheck-US',
            role: actorSpec.role,
            countryOfCare: 'US',
            delegateId: actorSpec.delegateId ?? null,
            adminTenantBinding: null,
            adminHomeTenantId: null,
          },
    actorNonce: opts?.actorNonce,
    server: {
      httpErrors: {
        forbidden: (msg: string) => {
          const e = new Error(msg) as Error & { statusCode: number };
          e.statusCode = 403;
          return e;
        },
      },
    },
  } as unknown as FastifyRequest;
}

function makeReply(): { reply: FastifyReply; sent: { code?: number; body?: unknown } } {
  const sent: { code?: number; body?: unknown } = {};
  const reply = {
    code: (n: number) => {
      sent.code = n;
      return reply;
    },
    send: (body: unknown) => {
      sent.body = body;
      return reply;
    },
  } as unknown as FastifyReply;
  return { reply, sent };
}

beforeEach(() => {
  wrapperCalls.length = 0;
  recordedQueries.length = 0;
  auditCalls.length = 0;
  ulidCounter = 0;
  capturedMapServiceError = null;
  queryResponder = async () => ({ rows: [], rowCount: 1 });
});

// ===========================================================================
// §1 — Guard precedence + envelope validation
// ===========================================================================

describe('submitIntakeV1Handler §1 — guards + validation', () => {
  it('rejects 401 when unauthenticated', async () => {
    const req = makeReq({ actor: null });
    const { reply } = makeReply();
    await expect(submitIntakeV1Handler(req, reply)).rejects.toMatchObject({ statusCode: 401 });
  });

  it('rejects 403 for a clinician actor', async () => {
    const req = makeReq({ actor: { role: 'clinician' } });
    const { reply } = makeReply();
    await expect(submitIntakeV1Handler(req, reply)).rejects.toMatchObject({ statusCode: 403 });
  });

  it('rejects 403 when the patient actor carries delegate context', async () => {
    const req = makeReq({ actor: { role: 'patient', delegateId: TEMPLATE_ULID } });
    const { reply } = makeReply();
    await expect(submitIntakeV1Handler(req, reply)).rejects.toMatchObject({ statusCode: 403 });
  });

  it('rejects 400 on a malformed consult_id path param', async () => {
    const req = makeReq({ consultId: 'not-a-ulid' });
    const { reply, sent } = makeReply();
    await submitIntakeV1Handler(req, reply);
    expect(sent.code).toBe(400);
  });

  it('rejects 400 when the KMS envelope is missing a field (partial envelope)', async () => {
    const envelope = makeEnvelope();
    delete envelope['tag_b64'];
    const req = makeReq({ body: { ...makeValidBody(), intake_payload_envelope: envelope } });
    const { reply, sent } = makeReply();
    await submitIntakeV1Handler(req, reply);
    expect(sent.code).toBe(400);
  });

  it('rejects 400 when a BYTEA envelope field is not valid base64', async () => {
    const envelope = { ...makeEnvelope(), ciphertext_b64: '%%%not-base64%%%' };
    const req = makeReq({ body: { ...makeValidBody(), intake_payload_envelope: envelope } });
    const { reply, sent } = makeReply();
    await submitIntakeV1Handler(req, reply);
    expect(sent.code).toBe(400);
  });
});

// ===========================================================================
// §2 — Composition + wrapper call + audit
// ===========================================================================

describe('submitIntakeV1Handler §2 — composition + wrapper + audit', () => {
  it('threads the canonical composition with withDbRole(async_consult_patient_initiator)', async () => {
    const req = makeReq({ actorNonce: 'nonce-1' });
    const { reply } = makeReply();
    await submitIntakeV1Handler(req, reply);
    expect(wrapperCalls).toEqual([
      'withIdempotentExecution:start',
      'withTenantContext:Telecheck-US',
      'withActorContext:nonce-1',
      'withDbRole:async_consult_patient_initiator',
      'withIdempotentExecution:end',
    ]);
  });

  it('calls record_consult_intake_submission with 18 params + decoded Buffers', async () => {
    const req = makeReq();
    const { reply } = makeReply();
    await submitIntakeV1Handler(req, reply);

    expect(recordedQueries).toHaveLength(1);
    const { sql, params } = recordedQueries[0]!;
    expect(sql).toContain('record_consult_intake_submission');
    expect(params).toHaveLength(18);
    expect(params?.[1]).toBe('Telecheck-US');
    expect(params?.[2]).toBe(CONSULT_ULID);
    expect(params?.[3]).toBe(PATIENT_ULID); // trust-anchor patient
    expect(Buffer.isBuffer(params?.[6])).toBe(true); // ciphertext
    expect((params?.[6] as Buffer).toString('utf8')).toBe('sealed-intake-payload');
    expect(params?.[7]).toBe(DEK_ULID);
    expect(params?.[17]).toBe('patient'); // p_actor_role
  });

  it('emits EXACTLY ONE audit event: async_consult.intake_submitted', async () => {
    const req = makeReq();
    const { reply } = makeReply();
    await submitIntakeV1Handler(req, reply);
    expect(auditCalls.map((c) => c.fn)).toEqual(['emitAsyncConsultIntakeSubmittedAudit']);
    const args = auditCalls[0]!.args as Record<string, unknown>;
    expect(args['consultId']).toBe(CONSULT_ULID);
    expect(args['templateId']).toBe(TEMPLATE_ULID);
  });

  it('returns 201 with { submission_id }', async () => {
    const req = makeReq();
    const { reply, sent } = makeReply();
    await submitIntakeV1Handler(req, reply);
    expect(sent.code).toBe(201);
    expect(typeof (sent.body as Record<string, unknown>)['submission_id']).toBe('string');
  });
});

// ===========================================================================
// §3 — Error mapping
// ===========================================================================

describe('submitIntakeV1Handler §3 — error mapping', () => {
  it('maps 42501 to a tenant-blind 403', async () => {
    queryResponder = async () => {
      const err = new Error('tenant scope mismatch') as Error & { code: string };
      err.code = '42501';
      throw err;
    };
    const req = makeReq();
    const { reply } = makeReply();
    await expect(submitIntakeV1Handler(req, reply)).rejects.toMatchObject({
      statusCode: 403,
      message: 'Insufficient scope for this request.',
    });
  });

  it('mapServiceError maps the 23514 state guard to a tenant-blind 409', async () => {
    const req = makeReq();
    const { reply } = makeReply();
    await submitIntakeV1Handler(req, reply);
    expect(capturedMapServiceError).not.toBeNull();

    const { reply: mapReply, sent } = makeReply();
    const err = new Error('consult not in an intake-capable state') as Error & { code: string };
    err.code = '23514';
    const mapped = capturedMapServiceError!(err, mapReply, 'req_test');
    expect(mapped).toBe(true);
    expect(sent.code).toBe(409);
    const body = sent.body as { error: { message: string } };
    expect(body.error.message).toBe('Consult is not in an intake-capable state.');
  });

  it('mapServiceError leaves unknown SQLSTATEs unmapped (propagate to global envelope)', async () => {
    const req = makeReq();
    const { reply } = makeReply();
    await submitIntakeV1Handler(req, reply);
    const { reply: mapReply } = makeReply();
    const err = new Error('deadlock detected') as Error & { code: string };
    err.code = '40P01';
    expect(capturedMapServiceError!(err, mapReply, 'req_test')).toBe(false);
  });
});
