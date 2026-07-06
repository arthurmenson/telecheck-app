-- =============================================================================
-- File:    migrations/060_pharmacy_refill_entities.sql
-- Purpose: Refill sub-slice DB layer — `refills`, `dispensings`, `shipments`
--          entities per SI-007 v0.19 (RATIFIED 2026-07-06, Promotion Ledger
--          P-046; the SI's historical P-013 target resolves to P-046).
--          Closes the final 8% of the Pharmacy + Refill slice at the schema
--          layer (CDM §4.17 Refill / §4.18 Dispensing / §4.19 Shipment;
--          entities #19 / #20 / #21 in CDM §3.5 Pharmacy & Fulfillment).
--
-- Spec:    - docs/SI-007-Refill-Dispensing-Shipment-Schema-Gap.md v0.19
--            (RATIFIED content: 3 entity schemas + state machines +
--            allowed-transition tables + cross-entity handoff rules +
--            tenant-scoped composite FK invariant per Codex R18 closure)
--          - State Machines §2 (Refill) + §5 (Pharmacy Fulfillment) —
--            canonical; the SI splits §5 ownership: Dispensing owns
--            QUEUED→RELEASED, Shipment owns PENDING_CARRIER_PICKUP→terminal
--          - Pharmacy + Refill Slice PRD v2.1 §9 / §12 / §13 / §15
--          - ADR-001 (module boundary), ADR-008 (bridge supply),
--            ADR-023 (multi-tenancy Model A), ADR-024 (adapter selection)
--          - I-012, I-023..I-027
--          - PROJECT_CONVENTIONS r5 §1.1 (composite UNIQUE + composite FK)
--          - migrations/025_medication_requests.sql (SI-001 sibling; the
--            §4.16 precedent this SI extends)
--          - migrations/056_async_consult_entities.sql (newest entities
--            pattern: Option-2 conventions, RLS ENABLE+FORCE, verification)
--
-- Option 2 adaptations from spec (recorded divergences; same class as the
-- migration 033/040/047/056 recorded divergences):
--   - id ULID → VARCHAR(26), app-generated (no DB default; no canonical
--     TYPES prefix is defined for Refill/Dispensing/Shipment ids at v0.19 —
--     plain 26-char ULID per the 056 convention. medication_request_id
--     references keep VARCHAR(30) to carry the canonical mrx_<ULID> shape
--     from migration 025.)
--   - tenant_id → TEXT NOT NULL REFERENCES tenants(id) (056 convention).
--   - RLS: current_tenant_id() (migration 003 helper) with USING + WITH
--     CHECK; policy name `tenant_isolation` (default convention).
--   - `refills.subscription_id` → VARCHAR(26) NULL, NO FK. The Subscription
--     slice's canonical `subscriptions` table does not exist in this repo
--     yet. DEFERRED-FK TODO: add composite FK
--     (tenant_id, subscription_id) REFERENCES subscriptions (tenant_id, id)
--     when the Subscription slice lands (same class as 056's
--     payment_intent_id deferred FK). The SI's subscription-consistency
--     trigger (refill's medication_request must match the subscription's
--     medication_request) is deferred with it — it reads `subscriptions`.
--     Repo/service layer enforces tenant + linkage coherence until then.
--   - `shipments.pickup_location_id` → VARCHAR(26) NULL, NO FK. The
--     `pharmacy_locations` table does not exist in this repo yet.
--     DEFERRED-FK TODO: composite FK when the pharmacy-locations entity
--     lands. The §4.19 mode CHECK constraints (presence/absence per
--     delivery_preference) are enforced now regardless.
--   - `shipments.delivery_proof_artifact_id` → VARCHAR(26) NULL, NO FK.
--     The `attachments` entity does not exist in this repo yet.
--     DEFERRED-FK TODO when the attachments slice lands.
--   - Append-only-on-business-final: SI-007 specifies repository-layer
--     enforcement (`UPDATE ... WHERE state NOT IN (<append_only_set>)`
--     guards per the TLC-055 state-machine.ts precedent). This migration
--     ADDS defense-in-depth BEFORE UPDATE triggers that reject UPDATEs when
--     OLD.state is in each table's business-final set, plus BEFORE DELETE
--     block triggers (fulfillment/clinical records are never deleted).
--     This enforces exactly the SI's declared invariant at the DB layer —
--     it does not alter the state machines. State-TRANSITION validity
--     (allowed-transition tables) remains service-layer per the SI note,
--     matching the TLC-055 medication_requests precedent.
--   - I-012 `audit_i012_workload_evidence_required` CHECK amendment: the
--     SI targets the spec-corpus CDM's audit CHECK constraint. NO such
--     CHECK exists in this code repo's migration chain (verified: the only
--     reference is the SI doc itself). This repo's established I-012
--     enforcement is (a) per-entity envelope CHECKs (migration 025
--     medication_requests_i012_envelope_active_check) and (b) handler-layer
--     audit-envelope validation (audit-emission discipline). Refill carries
--     NO ai_workload_type / autonomy_level columns per SI §4.17 —
--     `decision_pathway` is the discriminator — so the I-012 evidence rule
--     for the new refill.{clinician_approved, protocol_approved,
--     bridge_supply_dispensed, execution_rejected} audit actions is
--     HANDLER-LAYER enforcement, landing with the refill service/handlers
--     PRs. Recorded here per the SI-to-repo adaptation discipline.
--   - `refills.discontinued_reason` → TEXT NULL, NO CHECK. SI §4.17 lists
--     it as "(nullable enum)" without enumerating the domain. Recorded as
--     an open question; the CHECK lands when the enum is enumerated
--     spec-side. (Not to be confused with medication_requests'
--     discontinued_reason, whose domain IS enumerated.)
--   - No wrapper-role grants: the Pharmacy slice follows the TLC-055
--     direct repository-write pattern (migration 025 precedent), not the
--     SECURITY DEFINER wrapper-procedure pattern of the Crisis/Admin/
--     Med-Int/Async-Consult slices. Writes are app-layer, RLS-scoped.
--   - §0 fix-forward: `adapter_configs` (migration 019) lacks the
--     UNIQUE (tenant_id, id) composite FK target required by the SI's
--     composite-FK invariant table (pharmacy_adapter_id / compounding_lab_id
--     / carrier_id). Added here, additive-only (trivially satisfiable —
--     id is already the PK). Same fix-forward class as migration 021.
--     The SI's pre-ratification flag anticipated exactly this verification.
--
-- Preconditions: migrations 000–059 applied. FK targets: tenants (001),
-- accounts (012, UNIQUE (tenant_id, account_id)), adapter_configs (019 +
-- §0 below), medication_requests (025, UNIQUE (tenant_id, id)).
--
-- Invariants: I-023 (tenant isolation; composite tenant-scoped FKs per SI
-- v0.19 R18 closure — plain single-column FKs FORBIDDEN for tenant-owned
-- references), I-012 (handler-layer per adaptation note above), I-027
-- (audit tenancy — handler layer).
--
-- ROLLBACK: migrations/rollback/060_rollback.sql
-- =============================================================================

-- =============================================================================
-- §0 — Composite-FK target fix-forward on adapter_configs
--      (SI-007 v0.19 pre-ratification flag: "subscriptions / accounts /
--      adapter_configs / pharmacy_locations need verification". Verified:
--      accounts has uq_account_tenant_id; medication_requests has
--      medication_requests_tenant_id_id_unique; adapter_configs LACKS the
--      composite UNIQUE — added here; subscriptions + pharmacy_locations
--      do not exist — their FKs are deferred per the header notes.)
-- =============================================================================

ALTER TABLE adapter_configs
    ADD CONSTRAINT adapter_configs_tenant_id_id_unique UNIQUE (tenant_id, id);

-- =============================================================================
-- §1 — refills (CDM §4.17; entity #19; SI-007 v0.19)
--
-- Patient-facing refill lifecycle per State Machines §2 (+ SI-007 v0.4/v0.6
-- additions: CANCELLED, EXPIRED). `state` is a STORED column (mutable row;
-- NOT the Option-A derived-state pattern) per the SI's explicit design —
-- state-transition guards live in the service layer per TLC-055 precedent.
-- Fulfillment linkage is child→parent ONLY: refills carries NO dispensing_id
-- / shipment_id FK (Codex R1 closure; dispensings.refill_id is authoritative).
-- =============================================================================

CREATE TABLE refills (
    id                                  VARCHAR(26)  PRIMARY KEY,
    tenant_id                           TEXT         NOT NULL REFERENCES tenants(id),

    -- Patient anchor
    patient_account_id                  VARCHAR(26)  NOT NULL,

    -- Source link — the canonical authorization source (mrx_<ULID> shape
    -- from migration 025; hence VARCHAR(30))
    medication_request_id               VARCHAR(30)  NOT NULL,

    -- Subscription link — set when auto-initiated by the subscription
    -- engine per Slice PRD §9.1. DEFERRED-FK TODO (Subscription slice):
    -- composite FK to subscriptions (tenant_id, id) when that entity lands.
    subscription_id                     VARCHAR(26),

    -- Initiation (Slice PRD §9.1 five initiation paths)
    initiated_by                        VARCHAR(30)  NOT NULL,

    -- Lifecycle (State Machines §2 + SI-007 CANCELLED/EXPIRED additions)
    state                               VARCHAR(30)  NOT NULL,

    -- Decision authorship
    decided_by_clinician_account_id     VARCHAR(26),
    protocol_id                         VARCHAR(26),               -- FK target deferred (protocols entity not yet authored; migration 025 precedent)
    protocol_version                    VARCHAR(20),

    -- Decision pathway — discriminator for the audit envelope's I-012
    -- evidence rule (matches MedicationRequest §4.16 approval_pathway
    -- convention). Nullable until a decision is reached.
    decision_pathway                    VARCHAR(40),

    -- Safety integration (Path 1 per SI-007 §4.17: NO interaction_override_id
    -- column; Med Interaction Engine integration is via the
    -- refill.interaction_safety_hold_triggered domain event per ADR-001)
    interaction_signals_evaluated_at    TIMESTAMPTZ,
    interaction_signals_status          VARCHAR(20),               -- NULL until the engine writes back

    -- Pre-auth tracking (Slice PRD §9.3 medication-class table)
    preauth_window_class                VARCHAR(30),
    preauth_renewals_remaining          INTEGER,

    -- Delivery preference
    delivery_preference                 VARCHAR(10)  NOT NULL,

    -- Bridge supply (ADR-008)
    is_bridge_supply                    BOOLEAN      NOT NULL DEFAULT FALSE,
    bridge_supply_reason                VARCHAR(40),

    -- Lifecycle timestamps (SI §4.17)
    requested_at                        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    eligible_at                         TIMESTAMPTZ,
    approved_at                         TIMESTAMPTZ,
    dispatched_at                       TIMESTAMPTZ,
    delivered_at                        TIMESTAMPTZ,
    completed_at                        TIMESTAMPTZ,
    cancelled_at                        TIMESTAMPTZ,
    discontinued_reason                 TEXT,                      -- enum domain NOT enumerated at SI v0.19; no CHECK (header note)

    -- CCR linkage (denormalized per Slice PRD §4 threading rule)
    country_of_care                     CHAR(2)      NOT NULL,

    -- Standard timestamps (migration 025 convention)
    created_at                          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at                          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

    -- Composite UNIQUE for downstream composite-FK pattern
    -- (PROJECT_CONVENTIONS r5 §1.1; SI v0.19 composite-FK invariant)
    CONSTRAINT refills_tenant_id_id_unique UNIQUE (tenant_id, id),

    -- Tenant-scoped composite FKs (SI v0.19 R18 closure — plain
    -- single-column FKs forbidden for tenant-owned references)
    CONSTRAINT refills_tenant_patient_fk
        FOREIGN KEY (tenant_id, patient_account_id)
        REFERENCES accounts (tenant_id, account_id),
    CONSTRAINT refills_tenant_medication_request_fk
        FOREIGN KEY (tenant_id, medication_request_id)
        REFERENCES medication_requests (tenant_id, id),
    CONSTRAINT refills_tenant_clinician_fk
        FOREIGN KEY (tenant_id, decided_by_clinician_account_id)
        REFERENCES accounts (tenant_id, account_id),

    -- State enum per State Machines §2 + SI-007 v0.19 (23 states)
    CONSTRAINT refills_state_valid CHECK (
        state IN (
            'REQUESTED', 'VERIFYING', 'ELIGIBLE', 'INELIGIBLE', 'CHECKING',
            'REVIEWED', 'CLINICIAN_REVIEW', 'PROTOCOL_EVALUATION', 'APPROVED',
            'DECLINED', 'FULFILLING', 'READY', 'DELIVERING', 'PICKUP_AVAILABLE',
            'DELIVERED', 'PICKED_UP', 'COMPLETED', 'DELIVERY_FAILED',
            'EXCEPTION', 'ESCALATED', 'SAFETY_HOLD', 'CANCELLED', 'EXPIRED'
        )
    ),

    -- Initiation enum (Slice PRD §9.1)
    CONSTRAINT refills_initiated_by_valid CHECK (
        initiated_by IN ('patient', 'subscription_engine', 'ai_mode_1', 'delegate', 'clinician')
    ),

    -- Decision pathway enum (SI §4.17)
    CONSTRAINT refills_decision_pathway_valid CHECK (
        decision_pathway IS NULL
        OR decision_pathway IN (
            'clinician_reviewed', 'protocol_authorized', 'bridge_supply_consent_revocation'
        )
    ),

    -- Decision-pathway ↔ authorship consistency (SI §4.17 prose:
    -- decided_by_clinician_account_id populated on the CLINICIAN_REVIEW
    -- path; protocol_id + protocol_version populated on the
    -- PROTOCOL_EVALUATION path)
    CONSTRAINT refills_clinician_pathway_authorship CHECK (
        decision_pathway IS DISTINCT FROM 'clinician_reviewed'
        OR decided_by_clinician_account_id IS NOT NULL
    ),
    CONSTRAINT refills_protocol_pathway_binding CHECK (
        decision_pathway IS DISTINCT FROM 'protocol_authorized'
        OR (protocol_id IS NOT NULL AND protocol_version IS NOT NULL)
    ),

    -- Protocol binding together-or-neither (migration 025 §4.16 convention)
    CONSTRAINT refills_protocol_binding_pair_check CHECK (
        (protocol_id IS NULL AND protocol_version IS NULL)
        OR (protocol_id IS NOT NULL AND protocol_version IS NOT NULL)
    ),

    -- Interaction signals enum (SI §4.17: clean | caution | safety_hold;
    -- NULL until evaluated — note the domain differs from
    -- medication_requests, which carries an explicit 'pending')
    CONSTRAINT refills_interaction_signals_status_valid CHECK (
        interaction_signals_status IS NULL
        OR interaction_signals_status IN ('clean', 'caution', 'safety_hold')
    ),

    -- Pre-auth window class enum (Slice PRD §9.3)
    CONSTRAINT refills_preauth_window_class_valid CHECK (
        preauth_window_class IS NULL
        OR preauth_window_class IN (
            'stable_chronic', 'glp1', 'ed', 'hair_loss', 'topical_rx',
            'new_medication', 'controlled_iii_v'
        )
    ),
    CONSTRAINT refills_preauth_renewals_nonnegative CHECK (
        preauth_renewals_remaining IS NULL OR preauth_renewals_remaining >= 0
    ),

    -- Delivery preference enum
    CONSTRAINT refills_delivery_preference_valid CHECK (
        delivery_preference IN ('delivery', 'pickup')
    ),

    -- Bridge supply reason enum + presence rule (SI cross-entity CHECK:
    -- is_bridge_supply = TRUE ⟹ bridge_supply_reason IS NOT NULL)
    CONSTRAINT refills_bridge_supply_reason_valid CHECK (
        bridge_supply_reason IS NULL
        OR bridge_supply_reason IN ('consent_revocation', 'abrupt_discontinuation_risk')
    ),
    CONSTRAINT refills_bridge_supply_reason_required CHECK (
        is_bridge_supply = FALSE OR bridge_supply_reason IS NOT NULL
    ),

    -- Country-of-care ISO 3166-1 alpha-2 (migration 025 convention)
    CONSTRAINT refills_country_valid CHECK (country_of_care ~ '^[A-Z]{2}$')
);

CREATE INDEX idx_refills_tenant_patient
    ON refills (tenant_id, patient_account_id, state);
CREATE INDEX idx_refills_tenant_medication_request
    ON refills (tenant_id, medication_request_id);
CREATE INDEX idx_refills_tenant_subscription
    ON refills (tenant_id, subscription_id)
    WHERE subscription_id IS NOT NULL;
CREATE INDEX idx_refills_tenant_state
    ON refills (tenant_id, state);

ALTER TABLE refills ENABLE ROW LEVEL SECURITY;
ALTER TABLE refills FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON refills
    USING     (tenant_id = current_tenant_id())
    WITH CHECK (tenant_id = current_tenant_id());

-- Business-final append-only guard (SI consolidated set:
-- {COMPLETED, INELIGIBLE, DECLINED, CANCELLED, EXPIRED}) + no-DELETE.
-- Defense-in-depth for the repository-layer guards per the header note.
CREATE OR REPLACE FUNCTION refills_block_terminal_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION
            'refills rows are never deleted (fulfillment/clinical record; '
            'SI-007 append-only discipline). DELETE is permanently prohibited.';
    END IF;
    IF OLD.state IN ('COMPLETED', 'INELIGIBLE', 'DECLINED', 'CANCELLED', 'EXPIRED') THEN
        RAISE EXCEPTION
            'refills row in business-final state % is append-only per SI-007 '
            '(P-046); corrections require a fresh Refill row (or a superseding '
            'MedicationRequest). UPDATE rejected.', OLD.state
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER refills_block_terminal_update
    BEFORE UPDATE ON refills
    FOR EACH ROW
    EXECUTE FUNCTION refills_block_terminal_mutation();

CREATE TRIGGER refills_block_delete
    BEFORE DELETE ON refills
    FOR EACH ROW
    EXECUTE FUNCTION refills_block_terminal_mutation();

-- =============================================================================
-- §2 — dispensings (CDM §4.18; entity #20; SI-007 v0.19)
--
-- Pharmacist-side fulfillment lifecycle (State Machines §5 QUEUED→RELEASED
-- ownership per Codex R2 closure; post-RELEASED progress is recorded on
-- shipments per the handoff rule). Child holds the authoritative source
-- link: refill_id XOR medication_request_id (Codex R1 + R3 closures).
-- =============================================================================

CREATE TABLE dispensings (
    id                                  VARCHAR(26)  PRIMARY KEY,
    tenant_id                           TEXT         NOT NULL REFERENCES tenants(id),

    -- Source link — exactly one of the two (XOR CHECK below). Both columns
    -- individually nullable per Codex R3 closure.
    refill_id                           VARCHAR(26),
    medication_request_id               VARCHAR(30),

    -- Pharmacy partner (ADR-024 adapter selection; Slice PRD §6)
    pharmacy_adapter_id                 VARCHAR(26)  NOT NULL,

    -- Pharmacy actor (set on RELEASE_CHECK)
    pharmacist_account_id               VARCHAR(26),
    pharmacist_release_check_passed_at  TIMESTAMPTZ,

    -- Lifecycle (State Machines §5 pharmacist-side ownership + SI-007 v0.6
    -- CANCELLED addition)
    state                               VARCHAR(30)  NOT NULL,

    -- Exception tracking
    exception_type                      VARCHAR(30),
    exception_resolution                VARCHAR(30),

    -- Inventory awareness (Slice PRD §13)
    in_stock_status                     VARCHAR(30),

    -- Compounding (Slice PRD §14)
    is_compounded                       BOOLEAN      NOT NULL DEFAULT FALSE,
    compounding_lab_id                  VARCHAR(26),

    -- Lifecycle timestamps (SI §4.18)
    queued_at                           TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    claimed_at                          TIMESTAMPTZ,
    fulfilled_at                        TIMESTAMPTZ,
    released_at                         TIMESTAMPTZ,
    dispatched_at                       TIMESTAMPTZ,

    -- CCR linkage
    country_of_care                     CHAR(2)      NOT NULL,

    -- Standard timestamps
    created_at                          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at                          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

    CONSTRAINT dispensings_tenant_id_id_unique UNIQUE (tenant_id, id),

    -- Tenant-scoped composite FKs (SI v0.19 R18 closure)
    CONSTRAINT dispensings_tenant_refill_fk
        FOREIGN KEY (tenant_id, refill_id)
        REFERENCES refills (tenant_id, id),
    CONSTRAINT dispensings_tenant_medication_request_fk
        FOREIGN KEY (tenant_id, medication_request_id)
        REFERENCES medication_requests (tenant_id, id),
    CONSTRAINT dispensings_tenant_pharmacy_adapter_fk
        FOREIGN KEY (tenant_id, pharmacy_adapter_id)
        REFERENCES adapter_configs (tenant_id, id),
    CONSTRAINT dispensings_tenant_pharmacist_fk
        FOREIGN KEY (tenant_id, pharmacist_account_id)
        REFERENCES accounts (tenant_id, account_id),
    CONSTRAINT dispensings_tenant_compounding_lab_fk
        FOREIGN KEY (tenant_id, compounding_lab_id)
        REFERENCES adapter_configs (tenant_id, id),

    -- Source XOR — exactly one non-null (SI cross-entity CHECK, verbatim)
    CONSTRAINT dispensings_source_xor CHECK (
        (refill_id IS NOT NULL)::int + (medication_request_id IS NOT NULL)::int = 1
    ),

    -- State enum (State Machines §5 QUEUED→RELEASED + recovery states +
    -- SI-007 v0.6 CANCELLED; post-RELEASED tail is owned by shipments)
    CONSTRAINT dispensings_state_valid CHECK (
        state IN (
            'QUEUED', 'CLAIMED', 'FULFILLING', 'RELEASE_CHECK', 'RELEASED',
            'EXCEPTION', 'HELD', 'ESCALATED', 'CANCELLED'
        )
    ),

    -- Exception enums (SI §4.18)
    CONSTRAINT dispensings_exception_type_valid CHECK (
        exception_type IS NULL
        OR exception_type IN ('stock_out', 'substitution', 'cold_chain', 'counterfeit_flag', 'other')
    ),
    CONSTRAINT dispensings_exception_resolution_valid CHECK (
        exception_resolution IS NULL
        OR exception_resolution IN ('resubstituted', 'escalated', 'cancelled')
    ),

    -- Inventory awareness enum (Slice PRD §13)
    CONSTRAINT dispensings_in_stock_status_valid CHECK (
        in_stock_status IS NULL
        OR in_stock_status IN ('in_stock', 'out_of_stock_resubbed', 'out_of_stock_cancelled')
    ),

    CONSTRAINT dispensings_country_valid CHECK (country_of_care ~ '^[A-Z]{2}$')
);

-- One dispensing per upstream source (SI partial UNIQUEs, verbatim)
CREATE UNIQUE INDEX uq_dispensings_tenant_refill
    ON dispensings (tenant_id, refill_id)
    WHERE refill_id IS NOT NULL;
CREATE UNIQUE INDEX uq_dispensings_tenant_medication_request
    ON dispensings (tenant_id, medication_request_id)
    WHERE medication_request_id IS NOT NULL;

CREATE INDEX idx_dispensings_tenant_state
    ON dispensings (tenant_id, state);
CREATE INDEX idx_dispensings_tenant_adapter
    ON dispensings (tenant_id, pharmacy_adapter_id);
CREATE INDEX idx_dispensings_tenant_pharmacist
    ON dispensings (tenant_id, pharmacist_account_id)
    WHERE pharmacist_account_id IS NOT NULL;

ALTER TABLE dispensings ENABLE ROW LEVEL SECURITY;
ALTER TABLE dispensings FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON dispensings
    USING     (tenant_id = current_tenant_id())
    WITH CHECK (tenant_id = current_tenant_id());

-- Append-only at {RELEASED, CANCELLED} (SI consolidated set: once the
-- pharmacist releases, subsequent lifecycle progress is recorded on the
-- shipments row — there IS no downstream dispensing state) + no-DELETE.
CREATE OR REPLACE FUNCTION dispensings_block_terminal_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION
            'dispensings rows are never deleted (fulfillment record; SI-007 '
            'append-only discipline). DELETE is permanently prohibited.';
    END IF;
    IF OLD.state IN ('RELEASED', 'CANCELLED') THEN
        RAISE EXCEPTION
            'dispensings row in state % is append-only per SI-007 (P-046) '
            'handoff rule #6 — post-RELEASED progress is recorded on the '
            'shipments row. UPDATE rejected.', OLD.state
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER dispensings_block_terminal_update
    BEFORE UPDATE ON dispensings
    FOR EACH ROW
    EXECUTE FUNCTION dispensings_block_terminal_mutation();

CREATE TRIGGER dispensings_block_delete
    BEFORE DELETE ON dispensings
    FOR EACH ROW
    EXECUTE FUNCTION dispensings_block_terminal_mutation();

-- =============================================================================
-- §3 — shipments (CDM §4.19; entity #21; SI-007 v0.19)
--
-- Carrier-side delivery lifecycle. Created in PENDING_CARRIER_PICKUP by the
-- atomic Dispensing.RELEASED handoff tx (Codex R9 + R10 closures — the
-- atomicity itself is a service-layer write-path rule landing with the
-- fulfillment writeback PR). Child holds the authoritative link:
-- shipments.dispensing_id; one shipment per dispensing.
-- =============================================================================

CREATE TABLE shipments (
    id                          VARCHAR(26)  PRIMARY KEY,
    tenant_id                   TEXT         NOT NULL REFERENCES tenants(id),

    -- Source link (authoritative; Dispensing carries NO reciprocal FK)
    dispensing_id               VARCHAR(26)  NOT NULL,

    -- Carrier link — nullable at the column level; mode CHECKs below
    -- enforce per-mode NOT-NULL (Codex R3 + R7 closures)
    carrier_id                  VARCHAR(26),

    -- Tracking
    carrier_tracking_number     TEXT,
    carrier_tracking_url        TEXT,

    -- Lifecycle (SI-007 v0.11 enum: PENDING_CARRIER_PICKUP initial state)
    state                       VARCHAR(30)  NOT NULL,

    -- Delivery preference (denormalized from parent Refill per SI §4.19)
    delivery_preference         VARCHAR(10)  NOT NULL,

    -- Delivery confirmation
    delivered_at                TIMESTAMPTZ,
    delivery_proof_type         VARCHAR(30),
    -- DEFERRED-FK TODO (attachments slice): composite FK when the
    -- attachments entity lands.
    delivery_proof_artifact_id  VARCHAR(26),

    -- Failure tracking
    delivery_failed_reason      VARCHAR(30),

    -- Pickup tracking. DEFERRED-FK TODO (pharmacy_locations): composite FK
    -- when the pharmacy-locations entity lands; the mode CHECKs below
    -- enforce presence/absence per delivery_preference regardless.
    pickup_location_id          VARCHAR(26),
    pickup_expires_at           TIMESTAMPTZ,
    picked_up_at                TIMESTAMPTZ,

    -- CCR linkage
    country_of_care             CHAR(2)      NOT NULL,

    -- Standard timestamps
    created_at                  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at                  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

    CONSTRAINT shipments_tenant_id_id_unique UNIQUE (tenant_id, id),

    -- One shipment per dispensing (SI UNIQUE, verbatim)
    CONSTRAINT shipments_tenant_dispensing_unique UNIQUE (tenant_id, dispensing_id),

    -- Tenant-scoped composite FKs (SI v0.19 R18 closure)
    CONSTRAINT shipments_tenant_dispensing_fk
        FOREIGN KEY (tenant_id, dispensing_id)
        REFERENCES dispensings (tenant_id, id),
    CONSTRAINT shipments_tenant_carrier_fk
        FOREIGN KEY (tenant_id, carrier_id)
        REFERENCES adapter_configs (tenant_id, id),

    -- State enum (SI-007 v0.11 per Codex R10 closure)
    CONSTRAINT shipments_state_valid CHECK (
        state IN (
            'PENDING_CARRIER_PICKUP', 'DISPATCHED', 'IN_TRANSIT', 'DELIVERED',
            'DELIVERY_FAILED', 'PICKUP_AVAILABLE', 'PICKED_UP',
            'PICKUP_EXPIRED', 'CANCELLED_BEFORE_DISPATCH'
        )
    ),

    CONSTRAINT shipments_delivery_preference_valid CHECK (
        delivery_preference IN ('delivery', 'pickup')
    ),

    -- Mode-specific presence rules (SI cross-entity CHECKs, verbatim):
    --   pickup   ⟹ pickup_location_id NOT NULL AND carrier_id NULL
    --   delivery ⟹ carrier_id NOT NULL AND pickup_location_id NULL
    CONSTRAINT shipments_pickup_mode_fields CHECK (
        delivery_preference <> 'pickup'
        OR (pickup_location_id IS NOT NULL AND carrier_id IS NULL)
    ),
    CONSTRAINT shipments_delivery_mode_fields CHECK (
        delivery_preference <> 'delivery'
        OR (carrier_id IS NOT NULL AND pickup_location_id IS NULL)
    ),

    -- Proof + failure enums (SI §4.19)
    CONSTRAINT shipments_delivery_proof_type_valid CHECK (
        delivery_proof_type IS NULL
        OR delivery_proof_type IN ('signature', 'photo', 'gps_geofence', 'acknowledged_receipt')
    ),
    CONSTRAINT shipments_delivery_failed_reason_valid CHECK (
        delivery_failed_reason IS NULL
        OR delivery_failed_reason IN (
            'incorrect_address', 'no_one_to_receive', 'damaged', 'lost', 'recipient_refused'
        )
    ),

    CONSTRAINT shipments_country_valid CHECK (country_of_care ~ '^[A-Z]{2}$')
);

CREATE INDEX idx_shipments_tenant_state
    ON shipments (tenant_id, state);
CREATE INDEX idx_shipments_tenant_tracking
    ON shipments (tenant_id, carrier_tracking_number)
    WHERE carrier_tracking_number IS NOT NULL;

ALTER TABLE shipments ENABLE ROW LEVEL SECURITY;
ALTER TABLE shipments FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON shipments
    USING     (tenant_id = current_tenant_id())
    WITH CHECK (tenant_id = current_tenant_id());

-- Business-final append-only guard (SI consolidated set: {DELIVERED,
-- PICKED_UP, PICKUP_EXPIRED, CANCELLED_BEFORE_DISPATCH}) + no-DELETE.
CREATE OR REPLACE FUNCTION shipments_block_terminal_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION
            'shipments rows are never deleted (fulfillment record; SI-007 '
            'append-only discipline). DELETE is permanently prohibited.';
    END IF;
    IF OLD.state IN ('DELIVERED', 'PICKED_UP', 'PICKUP_EXPIRED', 'CANCELLED_BEFORE_DISPATCH') THEN
        RAISE EXCEPTION
            'shipments row in business-final state % is append-only per SI-007 '
            '(P-046). UPDATE rejected.', OLD.state
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER shipments_block_terminal_update
    BEFORE UPDATE ON shipments
    FOR EACH ROW
    EXECUTE FUNCTION shipments_block_terminal_mutation();

CREATE TRIGGER shipments_block_delete
    BEFORE DELETE ON shipments
    FOR EACH ROW
    EXECUTE FUNCTION shipments_block_terminal_mutation();

-- =============================================================================
-- §4 — Verification (matches migration 033/040/047/056 closing-check pattern)
-- =============================================================================

DO $$
DECLARE
    v_table TEXT;
    v_tables TEXT[] := ARRAY['refills', 'dispensings', 'shipments'];
    v_count INTEGER;
BEGIN
    -- All 3 tables exist with RLS FORCED
    FOREACH v_table IN ARRAY v_tables LOOP
        IF NOT EXISTS (
            SELECT 1 FROM pg_class c
            JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = 'public' AND c.relname = v_table
              AND c.relrowsecurity AND c.relforcerowsecurity
        ) THEN
            RAISE EXCEPTION 'migration-060-verification: table % missing or RLS not FORCED', v_table
                USING ERRCODE = 'check_violation';
        END IF;
    END LOOP;

    -- Every table has a tenant_isolation policy
    SELECT COUNT(*) INTO v_count
      FROM pg_policies
     WHERE schemaname = 'public'
       AND tablename = ANY (v_tables)
       AND policyname = 'tenant_isolation';
    IF v_count <> 3 THEN
        RAISE EXCEPTION 'migration-060-verification: expected 3 tenant_isolation policies, found %', v_count
            USING ERRCODE = 'check_violation';
    END IF;

    -- Append-only guard triggers present (2 per table = 6)
    SELECT COUNT(*) INTO v_count
      FROM pg_trigger t
      JOIN pg_class c ON c.oid = t.tgrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relname = ANY (v_tables)
       AND NOT t.tgisinternal;
    IF v_count <> 6 THEN
        RAISE EXCEPTION 'migration-060-verification: expected 6 user triggers across the 3 tables, found %', v_count
            USING ERRCODE = 'check_violation';
    END IF;

    -- §0 composite-FK target on adapter_configs present
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'adapter_configs_tenant_id_id_unique'
          AND contype = 'u'
    ) THEN
        RAISE EXCEPTION 'migration-060-verification: adapter_configs_tenant_id_id_unique missing'
            USING ERRCODE = 'check_violation';
    END IF;
END $$;
