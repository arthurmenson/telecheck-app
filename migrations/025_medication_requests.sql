-- =============================================================================
-- File:    migrations/025_medication_requests.sql
-- Purpose: MedicationRequest table per CDM v1.3 §4.16. Canonical record of a
--          prescribing decision (or draft thereof) within an operating tenant.
--          Targets Slice 4 Pharmacy + Refill v2.1 (Sprint 35-36) + Subscription
--          binding (CDM v1.2 §4.7 line 416 prescription_id FK target) + Med
--          Interaction Engine slice (via the
--          medication_request.interaction_safety_hold_triggered domain event).
--
-- Spec:    - Canonical Data Model v1.3 §4.16 MedicationRequest (added at P-011 /
--            SI-001 closure 2026-05-11; spec corpus commit 879cd57)
--          - State Machines v1.2 §19 MedicationRequest lifecycle (added at
--            P-011 / SI-001 closure 2026-05-11)
--          - AUDIT_EVENTS v5.3 §I-012 closure rule (bumped v5.2 → v5.3 at
--            P-011; live emissions of the new I-012 confirmation action
--            prescribing.protocol_authorization_granted MUST resolve against
--            v5.3 or later)
--          - DOMAIN_EVENTS v5.2 (amend-in-place at P-011 — 4 net-new
--            medication_request.* event types + reuse of canonical
--            medication_request.approved.v1 for activation handoff in BOTH
--            execution routes)
--          - Promotion Ledger P-011 entry
--          - WORKLOAD_TAXONOMY v5.2 §2.1 / §2.2 (active levels at v1.0:
--            conversational_assistant [advisory only] / protocol_execution
--            [advisory, suggestion, action_with_confirm])
--          - AUTONOMY_LEVELS v5.2 (action_with_confirm is the single
--            I-012-permitted level at v1.0)
--          - ADR-001 (modular monolith; Med Interaction Engine integration via
--            domain event, NOT a row-level FK)
--          - ADR-023 (multi-tenancy Model A; three-layer RLS)
--          - ADR-029 (AI workload taxonomy; protocol_execution canonical name)
--          - PROJECT_CONVENTIONS r5 §1.1 (composite UNIQUE for FK targets)
--          - PROJECT_CONVENTIONS r5 §1.2 (named constraints)
--          - I-012 (reject-unless three-clause rule for prescribing /
--            refill / medication-order execution)
--          - I-023 / I-027 (RLS + tenant scoping)
--          - migrations/003_rls_helpers.sql (current_tenant_id() helper)
--          - migrations/012_accounts.sql (composite-UNIQUE FK target)
--          - migrations/020_async_consult.sql (composite-UNIQUE FK target)
--          - migrations/024_product_catalog.sql (composite-UNIQUE FK target)
--
-- HISTORY:
--   The original 2026-05-11 ratification attempt of this migration (PR #95;
--   commit 06ba329) was reverted via PR #109 (commit b578fc8) after Codex
--   returned a withdraw-ratification verdict with 5 findings against the SI-001
--   v1.0 ratification. This rewrite incorporates ALL of the corrections that
--   landed in SI-001 v0.13 RATIFIED (the workstream DRAFT closed 20 findings
--   inline across 11 Codex pre-ratification rounds). The full audit trail is in
--   ../Telecheck_SI_Closure_Cycle_2026-05-11/
--   Telecheck_SI_001_MedicationRequest_Schema_DRAFT.md and the spec corpus push
--   at commit 879cd57.
--
-- CRITICAL CORRECTIONS FROM THE REVERTED PR #95 SCAFFOLD:
--   1. NO `interaction_override_id` column. Path 1 ratified at SI-001 v1.0:
--      Med Interaction Engine integration is via the
--      `medication_request.interaction_safety_hold_triggered` domain event;
--      the override workflow + override table belong to the Med Interaction
--      Engine slice with clean module-boundary separation per ADR-001. The
--      reverted scaffold included this column; this version drops it.
--   2. CHECK constraint workload values are the CANONICAL WORKLOAD_TAXONOMY
--      v5.2 active levels: 'conversational_assistant' and 'protocol_execution'
--      (NOT the descriptive 'clinical_assistant_mode_1' /
--      'protocol_execution_mode_2' aliases the original DRAFT proposed, which
--      drove Codex Finding 1 of the withdraw-ratification verdict).
--   3. I-012 envelope CHECK (b) clause restricts the AI-participating
--      EXECUTION path to `ai_workload_type='protocol_execution' AND
--      autonomy_level='action_with_confirm'` ONLY. The
--      `conversational_assistant` branch is excluded by taxonomy:
--      WORKLOAD_TAXONOMY v5.2 §2.1 caps `conversational_assistant` at
--      `autonomy_level_range=[advisory]`, so the `action_with_confirm` pairing
--      is impossible. Mode 1 advice that informed but did not execute a
--      prescribing decision is recorded on the AI session / consult
--      transcript, NOT on the MedicationRequest execution envelope.
--   4. RLS policy uses the canonical `current_tenant_id()` helper from
--      migration 003 (NOT the raw `current_setting('app.tenant_id', true)`
--      pattern — the helper is hardened against the user-settable-session-
--      variable trust-boundary issue).
--
-- PRECONDITIONS:
--   001_tenants.sql       applied (FK target for tenant_id)
--   003_rls_helpers.sql   applied (current_tenant_id())
--   012_accounts.sql      applied (composite FK target for patient + clinician)
--   020_async_consult.sql applied (composite FK target for prescribing_consult_id)
--   024_product_catalog.sql applied (composite FK target for product_catalog_id)
--
-- DOWNSTREAM CONSUMERS:
--   - Pharmacy + Refill Slice (this slice; uses medication_requests as the
--     prescribing-decision aggregate)
--   - Subscription slice (CDM v1.2 §4.7 line 416 prescription_id FK target)
--   - Med Interaction Engine slice (subscribes to
--     medication_request.interaction_safety_hold_triggered for the override
--     loop; owns its own override table)
--   - Adverse Events slice (subscribes to medication_request.discontinued for
--     adverse-event-discontinuation routing)
--   - Notification slice (patient + clinician notifications on lifecycle
--     changes)
--
-- ROLLBACK:
--   migrations/rollback/025_rollback.sql
-- =============================================================================

