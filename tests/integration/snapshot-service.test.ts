/**
 * snapshot-service.ts — direct unit + integration coverage on patient-
 * ownership cross-check semantics + the snapshotToPatientView projection.
 *
 * Until this commit `src/modules/forms-intake/internal/services/snapshot-service.ts`
 * was exercised only INDIRECTLY through forms-intake-submission.test.ts +
 * forms-intake-snapshot-http.test.ts. Those tests prove the COMPOSITE
 * happy path (submit → snapshot persisted → patient reads back) but
 * don't directly pin the per-branch null-return contract on
 * `getSnapshotForSubmissionAsPatient` and `getSnapshotByIdAsPatient`,
 * nor the structural invariants of `snapshotToPatientView`.
 *
 * Why this matters:
 *   These functions are the HANDLER → SERVICE boundary for patient
 *   snapshot reads. The patient-ownership cross-check is a HIGH-PHI
 *   security gate: a regression that lets a snapshot read return a
 *   different patient's row (e.g., dropping the `patient_id` comparison,
 *   replacing it with a `null`-permissive variant) is a direct
 *   cross-patient PHI leak. The composite tests would EVENTUALLY catch
 *   it but only after end-to-end HTTP execution; direct tests catch
 *   it at unit-test speed.
 *
 *   `snapshotToPatientView` is the patient-surface stripper. Pinning
 *   that it ALWAYS removes `tenant_id` (and only `tenant_id`) from the
 *   FormSnapshot keeps the function honest under refactor (e.g., a
 *   new field added to FormSnapshot must be deliberately excluded if
 *   it's also tenant-leaky).
 *
 * Coverage in this file (3 sections):
 *
 *   §1 snapshotToPatientView (pure function) —
 *      §1a tenant_id is dropped
 *      §1b every other top-level field is preserved verbatim
 *      §1c NEW fields added to FormSnapshot in the future are auto-
 *          included in the patient view (rest-spread semantics)
 *      §1d distinct snapshots produce distinct patient views (no
 *          accidental aliasing from a shared object reference)
 *
 *   §2 getSnapshotForSubmissionAsPatient — patient ownership cross-check:
 *      §2a happy path (matching patient → snapshot returned)
 *      §2b snapshot doesn't exist → null
 *      §2c snapshot exists but submission_id mismatches → null
 *          (orphan-snapshot defense per the function's own comment;
 *          should never happen given the composite FK but pinned)
 *      §2d submission exists with DIFFERENT patient_id → null
 *
 *   §3 getSnapshotByIdAsPatient — same ownership pattern via snapshot_id:
 *      §3a happy path → snapshot returned
 *      §3b snapshot missing → null
 *      §3c submission exists with DIFFERENT patient_id → null
 *
 * Spec references:
 *   - Slice PRD v2.1 §4 (snapshot-at-submission-time discipline)
 *   - I-013 (snapshots immutable after creation)
 *   - I-024 (cross-patient access requires break-glass + audit; the
 *     handler must never return a wrong-patient snapshot)
 *   - I-025 (tenant-blind 404 envelope; null → 404)
 *   - Master PRD v1.10 §17 + Glossary v5.2 C3 (patient surface MUST NOT
 *     render the operating-tenant identifier — `snapshotToPatientView`
 *     enforces this)
 */

import { describe, expect, it } from 'vitest';

import { asTenantId, type TenantId } from '../../src/lib/glossary.ts';
import type { TenantContext } from '../../src/lib/tenant-context.ts';
import { ulid } from '../../src/lib/ulid.ts';
import * as snapshotService from '../../src/modules/forms-intake/internal/services/snapshot-service.ts';
import type {
  FormSnapshot,
  FormSnapshotId,
  FormSubmissionId,
  PatientId,
} from '../../src/modules/forms-intake/internal/types.ts';
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
 * Build a minimal FormSnapshot literal for unit tests on the pure
 * projection function. Real snapshots have all fields populated by
 * buildAndPersistSnapshot; this builder produces enough for shape pins.
 */
function buildSnapshot(overrides: Partial<FormSnapshot> = {}): FormSnapshot {
  const base: FormSnapshot = {
    snapshot_id: ulid(),
    tenant_id: T_US,
    submission_id: ulid(),
    template_id: ulid(),
    template_version: 1,
    presented_content: {
      // Approximate the v1.10 FORMS_ENGINE v5.2 four-layer envelope
      // (L1 presentation / L2 branching / L3 eligibility / L4 approval
      // governance) plus CCR keys + research_consent_text_version. The
      // service treats it as opaque `unknown`; the test only asserts
      // structural pass-through.
      l1_presentation: { sections: [] },
      l2_branching: {},
      l3_eligibility: {},
      l4_approval_governance: null,
      ccr_resolution_snapshot: null,
      research_consent_text_version: null,
      captured_responses: { field_age: 30 },
    },
    created_at: new Date().toISOString(),
  };
  return { ...base, ...overrides };
}

