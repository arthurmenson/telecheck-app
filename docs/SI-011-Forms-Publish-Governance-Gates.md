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

1. Add `forms_template_l3_edit_log` table tracking every UPDATE to `eligibility_logic` JSONB. Trigger-driven change-data-capture; entry per UPDATE: `(template_id, tenant_id, draft_revision_id, editor_account_id, edited_at, prior_value_hash, new_value_hash, changed_path_set JSONB, value_fingerprint_map JSONB)`. **`changed_path_set` is the canonical sorted JSONPath array of every leaf that differs between prior_value and new_value; `value_fingerprint_map` is the per-path SHA-256 fingerprint of the new value at each leaf.** Hashes prove tamper-evidence; path-set + fingerprints prove *what* changed and form the artifact a second approver actually reviews.
2. Add `forms_template_l3_approval` table — explicit dual-control approval artifact per edit: `(template_id, tenant_id, draft_revision_id, approved_path_set JSONB, approved_value_fingerprint_map JSONB, editor_account_id, approver_account_id, approver_role_at_approval, approved_at)`. **`approver_account_id != editor_account_id` enforced at row-insert CHECK.** Approval is bound to the exact `(draft_revision_id, path-set, fingerprint-map)` the approver reviewed — not the template generally.
3. Publish path:
   - For each `forms_template_l3_edit_log` entry on this template's current draft revision, require a matching `forms_template_l3_approval` row where `approved_path_set ⊇ changed_path_set` AND `approved_value_fingerprint_map` agrees on every shared path AND `approver_account_id != editor_account_id` AND `approver_role_at_approval ∈ {tenant_clinical_lead}`.
   - If publishing actor is also an editor on this draft → reject (separation of duty floor; second condition layered on top of the path-bound approval requirement).
   - Any missing/stale/mismatched approval → reject with `forms.publish.l3_dual_control_violation` Category B audit including specific failed precondition.
