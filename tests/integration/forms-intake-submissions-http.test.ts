/**
 * Forms/Intake — submissions HTTP route-level integration tests.
 *
 * Extends the buildApp + Fastify `inject` pattern landed at the snapshot
 * HTTP batch (`forms-intake-snapshot-http.test.ts`) to the four
 * patient-facing submission lifecycle endpoints. These are the highest-
 * traffic patient surfaces in the slice — every test asserts the
 * tenant-blind I-025 envelope discipline + the no-tenant_id-leakage
 * guarantee at the actual HTTP boundary (raw body string + recursive
 * key scan).
 *
 * Spec references:
 *   - Slice PRD v2.1 §7 (onboarding flow), §8 (save-and-resume),
 *     §13 (crisis escalation), §17 (subscription handoff)
 *   - I-013 immutability (in_progress lock)
 *   - I-019 crisis detection platform-floor
 *   - I-023 RLS + tenant context
 *   - I-025 tenant-blind 400/404 envelopes
 *   - I-027 audit emission carries tenant_id
 *   - Master PRD v1.10 §17 + Glossary v5.2 C3 — patient surface MUST
 *     NOT render the operating-tenant identifier
 */

import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../../src/app.ts';
import { ulid } from '../../src/lib/ulid.ts';
import * as submissionService from '../../src/modules/forms-intake/internal/services/submission-service.ts';
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
// Test helpers (mirror the snapshot HTTP test for consistency)
// ---------------------------------------------------------------------------

