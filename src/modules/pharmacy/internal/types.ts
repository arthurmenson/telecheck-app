/**
 * pharmacy/internal/types.ts — branded IDs + canonical row shapes.
 *
 * v0.2 (P-011 / SI-001 closure 2026-05-11): MedicationRequest row-shape
 * interface added per the now-canonical CDM v1.3 §4.16. Path 1 shape (no
 * `interaction_override_id` field — integration via the
 * `medication_request.interaction_safety_hold_triggered` domain event per
 * clean module-boundary separation, ADR-001).
 *
 * History: v0.1 (pre-P-011) carried branded IDs only because SI-001 was
 * unresolved. The 2026-05-11 ratification attempt at v1.0 was reverted via
 * PR #109 after Codex returned a withdraw-ratification verdict; this v0.2
 * incorporates the v0.13 RATIFIED spec (20 Codex findings closed inline
 * across 11 pre-ratification rounds; spec corpus commit 879cd57).
 *
 * Spec references:
 *   - Canonical Data Model v1.3 §4.16 MedicationRequest (added at P-011)
 *   - State Machines v1.2 §19 MedicationRequest lifecycle (added at P-011)
 *   - AUDIT_EVENTS v5.3 §I-012 closure rule (bumped v5.2 → v5.3 at P-011)
 *   - DOMAIN_EVENTS v5.2 amend-in-place at P-011 (4 net-new event types)
 *   - WORKLOAD_TAXONOMY v5.2 §2.1/§2.2 (canonical workload values)
 *   - AUTONOMY_LEVELS v5.2 (action_with_confirm is the single
 *     I-012-permitted level at v1.0)
 *   - ADR-029 (AI workload taxonomy)
 *   - EHBG §7 (engineering implements per CDM, does not author)
 */

// ---------------------------------------------------------------------------
// Branded ID types (CDM §3.5 entities #18-#22)
// ---------------------------------------------------------------------------

// MedicationRequestId is canonical in src/lib/glossary.ts with full
// validation against the `mrx_<26-char Crockford-base32 ULID>` pattern
// (per TYPES v5.2 ID conventions). The pharmacy module imports the
// canonical brand + constructor (and re-exports both) so cross-module
// callers get the same validated type and there is exactly one
// constructor entry point. The bare unvalidated brand that lived here
// in v0.1 + v0.2 was dropped per Codex pharmacy-scaffold-rebuild R6
// HIGH closure 2026-05-12 — the local caster would have silently
// persisted noncanonical IDs that bypass the glossary's mrx_-prefix
// invariant.
import { type MedicationRequestId, asMedicationRequestId } from '../../../lib/glossary.js';
export { type MedicationRequestId, asMedicationRequestId };

declare const _refillIdBrand: unique symbol;
export type RefillId = string & { readonly [_refillIdBrand]: 'RefillId' };
export function asRefillId(s: string): RefillId {
  return s as RefillId;
}

declare const _dispensingIdBrand: unique symbol;
export type DispensingId = string & { readonly [_dispensingIdBrand]: 'DispensingId' };
export function asDispensingId(s: string): DispensingId {
  return s as DispensingId;
}

declare const _shipmentIdBrand: unique symbol;
export type ShipmentId = string & { readonly [_shipmentIdBrand]: 'ShipmentId' };
export function asShipmentId(s: string): ShipmentId {
  return s as ShipmentId;
}

declare const _productCatalogIdBrand: unique symbol;
export type ProductCatalogId = string & {
  readonly [_productCatalogIdBrand]: 'ProductCatalogId';
};
export function asProductCatalogId(s: string): ProductCatalogId {
  return s as ProductCatalogId;
}

// NOTE: No `InteractionOverrideId` branded type. The Med Interaction Engine
// slice owns the InteractionOverride entity + its identifier per Path 1
// ratified at SI-001 v1.0 (2026-05-11). Pharmacy integrates via the
// `medication_request.interaction_safety_hold_triggered` domain event;
// pharmacy code MUST NOT import an override-ID type from this module.

// ---------------------------------------------------------------------------
// Enum types — match the migration 025 CHECK constraints exactly
// ---------------------------------------------------------------------------

/**
 * MedicationRequest lifecycle states per State Machines v1.2 §19.
 *
 * Two prescribing-execution routes both terminate at `active`:
 *   - clinician_approve (clinician-only path)
 *   - protocol_authorized_prescribing (Mode 2 protocol-engine path)
 * Both routes are I-012-gated. See state-machine.ts for the transition map.
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

/**
 * Discontinuation reasons per CDM v1.3 §4.16. Nullable except when
 * status='discontinued' (enforced by the
 * medication_requests_discontinued_reason_set_when_discontinued CHECK).
 */
export type MedicationRequestDiscontinuedReason =
  | 'clinical_decision'
  | 'adverse_event'
  | 'patient_request'
  | 'replaced_by_new_prescription'
  | 'expired'
  | 'safety_hold';

/**
 * Interaction-engine signal status per CDM v1.3 §4.16. The engine writes
 * this; pharmacy reads it and may emit
 * `medication_request.interaction_safety_hold_triggered` when it flips to
 * 'safety_hold'.
 */
export type InteractionSignalsStatus = 'pending' | 'clean' | 'caution' | 'safety_hold';

