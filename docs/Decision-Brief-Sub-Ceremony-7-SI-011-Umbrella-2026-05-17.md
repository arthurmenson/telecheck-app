# Sub-Ceremony 7 Decision Brief — SI-011 Forms-Intake publish-time governance gates (UMBRELLA)

**Date:** 2026-05-17 → 2026-05-18 boundary
**Ratifier:** Evans (Telecheck workstream lead)
**Reviewer (adversarial):** Codex (per-PR adversarial review)
**Target Promotion Ledger entry (umbrella):** P-024
**Source spec doc:** `telecheck-app/docs/SI-011-Forms-Publish-Governance-Gates.md` v0.1 (filed 2026-05-15)
**Cluster:** Standalone umbrella SI (4 sub-SIs: a/b/c/d) — no batch sequencing constraint

---

## Why this needs ratification

SI-011 scopes the **four pre-publish governance gates** that currently sit behind the `FORMS_PUBLISH_GATES_BYPASS='unsafe-test-only'` sentinel in `templateService.publishVersion()`. Without these gates wired, every production deployment is gated by an env flag — acceptable for v1.0 pilot (zero published templates day-1) but unacceptable beyond pilot. Each gate protects platform-floor invariants:

| Gate | Protects | Invariant |
|---|---|---|
| SI-011a L3 dual-control | Eligibility-logic changes from single-actor compromise | **I-015** |
| SI-011b I-030 six-category static analysis | Research-consent leakage into clinical decision-making | **I-030** |
| SI-011c L4 MarketingCopy approval | Unreviewed regulatory copy shipping to patients | L4 medical-affairs floor |
| SI-011d Mode 2 input contract | Malformed AI workflow integrations causing silent failures | Mode 2 contract per Slice PRD §10 |

**Concurrent implementation context:** PR #155 ("SI-011 publish-gates bypass kill-switch layers 1+2") merged on main during the SC6 cycle — partial implementation of SI-011's **production environment guard** (the §"Production environment guard (kill-switch)" section of the source spec). The kill-switch wires runtime fail-closed layers; the four gates themselves remain TODO-deferred pending this SC7 ratification + per-sub-SI implementation cycles.

---

## Nine ratifier sub-decisions

### Sub-decision 1 — Umbrella ledger shape: ONE P-NUM (P-024 umbrella) covering all 4 sub-SIs

**Recommendation:** ✅ Single umbrella P-024 ratifying the **overall scoping decision + sub-SI breakdown + kill-switch acceptance + cross-cutting design constraints**. Per-sub-SI canonical content (CDM expansions, contract amendments, AUDIT_EVENTS additions) lands in **separate future SIs (SI-011.1a/b/c/d)** as each sub-SI's design converges through its own Codex pre-ratification gate.

**Rationale:** The 4 sub-SIs have meaningfully different prerequisites (SI-011a depends on SI-010 already ratified; SI-011c depends on MarketingCopy CDM ratification not yet filed; SI-011d depends on `ai_workflow_handler_registry` table location TBD). Filing them at separate ledger entries lets each iterate at its own pace + lets cross-references stabilize before locking down canonical row shapes.

**Alternative considered:** P-024 umbrella + P-025/026/027/028 per-sub-SI in a single SC7 commit. Rejected because (a) two sub-SIs depend on prerequisites not yet ratified (MarketingCopy entity; AI handler registry); (b) Codex pre-ratification rounds on each sub-SI's row shapes haven't run; (c) bundling 5 P-NUMs at once creates a cascade-arithmetic mess akin to the R6 SI-012 propagation issue SC6 closed.

### Sub-decision 2 — SI-011a (L3 dual-control gate) substantive design ratification

**Recommendation:** ✅ ACCEPT the 7-step implementation outline:

1. `forms_template_l3_edit_log` PERMANENT append-only table (I-003 audit_records discipline parity) with baseline-insert provenance + supersession model
2. `forms_template_l3_approval` 1:1-bound approval artifact with exact path-set + fingerprint-map binding
3. Publish-path predicate: one matching approval per ACTIVE edit-log entry + publish-time revalidation defense-in-depth
4. State-validating gate: every live `eligibility_logic` leaf must trace to an active approved edit (supersession-coverage CHECK)
5. Publishing actor's role validated as `tenant_clinical_lead`
6. Batch-approval model DEFERRED to v1.x (out of scope for v1.0)
7. Import/migration/fixture pathways MUST emit synthetic `edit_type='baseline_insert'` row

