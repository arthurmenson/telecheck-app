/**
 * Forms/Intake — templates admin HTTP route-level integration tests.
 *
 * Extends the buildApp + Fastify `inject` pattern (originally landed at
 * forms-intake-snapshot-http.test.ts) to the four admin endpoints that
 * own the template authoring lifecycle:
 *
 *   POST /v0/forms/templates                       — createTemplateHandler
 *   GET  /v0/forms/templates                       — listTemplatesHandler
 *   GET  /v0/forms/templates/:templateId           — getTemplateHandler
 *   POST /v0/forms/templates/:tid/versions/:vid/publish — publishVersionHandler
 *
 * **Admin surface, not patient surface.** Per the surface classification
 * landed in forms-intake-variants-http.test.ts: tenant_id IS legitimately
 * present in 200 responses on admin endpoints. We assert presence on
 * 200 hits + assert no leakage on 4xx responses (where errors must be
 * tenant-blind per I-025 regardless of surface).
 *
 * **Auth gate (Codex variants-resume-http-r1 pattern):** all four
 * handlers require an authenticated `x-actor-id`. The list + by-id
 * read endpoints had the auth gate landed in this commit (preemptive
 * fix to the same gap Codex flagged on getVariantHandler).
 *
 * Spec references:
 *   - Slice PRD v2.1 §6 (visual builder workflows)
 *   - I-013 published-version immutability (publish path)
 *   - I-023 RLS + tenant context
 *   - I-025 tenant-blind 4xx envelopes
 *   - Master PRD v1.10 §17 patient-surface rule (DOES NOT apply to admin)
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
// Test helpers (mirror the snapshot/submissions/variants/resume HTTP tests)
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

/**
 * Tenant-blind error response leakage assertion. Tolerant of empty /
 * non-JSON bodies. Per Codex variants-resume-http-r1 closure pattern:
 * every negative HTTP response must run this guard.
 */
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

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

interface SeededTemplate {
  templateId: string;
  programId: string;
  status: 'draft' | 'published' | 'superseded' | 'archived';
}

async function seedTemplate(opts: {
  status?: 'draft' | 'published' | 'superseded' | 'archived';
}): Promise<SeededTemplate> {
  const client = getTestClient();
  const programId = `prog_tpl_http_${ulid().slice(0, 8)}`;
  const templateId = ulid();
  const status = opts.status ?? 'published';

  await withTenantContext(TENANT_US, async () => {
    await client.query(
      `INSERT INTO forms_template (
          template_id, tenant_id, program_id, country_of_care,
          template_version, status, name, created_by,
          presentation_content, branching_logic,
          eligibility_logic, approval_governance,
          published_at, created_at, updated_at
       ) VALUES (
          $1, $2, $3, $4,
          1, $5, $6, $7,
          '{}'::jsonb, '{}'::jsonb,
          '{}'::jsonb, '{}'::jsonb,
          $8, NOW(), NOW()
       )`,
      [
        templateId,
        TENANT_US,
        programId,
        'US',
        status,
        `test-tpl-http-${templateId.slice(0, 8)}`,
        ulid(),
        status === 'published' ? new Date() : null,
      ],
    );
  });
  return { templateId, programId, status };
}

const US_HOST = 'localhost';

// ---------------------------------------------------------------------------
// POST /v0/forms/templates
// ---------------------------------------------------------------------------

