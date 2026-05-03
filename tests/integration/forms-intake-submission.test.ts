/**
 * Forms/Intake — submission lifecycle integration tests.
 *
 * Covers all four patient-facing handlers via the service layer with
 * externalTx threaded through (publishVersion-r1 MEDIUM closure pattern):
 *
 *   - startSubmission: happy path (creates row, emits Category C audit
 *     + intake_response.started event), DEPLOYMENT_NOT_FOUND on retired
 *     deployment, cross-tenant denial.
 *   - getSubmission: hit / tenant-blind miss.
 *   - updateResponses: happy path, NOT_IN_PROGRESS on already-submitted
 *     row, NOT_FOUND on cross-tenant.
 *   - submitSubmission: happy path (status flip to 'submitted',
 *     submitted_at set, audit + intake_response.submitted event),
 *     NOT_IN_PROGRESS on second submit.
 *
 * Spec references:
 *   - Slice PRD v2.1 §7 onboarding flow, §8 save-and-resume.
 *   - I-013 (in_progress immutability for status-flipped rows).
 *   - I-016 (domain event durability, same-tx outbox).
 *   - I-023 / I-027 (cross-tenant denial via RLS).
 *   - AUDIT_EVENTS v5.2 §Category C operational catalog.
 */

import { describe, expect, it } from 'vitest';

import { asTenantId } from '../../src/lib/glossary.ts';
import type { TenantContext } from '../../src/lib/tenant-context.ts';
import { ulid } from '../../src/lib/ulid.ts';
import * as submissionRepo from '../../src/modules/forms-intake/internal/repositories/submission-repo.ts';
import * as submissionService from '../../src/modules/forms-intake/internal/services/submission-service.ts';
import { assertAuditRecordExists } from '../helpers/audit-assertions.ts';
import { TENANT_GHANA, TENANT_US, withTenantContext } from '../helpers/tenant-fixtures.ts';
import { getTestClient } from '../setup.ts';

// ---------------------------------------------------------------------------
// Fixtures
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

const GH_CTX: TenantContext = {
  tenantId: asTenantId(TENANT_GHANA),
  displayName: 'Telecheck-Ghana',
  countryOfCare: 'GH',
  kmsKeyAlias: 'alias/telecheck-gh-data-key',
  consumerDba: 'Heros Health Ghana',
  legalEntity: 'Telecheck-Ghana Ltd.',
  consumerSubdomain: 'ghana.heroshealth.com',
};

interface SeededDeployment {
  templateId: string;
  deploymentId: string;
}

