# Crisis Response (SI-022) Implementation Plan

**Status:** PR 1 in progress (migration 032 RBAC roles + this plan doc committed; migration 033 entities authoring next).
**Spec source:** `../telecheckONE/Telecheck Master Bundle FINAL US REGION BASELINE/Telecheck_SI_022_Crisis_Response_v1_0.md` + `Telecheck_CDM_v1_9_to_v1_10_Amendment.md` (P-039 + P-040 RATIFIED 2026-05-21).
**Branch:** `feat/crisis-response-pr1-foundation` (this branch; subsequent migrations land as separate PRs).
**Ratifier decision 2026-05-22 — Option 2 (adapt to existing code-repo patterns):** Evans chose to adapt the spec to existing code-repo patterns rather than land the spec-canonical foundation first. Rationale: pilot timeline pressure; foundation rework can be paid back in a later hygiene cycle (the canonical `jwt_migration_entity_status` tracking the spec built specifically for this is the right vehicle when foundation work resumes). See "Adapted plan (Option 2)" section below — the Option 1 prerequisite sequence in the original plan is SUPERSEDED.

---

## ADAPTED PLAN (Option 2 ratified 2026-05-22)

Migration sequence under Option 2:

| Migration | Purpose | Status |
|---|---|---|
| 032 | Crisis Response RBAC roles (15 roles, NOLOGIN + non-BYPASSRLS) | ✅ MERGED at `ca44925` (foundation-independent; works for either option) |
| **033** | **Crisis Response entities + notification baseline (inline) + RLS + per-table append-only triggers + monotonic-ordering trigger** | **NEXT** |
| 034 | Crisis Response derived views (R1 HIGH-2 staff/patient split) | After 033 |
| 035+ | SECDEF wrappers (adapted to SI-010 `current_actor_*()` helpers + `current_tenant_id()` GUC; spec uses SI-024.1 helpers — divergence documented inline) | After 034 |
| 036+ | Fastify `src/modules/crisis-response/` module + routes + audit emitters + integration tests | After 035 |

