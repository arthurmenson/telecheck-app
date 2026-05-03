/**
 * forms-intake/internal/services/template-service.ts — template + version business logic.
 *
 * Owns:
 *   - Authoring lifecycle (draft → published → superseded → archived) per
 *     FORMS_ENGINE v5.2 §Form versioning + Pattern A immutability.
 *   - Layer-3 (eligibility) clinical-safety dual control per I-015.
 *   - Layer-4 publish-time governance checks per Slice PRD §25.1
 *     (molecule-level marketing copy resolution to approved `MarketingCopy`)
 *     and §25.3 (six-category I-030 static analysis on
 *     `research_data_use_consent_block`).
 *
 * Spec references:
 *   - FORMS_ENGINE v5.2 §Four-layer architecture
 *   - FORMS_ENGINE v5.2 §Research consent integration (I-030 enforcement)
 *   - Slice PRD v2.1 §6 (visual builder)
 *   - Slice PRD v2.1 §25.1 / §25.3 / §25.4 (v1.10 cycle additions)
 *   - INVARIANT I-013 published-version immutability
 *   - INVARIANT I-015 dual-control on Layer 3
 *   - INVARIANT I-030 (no care-touching dependency on `research_consent_status`)
 */

import type { TenantContext } from '../../../../lib/tenant-context.js';

import type { CreateTemplateRequest, PublishVersionRequest } from '../../schemas.js';
import type { FormTemplate, FormTemplateId } from '../types.js';

/**
 * Create a draft template under the active tenant context. Returns the
 * template + the v1 draft version. Audit emission (`forms_*_edited` per
 * AUDIT_EVENTS v5.2) happens inside the transaction the repository opens.
 */
export async function createDraftTemplate(
  _ctx: TenantContext,
  _actorId: string,
  _input: CreateTemplateRequest,
): Promise<FormTemplate> {
  // TODO: validate program_catalog_entry_id resolves to an active
  // ProgramCatalogEntry (per Master PRD v1.10 §10.5 Layer 1) before insert;
  // delegate write to template-repo.createDraftTemplate, threading audit
  // emission inside the same transaction.
  throw new Error('not implemented');
}

/**
 * Publish a draft version. Pre-publish gates:
 *
 *   1. Tenant Clinical Lead approval recorded for any L3 (eligibility) edits
 *      per I-015 dual-control.
 *   2. Six-category I-030 static analysis against `research_data_use_consent_block`
 *      elements per FORMS_ENGINE v5.2 + Slice PRD §25.3 — reject publish
 *      if ANY of: branching, visibility, validation, eligibility/triage,
 *      pricing/commerce, outcome messaging depends on `research_consent_status`.
 *   3. L4 governance verification that any molecule-level L1 element resolves
 *      to a `MarketingCopy` entity in `approved` status per Slice PRD §25.1.
 *   4. Mode 2 input contract conformance per Slice PRD §10.
 *
 * On success: cascades prior published version → superseded; flips target
 * version → published; emits the corresponding governance audit + domain
 * event inside the same transaction.
 */
export async function publishVersion(
  _ctx: TenantContext,
  _actorId: string,
  _templateId: FormTemplateId,
  _input: PublishVersionRequest,
): Promise<FormTemplate> {
  // TODO: run static-analysis evaluator (six-category I-030 enforcement),
  // marketing-copy resolver, Mode 2 contract validator; on success
  // delegate to template-repo.publishVersion threading audit emission.
  throw new Error('not implemented');
}

/**
 * Resolve a template by ID. Returns null when not found OR when found in
 * a different tenant (tenant-blind 404 per I-025; the repository's RLS
 * binding plus the WHERE clause both enforce isolation).
 */
export async function getTemplate(
  _ctx: TenantContext,
  _templateId: FormTemplateId,
): Promise<FormTemplate | null> {
  throw new Error('not implemented');
}

/**
 * List all templates for the active tenant. Pagination is not implemented
 * at the scaffold layer — service signature reserves room for it.
 */
export async function listTemplates(_ctx: TenantContext): Promise<FormTemplate[]> {
  throw new Error('not implemented');
}