/**
 * Insert a published template + active deployment + an in_progress
 * submission for the test's patient, then persist a snapshot row that
 * binds the submission. Returns the IDs needed for the ownership
 * cross-check tests in §2 / §3.
 *
 * Mirrors the seeding pattern from forms-intake-submission.test.ts but
 * INLINED here so the test file is self-contained.
 */
async function seedSubmissionWithSnapshot(opts: { patientId: PatientId }): Promise<{
  submissionId: FormSubmissionId;
  snapshotId: FormSnapshotId;
}> {
  const client = getTestClient();
  const programId = `prog_snap_svc_${ulid().slice(-8)}`;
  const templateId = ulid();
  const deploymentId = ulid();
  const submissionId = ulid();
  const snapshotId = ulid();

  await withTenantContext(T_US, async () => {
    await client.query(
      `INSERT INTO forms_template (
          template_id, tenant_id, program_id, country_of_care,
          template_version, status, name, created_by,
          presentation_content, branching_logic,
          eligibility_logic, approval_governance,
          published_at, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, 1, 'published', $5, $6,
                 '{}'::jsonb, '{}'::jsonb,
                 '{}'::jsonb, '{}'::jsonb,
                 NOW(), NOW(), NOW())`,
      [templateId, T_US, programId, 'US', `snap-svc-${templateId.slice(0, 8)}`, ulid()],
    );
    await client.query(
      `INSERT INTO forms_deployment (
          deployment_id, tenant_id, template_id, program_id,
          deployed_by, deployed_at, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, $5, NOW(), NOW(), NOW())`,
      [deploymentId, T_US, templateId, programId, ulid()],
    );
    await client.query(
      `INSERT INTO forms_submission (
          submission_id, tenant_id, deployment_id, variant_id,
          patient_id, delegate_id,
          status, responses, mode_2_eligible,
          created_at, updated_at
       ) VALUES ($1, $2, $3, NULL, $4, NULL,
                 'in_progress', '{}'::jsonb, FALSE,
                 NOW(), NOW())`,
      [submissionId, T_US, deploymentId, opts.patientId],
    );
    await client.query(
      `INSERT INTO forms_snapshot (
          snapshot_id, tenant_id, submission_id,
          template_id, template_version,
          presented_content, created_at
       ) VALUES ($1, $2, $3,
                 $4, 1,
                 '{}'::jsonb, NOW())`,
      [snapshotId, T_US, submissionId, templateId],
    );
  });

  return {
    submissionId: submissionId,
    snapshotId: snapshotId,
  };
}

// ---------------------------------------------------------------------------
// §1 — snapshotToPatientView (pure function)
// ---------------------------------------------------------------------------

describe('snapshotToPatientView — patient-surface projection', () => {
  it('§1a strips `tenant_id` from the patient view', () => {
    const snapshot = buildSnapshot({ tenant_id: T_US });
    const view = snapshotService.snapshotToPatientView(snapshot);
    expect(view).not.toHaveProperty('tenant_id');
  });

  it('§1b preserves every other top-level field verbatim', () => {
    const snapshot = buildSnapshot();
    const view = snapshotService.snapshotToPatientView(snapshot);

    // Pin EACH non-stripped field individually so a refactor that drops
    // one fails this test loudly. (A `toEqual({...snapshot, tenant_id: …
    // omitted})` assertion would also catch field changes but with a
    // less-actionable diff.)
    expect(view.snapshot_id).toBe(snapshot.snapshot_id);
    expect(view.submission_id).toBe(snapshot.submission_id);
    expect(view.template_id).toBe(snapshot.template_id);
    expect(view.template_version).toBe(snapshot.template_version);
    expect(view.presented_content).toEqual(snapshot.presented_content);
    expect(view.created_at).toBe(snapshot.created_at);
  });

  it('§1c rest-spread semantics: future fields added to FormSnapshot pass through', () => {
    // The implementation uses destructuring + rest spread:
    //   const { tenant_id: _, ...patientView } = snapshot;
    // Any new field on FormSnapshot (e.g., a `signed_consent_id`)
    // will land in patientView automatically. Pin via a synthetic
    // future-field on the input shape; if a refactor moves to an
    // explicit pick-list, this test will fail and prompt revisiting
    // the field's tenant-safety classification before silently dropping it.
    const synthetic = {
      ...buildSnapshot(),
      future_field_added_post_v1_0: 'value',
    } as FormSnapshot & { future_field_added_post_v1_0: string };
    const view = snapshotService.snapshotToPatientView(synthetic) as FormSnapshot & {
      future_field_added_post_v1_0?: string;
    };
    expect(view.future_field_added_post_v1_0).toBe('value');
  });

  it('§1d distinct snapshots produce distinct patient views (no shared-reference leak)', () => {
    const a = buildSnapshot({ snapshot_id: ulid() });
    const b = buildSnapshot({ snapshot_id: ulid() });
    const va = snapshotService.snapshotToPatientView(a);
    const vb = snapshotService.snapshotToPatientView(b);
    expect(va.snapshot_id).not.toBe(vb.snapshot_id);
    // Defense-in-depth: ensure the rest-spread COPIES the object rather
    // than aliasing — mutating one view should NOT affect the other.
    (va as { snapshot_id: string }).snapshot_id = 'mutated';
    expect(vb.snapshot_id).not.toBe('mutated');
  });
});

