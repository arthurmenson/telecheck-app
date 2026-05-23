# Medication Interaction & Validation Engine (SI-019) Implementation Plan

**Status:** PR 3 in progress (migration 048 read-path MV/view/access-function + a prerequisite grant-defect fix in migration 047). PR 1 (046 RBAC roles) + PR 2 (047 entities) MERGED to main.
**Spec source:** `../telecheckONE/Telecheck Master Bundle FINAL US REGION BASELINE/Telecheck_Medication_Interaction_Engine_Slice_PRD_v2_0.md` (P-033 RATIFIED 2026-05-21) + `Telecheck_CDM_v1_6_to_v1_7_Amendment.md` (P-034 RATIFIED 2026-05-21; the authoritative CDM/AUDIT/OpenAPI/State-Machines/RBAC follow-on landing).
**Branch:** `feat/med-interaction-pr1-rbac-roles` (this branch; subsequent migrations land as separate PRs).
**Why this slice is critical path:** the interaction engine runs BEFORE a clinician commits a `medication_request` (I-002 hard rule). The signal lifecycle this slice persists is what the Pharmacy clinician-commit gate, refill-release checks, and Mode 2 protocol gates read at STRICT-FRESHNESS (P-034 §4.NEW5 read-path classification). Med-Interaction unblocks the Pharmacy clinician-commit path; it is the first P-NUM in the Master Completion Plan v1.0 Phase B fan-out (Track 1 Ghana revenue anchor).

**Ratifier decision — Option 2 (adapt to existing code-repo patterns):** carryforward from the Crisis Response + Admin Backend PR series (see `docs/crisis-response-implementation-plan.md` for the originating ratifier decision 2026-05-22). The Med-Interaction DB layer adapts the spec to the code repo's existing patterns (`current_tenant_id()` GUC, SI-010 actor helpers, per-table inline triggers) rather than landing the SI-024.1 JWT trust-anchor foundation first. Foundation rework is paid back in a later hygiene cycle.

---

## Migration sequence (Option 2)

| Migration | Purpose | Status |
|---|---|---|
| **046** | Med-Interaction RBAC roles (12 roles: 4 application + 6 wrapper-owner + 2 service-level owner; NOLOGIN + non-BYPASSRLS; no grants) | MERGED (PR 1) |
| 047 | 4 entities (`interaction_engine_evaluation` + `interaction_signal` + `interaction_signal_override` + `interaction_signal_lifecycle_transition`) + RLS + per-table append-only triggers (I-035) + state-transition-triple CHECK + monotonic/advisory-lock-serialized write discipline | MERGED (PR 2); grant-defect fixed in PR 3 (see below) |
| **048** | **Optional `interaction_signal_current_state_mv` materialized view + `interaction_signal_current_state_v` SECURITY BARRIER view + `get_interaction_signal_current_state()` SECURITY DEFINER access function (P-034 §4.NEW5; both MV-access patterns permitted per OQ3)** | **THIS PR (PR 3)** |
| 049 | Raw lifecycle writer `record_interaction_signal_lifecycle_transition()` SECDEF (§6.NEW1) + anti-bypass EXECUTE matrix (wrapper-owners only) + BIGSERIAL/sequence USAGE grant if the transition PK is BIGSERIAL (per the migration 045 hotfix precedent) | After 048 |
| 050+ | 6 SECDEF wrappers (emission / activation / supersession / resolution / expiry per §6.NEW2-NEW6 + override per §6.NEW7) with reason-specific evidence checks | After 049 |
| 051+ | Fastify `src/modules/med-interaction/` route wiring + audit emitters + integration tests | After 050 |

### 12 RBAC roles created in migration 046 (P-034 §8)

**Application (4):** `medication_interaction_engine_evaluator`, `medication_interaction_signal_viewer`, `medication_interaction_override_recorder`, `medication_interaction_knowledge_base_updater`.

**Wrapper-owner (6):** `emission_wrapper_owner`, `activation_wrapper_owner`, `override_wrapper_owner`, `superseded_wrapper_owner`, `resolution_wrapper_owner`, `expiry_wrapper_owner`.

**Service-level owner (2):** `lifecycle_transition_writer_owner` (raw transition writer; sole INSERT grantee on the transition table), `mv_refresh_owner` (MV + access function; refresh/reconciliation scheduler).

---

## PR 3 prerequisite — migration 047 grant-defect fix

