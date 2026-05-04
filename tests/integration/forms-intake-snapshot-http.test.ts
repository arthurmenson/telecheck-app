/**
 * Forms/Intake — snapshot HTTP route-level integration tests.
 *
 * Closes the residual coverage gap Codex flagged on the snapshot HTTP
 * handler batch: prior tests exercise the service projection through
 * `snapshotToPatientView`, but did NOT prove the actual HTTP response
 * body is byte-clean of `tenant_id` after Fastify serialization.
 *
 * **Test pattern (NEW for this repo):** buildApp + Fastify `inject` per
 * the bootstrap pattern referenced in src/app.ts. The pattern is wired
 * here for the first time; future handler tests can adopt the same
 * shape incrementally.
 *
 * Spec references:
 *   - Slice PRD v2.1 §3 (patient actor surface), §4 (snapshot layer)
 *   - I-013 immutability analog
 *   - I-023 tenant context resolution + RLS
 *   - I-025 tenant-blind 404 envelopes
 *   - I-027 audit-records carry tenant_id
 *   - Master PRD v1.10 §17 + Glossary v5.2 C3 — patient surface MUST NOT
 *     render the operating-tenant identifier
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
  // ALLOW_ACTOR_HEADER_AUTH gates the patient/actor shim at the handler
  // boundary; under NODE_ENV=test the shim accepts headers without the
  // opt-in. Confirm here that the test harness is configured as expected.
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
// Fixtures (mirror the seedActiveDeployment + start-then-submit pipeline used
// across the rest of the suite, but seeded here directly so this test file
// is self-contained.)
// ---------------------------------------------------------------------------

interface SeededFixture {
  templateId: string;
  deploymentId: string;
  submissionId: string;
  patientId: string;
}

async function seedSubmittedSubmission(): Promise<SeededFixture> {
  const client = getTestClient();
  const programId = `prog_snap_http_${ulid().slice(0, 8)}`;
  const templateId = ulid();
  const deploymentId = ulid();
  const patientId = ulid();

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
      [templateId, TENANT_US, programId, 'US', `test-snap-http-${templateId.slice(0, 8)}`, ulid()],
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

  // Build a real submission via the service so the same-tx outbox runs.
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
      { actorId: 'op_http', patientId, delegateId: null },
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
      { actorId: 'op_http', patientId, delegateId: null },
      submission.submission_id,
      {},
      getTestClient(),
    ),
  );

  return {
    templateId,
    deploymentId,
    submissionId: submission.submission_id,
    patientId,
  };
}

// ---------------------------------------------------------------------------
// HTTP-level snapshot read path
// ---------------------------------------------------------------------------

describe('GET /v0/forms/submissions/:submissionId/snapshot — HTTP-level', () => {
  it('returns 200 + patient-safe body (no tenant_id) for the owning patient', async () => {
    const { submissionId, patientId } = await seedSubmittedSubmission();

    const response = await app!.inject({
      method: 'GET',
      url: `/v0/forms/submissions/${submissionId}/snapshot`,
      headers: {
        host: 'localhost',
        'x-patient-id': patientId,
      },
    });

    expect(response.statusCode).toBe(200);

    // Parse the response body as JSON. The snapshot is the patient-safe
    // projection, so tenant_id MUST NOT appear at the top level.
    const body = response.json<Record<string, unknown>>();
    expect(body).not.toHaveProperty('tenant_id');
    // Spot-check kept fields.
    expect(body['submission_id']).toBe(submissionId);
    expect(body).toHaveProperty('snapshot_id');
    expect(body).toHaveProperty('template_id');
    expect(body).toHaveProperty('template_version');
    expect(body).toHaveProperty('presented_content');
    expect(body).toHaveProperty('created_at');

    // Defense-in-depth: the raw response body string must not contain the
    // operating-tenant identifier anywhere (catches accidental nesting).
    expect(response.body).not.toContain('Telecheck-US');
  });

  it('returns 404 when a different patient presents a valid submission_id', async () => {
    const { submissionId } = await seedSubmittedSubmission();
    const wrongPatientId = ulid();

    const response = await app!.inject({
      method: 'GET',
      url: `/v0/forms/submissions/${submissionId}/snapshot`,
      headers: {
        host: 'localhost',
        'x-patient-id': wrongPatientId,
      },
    });

    expect(response.statusCode).toBe(404);
    // I-025 tenant-blind: the message should not differentiate "doesn't
    // exist" from "exists in another tenant" or "owned by another
    // patient". The error envelope plugin's canonical shape applies.
    const body = response.json<{ error?: { code?: string } }>();
    expect(body.error?.code).toBeDefined();
  });

  it('returns 401 when no patient identity header is supplied', async () => {
    const { submissionId } = await seedSubmittedSubmission();

    const response = await app!.inject({
      method: 'GET',
      url: `/v0/forms/submissions/${submissionId}/snapshot`,
      headers: {
        host: 'localhost',
      },
    });

    expect(response.statusCode).toBe(401);
  });
});

describe('GET /v0/forms/snapshots/:snapshotId — HTTP-level', () => {
  it('returns 200 + patient-safe body for the owning patient', async () => {
    const { submissionId, patientId } = await seedSubmittedSubmission();

    // Look up the snapshot_id via the by-submission endpoint (the only
    // direct surface; it's also test infrastructure for the next call).
    const submissionResp = await app!.inject({
      method: 'GET',
      url: `/v0/forms/submissions/${submissionId}/snapshot`,
      headers: { host: 'localhost', 'x-patient-id': patientId },
    });
    expect(submissionResp.statusCode).toBe(200);
    const snapshotId = submissionResp.json<{ snapshot_id: string }>().snapshot_id;

    // Now hit the by-id route.
    const byIdResp = await app!.inject({
      method: 'GET',
      url: `/v0/forms/snapshots/${snapshotId}`,
      headers: {
        host: 'localhost',
        'x-patient-id': patientId,
      },
    });
    expect(byIdResp.statusCode).toBe(200);
    const body = byIdResp.json<Record<string, unknown>>();
    expect(body).not.toHaveProperty('tenant_id');
    expect(body['snapshot_id']).toBe(snapshotId);
  });

  it('returns 404 for a non-existent snapshot_id', async () => {
    const { patientId } = await seedSubmittedSubmission();

    const response = await app!.inject({
      method: 'GET',
      url: `/v0/forms/snapshots/${ulid()}`,
      headers: {
        host: 'localhost',
        'x-patient-id': patientId,
      },
    });
    expect(response.statusCode).toBe(404);
  });
});