**Substantive design ratified:** append-only enforcement; supersession-as-NEW-append; pre-existing approval invalidation on supersession; already-published-template safety (point-in-time validity); narrow-binding (no batch/superset matching at v1.0).

**Sub-decision 2 open question DEFERRED to Sub-decision 7:** Tenant Clinical Lead role-assignment mechanism (tags JSONB vs separate table) — see Sub-decision 7.

### Sub-decision 3 — SI-011b (I-030 six-category static analysis) substantive design ratification

**Recommendation:** ✅ ACCEPT the 4-step implementation outline:

1. `tools/forms-engine-i030-analyzer/` deterministic AST walker
2. Six-category canonical detection rules (branching/visibility/validation/eligibility-triage/pricing-commerce/outcome-messaging)
3. Publish-path exact-set-match predicate: `for_every fᵢ ∈ findings: exists eⱼ ∈ exemptions where fingerprint matches` + stale-exemption rejection
4. One-to-many narrow exemption binding via `forms_template_i030_exemption_binding` with SHA-256-fingerprint binding + revision-scoped + 90-day default expiry + separation-of-duty + snapshot-role-at-approval

**Substantive design ratified:** narrow non-reusable exemptions; no cross-tenant exemption import; no perpetual exemptions; no broad path-prefix carve-outs; stale-exemption rejection on fingerprint drift.

### Sub-decision 4 — SI-011c (L4 MarketingCopy approval gate) substantive design ratification — WITH DEPENDENCY CAVEAT

**Recommendation:** ✅ ACCEPT the 4-step implementation outline contingent on **MarketingCopy entity CDM §4 ratification** filing as a **separate successor SI (SI-015 or equivalent placeholder)**:

1. MarketingCopy CDM §4 row shape: `(id, tenant_id, status, approved_at, approved_by_account_id, approver_role_at_approval, content_fingerprint)`
2. Publish path extracts L1 molecule-level `marketing_copy_ref` references
3. Per-reference validation: row exists + tenant_id matches + status='approved' + fingerprint matches; cross-tenant categorically forbidden
4. Immutable provenance on published template row + runtime fingerprint re-validation

**Substantive design ratified:** fingerprint-bound approval (post-approval edit invalidates `approved` via trigger); cross-tenant reference categorically forbidden; runtime drift detection.

**Dependency caveat (R1-class architectural risk):** SI-011c **cannot ratify canonical row shapes** at SC7 because MarketingCopy entity is named in CDM v1.2 §3 but not expanded in §4 (schema gap sibling to SI-001/005/008/009). SI-011c's substantive **design pattern** is ratified at P-024; SI-011c's **canonical row shape** must wait for the MarketingCopy CDM ratification SI (target: SI-015 or equivalent placeholder, to be filed under a future SC).

### Sub-decision 5 — SI-011d (Mode 2 input contract conformance) substantive design ratification — WITH DEPENDENCY CAVEAT

**Recommendation:** ✅ ACCEPT the 4-step implementation outline contingent on **`ai_workflow_handler_registry` table location ratification** (likely owned by AI Workflow Engine slice; cross-walk to AI_LAYERING / WORKLOAD_TAXONOMY contracts):

1. `mode_2_contract` field on `approval_governance`: `(handler_id, handler_version, handler_signature_hash, input_schema)`
2. Publish-path 5-step validation (schema well-formed + form-field cross-walk + handler resolves + signature compatibility + schema-handler compatibility)
3. Immutable provenance + runtime fingerprint re-validation; `ai_workflow.contract_drift_detected` audit on mismatch
4. Handler-registry lifecycle: `active → deprecated → retired`; bound-to-retired templates fail runtime + require re-publish

**Substantive design ratified:** binding-time signature-hash capture; runtime drift detection; deprecation-lifecycle enforcement.

