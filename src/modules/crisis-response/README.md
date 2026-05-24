# `src/modules/crisis-response/` — Crisis Response module

Implementation of **SI-022 Crisis Response Slice v1.0** (RATIFIED 2026-05-21 P-039) + the canonical follow-on **CDM v1.9 → v1.10 Amendment** (RATIFIED 2026-05-21 P-040).

## Status: Sprint 2 PR 1 — **FIRST REAL HANDLER LANDED**

The DB layer is **complete** through migration 038 + foundation 051 (Option B app-role acquisition). The TypeScript application layer is at Sprint 2 — Sprint 1's skeleton + branded IDs + canonical vocabularies, plus the FIRST real Fastify handler (`GET /v0/crisis-events/:id` staff-scoped read) landed this commit. Remaining Sprint 2-3 write-path handlers + Cat A audit emission + KMS envelope + integration tests land in follow-up PRs.

### Sprint 2 PR 1 (this commit)

- `GET /v0/crisis-events/:id` — staff-scoped single-row read via `crisis_event_current_state_v` (12-column projection: crisis_event_id, tenant_id, patient_id, server_signal_id, crisis_type, severity, regulatory_reporting_enabled, detected_at, current_state, current_state_transition_at, current_state_transition_reason, current_state_actor_principal_id).
- Composition: `withTransaction → withTenantContext → withActorContext → withDbRole('crisis_event_staff_reader', ...) → SELECT FROM crisis_event_current_state_v WHERE crisis_event_id = $1`.
- Layer B authorization: closest-available `requireClinicianActorContext` role-gate (TODO: replace with explicit JWT-role → DB-slice-role membership check when Identity slice publishes role-to-membership mapping).
- 404 envelope is tenant-blind per I-025 — same shape whether the row genuinely doesn't exist or exists in another tenant (RLS-filtered).
- Path-param validation: UUID shape (`crisis_event.id` is `UUID` per migration 033 §4 line 472; **NOT** ULID despite some brief references).
- Unit tests cover happy path, 4 guard-precedes-tx cases, 404 tenant-blind envelope, and both actorNonce-bound + actorNonce-undefined composition paths.

### Sprint 2 PR 1 follow-up scope (NOT in this commit)

- `GET /v0/crisis-events/:id` patient-scoped variant — uses `crisis_event_patient_summary_v` + `crisis_event_patient_reader` role; requires `requirePatientActorContext` role-gate. Patient view's self-scoping predicate (`patient_id = current_actor_account_id()::UUID`) requires `req.actorNonce` to be bound (unlike the staff view), so the patient handler MUST fail-closed on missing nonce.

### DB layer (PRs 1-6 — already merged on `main`)

| Migration | Lines | Codex APPROVE | What |
|---|---|---|---|
| 032 | 228 | round 1 | 15 RBAC roles (7 application + 6 procedure-owner + 2 view-owner) |
| 033 | 882 | round 7 | 6 tables (3 Crisis canonical + 3 P-027 notification baseline) + RLS + per-table append-only triggers + monotonic-ordering trigger |
| 034 | 399 | round 1 | 2 derived views (R1 HIGH-2 staff/patient reader split; column-level patient minimization) |
| 035 | 252 | round 1 | Raw lifecycle writer SECDEF + anti-bypass EXECUTE matrix |
| 036 | 423 | round 3 | `record_crisis_initiation()` SECDEF (with idempotency-mismatch fail-closed) |
| 037 | 502 | round 2 | 3 mid-lifecycle wrappers (acknowledgement + response + resolution) |
| 038 | 535 | round 4 | `execute_crisis_no_acknowledgement_sweep()` (lease-takeover + fencing-token + STEP F atomic completion) |
| **Total** | **3,221 SQL** | **18 rounds** | **6 tables + 2 views + 6 SECDEF + 15 RBAC roles** |

### Sprint 2-4 remaining work (NOT yet implemented)

**Sprint 2 — Initiation + acknowledgement + read**
- `POST /v0/crisis-events` → wraps `record_crisis_initiation()` + emits Cat A `crisis.detected` audit + KMS-envelope-encrypts the intake_payload  *(remaining)*
- `POST /v0/crisis-events/:id/acknowledge` → wraps `record_crisis_acknowledgement_claim()` + Cat A `crisis.acknowledged` audit  *(remaining)*
- `GET /v0/crisis-events/:id` staff-scoped — reads `crisis_event_current_state_v`. **DONE — Sprint 2 PR 1 (this commit).**
- `GET /v0/crisis-events/:id` patient-scoped — reads `crisis_event_patient_summary_v` via `crisis_event_patient_reader` role; the two views' SELECT grants enforce the staff/patient split  *(follow-up: Sprint 2 PR 1.1)*
- Integration tests for the initiation + acknowledgement happy paths  *(remaining)*

