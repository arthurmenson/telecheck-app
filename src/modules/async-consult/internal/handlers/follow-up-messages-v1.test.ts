/**
 * follow-up-messages-v1.test.ts — unit tests for
 * POST + GET /v1/async-consults/:consult_id/follow-up-messages.
 *
 * Verifies: Layer B caller-class gates (401/403 incl. admin fail-closed
 * on GET + delegate fail-closed on POST), patient self-scoping (pinned
 * patient_id on POST; WHERE patient_id = actor on GET), clinician
 * patient_id requirement, direct-INSERT composition under the sender's
 * slice role, same-tx Cat C follow_up_message_sent emission, envelope
 * round-trip on GET, 23503 → 409 and 42501 → 403 mapping.
 */

import type { FastifyReply, FastifyRequest } from 'fastify';
import { describe, expect, it, vi, beforeEach } from 'vitest';

import {
  listFollowUpMessagesV1Handler,
  sendFollowUpMessageV1Handler,
} from './follow-up-messages-v1.js';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const wrapperCalls: string[] = [];
const recordedQueries: { sql: string; params: unknown[] | undefined }[] = [];
const auditCalls: { fn: string; args: unknown }[] = [];
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

vi.mock('../../../../lib/db.js', () => ({
  withTransaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
    wrapperCalls.push('withTransaction');
    return fn(mockTx);
  }),
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
  // Defined inline — vi.mock factories are hoisted above top-level
  // declarations, so referencing an outer class here would throw
  // "Cannot access before initialization".
  UnauthorizedRoleError: class extends Error {
    statusCode = 403;
    constructor(_required: unknown, observed: string) {
      super(`role mismatch: ${observed}`);
    }
  },
  requireActorContext: vi.fn((req: { actorContext?: { role?: string } }) => {
    const actor = req.actorContext;
    if (actor === undefined) {
      const e = new Error('Authentication is required.') as Error & { statusCode: number };
      e.statusCode = 401;
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
  emitAsyncConsultFollowUpMessageSentAudit: vi.fn(async (args: unknown, _tx: unknown) => {
    auditCalls.push({ fn: 'emitAsyncConsultFollowUpMessageSentAudit', args });
    return { audit_id: 'aud_test' };
  }),
}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PATIENT_ULID = '01HFG6Z3Q8B7H9P2W4V5K6N7TB';
const CLINICIAN_ULID = '01HFG6Z3Q8B7H9P2W4V5K6N7TC';
const CONSULT_ULID = '01HFG6Z3Q8B7H9P2W4V5K6N7TD';
const DEK_ULID = '01HFG6Z3Q8B7H9P2W4V5K6N7TF';

function makeEnvelope(): Record<string, unknown> {
  return {
    ciphertext_b64: Buffer.from('sealed-follow-up-message').toString('base64'),
    dek_id: DEK_ULID,
    iv_b64: Buffer.from('0123456789ab').toString('base64'),
    tag_b64: Buffer.from('0123456789abcdef').toString('base64'),
    alg: 'AES-256-GCM',
    alg_version: '1',
    aad_b64: Buffer.from('tenant:Telecheck-US').toString('base64'),
    encrypted_at: '2026-07-08T00:00:00.000Z',
  };
}

function makeReq(opts?: {
  body?: unknown;
  consultId?: string;
  actor?: { role: string; accountId?: string; delegateId?: string | null } | null;
  actorNonce?: string;
  query?: Record<string, string>;
}): FastifyRequest {
  const actorSpec =
    opts?.actor === undefined
      ? { role: 'patient', accountId: PATIENT_ULID, delegateId: null }
      : opts.actor;
  return {
    id: 'req_test',
    body: opts?.body ?? { message_envelope: makeEnvelope() },
    params: { consult_id: opts?.consultId ?? CONSULT_ULID },
    query: opts?.query ?? {},
    headers: {},
    actorContext:
      actorSpec === null
        ? undefined
        : {
            accountId: actorSpec.accountId ?? PATIENT_ULID,
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

function makeDbRow(): Record<string, unknown> {
  return {
    id: '01HFG6Z3Q8B7H9P2W4V5K6N7T9',
    sender_role: 'clinician',
    sender_account_id: CLINICIAN_ULID,
    message_ciphertext: Buffer.from('sealed-follow-up-message'),
    message_kms_envelope_dek_id: DEK_ULID,
    message_kms_envelope_iv: Buffer.from('0123456789ab'),
    message_kms_envelope_tag: Buffer.from('0123456789abcdef'),
    message_kms_envelope_alg: 'AES-256-GCM',
    message_kms_envelope_alg_version: '1',
    message_kms_envelope_aad: Buffer.from('tenant:Telecheck-US'),
    message_kms_envelope_encrypted_at: '2026-07-08T00:00:00.000Z',
    sent_at: '2026-07-08T00:01:00.000Z',
  };
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
// §1 — POST guards + validation
// ===========================================================================

describe('sendFollowUpMessageV1Handler §1 — guards + validation', () => {
  it('rejects 401 when unauthenticated', async () => {
    const req = makeReq({ actor: null });
    const { reply } = makeReply();
    await expect(sendFollowUpMessageV1Handler(req, reply)).rejects.toMatchObject({
      statusCode: 401,
    });
  });

  it('rejects 403 for an ai_service actor', async () => {
    const req = makeReq({ actor: { role: 'ai_service' } });
    const { reply } = makeReply();
    await expect(sendFollowUpMessageV1Handler(req, reply)).rejects.toMatchObject({
      statusCode: 403,
    });
  });

  it('rejects 403 for a tenant_admin actor', async () => {
    const req = makeReq({ actor: { role: 'tenant_admin' } });
    const { reply } = makeReply();
    await expect(sendFollowUpMessageV1Handler(req, reply)).rejects.toMatchObject({
      statusCode: 403,
    });
  });

  it('rejects 403 when the patient actor carries delegate context', async () => {
    const req = makeReq({ actor: { role: 'patient', delegateId: CONSULT_ULID } });
    const { reply } = makeReply();
    await expect(sendFollowUpMessageV1Handler(req, reply)).rejects.toMatchObject({
      statusCode: 403,
    });
  });

  it('rejects 400 on a malformed consult_id path param', async () => {
    const req = makeReq({ consultId: 'nope' });
    const { reply, sent } = makeReply();
    await sendFollowUpMessageV1Handler(req, reply);
    expect(sent.code).toBe(400);
  });

  it('rejects 400 when a patient supplies a foreign patient_id', async () => {
    const req = makeReq({
      body: { patient_id: CLINICIAN_ULID, message_envelope: makeEnvelope() },
    });
    const { reply, sent } = makeReply();
    await sendFollowUpMessageV1Handler(req, reply);
    expect(sent.code).toBe(400);
  });

  it('rejects 400 when a clinician omits patient_id', async () => {
    const req = makeReq({
      actor: { role: 'clinician', accountId: CLINICIAN_ULID },
      body: { message_envelope: makeEnvelope() },
    });
    const { reply, sent } = makeReply();
    await sendFollowUpMessageV1Handler(req, reply);
    expect(sent.code).toBe(400);
  });

  it('rejects 400 on a partial KMS envelope', async () => {
    const envelope = makeEnvelope();
    delete envelope['iv_b64'];
    const req = makeReq({ body: { message_envelope: envelope } });
    const { reply, sent } = makeReply();
    await sendFollowUpMessageV1Handler(req, reply);
    expect(sent.code).toBe(400);
  });
});

// ===========================================================================
// §2 — POST composition + INSERT + audit
// ===========================================================================

describe('sendFollowUpMessageV1Handler §2 — composition + INSERT + audit', () => {
  it('patient send: pins patient_id to the actor + uses the patient slice role', async () => {
    const req = makeReq({ actorNonce: 'nonce-1' });
    const { reply, sent } = makeReply();
    await sendFollowUpMessageV1Handler(req, reply);
    expect(sent.code).toBe(201);
    expect(wrapperCalls).toEqual([
      'withIdempotentExecution:start',
      'withTenantContext:Telecheck-US',
      'withActorContext:nonce-1',
      'withDbRole:async_consult_patient_initiator',
      'withIdempotentExecution:end',
    ]);
    const { sql, params } = recordedQueries[0]!;
    expect(sql).toContain('INSERT INTO consult_follow_up_message');
    expect(params?.[3]).toBe(PATIENT_ULID); // patient_id pinned to actor
    expect(params?.[4]).toBe('patient'); // sender_role
    expect(params?.[5]).toBe(PATIENT_ULID); // sender_account_id = actor
  });

  it('clinician send: requires body patient_id + uses the clinician slice role', async () => {
    const req = makeReq({
      actor: { role: 'clinician', accountId: CLINICIAN_ULID },
      body: { patient_id: PATIENT_ULID, message_envelope: makeEnvelope() },
    });
    const { reply, sent } = makeReply();
    await sendFollowUpMessageV1Handler(req, reply);
    expect(sent.code).toBe(201);
    expect(wrapperCalls).toContain('withDbRole:async_consult_clinician_reviewer');
    const { params } = recordedQueries[0]!;
    expect(params?.[3]).toBe(PATIENT_ULID);
    expect(params?.[4]).toBe('clinician');
    expect(params?.[5]).toBe(CLINICIAN_ULID);
  });

  it('emits EXACTLY ONE Cat C follow_up_message_sent audit same-tx', async () => {
    const req = makeReq();
    const { reply } = makeReply();
    await sendFollowUpMessageV1Handler(req, reply);
    expect(auditCalls.map((c) => c.fn)).toEqual(['emitAsyncConsultFollowUpMessageSentAudit']);
    const args = auditCalls[0]!.args as Record<string, unknown>;
    expect(args['consultId']).toBe(CONSULT_ULID);
    expect(args['senderRole']).toBe('patient');
  });

  it('maps 23503 composite-FK mismatch to a tenant-blind 409', async () => {
    const req = makeReq();
    const { reply } = makeReply();
    await sendFollowUpMessageV1Handler(req, reply);
    const { reply: mapReply, sent } = makeReply();
    const err = new Error('fk violation') as Error & { code: string };
    err.code = '23503';
    expect(capturedMapServiceError!(err, mapReply, 'req_test')).toBe(true);
    expect(sent.code).toBe(409);
  });

  it('maps 42501 to a tenant-blind 403', async () => {
    queryResponder = async () => {
      const err = new Error('permission denied') as Error & { code: string };
      err.code = '42501';
      throw err;
    };
    const req = makeReq();
    const { reply } = makeReply();
    await expect(sendFollowUpMessageV1Handler(req, reply)).rejects.toMatchObject({
      statusCode: 403,
    });
  });
});

// ===========================================================================
// §3 — GET guards + read composition
// ===========================================================================

describe('listFollowUpMessagesV1Handler §3 — guards + read', () => {
  it('rejects 401 when unauthenticated', async () => {
    const req = makeReq({ actor: null });
    const { reply } = makeReply();
    await expect(listFollowUpMessagesV1Handler(req, reply)).rejects.toMatchObject({
      statusCode: 401,
    });
  });

  it('rejects 403 for admin callers (ratified caller class; SELECT grant not ratified)', async () => {
    const req = makeReq({ actor: { role: 'tenant_admin' } });
    const { reply } = makeReply();
    await expect(listFollowUpMessagesV1Handler(req, reply)).rejects.toMatchObject({
      statusCode: 403,
    });
  });

  it('rejects 400 on invalid pagination', async () => {
    const req = makeReq({ query: { limit: '0' } });
    const { reply, sent } = makeReply();
    await listFollowUpMessagesV1Handler(req, reply);
    expect(sent.code).toBe(400);
  });

  it('patient read: self-scopes WHERE patient_id = actor under the patient slice role', async () => {
    queryResponder = async () => ({ rows: [makeDbRow()], rowCount: 1 });
    const req = makeReq({ actorNonce: 'nonce-2' });
    const { reply, sent } = makeReply();
    await listFollowUpMessagesV1Handler(req, reply);
    expect(sent.code).toBe(200);
    expect(wrapperCalls).toContain('withDbRole:async_consult_patient_initiator');
    const { sql, params } = recordedQueries[0]!;
    expect(sql).toContain('AND patient_id = $3');
    expect(params?.[2]).toBe(PATIENT_ULID);
  });

  it('clinician read: tenant-wide (no patient self-scope) under the clinician slice role', async () => {
    queryResponder = async () => ({ rows: [makeDbRow()], rowCount: 1 });
    const req = makeReq({ actor: { role: 'clinician', accountId: CLINICIAN_ULID } });
    const { reply, sent } = makeReply();
    await listFollowUpMessagesV1Handler(req, reply);
    expect(sent.code).toBe(200);
    expect(wrapperCalls).toContain('withDbRole:async_consult_clinician_reviewer');
    const { sql } = recordedQueries[0]!;
    expect(sql).not.toContain('AND patient_id =');
  });

  it('round-trips the KMS envelope BYTEA fields to base64 wire shape', async () => {
    queryResponder = async () => ({ rows: [makeDbRow()], rowCount: 1 });
    const req = makeReq({ actor: { role: 'clinician', accountId: CLINICIAN_ULID } });
    const { reply, sent } = makeReply();
    await listFollowUpMessagesV1Handler(req, reply);
    const body = sent.body as {
      rows: { message_id: string; message_envelope: { ciphertext_b64: string } }[];
    };
    expect(body.rows).toHaveLength(1);
    expect(Buffer.from(body.rows[0]!.message_envelope.ciphertext_b64, 'base64').toString()).toBe(
      'sealed-follow-up-message',
    );
  });
});