**Option 2 adaptations from spec:**
- **RLS predicate:** `tenant_id = current_tenant_id()` (code-repo pattern from migration 003) — NOT spec's `current_tenant_id_strict('entity_name')` (SI-024.1)
- **Actor identity in wrappers:** `current_actor_account_id()` + `current_actor_role()` + `current_actor_account_tenant_id()` (SI-010 from migration 031) — NOT spec's `verify_session_jwt_and_extract_claims().verified_principal_id`
- **Append-only triggers:** per-table inline trigger functions (audit_chain pattern from migration 002) — NOT spec's generic `enforce_append_only()`
- **Terminal-row-immutable:** per-table inline trigger function for `crisis_sweep_execution` — NOT spec's generic `enforce_terminal_row_immutable()`
- **`patient_id` FK:** column kept as `UUID NOT NULL` but FK constraint to `patient(tenant_id, id)` SKIPPED (no patient table exists; logical reference only; TODO documented inline for future migration when patient lands)
- **`server_signal_id` FK:** column kept as `UUID NOT NULL` but FK constraint to Mode 1 conversation envelope SKIPPED (Mode 1 entities not in code repo; logical reference only; TODO documented inline)
- **`notification_crisis_*` 3 tables:** inline-created in migration 033 as part of this slice (rather than as a separate P-027 baseline migration; SI-022 is the first slice that needs them)
- **`jwt_migration_entity_status` seed:** SKIPPED at v1.0 (the migration-tracker table itself doesn't exist; will be added in the future foundation hygiene cycle alongside the SI-024.1 trust-anchor migration)

**Recorded divergences from spec (to be reconciled in future hygiene cycle):**
- Crisis Response uses `current_tenant_id()` + SI-010 actor helpers — spec uses `current_tenant_id_strict()` + SI-024.1 JWT helpers. Both are tenant-binding mechanisms; the SI-010 pattern is GUC-based (legacy) and the SI-024.1 pattern is JWT-claim-based (canonical). Migration to SI-024.1 happens in a future hygiene cycle when foundation work resumes.
- Append-only trigger functions are per-table inline (not generic). When generic helpers land, individual triggers can be replaced with generic-helper invocations.
- `patient_id` + `server_signal_id` FKs are unenforced. When `patient` table + Mode 1 entities land, ALTER TABLE statements add the FK constraints + backfill validation.

---

## ORIGINAL PLAN (Option 1 — SUPERSEDED 2026-05-22 by ratifier decision)

The text below is preserved for traceability of what was considered + rejected. Option 1 would have required ~6 foundation migrations (033-038) BEFORE Crisis Response entities could land. Total timeline 12-28 days. Ratifier chose pilot-timeline-pressure path (Option 2) above.

---

## Foundation gap discovered 2026-05-22

Crisis Response cannot land as a clean spec lift onto the current code repo state. The spec assumes 6 foundation pieces that don't yet exist in `migrations/`:

| Spec dependency | Code repo state | Gap-closing migration |
|---|---|---|
| `current_tenant_id_strict()` RLS helper (SI-024.1 v0.8, ratified at spec P-031) | Code uses `current_tenant_id()` from migration 003 (different helper, GUC-based) | **Migration 033** — SI-024.1 trust anchor |
| `tenant_account_membership` table (SI-024.1 JWT-principal-to-role binding) | Doesn't exist; SI-010 `current_actor_*()` is the current trust anchor | Migration 033 |
| `verify_session_jwt_and_extract_claims()` function | Doesn't exist | Migration 033 |
| `jwt_migration_entity_status` tracking table (CDM v1.6 §4.NEW5 from spec P-032) | Doesn't exist | **Migration 034** |
| `enforce_append_only()` + `enforce_terminal_row_immutable()` generic trigger helpers | Code uses per-table inline trigger functions (audit_chain pattern at migration 002) | **Migration 035** |
| `patient` table (FK target for `crisis_event.patient_id`) | Doesn't exist; Identity slice's patient entity not yet built | **Migration 036** |
| `notification_crisis_dispatch_ledger` + `notification_crisis_provider_attempt` + `notification_crisis_escalation_obligation` (P-027 §4.66-4.68) | None exist | **Migration 037** |
| `ai_mode1_conversation` + 4 other Mode 1 entities + `ai_mode1_conversation_state` view (P-035 + P-036 + P-036a) | Doesn't exist; `src/modules/ai-service/` scaffold only | **Migration 038** |

## Prerequisite migrations (in order)

Each migration is its own PR with Codex APPROVE gate before merge. RBAC roles for any future slice are added in their respective foundation migrations alongside the entities they own.

### Migration 032 — Crisis Response RBAC roles ✅ MERGED at `ca44925`

15 net-new roles, no dependencies. Foundation-independent.

### Migration 033 — SI-024.1 JWT trust anchor (NEXT)

**Purpose:** Add the canonical JWT-binding helpers + tenant_account_membership entity. **Does NOT replace** SI-010 `current_actor_*()` helpers — coexists. New slices (Crisis Response, Admin Backend, future) use SI-024.1; existing slices (async-consult, med-interaction) keep SI-010 until per-entity migration.

**Artifacts:**
- `tenant_account_membership` table with composite `(tenant_id, account_id)` UNIQUE
- `verify_session_jwt_and_extract_claims()` SECURITY DEFINER function (reads JWT from request GUC; returns verified_tenant_id + verified_principal_id + verified_role_names[])
- `current_tenant_id_strict(p_entity_name TEXT)` function (asserts GUC is set; returns verified tenant_id from session_jwt_admission audit)
- `session_jwt_admission` audit table (per CDM v1.6 §4.NEW4 from spec P-032)

**Spec:** spec P-031 SI-024.1 v0.8 ratification ceremony + P-032 CDM v1.5 → v1.6 trust-anchor entities.

### Migration 034 — jwt_migration_entity_status

**Purpose:** Per-entity migration tracker for "is this entity now bound to SI-024.1 JWT helper vs still using raw GUC fallback." Required by every new slice's preflight per spec convention.

**Artifacts:**
- `jwt_migration_entity_status(entity_name, phase_4_cutover_eligible BOOLEAN, raw_guc_fallback_audited BOOLEAN)` per CDM v1.6 §4.NEW5

**Spec:** spec P-032.

### Migration 035 — Generic trigger helpers

**Purpose:** Spec-canonical reusable trigger functions. Eliminates per-table boilerplate for append-only + terminal-row-immutable patterns.

**Artifacts:**
- `enforce_append_only()` — `RAISE EXCEPTION 'append-only per I-027'`
- `enforce_terminal_row_immutable()` — when `OLD.completed_at IS NOT NULL`, blocks mutation

**Spec convention:** Used across Mode 1 / Crisis Response / Admin Backend lifecycle entities.

### Migration 036 — Identity patient entity

**Purpose:** Crisis Response + future slices need `patient(tenant_id, id)` FK target. Defer the full Identity slice; ship only the minimal `patient` entity now.

**Artifacts:**
- `patient` table with composite `(tenant_id, id)` UNIQUE + RLS + tenant-scoped composite FK to `tenants`

**Note:** Full Identity slice (patient_profile, patient_contact, etc.) is out of scope for this PR series; Crisis Response only needs the bare `patient` row as FK target.

### Migration 037 — P-027 notification baseline (3 tables)

**Purpose:** Crisis Response §4.EXT1/EXT2/EXT3 ALTER TABLE statements assume these exist. Spec P-027 §4.66-4.68 created them; code repo never landed them.

**Artifacts:**
- `notification_crisis_dispatch_ledger` (baseline schema; crisis_event_id column added by migration 039)
- `notification_crisis_provider_attempt` (baseline; crisis_event_id + recipient_principal_id + sweep_cycle_id columns added later)
- `notification_crisis_escalation_obligation` (baseline)

**Spec:** spec P-027 Contracts Pack v5.2 §4.66-4.68 baseline entities.

### Migration 038 — P-035 + P-036 + P-036a Mode 1 entities

**Purpose:** Crisis Response `crisis_event.server_signal_id` is FK to Mode 1's signal envelope. Need Mode 1 baseline.

**Artifacts:**
- 5 Mode 1 entities (ai_mode1_conversation, conversation_turn_admission, conversation_turn_detector_result, conversation_turn_result, conversation_archival_event)
- 1 derived view (ai_mode1_conversation_state, plain view post-R7) per P-036 + P-036a (Evans Option A) closure
- 6-entry `jwt_migration_entity_status` seed (5 base tables + 1 view per P-036a fix)

**Spec:** spec P-035 Mode 1 Handler v1.0 + P-036 CDM v1.7 → v1.8 follow-on + P-036a seed-scope fix.

### Migration 039 — Crisis Response entities + RLS + triggers (THE Crisis Response migration)

**Purpose:** Land the 3 crisis entities the spec requires. Builds cleanly on migrations 033-038.

**Artifacts:**
- `crisis_event` (UUID PK + 8-column KMS envelope for intake_payload + tenant-scoped composite FK to patient + UNIQUE(tenant_id, server_signal_id))
- `crisis_event_lifecycle_transition` (BIGSERIAL PK + 11 CHECK-enforced state transition triples per spec §6 + composite tenant-scoped FK to crisis_event + monotonic-ordering BEFORE INSERT trigger)
- `crisis_sweep_execution` (UUID PK + lease-takeover semantics + fencing-token + partial UNIQUE on open rows + terminal-row-immutable trigger)
- Additive columns on the 3 P-027 notification_crisis_* entities
- RLS policies + indexes
- 3-entry `jwt_migration_entity_status` seed for the 3 new tables

### Migration 040 — Crisis Response derived views (PR 2)

**Purpose:** R1 HIGH-2 staff/patient reader-view split.

**Artifacts:**
- `crisis_event_current_state_v` (tenant-wide staff view; security_invoker=true + security_barrier=true; SELECT granted to crisis_event_staff_reader)
- `crisis_event_patient_summary_v` (self-scoped patient view; predicate-restricted via SI-024.1 JWT + consent_grant; SELECT granted to crisis_event_patient_reader)
- 2-entry `jwt_migration_entity_status` seed for the 2 views

### Migrations 041-046+ — Crisis Response SECDEF wrappers (PR 3-4)

7 procedures per spec §3.1-§3.6: 1 raw lifecycle writer + 5 wrappers (initiation + acknowledgement + response + resolution + sweep) + class K CTAS provenance event trigger.

### Migration 047+ — Crisis Response Fastify module + routes + integration tests (PR 5+)

`src/modules/crisis-response/` per code-repo module convention (index.ts + plugin.ts + routes.ts + audit.ts + events.ts + internal/...).

## Sequencing rationale

Why this order:
1. **033 (trust anchor)** is foundational — every subsequent slice needs `current_tenant_id_strict()` for RLS + tenant_account_membership for LAYER B authorization
2. **034 (migration tracker)** is referenced by every subsequent slice's preflight
3. **035 (trigger helpers)** is referenced by 036-039+ entity DDL
4. **036 (patient)** is FK target for 039
5. **037 (notifications)** is required by 039's §4.EXT ALTER TABLE statements
6. **038 (Mode 1)** is FK target for 039's `server_signal_id`
7. **039 (Crisis Response entities)** is the canonical lift from spec P-040 §4.NEW1-NEW3 + §4.EXT1-EXT3

Each migration is independently reviewable + ships its own Codex APPROVE before merge. The series can pause/resume at any migration boundary.

## Estimated effort

- Migrations 033-038 (foundation): ~6 PRs, ~1-2 days each with Codex iteration → ~6-12 days total
- Migration 039-040 (Crisis Response schemas + views): ~2 PRs, 1-2 days each → ~2-4 days
- SECDEF wrappers + integration: ~4-6 PRs, ~1-2 days each → ~4-12 days

**Total Crisis Response implementation timeline: ~12-28 days of careful work**, gated by Codex APPROVE on each PR.

For a pilot-launch deadline, this may be too long. Alternatives:
- **Adapt the spec to the code repo's existing patterns** (use `current_tenant_id()`, SI-010 actor helpers, per-table trigger funcs) — saves ~4-6 PRs of foundation but creates a divergence from canonical spec that will need to be paid down later.
- **Parallelize foundation PRs** — migrations 033-038 don't depend on each other in series; pairs/triples can land in parallel branches.

## Cross-slice readiness

Migrations 033-038 unblock ALL 5 pilot slices (Med-Interaction + Mode 1 + Async-Consult + Crisis Response + Admin Backend), not just Crisis Response. The foundation work amortizes across the full pilot scope.