**Sprint 3 — Response + resolution + sweep**
- `POST /v0/crisis-events/:id/respond` → wraps `record_crisis_response()` + Cat A `crisis.responded` audit
- `POST /v0/crisis-events/:id/resolve` → wraps `record_crisis_resolution()` + Cat A `crisis.resolved` audit
- `POST /v0/crisis-events/:id/sweep` → operator-initiated; wraps `execute_crisis_no_acknowledgement_sweep()` + Cat A `crisis.no_acknowledgement_escalation` audit when outcome=completed_escalated
- Integration tests for state-machine guards (e.g., responding before acknowledging → 409 tenant-blind)

**Sprint 4 — Hardening**
- Cross-tenant isolation tests
- Idempotency-replay regression (initiation with same server_signal_id → same crisis_event_id)
- Race-condition coverage (concurrent acknowledgement claims; concurrent sweep workers)
- FLOOR-020 fail-closed verification (audit emission MUST commit co-transactionally with the lifecycle write — single DB transaction wraps both `emitAudit()` and the SECDEF wrapper call)
- KMS envelope encryption of `intake_payload` per ADR-024

## Module structure (per `src/modules/README.md` template)

```
crisis-response/
├── index.ts              ← public interface (cross-module-safe exports)
├── plugin.ts             ← Fastify plugin entry point (registered in src/app.ts under /v0/crisis-events)
├── routes.ts             ← Sprint 2 PR 1: health + ready + GET /:id (staff-scoped)
├── README.md             ← this file
└── internal/             ← module-private; no cross-module imports allowed
    ├── types.ts          ← branded IDs + state/classification vocabularies (Sprint 1)
    └── handlers/
        ├── get-crisis-event.ts       ← Sprint 2 PR 1 (this commit) — staff-scoped read
        └── get-crisis-event.test.ts  ← unit tests (composition, validation, 404)
```

## Option 2 ratifier decision (2026-05-22)

Evans chose **Option 2 — adapt to existing code-repo patterns** rather than land the SI-024.1 / P-027 / Mode 1 foundation prerequisites first. Recorded divergences from spec (to be reconciled in future hygiene cycle):

- **Trust anchor:** SQL wrappers use SI-010 `current_actor_*()` helpers (migration 031), not SI-024.1 `verify_session_jwt_and_extract_claims()`.
- **Trigger functions:** per-table inline functions (audit_chain pattern from migration 002), not generic `enforce_append_only()`.
- **patient + server_signal_id FKs:** column kept as `UUID NOT NULL` but FK constraint to `patient(tenant_id, id)` / Mode 1 conversation envelope SKIPPED (target tables don't exist yet; logical reference only).
- **notification_crisis_* baseline:** P-027 §4.66-4.68 tables inline-created in migration 033 (SI-022 is the first slice that needs them).
- **`jwt_migration_entity_status` seed:** SKIPPED at v1.0 (the migration-tracker table itself doesn't exist; added in future foundation hygiene cycle alongside SI-024.1 trust anchor).
- **Audit emission:** Cat A `crisis.*` audit emission deferred from SQL wrappers to the application layer (the Fastify route handler MUST wrap the SECDEF wrapper call + `emitAudit()` in a single DB transaction so a partial commit cannot leave a crisis_event row without its audit record — FLOOR-020 fail-closed at app layer rather than at SQL).

See `docs/crisis-response-implementation-plan.md` for the full plan + ratifier rationale.

## Spec references

- `Telecheck_SI_022_Crisis_Response_v1_0.md` (RATIFIED 2026-05-21 P-039)
- `Telecheck_CDM_v1_9_to_v1_10_Amendment.md` (RATIFIED 2026-05-21 P-040)
- `Telecheck_State_Machines_v1_1.md` §3 (canonical 6-state lifecycle)
- I-019 (crisis-detection-always-on platform-floor)
- I-035 (append-only lifecycle per migration 033 triggers)
- ADR-001 (modular monolith — public-interface-only cross-module access)
- ADR-021 (KMS envelope for `intake_payload` PHI encryption-at-rest)
- ADR-024 (per-tenant KMS — pending Sprint 4 implementation)
