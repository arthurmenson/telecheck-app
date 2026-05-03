-- =============================================================================
-- File:    migrations/006_forms_intake.sql
-- Purpose: Create the Forms / Intake Engine schema — 6 tables covering the
--          four canonical FORMS_ENGINE layers (template, deployment, submission,
--          snapshot) plus the two v2.0 additions (variant, resume_state).
-- Spec:    - Contracts Pack v5.2 FORMS_ENGINE (four-layer architecture, Pattern A
--            versioning, tenant scoping, research consent integration, I-030
--            static-analysis enforcement hooks)
--          - Forms / Intake Engine Slice PRD v2.1 §4 (form structure model),
--            §5 (tenant scoping), §8 (save-and-resume), §14 (A/B variants),
--            §25 (v1.10 cycle additions: marketing copy classification, research
--            consent block field type)
--          - Canonical Data Model v1.2 §2 conventions (ULID PK = VARCHAR(26);
--            tenant_id FK = VARCHAR(26) per Telecheck-{country} exception;
--            RLS on every PHI-touching table; soft deletion via deleted_at)
--          - State Machines v1.1 §3 Async Consult (intake submission states)
--          - I-013 (published form versions immutable)
--          - I-023 (three-layer tenant isolation)
--          - I-027 (every PHI-touching row carries tenant_id)
--          - I-030 (no Forms Engine layer may produce care-touching behaviour
--            gated on research_consent_status — static-analysis reject flag
--            column added to forms_template for publish-time enforcement)
--          - ADR-004 (Pattern A: one immutable version per market)
--          - ADR-023 (multi-tenancy Model A; RLS enforced)
--          - ADR-028 (research data partnership Posture A; consent block CCR gate)
-- Summary:
--   forms_template    — versioned form definitions per tenant/program/market
--   forms_deployment  — live binding of a template version to a program/market
--   forms_submission  — a patient's response record for a deployment
--   forms_snapshot    — APPEND-ONLY immutable record of what the patient saw
--   forms_variant     — A/B test variant of a deployed template
--   forms_resume_state— encrypted partial submission saved for later completion
--
-- RLS pattern: mirror of migrations 003–005.
-- Snapshot append-only: mirror of audit_records in migration 002.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- PRECONDITIONS:
--   001_tenants.sql        applied (tenants table)
--   002_audit_chain.sql    applied (append-only pattern reference)
--   003_rls_helpers.sql    applied (current_tenant_id())
--   004_domain_events_outbox.sql applied
--   005_idempotency_keys.sql     applied
-- ---------------------------------------------------------------------------

-- =============================================================================
-- TABLE 1: forms_template
-- The form definition layer. Carries all four FORMS_ENGINE functional layers
-- as JSONB columns. Versioned per Pattern A: one immutable version per
-- (tenant_id, program_id, country_of_care). Status lifecycle follows
-- FORMS_ENGINE §Version lifecycle.
--
-- SPEC ISSUE (naming): FORMS_ENGINE §Version lifecycle uses the terms
-- draft / published / superseded / archived, while the slice PRD §6 state
-- machine names the submission states (in_progress / submitted / under_review /
-- approved / declined / withdrawn). These are distinct lifecycles on distinct
-- entities. The template status column below uses the FORMS_ENGINE names
-- (draft / published / superseded / archived).
-- Engineering Lead: confirm whether "published" is acceptable as the live-
-- serving status or whether the slice PRD intends a separate "deployed" step
-- distinct from "published". The current implementation treats "published" and
-- "deployed" as equivalent for the template (deployment to a program happens
-- via forms_deployment; the template version status simply gates whether a
-- deployment may be created against it). This is a decision for Engineering
-- Lead review.
--
-- SPEC ISSUE (research_consent_static_analysis_status): FORMS_ENGINE v5.2
-- §Research consent integration requires that form-version-publish-time static
-- analysis rejects versions containing any of the 6 prohibited
-- research_consent_status dependencies (I-030). The enforcement mechanism is
-- described as application-layer (the builder/deploy handler), not a DB
-- constraint. This column records the verdict so that the application layer
-- can gate the draft → published transition. The column is nullable because
-- it is only meaningful at publish time; draft templates have no verdict.
-- Engineering Lead: confirm this column is the right DB-side hook, or whether
-- it belongs entirely in an application-layer validation step.
-- =============================================================================

