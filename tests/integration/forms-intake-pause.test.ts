/**
 * Forms/Intake — save-and-resume pause/write integration tests.
 *
 * Covers the patient-side "Save and continue later" flow (Slice PRD v2.1
 * §8.2): the PATCH /v0/forms/submissions/:submissionId/responses handler
 * with `pause === true` routes to `submissionService.pauseSubmission`,
 * which:
 *
 *   1. Runs the I-019 crisis gate FIRST (platform-floor; never disabled).
 *   2. Merges the responses into the submission row (auto-save path).
 *   3. Encrypts the merged responses under per-tenant KMS (ADR-024).
 *   4. INSERTs a forms_resume_state row in 'active' status.
 *   5. Emits the Category B `forms_submission_paused` audit (typed
 *      placeholder action_id via formsAuditPlaceholder() per the SPEC
 *      ISSUE flagged in audit.ts; post legacy-emitter-migration the
 *      discriminator is the action_id directly, not detail.intent).
 *      Note: slice PRD §8.5 calls this Category C operational; the
 *      emitter currently uses Category B carried over from the
 *      pre-migration `config_change_validated` placeholder. Reconciling
 *      that drift is a separate Engineering Lead decision (flagged in
 *      audit.ts SPEC ISSUE inline comment).
 *   6. Emits the `forms_resume_state.saved` domain event.
 *   7. Issues an HMAC-self-contained resume token (resume-token.ts).
 *
 * The audit + domain event commit in the SAME transaction as the
 * resume_state INSERT (I-016 same-tx outbox); a failure anywhere in the
 * txCallback rolls back the resume_state row.
 *
 * Spec references:
 *   - Slice PRD v2.1 §8.2 — explicit save-and-leave; resume_state row
 *     keyed off (patient/device, deployment, encrypted partial responses).
 *   - I-016 — same-tx outbox: audit + event durable iff resume_state INSERT.
 *   - I-019 — crisis detection always-on; runs BEFORE resume_state creation.
 *   - I-023 / I-027 — every PHI write tenant-scoped; audit carries tenant_id.
 *   - ADR-024 — per-tenant KMS key for encrypted_partial_responses.
 *
 * SPEC ISSUEs honored:
 *   - migration 006 has no `submission_id` on forms_resume_state. The
 *     service binds via (tenant, deployment, patient) at restore time.
 *   - migration's `forms_submission.patient_id NOT NULL` blocks the
 *     anonymous-flow (§8.2 device-anonymous) end-to-end; tests cover the
 *     known-patient happy path. Anonymous-flow lands when both the
 *     migration patch + audit-emitter signature change land together.
 *   - Audit action_id is `forms_submission_paused`, a typed placeholder
 *     in `FormsAuditActionPlaceholder` pending AUDIT_EVENTS amendment.
 *     Tests assert against the action_id directly post legacy-emitter
 *     migration 2026-05-04. The SPEC ISSUE flag is inventoried via
 *     `git grep "formsAuditPlaceholder("` in src/modules/forms-intake/.
 */

import { describe, expect, it } from 'vitest';

import { asTenantId } from '../../src/lib/glossary.ts';
import { kms } from '../../src/lib/kms.ts';
import type { TenantContext } from '../../src/lib/tenant-context.ts';
import { ulid } from '../../src/lib/ulid.ts';
import { verifyResumeToken } from '../../src/modules/forms-intake/internal/services/resume-token.ts';
import * as submissionService from '../../src/modules/forms-intake/internal/services/submission-service.ts';
import { assertAuditRecordExists } from '../helpers/audit-assertions.ts';
import { TENANT_US, withTenantContext } from '../helpers/tenant-fixtures.ts';
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

interface SeededDeployment {
  templateId: string;
  deploymentId: string;
}

/**
 * Insert a published template + active deployment for the active tenant.
 * Mirrors `seedActiveDeployment` from forms-intake-submission.test.ts —
 * kept here rather than extracted so each test file's seeding is obvious
 * at a glance.
 */
