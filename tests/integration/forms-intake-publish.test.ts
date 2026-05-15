/**
 * Forms/Intake — publishVersion integration tests.
 *
 * Exercises the publish path end-to-end: status transition, supersession
 * cascade, audit emission, domain event emission with audit_id correlation,
 * RLS-enforced cross-tenant denial, fail-closed governance gate.
 *
 * Spec references:
 *   - FORMS_ENGINE v5.2 §Form versioning (Pattern A: each row IS a version;
 *     one published per (tenant, program, country) family at a time).
 *   - Slice PRD v2.1 §6.2 deploy template (publish workflow).
 *   - INVARIANT I-013 (published version immutability).
 *   - INVARIANT I-016 (domain event durability — same-tx outbox).
 *   - INVARIANT I-023 / I-027 (cross-tenant denial via RLS).
 *
 * Test architecture (Codex publishVersion-r1 MEDIUM closure 2026-05-03):
 *
 * The service-level functions accept an optional `externalTx` parameter
 * (mirror of `lib/audit.ts emitAudit(input, tx?)`'s pattern). When tests
 * pass `getTestClient()` as externalTx, the service's transactional
 * work shares the test's outer transaction and rolls back at savepoint
 * end with everything else — no pool-side commits, no cleanup needed.
 *
 * Production handlers omit externalTx so the BEGIN/COMMIT pool path
 * provides durability. `git grep 'externalTx'` is the review surface
 * for ensuring this stays test-only.
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
// TenantContext fixtures
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

interface DraftTemplateInput {
  ctx: TenantContext;
  programId: string;
  templateVersion: number;
}

/**
 * Insert a draft template row directly via SQL on the test client.
 * Mirrors the service's createDraftTemplate INSERT but skips the audit
 * + event emission (we want a clean draft for the publish path to
 * exercise; the publish action itself emits the governance audit).
 *
 * Includes the `name` (TEXT NOT NULL) and `created_by` (VARCHAR(26)
 * NOT NULL) columns from migration 006 — both fields the prior bare
 * INSERT helper omitted.
 */
async function insertDraftTemplate(input: DraftTemplateInput): Promise<string> {
  const client = getTestClient();
  const templateId = ulid();
  const name = `test-publish-${templateId.slice(0, 8)}`;
  const createdBy = ulid();
  await withTenantContext(input.ctx.tenantId, async () => {
    await client.query(
      `INSERT INTO forms_template (
          template_id, tenant_id, program_id, country_of_care,
          template_version, status, name, created_by,
          presentation_content, branching_logic,
          eligibility_logic, approval_governance,
          created_at, updated_at
       ) VALUES (
          $1, $2, $3, $4,
          $5, 'draft', $6, $7,
          '{}'::jsonb, '{}'::jsonb,
          '{}'::jsonb, '{}'::jsonb,
          NOW(), NOW()
       )`,
      [
        templateId,
        input.ctx.tenantId,
        input.programId,
        input.ctx.countryOfCare,
        input.templateVersion,
        name,
        createdBy,
      ],
    );
  });
  return templateId;
}

/**
 * Run a publishVersion service call with the FORMS_PUBLISH_GATES_BYPASS
 * sentinel set. The bypass MUST be hostile-named so production
 * deployments can't open the gate via routine env config; we set + unset
 * it around each test invocation.
 */
async function publishWithGatesBypassed(
  ctx: TenantContext,
  actorId: string,
  versionId: string,
  changeNotes: string | undefined,
) {
  const prior = process.env['FORMS_PUBLISH_GATES_BYPASS'];
  process.env['FORMS_PUBLISH_GATES_BYPASS'] = 'unsafe-test-only';
  try {
    // F-4: tests are in-tenant operations (no platform_admin cross-
    // tenant scenarios here), so actorTenantId === ctx.tenantId.
    return await templateService.publishVersion(
      ctx,
      { actorId, actorTenantId: ctx.tenantId },
      versionId,
      { changeNotes },
      // externalTx: pass the test client so the service's transactional
      // writes share the savepoint-isolated outer transaction. Without
      // this, withTransaction would acquire a pool connection that can't
      // see test-client uncommitted rows (PG transaction isolation).
      getTestClient(),
    );
  } finally {
    if (prior === undefined) {
      delete process.env['FORMS_PUBLISH_GATES_BYPASS'];
    } else {
      process.env['FORMS_PUBLISH_GATES_BYPASS'] = prior;
    }
  }
}