CREATE TABLE IF NOT EXISTS forms_template (

    -- -------------------------------------------------------------------------
    -- Identity (CDM v1.2 §2 convention: ULID primary key)
    -- -------------------------------------------------------------------------

    -- ULID prefixed 'frv_' per FORMS_ENGINE §Pattern A. Stored as VARCHAR(26)
    -- per CDM v1.2 §2 ULID convention (prefix is conceptual — the actual
    -- stored value is the 26-char ULID; application layer appends prefix in
    -- the domain object representation).
    template_id         VARCHAR(26)     PRIMARY KEY,

    -- -------------------------------------------------------------------------
    -- Tenant scope (I-023, I-027, CDM v1.2 §2)
    -- -------------------------------------------------------------------------

    -- VARCHAR(26) per CDM v1.2 §2 FK-to-tenants exception: tenant_id uses the
    -- Telecheck-{country} format (VARCHAR(26)), not a ULID.
    tenant_id           VARCHAR(26)     NOT NULL
                            REFERENCES tenants(id),

    -- -------------------------------------------------------------------------
    -- Program + market binding (Pattern A — ADR-004, FORMS_ENGINE §Form versioning)
    -- -------------------------------------------------------------------------

    -- The platform-level program this template belongs to (ProgramCatalogEntry
    -- ID per TYPES v5.2). VARCHAR(26) ULID per CDM convention.
    program_id          VARCHAR(26)     NOT NULL,

    -- Country of care per ADR-024 CCR. Drives which CCR pack is active at
    -- render time (including research_data_partnership_active gate per
    -- FORMS_ENGINE v5.2 §Research consent integration).
    country_of_care     VARCHAR(10)     NOT NULL,

    -- Monotonically increasing version number within the
    -- (tenant_id, program_id, country_of_care) series.
    -- UNIQUE constraint below enforces Pattern A immutability: no two templates
    -- may share the same (tenant, program, country, version) tuple.
    template_version    INTEGER         NOT NULL
                            CHECK (template_version >= 1),

    -- -------------------------------------------------------------------------
    -- Display metadata
    -- -------------------------------------------------------------------------

    name                TEXT            NOT NULL,
    description         TEXT            NULL,

    -- -------------------------------------------------------------------------
    -- FORMS_ENGINE four-layer JSONB columns
    -- -------------------------------------------------------------------------

    -- Layer 1 (L1): Reassurance copy, testimonials, educational content,
    -- conversion blocks, trust blocks, pricing displays, cart upsells,
    -- transition messages, interstitials, progress indicators.
    -- Per Slice PRD §25.1: every L1 element must carry a 'copy_classification'
    -- attribute ('program_level' | 'molecule_level') for marketing-copy gating
    -- per ADR-027 Decision §4. L4 publish-time validation rejects molecule-level
    -- L1 elements that do not resolve to an approved MarketingCopy entity.
    -- Schema: { "sections": [...], "elements": [...] }
    presentation_content JSONB          NOT NULL DEFAULT '{}'::JSONB,

    -- Layer 2 (L2): Conditional question display, ordering, skip logic,
    -- page flow. Determines what the patient sees and in what order.
    -- FORMS_ENGINE v5.2 I-030 enforcement: no L2 BranchingLogic rule may
    -- evaluate research_consent_status — checked at publish-time static analysis
    -- (application layer); result recorded in research_consent_static_analysis_status.
    -- Schema: { "rules": [...], "computed_fields": [...] }
    branching_logic     JSONB           NOT NULL DEFAULT '{}'::JSONB,

    -- Layer 3 (L3): Clinical screening, contraindication detection, hard
    -- exclusions. Safety-critical layer; dual control required per I-015.
    -- Edited by clinical_content_author; approved by clinical_safety_officer.
    -- FORMS_ENGINE v5.2 I-030 enforcement: no L3 validation/eligibility rule
    -- may gate on research_consent_status.
    -- Audit category B per FORMS_ENGINE §Layer 3 definition.
    -- Schema: { "eligibility_rules": [...], "contraindications": [...] }
    eligibility_logic   JSONB           NOT NULL DEFAULT '{}'::JSONB,

    -- Layer 4 (L4): Pricing, country availability, launch gating, Mode 2
    -- input contract bindings. Binds a form version to markets and commercial
    -- configuration. L4 is also responsible for:
    --   - Verifying molecule-level L1 elements resolve to approved MarketingCopy
    --     per Slice PRD §25.1 (ADR-027 Decision §4).
    --   - Verifying research_consent_text_version against CCR
    --     research_ethics_review_body.approval_reference_id per FORMS_ENGINE v5.2.
    -- Schema: { "markets": [...], "pricing": {...}, "governance": {...} }
    approval_governance JSONB           NOT NULL DEFAULT '{}'::JSONB,

    -- -------------------------------------------------------------------------
    -- Lifecycle status (FORMS_ENGINE §Version lifecycle)
    -- -------------------------------------------------------------------------

    -- draft      — being authored; not visible to patients
    -- published  — live; patients can complete intakes against it
    --              (I-013: published versions are immutable — enforced by the
    --              application layer on UPDATE attempts against published rows)
    -- superseded — a newer version is published; no longer offered to new intakes
    --              but existing in-progress intakes may complete against it
    -- archived   — no longer used; retained for audit reference
    --
    -- SPEC ISSUE: The charter uses 'in_review' and 'deployed' as distinct
    -- lifecycle phases (draft / in_review / approved / deployed / retired)
    -- which does not align exactly with FORMS_ENGINE §Version lifecycle names
    -- (draft / published / superseded / archived). FORMS_ENGINE v5.2 is the
    -- higher-ranking contract (level 3 in source-of-truth hierarchy). This
    -- column uses the FORMS_ENGINE canonical names. Engineering Lead should
    -- review whether the charter's additional 'in_review' and 'approved' phases
    -- need to be tracked in a separate workflow-state column (e.g.,
    -- 'review_state': 'pending_clinical_review' | 'clinician_approved' |
    -- 'clinician_rejected') distinct from the published/live status here.
    -- For now, the 'draft' status covers both initial-draft and in-review states
    -- pending that clarification.
    status              VARCHAR(20)     NOT NULL DEFAULT 'draft'
                            CHECK (status IN ('draft', 'published', 'superseded', 'archived')),

    -- -------------------------------------------------------------------------
    -- I-030 static-analysis verdict (FORMS_ENGINE v5.2 + ADR-028)
    -- Populated by the application layer at publish-time. NULL = not yet
    -- evaluated (draft state). 'pass' = all 6 categories clear.
    -- 'fail' = one or more prohibited research_consent_status dependencies found;
    -- template MUST NOT transition to 'published' while this is 'fail'.
    -- -------------------------------------------------------------------------

    research_consent_static_analysis_status
                        VARCHAR(10)     NULL
                            CHECK (research_consent_static_analysis_status IN ('pass', 'fail')),

    -- -------------------------------------------------------------------------
    -- Authoring metadata
    -- -------------------------------------------------------------------------

    created_by          VARCHAR(26)     NOT NULL,  -- tenant_user_id (ULID)
    approved_by         VARCHAR(26)     NULL,       -- clinical_safety_officer user_id (ULID); required for L3 dual-control per I-015

    -- -------------------------------------------------------------------------
    -- Timestamps
    -- -------------------------------------------------------------------------

    created_at          TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
    published_at        TIMESTAMPTZ     NULL,       -- set when status transitions to 'published'
    superseded_at       TIMESTAMPTZ     NULL,       -- set when a newer version is published
    archived_at         TIMESTAMPTZ     NULL,

    -- -------------------------------------------------------------------------
    -- Soft deletion (CDM v1.2 §2 convention for clinical entities)
    -- -------------------------------------------------------------------------

    deleted_at          TIMESTAMPTZ     NULL,

    -- -------------------------------------------------------------------------
    -- Pattern A unique constraint (ADR-004, FORMS_ENGINE §Form versioning)
    -- One version per (tenant, program, country, version number).
    -- -------------------------------------------------------------------------

    CONSTRAINT uq_template_version
        UNIQUE (tenant_id, program_id, country_of_care, template_version)
);

