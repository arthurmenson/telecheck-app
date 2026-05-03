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
  patientId: string | null;
  deviceAnonymousToken: string | null;
  expiresAt: string;
}

/**
 * Seed a published template + active deployment + active resume_state row
 * directly via SQL. Used because the pause/write path that would create
 * resume_state rows through the service is still TODO.
 *
 * @param opts.expiresAt              ISO-8601; when omitted, NOW() + 30 days
 *                                     (the migration default and the slice PRD
 *                                     §8.4 tenant-configurable default).
 * @param opts.status                 Defaults to 'active'. Used by tests that
 *                                     exercise the status-gate in
 *                                     `getResumeStateMetadata` (completed and
 *                                     expired both surface as null).
 * @param opts.identityMode           Defaults to 'patient'. Pick 'anonymous' to
 *                                     seed a row that uses
 *                                     `device_anonymous_token` instead of
 *                                     `patient_id`.
 */
async function seedResumeState(opts: {
  ctx: TenantContext;
  programId: string;
  expiresAt?: string;
  status?: 'active' | 'completed' | 'expired';
  progressPercent?: number;
  currentSectionIndex?: number;
  identityMode?: 'patient' | 'anonymous';
}): Promise<SeededResumeState> {
  const client = getTestClient();
  const templateId = ulid();
  const deploymentId = ulid();
  const resumeStateId = ulid();
  const identityMode = opts.identityMode ?? 'patient';
  const patientId = identityMode === 'patient' ? ulid() : null;
  const deviceAnonymousToken =
    identityMode === 'anonymous' ? `anon_${ulid()}_${ulid().slice(0, 8)}` : null;
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
          $1, $2, $3, $4,
          $5, NULL,
          $6,
          $7, $8,
          $9, $10,
          NOW(), NOW(), NOW()
       )`,
      [
        resumeStateId,
        opts.ctx.tenantId,
        patientId,
        deviceAnonymousToken,
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

  return {
    resumeStateId,
    deploymentId,
    templateId,
    patientId,
    deviceAnonymousToken,
    expiresAt,
  };
}

/**
 * Build an `ownership` arg suitable for `getResumeStateMetadata`. Tests
 * that don't supply explicit identity get the seed's identity (the happy-
 * path actor); cross-actor tests pass `differentPatient` etc. explicitly.
 */
function ownershipFromSeed(seed: SeededResumeState): {
  patientId: string | null;
  deviceAnonymousToken: string | null;
} {
  return { patientId: seed.patientId, deviceAnonymousToken: seed.deviceAnonymousToken };
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
  it('returns metadata for a valid token + active row + matching patient owner', async () => {
    const programId = `prog_rs_ok_${ulid().slice(0, 8)}`;
    const seed = await seedResumeState({
      ctx: US_CTX,
      programId,
      progressPercent: 42,
      currentSectionIndex: 3,
    });
    const token = issueResumeToken(seed.resumeStateId, US_CTX.tenantId, seed.expiresAt);

    const metadata = await withTenantContext(TENANT_US, () =>
      submissionService.getResumeStateMetadata(
        US_CTX,
        ownershipFromSeed(seed),
        token,
        getTestClient(),
      ),
    );

    expect(metadata).not.toBeNull();
    expect(metadata?.resume_state_id).toBe(seed.resumeStateId);
    expect(metadata?.deployment_id).toBe(seed.deploymentId);
    expect(metadata?.progress_percent).toBe(42);
    expect(metadata?.current_section_index).toBe(3);
    expect(metadata?.status).toBe('active');
  });

  // Codex resume-r1 MEDIUM closure 2026-05-03 — patient surface MUST NOT
  // render `tenant_id`. Master PRD v1.10 §17 + Glossary v5.2 C3.
  it('does NOT include tenant_id in the patient-facing response', async () => {
    const programId = `prog_rs_notenant_${ulid().slice(0, 8)}`;
    const seed = await seedResumeState({ ctx: US_CTX, programId });
    const token = issueResumeToken(seed.resumeStateId, US_CTX.tenantId, seed.expiresAt);

    const metadata = await withTenantContext(TENANT_US, () =>
      submissionService.getResumeStateMetadata(
        US_CTX,
        ownershipFromSeed(seed),
        token,
        getTestClient(),
      ),
    );

    expect(metadata).not.toBeNull();
    // Type-level: `ResumeStateMetadata` has no tenant_id field.
    // Runtime-level: ensure no key named tenant_id leaks via a wider type.
    expect(metadata && Object.keys(metadata)).not.toContain('tenant_id');
  });

  it('returns metadata for a valid anonymous-flow row + matching device token', async () => {
    const programId = `prog_rs_anon_${ulid().slice(0, 8)}`;
    const seed = await seedResumeState({
      ctx: US_CTX,
      programId,
      identityMode: 'anonymous',
    });
    const token = issueResumeToken(seed.resumeStateId, US_CTX.tenantId, seed.expiresAt);

    const metadata = await withTenantContext(TENANT_US, () =>
      submissionService.getResumeStateMetadata(
        US_CTX,
        ownershipFromSeed(seed),
        token,
        getTestClient(),
      ),
    );
    expect(metadata).not.toBeNull();
    expect(metadata?.resume_state_id).toBe(seed.resumeStateId);
  });
});

describe('forms-intake getResumeStateMetadata — failure modes (all surface as null per I-025)', () => {
  // Codex resume-r1 HIGH closure 2026-05-03 — bearer-only tokens are not
  // sufficient. The actor's resolved patient identity MUST match the row's
  // patient_id; mismatch surfaces as null.
  it('returns null on cross-patient access (correct token + wrong patient)', async () => {
    const programId = `prog_rs_xpat_${ulid().slice(0, 8)}`;
    const seed = await seedResumeState({ ctx: US_CTX, programId });
    const token = issueResumeToken(seed.resumeStateId, US_CTX.tenantId, seed.expiresAt);

    // Different patient presents the same token — even though the token's
    // HMAC + tenant + expiry all check out, the ownership gate rejects.
    const differentPatientId = ulid();
    const result = await withTenantContext(TENANT_US, () =>
      submissionService.getResumeStateMetadata(
        US_CTX,
        { patientId: differentPatientId, deviceAnonymousToken: null },
        token,
        getTestClient(),
      ),
    );
    expect(result).toBeNull();
  });

  it('returns null when no patient identity is presented for a known-patient row', async () => {
    const programId = `prog_rs_nopat_${ulid().slice(0, 8)}`;
    const seed = await seedResumeState({ ctx: US_CTX, programId });
    const token = issueResumeToken(seed.resumeStateId, US_CTX.tenantId, seed.expiresAt);

    // Both identity anchors null — handler shim would have rejected at
    // 401, but we exercise the service-layer gate independently.
    const result = await withTenantContext(TENANT_US, () =>
      submissionService.getResumeStateMetadata(
        US_CTX,
        { patientId: null, deviceAnonymousToken: null },
        token,
        getTestClient(),
      ),
    );
    expect(result).toBeNull();
  });

  it('returns null on cross-device access for an anonymous-flow row', async () => {
    const programId = `prog_rs_xanon_${ulid().slice(0, 8)}`;
    const seed = await seedResumeState({
      ctx: US_CTX,
      programId,
      identityMode: 'anonymous',
    });
    const token = issueResumeToken(seed.resumeStateId, US_CTX.tenantId, seed.expiresAt);

    const result = await withTenantContext(TENANT_US, () =>
      submissionService.getResumeStateMetadata(
        US_CTX,
        { patientId: null, deviceAnonymousToken: 'anon_DIFFERENT_DEVICE' },
        token,
        getTestClient(),
      ),
    );
    expect(result).toBeNull();
  });

  it('returns null on a malformed token', async () => {
    const result = await withTenantContext(TENANT_US, () =>
      submissionService.getResumeStateMetadata(
        US_CTX,
        { patientId: ulid(), deviceAnonymousToken: null },
        'not-a-real-token',
        getTestClient(),
      ),
    );
    expect(result).toBeNull();
  });

  it('returns null on a token signed for a different tenant', async () => {
    // Token issued in Ghana, presented in the US request context. The HMAC
    // verifies (same shared secret) but the tenant_id binding mismatches —
    // service-layer step 2 rejects.
    const programId = `prog_rs_ct_${ulid().slice(0, 8)}`;
    const seed = await seedResumeState({ ctx: GH_CTX, programId });
    const ghanaToken = issueResumeToken(seed.resumeStateId, GH_CTX.tenantId, seed.expiresAt);

    const result = await withTenantContext(TENANT_US, () =>
      submissionService.getResumeStateMetadata(
        US_CTX,
        ownershipFromSeed(seed),
        ghanaToken,
        getTestClient(),
      ),
    );
    expect(result).toBeNull();
  });

  it('returns null when the row is in completed status', async () => {
    const programId = `prog_rs_done_${ulid().slice(0, 8)}`;
    const seed = await seedResumeState({
      ctx: US_CTX,
      programId,
      status: 'completed',
    });
    const token = issueResumeToken(seed.resumeStateId, US_CTX.tenantId, seed.expiresAt);

    const result = await withTenantContext(TENANT_US, () =>
      submissionService.getResumeStateMetadata(
        US_CTX,
        ownershipFromSeed(seed),
        token,
        getTestClient(),
      ),
    );
    expect(result).toBeNull();
  });

  it('returns null when the row is in expired status', async () => {
    const programId = `prog_rs_exp_${ulid().slice(0, 8)}`;
    const seed = await seedResumeState({
      ctx: US_CTX,
      programId,
      status: 'expired',
    });
    const token = issueResumeToken(seed.resumeStateId, US_CTX.tenantId, seed.expiresAt);

    const result = await withTenantContext(TENANT_US, () =>
      submissionService.getResumeStateMetadata(
        US_CTX,
        ownershipFromSeed(seed),
        token,
        getTestClient(),
      ),
    );
    expect(result).toBeNull();
  });

  it('returns null when the row-level expires_at is in the past', async () => {
    // Seed a row with a row-expires_at in the past, but issue a token whose
    // token-expires_at is in the FUTURE. Token-level gate passes (step 1);
    // row-level expiry gate (step 6) rejects. Defense-in-depth verified.
    const programId = `prog_rs_rowexp_${ulid().slice(0, 8)}`;
    const pastExpiry = new Date(Date.now() - 1000).toISOString();
    const seed = await seedResumeState({
      ctx: US_CTX,
      programId,
      expiresAt: pastExpiry,
    });
    const futureExpiry = new Date(Date.now() + 60_000).toISOString();
    const token = issueResumeToken(seed.resumeStateId, US_CTX.tenantId, futureExpiry);

    const result = await withTenantContext(TENANT_US, () =>
      submissionService.getResumeStateMetadata(
        US_CTX,
        ownershipFromSeed(seed),
        token,
        getTestClient(),
      ),
    );
    expect(result).toBeNull();
  });

  it('returns null when the resume_state_id does not exist (token forged for unknown row)', async () => {
    const fakeId = ulid();
    const futureExpiry = new Date(Date.now() + 60_000).toISOString();
    const token = issueResumeToken(fakeId, US_CTX.tenantId, futureExpiry);

    const result = await withTenantContext(TENANT_US, () =>
      submissionService.getResumeStateMetadata(
        US_CTX,
        { patientId: ulid(), deviceAnonymousToken: null },
        token,
        getTestClient(),
      ),
    );
    expect(result).toBeNull();
  });

  it('returns null on cross-tenant row presentation (token claims A, row lives in B)', async () => {
    // Token claims US, but the resume_state_id actually lives in Ghana.
    // RLS on the SELECT rejects the row. Defense-in-depth verifies RLS
    // still holds even when the token survives steps 1-2.
    const programId = `prog_rs_xt_${ulid().slice(0, 8)}`;
    const seed = await seedResumeState({ ctx: GH_CTX, programId });
    const lyingToken = issueResumeToken(seed.resumeStateId, US_CTX.tenantId, seed.expiresAt);

    const result = await withTenantContext(TENANT_US, () =>
      submissionService.getResumeStateMetadata(
        US_CTX,
        // Even with the legitimate Ghana patient identity, the US tenant
        // context's RLS rejects the row before ownership is checked.
        { patientId: seed.patientId, deviceAnonymousToken: null },
        lyingToken,
        getTestClient(),
      ),
    );
    expect(result).toBeNull();
  });
});
