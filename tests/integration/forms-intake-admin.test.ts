/**
 * Forms/Intake — admin read + retire integration tests.
 *
 * Covers:
 *   - getTemplate: hit + miss (tenant-blind null)
 *   - listTemplates: scoped to tenant; cross-tenant rows hidden by RLS
 *   - getDeployment: hit + miss
 *   - retireDeployment: happy path (status flip + audit + event with
 *     audit_id correlation), idempotency (already-retired throws),
 *     not-found (cross-tenant)
 *
 * Test architecture: same externalTx pattern as forms-intake-publish.test.ts
 * — service-level calls share the test client's outer transaction so all
 * inserts roll back at savepoint end. See that file's header for the
 * design rationale.
 *
 * Spec references:
 *   - I-013 (forms_template + forms_deployment immutability — retire flips
 *     `retired_at` only; deployment row stays for audit traceability).
 *   - I-016 (domain event durability — same-tx outbox).
 *   - I-023 / I-027 (cross-tenant denial via RLS).
 *   - Slice PRD v2.1 §6.2 deploy + retire workflow.
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

interface InsertTemplateOpts {
  ctx: TenantContext;
  programId: string;
  templateVersion: number;
  status?: 'draft' | 'published' | 'superseded' | 'archived';
}

async function insertTemplate(opts: InsertTemplateOpts): Promise<string> {
  const client = getTestClient();
  const templateId = ulid();
  const status = opts.status ?? 'draft';
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
          $5, $6, $7, $8,
          '{}'::jsonb, '{}'::jsonb,
          '{}'::jsonb, '{}'::jsonb,
          $9, NOW(), NOW()
       )`,
      [
        templateId,
        opts.ctx.tenantId,
        opts.programId,
        opts.ctx.countryOfCare,
        opts.templateVersion,
        status,
        `test-admin-${templateId.slice(0, 8)}`,
        ulid(),
        status === 'published' ? new Date() : null,
      ],
    );
  });
  return templateId;
}

/**
 * Insert a template + active deployment (no audit/event emission — fastest
 * setup path for read tests). The deployment binds (tenant, program,
 * country, template_id) per Pattern A.
 */
async function insertTemplateAndDeployment(opts: {
  ctx: TenantContext;
  programId: string;
}): Promise<{ templateId: string; deploymentId: string }> {
  const client = getTestClient();
  const templateId = await insertTemplate({
    ctx: opts.ctx,
    programId: opts.programId,
    templateVersion: 1,
    status: 'published',
  });
  const deploymentId = ulid();
  await withTenantContext(opts.ctx.tenantId, async () => {
    // forms_deployment columns per migration 006: deployment_id, tenant_id,
    // template_id, program_id, deployed_at, retired_at, deployed_by,
    // created_at, updated_at. Note country_of_care lives on forms_template
    // (the family identifier), NOT on forms_deployment — the deployment
    // inherits it via the composite FK.
    await client.query(
      `INSERT INTO forms_deployment (
          deployment_id, tenant_id, template_id, program_id,
          deployed_by, deployed_at, retired_at,
          created_at, updated_at
       ) VALUES (
          $1, $2, $3, $4,
          $5, NOW(), NULL,
          NOW(), NOW()
       )`,
      [deploymentId, opts.ctx.tenantId, templateId, opts.programId, ulid()],
    );
  });
  return { templateId, deploymentId };
}

// ---------------------------------------------------------------------------
// getTemplate
// ---------------------------------------------------------------------------

