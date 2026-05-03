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
  externalTx?: DbClient,
): Promise<FormTemplate | null> {
  return withTenantBoundConnection(
    tenantId,
    async (client: DbClient) => {
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
    },
    externalTx,
  );
}

/**
 * List all templates for a tenant ordered by program then version (ascending),
 * latest version last per family. RLS handles tenant isolation; the explicit
 * `tenant_id = $1` filter is belt + suspenders so a missing/expired
 * `set_tenant_context` binding can't accidentally widen the result set.
 *
 * Pagination is not implemented at the scaffold layer — the FormTemplate
 * row count per tenant is bounded by the program × version × country grid
 * and is well under any pagination horizon for v1.0. When the visual
 * builder slice ships and templates accumulate per-tenant, add LIMIT +
 * OFFSET (or keyset cursor) here and update the service signature.
 */
export async function listTemplatesForTenant(
  tenantId: TenantId,
  externalTx?: DbClient,
): Promise<FormTemplate[]> {
  return withTenantBoundConnection(
    tenantId,
    async (client: DbClient) => {
      const result = await client.query<FormTemplate>(
        `SELECT template_id, tenant_id, program_id, country_of_care,
                template_version, status,
                presentation_content, branching_logic,
                eligibility_logic, approval_governance,
                created_at, updated_at
           FROM forms_template
          WHERE tenant_id = $1
          ORDER BY program_id ASC, country_of_care ASC, template_version ASC`,
        [tenantId],
      );
      return result.rows;
    },
    externalTx,
  );
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
    /** Human-readable label per migration 006 (NOT NULL). */
    name: string;
    /** Authoring tenant_user_id (ULID) per migration 006 (NOT NULL). */
    createdBy: string;
    presentationContent: unknown;
    branchingLogic: unknown;
    eligibilityLogic: unknown;
    approvalGovernance: unknown;
  },
  txCallback: (tx: DbTransaction, template: FormTemplate) => Promise<void>,
  /**
   * Test-only: when supplied, the function runs on the caller's
   * transaction handle instead of acquiring a fresh pool connection.
   * Mirrors `lib/db.ts withTransaction`'s externalTx parameter.
   * Production callers must NOT supply this.
   */
  externalTx?: DbTransaction,
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

    // Migration 006 declares `name` (TEXT NOT NULL) and `created_by`
    // (VARCHAR(26) NOT NULL — tenant_user_id ULID); the prior INSERT
    // omitted both, which would fail in any environment with the
    // migration applied. Both are now propagated from the input.
    // (Patch 2026-05-03: closed in the same commit as the publishVersion
    //  test caught the latent bug; createDraftTemplate had no integration
    //  test exercising this path before today.)
    const result = await tx.query<FormTemplate>(
      `INSERT INTO forms_template (
          template_id, tenant_id, program_id, country_of_care,
          template_version, status, name, created_by,
          presentation_content, branching_logic,
          eligibility_logic, approval_governance,
          created_at, updated_at
       ) VALUES (
          $1, $2, $3, $4,
          $5, 'draft', $6, $7,
          $8::jsonb, $9::jsonb,
          $10::jsonb, $11::jsonb,
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
        input.name,
        input.createdBy,
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
  }, externalTx);
}

// ---------------------------------------------------------------------------
// Sentinel error codes for publishVersion preconditions.
//
// The service layer maps these to tenant-blind 400s (ERROR_MODEL v5.1) so the
// HTTP response shape never differentiates "version doesn't exist" vs "exists
// in another tenant" vs "exists but isn't a draft" — same I-025 discipline as
// the deployment handler (DEPLOYMENT_TEMPLATE_PRECONDITION_FAILED).
// ---------------------------------------------------------------------------

export const PUBLISH_VERSION_NOT_FOUND = 'forms.publish.version_not_found';
export const PUBLISH_VERSION_NOT_DRAFT = 'forms.publish.version_not_draft';

/**
 * Publish a draft version. Per FORMS_ENGINE v5.2 + I-013, the version
 * becomes immutable once status flips to `published`. The supersession
 * cascade (mark prior published versions `superseded`) happens in the
 * same transaction.
 *
 * **Concurrency model (publish race per FORMS_ENGINE v5.2 Pattern A):**
 *   The (tenant_id, program_id, country_of_care) family allows ONE
 *   `published` row at a time — but no DB-level uniqueness enforces that
 *   directly (migration 006 has UNIQUE on `template_version` per family,
 *   not on status='published'). Two concurrent publishes from different
 *   draft versions in the same family could both observe the prior
 *   published row, both UPDATE it to superseded, and both flip
 *   themselves to published — yielding two published rows.
 *
 *   Mitigation: `pg_advisory_xact_lock` keyed on the family identity
 *   (tenant_id + program_id + country_of_care) at the start of the
 *   transaction serializes all publishes within the same family. Lock
 *   auto-releases at txn end. Same pattern as the audit-chain
 *   per-partition serialization in migration 002 (HIGH-3 closure).
 *
 *   The advisory lock is sufficient against concurrent app callers; an
 *   adversarial DBA running ad-hoc UPDATE could still produce two
 *   published rows. A partial unique index `WHERE status = 'published'`
 *   on (tenant_id, program_id, country_of_care) would close that gap as
 *   a future hardening migration.
 *
 * **I-013 immutability:** the target row's status MUST be 'draft' at
 * UPDATE time. A 'published' / 'superseded' / 'archived' row is
 * immutable per I-013 — the predicate `WHERE template_id = $1 AND
 * status = 'draft'` enforces this at the SQL level. RETURNING zero
 * rows means the precondition was unmet (or the row doesn't exist in
 * this tenant); the function maps that to PUBLISH_VERSION_NOT_DRAFT
 * vs PUBLISH_VERSION_NOT_FOUND by re-checking the row's existence.
 */
export async function publishVersion(
  tenantId: TenantId,
  versionId: FormVersionId,
  txCallback: (
    tx: DbTransaction,
    published: FormTemplate,
    supersededVersionId: FormVersionId | null,
  ) => Promise<void>,
  /**
   * Test-only: see createDraftTemplate's externalTx param. Production
   * code must NOT supply this — durability is guaranteed by the
   * BEGIN/COMMIT pool path.
   */
  externalTx?: DbTransaction,
): Promise<FormTemplate> {
  return withTransaction(async (tx) => {
    await tx.query('SELECT set_tenant_context($1)', [tenantId]);

    // Step 1: Locate the target row to learn its (program_id,
    // country_of_care) family — needed for the advisory lock key. Tenant
    // is bound above, RLS filters cross-tenant rows automatically. Reject
    // tenant-blindly if not found.
    const targetLookup = await tx.query<{
      template_id: string;
      program_id: string;
      country_of_care: string;
      status: FormLifecycleStatus;
    }>(
      `SELECT template_id, program_id, country_of_care, status
         FROM forms_template
        WHERE template_id = $1 AND tenant_id = $2
        LIMIT 1`,
      [versionId, tenantId],
    );
    if (targetLookup.rows.length === 0) {
      throw new Error(PUBLISH_VERSION_NOT_FOUND);
    }
    const target = targetLookup.rows[0]!;

    // Step 2: Acquire the family-scoped advisory lock so concurrent
    // publishes within the same (tenant, program, country) family
    // serialize. Key derivation mirrors the audit-chain trigger's
    // tenant-prefixed partition pattern.
    const familyKey = `${tenantId}:${target.program_id}:${target.country_of_care}`;
    await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [familyKey]);

    // Step 3: Re-check status under the lock. Between the initial lookup
    // and lock acquisition, another transaction in this family could
    // have concluded — if our target was already superseded by that, we
    // need to fail closed rather than silently re-publish a stale draft.
    if (target.status !== 'draft') {
      throw new Error(PUBLISH_VERSION_NOT_DRAFT);
    }

    // Step 4: Cascade — find the current published version in this
    // family (if any) and flip it to 'superseded'. The composite
    // (tenant_id, program_id, country_of_care, status) lookup uses the
    // existing index on (tenant_id, program_id, country_of_care,
    // template_version) for selection.
    const priorCascade = await tx.query<{ template_id: string }>(
      `UPDATE forms_template
          SET status = 'superseded',
              superseded_at = NOW(),
              updated_at = NOW()
        WHERE tenant_id = $1
          AND program_id = $2
          AND country_of_care = $3
          AND status = 'published'
          AND template_id <> $4
       RETURNING template_id`,
      [tenantId, target.program_id, target.country_of_care, versionId],
    );
    const supersededVersionId: FormVersionId | null =
      priorCascade.rows.length > 0 ? priorCascade.rows[0]!.template_id : null;

    // Step 5: Flip the target draft → published. The WHERE clause
    // includes `status = 'draft'` so an interleaved status change
    // (e.g., another path archived the row) makes this UPDATE a no-op,
    // surfacing as PUBLISH_VERSION_NOT_DRAFT. The advisory lock above
    // already prevents this in single-DB-instance flows but the SQL-
    // level guard is the durable invariant.
    const result = await tx.query<FormTemplate>(
      `UPDATE forms_template
          SET status = 'published',
              published_at = NOW(),
              updated_at = NOW()
        WHERE template_id = $1
          AND tenant_id = $2
          AND status = 'draft'
       RETURNING template_id, tenant_id, program_id, country_of_care,
                 template_version, status,
                 presentation_content, branching_logic,
                 eligibility_logic, approval_governance,
                 created_at, updated_at`,
      [versionId, tenantId],
    );
    if (result.rows.length === 0) {
      // Should not happen given the lock + re-check above, but the
      // SQL-level guard insists. Translate to the same precondition
      // sentinel so the service layer's error mapping is uniform.
      throw new Error(PUBLISH_VERSION_NOT_DRAFT);
    }
    const published = result.rows[0]!;

    // Step 6: Service callback — emits audit + domain event in the same
    // transaction so a failure there rolls back the whole publish
    // (cascade + flip), preserving I-003 + I-016 atomicity.
    await txCallback(tx, published, supersededVersionId);

    return published;
  }, externalTx);
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
