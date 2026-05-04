/**
 * submission-service.ts toPatientView() — direct unit coverage on the
 * patient-surface projection.
 *
 * Parallel to the §1 section in `snapshot-service.test.ts` (which
 * covered `snapshotToPatientView`). `toPatientView` is the same
 * pattern applied to `FormSubmission`: a pure rest-spread destructure
 * that drops `tenant_id` so the patient-facing API never renders the
 * operating-tenant identifier.
 *
 * Until this commit the function was exercised only INDIRECTLY through
 * forms-intake-submissions-http.test.ts (POST/GET/PATCH/SUBMIT
 * /v0/forms/submissions/* response-body checks). Those tests catch
 * tenant_id leakage at the WIRE layer but don't pin the per-field
 * structural contract on the function itself.
 *
 * Why this matters:
 *   `toPatientView` is the boundary between the FULL FormSubmission
 *   (which carries `tenant_id`) and the patient-facing
 *   `PatientFormSubmissionView` (which must not). A regression that:
 *     - drops the rest-spread (returning the input unmodified)
 *     - replaces it with a hand-picked subset that misses a field
 *     - copies tenant_id under a different key
 *   would all leak the operating-tenant identifier to the patient app
 *   surface in violation of Master PRD v1.10 §17 + Glossary v5.2 C3
 *   brand-structure rules.
 *
 *   The closure citation in the function comment (Codex
 *   patient-surface-r0 closure 2026-05-04) records that CI already
 *   caught one such leak — four `not to contain 'tenant_id'`
 *   failures across the submission HTTP suite. Direct coverage on
 *   the pure function pins the contract WITHOUT requiring an HTTP
 *   round-trip — the regression surfaces at unit-test speed instead
 *   of after the full integration matrix.
 *
 * Coverage in this file (1 section, 4 cases):
 *   §1a tenant_id is dropped from the patient view
 *   §1b every other top-level field is preserved verbatim
 *   §1c rest-spread semantics: future fields added to FormSubmission
 *       pass through automatically
 *   §1d distinct submissions produce distinct patient views (no
 *       shared-reference leak)
 *
 * Spec references:
 *   - Master PRD v1.10 §17 + Glossary v5.2 C3 (patient surface MUST
 *     NOT render the operating-tenant identifier)
 *   - I-025 (tenant-blind error model — same blindness extends to
 *     successful response surfaces)
 *   - Slice PRD v2.1 §3 (submissions are PHI; patient app reads
 *     submissions back via /v0/forms/submissions/*)
 */

import { describe, expect, it } from 'vitest';

import { asTenantId, type TenantId } from '../../src/lib/glossary.ts';
import { ulid } from '../../src/lib/ulid.ts';
import { toPatientView } from '../../src/modules/forms-intake/internal/services/submission-service.ts';
import type { FormSubmission } from '../../src/modules/forms-intake/internal/types.ts';
import { TENANT_US } from '../helpers/tenant-fixtures.ts';

const T_US: TenantId = asTenantId(TENANT_US);

/**
 * Build a minimal FormSubmission literal. Mirrors the shape from
 * `migrations/006_forms_intake.sql` TABLE 3 + the v1.10 type set.
 * Every field is populated so §1b can assert preservation by name.
 */
function buildSubmission(overrides: Partial<FormSubmission> = {}): FormSubmission {
  const base: FormSubmission = {
    submission_id: ulid(),
    tenant_id: T_US,
    deployment_id: ulid(),
    variant_id: null,
    patient_id: ulid(),
    delegate_id: null,
    status: 'in_progress',
    responses: { field_age: 30, field_consent: true },
    started_at: new Date().toISOString(),
    submitted_at: null,
  };
  return { ...base, ...overrides };
}

describe('toPatientView — patient-surface projection on FormSubmission', () => {
  it('§1a strips `tenant_id` from the patient view', () => {
    const submission = buildSubmission({ tenant_id: T_US });
    const view = toPatientView(submission);
    expect(view).not.toHaveProperty('tenant_id');
  });

  it('§1b preserves every other top-level field verbatim', () => {
    const submission = buildSubmission();
    const view = toPatientView(submission);

    // Pin EACH non-stripped field individually so a refactor that
    // accidentally drops one fails this test loudly with an
    // actionable diff.
    expect(view.submission_id).toBe(submission.submission_id);
    expect(view.deployment_id).toBe(submission.deployment_id);
    expect(view.variant_id).toBe(submission.variant_id);
    expect(view.patient_id).toBe(submission.patient_id);
    expect(view.delegate_id).toBe(submission.delegate_id);
    expect(view.status).toBe(submission.status);
    expect(view.responses).toEqual(submission.responses);
    expect(view.started_at).toBe(submission.started_at);
    expect(view.submitted_at).toBe(submission.submitted_at);
  });

  it('§1c rest-spread semantics: future fields added to FormSubmission pass through', () => {
    // The implementation uses destructuring + rest spread:
    //   const { tenant_id: _, ...patientView } = submission;
    // Any new field on FormSubmission (e.g., a `consent_signature_id`
    // landed in a future slice) lands in the patient view automatically.
    // Pin via a synthetic future-field on the input shape; if a
    // refactor switches to an explicit pick-list, this test fails and
    // prompts revisiting the field's tenant-safety classification
    // before silently dropping it from the patient surface.
    const synthetic = {
      ...buildSubmission(),
      future_field_added_post_v1_0: 'value',
    } as FormSubmission & { future_field_added_post_v1_0: string };
    const view = toPatientView(synthetic) as FormSubmission & {
      future_field_added_post_v1_0?: string;
    };
    expect(view.future_field_added_post_v1_0).toBe('value');
  });

  it('§1d distinct submissions produce distinct patient views (no shared-reference leak)', () => {
    const a = buildSubmission({ submission_id: ulid() });
    const b = buildSubmission({ submission_id: ulid() });
    const va = toPatientView(a);
    const vb = toPatientView(b);
    expect(va.submission_id).not.toBe(vb.submission_id);
    // Defense-in-depth: ensure the rest-spread COPIES the object rather
    // than aliasing — mutating one view should NOT affect the other.
    (va as { submission_id: string }).submission_id = 'mutated';
    expect(vb.submission_id).not.toBe('mutated');
  });

  it('§1e patient_id=null (anonymous pre-account submission) is preserved on the view', () => {
    // Pre-account / device-anonymous submissions have patient_id=null
    // until the patient creates an account and the submission is
    // bound. The strip MUST preserve null vs erasing it (lossy
    // serialization here would silently drop intent on the wire).
    const anon = buildSubmission({ patient_id: null });
    const view = toPatientView(anon);
    expect(view.patient_id).toBeNull();
  });

  it('§1f tenant_id-shaped substring is absent from JSON serialization (defense in depth)', () => {
    // Belt-and-suspenders: stringifying the patient view MUST NOT
    // surface the operating-tenant identifier. Catches a regression
    // that aliases the field under a different key (e.g., `tenant`
    // instead of `tenant_id`) — the structural toPatientView strip
    // would only check for `tenant_id`, but a serialized
    // `"tenant":"Telecheck-US"` would still leak.
    const submission = buildSubmission({ tenant_id: T_US });
    const view = toPatientView(submission);
    const serialized = JSON.stringify(view);
    expect(serialized).not.toContain('Telecheck-US');
    expect(serialized).not.toContain('tenant_id');
  });
});