// ---------------------------------------------------------------------------
// Scenario 1: First-time publish — no prior published version
// ---------------------------------------------------------------------------

describe('forms-intake publishVersion — first-time publish (no prior to supersede)', () => {
  it('should flip a draft to published, set published_at, and emit governance audit + domain event with correlated audit_id', async () => {
    const programId = `prog_pub_first_${ulid().slice(0, 8)}`;
    const draftId = await insertDraftTemplate({
      ctx: US_CTX,
      programId,
      templateVersion: 1,
    });

    const result = await withTenantContext(TENANT_US, () =>
      publishWithGatesBypassed(US_CTX, 'op_publish_test_1', draftId, 'Initial publish'),
    );

    expect(result.template_id).toBe(draftId);
    expect(result.status).toBe('published');
    expect(result.template_version).toBe(1);

    // Storage state matches the returned envelope.
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

    // Audit (Category B governance) — bare suppression forbidden per I-003.
    const auditRecord = await withTenantContext(TENANT_US, () =>
      assertAuditRecordExists(
        TENANT_US,
        (rec) =>
          rec.action === ('forms_template_version_published' as typeof rec.action) &&
          rec.category === 'B' &&
          rec.resource_id === draftId &&
          rec.detail['status'] === 'published' &&
          rec.detail['prior_published_version_id'] === null,
      ),
    );

    // Domain event correlated to the audit by audit_id (Codex
    // publishVersion-r1 HIGH closure). The same-tx outbox per I-016
    // ensures the event commits with the audit + status flip atomically.
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
    expect(event!.payload['audit_id']).toBe(auditRecord.audit_id);
  });
});

// ---------------------------------------------------------------------------
// Scenario 2: Supersession cascade — second publish in same family
// ---------------------------------------------------------------------------

