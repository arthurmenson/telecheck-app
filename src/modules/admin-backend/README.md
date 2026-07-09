# `src/modules/admin-backend/` — Admin Backend Basics module

Implementation of **SI-023 Admin Backend Basics Slice v1.0** (RATIFIED 2026-05-22 P-041) + the canonical follow-on **CDM v1.10 → v1.11 Amendment** (RATIFIED 2026-05-22 P-042).

## Status: Sprint 2 PR 4 (this commit) — **3 of 3 dashboard reads MOUNTED (2 fail-closed pending data sources); all 5 SI-023 §5 endpoints mounted**

The DB layer is **complete** through migration 044. Foundation 051 (Option B app-role acquisition via `src/lib/with-db-role.ts`) merged. On `main`: Sprint 2 PR 1 shipped the live crisis dashboard + PR 2 shipped the first WRITE handler (submit-for-review) + PR 3 shipped the second WRITE handler (template-review decision). **Sprint 2 PR 4 (this commit) mounts the 2 deferred-wrapper dashboard scaffolds**, completing the 3-dashboard read surface:

- **`GET /v1/admin/dashboards/crisis-operational-health`** (PR 1, on `main`; **LIVE**) — wraps the SECDEF read function `read_admin_crisis_operational_health` (migration 044 §1). Composes `withTransaction → withTenantContext → withActorContext → withDbRole('admin_basic_operator')` → wrapper call. LAYER B uses the legacy `requireAdminRole` shim. I-027 read-trail satisfied by the wrapper's co-transactional `admin_dashboard_query_execution` INSERT.
- **`POST /v1/admin/templates/:template_id/submit-for-review`** (PR 2, on `main`) — wraps the SECDEF write function `submit_forms_template_for_admin_review` (migration 043 §1). Composes `withIdempotentExecution → withTenantContext → withActorContext → withDbRole('admin_basic_operator')` → wrapper call → **same-tx Cat A audit emission under the restored `telecheck_app_role`**. Cat A action `admin.template_submitted_for_review` per SI-023 §3 row 2 emitted via the module-local `adminBackendAuditPlaceholder()` cast helper. Idempotency-protected via `withIdempotentExecution`. 42501 → tenant-blind 403 mapping wraps the entire `withDbRole` call.
- **`GET /v1/admin/dashboards/consult-queue-health`** (NEW PR 4; **FAIL-CLOSED 503**) — handler scaffold mirroring the PR 1 composition pipeline. The SECDEF wrapper `read_admin_consult_queue_health` is **deferred** at migration 044 §3 (Async Consult slice not in code repo yet); the wrapper does NOT exist in the DB. The handler runs auth + role gates + the canonical composition; the wrapper SELECT surfaces PG SQLSTATE `42883` (undefined_function) today, mapped to a canonical 503 tenant-blind envelope via `req.server.httpErrors.serviceUnavailable()`. The handler additionally maps `0A000` (feature_not_supported — forward-compat with a possible future intermediate hygiene state where the wrapper exists as a stub) → 503, and `42501` → 403 (mirrors PR 1 R2 MED-1 closure). **Zero handler change required** when the Async Consult slice + matching Option-2 hygiene migration land the view + wrapper.
- **`GET /v1/admin/dashboards/mode1-volume-health`** (NEW PR 4; **FAIL-CLOSED 503**) — sibling pattern to consult-queue-health; wrapper deferred at migration 044 §4 pending Mode 1 slice. Same fail-closed 503 mapping; same auto-unblock posture.
- **`POST /v1/admin/templates/:template_id/reviews/:review_id/decision`** (Sprint 2 PR 3, on `main`) — wraps the SECDEF write function `record_forms_template_admin_decision` (migration 043 §3) under the **`admin_template_reviewer`** slice role (distinct from PR 2's `admin_basic_operator`). Composes the same canonical write stack → wrapper call → **same-tx Cat A audit emission** of `admin.template_review_decision` per SI-023 §3 row 3 (via `adminBackendAuditPlaceholder()` — ID not yet AUDIT_EVENTS-ratified). The `decision` enum is `approve | reject | request_revision`. Idempotency via the `Idempotency-Key` header threaded into the wrapper's `p_idempotency_key` (same canonical key per IDEMPOTENCY v5.1). 42501 → tenant-blind 403 mapping wraps the entire `withDbRole` call (R2 MED-1 closure parity).

**Sprint 4 hardening (2026-07-09) closed the BUILDABLE remainder:** Cat A `admin.dashboard_query_executed` now emitted on all 3 dashboard reads; the LAYER B slice-role-membership gate (`requireSliceRoleMembership`) replaced the legacy `requireAdminRole` shim call at all 5 handlers; cross-tenant isolation tests landed; the approve-path `admin.template_published_via_review_workflow` audit landed. `/ready` flipped to 200. The only remaining item is the Track-6 SPEC-GATED AUDIT_EVENTS catalog ratification (placeholder-cast; no runtime impact). See the "Sprint 4 — Hardening" section below.

### DB layer (PRs 1-5 — already merged on `main`)

| Migration | Lines         | Codex APPROVE | What                                                                                                                                                                                                      |
| --------- | ------------- | ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 039       | 167           | round 1       | 12 RBAC roles (2 application + 3 dashboard-wrapper-owner + 2 template-wrapper-owner + 1 raw-writer-owner + 4 view-owner)                                                                                  |
| 040       | 648           | round 2       | 4 entities + RLS + per-table append-only triggers + unified lifecycle-invariants trigger + one-active-review LAYER 2 (R1 HIGH-1 closure: lock + orphan check)                                             |
| 041       | 343           | round 4       | 2 derived views (admin_crisis_operational_health_v + forms_template_admin_review_pending_v); 2 deferred (consult + Mode 1 dashboards). R1+R2+R3 closures: base-table grants + runner-independent rollback |
| 042       | 317           | round 4       | Raw lifecycle writer SECDEF + anti-bypass EXECUTE matrix + BIGSERIAL USAGE (R3 HIGH-1 closure)                                                                                                            |
| 043       | 741           | round 1       | 2 template wrappers (submit + decision); decision-wrapper body verbatim per ratifier P-042 R2 hard-floor item 6 closure on idempotency-ordering                                                           |
| 044       | 366           | round 2       | 1 dashboard read-wrapper (crisis); 2 deferred. R1 MED-1+MED-2 closures: temp-table reentrancy + rollback existence-gates                                                                                  |
| **Total** | **2,582 SQL** | **14 rounds** | **4 tables + 2 views + 4 SECDEF + 12 RBAC roles**                                                                                                                                                         |

### Sprint 2+ remaining work (NOT yet implemented)

**Sprint 2 — Template submit + decision endpoints**

- ✅ `POST /v1/admin/templates/:template_id/submit-for-review` → handler MOUNTED (Sprint 2 PR 2). Wraps `submit_forms_template_for_admin_review()` + emits Cat A `admin.template_submitted_for_review` audit same-tx under the restored app role + idempotency-protected via `withIdempotentExecution`. Unit tests cover composition order + guard precedence + 42501 → tenant-blind 403 mapping + audit payload shape (initial_submission + revision_resubmission paths) + idempotency-wrapper integration.
- ✅ `POST /v1/admin/templates/:template_id/reviews/:review_id/decision` → handler MOUNTED (Sprint 2 PR 3). Wraps `record_forms_template_admin_decision()` under `admin_template_reviewer` + emits Cat A `admin.template_review_decision` same-tx under the restored app role + idempotency via the `Idempotency-Key` header. Conditional Cat A `admin.template_published_via_review_workflow` (IFF approve) lands when the publication wrapper is exercised. Unit tests cover composition order + guard precedence + decision-enum validation + 42501 → tenant-blind 403 mapping + audit payload shape.
- ⏳ Integration tests for both happy paths + idempotency-replay regression on decision wrapper

**Sprint 3 — Dashboard endpoints** ✅ all 3 reads shipped (PR 1 + PR 4)
- ✅ `GET /v1/admin/dashboards/crisis-operational-health` (PR 1) → handler MOUNTED (live; wraps `read_admin_crisis_operational_health()` via the canonical context-helper composition + Option B `withDbRole('admin_basic_operator')` elevation; unit tests cover the composition order + guard precedence + 42501 → 403 mapping).
- ✅ `GET /v1/admin/dashboards/consult-queue-health` (PR 4) → handler MOUNTED (fail-closed 503 scaffold; auth + composition wired; PG `42883` undefined_function + `0A000` feature_not_supported both → 503 tenant-blind; `42501` → 403; unit tests cover all 4 paths + composition order). Auto-unblocks when the Async Consult slice + hygiene migration land the view + wrapper.
- ✅ `GET /v1/admin/dashboards/mode1-volume-health` (PR 4) → handler MOUNTED (fail-closed 503 scaffold; same pattern as consult-queue-health). Auto-unblocks when the Mode 1 slice lands.
- ⏳ Cat A `admin.dashboard_query_executed` audit emission — deferred to Sprint 4 hardening (READ endpoint scope per task brief).
- ⏳ Integration tests for tenant-isolation cases (cross-tenant read → tenant-blind 42501 → 403) — pending the foundation-role-acquisition integration test suite landing alongside the per-slice handler PRs (per migration 051 header §"DEFERRED TO FOLLOW-UP PRS").

**Sprint 4 — Hardening** ✅ CLOSED 2026-07-09 (`/ready` flipped to 200)

- ✅ **LAYER B slice-role-membership check** at the Fastify route layer via `requireSliceRoleMembership(req, <role>)` (src/lib/auth-context.ts), replacing the legacy `requireAdminRole` shim CALL at all 5 SI-023 §5 handlers. `admin_basic_operator` for the 3 dashboards + submit; `admin_template_reviewer` for decision (per SI-023 §5 endpoint→role map). **Honest fail-closed, not permissive:** the gate delegates the admin-authorization decision to the ratified `requireAdminRole` boundary (which fails closed on verified-non-admin JWT, presented-but-rejected JWT, and wrong-tenant tenant_admin binding), then binds the endpoint's ratified slice role. The bound role is threaded into `withDbRole`, so the LAYER B assertion + the DB elevation cannot drift; binding the wrong role raises 42501 → tenant-blind 403 at the DB EXECUTE-grant floor. Mirrors the ratified crisis-response `requireCrisisInitiatorActorContext` slice-role-gate precedent (P-041/P-042).
- ✅ **Cat A audit emission for all 4 admin.* action IDs.** `admin.dashboard_query_executed` (SI-023 §3 row 1) on the 3 dashboard reads (success-path only; same tx as the wrapper SELECT + read-trail INSERT, under the restored `telecheck_app_role`). `admin.template_submitted_for_review` (row 2) + `admin.template_review_decision` (row 3) on the write paths (already on `main`). `admin.template_published_via_review_workflow` (row 4) NEW — emitted from the decision handler's `approve` branch (IFF decision=approve → the wrapper published the template per transition triple #2). All emitted via the `adminBackendAuditPlaceholder()` cast (see below).
- ✅ **Cross-tenant isolation tests** — `tests/integration/admin-cross-tenant-isolation.test.ts` (live-PG): same-tenant scoping baseline (US admin → US rows + US read-trail + US Cat A audit); US-issued admin JWT on the Ghana host → tenant-blind denial with NO Ghana side-effect (I-023/I-025); per-tenant read-trail separation (I-027); write-surface (submit) enforces the same boundary.
- ✅ **Fail-closed verification** — each Cat A audit emission runs in the SAME DB transaction as its SECDEF wrapper call (FLOOR-020 + I-003 same-tx durability). A throw at the emit rolls the whole tx back; a partial commit leaving a wrapper effect without its audit is impossible.

**Remaining gap — Track-6 SPEC-GATED (not buildable in the code repo):**

- ⏳ **AUDIT_EVENTS catalog ratification of the `admin.*` action IDs.** The 4 Cat A IDs are emitted via the module-local `adminBackendAuditPlaceholder()` cast (grep `git grep "adminBackendAuditPlaceholder("` for the full inventory) pending the bundle **AUDIT_EVENTS v5.12 → v5.13 amendment** per SI-023 §3. This is a **§12 SI candidate** (spec-corpus ratification ceremony — requires the spec-corpus ratifier quorum; cannot be executed unilaterally in the code repo). It is a **naming-provenance gap only — ZERO runtime impact:** the audit rows commit correctly, the hash chain validates, and the payloads conform to SI-023 §3. Per the **async-consult precedent** (async-consult `/ready` is READY with 17 placeholder-cast IDs), a placeholder-cast naming-provenance gap does NOT block the `/ready` 200 flip — it is fail-conservative (audits still emitted; only canonical-catalog registration is pending) and is surfaced machine-readably in the `/ready` response's `spec_gated_gaps` array.

**Future Option-2 hygiene cycle (post-pilot v1.1)**

- Land consult + Mode 1 entities → recreate the 2 deferred dashboard views (per migration 041 §2/§3 deferral notes) → recreate the 2 deferred dashboard read-wrappers (per migration 044 §3/§4 deferral notes) → wire the 2 deferred endpoints

## Module structure (per `src/modules/README.md` template)

```
admin-backend/
├── index.ts              ← public interface (cross-module-safe exports)
├── plugin.ts             ← Fastify plugin entry point (registered in src/app.ts under /v0/admin-backend)
├── routes.ts             ← Sprint 1: health + ready only; Sprint 2+ adds handlers
├── README.md             ← this file
└── internal/             ← module-private; no cross-module imports allowed
    └── types.ts          ← branded IDs + lifecycle-state + decision vocabularies (Sprint 1)
    └── handlers/         ← (Sprint 2+) 3-5 handler files
    └── services/         ← (Sprint 2+) admin-service.ts
    └── repositories/     ← (Sprint 2+) tenant-scoped DB access
```

## Option 2 ratifier decision (2026-05-22)

Evans chose **Option 2 — adapt to existing code-repo patterns** rather than land the SI-024.1 / consult / Mode 1 foundation prerequisites first. Recorded divergences from spec (to be reconciled in future hygiene cycle):

- **Trust anchor:** SQL wrappers use SI-010 `current_actor_*()` helpers (migration 031), not SI-024.1 `verify_session_jwt_and_extract_claims()`.
- **Tenant-id type:** TEXT (code-repo convention), not the spec's `tenant_id_t` domain.
- **forms_template_id:** VARCHAR(26) (code-repo PK type from migration 006), not the spec's UUID.
- **Principal-id types:** VARCHAR(26) (code-repo PK type for accounts from migration 012), not the spec's UUID.
- **Trigger functions:** per-table inline functions (audit_chain pattern from migration 002) + per-table inline append-only, not generic `enforce_append_only()`.
- **2 dashboard views + 2 dashboard wrappers DEFERRED:** consult-queue-health + mode1-volume-health views + their read-wrappers cannot be created at v0.1 because the consult / Mode 1 entities don't exist in code repo. Future Option-2 hygiene migrations land them when foundation entities ship.
- **LAYER B (role-membership) authorization:** deferred from SQL wrappers to Fastify route layer (spec calls `tenant_account_membership` which doesn't exist in code repo; the route handler checks role membership before invoking the wrapper).
- **Cat A audit emission:** deferred from SQL wrappers to the application layer (the Fastify route handler MUST wrap the SECDEF wrapper call + `audit_records` INSERT in a single DB transaction so a partial commit cannot leave a SECDEF effect without its audit record).

See `docs/crisis-response-implementation-plan.md` for the full Option 2 plan + ratifier rationale (the same Option 2 carryforward applies here).

## Spec references

- `Telecheck_SI_023_Admin_Backend_Basics_v1_0.md` (RATIFIED 2026-05-22 P-041)
- `Telecheck_CDM_v1_10_to_v1_11_Amendment.md` (RATIFIED 2026-05-22 P-042)
- `Telecheck_State_Machines_v1_5.md` §forms_template_admin_review_lifecycle (5 states + 5 transition triples)
- I-023, I-025, I-027, I-035 (tenant isolation; tenant-blind errors; audit; append-only state machine)
- ADR-001 (modular monolith — public-interface-only cross-module access)