**Dependency caveat:** SI-011d's **canonical row shape** for `ai_workflow_handler_registry` requires a separate SI (target: SI-016 or equivalent placeholder, to be filed under a future SC). SI-011d's **integration pattern** (signature-hash binding + 5-step publish validation) is ratified at P-024.

### Sub-decision 6 — Production environment guard (kill-switch) substantive design ratification (PR #155 already merged layers 1+2)

**Recommendation:** ✅ ACCEPT the 4-layer defense-in-depth model:

1. **App startup guard** (PR #155 layer 1): Fastify boot hook fails-fast on `FORMS_PUBLISH_GATES_*` env vars when `NODE_ENV !== 'test'` (regardless of value)
2. **`publishVersion()` defense-in-depth** (PR #155 layer 2): function re-checks env at gate-run-time + emits `forms.publish.bypass_attempt_in_production` Category B audit
3. **CI gate**: `npm run lint` + `npm test` static check that bypass-kill-switch boot-hook test is wired + any reference to `FORMS_PUBLISH_GATES_BYPASS` outside allowed files fails CI (TODO — to land in subsequent PR)
4. **Deploy validation**: production-deploy runbook adds post-deploy smoke check for env-var absence; non-clean = auto-rollback (TODO — to land in deploy runbook)

**Substantive design ratified:** four-layer defense + prefix-match glob (not allow-list) for fail-closed semantics; CI gate + deploy runbook layers TBD as separate work items.

**Note on PR #155:** layers 1+2 already shipped to main during the SC6 Codex cycle. This sub-decision ratifies the **design pattern** (4-layer defense + glob prefix) for the spec corpus; the implementation work for layers 3+4 lands separately as standard autonomous-track work, not gated on this SC7 ratification.

### Sub-decision 7 — Tenant Clinical Lead role-assignment mechanism

**Recommendation:** ✅ ACCEPT **separate `tenant_clinical_lead_assignments` table** (not `accounts.tags JSONB`).

**Rationale:** A separate table provides:
- Explicit FK + audit-event surface (`identity.tenant_clinical_lead.{assigned, revoked}`)
- Per-tenant + per-account uniqueness invariant via DB constraint
- Cleaner RLS policy expression
- No JSONB schema-evolution risk

**Alternative considered:** `accounts.tags JSONB` — rejected because JSONB tags lack DB-enforced uniqueness, encode role as soft data, and require app-layer enforcement of "exactly N tenant_clinical_leads per tenant" rules.

**Open question deferred to SI-011a's per-sub-SI Codex pre-ratification round:** the exact table shape + assignment workflow (Platform Admin assigns? Tenant Admin assigns? Both? RBAC matrix updates).

### Sub-decision 8 — I-030 exemption default expiry policy

**Recommendation:** ✅ ACCEPT **90-day default expiry** (no perpetual exemptions; tightened defaults rather than overly-permissive).

**Implementation:** `expires_at` column on `forms_i030_exemption` with `CHECK (expires_at - approved_at <= INTERVAL '90 days')` enforced at INSERT. Exemptions older than 90 days from approval fail publish-time validation; tenant must request fresh exemption.

**Alternative considered:** Per-category expiry (e.g., 30 days for branching/visibility, 90 days for messaging). Rejected as premature optimization; single 90-day default is simpler + can be tightened per-category in a future SI-011b.X if needed.

### Sub-decision 9 — Dependent-SI filing path post-SC7

**Recommendation:** ✅ ACCEPT the following dependency-SI filing schedule:

| Dependency | Target SI | Target SC | Notes |
|---|---|---|---|
| MarketingCopy entity CDM §4 expansion | SI-015 | Future SC (post-SC7) | Blocks SI-011c canonical content |
| `ai_workflow_handler_registry` table | SI-016 | Future SC (post-SC7) | Blocks SI-011d canonical content |
| Tenant Clinical Lead assignment table | Folded into SI-011a Codex pre-ratification | N/A | Per Sub-decision 7 |
| FORMS_ENGINE §I-030 detection-rules canonicalization | Folded into SI-011b Codex pre-ratification | N/A | Source spec already names the 6 categories |

**Rationale:** SI-015 + SI-016 surface concrete pending-ratification work that the cascade-prediction model must track. Both will go through Codex pre-ratification before their own SCs.

---

## What lands at PR-A1⁗″ (this sub-ceremony's ratification-intent commit)

**Promotion Ledger:**
- **NEW P-024** — SI-011 Umbrella ratification-intent (4 sub-SIs scoped; substantive design + implementation outline ratified for each; per-sub-SI canonical content deferred to future SI-011.1a/b/c/d at separate SCs; kill-switch 4-layer defense pattern ratified; Tenant Clinical Lead = separate table; I-030 exemption = 90-day default expiry; SI-015 + SI-016 dependencies filed)
- **Top-of-Ledger interpretation rule extended** from 6 sub-ceremonies / 9 entries to 7 sub-ceremonies / 10 entries with sub-ceremony 7 framing: **SC7 is umbrella-scope only — no entity additions in this commit, no AUDIT_EVENTS additions, no contract amendments**; per-sub-SI canonical content lands in successor SCs as each sub-SI's Codex pre-ratification gate completes. SC7 is therefore the **first SC to be exempt from BOTH CDM and AUDIT_EVENTS bumps** (SC4/SC5/SC6 were CDM-exempt but contributed AUDIT_EVENTS bumps; SC7 contributes neither). Total maximum CDM bumps across all 7 SCs unchanged at 3; total maximum AUDIT_EVENTS bumps unchanged at 6.

**Registry:** v2.11 (UNCHANGED per lockstep invariant) — Last-updated header bumped to 2026-05-17/18 with explicit P-024 mention; §3 row 64 extended to 10-entry framing with SC7 umbrella-scope note + AUDIT_EVENTS-exempt clarification; §8 changelog new top row dated 2026-05-17/18 SC7 with all 9 sub-decisions enumerated.

### Interpretation-rule extension at P-024

- **6 SCs / 9 entries → 7 SCs / 10 entries**
- **7th-landing destinations:** Registry v2.17 → v2.18 (umbrella only — no contract files bumped)
- **AUDIT_EVENTS max-bumps cap:** unchanged at 6 (SC7 contributes 0 AUDIT_EVENTS bumps — umbrella scoping commit, no audit events added at this commit; each sub-SI's later SC will contribute its own AUDIT_EVENTS bumps)
- **CDM max-bumps total across all 7 SCs:** unchanged at 3 (SC4/SC5/SC6/SC7 all exempt)
- **DOMAIN_EVENTS no-version-bump pattern preserved across all 7 SCs**
- **SC7 is FIRST SC exempt from all 3 (CDM + AUDIT_EVENTS + DOMAIN_EVENTS) bumps** — registry-only bump for umbrella-scope ratification

### P-NUM cascade post-SC7

| SI | P-NUM | Status |
|---|:---:|---|
| ...(prior entries unchanged)... | | |
| **SI-011 umbrella (SC7)** | **P-024** | 🕐 **this brief's target** |
| SI-013 (SC8) | P-025 | 🕐 upcoming |
| SI-014 (SC9) | P-026 | 🕐 upcoming (parked until ADR-030) |
| **SI-015 MarketingCopy CDM §4 expansion** (NEW dependency) | TBD (future SC) | 🕐 new in queue per Sub-decision 9 |
| **SI-016 `ai_workflow_handler_registry`** (NEW dependency) | TBD (future SC) | 🕐 new in queue per Sub-decision 9 |
| **SI-011.1a / .1b / .1c / .1d** (per-sub-SI canonical content) | TBD (future SCs) | 🕐 successors after Codex pre-ratification gates |

---

## Ratification

To accept all 9 sub-decisions as recommended: reply **"ratify"** (Evans already given as forward authorization per SC6 close-out exchange).

To modify: name sub-decision # + alternative (e.g., *"ratify but 1: file P-024 + P-025/026/027/028 in single SC7 commit"*).

To defer: name sub-decision # + unresolved question.

---

— Claude (Opus 4.7, 1M context), 2026-05-17 → 2026-05-18 Sub-Ceremony 7 Decision Brief delivery (umbrella structure; substantively different ratification surface than SC1-SC6 because no canonical row shapes land at P-024; 4 sub-SIs scoped for future per-sub-SI SCs; 2 new dependency SIs (SI-015 + SI-016) added to queue)
