/**
 * Forms/Intake — save-and-resume metadata read-path integration tests.
 *
 * Covers the GET /v0/forms/resume/:resumeToken slice via the service-layer
 * `getResumeStateMetadata` with `externalTx` threaded through. Tokens are
 * issued via `issueResumeToken` (HMAC-self-contained) so tests stay
 * end-to-end without relying on a yet-to-land pause/write path.
 *
 * Spec references:
 *   - Slice PRD v2.1 §8 — save-and-resume.
 *   - I-023 / I-027 — cross-tenant denial via RLS + tenant_id binding in token.
 *   - I-025 — tenant-blind 404 envelope on every failure mode.
 *
 * SPEC ISSUEs honored:
 *   - migration 006 has no `submission_id`, `resume_token`, or
 *     `resume_token_hash` column on forms_resume_state. Tokens are
 *     HMAC-signed envelopes (resume-token.ts); rows are seeded directly via
 *     SQL since the pause/write path is still TODO.
 */

import { describe, expect, it } from 'vitest';

import { asTenantId } from '../../src/lib/glossary.ts';
import type { TenantContext } from '../../src/lib/tenant-context.ts';
import { ulid } from '../../src/lib/ulid.ts';
import {
  issueResumeToken,
  verifyResumeToken,
} from '../../src/modules/forms-intake/internal/services/resume-token.ts';
import * as submissionService from '../../src/modules/forms-intake/internal/services/submission-service.ts';
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

interface SeededResumeState {
  resumeStateId: string;
  deploymentId: string;
  templateId: string;
  expiresAt: string;
}

/**
 * Seed a published template + active deployment + active resume_state row
 * directly via SQL. Used because the pause/write path that would create
 * resume_state rows through the service is still TODO.
 *
 * @param opts.expiresAt   ISO-8601; when omitted, NOW() + 30 days (the
 *                          migration default and the slice PRD §8.4
 *                          tenant-configurable default).
 * @param opts.status      Defaults to 'active'. Used by tests that exercise
 *                          the status-gate in `getResumeStateMetadata`
 *                          (completed/expired both surface as null).
 */
