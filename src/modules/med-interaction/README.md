# `src/modules/med-interaction/` — Medication Interaction & Validation Engine module

Implementation of **SI-019 Medication Interaction & Validation Engine Slice PRD v2.0** (RATIFIED 2026-05-21 P-033) + the canonical follow-on **CDM v1.6 → v1.7 Amendment** (RATIFIED 2026-05-21 P-034 — co-bumped AUDIT_EVENTS v5.8 → v5.9 + OpenAPI v0.2 → v0.3 + State Machines v1.1 → v1.2 + RBAC v1.1 → v1.2).

## Status: Sprint 1 (PR 6 of 6 DB-layer series — this commit) — **DB LAYER COMPLETE; Fastify scaffold update**

Spec layer is **complete + ratified**. **DB layer is COMPLETE through migration 050** (PRs 1-5 merged; 21 Codex adversarial-review rounds total across the series). This PR (6 of 6) is the Fastify scaffold update reflecting the post-DB-layer state — the `/health` blocker payload + `/ready` reason now describe the DB layer as complete with Fastify handler implementation as the sole remaining blocker (lands PR 7+).

Med-Interaction is the **Master Completion Plan v1.0 "new critical path"** per the 2026-05-15 implementation audit — the I-002 hard rule (interaction engine runs BEFORE clinician commits `medication_request`) gates Pharmacy clinician-commit + refill-release + Mode 2 protocol-execution paths. Pilot launch (Telecheck-Ghana revenue anchor) does not progress past clinician-commit until this slice's signal lifecycle + Fastify handlers are live.

### DB layer PR progression (CLOSED through PR 6 of 6)

| PR | Migration | What | Codex rounds |
|---|---|---|---|
| 1 | 046 | **12 RBAC roles** — 4 application + 6 wrapper-owner + 2 service-level-owner. NOLOGIN + non-BYPASSRLS. No grants. | 5 (stale-prose hygiene across 8 files) |
| 2 | 047 | **4 entities** — `interaction_engine_evaluation` + `interaction_signal` (state DERIVED per I-035 Option A; NO state column) + `interaction_signal_override` (8-col KMS envelope) + `interaction_signal_lifecycle_transition`. RLS + per-table append-only triggers + server-assigned monotonic-ordering trigger (`clock_timestamp()` + auto-bump) with state-continuity check + caller-tenant guard. | 7 (monotonic-ordering trigger hardening) |
| 3 | 048 | **1 SECURITY BARRIER view** (`interaction_signal_current_state_v`) + **1 optional MV** (`interaction_signal_current_state_mv`) + **SECDEF access function** (`get_interaction_signal_current_state`) + MV access-discipline (preflight + immediate REVOKE PUBLIC + aclexplode loop for inherited grants + final verifier; no BEGIN/COMMIT per transactional-runner safety). | 5 (MV-access-discipline defense-in-depth) |
| 4 | 049 | **Raw lifecycle writer SECDEF** (`record_interaction_signal_lifecycle_transition`) + anti-bypass EXECUTE matrix to the 6 wrapper-owner roles only + STEP 3.5 activation-override-evidence check under per-(tenant, signal) advisory lock (R1 closure) + writer-owner GRANT SELECT on `interaction_signal_override` for SECDEF read (R2 closure). | 3 |
| 5 | 050 | **6 reason-specific lifecycle wrappers** — 3 operational (emission + activation + supersession) + 3 **fail-closed** (resolution + expiry + override; RAISE EXCEPTION SQLSTATE `0A000` pending evidence-source migrations from Async Consult / Pharmacy / LAYER B). All wrappers: SECDEF + locked search_path + OWNED BY wrapper-owner + SI-010 tenant guard + per-(tenant, signal) advisory lock matching the raw writer. | 3 (incl. CRITICAL R2 fix on UNREACHABLE-block comment-syntax that would have blocked migration application) |
| 6 | n/a | **Fastify scaffold update (this commit)** — module-level `README.md` + `routes.ts` `/health` blocker payload + `/ready` reason message + plugin/index/internal-types header doc-blocks + integration-test assertions updated to reflect DB layer COMPLETE through migration 050. No DB or HTTP-handler delta; pure docs/test alignment closing the DB-layer series. | (Sprint 1 PR 6) |
| 7+ | n/a | **Fastify handler implementation** — 8 endpoints per SI-019 §5 + CDM §6 OpenAPI v0.3 (signal-check, override-record, lifecycle actions). Cat A audit emission (6 events: 4 Cat A + 2 Cat B). LAYER B role-membership check at route layer. Integration tests for tenant isolation + I-002 ordering invariant. |

### What ships at PR 6 (this commit)

- `README.md` Status header + PR-progression table updated to reflect DB layer COMPLETE through migration 050 (21 Codex rounds total)
- `routes.ts` `/health.blocked_message` rewritten to advertise post-PR-5 state with per-migration Codex-round counts
- `routes.ts` `/ready.reason_message` updated to describe Fastify handler implementation as the sole remaining DB-layer-to-HTTP gap
- `plugin.ts` + `index.ts` + `internal/types.ts` header doc-blocks updated to reflect post-PR-5 entities + views + writers + wrappers state
- Integration test (`tests/integration/med-interaction-plugin-wiring.test.ts`) assertion `PR 6+` → `PR 7+` to match the renumbered handler-PR series
- No DB delta. No HTTP-handler delta. Pure docs/test alignment closing the DB-layer series.

### What does NOT ship at PR 6

