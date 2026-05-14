# SI-007 — Refill + Dispensing + Shipment schema gap (CDM v1.3 → v1.4)

**Raised by:** Engineering (autonomous turn 2026-05-14)
**Date raised:** 2026-05-14
**Severity:** high
**Status:** **OPEN — v0.3 DRAFT** (Codex R2 HIGH ×1 closed: Dispensing↔Shipment §5 fulfillment-state ownership handoff; pre-ratification gate continues)
**Target spec doc (proposed):** `Telecheck_Canonical_Data_Model_v1_2.md` (headers will govern v1.4; on-disk filename retains the `v1_2.md` legacy pattern per v1.10 cycle convention)
**Target slice PRD:** `Telecheck_Pharmacy_Refill_Slice_PRD_v2_1.md` (canonical references §4.17 + §4.18 + §4.19 post-promotion)
**Companion SIs:** SI-001 (MedicationRequest schema gap — CLOSED 2026-05-11 via P-011) — same pattern, expanded scope
**Promotion Ledger:** P-013 (proposed; content-change promotion bumping Registry v2.11 → v2.12)
**Pre-ratification gate:** mandatory per the SI-001 retrospective lesson — multi-round Codex convergence before ratification attempt

---

## What I'm trying to implement

The remaining 8% of the Pharmacy + Refill slice per the cockpit (`progress.json` `slice-pharmacy` task: "final 8% awaits Refill sub-slice + cap clearance to shipped"). Per EHBG §10b sprint plan, Slice 4 Pharmacy + Refill v2.1 Sprint 4-6 work:

> Refill state machine implementation, pharmacy adapter framework with first US adapter (Truepill) and first Ghana adapter, MedicationRequest model, basic refill workflow.

SI-001 closed the MedicationRequest layer via P-011, enabling TLC-055 PRs A–K (medication_requests table + repo + service + handlers; 8 active states + 13 transitions per State Machines v1.2 §19). The remaining slice work is:

- **Refill** lifecycle (entity #19 in CDM v1.3 §3.5 inventory) — the patient-initiated and subscription-initiated refill workflow per Pharmacy + Refill Slice PRD v2.1 §9.
- **Dispensing** confirmation (entity #20) — the pharmacist-side workflow per Pharmacy + Refill Slice PRD v2.1 §15 (Pharmacy partner workflow consolidated from the v1.0 Pharmacy Portal Slice).
- **Shipment** tracking (entity #21) — the last-mile delivery tracking per Pharmacy + Refill Slice PRD v2.1 §12.

The very first migration in this work would be `refills`, `dispensings`, and `shipments` tables — entities #19, #20, #21 in CDM v1.3 §3.5 Pharmacy & Fulfillment.

## What the spec says

CDM v1.3 §3.5 (line 102-105 of `Telecheck_Canonical_Data_Model_v1_2.md`):

```
| 18 | MedicationRequest | Pharmacy & Fulfillment | Renamed from "Prescription" per Contracts Pack vocabulary |
| 19 | Refill            | Pharmacy & Fulfillment | Refill request and lifecycle                              |
| 20 | Dispensing        | Pharmacy & Fulfillment | Pharmacist confirmation of dispensing                     |
| 21 | Shipment          | Pharmacy & Fulfillment | Last-mile delivery tracking                               |
| 22 | ProductCatalog    | Pharmacy & Fulfillment | Per-tenant medication and product catalog                 |
```

CDM §4 expansions present:

- §4.1–§4.6: Tenant management (entities #1–#6)
- §4.7–§4.15: Ecom (Subscription #32, SubscriptionEvent #33, ProductCatalog #22, Cart, CartItem, DiscountCode, DiscountCodeRedemption, AffiliateAccount, AffiliateConversion)
- §4.16: MedicationRequest (entity #18, added by P-011)

**Missing §4 expansions:** §4.17 Refill (#19), §4.18 Dispensing (#20), §4.19 Shipment (#21).

State Machines v1.1 §2 fully expands the **Refill state machine** (REQUESTED → VERIFYING → ELIGIBLE/INELIGIBLE → CHECKING → REVIEWED → CLINICIAN_REVIEW/PROTOCOL_EVALUATION → APPROVED/DECLINED → FULFILLING → READY → DELIVERING/PICKUP_AVAILABLE → DELIVERED/PICKED_UP → COMPLETED, plus DELIVERY_FAILED, EXCEPTION, ESCALATED, and SAFETY_HOLD via ADR-008 bridge supply). State Machines v1.1 §5 fully expands the **Pharmacy Fulfillment state machine** (QUEUED → CLAIMED → FULFILLING → RELEASE_CHECK → RELEASED → DISPATCHED → IN_TRANSIT → DELIVERED → COMPLETED). These are CANONICAL state machines — the entity schemas are the gap.

The Pharmacy + Refill Slice PRD v2.1 references these entities:

- §9 Refill workflow (Refill state machine)
- §9.1 Refill initiation paths (5 initiators)
- §9.2 Refill state machine (subscription linkage added in v2.0)
- §9.3 Pre-authorization windows (medication-class table)
- §9.4 Interaction engine gate (every refill passes through)
- §9.5 Bridge supply on consent revocation (ADR-008)
- §10 Cancellation deflection (subscription-bound; needs refill linkage)
- §11 Multi-product cart (Cart → Refill creation path)
- §12 Shipment tracking (Shipment entity)
- §13 Inventory awareness (Dispensing/in-stock path)
- §15 Pharmacy partner workflow (Dispensing entity — pick/label/release/dispatch)

OpenAPI v0.2 references refill endpoints but does not enumerate the row shape:

```
GET   /refills/{id}
POST  /refills (patient-initiated)
POST  /refills/{id}/clinician-approve
POST  /refills/{id}/protocol-evaluate
POST  /refills/{id}/dispatch
GET   /dispensings/{id}
POST  /dispensings/{id}/release-check
GET   /shipments/{id}
POST  /shipments/{id}/delivered
```

(Exact endpoint enumeration to be confirmed at the pre-ratification gate.)

AUDIT_EVENTS v5.3 §Category A lists `refill.*` action IDs as **placeholder set** (per SI-002 closure pattern); no concrete enumeration. DOMAIN_EVENTS v5.2 similarly has `refill.*` as placeholders (per SI-003 closure pattern).

## What's unclear

**The `refills`, `dispensings`, `shipments` tables are referenced by FK targets in the slice PRD and by state in State Machines §2 + §5, but none has a published row schema.** A v1.0 implementation cannot proceed without one of:

- The full `CREATE TABLE refills (...)`, `CREATE TABLE dispensings (...)`, `CREATE TABLE shipments (...)` DDLs with column types, nullability, FK targets, CHECK constraints, indexes, RLS policies.
- Canonical AUDIT_EVENTS v5.3 §Category A action IDs for refill/dispensing/shipment lifecycle (`refill.requested`, `.eligible`, `.approved`, `.declined`, `.dispatched`, `.completed`, `.cancelled`; `dispensing.released`, `.held`, `.escalated`, `.resolved`; `shipment.dispatched`, `.in_transit`, `.delivered`, `.delivery_failed`) — current AUDIT_EVENTS v5.3 lists these as the placeholder pattern only.
- Canonical DOMAIN_EVENTS v5.2 type IDs for refill/dispensing/shipment lifecycle.

Without the schema, engineering would either:

- **Author the schema in this code repo** — violates EHBG §7 "engineering implements per CDM, does not author" + the established §12 SI/DSI escalation discipline.
- **Skip the Refill sub-slice** — blocks the cockpit's `slice-pharmacy` task at 92% indefinitely; blocks Subscription completion (depends on Refill creation in `period_end` transition per State Machines §6); blocks Cancellation Deflection workflow (depends on Refill linkage); blocks Cart workflow (depends on Refill creation on checkout).

## What I'd propose

**Two-step resolution, mirroring SI-001/P-011:**

### Step 1 (spec corpus, owned by Engineering Lead + Clinical Lead + Pharmacy Lead)

Author CDM v1.4 §4.17 Refill + §4.18 Dispensing + §4.19 Shipment with at minimum:

#### §4.17 Refill (entity #19)

- **Identity:** `id` (ULID), `tenant_id` (FK tenants).
- **Patient anchor:** `patient_account_id` (FK accounts, NOT NULL).
- **Source link:** `medication_request_id` (FK medication_requests, NOT NULL) — the canonical authorization source.
- **Subscription link:** `subscription_id` (FK subscriptions, nullable) — set when refill was auto-initiated by subscription engine per §9.1.
- **Initiation:** `initiated_by` enum (`patient`, `subscription_engine`, `ai_mode_1`, `delegate`, `clinician`) — matches Slice PRD §9.1 five initiation paths.
- **Lifecycle:** `state` enum matching State Machines v1.1 §2 (REQUESTED, VERIFYING, ELIGIBLE, INELIGIBLE, CHECKING, REVIEWED, CLINICIAN_REVIEW, PROTOCOL_EVALUATION, APPROVED, DECLINED, FULFILLING, READY, DELIVERING, PICKUP_AVAILABLE, DELIVERED, PICKED_UP, COMPLETED, DELIVERY_FAILED, EXCEPTION, ESCALATED, SAFETY_HOLD, CANCELLED).
- **Decision authorship:** `decided_by_clinician_account_id` (FK accounts, nullable — populated on CLINICIAN_REVIEW path), `protocol_id` + `protocol_version` (nullable — populated on PROTOCOL_EVALUATION path).
- **Decision pathway:** `decision_pathway` enum (`clinician_reviewed`, `protocol_authorized`, `bridge_supply_consent_revocation`) — discriminator for the audit envelope's I-012 evidence rule (matches MedicationRequest §4.16 `approval_pathway` convention).
- **Safety integration:** `interaction_signals_evaluated_at`, `interaction_signals_status` (enum: `clean`, `caution`, `safety_hold`). Path 1 integration: no `interaction_override_id` column; integration via `refill.interaction_safety_hold_triggered` domain event per ADR-001 module-boundary separation (mirrors MedicationRequest §4.16 Path 1 ratified at P-011).
- **Pre-auth tracking:** `preauth_window_class` (enum matching §9.3 medication-class table: `stable_chronic`, `glp1`, `ed`, `hair_loss`, `topical_rx`, `new_medication`, `controlled_iii_v`), `preauth_renewals_remaining` (INT, decrements on COMPLETED).
- **Delivery preference:** `delivery_preference` enum (`delivery`, `pickup`).
- **Fulfillment linkage:** _Authoritative direction = child → parent._ Refill does NOT carry a `dispensing_id` or `shipment_id` FK. Per Codex R1 HIGH closure 2026-05-14, the authoritative FK is `dispensings.refill_id` (child holds the link), eliminating the bidirectional partial-failure window. Refill rows that need their fulfillment artifact look it up via `SELECT ... FROM dispensings WHERE refill_id = $refill_id` (tenant-scoped). Indexed `(tenant_id, refill_id)` UNIQUE constraint on `dispensings` enforces one-dispensing-per-refill (see §4.18).
- **Bridge supply:** `is_bridge_supply` BOOLEAN, `bridge_supply_reason` enum nullable (`consent_revocation`, `abrupt_discontinuation_risk`).
- **Timestamps:** `requested_at`, `eligible_at`, `approved_at`, `dispatched_at`, `delivered_at`, `completed_at`, `cancelled_at`, `discontinued_reason` (nullable enum).
- **CCR linkage:** `country_of_care` denormalized (matches Slice PRD §4 country_of_care threading rule).
- **Append-only after final business state.** Per Codex R1 HIGH closure 2026-05-14, the append-only invariant attaches to the **business-final** states only — the states from which no further transition is expected to fire. Per State Machines v1.1 §2, **COMPLETED is the single business-final state for a successful refill** (reached from DELIVERED via `complete` or from PICKUP_AVAILABLE via `picked_up`). Append-only states: `COMPLETED`, `DECLINED`, `INELIGIBLE`, `CANCELLED`, `EXPIRED`. `DELIVERED` and `PICKED_UP` are intermediate-on-success-path states that MUST be able to transition to `COMPLETED`; they are NOT append-only. (The prior v0.1 wording incorrectly listed DELIVERED as terminal-append-only, which would have created a state-machine dead-end where successful refills could never reach COMPLETED. Same append-only pattern as Slice 3 consent table's terminal states; the relevant analogy is "no further row mutations once COMPLETED is reached," not "no further mutations once DELIVERED is reached.")

#### §4.18 Dispensing (entity #20)

- **Identity:** `id` (ULID), `tenant_id` (FK tenants).
- **Source link (AUTHORITATIVE per Codex R1 HIGH closure):** `refill_id` (FK refills, NOT NULL) OR `medication_request_id` (FK medication_requests, NOT NULL) — but exactly one must be set (CHECK XOR constraint; precedent: Pharmacy Fulfillment §5 entity "linked to Refill or Prescription"). The Dispensing row is the **single source of truth** for the Refill ↔ Dispensing relationship; Refill does not carry the reciprocal FK. Indexed `UNIQUE (tenant_id, refill_id) WHERE refill_id IS NOT NULL` (partial unique index) prevents duplicate dispensings per refill; matching `UNIQUE (tenant_id, medication_request_id) WHERE medication_request_id IS NOT NULL` for the direct-prescription path.
- **Idempotency on creation:** Refill FULFILLING → Dispensing creation is one of the **state-changing handlers** that MUST go through the reserve-then-execute idempotency pattern (PROJECT_CONVENTIONS r5 §3.7-§3.9 + `withIdempotency` + `withIdempotentExecution`). A retry under the same Idempotency-Key after a partial failure (Dispensing row committed, Refill state transition not yet applied) recovers idempotently: the second attempt's reserve hits the existing row and returns the prior outcome; the partial unique index above prevents a duplicate Dispensing for the same Refill.
- **Pharmacy partner:** `pharmacy_adapter_id` (FK adapter_configs, NOT NULL) — which PharmacyProvider (Truepill, MedSupply, etc.) per Slice PRD §6.
- **Pharmacy actor:** `pharmacist_account_id` (FK accounts, nullable — set on RELEASE_CHECK), `pharmacist_release_check_passed_at` (timestamp).
- **Lifecycle:** `state` enum matching State Machines v1.1 §5 (QUEUED, CLAIMED, FULFILLING, RELEASE_CHECK, RELEASED, EXCEPTION, HELD, ESCALATED).
- **Exception tracking:** `exception_type` enum (nullable: `stock_out`, `substitution`, `cold_chain`, `counterfeit_flag`, `other`), `exception_resolution` enum (nullable: `resubstituted`, `escalated`, `cancelled`).
- **Inventory awareness:** `in_stock_status` enum (`in_stock`, `out_of_stock_resubbed`, `out_of_stock_cancelled`) per Slice PRD §13.
- **Compounding:** `is_compounded` BOOLEAN, `compounding_lab_id` (FK adapter_configs, nullable) per Slice PRD §14.
- **Timestamps:** `queued_at`, `claimed_at`, `fulfilled_at`, `released_at`, `dispatched_at`.
- **CCR linkage:** `country_of_care` denormalized.

#### §4.19 Shipment (entity #21)

- **Identity:** `id` (ULID), `tenant_id` (FK tenants).
- **Source link (AUTHORITATIVE per Codex R1 HIGH closure):** `dispensing_id` (FK dispensings, NOT NULL) — child holds the link; Dispensing does NOT carry a reciprocal `shipment_id` FK. Indexed `UNIQUE (tenant_id, dispensing_id)` enforces one-shipment-per-dispensing. Reserve-then-execute idempotency on Shipment creation (Dispensing RELEASE_CHECK → Shipment) per the same pattern documented for Dispensing creation above.
- **Carrier:** `carrier_id` (FK adapter_configs — which last-mile carrier per Slice PRD §12.1).
- **Tracking:** `carrier_tracking_number` (nullable text), `carrier_tracking_url` (nullable text).
- **Lifecycle:** `state` enum matching State Machines v1.1 §5 fulfillment suffix (DISPATCHED, IN_TRANSIT, DELIVERED, DELIVERY_FAILED, PICKUP_AVAILABLE, PICKED_UP, PICKUP_EXPIRED).
- **Delivery preference:** `delivery_preference` enum (`delivery`, `pickup`) — denormalized from parent Refill for cleaner querying.
- **Delivery confirmation:** `delivered_at` (timestamp), `delivery_proof_type` enum (`signature`, `photo`, `gps_geofence`, `acknowledged_receipt`), `delivery_proof_artifact_id` (nullable FK to attachments).
- **Failure tracking:** `delivery_failed_reason` enum nullable (`incorrect_address`, `no_one_to_receive`, `damaged`, `lost`, `recipient_refused`).
- **Pickup tracking:** `pickup_location_id` (FK pharmacy_locations, nullable), `pickup_expires_at` (timestamp nullable), `picked_up_at` (timestamp nullable).
- **CCR linkage:** `country_of_care` denormalized.

#### CHECK constraints (cross-entity invariants)

- `refills.subscription_id IS NOT NULL` ⟹ `refills.medication_request_id` references a `subscription_id` matching this refill's `subscription_id` (via subscription's `medication_request_id` FK). Database-enforced via trigger; precedent = MedicationRequest §4.16 supersession reciprocity trigger from P-011.
- `dispensings.refill_id IS NULL XOR dispensings.medication_request_id IS NULL` — exactly one source link must be set.
- `dispensings` partial UNIQUE: `(tenant_id, refill_id) WHERE refill_id IS NOT NULL` AND `(tenant_id, medication_request_id) WHERE medication_request_id IS NOT NULL` — one dispensing per upstream source.
- `shipments` UNIQUE: `(tenant_id, dispensing_id)` — one shipment per dispensing.
- `shipments.delivery_preference = 'pickup'` ⟹ `pickup_location_id IS NOT NULL` AND `carrier_id IS NULL`.
- `shipments.delivery_preference = 'delivery'` ⟹ `carrier_id IS NOT NULL` AND `pickup_location_id IS NULL`.
- `refills.is_bridge_supply = TRUE` ⟹ `refills.bridge_supply_reason IS NOT NULL`.
- Composite UNIQUE `(tenant_id, id)` on all three tables — tenant-scoping per ADR-023 + PROJECT_CONVENTIONS r5 §1.1.

#### Refill state-machine allowed-transition table (Codex R1 HIGH closure 2026-05-14)

Per Codex R1's recommendation to define an explicit allowed-transition table for terminal states **before** ratification. Mirrors State Machines v1.1 §2 Transition details (line 124-147), with the append-only column added:

| From                             | Event                    | To                                      | Append-only at destination?                                              |
| -------------------------------- | ------------------------ | --------------------------------------- | ------------------------------------------------------------------------ |
| REQUESTED                        | verify                   | VERIFYING                               | no                                                                       |
| VERIFYING                        | checks_pass              | ELIGIBLE                                | no                                                                       |
| VERIFYING                        | checks_fail              | INELIGIBLE                              | **YES — business-final**                                                 |
| ELIGIBLE                         | run_engine               | CHECKING                                | no                                                                       |
| CHECKING                         | signals_produced         | REVIEWED                                | no                                                                       |
| REVIEWED                         | route_clinician          | CLINICIAN_REVIEW                        | no                                                                       |
| REVIEWED                         | route_protocol           | PROTOCOL_EVALUATION                     | no                                                                       |
| CLINICIAN_REVIEW                 | approve                  | APPROVED                                | no                                                                       |
| CLINICIAN_REVIEW                 | approve_modified         | APPROVED                                | no                                                                       |
| CLINICIAN_REVIEW                 | decline                  | DECLINED                                | **YES — business-final**                                                 |
| PROTOCOL_EVALUATION              | all_pass                 | APPROVED                                | no                                                                       |
| PROTOCOL_EVALUATION              | any_fail                 | CLINICIAN_REVIEW                        | no                                                                       |
| APPROVED                         | transmit                 | FULFILLING                              | no                                                                       |
| FULFILLING                       | fulfill_ok               | READY                                   | no                                                                       |
| FULFILLING                       | exception                | EXCEPTION                               | no                                                                       |
| EXCEPTION                        | escalate                 | ESCALATED                               | no                                                                       |
| ESCALATED                        | resolve                  | FULFILLING                              | no                                                                       |
| READY                            | dispatch                 | DELIVERING                              | no                                                                       |
| READY                            | pickup_ready             | PICKUP_AVAILABLE                        | no                                                                       |
| DELIVERING                       | delivered                | DELIVERED                               | no (NOT terminal — must reach COMPLETED via `complete`)                  |
| DELIVERING                       | delivery_fail            | DELIVERY_FAILED                         | no                                                                       |
| DELIVERY_FAILED                  | revert_pickup            | PICKUP_AVAILABLE                        | no                                                                       |
| DELIVERED                        | complete                 | COMPLETED                               | **YES — business-final**                                                 |
| PICKUP_AVAILABLE                 | picked_up                | COMPLETED                               | **YES — business-final**                                                 |
| any                              | cancel                   | CANCELLED                               | **YES — business-final** (per consent-revocation + patient-cancel paths) |
| ELIGIBLE / CHECKING / FULFILLING | safety_hold              | SAFETY_HOLD                             | no (recoverable via ADR-008 bridge supply → APPROVED)                    |
| SAFETY_HOLD                      | bridge_supply_authorized | APPROVED (with `is_bridge_supply=TRUE`) | no                                                                       |

#### Dispensing ↔ Shipment §5 fulfillment-state ownership (Codex R2 HIGH closure 2026-05-14)

State Machines v1.1 §5 (Pharmacy Fulfillment) spans `QUEUED → CLAIMED → FULFILLING → RELEASE_CHECK → RELEASED → DISPATCHED → IN_TRANSIT → DELIVERED → COMPLETED`. v0.2 of this SI proposed Dispensing's `state` enum stopping at `{QUEUED, CLAIMED, FULFILLING, RELEASE_CHECK, RELEASED, EXCEPTION, HELD, ESCALATED}` without addressing the post-RELEASED tail. Per Codex R2 HIGH closure, the resolution is an **explicit handoff** at RELEASED:

**Ownership boundary:** Dispensing owns the **pharmacist-side fulfillment** lifecycle (QUEUED through RELEASED, with exception/held/escalated as in-band recovery states). Shipment owns the **carrier-side delivery** lifecycle (DISPATCHED through DELIVERED/PICKED_UP). The two are linked authoritatively via `shipments.dispensing_id` (per the v0.2 child-holds-link decision).

**Dispensing state enum (post-handoff):**

| State         | Meaning                                                                           | Next                                                                             |
| ------------- | --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| QUEUED        | Pharmacist queue; awaiting claim                                                  | CLAIMED on `claim`                                                               |
| CLAIMED       | Pharmacist accepted                                                               | FULFILLING on `start_fulfillment`                                                |
| FULFILLING    | Pick, label, package                                                              | RELEASE_CHECK on `fulfill_complete`                                              |
| RELEASE_CHECK | Pharmacist release check                                                          | RELEASED on `release_pass`                                                       |
| RELEASED      | Pharmacist released; ready for handoff to Shipment                                | **(terminal-from-Dispensing perspective)** — Shipment row creation triggers next |
| EXCEPTION     | Stock-out / substitution / cold-chain / counterfeit flag                          | HELD on `hold`                                                                   |
| HELD          | Awaiting decision                                                                 | ESCALATED on `escalate`                                                          |
| ESCALATED     | Clinician/pharmacist review                                                       | FULFILLING on `resolve` (re-enter)                                               |
| CANCELLED     | Dispensing cancelled before RELEASED (consent revocation, refill cancelled, etc.) | **(business-final)**                                                             |

**Handoff rule (Dispensing RELEASED → Shipment row creation):**

1. **Trigger:** A successful Dispensing.released event MUST create exactly one Shipment row scoped to that Dispensing.
2. **Authoritative link direction (per v0.2):** `shipments.dispensing_id` (Shipment row holds the FK; Dispensing does not carry `shipment_id`).
3. **Idempotency:** The Shipment creation runs through the reserve-then-execute pattern (PROJECT_CONVENTIONS r5 §3.7-§3.9 + `withIdempotency` + `withIdempotentExecution`). The partial UNIQUE `shipments (tenant_id, dispensing_id)` per §4.19 ensures one Shipment per Dispensing across retries.
4. **Recovery (Dispensing RELEASED but no Shipment yet):** A repair job (or the next pharmacy-portal request hitting the same Dispensing) detects the gap via `WHERE dispensings.state = 'RELEASED' AND NOT EXISTS (SELECT 1 FROM shipments WHERE shipments.dispensing_id = dispensings.id)` and creates the missing Shipment row (idempotent by the partial UNIQUE).
5. **Append-only-on-RELEASED:** Once a Dispensing reaches RELEASED, the row is append-only (no further UPDATEs). Any subsequent state-machine progress is recorded on the Shipment row.
6. **Cancellation race:** If a patient/clinician cancellation arrives between Dispensing.RELEASED and Shipment.DISPATCHED, the cancellation creates a Shipment row in `CANCELLED_BEFORE_DISPATCH` state (terminal) rather than mutating the Dispensing. This preserves the append-only-on-RELEASED invariant.

**Shipment state enum (post-handoff):**

| State                     | Meaning                                                                                  | Next                                                                                                                                               |
| ------------------------- | ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| DISPATCHED                | Carrier picked up from pharmacy (delivery mode) OR pickup ready at counter (pickup mode) | IN_TRANSIT on `in_transit_update` (delivery only) OR PICKUP_AVAILABLE (pickup mode immediately)                                                    |
| IN_TRANSIT                | Carrier scan event                                                                       | DELIVERED on `delivered` OR DELIVERY_FAILED on `delivery_fail`                                                                                     |
| DELIVERED                 | Proof of delivery received                                                               | (Refill row transitions to DELIVERED on this Shipment's `delivered` event; Refill transitions to COMPLETED on its own `complete` event after this) |
| DELIVERY_FAILED           | Delivery unsuccessful                                                                    | PICKUP_AVAILABLE on `revert_pickup` per State Machines v1.1 §2                                                                                     |
| PICKUP_AVAILABLE          | Pickup mode: ready at counter (initial) OR fallback after delivery failure               | PICKED_UP on `picked_up` OR PICKUP_EXPIRED on `pickup_expires`                                                                                     |
| PICKED_UP                 | Patient collected                                                                        | (Refill row transitions to PICKED_UP on this Shipment's event; Refill transitions to COMPLETED on its own `complete` event after this)             |
| PICKUP_EXPIRED            | Pickup window expired without collection                                                 | **(business-final)**                                                                                                                               |
| CANCELLED_BEFORE_DISPATCH | Cancellation race per #6 above                                                           | **(business-final)**                                                                                                                               |

**Cross-entity append-only set (consolidated):**

- **Refill business-final:** `{COMPLETED, INELIGIBLE, DECLINED, CANCELLED, EXPIRED}`
- **Dispensing business-final + append-only at RELEASED:** `{RELEASED, CANCELLED}` (the §5 progress after RELEASED is recorded on Shipment per the handoff rule)
- **Shipment business-final:** `{DELIVERED, PICKED_UP, PICKUP_EXPIRED, CANCELLED_BEFORE_DISPATCH}` (terminal on this Shipment; the parent Refill still needs `complete` to reach its own business-final COMPLETED)

**Why this design:**

- **Single canonical state machine across the boundary.** The §5 lifecycle is preserved end-to-end; it's just owned by two tables. Dispensing carries QUEUED→RELEASED; Shipment carries DISPATCHED→DELIVERED/PICKED_UP/PICKUP_EXPIRED.
- **Append-only-on-RELEASED for Dispensing.** Once the pharmacist releases, the Dispensing row's lifecycle is complete. Subsequent state changes (carrier scans, delivery confirmation, pickup, etc.) are Shipment events, not Dispensing UPDATEs. This eliminates the partial-failure window where a Shipment is created but the Dispensing state hasn't been UPDATEd to a downstream state — there IS no downstream Dispensing state to UPDATE.
- **Idempotent handoff.** Reserve-then-execute + partial UNIQUE ensures one Shipment per Dispensing. Recovery via the existence-check WHERE clause is straightforward and idempotent.
- **Refill's view stays simple.** The Refill row's `state` enum still drives the overall lifecycle from the patient's perspective. Refill's `DELIVERED` / `PICKED_UP` / `COMPLETED` events are triggered by the corresponding Shipment row events (cross-table state coordination, not cross-table state UPDATEs).

**Append-only-state set: `{COMPLETED, INELIGIBLE, DECLINED, CANCELLED, EXPIRED}`.** Rows in these states cannot be UPDATEd; subsequent corrections require a fresh Refill row (or, for amendment-class corrections, a fresh MedicationRequest superseding the original, which itself triggers a fresh Refill cycle). `DELIVERED` and `PICKUP_AVAILABLE` are NOT append-only — they MUST transition to `COMPLETED` to finalize the lifecycle.

(Note: the append-only invariant is enforced at the repository layer via `UPDATE ... WHERE state NOT IN (<append_only_set>)` guards, mirroring the MedicationRequest §4.16 supersession-reciprocity trigger pattern. The state machine itself uses state-transition guards in the service layer per the existing TLC-055 pharmacy state-machine.ts implementation precedent.)

#### RLS policies

All three tables: canonical `current_tenant_id()` helper-based RLS per CDM v1.3 §4.16 pattern. No special carve-outs.

#### Add the corresponding spec-corpus entries

- **State Machines v1.1 — keep §2 + §5 as canonical state machine sources.** SI-007 is a schema gap, not a state-machine gap; no §20/§21 needed.
- **AUDIT_EVENTS v5.3 — promote placeholder set to canonical:** enumerate `refill.{requested, eligible, ineligible, signals_evaluated, clinician_approved, clinician_declined, protocol_approved, protocol_declined, fulfilling_started, released, dispatched, delivered, picked_up, completed, cancelled, safety_hold_triggered, bridge_supply_dispensed, execution_rejected}` (18 net-new); `dispensing.{queued, claimed, released, exception_recorded, held, escalated, resolved}` (7 net-new); `shipment.{dispatched, in_transit_update, delivered, delivery_failed, pickup_available, picked_up, pickup_expired}` (7 net-new). Bumps AUDIT_EVENTS Contracts Pack **v5.3 → v5.4** (smallest semver step appropriate to additive-only Category A enumeration; precedent = P-011 v5.2 → v5.3 amendment).
- **DOMAIN_EVENTS v5.2 — additive enum extension:** add `refill.{approved, dispatched, completed, cancelled, interaction_safety_hold_triggered}` (5 net-new tenant-scoped events; partition_key `tenant_id:refill_id`), `dispensing.{released, exception_escalated}` (2 net-new; partition_key `tenant_id:dispensing_id`), `shipment.{delivered, delivery_failed}` (2 net-new; partition_key `tenant_id:shipment_id`). No version bump per P-011 precedent (DOMAIN_EVENTS additive enum extension stays in-place at v5.2).
- **I-012 envelope check amendment in CDM `audit_i012_workload_evidence_required` CHECK constraint:** add the new `refill.{clinician_approved, protocol_approved, bridge_supply_dispensed, execution_rejected}` action IDs to the I-012 authoritative set (database-level enforcement of AUDIT_EVENTS v5.4 §I-012 closure rule, in lockstep with the AUDIT_EVENTS prose amendment).

#### Promotion Ledger entry P-013 closes this SI

Content-change promotion bumping Registry v2.11 → v2.12. Coverage counts updated: entities 42 → 45 (added Refill #19, Dispensing #20, Shipment #21); state machines 19 → 19 (no new SMs — §2 + §5 already canonical); Contracts Pack rows updated (AUDIT_EVENTS v5.3 → v5.4; DOMAIN_EVENTS in-place at v5.2 with 9 net-new event types); CDM row updated to v1.4 with §4.17 + §4.18 + §4.19 + amended `audit_i012_workload_evidence_required` CHECK noted.

### Step 2 (this code repo, owned by Engineering)

Once Step 1 lands (pull the spec bundle; confirm CDM has §4.17 + §4.18 + §4.19 expanded), implement migrations 028 + 029 + 030 (refills + dispensings + shipments) + repo + service + handlers per the established TLC-055 pattern (PRs A–K precedent). Estimated 12-18 commits depending on Codex per-PR adversarial review iteration depth, broken into ~3-4 PRs:

- **PR α**: `refills` migration + repo layer + state-machine module (mirror of `MedicationRequest` state-machine.ts pattern; the §2 lifecycle is 20+ states / 20+ transitions). I-012 + Path 1 + safety-hold-handling guards.
- **PR β**: Refill HTTP surface (read endpoints + patient-initiated POST `/refills` + subscription-engine service-callable creation path).
- **PR γ**: Refill clinician/protocol decision write-paths (`clinician_approve`, `clinician_decline`, `protocol_authorized_approve`, `protocol_declined`).
- **PR δ**: Refill fulfillment writeback (FULFILLING → READY → DELIVERING → DELIVERED/PICKED_UP → COMPLETED) + cross-entity wiring to Dispensing (`dispensings` migration + service-callable creation from Refill FULFILLING) + Shipment (`shipments` migration + service-callable creation from Dispensing RELEASE_CHECK).
- **PR ε**: Audit + domain emitters for the 18+7+7 net-new audits + 5+2+2 net-new domain events; cross-tenant isolation regression tests; I-003 audit-chain regression; subscription-linkage tests (refill creation from subscription `period_end`); ADR-008 bridge-supply path tests.

Total estimated effort: ~3-4 weeks of engineering capacity given the Codex per-PR cadence observed on TLC-055 (each PR typically 1-3 rounds for a state-machine-bearing slice, with PR α expected to need 5+ given the breadth of the §2 state machine).

## What I'm doing in the meantime

**Pausing the Refill sub-slice until SI-007 closes.** The pharmacy module on `main` is stable at the medication_requests level (TLC-055 PRs A–K merged 2026-05-14; `/v0/pharmacy/ready` returns 200; cockpit `slice-pharmacy` task is at 92%).

Cross-slice options that don't require SI-007 closure:

1. **Forms/Intake Slice (92% on cockpit)** — final 8% needs identification before pursuit. Hypothesis: forms-intake hardening + resume-state edge cases. Requires its own status doc read before slice work.
2. **Consent & Delegated Access (72% on cockpit)** — independent track from SI-007; may have implementable surface.
3. **AI Service handler mount (PR G/H)** — blocked on 5 external dependencies enumerated in `AI_Service_Rollout_24h_Status_2026-05-14.md` §"What's NOT live"; cannot proceed autonomously.

The autonomous-turn discipline preserved from SI-001: **never author canonical schema in the code repo.** Spec gaps surface as SIs and route to the spec corpus.

## Required from product

| Item                                                                                                                                                                                           | Owner                                         | Severity |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- | -------- |
| CDM v1.3 → v1.4 §4.17 Refill field-level schema                                                                                                                                                | Engineering Lead + Clinical Lead              | high     |
| CDM v1.3 → v1.4 §4.18 Dispensing field-level schema                                                                                                                                            | Engineering Lead + Pharmacy Lead              | high     |
| CDM v1.3 → v1.4 §4.19 Shipment field-level schema                                                                                                                                              | Engineering Lead                              | high     |
| CDM CHECK constraint amendment: `audit_i012_workload_evidence_required` adding `refill.{clinician_approved, protocol_approved, bridge_supply_dispensed, execution_rejected}` to the I-012 list | Engineering Lead                              | high     |
| AUDIT_EVENTS v5.3 → v5.4 promotion: enumerate 32 net-new Category A action IDs (18 refill + 7 dispensing + 7 shipment) replacing the placeholder set                                           | Privacy/Compliance + Engineering Lead         | high     |
| DOMAIN_EVENTS v5.2 in-place amendment: 9 net-new domain event types (5 refill + 2 dispensing + 2 shipment)                                                                                     | Engineering Lead                              | medium   |
| Decision: Refill is append-only on terminal states (mirroring Consent §7.1) vs mutable                                                                                                         | Engineering Lead + Clinical Lead              | medium   |
| Decision: Dispensing source XOR — refill_id NULL XOR medication_request_id NULL — confirm pattern                                                                                              | Engineering Lead                              | medium   |
| Decision: ADR-008 bridge-supply path's `decision_pathway = 'bridge_supply_consent_revocation'` envelope rule (does it require I-012 evidence?)                                                 | Engineering Lead + Clinical Lead + Compliance | medium   |
| Decision: Inventory awareness (§13) vs scope of Dispensing entity — single column or separate table?                                                                                           | Engineering Lead + Pharmacy Lead              | low      |
| Pre-ratification gate (mandatory per SI-001 retrospective): multi-round Codex convergence before ratification attempt                                                                          | Engineering (orchestrator) + Codex (reviewer) | high     |

---

## Cross-references

- **EHBG v1.3 §10b sprint plan** — Sprint 4-6 (weeks 9-14): Pharmacy + Refill v2.X full implementation
- **EHBG v1.3 §12** — SI escalation template (this doc follows it)
- **CDM v1.3 §3.5 + §4** — entity inventory and field-level expansion
- **CDM v1.3 §4.16 MedicationRequest** — canonical precedent for the §4.17/§4.18/§4.19 expansions
- **State Machines v1.1 §2** — Refill state machine (canonical; preserved; not a gap)
- **State Machines v1.1 §5** — Pharmacy Fulfillment state machine (canonical; preserved; not a gap)
- **Pharmacy + Refill Slice PRD v2.1 §9** — Refill workflow with v2.0 subscription-aware additions
- **Pharmacy + Refill Slice PRD v2.1 §10** — Cancellation deflection (depends on Refill linkage)
- **Pharmacy + Refill Slice PRD v2.1 §12** — Shipment tracking
- **Pharmacy + Refill Slice PRD v2.1 §13** — Inventory awareness
- **Pharmacy + Refill Slice PRD v2.1 §15** — Pharmacy partner workflow (Dispensing)
- **ADR-008** — Bridge supply on consent revocation (canonical clinical-safety carve-out)
- **AUDIT_EVENTS v5.3** — placeholder pattern for `refill.*`, `dispensing.*`, `shipment.*` (this SI promotes them)
- **DOMAIN_EVENTS v5.2** — placeholder pattern for the same (this SI promotes them in-place)
- **I-012** — `prescription/refill/medication-order execution` reject-unless three-clause rule (Refill is in scope)
- **I-019** — crisis detection NOT in scope for Refill (no patient-text input surfaces in the Refill workflow itself)
- **I-023..I-027** — tenant isolation (every Refill/Dispensing/Shipment row carries `tenant_id` per ADR-023)
- **ADR-001** — modular monolith; Refill/Dispensing/Shipment all live in `src/modules/pharmacy/` per the existing module boundary
- **ADR-023** — multi-tenancy Model A (RLS + app-layer filter + per-tenant KMS keys)
- **ADR-024** — country-driven adapter selection (PharmacyProvider abstraction; Dispensing.pharmacy_adapter_id + Shipment.carrier_id route through this)
- **SI-001 (CLOSED via P-011)** — the proven precedent for this SI's structure + ratification cycle
- **PROJECT_CONVENTIONS r5 §1.1** — composite UNIQUE + composite FK pattern for tenant-scoped tables
- **PROJECT_CONVENTIONS r5 §3.7-§3.9** — reserve-then-execute idempotency pattern (will apply to every state-changing Refill/Dispensing/Shipment handler)

## Companion code-repo state at SI-007 raise

- **Slices implementation-complete:** Forms-Intake (1), Identity + JWT (2), Consent + Delegated Access (3), Tenant Config (TLC-009 partial), AI Service module (PRs A–F merged 2026-05-14; handlers gated).
- **Slices implementation-partial:** Pharmacy + Refill (MedicationRequest layer complete via P-011 + TLC-055 A–K; Refill + Dispensing + Shipment BLOCKED by this SI).
- **Slices blocked on this SI:** Refill sub-slice, Subscription completion (depends on Refill for `period_end` transition), Cancellation Deflection (depends on Refill linkage), Cart workflow (Cart → Refill creation path), Multi-product cart, Shipment tracking surfaces.
- **Slices unblocked but not started:** Med Interaction Engine (depends on MedicationRequest list — UNBLOCKED by P-011), Adverse Event Reporting, Labs & Document Interpretation, RPM/CCM.

## Resolution expectations

- **Target close-out:** Spec Issue resolution lands in the spec bundle as Promotion Ledger entry **P-013** (next available P-NUM after the P-012 slot was deferred — see `Telecheck_v1_10_PRD_Update/AI_Service_Rollout_24h_Status_2026-05-14.md` Addendum 2; if P-012 is later assigned, P-013 becomes P-014, etc.).
- **Pre-ratification gate (mandatory):** multi-round Codex adversarial-review convergence on the SI-007 v0.1 → v0.X DRAFT trajectory before any ratification attempt. SI-001's 11-round trajectory is the precedent for this slot.
- **Until then:** SI-007 stays open in this file; engineering does not author the schema; Refill sub-slice implementation does not begin.

---

## Document control

- **v0.1 — 2026-05-14** — Initial DRAFT authored autonomously on the post-AI-Service-rollout continuation. Captures the gap, the spec corpus references, the proposed schema, the cross-references, the resolution expectations.
- **v0.2 — 2026-05-14** — Codex R1 HIGH ×2 closed:
  1. **Terminal-state contradiction:** v0.1 listed DELIVERED as append-only terminal, which would have created a state-machine dead-end (DELIVERED must transition to COMPLETED via `complete`). v0.2 narrows the append-only set to `{COMPLETED, INELIGIBLE, DECLINED, CANCELLED, EXPIRED}` and adds an explicit allowed-transition table per Codex's recommendation.
  2. **Circular FK ambiguity:** v0.1 proposed bidirectional FKs (`refills.dispensing_id` + `dispensings.refill_id`) without specifying authoritative direction, creating partial-failure recovery issues. v0.2 makes the **child-holds-link** direction authoritative (`dispensings.refill_id`, `shipments.dispensing_id`), removes the reciprocal FKs from Refill/Dispensing, adds partial UNIQUE indexes for one-child-per-parent enforcement, and documents reserve-then-execute idempotency on creation.
- **v0.3 — 2026-05-14** — Codex R2 HIGH ×1 closed:
  - **Dispensing schema dropped canonical §5 states (DISPATCHED → IN_TRANSIT → DELIVERED → COMPLETED).** v0.2's Dispensing enum stopped at RELEASED + exception/held/escalated; the §5 lifecycle continued through DISPATCHED → IN_TRANSIT → DELIVERED → COMPLETED but no entity owned those states. v0.3 adds an explicit **Dispensing ↔ Shipment §5 fulfillment-state ownership** section that: defines an ownership boundary (Dispensing owns QUEUED→RELEASED; Shipment owns DISPATCHED→DELIVERED/PICKED_UP/PICKUP_EXPIRED); enumerates both state enums in full; documents the **handoff rule** at RELEASED (Shipment row creation, idempotency, recovery, append-only-on-RELEASED, cancellation-race handling); consolidates the cross-entity append-only set across all three entities.
- **Next:** v0.4 after Codex R3 review; iterate to convergence per the SI-001 trajectory pattern (R1 → R10 was SI-001's path).
