# SI-011 — Forms-Intake publish-time governance gates

**Raised by:** Engineering (autonomous run 2026-05-15; existing TODO-deferred gates in `templateService.publishVersion`)
**Date:** 2026-05-15
**Severity:** HIGH at production deploy time — the four publish-time governance gates that protect against unsafe forms being promoted from draft → published are currently TODO-deferred behind a `FORMS_PUBLISH_GATES_BYPASS='unsafe-test-only'` sentinel. The sentinel is hostile-named so production env-config typo cannot accidentally open the gate, but currently setting it = bypass ALL safety floors; not setting it = no template can be legitimately published. Neither posture is acceptable beyond v1.0 pilot.
**Status:** Open — awaiting spec-corpus + v1.10 governance-work scoping
**Target spec docs:** `Telecheck_Forms_Intake_Engine_Slice_PRD_v2_1.md`, `Telecheck_Contracts_Pack_v5_00_FORMS_ENGINE.md`, `Telecheck_Contracts_Pack_v5_00_INVARIANTS.md` (I-013, I-015, I-030)
**Target slice:** Forms/Intake Engine Slice PRD v2.1 §25.3 (six-category I-030 static analysis), §25.1 (MarketingCopy L4 governance), §10 (Mode 2 input contract), I-015 (L3 dual-control)
**Parallel SIs:** depends on SI-010 (`current_actor_role()` helpers for L3 dual-control), SI-008 (Mode 2 contract ratification)

---

## What this is

`templateService.publishVersion()` in `src/modules/forms-intake/internal/services/template-service.ts` documents FOUR pre-publish governance gates that MUST run before a draft template can be promoted to `published` status:

1. **I-015 L3 dual-control:** Tenant Clinical Lead approval recorded for any L3 (eligibility) edits — the clinician who authored an eligibility-logic change MUST NOT be the same operator who authorizes publish.
2. **I-030 six-category static analysis:** reject publish if ANY of {branching, visibility, validation, eligibility/triage, pricing/commerce, outcome messaging} depends on the `research_consent_status` PHI field per FORMS_ENGINE v5.2 + Slice PRD §25.3.
3. **L4 MarketingCopy approval:** all molecule-level L1 elements referenced in `presentation_content` MUST resolve to `MarketingCopy` rows in `status='approved'`.
4. **Mode 2 input contract conformance:** any Mode 2 case-prep workflow integration MUST conform to the contract validator per Slice PRD §10.

At HEAD, the publish path FAILS CLOSED in production via the `FORMS_PUBLISH_GATES_BYPASS='unsafe-test-only'` sentinel. The bypass is intentionally hostile-named so a routine env-config typo cannot accidentally open the gate. But the gates aren't wired:

- Production cannot legitimately publish without setting the bypass
- Setting the bypass = ALL FOUR gates skipped

This SI scopes the four gates as real deliverables so the sentinel can be retired.

## Why this is critical

Publishing an unsafe form template directly impacts patient safety:

- **Gate 1 (L3 dual-control)** prevents a single bad-actor or compromised operator from authoring AND approving a malicious eligibility-logic change (e.g., relaxing GLP-1 prescribing criteria to bypass clinical safety floors). This is the I-015 invariant and is platform-floor.
- **Gate 2 (I-030 static analysis)** prevents form templates from inadvertently coupling research-consent status into clinical decision-making. Form templates that conditionally hide / show / validate based on `research_consent_status` would violate the I-030 separation contract.
- **Gate 3 (MarketingCopy approval)** prevents inadvertent shipping of marketing/regulatory copy that hasn't passed L4 medical-affairs review (FDA / EMA / regulatory body approval workflow per market).
- **Gate 4 (Mode 2 contract)** prevents shipping Mode 2 AI workflow integrations with malformed input contracts that would cause silent AI-recommendation failures.

Until SI-011 closes, every production deployment is gated by the `FORMS_PUBLISH_GATES_BYPASS` env flag. Beyond pilot, this is unacceptable.

## Scoping decision

The four gates are NOT a single SI — each is its own substantial body of work. This umbrella SI files each as a sub-deliverable (SI-011a/b/c/d) so they can be scoped independently.

## SI-011a (L3 dual-control gate)

**Prerequisite:** SI-010 (`current_actor_role()` + `current_actor_account_id()` + `current_actor_account_tenant_id()` helpers)

**Implementation outline:**

1. Add `forms_template_l3_edit_log` table tracking every UPDATE to `eligibility_logic` JSONB. Trigger-driven change-data-capture; entry per UPDATE: `(template_id, tenant_id, editor_account_id, edited_at, prior_value_hash, new_value_hash)`.
2. Publish path queries `forms_template_l3_edit_log` for any entry on this template whose `editor_account_id` equals the publishing actor's `current_actor_account_id()`.
3. If such an entry exists → reject with `forms.publish.l3_dual_control_violation` Category B audit + sentinel error.
4. Validate the publishing actor's role is in the dual-control authorized set: `clinician` with the `tenant_clinical_lead` tag (TBD where this tag lives — `accounts.tags JSONB` per a future RBAC v1.1 extension, OR a separate `tenant_clinical_lead_assignments` table per tenant).

