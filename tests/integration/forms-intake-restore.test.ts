/**
 * Forms/Intake — save-and-resume RESTORE integration tests.
 *
 * Covers the patient-side "Resume" flow read-side (Slice PRD v2.1 §8.4):
 * `submissionService.resumeSubmission` validates the patient-held HMAC
 * resume token, decrypts the partial responses, merges them back onto
 * the in-progress forms_submission row, flips the resume_state row to
 * `status='completed'`, and emits the Category B `forms_submission_resumed`
 * audit (typed placeholder action_id via formsAuditPlaceholder() per the
 * SPEC ISSUE flagged in audit.ts; post legacy-emitter-migration the
 * discriminator is the action_id directly, not detail.intent).
 * Note: slice PRD §8.5 calls this Category C; the emitter currently uses
 * Category B carried over from the pre-migration `config_change_validated`
 * placeholder. Reconciling that drift is a separate Engineering Lead
 * decision (flagged in audit.ts SPEC ISSUE inline comment).
 *
 * Atomic orchestration in ONE outer transaction (I-016 same-tx outbox):
 * a failure anywhere in the merge UPDATE / status flip / audit emission
 * rolls back the merge AND prevents the resume_state row from being
 * marked completed. Replay protection rides on the status-flip predicate.
 *
 * Spec references:
 *   - Slice PRD v2.1 §8 — save-and-resume; §8.4 restore + replay
 *     protection (the row flips to completed inside the merge tx).
 *   - I-016 — same-tx outbox: merge UPDATE + status flip + audit durable iff all succeed.
 *   - I-019 — crisis detection runs at submission entry, not at restore
 *     (decrypted bytes already passed the entry gate; re-scanning would
 *     either duplicate detections or break legitimate resumes).
 *   - I-023 / I-027 — RLS + audit tenant_id; cross-tenant restore null.
 *   - I-025 — every failure mode surfaces as null (handler 404).
 *   - ADR-024 — per-tenant KMS key; cross-tenant ciphertext can't decrypt.
 *
 * SPEC ISSUEs honored:
 *   - migration 006 has no `submission_id` on forms_resume_state. The
 *     restore service binds via (tenant, deployment, patient,
 *     status='in_progress') ORDER BY created_at DESC LIMIT 1.
 *   - DOMAIN_EVENTS v5.2 doesn't yet enumerate `forms_resume_state.restored`;
 *     the restore path emits ONLY the audit and documents the gap inline.
 *     Tests therefore assert the audit + the resume_state status flip;
 *     no domain event is asserted (and we explicitly verify no `.restored`
 *     event is in the outbox so the inline-deferred contract holds).
 */

import { describe, expect, it } from 'vitest';

import { asTenantId } from '../../src/lib/glossary.ts';
import { kms } from '../../src/lib/kms.ts';
import type { TenantContext } from '../../src/lib/tenant-context.ts';
import { ulid } from '../../src/lib/ulid.ts';
import { issueResumeToken } from '../../src/modules/forms-intake/internal/services/resume-token.ts';
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
 * Insert a published template + active deployment for the given tenant
 * context. Mirrors the helper in forms-intake-pause.test.ts; kept inline
 * rather than extracted so each test file is self-contained.
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
        `test-restore-${templateId.slice(0, 8)}`,
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

interface PausedSetup {
  templateId: string;
  deploymentId: string;
  patientId: string;
  submissionId: string;
  resumeStateId: string;
  resumeToken: string;
  resumeExpiresAt: string;
  /** Responses the patient sent on the pause request (also the merged set at v0.1). */
  pausedResponses: Record<string, unknown>;
}

/**
 * Pause helper — exercises the full pause pipeline end-to-end via the
 * service layer (not seeded SQL). Used by tests that want a real
 * resume_state row, real KMS-encrypted payload, and a real HMAC token
 * pointing to it. Mirrors the pause happy-path test's setup.
 */