async function seedActiveDeployment(opts: {
  ctx: TenantContext;
  programId: string;
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
        `test-pause-${templateId.slice(0, 8)}`,
        ulid(),
      ],
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
      [deploymentId, opts.ctx.tenantId, templateId, opts.programId, ulid()],
    );
  });
  return { templateId, deploymentId };
}

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe('forms-intake pauseSubmission — happy path', () => {
  it('creates an active resume_state row, emits Category C audit + forms_resume_state.saved event, returns a verifiable resume token', async () => {
    const programId = `prog_pause_ok_${ulid().slice(0, 8)}`;
    const { deploymentId } = await seedActiveDeployment({ ctx: US_CTX, programId });
    const patientId = ulid();

    // Start an in_progress submission for the patient to pause.
    const submission = await withTenantContext(TENANT_US, () =>
      submissionService.startSubmission(
        US_CTX,
        { actorId: 'op_pause', patientId, delegateId: null },
        { deploymentId },
        getTestClient(),
      ),
    );

    // Pause path — `pause: true` routes the handler to pauseSubmission.
    const result = await withTenantContext(TENANT_US, () =>
      submissionService.pauseSubmission(
        US_CTX,
        { actorId: 'op_pause', patientId, delegateId: null },
        submission.submission_id,
        { responses: { field_age: 30, field_name: 'Pat' }, pause: true },
        getTestClient(),
      ),
    );

    // Submission state — merged, still in_progress (pause does NOT flip
    // status; submission rows stay 'in_progress' until the patient
    // finalizes, per slice PRD §8.2).
    expect(result.submission.status).toBe('in_progress');
    expect(result.submission.responses).toEqual({ field_age: 30, field_name: 'Pat' });
    expect(result.submission.submission_id).toBe(submission.submission_id);

    // Resume metadata — present, with a verifiable HMAC-signed token.
    expect(result.resumeState.resumeStateId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(typeof result.resumeState.resumeToken).toBe('string');
    expect(result.resumeState.resumeToken.length).toBeGreaterThan(20);
    expect(typeof result.resumeState.expiresAt).toBe('string');
    // 30-day TTL — round to the nearest day so leap-second / clock-skew
    // don't fail the test. Lower bound 29.9 / upper 30.1 days from now.
    const expiresMs = Date.parse(result.resumeState.expiresAt);
    const now = Date.now();
    expect(expiresMs - now).toBeGreaterThan(29.9 * 24 * 60 * 60 * 1000);
    expect(expiresMs - now).toBeLessThan(30.1 * 24 * 60 * 60 * 1000);

    // Token round-trips: HMAC verifies + carries the same identity payload.
    const verified = verifyResumeToken(result.resumeState.resumeToken);
    expect(verified).not.toBeNull();
    expect(verified?.resumeStateId).toBe(result.resumeState.resumeStateId);
    expect(verified?.tenantId).toBe(US_CTX.tenantId);

    // Resume state row exists in active status with the correct binding.
    const client = getTestClient();
    const row = await withTenantContext(TENANT_US, async () => {
      const r = await client.query<{
        status: string;
        patient_id: string | null;
        device_anonymous_token: string | null;
        deployment_id: string;
      }>(
        `SELECT status, patient_id, device_anonymous_token, deployment_id
           FROM forms_resume_state
          WHERE resume_state_id = $1`,
        [result.resumeState.resumeStateId],
      );
      return r.rows[0];
    });
    expect(row).toBeDefined();
    expect(row!.status).toBe('active');
    expect(row!.patient_id).toBe(patientId);
    expect(row!.device_anonymous_token).toBeNull();
    expect(row!.deployment_id).toBe(deploymentId);

    // Audit emitted with the typed-placeholder action_id (post legacy-
    // emitter-migration 2026-05-04 — see SPEC ISSUE in audit.ts
    // formsAuditPlaceholder helper). Prior to the migration this row used
    // `action='config_change_validated'` with `detail.intent='forms_submission_paused'`;
    // the migration moved the discriminator into the action_id and dropped
    // the redundant detail.intent field.
    await withTenantContext(TENANT_US, () =>
      assertAuditRecordExists(
        TENANT_US,
        (rec) =>
          rec.action === ('forms_submission_paused' as typeof rec.action) &&
          rec.detail['resume_state_id'] === result.resumeState.resumeStateId &&
          rec.target_patient_id === patientId,
      ),
    );

    // forms_resume_state.saved domain event in outbox — same-tx with the
    // INSERT (I-016).
    const event = await withTenantContext(TENANT_US, async () => {
      const r = await client.query<{
        payload: Record<string, unknown>;
        aggregate_type: string;
        event_type: string;
      }>(
        `SELECT payload, aggregate_type, event_type
           FROM domain_events_outbox
          WHERE tenant_id = $1
            AND aggregate_id = $2
            AND event_type = 'forms_resume_state.saved'`,
        [TENANT_US, result.resumeState.resumeStateId],
      );
      return r.rows[0];
    });
    expect(event).toBeDefined();
    expect(event!.aggregate_type).toBe('forms_resume_state');
    expect(event!.payload['submission_id']).toBe(submission.submission_id);
    expect(event!.payload['patient_id']).toBe(patientId);
  });

  // The encrypted_partial_responses BYTEA column MUST hold ciphertext, not
  // plaintext (ADR-024 layer-3 isolation). We round-trip via kms.decrypt
  // to assert (a) plaintext was not stored, and (b) the decrypt yields
  // the merged responses back.
  it('persists encrypted_partial_responses (decrypt round-trip yields merged JSON)', async () => {
    const programId = `prog_pause_enc_${ulid().slice(0, 8)}`;
    const { deploymentId } = await seedActiveDeployment({ ctx: US_CTX, programId });
    const patientId = ulid();

    const submission = await withTenantContext(TENANT_US, () =>
      submissionService.startSubmission(
        US_CTX,
        { actorId: 'op_enc', patientId, delegateId: null },
        { deploymentId },
        getTestClient(),
      ),
    );

    // First save: build up some prior state.
    await withTenantContext(TENANT_US, () =>
      submissionService.updateResponses(
        US_CTX,
        { actorId: 'op_enc', patientId, delegateId: null },
        submission.submission_id,
        { responses: { field_age: 28 } },
        getTestClient(),
      ),
    );

    const result = await withTenantContext(TENANT_US, () =>
      submissionService.pauseSubmission(
        US_CTX,
        { actorId: 'op_enc', patientId, delegateId: null },
        submission.submission_id,
        {
          responses: { field_name: 'Sam', field_zip: '94110' },
          pause: true,
        },
        getTestClient(),
      ),
    );

    // Read the BYTEA back from the row.
    const client = getTestClient();
    const row = await withTenantContext(TENANT_US, async () => {
      const r = await client.query<{ encrypted_partial_responses: Buffer }>(
        `SELECT encrypted_partial_responses FROM forms_resume_state
          WHERE resume_state_id = $1`,
        [result.resumeState.resumeStateId],
      );
      return r.rows[0];
    });
    expect(row).toBeDefined();
    expect(Buffer.isBuffer(row!.encrypted_partial_responses)).toBe(true);

    // The bytes are NOT the plaintext JSON — encrypt produces an opaque
    // [iv | tag | ct] envelope. Verifying that the bytes don't simply
    // contain the plaintext keys gives a smoke check that encryption
    // actually ran.
    const cipherText = row!.encrypted_partial_responses.toString('utf8');
    expect(cipherText).not.toContain('field_name');
    expect(cipherText).not.toContain('Sam');

    // Round-trip: decrypt under the same tenant context and verify the
    // JSON matches the merged responses (prior keys preserved).
    const decrypted = await kms.decrypt(US_CTX, row!.encrypted_partial_responses);
    const parsed = JSON.parse(decrypted.toString('utf8')) as Record<string, unknown>;
    expect(parsed).toEqual({ field_age: 28, field_name: 'Sam', field_zip: '94110' });
  });
});

// ---------------------------------------------------------------------------
// Auto-save (pause undefined or false) does NOT create a resume_state row
// ---------------------------------------------------------------------------

describe('forms-intake updateResponses — auto-save does NOT create resume_state', () => {
  it('writes no resume_state row when pause is omitted', async () => {
    const programId = `prog_auto_${ulid().slice(0, 8)}`;
    const { deploymentId } = await seedActiveDeployment({ ctx: US_CTX, programId });
    const patientId = ulid();

    const submission = await withTenantContext(TENANT_US, () =>
      submissionService.startSubmission(
        US_CTX,
        { actorId: 'op_auto', patientId, delegateId: null },
        { deploymentId },
        getTestClient(),
      ),
    );

    await withTenantContext(TENANT_US, () =>
      submissionService.updateResponses(
        US_CTX,
        { actorId: 'op_auto', patientId, delegateId: null },
        submission.submission_id,
        { responses: { field_1: 'autosave' } /* pause omitted */ },
        getTestClient(),
      ),
    );

    const client = getTestClient();
    const count = await withTenantContext(TENANT_US, async () => {
      const r = await client.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count
           FROM forms_resume_state
          WHERE deployment_id = $1
            AND patient_id = $2`,
        [deploymentId, patientId],
      );
      return r.rows[0]!.count;
    });
    expect(count).toBe('0');
  });

  it('writes no resume_state row when pause is explicitly false', async () => {
    const programId = `prog_false_${ulid().slice(0, 8)}`;
    const { deploymentId } = await seedActiveDeployment({ ctx: US_CTX, programId });
    const patientId = ulid();

    const submission = await withTenantContext(TENANT_US, () =>
      submissionService.startSubmission(
        US_CTX,
        { actorId: 'op_false', patientId, delegateId: null },
        { deploymentId },
        getTestClient(),
      ),
    );

    await withTenantContext(TENANT_US, () =>
      submissionService.updateResponses(
        US_CTX,
        { actorId: 'op_false', patientId, delegateId: null },
        submission.submission_id,
        { responses: { field_1: 'autosave-explicit' }, pause: false },
        getTestClient(),
      ),
    );

    const client = getTestClient();
    const count = await withTenantContext(TENANT_US, async () => {
      const r = await client.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count
           FROM forms_resume_state
          WHERE deployment_id = $1
            AND patient_id = $2`,
        [deploymentId, patientId],
      );
      return r.rows[0]!.count;
    });
    expect(count).toBe('0');
  });
});