CREATE TABLE IF NOT EXISTS medication_requests (
    -- Identity
    id                                  VARCHAR(26) PRIMARY KEY,           -- ULID (§2 conventions)
    tenant_id                           VARCHAR(26) NOT NULL REFERENCES tenants(id),

    -- Patient anchor (composite FK enforces same-tenant binding per
    -- PROJECT_CONVENTIONS r5 §1.1 — patient must belong to same tenant)
    patient_account_id                  VARCHAR(26) NOT NULL,

    -- Catalog anchor (composite FK enforces same-tenant binding)
    product_catalog_id                  VARCHAR(26) NOT NULL,
    medication_name                     VARCHAR(200) NOT NULL,             -- denormalized snapshot at prescribe-time
    strength                            VARCHAR(80)  NOT NULL,             -- '500mg', '10mg/ml', etc.
    formulation                         VARCHAR(40)  NOT NULL,             -- 'tablet', 'injection', 'topical', ...

    -- Clinical detail (denormalized snapshot — does NOT mutate when
    -- product_catalog updates; the prescription captures what the clinician
    -- prescribed at decision-time, not what the catalog says today)
    dose_instructions                   TEXT         NOT NULL,             -- '1 tablet twice daily with meals'
    quantity                            INTEGER      NOT NULL,             -- units per dispense
    quantity_unit                       VARCHAR(20)  NOT NULL,             -- 'tablet', 'ml', 'patch', ...
    refills_allowed                     INTEGER      NOT NULL,             -- 0 .. N
    indication                          VARCHAR(200),                      -- clinical indication; nullable
    clinical_notes                      TEXT,                              -- prescriber notes; nullable

    -- Lifecycle status (see State Machines v1.2 §19 — enum is the authoritative
    -- state set: 8 active states + 4 reserved-future transitions documented in
    -- the spec but not in this enum since no implementation exists at v1.0)
    status                              VARCHAR(30)  NOT NULL,

    -- Lifecycle timestamps
    prescribed_at                       TIMESTAMPTZ,                       -- set on draft → active transition
    activated_at                        TIMESTAMPTZ,                       -- alias for prescribed_at retained for clarity
    discontinued_at                     TIMESTAMPTZ,
    discontinued_reason                 VARCHAR(60),                       -- enum below; nullable except when status='discontinued'
    expires_at                          TIMESTAMPTZ,                       -- prescription-validity window end

    -- Authorship (clinician anchor; nullable only while status='draft')
    prescribed_by_clinician_account_id  VARCHAR(26),
    prescribing_consult_id              VARCHAR(26),

    -- Safety integration (Path 1 per SI-001 v1.0 RATIFIED 2026-05-11:
    -- NO `interaction_override_id` column. MedicationRequest emits the
    -- `medication_request.interaction_safety_hold_triggered` domain event when
    -- `interaction_signals_status` flips to 'safety_hold'; the Med Interaction
    -- Engine slice subscribes + owns its own override workflow + override table.
    -- Clean module-boundary separation per ADR-001.)
    interaction_signals_evaluated_at    TIMESTAMPTZ,                       -- last engine evaluation timestamp
    interaction_signals_status          VARCHAR(20)  NOT NULL DEFAULT 'pending',  -- 'pending' | 'clean' | 'caution' | 'safety_hold'

    -- I-012 reject-unless three-clause envelope fields per AUDIT_EVENTS v5.3
    -- §I-012 closure rule (carries forward v5.2 line 66 prose plus P-011
    -- amendment adding prescribing.protocol_authorization_granted; live
    -- emission MUST resolve against v5.3 or later).
    ai_workload_type                    VARCHAR(40),                       -- per WORKLOAD_TAXONOMY v5.2; nullable if no AI participation
    autonomy_level                      VARCHAR(40),                       -- per AUTONOMY_LEVELS v5.2; nullable if no AI participation
    protocol_id                         VARCHAR(26),                       -- when protocol-authorized: which protocol; FK target deferred (protocols entity not yet authored)
    protocol_version                    VARCHAR(20),                       -- frozen protocol version at prescribe-time

    -- Append-only via supersession (discontinuation creates a new
    -- status='discontinued' row with supersedes_id; the original flips to
    -- 'superseded' under hash-chain audit). Same discipline as consent_versions
    -- per Slice 3 PRD v1.0 §7.1.
    supersedes_id                       VARCHAR(26),                       -- self-FK (composite); nullable
    superseded_by_id                    VARCHAR(26),                       -- self-FK (composite); nullable

    -- CCR linkage (denormalized; matches Slice 4 country_of_care threading
    -- rule per Tenant Threading Addendum v1.0 §3.4)
    country_of_care                     CHAR(2)      NOT NULL,             -- ISO 3166-1 alpha-2

    -- Standard timestamps
    created_at                          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at                          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

    -- Composite UNIQUE for downstream composite-FK pattern per
    -- PROJECT_CONVENTIONS r5 §1.1. Used by Subscription
    -- (subscriptions.prescription_id), Refill, Dispensing, etc.
    CONSTRAINT medication_requests_tenant_id_id_unique UNIQUE (tenant_id, id),

    -- Composite FK: patient must belong to same tenant
    CONSTRAINT medication_requests_tenant_patient_fk
        FOREIGN KEY (tenant_id, patient_account_id)
        REFERENCES accounts (tenant_id, account_id),

    -- Composite FK: prescriber (when set) must belong to same tenant
    CONSTRAINT medication_requests_tenant_clinician_fk
        FOREIGN KEY (tenant_id, prescribed_by_clinician_account_id)
        REFERENCES accounts (tenant_id, account_id),

    -- Composite FK: prescribing consult (when set) must belong to same tenant
    CONSTRAINT medication_requests_tenant_consult_fk
        FOREIGN KEY (tenant_id, prescribing_consult_id)
        REFERENCES consults (tenant_id, id),

    -- Composite FK: product catalog item must belong to same tenant
    CONSTRAINT medication_requests_tenant_product_fk
        FOREIGN KEY (tenant_id, product_catalog_id)
        REFERENCES product_catalog (tenant_id, id),

    -- Composite self-FKs for supersession chain
    CONSTRAINT medication_requests_supersedes_fk
        FOREIGN KEY (tenant_id, supersedes_id)
        REFERENCES medication_requests (tenant_id, id),
    CONSTRAINT medication_requests_superseded_by_fk
        FOREIGN KEY (tenant_id, superseded_by_id)
        REFERENCES medication_requests (tenant_id, id),

    -- State enum validation per State Machines v1.2 §19
    CONSTRAINT medication_requests_status_valid CHECK (
        status IN (
            'draft',
            'pending_interaction_check',
            'pending_clinician_review',
            'active',
            'discontinued',
            'superseded',
            'expired',
            'rejected'
        )
    ),

    -- Discontinuation reason enum
    CONSTRAINT medication_requests_discontinued_reason_valid CHECK (
        discontinued_reason IS NULL
        OR discontinued_reason IN (
            'clinical_decision',
            'adverse_event',
            'patient_request',
            'replaced_by_new_prescription',
            'expired',
            'safety_hold'
        )
    ),

    -- Discontinuation reason MUST be set iff status='discontinued'
    CONSTRAINT medication_requests_discontinued_reason_set_when_discontinued CHECK (
        (status = 'discontinued') = (discontinued_reason IS NOT NULL)
    ),

    -- Interaction signals enum validation
    CONSTRAINT medication_requests_interaction_signals_status_valid CHECK (
        interaction_signals_status IN (
            'pending',
            'clean',
            'caution',
            'safety_hold'
        )
    ),

    -- I-012 envelope check per AUDIT_EVENTS v5.3 §I-012 closure rule (carries
    -- forward v5.2 line 66 prose plus P-011 amendment) + INVARIANTS I-012 +
    -- WORKLOAD_TAXONOMY v5.2 §2.1/§2.2:
    --   (1) ai_workload_type must be canonical (WORKLOAD_TAXONOMY v5.2 active
    --       levels at v1.0)
    --   (2) autonomy_level must be 'action_with_confirm' (the single
    --       I-012-permitted level at v1.0)
    --   (3) reserved workload/autonomy values forbidden until ADR-030 +
    --       successor invariant
    --   (4) workload × autonomy compatibility (WORKLOAD_TAXONOMY v5.2):
    --        - conversational_assistant: autonomy_level_range = [advisory] ONLY
    --        - protocol_execution: autonomy_level_range = [advisory,
    --          suggestion, action_with_confirm]
    --       Therefore the AI-participating I-012 EXECUTION path
    --       (autonomy='action_with_confirm') requires
    --       ai_workload_type='protocol_execution'. A 'conversational_assistant'
    --       row at 'action_with_confirm' is impossible by WORKLOAD_TAXONOMY and
    --       MUST be rejected here so a Mode 1 workload cannot be falsely
    --       elevated to execution authority.
    -- State-dependent: status='active' (or post-active) MUST either have both
    -- AI fields null (clinician-only path) OR both populated with canonical
    -- I-012 execution values (AI-participating path = protocol_execution +
    -- action_with_confirm ONLY).
    CONSTRAINT medication_requests_i012_envelope_active_check CHECK (
        -- Pre-active states: AI fields can be null (envelope not yet populated)
        (status NOT IN ('active', 'discontinued', 'superseded', 'expired')
         AND ai_workload_type IS NULL
         AND autonomy_level IS NULL)
        OR
        -- Active and post-active states: I-012 envelope must be valid
        (status IN ('active', 'discontinued', 'superseded', 'expired')
         AND (
            -- (a) Clinician-only path: no AI fields set
            (ai_workload_type IS NULL AND autonomy_level IS NULL)
            OR
            -- (b) AI-participating I-012 EXECUTION path: protocol_execution +
            --     action_with_confirm ONLY. conversational_assistant is
            --     excluded because its taxonomy autonomy_level_range is
            --     [advisory] (per WORKLOAD_TAXONOMY v5.2 §2.1); persisting a
            --     successful prescribing row attributed to
            --     conversational_assistant would defeat the workload × autonomy
            --     compatibility rule.
            (ai_workload_type = 'protocol_execution'
             AND autonomy_level = 'action_with_confirm')
         ))
    ),

    -- Protocol-authorized path: when autonomy_level set, protocol_id +
    -- protocol_version required. This catches Mode 2 protocol-authorized
    -- prescribing rows that lack the protocol-binding evidence.
    CONSTRAINT medication_requests_i012_protocol_binding_check CHECK (
        autonomy_level IS NULL
        OR (autonomy_level = 'action_with_confirm'
            AND protocol_id IS NOT NULL
            AND protocol_version IS NOT NULL)
    ),

    -- Country-of-care must be a valid ISO 3166-1 alpha-2 code
    CONSTRAINT medication_requests_country_valid CHECK (
        country_of_care ~ '^[A-Z]{2}$'
    ),

    -- Basic clinical-validity guards (cheap defense-in-depth; downstream
    -- refill/dispensing/notification slices trust these). Negative dispense
    -- quantities or refill counts indicate corrupt data; the column-level
    -- comment said `0 .. N` but the type didn't enforce it.
    CONSTRAINT medication_requests_quantity_positive CHECK (quantity > 0),
    CONSTRAINT medication_requests_refills_nonnegative CHECK (refills_allowed >= 0),

    -- Status-dependent lifecycle guards. Active and post-active rows MUST
    -- carry a prescriber + a prescribed_at timestamp (the prescribing
    -- decision is by definition made by a named clinician at a known time).
    -- Draft / pending_* / rejected rows may have these unset.
    CONSTRAINT medication_requests_prescriber_set_when_active CHECK (
        status NOT IN ('active', 'discontinued', 'superseded', 'expired')
        OR (
            prescribed_by_clinician_account_id IS NOT NULL
            AND prescribed_at IS NOT NULL
        )
    )
);

