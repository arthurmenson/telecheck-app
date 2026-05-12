/**
 * pharmacy/internal/types.ts — branded ID types only at v0.1.
 *
 * Schema authoring is BLOCKED on SI-001 (`docs/SI-001-MedicationRequest-Schema-Gap.md`).
 * The CDM v1.2 §3.5 Pharmacy & Fulfillment entity inventory references
 * MedicationRequest/Refill/Dispensing/Shipment/ProductCatalog (entities
 * #18-#22) but provides no §4 field-level expansion. Per EHBG §7,
 * engineering does not author canonical schema. Branded IDs land here
 * because they are NOT schema (they're identifier hygiene); row-shape
 * interfaces wait for SI-001 closure (Promotion Ledger P-011).
 *
 * Spec references:
 *   - docs/SI-001-MedicationRequest-Schema-Gap.md
 *   - CDM v1.2 §3.5 (entity inventory)
 *   - EHBG §7 (engineering implements per CDM, does not author)
 */

// ---------------------------------------------------------------------------
// Branded ID types (CDM §3.5 entities #18-#22)
// ---------------------------------------------------------------------------

declare const _medicationRequestIdBrand: unique symbol;
export type MedicationRequestId = string & {
  readonly [_medicationRequestIdBrand]: 'MedicationRequestId';
};
export function asMedicationRequestId(s: string): MedicationRequestId {
  return s as MedicationRequestId;
}

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

// Row-shape interfaces (MedicationRequest, Refill, Dispensing, Shipment,
// ProductCatalog) are intentionally NOT exported here. They land when
// SI-001 closes and the CDM §4 field-level schema is canonical.
