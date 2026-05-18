# SI-016 — `ai_workflow_handler_registry` CDM §4 expansion (CDM v1.X)

**Raised by:** Engineering (autonomous run 2026-05-18; SC7 P-024 SI-011 UMBRELLA Sub-decision #5 dependency caveat — SI-011d Mode 2 input contract conformance gate cannot ratify canonical row shape until `ai_workflow_handler_registry` table location ratification SI lands)
**Date:** 2026-05-18
**Severity:** medium (does NOT block any SC1–SC7 ratifications; **prerequisite** for SI-011.1d L4 Mode 2 input contract conformance canonical content port + any future protocol_execution / autonomous_agent / multi_agent_supervisor / tool_using_agent workload handler registration in the AI Workflow Engine slice)
**Status:** **OPEN — v0.1 DRAFT (pre-Codex pre-ratification gate; gate commences with v0.1 PR open)**
**Target spec doc:** `Telecheck_Canonical_Data_Model_v1_2.md` (CDM v1.X → v1.Y with §3.14 NEW AI Workflow Registry category added + §4.29 ai_workflow_handler_registry + §4.30 ai_workflow_handler_audit_log)
**Target slice PRDs (consumers):** `Telecheck_SI-011-Forms-Publish-Governance-Gates.md` §SI-011d (L4 Mode 2 input contract conformance gate — DEPENDS on this SI closing); future AI Workflow Engine slice PRD when authored
**Parent SI / triggers:** SC7 P-024 SI-011 UMBRELLA (Sub-decision #5 + #9 — filed SI-016 as dependency); ADR-029 (AI Workload Taxonomy + Autonomy Levels, Accepted at v1.10); WORKLOAD_TAXONOMY v5.2 contract (`AIWorkloadType` enum + per-workload-type properties); AI_LAYERING v5.2 contract (cross-walk for legacy Mode 1/Mode 2 framing); AUTONOMY_LEVELS v5.2 contract (autonomy_level enum); SI-008 P-018 (AiWorkflowExecution row shape ratified; references handlers but handler registry was a gap)
**Promotion Ledger target:** **TBD future P-NUM** (gap slot — likely P-017 or P-022 per post-SC7 unclaimed-slot inventory; or next-available after canonical-content-port wave for sub-ceremonies 1-6)

---

## What this is

CDM v1.2 §3 entity inventory has 42 entities (44 after SI-015 lands), **none of which is `ai_workflow_handler_registry`**. The entity is heavily referenced by:
- SI-008 P-018 (AiWorkflowExecution row shape — references `handler_id` + `handler_version`)
- SI-011d substantive design (SC7 P-024 Sub-decision #5 — `mode_2_contract` field on `approval_governance` requires `handler_signature_hash` SHA-256 of the handler's registered runtime input-validator schema)
- WORKLOAD_TAXONOMY v5.2 (handler registration is the structural anchor for `protocol_execution` workload-type activation)

The CDM §4 row-shape expansion has never landed — this is a schema gap of the same class as SI-001/005/008/009/009.1/015 family that the Q2 2026 ratifier ceremony has been closing.

SI-016 closes the `ai_workflow_handler_registry` CDM schema gap + the companion `ai_workflow_handler_audit_log` table for handler lifecycle audit-trail (a registered handler's `signature_hash` + version-deprecation timeline is governance-relevant evidence).

## What changed vs upstream contracts

| Surface | Existing at v5.2 contracts | SI-016 CDM §4 expansion |
| --- | --- | --- |
| WORKLOAD_TAXONOMY `AIWorkloadType` enum | 5 values: `conversational_assistant` (active), `protocol_execution` (active), `autonomous_agent` / `multi_agent_supervisor` / `tool_using_agent` (RESERVED — require ADR-030/031/033) + 2 sentinels (`rejected_invalid_attempt`, `n/a`) | NO new workload types at SI-016; registry references the enum |
| AUTONOMY_LEVELS `AutonomyLevel` enum | `advisory` / `action_with_confirm` (active v1.0) + RESERVED levels | NO new autonomy levels at SI-016; registry references the enum |
| AI_LAYERING contract | Mode 1 / Mode 2 framing (legacy at v1.0; superseded prospectively by ADR-029 workload taxonomy) | NO contract change; SI-016 is the structural anchor that lets workload-type activation use registered handlers |
| AUDIT_EVENTS `ai_workflow.contract_drift_detected` (per SI-011d substantive design) | Not yet canonical; deferred to SI-011.1d canonical content port | NO new audit events at SI-016 — handler-registry lifecycle events fold into SI-011.1d per the SC7 umbrella |
| CDM entities | 42 entities (44 after SI-015) — no `ai_workflow_handler_registry`, no `ai_workflow_handler_audit_log` | **+2 NEW** (§4.29 ai_workflow_handler_registry + §4.30 ai_workflow_handler_audit_log) |
| Composite UNIQUE | None | **+2** (registry: `UNIQUE(handler_id, version)` + audit log: `UNIQUE(audit_log_id)`) |
| Composite FK | None | **+1** (audit log → registry composite FK on `(handler_id, handler_version)` for version-aware audit-trail binding) |

**Scope note:** `ai_workflow_handler_registry` is **platform-scoped** (no `tenant_id` column) because registered handlers are shared infrastructure consumed by all tenants. Tenant-scoping happens at the **execution** layer (`ai_workflow_executions` per SI-008 P-018 carries `tenant_id`). GRANT model: `telecheck_app_role` has SELECT only; INSERT/UPDATE restricted to a privileged `platform_admin_role` (no per-tenant write authority). Mirrors the platform-scope discipline of other catalog tables that day-1-tenant operators consume but never mutate.

---

## Proposed canonical row shapes (FOR REVIEW — pre-Codex pre-ratification gate)

### §4.29 ai_workflow_handler_registry (entity #45)

```sql
-- v0.1 placeholder columns; SI-016 pre-ratification gate
handler_id                  VARCHAR(64)   NOT NULL  -- canonical handler ID (kebab-case namespace, e.g., 'consult-prep-glp1-v1', 'consult-prep-async-v1'); part of PK
version                     VARCHAR(20)   NOT NULL  -- semver string ('1.0.0', '1.0.1', '2.0.0-beta.1'); part of PK
ai_workload_type            VARCHAR(40)   NOT NULL CHECK (ai_workload_type IN (
    'protocol_execution'           -- active at v1.0 (current Mode 2 successor)
    -- RESERVED FUTURE — require successor ADRs before activation:
    -- 'autonomous_agent' (ADR-030), 'multi_agent_supervisor' (ADR-033), 'tool_using_agent' (ADR-031)
    -- Reserved values not in this CHECK; activation requires ADR landing + this CHECK amendment via a successor SI.
))
autonomy_level              VARCHAR(30)   NOT NULL CHECK (autonomy_level IN ('action_with_confirm'))
    -- Per I-012 reject-unless rule: protocol_execution handlers require autonomy_level=action_with_confirm; advisory-only handlers don't register here (they're conversational_assistant workload type which doesn't use this registry)
display_name                TEXT          NOT NULL  -- human-readable handler name for operator console
description                 TEXT          NOT NULL  -- one-paragraph operational description
input_validator_schema      JSONB         NOT NULL  -- canonical JSON Schema (draft-2020-12) defining the handler's input contract
signature_hash              TEXT          NOT NULL  -- SHA-256 of canonical-JSON-serialized input_validator_schema; DB-owned (forced via INSERT/UPDATE triggers); used by SI-011d publish-time validation
status                      VARCHAR(20)   NOT NULL CHECK (status IN ('registered', 'active', 'deprecated', 'retired')) DEFAULT 'registered'
registered_at               TIMESTAMPTZ   NOT NULL DEFAULT NOW()  -- DB-clock anchor; forced via INSERT trigger
activated_at                TIMESTAMPTZ   NULL  -- REQUIRED when status='active'; forced to NOW() at state-machine transition
deprecated_at               TIMESTAMPTZ   NULL  -- REQUIRED when status='deprecated'; forced to NOW() at state-machine transition
retired_at                  TIMESTAMPTZ   NULL  -- REQUIRED when status='retired'; forced to NOW() at state-machine transition
deprecation_successor_handler_id    VARCHAR(64)  NULL  -- optional; canonical ID of the successor handler that supersedes this version; populated at deprecated_at
deprecation_successor_version       VARCHAR(20)  NULL  -- paired with successor_handler_id
updated_at                  TIMESTAMPTZ   NOT NULL DEFAULT NOW()

-- Cross-version safety constraints (NOT placeholders; permanent)
PRIMARY KEY (handler_id, version)  -- one row per (handler_id, version); a new version is a new row
UNIQUE (handler_id, version)        -- redundant with PK but documents the intent
UNIQUE (signature_hash) WHERE status IN ('registered', 'active')
    -- Partial UNIQUE: no two simultaneously-registered-or-active rows may share a signature_hash. Prevents
    -- registering the same canonical schema under two different handler_ids/versions (which would defeat
    -- the SI-011d publish-time signature-hash verification — a form-template binds to the hash, and the
    -- hash should resolve to exactly one (handler_id, version) at any point in time among active handlers).
    -- Deprecated/retired rows are excluded because historical hash reuse is possible after a handler retires
    -- and a NEW handler-id with the same input shape registers.

-- Workload-type-specific compatibility CHECK
CHECK (
  (ai_workload_type = 'protocol_execution' AND autonomy_level = 'action_with_confirm')
)

-- Status-state-machine consistency CHECK (matches the lifecycle: registered → active → deprecated → retired)
CHECK (
  (status = 'registered' AND activated_at IS NULL AND deprecated_at IS NULL AND retired_at IS NULL)
  OR (status = 'active' AND activated_at IS NOT NULL AND deprecated_at IS NULL AND retired_at IS NULL)
  OR (status = 'deprecated' AND activated_at IS NOT NULL AND deprecated_at IS NOT NULL AND retired_at IS NULL)
  OR (status = 'retired' AND retired_at IS NOT NULL)
)

-- Deprecation successor consistency: if deprecation_successor_handler_id is populated, version pair must be populated too;
-- if status is 'deprecated' or later, a successor MAY be populated (optional — some deprecations are end-of-life without successor)
CHECK (
  (deprecation_successor_handler_id IS NULL AND deprecation_successor_version IS NULL)
  OR
  (deprecation_successor_handler_id IS NOT NULL AND deprecation_successor_version IS NOT NULL)
)
CHECK (deprecation_successor_handler_id IS NULL OR status IN ('deprecated', 'retired'))

-- Timestamp monotonicity CHECKs
CHECK (activated_at IS NULL OR activated_at >= registered_at)
CHECK (deprecated_at IS NULL OR deprecated_at >= COALESCE(activated_at, registered_at))
CHECK (retired_at IS NULL OR retired_at >= COALESCE(deprecated_at, activated_at, registered_at))
```

### §4.30 ai_workflow_handler_audit_log (entity #46)

```sql
-- v0.1 placeholder columns; SI-016 pre-ratification gate
audit_log_id                VARCHAR(26)   PRIMARY KEY  -- 'wha_<ULID>' per TYPES v5.2 ID prefix convention
handler_id                  VARCHAR(64)   NOT NULL
handler_version             VARCHAR(20)   NOT NULL
event_type                  VARCHAR(40)   NOT NULL CHECK (event_type IN (
    'handler.registered',
    'handler.activated',
    'handler.deprecated',
    'handler.retired',
    'handler.signature_hash_recomputed'
))
event_payload               JSONB         NOT NULL  -- event-specific shape; includes (prior_status, new_status, deprecation_successor_handler_id, deprecation_successor_version) for status-transition events
actor_account_id            VARCHAR(26)   NOT NULL  -- platform_admin account that performed the registry mutation (FK to accounts.account_id; platform_admin scope)
actor_role_at_event         VARCHAR(50)   NOT NULL  -- snapshot of actor's role at the moment of event (platform_admin or successor; immutable)
recorded_at                 TIMESTAMPTZ   NOT NULL DEFAULT NOW()  -- DB-clock anchor; forced via INSERT trigger

-- Append-only invariant: full Tier 0 immutability post-INSERT.
UNIQUE (audit_log_id)

-- Composite FK to registry: every audit-log row references a specific (handler_id, version) pair
FOREIGN KEY (handler_id, handler_version) REFERENCES ai_workflow_handler_registry (handler_id, version)
```

---

## Append-only + Tier 0/1/2 invariants

### ai_workflow_handler_registry

**Tier 0 — Identity binding immutable from INSERT** (FROZEN at row creation; never mutable):
- `handler_id`, `version`, `ai_workload_type`, `autonomy_level`, `registered_at` — registry-row identity binding cannot be retroactively changed
- A new `version` is a NEW row (immutable per row); never an UPDATE that changes the version column

**Tier 1 — Input-validator schema + signature_hash immutable AFTER registration** (FROZEN once row exists):
- `input_validator_schema`, `signature_hash` — handler schema is immutable per (handler_id, version); any schema change requires a NEW version row + new signature_hash
- `display_name` + `description` may be edited for typo/clarity fixes (operator-console convenience); these are NOT part of the signature_hash computation, so editing them does NOT invalidate downstream form-template bindings

**Tier 2 — Status-transition allow-list** (status column + status-transition timestamps remain mutable, but ONLY through guarded state transitions):
- `registered → active` (operator action; sets activated_at to NOW())
- `active → deprecated` (operator action; sets deprecated_at to NOW(); optional deprecation_successor_handler_id + deprecation_successor_version)
- `deprecated → retired` (operator action; sets retired_at to NOW())
- `registered → retired` (operator action; for never-activated handlers; sets retired_at to NOW())
- All other transitions FORBIDDEN; status='retired' is terminal

### ai_workflow_handler_audit_log

**Tier 0 — Fully append-only from INSERT** (every column immutable post-INSERT; no UPDATE path; no DELETE path):
- All 8 columns are evidence artifacts; the row IS the evidence
- Mirrors I-003 audit_records discipline + SI-015 MarketingCopyGovernanceEvidence append-only pattern

---

## Repository layer enforcement (pseudo-SQL)

```sql
-- DB-owned canonical signature_hash computation (mirror SI-015 content_fingerprint pattern):
-- canonical SHA-256 over canonical-JSON-serialized input_validator_schema (sorted keys,
-- normalized whitespace) ensures the same schema always produces the same hash regardless
-- of caller's JSON formatting.
CREATE OR REPLACE FUNCTION compute_ai_workflow_handler_signature_hash(
  p_input_validator_schema JSONB
) RETURNS TEXT
LANGUAGE plpgsql IMMUTABLE
AS $$
DECLARE
  v_canonical_json TEXT;
BEGIN
  -- jsonb canonical serialization: jsonb auto-sorts keys + normalizes whitespace, so
  -- jsonb::text already produces a canonical form. SHA-256 over that text is the hash.
  v_canonical_json := p_input_validator_schema::TEXT;
  RETURN encode(digest(v_canonical_json, 'sha256'), 'hex');
END;
$$;

-- BEFORE INSERT trigger: force registered_at + updated_at + signature_hash to DB-derived
-- values; reject pre-seeded lifecycle timestamps; force status='registered' at INSERT.
CREATE OR REPLACE FUNCTION ai_workflow_handler_registry_insert_guard()
RETURNS TRIGGER AS $$
BEGIN
  NEW.registered_at := NOW();
  NEW.updated_at := NOW();
  -- DB-owned signature_hash (mirror SI-015 R1 HIGH-2 closure): caller-supplied
  -- value silently overridden so signature_hash is provably derived from
  -- input_validator_schema and cannot be tampered with at registration time.
  NEW.signature_hash := compute_ai_workflow_handler_signature_hash(NEW.input_validator_schema);
  IF NEW.status IS DISTINCT FROM 'registered' THEN
    RAISE EXCEPTION 'ai_workflow_handler_registry(% / %): direct INSERT must start at status=''registered'' (got %); status progression via the guarded state-machine transitions only', NEW.handler_id, NEW.version, NEW.status;
  END IF;
  IF NEW.activated_at IS NOT NULL OR NEW.deprecated_at IS NOT NULL OR NEW.retired_at IS NOT NULL THEN
    RAISE EXCEPTION 'ai_workflow_handler_registry(% / %): direct INSERT cannot pre-seed status-transition timestamps (activated_at / deprecated_at / retired_at); these are populated only via the guarded state-machine transitions', NEW.handler_id, NEW.version;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER ai_workflow_handler_registry_insert_lifecycle_guard
  BEFORE INSERT ON ai_workflow_handler_registry
  FOR EACH ROW
  EXECUTE FUNCTION ai_workflow_handler_registry_insert_guard();

-- Tier 0 identity immutability (BEFORE UPDATE trigger):
CREATE OR REPLACE FUNCTION ai_workflow_handler_registry_tier0_immutability()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.handler_id IS DISTINCT FROM OLD.handler_id THEN
    RAISE EXCEPTION 'ai_workflow_handler_registry(% / %): Tier 0 identity immutability violated — handler_id cannot change post-INSERT (PK column)', NEW.handler_id, NEW.version;
  END IF;
  IF NEW.version IS DISTINCT FROM OLD.version THEN
    RAISE EXCEPTION 'ai_workflow_handler_registry(% / %): Tier 0 identity immutability violated — version cannot change post-INSERT (PK column; a new version is a NEW row)', NEW.handler_id, NEW.version;
  END IF;
  IF NEW.ai_workload_type IS DISTINCT FROM OLD.ai_workload_type THEN
    RAISE EXCEPTION 'ai_workflow_handler_registry(% / %): Tier 0 identity immutability violated — ai_workload_type cannot change post-INSERT', NEW.handler_id, NEW.version;
  END IF;
  IF NEW.autonomy_level IS DISTINCT FROM OLD.autonomy_level THEN
    RAISE EXCEPTION 'ai_workflow_handler_registry(% / %): Tier 0 identity immutability violated — autonomy_level cannot change post-INSERT', NEW.handler_id, NEW.version;
  END IF;
  IF NEW.registered_at IS DISTINCT FROM OLD.registered_at THEN
    RAISE EXCEPTION 'ai_workflow_handler_registry(% / %): Tier 0 identity immutability violated — registered_at cannot change post-INSERT', NEW.handler_id, NEW.version;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER ai_workflow_handler_registry_tier0_immutability_guard
  BEFORE UPDATE ON ai_workflow_handler_registry
  FOR EACH ROW
  EXECUTE FUNCTION ai_workflow_handler_registry_tier0_immutability();

-- Tier 1 input_validator_schema + signature_hash immutability (BEFORE UPDATE trigger):
-- Schema is registration-time-set; any change requires a NEW (handler_id, version) row.
-- Schema is also the input to signature_hash, so any signature_hash mismatch with the
-- recomputed value of input_validator_schema is rejected (defense-in-depth against
-- direct-SQL attempting to swap one without the other).
CREATE OR REPLACE FUNCTION ai_workflow_handler_registry_tier1_schema_immutability()
RETURNS TRIGGER AS $$
DECLARE
  v_recomputed_hash TEXT;
BEGIN
  IF NEW.input_validator_schema IS DISTINCT FROM OLD.input_validator_schema THEN
    RAISE EXCEPTION 'ai_workflow_handler_registry(% / %): Tier 1 input_validator_schema immutability violated (schema is registration-time-set; any change requires a NEW version row)', NEW.handler_id, NEW.version;
  END IF;
  -- Defense-in-depth: signature_hash is DB-owned via the INSERT trigger; UPDATEs should
  -- NEVER attempt to change it. If caller does, force it back to the computed value.
  v_recomputed_hash := compute_ai_workflow_handler_signature_hash(NEW.input_validator_schema);
  IF NEW.signature_hash IS DISTINCT FROM v_recomputed_hash THEN
    NEW.signature_hash := v_recomputed_hash;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER ai_workflow_handler_registry_tier1_schema_immutability_guard
  BEFORE UPDATE ON ai_workflow_handler_registry
  FOR EACH ROW
  EXECUTE FUNCTION ai_workflow_handler_registry_tier1_schema_immutability();

-- Tier 2 status-state-machine trigger (BEFORE UPDATE):
CREATE OR REPLACE FUNCTION ai_workflow_handler_registry_status_state_machine()
RETURNS TRIGGER AS $$
BEGIN
  -- Force updated_at to DB time on every UPDATE
  NEW.updated_at := NOW();
  -- Same-state UPDATE allowed iff status-transition timestamps unchanged
  IF NEW.status = OLD.status THEN
    IF NEW.activated_at IS DISTINCT FROM OLD.activated_at
       OR NEW.deprecated_at IS DISTINCT FROM OLD.deprecated_at
       OR NEW.retired_at IS DISTINCT FROM OLD.retired_at THEN
      RAISE EXCEPTION 'ai_workflow_handler_registry(% / %): same-state UPDATE (status=%) cannot rewrite status-transition timestamps', NEW.handler_id, NEW.version, OLD.status;
    END IF;
    RETURN NEW;
  END IF;
  -- Transition allow-list:
  IF OLD.status = 'registered' AND NEW.status IN ('active', 'retired') THEN
    IF NEW.status = 'active' THEN
      NEW.activated_at := NOW();
    ELSIF NEW.status = 'retired' THEN
      NEW.retired_at := NOW();
    END IF;
    RETURN NEW;
  ELSIF OLD.status = 'active' AND NEW.status = 'deprecated' THEN
    NEW.deprecated_at := NOW();
    -- Optional successor binding: if caller supplied successor, validate composite FK semantics
    -- (the FK from registry to itself for successor is NOT modeled; deferred to service-layer
    -- validation that the successor row exists in the same registry).
    RETURN NEW;
  ELSIF OLD.status = 'deprecated' AND NEW.status = 'retired' THEN
    NEW.retired_at := NOW();
    RETURN NEW;
  END IF;
  -- All other transitions forbidden:
  RAISE EXCEPTION 'ai_workflow_handler_registry(% / %): forbidden status transition % → %; allow-list: registered→active, active→deprecated, deprecated→retired, registered→retired', NEW.handler_id, NEW.version, OLD.status, NEW.status;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER ai_workflow_handler_registry_status_state_machine_guard
  BEFORE UPDATE ON ai_workflow_handler_registry
  FOR EACH ROW
  EXECUTE FUNCTION ai_workflow_handler_registry_status_state_machine();

-- ai_workflow_handler_registry: BEFORE DELETE trigger rejects ALL DELETEs.
-- Registry rows are forensic evidence; retired-status is the terminal state, not deletion.
-- (R2 MEDIUM-1 closure 2026-05-18: previously the v0.1 only withheld DELETE from
-- platform_admin_role via REVOKE; a table owner / migration role / future role
-- change could still delete registry rows and leave audit_log composite-FK
-- references dangling. DB-layer trigger enforcement closes this backdoor.)
CREATE OR REPLACE FUNCTION ai_workflow_handler_registry_reject_delete()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'ai_workflow_handler_registry(% / %): registry rows are forensic evidence; DELETE forbidden (retired-status is the terminal state, not deletion); R2 MEDIUM-1 closure', OLD.handler_id, OLD.version;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER ai_workflow_handler_registry_append_only_delete
  BEFORE DELETE ON ai_workflow_handler_registry
  FOR EACH ROW
  EXECUTE FUNCTION ai_workflow_handler_registry_reject_delete();

-- ai_workflow_handler_audit_log: full append-only enforcement
CREATE OR REPLACE FUNCTION ai_workflow_handler_audit_log_reject_mutation()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'ai_workflow_handler_audit_log(%): row is evidence artifact; no UPDATE/DELETE permitted (Tier 0 full append-only enforced at DB layer per I-003 audit_records precedent)', COALESCE(OLD.audit_log_id, NEW.audit_log_id);
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER ai_workflow_handler_audit_log_append_only_update
  BEFORE UPDATE ON ai_workflow_handler_audit_log
  FOR EACH ROW
  EXECUTE FUNCTION ai_workflow_handler_audit_log_reject_mutation();

CREATE TRIGGER ai_workflow_handler_audit_log_append_only_delete
  BEFORE DELETE ON ai_workflow_handler_audit_log
  FOR EACH ROW
  EXECUTE FUNCTION ai_workflow_handler_audit_log_reject_mutation();

-- ai_workflow_handler_audit_log BEFORE INSERT trigger: force recorded_at to DB time
CREATE OR REPLACE FUNCTION ai_workflow_handler_audit_log_insert_guard()
RETURNS TRIGGER AS $$
BEGIN
  NEW.recorded_at := NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER ai_workflow_handler_audit_log_insert_db_time_guard
  BEFORE INSERT ON ai_workflow_handler_audit_log
  FOR EACH ROW
  EXECUTE FUNCTION ai_workflow_handler_audit_log_insert_guard();
```

---

## GRANT model + SECURITY DEFINER write paths (platform-scope discipline + atomic audit emission)

**Codex-Gate R1 HIGH closure 2026-05-18:** the original v0.1 GRANT model granted `platform_admin_role` direct INSERT/UPDATE on the registry + separate INSERT on the audit_log. An operator could mutate registry lifecycle state and simply omit the audit insert, breaking the stated evidence-grade audit trail. Closure: registry mutations now flow through SECURITY DEFINER procedures that atomically (a) mutate the registry row + (b) emit the corresponding audit_log row in the same transaction. Direct registry INSERT/UPDATE is REVOKED from `platform_admin_role`. The audit emission becomes structurally guaranteed.

```sql
-- ai_workflow_handler_registry: app-role has SELECT only; direct INSERT/UPDATE/DELETE
-- REVOKED from ALL roles. Writes go ONLY through the SECURITY DEFINER procedures below.
REVOKE ALL ON ai_workflow_handler_registry FROM telecheck_app_role;
REVOKE ALL ON ai_workflow_handler_registry FROM platform_admin_role;
GRANT SELECT ON ai_workflow_handler_registry TO telecheck_app_role;
GRANT SELECT ON ai_workflow_handler_registry TO platform_admin_role;

-- ai_workflow_handler_audit_log: app-role has SELECT only (read for audit walks);
-- direct INSERT/UPDATE/DELETE REVOKED from ALL roles. INSERTs happen via the
-- SECURITY DEFINER registry-mutation procedures in the SAME transaction as the
-- corresponding registry row mutation.
REVOKE ALL ON ai_workflow_handler_audit_log FROM telecheck_app_role;
REVOKE ALL ON ai_workflow_handler_audit_log FROM platform_admin_role;
GRANT SELECT ON ai_workflow_handler_audit_log TO telecheck_app_role;
GRANT SELECT ON ai_workflow_handler_audit_log TO platform_admin_role;
```

### SECURITY DEFINER write-path procedures (R1 HIGH closure 2026-05-18)

Registry mutations occur ONLY through the four procedures below. Each procedure:
1. Mutates the registry row (INSERT or UPDATE) under the SECURITY DEFINER function-owner role (which retains INSERT/UPDATE privileges).
2. INSERTS the corresponding audit_log row in the SAME transaction.
3. Uses `current_actor_account_id()` + `current_actor_role()` helpers (SI-010 dependency) to derive actor identity — caller cannot spoof.

**IMPL-readiness gate:** these procedures depend on SI-010 (`current_actor_account_id()` + helpers) being implemented. Same gate that SI-005/008/009 procedures wait on. SI-010 is ratified at P-023 SC6; implementation port unblocks SI-016 procedures + SI-005/008/009 procedures simultaneously.

```sql
-- register_handler: INSERT a new (handler_id, version) registry row + emit
-- handler.registered audit_log row atomically.
CREATE OR REPLACE PROCEDURE register_handler(
  p_handler_id            TEXT,
  p_version               TEXT,
  p_ai_workload_type      TEXT,
  p_autonomy_level        TEXT,
  p_display_name          TEXT,
  p_description           TEXT,
  p_input_validator_schema JSONB
)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_actor_account_id TEXT := current_actor_account_id();  -- SI-010 helper
  v_actor_role       TEXT := current_actor_role();         -- SI-010 helper
  v_audit_log_id     TEXT;
BEGIN
  -- Tier 0: only platform_admin can register handlers
  IF v_actor_role NOT IN ('platform_admin') THEN
    RAISE EXCEPTION 'register_handler: insufficient privilege (role=% required platform_admin)', v_actor_role;
  END IF;
  -- Registry INSERT (the INSERT trigger forces registered_at + updated_at + signature_hash to DB-computed values; rejects pre-seeded lifecycle timestamps)
  INSERT INTO ai_workflow_handler_registry
    (handler_id, version, ai_workload_type, autonomy_level, display_name, description,
     input_validator_schema, signature_hash, status)
  VALUES
    (p_handler_id, p_version, p_ai_workload_type, p_autonomy_level, p_display_name, p_description,
     p_input_validator_schema, 'placeholder-overridden-by-trigger', 'registered');
  -- Atomic audit emission
  v_audit_log_id := 'wha_' || encode(gen_random_bytes(16), 'hex');
  INSERT INTO ai_workflow_handler_audit_log
    (audit_log_id, handler_id, handler_version, event_type, event_payload, actor_account_id, actor_role_at_event)
  VALUES
    (v_audit_log_id, p_handler_id, p_version, 'handler.registered',
     jsonb_build_object('ai_workload_type', p_ai_workload_type, 'autonomy_level', p_autonomy_level),
     v_actor_account_id, v_actor_role);
END;
$$;

-- activate_handler: UPDATE status registered → active + emit handler.activated audit
CREATE OR REPLACE PROCEDURE activate_handler(
  p_handler_id  TEXT,
  p_version     TEXT
)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_actor_account_id TEXT := current_actor_account_id();
  v_actor_role       TEXT := current_actor_role();
  v_audit_log_id     TEXT;
  v_prior_status     TEXT;
BEGIN
  IF v_actor_role NOT IN ('platform_admin') THEN
    RAISE EXCEPTION 'activate_handler: insufficient privilege (role=% required platform_admin)', v_actor_role;
  END IF;
  -- Read prior status for audit payload
  SELECT status INTO v_prior_status FROM ai_workflow_handler_registry
   WHERE handler_id = p_handler_id AND version = p_version;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'activate_handler: registry row not found (handler_id=%, version=%)', p_handler_id, p_version;
  END IF;
  -- Registry UPDATE (state-machine trigger enforces registered → active arc + sets activated_at via NEW.activated_at := NOW())
  UPDATE ai_workflow_handler_registry
     SET status = 'active'
   WHERE handler_id = p_handler_id AND version = p_version;
  -- Atomic audit emission
  v_audit_log_id := 'wha_' || encode(gen_random_bytes(16), 'hex');
  INSERT INTO ai_workflow_handler_audit_log
    (audit_log_id, handler_id, handler_version, event_type, event_payload, actor_account_id, actor_role_at_event)
  VALUES
    (v_audit_log_id, p_handler_id, p_version, 'handler.activated',
     jsonb_build_object('prior_status', v_prior_status, 'new_status', 'active'),
     v_actor_account_id, v_actor_role);
END;
$$;

-- deprecate_handler: UPDATE status active → deprecated + emit handler.deprecated audit
-- Optionally binds a successor (handler_id, version) — validated existence + active-or-deprecated status.
CREATE OR REPLACE PROCEDURE deprecate_handler(
  p_handler_id                        TEXT,
  p_version                           TEXT,
  p_deprecation_successor_handler_id  TEXT DEFAULT NULL,
  p_deprecation_successor_version     TEXT DEFAULT NULL
)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_actor_account_id TEXT := current_actor_account_id();
  v_actor_role       TEXT := current_actor_role();
  v_audit_log_id     TEXT;
  v_prior_status     TEXT;
  v_successor_status TEXT;
BEGIN
  IF v_actor_role NOT IN ('platform_admin') THEN
    RAISE EXCEPTION 'deprecate_handler: insufficient privilege (role=% required platform_admin)', v_actor_role;
  END IF;
  -- Read prior status
  SELECT status INTO v_prior_status FROM ai_workflow_handler_registry
   WHERE handler_id = p_handler_id AND version = p_version;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'deprecate_handler: registry row not found (handler_id=%, version=%)', p_handler_id, p_version;
  END IF;
  -- Successor validation (R2 MEDIUM-2 closure 2026-05-18): if successor specified,
  -- verify the successor row exists AND is in a dispatchable state (active or deprecated;
  -- retired successors are rejected — pointing to a retired successor leaves consumers
  -- without a valid migration target).
  IF p_deprecation_successor_handler_id IS NOT NULL OR p_deprecation_successor_version IS NOT NULL THEN
    IF p_deprecation_successor_handler_id IS NULL OR p_deprecation_successor_version IS NULL THEN
      RAISE EXCEPTION 'deprecate_handler: successor handler_id + version must both be supplied or both NULL';
    END IF;
    SELECT status INTO v_successor_status FROM ai_workflow_handler_registry
     WHERE handler_id = p_deprecation_successor_handler_id AND version = p_deprecation_successor_version;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'deprecate_handler: successor not found (handler_id=%, version=%)', p_deprecation_successor_handler_id, p_deprecation_successor_version;
    END IF;
    IF v_successor_status NOT IN ('active', 'deprecated') THEN
      RAISE EXCEPTION 'deprecate_handler: successor must be in active or deprecated status (got %); cannot point to retired successor', v_successor_status;
    END IF;
  END IF;
  -- Registry UPDATE (state-machine trigger enforces active → deprecated arc + sets deprecated_at)
  UPDATE ai_workflow_handler_registry
     SET status = 'deprecated',
         deprecation_successor_handler_id = p_deprecation_successor_handler_id,
         deprecation_successor_version = p_deprecation_successor_version
   WHERE handler_id = p_handler_id AND version = p_version;
  -- Atomic audit emission
  v_audit_log_id := 'wha_' || encode(gen_random_bytes(16), 'hex');
  INSERT INTO ai_workflow_handler_audit_log
    (audit_log_id, handler_id, handler_version, event_type, event_payload, actor_account_id, actor_role_at_event)
  VALUES
    (v_audit_log_id, p_handler_id, p_version, 'handler.deprecated',
     jsonb_build_object(
       'prior_status', v_prior_status,
       'new_status', 'deprecated',
       'deprecation_successor_handler_id', p_deprecation_successor_handler_id,
       'deprecation_successor_version', p_deprecation_successor_version
     ),
     v_actor_account_id, v_actor_role);
END;
$$;

-- retire_handler: UPDATE status to retired + emit handler.retired audit
CREATE OR REPLACE PROCEDURE retire_handler(
  p_handler_id  TEXT,
  p_version     TEXT
)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_actor_account_id TEXT := current_actor_account_id();
  v_actor_role       TEXT := current_actor_role();
  v_audit_log_id     TEXT;
  v_prior_status     TEXT;
BEGIN
  IF v_actor_role NOT IN ('platform_admin') THEN
    RAISE EXCEPTION 'retire_handler: insufficient privilege (role=% required platform_admin)', v_actor_role;
  END IF;
  SELECT status INTO v_prior_status FROM ai_workflow_handler_registry
   WHERE handler_id = p_handler_id AND version = p_version;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'retire_handler: registry row not found (handler_id=%, version=%)', p_handler_id, p_version;
  END IF;
  -- Registry UPDATE (state-machine trigger enforces registered/deprecated → retired arc + sets retired_at)
  UPDATE ai_workflow_handler_registry
     SET status = 'retired'
   WHERE handler_id = p_handler_id AND version = p_version;
  -- Atomic audit emission
  v_audit_log_id := 'wha_' || encode(gen_random_bytes(16), 'hex');
  INSERT INTO ai_workflow_handler_audit_log
    (audit_log_id, handler_id, handler_version, event_type, event_payload, actor_account_id, actor_role_at_event)
  VALUES
    (v_audit_log_id, p_handler_id, p_version, 'handler.retired',
     jsonb_build_object('prior_status', v_prior_status, 'new_status', 'retired'),
     v_actor_account_id, v_actor_role);
END;
$$;

-- EXECUTE privilege on the procedures: granted only to platform_admin_role
-- (which has no direct INSERT/UPDATE on registry — must go through these procedures).
REVOKE ALL ON PROCEDURE register_handler FROM PUBLIC;
REVOKE ALL ON PROCEDURE activate_handler FROM PUBLIC;
REVOKE ALL ON PROCEDURE deprecate_handler FROM PUBLIC;
REVOKE ALL ON PROCEDURE retire_handler FROM PUBLIC;
GRANT EXECUTE ON PROCEDURE register_handler TO platform_admin_role;
GRANT EXECUTE ON PROCEDURE activate_handler TO platform_admin_role;
GRANT EXECUTE ON PROCEDURE deprecate_handler TO platform_admin_role;
GRANT EXECUTE ON PROCEDURE retire_handler TO platform_admin_role;
```

---

## SI-011.1d L4 Mode 2 input contract conformance consumption pattern (informational; canonical content lands at SI-011.1d, not here)

SI-011d's substantive design (per SC7 P-024 sub-decision #5 ratified) calls out:
- Form template's `approval_governance.mode_2_contract` field contains `(handler_id, handler_version, handler_signature_hash, input_schema)`
- Publish-path 5-step validation:
  - (a) Schema well-formed (JSON Schema draft-2020-12)
  - (b) Form-field cross-walk (every required property in input_schema corresponds to a form field)
  - (c) Handler resolves: `ai_workflow_handler_registry WHERE handler_id = $handler_id AND version = $handler_version AND status = 'active'`
  - (d) Signature compatibility: `handler_signature_hash` matches `ai_workflow_handler_registry.signature_hash` for that (handler_id, version)
  - (e) Schema-handler compatibility: form's `input_schema` is structural subset of handler's registered `input_validator_schema`
- Immutable provenance: published template row records `(handler_id, handler_version, handler_signature_hash)`
- Runtime drift detection: Mode 2 dispatch verifies the published template's signature_hash still matches the handler-at-dispatch-time signature; mismatch → `ai_workflow.contract_drift_detected` audit + runtime rejection

The SI-016 row shape's `signature_hash` column + DB-owned computation + Tier 1 schema immutability + partial UNIQUE on `(signature_hash) WHERE status IN ('registered', 'active')` are the structural pieces SI-011.1d's L4 gate relies on. SI-011.1d lands its own canonical content (the L4 gate logic + `forms.publish.mode_2_contract_invalid` audit IDs + `ai_workflow.contract_drift_detected` audit event) at its own future ratification.

---

## Cross-tenant safety note (platform-scope reasoning)

Unlike the SI-005/008/009/009.1/015 entities (all tenant-scoped with `tenant_id` + composite-FK cross-tenant safety), `ai_workflow_handler_registry` is **platform-scoped** (no `tenant_id` column). Cross-tenant safety is enforced at the **execution** layer:
- All tenants see the same handler registry (read-only catalog)
- Each `ai_workflow_executions` row (SI-008 P-018) carries `tenant_id` + references `(handler_id, handler_version)` from the registry
- Handlers cannot leak tenant data: handler code runs in the AI Service with `tenant_id` provided at invocation time + tenant-scoped data access patterns per ADR-023

This mirrors other platform-scoped catalog tables (e.g., country regulatory placeholders, drug-interaction rulesets at platform scope) where read-shared infrastructure is safe but writes are platform_admin-restricted.

---

## Open questions for CDM author + AI Workflow Engine slice author + Platform AI Safety review

| # | Question | Owner | Severity |
| :---: | --- | --- | --- |
| OQ1 | Should `handler_id` enforce a canonical kebab-case naming convention via regex CHECK, OR remain free-form TEXT? | CDM author + AI Workflow Engine slice author | low |
| OQ2 | Should `version` be enforced as strict semver via regex CHECK, OR remain free-form TEXT? Aligns with SI-015 OQ1. | CDM author | low |
| OQ3 | Successor handler binding: should `deprecation_successor_handler_id` + `deprecation_successor_version` have a self-referential composite FK back to the registry (with CHECK that successor is not retired)? Current proposal defers to service-layer validation (simpler at v1.0). | CDM author | medium |
| OQ4 | Should the partial UNIQUE on `signature_hash` exclude `retired` rows (current: excludes deprecated + retired; only active + registered have the constraint), OR be more permissive (allow signature_hash reuse across retired handlers since they're no longer dispatchable)? Current proposal: `WHERE status IN ('registered', 'active')` only. | AI Workflow Engine slice author | medium |
| OQ5 | When a handler is `deprecated`, are existing form-template bindings to it: (a) still dispatchable (current proposal — deprecated handlers serve existing bindings + emit deprecation warning audit; only retired handlers fail runtime dispatch), OR (b) immediately undispatchable (deprecated = immediate runtime rejection)? Current proposal: (a) for operational continuity. | Platform AI Safety | medium |
| OQ6 | Should `ai_workflow_handler_audit_log` events be folded into the existing `audit_records` table (Cat B governance events) instead of a separate table? Current proposal: separate table because handler-registry lifecycle is platform-scoped (no `tenant_id`) while audit_records is tenant-scoped; the two have incompatible row shapes. Audit_records may ADDITIONALLY emit a Cat B reference event for each handler-registry mutation, but the per-row audit log lives in `ai_workflow_handler_audit_log`. | Platform AI Safety + AUDIT_EVENTS owner | medium |

These open questions will be surfaced + addressed during the Codex pre-ratification gate (target 3-5 rounds based on SI-001/SI-015 single-or-paired-entity precedent for similar scope).

---

## Resolution path

When SI-016 closes:

1. **Future PR-A2/A3-class commit** (at SI-016's own ratification SC) lands:
   - CDM v1.X → v1.Y with §3.14 NEW category "AI Workflow Registry — 2 entities" + §4.29 ai_workflow_handler_registry + §4.30 ai_workflow_handler_audit_log canonical row shapes
   - **9 BEFORE INSERT/UPDATE/DELETE triggers** (7 for registry: insert_guard + tier0_immutability + tier1_schema_immutability + status_state_machine + reject_delete + recompute_fingerprint-equivalent fold into tier1; 2 for audit_log: append_only_update_delete + insert_db_time_guard)
   - **4 SECURITY DEFINER procedures** (`register_handler` / `activate_handler` / `deprecate_handler` / `retire_handler`) — the ONLY write paths to registry; atomic registry-mutation + audit_log emission; IMPL-readiness-gated on SI-010 helpers (mirror SI-005/008/009 gate)
   - 1 composite FK + 2 composite UNIQUEs + 6+ CHECK constraints
   - GRANT model: `telecheck_app_role` SELECT only on both tables; `platform_admin_role` SELECT only on both tables + EXECUTE on the 4 procedures; direct INSERT/UPDATE/DELETE REVOKED from all roles on both tables
   - `compute_ai_workflow_handler_signature_hash()` DB function for canonical hashing
2. **SI-011.1d L4 Mode 2 input contract conformance gate canonical content port** is now unblocked (per SC7 P-024 Sub-decision #5 dependency caveat — SI-011.1d requires SI-016 ratification landing first; this SI-016 closure clears that gate)
3. **AI Workflow Engine slice PRD** (when authored) can author against canonical handler-registry row shapes
4. **Regression tests required:**
   - Tier 0 immutability test: attempt direct SQL UPDATE of handler_id/version/ai_workload_type/autonomy_level/registered_at → all MUST fail
   - Tier 1 schema immutability test: attempt UPDATE of input_validator_schema after row exists → MUST fail
   - State-machine allow-list test: each non-allow-listed transition MUST fail; each allow-listed transition MUST succeed with correct timestamp population
   - DB-owned signature_hash test: INSERT with caller-supplied signature_hash → MUST be silently overridden to DB-computed value
   - Signature_hash tamper-resistance test: UPDATE attempting to change signature_hash → MUST be re-derived from current input_validator_schema (defense-in-depth)
   - Partial UNIQUE test: INSERT a second row with same signature_hash but different (handler_id, version) while first is active → MUST fail
   - GRANT lockdown test: `telecheck_app_role` AND `platform_admin_role` BOTH attempting direct INSERT/UPDATE/DELETE on registry or audit_log MUST fail with permission denied (R1 HIGH closure: direct writes REVOKED from all roles)
   - SECURITY DEFINER procedure-only-write test: `platform_admin_role` calling `register_handler` / `activate_handler` / `deprecate_handler` / `retire_handler` MUST succeed; calling these procedures from any other role MUST fail with permission denied OR with `insufficient privilege` error
   - Atomic audit emission test: `register_handler` mutating registry MUST always emit a paired `handler.registered` audit_log row in the same transaction; manual rollback of audit_log INSERT alone (impossible via grants, but verify trigger-driven safety) MUST be structurally prevented (R1 HIGH closure)
   - Append-only audit_log test: UPDATE or DELETE on audit_log row MUST fail with trigger exception
   - Append-only registry test: DELETE on registry row MUST fail with `registry rows are forensic evidence` trigger exception (R2 MEDIUM-1 closure)
   - Cross-version FK test: INSERT into audit_log referencing a non-existent (handler_id, version) → MUST fail at composite FK
   - Successor-existence test: `deprecate_handler` with successor (handler_id, version) that doesn't exist → MUST fail with `successor not found` (R2 MEDIUM-2 closure)
   - Retired-successor-rejection test: `deprecate_handler` with successor whose status is `retired` → MUST fail with `cannot point to retired successor` (R2 MEDIUM-2 closure)
   - DB-time forcing test: INSERT with caller-supplied registered_at = past MUST be silently overridden to NOW()

---

## Cross-cutting impact

This SI is on the critical path for SI-011.1d L4 Mode 2 input contract conformance canonical content port + any future AI Workflow Engine slice handler-registration work. Landing it unblocks 2 downstream surfaces:
1. SI-011.1d canonical row shape ratification (which lands its own L4 gate logic + `forms.publish.mode_2_contract_invalid` audit IDs + `ai_workflow.contract_drift_detected` audit event)
2. AI Workflow Engine slice (when authored) implementation against handler-registry row shapes

The WORKLOAD_TAXONOMY v5.2 + AUTONOMY_LEVELS v5.2 + AI_LAYERING v5.2 contract surfaces are already complete; SI-016 is the **CDM-only** schema gap that closes the layered architecture for AI workflow handler registration + versioning + lifecycle audit.

---

## Spec references

- CDM v1.2 §3 entity inventory (will add §3.14 AI Workflow Registry category — 2 entities — at SI-016 closure; total entities 42 → 44 (post-SI-015) → 46 (post-SI-016))
- CDM v1.2 §4 row-shape expansion (will add §4.29 ai_workflow_handler_registry + §4.30 ai_workflow_handler_audit_log)
- WORKLOAD_TAXONOMY v5.2 (`AIWorkloadType` enum; v1.0 active = `conversational_assistant` + `protocol_execution`)
- AUTONOMY_LEVELS v5.2 (`AutonomyLevel` enum; v1.0 active = `advisory` + `action_with_confirm`)
- AI_LAYERING v5.2 (legacy Mode 1/Mode 2 framing; superseded prospectively by ADR-029)
- ADR-029 (AI Workload Taxonomy + Autonomy Levels, Accepted at v1.10)
- ADR-002 (AI Service architecture; legacy at v1.0 active)
- ADR-030/031/033 (RESERVED future ADRs for autonomous_agent / tool_using_agent / multi_agent_supervisor activation; not in v1.0 scope)
- Master PRD v1.10 §13.7 (AI workload taxonomy normative surface)
- SI-008 P-018 (AiWorkflowExecution row shape — references handlers but registry was a gap; this SI closes that gap)
- SI-011 UMBRELLA P-024 Sub-decision #5 + #9 (SC7 ratification 2026-05-18 — SI-011.1d depends on SI-016)
- SI-015 (sibling dependency SI for MarketingCopy CDM; both filed at SC7 P-024 + ratified independently)
- SI-001 / SI-005 / SI-009 / SI-009.1 / SI-015 (precedent disciplines for CDM schema-gap closure: composite UNIQUE + state-machine triggers + DB-owned content/signature hashing + Tier 0/1/2 invariants + DB-clock-anchored timestamps + I-003 append-only parity)
- INVARIANTS §I-003 (audit append-only — ai_workflow_handler_audit_log inherits the discipline)
- INVARIANTS §I-012 (reject-unless three-clause rule for action_with_confirm executions; handlers' autonomy_level is the gating value)
- INVARIANTS §I-023..I-027 (tenant isolation — platform-scope tables enforce isolation at execution layer; registry is shared catalog)
- INVARIANTS §I-027 (audit append-only — handler-registry lifecycle audit chain is platform-floor)

---

## Status

- **Filed:** 2026-05-18 (autonomous run; post-SC7 P-024 SI-011 UMBRELLA Sub-decision #5 + #9 dependency execution; sibling to SI-015)
- **Author:** Autonomous Claude
- **Target Promotion Ledger entry:** **TBD future P-NUM** (gap slot — likely P-017 or P-022 per post-SC7 unclaimed-slot inventory; or next-available after canonical-content-port wave for sub-ceremonies 1-6)
- **Codex pre-ratification gate:** v0.1 filed 2026-05-18 (this commit); formal gate commences with this PR open. Estimated 3-5 rounds based on SI-001/SI-015 paired-entity precedent for similar scope.
- **Blocks:** SI-011.1d L4 Mode 2 input contract conformance canonical content port; AI Workflow Engine slice implementation against handler-registry row shapes
- **Does NOT block:** SC1–SC7 ratifications (all closed); SI-009.1 / SI-015 ratifications (independent surfaces); SI-011.1a + SI-011.1b (independent sub-SIs); any tenant-scoped SI
- **Companion SIs:** SI-001 (MedicationRequest precedent ✅ closed at P-011); SI-005 (Consult + ConsultEvent precedent ✅); SI-008 (AiWorkflowExecution — references handlers; this SI closes the registry gap that SI-008 references ✅); SI-009 (SyncSession precedent ✅); SI-009.1 (SyncSessionParticipants + SyncSessionRecordings precedent — pre-ratification converged); SI-011 UMBRELLA (parent — closed at P-024 SC7); SI-015 (sibling SC7 dependency SI for MarketingCopy CDM — pre-ratification converged)

— Claude (Opus 4.7, 1M context), 2026-05-18 SI-016 v0.1 DRAFT filed per SC7 P-024 SI-011 UMBRELLA Sub-decision #5 + #9 dependency execution. Pre-Codex pre-ratification gate ahead per SI-001/SI-015 retrospective discipline.
