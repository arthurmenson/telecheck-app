# `src/modules/crisis-response/` — Crisis Response module

Implementation of **SI-022 Crisis Response Slice v1.0** (RATIFIED 2026-05-21 P-039) + the canonical follow-on **CDM v1.9 → v1.10 Amendment** (RATIFIED 2026-05-21 P-040).

## Status: Sprint 4 — **HARDENING COMPLETE — /ready flipped to 200** (7 of 7 endpoints wired + live-PG integration suite)

The DB layer is **complete** through migration 038 + foundation 051 (Option B app-role acquisition) + migration 053 (SI-025 P-045 identity re-shape: patient_id → patient_account_id VARCHAR(26)). The TypeScript application layer has ALL endpoints mounted and the Sprint 4 hardening list closed. Remaining gaps are spec-gated only (see `KNOWN_FOLLOWUPS.md` + the /ready probe's machine-readable `spec_gated_gaps`).

### Sprint 4 (this commit) — hardening closure

- **KMS envelope wire surface** — `POST /v0/crisis-events` accepts an OPTIONAL `intake_payload_envelope` (pre-encrypted 8-field posture per ADR-021 / ADR-024): `ciphertext_b64`, `dek_id` (UUID), `dek_version` (int ≥ 1), `iv_b64`, `auth_tag_b64`, `kek_id` (UUID), `kek_version` (int ≥ 1), `algorithm`. All-or-none per the migration 033 §4 CHECK; absent → all 8 wrapper params bind NULL (Sprint 2 behavior preserved). The caller (Mode 1 orchestration / clinician console BFF) performs the per-tenant KMS envelope encryption at an internal boundary and forwards the sealed fields — NO app-side crypto (`src/lib/kms.ts` is not an envelope builder; app-side encryption is the standing platform-wide Track-5 TODO, same posture as async-consult `v1-shared.ts`). Note the crisis envelope field set differs from async-consult's (crisis carries dek_version/kek_id/kek_version; async-consult carries alg_version/aad/encrypted_at) because the ratified migration 033 column sets differ.
- **Live-PG integration suite** — `tests/integration/crisis-response-http.test.ts` (bind-pool + grant-slice-roles harness; med-interaction PR #262 precedent): initiate happy paths ± envelope, idempotency-replay regression (same server_signal_id → same crisis_event_id + exactly ONE `crisis.detected` audit), mismatched-replay 409 with FLOOR-020 atomic-rollback assertions, staff + patient reads with data-minimization pins, full lifecycle chain, respond-before-acknowledge 409 state-machine guard, acknowledge replay per-transition audit dedupe, sweep escalation/no-op/already_completed outcomes, cross-tenant I-023/I-025 tenant-blind denials (GET/acknowledge/patient-summary/sweep), and the I-019 always-mounted floor assertions. True multi-connection race interleaving cannot run under the shared-client savepoint harness — the suite pins the deterministic SQLSTATE→envelope equivalents (40001→409; fencing replay → `already_completed`).
- **Latent-defect fix 1 (route mount)** — `GET /:id/patient-summary` existed as a handler + unit tests on `main` but was NEVER mounted in `routes.ts` (dropped in the PR 6 rebase union) while /ready + the routes docstring claimed 7 mounted handlers. Now mounted; integration test B3 pins it.
- **Latent-defect fix 2 (42703 on sweep)** — the sweep handler's staff-view pre-fetch still selected the pre-migration-053 view column `patient_id`; migration 053 §3 renamed it `patient_account_id`, so every live sweep call raised 42703 (undefined_column) → 500. Unit-test mocks masked it; integration test D1 pins the fix.
- **/ready flipped 503 → 200** with machine-readable `spec_gated_gaps` per the PR #254 readiness contract (every remaining gap is spec-gated AND fails closed / fail-conservative — see `KNOWN_FOLLOWUPS.md`).
- **PR-#262 latent-defect-class sweep** — checked all 7 handlers for the med-interaction defect classes: Cat A audit emitted inside `withDbRole` (NOT present — all crisis emitters fire after the role reverts, at the tx level), missing wrapper-owner SELECT grants (NOT present — migrations 036-038 + 053 grant matrices verified), rejection-audit-into-aborted-tx (N/A — crisis rejection paths deliberately do not emit per SI-022 §3; the surface-side `crisis_detection_trigger` is the canonical pre-initiation record).

### Sprint 2 PR 6 (this commit) — operator-invoked sweep

- `POST /v0/crisis-events/:id/_sweep` — operator-invoked no-acknowledgement escalation sweep, wrapping the SECDEF `execute_crisis_no_acknowledgement_sweep()` from migration 038. Emits Cat A `crisis.no_acknowledgement_escalation` audit in the same transaction when outcome=`completed_escalated`. Fencing-token idempotency prevents double-escalation.

### Sprint 2 PR 5 (merged) — patient-scoped read

- `GET /v0/crisis-events/:id/patient-summary` — patient-scoped (data-minimized) single-row read via `crisis_event_patient_summary_v` (8-column projection: crisis_event_id, tenant_id, patient_id, crisis_type, severity, detected_at, current_state, current_state_transition_at). Omits 4 staff-only columns: `server_signal_id`, `regulatory_reporting_enabled`, `current_state_transition_reason`, `current_state_actor_principal_id`.
- Composition: `withTransaction → withTenantContext → withActorContext → withDbRole('crisis_event_patient_reader', ...) → SELECT FROM crisis_event_patient_summary_v WHERE crisis_event_id = $1`.
- Layer B authorization: closest-available `requirePatientActorContext` role-gate (TODO: replace with explicit JWT-role → DB-slice-role membership check when Identity slice publishes role-to-membership mapping; widen to accept delegates when the canonical delegation-lookup helper lands and the view's `consent_grant` predicate is reintroduced).
- **Fail-closed on missing `actorNonce` (Phase 3.5)** — divergence from the staff handler. The patient view's self-scoping predicate `patient_id = current_actor_account_id()::UUID` returns 0 rows for all inputs when no actor context is bound (NULL comparison), which would look like a misleading 404. The handler throws a tenant-blind 403 at the app layer before opening the transaction.
- 42501 → tenant-blind 403 mapping wraps the **entire** `withDbRole` call (both the SET LOCAL ROLE acquisition path and the view-body SELECT path), preserving I-025.
- 404 envelope is tenant-blind per I-025 — same shape whether the row genuinely doesn't exist, exists in another tenant (RLS-filtered), or exists in this tenant but belongs to a different patient (view's self-scoping predicate filtered it out).
- Path-param validation: UUID shape (same `crisis_event.id` UUID per migration 033 §4 line 472).
- Unit tests (9 sections) cover happy path with negative SQL-column assertions, 4 guard-precedes-tx cases, 404 tenant-blind envelope, fail-closed-on-missing-nonce, withActorContext wrap order, and 3 cases for 42501 mapping (acquisition path, view-body path, non-42501 passthrough).

### Sprint 2 PR 4 (merged on main) — TWO mid-lifecycle write handlers

- `POST /v0/crisis-events/:id/respond` — clinician records first-response on an acknowledged crisis event. Wraps SECDEF `record_crisis_response()` (migration 037 §2) under `crisis_responder` slice role. Cat A `crisis.responded` audit emitted same-tx (FLOOR-020 fail-closed; I-003 propagation). Pre-fetch under `crisis_event_staff_reader` resolves `patient_id` for the audit's P1 partition key + serves as tenant-blind 404 guard (I-025).
- `POST /v0/crisis-events/:id/resolve` — clinician resolves a previously-responded OR previously-escalated crisis event. Wraps SECDEF `record_crisis_resolution()` (migration 037 §3) under `crisis_resolver` slice role. Cat A `crisis.resolved` audit emitted same-tx, with `detail.from_state` read back from the committed `crisis_event_lifecycle_transition` row (NOT the pre-lock pre-fetch — Codex R1 #202; allowed values per State Machines v1.1 §3 triples #10 + #11: `responded` or `escalated`).
- Both handlers follow PR 3 acknowledge's canonical composition stack: `requireTenantContext → requireClinicianActorContext → path/body validation → resolveActorTenantIdForAudit → withIdempotentExecution → withTenantContext → withActorContext (when nonce bound) → withDbRole(crisis_event_staff_reader, ...) pre-fetch → withDbRole(<wrapper role>, ...) SECDEF call → emit<Action>Audit(tx)`.
- 42501 → tenant-blind 403 via the R2 MED-1 closure pattern (try/catch wrapping the entire `withDbRole` call, NOT the inner wrapper-query — covers SET LOCAL ROLE elevation failures + wrapper LAYER B/C guard failures).
- SQLSTATE 02000 → tenant-blind 404 (defensive — pre-fetch normally catches missing first). SQLSTATE 40001 → tenant-blind 409 (race-loss to concurrent actor OR invalid from-state).
- Unit tests (`post-crisis-respond.test.ts` + `post-crisis-resolve.test.ts`) cover happy path, guard precedence, path/body validation (incl. non-object root body), pre-fetch 404, Cat A audit ordering + I-003 propagation, the per-transition replay-dedupe (claim→skip emit), 42501 mapping (SET LOCAL ROLE + wrapper LAYER C + pre-fetch elevation), actorNonce-undefined skip-withActorContext path, and SQLSTATE 40001 → 409 tenant-blind envelope. Resolve adds an §11 from_state read-back block (read-back `responded`/`escalated` → audit; out-of-range value throws) + an §12 replay-dedupe block.
- `audit.ts` carries ALL FOUR emitters (`detected`, `acknowledged`, `responded`, `resolved`); `routes.ts` mounts all four POST write-paths (`/`, `/:id/acknowledge`, `/:id/respond`, `/:id/resolve`) plus GET `/:id` — the rebase onto `main` resolved the union with the merged initiate (PR 2) + acknowledge (PR 3).

### Sprint 2 PR 3 (merged on main)

- `POST /v0/crisis-events/:id/acknowledge` — clinician/care-team claims a detected (or escalated) crisis event via the `record_crisis_acknowledgement_claim()` SECDEF wrapper (migration 037 §1) under the `crisis_acknowledger` role.
- Composition: `requireTenantContext → requireClinicianActorContext → path/body validation → resolveActorTenantIdForAudit → withIdempotentExecution → withTenantContext → (withActorContext when nonce bound) → withDbRole('crisis_event_staff_reader', ...) pre-fetch (patient_id only; 404 branch on 0 rows) → withDbRole('crisis_acknowledger', ...) wrapper SELECT → claimResourceLifecycleAuditSlot (per-transition dedupe) → withDbRole('crisis_event_staff_reader', ...) from_state read-back → emitCrisisAcknowledgedAudit (same tx; FLOOR-020 fail-closed Cat A)`.
- Two allowed from-states per migration 037 §1 + State Machines v1.1 §3 triples #7 + #8: `detected → acknowledged` OR `escalated → acknowledged` (both `clinician_acknowledgement`). The audit's `detail.from_state` is read back from the committed `crisis_event_lifecycle_transition` row (keyed by the wrapper-returned id) — NOT from the pre-lock pre-fetch, which is not authoritative under a detected→escalated sweep race or same-actor replay (Codex R1 #199 finding 1).
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
- `GET /v0/crisis-events/:id/patient-summary` patient-scoped — reads `crisis_event_patient_summary_v` via `crisis_event_patient_reader` role; the two views' SELECT grants enforce the staff/patient split. **DONE — Sprint 2 PR 5 (this commit).**
- Integration tests for the initiation + acknowledgement happy paths _(remaining)_

**Sprint 3 — Response + resolution + sweep**

- `POST /v0/crisis-events/:id/respond` → wraps `record_crisis_response()` + Cat A `crisis.responded` audit. **DONE — Sprint 2 PR 4.**
- `POST /v0/crisis-events/:id/resolve` → wraps `record_crisis_resolution()` + Cat A `crisis.resolved` audit. **DONE — Sprint 2 PR 4.**
- `POST /v0/crisis-events/:id/_sweep` → operator-initiated; wraps `execute_crisis_no_acknowledgement_sweep()` + Cat A `crisis.no_acknowledgement_escalation` audit when outcome=completed_escalated. **DONE — Sprint 2 PR 6 (this commit).**
- Integration tests for state-machine guards (e.g., responding before acknowledging → 409 tenant-blind)

**Sprint 4 — Hardening (COMPLETE — this commit)**

- Cross-tenant isolation tests. **DONE — `tests/integration/crisis-response-http.test.ts` Groups D5 + E (I-023/I-025 tenant-blind envelope-equality pins).**
- Idempotency-replay regression (initiation with same server_signal_id → same crisis_event_id). **DONE — test A4 (+ exactly-one-audit assertion).**
- Race-condition coverage (concurrent acknowledgement claims; concurrent sweep workers). **DONE at the deterministic envelope level — tests C2/C4 (40001 → tenant-blind 409; same-actor replay per-transition dedupe) + D2 (fencing/generation replay → `already_completed`). True multi-connection interleaving cannot run under the shared-client savepoint harness; the SQLSTATE→envelope mappings a racing caller observes are pinned instead.**
- FLOOR-020 fail-closed verification (audit emission MUST commit co-transactionally with the lifecycle write — single DB transaction wraps both `emitAudit()` and the SECDEF wrapper call). **DONE — tests A1/A5/C2/C3 (co-persistence on success; zero partial state on rejection).**
- KMS envelope encryption of `intake_payload` per ADR-024. **DONE at the ratified wire surface — pre-encrypted 8-field envelope pass-through (tests A2/A3 + unit §10). App-side envelope building remains the standing platform-wide Track-5 TODO (async-consult precedent; does not hold the /ready gate).**

## Module structure (per `src/modules/README.md` template)

```
crisis-response/
├── index.ts              ← public interface (cross-module-safe exports)
├── plugin.ts             ← Fastify plugin entry point (registered in src/app.ts under /v0/crisis-events)
├── routes.ts             ← health + ready + POST / (initiate, PR 2) + GET /:id (staff, PR 1) + POST /:id/acknowledge (PR 3) + POST /:id/respond + POST /:id/resolve (PR 4) + GET /:id/patient-summary (PR 5)
├── audit.ts              ← Cat A crisis.* emitters (detected PR 2 + acknowledged PR 3 + responded + resolved PR 4; placeholder pattern; will simplify on AUDIT_EVENTS v5.12 landing)
├── README.md             ← this file
└── internal/             ← module-private; no cross-module imports allowed
    ├── types.ts          ← branded IDs + state/classification vocabularies (Sprint 1)
    └── handlers/
        ├── get-crisis-event.ts             ← Sprint 2 PR 1 (e4cb312) — staff-scoped read
        ├── get-crisis-event.test.ts        ← unit tests (composition, validation, 404)
        ├── get-crisis-event-patient-summary.ts      ← Sprint 2 PR 5 (this commit) — patient-scoped read
        ├── get-crisis-event-patient-summary.test.ts ← unit tests (9 sections; data-min, fail-closed-nonce, 42501)
        ├── post-crisis-event.ts            ← Sprint 2 PR 2 (merged) — initiate via SECDEF wrapper + Cat A audit emit
        ├── post-crisis-event.test.ts       ← unit tests (composition, validation, audit ordering, 42501, idempotency-mismatch)
        ├── post-crisis-acknowledge.ts      ← Sprint 2 PR 3 (merged) — acknowledge write-path
        ├── post-crisis-acknowledge.test.ts ← unit tests (§1-§11 composition, audit dedupe, from_state read-back, error-mapping)
        ├── post-crisis-respond.ts          ← Sprint 2 PR 4 (this commit) — record_crisis_response wrapper
        ├── post-crisis-respond.test.ts     ← unit tests (10 sections; happy-path + envelope + R2 MED-1 + I-003)
        ├── post-crisis-resolve.ts          ← Sprint 2 PR 4 (this commit) — record_crisis_resolution wrapper
        └── post-crisis-resolve.test.ts     ← unit tests (adds from_state read-back + replay-dedupe blocks)
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
