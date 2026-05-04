/**
 * Forms/Intake — variants admin HTTP route-level integration tests.
 *
 * Covers the buildApp + Fastify `inject` integration boundary for the three
 * tenant-admin variants endpoints registered in
 * `src/modules/forms-intake/routes.ts`:
 *
 *   - POST   /v0/forms/variants                     (createVariantHandler)
 *   - GET    /v0/forms/variants/:variantId          (getVariantHandler)
 *   - POST   /v0/forms/variants/:variantId/promote  (promoteVariantHandler)
 *
 * The service-layer behaviour is already covered by
 * `forms-intake-variants.test.ts`; this file pins the actual HTTP wire
 * surface — request validation, status-code mapping, sentinel-to-400
 * translation, tenant-blind 404s, and 401 fail-closed when the actor
 * shim has nothing to read.
 *
 * **Pattern:** mirrors `forms-intake-snapshot-http.test.ts` (the canonical
 * buildApp + inject reference in this repo). App lifecycle, helpers, and
 * envelope-conscious assertions are duplicated here on purpose — keeping
 * each HTTP test file self-contained until a shared helper module is
 * justified.
 *
 * **Surface classification — admin vs patient:**
 *   Variants CRUD is an ADMIN surface (tenant admins manage A/B-test arms),
 *   NOT a patient surface. Per Master PRD v1.10 §17 + Glossary v5.2 C3, the
 *   patient-surface rule says patient-facing APIs MUST NOT render the
 *   operating-tenant identifier. Admin APIs ARE allowed to surface
 *   `tenant_id` because the tenant admin operates within their own tenant
 *   scope and the identifier is meaningful to them. So these tests do NOT
 *   call `assertNoTenantIdLeakage` against the body — the FormVariant
 *   response shape carries `tenant_id` legitimately. Cross-tenant
 *   isolation is still enforced (and asserted) via the tenant-blind 404
 *   on a Ghana-host read of a US-tenant variant.
 *
 *   OPEN QUESTION: the Master PRD does not explicitly forbid `tenant_id`
 *   on admin-surface response bodies, and the existing service projection
 *   (`templateService.getVariant`) returns the raw FormVariant row
 *   (tenant_id included). If a future rule tightens this, the assertions
 *   here will need to add `assertNoTenantIdLeakage` and the service will
 *   need a `variantToAdminView` projector analogous to
 *   `snapshotToPatientView`. Filed inline so engineering escalation per
 *   EHBG §12 catches it during a v1.11 spec round.
 *
 * Spec references:
 *   - Slice PRD v2.1 §14 (A/B testing native — variant lifecycle).
 *   - I-023 / I-024 / I-025 (tenant isolation + tenant-blind error envelopes).
 *   - I-027 (audit records carry tenant_id; promote audits are Category B
 *     with target_patient_id null per Slice PRD §14.6).
 *   - Master PRD v1.10 §17 + Glossary v5.2 C3 (brand-structure / patient
 *     surface MUST NOT render operating-tenant identifier; admin surfaces
 *     are not constrained by this rule at v1.10).
 *   - ERROR_MODEL v5.1 (canonical error envelope shape).
 */

import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../../src/app.ts';
import { asTenantId } from '../../src/lib/glossary.ts';
import type { TenantContext } from '../../src/lib/tenant-context.ts';
import { ulid } from '../../src/lib/ulid.ts';
import * as templateService from '../../src/modules/forms-intake/internal/services/template-service.ts';
import { TENANT_US, withTenantContext } from '../helpers/tenant-fixtures.ts';
import { getTestClient } from '../setup.ts';

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
// Tenant contexts (mirrored from forms-intake-variants.test.ts; duplicated
// rather than imported so this file is self-contained per the snapshot-http
// precedent)
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
// Fixtures (mirrored from forms-intake-variants.test.ts; duplicated for
// self-containment per the snapshot-http precedent — consistency with the
// rest of the suite over DRY)
// ---------------------------------------------------------------------------