-- ---------------------------------------------------------------------------
-- Indexes for forms_template
-- Key queries per slice PRD §7 (Endpoints):
--   GET /tenants/{tid}/forms-templates                → (tenant_id, status, created_at)
--   GET /tenants/{tid}/programs/{pid}/templates       → (tenant_id, program_id, country_of_care, status)
--   GET /tenants/{tid}/forms-templates/{template_id}  → PK
-- ---------------------------------------------------------------------------

-- Active template lookup per tenant + program + market (the most common query
-- at deployment time and at form-rendering entry-point).
CREATE INDEX IF NOT EXISTS idx_forms_template_tenant_program_coc_status
    ON forms_template (tenant_id, program_id, country_of_care, status);

-- Tenant-wide template listing (admin builder view, audit queries).
CREATE INDEX IF NOT EXISTS idx_forms_template_tenant_status_created
    ON forms_template (tenant_id, status, created_at DESC);

-- ---------------------------------------------------------------------------
-- Row-Level Security (I-023, ADR-023)
-- ---------------------------------------------------------------------------

ALTER TABLE forms_template ENABLE ROW LEVEL SECURITY;
ALTER TABLE forms_template FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON forms_template
    USING     (tenant_id = current_tenant_id())
    WITH CHECK (tenant_id = current_tenant_id());


-- =============================================================================
-- TABLE 2: forms_deployment
-- A template version deployed to a tenant for a specific program at a specific
-- point in time. Creates the live binding between a published form version and
-- the patients who will receive it. Per FORMS_ENGINE §Tenant scoping: form
-- deployments are tenant-scoped.
-- =============================================================================

CREATE TABLE IF NOT EXISTS forms_deployment (

    deployment_id       VARCHAR(26)     PRIMARY KEY,

    -- -------------------------------------------------------------------------
    -- Tenant scope
    -- -------------------------------------------------------------------------

    tenant_id           VARCHAR(26)     NOT NULL
                            REFERENCES tenants(id),

    -- -------------------------------------------------------------------------
    -- Program binding
    -- -------------------------------------------------------------------------

    program_id          VARCHAR(26)     NOT NULL,

    -- -------------------------------------------------------------------------
    -- Template version binding (FK to forms_template)
    -- -------------------------------------------------------------------------

    template_id         VARCHAR(26)     NOT NULL
                            REFERENCES forms_template(template_id),

    -- -------------------------------------------------------------------------
    -- Deployment window
    -- -------------------------------------------------------------------------

    deployed_at         TIMESTAMPTZ     NOT NULL DEFAULT NOW(),

    -- Set when this deployment is retired (a newer deployment for the same
    -- program supersedes it). NULL = currently active.
    retired_at          TIMESTAMPTZ     NULL,

    -- -------------------------------------------------------------------------
    -- Deployment metadata
    -- -------------------------------------------------------------------------

    deployed_by         VARCHAR(26)     NOT NULL,   -- tenant_user_id

    -- -------------------------------------------------------------------------
    -- Timestamps
    -- -------------------------------------------------------------------------

    created_at          TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ     NOT NULL DEFAULT NOW()
);

