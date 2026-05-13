# SI-001 — MedicationRequest schema gap (CDM v1.2 → v1.3)

**Raised by:** Engineering (autonomous turn 2026-05-04)
**Date raised:** 2026-05-04
**Severity:** high
**Status:** **CLOSED 2026-05-11 — RATIFIED via Promotion Ledger entry P-011** (spec corpus commit `879cd57` in `arthurmenson/telecheckONE`). The first 2026-05-11 ratification attempt (the original PR #95 + PR #108 sequence) was reverted via PR #109 after Codex returned a withdraw-ratification verdict with 5 findings; the same-day re-ratification closed those 5 findings plus 15 more across 11 rounds of pre-ratification Codex convergence, plus 22 propagation findings across 11 rounds of post-merge convergence. Pharmacy + Refill v2.1 scaffold landed in this repo on `feat/slice-4-pharmacy-scaffold-rebuild-p011` (the PR #95 / PR #108 successor PR); 12 additional rounds of pre-PR Codex convergence closed 15 scaffold-side findings + 1 deferred-to-write-path with TLC-055 acceptance criterion (supersession reciprocity constraint trigger).
**Target spec doc (ratified):** `Telecheck_Canonical_Data_Model_v1_3.md` (headers govern; on-disk filename retains the `v1_2.md` legacy pattern per v1.10 cycle convention)
**Target slice PRD:** `Telecheck_Pharmacy_Refill_Slice_PRD_v2_1.md` (canonical references CDM v1.3 §4.16 + State Machines v1.2 §19 post-P-011)
**Promotion Ledger:** P-011 (2026-05-11; content-change promotion bumping Registry v2.10 → v2.11)
**Spec corpus refs (in telecheckONE):** `55d9c20` (workstream artifacts including the SI-001 v0.13 RATIFIED DRAFT) + `879cd57` (P-011 promotion landing the 11 bundle-file changes)
**Path 1 ratified:** No `interaction_override_id` column. Med Interaction Engine integration via the `medication_request.interaction_safety_hold_triggered` domain event with clean module-boundary separation per ADR-001.
**New I-012 confirmation action:** `prescribing.protocol_authorization_granted` (added at AUDIT_EVENTS v5.3 under P-011) — the canonical clinician confirmation prerequisite for the `protocol_authorized_prescribing` execution route.

---

## What I'm trying to implement

Slice 4 of the EHBG §10b sprint plan — **Pharmacy + Refill v2.1 part 1** (Sprint 4, weeks 9-10):

> Refill state machine implementation, pharmacy adapter framework with first US adapter (Truepill) and first Ghana adapter, **MedicationRequest model**, basic refill workflow.

The very first migration in that work would be the `medication_requests` table — entity #18 in CDM v1.2 §3.5 Pharmacy & Fulfillment, "Renamed from 'Prescription' per Contracts Pack vocabulary."

## What the spec says

Three places in the spec corpus reference `medication_requests`, and all three are **referencing references** — none defines the table:

1. **CDM v1.2 §3.5 (line 92)** — listed in the entity inventory:

   ```
   | 18 | MedicationRequest | Pharmacy & Fulfillment | Renamed from "Prescription" per Contracts Pack vocabulary |
   ```

   No §4.X field-level expansion follows for entity #18. CDM v1.2 §4 expands §4.1–§4.15 (Tenant management + Ecom & Subscription Management entities only). Entity #18 has no §4 detail block.

2. **CDM v1.2 §4.7 Subscription (line 416)** — references `medication_requests` as a foreign-key target:

   ```sql
   prescription_id  VARCHAR(26) NOT NULL REFERENCES medication_requests(id),
   ```

3. **Pharmacy + Refill Slice PRD v2.1 §8.1 (line 231)** — the same FK reference inside the Subscription DDL.

OpenAPI v0.2 §5.1 (line 255+) gives **field hints** in a `POST /consults/{id}/decision` request payload:

```json
"prescriptions": [{
  "medication_id": "uuid",
  "medication_name": "Metformin",
  "strength": "500mg",
  "formulation": "tablet",
  "dose_instructions": "1 tablet twice daily with meals",
  "quantity": 60,
  "refills_allowed": 5,
  "indication": "Type 2 diabetes management"
}]
```

These are API-payload field names, not table-column names; in particular `medication_id` here is the catalog-item FK (entity #22 ProductCatalog), not the row's own primary key.

## What's unclear

**The `medication_requests` table is referenced by FK from a canonical entity (Subscription) but the table itself has no published schema.** A v1.0 implementation cannot proceed without one of:

- The full `CREATE TABLE medication_requests (...)` DDL with column types, nullability, FK targets, CHECK constraints, indexes, RLS policy.
- A canonical `MedicationRequest` state machine definition (the OpenAPI hint "PRESCRIBED" suggests one exists implicitly but it isn't enumerated in State Machines v1.1 §1–§18).
- Audit-event canonical action IDs for medication_request lifecycle (`medication_request.created`, `.activated`, `.discontinued`, etc.) — none are enumerated in AUDIT_EVENTS v5.2.
- Domain-event canonical type IDs for medication_request lifecycle — none enumerated in DOMAIN_EVENTS v5.2.

Without the schema, engineering would either:

- **Author the schema in this code repo** — violates EHBG §7 "engineering implements per CDM, does not author" + the established §12 SI/DSI escalation discipline.
- **Skip Slice 4** — blocks Sprint 4–6 work in §10b (refill, subscription, pharmacy adapter, dispensing, shipment all transitively depend on this table).

## What I'd propose

**Two-step resolution:**

### Step 1 (spec corpus, owned by Engineering Lead + Clinical Lead)

Author CDM v1.2 §4.16 (or v1.3) MedicationRequest with at minimum:

- **Identity:** `id` (ULID), `tenant_id` (FK tenants).
- **Patient anchor:** `patient_account_id` (FK accounts, NOT NULL).
- **Catalog:** `product_catalog_id` (FK product_catalog), `medication_name`, `strength`, `formulation`.
- **Clinical detail:** `dose_instructions`, `quantity`, `refills_allowed` (INT), `indication`, `notes` (nullable).
- **Lifecycle:** `status` enum (`draft`, `active`, `discontinued`, `expired`, `superseded`), `prescribed_at`, `discontinued_at`, `discontinued_reason` (nullable enum), `expires_at`, `superseded_by_id` (self-FK nullable).
- **Authorship:** `prescribed_by_clinician_account_id` (FK accounts, NOT NULL when status ≠ draft), `prescribing_consult_id` (FK consults nullable).
- **Safety integration:** `interaction_signals_evaluated_at`, `interaction_signals_status` (enum: `clean`, `caution`, `safety_hold`), `interaction_override_id` (nullable FK to interaction_overrides table — out of scope for this SI).
- **Append-only:** discontinuation creates a new `superseded` row, not an UPDATE — same pattern as Slice 3 consent table per Slice PRD §7.1. Confirms whether MedicationRequest is append-only or mutable.
- **CCR linkage:** `country_of_care` denormalized (matches the Slice PRD §4 country_of_care threading rule).

Add the corresponding State Machines v1.1 §19 entry, AUDIT_EVENTS v5.2 Category A action IDs (`medication_request.prescribed`, `.discontinued`, `.superseded`, `.execution_rejected` per I-012), DOMAIN_EVENTS v5.2 type IDs.

Promotion Ledger entry P-011 closes this SI.

### Step 2 (this code repo, owned by Engineering)

Once Step 1 lands (pull the spec bundle, confirm CDM has §4.16 expanded), implement migration 018 + repo + service + handlers per the established pattern (mirror of Slice 3 consent module structure):

```
src/modules/pharmacy/
├── internal/
│   ├── types.ts                                 # branded IDs + enums
│   ├── repositories/
│   │   ├── medication-request-repo.ts
│   │   └── refill-repo.ts
│   ├── services/
│   │   └── medication-request-service.ts
│   └── handlers/
│       └── medication-requests.ts
├── audit.ts                                      # 5+ Category A emitters
├── index.ts                                      # public-interface
├── plugin.ts
└── routes.ts
```

## What I'm doing in the meantime

**Pausing Slice 4 until SI-001 closes.** Continuing to harden Slices 1–3 (forms-intake, identity, consent + delegation) — coverage-gap tests + invariant regression tests + cross-tenant isolation tests. Recent commits `972a3aa..37d0f87` exemplify the pattern.

The autonomous-turn discipline is: **never author canonical schema in the code repo.** Spec gaps are surfaced as SIs and routed to the spec corpus.

## Required from product

| Item                                                                                                                                                    | Owner                                 | Severity |
| ------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- | -------- |
| CDM v1.2 §4.16 MedicationRequest field-level schema                                                                                                     | Engineering Lead + Clinical Lead      | high     |
| State Machines v1.1 §19 MedicationRequest state machine                                                                                                 | Clinical Lead                         | high     |
| AUDIT_EVENTS v5.2 — `medication_request.*` Category A canonical action IDs                                                                              | Privacy/Compliance + Engineering Lead | medium   |
| DOMAIN_EVENTS v5.2 — `medication_request.*` type IDs                                                                                                    | Engineering Lead                      | medium   |
| Decision: append-only vs mutable on discontinuation                                                                                                     | Engineering Lead + Clinical Lead      | medium   |
| Decision: how `interaction_override_id` and the InteractionOverride entity (Med Interaction Engine slice) participate; SI-002 candidate if scope creeps | Engineering Lead                      | medium   |

---

## Cross-references

- EHBG v1.3 §10b sprint plan — Sprint 4 (weeks 9-10): Pharmacy + Refill v2.X part 1
- EHBG v1.3 §12 — SI escalation template (this doc follows it)
- CDM v1.2 §3.5 + §4 — entity inventory and field-level expansion
- Pharmacy + Refill Slice PRD v2.1 §8.1 — Subscription FK to medication_requests
- Med Interaction Engine Slice PRD v1.0 §4 — interaction signals consume the medication list (depends on MedicationRequest schema)
- I-012 — `prescription/refill/medication-order execution` reject-unless three-clause rule (pre-supposes medication_request entity exists)
- AUDIT_EVENTS v5.2 — placeholder pattern used by Slices 1/2/3 for unratified action IDs (`{slice}AuditPlaceholder()`); same pattern would apply to Slice 4 if a partial implementation lands ahead of full ratification

## Companion code-repo state at SI-001 raise

- **Slices implementation-complete:** Forms-Intake (1), Identity + JWT (2), Consent + Delegated Access (3).
- **Slices blocked on this SI:** Pharmacy + Refill (4), Refill subworkflow, Subscription, Dispensing, Shipment — anything that needs `medication_requests` to exist.
- **Slices unblocked but not started:** Med Interaction Engine (depends on MedicationRequest list — partially blocked by this SI but the engine's pure-logic surface can be drafted with a placeholder MedicationRequest interface).

## Resolution expectations

- **Target close-out:** Spec Issue resolution lands in the spec bundle as Promotion Ledger entry **P-011** (next available P-NUM after P-010 closure 2026-05-02 documented in `migrations/001_tenants.sql`).
- **Until then:** SI-001 stays open in this file; engineering does not author the schema; Slice 4 implementation does not begin.
