/**
 * Forms/Intake — deployments admin HTTP route-level integration tests.
 *
 * Covers the buildApp + Fastify `inject` integration boundary for the three
 * tenant-admin deployment endpoints registered in
 * `src/modules/forms-intake/routes.ts`:
 *
 *   - POST   /v0/forms/deployments                       (createDeploymentHandler)
 *   - GET    /v0/forms/deployments/:deploymentId         (getDeploymentHandler)
 *   - POST   /v0/forms/deployments/:deploymentId/retire  (retireDeploymentHandler)
 *
 * The service-layer behaviour for create + retire is already covered by the
 * forms-intake template-service tests; this file pins the actual HTTP wire
 * surface — request validation, status-code mapping, sentinel-to-400
 * translation, tenant-blind 404s, and 401 fail-closed when the actor shim
 * has nothing to read.
 *
 * **Pattern:** mirrors `forms-intake-variants-http.test.ts` (the canonical
 * admin-surface buildApp + inject reference in this repo, which itself
 * mirrors `forms-intake-snapshot-http.test.ts` for app lifecycle). Helpers
 * and envelope-conscious assertions are duplicated here on purpose —
 * keeping each HTTP test file self-contained until a shared helper module
 * is justified.
 *
 * **Surface classification — admin vs patient:**
 *   Deployment CRUD is an ADMIN surface (tenant admins manage which
 *   templates are live in their program), NOT a patient surface. Per
 *   Master PRD v1.10 §17 + Glossary v5.2 C3, the patient-surface rule says
 *   patient-facing APIs MUST NOT render the operating-tenant identifier.
 *   Admin APIs ARE allowed to surface `tenant_id` because the tenant
 *   admin operates within their own tenant scope and the identifier is
 *   meaningful to them. So these tests do NOT call
 *   `assertNoTenantIdLeakage` against successful 200/201 bodies — the
 *   FormDeployment response shape carries `tenant_id` legitimately.
 *   `assertNoTenantIdLeakageInError` IS applied to every 4xx response per
 *   the variants-resume-http-r1 pattern closure (error envelopes are a
 *   real PHI leak surface even on admin endpoints — the surface
 *   classification doesn't extend to error bodies that may have been
 *   triggered cross-tenant).
 *
 * **Auth-gate fix applied inline (Codex variants-resume-http-r1 pattern
 *   closure 2026-05-03, extended to deployments by this test pass):**
 *   The original `getDeploymentHandler` only required tenant context, not
 *   actor identity — same hole Codex flagged on `getVariantHandler` and
 *   that landed in commit `f551b5d`. Pre-emptive fix in this commit:
 *   `getDeploymentHandler` now also calls `resolveActorId(req)`, so all
 *   GET tests below pass `x-actor-id` and a 401-when-no-actor case is
 *   included. Documented inline in the handler header comment for
 *   future readers.
 *
 * Spec references:
 *   - Slice PRD v2.1 §6.2 (deployment workflow — create / read / retire).
 *   - I-023 / I-024 / I-025 (tenant isolation + tenant-blind error envelopes).
 *   - I-027 (audit records carry tenant_id; deployment.created + retired
 *     audits are Category B).
 *   - Master PRD v1.10 §17 + Glossary v5.2 C3 (brand-structure / patient
 *     surface MUST NOT render operating-tenant identifier; admin surfaces
 *     are not constrained by this rule on success bodies at v1.10, but
 *     error bodies remain tenant-blind).
 *   - ERROR_MODEL v5.1 (canonical error envelope shape).
 *   - FORMS_ENGINE v5.2 Pattern A (one-version-per-market immutability;
 *     deployment binds (tenant, template, version, ProgramMarketPolicy)).
 */

import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../../src/app.ts';
import { asTenantId } from '../../src/lib/glossary.ts';
import type { TenantContext } from '../../src/lib/tenant-context.ts';
import { ulid } from '../../src/lib/ulid.ts';
import { bearerAuthHeader } from '../helpers/jwt-fixtures.ts';
import { TENANT_US, withTenantContext } from '../helpers/tenant-fixtures.ts';
import { getTestClient } from '../setup.ts';

const T_US = asTenantId(TENANT_US);
const T_GH = asTenantId('Telecheck-Ghana');

