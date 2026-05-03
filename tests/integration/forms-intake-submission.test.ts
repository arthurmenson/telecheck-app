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
// startSubmission — IN_PROGRESS_SUBMISSION_EXISTS (Codex resume-restore-r1
// HIGH closure 2026-05-03)
//
// Migration 008 added a partial unique index preventing more than one
// in_progress submission for the same (tenant, deployment, patient) tuple.
// Without this constraint, the save-and-resume restore path's tuple-based
// (resume_state ↔ submission) reconstruction had an ambiguity bug — a
// patient who started a fresh submission after pausing an earlier one
// would have two in_progress rows, and restore would silently overwrite
// the fresh-start row with the decrypted paused responses.
//
// These tests prove the constraint fires at the application layer with
// the IN_PROGRESS_SUBMISSION_EXISTS sentinel rather than leaking the raw
// `23505` error.
// ---------------------------------------------------------------------------

describe('forms-intake startSubmission — IN_PROGRESS_SUBMISSION_EXISTS', () => {
  it('rejects a second start on the same (deployment, patient) tuple while one is in progress', async () => {
    const programId = `prog_sub_dup_${ulid().slice(0, 8)}`;
    const { deploymentId } = await seedActiveDeployment({ ctx: US_CTX, programId });
    const patientId = ulid();

    // First start succeeds.
    const first = await withTenantContext(TENANT_US, () =>
      submissionService.startSubmission(
        US_CTX,
        { actorId: 'op_dup_first', patientId, delegateId: null },
        { deploymentId },
        getTestClient(),
      ),
    );
    expect(first.status).toBe('in_progress');

    // Second start on the SAME (deployment, patient) tuple while first is
    // still in_progress must reject deterministically — not silently
    // create a sibling row that would later confuse restore.
    await expect(
      withTenantContext(TENANT_US, () =>
        submissionService.startSubmission(
          US_CTX,
          { actorId: 'op_dup_second', patientId, delegateId: null },
          { deploymentId },
          getTestClient(),
        ),
      ),
    ).rejects.toThrow(submissionRepo.IN_PROGRESS_SUBMISSION_EXISTS);
  });

  it('allows a fresh start after the prior submission completes', async () => {
    // Once the first submission is `submitted`, the partial unique index's
    // predicate (`status = 'in_progress'`) no longer matches the prior row
    // so a fresh start succeeds. Confirms the index is genuinely partial
    // and doesn't over-constrain the legitimate one-submission-per-visit
    // pattern.
    const programId = `prog_sub_seq_${ulid().slice(0, 8)}`;
    const { deploymentId } = await seedActiveDeployment({ ctx: US_CTX, programId });
    const patientId = ulid();

    const first = await withTenantContext(TENANT_US, () =>
      submissionService.startSubmission(
        US_CTX,
        { actorId: 'op_seq_a', patientId, delegateId: null },
        { deploymentId },
        getTestClient(),
      ),
    );
    await withTenantContext(TENANT_US, () =>
      submissionService.submitSubmission(
        US_CTX,
        { actorId: 'op_seq_a', patientId, delegateId: null },
        first.submission_id,
        {},
        getTestClient(),
      ),
    );

    // Now fresh start succeeds.
    const second = await withTenantContext(TENANT_US, () =>
      submissionService.startSubmission(
        US_CTX,
        { actorId: 'op_seq_b', patientId, delegateId: null },
        { deploymentId },
        getTestClient(),
      ),
    );
    expect(second.status).toBe('in_progress');
    expect(second.submission_id).not.toBe(first.submission_id);
  });

  it('allows concurrent in_progress submissions for different patients on the same deployment', async () => {
    // The unique index is on (tenant, deployment, patient) — a different
    // patient on the same deployment is unconstrained.
    const programId = `prog_sub_two_${ulid().slice(0, 8)}`;
    const { deploymentId } = await seedActiveDeployment({ ctx: US_CTX, programId });
    const patientA = ulid();
    const patientB = ulid();

    const a = await withTenantContext(TENANT_US, () =>
      submissionService.startSubmission(
        US_CTX,
        { actorId: 'op_two_a', patientId: patientA, delegateId: null },
        { deploymentId },
        getTestClient(),
      ),
    );
    const b = await withTenantContext(TENANT_US, () =>
      submissionService.startSubmission(
        US_CTX,
        { actorId: 'op_two_b', patientId: patientB, delegateId: null },
        { deploymentId },
        getTestClient(),
      ),
    );
    expect(a.status).toBe('in_progress');
    expect(b.status).toBe('in_progress');
    expect(a.submission_id).not.toBe(b.submission_id);
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
      submissionService.getSubmission(
        US_CTX,
        { patientId, delegateId: null },
        submission.submission_id,
        getTestClient(),
      ),
    );
    expect(fetched).not.toBeNull();
    expect(fetched!.submission_id).toBe(submission.submission_id);
    expect(fetched!.status).toBe('in_progress');
  });

  it('returns null on tenant-blind miss', async () => {
    const fakeId = ulid();
    const fakePatient = ulid();
    const result = await withTenantContext(TENANT_US, () =>
      submissionService.getSubmission(
        US_CTX,
        { patientId: fakePatient, delegateId: null },
        fakeId,
        getTestClient(),
      ),
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

// ---------------------------------------------------------------------------
// Codex submissions-r1 regression tests (CRITICAL-1, CRITICAL-2, HIGH)
// ---------------------------------------------------------------------------

describe('forms-intake updateResponses — I-019 crisis detection (CRITICAL-1 closure)', () => {
  it('rejects responses containing crisis text and emits Category A audit', async () => {
    const programId = `prog_crisis_${ulid().slice(0, 8)}`;
    const { deploymentId } = await seedActiveDeployment({ ctx: US_CTX, programId });
    const patientId = ulid();

    const submission = await withTenantContext(TENANT_US, () =>
      submissionService.startSubmission(
        US_CTX,
        { actorId: 'op_crisis', patientId, delegateId: null },
        { deploymentId },
        getTestClient(),
      ),
    );

    // A phrase from CRISIS_PATTERNS.suicidal_ideation regex per
    // crisis-detection.ts.
    const crisisPhrase = 'I want to kill myself';
    await expect(
      withTenantContext(TENANT_US, () =>
        submissionService.updateResponses(
          US_CTX,
          { actorId: 'op_crisis', patientId, delegateId: null },
          submission.submission_id,
          { responses: { field_open_text: crisisPhrase } },
          getTestClient(),
        ),
      ),
    ).rejects.toThrow(submissionService.CRISIS_DETECTED);

    // The Category A `crisis_detection_trigger` audit MUST exist regardless
    // — the responses didn't persist, but the detection event MUST.
    await withTenantContext(TENANT_US, () =>
      assertAuditRecordExists(
        TENANT_US,
        (rec) =>
          rec.action === 'crisis_detection_trigger' &&
          rec.category === 'A' &&
          rec.target_patient_id === patientId &&
          rec.resource_id === submission.submission_id,
      ),
    );

    // The submission row's responses are unchanged (still the empty
    // initial state).
    const client = getTestClient();
    const row = await withTenantContext(TENANT_US, async () => {
      const r = await client.query<{ responses: Record<string, unknown> }>(
        `SELECT responses FROM forms_submission WHERE submission_id = $1`,
        [submission.submission_id],
      );
      return r.rows[0];
    });
    expect(row!.responses).toEqual({});
  });
});

describe('forms-intake — patient ownership (CRITICAL-2 closure)', () => {
  it('returns null when getSubmission is called by a different patient in the same tenant', async () => {
    const programId = `prog_own_get_${ulid().slice(0, 8)}`;
    const { deploymentId } = await seedActiveDeployment({ ctx: US_CTX, programId });
    const patientA = ulid();
    const patientB = ulid();

    const submission = await withTenantContext(TENANT_US, () =>
      submissionService.startSubmission(
        US_CTX,
        { actorId: 'op_a', patientId: patientA, delegateId: null },
        { deploymentId },
        getTestClient(),
      ),
    );

    // Patient B requests Patient A's submission — service returns null
    // (tenant-blind, indistinguishable from "doesn't exist").
    const result = await withTenantContext(TENANT_US, () =>
      submissionService.getSubmission(
        US_CTX,
        { patientId: patientB, delegateId: null },
        submission.submission_id,
        getTestClient(),
      ),
    );
    expect(result).toBeNull();
  });

  it('rejects updateResponses when called by a different patient in the same tenant', async () => {
    const programId = `prog_own_upd_${ulid().slice(0, 8)}`;
    const { deploymentId } = await seedActiveDeployment({ ctx: US_CTX, programId });
    const patientA = ulid();
    const patientB = ulid();

    const submission = await withTenantContext(TENANT_US, () =>
      submissionService.startSubmission(
        US_CTX,
        { actorId: 'op_a', patientId: patientA, delegateId: null },
        { deploymentId },
        getTestClient(),
      ),
    );

    await expect(
      withTenantContext(TENANT_US, () =>
        submissionService.updateResponses(
          US_CTX,
          { actorId: 'op_b', patientId: patientB, delegateId: null },
          submission.submission_id,
          { responses: { field_1: 'hijack attempt' } },
          getTestClient(),
        ),
      ),
    ).rejects.toThrow(submissionRepo.SUBMISSION_NOT_FOUND);
  });

  it('rejects submitSubmission when called by a different patient in the same tenant', async () => {
    const programId = `prog_own_sub_${ulid().slice(0, 8)}`;
    const { deploymentId } = await seedActiveDeployment({ ctx: US_CTX, programId });
    const patientA = ulid();
    const patientB = ulid();

    const submission = await withTenantContext(TENANT_US, () =>
      submissionService.startSubmission(
        US_CTX,
        { actorId: 'op_a', patientId: patientA, delegateId: null },
        { deploymentId },
        getTestClient(),
      ),
    );

    await expect(
      withTenantContext(TENANT_US, () =>
        submissionService.submitSubmission(
          US_CTX,
          { actorId: 'op_b', patientId: patientB, delegateId: null },
          submission.submission_id,
          {},
          getTestClient(),
        ),
      ),
    ).rejects.toThrow(submissionRepo.SUBMISSION_NOT_FOUND);
  });
});

describe('forms-intake — delegate ownership null-safety (verify-r1 HIGH closure)', () => {
  it('rejects a non-delegate update on a delegate-bound submission', async () => {
    const programId = `prog_d_null_${ulid().slice(0, 8)}`;
    const { deploymentId } = await seedActiveDeployment({ ctx: US_CTX, programId });
    const patientId = ulid();
    const delegateId = ulid();

    // Submission created BY a delegate — row.delegate_id is non-null.
    const submission = await withTenantContext(TENANT_US, () =>
      submissionService.startSubmission(
        US_CTX,
        { actorId: 'op_d', patientId, delegateId },
        { deploymentId },
        getTestClient(),
      ),
    );

    // Patient (no delegate) tries to update — must be rejected. Prior to
    // the verify-r1 closure, the SQL `($n IS NULL OR delegate_id = $n)`
    // would short-circuit to TRUE on null delegateId and let the patient
    // self-update through the row. `IS NOT DISTINCT FROM` closes that.
    await expect(
      withTenantContext(TENANT_US, () =>
        submissionService.updateResponses(
          US_CTX,
          { actorId: 'op_self', patientId, delegateId: null },
          submission.submission_id,
          { responses: { field_1: 'self-bypass-attempt' } },
          getTestClient(),
        ),
      ),
    ).rejects.toThrow(submissionRepo.SUBMISSION_NOT_FOUND);
  });

  it('rejects a wrong-delegate update on a delegate-bound submission', async () => {
    const programId = `prog_d_wrong_${ulid().slice(0, 8)}`;
    const { deploymentId } = await seedActiveDeployment({ ctx: US_CTX, programId });
    const patientId = ulid();
    const delegateA = ulid();
    const delegateB = ulid();

    const submission = await withTenantContext(TENANT_US, () =>
      submissionService.startSubmission(
        US_CTX,
        { actorId: 'op_da', patientId, delegateId: delegateA },
        { deploymentId },
        getTestClient(),
      ),
    );

    // Different delegate (same patient) tries to update — rejected.
    await expect(
      withTenantContext(TENANT_US, () =>
        submissionService.updateResponses(
          US_CTX,
          { actorId: 'op_db', patientId, delegateId: delegateB },
          submission.submission_id,
          { responses: { field_1: 'wrong-delegate-attempt' } },
          getTestClient(),
        ),
      ),
    ).rejects.toThrow(submissionRepo.SUBMISSION_NOT_FOUND);
  });
});

describe('forms-intake updateResponses — recursive crisis scan (verify-r1 HIGH closure)', () => {
  it('detects crisis text nested inside an object value', async () => {
    const programId = `prog_nest_${ulid().slice(0, 8)}`;
    const { deploymentId } = await seedActiveDeployment({ ctx: US_CTX, programId });
    const patientId = ulid();

    const submission = await withTenantContext(TENANT_US, () =>
      submissionService.startSubmission(
        US_CTX,
        { actorId: 'op_nest', patientId, delegateId: null },
        { deploymentId },
        getTestClient(),
      ),
    );

    // Crisis text nested inside an object value — top-level scanner
    // would have missed this; the recursive walker catches it.
    await expect(
      withTenantContext(TENANT_US, () =>
        submissionService.updateResponses(
          US_CTX,
          { actorId: 'op_nest', patientId, delegateId: null },
          submission.submission_id,
          {
            responses: {
              field_open: { meta: 'fine', narrative: 'I want to kill myself' },
            },
          },
          getTestClient(),
        ),
      ),
    ).rejects.toThrow(submissionService.CRISIS_DETECTED);
  });

  it('detects crisis text nested inside an array value', async () => {
    const programId = `prog_arr_${ulid().slice(0, 8)}`;
    const { deploymentId } = await seedActiveDeployment({ ctx: US_CTX, programId });
    const patientId = ulid();

    const submission = await withTenantContext(TENANT_US, () =>
      submissionService.startSubmission(
        US_CTX,
        { actorId: 'op_arr', patientId, delegateId: null },
        { deploymentId },
        getTestClient(),
      ),
    );

    await expect(
      withTenantContext(TENANT_US, () =>
        submissionService.updateResponses(
          US_CTX,
          { actorId: 'op_arr', patientId, delegateId: null },
          submission.submission_id,
          {
            responses: {
              symptoms: ['headache', 'I want to kill myself', 'fatigue'],
            },
          },
          getTestClient(),
        ),
      ),
    ).rejects.toThrow(submissionService.CRISIS_DETECTED);
  });

  // verify-r2 HIGH closure 2026-05-03: a deeply-nested response under
  // Fastify's body limit used to overflow the recursive scanner's call
  // stack and surface as a 5xx, bypassing I-019 escalation. The scanner
  // is now iterative; depth 30 is well under the 64 budget so the crisis
  // text at the leaf MUST still be detected.
  it('detects crisis text nested 30 levels deep', async () => {
    const programId = `prog_dp_${ulid().slice(0, 8)}`;
    const { deploymentId } = await seedActiveDeployment({ ctx: US_CTX, programId });
    const patientId = ulid();

    const submission = await withTenantContext(TENANT_US, () =>
      submissionService.startSubmission(
        US_CTX,
        { actorId: 'op_dp', patientId, delegateId: null },
        { deploymentId },
        getTestClient(),
      ),
    );

    // Build a 30-level-deep nested object with crisis text at the leaf.
    let nested: Record<string, unknown> = { narrative: 'I want to kill myself' };
    for (let i = 0; i < 30; i += 1) {
      nested = { wrap: nested };
    }

    await expect(
      withTenantContext(TENANT_US, () =>
        submissionService.updateResponses(
          US_CTX,
          { actorId: 'op_dp', patientId, delegateId: null },
          submission.submission_id,
          { responses: nested },
          getTestClient(),
        ),
      ),
    ).rejects.toThrow(submissionService.CRISIS_DETECTED);
  });

  // verify-r2 HIGH closure 2026-05-03: a payload that exceeds the depth
  // budget MUST surface as a deterministic RESPONSE_PAYLOAD_TOO_LARGE
  // sentinel (handler maps to HTTP 413), NOT as a 5xx stack overflow.
  // The detection skip is not a crisis-detection bypass: no string was
  // ever scanned, so there's no detection to suppress; the rejection
  // gates the whole write.
  it('rejects an over-deep payload with RESPONSE_PAYLOAD_TOO_LARGE', async () => {
    const programId = `prog_ov_${ulid().slice(0, 8)}`;
    const { deploymentId } = await seedActiveDeployment({ ctx: US_CTX, programId });
    const patientId = ulid();

    const submission = await withTenantContext(TENANT_US, () =>
      submissionService.startSubmission(
        US_CTX,
        { actorId: 'op_ov', patientId, delegateId: null },
        { deploymentId },
        getTestClient(),
      ),
    );

    // 100 levels — exceeds the MAX_RESPONSE_DEPTH budget (64).
    let nested: Record<string, unknown> = { leaf: 'benign' };
    for (let i = 0; i < 100; i += 1) {
      nested = { wrap: nested };
    }

    await expect(
      withTenantContext(TENANT_US, () =>
        submissionService.updateResponses(
          US_CTX,
          { actorId: 'op_ov', patientId, delegateId: null },
          submission.submission_id,
          { responses: nested },
          getTestClient(),
        ),
      ),
    ).rejects.toThrow(submissionService.RESPONSE_PAYLOAD_TOO_LARGE);
  });
});

describe('forms-intake updateResponses — JSONB merge preserves prior keys (HIGH closure)', () => {
  it('does not wipe existing keys when a delta is sent', async () => {
    const programId = `prog_merge_${ulid().slice(0, 8)}`;
    const { deploymentId } = await seedActiveDeployment({ ctx: US_CTX, programId });
    const patientId = ulid();

    const submission = await withTenantContext(TENANT_US, () =>
      submissionService.startSubmission(
        US_CTX,
        { actorId: 'op_merge', patientId, delegateId: null },
        { deploymentId },
        getTestClient(),
      ),
    );

    // First save: two fields.
    await withTenantContext(TENANT_US, () =>
      submissionService.updateResponses(
        US_CTX,
        { actorId: 'op_merge', patientId, delegateId: null },
        submission.submission_id,
        { responses: { field_age: 30, field_name: 'Pat' } },
        getTestClient(),
      ),
    );

    // Second save: only `field_age` updated. `field_name` MUST be
    // preserved (this was the prior-implementation data-loss bug).
    const after = await withTenantContext(TENANT_US, () =>
      submissionService.updateResponses(
        US_CTX,
        { actorId: 'op_merge', patientId, delegateId: null },
        submission.submission_id,
        { responses: { field_age: 31 } },
        getTestClient(),
      ),
    );
    expect(after.responses).toEqual({ field_age: 31, field_name: 'Pat' });
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
