/**
 * forms-intake/internal/repositories/template-repo.ts — Template + Version DB access.
 *
 * Tables (per migration 006_forms_intake.sql, authored in parallel — column
 * names assumed canonical from FORMS_ENGINE v5.2 four-layer model):
 *   - forms_templates(id, tenant_id, program_catalog_entry_id, name, current_version_id, created_at, updated_at)
 *   - forms_versions(id, template_id, tenant_id, version_number, status, layout, branching_logic, eligibility_logic, approval_governance, published_at, created_at)
 *
 * RLS posture: every PHI / tenant-scoped query MUST flow through
 * `withTransaction` (writes) or `withTenantBoundConnection` (reads). The
 * lib/db.ts helpers handle the `set_tenant_context` binding so RLS policies
 * fire at the DB layer per I-023.
 *
 * Spec references:
 *   - FORMS_ENGINE v5.2 §Form versioning (Pattern A immutable per market)
 *   - INVARIANT I-013 (published versions are immutable)
 *   - INVARIANT I-023 (three-layer tenant isolation)
 *   - Slice PRD v2.1 §5.1 (templates tenant-scoped; no cross-tenant sharing)
 *
 * SCAFFOLD STATUS: function bodies throw 'not implemented' unless the
 * canonical RLS pattern is illustrated. One example per repo shows the
 * `withTransaction` + `withTenantBoundConnection` pattern so future engineers
 * can copy-adapt.
 */

import {
  type DbClient,
  type DbTransaction,
  withTenantBoundConnection,
  withTransaction,
} from '../../../../lib/db.js';
import type { TenantId } from '../../../../lib/glossary.js';
import { ulid } from '../../../../lib/ulid.js';
import type { FormLifecycleStatus, FormTemplate, FormTemplateId, FormVersionId } from '../types.js';

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/**
 * Find a template by ID within a tenant. Returns null on miss (caller maps
 * to a tenant-blind 404 per ERROR_MODEL v5.1 + I-025 — never differentiate
 * "doesn't exist" from "exists in another tenant").
 *
 * Canonical pattern: `withTenantBoundConnection` sets the RLS session
 * binding before the SELECT runs, so the DB-layer policy independently
 * enforces tenant isolation even if the WHERE clause is wrong.
 */
export async function findTemplateById(
  tenantId: TenantId,
  templateId: FormTemplateId,
): Promise<FormTemplate | null> {
  return withTenantBoundConnection(tenantId, async (client: DbClient) => {
    // Aligned to migration 006 column set (Codex slice-scaffold-r1
    // MEDIUM finding closure 2026-05-02): singular table name
    // `forms_template`, primary key `template_id`, fields per
    // FORMS_ENGINE v5.2 four-layer architecture.
    const result = await client.query<FormTemplate>(
      `SELECT template_id, tenant_id, program_id, country_of_care,
              template_version, status,
              presentation_content, branching_logic,
              eligibility_logic, approval_governance,
              created_at, updated_at
         FROM forms_template
        WHERE template_id = $1 AND tenant_id = $2
        LIMIT 1`,
      [templateId, tenantId],
    );
    return result.rows[0] ?? null;
  });
}

export async function listTemplatesForTenant(_tenantId: TenantId): Promise<FormTemplate[]> {
  // TODO: SELECT under withTenantBoundConnection following findTemplateById pattern.
  throw new Error('not implemented');
}

