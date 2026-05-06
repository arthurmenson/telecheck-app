-- =============================================================================
-- File:    migrations/020_async_consult.sql
-- Purpose: Async Consult slice tables — `consults` + `consult_events`.
--          Implements the Sprint 9 / TLC-021a v0.1 placeholder schema per
--          the Async Consult Slice PRD v1.0 + State Machines v1.1 §3.
--
-- Spec:    - Async Consult Slice PRD v1.0
--          - State Machines v1.1 §3 (canonical state inventory of 17 states;
--            SOURCE OF TRUTH per CLAUDE.md hard rule "Slice PRD vs State
--            Machines v1.1 → State Machines wins")
--          - CDM v1.2 §3 entities #15 (Consult) + #16 (ConsultEvent)
--          - ADR-001 (modular monolith)
--          - ADR-012 (async ↔ sync conversion)
--          - I-023 / I-027 (RLS + tenant scoping)
--
-- v0.1 PLACEHOLDER SCHEMA POSTURE (per SI-005):
--   CDM v1.2 §4 row-shape expansion does NOT exist for Consult / ConsultEvent
--   (only §3 entity inventory names them at L84-85). This migration ships
--   minimal-viable columns to support Sprint 9-implemented transitions
--   (1-6 + 16 per State Machines §3). Each column carries a SQL comment
--   pointing to SI-005 as the resume gate.
--
--   When SI-005 closes, CDM §4 expansion will canonicalize the column set
--   and a follow-on ALTER migration will adjust placeholders to ratified
--   form. See `docs/SI-005-Consult-ConsultEvent-Schema-Gap.md`.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- PRECONDITIONS:
--   001_tenants.sql       applied (FK target for tenant_id)
--   003_rls_helpers.sql   applied (current_tenant_id() function)
--   012_accounts.sql      applied (FK target for patient_id;
--                                  accounts.id is the operator-facing
--                                  patient identifier per CDM §4.6 / Identity
--                                  Slice PRD)
-- ---------------------------------------------------------------------------

-- =============================================================================
-- TABLE 1: consults
-- The patient's consult instance — async or sync per ADR-012 (modality
-- column distinguishes; ADR-012 conversion changes the value mid-lifecycle).
-- State machine governs lifecycle per State Machines v1.1 §3.
--
-- v0.1 placeholder column set per SI-005; minimal-viable for Sprint 9
-- transitions 1-6 + 16. Sprint 10 + later sprints add columns for
-- clinician-decision branches (transitions 9-15) under a separate
-- migration with paired rollback.
-- =============================================================================

