/**
 * Forms/Intake — A/B variant create + read integration tests.
 *
 * Covers:
 *   - createVariant: happy path (creates row, emits Category B audit),
 *     VARIANT_PRECONDITION_FAILED on retired deployment + cross-tenant
 *     variant_template, VARIANT_LABEL_CONFLICT on duplicate (deployment,
 *     label).
 *   - getVariant: hit / tenant-blind miss.
 *
 * The variant promote handler remains stubbed; covered in a future batch
 * once statistical-significance + batch-retire-losers logic lands.
 *
 * Spec references:
 *   - Slice PRD v2.1 §14 A/B testing native.
 *   - I-023 / I-027 cross-tenant denial via RLS + composite FK.
 *   - I-025 tenant-blind 404 envelope on miss.
 *   - AUDIT_EVENTS v5.2 §Category B (admin governance).
 */

import { describe, expect, it } from 'vitest';

import { asTenantId } from '../../src/lib/glossary.ts';
import type { TenantContext } from '../../src/lib/tenant-context.ts';
import { ulid } from '../../src/lib/ulid.ts';
import * as submissionRepo from '../../src/modules/forms-intake/internal/repositories/submission-repo.ts';
import * as templateService from '../../src/modules/forms-intake/internal/services/template-service.ts';
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
 * Seed a published template + active deployment for the active tenant.
 * Optionally retire the deployment so tests can exercise the
 * VARIANT_PRECONDITION_FAILED path. Mirrors the helper from
 * forms-intake-submission.test.ts.
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
        `test-variant-${templateId.slice(0, 8)}`,
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

/**
 * Seed an additional template under the given tenant — used as a
 * `variantTemplateId` for non-Control variant arms (which use a
 * separately-authored modified template per Slice PRD §14.1).
 *
 * @param opts.status — defaults to 'published' (the only status that
 *   passes the variant-create publish gate). Tests exercising the
 *   Codex variants-r1 HIGH-2 closure (publish gate) pass 'draft' /
 *   'superseded' / 'archived' explicitly to prove rejection.
 */