export async function findVersionById(
  _tenantId: TenantId,
  _versionId: FormVersionId,
): Promise<FormTemplate | null> {
  // TODO: SELECT under withTenantBoundConnection following findTemplateById pattern.
  throw new Error('not implemented');
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/**
 * Create a draft template + version 1 atomically. Both the INSERT and any
 * downstream audit/event emission MUST run inside the same `withTransaction`
 * scope so a rollback discards both per I-003 + same-tx outbox semantics.
 *
 * The caller (template-service) is responsible for:
 *   1. Capturing the audit envelope via the audit.ts emitter, passing the
 *      same `tx` so the audit INSERT is durable in the same atomic step.
 *   2. NOT swallowing any errors — bare suppression is forbidden per I-003.
 */
/**
 * Insert a draft forms_template row + run the caller's txCallback (which
 * emits the audit envelope + domain event) inside the same transaction.
 *
 * Atomicity guarantee: if the audit emission OR domain event INSERT fails,
 * the transaction rolls back the template INSERT too — per I-003 (audit
 * durability) + I-016 (domain event durability). This is the canonical
 * write-path pattern every other forms-intake repo write should mirror.
 */
export async function createDraftTemplate(
  tenantId: TenantId,
  input: {
    programId: string;
    countryOfCare: 'US' | 'GH';
    presentationContent: unknown;
    branchingLogic: unknown;
    eligibilityLogic: unknown;
    approvalGovernance: unknown;
  },
  txCallback: (tx: DbTransaction, template: FormTemplate) => Promise<void>,
): Promise<FormTemplate> {
  return withTransaction(async (tx) => {
    // Bind tenant context inside the transaction so RLS policies on
    // forms_template (and any tables the txCallback touches) authorize
    // correctly. The binding lives for the transaction lifetime + 5min TTL
    // per migration 003.
    await tx.query('SELECT set_tenant_context($1)', [tenantId]);

    // template_version starts at 1; subsequent versions for the same
    // (tenant, program, country_of_care) trio increment per Pattern A.
    // Real implementation looks up MAX(template_version) + 1 under a row
    // lock to handle concurrent draft creation; v0 uses 1 unconditionally
    // (suitable for the first-template-per-program demonstration).
    const templateId = ulid();
    const templateVersion = 1;

    const result = await tx.query<FormTemplate>(
      `INSERT INTO forms_template (
          template_id, tenant_id, program_id, country_of_care,
          template_version, status,
          presentation_content, branching_logic,
          eligibility_logic, approval_governance,
          created_at, updated_at
       ) VALUES (
          $1, $2, $3, $4,
          $5, 'draft',
          $6::jsonb, $7::jsonb,
          $8::jsonb, $9::jsonb,
          NOW(), NOW()
       )
       RETURNING template_id, tenant_id, program_id, country_of_care,
                 template_version, status,
                 presentation_content, branching_logic,
                 eligibility_logic, approval_governance,
                 created_at, updated_at`,
      [
        templateId,
        tenantId,
        input.programId,
        input.countryOfCare,
        templateVersion,
        JSON.stringify(input.presentationContent ?? {}),
        JSON.stringify(input.branchingLogic ?? {}),
        JSON.stringify(input.eligibilityLogic ?? {}),
        JSON.stringify(input.approvalGovernance ?? {}),
      ],
    );

    if (result.rows.length === 0) {
      throw new Error(
        `forms-intake template-repo.createDraftTemplate: INSERT returned no row ` +
          `for tenant=${tenantId}, program=${input.programId}. The RLS WITH CHECK ` +
          `predicate may have rejected the row (tenant context mismatch).`,
      );
    }

    const template = result.rows[0]!;

    // Run the caller's txCallback under the same transaction. The service
    // typically emits audit + domain event here; failure propagates through
    // the transaction and rolls back the template INSERT above.
    await txCallback(tx, template);

    return template;
  });
}

/**
 * Publish a draft version. Per FORMS_ENGINE v5.2 + I-013, the version
 * becomes immutable once status flips to `published`. The supersession
 * cascade (mark prior published versions `superseded`) happens in the
 * same transaction.
 */
export async function publishVersion(
  _tenantId: TenantId,
  _versionId: FormVersionId,
  _txCallback: (tx: DbTransaction) => Promise<void>,
): Promise<FormTemplate> {
  // Canonical write-path skeleton:
  //
  //   return withTransaction(async (tx) => {
  //     await tx.query('SELECT set_tenant_context($1)', [tenantId]);
  //     // 1. Cascade prior published version → superseded.
  //     // 2. Flip target version → published.
  //     // 3. Service callback runs the L4 governance check (research consent
  //     //    block render gate + molecule-level marketing copy resolution per
  //     //    Slice PRD §25.1 / §25.3) and emits audit + domain event.
  //     await txCallback(tx);
  //   });
  void withTransaction; // referenced so the import is not pruned at lint time.
  throw new Error('not implemented');
}

/**
 * Update lifecycle status (e.g., archive a superseded version). Caller's
 * `_txCallback` runs the corresponding audit emission inside the same
 * transaction.
 */
export async function updateVersionStatus(
  _tenantId: TenantId,
  _versionId: FormVersionId,
  _newStatus: FormLifecycleStatus,
  _txCallback: (tx: DbTransaction) => Promise<void>,
): Promise<FormTemplate> {
  throw new Error('not implemented');
}