/**
 * Recursively scan a parsed JSON value for a key matching `targetKey`.
 * Used to catch nested `tenant_id` leaks that a top-level
 * `not.toHaveProperty` check misses. Stack-based traversal mirrors
 * the iterative-scanner discipline established at submissions verify-r2
 * (the crisis scanner closure).
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
  }
  return false;
}

function assertNoTenantIdLeakage(response: { body: string; json: <T>() => T }): void {
  expect(response.body).not.toContain('tenant_id');
  expect(response.body).not.toContain(TENANT_US);
  const parsed = response.json<unknown>();
  expect(findKeyAtAnyDepth(parsed, 'tenant_id')).toBe(false);
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

interface SeededDeployment {
  templateId: string;
  deploymentId: string;
}

async function seedActiveDeployment(): Promise<SeededDeployment> {
  const client = getTestClient();
  const programId = `prog_subhttp_${ulid().slice(0, 8)}`;
  const templateId = ulid();
  const deploymentId = ulid();

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
          1, 'published', $5, $6,
          '{}'::jsonb, '{}'::jsonb,
          '{}'::jsonb, '{}'::jsonb,
          NOW(), NOW(), NOW()
       )`,
      [templateId, TENANT_US, programId, 'US', `test-subhttp-${templateId.slice(0, 8)}`, ulid()],
    );
    await client.query(
      `INSERT INTO forms_deployment (
          deployment_id, tenant_id, template_id, program_id,
          deployed_by, deployed_at,
          created_at, updated_at
       ) VALUES (
          $1, $2, $3, $4,
          $5, NOW(),
          NOW(), NOW()
       )`,
      [deploymentId, TENANT_US, templateId, programId, ulid()],
    );
  });
  return { templateId, deploymentId };
}

const US_HOST = 'localhost'; // maps to Telecheck-US per SUBDOMAIN_TENANT_MAP

// ---------------------------------------------------------------------------
// POST /v0/forms/submissions — startSubmission
// ---------------------------------------------------------------------------

describe('POST /v0/forms/submissions — HTTP-level', () => {
  it('returns 201 + patient-safe body for the owning patient', async () => {
    const { deploymentId } = await seedActiveDeployment();
    const patientId = ulid();

    const response = await app!.inject({
      method: 'POST',
      url: '/v0/forms/submissions',
      headers: {
        host: US_HOST,
        'x-actor-id': 'op_start',
        'x-patient-id': patientId,
        'content-type': 'application/json',
      },
      payload: { deploymentId },
    });

    expect(response.statusCode).toBe(201);
    assertNoTenantIdLeakage(response);

    const body = response.json<Record<string, unknown>>();
    expect(body['deployment_id']).toBe(deploymentId);
    expect(body['patient_id']).toBe(patientId);
    expect(body['status']).toBe('in_progress');
  });

  it('returns 400 tenant-blind when the deployment does not exist', async () => {
    const patientId = ulid();
    const fakeDeploymentId = ulid();

    const response = await app!.inject({
      method: 'POST',
      url: '/v0/forms/submissions',
      headers: {
        host: US_HOST,
        'x-actor-id': 'op_404',
        'x-patient-id': patientId,
        'content-type': 'application/json',
      },
      payload: { deploymentId: fakeDeploymentId },
    });

    expect(response.statusCode).toBe(400);
    const body = response.json<{ error?: { code?: string } }>();
    expect(body.error?.code).toBeDefined();
  });

  it('returns 400 when starting a duplicate in_progress submission for the same tuple', async () => {
    // Migration 008 partial unique index: one in_progress per tuple.
    const { deploymentId } = await seedActiveDeployment();
    const patientId = ulid();

    const first = await app!.inject({
      method: 'POST',
      url: '/v0/forms/submissions',
      headers: {
        host: US_HOST,
        'x-actor-id': 'op_dupe1',
        'x-patient-id': patientId,
        'content-type': 'application/json',
      },
      payload: { deploymentId },
    });
    expect(first.statusCode).toBe(201);

    const second = await app!.inject({
      method: 'POST',
      url: '/v0/forms/submissions',
      headers: {
        host: US_HOST,
        'x-actor-id': 'op_dupe2',
        'x-patient-id': patientId,
        'content-type': 'application/json',
      },
      payload: { deploymentId },
    });
    expect(second.statusCode).toBe(400);
  });

  it('returns 401 when no patient identity header is supplied', async () => {
    const { deploymentId } = await seedActiveDeployment();

    const response = await app!.inject({
      method: 'POST',
      url: '/v0/forms/submissions',
      headers: {
        host: US_HOST,
        'x-actor-id': 'op_noid',
        'content-type': 'application/json',
      },
      payload: { deploymentId },
    });
    expect(response.statusCode).toBe(401);
  });

  it('returns 400 on missing body', async () => {
    const response = await app!.inject({
      method: 'POST',
      url: '/v0/forms/submissions',
      headers: {
        host: US_HOST,
        'x-actor-id': 'op_nobody',
        'x-patient-id': ulid(),
        'content-type': 'application/json',
      },
      payload: {},
    });
    expect(response.statusCode).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// GET /v0/forms/submissions/:submissionId — getSubmission
// ---------------------------------------------------------------------------

describe('GET /v0/forms/submissions/:submissionId — HTTP-level', () => {
  it('returns 200 + patient-safe body for the owning patient', async () => {
    const { deploymentId } = await seedActiveDeployment();
    const patientId = ulid();

    const submission = await withTenantContext(TENANT_US, () =>
      submissionService.startSubmission(
        {
          tenantId: TENANT_US as never,
          displayName: 'Telecheck-US',
          countryOfCare: 'US',
          kmsKeyAlias: 'alias/telecheck-us-data-key',
          consumerDba: 'Heros Health',
          legalEntity: 'Telecheck Health LLC',
          consumerSubdomain: 'heroshealth.com',
        },
        { actorId: 'op_get', patientId, delegateId: null },
        { deploymentId },
        getTestClient(),
      ),
    );

    const response = await app!.inject({
      method: 'GET',
      url: `/v0/forms/submissions/${submission.submission_id}`,
      headers: {
        host: US_HOST,
        'x-patient-id': patientId,
      },
    });

    expect(response.statusCode).toBe(200);
    assertNoTenantIdLeakage(response);
    const body = response.json<Record<string, unknown>>();
    expect(body['submission_id']).toBe(submission.submission_id);
  });

  it('returns 404 tenant-blind for cross-patient access', async () => {
    const { deploymentId } = await seedActiveDeployment();
    const patientA = ulid();
    const patientB = ulid();

    const submission = await withTenantContext(TENANT_US, () =>
      submissionService.startSubmission(
        {
          tenantId: TENANT_US as never,
          displayName: 'Telecheck-US',
          countryOfCare: 'US',
          kmsKeyAlias: 'alias/telecheck-us-data-key',
          consumerDba: 'Heros Health',
          legalEntity: 'Telecheck Health LLC',
          consumerSubdomain: 'heroshealth.com',
        },
        { actorId: 'op_xpat', patientId: patientA, delegateId: null },
        { deploymentId },
        getTestClient(),
      ),
    );

    const response = await app!.inject({
      method: 'GET',
      url: `/v0/forms/submissions/${submission.submission_id}`,
      headers: {
        host: US_HOST,
        'x-patient-id': patientB,
      },
    });
    expect(response.statusCode).toBe(404);
  });

  it('returns 404 for a missing submission_id', async () => {
    const response = await app!.inject({
      method: 'GET',
      url: `/v0/forms/submissions/${ulid()}`,
      headers: {
        host: US_HOST,
        'x-patient-id': ulid(),
      },
    });
    expect(response.statusCode).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// PATCH /v0/forms/submissions/:submissionId/responses — updateResponses
// (auto-save path; pause path tested separately below)
// ---------------------------------------------------------------------------

describe('PATCH /v0/forms/submissions/:submissionId/responses — HTTP-level (auto-save)', () => {
  it('returns 200 + patient-safe merged body for owning patient on auto-save', async () => {
    const { deploymentId } = await seedActiveDeployment();
    const patientId = ulid();

    const submission = await withTenantContext(TENANT_US, () =>
      submissionService.startSubmission(
        {
          tenantId: TENANT_US as never,
          displayName: 'Telecheck-US',
          countryOfCare: 'US',
          kmsKeyAlias: 'alias/telecheck-us-data-key',
          consumerDba: 'Heros Health',
          legalEntity: 'Telecheck Health LLC',
          consumerSubdomain: 'heroshealth.com',
        },
        { actorId: 'op_upd', patientId, delegateId: null },
        { deploymentId },
        getTestClient(),
      ),
    );

    const response = await app!.inject({
      method: 'PATCH',
      url: `/v0/forms/submissions/${submission.submission_id}/responses`,
      headers: {
        host: US_HOST,
        'x-actor-id': 'op_upd',
        'x-patient-id': patientId,
        'content-type': 'application/json',
      },
      payload: { responses: { field_age: 30 } },
    });

    expect(response.statusCode).toBe(200);
    assertNoTenantIdLeakage(response);
    const body = response.json<{ responses: Record<string, unknown> }>();
    expect(body.responses['field_age']).toBe(30);
  });

  it('returns 409 on crisis content (I-019 platform-floor)', async () => {
    const { deploymentId } = await seedActiveDeployment();
    const patientId = ulid();

    const submission = await withTenantContext(TENANT_US, () =>
      submissionService.startSubmission(
        {
          tenantId: TENANT_US as never,
          displayName: 'Telecheck-US',
          countryOfCare: 'US',
          kmsKeyAlias: 'alias/telecheck-us-data-key',
          consumerDba: 'Heros Health',
          legalEntity: 'Telecheck Health LLC',
          consumerSubdomain: 'heroshealth.com',
        },
        { actorId: 'op_crisis', patientId, delegateId: null },
        { deploymentId },
        getTestClient(),
      ),
    );

    const response = await app!.inject({
      method: 'PATCH',
      url: `/v0/forms/submissions/${submission.submission_id}/responses`,
      headers: {
        host: US_HOST,
        'x-actor-id': 'op_crisis',
        'x-patient-id': patientId,
        'content-type': 'application/json',
      },
      // Phrase from CRISIS_PATTERNS.suicidal_ideation.
      payload: { responses: { field_open: 'I want to kill myself' } },
    });

    // Per I-019 platform-floor, crisis detection maps to 409 Conflict
    // with a structured error code (not the generic 4xx) so the patient
    // surface can branch to the crisis-resources path.
    expect(response.statusCode).toBe(409);
  });

  it('returns 404 cross-patient on update', async () => {
    const { deploymentId } = await seedActiveDeployment();
    const patientA = ulid();
    const patientB = ulid();

    const submission = await withTenantContext(TENANT_US, () =>
      submissionService.startSubmission(
        {
          tenantId: TENANT_US as never,
          displayName: 'Telecheck-US',
          countryOfCare: 'US',
          kmsKeyAlias: 'alias/telecheck-us-data-key',
          consumerDba: 'Heros Health',
          legalEntity: 'Telecheck Health LLC',
          consumerSubdomain: 'heroshealth.com',
        },
        { actorId: 'op_xpat_upd', patientId: patientA, delegateId: null },
        { deploymentId },
        getTestClient(),
      ),
    );

    const response = await app!.inject({
      method: 'PATCH',
      url: `/v0/forms/submissions/${submission.submission_id}/responses`,
      headers: {
        host: US_HOST,
        'x-actor-id': 'op_xpat_upd',
        'x-patient-id': patientB,
        'content-type': 'application/json',
      },
      payload: { responses: { f: 'v' } },
    });
    // SUBMISSION_NOT_FOUND on ownership mismatch -> tenant-blind 400 per
    // I-025 (unified envelope for the "in invalid state" sentinels).
    expect(response.statusCode).toBe(400);
  });

  it('returns 401 when no patient identity is supplied', async () => {
    const { deploymentId } = await seedActiveDeployment();
    const patientId = ulid();

    const submission = await withTenantContext(TENANT_US, () =>
      submissionService.startSubmission(
        {
          tenantId: TENANT_US as never,
          displayName: 'Telecheck-US',
          countryOfCare: 'US',
          kmsKeyAlias: 'alias/telecheck-us-data-key',
          consumerDba: 'Heros Health',
          legalEntity: 'Telecheck Health LLC',
          consumerSubdomain: 'heroshealth.com',
        },
        { actorId: 'op_noid', patientId, delegateId: null },
        { deploymentId },
        getTestClient(),
      ),
    );

    const response = await app!.inject({
      method: 'PATCH',
      url: `/v0/forms/submissions/${submission.submission_id}/responses`,
      headers: {
        host: US_HOST,
        'x-actor-id': 'op_noid',
        'content-type': 'application/json',
      },
      payload: { responses: { f: 'v' } },
    });
    expect(response.statusCode).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// PATCH /v0/forms/submissions/:submissionId/responses — pause path
// ---------------------------------------------------------------------------

describe('PATCH /v0/forms/submissions/:submissionId/responses — HTTP-level (pause=true)', () => {
  it('returns 200 + PauseSubmissionResult shape (no tenant_id) for owning patient', async () => {
    const { deploymentId } = await seedActiveDeployment();
    const patientId = ulid();

    const submission = await withTenantContext(TENANT_US, () =>
      submissionService.startSubmission(
        {
          tenantId: TENANT_US as never,
          displayName: 'Telecheck-US',
          countryOfCare: 'US',
          kmsKeyAlias: 'alias/telecheck-us-data-key',
          consumerDba: 'Heros Health',
          legalEntity: 'Telecheck Health LLC',
          consumerSubdomain: 'heroshealth.com',
        },
        { actorId: 'op_pause', patientId, delegateId: null },
        { deploymentId },
        getTestClient(),
      ),
    );

    const response = await app!.inject({
      method: 'PATCH',
      url: `/v0/forms/submissions/${submission.submission_id}/responses`,
      headers: {
        host: US_HOST,
        'x-actor-id': 'op_pause',
        'x-patient-id': patientId,
        'content-type': 'application/json',
      },
      payload: {
        responses: { field_age: 25 },
        pause: true,
      },
    });

    expect(response.statusCode).toBe(200);
    assertNoTenantIdLeakage(response);

    const body = response.json<{
      submission: { submission_id: string };
      resumeState: { resumeStateId: string; resumeToken: string; expiresAt: string };
    }>();
    expect(body.submission.submission_id).toBe(submission.submission_id);
    expect(body.resumeState.resumeStateId).toBeDefined();
    expect(body.resumeState.resumeToken).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(body.resumeState.expiresAt).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// POST /v0/forms/submissions/:submissionId/submit — submitSubmission
// ---------------------------------------------------------------------------

describe('POST /v0/forms/submissions/:submissionId/submit — HTTP-level', () => {
  it('returns 200 + patient-safe submitted body for owning patient', async () => {
    const { deploymentId } = await seedActiveDeployment();
    const patientId = ulid();

    const submission = await withTenantContext(TENANT_US, () =>
      submissionService.startSubmission(
        {
          tenantId: TENANT_US as never,
          displayName: 'Telecheck-US',
          countryOfCare: 'US',
          kmsKeyAlias: 'alias/telecheck-us-data-key',
          consumerDba: 'Heros Health',
          legalEntity: 'Telecheck Health LLC',
          consumerSubdomain: 'heroshealth.com',
        },
        { actorId: 'op_submit', patientId, delegateId: null },
        { deploymentId },
        getTestClient(),
      ),
    );

    const response = await app!.inject({
      method: 'POST',
      url: `/v0/forms/submissions/${submission.submission_id}/submit`,
      headers: {
        host: US_HOST,
        'x-actor-id': 'op_submit',
        'x-patient-id': patientId,
        'content-type': 'application/json',
      },
      payload: {},
    });

    expect(response.statusCode).toBe(200);
    assertNoTenantIdLeakage(response);
    const body = response.json<{ status: string; submitted_at: string | null }>();
    expect(body.status).toBe('submitted');
    expect(body.submitted_at).not.toBeNull();
  });

  it('returns 400 on already-submitted (I-013 immutability)', async () => {
    const { deploymentId } = await seedActiveDeployment();
    const patientId = ulid();

    const submission = await withTenantContext(TENANT_US, () =>
      submissionService.startSubmission(
        {
          tenantId: TENANT_US as never,
          displayName: 'Telecheck-US',
          countryOfCare: 'US',
          kmsKeyAlias: 'alias/telecheck-us-data-key',
          consumerDba: 'Heros Health',
          legalEntity: 'Telecheck Health LLC',
          consumerSubdomain: 'heroshealth.com',
        },
        { actorId: 'op_double', patientId, delegateId: null },
        { deploymentId },
        getTestClient(),
      ),
    );
    await withTenantContext(TENANT_US, () =>
      submissionService.submitSubmission(
        {
          tenantId: TENANT_US as never,
          displayName: 'Telecheck-US',
          countryOfCare: 'US',
          kmsKeyAlias: 'alias/telecheck-us-data-key',
          consumerDba: 'Heros Health',
          legalEntity: 'Telecheck Health LLC',
          consumerSubdomain: 'heroshealth.com',
        },
        { actorId: 'op_double', patientId, delegateId: null },
        submission.submission_id,
        {},
        getTestClient(),
      ),
    );

    const response = await app!.inject({
      method: 'POST',
      url: `/v0/forms/submissions/${submission.submission_id}/submit`,
      headers: {
        host: US_HOST,
        'x-actor-id': 'op_double',
        'x-patient-id': patientId,
        'content-type': 'application/json',
      },
      payload: {},
    });
    expect(response.statusCode).toBe(400);
  });

  it('returns 401 when no patient identity is supplied', async () => {
    const { deploymentId } = await seedActiveDeployment();
    const patientId = ulid();

    const submission = await withTenantContext(TENANT_US, () =>
      submissionService.startSubmission(
        {
          tenantId: TENANT_US as never,
          displayName: 'Telecheck-US',
          countryOfCare: 'US',
          kmsKeyAlias: 'alias/telecheck-us-data-key',
          consumerDba: 'Heros Health',
          legalEntity: 'Telecheck Health LLC',
          consumerSubdomain: 'heroshealth.com',
        },
        { actorId: 'op_subnoid', patientId, delegateId: null },
        { deploymentId },
        getTestClient(),
      ),
    );

    const response = await app!.inject({
      method: 'POST',
      url: `/v0/forms/submissions/${submission.submission_id}/submit`,
      headers: {
        host: US_HOST,
        'x-actor-id': 'op_subnoid',
        'content-type': 'application/json',
      },
      payload: {},
    });
    expect(response.statusCode).toBe(401);
  });
});
