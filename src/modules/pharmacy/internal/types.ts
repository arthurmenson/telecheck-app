/**
 * pharmacy/internal/types.ts — Pharmacy module internal types.
 *
 * DRAFT pre-SI-001-ratification. Row-shape interface + enums + branded
 * IDs implementing the CDM v1.2 §4.16 proposal from SI-001 DRAFT
 * (Telecheck_SI_Closure_Cycle_2026-05-11/
 * Telecheck_SI_001_MedicationRequest_Schema_DRAFT.md). Will be revised
 * if SI-001 ratification adjusts column names, types, or enum values.
 *
 * Spec references:
 *   - SI-001 DRAFT §"Proposed CDM §4.16 MedicationRequest"
 *   - migrations/025_medication_requests.sql (the schema)
 *   - State Machines v1.1 §19 DRAFT (status enum)
 *   - CDM v1.2 §3.5 (entity inventory)
 */

import type { TenantId } from '../../../lib/glossary.js';
import type { AccountId } from '../../identity/internal/types.js';

// ---------------------------------------------------------------------------
// Branded ID types (CDM §3.5 entities #18-#22)
// ---------------------------------------------------------------------------

declare const __brand: unique symbol;
type Brand<T, B> = T & { readonly [__brand]: B };

export type MedicationRequestId = Brand<string, 'MedicationRequestId'>;
export type RefillId = Brand<string, 'RefillId'>;
export type DispensingId = Brand<string, 'DispensingId'>;
export type ShipmentId = Brand<string, 'ShipmentId'>;
export type ProductCatalogId = Brand<string, 'ProductCatalogId'>;
export type InteractionOverrideId = Brand<string, 'InteractionOverrideId'>;
export type ProtocolId = Brand<string, 'ProtocolId'>;

export function asMedicationRequestId(raw: string): MedicationRequestId {
  return raw as MedicationRequestId;
}
export function asRefillId(raw: string): RefillId {
  return raw as RefillId;
}
export function asDispensingId(raw: string): DispensingId {
  return raw as DispensingId;
}
export function asShipmentId(raw: string): ShipmentId {
  return raw as ShipmentId;
}
export function asProductCatalogId(raw: string): ProductCatalogId {
  return raw as ProductCatalogId;
}
export function asInteractionOverrideId(raw: string): InteractionOverrideId {
  return raw as InteractionOverrideId;
}
export function asProtocolId(raw: string): ProtocolId {
  return raw as ProtocolId;
}

// ---------------------------------------------------------------------------
// Enums — MedicationRequest lifecycle per State Machines v1.1 §19 DRAFT
// ---------------------------------------------------------------------------

/**
 * MedicationRequest status enum — 8 active states.
 *
 * Terminal states: `discontinued`, `superseded`, `expired`, `rejected`.
 *
 * I-012 reject-unless three-clause rule applies to:
 *   - `pending_clinician_review → active` (the prescribing decision)
 *   - protocol-authorized prescribing (Mode 2 protocol agent path)
 */
export type MedicationRequestStatus =
  | 'draft'
  | 'pending_interaction_check'
  | 'pending_clinician_review'
  | 'active'
  | 'discontinued'
  | 'superseded'
  | 'expired'
  | 'rejected';

/** Discontinuation reason enum — null except when status='discontinued'. */
export type DiscontinuedReason =
  | 'clinical_decision'
  | 'adverse_event'
  | 'patient_request'
  | 'replaced_by_new_prescription'
  | 'expired'
  | 'safety_hold';

/** Interaction signals status (Med Interaction Engine output). */
export type InteractionSignalsStatus = 'pending' | 'clean' | 'caution' | 'safety_hold';

// ---------------------------------------------------------------------------
// MedicationRequest row shape (mirrors migration 023 columns)
// ---------------------------------------------------------------------------

/**
 * Row shape of `medication_requests`. All optional/nullable columns are
 * modeled as `T | null` to match the DB. Snake_case keys match the
 * column names — the row mapper in the repo translates between this and
 * the DB result rows.
 */
export interface MedicationRequest {
  // Identity
  id: MedicationRequestId;
  tenant_id: TenantId;

  // Patient anchor
  patient_account_id: AccountId;

  // Catalog anchor (snapshot-at-prescribe-time)
  product_catalog_id: ProductCatalogId;
  medication_name: string;
  strength: string;
  formulation: string;
  dose_instructions: string;
  quantity: number;
  quantity_unit: string;
  refills_allowed: number;
  indication: string | null;
  clinical_notes: string | null;

  // Lifecycle status
  status: MedicationRequestStatus;

  // Lifecycle timestamps
  prescribed_at: string | null;
  activated_at: string | null;
  discontinued_at: string | null;
  discontinued_reason: DiscontinuedReason | null;
  expires_at: string | null;

  // Authorship
  prescribed_by_clinician_account_id: AccountId | null;
  prescribing_consult_id: string | null;

  // Safety integration
  interaction_signals_evaluated_at: string | null;
  interaction_signals_status: InteractionSignalsStatus;
  interaction_override_id: InteractionOverrideId | null;

  // I-012 envelope (both null or both set, per CHECK constraint)
  ai_workload_type: string | null;
  autonomy_level: string | null;
  protocol_id: ProtocolId | null;
  protocol_version: string | null;

  // Supersession chain
  supersedes_id: MedicationRequestId | null;
  superseded_by_id: MedicationRequestId | null;

  // CCR linkage
  country_of_care: string; // ISO 3166-1 alpha-2

  // Standard timestamps
  created_at: string;
  updated_at: string;
}