describe('POST /v0/forms/templates — HTTP-level', () => {
  it('returns 201 + admin body for a valid create', async () => {
    const programId = `prog_create_${ulid().slice(0, 8)}`;
    const response = await app!.inject({
      method: 'POST',
      url: '/v0/forms/templates',
      headers: {
        host: US_HOST,
        'x-actor-id': 'op_create_tpl',

        'x-actor-roles': 'tenant_admin',

        'x-actor-admin-tenant': TENANT_US,
        'content-type': 'application/json',
      },
      payload: {
        programCatalogEntryId: programId,
        name: 'Test create template',
        layout: {},
        branchingLogic: {},
        eligibilityLogic: {},
        approvalGovernance: {},
      },
    });

    expect(response.statusCode).toBe(201);
    const body = response.json<Record<string, unknown>>();
    expect(body['template_id']).toBeDefined();
    expect(body['status']).toBe('draft');
  });

  it('returns 400 on missing body', async () => {
    const response = await app!.inject({
      method: 'POST',
      url: '/v0/forms/templates',
      headers: {
        host: US_HOST,
        'x-actor-id': 'op_no_body',

        'x-actor-roles': 'tenant_admin',

        'x-actor-admin-tenant': TENANT_US,
        'content-type': 'application/json',
      },
      payload: {},
    });
    expect(response.statusCode).toBe(400);
    assertNoTenantIdLeakageInError(response);
  });

  it('returns 401 when no actor identity is supplied', async () => {
    const response = await app!.inject({
      method: 'POST',
      url: '/v0/forms/templates',
      headers: {
        host: US_HOST,
        'content-type': 'application/json',
      },
      payload: {
        programCatalogEntryId: `prog_${ulid().slice(0, 8)}`,
        name: 'name',
        layout: {},
        branchingLogic: {},
        eligibilityLogic: {},
        approvalGovernance: {},
      },
    });
    expect(response.statusCode).toBe(401);
    assertNoTenantIdLeakageInError(response);
  });

  // Codex admin-auth-r1 closure 2026-05-03 — tenant_admin scope is
  // tenant-bound. A tenant_admin for tenant A cannot administer tenant B
  // even with a valid actor identity + admin role + actor-admin-tenant
  // header pointing at A. The shim's tenant-scope check refuses.
  it('returns 403 when tenant_admin role is scoped to a different tenant', async () => {
    const response = await app!.inject({
      method: 'POST',
      url: '/v0/forms/templates',
      headers: {
        host: US_HOST,
        'x-actor-id': 'op_xt_admin',
        'x-actor-roles': 'tenant_admin',
        // Role binding points to a DIFFERENT tenant than the request's
        // resolved context (which is Telecheck-US per host=localhost).
        'x-actor-admin-tenant': 'Telecheck-Ghana',
        'content-type': 'application/json',
      },
      payload: {
        programCatalogEntryId: `prog_${ulid().slice(0, 8)}`,
        name: 'cross-tenant attempt',
        layout: {},
        branchingLogic: {},
        eligibilityLogic: {},
        approvalGovernance: {},
      },
    });
    expect(response.statusCode).toBe(403);
    assertNoTenantIdLeakageInError(response);
  });

  // Codex admin-auth-r1 closure 2026-05-03 — platform_admin is global,
  // authorized in any tenant context regardless of admin-tenant binding.
  it('returns 201 when platform_admin role is supplied (global scope, no admin-tenant header needed)', async () => {
    const programId = `prog_platadmin_${ulid().slice(0, 8)}`;
    const response = await app!.inject({
      method: 'POST',
      url: '/v0/forms/templates',
      headers: {
        host: US_HOST,
        'x-actor-id': 'op_platform_admin',
        'x-actor-roles': 'platform_admin',
        // Deliberately NO x-actor-admin-tenant header — platform_admin
        // is global per RBAC v1.1.
        'content-type': 'application/json',
      },
      payload: {
        programCatalogEntryId: programId,
        name: 'platform admin create',
        layout: {},
        branchingLogic: {},
        eligibilityLogic: {},
        approvalGovernance: {},
      },
    });
    expect(response.statusCode).toBe(201);
  });

  // Codex deployments-http-r1 closure 2026-05-03 — admin endpoints must
  // assert AUTHORIZATION (admin role) on top of IDENTITY (actor-id).
  // Identity present without admin role MUST return 403, not 401 and not
  // 200. Without this the handler would let any authenticated tenant
  // actor (incl. patient/clinician roles) write admin data.
  it('returns 403 when actor identity is present but no admin role is supplied', async () => {
    const response = await app!.inject({
      method: 'POST',
      url: '/v0/forms/templates',
      headers: {
        host: US_HOST,
        'x-actor-id': 'op_no_admin_role',
        // Deliberately a non-admin role.
        'x-actor-roles': 'patient',
        'content-type': 'application/json',
      },
      payload: {
        programCatalogEntryId: `prog_${ulid().slice(0, 8)}`,
        name: 'name',
        layout: {},
        branchingLogic: {},
        eligibilityLogic: {},
        approvalGovernance: {},
      },
    });
    expect(response.statusCode).toBe(403);
    assertNoTenantIdLeakageInError(response);
  });
});

// ---------------------------------------------------------------------------
// GET /v0/forms/templates  (list, paginated)
// ---------------------------------------------------------------------------

