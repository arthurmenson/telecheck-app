# SI-005 — Consult / ConsultEvent schema gap (CDM v1.2)

**Raised by:** Engineering (autonomous turn 2026-05-05; Sprint 9 PM kickoff verification gate; filed at TLC-021a)
**Date:** 2026-05-05
**Severity:** medium (does NOT block Sprint 9 authoring; placeholder schema ships with this gap as the resume-gate)
**Status:** Open — awaiting CDM v1.2 §4 row-shape expansion
**Target spec doc:** `Telecheck_Canonical_Data_Model_v1_2.md`
**Target slice PRD:** `Telecheck_Async_Consult_Slice_PRD_v1_0.md`

---

## What I'm trying to implement

Sprint 9 (TLC-021a) authors `migrations/020_async_consult.sql` for the Async Consult slice. Per Async Consult Slice PRD v1.0, the slice operates on:
- **Consult** entity — CDM v1.2 §3 entity #15 (`Telecheck_Canonical_Data_Model_v1_2.md:84`): "Async or sync consultation; converts seamlessly per ADR-012"
- **ConsultEvent** entity — CDM v1.2 §3 entity #16 (`Telecheck_Canonical_Data_Model_v1_2.md:85`): "State transitions and events on a consult"

## What the canonical CDM says

CDM v1.2 §3 entity inventory NAMES both entities at lines 84-85. CDM v1.2 §4 row-shape expansion (§4.1 through §4.15) covers Tenant management + Ecom/Subscription Management entities only:
- §4.1 Tenant
- §4.2 TenantBrand
- §4.3 CountryProfile
- §4.4 CcrConfig
- §4.5 AdapterConfig
- §4.6 TenantUser
- §4.7 Subscription
- §4.8 ProductCatalog
- §4.9 Order
- §4.10 OrderItem
- §4.11 PaymentRecord
- §4.12 Discount
- §4.13 AffiliateProgram
- §4.14 AffiliateReferral
- §4.15 PromoCode

**No §4 detail block exists for entity #15 (Consult) or #16 (ConsultEvent).** Same shape as SI-001 (MedicationRequest, entity #18, also missing from §4) — the entity inventory names them but no field-level row shape is canonicalized.

## Why this is a gap, not a missing-feature

EHBG §7 (Engineering Handoff Build Guide) is explicit: engineering does NOT author canonical schema. The Slice PRD authors describe behavior; CDM §4 authors row shapes; engineering implements per the canonical contract. When CDM §4 is silent, engineering MUST raise an SI rather than author placeholder schemas without spec backing — otherwise the spec corpus silently forks.

CLAUDE.md hard rule on this: "Do NOT silently fork. When a slice PRD disagrees with CDM / OpenAPI / State Machines, open a Spec Issue (per EHBG §12); do not edit the engineering spec to match the slice."

## Decision (Sprint 9 / TLC-021a — placeholder schema with resume gate)

Per the same Sprint 8 retro option (c) posture applied to SI-004 audit events:

**Decision: Sprint 9 ships placeholder schema for `consults` + `consult_events` tables; SI-005 closure ratifies the column set upstream.**

Rationale:
1. **Authoring should not block on out-of-repo spec work.** SI-001 has been open for the entire 9-sprint cycle; we cannot afford to leave Async Consult schema-blocked for the same indefinite duration.
2. **Placeholder columns are minimal-viable.** Only what the Sprint 9-implemented transitions (1-6 + 16) actually require:
   - `id`, `tenant_id`, `patient_id` (foreign-key core)
   - `consult_type`, `modality` (PRD §1 distinguishes async vs sync; §2 distinguishes program vs general)
   - `state` (CONSULT_STATES enum vocabulary per State Machines §3)
   - `current_program_catalog_entry_id` (PRD §15 dependency on Program Catalog; nullable for non-program consults)
   - `intake_form_submission_id` (PRD §15 dependency on Forms-Intake; nullable until INTAKE → SUBMITTED transition)
   - `created_at`, `updated_at` (audit-trail timestamps)
3. **Each placeholder column carries a SQL comment** pointing to SI-005 as the resume gate, identical to how migration 002 and 005 comment their hash-chain + idempotency-key columns.
4. **Parallel posture to SI-004** for symmetry — both audit events (SI-004) and schema rows (SI-005) ship placeholders + SI docs.

## Resolution path

When SI-005 closes:

1. CDM v1.2 §4 expansion adds row-shape detail blocks for Consult (entity #15) + ConsultEvent (entity #16).
2. Engineering compares Sprint 9 placeholder columns against ratified columns.
3. Forward migration ALTER (paired with rollback) adds any new columns ratified by §4 that Sprint 9 placeholder set didn't include.
4. Forward migration ALTER (paired with rollback) renames / retypes any columns where placeholder + ratified differ.
5. PR includes closing-rationale comment referencing this SI-005 doc.
6. SI-005 status changed to "Resolved"; placeholder column SQL comments removed.

## Placeholder column set (Sprint 9 / TLC-021a — `consults` table)

```sql
-- v0.1 placeholder columns; SI-005 resume gate
id                              VARCHAR(26)  PRIMARY KEY
tenant_id                       TEXT         NOT NULL REFERENCES tenants(id)
patient_id                      VARCHAR(26)  NOT NULL  -- FK to accounts(id) (operator-facing patient identifier)
consult_type                    VARCHAR(50)  NOT NULL CHECK (...)  -- 'program' | 'general'
modality                        VARCHAR(20)  NOT NULL CHECK (...)  -- 'async' | 'sync' (per PRD §1; ADR-012 conversion)
state                           VARCHAR(30)  NOT NULL CHECK (...)  -- CONSULT_STATES enum (17 values)
current_program_catalog_entry_id VARCHAR(26) NULL  -- nullable; PRD §15 dependency on Program Catalog
intake_form_submission_id       VARCHAR(26)  NULL  -- nullable; PRD §15 dependency on Forms-Intake; populated at INTAKE → SUBMITTED
created_at                      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
updated_at                      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
```

## Placeholder column set (Sprint 9 / TLC-021a — `consult_events` table)

```sql
-- v0.1 placeholder columns; SI-005 resume gate
id          VARCHAR(26)  PRIMARY KEY
consult_id  VARCHAR(26)  NOT NULL REFERENCES consults(id)
tenant_id   TEXT         NOT NULL REFERENCES tenants(id)  -- denormalized for RLS
event_type  VARCHAR(80)  NOT NULL  -- e.g. 'state_transition', 'audit_emit'
from_state  VARCHAR(30)  NULL  -- nullable for non-transition events
to_state    VARCHAR(30)  NULL  -- nullable for non-transition events
actor_id    VARCHAR(26)  NULL  -- nullable for system-generated events
metadata    JSONB        NULL  -- nullable; per-event detail
created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
```

## Sprint reference

Filed at Sprint 9 / TLC-021a as part of the Async Consult slice authoring continuation. PM-brief verification gate at Sprint 9 kickoff confirmed CDM §4 silent on Consult / ConsultEvent. Sprint 9 ships placeholder schema + SI-005 doc as resume gate. Sprint 10 may extend placeholder columns for clinician-decision branches (transitions 9-15) — those extensions also flagged with SI-005 references in the migration comments.
