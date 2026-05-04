/**
 * submission-service.getSubmission() — delegate-rotation cross-check coverage.
 *
 * The function comment in `submission-service.ts:getSubmission` calls
 * out two cross-checks AFTER the tenant-scope RLS filter:
 *
 *   1. Patient-level: `submission.patient_id !== ownership.patientId` → null
 *      (Codex submissions-r1 CRITICAL-2 closure 2026-05-03 — direct
 *       cross-patient PHI leak prevention)
 *
 *   2. Delegate-rotation: `submission.delegate_id !== null && submission.
 *      delegate_id !== ownership.delegateId` → null
 *      ("no rotating delegates mid-flow")
 *
 * The CRITICAL-2 patient-level check is covered by the
 * "patient ownership (CRITICAL-2 closure)" describe block in
 * forms-intake-submission.test.ts. The DELEGATE check has zero direct
 * coverage — every existing call site passes `delegateId: null` to
 * both `startSubmission` and `getSubmission`, so the code path
 * `submission.delegate_id !== null && submission.delegate_id !== X`
 * is never exercised at runtime.
 *
 * Why this matters:
 *   Per Slice PRD v2.1 §3, intake forms can be completed by a
 *   delegate (e.g., a parent on behalf of a minor; a caregiver on
 *   behalf of an elderly patient). The delegate's identity is bound
 *   to the submission row at start time. A regression that drops the
 *   delegate-comparison gate would let:
 *     - A different delegate (e.g., a swapped account) read the
 *       in-progress submission, mid-flow
 *     - The patient themselves read a delegate-bound submission
 *       directly (bypassing the delegate context — which may be
 *       intentional in some flows but MUST be a deliberate decision,
 *       not an accidental fall-through)
 *
 *   Both are I-024-adjacent failures (cross-actor access to PHI without
 *   break-glass) — bounded by the patient match but still a leak across
 *   the delegate boundary.
 *
 * Coverage in this file (1 section, 4 cases):
 *
 *   §1 getSubmission — delegate-rotation gate:
 *      §1a happy path: same patient + same delegate → submission returned
 *      §1b different delegate → null (the rotating-delegate gate fires)
 *      §1c patient direct read (ownership.delegateId=null) of a
 *          delegate-bound submission → null (patient cannot bypass
 *          delegate context implicitly)
 *      §1d different patient + same delegate → null (cross-patient via
 *          shared delegate session — the patient gate fires before the
 *          delegate gate, but pin the joint behavior)
 *
 * Spec references:
 *   - Slice PRD v2.1 §3 + §18 (delegate intake model)
 *   - I-023 (three-layer tenant isolation; delegate-rotation is the
 *     within-tenant equivalent of cross-actor access)
 *   - I-024 (cross-tenant access requires break-glass; the delegate
 *     gate is the bounded-scope equivalent that prevents accidental
 *     cross-actor reads inside one tenant)
 *   - I-025 (tenant-blind null on miss — the function returns null,
 *     not a thrown sentinel, so wire shape matches "row absent")
 */

import { describe, expect, it } from 'vitest';

import { asTenantId, type TenantId } from '../../src/lib/glossary.ts';
import type { TenantContext } from '../../src/lib/tenant-context.ts';
import { ulid } from '../../src/lib/ulid.ts';
import * as submissionService from '../../src/modules/forms-intake/internal/services/submission-service.ts';
import type { FormDeploymentId } from '../../src/modules/forms-intake/internal/types.ts';
import { TENANT_US, withTenantContext } from '../helpers/tenant-fixtures.ts';
import { getTestClient } from '../setup.ts';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const T_US: TenantId = asTenantId(TENANT_US);

const US_CTX: TenantContext = {
  tenantId: T_US,
  displayName: 'Telecheck-US',
  countryOfCare: 'US',
  kmsKeyAlias: 'alias/telecheck-us-data-key',
  consumerDba: 'Heros Health',
  legalEntity: 'Telecheck Health LLC',
  consumerSubdomain: 'heroshealth.com',
};

/**
 * Inline a published template + active deployment so `startSubmission`
 * has a target. Mirrors `seedActiveDeployment` from
 * forms-intake-submission.test.ts but kept LOCAL so this file is
 * self-contained and a future refactor of the shared helper doesn't
 * silently break the delegate gate test.
 */
async function seedActiveDeployment(programId: string): Promise<{
  deploymentId: FormDeploymentId;
}> {
  const client = getTestClient();
  const templateId = ulid();
  const deploymentId = ulid();
  await withTenantContext(T_US, async () => {
    await client.query(
      `INSERT INTO forms_template (
          template_id, tenant_id, program_id, country_of_care,
          template_version, status, name, created_by,
          presentation_content, branching_logic,
          eligibility_logic, approval_governance,
          published_at, created_at, updated_at
       ) VALUES ($1, $2, $3, 'US', 1, 'published', $4, $5,
                 '{}'::jsonb, '{}'::jsonb,
                 '{}'::jsonb, '{}'::jsonb,
                 NOW(), NOW(), NOW())`,
      [templateId, T_US, programId, `delegate-test-${templateId.slice(0, 8)}`, ulid()],
    );
    await client.query(
      `INSERT INTO forms_deployment (
          deployment_id, tenant_id, template_id, program_id,
          deployed_by, deployed_at, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, $5, NOW(), NOW(), NOW())`,
      [deploymentId, T_US, templateId, programId, ulid()],
    );
  });
  return { deploymentId: deploymentId };
}