// Phase 2 admin JWT migration (2026-05-15): tenant_admin JWT for
// deployments-http admin tests (US tenant). Each test passes its own
// actor accountId.
function adminAuth(accountId: string): { authorization: string } {
  return bearerAuthHeader({
    accountId,
    tenantId: T_US,
    countryOfCare: 'US',
    role: 'tenant_admin',
  });
}

// ---------------------------------------------------------------------------
// Test app lifecycle
// ---------------------------------------------------------------------------

let app: FastifyInstance | null = null;

beforeAll(async () => {
  // ALLOW_ACTOR_HEADER_AUTH gates the actor-id shim at the handler boundary;
  // under NODE_ENV=test the shim accepts headers without the opt-in. Confirm
  // here that the test harness is configured as expected.
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
// Idempotency-Key wrapper — every state-changing HTTP request must carry an
// `Idempotency-Key` header per IDEMPOTENCY v5.1 (the platform plugin in
// `src/lib/idempotency.ts` returns 400 with code
// `internal.idempotency.missing_key` otherwise). Tests use this wrapper
// so a fresh ULID is auto-injected on every state-changing method.
// Tests that need to exercise the missing-key path call `injectWithIdempotency(...)`
// directly.
// ---------------------------------------------------------------------------

async function injectWithIdempotency(args: InjectOptions): Promise<LightMyRequestResponse> {
  const headers = { ...(args.headers ?? {}) } as Record<string, string>;
  const method = typeof args.method === 'string' ? args.method.toUpperCase() : 'GET';
  if (!['GET', 'HEAD', 'OPTIONS'].includes(method) && !('idempotency-key' in headers)) {
    headers['idempotency-key'] = ulid();
  }
  return app!.inject({ ...args, headers });
}

// ---------------------------------------------------------------------------
// Tenant contexts (mirrored from forms-intake-variants-http.test.ts)
// ---------------------------------------------------------------------------

const US_CTX: TenantContext = {
  tenantId: asTenantId(TENANT_US),
  displayName: 'Telecheck-US',
  countryOfCare: 'US',
  kmsKeyAlias: 'alias/telecheck-us-data-key',
  consumerDba: 'Heros Health',
  legalEntity: 'Telecheck Health LLC',
  consumerSubdomain: 'heroshealth.com',
};

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * Seed a published template for the active tenant. The deployment under
 * test is created via the HTTP surface (POST /v0/forms/deployments) so the
 * inject path is covered end-to-end. Returns the templateId only.
 *
 * The `status` parameter lets a test seed a draft template to exercise
 * the publish-gate rejection path — `forms.deployment.template_not_published`
 * sentinel surfaces as a tenant-blind 400.
 */
async function seedTemplate(opts: {
  ctx: TenantContext;
  programId: string;
  status?: 'draft' | 'published' | 'superseded' | 'archived';
}): Promise<string> {
  const client = getTestClient();
  const templateId = ulid();
  const status = opts.status ?? 'published';
  await withTenantContext(opts.ctx.tenantId, async () => {
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
        opts.ctx.tenantId,
        opts.programId,
        opts.ctx.countryOfCare,
        status,
        `test-deploy-http-${templateId.slice(0, 8)}`,
        ulid(),
        status === 'published' ? new Date() : null,
      ],
    );
  });
  return templateId;
}

// ---------------------------------------------------------------------------
// Response shapes (subset asserted by these tests)
// ---------------------------------------------------------------------------

interface DeploymentResponseBody {
  deployment_id: string;
  template_id: string;
  program_id: string;
  deployed_at: string;
  retired_at: string | null;
  // tenant_id IS legitimately present on admin-surface responses per the
  // surface classification note at the top of the file. Asserted only when
  // we want to confirm same-tenant behaviour, never as a leak guard.
  tenant_id?: string;
}

interface ErrorEnvelopeBody {
  error?: {
    code?: string;
    message?: string;
    request_id?: string;
  };
}

// ---------------------------------------------------------------------------
// Helpers — leak-detection, mirrored from forms-intake-resume-http.test.ts
// (per Codex variants-resume-http-r1 closure 2026-05-03 — error envelopes
//  are a real PHI leak surface; apply on every negative response).
// ---------------------------------------------------------------------------

/**
 * Recursively scan a parsed JSON value for a key matching `targetKey`
 * (case-sensitive). Used to catch nested `tenant_id` leaks that a top-level
 * `not.toHaveProperty` check misses. Mirrors the snapshot-http /
 * resume-http / variants-http precedent (consistency over DRY).
 */
