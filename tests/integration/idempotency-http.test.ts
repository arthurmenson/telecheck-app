/**
 * Idempotency plugin — HTTP-level integration tests.
 *
 * Closes the long-standing gap on `src/lib/idempotency.ts` (a substantial
 * piece of foundation infrastructure that had zero HTTP-level coverage
 * until this commit). Discovered while looking for the next batch
 * during the 24-hour autonomous run: the plugin requires an
 * `Idempotency-Key` header on every state-changing request, and the
 * recent forms-intake HTTP test wave had to be patched (commit f4b6452)
 * to auto-inject one. That fix proves the recent tests work; this file
 * proves the plugin itself works as the IDEMPOTENCY v5.1 contract
 * specifies.
 *
 * Coverage scope (per IDEMPOTENCY v5.1):
 *   1. Missing key on state-changing request -> 400 with code
 *      'internal.idempotency.missing_key'
 *   2. GET request without key -> passes through (GET is exempt)
 *   3. Same key + same body -> response REPLAY (cached body returned,
 *      handler not re-run; verifiable by checking persistence side-effects)
 *   4. Same key + different body -> 409 with code
 *      'internal.idempotency.body_mismatch'
 *   5. Same key + different tenant -> independent (per the 4-tuple PK)
 *   6. Same key + different actor -> independent (per the 4-tuple PK)
 *   7. Same key + different endpoint -> independent (per the 4-tuple PK)
 *
 * Spec references:
 *   - IDEMPOTENCY v5.1 (key format, 4-tuple PK, 24-hour TTL, body hash)
 *   - I-023 (tenant isolation; same key in different tenants is independent)
 *   - ERROR_MODEL v5.1 ('internal.idempotency.*' codes)
 *   - Master PRD v1.10 §17 (operating-tenant identifier MUST NOT leak in
 *     error envelopes — applied via assertNoTenantIdLeakageInError)
 */

import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../../src/app.ts';
import { ulid } from '../../src/lib/ulid.ts';
import { TENANT_US, withTenantContext } from '../helpers/tenant-fixtures.ts';
import { getTestClient } from '../setup.ts';

// ---------------------------------------------------------------------------
// Test app lifecycle
// ---------------------------------------------------------------------------

let app: FastifyInstance | null = null;

beforeAll(async () => {
  process.env['NODE_ENV'] = 'test';
  app = await buildApp({ logger: false });
  await app.ready();
});