// ---------------------------------------------------------------------------
// §1 — getSubmission delegate-rotation cross-check
// ---------------------------------------------------------------------------

describe('submissionService.getSubmission — delegate-rotation cross-check', () => {
  it('§1a happy path: same patient + same delegate → submission returned', async () => {
    const programId = `prog_del_a_${ulid().slice(-8)}`;
    const { deploymentId } = await seedActiveDeployment(programId);
    const patientId = ulid();
    const delegateId = `del_${ulid().slice(-10)}`;

    const submission = await withTenantContext(T_US, () =>
      submissionService.startSubmission(
        US_CTX,
        { actorId: 'op_del_a', patientId, delegateId },
        { deploymentId },
        getTestClient(),
      ),
    );
    expect(submission.delegate_id).toBe(delegateId);

    const fetched = await withTenantContext(T_US, () =>
      submissionService.getSubmission(
        US_CTX,
        { patientId, delegateId },
        submission.submission_id,
        getTestClient(),
      ),
    );
    expect(fetched).not.toBeNull();
    expect(fetched!.submission_id).toBe(submission.submission_id);
    expect(fetched!.delegate_id).toBe(delegateId);
  });

  it('§1b returns null when ownership.delegateId is a DIFFERENT delegate (rotating-delegate gate)', async () => {
    const programId = `prog_del_b_${ulid().slice(-8)}`;
    const { deploymentId } = await seedActiveDeployment(programId);
    const patientId = ulid();
    const ownerDelegate = `del_owner_${ulid().slice(-8)}`;
    const otherDelegate = `del_other_${ulid().slice(-8)}`;

    const submission = await withTenantContext(T_US, () =>
      submissionService.startSubmission(
        US_CTX,
        { actorId: 'op_del_b', patientId, delegateId: ownerDelegate },
        { deploymentId },
        getTestClient(),
      ),
    );

    // Same patient, but a different delegate is requesting the read.
    // The rotating-delegate gate must fire — `submission.delegate_id`
    // is not null AND is not equal to ownership.delegateId.
    const fetched = await withTenantContext(T_US, () =>
      submissionService.getSubmission(
        US_CTX,
        { patientId, delegateId: otherDelegate },
        submission.submission_id,
        getTestClient(),
      ),
    );
    expect(fetched).toBeNull();
  });

  it('§1c returns null when ownership.delegateId=null (patient direct read of delegate-bound submission)', async () => {
    // The rotating-delegate gate's exact comparison:
    //   submission.delegate_id !== null && submission.delegate_id !== ownership.delegateId
    // For a delegate-bound submission (submission.delegate_id != null)
    // and ownership.delegateId=null, the second comparand evaluates to
    // null !== <real_delegate_id>, which is true → the gate returns null.
    //
    // This pins that a patient cannot bypass delegate context
    // implicitly — they cannot read their own delegate-bound
    // submission by simply omitting the delegate context. The
    // patient app/clinician console MUST use the right session shape.
    const programId = `prog_del_c_${ulid().slice(-8)}`;
    const { deploymentId } = await seedActiveDeployment(programId);
    const patientId = ulid();
    const delegateId = `del_owner_${ulid().slice(-8)}`;

    const submission = await withTenantContext(T_US, () =>
      submissionService.startSubmission(
        US_CTX,
        { actorId: 'op_del_c', patientId, delegateId },
        { deploymentId },
        getTestClient(),
      ),
    );
    expect(submission.delegate_id).toBe(delegateId);

    const fetched = await withTenantContext(T_US, () =>
      submissionService.getSubmission(
        US_CTX,
        { patientId, delegateId: null },
        submission.submission_id,
        getTestClient(),
      ),
    );
    expect(fetched).toBeNull();
  });

  it('§1d returns null when patient differs (cross-patient gate fires before delegate gate)', async () => {
    // Belt-and-suspenders: a different patient + the SAME delegate
    // must still return null (the patient gate fires first; the
    // delegate gate is a defense-in-depth follow-on). Pin the joint
    // behavior so a refactor that swaps the gate order doesn't
    // accidentally let a delegate read across patients.
    const programId = `prog_del_d_${ulid().slice(-8)}`;
    const { deploymentId } = await seedActiveDeployment(programId);
    const ownerPatient = ulid();
    const otherPatient = ulid();
    const sharedDelegate = `del_shared_${ulid().slice(-8)}`;

    const submission = await withTenantContext(T_US, () =>
      submissionService.startSubmission(
        US_CTX,
        { actorId: 'op_del_d', patientId: ownerPatient, delegateId: sharedDelegate },
        { deploymentId },
        getTestClient(),
      ),
    );

    const fetched = await withTenantContext(T_US, () =>
      submissionService.getSubmission(
        US_CTX,
        { patientId: otherPatient, delegateId: sharedDelegate },
        submission.submission_id,
        getTestClient(),
      ),
    );
    expect(fetched).toBeNull();
  });
});