CREATE TABLE IF NOT EXISTS consults (

    id                                  VARCHAR(26) PRIMARY KEY,

    -- v0.1 placeholder columns; SI-005 resume gate
    -- See docs/SI-005-Consult-ConsultEvent-Schema-Gap.md
    tenant_id                           TEXT        NOT NULL REFERENCES tenants(id),

    -- patient_id references the patient's Account row (per CDM §4.6 /
    -- Identity Slice PRD); operator-facing identifier. Not nullable —
    -- every consult is tied to a patient.
    --
    -- Composite FK against (accounts.tenant_id, accounts.account_id) —
    -- per Codex async-consult-r1 HIGH closure 2026-05-05. Enforces at
    -- the DB layer that a consult can only be created against a patient
    -- in the SAME tenant; prevents cross-tenant patient binding even
    -- when the cross-tenant attacker knows a patient_id from another
    -- tenant. accounts has the matching UNIQUE (tenant_id, account_id)
    -- per migration 012:181 explicitly added "for downstream composite-
    -- FK pattern" — this is exactly that pattern in use.
    patient_id                          VARCHAR(26) NOT NULL,

    -- Consult type discriminator per PRD §1 / §2:
    --   'program' — patient selected a specific program from the catalog
    --               (e.g., GLP-1 weight management)
    --   'general' — open-ended async consult, no program-specific protocol
    consult_type                        VARCHAR(50) NOT NULL
                                            CHECK (consult_type IN ('program', 'general')),

    -- Modality per ADR-012:
    --   'async' — initiated as asynchronous; may convert to sync mid-lifecycle
    --   'sync'  — initiated as synchronous video consult
    -- Sprint 9 implements async only; sync conversion lands Sprint 10+.
    modality                            VARCHAR(20) NOT NULL DEFAULT 'async'
                                            CHECK (modality IN ('async', 'sync')),

    -- State per State Machines v1.1 §3 (canonical 17-state inventory).
    -- The CHECK enforces the canonical vocabulary at the DB layer (defense
    -- in depth alongside the application-layer state machine). Order
    -- matches src/modules/async-consult/internal/types.ts:CONSULT_STATES.
    state                               VARCHAR(30) NOT NULL DEFAULT 'INITIATED'
                                            CHECK (state IN (
                                                'INITIATED',
                                                'INTAKE',
                                                'ABANDONED',
                                                'SUBMITTED',
                                                'PROCESSING',
                                                'QUEUED',
                                                'UNDER_REVIEW',
                                                'PRESCRIBED',
                                                'ADVISED',
                                                'AWAITING_DATA',
                                                'ESCALATED_TO_SYNC',
                                                'DECLINED',
                                                'REFERRED',
                                                'FOLLOW_UP',
                                                'COMPLETED',
                                                'EXPIRED',
                                                'CLOSED'
                                            )),

    -- Cross-slice foreign keys per PRD §15 (nullable until populated).
    -- v0.1 placeholder columns; SI-005 resume gate

    -- Program Catalog dependency: nullable for general consults; populated
    -- at INITIATED → INTAKE transition for program consults. CDM §4.8
    -- ProductCatalog is canonical; this column ships as VARCHAR(26) with
    -- no FK constraint until that linkage is confirmed at SI-005 closure.
    current_program_catalog_entry_id    VARCHAR(26) NULL,

    -- Forms-Intake dependency: populated at INTAKE → SUBMITTED transition.
    -- References forms_submission per migration 006 (forms-intake
    -- submission table). The forms_submission PK is `submission_id`.
    --
    -- Composite FK against (forms_submission.tenant_id,
    -- forms_submission.submission_id) — per Codex async-consult-r1
    -- MEDIUM closure 2026-05-05. Enforces at the DB layer that a
    -- consult can only reference an intake submission in the SAME
    -- tenant. forms_submission has the matching UNIQUE constraint
    -- per migration 006:503.
    intake_form_submission_id           VARCHAR(26) NULL,

    created_at                          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at                          TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- Composite UNIQUE per Codex async-consult-r1 HIGH closure 2026-05-05.
    -- Enables consult_events.consult_id composite FK against
    -- (consults.tenant_id, consults.id) so events cannot reference a
    -- consult from a different tenant even if the consult's id is known.
    -- Mirror of the migration 012:181 "downstream composite-FK pattern".
    --
    -- Constraint NAMED to match migration 021's idempotent ADD CONSTRAINT
    -- per Codex async-consult-r3 HIGH closure 2026-05-05 — so rollback
    -- 021_rollback.sql can drop by the same name across both apply paths
    -- (fresh-DB inline + upgraded-DB ALTER).
    CONSTRAINT consults_tenant_id_id_unique UNIQUE (tenant_id, id),

    -- Composite FK on patient ownership (cross-tenant patient binding
    -- prevention). NAMED per Codex async-consult-r3 HIGH closure.
    CONSTRAINT consults_tenant_patient_fk
        FOREIGN KEY (tenant_id, patient_id)
        REFERENCES accounts (tenant_id, account_id),

    -- Composite FK on intake form submission (cross-tenant intake
    -- binding prevention; nullable so applies only when populated at
    -- the INTAKE → SUBMITTED transition). NAMED per Codex
    -- async-consult-r3 HIGH closure.
    CONSTRAINT consults_tenant_intake_fk
        FOREIGN KEY (tenant_id, intake_form_submission_id)
        REFERENCES forms_submission (tenant_id, submission_id)
);

CREATE INDEX IF NOT EXISTS idx_consults_tenant
    ON consults (tenant_id);
CREATE INDEX IF NOT EXISTS idx_consults_tenant_patient
    ON consults (tenant_id, patient_id);
CREATE INDEX IF NOT EXISTS idx_consults_tenant_state
    ON consults (tenant_id, state);

-- updated_at trigger using clock_timestamp() (mirrors migration 019 pattern)
CREATE OR REPLACE FUNCTION consults_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = clock_timestamp();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS consults_updated_at ON consults;
CREATE TRIGGER consults_updated_at
    BEFORE UPDATE ON consults
    FOR EACH ROW EXECUTE FUNCTION consults_set_updated_at();

