/**
 * Forms/Intake — publishVersion integration tests.
 *
 * Exercises the publish path end-to-end: status transition, supersession
 * cascade, audit emission, domain event emission, RLS-enforced cross-
 * tenant denial.
 *
 * Spec references:
 *   - FORMS_ENGINE v5.2 §Form versioning (Pattern A: each row IS a version;
 *     one published per (tenant, program, country) family at a time).
 *   - Slice PRD v2.1 §6.2 deploy template (publish workflow).
 *   - INVARIANT I-013 (published version immutability).
 *   - INVARIANT I-016 (domain event durability — same-tx outbox).
 *   - INVARIANT I-023 / I-027 (cross-tenant denial via RLS).
 *   - tests/helpers/audit-assertions.ts (assertAuditRecordExists,
 *     assertAuditChainIntact).
 *
 * DEPENDS ON:
 *   - tests/setup.ts (savepoint wrapping; telecheck_test_app role bound
 *     so RLS applies).
 *   - migrations/006_forms_intake.sql (forms_template table + RLS policies).
 */

import { describe, expect, it } from 'vitest';

import { asTenantId } from '../../src/lib/glossary.ts';
import type { TenantContext } from '../../src/lib/tenant-context.ts';
import { ulid } from '../../src/lib/ulid.ts';
import * as templateRepo from '../../src/modules/forms-intake/internal/repositories/template-repo.ts';
import * as templateService from '../../src/modules/forms-intake/internal/services/template-service.ts';
import { assertAuditRecordExists } from '../helpers/audit-assertions.ts';
import { TENANT_GHANA, TENANT_US, withTenantContext } from '../helpers/tenant-fixtures.ts';
import { getTestClient } from '../setup.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// TenantContext literals for the service-layer calls. tenant-fixtures.ts
// exports TENANT_US/TENANT_GHANA as plain strings ('Telecheck-US' /
// 'Telecheck-Ghana'); the TenantContext interface requires the branded
// TenantId type from src/lib/glossary.ts so we round-trip through
// asTenantId() to satisfy the type system.
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

interface DraftTemplateInput {
  tenantId: 'Telecheck-US' | 'Telecheck-Ghana';
  programId: string;
  countryOfCare: 'US' | 'GH';
  templateVersion: number;
}

/**
 * Insert a draft forms_template row directly via SQL — bypasses
 * createDraftTemplate so we can seed multiple drafts in one family
 * for supersession tests without paying the audit-emission cost on the
 * setup rows. Uses the ulid() helper to mint template_ids matching the
 * canonical `frt_<ULID>` shape.
 */
async function insertDraftTemplate(input: DraftTemplateInput): Promise<string> {
  const client = getTestClient();
  const templateId = ulid();
  await withTenantContext(input.tenantId, async () => {
    await client.query(
      `INSERT INTO forms_template (
          template_id, tenant_id, program_id, country_of_care,
          template_version, status,
          presentation_content, branching_logic,
          eligibility_logic, approval_governance,
          created_at, updated_at
       ) VALUES (
          $1, $2, $3, $4,
          $5, 'draft',
          '{}'::jsonb, '{}'::jsonb,
          '{}'::jsonb, '{}'::jsonb,
          NOW(), NOW()
       )`,
      [templateId, input.tenantId, input.programId, input.countryOfCare, input.templateVersion],
    );
  });
  return templateId;
}

// ---------------------------------------------------------------------------
// Scenario 1: First-time publish — no prior published version
// ---------------------------------------------------------------------------