-- ---------------------------------------------------------------------------
-- Indexes for forms_deployment
-- Key queries per slice PRD §7:
--   Active deployment lookup for a patient starting intake (most critical path):
--     WHERE tenant_id = $1 AND program_id = $2 AND retired_at IS NULL
--   Deployment history for admin/audit:
--     WHERE tenant_id = $1 AND program_id = $2 ORDER BY deployed_at DESC
-- ---------------------------------------------------------------------------

-- Active deployment lookup — partial index keeps it small (only live rows).
CREATE INDEX IF NOT EXISTS idx_forms_deployment_active
    ON forms_deployment (tenant_id, program_id, deployed_at DESC)
    WHERE retired_at IS NULL;

-- Full history including retired deployments (audit, analytics).
CREATE INDEX IF NOT EXISTS idx_forms_deployment_tenant_program
    ON forms_deployment (tenant_id, program_id, deployed_at DESC);

-- ---------------------------------------------------------------------------
-- Row-Level Security
-- ---------------------------------------------------------------------------

ALTER TABLE forms_deployment ENABLE ROW LEVEL SECURITY;
ALTER TABLE forms_deployment FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON forms_deployment
    USING     (tenant_id = current_tenant_id())
    WITH CHECK (tenant_id = current_tenant_id());


-- =============================================================================
-- TABLE 3: forms_submission
-- A patient's actual responses to a deployment. PHI-bearing. The status
-- lifecycle follows the intake flow described in State Machines v1.1 §3 and
-- the submission states in the slice PRD.
-- Submitted responses are stored as JSONB because the schema is dynamic per
-- template — field IDs vary by template version.
-- =============================================================================

CREATE TABLE IF NOT EXISTS forms_submission (

    submission_id       VARCHAR(26)     PRIMARY KEY,

    -- -------------------------------------------------------------------------
    -- Tenant scope (PHI — mandatory)
    -- -------------------------------------------------------------------------

    tenant_id           VARCHAR(26)     NOT NULL
                            REFERENCES tenants(id),

    -- -------------------------------------------------------------------------
    -- Relationship to deployment
    -- -------------------------------------------------------------------------

    deployment_id       VARCHAR(26)     NOT NULL
                            REFERENCES forms_deployment(deployment_id),

    -- -------------------------------------------------------------------------
    -- Patient and delegate identifiers (PHI)
    -- -------------------------------------------------------------------------

    patient_id          VARCHAR(26)     NOT NULL,   -- patient ULID (FK to patients table, added when Identity slice lands)

    -- Delegate who completed the form on the patient's behalf, if applicable.
    -- NULL = patient completed their own form (normal case).
    -- Per slice PRD §3 + §18 delegate intake model; delegations are
    -- tenant-scoped (a delegate in Tenant X is not automatically authorized
    -- in Tenant Y per ADR-023).
    delegate_id         VARCHAR(26)     NULL,

    -- -------------------------------------------------------------------------
    -- Variant attribution (links to A/B test arm)
    -- NULL when no A/B test is active for the deployment.
    -- -------------------------------------------------------------------------

    variant_id          VARCHAR(26)     NULL,       -- FK added after forms_variant is created below

    -- -------------------------------------------------------------------------
    -- Lifecycle status
    -- Per State Machines v1.1 §3 Async Consult intake flow and slice PRD §6.
    -- States:
    --   in_progress   — patient has started but not yet submitted
    --   submitted     — patient submitted; awaiting processing
    --   under_review  — clinician or AI Mode 2 is reviewing
    --   approved      — intake approved; downstream workflow (e.g., subscription
    --                   DRAFT) may proceed
    --   declined      — clinician declined; patient notified
    --   withdrawn     — patient withdrew their submission before review
    -- -------------------------------------------------------------------------

    status              VARCHAR(20)     NOT NULL DEFAULT 'in_progress'
                            CHECK (status IN (
                                'in_progress',
                                'submitted',
                                'under_review',
                                'approved',
                                'declined',
                                'withdrawn'
                            )),

    -- -------------------------------------------------------------------------
    -- Response payload (PHI — dynamic per template)
    -- Field IDs in the JSONB keys correspond to question elements in the
    -- template version. The application layer validates this against the
    -- template schema at submission time.
    -- Schema: { "field_<id>": <value>, ... }
    -- -------------------------------------------------------------------------

    responses           JSONB           NOT NULL DEFAULT '{}'::JSONB,

    -- -------------------------------------------------------------------------
    -- Mode 2 input contract flag (slice PRD §10)
    -- Set to TRUE when the submission carries all required Mode 2 input fields
    -- in conformant schema. The AI Clinical Assistant slice reads this flag
    -- before attempting Mode 2 case prep.
    -- -------------------------------------------------------------------------

    mode_2_eligible     BOOLEAN         NOT NULL DEFAULT FALSE,

    -- -------------------------------------------------------------------------
    -- Timestamps
    -- -------------------------------------------------------------------------

    created_at          TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
    submitted_at        TIMESTAMPTZ     NULL,       -- set on status → 'submitted'
    reviewed_at         TIMESTAMPTZ     NULL,       -- set when clinician claims the case
    resolved_at         TIMESTAMPTZ     NULL,       -- set on status → approved / declined / withdrawn

    -- -------------------------------------------------------------------------
    -- Soft deletion (clinical entity per CDM v1.2 §2)
    -- -------------------------------------------------------------------------

    deleted_at          TIMESTAMPTZ     NULL
);