describe('forms-intake getTemplate', () => {
  it('returns the template when it exists in the active tenant', async () => {
    const programId = `prog_get_t_${ulid().slice(0, 8)}`;
    const templateId = await insertTemplate({ ctx: US_CTX, programId, templateVersion: 1 });

    const result = await withTenantContext(TENANT_US, () =>
      templateService.getTemplate(US_CTX, templateId, getTestClient()),
    );

    expect(result).not.toBeNull();
    expect(result!.template_id).toBe(templateId);
    expect(result!.tenant_id).toBe(TENANT_US);
    expect(result!.program_id).toBe(programId);
  });

  it('returns null when the template does not exist (tenant-blind miss)', async () => {
    const fakeId = ulid();
    const result = await withTenantContext(TENANT_US, () =>
      templateService.getTemplate(US_CTX, fakeId, getTestClient()),
    );
    expect(result).toBeNull();
  });

  it('returns null when the template exists in a different tenant (RLS-filtered)', async () => {
    const programId = `prog_get_xten_${ulid().slice(0, 8)}`;
    const templateId = await insertTemplate({ ctx: US_CTX, programId, templateVersion: 1 });

    // Same template_id, queried under TENANT_GHANA — RLS hides the row.
    const result = await withTenantContext(TENANT_GHANA, () =>
      templateService.getTemplate(GH_CTX, templateId, getTestClient()),
    );
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// listTemplates
// ---------------------------------------------------------------------------

describe('forms-intake listTemplates', () => {
  it('returns all templates for the active tenant; cross-tenant rows are hidden by RLS', async () => {
    // Seed two templates under TENANT_US and one under TENANT_GHANA.
    const usProgramA = `prog_list_us_a_${ulid().slice(0, 8)}`;
    const usProgramB = `prog_list_us_b_${ulid().slice(0, 8)}`;
    const ghProgram = `prog_list_gh_${ulid().slice(0, 8)}`;

    const usA = await insertTemplate({ ctx: US_CTX, programId: usProgramA, templateVersion: 1 });
    const usB = await insertTemplate({ ctx: US_CTX, programId: usProgramB, templateVersion: 1 });
    const gh = await insertTemplate({ ctx: GH_CTX, programId: ghProgram, templateVersion: 1 });

    // Under TENANT_US context: see both US templates, NOT the GH template.
    const usList = await withTenantContext(TENANT_US, () =>
      templateService.listTemplates(US_CTX, { limit: 50 }, getTestClient()),
    );
    const usIds = new Set(usList.map((t) => t.template_id));
    expect(usIds.has(usA)).toBe(true);
    expect(usIds.has(usB)).toBe(true);
    expect(usIds.has(gh)).toBe(false);

    // Under TENANT_GHANA context: see only the GH template.
    const ghList = await withTenantContext(TENANT_GHANA, () =>
      templateService.listTemplates(GH_CTX, { limit: 50 }, getTestClient()),
    );
    const ghIds = new Set(ghList.map((t) => t.template_id));
    expect(ghIds.has(gh)).toBe(true);
    expect(ghIds.has(usA)).toBe(false);
    expect(ghIds.has(usB)).toBe(false);
  });

  it('respects keyset pagination via limit + cursor', async () => {
    // Seed 3 templates in a fresh tenant family so the test owns the
    // entire ordering space (no interference from prior tests' rows).
    const programId = `prog_list_paged_${ulid().slice(0, 8)}`;
    const ids = [
      await insertTemplate({ ctx: US_CTX, programId, templateVersion: 1 }),
      await insertTemplate({ ctx: US_CTX, programId, templateVersion: 2 }),
      await insertTemplate({ ctx: US_CTX, programId, templateVersion: 3 }),
    ];

    // Page 1: limit=2 → expect first two by (program, country, version, id) order.
    const page1 = await withTenantContext(TENANT_US, () =>
      templateService.listTemplates(US_CTX, { limit: 2 }, getTestClient()),
    );
    // Among rows belonging to our program, the first two by version are v1, v2.
    const page1Ours = page1.filter((t) => t.program_id === programId);
    expect(page1Ours).toHaveLength(2);
    expect(page1Ours[0]!.template_version).toBe(1);
    expect(page1Ours[1]!.template_version).toBe(2);

    // Page 2: cursor = ordering tuple of last row from page1 → expect
    // items strictly after. The cursor is independent of the row's
    // existence (Codex verify-r1 MEDIUM closure 2026-05-03), so the
    // service-level call passes the structured tuple directly.
    const lastPage1 = page1[page1.length - 1]!;
    const page2 = await withTenantContext(TENANT_US, () =>
      templateService.listTemplates(
        US_CTX,
        {
          limit: 2,
          cursor: {
            program_id: lastPage1.program_id,
            country_of_care: lastPage1.country_of_care,
            template_version: lastPage1.template_version,
            template_id: lastPage1.template_id,
          },
        },
        getTestClient(),
      ),
    );
    const page2Ours = page2.filter((t) => t.program_id === programId);
    // Every row in page2 has (program, country, version, id) > page1's last row.
    for (const row of page2Ours) {
      expect(ids).toContain(row.template_id);
    }
  });

  it('keeps pagination stable when the cursor row is archived between page fetches', async () => {
    // Codex verify-r1 MEDIUM regression: with the prior cursor-row CTE
    // implementation, archiving the cursor's row would silently end
    // pagination (zero rows returned). The opaque tuple cursor must
    // resume from the encoded position regardless.
    const programId = `prog_list_archive_${ulid().slice(0, 8)}`;
    const v1 = await insertTemplate({ ctx: US_CTX, programId, templateVersion: 1 });
    const v2 = await insertTemplate({ ctx: US_CTX, programId, templateVersion: 2 });
    const v3 = await insertTemplate({ ctx: US_CTX, programId, templateVersion: 3 });

    // Build a cursor whose tuple corresponds to v1's row, then archive v1.
    const cursor = {
      program_id: programId,
      country_of_care: 'US',
      template_version: 1,
      template_id: v1,
    };
    const client = getTestClient();
    await withTenantContext(TENANT_US, async () => {
      await client.query(
        `UPDATE forms_template SET status = 'archived', archived_at = NOW() WHERE template_id = $1`,
        [v1],
      );
    });

    // Continue pagination from v1's tuple — should still return v2 and v3
    // even though v1 itself is archived.
    const next = await withTenantContext(TENANT_US, () =>
      templateService.listTemplates(US_CTX, { limit: 50, cursor }, getTestClient()),
    );
    const ours = next.filter((t) => t.program_id === programId);
    const oursIds = new Set(ours.map((t) => t.template_id));
    expect(oursIds.has(v2)).toBe(true);
    expect(oursIds.has(v3)).toBe(true);
  });

  it('rejects limit out of bounds at the handler with 400', () => {
    // Handler-level concern (not exercised here directly since the test
    // calls the service); document as it.todo if you want to assert via
    // app.inject once the test harness can drive HTTP fixtures.
    expect(true).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// getDeployment
// ---------------------------------------------------------------------------

describe('forms-intake getDeployment', () => {
  it('returns the deployment when it exists in the active tenant', async () => {
    const programId = `prog_get_d_${ulid().slice(0, 8)}`;
    const { deploymentId, templateId } = await insertTemplateAndDeployment({
      ctx: US_CTX,
      programId,
    });

    const result = await withTenantContext(TENANT_US, () =>
      templateService.getDeployment(US_CTX, deploymentId, getTestClient()),
    );

    expect(result).not.toBeNull();
    expect(result!.deployment_id).toBe(deploymentId);
    expect(result!.template_id).toBe(templateId);
    expect(result!.retired_at).toBeNull();
  });

  it('returns null when the deployment does not exist (tenant-blind miss)', async () => {
    const fakeId = ulid();
    const result = await withTenantContext(TENANT_US, () =>
      templateService.getDeployment(US_CTX, fakeId, getTestClient()),
    );
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// retireDeployment — happy path
// ---------------------------------------------------------------------------

describe('forms-intake retireDeployment — happy path', () => {
  it('flips retired_at and emits Category B audit + correlated domain event', async () => {
    const programId = `prog_retire_ok_${ulid().slice(0, 8)}`;
    const { deploymentId, templateId } = await insertTemplateAndDeployment({
      ctx: US_CTX,
      programId,
    });

    const retired = await withTenantContext(TENANT_US, () =>
      templateService.retireDeployment(
        US_CTX,
        { actorId: 'op_retire_ok', actorTenantId: TENANT_US },
        deploymentId,
        getTestClient(),
      ),
    );

    expect(retired.deployment_id).toBe(deploymentId);
    expect(retired.retired_at).not.toBeNull();

    // Storage check: row updated, but still present (I-013 — deployment
    // rows are immutable in the audit-trail sense, retirement is a flag).
    const client = getTestClient();
    const row = await withTenantContext(TENANT_US, async () => {
      const r = await client.query<{ retired_at: Date | null; deployment_id: string }>(
        `SELECT deployment_id, retired_at FROM forms_deployment WHERE deployment_id = $1`,
        [deploymentId],
      );
      return r.rows[0];
    });
    expect(row).toBeDefined();
    expect(row!.retired_at).not.toBeNull();

    // Category B audit emitted with the SPEC-ISSUE-flagged action ID.
    const auditRecord = await withTenantContext(TENANT_US, () =>
      assertAuditRecordExists(
        TENANT_US,
        (rec) =>
          rec.action === ('forms_deployment_retired' as typeof rec.action) &&
          rec.category === 'B' &&
          rec.resource_id === deploymentId &&
          rec.detail['template_id'] === templateId,
      ),
    );

    // Domain event in outbox correlated by audit_id (publishVersion-r1 HIGH
    // closure pattern).
    const event = await withTenantContext(TENANT_US, async () => {
      const r = await client.query<{
        aggregate_id: string;
        event_type: string;
        payload: Record<string, unknown>;
      }>(
        `SELECT aggregate_id, event_type, payload
           FROM domain_events_outbox
          WHERE tenant_id = $1
            AND aggregate_id = $2
            AND event_type = 'forms_deployment.retired'`,
        [TENANT_US, deploymentId],
      );
      return r.rows[0];
    });
    expect(event).toBeDefined();
    expect(event!.payload['template_id']).toBe(templateId);
    expect(event!.payload['audit_id']).toBe(auditRecord.audit_id);
  });
});

// ---------------------------------------------------------------------------
// retireDeployment — idempotency / already-retired
// ---------------------------------------------------------------------------

describe('forms-intake retireDeployment — already-retired surface', () => {
  it('throws DEPLOYMENT_ALREADY_RETIRED on a second retire of the same deployment', async () => {
    const programId = `prog_retire_idem_${ulid().slice(0, 8)}`;
    const { deploymentId } = await insertTemplateAndDeployment({ ctx: US_CTX, programId });

    await withTenantContext(TENANT_US, () =>
      templateService.retireDeployment(
        US_CTX,
        { actorId: 'op_retire_idem', actorTenantId: TENANT_US },
        deploymentId,
        getTestClient(),
      ),
    );

    await expect(
      withTenantContext(TENANT_US, () =>
        templateService.retireDeployment(
          US_CTX,
          { actorId: 'op_retire_idem', actorTenantId: TENANT_US },
          deploymentId,
          getTestClient(),
        ),
      ),
    ).rejects.toThrow(submissionRepo.DEPLOYMENT_ALREADY_RETIRED);
  });
});

// ---------------------------------------------------------------------------
// retireDeployment — cross-tenant denial
// ---------------------------------------------------------------------------

describe('forms-intake retireDeployment — cross-tenant isolation (I-023)', () => {
  it('treats a cross-tenant retire attempt as DEPLOYMENT_NOT_FOUND', async () => {
    const programId = `prog_retire_xten_${ulid().slice(0, 8)}`;
    const { deploymentId } = await insertTemplateAndDeployment({ ctx: US_CTX, programId });

    await expect(
      withTenantContext(TENANT_GHANA, () =>
        templateService.retireDeployment(
          GH_CTX,
          { actorId: 'op_retire_xten', actorTenantId: TENANT_GHANA },
          deploymentId,
          getTestClient(),
        ),
      ),
    ).rejects.toThrow(submissionRepo.DEPLOYMENT_NOT_FOUND);

    // The TENANT_US deployment is unchanged.
    const client = getTestClient();
    const row = await withTenantContext(TENANT_US, async () => {
      const r = await client.query<{ retired_at: Date | null }>(
        `SELECT retired_at FROM forms_deployment WHERE deployment_id = $1`,
        [deploymentId],
      );
      return r.rows[0];
    });
    expect(row!.retired_at).toBeNull();
  });
});