interface SeededDeployment {
  templateId: string;
  deploymentId: string;
}

/**
 * Seed a published template + deployment for the active tenant. Optionally
 * mark the deployment retired so tests can exercise the
 * VARIANT_PRECONDITION_FAILED path through the HTTP surface.
 */
async function seedActiveDeployment(opts: {
  ctx: TenantContext;
  programId: string;
  retired?: boolean;
}): Promise<SeededDeployment> {
  const client = getTestClient();
  const templateId = ulid();
  const deploymentId = ulid();
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
          1, 'published', $5, $6,
          '{}'::jsonb, '{}'::jsonb,
          '{}'::jsonb, '{}'::jsonb,
          NOW(), NOW(), NOW()
       )`,
      [
        templateId,
        opts.ctx.tenantId,
        opts.programId,
        opts.ctx.countryOfCare,
        `test-variant-http-${templateId.slice(0, 8)}`,
        ulid(),
      ],
    );
    await client.query(
      `INSERT INTO forms_deployment (
          deployment_id, tenant_id, template_id, program_id,
          deployed_by, deployed_at, retired_at,
          created_at, updated_at
       ) VALUES (
          $1, $2, $3, $4,
          $5, NOW(), $6,
          NOW(), NOW()
       )`,
      [
        deploymentId,
        opts.ctx.tenantId,
        templateId,
        opts.programId,
        ulid(),
        opts.retired === true ? new Date() : null,
      ],
    );
  });
  return { templateId, deploymentId };
}

/**
 * Seed an additional template under the given tenant — used when a test
 * needs a separately-authored modified template arm (Slice PRD §14.1) or a
 * draft template for the publish-gate rejection path (Codex variants-r1
 * HIGH-2 closure).
 */
async function seedAdditionalTemplate(opts: {
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
        `test-variant-http-tpl-${templateId.slice(0, 8)}`,
        ulid(),
        status === 'published' ? new Date() : null,
      ],
    );
  });
  return templateId;
}

/**
 * Seed an active control variant directly via the service layer — used as
 * test setup when the HTTP test under exercise is GET or promote (the
 * variant must already exist before the HTTP call). For the create-variant
 * tests we call the HTTP surface directly so the inject path is covered
 * end-to-end.
 */
async function seedControlVariant(opts: {
  ctx: TenantContext;
  deploymentId: string;
  variantTemplateId: string;
  label?: 'control' | 'A' | 'B' | 'C' | 'D';
  trafficPercent?: number;
  actorId?: string;
}): Promise<string> {
  const variant = await withTenantContext(opts.ctx.tenantId, () =>
    templateService.createVariant(
      opts.ctx,
      opts.actorId ?? 'op_http_setup',
      {
        deploymentId: opts.deploymentId,
        variantTemplateId: opts.variantTemplateId,
        label: opts.label ?? 'control',
        trafficPercent: opts.trafficPercent ?? 100,
      },
      getTestClient(),
    ),
  );
  return variant.variant_id;
}

// ---------------------------------------------------------------------------
// FormVariant response shape (subset asserted by these tests)
// ---------------------------------------------------------------------------

interface VariantResponseBody {
  variant_id: string;
  variant_label: 'control' | 'A' | 'B' | 'C' | 'D';
  variant_template_id: string;
  traffic_percent: number;
  status: 'active' | 'retired' | 'winner';
  deployment_id: string;
  created_by: string;
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
// POST /v0/forms/variants — createVariantHandler
// ---------------------------------------------------------------------------

describe('POST /v0/forms/variants — HTTP-level', () => {
  it('returns 201 + active control variant on a fresh deployment (happy path)', async () => {
    const programId = `prog_var_http_ok_${ulid().slice(0, 8)}`;
    const { templateId, deploymentId } = await seedActiveDeployment({
      ctx: US_CTX,
      programId,
    });

    const response = await injectWithIdempotency({
      method: 'POST',
      url: '/v0/forms/variants',
      headers: {
        host: 'localhost',
        'x-actor-id': 'op_http_create',

        'x-actor-roles': 'tenant_admin',

        'x-actor-admin-tenant': TENANT_US,
      },
      payload: {
        deploymentId,
        variantTemplateId: templateId,
        label: 'control',
        trafficPercent: 100,
      },
    });

    expect(response.statusCode).toBe(201);
    const body = response.json<VariantResponseBody>();
    expect(body.variant_id).toBeDefined();
    expect(body.variant_label).toBe('control');
    expect(body.variant_template_id).toBe(templateId);
    expect(body.traffic_percent).toBe(100);
    expect(body.status).toBe('active');
    expect(body.deployment_id).toBe(deploymentId);
    expect(body.created_by).toBe('op_http_create');
  });

  it('returns 400 (tenant-blind) when the deployment is retired', async () => {
    const programId = `prog_var_http_ret_${ulid().slice(0, 8)}`;
    const { templateId, deploymentId } = await seedActiveDeployment({
      ctx: US_CTX,
      programId,
      retired: true,
    });

    const response = await injectWithIdempotency({
      method: 'POST',
      url: '/v0/forms/variants',
      headers: {
        host: 'localhost',
        'x-actor-id': 'op_http_retired',

        'x-actor-roles': 'tenant_admin',

        'x-actor-admin-tenant': TENANT_US,
      },
      payload: {
        deploymentId,
        variantTemplateId: templateId,
        label: 'control',
        trafficPercent: 100,
      },
    });

    expect(response.statusCode).toBe(400);
    const body = response.json<ErrorEnvelopeBody>();
    // I-025 tenant-blind: structured code present, but the wire-out message
    // does not differentiate "retired" from "missing" / "cross-tenant".
    expect(body.error?.code).toBeDefined();
  });

  it('returns 400 on duplicate (deployment, label) pair', async () => {
    const programId = `prog_var_http_dup_${ulid().slice(0, 8)}`;
    const { templateId, deploymentId } = await seedActiveDeployment({
      ctx: US_CTX,
      programId,
    });

    // First create — succeeds.
    const first = await injectWithIdempotency({
      method: 'POST',
      url: '/v0/forms/variants',
      headers: {
        host: 'localhost',
        'x-actor-id': 'op_http_dup_first',

        'x-actor-roles': 'tenant_admin',

        'x-actor-admin-tenant': TENANT_US,
      },
      payload: {
        deploymentId,
        variantTemplateId: templateId,
        label: 'control',
        trafficPercent: 100,
      },
    });
    expect(first.statusCode).toBe(201);

    // Second create with same label — must conflict (VARIANT_LABEL_CONFLICT
    // → 400 tenant-blind).
    const second = await injectWithIdempotency({
      method: 'POST',
      url: '/v0/forms/variants',
      headers: {
        host: 'localhost',
        'x-actor-id': 'op_http_dup_second',

        'x-actor-roles': 'tenant_admin',

        'x-actor-admin-tenant': TENANT_US,
      },
      payload: {
        deploymentId,
        variantTemplateId: templateId,
        label: 'control',
        trafficPercent: 50,
      },
    });
    expect(second.statusCode).toBe(400);
    const body = second.json<ErrorEnvelopeBody>();
    expect(body.error?.code).toBeDefined();
  });

  it('returns 400 when variant_template is unpublished (publish-gate closure)', async () => {
    // Codex variants-r1 HIGH-2 closure 2026-05-03 — variant_template MUST be
    // published. A draft template represents content that hasn't passed
    // the I-013 + I-015 + I-030 publish-time gates; routing intake traffic
    // to it is a clinical safety violation. Surfaces as a tenant-blind 400
    // through the HTTP wire.
    const programId = `prog_var_http_draft_${ulid().slice(0, 8)}`;
    const { deploymentId } = await seedActiveDeployment({
      ctx: US_CTX,
      programId,
    });
    const draftTemplateId = await seedAdditionalTemplate({
      ctx: US_CTX,
      programId,
      status: 'draft',
    });

    const response = await injectWithIdempotency({
      method: 'POST',
      url: '/v0/forms/variants',
      headers: {
        host: 'localhost',
        'x-actor-id': 'op_http_draft',

        'x-actor-roles': 'tenant_admin',

        'x-actor-admin-tenant': TENANT_US,
      },
      payload: {
        deploymentId,
        variantTemplateId: draftTemplateId,
        label: 'A',
        trafficPercent: 25,
      },
    });

    expect(response.statusCode).toBe(400);
    const body = response.json<ErrorEnvelopeBody>();
    expect(body.error?.code).toBeDefined();
  });

  it('returns 400 when the request body is missing required fields', async () => {
    const response = await injectWithIdempotency({
      method: 'POST',
      url: '/v0/forms/variants',
      headers: {
        host: 'localhost',
        'x-actor-id': 'op_http_nobody',

        'x-actor-roles': 'tenant_admin',

        'x-actor-admin-tenant': TENANT_US,
      },
      payload: {},
    });

    expect(response.statusCode).toBe(400);
    const body = response.json<ErrorEnvelopeBody>();
    expect(body.error?.code).toBeDefined();
  });

  it('returns 401 when no actor identity header is supplied', async () => {
    // Even with a valid body, the handler MUST refuse to act when no
    // actor identity has been resolved — audit chains require an actor and
    // the placeholder `x-actor-id` shim is the only source under
    // NODE_ENV=test (per Identity slice deferral).
    const programId = `prog_var_http_noactor_${ulid().slice(0, 8)}`;
    const { templateId, deploymentId } = await seedActiveDeployment({
      ctx: US_CTX,
      programId,
    });

    const response = await injectWithIdempotency({
      method: 'POST',
      url: '/v0/forms/variants',
      headers: {
        host: 'localhost',
      },
      payload: {
        deploymentId,
        variantTemplateId: templateId,
        label: 'control',
        trafficPercent: 100,
      },
    });

    expect(response.statusCode).toBe(401);
  });

  // Codex deployments-http-r1 closure 2026-05-03 — admin endpoints assert
  // BOTH identity AND admin-role authorization. With actor-id present
  // but no admin role, the handler returns 403 (not 401, not 201).
  it('returns 403 when actor identity is present but no admin role is supplied', async () => {
    const programId = `prog_var_http_noadmin_${ulid().slice(0, 8)}`;
    const { templateId, deploymentId } = await seedActiveDeployment({
      ctx: US_CTX,
      programId,
    });

    const response = await injectWithIdempotency({
      method: 'POST',
      url: '/v0/forms/variants',
      headers: {
        host: 'localhost',
        'x-actor-id': 'op_no_admin_role',
        // Non-admin role.
        'x-actor-roles': 'patient',
      },
      payload: {
        deploymentId,
        variantTemplateId: templateId,
        label: 'control',
        trafficPercent: 100,
      },
    });
    expect(response.statusCode).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// GET /v0/forms/variants/:variantId — getVariantHandler
// ---------------------------------------------------------------------------

describe('GET /v0/forms/variants/:variantId — HTTP-level', () => {
  it('returns 200 + variant body for a same-tenant lookup', async () => {
    const programId = `prog_var_http_getok_${ulid().slice(0, 8)}`;
    const { templateId, deploymentId } = await seedActiveDeployment({
      ctx: US_CTX,
      programId,
    });
    const variantId = await seedControlVariant({
      ctx: US_CTX,
      deploymentId,
      variantTemplateId: templateId,
    });

    const response = await injectWithIdempotency({
      method: 'GET',
      url: `/v0/forms/variants/${variantId}`,
      headers: {
        host: 'localhost',
        // Admin endpoints (incl. reads) require an authenticated actor —
        // Codex variants-resume-http-r1 closure 2026-05-03.
        'x-actor-id': 'op_get',

        'x-actor-roles': 'tenant_admin',

        'x-actor-admin-tenant': TENANT_US,
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json<VariantResponseBody>();
    expect(body.variant_id).toBe(variantId);
    expect(body.deployment_id).toBe(deploymentId);
    expect(body.variant_template_id).toBe(templateId);
    expect(body.status).toBe('active');
    // Admin surface — tenant_id IS legitimately present here. We assert it
    // matches the active tenant rather than asserting absence (see the
    // surface classification note at the top of the file).
    expect(body.tenant_id).toBe(TENANT_US);
  });

  it('returns 401 when no actor identity is supplied (admin-read auth gate)', async () => {
    // Codex variants-resume-http-r1 closure 2026-05-03 — variants are
    // tenant-admin operations per Slice PRD §14; even read endpoints
    // require authenticated actor identity. Without `x-actor-id` the
    // handler's `resolveActorId` shim 401s before any DB access runs.
    const programId = `prog_var_http_get401_${ulid().slice(0, 8)}`;
    const { templateId, deploymentId } = await seedActiveDeployment({
      ctx: US_CTX,
      programId,
    });
    const variantId = await seedControlVariant({
      ctx: US_CTX,
      deploymentId,
      variantTemplateId: templateId,
    });

    const response = await injectWithIdempotency({
      method: 'GET',
      url: `/v0/forms/variants/${variantId}`,
      headers: {
        host: 'localhost',
      },
    });

    expect(response.statusCode).toBe(401);
  });

  it('returns 404 (tenant-blind) when a different tenant attempts the read', async () => {
    // Seed in US then read from Ghana (host: ghana.heroshealth.com → maps
    // to Telecheck-Ghana per SUBDOMAIN_TENANT_MAP). RLS filters the row
    // out; the handler returns 404 with the canonical envelope shape per
    // I-025 — same response as a missing variant.
    const programId = `prog_var_http_xt_${ulid().slice(0, 8)}`;
    const { templateId, deploymentId } = await seedActiveDeployment({
      ctx: US_CTX,
      programId,
    });
    const usVariantId = await seedControlVariant({
      ctx: US_CTX,
      deploymentId,
      variantTemplateId: templateId,
    });

    const response = await injectWithIdempotency({
      method: 'GET',
      url: `/v0/forms/variants/${usVariantId}`,
      headers: {
        host: 'ghana.heroshealth.com',
        'x-actor-id': 'op_xt',

        'x-actor-roles': 'tenant_admin',

        'x-actor-admin-tenant': 'Telecheck-Ghana',
      },
    });

    expect(response.statusCode).toBe(404);
    const body = response.json<ErrorEnvelopeBody>();
    expect(body.error?.code).toBeDefined();
  });

  it('returns 404 (tenant-blind) for a non-existent variant_id', async () => {
    const response = await injectWithIdempotency({
      method: 'GET',
      url: `/v0/forms/variants/${ulid()}`,
      headers: {
        host: 'localhost',
        'x-actor-id': 'op_missing',

        'x-actor-roles': 'tenant_admin',

        'x-actor-admin-tenant': TENANT_US,
      },
    });

    expect(response.statusCode).toBe(404);
    const body = response.json<ErrorEnvelopeBody>();
    expect(body.error?.code).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// POST /v0/forms/variants/:variantId/promote — promoteVariantHandler
// ---------------------------------------------------------------------------

describe('POST /v0/forms/variants/:variantId/promote — HTTP-level', () => {
  it('returns 200 + winner status on the happy path (control + arm A)', async () => {
    const programId = `prog_var_http_promote_${ulid().slice(0, 8)}`;
    const { templateId, deploymentId } = await seedActiveDeployment({
      ctx: US_CTX,
      programId,
    });
    const altTemplateId = await seedAdditionalTemplate({
      ctx: US_CTX,
      programId,
    });

    // Setup: control + arm A both active.
    await seedControlVariant({
      ctx: US_CTX,
      deploymentId,
      variantTemplateId: templateId,
      label: 'control',
      trafficPercent: 50,
    });
    const armAId = await seedControlVariant({
      ctx: US_CTX,
      deploymentId,
      variantTemplateId: altTemplateId,
      label: 'A',
      trafficPercent: 50,
    });

    // Promote arm A.
    const response = await injectWithIdempotency({
      method: 'POST',
      url: `/v0/forms/variants/${armAId}/promote`,
      headers: {
        host: 'localhost',
        'x-actor-id': 'op_http_promote',

        'x-actor-roles': 'tenant_admin',

        'x-actor-admin-tenant': TENANT_US,
      },
      payload: {
        rationale: 'Arm A converted 12% better; p < 0.01 over n=2000 sessions.',
        sampleSize: 2000,
        pValue: 0.005,
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json<VariantResponseBody>();
    expect(body.variant_id).toBe(armAId);
    expect(body.status).toBe('winner');
  });

  it('returns 400 (tenant-blind) when promoting a retired variant', async () => {
    // Promote control once — that retires nothing (single arm) but flips
    // control to winner. Then attempt to promote the same variant_id again
    // — VARIANT_NOT_ACTIVE → tenant-blind 400.
    const programId = `prog_var_http_promote_dup_${ulid().slice(0, 8)}`;
    const { templateId, deploymentId } = await seedActiveDeployment({
      ctx: US_CTX,
      programId,
    });
    const variantId = await seedControlVariant({
      ctx: US_CTX,
      deploymentId,
      variantTemplateId: templateId,
    });

    // First promote — succeeds.
    const first = await injectWithIdempotency({
      method: 'POST',
      url: `/v0/forms/variants/${variantId}/promote`,
      headers: {
        host: 'localhost',
        'x-actor-id': 'op_http_promote_first',

        'x-actor-roles': 'tenant_admin',

        'x-actor-admin-tenant': TENANT_US,
      },
      payload: {
        rationale: 'first',
        sampleSize: 1000,
        pValue: 0.01,
      },
    });
    expect(first.statusCode).toBe(200);

    // Second promote — must reject (variant is now `winner`, not `active`).
    const second = await injectWithIdempotency({
      method: 'POST',
      url: `/v0/forms/variants/${variantId}/promote`,
      headers: {
        host: 'localhost',
        'x-actor-id': 'op_http_promote_second',

        'x-actor-roles': 'tenant_admin',

        'x-actor-admin-tenant': TENANT_US,
      },
      payload: {
        rationale: 'second',
        sampleSize: 1000,
        pValue: 0.01,
      },
    });
    expect(second.statusCode).toBe(400);
    const body = second.json<ErrorEnvelopeBody>();
    expect(body.error?.code).toBeDefined();
  });

  it('returns 401 when promoting without an actor identity header', async () => {
    // Same fail-closed gate as createVariantHandler — promote also writes
    // an audit row, so it must refuse to proceed without an actor.
    const programId = `prog_var_http_promote_noactor_${ulid().slice(0, 8)}`;
    const { templateId, deploymentId } = await seedActiveDeployment({
      ctx: US_CTX,
      programId,
    });
    const variantId = await seedControlVariant({
      ctx: US_CTX,
      deploymentId,
      variantTemplateId: templateId,
    });

    const response = await injectWithIdempotency({
      method: 'POST',
      url: `/v0/forms/variants/${variantId}/promote`,
      headers: {
        host: 'localhost',
      },
      payload: {
        rationale: 'r',
        sampleSize: 100,
        pValue: 0.05,
      },
    });
    expect(response.statusCode).toBe(401);
  });

  // Note on "missing variantId in path": Fastify's route matcher for
  // `/v0/forms/variants/:variantId/promote` does not match the URL
  // `/v0/forms/variants//promote` to this handler at all — the empty path
  // segment fails the match, returning a 404 from the framework before
  // promoteVariantHandler runs. The handler's defensive
  // `if (variantIdParam.length === 0)` check exists for type-narrowing
  // but is not reachable through HTTP. Skipping that case per the spec
  // brief's "skip if unreachable" allowance — the missing-id 404 envelope
  // shape is covered by the GET tests above.
});