Migration 047 (merged as PR 2) granted INSERT/SELECT on `interaction_signal_override`
and `interaction_signal_lifecycle_transition` to three **slice-prefixed** owner-role
names — `interaction_signal_override_wrapper_owner`,
`interaction_signal_lifecycle_transition_writer_owner`, and
`interaction_signal_mv_refresh_owner` — that **no migration creates**. Migration 046
(PR 1) and P-034 §8 both name those owner roles in their **bare** forms
(`override_wrapper_owner`, `lifecycle_transition_writer_owner`, `mv_refresh_owner`).
A fresh `000→047` apply therefore aborted at the override-grant block with
`ERROR: role "interaction_signal_override_wrapper_owner" does not exist`, blocking
all downstream Med-Interaction DB work (including 048, which depends on 047's tables).

PR 3 corrects the three grant targets in 047 to the bare canonical names created by
046. This is a mechanical naming fix (the canonical names are unambiguous per 046 +
spec §8), not a new architectural decision. The migrations are pre-deployment (no
prod/staging has run them; CI is not yet wired for this slice), so the fix is applied
in place rather than as a forward-only migration — a forward-only fix could not help
because 047 aborts mid-file before any later migration runs. Verified empirically: a
clean `000→048` apply now completes against a throwaway PostgreSQL 16 cluster.

## Recorded Option 2 divergences from spec (to be reconciled in a future hygiene cycle)

- **Read-path Option 2 adaptations (migration 048):** `current_tenant_id_strict('interaction_signal_current_state_mv')`
  (spec §4.NEW5 R5 HIGH-1 SI-024.1 JWT trust anchor) → `current_tenant_id()` (code-repo
  GUC trust anchor) on both the SECURITY BARRIER view and the SECDEF access function;
  `ulid_t` → `VARCHAR(26)`; declared return domains `interaction_signal_state_t` /
  `interaction_signal_transition_reason_t` → `TEXT` (MV columns are already TEXT, so the
  spec's R1 MED-1 explicit casts are no-ops and omitted). The MV is applier-owned with
  explicit SELECT to `mv_refresh_owner`; the access function is `OWNER TO mv_refresh_owner`
  per spec. Same SI-024.1 cutover deferral posture as 047/041/034.

- **Dotted → underscore role names (migration 046):** P-034 §8 names two application roles with a dot (`medication_interaction.override_recorder`, `medication_interaction.knowledge_base_updater`). An unquoted dotted identifier is not a valid PostgreSQL role; the code repo has zero quoted-dotted roles. Realized as `medication_interaction_override_recorder` + `medication_interaction_knowledge_base_updater`. The spec is itself internally inconsistent (Sub-decision 6 dotted vs the §6 wrapper-grant matrix underscored). Mechanical DB-realization, not a new architectural decision. Migration 046's verification block asserts the dotted forms do NOT exist (anti-drift).
- **`medication_interaction_resolution_subscriber` NOT created here:** P-034 §8 states it is "defined elsewhere" (Async Consult domain-event subscriber RBAC registry); it is referenced in the §6.NEW1-NEW6 EXECUTE-grant table only for completeness. The resolution-wrapper EXECUTE grant to it lands when the Async Consult subscriber registry creates it.
- **Wrapper-owner role names verbatim from spec (bare, not slice-prefixed):** P-034 §8 names the 6 wrapper-owner roles `emission_wrapper_owner` … `expiry_wrapper_owner` and the 2 service-level owners `lifecycle_transition_writer_owner` / `mv_refresh_owner` without a `medication_interaction_` prefix. These are kept verbatim so the downstream procedure-DDL `OWNER TO` / `GRANT EXECUTE` statements (migrations 049-050) match the canonical spec text exactly. (These names are generic relative to the cluster-global PostgreSQL role namespace; if a future slice needs a same-named owner role, the collision is reconciled at that point. Flagged here as an observation, not a divergence — migration 046 matches the spec.)
- **Trust anchor (later migrations):** Med-Interaction SECDEF wrappers (049-050) will use `current_tenant_id()` + SI-010 `current_actor_*()` helpers, NOT the spec's post-P-034 SI-024.1 JWT-binding helpers (`verify_session_jwt_and_extract_claims()` + `current_tenant_id_strict()`), matching the Crisis Response + Admin Backend Option 2 carryforward. Migration to SI-024.1 happens in a future foundation hygiene cycle.
- **`patient_id` FK (later migrations):** `interaction_signal.patient_id` kept as a logical reference; FK constraint to a `patient(tenant_id, id)` table SKIPPED until the Identity patient entity lands (same posture as Crisis Response `crisis_event.patient_id`).

---

## Sequencing rationale

Each migration is its own PR with a Codex APPROVE gate before merge. RBAC roles land first (migration 046) because they are foundation-independent (no FK targets, no table/procedure dependencies) and are the privilege boundary the later procedure migrations bind EXECUTE to. The series can pause/resume at any migration boundary. This mirrors the Crisis Response (032 → 033 → … → 038) and Admin Backend (039 → 040 → … → 044) cadence exactly.