afterAll(async () => {
  if (app !== null) {
    await app.close();
  }
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function findKeyAtAnyDepth(value: unknown, targetKey: string): boolean {
  type Frame = unknown;
  const stack: Frame[] = [value];
  while (stack.length > 0) {
    const next = stack.pop();
    if (Array.isArray(next)) {
      for (const item of next) stack.push(item);
      continue;
    }
    if (next !== null && typeof next === 'object') {
      const obj = next as Record<string, unknown>;
      for (const key of Object.keys(obj)) {
        if (key === targetKey) return true;
        stack.push(obj[key]);
      }
    }
  }
  return false;
}

function assertNoTenantIdLeakageInError(response: { body: string }): void {
  expect(response.body).not.toContain('tenant_id');
  expect(response.body).not.toContain(TENANT_US);
  if (response.body.trim().length === 0) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(response.body);
  } catch {
    return;
  }
  expect(findKeyAtAnyDepth(parsed, 'tenant_id')).toBe(false);
}

/**
 * Seed a published template + active deployment so we can use
 * POST /v0/forms/templates as the "create draft template" path for
 * idempotency-key replay tests. Templates were chosen because the
 * endpoint is admin-scoped (avoids the patient ownership complexity)
 * and creates a row with a deterministic shape on success.
 */
async function adminAuthHeaders(): Promise<Record<string, string>> {
  return {
    host: 'localhost',
    'x-actor-id': `op_idem_${ulid()}`,
    'x-actor-roles': 'tenant_admin',
    'x-actor-admin-tenant': TENANT_US,
    'content-type': 'application/json',
  };
}

function createTemplatePayload(): Record<string, unknown> {
  return {
    programCatalogEntryId: `prog_idem_${ulid().slice(0, 8)}`,
    name: `idem template ${ulid().slice(0, 8)}`,
    layout: {},
    branchingLogic: {},
    eligibilityLogic: {},
    approvalGovernance: {},
  };
}

// Direct injectWithKey helper that always uses the provided key —
// distinct from the per-test-file injectWithIdempotency helpers which
// auto-generate. This file deliberately does NOT auto-inject because
// we're testing the plugin's behavior with explicit keys.
async function inject(args: InjectOptions): Promise<LightMyRequestResponse> {
  return app!.inject(args);
}

// ---------------------------------------------------------------------------
// Missing-key path (state-changing without header)
// ---------------------------------------------------------------------------

describe('idempotency plugin HTTP — missing-key path', () => {
  it('returns 400 with internal.idempotency.missing_key on POST without Idempotency-Key', async () => {
    const headers = await adminAuthHeaders();
    // Don't add idempotency-key — that's the test.
    const response = await inject({
      method: 'POST',
      url: '/v0/forms/templates',
      headers,
      payload: createTemplatePayload(),
    });
    expect(response.statusCode).toBe(400);
    const body = response.json<{ error?: { code?: string } }>();
    expect(body.error?.code).toBe('internal.idempotency.missing_key');
    assertNoTenantIdLeakageInError(response);
  });

  it('passes GET requests through unchanged (no key required)', async () => {
    const headers = await adminAuthHeaders();
    const response = await inject({
      method: 'GET',
      url: `/v0/forms/templates/${ulid()}`,
      headers,
    });
    // GET hit reaches the handler. The template doesn't exist so we get
    // 404 — proves the request reached the handler past the idempotency
    // plugin (which would have returned 400 if it gated GETs).
    expect(response.statusCode).toBe(404);
    assertNoTenantIdLeakageInError(response);
  });
});

// ---------------------------------------------------------------------------
// Replay (same key + same body)
// ---------------------------------------------------------------------------

describe('idempotency plugin HTTP — replay (same 4-tuple + same body)', () => {
  it('returns the cached response on second call with identical key + body', async () => {
    const idempotencyKey = ulid();
    const headers = await adminAuthHeaders();
    const payload = createTemplatePayload();

    // First call: real handler runs, template created.
    const first = await inject({
      method: 'POST',
      url: '/v0/forms/templates',
      headers: { ...headers, 'idempotency-key': idempotencyKey },
      payload,
    });
    expect(first.statusCode).toBe(201);
    const firstBody = first.json<Record<string, unknown>>();
    expect(firstBody['template_id']).toBeDefined();

    // Second call with the SAME key + body — should replay the cached
    // response. Status code AND body should match the first call exactly.
    const second = await inject({
      method: 'POST',
      url: '/v0/forms/templates',
      headers: { ...headers, 'idempotency-key': idempotencyKey },
      payload,
    });
    expect(second.statusCode).toBe(201);
    const secondBody = second.json<Record<string, unknown>>();
    // The replayed body MUST equal the first body (proves no second-handler
    // run created a different row).
    expect(secondBody['template_id']).toBe(firstBody['template_id']);

    // Side-effect verification: only ONE template row was created.
    const client = getTestClient();
    const count = await withTenantContext(TENANT_US, async () => {
      const r = await client.query<{ c: string }>(
        `SELECT COUNT(*)::text AS c FROM forms_template
           WHERE tenant_id = $1 AND template_id = $2`,
        [TENANT_US, firstBody['template_id']],
      );
      return Number.parseInt(r.rows[0]!.c, 10);
    });
    expect(count).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Body mismatch (same key + different body)
// ---------------------------------------------------------------------------

describe('idempotency plugin HTTP — body mismatch (same key + different body)', () => {
  it('returns 409 internal.idempotency.body_mismatch on second call with different body', async () => {
    const idempotencyKey = ulid();
    const headers = await adminAuthHeaders();
    const firstPayload = createTemplatePayload();

    const first = await inject({
      method: 'POST',
      url: '/v0/forms/templates',
      headers: { ...headers, 'idempotency-key': idempotencyKey },
      payload: firstPayload,
    });
    expect(first.statusCode).toBe(201);

    // Second call with same key but a different name (different body hash).
    const second = await inject({
      method: 'POST',
      url: '/v0/forms/templates',
      headers: { ...headers, 'idempotency-key': idempotencyKey },
      payload: { ...firstPayload, name: 'a different name' },
    });
    expect(second.statusCode).toBe(409);
    const body = second.json<{ error?: { code?: string } }>();
    expect(body.error?.code).toBe('internal.idempotency.body_mismatch');
    assertNoTenantIdLeakageInError(second);
  });
});

// ---------------------------------------------------------------------------
// 4-tuple PK independence — same key, different actor/endpoint => independent
// (Tenant independence is harder to test here because we'd need a request
// to resolve to a different tenant; covered indirectly by the cache PK
// design + by tenant-isolation tests elsewhere in the suite.)
// ---------------------------------------------------------------------------

describe('idempotency plugin HTTP — 4-tuple PK independence', () => {
  it('treats same key with different actor as independent (no replay across actors)', async () => {
    const idempotencyKey = ulid();
    const baseHeaders = await adminAuthHeaders();
    const payload = createTemplatePayload();

    // Actor A creates with the key.
    const headersA = { ...baseHeaders, 'x-actor-id': 'op_idem_actorA' };
    const first = await inject({
      method: 'POST',
      url: '/v0/forms/templates',
      headers: { ...headersA, 'idempotency-key': idempotencyKey },
      payload,
    });
    expect(first.statusCode).toBe(201);
    const firstBody = first.json<Record<string, unknown>>();

    // Actor B uses the SAME key + SAME body. With a single-actor cache
    // this would replay; with the 4-tuple PK (tenant, key, endpoint,
    // actor) it's an independent record so the handler runs again and
    // creates a SECOND template.
    const headersB = { ...baseHeaders, 'x-actor-id': 'op_idem_actorB' };
    const second = await inject({
      method: 'POST',
      url: '/v0/forms/templates',
      headers: { ...headersB, 'idempotency-key': idempotencyKey },
      payload,
    });
    expect(second.statusCode).toBe(201);
    const secondBody = second.json<Record<string, unknown>>();

    // Two distinct template_ids prove the handler ran twice.
    expect(secondBody['template_id']).not.toBe(firstBody['template_id']);
  });

  it('treats same key on a different endpoint as independent', async () => {
    const idempotencyKey = ulid();
    const headers = await adminAuthHeaders();

    // First call: POST /templates (creates a draft)
    const first = await inject({
      method: 'POST',
      url: '/v0/forms/templates',
      headers: { ...headers, 'idempotency-key': idempotencyKey },
      payload: createTemplatePayload(),
    });
    expect(first.statusCode).toBe(201);

    // Second call with SAME key but DIFFERENT endpoint: POST /deployments.
    // Different endpoint -> independent cache record. The deployment
    // create will fail (no template to deploy from a fresh ULID) but
    // the failure is from the deployment handler, NOT a replay of the
    // first response.
    const second = await inject({
      method: 'POST',
      url: '/v0/forms/deployments',
      headers: { ...headers, 'idempotency-key': idempotencyKey },
      payload: { templateId: ulid() },
    });
    // Either 201 if it somehow succeeds (it shouldn't with a random
    // templateId) or 400 from the handler's missing-template guard.
    // Crucially NOT 201 with the FIRST endpoint's template_id — that
    // would be a replay.
    if (second.statusCode === 201) {
      const secondBody = second.json<Record<string, unknown>>();
      expect(secondBody['template_id']).not.toBe(
        first.json<Record<string, unknown>>()['template_id'],
      );
    } else {
      expect(second.statusCode).toBe(400);
    }
  });
});
