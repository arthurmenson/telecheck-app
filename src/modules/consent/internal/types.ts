/**
 * Consent & Delegated Access — internal type definitions.
 *
 * Mirrors the four CDM v1.2 §3.3 entities scaffolded in migrations
 * 016 + 017 (consent_versions, consent, delegations, delegation_scopes)
 * at the TypeScript layer. Module-private — only the public-interface
 * re-exports (`src/modules/consent/index.ts`) cross the module boundary.
 *
 * Spec references:
 *   - CDM v1.2 §3.3 (entities 11-14)
 *   - Consent & Delegated Access Slice PRD v1.0
 *   - migrations/016_consent.sql + 017_delegations.sql
 */

import type { TenantId } from '../../../lib/glossary.js';
import type { AccountId } from '../../identity/internal/types.js';

// ---------------------------------------------------------------------------
// Branded ID types
// ---------------------------------------------------------------------------

declare const __brand: unique symbol;
type Brand<T, B> = T & { readonly [__brand]: B };

export type ConsentId = Brand<string, 'ConsentId'>;
export type ConsentVersionId = Brand<string, 'ConsentVersionId'>;
export type DelegationId = Brand<string, 'DelegationId'>;
export type DelegationScopeId = Brand<string, 'DelegationScopeId'>;

export function asConsentId(raw: string): ConsentId {
  return raw as ConsentId;
}
export function asConsentVersionId(raw: string): ConsentVersionId {
  return raw as ConsentVersionId;
}
export function asDelegationId(raw: string): DelegationId {
  return raw as DelegationId;
}
export function asDelegationScopeId(raw: string): DelegationScopeId {
  return raw as DelegationScopeId;
}

// ---------------------------------------------------------------------------
// Consent enums (per Slice PRD v1.0 §5)
// ---------------------------------------------------------------------------

export type ConsentType =
  | 'platform'
  | 'care'
  | 'data_use'
  | 'delegation'
  | 'jurisdictional'
  | 'episode';

export type ConsentStatus = 'granted' | 'revoked';

export type ConsentRevocationReason =
  | 'patient_initiated'
  | 'account_closed'
  | 'jurisdictional_change'
  | 'admin_revoked'
  | 'expired';

// ---------------------------------------------------------------------------
// ConsentVersion entity
// ---------------------------------------------------------------------------

export interface ConsentVersion {
  consent_version_id: ConsentVersionId;
  tenant_id: TenantId;
  consent_type: ConsentType;
  version_label: string; // 'vN.N' or 'vN.N.N'
  locale: string; // BCP 47
  terms_text: string;
  regulatory_reference: string | null;
  published_at: string;
  superseded_at: string | null;
  created_at: string;
}

// ---------------------------------------------------------------------------
// Consent entity
// ---------------------------------------------------------------------------

/**
 * Evidence shape per Slice PRD v1.0 §7. The shape varies by consent_type;
 * the `timestamp` key is required across all types (the schema CHECK
 * constraint enforces this).
 */
export interface ConsentEvidence {
  timestamp: string;
  // Type-specific keys (all optional in the type; service-layer Zod
  // validates the per-type shape):
  type?: string; // 'in_app' | 'signed_form' | 'voice_recording' | ...
  device_id?: string;
  session_id?: string;
  program_id?: string;
  decisions?: Record<string, boolean>; // for data_use: per-category decisions
  delegate_id?: string;
  relationship_type?: string;
  scopes?: string[];
  jurisdiction?: string;
  regulatory_reference?: string;
  episode_id?: string;
  clinician_id?: string;
  [key: string]: unknown;
}

export interface Consent {
  consent_id: ConsentId;
  tenant_id: TenantId;
  account_id: AccountId;
  consent_type: ConsentType;
  scope_id: string | null;
  consent_version_id: ConsentVersionId;
  status: ConsentStatus;
  evidence: ConsentEvidence;
  revocation_reason: ConsentRevocationReason | null;
  expires_at: string | null;
  created_at: string;
}

// ---------------------------------------------------------------------------
// Delegation enums
// ---------------------------------------------------------------------------

export type DelegationRelationshipType =
  | 'parent_of_minor'
  | 'adult_child'
  | 'spouse_partner'
  | 'professional_caregiver'
  | 'healthcare_proxy'
  | 'other';

export type DelegationStatus = 'pending_acceptance' | 'active' | 'revoked' | 'declined';

export type DelegationRevocationReason =
  | 'patient_initiated'
  | 'delegate_initiated'
  | 'expiration'
  | 'admin_revoked'
  | 'compromise_detected';

export type DelegationScope =
  | 'view_records'
  | 'request_refills'
  | 'book_consults'
  | 'attend_consults'
  | 'receive_notifications'
  | 'make_payments'
  | 'upload_documents'
  | 'give_consent_on_behalf'
  | 'view_community';

// ---------------------------------------------------------------------------
// Delegation entity
// ---------------------------------------------------------------------------

export interface Delegation {
  delegation_id: DelegationId;
  tenant_id: TenantId;
  grantor_account_id: AccountId;
  delegate_account_id: AccountId;
  relationship_type: DelegationRelationshipType;
  status: DelegationStatus;
  legal_documentation_id: string | null;
  created_at: string;
  accepted_at: string | null;
  declined_at: string | null;
  revoked_at: string | null;
  revoked_reason: DelegationRevocationReason | null;
}

// ---------------------------------------------------------------------------
// DelegationScope entity
// ---------------------------------------------------------------------------

/**
 * Visibility restrictions for view_records scope per Slice PRD §6.4.
 * Sensitive categories (mental_health, sexual_health, reproductive_health,
 * substance_use, psychiatric_diagnoses) require EXPLICIT inclusion in
 * sensitive_categories — they are excluded by default.
 */
export interface DelegationVisibilityRestrictions {
  /** Sensitive categories the delegate is permitted to see (default-excluded). */
  sensitive_categories?: string[];
  /** Optional broader category allowlist when scope-narrowing is needed. */
  category_allowlist?: string[];
}

export interface DelegationScopeRow {
  delegation_scope_id: DelegationScopeId;
  tenant_id: TenantId;
  delegation_id: DelegationId;
  scope: DelegationScope;
  visibility_restrictions: DelegationVisibilityRestrictions | null;
  granted_at: string;
  revoked_at: string | null;
}
