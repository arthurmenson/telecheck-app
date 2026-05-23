# `src/modules/admin-backend/` — Admin Backend Basics module

Implementation of **SI-023 Admin Backend Basics Slice v1.0** (RATIFIED 2026-05-22 P-041) + the canonical follow-on **CDM v1.10 → v1.11 Amendment** (RATIFIED 2026-05-22 P-042).

## Status: Sprint 1 (PR 6 — this commit) — **SKELETON**

The DB layer is **complete** through migration 044. The TypeScript application layer is at Sprint 1 — module skeleton + public interface + branded ID types + canonical lifecycle-state + decision + dashboard-name vocabularies. Handler implementation + Cat A audit emission + LAYER B role-membership check + integration tests land across Sprints 2-N.

### DB layer (PRs 1-5 — already merged on `main`)

| Migration | Lines | Codex APPROVE | What |
|---|---|---|---|
| 039 | 167 | round 1 | 12 RBAC roles (2 application + 3 dashboard-wrapper-owner + 2 template-wrapper-owner + 1 raw-writer-owner + 4 view-owner) |
| 040 | 648 | round 2 | 4 entities + RLS + per-table append-only triggers + unified lifecycle-invariants trigger + one-active-review LAYER 2 (R1 HIGH-1 closure: lock + orphan check) |
| 041 | 343 | round 4 | 2 derived views (admin_crisis_operational_health_v + forms_template_admin_review_pending_v); 2 deferred (consult + Mode 1 dashboards). R1+R2+R3 closures: base-table grants + runner-independent rollback |
| 042 | 317 | round 4 | Raw lifecycle writer SECDEF + anti-bypass EXECUTE matrix + BIGSERIAL USAGE (R3 HIGH-1 closure) |
| 043 | 741 | round 1 | 2 template wrappers (submit + decision); decision-wrapper body verbatim per ratifier P-042 R2 hard-floor item 6 closure on idempotency-ordering |
| 044 | 366 | round 2 | 1 dashboard read-wrapper (crisis); 2 deferred. R1 MED-1+MED-2 closures: temp-table reentrancy + rollback existence-gates |
| **Total** | **2,582 SQL** | **14 rounds** | **4 tables + 2 views + 4 SECDEF + 12 RBAC roles** |

### Sprint 2+ remaining work (NOT yet implemented)

**Sprint 2 — Template submit + decision endpoints**
- `POST /v1/admin/templates/{template_id}/submit-for-review` → wraps `submit_forms_template_for_admin_review()` + Cat A `admin.template_submitted_for_review` audit
- `POST /v1/admin/template-reviews/{review_id}/decision` → wraps `record_forms_template_admin_decision()` + Cat A `admin.template_review_decision` + conditional Cat A `admin.template_published_via_review_workflow` (IFF approve)
- Integration tests for both happy paths + idempotency-replay regression on decision wrapper

**Sprint 3 — Crisis dashboard endpoint**
- `GET /v1/admin/dashboards/crisis-operational-health` → wraps `read_admin_crisis_operational_health()` + Cat A `admin.dashboard_query_executed` audit
- Integration tests for tenant-isolation cases (cross-tenant read → tenant-blind 02000 / 42501)

**Sprint 4 — Hardening**
- LAYER B role-membership check at Fastify route layer (admin_basic_operator for submit + dashboard; admin_template_reviewer for decision; deferred from SQL wrappers per Option 2)
- Cross-tenant isolation tests (the wrapper-level LAYER C is one defense; the route-level LAYER B is the other)
- Fail-closed verification (Cat A audit emission MUST commit co-transactionally with the SECDEF call — single DB transaction wraps both)

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