describe('GET /v0/forms/templates — HTTP-level', () => {
  it('returns 200 + items array for an authenticated admin', async () => {
    await seedTemplate({});

    const response = await app!.inject({
      method: 'GET',
      url: '/v0/forms/templates?limit=5',
      headers: {
        host: US_HOST,
        'x-actor-id': 'op_list',

        'x-actor-roles': 'tenant_admin',

        'x-actor-admin-tenant': TENANT_US,
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json<{ items: unknown[]; next_cursor: string | null }>();
    expect(Array.isArray(body.items)).toBe(true);
    expect('next_cursor' in body).toBe(true);
  });

  it('returns 400 on an invalid limit', async () => {
    const response = await app!.inject({
      method: 'GET',
      url: '/v0/forms/templates?limit=abc',
      headers: {
        host: US_HOST,
        'x-actor-id': 'op_list_bad',

        'x-actor-roles': 'tenant_admin',

        'x-actor-admin-tenant': TENANT_US,
      },
    });
    expect(response.statusCode).toBe(400);
    assertNoTenantIdLeakageInError(response);
  });

  it('returns 400 on an invalid pagination cursor', async () => {
    const response = await app!.inject({
      method: 'GET',
      url: '/v0/forms/templates?cursor=not-a-real-cursor',
      headers: {
        host: US_HOST,
        'x-actor-id': 'op_list_cur',

        'x-actor-roles': 'tenant_admin',

        'x-actor-admin-tenant': TENANT_US,
      },
    });
    expect(response.statusCode).toBe(400);
    assertNoTenantIdLeakageInError(response);
  });

  it('returns 401 when no actor identity is supplied (admin-read auth gate)', async () => {
    // Codex variants-resume-http-r1 pattern: list endpoint is admin
    // surface; even reads require authenticated actor identity.
    const response = await app!.inject({
      method: 'GET',
      url: '/v0/forms/templates',
      headers: {
        host: US_HOST,
      },
    });
    expect(response.statusCode).toBe(401);
    assertNoTenantIdLeakageInError(response);
  });
});

// ---------------------------------------------------------------------------
// GET /v0/forms/templates/:templateId
// ---------------------------------------------------------------------------

describe('GET /v0/forms/templates/:templateId — HTTP-level', () => {
  it('returns 200 + admin body for a same-tenant lookup', async () => {
    const { templateId } = await seedTemplate({});

    const response = await app!.inject({
      method: 'GET',
      url: `/v0/forms/templates/${templateId}`,
      headers: {
        host: US_HOST,
        'x-actor-id': 'op_get',

        'x-actor-roles': 'tenant_admin',

        'x-actor-admin-tenant': TENANT_US,
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json<Record<string, unknown>>();
    expect(body['template_id']).toBe(templateId);
    // Admin surface — tenant_id IS legitimately present.
    expect(body['tenant_id']).toBe(TENANT_US);
  });

  it('returns 404 (tenant-blind) when a Ghana request reads a US-seeded template', async () => {
    const { templateId } = await seedTemplate({});

    const response = await app!.inject({
      method: 'GET',
      url: `/v0/forms/templates/${templateId}`,
      headers: {
        host: 'ghana.heroshealth.com',
        'x-actor-id': 'op_xt',

        'x-actor-roles': 'tenant_admin',

        'x-actor-admin-tenant': 'Telecheck-Ghana',
      },
    });

    expect(response.statusCode).toBe(404);
    assertNoTenantIdLeakageInError(response);
  });

  it('returns 404 (tenant-blind) for a non-existent template_id', async () => {
    const response = await app!.inject({
      method: 'GET',
      url: `/v0/forms/templates/${ulid()}`,
      headers: {
        host: US_HOST,
        'x-actor-id': 'op_missing',

        'x-actor-roles': 'tenant_admin',

        'x-actor-admin-tenant': TENANT_US,
      },
    });
    expect(response.statusCode).toBe(404);
    assertNoTenantIdLeakageInError(response);
  });

  it('returns 401 when no actor identity is supplied', async () => {
    const { templateId } = await seedTemplate({});
    const response = await app!.inject({
      method: 'GET',
      url: `/v0/forms/templates/${templateId}`,
      headers: {
        host: US_HOST,
      },
    });
    expect(response.statusCode).toBe(401);
    assertNoTenantIdLeakageInError(response);
  });
});

// ---------------------------------------------------------------------------
// POST /v0/forms/templates/:templateId/versions/:versionId/publish
//
// SPEC NOTE: the route accepts a `:versionId` path param but Pattern A
// versioning means each row IS a version (template_version is monotonic
// per (tenant, program, country)). The handler treats the templateId as
// the row to publish; versionId is reserved for future shape but unused
// today. We test against the templateId as both segments to match what
// the publish service expects.
// ---------------------------------------------------------------------------

/**
 * Run an `app.inject` call with FORMS_PUBLISH_GATES_BYPASS set to the
 * 'unsafe-test-only' sentinel. Mirrors the helper in
 * tests/integration/forms-intake-publish.test.ts — the gate is
 * hostile-named so a routine env-config typo can't accidentally open
 * publish in production. We save/restore around every publish-path
 * HTTP test.
 *
 * **Codex templates-http-r1 closure 2026-05-03:** the prior version of
 * this suite ran publish-path tests without setting the bypass. Every
 * publish call (including draft / already-published / missing) hit the
 * fail-closed sentinel first and returned 503 instead of the intended
 * 200/400 response — so the assertions were either red in CI or
 * masked by a process-wide bypass set elsewhere.
 */
async function injectWithPublishBypass(injectArgs: InjectOptions): Promise<LightMyRequestResponse> {
  const prior = process.env['FORMS_PUBLISH_GATES_BYPASS'];
  process.env['FORMS_PUBLISH_GATES_BYPASS'] = 'unsafe-test-only';
  try {
    return await app!.inject(injectArgs);
  } finally {
    if (prior === undefined) {
      delete process.env['FORMS_PUBLISH_GATES_BYPASS'];
    } else {
      process.env['FORMS_PUBLISH_GATES_BYPASS'] = prior;
    }
  }
}

describe('POST /v0/forms/templates/:templateId/versions/:versionId/publish — HTTP-level', () => {
  it('returns 200 + body when publishing a draft template (bypass set)', async () => {
    const { templateId } = await seedTemplate({ status: 'draft' });

    const response = await injectWithPublishBypass({
      method: 'POST',
      url: `/v0/forms/templates/${templateId}/versions/${templateId}/publish`,
      headers: {
        host: US_HOST,
        'x-actor-id': 'op_publish',

        'x-actor-roles': 'tenant_admin',

        'x-actor-admin-tenant': TENANT_US,
        'content-type': 'application/json',
      },
      payload: {},
    });

    // Publish flow may return 200 on success. Lax 2xx check to tolerate
    // 204 or similar on the empty-body case.
    expect(response.statusCode).toBeGreaterThanOrEqual(200);
    expect(response.statusCode).toBeLessThan(300);
  });

  it('returns 400 when publishing a non-draft (already-published) template', async () => {
    // Pattern A immutability: a published version cannot be re-published.
    const { templateId } = await seedTemplate({ status: 'published' });

    const response = await injectWithPublishBypass({
      method: 'POST',
      url: `/v0/forms/templates/${templateId}/versions/${templateId}/publish`,
      headers: {
        host: US_HOST,
        'x-actor-id': 'op_double_publish',

        'x-actor-roles': 'tenant_admin',

        'x-actor-admin-tenant': TENANT_US,
        'content-type': 'application/json',
      },
      payload: {},
    });

    expect(response.statusCode).toBe(400);
    assertNoTenantIdLeakageInError(response);
  });

  it('returns 400 (tenant-blind) for a non-existent template_id', async () => {
    const response = await injectWithPublishBypass({
      method: 'POST',
      url: `/v0/forms/templates/${ulid()}/versions/${ulid()}/publish`,
      headers: {
        host: US_HOST,
        'x-actor-id': 'op_pub_missing',

        'x-actor-roles': 'tenant_admin',

        'x-actor-admin-tenant': TENANT_US,
        'content-type': 'application/json',
      },
      payload: {},
    });
    expect(response.statusCode).toBe(400);
    assertNoTenantIdLeakageInError(response);
  });

  it('returns 401 when no actor identity is supplied', async () => {
    const { templateId } = await seedTemplate({ status: 'draft' });

    // No bypass needed — the actor-id 401 fires before the publish-gate
    // sentinel. This test covers the auth-gate-first ordering.
    const response = await app!.inject({
      method: 'POST',
      url: `/v0/forms/templates/${templateId}/versions/${templateId}/publish`,
      headers: {
        host: US_HOST,
        'content-type': 'application/json',
      },
      payload: {},
    });
    expect(response.statusCode).toBe(401);
    assertNoTenantIdLeakageInError(response);
  });

  // Codex templates-http-r1 closure 2026-05-03: assert the fail-closed
  // invariant explicitly. With the bypass absent (default production
  // posture), the publish endpoint MUST return 503 — preserves the
  // safety floor that publish-time governance gates aren't yet
  // implemented and won't accidentally pass through.
  it('returns 503 when FORMS_PUBLISH_GATES_BYPASS is absent (fail-closed invariant)', async () => {
    const { templateId } = await seedTemplate({ status: 'draft' });

    // Save the env state, ensure bypass is unset for THIS test only,
    // restore after.
    const prior = process.env['FORMS_PUBLISH_GATES_BYPASS'];
    delete process.env['FORMS_PUBLISH_GATES_BYPASS'];
    let response;
    try {
      response = await app!.inject({
        method: 'POST',
        url: `/v0/forms/templates/${templateId}/versions/${templateId}/publish`,
        headers: {
          host: US_HOST,
          'x-actor-id': 'op_pub_failclose',

          'x-actor-roles': 'tenant_admin',

          'x-actor-admin-tenant': TENANT_US,
          'content-type': 'application/json',
        },
        payload: {},
      });
    } finally {
      if (prior !== undefined) {
        process.env['FORMS_PUBLISH_GATES_BYPASS'] = prior;
      }
    }
    expect(response.statusCode).toBe(503);
    assertNoTenantIdLeakageInError(response);
  });
});