-- ---------------------------------------------------------------------------
-- Indexes for forms_submission
-- Key queries per slice PRD §7 (Endpoints):
--   GET /tenants/{tid}/patients/{pid}/submissions          → (tenant_id, patient_id, created_at)
--   GET /tenants/{tid}/submissions?status=under_review     → (tenant_id, status, submitted_at)
--   GET /tenants/{tid}/deployments/{did}/submissions       → (tenant_id, deployment_id, status)
--   Clinician queue (pending review):
--     WHERE tenant_id = $1 AND status = 'submitted' ORDER BY submitted_at
-- ---------------------------------------------------------------------------

-- Patient's submission history (most common patient-app query).
CREATE INDEX IF NOT EXISTS idx_forms_submission_patient
    ON forms_submission (tenant_id, patient_id, created_at DESC);

-- Clinician review queue — partial index on submitted + under_review only.
CREATE INDEX IF NOT EXISTS idx_forms_submission_review_queue
    ON forms_submission (tenant_id, submitted_at ASC)
    WHERE status IN ('submitted', 'under_review');

-- Deployment-scoped submission list (admin analytics).
CREATE INDEX IF NOT EXISTS idx_forms_submission_deployment
    ON forms_submission (tenant_id, deployment_id, status, created_at DESC);

-- ---------------------------------------------------------------------------
-- Row-Level Security
-- ---------------------------------------------------------------------------

ALTER TABLE forms_submission ENABLE ROW LEVEL SECURITY;
ALTER TABLE forms_submission FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON forms_submission
    USING     (tenant_id = current_tenant_id())
    WITH CHECK (tenant_id = current_tenant_id());


-- =============================================================================
-- TABLE 4: forms_snapshot
-- The IMMUTABLE record of what the patient saw at submission time. Binds the
-- exact template version that was rendered. Per FORMS_ENGINE §Form versioning:
-- the version used is recorded in the intake response and in audit.
-- Per I-013: published versions are immutable.
--
-- APPEND-ONLY enforcement (mirrors audit_records in migration 002):
--   - REVOKE UPDATE, DELETE FROM PUBLIC
--   - Trigger raises EXCEPTION on any UPDATE/DELETE attempt
-- =============================================================================

CREATE TABLE IF NOT EXISTS forms_snapshot (

    snapshot_id         VARCHAR(26)     PRIMARY KEY,

    -- -------------------------------------------------------------------------
    -- Tenant scope (PHI — mandatory)
    -- -------------------------------------------------------------------------

    tenant_id           VARCHAR(26)     NOT NULL
                            REFERENCES tenants(id),

    -- -------------------------------------------------------------------------
    -- Submission binding (one snapshot per submission)
    -- -------------------------------------------------------------------------

    submission_id       VARCHAR(26)     NOT NULL
                            REFERENCES forms_submission(submission_id),

    -- -------------------------------------------------------------------------
    -- Template version that was presented
    -- -------------------------------------------------------------------------

    template_id         VARCHAR(26)     NOT NULL
                            REFERENCES forms_template(template_id),

    template_version    INTEGER         NOT NULL
                            CHECK (template_version >= 1),

    -- -------------------------------------------------------------------------
    -- Immutable rendered content
    -- The exact rendered template as the patient saw it. Includes resolved
    -- CCR values (e.g., whether research_data_partnership_active was truthy,
    -- which research consent block text version was shown) and all four L1-L4
    -- layers at the moment of rendering, so that future audit can reconstruct
    -- what was presented without being affected by subsequent template edits.
    -- Schema: { "rendered_sections": [...], "ccr_resolution_snapshot": {...},
    --           "research_consent_text_version": "<ref>|null",
    --           "l4_approval_governance_snapshot": {...} }
    -- -------------------------------------------------------------------------

    presented_content   JSONB           NOT NULL,

    -- -------------------------------------------------------------------------
    -- Timestamps (append-only; no updated_at — snapshots never change)
    -- -------------------------------------------------------------------------

    created_at          TIMESTAMPTZ     NOT NULL DEFAULT NOW()
);

-- ---------------------------------------------------------------------------
-- Indexes for forms_snapshot
-- Key queries:
--   GET /tenants/{tid}/submissions/{sid}/snapshot   → (submission_id) — covered by FK index below
--   Audit reconstruction by template version       → (template_id, template_version)
-- ---------------------------------------------------------------------------