**Open questions:** the "Tenant Clinical Lead" role assignment mechanism. RBAC v1.1 lists the role; we need a permission row or account-attribute that lets the publish path query it.

## SI-011b (I-030 six-category static analysis)

**Prerequisite:** none (pure analysis over JSON content); needs FORMS_ENGINE §I-030 detection-rules canonicalization in spec corpus.

**Implementation outline:**

1. Author `tools/forms-engine-i030-analyzer/` — a deterministic AST walker over `presentation_content` + `branching_logic` + `eligibility_logic` + `approval_governance` JSON.
2. Define canonical detection rules for each of the six categories:
   - **Branching:** any branching predicate referencing `patient.research_consent_status` or its dotted-path equivalents
   - **Visibility:** field-level `visible_if` referencing research consent
   - **Validation:** validation predicate referencing research consent
   - **Eligibility/triage:** eligibility_logic predicate
   - **Pricing/commerce:** approval_governance > pricing_overrides referencing research consent
   - **Outcome messaging:** dynamic copy templates substituting research-consent values
3. Publish path runs the analyzer; ANY hit → `forms.publish.i030_violation` Category B audit + sentinel error with specific category + path.
4. False-positive carve-outs require an explicit `i030_exemption_id` field on the template + paired `forms_i030_exemption` row signed off by `tenant_clinical_lead`. Documented case; rare.

**Open questions:** the exact JSONPath syntax for the "references research_consent_status" detector. Needs FORMS_ENGINE §I-030 to canonicalize.

## SI-011c (L4 MarketingCopy approval gate)

**Prerequisite:** CDM v1.2 §4 expansion to canonicalize the MarketingCopy entity (named in §3 but row shape isn't ratified — another schema gap, sibling to SI-001/005/008/009).

**Implementation outline:**

1. CDM §4 row shape for MarketingCopy must include `status ∈ {draft, in_review, approved, retired}`.
2. Publish path walks `presentation_content` extracting every L1 molecule-level reference (e.g., `{ type: 'marketing_copy_ref', id: 'mkt_abc123' }`).
3. For each reference: query `marketing_copy WHERE id = $ref AND tenant_id = ctx.tenantId AND status = 'approved'`. Missing/non-approved → reject with `forms.publish.marketing_copy_not_approved` + sentinel error.

**Open questions:** the L1 reference syntax in `presentation_content` — currently underspecified. Should be defined alongside MarketingCopy ratification.

## SI-011d (Mode 2 input contract conformance)

**Prerequisite:** SI-008 (AiWorkflowExecution schema gap closure — defines the canonical Mode 2 input shape)

**Implementation outline:**

1. Mode 2 input contract is the schema of inputs the workflow expects. Each form template declaring Mode 2 integration MUST include a `mode_2_contract` field in `approval_governance` containing the input schema + handler procedure name.
2. Publish path validates `mode_2_contract.input_schema` is a well-formed JSON Schema AND references only fields the form actually collects (cross-walk between `presentation_content` field IDs and the schema's required-property names).
3. Mismatch → reject with `forms.publish.mode_2_contract_invalid` + sentinel error.

**Open questions:** Mode 2 contract spec ratification (SI-008 dependency).

## Resolution path

When SI-011 closes:

1. Each sub-SI (SI-011a/b/c/d) is filed as its own deliverable + scoped sprint-by-sprint.
2. As each gate lands, its `if (gateBypass !== 'unsafe-test-only')` early-throw branch in `publishVersion()` is REPLACED with the actual gate logic.
3. When ALL four gates land, the `FORMS_PUBLISH_GATES_BYPASS` env flag is REMOVED entirely (along with the test helpers that set it).
4. Tests that previously set the bypass are rewritten to either (a) construct fixtures that pass all four gates, OR (b) use per-gate granular test-only overrides `process.env['FORMS_PUBLISH_GATES_TEST_OVERRIDE_<GATE_NAME>']` (only valid in `NODE_ENV=test`).

## Cross-cutting impact

This is the single largest pending body of v1.0-launch governance work that depends on spec-corpus ratification rather than implementation. Each sub-SI is ~1-2 sprints; the full set is multi-quarter work coordinating spec authors + clinical leads + product + engineering.

The current placeholder (FORMS_PUBLISH_GATES_BYPASS sentinel) is acceptable for the v1.0 launch posture (zero published templates day-1; pilot tenants will work with Telecheck team to manually validate each template promotion via out-of-band review). Beyond pilot, this SI must close before self-service template authoring is enabled for tenant admins.

## Status

- **Filed:** 2026-05-15 (autonomous run; reflective survey of TODO-deferred work)
- **Target Promotion Ledger entries:** P-021 (umbrella) + P-022 through P-025 (per sub-SI)
- **Blocks:** self-service template authoring; v1.x tenant-admin publish workflow
- **Depends on:** SI-010 (SI-011a actor context); CDM §4 MarketingCopy ratification (SI-011c); SI-008 Mode 2 contract (SI-011d); FORMS_ENGINE §I-030 detection-rules canonicalization (SI-011b)