describe('forms-intake publishVersion — first-time publish (no prior to supersede)', () => {
  it('should flip a draft to published, set published_at, and emit governance audit + domain event', async () => {
    const programId = `prog_pub_first_${ulid().slice(0, 8)}`;
    const draftId = await insertDraftTemplate({
      tenantId: TENANT_US,
      programId,
      countryOfCare: 'US',
      templateVersion: 1,
    });

    const result = await withTenantContext(TENANT_US, () =>
      templateService.publishVersion(US_CTX, 'op_publish_test_1', draftId, {
        changeNotes: 'Initial publish',
      }),
    );

    // Service returns the now-published row.
    expect(result.template_id).toBe(draftId);
    expect(result.status).toBe('published');
    expect(result.template_version).toBe(1);

    // Storage state matches: status flipped, published_at set, no
    // superseded_at (no prior to supersede).
    const client = getTestClient();
    const row = await withTenantContext(TENANT_US, async () => {
      const r = await client.query<{
        status: string;
        published_at: Date | null;
        superseded_at: Date | null;
      }>(
        `SELECT status, published_at, superseded_at
           FROM forms_template WHERE template_id = $1`,
        [draftId],
      );
      return r.rows[0];
    });
    expect(row).toBeDefined();
    expect(row!.status).toBe('published');
    expect(row!.published_at).not.toBeNull();
    expect(row!.superseded_at).toBeNull();

    // Audit emission (Category B governance) — bare suppression forbidden
    // per I-003 + the publish action SPEC ISSUE flag in audit.ts.
    await withTenantContext(TENANT_US, async () => {
      await assertAuditRecordExists(
        TENANT_US,
        (rec) =>
          rec.action === ('forms_template_version_published' as typeof rec.action) &&
          rec.category === 'B' &&
          rec.resource_id === draftId &&
          rec.detail['status'] === 'published' &&
          rec.detail['prior_published_version_id'] === null,
      );
    });

    // Domain event emission (forms_template aggregate) — same-tx outbox
    // per I-016 ensures the audit + event + status change roll back together.
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
            AND event_type = 'forms_template.version_published'`,
        [TENANT_US, draftId],
      );
      return r.rows[0];
    });
    expect(event).toBeDefined();
    expect(event!.payload['template_id']).toBe(draftId);
    expect(event!.payload['prior_published_version_id']).toBeNull();
    expect(event!.payload['template_version']).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Scenario 2: Supersession cascade — second publish in same family
// ---------------------------------------------------------------------------

describe('forms-intake publishVersion — supersession cascade', () => {
  it('should flip prior published to superseded when a newer version publishes in the same family', async () => {
    const programId = `prog_pub_super_${ulid().slice(0, 8)}`;
    const v1Id = await insertDraftTemplate({
      tenantId: TENANT_US,
      programId,
      countryOfCare: 'US',
      templateVersion: 1,
    });
    const v2Id = await insertDraftTemplate({
      tenantId: TENANT_US,
      programId,
      countryOfCare: 'US',
      templateVersion: 2,
    });

    // Publish v1 (no prior).
    await withTenantContext(TENANT_US, () =>
      templateService.publishVersion(US_CTX, 'op_super_test', v1Id, {}),
    );

    // Publish v2 — supersession cascade should flip v1 to superseded.
    const v2Published = await withTenantContext(TENANT_US, () =>
      templateService.publishVersion(US_CTX, 'op_super_test', v2Id, {
        changeNotes: 'Promoted v2',
      }),
    );
    expect(v2Published.status).toBe('published');

    const client = getTestClient();
    const rows = await withTenantContext(TENANT_US, async () => {
      const r = await client.query<{
        template_id: string;
        status: string;
        superseded_at: Date | null;
        published_at: Date | null;
      }>(
        `SELECT template_id, status, superseded_at, published_at
           FROM forms_template
          WHERE template_id IN ($1, $2)
          ORDER BY template_version`,
        [v1Id, v2Id],
      );
      return r.rows;
    });

    expect(rows).toHaveLength(2);
    const v1Row = rows.find((r) => r.template_id === v1Id);
    const v2Row = rows.find((r) => r.template_id === v2Id);

    expect(v1Row!.status).toBe('superseded');
    expect(v1Row!.superseded_at).not.toBeNull();
    expect(v2Row!.status).toBe('published');
    expect(v2Row!.published_at).not.toBeNull();

    // Audit for v2 carries the priorPublishedVersionId pointing at v1.
    await withTenantContext(TENANT_US, async () => {
      await assertAuditRecordExists(
        TENANT_US,
        (rec) =>
          rec.action === ('forms_template_version_published' as typeof rec.action) &&
          rec.resource_id === v2Id &&
          rec.detail['prior_published_version_id'] === v1Id,
      );
    });
  });
});

// ---------------------------------------------------------------------------
// Scenario 3: I-013 immutability — second publish on the SAME row rejected
// ---------------------------------------------------------------------------

describe('forms-intake publishVersion — I-013 immutability', () => {
  it('should reject re-publishing an already-published row with PUBLISH_VERSION_NOT_DRAFT', async () => {
    const draftId = await insertDraftTemplate({
      tenantId: TENANT_US,
      programId: `prog_pub_imm_${ulid().slice(0, 8)}`,
      countryOfCare: 'US',
      templateVersion: 1,
    });

    await withTenantContext(TENANT_US, () =>
      templateService.publishVersion(US_CTX, 'op_imm_test', draftId, {}),
    );

    await expect(
      withTenantContext(TENANT_US, () =>
        templateService.publishVersion(US_CTX, 'op_imm_test', draftId, {}),
      ),
    ).rejects.toThrow(templateRepo.PUBLISH_VERSION_NOT_DRAFT);
  });
});

// ---------------------------------------------------------------------------
// Scenario 4: Cross-tenant denial — TENANT_GHANA cannot publish a TENANT_US draft
// ---------------------------------------------------------------------------

describe('forms-intake publishVersion — cross-tenant isolation (I-023)', () => {
  it('should treat a cross-tenant publish attempt as VERSION_NOT_FOUND (tenant-blind)', async () => {
    // Insert draft under TENANT_US.
    const draftId = await insertDraftTemplate({
      tenantId: TENANT_US,
      programId: `prog_pub_xten_${ulid().slice(0, 8)}`,
      countryOfCare: 'US',
      templateVersion: 1,
    });

    // Attempt publish under TENANT_GHANA context — RLS hides the row, so
    // the tenant-bound lookup returns 0 rows and we raise the
    // tenant-blind PUBLISH_VERSION_NOT_FOUND. The handler maps this
    // (and PUBLISH_VERSION_NOT_DRAFT) to the same 400 envelope per I-025.
    await expect(
      withTenantContext(TENANT_GHANA, () =>
        templateService.publishVersion(GH_CTX, 'op_xten_test', draftId, {}),
      ),
    ).rejects.toThrow(templateRepo.PUBLISH_VERSION_NOT_FOUND);

    // The TENANT_US row is unchanged — the failed cross-tenant attempt
    // didn't leak any state. Verify status is still 'draft'.
    const client = getTestClient();
    const row = await withTenantContext(TENANT_US, async () => {
      const r = await client.query<{ status: string }>(
        `SELECT status FROM forms_template WHERE template_id = $1`,
        [draftId],
      );
      return r.rows[0];
    });
    expect(row!.status).toBe('draft');
  });
});