4. Validate the publishing actor's role is in the dual-control authorized set: `clinician` with the `tenant_clinical_lead` tag (TBD where this tag lives — `accounts.tags JSONB` per a future RBAC v1.1 extension, OR a separate `tenant_clinical_lead_assignments` table per tenant).
5. Multi-editor case: when a draft revision has independent L3 edits by different actors, each edit's path-set requires its own approval row. The publish path validates the union of all approvals covers the union of all changed paths. This prevents a single broad approval from rubber-stamping unrelated edits.

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
4. False-positive carve-outs require an explicit `i030_exemption_id` field on the template + paired `forms_i030_exemption` row. **Exemptions are narrow, non-reusable approval artifacts** scoped to a single analyzer finding:
   - **Row shape:** `(id, tenant_id, template_id, draft_revision_id, category, jsonpath, finding_fingerprint, rationale, requester_account_id, approver_account_id, approver_role_at_approval, requested_at, approved_at, expires_at)`.
   - **Binding rules enforced at publish path:**
     - `tenant_id` matches the publishing template's tenant (no cross-tenant exemption import).
     - `template_id` matches; `draft_revision_id` matches the draft being published (no carry-over to subsequent revisions — each revision must be re-exempted explicitly).
     - `category + jsonpath + finding_fingerprint` exactly match the analyzer-emitted finding (no broad path-prefix carve-outs).
     - `finding_fingerprint` is SHA-256 of `(category, jsonpath, normalized_offending_subtree_canonical_json)` — changing the offending subtree invalidates the exemption.
     - `expires_at > now()` — no perpetual exemptions; default expiry policy TBD with Platform Privacy + Clinical Governance (recommend ≤ 90 days).
     - `approver_account_id != requester_account_id` (separation of duty CHECK).
     - `approver_role_at_approval ∈ {tenant_clinical_lead, platform_clinical_governance}` (snapshot role at approval time; role re-assignment doesn't retroactively validate).
   - **Audit emission:** exemption issuance emits `forms.i030.exemption_granted` Category B audit; publish-time consumption emits `forms.publish.i030_exemption_consumed`; expired/invalid exemption attempt at publish emits `forms.publish.i030_exemption_rejected` with specific failed precondition.
   - **Rationale:** narrow exemptions prevent the abuse path where a single valid `i030_exemption_id` suppresses unrelated findings, cross-tenant exemption import, or stale-revision rubber-stamping. Each finding requires its own paired exemption row.

**Open questions:** the exact JSONPath syntax for the "references research_consent_status" detector. Needs FORMS_ENGINE §I-030 to canonicalize. Also: who approves cross-cutting platform-wide exemption patterns (e.g., research-pure cohort study forms) — likely Platform Clinical Governance via a separate `forms_i030_pattern_exemption` mechanism with stronger oversight; out of scope for this SI's narrow-binding default.

## SI-011c (L4 MarketingCopy approval gate)

**Prerequisite:** CDM v1.2 §4 expansion to canonicalize the MarketingCopy entity (named in §3 but row shape isn't ratified — another schema gap, sibling to SI-001/005/008/009).

**Implementation outline:**

1. CDM §4 row shape for MarketingCopy must include `(id, tenant_id, status ∈ {draft, in_review, approved, retired}, approved_at, approved_by_account_id, approver_role_at_approval, content_fingerprint)`. `content_fingerprint` is SHA-256 of the canonical-JSON-serialized copy body; approval is bound to the fingerprint such that any post-approval edit invalidates `status='approved'` via trigger.
2. Publish path walks `presentation_content` extracting every L1 molecule-level reference (e.g., `{ type: 'marketing_copy_ref', id: 'mkt_abc123' }`).
3. For each reference: query `marketing_copy WHERE id = $ref AND tenant_id = ctx.tenantId AND status = 'approved'`. **`tenant_id = ctx.tenantId` is mandatory** — cross-tenant MarketingCopy references are categorically forbidden (a tenant cannot publish referencing another tenant's approved copy, even if both tenants approve). Missing/non-approved/cross-tenant → reject with `forms.publish.marketing_copy_not_approved` Category B audit + sentinel error specifying the failing reference `id` and reason (`missing`, `not_approved`, `cross_tenant`, `fingerprint_drift`).
4. Persist the `content_fingerprint` of each referenced MarketingCopy on the published template row as immutable provenance. Runtime rendering verifies fingerprint still matches at render time; mismatch → render rejects + `forms.runtime.marketing_copy_drift_detected` audit.

**Open questions:** the L1 reference syntax in `presentation_content` — currently underspecified. Should be defined alongside MarketingCopy ratification.

## SI-011d (Mode 2 input contract conformance)

**Prerequisite:** SI-008 (AiWorkflowExecution schema gap closure — defines the canonical Mode 2 input shape)

**Implementation outline:**

1. Mode 2 input contract is the schema of inputs the workflow expects. Each form template declaring Mode 2 integration MUST include a `mode_2_contract` field in `approval_governance` containing:
   - `handler_id` — canonical ID of a registered Mode 2 workflow handler in the `ai_workflow_handler_registry` table.
   - `handler_version` — semver of the handler at the time of binding.
   - `handler_signature_hash` — SHA-256 of the handler's runtime input-validator schema at `handler_version` (computed at handler-registration time; immutable per version).
   - `input_schema` — the JSON Schema the form will pass to the handler.
2. Publish path validates ALL of the following; ANY failure → reject with `forms.publish.mode_2_contract_invalid` Category B audit + sentinel error specifying which validation step failed:
   - **(a) Schema well-formed:** `input_schema` is a syntactically valid JSON Schema (draft-2020-12).
   - **(b) Form-field cross-walk:** every `required` property in `input_schema` corresponds to a field actually collected in `presentation_content`; field type compatibility verified.
   - **(c) Handler resolves:** `handler_id @ handler_version` exists in `ai_workflow_handler_registry` and is `status='active'` (not deprecated, not pending-retirement).
   - **(d) Handler signature compatibility:** computed SHA-256 of registry's current runtime input-validator schema for `handler_id @ handler_version` matches the template's `handler_signature_hash` — proves the template's view of the handler hasn't drifted since template-author bound it.
   - **(e) Schema-handler compatibility:** `input_schema` is a structural subset of the handler's registered runtime input-validator schema (every required field declared in handler's validator is present in template's `input_schema` with compatible type; no extra required fields that the handler doesn't accept).
3. On successful publish, persist `(handler_id, handler_version, handler_signature_hash)` to the published template row as immutable provenance. Runtime Mode 2 dispatch verifies the published template's signature hash still matches the handler-at-dispatch-time signature; mismatch → runtime reject + `ai_workflow.contract_drift_detected` audit (separate I-012 reject-unless violation handling).
4. Handler-registry evolution: when a handler is upgraded to a new `handler_version`, the old version remains queryable for templates that bound to it; the registry enforces a deprecation lifecycle (`active → deprecated → retired`). Published templates bound to retired handlers fail runtime dispatch and require a re-publish through SI-011d gate.

**Open questions:**
- Mode 2 contract spec ratification (SI-008 dependency).
- `ai_workflow_handler_registry` table location — likely owned by AI Workflow Engine slice; cross-walk to AI_LAYERING / WORKLOAD_TAXONOMY contracts.
- Backward compat: when a handler ships a v2 that is a strict superset of v1's input schema, can a template auto-migrate? Default: NO (must re-publish through the gate to re-bind `handler_signature_hash`).

## Production environment guard (kill-switch)

**Non-negotiable runtime fail-closed:** in any environment where `NODE_ENV !== 'test'`:

1. **App startup guard:** Fastify boot hook reads `process.env` and **fails fast** (process exits with non-zero, no listener bound) if ANY of the following env vars are present (regardless of value):
   - `FORMS_PUBLISH_GATES_BYPASS`
   - `FORMS_PUBLISH_GATES_TEST_OVERRIDE_L3_DUAL_CONTROL`
   - `FORMS_PUBLISH_GATES_TEST_OVERRIDE_I030_ANALYSIS`
   - `FORMS_PUBLISH_GATES_TEST_OVERRIDE_MARKETING_COPY`
   - `FORMS_PUBLISH_GATES_TEST_OVERRIDE_MODE_2_CONTRACT`
   - (Plus any future `FORMS_PUBLISH_GATES_TEST_OVERRIDE_*` glob match — fail closed on the prefix, not an allow-list.)
2. **`publishVersion()` defense-in-depth:** the function itself re-checks `NODE_ENV` + the env-var glob before running any gate; on `NODE_ENV !== 'test'` with any of those env vars present, emit `forms.publish.bypass_attempt_in_production` Category B audit and throw before doing any work. Catches the case where startup-guard is somehow bypassed (e.g., env var injected post-boot via a sidecar, dynamic config reload).
3. **CI gate:** `npm run lint` + `npm test` includes a static check that the bypass kill-switch boot-hook test is wired and that any reference to `FORMS_PUBLISH_GATES_BYPASS` outside of `templateService` + the kill-switch + the test-helper file fails CI.
4. **Deploy validation:** the production-deploy runbook adds a post-deploy smoke check that hits a diagnostic endpoint confirming no bypass env vars are set. If the smoke check returns non-clean, the deploy auto-rolls-back.

This is a defense-in-depth model: kill-switch at boot + defense-in-depth in the publish path + static analysis in CI + deploy validation. Env-config drift becomes detectable at four independent layers rather than relying on naming + `NODE_ENV` intent alone.

## Resolution path

When SI-011 closes:

1. Each sub-SI (SI-011a/b/c/d) is filed as its own deliverable + scoped sprint-by-sprint.
2. As each gate lands, its `if (gateBypass !== 'unsafe-test-only')` early-throw branch in `publishVersion()` is REPLACED with the actual gate logic.
3. When ALL four gates land, the `FORMS_PUBLISH_GATES_BYPASS` env flag is REMOVED entirely (along with the test helpers that set it). The four `FORMS_PUBLISH_GATES_TEST_OVERRIDE_*` vars remain (test-only) for fixture-construction convenience but the production guard above still rejects them in `NODE_ENV !== 'test'`.
4. Tests that previously set the bypass are rewritten to either (a) construct fixtures that pass all four gates, OR (b) use per-gate granular test-only overrides `process.env['FORMS_PUBLISH_GATES_TEST_OVERRIDE_<GATE_NAME>']` (only valid in `NODE_ENV=test`; production guard fails closed if observed in any other env).
5. Self-service template authoring for tenant admins remains BLOCKED until ALL FOUR sub-SIs close AND the kill-switch guard is in place AND the all-gates bypass is removed.

## Cross-cutting impact

This is the single largest pending body of v1.0-launch governance work that depends on spec-corpus ratification rather than implementation. Each sub-SI is ~1-2 sprints; the full set is multi-quarter work coordinating spec authors + clinical leads + product + engineering.

The current placeholder (FORMS_PUBLISH_GATES_BYPASS sentinel) is acceptable for the v1.0 launch posture (zero published templates day-1; pilot tenants will work with Telecheck team to manually validate each template promotion via out-of-band review). Beyond pilot, this SI must close before self-service template authoring is enabled for tenant admins.

## Status

- **Filed:** 2026-05-15 (autonomous run; reflective survey of TODO-deferred work)
- **Target Promotion Ledger entries:** P-021 (umbrella) + P-022 through P-025 (per sub-SI)
- **Blocks:** self-service template authoring; v1.x tenant-admin publish workflow
- **Depends on:** SI-010 (SI-011a actor context); CDM §4 MarketingCopy ratification (SI-011c); SI-008 Mode 2 contract (SI-011d); FORMS_ENGINE §I-030 detection-rules canonicalization (SI-011b)
