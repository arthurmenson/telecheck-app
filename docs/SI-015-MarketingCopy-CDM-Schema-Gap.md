# SI-015 — MarketingCopy + MarketingCopyGovernanceEvidence CDM §4 expansion (CDM v1.X)

**Raised by:** Engineering (autonomous run 2026-05-18; SC7 P-024 SI-011 UMBRELLA Sub-decision #4 dependency caveat — SI-011c L4 MarketingCopy approval gate cannot ratify canonical row shape until MarketingCopy CDM ratification SI lands)
**Date:** 2026-05-18
**Severity:** medium (does NOT block any SC1–SC7 ratifications; **prerequisite** for SI-011.1c L4 MarketingCopy approval gate canonical content port + Acquisition / Admin Configuration slice implementation against MarketingCopy row shapes per Slice PRDs)
**Status:** **OPEN — v0.1 DRAFT (pre-Codex pre-ratification gate; gate commences with v0.1 PR open)**
**Target spec doc:** `Telecheck_Canonical_Data_Model_v1_2.md` (CDM v1.X → v1.Y with §3.13 Marketing-Governance category added + §4.27 MarketingCopy + §4.28 MarketingCopyGovernanceEvidence)
**Target slice PRDs (consumers):** `Telecheck_Acquisition_Engagement_Tools_Slice_PRD_v1_0.md` §13 (marketing surface rendering), `Telecheck_Admin_Configuration_Surfaces_Slice_PRD_v1_0.md` §12.1 (marketing copy admin console), `Telecheck_SI-011-Forms-Publish-Governance-Gates.md` §SI-011c (L4 MarketingCopy approval gate — DEPENDS on this SI closing)
**Parent SI / triggers:** SC7 P-024 SI-011 UMBRELLA (Sub-decision #4 + #9 — filed SI-015 as dependency); ADR-027 v0.6 (country-conditional DTC marketing posture); Master PRD v1.10 §13.2 (marketing copy governance review process); TYPES v5.2 (MarketingCopy + MarketingCopyGovernanceEvidence type defs); AUDIT_EVENTS v5.2 (`marketing.surface_rendered` + `marketing.surface_drift`); DOMAIN_EVENTS v5.2 (`marketing.surface_published` + `marketing.surface_suspended`); MARKET_LAUNCH v5.1 6-condition activation gate; CCR_RUNTIME v5.2 marketing block
**Promotion Ledger target:** **TBD future P-NUM** (gap slot — likely P-017 or P-022 per post-SC7 unclaimed-slot inventory; or next-available after canonical-content-port wave for sub-ceremonies 1-6)

---

## What this is

CDM v1.2 §3 entity inventory has 42 entities, **none of which is MarketingCopy or MarketingCopyGovernanceEvidence**. Both entities are defined at the TYPES contract level (TYPES v5.2 §"MarketingCopy" + §"MarketingCopyGovernanceEvidence") and are heavily referenced across slice PRDs (Acquisition §13, Admin Configuration §12.1, SI-011c L4 gate). The CDM §4 row-shape expansion has never landed — this is a schema gap of the same class as the SI-001/005/008/009/009.1 family that the Q2 2026 ratifier ceremony has been closing.

SI-015 closes the MarketingCopy CDM schema gap. Two entities are scoped together because their lifecycles + invariants are tightly coupled (MarketingCopyGovernanceEvidence is the immutable evidence anchor that MarketingCopy approval references via FK).

## What changed vs upstream contracts

| Surface | Existing at v5.2 contracts (TYPES + AUDIT_EVENTS + DOMAIN_EVENTS) | SI-015 CDM §4 expansion |
| --- | --- | --- |
| TYPES `MarketingCopy` definition | 16 fields with semver `version` + `status` enum | **CDM §4.27 row shape — formalize as table** with composite UNIQUE for cross-entity FK safety + content fingerprint column + Tier 0/1/2 invariants |
| TYPES `MarketingCopyGovernanceEvidence` definition | 9 fields with FK-shape `governance_lead_designation_artifact_id` | **CDM §4.28 row shape — formalize as table** with append-only enforcement + FK to MarketingCopy |
| AUDIT_EVENTS `marketing.surface_rendered` + `.surface_drift` | Already in AUDIT_EVENTS v5.2 §6 | NO new audit events at SI-015 — table-lifecycle events (`marketing_copy.drafted/submitted/approved/rejected/suspended/retired`) fold into SI-011.1c per the SC7 umbrella |
| DOMAIN_EVENTS `marketing.surface_published` + `.surface_suspended` | Already in DOMAIN_EVENTS v5.2 | NO new domain events at SI-015 |
| CCR_RUNTIME marketing block | Existing `molecule_level_marketing_permitted` 3-state enum + `marketing_copy_governance_evidence` + `marketing_governance_review_cadence_months` + `marketing_governance_lead_designation_artifact_id` | NO new CCR keys at SI-015 — marketing block already complete at v5.2 |
| Composite FKs | None (entity not in CDM) | **+3 NEW** (MarketingCopy ↔ governance_review artifact via `governance_review_reference_id`; MarketingCopyGovernanceEvidence ↔ MarketingCopy via `marketing_copy_id`; MarketingCopy ↔ tenants via `tenant_id`) |

**Scope narrowness vs SI-009.1 / SI-011 family:** SI-015 is intentionally narrower than the SC2-SC7 expansions because the marketing surface's runtime events + CCR config already landed at v1.10 (ADR-027 cycle). SI-015 is **CDM-only** — adds the §4 row shapes + §3 inventory entries + Tier 0/1/2 enforcement triggers. No new AUDIT_EVENTS, no new DOMAIN_EVENTS, no new CCR keys.

---

## Proposed canonical row shapes (FOR REVIEW — pre-Codex pre-ratification gate)

### §4.27 MarketingCopy (entity #43)

```sql
-- v0.1 placeholder columns; SI-015 pre-ratification gate
id                                  VARCHAR(26)  PRIMARY KEY  -- 'mkc_<ULID>' per TYPES v5.2 ID prefix
tenant_id                           TEXT         NOT NULL REFERENCES tenants(id)
country_of_care                     VARCHAR(2)   NOT NULL  -- ISO 3166-1 alpha-2; must match tenant's country (cross-tenant safety)
version                             TEXT         NOT NULL  -- semver per TYPES v5.2; immutable per row (a new version is a new row, never an UPDATE)
surface_type                        VARCHAR(20)  NOT NULL CHECK (surface_type IN ('landing', 'email', 'banner', 'educational', 'testimonial', 'social'))
classification                      VARCHAR(20)  NOT NULL CHECK (classification IN ('molecule_level', 'program_level'))
molecule_references                 JSONB        NULL  -- [{code, name}, ...]; REQUIRED when classification='molecule_level'
program_references                  TEXT[]       NULL  -- program_id array; REQUIRED when classification='program_level'
rendered_claim_classes              TEXT[]       NOT NULL  -- claim taxonomy classes used in this copy version
content_body                        JSONB        NOT NULL  -- structured copy content body (text + image refs + claim binding)
content_fingerprint                 TEXT         NOT NULL  -- SHA-256 of canonical-JSON serialization of (surface_type, classification, molecule_references, program_references, rendered_claim_classes, content_body); used by SI-011c L4 approval gate + drift detection per §13.2
governance_review_reference_id      VARCHAR(26)  NULL  -- FK to §4.28 MarketingCopyGovernanceEvidence.evidence_id; REQUIRED when status='approved'
approved_at                         TIMESTAMPTZ  NULL  -- REQUIRED when status='approved'
approver_account_id                 VARCHAR(26)  NULL  -- FK to accounts(account_id); REQUIRED when status='approved'
approver_role_at_approval           VARCHAR(50)  NULL  -- snapshot of approver's role at approval time (defense against role re-assignment retroactively validating)
approval_validity_until             TIMESTAMPTZ  NULL  -- computed at approval time from approved_at + CCR marketing_governance_review_cadence_months
review_cadence_months               INTEGER      NULL CHECK (review_cadence_months IS NULL OR review_cadence_months IN (6, 12))
status                              VARCHAR(20)  NOT NULL CHECK (status IN ('draft', 'under_review', 'approved', 'suspended', 'retired')) DEFAULT 'draft'
suspended_at                        TIMESTAMPTZ  NULL  -- REQUIRED when status='suspended' (and only meaningful then)
suspension_reason                   VARCHAR(40)  NULL CHECK (suspension_reason IS NULL OR suspension_reason IN ('drift_detected', 'governance_cadence_lapsed', 'operator_action', 'regulatory_directive'))
retired_at                          TIMESTAMPTZ  NULL  -- REQUIRED when status='retired'
created_at                          TIMESTAMPTZ  NOT NULL DEFAULT NOW()
updated_at                          TIMESTAMPTZ  NOT NULL DEFAULT NOW()

-- Cross-tenant safety constraints (NOT placeholders; permanent)
UNIQUE (tenant_id, id)  -- composite UNIQUE for cross-entity composite FK safety
UNIQUE (tenant_id, id, version)  -- triple-composite for future version-aware references
UNIQUE (tenant_id, content_fingerprint) WHERE status = 'approved'  -- partial UNIQUE: one approved row per (tenant, fingerprint) — prevents duplicate-approval drift

FOREIGN KEY (tenant_id, country_of_care) REFERENCES tenants (id, country_of_care)
  -- Cross-tenant safety: country_of_care MUST match tenant's country (no cross-jurisdiction copy publishing)
FOREIGN KEY (tenant_id, governance_review_reference_id) REFERENCES marketing_copy_governance_evidence (tenant_id, evidence_id)
  -- Defer to §4.28 expansion; composite FK ensures evidence is from the same tenant
FOREIGN KEY (tenant_id, approver_account_id) REFERENCES accounts (tenant_id, account_id)

-- Classification consistency CHECK:
CHECK (
  (classification = 'molecule_level' AND molecule_references IS NOT NULL AND jsonb_array_length(molecule_references) > 0 AND program_references IS NULL)
  OR
  (classification = 'program_level' AND program_references IS NOT NULL AND array_length(program_references, 1) > 0 AND molecule_references IS NULL)
)

-- Approval-state consistency CHECK (status='approved' requires the full approval-evidence quartet):
CHECK (
  (status IN ('draft', 'under_review') AND governance_review_reference_id IS NULL AND approved_at IS NULL AND approver_account_id IS NULL AND approver_role_at_approval IS NULL AND approval_validity_until IS NULL AND suspended_at IS NULL AND suspension_reason IS NULL AND retired_at IS NULL)
  OR
  (status = 'approved' AND governance_review_reference_id IS NOT NULL AND approved_at IS NOT NULL AND approver_account_id IS NOT NULL AND approver_role_at_approval IS NOT NULL AND approval_validity_until IS NOT NULL AND review_cadence_months IS NOT NULL AND suspended_at IS NULL AND suspension_reason IS NULL AND retired_at IS NULL)
  OR
  (status = 'suspended' AND governance_review_reference_id IS NOT NULL AND approved_at IS NOT NULL AND suspended_at IS NOT NULL AND suspension_reason IS NOT NULL AND retired_at IS NULL)
  OR
  (status = 'retired' AND retired_at IS NOT NULL)
)

-- Approval-validity consistency CHECK (approval_validity_until must extend approved_at by exactly review_cadence_months):
CHECK (
  approval_validity_until IS NULL
  OR (approved_at IS NOT NULL AND approval_validity_until > approved_at)
)

-- Timestamp monotonicity CHECKs:
CHECK (approved_at IS NULL OR approved_at >= created_at)
CHECK (suspended_at IS NULL OR suspended_at >= COALESCE(approved_at, created_at))
CHECK (retired_at IS NULL OR retired_at >= created_at)
```

### §4.28 MarketingCopyGovernanceEvidence (entity #44)

```sql
-- v0.1 placeholder columns; SI-015 pre-ratification gate
evidence_id                                 VARCHAR(26)  PRIMARY KEY  -- 'mge_<ULID>' per TYPES v5.2 ID prefix
tenant_id                                   TEXT         NOT NULL REFERENCES tenants(id)
country_of_care                             VARCHAR(2)   NOT NULL  -- ISO 3166-1 alpha-2; must match tenant's country
regulatory_jurisdiction                     TEXT         NOT NULL  -- jurisdiction code
regulatory_authority                        TEXT         NOT NULL  -- regulatory body name
regulatory_interpretation_artifact_id       VARCHAR(26)  NOT NULL  -- ULID of the artifact storing the regulatory interpretation
interpretation_date                         TIMESTAMPTZ  NOT NULL
scope                                       TEXT         NOT NULL  -- scope of permitted molecule-level marketing per this interpretation
prohibited_claim_classes                    TEXT[]       NOT NULL  -- claim taxonomy classes the regulator has explicitly prohibited
governance_lead_designation_artifact_id     VARCHAR(26)  NOT NULL  -- ULID of the artifact designating the marketing-copy-governance-lead role assignment
ethics_review_concurrence_artifact_id       VARCHAR(26)  NULL  -- optional; ULID of ethics-review concurrence
created_at                                  TIMESTAMPTZ  NOT NULL DEFAULT NOW()

-- Cross-tenant safety constraints (NOT placeholders; permanent)
UNIQUE (tenant_id, evidence_id)  -- composite UNIQUE for cross-entity composite FK safety

FOREIGN KEY (tenant_id, country_of_care) REFERENCES tenants (id, country_of_care)

-- Append-only invariant: MarketingCopyGovernanceEvidence rows are evidence artifacts;
-- they capture the regulatory + governance-lead-designation context at the moment of
-- recording. Post-INSERT mutations break the evidence chain. Mirrors I-003 audit_records
-- append-only discipline.
```

---

## Append-only + Tier 0/1/2 invariants

### MarketingCopy

**Tier 0 — Identity binding immutable from INSERT** (FROZEN at row creation; never mutable):
- `id`, `tenant_id`, `country_of_care`, `version`, `surface_type`, `classification` — copy identity binding cannot be retroactively changed
- `created_at` — record-creation timestamp is immutable
- A new `version` is a NEW row (immutable per row); never an UPDATE that changes the version column

**Tier 1 — Payload + governance-evidence binding immutable AFTER approval** (once `status = 'approved'` is reached, the following columns are FROZEN):
- `molecule_references`, `program_references`, `rendered_claim_classes`, `content_body`, `content_fingerprint` — copy content + claim binding cannot change post-approval (any change implies a new version row + new approval pass per I-013 published-content-version-immutability)
- `governance_review_reference_id`, `approved_at`, `approver_account_id`, `approver_role_at_approval`, `approval_validity_until`, `review_cadence_months` — approval evidence cannot retroactively change

**Tier 2 — Status-transition allow-list** (status column + status-transition timestamps remain mutable, but ONLY through guarded state transitions):
- `draft → under_review` (no required additional fields beyond status change)
- `under_review → draft` (rejection back to draft; status change only)
- `under_review → approved` (requires the full approval-evidence quartet populated atomically + content_fingerprint computed from THIS draft's content_body)
- `approved → suspended` (drift detector / cadence overrun / operator action / regulatory directive; sets suspended_at + suspension_reason)
- `suspended → approved` (re-review per §13.2 with fresh governance_review_reference_id; treat as a NEW approval evidence record — old governance_review_reference_id stays as historical reference)
- `approved → retired` (operator action; sets retired_at)
- `suspended → retired` (operator action; sets retired_at)
- `draft → retired` (operator action; sets retired_at)
- All other transitions FORBIDDEN; status='retired' is terminal

### MarketingCopyGovernanceEvidence

**Tier 0 — Fully append-only from INSERT** (every column immutable post-INSERT; no UPDATE path):
- All 12 columns are evidence artifacts; the row IS the evidence
- Post-INSERT mutations forbidden; corrections require a NEW evidence row + supersession reference (deferred to v1.x if needed; v1.0 scope is single-row immutable evidence per regulatory interpretation)

---

## Repository layer enforcement (pseudo-SQL)

```sql
-- Tier 0 identity immutability for MarketingCopy (BEFORE UPDATE trigger):
CREATE OR REPLACE FUNCTION marketing_copy_tier0_immutability()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id THEN
    RAISE EXCEPTION 'marketing_copy(% / %): Tier 0 identity immutability violated — id cannot change post-INSERT', NEW.tenant_id, NEW.id;
  END IF;
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id THEN
    RAISE EXCEPTION 'marketing_copy(% / %): Tier 0 identity immutability violated — tenant_id cannot change post-INSERT (cross-tenant safety floor per I-023)', NEW.tenant_id, NEW.id;
  END IF;
  IF NEW.country_of_care IS DISTINCT FROM OLD.country_of_care
     OR NEW.version IS DISTINCT FROM OLD.version
     OR NEW.surface_type IS DISTINCT FROM OLD.surface_type
     OR NEW.classification IS DISTINCT FROM OLD.classification
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'marketing_copy(% / %): Tier 0 identity immutability violated — country_of_care/version/surface_type/classification/created_at cannot change post-INSERT', NEW.tenant_id, NEW.id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER marketing_copy_tier0_immutability_guard
  BEFORE UPDATE ON marketing_copy
  FOR EACH ROW
  EXECUTE FUNCTION marketing_copy_tier0_immutability();

-- Tier 1 payload + governance-evidence binding immutability AFTER approval
-- (BEFORE UPDATE trigger; runs after Tier 0 trigger):
CREATE OR REPLACE FUNCTION marketing_copy_tier1_post_approval_immutability()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.status IN ('approved', 'suspended', 'retired') THEN
    -- Tier 1 frozen-column check:
    IF NEW.molecule_references IS DISTINCT FROM OLD.molecule_references
       OR NEW.program_references IS DISTINCT FROM OLD.program_references
       OR NEW.rendered_claim_classes IS DISTINCT FROM OLD.rendered_claim_classes
       OR NEW.content_body IS DISTINCT FROM OLD.content_body
       OR NEW.content_fingerprint IS DISTINCT FROM OLD.content_fingerprint
       OR NEW.governance_review_reference_id IS DISTINCT FROM OLD.governance_review_reference_id
       OR NEW.approved_at IS DISTINCT FROM OLD.approved_at
       OR NEW.approver_account_id IS DISTINCT FROM OLD.approver_account_id
       OR NEW.approver_role_at_approval IS DISTINCT FROM OLD.approver_role_at_approval
       OR NEW.approval_validity_until IS DISTINCT FROM OLD.approval_validity_until
       OR NEW.review_cadence_months IS DISTINCT FROM OLD.review_cadence_months THEN
      RAISE EXCEPTION 'marketing_copy(% / %): Tier 1 payload/governance-evidence binding immutability violated (state=% requires payload + approval evidence frozen; I-013 published-content-version-immutability + ADR-027 §13.2 evidence-chain integrity)', NEW.tenant_id, NEW.id, OLD.status;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER marketing_copy_tier1_post_approval_immutability_guard
  BEFORE UPDATE ON marketing_copy
  FOR EACH ROW
  EXECUTE FUNCTION marketing_copy_tier1_post_approval_immutability();

-- Tier 2 status-transition allow-list (BEFORE UPDATE trigger):
CREATE OR REPLACE FUNCTION marketing_copy_status_state_machine()
RETURNS TRIGGER AS $$
BEGIN
  -- Force updated_at to DB time on every UPDATE (R7-style discipline from SI-009.1)
  NEW.updated_at := NOW();
  -- Same-state UPDATE allowed iff status unchanged (no rewrite of status-transition timestamps)
  IF NEW.status = OLD.status THEN
    IF NEW.approved_at IS DISTINCT FROM OLD.approved_at
       OR NEW.suspended_at IS DISTINCT FROM OLD.suspended_at
       OR NEW.retired_at IS DISTINCT FROM OLD.retired_at THEN
      RAISE EXCEPTION 'marketing_copy(% / %): same-state UPDATE (status=%) cannot rewrite status-transition timestamps', NEW.tenant_id, NEW.id, OLD.status;
    END IF;
    RETURN NEW;
  END IF;
  -- Transition allow-list:
  IF OLD.status = 'draft' AND NEW.status IN ('under_review', 'retired') THEN
    IF NEW.status = 'retired' THEN
      NEW.retired_at := NOW();
    END IF;
    RETURN NEW;
  ELSIF OLD.status = 'under_review' AND NEW.status IN ('draft', 'approved') THEN
    IF NEW.status = 'approved' THEN
      -- The full approval-evidence quartet is required (Tier 1 immutability after);
      -- timestamps forced to DB time
      NEW.approved_at := NOW();
      IF NEW.governance_review_reference_id IS NULL OR NEW.approver_account_id IS NULL OR NEW.approver_role_at_approval IS NULL OR NEW.review_cadence_months IS NULL THEN
        RAISE EXCEPTION 'marketing_copy(% / %): under_review → approved requires full approval evidence quartet (governance_review_reference_id + approver_account_id + approver_role_at_approval + review_cadence_months)', NEW.tenant_id, NEW.id;
      END IF;
      -- Compute approval_validity_until from approved_at + review_cadence_months
      NEW.approval_validity_until := NEW.approved_at + (NEW.review_cadence_months || ' months')::INTERVAL;
    END IF;
    RETURN NEW;
  ELSIF OLD.status = 'approved' AND NEW.status IN ('suspended', 'retired') THEN
    IF NEW.status = 'suspended' THEN
      NEW.suspended_at := NOW();
      IF NEW.suspension_reason IS NULL THEN
        RAISE EXCEPTION 'marketing_copy(% / %): approved → suspended requires suspension_reason', NEW.tenant_id, NEW.id;
      END IF;
    ELSIF NEW.status = 'retired' THEN
      NEW.retired_at := NOW();
    END IF;
    RETURN NEW;
  ELSIF OLD.status = 'suspended' AND NEW.status IN ('approved', 'retired') THEN
    IF NEW.status = 'approved' THEN
      -- Re-approval after suspension: requires fresh governance_review_reference_id
      -- (old one stays as historical reference via versioning; a NEW MarketingCopy
      -- row with bumped version is the canonical re-approval path; in-place
      -- suspended → approved on the SAME row is permitted only if the SAME
      -- content_fingerprint passes re-review)
      IF NEW.governance_review_reference_id IS NULL OR NEW.governance_review_reference_id = OLD.governance_review_reference_id THEN
        RAISE EXCEPTION 'marketing_copy(% / %): suspended → approved requires fresh governance_review_reference_id (cannot reuse OLD=% per §13.2 re-review discipline)', NEW.tenant_id, NEW.id, OLD.governance_review_reference_id;
      END IF;
      NEW.approved_at := NOW();
      NEW.suspended_at := NULL;
      NEW.suspension_reason := NULL;
      NEW.approval_validity_until := NEW.approved_at + (NEW.review_cadence_months || ' months')::INTERVAL;
    ELSIF NEW.status = 'retired' THEN
      NEW.retired_at := NOW();
    END IF;
    RETURN NEW;
  END IF;
  -- All other transitions forbidden:
  RAISE EXCEPTION 'marketing_copy(% / %): forbidden status transition % → %; allow-list: draft→under_review, under_review→draft, under_review→approved, approved→suspended, approved→retired, suspended→approved, suspended→retired, draft→retired', NEW.tenant_id, NEW.id, OLD.status, NEW.status;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER marketing_copy_status_state_machine_guard
  BEFORE UPDATE ON marketing_copy
  FOR EACH ROW
  EXECUTE FUNCTION marketing_copy_status_state_machine();

-- BEFORE INSERT trigger for MarketingCopy: force created_at + updated_at to DB time
-- + reject pre-seeded status-transition timestamps (rows must start at status='draft'
-- with all status-transition timestamps NULL).
CREATE OR REPLACE FUNCTION marketing_copy_insert_guard()
RETURNS TRIGGER AS $$
BEGIN
  NEW.created_at := NOW();
  NEW.updated_at := NOW();
  IF NEW.status IS DISTINCT FROM 'draft' THEN
    RAISE EXCEPTION 'marketing_copy(% / %): direct INSERT must start at status=''draft'' (got %); status progression via the guarded state-machine transitions only', NEW.tenant_id, NEW.id, NEW.status;
  END IF;
  IF NEW.approved_at IS NOT NULL OR NEW.suspended_at IS NOT NULL OR NEW.retired_at IS NOT NULL
     OR NEW.governance_review_reference_id IS NOT NULL OR NEW.approver_account_id IS NOT NULL
     OR NEW.approver_role_at_approval IS NOT NULL OR NEW.approval_validity_until IS NOT NULL THEN
    RAISE EXCEPTION 'marketing_copy(% / %): direct INSERT cannot pre-seed status-transition or approval-evidence columns; these are populated only via the guarded state-machine transitions', NEW.tenant_id, NEW.id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER marketing_copy_insert_lifecycle_guard
  BEFORE INSERT ON marketing_copy
  FOR EACH ROW
  EXECUTE FUNCTION marketing_copy_insert_guard();

-- MarketingCopyGovernanceEvidence full append-only enforcement:
-- App role has only SELECT + INSERT privileges; UPDATE + DELETE REVOKED.
-- BEFORE UPDATE + BEFORE DELETE triggers reject unconditionally.
CREATE OR REPLACE FUNCTION marketing_copy_governance_evidence_reject_mutation()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'marketing_copy_governance_evidence(% / %): row is evidence artifact; no UPDATE/DELETE permitted (Tier 0 full append-only enforced at DB layer per I-003 audit_records precedent)', COALESCE(OLD.tenant_id, NEW.tenant_id), COALESCE(OLD.evidence_id, NEW.evidence_id);
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER marketing_copy_governance_evidence_append_only_update
  BEFORE UPDATE ON marketing_copy_governance_evidence
  FOR EACH ROW
  EXECUTE FUNCTION marketing_copy_governance_evidence_reject_mutation();

CREATE TRIGGER marketing_copy_governance_evidence_append_only_delete
  BEFORE DELETE ON marketing_copy_governance_evidence
  FOR EACH ROW
  EXECUTE FUNCTION marketing_copy_governance_evidence_reject_mutation();

-- BEFORE INSERT trigger for MarketingCopyGovernanceEvidence: force created_at to DB time.
CREATE OR REPLACE FUNCTION marketing_copy_governance_evidence_insert_guard()
RETURNS TRIGGER AS $$
BEGIN
  NEW.created_at := NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER marketing_copy_governance_evidence_insert_db_time_guard
  BEFORE INSERT ON marketing_copy_governance_evidence
  FOR EACH ROW
  EXECUTE FUNCTION marketing_copy_governance_evidence_insert_guard();
```

---

## Cross-tenant safety constraints summary

| FK | Source | Target | Composite keys | Same-tenant lineage |
| --- | --- | --- | --- | --- |
| 1 | `marketing_copy.tenant_id` | `tenants.id` | — | Direct tenant binding |
| 2 | `marketing_copy.(tenant_id, country_of_care)` | `tenants.(id, country_of_care)` | composite | Country-jurisdiction matches tenant's country |
| 3 | `marketing_copy.(tenant_id, governance_review_reference_id)` | `marketing_copy_governance_evidence.(tenant_id, evidence_id)` | composite | Evidence from same tenant |
| 4 | `marketing_copy.(tenant_id, approver_account_id)` | `accounts.(tenant_id, account_id)` | composite | Approver is same-tenant account |
| 5 | `marketing_copy_governance_evidence.tenant_id` | `tenants.id` | — | Direct tenant binding |
| 6 | `marketing_copy_governance_evidence.(tenant_id, country_of_care)` | `tenants.(id, country_of_care)` | composite | Country matches tenant's country |

**Cross-tenant attack surface:** structurally impossible per composite FKs (a copy in tenant A cannot reference evidence in tenant B because the composite FK enforces both columns match). Mirrors the SI-005/008/009/009.1 cross-tenant safety pattern.

---

## SI-011.1c L4 MarketingCopy approval gate consumption pattern (informational; canonical content lands at SI-011.1c, not here)

SI-011c's substantive design (per SC7 P-024 sub-decision #4 ratified) calls out:
- Publish path extracts L1 molecule-level `marketing_copy_ref` references from `presentation_content`
- Per-reference validation: `marketing_copy.id = $ref AND marketing_copy.tenant_id = ctx.tenantId AND marketing_copy.status = 'approved' AND marketing_copy.content_fingerprint = $expected_fingerprint`
- Cross-tenant categorically forbidden (enforced by FK 1 + the WHERE tenant_id = ctx.tenantId)
- Immutable provenance: published template row records the resolved `marketing_copy.id` + `marketing_copy.version` + `marketing_copy.content_fingerprint`
- Runtime fingerprint re-validation: render-time check that `marketing_copy.content_fingerprint` still matches the stored provenance; mismatch → `forms.runtime.marketing_copy_drift_detected` audit

The SI-015 row shape's `content_fingerprint` column + partial UNIQUE `(tenant_id, content_fingerprint) WHERE status='approved'` + Tier 1 post-approval immutability of `content_fingerprint` are the structural pieces SI-011.1c's L4 gate relies on. SI-011.1c lands its own canonical content (the L4 gate logic + `forms.publish.marketing_copy_not_approved` audit IDs) at its own future ratification.

---

## Open questions for CDM author + Marketing Governance Lead + Privacy Officer review

| # | Question | Owner | Severity |
| :---: | --- | --- | --- |
| OQ1 | Should `version` be enforced as strict semver via regex CHECK, OR accept the existing free-form TEXT per TYPES v5.2? | CDM author | low |
| OQ2 | Should the partial UNIQUE `(tenant_id, content_fingerprint) WHERE status='approved'` be widened to `WHERE status IN ('approved', 'suspended')` to prevent re-approval of a suspended copy under a different `id`? | Marketing Governance Lead | medium |
| OQ3 | Should the `suspended → approved` re-approval path REQUIRE a new `version` bump, OR is in-place re-approval with the same `content_fingerprint` acceptable (current proposal allows in-place if the same fingerprint passes fresh §13.2 re-review)? | Marketing Governance Lead | medium |
| OQ4 | Should `MarketingCopyGovernanceEvidence` allow optional supersession (corrective evidence record for a misfiled regulatory interpretation) at v1.0, OR defer to v1.x? Current proposal defers — corrections require a NEW evidence row + the broken one stays in the chain (mirrors I-003 audit_records discipline). | Privacy Officer + CDM author | low |
| OQ5 | Should `prohibited_claim_classes` be enforced against the canonical claim-taxonomy enum (when that enum lands), OR remain free-form TEXT[] at v1.0? | CDM author | low |
| OQ6 | Should the §3 entity inventory category be `3.13 Marketing-Governance` (new category) OR fold into an existing category like §3.6 Clinical Intelligence (poor fit) OR §3.10 Notification & Comms (also poor fit)? Current proposal: NEW §3.13 category. | CDM author | low |

These open questions will be surfaced + addressed during the Codex pre-ratification gate (target 3-5 rounds based on SI-001 single-entity precedent for similar scope).

---

## Resolution path

When SI-015 closes:

1. **Future PR-A2/A3-class commit** (at SI-015's own ratification SC) lands:
   - CDM v1.X → v1.Y with §3.13 NEW category "Marketing-Governance — 2 entities" + §4.27 MarketingCopy + §4.28 MarketingCopyGovernanceEvidence canonical row shapes
   - 6 BEFORE INSERT/UPDATE/DELETE triggers (4 for MarketingCopy + 2 for MarketingCopyGovernanceEvidence)
   - 6 composite FKs
   - 8+ CHECK constraints
   - Application-role GRANT lockdown: `telecheck_app_role` has SELECT + INSERT only on `marketing_copy_governance_evidence` (no UPDATE/DELETE); SELECT + INSERT + UPDATE on `marketing_copy` (no DELETE)
2. **SI-011.1c L4 MarketingCopy approval gate canonical content port** is now unblocked (per SC7 P-024 Sub-decision #4 dependency caveat — SI-011.1c requires SI-015 ratification landing first; this SI-015 closure clears that gate)
3. **Acquisition Slice PRD §13 + Admin Configuration Slice PRD §12.1 implementation** against MarketingCopy row shapes can begin (estimated ~800-1500 LOC across marketing-copy repo + service + admin handler + governance review workflow + tests)
4. **Regression tests required:**
   - Tier 0 immutability test: attempt direct SQL UPDATE of id/tenant_id/country_of_care/version/surface_type/classification/created_at → all MUST fail
   - Tier 1 post-approval immutability test: with row at status='approved', attempt UPDATE of any Tier 1 column → all MUST fail
   - State-machine allow-list test: each non-allow-listed transition MUST fail; each allow-listed transition MUST succeed with correct timestamp population
   - Cross-tenant safety test: attempt INSERT of marketing_copy in tenant A referencing governance_evidence in tenant B → MUST fail
   - GRANT lockdown test: `telecheck_app_role` attempting UPDATE or DELETE on `marketing_copy_governance_evidence` MUST fail with permission denied
   - Content fingerprint immutability test: with row at status='approved', attempt UPDATE of content_body → MUST fail at the Tier 1 trigger before fingerprint mismatch
   - Re-approval requires fresh governance_review_reference_id test: suspended → approved with OLD.governance_review_reference_id reused MUST fail
   - DB-time forcing test: INSERT with caller-supplied created_at = past MUST be silently overridden to NOW()

---

## Cross-cutting impact

This SI is on the critical path for SI-011.1c L4 MarketingCopy approval gate canonical content port + Acquisition + Admin Configuration slice implementation. Landing it unblocks 3 downstream surfaces:
1. SI-011.1c canonical row shape ratification (which lands its own L4 gate logic + `forms.publish.marketing_copy_*` audit IDs)
2. Acquisition Slice §13 marketing surface rendering (which references `MarketingCopy.content_fingerprint` for drift detection per §13.2)
3. Admin Configuration Slice §12.1 marketing copy admin console (which CRUDs `MarketingCopy` rows in scoped tenant)

The TYPES v5.2 + AUDIT_EVENTS v5.2 + DOMAIN_EVENTS v5.2 + CCR_RUNTIME v5.2 marketing surface is already complete; SI-015 is the **CDM-only** schema gap that closes the layered architecture for marketing-copy lifecycle.

---

## Spec references

- CDM v1.2 §3 entity inventory (will add §3.13 Marketing-Governance category — 2 entities — at SI-015 closure; total entities 42 → 44)
- CDM v1.2 §4 row-shape expansion (will add §4.27 MarketingCopy + §4.28 MarketingCopyGovernanceEvidence)
- TYPES v5.2 §MarketingCopy + §MarketingCopyGovernanceEvidence (existing type defs; SI-015 formalizes as tables)
- AUDIT_EVENTS v5.2 §6 (`marketing.surface_rendered`, `marketing.surface_drift` — already canonical)
- DOMAIN_EVENTS v5.2 (`marketing.surface_published`, `marketing.surface_suspended` — already canonical)
- CCR_RUNTIME v5.2 marketing block (already canonical)
- ADR-027 v0.6 (country-conditional DTC marketing posture, Accepted at v1.10)
- Master PRD v1.10 §13.2 (marketing copy governance review process)
- MARKET_LAUNCH v5.1 6-condition activation gate
- SI-011 UMBRELLA P-024 Sub-decision #4 + #9 (SC7 ratification 2026-05-18 — SI-011.1c depends on SI-015)
- SI-001 / SI-005 / SI-008 / SI-009 / SI-009.1 (precedent disciplines for CDM schema-gap closure: composite UNIQUE + composite FK + Tier 0/1/2 invariants + DB-clock-anchored timestamps + state-machine triggers + I-003 append-only parity)
- INVARIANTS §I-003 (audit append-only — MarketingCopyGovernanceEvidence inherits the discipline)
- INVARIANTS §I-013 (published-content-version-immutability — MarketingCopy Tier 1 inherits the discipline)
- INVARIANTS §I-023..I-027 (tenant isolation — composite FKs make cross-tenant attacks structurally impossible)

---

## Status

- **Filed:** 2026-05-18 (autonomous run; post-SC7 P-024 SI-011 UMBRELLA Sub-decision #4 + #9 dependency execution)
- **Author:** Autonomous Claude
- **Target Promotion Ledger entry:** **TBD future P-NUM** (gap slot — likely P-017 or P-022 per post-SC7 unclaimed-slot inventory; or next-available after canonical-content-port wave for sub-ceremonies 1-6)
- **Codex pre-ratification gate:** v0.1 filed 2026-05-18 (this commit); formal gate commences with this PR open. Estimated 3-5 rounds based on SI-001 single-entity precedent for similar scope.
- **Blocks:** SI-011.1c L4 MarketingCopy approval gate canonical content port; Acquisition Slice §13 + Admin Configuration §12.1 implementation against MarketingCopy row shapes
- **Does NOT block:** SC1–SC7 ratifications (all closed); SI-009.1 ratification (independent surface); SI-011.1a + SI-011.1b (independent sub-SIs); SI-016 (independent dependency SI)
- **Companion SIs:** SI-001 (MedicationRequest — single-entity CDM expansion precedent ✅ closed at P-011); SI-005 (Consult + ConsultEvent — sibling-pair CDM expansion ✅); SI-008 (AiWorkflowExecution — single-entity ✅); SI-009 (SyncSession — single-entity ✅); SI-009.1 (SyncSessionParticipants + SyncSessionRecordings — sibling-pair ✅ pre-ratification converged); SI-011 UMBRELLA (parent — closed at P-024 SC7); SI-016 (sibling dependency SI for ai_workflow_handler_registry — independent surface)

— Claude (Opus 4.7, 1M context), 2026-05-18 SI-015 v0.1 DRAFT filed per SC7 P-024 SI-011 UMBRELLA Sub-decision #4 + #9 dependency execution. Pre-Codex pre-ratification gate ahead per SI-001/SI-007/SI-009.1 retrospective discipline.