/**
 * Insert a published template + active deployment for the active tenant
 * so `startSubmission` has a target. Mirrors the helper from
 * forms-intake-admin.test.ts.
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
        `test-submission-${templateId.slice(0, 8)}`,
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

// ---------------------------------------------------------------------------
// startSubmission
// ---------------------------------------------------------------------------

describe('forms-intake startSubmission — happy path', () => {
  it('creates an in_progress submission and emits Category C audit + intake_response.started event', async () => {
    const programId = `prog_sub_start_${ulid().slice(0, 8)}`;
    const { deploymentId } = await seedActiveDeployment({ ctx: US_CTX, programId });
    const patientId = ulid();

    const submission = await withTenantContext(TENANT_US, () =>
      submissionService.startSubmission(
        US_CTX,
        { actorId: 'op_start', patientId, delegateId: null },
        { deploymentId },
        getTestClient(),
      ),
    );

    expect(submission.status).toBe('in_progress');
    expect(submission.deployment_id).toBe(deploymentId);
    expect(submission.patient_id).toBe(patientId);
    expect(submission.submitted_at).toBeNull();

    // Category C audit emitted.
    await withTenantContext(TENANT_US, () =>
      assertAuditRecordExists(
        TENANT_US,
        (rec) =>
          rec.action === ('forms_submission_started' as typeof rec.action) &&
          rec.category === 'C' &&
          rec.resource_id === submission.submission_id &&
          rec.target_patient_id === patientId,
      ),
    );

    // Domain event in outbox: aggregate intake_response, event started.
    const client = getTestClient();
    const event = await withTenantContext(TENANT_US, async () => {
      const r = await client.query<{ payload: Record<string, unknown> }>(
        `SELECT payload FROM domain_events_outbox
          WHERE tenant_id = $1
            AND aggregate_id = $2
            AND event_type = 'intake_response.started'`,
        [TENANT_US, submission.submission_id],
      );
      return r.rows[0];
    });
    expect(event).toBeDefined();
    expect(event!.payload['submission_id']).toBe(submission.submission_id);
    expect(event!.payload['patient_id']).toBe(patientId);
  });
});

describe('forms-intake startSubmission — DEPLOYMENT_NOT_FOUND', () => {
  it('rejects when the deployment is retired', async () => {
    const programId = `prog_sub_retired_${ulid().slice(0, 8)}`;
    const { deploymentId } = await seedActiveDeployment({
      ctx: US_CTX,
      programId,
      retired: true,
    });
    const patientId = ulid();

    await expect(
      withTenantContext(TENANT_US, () =>
        submissionService.startSubmission(
          US_CTX,
          { actorId: 'op_retired', patientId, delegateId: null },
          { deploymentId },
          getTestClient(),
        ),
      ),
    ).rejects.toThrow(submissionRepo.DEPLOYMENT_NOT_FOUND);
  });

  it('rejects when the deployment is cross-tenant (RLS hides it from the service)', async () => {
    const programId = `prog_sub_xten_${ulid().slice(0, 8)}`;
    const { deploymentId } = await seedActiveDeployment({ ctx: US_CTX, programId });
    const patientId = ulid();

    await expect(
      withTenantContext(TENANT_GHANA, () =>
        submissionService.startSubmission(
          GH_CTX,
          { actorId: 'op_xten', patientId, delegateId: null },
          { deploymentId },
          getTestClient(),
        ),
      ),
    ).rejects.toThrow(submissionRepo.DEPLOYMENT_NOT_FOUND);
  });
});

// ---------------------------------------------------------------------------
// getSubmission
// ---------------------------------------------------------------------------

describe('forms-intake getSubmission', () => {
  it('returns the submission when it exists in the active tenant', async () => {
    const programId = `prog_sub_get_${ulid().slice(0, 8)}`;
    const { deploymentId } = await seedActiveDeployment({ ctx: US_CTX, programId });
    const patientId = ulid();

    const submission = await withTenantContext(TENANT_US, () =>
      submissionService.startSubmission(
        US_CTX,
        { actorId: 'op_get', patientId, delegateId: null },
        { deploymentId },
        getTestClient(),
      ),
    );

    const fetched = await withTenantContext(TENANT_US, () =>
      submissionService.getSubmission(US_CTX, submission.submission_id, getTestClient()),
    );
    expect(fetched).not.toBeNull();
    expect(fetched!.submission_id).toBe(submission.submission_id);
    expect(fetched!.status).toBe('in_progress');
  });

  it('returns null on tenant-blind miss', async () => {
    const fakeId = ulid();
    const result = await withTenantContext(TENANT_US, () =>
      submissionService.getSubmission(US_CTX, fakeId, getTestClient()),
    );
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// updateResponses
// ---------------------------------------------------------------------------

describe('forms-intake updateResponses — happy path', () => {
  it('persists partial responses on an in_progress submission', async () => {
    const programId = `prog_sub_upd_${ulid().slice(0, 8)}`;
    const { deploymentId } = await seedActiveDeployment({ ctx: US_CTX, programId });
    const patientId = ulid();

    const submission = await withTenantContext(TENANT_US, () =>
      submissionService.startSubmission(
        US_CTX,
        { actorId: 'op_upd', patientId, delegateId: null },
        { deploymentId },
        getTestClient(),
      ),
    );

    const updated = await withTenantContext(TENANT_US, () =>
      submissionService.updateResponses(
        US_CTX,
        { actorId: 'op_upd', patientId, delegateId: null },
        submission.submission_id,
        { responses: { field_1: 'answer A', field_2: 42 } },
        getTestClient(),
      ),
    );

    expect(updated.status).toBe('in_progress');
    expect(updated.responses).toEqual({ field_1: 'answer A', field_2: 42 });
  });
});

describe('forms-intake updateResponses — NOT_IN_PROGRESS / NOT_FOUND', () => {
  it('rejects updates after the submission is submitted', async () => {
    // Keep prefix short — forms_template.program_id is VARCHAR(26).
    const programId = `prog_lk_${ulid().slice(0, 8)}`;
    const { deploymentId } = await seedActiveDeployment({ ctx: US_CTX, programId });
    const patientId = ulid();

    const submission = await withTenantContext(TENANT_US, () =>
      submissionService.startSubmission(
        US_CTX,
        { actorId: 'op_locked', patientId, delegateId: null },
        { deploymentId },
        getTestClient(),
      ),
    );

    await withTenantContext(TENANT_US, () =>
      submissionService.submitSubmission(
        US_CTX,
        { actorId: 'op_locked', patientId, delegateId: null },
        submission.submission_id,
        {},
        getTestClient(),
      ),
    );

    await expect(
      withTenantContext(TENANT_US, () =>
        submissionService.updateResponses(
          US_CTX,
          { actorId: 'op_locked', patientId, delegateId: null },
          submission.submission_id,
          { responses: { field_1: 'too late' } },
          getTestClient(),
        ),
      ),
    ).rejects.toThrow(submissionRepo.SUBMISSION_NOT_IN_PROGRESS);
  });

  it('rejects updates on a non-existent submission with NOT_FOUND', async () => {
    const fakeId = ulid();
    const patientId = ulid();
    await expect(
      withTenantContext(TENANT_US, () =>
        submissionService.updateResponses(
          US_CTX,
          { actorId: 'op_missing', patientId, delegateId: null },
          fakeId,
          { responses: {} },
          getTestClient(),
        ),
      ),
    ).rejects.toThrow(submissionRepo.SUBMISSION_NOT_FOUND);
  });
});

// ---------------------------------------------------------------------------
// submitSubmission
// ---------------------------------------------------------------------------

describe('forms-intake submitSubmission — happy path', () => {
  it('flips status to submitted, sets submitted_at, emits audit + intake_response.submitted event', async () => {
    const programId = `prog_sub_submit_${ulid().slice(0, 8)}`;
    const { deploymentId } = await seedActiveDeployment({ ctx: US_CTX, programId });
    const patientId = ulid();

    const submission = await withTenantContext(TENANT_US, () =>
      submissionService.startSubmission(
        US_CTX,
        { actorId: 'op_submit', patientId, delegateId: null },
        { deploymentId },
        getTestClient(),
      ),
    );

    const submitted = await withTenantContext(TENANT_US, () =>
      submissionService.submitSubmission(
        US_CTX,
        { actorId: 'op_submit', patientId, delegateId: null },
        submission.submission_id,
        { attestation: { acceptedTerms: true, acceptedPrivacy: true } },
        getTestClient(),
      ),
    );

    expect(submitted.status).toBe('submitted');
    expect(submitted.submitted_at).not.toBeNull();
    expect(submitted.submission_id).toBe(submission.submission_id);

    // Category C audit emitted with action forms_submission_completed.
    await withTenantContext(TENANT_US, () =>
      assertAuditRecordExists(
        TENANT_US,
        (rec) =>
          rec.action === ('forms_submission_completed' as typeof rec.action) &&
          rec.category === 'C' &&
          rec.resource_id === submission.submission_id &&
          rec.target_patient_id === patientId,
      ),
    );

    // intake_response.submitted event in outbox.
    const client = getTestClient();
    const event = await withTenantContext(TENANT_US, async () => {
      const r = await client.query<{ payload: Record<string, unknown> }>(
        `SELECT payload FROM domain_events_outbox
          WHERE tenant_id = $1
            AND aggregate_id = $2
            AND event_type = 'intake_response.submitted'`,
        [TENANT_US, submission.submission_id],
      );
      return r.rows[0];
    });
    expect(event).toBeDefined();
    expect(event!.payload['mode_2_eligible']).toBe(false);
  });
});

describe('forms-intake submitSubmission — already-submitted', () => {
  it('rejects a second submit on the same row with SUBMISSION_NOT_IN_PROGRESS', async () => {
    const programId = `prog_sub_double_${ulid().slice(0, 8)}`;
    const { deploymentId } = await seedActiveDeployment({ ctx: US_CTX, programId });
    const patientId = ulid();

    const submission = await withTenantContext(TENANT_US, () =>
      submissionService.startSubmission(
        US_CTX,
        { actorId: 'op_double', patientId, delegateId: null },
        { deploymentId },
        getTestClient(),
      ),
    );

    await withTenantContext(TENANT_US, () =>
      submissionService.submitSubmission(
        US_CTX,
        { actorId: 'op_double', patientId, delegateId: null },
        submission.submission_id,
        {},
        getTestClient(),
      ),
    );

    await expect(
      withTenantContext(TENANT_US, () =>
        submissionService.submitSubmission(
          US_CTX,
          { actorId: 'op_double', patientId, delegateId: null },
          submission.submission_id,
          {},
          getTestClient(),
        ),
      ),
    ).rejects.toThrow(submissionRepo.SUBMISSION_NOT_IN_PROGRESS);
  });
});