-- Indexes for tenant-scoped lookups + supersession-chain traversal
CREATE INDEX IF NOT EXISTS idx_medication_requests_tenant_patient
    ON medication_requests (tenant_id, patient_account_id, status);
CREATE INDEX IF NOT EXISTS idx_medication_requests_tenant_clinician
    ON medication_requests (tenant_id, prescribed_by_clinician_account_id)
    WHERE prescribed_by_clinician_account_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_medication_requests_tenant_consult
    ON medication_requests (tenant_id, prescribing_consult_id)
    WHERE prescribing_consult_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_medication_requests_tenant_status_active
    ON medication_requests (tenant_id, status)
    WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_medication_requests_supersession_chain
    ON medication_requests (tenant_id, supersedes_id)
    WHERE supersedes_id IS NOT NULL;

-- RLS policy: tenant-scoped read+write per ADR-023 + I-023 three-layer
-- enforcement. Uses the canonical `current_tenant_id()` helper from migration
-- 003 (NOT the raw `current_setting('app.tenant_id', true)` pattern — the
-- helper is hardened against the user-settable-session-variable trust-boundary
-- issue, matching the established pattern in migrations 016/020/024).
ALTER TABLE medication_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE medication_requests FORCE ROW LEVEL SECURITY;

CREATE POLICY medication_requests_tenant_isolation
    ON medication_requests
    USING (tenant_id = current_tenant_id())
    WITH CHECK (tenant_id = current_tenant_id());
