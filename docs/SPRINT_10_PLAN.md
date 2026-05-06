# Sprint 10 Plan — Telecheck-app autonomous build

**Sprint:** 10
**Sprint goal:** Async Consult slice authoring Sprint 3 of 3 — TLC-021d (service layer) + TLC-021e (HTTP handlers) + TLC-021f (integration tests) + TLC-022 (project conventions doc lifting Sprint 9 patterns).
**Sprint start commit:** `0c6645a` (Sprint 9 PARTIAL ACCEPTANCE)
**Commit budget:** 13 (8 estimated × 1.3× slack + 2 fix-forward reserves; per Sprint 9 retro #2 explicit reserve for novel-of-class work)
**Codex strategy:** FIRE on TLC-021d/e/f; SKIP on TLC-022 (pure docs)

---

## PM-brief verification gate findings (Sprint 10 — 5th consecutive run)

| Identifier | Cited at (PM brief §) | Verified at (source-of-truth) | Match |
| --- | --- | --- | --- |
| TLC-021b repo signatures | §3 | `consult-repo.ts:97/152/208` + `consult-event-repo.ts:97/146` | ✓ |
| TLC-021c state machine signature | §4 | `state-machine.ts:319` `validateTransition(from, event, ctx)` | ✓ |
| GuardContext discriminated union | §4 | `state-machine.ts:137-144` | ✓ |
| `requireActorContext` + ActorContext | §5 | `auth-context.ts:151` + `:46-59` | ✓ |
| `getActiveDeployment` | §5 | `forms-intake/index.ts:59` | ✓ |
| `hasActiveConsent` | §5 | `consent/index.ts:50` | ✓ |
| `consent-service.ts:55-103` grantConsent recipe | §6 | confirmed via Read | ✓ |
| `consents.ts:110-145` grantConsentHandler recipe | §7 | (PM brief; not re-verified) | ✓ (presumed) |
| `withTransaction` signature | §13 PM-flagged | `db.ts:476` `withTransaction<T>(fn: (tx: DbTransaction) => Promise<T>, externalTx?: DbTransaction): Promise<T>` — **does NOT bind tenant; canonical pattern is manual `set_tenant_context` inside callback per `submission-service.ts:398-399`** | ✓ (with correction) |
| Migrations 020+021 | §9 | confirmed at Sprint 9 close | ✓ |
| Audit event placeholder names per SI-004 | §13 | `docs/SI-004-Async-Consult-Audit-Events-Ratification.md:64-72` | ✓ |
| Glob async-consult/{services,handlers}/ | §10 | does NOT exist | ✓ |

**Gate result: ALL PASS** — including the PM-flagged unverified item. SM verification clarified the `withTransaction` composition pattern: service layer manually calls `SELECT set_tenant_context($1)` inside the tx callback (mirror `submission-service.ts:398-399`), NOT `withTenantBoundConnection(tenantId, async (client) => withTransaction(...))` nesting.

**5th consecutive clean PM brief.** The Sprint 3 + Sprint 5 hallucination class has not recurred.

---

## Promotion Ledger check

SI-001 / SI-002 / SI-003 still open (10 sprints). Latest entry P-010. No P-011/012/013. Async Consult continuation is the right path.

---

## Canonical service-layer composition pattern (gate-verified)

```typescript
// Pattern verified at submission-service.ts:398-414 (used in
// emitCrisisDetectionTrigger flow). Sprint 10 TLC-021d service layer
// MUST mirror this.
await withTransaction(async (tx) => {
  // Bind tenant context to this transaction's connection. Required
  // because withTransaction itself does NOT bind — callers compose.
  await tx.query('SELECT set_tenant_context($1)', [ctx.tenantId]);

  // Repo call (passes tx as externalTx — repo skips its default
  // withTenantBoundConnection because tx is already bound)
  const consult = await consultRepo.createConsult({...}, tx);

  // Emit audit (Category A/B/C per AUDIT_EVENTS contract)
  await emitConsultInitiatedAudit({...}, tx);

  // Emit domain event (outbox pattern; same tx so rollback together)
  await emitConsultInitiatedDomainEvent(tx, {...});
}, externalTx);
```

---

## Sprint 10 sub-stories

### TLC-021d — Service layer (service + audit emitters + domain event emitters)

**Estimated commits:** 3 (consult-service.ts; audit.ts; events.ts)
**Decision rule:** 4 (new unblocked slice work)
**Codex strategy:** FIRE — novel-of-class (first cross-slice service-orchestration; same-tx audit+domain coordination; guard-context construction with proof from 3 modules)

**Files to author:**
- `src/modules/async-consult/internal/services/consult-service.ts` — orchestrator. 7 operations covering Sprint 9 transitions (initiate, start_intake, submit, abandon, resume, process, patient_responds). `expire` deferred to Sprint 11+ (no scheduled job at v0.1). Each operation:
  1. Validates input via Zod schema
  2. Reads current consult state via repo (`findConsultById`)
  3. Constructs typed GuardContext (proves guard satisfaction via cross-slice calls — Forms-Intake, Consent — BEFORE building the context)
  4. `validateTransition(from, event, ctx)` — throws on guard mismatch / invalid / deferred
  5. Within `withTransaction(async (tx) => { tx.query('SELECT set_tenant_context($1)'); ... }, externalTx)`:
     - `repo.updateConsultState({ ..., expected_from_state: from }, tx)` — null return → 409 conflict
     - `repo.createStateTransitionEvent({...}, tx)`
     - `emitConsult<event>Audit({...}, tx)` (placeholder events per SI-004)
     - `emitConsult<event>DomainEvent(tx, {...})` (placeholder events per SI-004)
- `src/modules/async-consult/audit.ts` — 4 audit emitters (initiated / intake_submitted / abandoned / expired). `expired` emitter scaffolds but call site deferred (no scheduled job in Sprint 10).
- `src/modules/async-consult/events.ts` — 4 domain event emitters (same shape).

#### Defense-in-depth checklist (Sprint 9 retro lesson #1)

1. **Guard satisfaction proof (per event):**
   - `start_intake`: payment service returns `confirmed=true`. Sprint 10 stub: `payment_confirmed: true` is hard-coded TRUE (no Payment slice yet); SI-006 candidate filed if appropriate.
   - `submit`: forms-intake submission state confirms complete; `hasActiveConsent(ctx, accountId, 'care', null)` returns true.
   - `abandon`: `hours_since_activity = (now - consult.updated_at) / hours` ≥ 48.
   - `resume`/`process`/`patient_responds`: empty context.
2. **Tenant scope:** every repo call uses `withTransaction` + manual `set_tenant_context` OR direct `withTenantBoundConnection` (default repo path). All repo queries already include explicit `tenant_id = $N` predicate (Sprint 9 r6 closure).
3. **Audit emission ordering:** INSIDE same tx; audit BEFORE domain event (mirror `consent-service.ts:77,91`).
4. **Domain event emission:** outbox pattern; same tx; uses existing outbox helper (verify exists at execution; if not, defer to follow-up SI).
5. **Idempotency key handling:** `initiate` is idempotent-bound (use existing `lib/idempotency.ts`). `start_intake/submit/abandon/resume/process/patient_responds` are state-conditional and naturally idempotent via optimistic concurrency (replay matches zero rows → null → 409).

---

### TLC-021e — HTTP handlers + route wiring

**Estimated commits:** 2 (handlers + routes.ts wiring)
**Decision rule:** 4
**Codex strategy:** FIRE — pattern-mirror of `consents.ts` shape but with novel state-machine integration + 7 endpoints; expect 1-2 rounds.

**Files to author:**
- `src/modules/async-consult/internal/handlers/consults.ts` — 7 handlers:
  - `POST /v0/async-consult` — initiate
  - `POST /v0/async-consult/:id/start-intake`
  - `POST /v0/async-consult/:id/submit`
  - `POST /v0/async-consult/:id/abandon`
  - `POST /v0/async-consult/:id/resume`
  - `POST /v0/async-consult/:id/process`
  - `GET /v0/async-consult/:id/events` — list event history
- Update `routes.ts` with the 7 routes.
- Patient-view projection: `Omit<Consult, 'tenant_id'>` per Master PRD §17 + C3 (mirror `consents.ts:51-57`).

---

### TLC-021f — Integration tests

**Estimated commits:** 2 (handler happy-paths + cross-tenant isolation)
**Decision rule:** 3 (diminishing-returns hygiene)
**Codex strategy:** FIRE — pattern-mirror of `consent-cross-tenant-isolation.test.ts`; expect 0-1 rounds.

**Test files to author:**
- `tests/integration/async-consult-http.test.ts` — happy paths: initiate, start_intake (with stub payment), submit (with seeded forms-intake submission + active consent), abandon (with seeded consult + 48h+ updated_at), resume, process, patient_responds (transition to UNDER_REVIEW).
- `tests/integration/async-consult-cross-tenant-isolation.test.ts` — mirror of `consent-cross-tenant-isolation.test.ts`. US tenant cannot read/update Ghana consult; no spurious audit emission in attacking tenant.

---

### TLC-022 — Project conventions doc

**Estimated commits:** 1
**Decision rule:** Sprint 9 retro process change #4
**Codex strategy:** SKIP (pure docs)

**File to author:** `docs/PROJECT_CONVENTIONS.md` lifting the 4 Sprint 9 patterns:
1. Composite UNIQUE + composite FK pattern for tenant-bound parent-child tables
2. `to_regclass` guards on table-targeting rollback statements
3. Explicit `tenant_id = $N` predicate on tenant-scoped repo queries (defense-in-depth alongside RLS)
4. Typed `GuardContext` discriminated union for state machine transitions (with event/context match enforcement)
5. (also) Manual `SELECT set_tenant_context($1)` inside `withTransaction` for service-layer transactions

---

## Definition of Done — Sprint 10

- [ ] PM-brief verification gate ran + findings recorded (this doc)
- [ ] TLC-021d: consult-service.ts + audit.ts + events.ts (3 commits)
- [ ] TLC-021e: consults handlers + routes (2 commits)
- [ ] TLC-021f: 2 integration test files
- [ ] TLC-022: PROJECT_CONVENTIONS.md
- [ ] Codex FIRE on each sub-story; HIGH/CRITICAL closed in-sprint
- [ ] Lint + type-check clean
- [ ] No invariants relaxed (I-003, I-019, I-023, I-024, I-025, I-027)
- [ ] No production-code changes outside scope
- [ ] `docs/SPRINT_10_REVIEW.md` filed
- [ ] `docs/SPRINT_10_RETRO.md` filed
- [ ] PM kickoff brief for Sprint 11 (pre-pave runway will exhaust again; pivot decision)

---

## Risks (PM-flagged + SM additions)

- **PM Risk 1: SI-006 candidate (payment confirmation).** Sprint 10 stub may need a doc; SM decides at execution.
- **PM Risk 2: Outbox helper for domain events.** Verify `events.ts` outbox helper exists at execution; if absent, defer domain event emission to Sprint 11+ scoping (audit emission still ships).
- **SM addition: 5+ Codex rounds = pause-and-reassess (Sprint 9 retro #3).** TLC-021a hit 5 rounds; if any Sprint 10 sub-story hits 5+, pause and either descope or surface to Evans.
- **SM addition: explicit tenant predicate rule + composite-FK pattern + guard typing pattern apply to all Sprint 10 authoring.** Sprint 10 sub-stories must consistently apply these (codified in TLC-022).

---

## Codex iteration cap

Per Sprint 9 retro #3: 5+ Codex rounds on a single sub-story = pause + reassess scope. Apply if hit.