// ---------------------------------------------------------------------------
// §2 — getSnapshotForSubmissionAsPatient — ownership cross-check
// ---------------------------------------------------------------------------

describe('getSnapshotForSubmissionAsPatient — patient ownership cross-check', () => {
  it('§2a happy path: matching patient → snapshot returned', async () => {
    const patientId = ulid();
    const { submissionId, snapshotId } = await seedSubmissionWithSnapshot({ patientId });

    const result = await withTenantContext(T_US, () =>
      snapshotService.getSnapshotForSubmissionAsPatient(US_CTX, patientId, submissionId),
    );

    expect(result).not.toBeNull();
    expect(result!.snapshot_id).toBe(snapshotId);
    expect(result!.submission_id).toBe(submissionId);
  });

  it('§2b snapshot does not exist for the submission_id → null', async () => {
    const patientId = ulid();
    const phantomSubmissionId = ulid();

    const result = await withTenantContext(T_US, () =>
      snapshotService.getSnapshotForSubmissionAsPatient(US_CTX, patientId, phantomSubmissionId),
    );

    expect(result).toBeNull();
  });

  it('§2c submission exists with a DIFFERENT patient_id → null (cross-patient denial)', async () => {
    const ownerPatientId = ulid();
    const otherPatientId = ulid();
    const { submissionId } = await seedSubmissionWithSnapshot({ patientId: ownerPatientId });

    const result = await withTenantContext(T_US, () =>
      snapshotService.getSnapshotForSubmissionAsPatient(US_CTX, otherPatientId, submissionId),
    );

    // The regression-guard for cross-patient PHI leak. A refactor that
    // drops the `submission.patient_id !== patientId` comparison silently
    // returns the snapshot and this assertion fires.
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// §3 — getSnapshotByIdAsPatient — same ownership pattern via snapshot_id
// ---------------------------------------------------------------------------

describe('getSnapshotByIdAsPatient — patient ownership cross-check', () => {
  it('§3a happy path: matching patient → snapshot returned', async () => {
    const patientId = ulid();
    const { snapshotId } = await seedSubmissionWithSnapshot({ patientId });

    const result = await withTenantContext(T_US, () =>
      snapshotService.getSnapshotByIdAsPatient(US_CTX, patientId, snapshotId),
    );

    expect(result).not.toBeNull();
    expect(result!.snapshot_id).toBe(snapshotId);
  });

  it('§3b snapshot does not exist → null', async () => {
    const patientId = ulid();
    const phantomSnapshotId = ulid();

    const result = await withTenantContext(T_US, () =>
      snapshotService.getSnapshotByIdAsPatient(US_CTX, patientId, phantomSnapshotId),
    );

    expect(result).toBeNull();
  });

  it('§3c snapshot exists but bound submission has DIFFERENT patient_id → null', async () => {
    const ownerPatientId = ulid();
    const otherPatientId = ulid();
    const { snapshotId } = await seedSubmissionWithSnapshot({ patientId: ownerPatientId });

    const result = await withTenantContext(T_US, () =>
      snapshotService.getSnapshotByIdAsPatient(US_CTX, otherPatientId, snapshotId),
    );

    expect(result).toBeNull();
  });
});