-- One snapshot per submission — primary lookup by submission_id.
CREATE INDEX IF NOT EXISTS idx_forms_snapshot_submission
    ON forms_snapshot (tenant_id, submission_id);

-- Audit queries: all snapshots for a specific template version.
CREATE INDEX IF NOT EXISTS idx_forms_snapshot_template_version
    ON forms_snapshot (tenant_id, template_id, template_version);

-- ---------------------------------------------------------------------------
-- Row-Level Security
-- ---------------------------------------------------------------------------

ALTER TABLE forms_snapshot ENABLE ROW LEVEL SECURITY;
ALTER TABLE forms_snapshot FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON forms_snapshot
    USING     (tenant_id = current_tenant_id())
    WITH CHECK (tenant_id = current_tenant_id());

-- ---------------------------------------------------------------------------
-- APPEND-ONLY ENFORCEMENT for forms_snapshot
-- Belt: REVOKE UPDATE and DELETE from PUBLIC.
-- Suspenders: trigger raises EXCEPTION on any UPDATE/DELETE attempt.
-- This is required by the same reasoning as audit_records (I-013 for form
-- versions; also per FORMS_ENGINE §Tenant scoping "Form snapshots are
-- tenant-scoped" and the overall principle that the patient's record of
-- what they saw cannot be altered after the fact).
-- ---------------------------------------------------------------------------

REVOKE UPDATE ON forms_snapshot FROM PUBLIC;
REVOKE DELETE ON forms_snapshot FROM PUBLIC;

-- SPEC ISSUE: Application role not yet created. When 006_roles.sql (or
-- equivalent) is authored, add:
--   REVOKE UPDATE ON forms_snapshot FROM telecheck_app_role;
--   REVOKE DELETE ON forms_snapshot FROM telecheck_app_role;

CREATE OR REPLACE FUNCTION forms_snapshot_block_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
    RAISE EXCEPTION
        'forms_snapshot is append-only per FORMS_ENGINE §Tenant scoping and I-013. '
        'UPDATE and DELETE are permanently prohibited on snapshot rows. '
        'The snapshot binds the exact template version the patient saw at '
        'submission time; it must not be altered after capture.';
END;
$$;

CREATE TRIGGER forms_snapshot_block_update
    BEFORE UPDATE ON forms_snapshot
    FOR EACH ROW
    EXECUTE FUNCTION forms_snapshot_block_mutation();

CREATE TRIGGER forms_snapshot_block_delete
    BEFORE DELETE ON forms_snapshot
    FOR EACH ROW
    EXECUTE FUNCTION forms_snapshot_block_mutation();


-- =============================================================================
-- TABLE 5: forms_variant
-- A/B test variants of a deployed template. Per slice PRD §14.1: each deployed
-- template can have one Control + 1–4 alternative variants. Variants are full
-- template instances that differ in specified elements. Traffic split via
-- PostHog feature flags (per ADR-022). Per FORMS_ENGINE §Tenant scoping:
-- variant assignment, statistical significance computation, and winner promotion
-- happen within a single tenant.
-- =============================================================================

CREATE TABLE IF NOT EXISTS forms_variant (

    variant_id          VARCHAR(26)     PRIMARY KEY,

    -- -------------------------------------------------------------------------
    -- Tenant scope
    -- -------------------------------------------------------------------------

    tenant_id           VARCHAR(26)     NOT NULL
                            REFERENCES tenants(id),

    -- -------------------------------------------------------------------------
    -- Deployment binding
    -- -------------------------------------------------------------------------

    deployment_id       VARCHAR(26)     NOT NULL
                            REFERENCES forms_deployment(deployment_id),

    -- -------------------------------------------------------------------------
    -- Variant identity
    -- -------------------------------------------------------------------------

    -- Human-readable label (e.g., 'control', 'A', 'B', 'C', 'D').
    -- Per slice PRD §14.1: one Control + 1–4 alternatives.
    variant_label       VARCHAR(20)     NOT NULL
                            CHECK (variant_label IN ('control', 'A', 'B', 'C', 'D')),

    -- -------------------------------------------------------------------------
    -- Template binding
    -- Each variant arm is backed by a forms_template version. The 'control'
    -- variant uses the same template_id as the deployment's primary template;
    -- alternative variants use modified template versions.
    -- -------------------------------------------------------------------------

    variant_template_id VARCHAR(26)     NOT NULL
                            REFERENCES forms_template(template_id),

    -- -------------------------------------------------------------------------
    -- Traffic split (percentage 0–100)
    -- The sum of traffic_percent across all variants for a deployment SHOULD
    -- equal 100. Enforced at the application layer (PostHog flag configuration).
    -- -------------------------------------------------------------------------

    traffic_percent     SMALLINT        NOT NULL
                            CHECK (traffic_percent BETWEEN 0 AND 100),

    -- -------------------------------------------------------------------------
    -- PostHog feature flag reference (ADR-022 PostHog integration)
    -- The PostHog feature flag key that drives traffic assignment for this arm.
    -- -------------------------------------------------------------------------

    posthog_flag_key    TEXT            NULL,

    -- -------------------------------------------------------------------------
    -- Lifecycle
    -- -------------------------------------------------------------------------

    -- active    — this arm is live; new patients may be assigned to it
    -- retired   — arm retired (e.g., losing variant after winner promotion)
    -- winner    — this arm was promoted as the winner and became the new control
    status              VARCHAR(10)     NOT NULL DEFAULT 'active'
                            CHECK (status IN ('active', 'retired', 'winner')),

    -- -------------------------------------------------------------------------
    -- Audit metadata (slice PRD §14.6: variant audit is category B)
    -- -------------------------------------------------------------------------

    created_by          VARCHAR(26)     NOT NULL,   -- tenant_user_id
    retired_by          VARCHAR(26)     NULL,
    retired_reason      TEXT            NULL,

    -- -------------------------------------------------------------------------
    -- Timestamps
    -- -------------------------------------------------------------------------

    created_at          TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
    retired_at          TIMESTAMPTZ     NULL,

    -- -------------------------------------------------------------------------
    -- Per-deployment uniqueness: only one variant may hold a given label
    -- -------------------------------------------------------------------------

    CONSTRAINT uq_variant_label_per_deployment
        UNIQUE (deployment_id, variant_label)
);