- Row-shape interfaces / repository files / service files for the 4 entities (lands PR 7+ when handlers are wired)
- Real HTTP handlers (POST /signals/check, POST /overrides, GET /rulesets/:id, etc.) — land PR 7+
- Vendor adapter abstraction (interaction databases like First Databank, Lexicomp) — per ADR-022 native-first / open-source-first preference; lands when handler implementation begins
- Audit / domain event emitters — land PR 7+ when handlers are wired
- Fail-closed wrapper unblock (resolution / expiry / override) — requires Async Consult discontinuation-event log + per-basis cadence config table + active-medication-list view + LAYER B; lands in cross-slice integration cycles after PR 7+

## Module structure (per `src/modules/README.md` template)

```
med-interaction/
├── index.ts              ← public interface (cross-module-safe exports)
├── plugin.ts             ← Fastify plugin entry point (registered in src/app.ts under /v0/med-interaction)
├── routes.ts             ← Sprint 1: health + ready only; PR 7+ adds handlers
├── README.md             ← this file
└── internal/             ← module-private; no cross-module imports allowed
    └── types.ts          ← branded IDs + canonical state/severity/check-class vocabularies
    └── handlers/         ← (PR 7+) endpoint handler files
    └── services/         ← (PR 7+) signal evaluator, override workflow
    └── repositories/     ← (PR 7+) tenant-scoped DB access
    └── adapters/         ← (PR 7+) vendor interaction-database abstractions
```

## Option 2 ratifier decision (carryforward from Crisis Response + Admin Backend)

Per ratifier Option 2 (`docs/crisis-response-implementation-plan.md` + `docs/med-interaction-implementation-plan.md`): adapt to existing code-repo patterns rather than land the SI-024.1 / strict-helper foundation prerequisites first. Recorded divergences from spec (to be reconciled in future hygiene cycle):

- **Trust anchor:** SQL wrappers use SI-010 `current_actor_*()` helpers (migration 031), not SI-024.1 `verify_session_jwt_and_extract_claims()`.
- **RLS predicate:** `current_tenant_id()` (code-repo pattern from migration 003), NOT spec's `current_tenant_id_strict(entity_name)`.
- **Trigger functions:** per-table inline functions (audit_chain pattern from migration 002), NOT spec's generic `enforce_append_only()`. Append-only enforcement on `interaction_signal_lifecycle_transition` lives in the per-table append-only trigger from migration 047; the monotonic-ordering trigger lives alongside it.
- **Role naming:** the two dotted application-role names in P-034 §8 (`medication_interaction.override_recorder` + `.knowledge_base_updater`) are realized as their underscore forms — unquoted dotted identifiers are not valid PG roles. The verification block in migration 046 asserts the dotted forms are absent (anti-drift). Documented in migration 046 inline.
- **Audit emission:** Cat A audit emission deferred from SQL wrappers to the application layer (the Fastify route handler MUST wrap the SECDEF wrapper call + `audit_records` INSERT in a single DB transaction so a partial commit cannot leave a SECDEF effect without its audit record). Lands PR 7+.
- **LAYER B (role-membership) authorization:** deferred from SQL wrappers to Fastify route layer (spec calls `tenant_account_membership` which doesn't exist in code repo). Lands PR 7+.
- **`medication_interaction_resolution_subscriber`** referenced by P-034 §8 as "defined elsewhere — Async Consult slice domain-event subscriber RBAC"; NOT created in migration 046. EXECUTE GRANT on `record_signal_resolution` was DEFERRED in migration 050 pending the role's creation by Async Consult slice work.
- **Fail-closed wrappers (resolution / expiry / override) at migration 050:** the 3 terminal-lifecycle wrappers RAISE EXCEPTION SQLSTATE `0A000` (`feature_not_supported`) until their evidence sources land in the code repo (Async Consult discontinuation-event log; per-basis cadence config table; active-medication-list view + LAYER B). Structural integrity preserved (signatures + grants + tenant guard + advisory lock present); production writes blocked until evidence sources exist. Closed PR 5 R1 HIGH×3.

See `docs/med-interaction-implementation-plan.md` for the full PR-by-PR plan + ratifier rationale.

## Hard rules (platform-floor)

- **I-002**: interaction engine **runs BEFORE the clinician commits a `medication_request`**. Not after, not in parallel. This binds at the Pharmacy + Async Consult clinician-commit boundaries; the Med-Interaction module exposes the synchronous signal-check surface that those boundaries call.
- **I-015**: knowledge-base version updates are **dual-control** (admin role gated by Admin Backend approval workflow).
- **I-023**: every PHI-touching query is tenant-filtered (RLS + app-layer + per-tenant KMS three-layer enforcement).
- **I-025**: error responses do not leak cross-tenant existence (tenant-blind envelopes).
- **I-027**: audit records carry `tenant_id` always (append-only per I-003).
- **I-035**: `interaction_signal_lifecycle_transition` is append-only (Option A per SI-019 OQ7 ratification at P-033). `interaction_signal.state` is DERIVED from the append-only transition log — no state column on the signal table.

## Spec references

- `Telecheck_Medication_Interaction_Engine_Slice_PRD_v2_0.md` (RATIFIED 2026-05-21 P-033)
- `Telecheck_CDM_v1_6_to_v1_7_Amendment.md` (RATIFIED 2026-05-21 P-034)
- `Telecheck_State_Machines_v1_2.md` §interaction_signal_lifecycle (derived-from-append-only)
- `Telecheck_OpenAPI_v0_3.md` (8 new endpoints under `/v1/med-interaction/*`)
- I-002 platform-floor (interaction-before-commit)
- I-015, I-023, I-025, I-027, I-035
- ADR-001 (modular monolith — public-interface-only cross-module access)
