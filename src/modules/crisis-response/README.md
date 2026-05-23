# `src/modules/crisis-response/` — Crisis Response module

Implementation of **SI-022 Crisis Response Slice v1.0** (RATIFIED 2026-05-21 P-039) + the canonical follow-on **CDM v1.9 → v1.10 Amendment** (RATIFIED 2026-05-21 P-040).

## Status: Sprint 2 PR 3 — **ACKNOWLEDGE MID-LIFECYCLE WRITE-PATH LANDED** (on top of merged initiate PR 2)

The DB layer is **complete** through migration 038 + foundation 051 (Option B app-role acquisition). The TypeScript application layer is at Sprint 2 — Sprint 1's skeleton + branded IDs + canonical vocabularies, the staff-scoped read (`GET /v0/crisis-events/:id`, Sprint 2 PR 1, merged), the initiate write-path (`POST /v0/crisis-events`, Sprint 2 PR 2, merged), and now the acknowledge mid-lifecycle write-path (`POST /v0/crisis-events/:id/acknowledge`, this commit). The respond/resolve (PR 4), sweep (PR 6), and patient-scoped read (PR 5) handlers are parked on sibling `[CODEX-PENDING]` branches and merge as a union. Remaining Cat A audit-event-catalog landing + KMS envelope + integration tests land in follow-up PRs.

### Sprint 2 PR 3 (this commit)

- `POST /v0/crisis-events/:id/acknowledge` — clinician/care-team claims a detected (or escalated) crisis event via the `record_crisis_acknowledgement_claim()` SECDEF wrapper (migration 037 §1) under the `crisis_acknowledger` role.
- Composition: `requireTenantContext → requireClinicianActorContext → path/body validation → resolveActorTenantIdForAudit → withIdempotentExecution → withTenantContext → (withActorContext when nonce bound) → withDbRole('crisis_event_staff_reader', ...) pre-fetch (patient_id + current_state; 404 branch on 0 rows) → withDbRole('crisis_acknowledger', ...) wrapper SELECT → emitCrisisAcknowledgedAudit (same tx; FLOOR-020 fail-closed Cat A)`.
- Two allowed from-states per migration 037 §1 + State Machines v1.1 §3 triples #7 + #8: `detected → acknowledged` OR `escalated → acknowledged` (both `clinician_acknowledgement`). The pre-fetched `current_state` is carried into the audit's `detail.from_state`.
- Cat A `crisis.acknowledged` audit emitted in the same transaction via the `crisisAuditPlaceholder()` single-sanctioned-cast helper (mirrors `formsAuditPlaceholder`), pending the AUDIT_EVENTS v5.12 catalog landing in `lib/audit.ts`.
- Tenant-blind envelopes per I-025: 400 (path/body), 403 (42501 via R2 MED-1 closure), 404 (missing/cross-tenant), 409 (wrapper 40001 — concurrent-claim race-loss or invalid from-state).
- Unit tests (§1-§10): happy path, payload pass-through, from_state echo, 3 guards-precede-tx, path/body validation, 404 tenant-blind, FLOOR-020 audit ordering + I-003 fail-closed propagation, 42501 → 403 in all three sites, actorNonce-undefined path, 40001 → 409.

### Sprint 2 PR 2 (merged on main) — POST /v0/crisis-events