function findKeyAtAnyDepth(value: unknown, targetKey: string): boolean {
  type Frame = unknown;
  const stack: Frame[] = [value];
  while (stack.length > 0) {
    const next = stack.pop();
    if (Array.isArray(next)) {
      for (const item of next) {
        stack.push(item);
      }
      continue;
    }
    if (next !== null && typeof next === 'object') {
      const obj = next as Record<string, unknown>;
      for (const key of Object.keys(obj)) {
        if (key === targetKey) {
          return true;
        }
        stack.push(obj[key]);
      }
    }
    // primitives — no key surface
  }
  return false;
}

/**
 * Tenant-blind guard for 4xx / error responses. Tolerant of empty / non-JSON
 * bodies (some 401s come back as empty strings depending on the upstream
 * httpErrors plugin shape).
 *
 * NOTE: this is the ONLY leak guard applied in this file. The patient-surface
 * `assertNoTenantIdLeakage` (success-body byte-clean) is intentionally NOT
 * used here — deployment CRUD is an admin surface and `tenant_id` is
 * legitimately present on 200/201 bodies. See the surface-classification
 * note at the top of the file.
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
// POST /v0/forms/deployments — createDeploymentHandler
// ---------------------------------------------------------------------------

describe('POST /v0/forms/deployments — HTTP-level', () => {
  it('returns 201 + active deployment body on a published template (happy path)', async () => {
    const programId = `prog_dep_http_ok_${ulid().slice(0, 8)}`;
    const templateId = await seedTemplate({ ctx: US_CTX, programId });

    const response = await injectWithIdempotency({
      method: 'POST',
      url: '/v0/forms/deployments',
      headers: {
        host: 'localhost',
        ...adminAuth('op_http_dep_create'),
      },
      payload: { templateId },
    });

    expect(response.statusCode).toBe(201);
    const body = response.json<DeploymentResponseBody>();
    expect(body.deployment_id).toBeDefined();
    expect(body.template_id).toBe(templateId);
    expect(body.program_id).toBe(programId);
    expect(body.deployed_at).toBeDefined();
    expect(body.retired_at).toBeNull();
    // Admin surface — tenant_id IS legitimately present. Confirm it
    // matches the active tenant rather than asserting absence.
    expect(body.tenant_id).toBe(TENANT_US);
  });

  it('returns 400 (tenant-blind) when the template is in draft status (publish-gate)', async () => {
    // Per FORMS_ENGINE v5.2 Pattern A, only a published version is
    // deployable. The service throws `forms.deployment.template_not_published`
    // and the handler maps it to 400 with the canonical code. Tenant-blind:
    // the wire body must not differentiate "draft" from "missing" /
    // "cross-tenant" via leaked operating-tenant identity.
    const programId = `prog_dep_http_draft_${ulid().slice(0, 8)}`;
    const draftTemplateId = await seedTemplate({
      ctx: US_CTX,
      programId,
      status: 'draft',
    });

    const response = await injectWithIdempotency({
      method: 'POST',
      url: '/v0/forms/deployments',
      headers: {
        host: 'localhost',
        ...adminAuth('op_http_dep_draft'),
      },
      payload: { templateId: draftTemplateId },
    });

    expect(response.statusCode).toBe(400);
    assertNoTenantIdLeakageInError(response);
    const body = response.json<ErrorEnvelopeBody>();
    expect(body.error?.code).toBeDefined();
  });

  it('returns 400 (tenant-blind) when the templateId does not exist', async () => {
    // Service throws `forms.deployment.template_not_found` for a missing
    // template; handler maps to 400. Same envelope shape as the draft path
    // per I-025 — observability code preserved internally, wire body
    // doesn't betray which underlying reason tripped.
    const response = await injectWithIdempotency({
      method: 'POST',
      url: '/v0/forms/deployments',
      headers: {
        host: 'localhost',
        ...adminAuth('op_http_dep_missing'),
      },
      payload: { templateId: ulid() },
    });

    expect(response.statusCode).toBe(400);
    assertNoTenantIdLeakageInError(response);
    const body = response.json<ErrorEnvelopeBody>();
    expect(body.error?.code).toBeDefined();
  });

  it('returns 401 when no actor identity header is supplied', async () => {
    // Even with a valid body + a real published template, the handler MUST
    // refuse to act when no actor identity has been resolved — audit chains
    // require an actor and the placeholder `x-actor-id` shim is the only
    // source under NODE_ENV=test (Identity slice deferral).
    const programId = `prog_dep_http_noactor_${ulid().slice(0, 8)}`;
    const templateId = await seedTemplate({ ctx: US_CTX, programId });

    const response = await injectWithIdempotency({
      method: 'POST',
      url: '/v0/forms/deployments',
      headers: {
        host: 'localhost',
      },
      payload: { templateId },
    });

    expect(response.statusCode).toBe(401);
    assertNoTenantIdLeakageInError(response);
  });

  // Codex deployments-http-r1 closure 2026-05-03 — admin endpoints assert
  // BOTH identity AND admin-role authorization. With actor-id present
  // but no admin role, the handler returns 403 (not 401, not 200).
  it('returns 403 when actor identity is present but no admin role is supplied', async () => {
    const programId = `prog_dep_http_noadmin_${ulid().slice(0, 8)}`;
    const templateId = await seedTemplate({ ctx: US_CTX, programId });

    const response = await injectWithIdempotency({
      method: 'POST',
      url: '/v0/forms/deployments',
      headers: {
        host: 'localhost',
        // Non-admin role (patient JWT) — fails admin authz.
        ...bearerAuthHeader({
          accountId: 'op_no_admin_role',
          tenantId: T_US,
          countryOfCare: 'US',
          role: 'patient',
        }),
      },
      payload: { templateId },
    });

    expect(response.statusCode).toBe(403);
    assertNoTenantIdLeakageInError(response);
  });

  it('returns 400 when the request body is empty (missing templateId)', async () => {
    // CreateDeploymentRequestSchema requires `templateId: z.string().min(1)`;
    // an empty payload fails Zod validation before the service runs.
    const response = await injectWithIdempotency({
      method: 'POST',
      url: '/v0/forms/deployments',
      headers: {
        host: 'localhost',
        ...adminAuth('op_http_dep_emptybody'),
      },
      payload: {},
    });

    expect(response.statusCode).toBe(400);
    assertNoTenantIdLeakageInError(response);
    const body = response.json<ErrorEnvelopeBody>();
    expect(body.error?.code).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// GET /v0/forms/deployments/:deploymentId — getDeploymentHandler
// ---------------------------------------------------------------------------

describe('GET /v0/forms/deployments/:deploymentId — HTTP-level', () => {
  it('returns 200 + deployment body for a same-tenant lookup', async () => {
    // Create via HTTP so the test exercises the create -> read round-trip
    // through the same Fastify instance.
    const programId = `prog_dep_http_getok_${ulid().slice(0, 8)}`;
    const templateId = await seedTemplate({ ctx: US_CTX, programId });

    const createResp = await injectWithIdempotency({
      method: 'POST',
      url: '/v0/forms/deployments',
      headers: {
        host: 'localhost',
        ...adminAuth('op_http_dep_get_create'),
      },
      payload: { templateId },
    });
    expect(createResp.statusCode).toBe(201);
    const created = createResp.json<DeploymentResponseBody>();

    const response = await injectWithIdempotency({
      method: 'GET',
      url: `/v0/forms/deployments/${created.deployment_id}`,
      headers: {
        host: 'localhost',
        // Admin endpoints (incl. reads) require an authenticated actor —
        // Codex variants-resume-http-r1 pattern closure 2026-05-03,
        // extended to deployments by this test pass. The handler patch in
        // the same commit adds `void resolveActorId(req)` to
        // getDeploymentHandler.
        ...adminAuth('op_http_dep_get'),
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json<DeploymentResponseBody>();
    expect(body.deployment_id).toBe(created.deployment_id);
    expect(body.template_id).toBe(templateId);
    expect(body.program_id).toBe(programId);
    expect(body.retired_at).toBeNull();
    // Admin surface — tenant_id IS legitimately present here. Assert it
    // matches the active tenant rather than asserting absence.
    expect(body.tenant_id).toBe(TENANT_US);
  });

  it('returns 401 when no actor identity is supplied (admin-read auth gate)', async () => {
    // Codex variants-resume-http-r1 pattern closure 2026-05-03 extended to
    // deployments — deployment CRUD is a tenant-admin operation per Slice
    // PRD §6.2; even read endpoints require authenticated actor identity.
    // Without `x-actor-id` the handler's `resolveActorId` shim 401s before
    // any DB access runs. The handler patch in this same commit adds the
    // gate; this case proves it's wired.
    const programId = `prog_dep_http_get401_${ulid().slice(0, 8)}`;
    const templateId = await seedTemplate({ ctx: US_CTX, programId });

    const createResp = await injectWithIdempotency({
      method: 'POST',
      url: '/v0/forms/deployments',
      headers: {
        host: 'localhost',
        ...adminAuth('op_http_dep_get401_create'),
      },
      payload: { templateId },
    });
    expect(createResp.statusCode).toBe(201);
    const { deployment_id } = createResp.json<DeploymentResponseBody>();

    const response = await injectWithIdempotency({
      method: 'GET',
      url: `/v0/forms/deployments/${deployment_id}`,
      headers: {
        host: 'localhost',
      },
    });

    expect(response.statusCode).toBe(401);
    assertNoTenantIdLeakageInError(response);
  });

  it('returns 404 (tenant-blind) when a different tenant attempts the read', async () => {
    // Seed + create in US then read from Ghana (host: ghana.heroshealth.com
    // → maps to Telecheck-Ghana per SUBDOMAIN_TENANT_MAP). RLS filters the
    // row out; the handler returns 404 with the canonical envelope shape
    // per I-025 — same response as a missing deployment.
    const programId = `prog_dep_http_xt_${ulid().slice(0, 8)}`;
    const templateId = await seedTemplate({ ctx: US_CTX, programId });

    const createResp = await injectWithIdempotency({
      method: 'POST',
      url: '/v0/forms/deployments',
      headers: {
        host: 'localhost',
        ...adminAuth('op_http_dep_xt_create'),
      },
      payload: { templateId },
    });
    expect(createResp.statusCode).toBe(201);
    const { deployment_id: usDeploymentId } = createResp.json<DeploymentResponseBody>();

    const response = await injectWithIdempotency({
      method: 'GET',
      url: `/v0/forms/deployments/${usDeploymentId}`,
      headers: {
        host: 'ghana.heroshealth.com',
        ...bearerAuthHeader({
          accountId: 'op_http_dep_xt_read',
          tenantId: T_GH,
          countryOfCare: 'GH',
          role: 'tenant_admin',
        }),
      },
    });

    expect(response.statusCode).toBe(404);
    assertNoTenantIdLeakageInError(response);
    const body = response.json<ErrorEnvelopeBody>();
    expect(body.error?.code).toBeDefined();
  });

  it('returns 404 (tenant-blind) for a non-existent deployment_id', async () => {
    const response = await injectWithIdempotency({
      method: 'GET',
      url: `/v0/forms/deployments/${ulid()}`,
      headers: {
        host: 'localhost',
        ...adminAuth('op_http_dep_missing_get'),
      },
    });

    expect(response.statusCode).toBe(404);
    assertNoTenantIdLeakageInError(response);
    const body = response.json<ErrorEnvelopeBody>();
    expect(body.error?.code).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// POST /v0/forms/deployments/:deploymentId/retire — retireDeploymentHandler
// ---------------------------------------------------------------------------

describe('POST /v0/forms/deployments/:deploymentId/retire — HTTP-level', () => {
  it('returns 200 + retired_at populated on the happy path', async () => {
    const programId = `prog_dep_http_retire_ok_${ulid().slice(0, 8)}`;
    const templateId = await seedTemplate({ ctx: US_CTX, programId });

    const createResp = await injectWithIdempotency({
      method: 'POST',
      url: '/v0/forms/deployments',
      headers: {
        host: 'localhost',
        ...adminAuth('op_http_dep_retire_create'),
      },
      payload: { templateId },
    });
    expect(createResp.statusCode).toBe(201);
    const { deployment_id } = createResp.json<DeploymentResponseBody>();

    const response = await injectWithIdempotency({
      method: 'POST',
      url: `/v0/forms/deployments/${deployment_id}/retire`,
      headers: {
        host: 'localhost',
        ...adminAuth('op_http_dep_retire'),
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json<DeploymentResponseBody>();
    expect(body.deployment_id).toBe(deployment_id);
    expect(body.retired_at).not.toBeNull();
    // Spot-check the retired_at is ISO-ish (string, parseable as Date).
    expect(typeof body.retired_at).toBe('string');
    expect(Number.isNaN(Date.parse(body.retired_at as string))).toBe(false);
  });

  it('returns 400 (tenant-blind) when retiring an already-retired deployment', async () => {
    // First retire flips retired_at; second retire trips the
    // DEPLOYMENT_ALREADY_RETIRED sentinel (defined in submission-repo.ts at
    // L207). Handler maps to a tenant-blind 400 — same envelope as
    // DEPLOYMENT_NOT_FOUND so the wire response NEVER differentiates
    // "doesn't exist" / "exists in another tenant" / "already retired."
    const programId = `prog_dep_http_retire_dup_${ulid().slice(0, 8)}`;
    const templateId = await seedTemplate({ ctx: US_CTX, programId });

    const createResp = await injectWithIdempotency({
      method: 'POST',
      url: '/v0/forms/deployments',
      headers: {
        host: 'localhost',
        ...adminAuth('op_http_dep_dup_create'),
      },
      payload: { templateId },
    });
    expect(createResp.statusCode).toBe(201);
    const { deployment_id } = createResp.json<DeploymentResponseBody>();

    const first = await injectWithIdempotency({
      method: 'POST',
      url: `/v0/forms/deployments/${deployment_id}/retire`,
      headers: {
        host: 'localhost',
        ...adminAuth('op_http_dep_dup_first'),
      },
    });
    expect(first.statusCode).toBe(200);

    const second = await injectWithIdempotency({
      method: 'POST',
      url: `/v0/forms/deployments/${deployment_id}/retire`,
      headers: {
        host: 'localhost',
        ...adminAuth('op_http_dep_dup_second'),
      },
    });

    expect(second.statusCode).toBe(400);
    assertNoTenantIdLeakageInError(second);
    const body = second.json<ErrorEnvelopeBody>();
    expect(body.error?.code).toBeDefined();
  });

  it('returns 400 (tenant-blind) when retiring a non-existent deployment_id', async () => {
    // Sentinel mapping per `retireDeploymentHandler` header comment:
    // DEPLOYMENT_NOT_FOUND maps to 400 (NOT 404) so the wire envelope is
    // byte-identical to DEPLOYMENT_ALREADY_RETIRED. This is intentional
    // tenant-blindness per I-025 + the handler's documented contract —
    // a 404 here would let an attacker enumerate deployment_ids by
    // probing for "exists" vs "doesn't exist" responses (404 vs 400).
    const response = await injectWithIdempotency({
      method: 'POST',
      url: `/v0/forms/deployments/${ulid()}/retire`,
      headers: {
        host: 'localhost',
        ...adminAuth('op_http_dep_retire_missing'),
      },
    });

    expect(response.statusCode).toBe(400);
    assertNoTenantIdLeakageInError(response);
    const body = response.json<ErrorEnvelopeBody>();
    expect(body.error?.code).toBeDefined();
  });

  it('returns 401 when no actor identity header is supplied', async () => {
    // Same fail-closed gate as createDeploymentHandler — retire writes an
    // audit row (Category B per Slice PRD §6.2 supersession discipline),
    // so it must refuse to proceed without an actor.
    const programId = `prog_dep_http_retire_noactor_${ulid().slice(0, 8)}`;
    const templateId = await seedTemplate({ ctx: US_CTX, programId });

    const createResp = await injectWithIdempotency({
      method: 'POST',
      url: '/v0/forms/deployments',
      headers: {
        host: 'localhost',
        ...adminAuth('op_http_dep_retire_noactor_create'),
      },
      payload: { templateId },
    });
    expect(createResp.statusCode).toBe(201);
    const { deployment_id } = createResp.json<DeploymentResponseBody>();

    const response = await injectWithIdempotency({
      method: 'POST',
      url: `/v0/forms/deployments/${deployment_id}/retire`,
      headers: {
        host: 'localhost',
      },
    });

    expect(response.statusCode).toBe(401);
    assertNoTenantIdLeakageInError(response);
  });

  // Note on "missing deploymentId in path": Fastify's route matcher for
  // `/v0/forms/deployments/:deploymentId/retire` does not match the URL
  // `/v0/forms/deployments//retire` to this handler at all — the empty
  // path segment fails the match, returning a 404 from the framework
  // before retireDeploymentHandler runs. The handler's defensive
  // `if (deploymentIdParam.length === 0)` check exists for type-narrowing
  // but is not reachable through HTTP. Skipping that case per the
  // variants-http precedent's "skip if unreachable" allowance.
});