async function seedResumeState(opts: {
  ctx: TenantContext;
  programId: string;
  expiresAt?: string;
  status?: 'active' | 'completed' | 'expired';
  progressPercent?: number;
  currentSectionIndex?: number;
}): Promise<SeededResumeState> {
  const client = getTestClient();
  const templateId = ulid();
  const deploymentId = ulid();
  const resumeStateId = ulid();
  const patientId = ulid();
  const expiresAt = opts.expiresAt ?? new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

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
        `test-resume-${templateId.slice(0, 8)}`,
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
          $6, $7,
          $8, $9,
          NOW(), NOW(), NOW()
       )`,
      [
        resumeStateId,
        opts.ctx.tenantId,
        patientId,
        deploymentId,
        // Empty BYTEA — the metadata path never decrypts so contents are irrelevant.
        Buffer.from(''),
        opts.currentSectionIndex ?? 2,
        opts.progressPercent ?? 35,
        opts.status ?? 'active',
        expiresAt,
      ],
    );
  });

  return { resumeStateId, deploymentId, templateId, expiresAt };
}

// ---------------------------------------------------------------------------
// Token verification (unit-level via the service layer)
// ---------------------------------------------------------------------------

describe('forms-intake resume-token — issue + verify round-trip', () => {
  it('round-trips an issued token to the same identity payload', () => {
    const resumeStateId = ulid();
    const tenantId = US_CTX.tenantId;
    const expiresAt = new Date(Date.now() + 60_000).toISOString();

    const token = issueResumeToken(resumeStateId, tenantId, expiresAt);
    const verified = verifyResumeToken(token);
    expect(verified).not.toBeNull();
    expect(verified?.resumeStateId).toBe(resumeStateId);
    expect(verified?.tenantId).toBe(tenantId);
    expect(verified?.expiresAtMs).toBe(Date.parse(expiresAt));
  });

  it('rejects a token with a flipped signature byte', () => {
    const token = issueResumeToken(
      ulid(),
      US_CTX.tenantId,
      new Date(Date.now() + 60_000).toISOString(),
    );
    // Flip a single character in the signature segment.
    const dotIdx = token.lastIndexOf('.');
    const sig = token.slice(dotIdx + 1);
    const flipped = sig[0] === 'A' ? 'B' : 'A';
    const tampered = token.slice(0, dotIdx + 1) + flipped + sig.slice(1);
    expect(verifyResumeToken(tampered)).toBeNull();
  });

  it('rejects a token whose token-level expiry is in the past', () => {
    const past = new Date(Date.now() - 1).toISOString();
    const token = issueResumeToken(ulid(), US_CTX.tenantId, past);
    expect(verifyResumeToken(token)).toBeNull();
  });

  it('rejects malformed tokens', () => {
    expect(verifyResumeToken('')).toBeNull();
    expect(verifyResumeToken('not-a-token')).toBeNull();
    expect(verifyResumeToken('only-one-dot.')).toBeNull();
    expect(verifyResumeToken('.no-payload')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// getResumeStateMetadata — service layer end-to-end
// ---------------------------------------------------------------------------

describe('forms-intake getResumeStateMetadata — happy path', () => {
  it('returns metadata for a valid token + active row', async () => {
    const programId = `prog_rs_ok_${ulid().slice(0, 8)}`;
    const { resumeStateId, deploymentId, expiresAt } = await seedResumeState({
      ctx: US_CTX,
      programId,
      progressPercent: 42,
      currentSectionIndex: 3,
    });
    const token = issueResumeToken(resumeStateId, US_CTX.tenantId, expiresAt);

    const metadata = await withTenantContext(TENANT_US, () =>
      submissionService.getResumeStateMetadata(US_CTX, token, getTestClient()),
    );

    expect(metadata).not.toBeNull();
    expect(metadata?.resume_state_id).toBe(resumeStateId);
    expect(metadata?.tenant_id).toBe(US_CTX.tenantId);
    expect(metadata?.deployment_id).toBe(deploymentId);
    expect(metadata?.progress_percent).toBe(42);
    expect(metadata?.current_section_index).toBe(3);
    expect(metadata?.status).toBe('active');
  });
});

describe('forms-intake getResumeStateMetadata — failure modes (all surface as null per I-025)', () => {
  it('returns null on a malformed token', async () => {
    const result = await withTenantContext(TENANT_US, () =>
      submissionService.getResumeStateMetadata(US_CTX, 'not-a-real-token', getTestClient()),
    );
    expect(result).toBeNull();
  });

  it('returns null on a token signed for a different tenant', async () => {
    // Token issued in Ghana, presented in the US request context. The HMAC
    // verifies (same shared secret) but the tenant_id binding mismatches —
    // service-layer step 2 rejects.
    const programId = `prog_rs_ct_${ulid().slice(0, 8)}`;
    const { resumeStateId, expiresAt } = await seedResumeState({
      ctx: GH_CTX,
      programId,
    });
    const ghanaToken = issueResumeToken(resumeStateId, GH_CTX.tenantId, expiresAt);

    const result = await withTenantContext(TENANT_US, () =>
      submissionService.getResumeStateMetadata(US_CTX, ghanaToken, getTestClient()),
    );
    expect(result).toBeNull();
  });

  it('returns null when the row is in completed status', async () => {
    const programId = `prog_rs_done_${ulid().slice(0, 8)}`;
    const { resumeStateId, expiresAt } = await seedResumeState({
      ctx: US_CTX,
      programId,
      status: 'completed',
    });
    const token = issueResumeToken(resumeStateId, US_CTX.tenantId, expiresAt);

    const result = await withTenantContext(TENANT_US, () =>
      submissionService.getResumeStateMetadata(US_CTX, token, getTestClient()),
    );
    expect(result).toBeNull();
  });

  it('returns null when the row is in expired status', async () => {
    const programId = `prog_rs_exp_${ulid().slice(0, 8)}`;
    const { resumeStateId, expiresAt } = await seedResumeState({
      ctx: US_CTX,
      programId,
      status: 'expired',
    });
    const token = issueResumeToken(resumeStateId, US_CTX.tenantId, expiresAt);

    const result = await withTenantContext(TENANT_US, () =>
      submissionService.getResumeStateMetadata(US_CTX, token, getTestClient()),
    );
    expect(result).toBeNull();
  });

  it('returns null when the row-level expires_at is in the past', async () => {
    // Seed a row with a row-expires_at in the past, but issue a token whose
    // token-expires_at is in the FUTURE. Token-level gate passes (step 1);
    // row-level expiry gate (step 5) rejects. Defense-in-depth verified.
    const programId = `prog_rs_rowexp_${ulid().slice(0, 8)}`;
    const pastExpiry = new Date(Date.now() - 1000).toISOString();
    const { resumeStateId } = await seedResumeState({
      ctx: US_CTX,
      programId,
      expiresAt: pastExpiry,
    });
    const futureExpiry = new Date(Date.now() + 60_000).toISOString();
    const token = issueResumeToken(resumeStateId, US_CTX.tenantId, futureExpiry);

    const result = await withTenantContext(TENANT_US, () =>
      submissionService.getResumeStateMetadata(US_CTX, token, getTestClient()),
    );
    expect(result).toBeNull();
  });

  it('returns null when the resume_state_id does not exist (token forged for unknown row)', async () => {
    // Verifier signs a syntactically-valid token for a resume_state_id that
    // doesn't have a corresponding row (someone with the platform secret
    // could craft this; in production the secret is restricted, but the
    // gate must hold regardless).
    const fakeId = ulid();
    const futureExpiry = new Date(Date.now() + 60_000).toISOString();
    const token = issueResumeToken(fakeId, US_CTX.tenantId, futureExpiry);

    const result = await withTenantContext(TENANT_US, () =>
      submissionService.getResumeStateMetadata(US_CTX, token, getTestClient()),
    );
    expect(result).toBeNull();
  });

  it('returns null on cross-tenant row presentation (token claims A, row lives in B)', async () => {
    // Edge case: a token that survives HMAC + matches the request's tenant
    // context, but the underlying resume_state_id actually lives in a
    // different tenant. RLS on the SELECT rejects the row. This shouldn't
    // happen via legitimate token issuance (issueResumeToken binds tenant
    // into the payload) but defense-in-depth verifies RLS still holds.
    const programId = `prog_rs_xt_${ulid().slice(0, 8)}`;
    const { resumeStateId, expiresAt } = await seedResumeState({
      ctx: GH_CTX,
      programId,
    });
    // Issue a token that lies about the tenant — claims US, points at a Ghana row.
    const lyingToken = issueResumeToken(resumeStateId, US_CTX.tenantId, expiresAt);

    const result = await withTenantContext(TENANT_US, () =>
      submissionService.getResumeStateMetadata(US_CTX, lyingToken, getTestClient()),
    );
    expect(result).toBeNull();
  });
});