-- RLS: tenant-scoped per I-023 / I-027 + ADR-023.
-- Standard `tenant_isolation` policy name (matches the 19 other
-- tenant-scoped tables; see tests/contracts/rls-policy-coverage-lockdown.test.ts
-- §1 inventory).
ALTER TABLE consults ENABLE ROW LEVEL SECURITY;
ALTER TABLE consults FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON consults
    USING (tenant_id = current_tenant_id())
    WITH CHECK (tenant_id = current_tenant_id());

-- =============================================================================
-- TABLE 2: consult_events
-- State transitions + audit-emit-adjacent events on a consult per CDM v1.2
-- §3 entity #16. Each event row is append-only at the application layer
-- (no UPDATE / DELETE in service code) — this complements I-003 audit
-- chain integrity for the Consult lifecycle specifically.
--
-- v0.1 placeholder column set per SI-005.
-- =============================================================================

CREATE TABLE IF NOT EXISTS consult_events (

    id          VARCHAR(26)  PRIMARY KEY,

    -- v0.1 placeholder columns; SI-005 resume gate

    -- consult_id references the parent consult.
    --
    -- Composite FK (tenant_id, consult_id) → consults (tenant_id, id)
    -- per Codex async-consult-r1 HIGH closure 2026-05-05. Without the
    -- composite FK, a tenant-A insert could write a consult_event
    -- referencing tenant-B's consult by knowing the consult id — RLS
    -- on consult_events.tenant_id would still pass, corrupting the
    -- consult lifecycle history. Composite FK makes this structurally
    -- impossible at the DB layer.
    consult_id  VARCHAR(26)  NOT NULL,

    -- Denormalized tenant_id for RLS scoping (avoids cross-table join in
    -- policy expression). The composite FK below structurally enforces
    -- that this matches the parent consult's tenant_id — defense in
    -- depth alongside the application layer + RLS WITH CHECK.
    tenant_id   TEXT         NOT NULL REFERENCES tenants(id),

    -- Event discriminator. Sprint 9 emits:
    --   'state_transition' — consult moved from one state to another
    -- Sprint 10+ may add types for ai-prep, clinician-decision, etc.
    event_type  VARCHAR(80)  NOT NULL
                    CHECK (event_type IN ('state_transition')),

    -- For state_transition events, both populated. Nullable to support
    -- future event types that aren't transitions.
    from_state  VARCHAR(30)  NULL,
    to_state    VARCHAR(30)  NULL,

    -- Actor that triggered the event. Nullable for system-generated events
    -- (e.g., scheduled `expire` transition at 14d). For user-triggered
    -- events, references either accounts(id) (patient) or tenant_users(id)
    -- (clinician/operator) — the application layer disambiguates via
    -- audit chain context.
    actor_id    VARCHAR(26)  NULL,

    -- Event-type-specific detail. For state_transition events, the
    -- application layer writes nothing here today (state values are in
    -- from_state / to_state); reserved for Sprint 10+ when richer events
    -- need structured detail.
    metadata    JSONB        NULL,

    created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

    -- Composite FK enforces same-tenant relationship to the parent
    -- consult (Codex async-consult-r1 HIGH closure 2026-05-05).
    --
    -- NAMED per Codex async-consult-r3 HIGH closure 2026-05-05 — so
    -- rollback 021_rollback.sql can drop by the same name across both
    -- apply paths (fresh-DB inline + upgraded-DB ALTER).
    CONSTRAINT consult_events_tenant_consult_fk
        FOREIGN KEY (tenant_id, consult_id) REFERENCES consults (tenant_id, id)
);

CREATE INDEX IF NOT EXISTS idx_consult_events_consult
    ON consult_events (consult_id);
CREATE INDEX IF NOT EXISTS idx_consult_events_tenant
    ON consult_events (tenant_id);
CREATE INDEX IF NOT EXISTS idx_consult_events_tenant_consult_created
    ON consult_events (tenant_id, consult_id, created_at);

-- RLS: tenant-scoped per I-023.
ALTER TABLE consult_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE consult_events FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON consult_events
    USING (tenant_id = current_tenant_id())
    WITH CHECK (tenant_id = current_tenant_id());

-- =============================================================================
-- Migration 020 complete. consults + consult_events placeholder schema
-- ready for Sprint 9 / TLC-021b repos + TLC-021c state-machine wiring.
-- =============================================================================