-- Add the FK from forms_submission to forms_variant now that forms_variant exists.
ALTER TABLE forms_submission
    ADD CONSTRAINT fk_submission_variant
        FOREIGN KEY (variant_id)
        REFERENCES forms_variant(variant_id);

-- ---------------------------------------------------------------------------
-- Indexes for forms_variant
-- Key queries per slice PRD §14:
--   Active variants for a deployment (traffic-split lookup at intake entry):
--     WHERE deployment_id = $1 AND status = 'active'
--   Variant analytics (admin dashboard):
--     WHERE tenant_id = $1 AND deployment_id = $2
-- ---------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS idx_forms_variant_deployment_active
    ON forms_variant (tenant_id, deployment_id, status)
    WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_forms_variant_deployment
    ON forms_variant (tenant_id, deployment_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- Row-Level Security
-- ---------------------------------------------------------------------------

ALTER TABLE forms_variant ENABLE ROW LEVEL SECURITY;
ALTER TABLE forms_variant FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON forms_variant
    USING     (tenant_id = current_tenant_id())
    WITH CHECK (tenant_id = current_tenant_id());


-- =============================================================================
-- TABLE 6: forms_resume_state
-- A partial submission saved for later completion. Encrypted partial responses
-- are stored as BYTEA — the application layer encrypts via kms.ts (per-tenant
-- KMS key, per ADR-023 three-layer isolation) before INSERT. The DB never sees
-- plaintext partial responses.
-- Per FORMS_ENGINE §Tenant scoping: form resume state is tenant-scoped; paused
-- submissions resume only within the tenant they were initiated in.
-- Per slice PRD §8.4: default 30-day TTL (tenant-configurable). After expiry,
-- resume state is purged; patient must restart.
--
-- NOTE on anonymous pre-account tokens:
-- Per slice PRD §8.2: if the patient has not yet created an account, the resume
-- state is tied to a device-anonymous-token (email/SMS contact per tenant config)
-- rather than a patient_id. patient_id is nullable here to support this case.
-- device_anonymous_token is nullable (NULL when patient_id is known).
-- The CHECK constraint below ensures at least one of (patient_id,
-- device_anonymous_token) is non-null.
-- =============================================================================

CREATE TABLE IF NOT EXISTS forms_resume_state (

    resume_state_id     VARCHAR(26)     PRIMARY KEY,

    -- -------------------------------------------------------------------------
    -- Tenant scope
    -- -------------------------------------------------------------------------

    tenant_id           VARCHAR(26)     NOT NULL
                            REFERENCES tenants(id),

    -- -------------------------------------------------------------------------
    -- Identity binding
    -- -------------------------------------------------------------------------

    -- Nullable when the patient has not yet created an account (pre-account flow).
    patient_id          VARCHAR(26)     NULL,

    -- Anonymous device/contact token for pre-account save-and-resume.
    -- Nullable when patient_id is known.
    device_anonymous_token  TEXT        NULL,

    -- At least one identity anchor required.
    CONSTRAINT chk_resume_identity
        CHECK (patient_id IS NOT NULL OR device_anonymous_token IS NOT NULL),

    -- -------------------------------------------------------------------------
    -- Deployment binding
    -- -------------------------------------------------------------------------

    deployment_id       VARCHAR(26)     NOT NULL
                            REFERENCES forms_deployment(deployment_id),

    -- -------------------------------------------------------------------------
    -- Variant arm (which A/B variant this partial session is assigned to)
    -- Sticky assignment per slice PRD §14.2 — once assigned, patient sees the
    -- same variant on resume.
    -- NULL when no A/B test is active.
    -- -------------------------------------------------------------------------

    variant_id          VARCHAR(26)     NULL
                            REFERENCES forms_variant(variant_id),

    -- -------------------------------------------------------------------------
    -- Encrypted partial responses
    -- Application layer encrypts with the tenant's KMS key before INSERT.
    -- Decryption happens at the application layer; the DB stores ciphertext only.
    -- BYTEA per charter charter requirement: "encrypted partial responses (BYTEA
    -- — the application encrypts via kms.ts before INSERT)".
    -- -------------------------------------------------------------------------

    encrypted_partial_responses  BYTEA  NOT NULL,

    -- -------------------------------------------------------------------------
    -- Resume progress metadata (not PHI — section/step index only)
    -- Stored cleartext for application-layer progress-bar reconstruction
    -- without needing to decrypt the partial responses.
    -- -------------------------------------------------------------------------

    current_section_index   INTEGER     NOT NULL DEFAULT 0,
    progress_percent        SMALLINT    NOT NULL DEFAULT 0
                                CHECK (progress_percent BETWEEN 0 AND 100),

    -- -------------------------------------------------------------------------
    -- Status
    -- -------------------------------------------------------------------------

    -- active    — patient can resume
    -- completed — patient completed the form; resume state preserved for audit
    --             (will be purged after TTL by cleanup job)
    -- expired   — TTL elapsed without completion; already processed by cleanup
    status              VARCHAR(10)     NOT NULL DEFAULT 'active'
                            CHECK (status IN ('active', 'completed', 'expired')),

    -- -------------------------------------------------------------------------
    -- TTL / expiry (slice PRD §8.4)
    -- Default 30 days. Tenant-configurable (application layer sets this from
    -- tenant configuration at INSERT time). Cleanup job scans for expired rows.
    -- -------------------------------------------------------------------------

    expires_at          TIMESTAMPTZ     NOT NULL
                            DEFAULT (NOW() + INTERVAL '30 days'),

    -- -------------------------------------------------------------------------
    -- Timestamps
    -- -------------------------------------------------------------------------

    created_at          TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
    last_saved_at       TIMESTAMPTZ     NOT NULL DEFAULT NOW(),  -- refreshed on every auto-save
    resumed_at          TIMESTAMPTZ     NULL,                    -- set each time patient resumes

    -- -------------------------------------------------------------------------
    -- Soft deletion (CDM v1.2 §2 convention)
    -- -------------------------------------------------------------------------

    deleted_at          TIMESTAMPTZ     NULL
);

