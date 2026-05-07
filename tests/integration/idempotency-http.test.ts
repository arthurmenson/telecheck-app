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
import { TENANT_GHANA, TENANT_US, withTenantContext } from '../helpers/tenant-fixtures.ts';
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
  // Use .slice(-8) (random portion of the ULID) instead of .slice(0, 8)
  // (timestamp portion). Two ULIDs generated within the same millisecond
  // share the first 10 chars; tests that call createTemplatePayload()
  // twice in fast succession (e.g., the 4-tuple-PK actor independence
  // test) would generate identical programCatalogEntryId values and
  // collide on `uq_template_version`. Codex idem-http-r0 closure
  // 2026-05-04 — same fix pattern as resume-http seedPausedSubmission.
  return {
    programCatalogEntryId: `prog_idem_${ulid().slice(-8)}`,
    name: `idem template ${ulid().slice(-8)}`,
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
    // Discriminate via the request payload, NOT the returned template_id.
    // Codex idempotency-http-r1 closure 2026-05-03: a broken idempotency
    // layer could re-run the handler on the second request, create a
    // SECOND forms_template row with a NEW template_id, and still return
    // the cached first response. A COUNT(*) WHERE template_id = first.id
    // would pass that bug; we need a query that captures BOTH rows if a
    // duplicate exists.
    //
    // Strategy: tag the payload with a unique programCatalogEntryId for
    // this test invocation; after the second call, count ALL forms_template
    // rows in this tenant with that program_id and require exactly one.
    // Any duplicate handler-run would write a second row with the same
    // program_id (the payload uniquely identifies the request shape).
    // Codex idempotency-http-r2 closure 2026-05-03: forms_template.program_id
    // is VARCHAR(26); a longer value would fail the INSERT before the
    // replay logic ran. ULID is 26 chars, so prefix+slice keeps total <= 26.
    const uniqueProgramId = `idem_${ulid().slice(0, 21)}`;
    const payload = { ...createTemplatePayload(), programCatalogEntryId: uniqueProgramId };

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
    expect(secondBody['template_id']).toBe(firstBody['template_id']);

    // Side-effect verification by REQUEST-DERIVED discriminator: count ALL
    // forms_template rows in this tenant with the unique program_id.
    // Exactly one row proves the handler ran exactly once. A duplicate-run
    // bug would surface here even if the cached response replayed cleanly.
    const client = getTestClient();
    const count = await withTenantContext(TENANT_US, async () => {
      const r = await client.query<{ c: string }>(
        `SELECT COUNT(*)::text AS c FROM forms_template
           WHERE tenant_id = $1 AND program_id = $2`,
        [TENANT_US, uniqueProgramId],
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

    // Actor A and Actor B each get a DISTINCT payload (different
    // programCatalogEntryId) so each can succeed at the DB layer —
    // forms_template has a UNIQUE constraint on
    // (tenant_id, program_id, country_of_care, template_version)
    // per FORMS_ENGINE Pattern A. If both actors used the same
    // programCatalogEntryId, the second INSERT would fail with
    // uq_template_version even when the idempotency layer correctly
    // routes through to the handler (the bug we're testing for).
    // Distinct payloads isolate the test to "did the handler run
    // again?" without entangling the DB unique-constraint behavior.
    // Codex idempotency-http-r1 closure 2026-05-04.
    const payloadA = createTemplatePayload();
    const payloadB = createTemplatePayload();

    // Actor A creates with the key.
    const headersA = { ...baseHeaders, 'x-actor-id': 'op_idem_actorA' };
    const first = await inject({
      method: 'POST',
      url: '/v0/forms/templates',
      headers: { ...headersA, 'idempotency-key': idempotencyKey },
      payload: payloadA,
    });
    expect(first.statusCode).toBe(201);
    const firstBody = first.json<Record<string, unknown>>();

    // Actor B uses the SAME key + DIFFERENT body. With a single-actor
    // cache this would 409 (body mismatch); with the 4-tuple PK
    // (tenant, key, endpoint, actor) it's an independent record so
    // the handler runs again and creates a SECOND template.
    const headersB = { ...baseHeaders, 'x-actor-id': 'op_idem_actorB' };
    const second = await inject({
      method: 'POST',
      url: '/v0/forms/templates',
      headers: { ...headersB, 'idempotency-key': idempotencyKey },
      payload: payloadB,
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

  // -------------------------------------------------------------------------
  // Sprint 5 / TLC-013 — closes 2 verified IDEMPOTENCY v5.1 invariant gaps
  // surfaced at PM kickoff:
  //   1. Same key + different TENANT → independent (4-tuple PK tenant case)
  //   2. TTL expiry → treated as first request
  //
  // Prior comment at line 274–278 explicitly deferred the cross-tenant case
  // ("covered indirectly"); this story closes it directly via host-header
  // tenant routing. The TTL case had ZERO test coverage prior; relied on
  // SQL `expires_at > NOW()` behavior implicitly. This locks both surfaces
  // against future regression.
  // -------------------------------------------------------------------------

  it('§NEW (TLC-013) treats same key with different tenant as independent (no replay across tenants — I-023 + 4-tuple PK)', async () => {
    const idempotencyKey = ulid();

    // Each tenant gets a DISTINCT payload (different programCatalogEntryId)
    // so each can succeed at the DB layer — forms_template has a UNIQUE
    // constraint on (tenant_id, program_id, country_of_care, template_version)
    // per FORMS_ENGINE Pattern A. Distinct payloads isolate the test to
    // "did the handler run again?" without entangling the DB unique-
    // constraint behavior. Mirror of the 4-tuple-PK actor independence
    // test pattern (Codex idempotency-http-r1 closure 2026-05-04).
    const payloadUS = createTemplatePayload();
    const payloadGH = createTemplatePayload();

    // Tenant US: POST with the key. Host header `heroshealth.com` resolves
    // to TENANT_US per src/lib/tenant-context.ts hostname mapping.
    const headersUS = {
      ...(await adminAuthHeaders()),
      host: 'heroshealth.com',
      'x-actor-admin-tenant': TENANT_US,
    };
    const first = await inject({
      method: 'POST',
      url: '/v0/forms/templates',
      headers: { ...headersUS, 'idempotency-key': idempotencyKey },
      payload: payloadUS,
    });
    expect(first.statusCode).toBe(201);
    const firstBody = first.json<Record<string, unknown>>();
    expect(firstBody['template_id']).toBeDefined();

    // Tenant Ghana: SAME key + DIFFERENT body via DIFFERENT host header
    // → resolves to TENANT_GHANA. With a single-tenant cache this would
    // 409 (body mismatch); with the 4-tuple PK (tenant, key, endpoint,
    // actor) it's an independent record so the handler runs again and
    // creates a SECOND template.
    const headersGH = {
      ...(await adminAuthHeaders()),
      host: 'ghana.heroshealth.com',
      'x-actor-admin-tenant': TENANT_GHANA,
    };
    const second = await inject({
      method: 'POST',
      url: '/v0/forms/templates',
      headers: { ...headersGH, 'idempotency-key': idempotencyKey },
      payload: payloadGH,
    });
    expect(second.statusCode).toBe(201);
    const secondBody = second.json<Record<string, unknown>>();
    expect(secondBody['template_id']).toBeDefined();

    // Two distinct template_ids prove the handler ran twice (no replay).
    // The 4-tuple PK kept the tenants' records independent at the cache
    // layer; RLS at the data layer kept their template rows independent.
    expect(secondBody['template_id']).not.toBe(firstBody['template_id']);
  });

  it('§NEW (TLC-013) treats expired idempotency key as first request (TTL expiry)', async () => {
    const idempotencyKey = ulid();
    const headers = await adminAuthHeaders();

    // Per Codex idempotency-r5 HIGH finding 2026-05-05: the second request
    // MUST use a DISTINCT payload from the first so the post-TTL retry can
    // succeed cleanly (201 with a new template_id) without colliding with
    // the first row's (tenant_id, program_id, country_of_care,
    // template_version) UNIQUE constraint. The original test accepted any
    // 4xx as "proof TTL works", which would silently pass on unrelated
    // handler-side failures (auth, validation, etc.). With distinct
    // payloads the test has exactly ONE expected outcome — 201 with a
    // different template_id — and can no longer pass for the wrong reason.
    const firstPayload = createTemplatePayload();
    const secondPayload = createTemplatePayload();

    // Step 1: First call creates the cache row + the template row.
    const first = await inject({
      method: 'POST',
      url: '/v0/forms/templates',
      headers: { ...headers, 'idempotency-key': idempotencyKey },
      payload: firstPayload,
    });
    expect(first.statusCode).toBe(201);
    const firstBody = first.json<Record<string, unknown>>();
    expect(firstBody['template_id']).toBeDefined();

    // Step 2: Backdate the cache row's expires_at to 1 hour AGO so the
    // SQL guard `expires_at > NOW()` filters it out on the next lookup.
    // This simulates the 24-hour TTL elapsing without waiting 24 hours.
    const client = getTestClient();
    const updated = await withTenantContext(TENANT_US, async () => {
      const r = await client.query<{ c: string }>(
        `UPDATE idempotency_keys
            SET expires_at = NOW() - INTERVAL '1 hour'
          WHERE tenant_id = $1
            AND key = $2
            AND endpoint = $3
          RETURNING (1)::text AS c`,
        // The plugin canonicalizes endpoint as the path-only normalized URL
        // (idempotency.ts:205,227 — `url.split('?')[0]`). Method is NOT
        // included in the endpoint column. The UPDATE here MUST use the
        // same canonicalization or the WHERE will silently match zero rows
        // (which would let the test pass for the wrong reason).
        [TENANT_US, idempotencyKey, '/v0/forms/templates'],
      );
      return r.rowCount ?? 0;
    });
    // Sanity: the UPDATE must hit exactly one row. If the endpoint string
    // doesn't match what the plugin canonicalizes, the test would silently
    // pass the assertion below for the wrong reason (no row updated → cache
    // never had the entry → second request was always going to be a "first
    // request"). Bail loudly if the seed didn't take.
    expect(updated).toBe(1);

    // Step 3: Second call with the SAME key + DISTINCT payload. The expired
    // cache row should be filtered out by `expires_at > NOW()`; the plugin
    // treats this as a first request and re-runs the handler, creating a
    // SECOND forms_template row.
    //
    // Note on body-mismatch: with the SAME key and a DIFFERENT body, an
    // UNEXPIRED cache row would 409 with internal.idempotency.body_mismatch.
    // We are exploiting that here in our favor: if the cache row had NOT
    // expired, this request would 409 (not 201) — proving the test depends
    // on TTL expiry actually filtering the row. So 201 on the second call
    // is exactly the post-TTL "first request" semantics; 409 would be a
    // failed test (TTL expiry didn't filter).
    const second = await inject({
      method: 'POST',
      url: '/v0/forms/templates',
      headers: { ...headers, 'idempotency-key': idempotencyKey },
      payload: secondPayload,
    });

    // Exactly one expected outcome: 201 with a NEW template_id. Codex
    // idempotency-r5 HIGH closure 2026-05-05.
    expect(second.statusCode).toBe(201);
    const secondBody = second.json<Record<string, unknown>>();
    expect(secondBody['template_id']).toBeDefined();
    expect(secondBody['template_id']).not.toBe(firstBody['template_id']);
  });

  // -------------------------------------------------------------------------
  // Sprint 26 / TLC-048 — Codex retrospective HIGH finding closure.
  //
  // Background: the existing actor-independence test at line 282 uses
  // `x-actor-id` headers (legacy stub path). Sprint 21+ migrated tests
  // from `x-actor-id` to JWT bearer tokens for authenticated endpoints,
  // but `src/lib/idempotency.ts:226` still read from the header and fell
  // back to `'anonymous'` when absent. After the migration, ALL JWT-
  // authenticated requests bucketed as `actor_id='anonymous'` —
  // collapsing per-actor isolation.
  //
  // This test pins the JWT-actor-scoping fix: after `idempotency.ts`
  // reads from `request.actorContext?.accountId`, two distinct JWT-
  // authenticated patients in the same tenant using the same
  // Idempotency-Key on the same endpoint MUST be treated as independent
  // cache records — neither false 409 (different bodies) nor cross-actor
  // replay (same body).
  //
  // Endpoint choice: POST /v0/async-consult/:id/abandon. Both patients
  // probe a non-existent consult ID, so the service throws
  // ConsultNotFoundError → 404 via mapServiceError. The 404 response
  // gets cached. The TEST shape: two distinct ULIDs → two distinct
  // 404 responses → idempotency_keys table has TWO rows (one per
  // actor) with distinct actor_id values matching the JWT account_id
  // (NOT 'anonymous'). If the bug were still present, both rows would
  // share actor_id='anonymous' and one would have body-mismatch-409'd
  // the other — neither happens with the fix.
  // -------------------------------------------------------------------------
  it('§NEW (TLC-048) JWT-authenticated actors do not collapse to anonymous in idempotency cache', async () => {
    // Lazy-import to avoid hoisting interference; same shape as
    // async-consult-cross-tenant-isolation.test.ts mintTokenForAccount.
    const { issueAccessToken } = await import('../../src/lib/jwt.ts');
    const { config } = await import('../../src/lib/config.ts');
    const { asAccountId } = await import('../../src/modules/identity/internal/types.ts');

    const idempotencyKey = ulid();
    const accountIdA = asAccountId(`acct_${ulid()}`);
    const accountIdB = asAccountId(`acct_${ulid()}`);

    const { asTenantId } = await import('../../src/lib/glossary.ts');
    const tenantUS = asTenantId(TENANT_US);

    const tokenA = issueAccessToken(
      {
        account_id: accountIdA,
        tenant_id: tenantUS,
        session_id: ulid(),
        country_of_care: 'US',
      },
      config.jwtSigningKey,
    );
    const tokenB = issueAccessToken(
      {
        account_id: accountIdB,
        tenant_id: tenantUS,
        session_id: ulid(),
        country_of_care: 'US',
      },
      config.jwtSigningKey,
    );

    // PR-B Sprint 32 update: previously this test used POST /:id/abandon
    // with non-existent IDs to trigger a 404 cached response. After PR-B
    // migrated async-consult handlers to withIdempotency, failed requests
    // (404 from ConsultNotFoundError) roll back their reservation rather
    // than persisting it — the new contract is "exactly-once for SUCCESSFUL
    // requests." So we re-target this test at the SUCCESS path: POST
    // /v0/async-consult (initiate) with each JWT's own account_id.
    //
    // The cross-actor invariant being pinned is unchanged: two distinct
    // JWT actors in the same tenant + same Idempotency-Key MUST be
    // isolated in the 4-tuple cache (different actor_id values; neither
    // 'anonymous'). With initiate, both requests succeed (201 with each
    // patient's own consult), and both cache rows have distinct
    // accountId-derived actor_ids.

    const respA = await inject({
      method: 'POST',
      url: '/v0/async-consult',
      headers: {
        host: 'heroshealth.com',
        authorization: `Bearer ${tokenA}`,
        'idempotency-key': idempotencyKey,
        'content-type': 'application/json',
      },
      payload: {
        account_id: accountIdA,
        consult_type: 'general',
        modality: 'async',
      },
    });
    expect(respA.statusCode).toBe(201);

    const respB = await inject({
      method: 'POST',
      url: '/v0/async-consult',
      headers: {
        host: 'heroshealth.com',
        authorization: `Bearer ${tokenB}`,
        'idempotency-key': idempotencyKey,
        'content-type': 'application/json',
      },
      payload: {
        account_id: accountIdB,
        consult_type: 'general',
        modality: 'async',
      },
    });
    // CRITICAL: actor B MUST get 201 (handler ran for actor B), NOT 409
    // body-mismatch. A 409 body-mismatch would prove actor A and actor B
    // share the 'anonymous' bucket — the original TLC-048 bug.
    expect(respB.statusCode).toBe(201);

    // Direct cache-table inspection: two records exist for the same
    // (tenant_id, key, endpoint) with distinct actor_ids matching the
    // JWT account_id values — NOT 'anonymous'.
    const client = getTestClient();
    await withTenantContext(TENANT_US, async () => {
      const result = await client.query<{ actor_id: string; response_status: number }>(
        `SELECT actor_id, response_status
           FROM idempotency_keys
          WHERE tenant_id = $1
            AND key = $2
            AND endpoint = '/v0/async-consult'
          ORDER BY actor_id`,
        [TENANT_US, idempotencyKey],
      );
      const actorIds = result.rows.map((r) => r.actor_id);
      // Two rows = per-actor independence held.
      expect(actorIds).toHaveLength(2);
      // Neither row collapsed to 'anonymous' — JWT actorContext was read.
      expect(actorIds).not.toContain('anonymous');
      // Each row's actor_id matches the corresponding JWT's accountId.
      expect(actorIds.sort()).toEqual([accountIdA, accountIdB].sort());
      // Both rows cached the success status (201, not the v0 200 default).
      expect(result.rows.every((r) => r.response_status === 201)).toBe(true);
    });
  });
});
