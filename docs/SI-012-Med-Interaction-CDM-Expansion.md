# SI-012 — Med Interaction Engine CDM expansion (Track 1 pilot blocker)

**Raised by:** Engineering (autonomous run 2026-05-16; Med-Interaction module audit + Track 1 pilot critical-path identification)
**Date:** 2026-05-16
**Severity:** HIGH for Telecheck-Ghana pilot launch — Med Interaction Engine is the only SKELETON slice among pilot-required slices per the 2026-05-15 Implementation State Audit. Without it, the platform-floor "interaction engine runs BEFORE clinician commits prescription" rule (Master PRD v1.10 §7) cannot be enforced; pilot launch is BLOCKED.
**Status:** Open — awaiting spec-corpus ratifier (Evans + Engineering Lead + CDM v1.2 owner) to expand the CDM with InteractionSignal / InteractionOverride / InteractionRuleset row shapes
**Target spec docs:** `Telecheck_Canonical_Data_Model_v1_2.md` (CDM expansion), `Telecheck_Medication_Interaction_Engine_Slice_PRD_v1_0.md` (slice PRD — ratified, no changes needed), `Telecheck_Contracts_Pack_v5_00_INVARIANTS.md` (interaction-engine platform-floor invariant)
**Target slice:** Medication Interaction Engine Slice PRD v1.0 §4 (five check classes), §5 (signal model), §6 (when engine runs), §9 (knowledge base)
**Parallel SIs:** independent — does not depend on other open SIs. Unblocks Track 1 implementation by giving Engineering canonical row shapes to bind against.

---

## What this is

The Medication Interaction Engine Slice PRD v1.0 IS ratified in the bundle. The implementation module (`src/modules/med-interaction/`) is a directory skeleton with only `/health` (200) + `/ready` (503) mounted. The README documents the actual blocker:

> Per EHBG §7, engineering does not author canonical schema; the slice PRD owns it. The CDM v1.2 entity inventory does not yet expand Med Interaction signal/override/ruleset row shapes — authoring schemas now would silently fork the spec corpus (per the "do NOT silently fork" hard rule in CLAUDE.md).

This SI scopes the CDM expansion need as a formal deliverable so the spec-corpus ratifier can include it in the next ratification ceremony alongside the 7 other pending SIs.

## Why this is the new Track 1 critical path

Per the 2026-05-15 Implementation State Audit:

> **Pilot-blocking work (in order):**
> 1. Med-Interaction core checks (per Slice PRD v1.0 §4 five check classes: drug-drug, drug-condition, drug-lab, pharmacogenomic, special-clinical-flag). Note: drug-allergy is NOT a separate class in §4 — allergies are represented via drug-condition (allergy is a condition) and/or special-clinical-flag mechanisms.
> 2. Async-Consult completion (clinician decision loop, SI-005 procedure)
> 3. AI Service Mode 1 conversational scaffolding ✅ (PR #160 closed 2026-05-16)
> 4. Crisis Response slice (resource lookup + escalation; detection wired)
> 5. Admin Backend basics

Med-Interaction is item #1. The slice PRD is ratified; the CDM is the only remaining spec-corpus gap. Engineering work cannot legitimately begin until canonical row shapes exist in CDM v1.2.

## CDM expansion shape proposed (FOR REVIEW — not authoritative)

The Slice PRD v1.0 §5 (signal model) describes the conceptual entities. A possible CDM v1.3+ expansion shape (subject to ratifier sign-off):

### InteractionSignal entity

Per slice PRD §5.1:

| Field | Type | Notes |
|---|---|---|
| `interaction_signal_id` | PK | `intsig_<ULID>` |
| `tenant_id` | FK → tenants | I-027 required |
| `patient_id` | FK → patients | nullable when signal is for a medication request in-flight before patient binding |
| `medication_request_id` | FK → medication_requests | per glossary rule + canonical entity from migration 025; the request the signal was raised against |
| `check_class` | ENUM | `drug_drug` \| `drug_condition` \| `drug_lab` \| `pharmacogenomic` \| `special_clinical_flag` (the exact five classes enumerated in Slice PRD §4; drug-allergy is NOT a separate class — allergies surface via drug_condition or special_clinical_flag) |
| `severity` | ENUM | `info` \| `caution` \| `warning` \| `severe` \| `contraindicated` (per §5.2) |
| `recommended_action` | ENUM | per §5.3 |
| `signal_payload` | JSONB | structured signal-class-specific detail |
| `source_engine` | TEXT | adapter id (e.g., `vendor:firstdatabank`, `vendor:lexicomp`) |
| `source_version` | TEXT | knowledge-base version at evaluation time (audit traceability) |
| `evaluated_at` | TIMESTAMPTZ | when the engine evaluated this signal |
| `expires_at` | TIMESTAMPTZ | knowledge-base-version-relative expiry; force re-evaluation after this |
| `created_at` / `updated_at` | TIMESTAMPTZ | standard audit |

### InteractionOverride entity

Per slice PRD §5.3 + clinician decision surface (§7.1):

| Field | Type | Notes |
|---|---|---|
| `interaction_override_id` | PK | `intovr_<ULID>` |
| `tenant_id` | FK → tenants |
| `interaction_signal_id` | FK → interaction_signals | the signal being overridden |
| `clinician_id` | FK → accounts | the clinician authorizing the override |
| `rationale` | TEXT | required free-text rationale (clinical justification) |
| `override_class` | ENUM | `informed_override` \| `risk_accepted` \| `monitoring_plan_added` (per §5.3) |
| `monitoring_plan_id` | FK → monitoring_plans | nullable; required for `monitoring_plan_added` class |
| `expires_at` | TIMESTAMPTZ | override is valid for a bounded window (typically prescription cycle) |
| `created_at` | TIMESTAMPTZ | standard audit |

### InteractionRuleset entity

Per slice PRD §9 (knowledge base) — represents the active rule-set version a tenant binds to:

| Field | Type | Notes |
|---|---|---|
| `interaction_ruleset_id` | PK | `intrs_<ULID>` |
| `tenant_id` | FK → tenants |
| `country_of_care` | TEXT | CCR-driven; rulesets vary by jurisdiction (Ghana vs US formulary differences) |
| `vendor` | ENUM | `vendor:firstdatabank` \| `vendor:lexicomp` \| `vendor:medscape` (extensible) |
| `vendor_version` | TEXT | version pin for reproducibility + audit |
| `effective_from` / `effective_until` | TIMESTAMPTZ | versioned activation window |
| `status` | ENUM | `draft` \| `active` \| `retired` |
| `created_at` / `updated_at` | TIMESTAMPTZ | standard audit |

## What this SI does NOT propose

- Specific severity thresholds for each check class (slice PRD §5.2 specifies)
- Vendor adapter implementation details (separate engineering deliverable post-CDM-ratification)
- Pharmacogenomic ruleset shape (slice PRD §4.4 — may need its own SI if CDM expansion is non-trivial)
- Audit event canonicalization (`interaction_signal_emitted`, `interaction_override_authorized`, etc.) — separate AUDIT_EVENTS v5.4+ amendment

## Resolution path

When SI-012 closes:

1. CDM v1.3 (or v1.2 patch) lands with the three entity row shapes ratified above.
2. Engineering authors:
   - Migration `032_med_interaction_signals.sql` (or successor number)
   - Migration `033_med_interaction_overrides.sql`
   - Migration `034_med_interaction_rulesets.sql`
   - Repository layer (`signal-repo.ts`, `override-repo.ts`, `ruleset-repo.ts`)
   - Service layer (signal evaluator; override workflow)
   - Handler layer (POST `/v0/med-interaction/signals/check` per slice PRD §6.1, etc.)
   - Vendor adapter abstraction (initial scope: stub adapter returning empty signals; real Lexicomp / First Databank adapters land when contracts + secrets management resolved)
   - Integration with Pharmacy slice's prescription-commit path (the "engine runs BEFORE clinician commits" rule per Master PRD v1.10 §7)
3. README in `src/modules/med-interaction/` is updated: blocker resolved.
4. routes.ts: `/ready` flips to 200; real handler surface mounted.

## Cross-cutting impact

This SI is the gating spec deliverable for Telecheck-Ghana pilot launch. Without CDM ratification:
- The platform-floor "interaction engine runs BEFORE clinician commits prescription" rule (Master PRD v1.10 §7) cannot be enforced
- Pharmacy slice's prescription-commit path has no interaction-check integration
- AI Clinical Assistant Slice §7.3 (signal consumption by Mode 1 / Mode 2) has nothing to consume

Pilot launch (5 substantive workstreams per the 2026-05-15 audit) is BLOCKED by this SI's resolution.

## Status

- **Filed:** 2026-05-16 (autonomous run; Track 1 critical-path identification)
- **Target Promotion Ledger entry:** P-022 (alongside the other 7 pending SIs in the next ratification cycle)
- **Blocks:** Track 1 anchor (Pharmacy + Async-Consult + Med-Interaction) production-readiness
- **Blocks:** Telecheck-Ghana pilot launch
- **Depends on:** spec-corpus ratifier availability for CDM expansion ceremony

— Claude (Opus 4.7, 1M context), 2026-05-16 autonomous run