-- ---------------------------------------------------------------------------
-- Indexes for forms_resume_state
-- Key queries per slice PRD §8:
--   Resume lookup for known patient:
--     WHERE tenant_id = $1 AND patient_id = $2 AND deployment_id = $3
--     AND status = 'active' AND expires_at > NOW()
--   Cleanup job scan (expired rows for purge):
--     WHERE expires_at < NOW() AND status = 'active'
--   Anonymous token resume:
--     WHERE tenant_id = $1 AND device_anonymous_token = $2 AND status = 'active'
-- ---------------------------------------------------------------------------

-- Primary patient resume lookup — partial index on active only.
CREATE INDEX IF NOT EXISTS idx_forms_resume_state_patient_active
    ON forms_resume_state (tenant_id, patient_id, deployment_id)
    WHERE status = 'active' AND patient_id IS NOT NULL;

-- Anonymous token resume lookup.
CREATE INDEX IF NOT EXISTS idx_forms_resume_state_anon_token
    ON forms_resume_state (tenant_id, device_anonymous_token)
    WHERE status = 'active' AND device_anonymous_token IS NOT NULL;

-- TTL cleanup scan (plain btree; partial-index predicate would use NOW() which
-- is volatile and rejected by PG for index predicates — same constraint as
-- 005_idempotency_keys.sql idx_idempotency_expires_at).
CREATE INDEX IF NOT EXISTS idx_forms_resume_state_expires_at
    ON forms_resume_state (expires_at)
    WHERE status = 'active';

-- ---------------------------------------------------------------------------
-- Row-Level Security
-- ---------------------------------------------------------------------------

ALTER TABLE forms_resume_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE forms_resume_state FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON forms_resume_state
    USING     (tenant_id = current_tenant_id())
    WITH CHECK (tenant_id = current_tenant_id());


-- =============================================================================
-- CLEANUP COMMENT (background job responsibility, not implemented here)
-- =============================================================================

-- A background worker (application layer or pg_cron) should run periodically:
--
--   -- Run as DB owner (bypasses RLS for cross-tenant cleanup, analogous to
--   -- the idempotency_keys cleanup comment in 005_idempotency_keys.sql).
--   UPDATE forms_resume_state
--      SET status = 'expired'
--    WHERE status = 'active'
--      AND expires_at < NOW();
--
-- This cleanup job should run at least daily. After marking expired, a
-- second pass can DELETE (or archive) rows where status = 'expired' AND
-- expires_at < NOW() - INTERVAL '7 days' (audit retention window).
-- The encrypted_partial_responses BYTEA is effectively PHI (the application
-- holds the KMS key); expired rows should be actively purged, not just marked.
-- Per slice PRD §8.4: patients who do not complete within the TTL must restart.