/**
 * Canonical AI workload types active at v1.0 per WORKLOAD_TAXONOMY v5.2
 * §2.1/§2.2.
 *
 * Reserved-future workload types (`autonomous_agent`,
 * `multi_agent_supervisor`, `tool_using_agent`) are NOT in this enum
 * because they require successor ADR (ADR-030+) + activation audit event.
 *
 * The `rejected_invalid_attempt` sentinel + `n/a` carve-out from
 * AUDIT_EVENTS v5.3 §I-012 closure rule are envelope-level concerns, not
 * row-level concerns — they appear in the audit event envelope, not on
 * the MedicationRequest row.
 */
export type AIWorkloadType = 'conversational_assistant' | 'protocol_execution';

/**
 * Autonomy levels per AUTONOMY_LEVELS v5.2. At v1.0 the only
 * I-012-permitted level for the AI-participating EXECUTION path is
 * `action_with_confirm`. `advisory` and `suggestion` are valid taxonomy
 * values but rows persisting an I-012 EXECUTION audit envelope MUST use
 * `action_with_confirm` per the v5.3 §I-012 preservation rule.
 */
export type AutonomyLevel = 'advisory' | 'suggestion' | 'action_with_confirm';

// ---------------------------------------------------------------------------
// MedicationRequest row shape (CDM v1.3 §4.16 — Path 1 RATIFIED 2026-05-11)
// ---------------------------------------------------------------------------

/**
 * Canonical MedicationRequest row shape per CDM v1.3 §4.16.
 *
 * Field-level discipline notes:
 *   - `patient_account_id` is `accounts.account_id` (NOT `accounts.id` —
 *     the per-tenant ULID, not the row PK). Matches the §4.7 Subscription
 *     convention.
 *   - `medication_name` / `strength` / `formulation` / `dose_instructions` /
 *     `quantity` / `quantity_unit` / `refills_allowed` are snapshot-at-
 *     prescribe-time copies that do NOT mutate when `product_catalog`
 *     updates. Standard prescribing-snapshot pattern.
 *   - `prescribed_at` and `activated_at` are kept as separate fields for
 *     clarity even though they're usually set together.
 *   - `interaction_signals_status` is the Med Interaction Engine slice's
 *     output; pharmacy reads it and emits the
 *     `medication_request.interaction_safety_hold_triggered` domain event
 *     on flip to 'safety_hold'. No row-level `interaction_override_id`
 *     field — Path 1 ratified.
 *   - `supersedes_id` / `superseded_by_id` form the linear supersession
 *     chain. Discontinuation creates a new row with `status='discontinued'`
 *     and `supersedes_id` set; the old row's `status` becomes `superseded`
 *     and its `superseded_by_id` is set. Both row state transitions are
 *     captured by the I-003 hash-chain audit.
 *   - `protocol_id` + `protocol_version` are required when `autonomy_level`
 *     is set (enforced by
 *     medication_requests_i012_protocol_binding_check).
 *
 * I-012 envelope semantics (per migration 025
 * medication_requests_i012_envelope_active_check):
 *   - Pre-active states (`draft`, `pending_interaction_check`,
 *     `pending_clinician_review`, `rejected`): `ai_workload_type` and
 *     `autonomy_level` MUST both be null.
 *   - Active and post-active states (`active`, `discontinued`,
 *     `superseded`, `expired`): EITHER both null (clinician-only path) OR
 *     `ai_workload_type='protocol_execution'` AND
 *     `autonomy_level='action_with_confirm'` (the ONLY AI-participating
 *     EXECUTION path permitted by WORKLOAD_TAXONOMY v5.2 §2.2 + I-012).
 *     `conversational_assistant` at `action_with_confirm` is impossible
 *     by taxonomy and is rejected by the DB CHECK.
 */
export interface MedicationRequest {
  // Identity
  id: MedicationRequestId;
  tenant_id: string;

  // Patient + catalog anchors
  patient_account_id: string;
  product_catalog_id: ProductCatalogId;

  // Medication snapshot (frozen at prescribe-time)
  medication_name: string;
  strength: string;
  formulation: string;
  dose_instructions: string;
  quantity: number;
  quantity_unit: string;
  refills_allowed: number;
  indication: string | null;
  clinical_notes: string | null;

  // Lifecycle state
  status: MedicationRequestStatus;
  prescribed_at: Date | null;
  activated_at: Date | null;
  discontinued_at: Date | null;
  discontinued_reason: MedicationRequestDiscontinuedReason | null;
  expires_at: Date | null;

  // Authorship
  prescribed_by_clinician_account_id: string | null;
  prescribing_consult_id: string | null;

  // Safety integration (Path 1 — NO interaction_override_id field)
  interaction_signals_evaluated_at: Date | null;
  interaction_signals_status: InteractionSignalsStatus;

  // I-012 envelope (per AUDIT_EVENTS v5.3 §I-012 closure rule)
  ai_workload_type: AIWorkloadType | null;
  autonomy_level: AutonomyLevel | null;
  protocol_id: string | null;
  protocol_version: string | null;

  // Supersession chain
  supersedes_id: MedicationRequestId | null;
  superseded_by_id: MedicationRequestId | null;

  // CCR linkage
  country_of_care: string;

  // Standard timestamps
  created_at: Date;
  updated_at: Date;
}

// Row-shape interfaces for Refill, Dispensing, Shipment land in their own
// slice work (Sprint 35-36 follow-ons); they target downstream entities
// not in this scaffold.