- Initiates a crisis event by calling the SECDEF wrapper `record_crisis_initiation()` from migration 036 (granted EXECUTE to `crisis_initiator` role) and emitting the replay-aware Cat A `crisis.detected` audit in the SAME atomic transaction (FLOOR-020 fail-closed + Codex R1 #201 findings 1+2 closure 2026-05-24; if any of marker INSERT / wrapper INSERT / audit emit fails the whole tx rolls back so no orphan crisis_event row exists without its audit record AND no audit record exists without its companion marker).
- Composition: `requireTenantContext → requireCrisisInitiatorActorContext (SI-022 §7 slice-role gate; returns bound crisisInitiatorIdentity) → body validation → resolveActorTenantIdForAudit → withIdempotentExecution (which opens tx + binds tenant context for idempotency_keys RLS) → withTenantContext (rls.ts private binding for parity with PR 1) → (withActorContext when req.actorNonce bound) → withDbRole('crisis_initiator', ...) → SELECT record_crisis_initiation(...) → claimResourceLifecycleAuditSlot (resource-keyed dedupe; same tx) → emitCrisisDetectedAudit(tx) (only when claimed=true)`.
- Body: `{ patient_id (UUID), server_signal_id (UUID), crisis_type (6-value enum), severity (3-value enum), regulatory_reporting_enabled (boolean), source_surface (mode_1_chat|community|forms|messaging) }`. All 8 KMS envelope params on the wrapper signature are passed NULL at v0 wire surface — Sprint 4 lands KMS envelope encryption per ADR-024.
- Idempotency: `Idempotency-Key` header via canonical `withIdempotentExecution` helper (SI-006 PR-C extraction). DB-layer idempotency via wrapper's UNIQUE(tenant_id, server_signal_id) constraint — canonical replays return the existing crisis_event_id; mismatched immutable fields with same server_signal_id surface as SQLSTATE 23505 → tenant-blind 409.
- 42501 mapping: try/catch wraps the **ENTIRE** `withDbRole` call (per PR 1 R2 MED-1 closure pattern at `get-crisis-event.ts` lines 261-296) so 42501 is mapped to tenant-blind 403 whether it surfaces from (1) SET LOCAL ROLE pre-callback elevation or (2) the wrapper's internal LAYER B/C tenant-scope guards (SI-010 actor-not-bound or tenant-scope-mismatch per migration 036 lines 122-159).
- Layer B authorization: SI-022 §7 `requireCrisisInitiatorActorContext` slice-role gate (Codex R1 #201 finding 2 closure 2026-05-24). The gate's `crisisInitiatorIdentity` field carries the bound slice-role identity (today: always `'clinician'`; future: `+ 'on_call_clinician' + 'ai_mode1_service'` when the JWT-role → DB-slice-role mapping lands per Phase A successor to SI-010 / SI-024.1). The audit emitter's `CRISIS_INITIATOR_ACTOR_TYPE` map derives the canonical `actor_type` from this identity (clinician + on_call_clinician → `'clinician'`; ai_mode1_service → `'ai_workload'`) — no hard-coded literal; the future expansion is a one-line gate change.
- `crisis.detected` action ID placeholder: ratified in SI-022 §3 / CDM v1.9→v1.10 Amendment §3.1 (P-039 + P-040 2026-05-21) but NOT yet landed in `src/lib/audit.ts`'s `AuditAction` enum (which tracks AUDIT_EVENTS v5.3; the v5.12 amendment lands at a future Track 6 spec-corpus ratification). Used the same single-sanctioned-cast pattern that `forms-intake/audit.ts`'s `formsAuditPlaceholder()` uses — see `audit.ts` for the migration-on-ratification path.
- Crisis-specific platform-floor discipline (I-019): rejection paths (Layer B 403, validation 400, idempotency mismatch 409, audit-emit failure) do NOT emit `crisis.detected` because no crisis_event row was actually created — the surface-side detection record (`crisis_detection_trigger` Cat A from Mode 1 / forms-intake) is the canonical pre-initiation detection signal. Per SI-022 §3 the spec deliberately separates the two: there is no `crisis.initiation_rejected` audit action in the v5.12 amendment.
- Unit tests cover: §1 happy path composition (incl. claim + emit-with-identity), §2 tenant guard precedes wrap, §3 crisis_initiator slice-role gate precedes wrap, §4 13-case body validation matrix, §5 audit emitted in same tx after withDbRole returns + claim → emit ordering + audit-emit failure propagates (I-003) + claim-failure propagates with same atomicity, §6 42501 → 403 for both SET LOCAL ROLE failure and wrapper LAYER C failure + non-42501 PG errors propagate unchanged, §7 actorNonce undefined skips withActorContext, §8 SQLSTATE 23505 → tenant-blind 409 with no tenant_id / server_signal_id leak, §9 replay-aware audit dedupe (claim returns false → emit SKIPPED → 201 + same crisis_event_id; positive companion; claim-after-wrapper ordering).

### Sprint 2 PR 1 (already merged on `main` — e4cb312)

- `GET /v0/crisis-events/:id` — staff-scoped single-row read via `crisis_event_current_state_v` (12-column projection: crisis_event_id, tenant_id, patient_id, server_signal_id, crisis_type, severity, regulatory_reporting_enabled, detected_at, current_state, current_state_transition_at, current_state_transition_reason, current_state_actor_principal_id).
- Composition: `withTransaction → withTenantContext → withActorContext → withDbRole('crisis_event_staff_reader', ...) → SELECT FROM crisis_event_current_state_v WHERE crisis_event_id = $1`.
- Layer B authorization: closest-available `requireClinicianActorContext` role-gate (TODO: replace with explicit JWT-role → DB-slice-role membership check when Identity slice publishes role-to-membership mapping).
- 404 envelope is tenant-blind per I-025 — same shape whether the row genuinely doesn't exist or exists in another tenant (RLS-filtered).
- Path-param validation: UUID shape (`crisis_event.id` is `UUID` per migration 033 §4 line 472; **NOT** ULID despite some brief references).
- Unit tests cover happy path, 4 guard-precedes-tx cases, 404 tenant-blind envelope, and both actorNonce-bound + actorNonce-undefined composition paths.

### Sprint 2 PR 2 follow-up scope (NOT in this commit)

- `GET /v0/crisis-events/:id` patient-scoped variant — uses `crisis_event_patient_summary_v` + `crisis_event_patient_reader` role; requires `requirePatientActorContext` role-gate. Patient view's self-scoping predicate (`patient_id = current_actor_account_id()::UUID`) requires `req.actorNonce` to be bound (unlike the staff view), so the patient handler MUST fail-closed on missing nonce.

### DB layer (PRs 1-6 — already merged on `main`)

| Migration | Lines         | Codex APPROVE | What                                                                                                                              |
| --------- | ------------- | ------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| 032       | 228           | round 1       | 15 RBAC roles (7 application + 6 procedure-owner + 2 view-owner)                                                                  |
| 033       | 882           | round 7       | 6 tables (3 Crisis canonical + 3 P-027 notification baseline) + RLS + per-table append-only triggers + monotonic-ordering trigger |
| 034       | 399           | round 1       | 2 derived views (R1 HIGH-2 staff/patient reader split; column-level patient minimization)                                         |
| 035       | 252           | round 1       | Raw lifecycle writer SECDEF + anti-bypass EXECUTE matrix                                                                          |
| 036       | 423           | round 3       | `record_crisis_initiation()` SECDEF (with idempotency-mismatch fail-closed)                                                       |
| 037       | 502           | round 2       | 3 mid-lifecycle wrappers (acknowledgement + response + resolution)                                                                |
| 038       | 535           | round 4       | `execute_crisis_no_acknowledgement_sweep()` (lease-takeover + fencing-token + STEP F atomic completion)                           |
| **Total** | **3,221 SQL** | **18 rounds** | **6 tables + 2 views + 6 SECDEF + 15 RBAC roles**                                                                                 |

### Sprint 2-4 remaining work (NOT yet implemented)

**Sprint 2 — Initiation + acknowledgement + read**

- `POST /v0/crisis-events` → wraps `record_crisis_initiation()` + emits Cat A `crisis.detected` audit (KMS-envelope-encrypted intake_payload deferred to Sprint 4 per ADR-024). **DONE — Sprint 2 PR 2 (merged on main).**
- `POST /v0/crisis-events/:id/acknowledge` → wraps `record_crisis_acknowledgement_claim()` + Cat A `crisis.acknowledged` audit. **DONE — Sprint 2 PR 3 (this commit).**
- `GET /v0/crisis-events/:id` staff-scoped — reads `crisis_event_current_state_v`. **DONE — Sprint 2 PR 1 (e4cb312).**
- `GET /v0/crisis-events/:id` patient-scoped — reads `crisis_event_patient_summary_v` via `crisis_event_patient_reader` role; the two views' SELECT grants enforce the staff/patient split _(follow-up: Sprint 2 PR 5)_
- Integration tests for the initiation + acknowledgement happy paths _(remaining)_

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
├── routes.ts             ← health + ready + POST / (initiate, PR 2) + GET /:id (staff, PR 1) + POST /:id/acknowledge (PR 3)
├── audit.ts              ← Cat A crisis.* emitters (emitCrisisDetectedAudit PR 2 + emitCrisisAcknowledgedAudit PR 3; placeholder pattern; will simplify on AUDIT_EVENTS v5.12 landing)
├── README.md             ← this file
└── internal/             ← module-private; no cross-module imports allowed
    ├── types.ts          ← branded IDs + state/classification vocabularies (Sprint 1)
    └── handlers/
        ├── get-crisis-event.ts             ← Sprint 2 PR 1 (e4cb312) — staff-scoped read
        ├── get-crisis-event.test.ts        ← unit tests (composition, validation, 404)
        ├── post-crisis-event.ts            ← Sprint 2 PR 2 (merged) — initiate via SECDEF wrapper + Cat A audit emit
        ├── post-crisis-event.test.ts       ← unit tests (composition, validation, audit ordering, 42501, idempotency-mismatch)
        ├── post-crisis-acknowledge.ts      ← Sprint 2 PR 3 (this commit) — acknowledge write-path
        └── post-crisis-acknowledge.test.ts ← unit tests (§1-§10 composition, audit, error-mapping)
```

## Option 2 ratifier decision (2026-05-22)

Evans chose **Option 2 — adapt to existing code-repo patterns** rather than land the SI-024.1 / P-027 / Mode 1 foundation prerequisites first. Recorded divergences from spec (to be reconciled in future hygiene cycle):

- **Trust anchor:** SQL wrappers use SI-010 `current_actor_*()` helpers (migration 031), not SI-024.1 `verify_session_jwt_and_extract_claims()`.
- **Trigger functions:** per-table inline functions (audit_chain pattern from migration 002), not generic `enforce_append_only()`.
- **patient + server_signal_id FKs:** column kept as `UUID NOT NULL` but FK constraint to `patient(tenant_id, id)` / Mode 1 conversation envelope SKIPPED (target tables don't exist yet; logical reference only).
- **notification*crisis*\* baseline:** P-027 §4.66-4.68 tables inline-created in migration 033 (SI-022 is the first slice that needs them).
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