// ---------------------------------------------------------------------------
// I-019 crisis detection: runs BEFORE resume_state creation (no row written)
// ---------------------------------------------------------------------------

describe('forms-intake pauseSubmission — I-019 crisis gate', () => {
  it('rejects with CRISIS_DETECTED and creates NO resume_state row when crisis text is present', async () => {
    const programId = `prog_pcrisis_${ulid().slice(0, 8)}`;
    const { deploymentId } = await seedActiveDeployment({ ctx: US_CTX, programId });
    const patientId = ulid();

    const submission = await withTenantContext(TENANT_US, () =>
      submissionService.startSubmission(
        US_CTX,
        { actorId: 'op_pcrisis', patientId, delegateId: null },
        { deploymentId },
        getTestClient(),
      ),
    );

    // Crisis phrase from CRISIS_PATTERNS.suicidal_ideation per
    // crisis-detection.ts. The pause path's crisis gate runs FIRST (before
    // the merge, before encryption, before resume_state INSERT) — same
    // ordering as the auto-save path.
    const crisisPhrase = 'I want to kill myself';
    await expect(
      withTenantContext(TENANT_US, () =>
        submissionService.pauseSubmission(
          US_CTX,
          { actorId: 'op_pcrisis', patientId, delegateId: null },
          submission.submission_id,
          { responses: { field_open_text: crisisPhrase }, pause: true },
          getTestClient(),
        ),
      ),
    ).rejects.toThrow(submissionService.CRISIS_DETECTED);

    // The Category A `crisis_detection_trigger` audit MUST exist — the
    // detection event is durable per I-003 + I-019 even though no other
    // state mutated.
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

    // No resume_state row was created — the crisis gate aborts the flow
    // before submissionRepo.createResumeState runs.
    const client = getTestClient();
    const count = await withTenantContext(TENANT_US, async () => {
      const r = await client.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count
           FROM forms_resume_state
          WHERE deployment_id = $1
            AND patient_id = $2`,
        [deploymentId, patientId],
      );
      return r.rows[0]!.count;
    });
    expect(count).toBe('0');

    // The submission row's responses are unchanged — neither the merge
    // nor the encrypt nor the resume_state INSERT ran.
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