async function pauseHelper(opts: {
  ctx: TenantContext;
  programId: string;
  responses: Record<string, unknown>;
  actorId?: string;
}): Promise<PausedSetup> {
  const { templateId, deploymentId } = await seedActiveDeployment({
    ctx: opts.ctx,
    programId: opts.programId,
  });
  const patientId = ulid();
  const actorId = opts.actorId ?? `op_${ulid().slice(0, 8)}`;

  const submission = await withTenantContext(opts.ctx.tenantId, () =>
    submissionService.startSubmission(
      opts.ctx,
      { actorId, patientId, delegateId: null },
      { deploymentId },
      getTestClient(),
    ),
  );

  const result = await withTenantContext(opts.ctx.tenantId, () =>
    submissionService.pauseSubmission(
      opts.ctx,
      { actorId, patientId, delegateId: null },
      submission.submission_id,
      { responses: opts.responses, pause: true },
      getTestClient(),
    ),
  );

  return {
    templateId,
    deploymentId,
    patientId,
    submissionId: submission.submission_id,
    resumeStateId: result.resumeState.resumeStateId,
    resumeToken: result.resumeState.resumeToken,
    resumeExpiresAt: result.resumeState.expiresAt,
    pausedResponses: opts.responses,
  };
}

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe('forms-intake resumeSubmission — happy path', () => {
  it('decrypts + merges responses, flips resume_state to completed, emits Category C audit, omits tenant_id', async () => {
    const programId = `prog_restore_ok_${ulid().slice(0, 8)}`;
    const responses = { field_age: 30, field_name: 'Pat', field_zip: '94110' };
    const actorId = 'op_restore_ok';
    const setup = await pauseHelper({
      ctx: US_CTX,
      programId,
      responses,
      actorId,
    });

    const restored = await withTenantContext(TENANT_US, () =>
      submissionService.resumeSubmission(
        US_CTX,
        { actorId, patientId: setup.patientId, deviceAnonymousToken: null },
        setup.resumeToken,
        getTestClient(),
      ),
    );

    expect(restored).not.toBeNull();
    expect(restored!.submission_id).toBe(setup.submissionId);
    expect(restored!.responses).toEqual(responses);
    expect(restored!.status).toBe('in_progress');

    // tenant_id MUST NOT appear on the patient-facing view (Master PRD §17
    // + Glossary v5.2 C3 brand-structure rule). Type-level Omit guarantees
    // this at compile time; runtime check is belt-and-suspenders.
    expect(Object.keys(restored!)).not.toContain('tenant_id');

    // resume_state row was flipped: status='completed' + resumed_at set.
    const client = getTestClient();
    const row = await withTenantContext(TENANT_US, async () => {
      const r = await client.query<{ status: string; resumed_at: string | null }>(
        `SELECT status, resumed_at FROM forms_resume_state WHERE resume_state_id = $1`,
        [setup.resumeStateId],
      );
      return r.rows[0];
    });
    expect(row).toBeDefined();
    expect(row!.status).toBe('completed');
    expect(row!.resumed_at).not.toBeNull();

    // forms_submission row carries the merged decrypted responses.
    const subRow = await withTenantContext(TENANT_US, async () => {
      const r = await client.query<{ responses: Record<string, unknown> }>(
        `SELECT responses FROM forms_submission WHERE submission_id = $1`,
        [setup.submissionId],
      );
      return r.rows[0];
    });
    expect(subRow).toBeDefined();
    expect(subRow!.responses).toEqual(responses);

    // Audit emitted with the typed-placeholder action_id (post legacy-
    // emitter-migration 2026-05-04 — see SPEC ISSUE in audit.ts
    // formsAuditPlaceholder helper). Prior to the migration this row used
    // `action='config_change_validated'` with `detail.intent='forms_submission_resumed'`;
    // the migration moved the discriminator into the action_id and dropped
    // the redundant detail.intent field.
    await withTenantContext(TENANT_US, () =>
      assertAuditRecordExists(
        TENANT_US,
        (rec) =>
          rec.action === ('forms_submission_resumed' as typeof rec.action) &&
          rec.detail['resume_state_id'] === setup.resumeStateId &&
          rec.detail['submission_id'] === setup.submissionId &&
          rec.target_patient_id === setup.patientId,
      ),
    );

    // No `forms_resume_state.restored` domain event is emitted on restore
    // at v0.1 (DOMAIN_EVENTS v5.2 doesn't enumerate it; SPEC ISSUE flagged
    // inline in submission-service.ts). The lack of an event here is part
    // of the contract — this assertion guards against accidental drift
    // where someone wires an event without the spec amendment.
    const evCount = await withTenantContext(TENANT_US, async () => {
      const r = await client.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count
           FROM domain_events_outbox
          WHERE tenant_id = $1
            AND aggregate_id = $2
            AND event_type = 'forms_resume_state.restored'`,
        [TENANT_US, setup.resumeStateId],
      );
      return r.rows[0]!.count;
    });
    expect(evCount).toBe('0');
  });

  it('preserves prior submission keys when restoring (merge semantics)', async () => {
    const programId = `prog_restore_merge_${ulid().slice(0, 8)}`;
    const { deploymentId } = await seedActiveDeployment({
      ctx: US_CTX,
      programId,
    });
    const patientId = ulid();
    const actorId = 'op_restore_merge';

    // Begin + auto-save some prior state on the in-progress row.
    const submission = await withTenantContext(TENANT_US, () =>
      submissionService.startSubmission(
        US_CTX,
        { actorId, patientId, delegateId: null },
        { deploymentId },
        getTestClient(),
      ),
    );

    await withTenantContext(TENANT_US, () =>
      submissionService.updateResponses(
        US_CTX,
        { actorId, patientId, delegateId: null },
        submission.submission_id,
        { responses: { field_prior: 'kept' } },
        getTestClient(),
      ),
    );

    // Pause carries the merged set (prior keys + pause-time keys), encrypts.
    const pause = await withTenantContext(TENANT_US, () =>
      submissionService.pauseSubmission(
        US_CTX,
        { actorId, patientId, delegateId: null },
        submission.submission_id,
        { responses: { field_pause: 'pause_value' }, pause: true },
        getTestClient(),
      ),
    );

    // Restore the same row.
    const restored = await withTenantContext(TENANT_US, () =>
      submissionService.resumeSubmission(
        US_CTX,
        { actorId, patientId, deviceAnonymousToken: null },
        pause.resumeState.resumeToken,
        getTestClient(),
      ),
    );

    expect(restored).not.toBeNull();
    // The restored responses MUST contain BOTH keys — restore JSONB-merges
    // the decrypted payload (which already carries the prior key from the
    // pause-time merge) onto the row, so prior keys persist.
    expect(restored!.responses).toEqual({
      field_prior: 'kept',
      field_pause: 'pause_value',
    });
  });
});

// ---------------------------------------------------------------------------
// Tenant-blind failure modes — every gate trip surfaces as null per I-025
// ---------------------------------------------------------------------------

describe('forms-intake resumeSubmission — failure modes (all surface as null per I-025)', () => {
  it('returns null on cross-patient access (correct token + wrong patient)', async () => {
    const programId = `prog_restore_xpat_${ulid().slice(0, 8)}`;
    const setup = await pauseHelper({
      ctx: US_CTX,
      programId,
      responses: { field_a: 1 },
    });

    const otherPatientId = ulid();
    const result = await withTenantContext(TENANT_US, () =>
      submissionService.resumeSubmission(
        US_CTX,
        {
          actorId: 'op_xpat',
          patientId: otherPatientId,
          deviceAnonymousToken: null,
        },
        setup.resumeToken,
        getTestClient(),
      ),
    );
    expect(result).toBeNull();

    // resume_state row is unchanged — still active, still not resumed_at.
    const client = getTestClient();
    const row = await withTenantContext(TENANT_US, async () => {
      const r = await client.query<{ status: string; resumed_at: string | null }>(
        `SELECT status, resumed_at FROM forms_resume_state WHERE resume_state_id = $1`,
        [setup.resumeStateId],
      );
      return r.rows[0];
    });
    expect(row!.status).toBe('active');
    expect(row!.resumed_at).toBeNull();
  });

  it('returns null on cross-tenant restore (paused as US, attempted as Ghana)', async () => {
    const programId = `prog_restore_xt_${ulid().slice(0, 8)}`;
    const setup = await pauseHelper({
      ctx: US_CTX,
      programId,
      responses: { field_a: 1 },
    });

    // Ghana request context presents the US-issued token. Token's tenant_id
    // binding mismatches Ghana ctx; service step 2 rejects.
    const result = await withTenantContext(TENANT_GHANA, () =>
      submissionService.resumeSubmission(
        GH_CTX,
        {
          actorId: 'op_xt',
          patientId: setup.patientId,
          deviceAnonymousToken: null,
        },
        setup.resumeToken,
        getTestClient(),
      ),
    );
    expect(result).toBeNull();

    // US-side row untouched.
    const client = getTestClient();
    const row = await withTenantContext(TENANT_US, async () => {
      const r = await client.query<{ status: string }>(
        `SELECT status FROM forms_resume_state WHERE resume_state_id = $1`,
        [setup.resumeStateId],
      );
      return r.rows[0];
    });
    expect(row!.status).toBe('active');
  });

  it('returns null when the token signature has been tampered with', async () => {
    const programId = `prog_restore_tamper_${ulid().slice(0, 8)}`;
    const setup = await pauseHelper({
      ctx: US_CTX,
      programId,
      responses: { field_a: 1 },
    });

    // Flip a single character in the signature segment.
    const dotIdx = setup.resumeToken.lastIndexOf('.');
    const sig = setup.resumeToken.slice(dotIdx + 1);
    const flipped = sig[0] === 'A' ? 'B' : 'A';
    const tampered = setup.resumeToken.slice(0, dotIdx + 1) + flipped + sig.slice(1);

    const result = await withTenantContext(TENANT_US, () =>
      submissionService.resumeSubmission(
        US_CTX,
        {
          actorId: 'op_tamper',
          patientId: setup.patientId,
          deviceAnonymousToken: null,
        },
        tampered,
        getTestClient(),
      ),
    );
    expect(result).toBeNull();
  });

  it('returns null on a token whose token-level expiry is in the past', async () => {
    // Issue a token with a past expiry over a row that's otherwise valid.
    // The service's verifyResumeToken rejects expired tokens at step 1
    // before the row lookup runs.
    const programId = `prog_restore_exp_${ulid().slice(0, 8)}`;
    const setup = await pauseHelper({
      ctx: US_CTX,
      programId,
      responses: { field_a: 1 },
    });

    const past = new Date(Date.now() - 1000).toISOString();
    const expiredToken = issueResumeToken(setup.resumeStateId, US_CTX.tenantId, past);

    const result = await withTenantContext(TENANT_US, () =>
      submissionService.resumeSubmission(
        US_CTX,
        {
          actorId: 'op_exp',
          patientId: setup.patientId,
          deviceAnonymousToken: null,
        },
        expiredToken,
        getTestClient(),
      ),
    );
    expect(result).toBeNull();
  });

  it('returns null on the second restore attempt (replay of an already-completed token)', async () => {
    const programId = `prog_restore_replay_${ulid().slice(0, 8)}`;
    const setup = await pauseHelper({
      ctx: US_CTX,
      programId,
      responses: { field_a: 'first' },
    });

    // First restore — succeeds, flips status to completed.
    const first = await withTenantContext(TENANT_US, () =>
      submissionService.resumeSubmission(
        US_CTX,
        {
          actorId: 'op_replay',
          patientId: setup.patientId,
          deviceAnonymousToken: null,
        },
        setup.resumeToken,
        getTestClient(),
      ),
    );
    expect(first).not.toBeNull();

    // Second restore with the SAME token — row is now in 'completed'
    // status; service step 4 (status gate) rejects. Tenant-blind null.
    const second = await withTenantContext(TENANT_US, () =>
      submissionService.resumeSubmission(
        US_CTX,
        {
          actorId: 'op_replay',
          patientId: setup.patientId,
          deviceAnonymousToken: null,
        },
        setup.resumeToken,
        getTestClient(),
      ),
    );
    expect(second).toBeNull();
  });

  it('returns null when the matching submission is no longer in_progress', async () => {
    const programId = `prog_restore_subnotip_${ulid().slice(0, 8)}`;
    const setup = await pauseHelper({
      ctx: US_CTX,
      programId,
      responses: { field_a: 'before_submit' },
    });

    // Out-of-band: flip the submission to 'submitted' so the
    // findInProgressSubmissionForRestore lookup misses. The forms_submission
    // status CHECK allows 'submitted'.
    const client = getTestClient();
    await withTenantContext(TENANT_US, async () => {
      await client.query(
        `UPDATE forms_submission
            SET status = 'submitted', submitted_at = NOW(), updated_at = NOW()
          WHERE submission_id = $1`,
        [setup.submissionId],
      );
    });

    const result = await withTenantContext(TENANT_US, () =>
      submissionService.resumeSubmission(
        US_CTX,
        {
          actorId: 'op_subnotip',
          patientId: setup.patientId,
          deviceAnonymousToken: null,
        },
        setup.resumeToken,
        getTestClient(),
      ),
    );
    expect(result).toBeNull();

    // resume_state row untouched.
    const row = await withTenantContext(TENANT_US, async () => {
      const r = await client.query<{ status: string }>(
        `SELECT status FROM forms_resume_state WHERE resume_state_id = $1`,
        [setup.resumeStateId],
      );
      return r.rows[0];
    });
    expect(row!.status).toBe('active');
  });

  it('returns null when encrypted_partial_responses is corrupted (decrypt fails)', async () => {
    // Seed a resume_state row directly with garbage in the BYTEA column.
    // verifyResumeToken passes (we issue a real token over the seeded
    // resume_state_id); ownership and row-state gates pass; the kms.decrypt
    // call inside the service catches the auth-tag failure and surfaces null.
    const programId = `prog_restore_decryptfail_${ulid().slice(0, 8)}`;
    const { deploymentId } = await seedActiveDeployment({
      ctx: US_CTX,
      programId,
    });

    // Insert an in_progress submission that the lookup will find.
    const patientId = ulid();
    const submissionId = ulid();
    const resumeStateId = ulid();
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

    const client = getTestClient();
    await withTenantContext(TENANT_US, async () => {
      await client.query(
        `INSERT INTO forms_submission (
            submission_id, tenant_id, deployment_id, variant_id,
            patient_id, delegate_id,
            status, responses, mode_2_eligible,
            created_at, updated_at
         ) VALUES (
            $1, $2, $3, NULL,
            $4, NULL,
            'in_progress', '{}'::jsonb, FALSE,
            NOW(), NOW()
         )`,
        [submissionId, TENANT_US, deploymentId, patientId],
      );
      // Garbage ciphertext — too short to even contain iv+tag, so
      // localDevDecrypt throws on length check; the service's try/catch
      // surfaces null.
      await client.query(
        `INSERT INTO forms_resume_state (
            resume_state_id, tenant_id, patient_id, device_anonymous_token,
            deployment_id, variant_id,
            encrypted_partial_responses,
            current_section_index, progress_percent,
            status, expires_at,
            created_at, updated_at, last_saved_at
         ) VALUES (
            $1, $2, $3, NULL,
            $4, NULL,
            $5,
            0, 0,
            'active', $6,
            NOW(), NOW(), NOW()
         )`,
        [
          resumeStateId,
          TENANT_US,
          patientId,
          deploymentId,
          Buffer.from('garbage_too_short'),
          expiresAt,
        ],
      );
    });

    const token = issueResumeToken(resumeStateId, US_CTX.tenantId, expiresAt);

    const result = await withTenantContext(TENANT_US, () =>
      submissionService.resumeSubmission(
        US_CTX,
        {
          actorId: 'op_decryptfail',
          patientId,
          deviceAnonymousToken: null,
        },
        token,
        getTestClient(),
      ),
    );
    expect(result).toBeNull();

    // resume_state row untouched.
    const row = await withTenantContext(TENANT_US, async () => {
      const r = await client.query<{ status: string }>(
        `SELECT status FROM forms_resume_state WHERE resume_state_id = $1`,
        [resumeStateId],
      );
      return r.rows[0];
    });
    expect(row!.status).toBe('active');
  });

  it('returns null when the cipher is well-formed but encrypted under a DIFFERENT tenant key (cross-tenant ciphertext)', async () => {
    // Defense-in-depth on top of cross-tenant token denial: even if a row
    // somehow ended up in tenant US with a payload that was encrypted
    // under tenant Ghana's key, kms.decrypt would fail with auth-tag
    // mismatch (tenantId is mixed into AAD per kms.ts). Verifies the
    // try/catch around kms.decrypt is correctly wired.
    const programId = `prog_restore_crosskms_${ulid().slice(0, 8)}`;
    const { deploymentId } = await seedActiveDeployment({
      ctx: US_CTX,
      programId,
    });

    const patientId = ulid();
    const submissionId = ulid();
    const resumeStateId = ulid();
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

    // Encrypt under Ghana's tenant context — same plaintext, wrong AAD
    // when later decrypted under US context.
    const ghCipher = await kms.encrypt(GH_CTX, Buffer.from(JSON.stringify({ x: 1 }), 'utf8'));

    const client = getTestClient();
    await withTenantContext(TENANT_US, async () => {
      await client.query(
        `INSERT INTO forms_submission (
            submission_id, tenant_id, deployment_id, variant_id,
            patient_id, delegate_id,
            status, responses, mode_2_eligible,
            created_at, updated_at
         ) VALUES (
            $1, $2, $3, NULL,
            $4, NULL,
            'in_progress', '{}'::jsonb, FALSE,
            NOW(), NOW()
         )`,
        [submissionId, TENANT_US, deploymentId, patientId],
      );
      await client.query(
        `INSERT INTO forms_resume_state (
            resume_state_id, tenant_id, patient_id, device_anonymous_token,
            deployment_id, variant_id,
            encrypted_partial_responses,
            current_section_index, progress_percent,
            status, expires_at,
            created_at, updated_at, last_saved_at
         ) VALUES (
            $1, $2, $3, NULL,
            $4, NULL,
            $5,
            0, 0,
            'active', $6,
            NOW(), NOW(), NOW()
         )`,
        [resumeStateId, TENANT_US, patientId, deploymentId, ghCipher, expiresAt],
      );
    });

    const token = issueResumeToken(resumeStateId, US_CTX.tenantId, expiresAt);

    const result = await withTenantContext(TENANT_US, () =>
      submissionService.resumeSubmission(
        US_CTX,
        {
          actorId: 'op_crosskms',
          patientId,
          deviceAnonymousToken: null,
        },
        token,
        getTestClient(),
      ),
    );
    expect(result).toBeNull();
  });
});