async function seedAdditionalTemplate(opts: {
  ctx: TenantContext;
  programId: string;
  status?: 'draft' | 'published' | 'superseded' | 'archived';
}): Promise<string> {
  const client = getTestClient();
  const templateId = ulid();
  const status = opts.status ?? 'published';
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
          2, $5, $6, $7,
          '{}'::jsonb, '{}'::jsonb,
          '{}'::jsonb, '{}'::jsonb,
          $8, NOW(), NOW()
       )`,
      // template_version=2 here, NOT 1 — the test seeds an ADDITIONAL
      // template under the same (tenant_id, program_id, country_of_care)
      // family as `seedActiveDeployment` (which uses version=1).
      // `uq_template_version` (tenant, program, country, version) rejects
      // collision; bumping the version side-steps the constraint while
      // preserving the "two templates in the same program family" intent
      // (Pattern A — multiple versions per family, one published at a
      // time per FORMS_ENGINE v5.2). Codex tenant-mapping-r0 closure
      // 2026-05-04: prior version=1 collided whenever both seeds were
      // called with the same programId in a single test.
      [
        templateId,
        opts.ctx.tenantId,
        opts.programId,
        opts.ctx.countryOfCare,
        status,
        `test-variant-tpl-${templateId.slice(0, 8)}`,
        ulid(),
        // published_at must be set when status='published' (the migration
        // doesn't enforce this directly, but other repo paths assume it).
        status === 'published' ? new Date() : null,
      ],
    );
  });
  return templateId;
}

// ---------------------------------------------------------------------------
// createVariant — happy path
// ---------------------------------------------------------------------------

describe('forms-intake createVariant — happy path', () => {
  it('creates an active control variant on a deployment + emits Category B audit', async () => {
    const programId = `prog_var_ok_${ulid().slice(0, 8)}`;
    const { templateId, deploymentId } = await seedActiveDeployment({
      ctx: US_CTX,
      programId,
    });

    const variant = await withTenantContext(TENANT_US, () =>
      templateService.createVariant(
        US_CTX,
        'op_variant_create',
        {
          deploymentId,
          variantTemplateId: templateId,
          label: 'control',
          trafficPercent: 50,
        },
        getTestClient(),
      ),
    );

    expect(variant.deployment_id).toBe(deploymentId);
    expect(variant.variant_template_id).toBe(templateId);
    expect(variant.variant_label).toBe('control');
    expect(variant.traffic_percent).toBe(50);
    expect(variant.status).toBe('active');
    expect(variant.created_by).toBe('op_variant_create');

    await withTenantContext(TENANT_US, () =>
      assertAuditRecordExists(
        TENANT_US,
        (rec) =>
          rec.action === ('forms_variant_created' as typeof rec.action) &&
          rec.category === 'B' &&
          rec.resource_id === variant.variant_id &&
          rec.target_patient_id === null,
      ),
    );

    // Domain event 'forms_variant.created' lands in outbox same-tx
    // (wired at ba2bc41 alongside SI-003).
    const evRow = await withTenantContext(TENANT_US, async () => {
      const r = await getTestClient().query<{
        event_type: string;
        aggregate_type: string;
        payload: Record<string, unknown>;
      }>(
        `SELECT event_type, aggregate_type, payload
           FROM domain_events_outbox
          WHERE tenant_id = $1
            AND aggregate_id = $2
            AND event_type = 'forms_variant.created'`,
        [TENANT_US, variant.variant_id],
      );
      return r.rows[0] ?? null;
    });
    expect(evRow).not.toBeNull();
    expect(evRow!.aggregate_type).toBe('forms_variant');
    expect(evRow!.payload['label']).toBe('control');
    expect(evRow!.payload['traffic_percent']).toBe(50);
  });

  it('supports a non-Control arm pointing at a separately-authored template', async () => {
    const programId = `prog_var_alt_${ulid().slice(0, 8)}`;
    const { deploymentId } = await seedActiveDeployment({
      ctx: US_CTX,
      programId,
    });
    const altTemplateId = await seedAdditionalTemplate({ ctx: US_CTX, programId });

    const variant = await withTenantContext(TENANT_US, () =>
      templateService.createVariant(
        US_CTX,
        'op_variant_alt',
        {
          deploymentId,
          variantTemplateId: altTemplateId,
          label: 'A',
          trafficPercent: 25,
        },
        getTestClient(),
      ),
    );

    expect(variant.variant_template_id).toBe(altTemplateId);
    expect(variant.variant_label).toBe('A');
    expect(variant.traffic_percent).toBe(25);
  });
});

// ---------------------------------------------------------------------------
// createVariant — failure modes
// ---------------------------------------------------------------------------

describe('forms-intake createVariant — failure modes', () => {
  it('rejects a variant on a retired deployment with VARIANT_PRECONDITION_FAILED', async () => {
    const programId = `prog_var_retired_${ulid().slice(0, 8)}`;
    const { templateId, deploymentId } = await seedActiveDeployment({
      ctx: US_CTX,
      programId,
      retired: true,
    });

    await expect(
      withTenantContext(TENANT_US, () =>
        templateService.createVariant(
          US_CTX,
          'op_variant_retired',
          {
            deploymentId,
            variantTemplateId: templateId,
            label: 'control',
            trafficPercent: 100,
          },
          getTestClient(),
        ),
      ),
    ).rejects.toThrow(submissionRepo.VARIANT_PRECONDITION_FAILED);
  });

  it('rejects a duplicate (deployment, label) pair with VARIANT_LABEL_CONFLICT', async () => {
    const programId = `prog_var_dup_${ulid().slice(0, 8)}`;
    const { templateId, deploymentId } = await seedActiveDeployment({
      ctx: US_CTX,
      programId,
    });

    await withTenantContext(TENANT_US, () =>
      templateService.createVariant(
        US_CTX,
        'op_variant_first',
        {
          deploymentId,
          variantTemplateId: templateId,
          label: 'control',
          trafficPercent: 100,
        },
        getTestClient(),
      ),
    );

    await expect(
      withTenantContext(TENANT_US, () =>
        templateService.createVariant(
          US_CTX,
          'op_variant_second',
          {
            deploymentId,
            variantTemplateId: templateId,
            label: 'control', // same label — must conflict
            trafficPercent: 50,
          },
          getTestClient(),
        ),
      ),
    ).rejects.toThrow(submissionRepo.VARIANT_LABEL_CONFLICT);
  });

  it('rejects a cross-tenant variant_template_id (composite FK + RLS)', async () => {
    // Seed a deployment in US and a template in Ghana; try to bind them.
    // The INSERT...SELECT predicate `t.tenant_id = $2` filters out the
    // Ghana template under the US tenant context; zero rows returned →
    // VARIANT_PRECONDITION_FAILED.
    const programId = `prog_var_xt_${ulid().slice(0, 8)}`;
    const { deploymentId } = await seedActiveDeployment({
      ctx: US_CTX,
      programId,
    });
    const ghanaTemplateId = await seedAdditionalTemplate({
      ctx: GH_CTX,
      programId: `prog_var_xt_gh_${ulid().slice(0, 8)}`,
    });

    await expect(
      withTenantContext(TENANT_US, () =>
        templateService.createVariant(
          US_CTX,
          'op_variant_xt',
          {
            deploymentId,
            variantTemplateId: ghanaTemplateId,
            label: 'A',
            trafficPercent: 50,
          },
          getTestClient(),
        ),
      ),
    ).rejects.toThrow(submissionRepo.VARIANT_PRECONDITION_FAILED);
  });

  it('rejects a missing deployment with VARIANT_PRECONDITION_FAILED', async () => {
    const fakeDeployment = ulid();
    const fakeTemplate = ulid();

    await expect(
      withTenantContext(TENANT_US, () =>
        templateService.createVariant(
          US_CTX,
          'op_variant_missing',
          {
            deploymentId: fakeDeployment,
            variantTemplateId: fakeTemplate,
            label: 'control',
            trafficPercent: 100,
          },
          getTestClient(),
        ),
      ),
    ).rejects.toThrow(submissionRepo.VARIANT_PRECONDITION_FAILED);
  });

  // Codex variants-r1 HIGH-2 closure 2026-05-03 — variant_template MUST be
  // published. A draft / superseded / archived template represents content
  // that hasn't passed I-013 + I-015 + I-030 publish-time gates; routing
  // active intake traffic to it is a clinical safety violation.
  it('rejects a draft variant_template with VARIANT_PRECONDITION_FAILED', async () => {
    const programId = `prog_var_draft_${ulid().slice(0, 8)}`;
    const { deploymentId } = await seedActiveDeployment({ ctx: US_CTX, programId });
    const draftTemplateId = await seedAdditionalTemplate({
      ctx: US_CTX,
      programId,
      status: 'draft',
    });

    await expect(
      withTenantContext(TENANT_US, () =>
        templateService.createVariant(
          US_CTX,
          'op_variant_draft',
          {
            deploymentId,
            variantTemplateId: draftTemplateId,
            label: 'A',
            trafficPercent: 25,
          },
          getTestClient(),
        ),
      ),
    ).rejects.toThrow(submissionRepo.VARIANT_PRECONDITION_FAILED);
  });

  it('rejects a superseded variant_template with VARIANT_PRECONDITION_FAILED', async () => {
    const programId = `prog_var_super_${ulid().slice(0, 8)}`;
    const { deploymentId } = await seedActiveDeployment({ ctx: US_CTX, programId });
    const supersededTemplateId = await seedAdditionalTemplate({
      ctx: US_CTX,
      programId,
      status: 'superseded',
    });

    await expect(
      withTenantContext(TENANT_US, () =>
        templateService.createVariant(
          US_CTX,
          'op_variant_super',
          {
            deploymentId,
            variantTemplateId: supersededTemplateId,
            label: 'A',
            trafficPercent: 25,
          },
          getTestClient(),
        ),
      ),
    ).rejects.toThrow(submissionRepo.VARIANT_PRECONDITION_FAILED);
  });

  // Codex variants-promote-r2 HIGH closure 2026-05-03 — once a winner
  // has been promoted on a deployment, no further active arms may be
  // created. The deployment-level FOR UPDATE lock alone serialized
  // promote-vs-create, but createVariant's predicate `retired_at IS NULL`
  // didn't reject on its own once the lock released. The new
  // `no_winner_yet` CTE finalizes the experiment.
  it('rejects creating a new variant after a winner has been promoted on the deployment', async () => {
    const programId = `prog_var_postwinner_${ulid().slice(0, 8)}`;
    const { templateId, deploymentId } = await seedActiveDeployment({
      ctx: US_CTX,
      programId,
    });
    const altTemplateId = await seedAdditionalTemplate({ ctx: US_CTX, programId });

    // Set up + promote winner.
    const winner = await withTenantContext(TENANT_US, () =>
      templateService.createVariant(
        US_CTX,
        'op_postwin_setup',
        {
          deploymentId,
          variantTemplateId: templateId,
          label: 'control',
          trafficPercent: 100,
        },
        getTestClient(),
      ),
    );
    await withTenantContext(TENANT_US, () =>
      templateService.promoteVariant(
        US_CTX,
        'op_postwin_promote',
        winner.variant_id,
        {
          rationale: 'first',
          sampleSize: 1000,
          pValue: 0.01,
        },
        getTestClient(),
      ),
    );

    // Attempt to create a new active variant on the now-finalized deployment.
    await expect(
      withTenantContext(TENANT_US, () =>
        templateService.createVariant(
          US_CTX,
          'op_postwin_late',
          {
            deploymentId,
            variantTemplateId: altTemplateId,
            label: 'A',
            trafficPercent: 25,
          },
          getTestClient(),
        ),
      ),
    ).rejects.toThrow(submissionRepo.VARIANT_PRECONDITION_FAILED);
  });

  it('rejects an archived variant_template with VARIANT_PRECONDITION_FAILED', async () => {
    const programId = `prog_var_arch_${ulid().slice(0, 8)}`;
    const { deploymentId } = await seedActiveDeployment({ ctx: US_CTX, programId });
    const archivedTemplateId = await seedAdditionalTemplate({
      ctx: US_CTX,
      programId,
      status: 'archived',
    });

    await expect(
      withTenantContext(TENANT_US, () =>
        templateService.createVariant(
          US_CTX,
          'op_variant_arch',
          {
            deploymentId,
            variantTemplateId: archivedTemplateId,
            label: 'A',
            trafficPercent: 25,
          },
          getTestClient(),
        ),
      ),
    ).rejects.toThrow(submissionRepo.VARIANT_PRECONDITION_FAILED);
  });
});

// ---------------------------------------------------------------------------
// getVariant — read path
// ---------------------------------------------------------------------------

describe('forms-intake getVariant — hit + tenant-blind miss', () => {
  it('returns the variant for a same-tenant lookup', async () => {
    const programId = `prog_var_get_${ulid().slice(0, 8)}`;
    const { templateId, deploymentId } = await seedActiveDeployment({
      ctx: US_CTX,
      programId,
    });

    const created = await withTenantContext(TENANT_US, () =>
      templateService.createVariant(
        US_CTX,
        'op_get',
        {
          deploymentId,
          variantTemplateId: templateId,
          label: 'control',
          trafficPercent: 100,
        },
        getTestClient(),
      ),
    );

    const fetched = await withTenantContext(TENANT_US, () =>
      templateService.getVariant(US_CTX, created.variant_id, getTestClient()),
    );
    expect(fetched).not.toBeNull();
    expect(fetched?.variant_id).toBe(created.variant_id);
    expect(fetched?.deployment_id).toBe(deploymentId);
  });

  it('returns null for a cross-tenant lookup (RLS-filtered)', async () => {
    const programId = `prog_var_xtread_${ulid().slice(0, 8)}`;
    const { templateId, deploymentId } = await seedActiveDeployment({
      ctx: US_CTX,
      programId,
    });

    const created = await withTenantContext(TENANT_US, () =>
      templateService.createVariant(
        US_CTX,
        'op_xtread',
        {
          deploymentId,
          variantTemplateId: templateId,
          label: 'control',
          trafficPercent: 100,
        },
        getTestClient(),
      ),
    );

    const fetched = await withTenantContext(TENANT_GHANA, () =>
      templateService.getVariant(GH_CTX, created.variant_id, getTestClient()),
    );
    expect(fetched).toBeNull();
  });

  it('returns null for a missing variant_id', async () => {
    const fetched = await withTenantContext(TENANT_US, () =>
      templateService.getVariant(US_CTX, ulid(), getTestClient()),
    );
    expect(fetched).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// promoteVariant — winner promotion + losing-arm batch retire
// ---------------------------------------------------------------------------

describe('forms-intake promoteVariant — winner promotion', () => {
  it('promotes target variant, retires sibling actives, emits one audit per row', async () => {
    const programId = `prog_var_promote_${ulid().slice(0, 8)}`;
    const { templateId, deploymentId } = await seedActiveDeployment({
      ctx: US_CTX,
      programId,
    });
    const altTemplateId = await seedAdditionalTemplate({ ctx: US_CTX, programId });

    // Three active variants on the same deployment: control + A + B.
    const control = await withTenantContext(TENANT_US, () =>
      templateService.createVariant(
        US_CTX,
        'op_promote_setup',
        {
          deploymentId,
          variantTemplateId: templateId,
          label: 'control',
          trafficPercent: 50,
        },
        getTestClient(),
      ),
    );
    const armA = await withTenantContext(TENANT_US, () =>
      templateService.createVariant(
        US_CTX,
        'op_promote_setup',
        {
          deploymentId,
          variantTemplateId: altTemplateId,
          label: 'A',
          trafficPercent: 25,
        },
        getTestClient(),
      ),
    );
    const armB = await withTenantContext(TENANT_US, () =>
      templateService.createVariant(
        US_CTX,
        'op_promote_setup',
        {
          deploymentId,
          variantTemplateId: altTemplateId,
          label: 'B',
          trafficPercent: 25,
        },
        getTestClient(),
      ),
    );

    // Promote arm A as winner.
    const promoted = await withTenantContext(TENANT_US, () =>
      templateService.promoteVariant(
        US_CTX,
        'op_promote',
        armA.variant_id,
        {
          rationale: 'Arm A converted 12% better; p < 0.01 over n=2000 sessions.',
          sampleSize: 2000,
          pValue: 0.005,
        },
        getTestClient(),
      ),
    );
    expect(promoted.status).toBe('winner');
    expect(promoted.variant_id).toBe(armA.variant_id);

    // Verify control + arm B both retired.
    const controlAfter = await withTenantContext(TENANT_US, () =>
      templateService.getVariant(US_CTX, control.variant_id, getTestClient()),
    );
    const armBAfter = await withTenantContext(TENANT_US, () =>
      templateService.getVariant(US_CTX, armB.variant_id, getTestClient()),
    );
    expect(controlAfter?.status).toBe('retired');
    expect(controlAfter?.retired_by).toBe('op_promote');
    expect(armBAfter?.status).toBe('retired');
    expect(armBAfter?.retired_by).toBe('op_promote');

    // Winner-promotion audit (Category B, target_patient_id null).
    await withTenantContext(TENANT_US, () =>
      assertAuditRecordExists(
        TENANT_US,
        (rec) =>
          rec.action === ('forms_variant_winner_promoted' as typeof rec.action) &&
          rec.category === 'B' &&
          rec.resource_id === armA.variant_id &&
          rec.target_patient_id === null,
      ),
    );
    // One retire audit per loser.
    await withTenantContext(TENANT_US, () =>
      assertAuditRecordExists(
        TENANT_US,
        (rec) =>
          rec.action === ('forms_variant_retired' as typeof rec.action) &&
          rec.category === 'B' &&
          rec.resource_id === control.variant_id &&
          rec.target_patient_id === null,
      ),
    );
    await withTenantContext(TENANT_US, () =>
      assertAuditRecordExists(
        TENANT_US,
        (rec) =>
          rec.action === ('forms_variant_retired' as typeof rec.action) &&
          rec.category === 'B' &&
          rec.resource_id === armB.variant_id &&
          rec.target_patient_id === null,
      ),
    );

    // Domain events lands in outbox same-tx with the audit emissions
    // (Sprint 1 / TLC-003 — closes the last forms-intake outbox-landing
    // gaps). One winner_promoted event + one retired event per loser.
    const winnerEv = await withTenantContext(TENANT_US, async () => {
      const r = await getTestClient().query<{
        event_type: string;
        aggregate_type: string;
        payload: Record<string, unknown>;
      }>(
        `SELECT event_type, aggregate_type, payload
           FROM domain_events_outbox
          WHERE tenant_id = $1
            AND aggregate_id = $2
            AND event_type = 'forms_variant.winner_promoted'`,
        [TENANT_US, armA.variant_id],
      );
      return r.rows[0] ?? null;
    });
    expect(winnerEv).not.toBeNull();
    expect(winnerEv!.aggregate_type).toBe('forms_variant');
    expect(winnerEv!.payload['rationale']).toBeDefined();

    // Retired event for control.
    const controlRetiredEv = await withTenantContext(TENANT_US, async () => {
      const r = await getTestClient().query<{ payload: Record<string, unknown> }>(
        `SELECT payload FROM domain_events_outbox
          WHERE tenant_id = $1
            AND aggregate_id = $2
            AND event_type = 'forms_variant.retired'`,
        [TENANT_US, control.variant_id],
      );
      return r.rows[0] ?? null;
    });
    expect(controlRetiredEv).not.toBeNull();
    expect(controlRetiredEv!.payload['promoted_winner_id']).toBe(armA.variant_id);

    // Retired event for armB.
    const armBRetiredEv = await withTenantContext(TENANT_US, async () => {
      const r = await getTestClient().query<{ payload: Record<string, unknown> }>(
        `SELECT payload FROM domain_events_outbox
          WHERE tenant_id = $1
            AND aggregate_id = $2
            AND event_type = 'forms_variant.retired'`,
        [TENANT_US, armB.variant_id],
      );
      return r.rows[0] ?? null;
    });
    expect(armBRetiredEv).not.toBeNull();
    expect(armBRetiredEv!.payload['promoted_winner_id']).toBe(armA.variant_id);
  });
});

describe('forms-intake promoteVariant — failure modes', () => {
  it('rejects a missing variant with VARIANT_NOT_FOUND', async () => {
    const fakeVariantId = ulid();
    await expect(
      withTenantContext(TENANT_US, () =>
        templateService.promoteVariant(
          US_CTX,
          'op_promote_missing',
          fakeVariantId,
          {
            rationale: 'forced',
            sampleSize: 100,
            pValue: 0.05,
          },
          getTestClient(),
        ),
      ),
    ).rejects.toThrow(submissionRepo.VARIANT_NOT_FOUND);
  });

  it('rejects an already-winner variant with VARIANT_NOT_ACTIVE', async () => {
    const programId = `prog_var_promote_dup_${ulid().slice(0, 8)}`;
    const { templateId, deploymentId } = await seedActiveDeployment({
      ctx: US_CTX,
      programId,
    });

    const control = await withTenantContext(TENANT_US, () =>
      templateService.createVariant(
        US_CTX,
        'op_pdsetup',
        {
          deploymentId,
          variantTemplateId: templateId,
          label: 'control',
          trafficPercent: 100,
        },
        getTestClient(),
      ),
    );

    // First promote: control → winner.
    await withTenantContext(TENANT_US, () =>
      templateService.promoteVariant(
        US_CTX,
        'op_pd_first',
        control.variant_id,
        {
          rationale: 'first promote',
          sampleSize: 500,
          pValue: 0.01,
        },
        getTestClient(),
      ),
    );

    // Second promote on the same (now winner) variant rejects.
    await expect(
      withTenantContext(TENANT_US, () =>
        templateService.promoteVariant(
          US_CTX,
          'op_pd_second',
          control.variant_id,
          {
            rationale: 'second promote',
            sampleSize: 500,
            pValue: 0.01,
          },
          getTestClient(),
        ),
      ),
    ).rejects.toThrow(submissionRepo.VARIANT_NOT_ACTIVE);
  });

  it('rejects a retired variant with VARIANT_NOT_ACTIVE', async () => {
    const programId = `prog_var_promote_ret_${ulid().slice(0, 8)}`;
    const { templateId, deploymentId } = await seedActiveDeployment({
      ctx: US_CTX,
      programId,
    });
    const altTemplateId = await seedAdditionalTemplate({ ctx: US_CTX, programId });

    const winner = await withTenantContext(TENANT_US, () =>
      templateService.createVariant(
        US_CTX,
        'op_ret_setup',
        {
          deploymentId,
          variantTemplateId: templateId,
          label: 'control',
          trafficPercent: 50,
        },
        getTestClient(),
      ),
    );
    const loser = await withTenantContext(TENANT_US, () =>
      templateService.createVariant(
        US_CTX,
        'op_ret_setup',
        {
          deploymentId,
          variantTemplateId: altTemplateId,
          label: 'A',
          trafficPercent: 50,
        },
        getTestClient(),
      ),
    );

    // Promote winner → retires loser.
    await withTenantContext(TENANT_US, () =>
      templateService.promoteVariant(
        US_CTX,
        'op_ret_promote',
        winner.variant_id,
        {
          rationale: 'r',
          sampleSize: 100,
          pValue: 0.04,
        },
        getTestClient(),
      ),
    );

    // Now attempt to promote the retired loser — must fail.
    await expect(
      withTenantContext(TENANT_US, () =>
        templateService.promoteVariant(
          US_CTX,
          'op_ret_attempt',
          loser.variant_id,
          {
            rationale: 'belated',
            sampleSize: 100,
            pValue: 0.04,
          },
          getTestClient(),
        ),
      ),
    ).rejects.toThrow(submissionRepo.VARIANT_NOT_ACTIVE);
  });

  it('rejects a cross-tenant promote attempt with VARIANT_NOT_FOUND', async () => {
    const programId = `prog_var_promote_xt_${ulid().slice(0, 8)}`;
    const { templateId, deploymentId } = await seedActiveDeployment({
      ctx: US_CTX,
      programId,
    });
    const usVariant = await withTenantContext(TENANT_US, () =>
      templateService.createVariant(
        US_CTX,
        'op_xt_setup',
        {
          deploymentId,
          variantTemplateId: templateId,
          label: 'control',
          trafficPercent: 100,
        },
        getTestClient(),
      ),
    );

    // Ghana attempt to promote the US variant — RLS rejects.
    await expect(
      withTenantContext(TENANT_GHANA, () =>
        templateService.promoteVariant(
          GH_CTX,
          'op_xt_attempt',
          usVariant.variant_id,
          {
            rationale: 'cross-tenant',
            sampleSize: 100,
            pValue: 0.04,
          },
          getTestClient(),
        ),
      ),
    ).rejects.toThrow(submissionRepo.VARIANT_NOT_FOUND);
  });
});