describe('forms-intake publishVersion — supersession cascade', () => {
  it('should flip prior published to superseded when a newer version publishes in the same family', async () => {
    const programId = `prog_pub_super_${ulid().slice(0, 8)}`;
    const v1Id = await insertDraftTemplate({ ctx: US_CTX, programId, templateVersion: 1 });
    const v2Id = await insertDraftTemplate({ ctx: US_CTX, programId, templateVersion: 2 });

    // Publish v1 (no prior).
    await withTenantContext(TENANT_US, () =>
      publishWithGatesBypassed(US_CTX, 'op_super_test', v1Id, undefined),
    );

    // Publish v2 — supersession cascade should flip v1 to superseded.
    const v2Published = await withTenantContext(TENANT_US, () =>
      publishWithGatesBypassed(US_CTX, 'op_super_test', v2Id, 'Promoted v2'),
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

    // v2's audit carries the priorPublishedVersionId pointing at v1.
    await withTenantContext(TENANT_US, () =>
      assertAuditRecordExists(
        TENANT_US,
        (rec) =>
          rec.action === ('forms_template_version_published' as typeof rec.action) &&
          rec.resource_id === v2Id &&
          rec.detail['prior_published_version_id'] === v1Id,
      ),
    );
  });
});

// ---------------------------------------------------------------------------
// Scenario 3: I-013 immutability — second publish on the SAME row rejected
// ---------------------------------------------------------------------------

describe('forms-intake publishVersion — I-013 immutability', () => {
  it('should reject re-publishing an already-published row with PUBLISH_VERSION_NOT_DRAFT', async () => {
    const draftId = await insertDraftTemplate({
      ctx: US_CTX,
      programId: `prog_pub_imm_${ulid().slice(0, 8)}`,
      templateVersion: 1,
    });

    await withTenantContext(TENANT_US, () =>
      publishWithGatesBypassed(US_CTX, 'op_imm_test', draftId, undefined),
    );

    await expect(
      withTenantContext(TENANT_US, () =>
        publishWithGatesBypassed(US_CTX, 'op_imm_test', draftId, undefined),
      ),
    ).rejects.toThrow(templateRepo.PUBLISH_VERSION_NOT_DRAFT);
  });
});

// ---------------------------------------------------------------------------
// Scenario 4: Cross-tenant denial — TENANT_GHANA cannot publish a TENANT_US draft
// ---------------------------------------------------------------------------

describe('forms-intake publishVersion — cross-tenant isolation (I-023)', () => {
  it('should treat a cross-tenant publish attempt as VERSION_NOT_FOUND (tenant-blind)', async () => {
    const draftId = await insertDraftTemplate({
      ctx: US_CTX,
      programId: `prog_pub_xten_${ulid().slice(0, 8)}`,
      templateVersion: 1,
    });

    await expect(
      withTenantContext(TENANT_GHANA, () =>
        publishWithGatesBypassed(GH_CTX, 'op_xten_test', draftId, undefined),
      ),
    ).rejects.toThrow(templateRepo.PUBLISH_VERSION_NOT_FOUND);

    // The TENANT_US row is unchanged after the failed cross-tenant attempt.
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

// ---------------------------------------------------------------------------
// Scenario 5: Fail-closed gate — publish refused without explicit env bypass
// ---------------------------------------------------------------------------

describe('forms-intake publishVersion — fail-closed governance gate', () => {
  it('should refuse to publish when FORMS_PUBLISH_GATES_BYPASS is absent', async () => {
    const draftId = await insertDraftTemplate({
      ctx: US_CTX,
      programId: `prog_pub_gate_${ulid().slice(0, 8)}`,
      templateVersion: 1,
    });

    const prior = process.env['FORMS_PUBLISH_GATES_BYPASS'];
    delete process.env['FORMS_PUBLISH_GATES_BYPASS'];
    try {
      await expect(
        withTenantContext(TENANT_US, () =>
          templateService.publishVersion(
            US_CTX,
            { actorId: 'op_gate_test', actorTenantId: TENANT_US },
            draftId,
            { changeNotes: undefined },
            getTestClient(),
          ),
        ),
      ).rejects.toThrow(templateService.PUBLISH_GATES_NOT_IMPLEMENTED);
    } finally {
      if (prior !== undefined) {
        process.env['FORMS_PUBLISH_GATES_BYPASS'] = prior;
      }
    }

    // Row remains in draft — no state change before the gate check.
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

  it('should refuse to publish when FORMS_PUBLISH_GATES_BYPASS is set to a non-sentinel value', async () => {
    const draftId = await insertDraftTemplate({
      ctx: US_CTX,
      programId: `prog_pub_typo_${ulid().slice(0, 8)}`,
      templateVersion: 1,
    });

    const prior = process.env['FORMS_PUBLISH_GATES_BYPASS'];
    // Common would-be-typo — must NOT open the gate.
    process.env['FORMS_PUBLISH_GATES_BYPASS'] = 'true';
    try {
      await expect(
        withTenantContext(TENANT_US, () =>
          templateService.publishVersion(
            US_CTX,
            { actorId: 'op_typo_test', actorTenantId: TENANT_US },
            draftId,
            { changeNotes: undefined },
            getTestClient(),
          ),
        ),
      ).rejects.toThrow(templateService.PUBLISH_GATES_NOT_IMPLEMENTED);
    } finally {
      if (prior === undefined) {
        delete process.env['FORMS_PUBLISH_GATES_BYPASS'];
      } else {
        process.env['FORMS_PUBLISH_GATES_BYPASS'] = prior;
      }
    }
  });
});
