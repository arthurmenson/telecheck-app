# Telecheck-app project conventions

**Sprint 10 / TLC-022.** Lifts patterns established across Sprints 6, 9, 10 (especially the 16+ Codex HIGH/MEDIUM closures on Sprint 9 + Sprint 10 schema/state-machine/service authoring) into a single discoverable conventions doc.

Authoring discipline: **read this doc before authoring schema migrations, repos, services, handlers, or state machines** for new slice work. The patterns below are the result of substantial Codex adversarial-review iteration; treating them as load-bearing rules saves the time + risk of re-deriving them per slice.

**Living artifact** — amend in place when new patterns emerge; bump the revision-line below.

**Revision history:**
- **r1 (2026-05-05, Sprint 10 / TLC-022):** initial codification of Sprint 6/9/10 patterns.

---

## §1 Schema migration patterns (Sprint 6 + Sprint 9 codified)

### §1.1 Composite UNIQUE + composite FK for tenant-bound parent-child tables

**Rule:** when a tenant-scoped child table references a tenant-scoped parent (or PHI like a patient, intake submission, etc.), the child's FK MUST be composite `(tenant_id, parent_id)` referencing the parent's matching composite UNIQUE.

**Why:** RLS alone does NOT prevent cross-tenant FK targeting. A tenant-A insert with `parent_id` pointing to tenant-B's row would pass RLS on the child row's own tenant_id while binding to a cross-tenant parent — corrupting downstream history + audit trails. Composite FK makes cross-tenant binding structurally impossible.

**Pattern:**

```sql
-- Parent table needs the composite UNIQUE
CREATE TABLE parents (
    id        VARCHAR(26) PRIMARY KEY,
    tenant_id TEXT        NOT NULL REFERENCES tenants(id),
    -- ... other columns ...
    CONSTRAINT parents_tenant_id_id_unique UNIQUE (tenant_id, id)
);

-- Child table uses NAMED composite FK (see §1.2)
CREATE TABLE children (
    id          VARCHAR(26) PRIMARY KEY,
    parent_id   VARCHAR(26) NOT NULL,
    tenant_id   TEXT        NOT NULL REFERENCES tenants(id),
    -- ... other columns ...
    CONSTRAINT children_tenant_parent_fk
        FOREIGN KEY (tenant_id, parent_id) REFERENCES parents (tenant_id, id)
);
```

**Examples in codebase:**
- `migrations/012_accounts.sql:181` — accounts adds `UNIQUE (tenant_id, account_id)` "for downstream composite-FK pattern"
- `migrations/006_forms_intake.sql:503` — forms_submission adds `UNIQUE (tenant_id, submission_id)`
- `migrations/020_async_consult.sql` — consults uses both as targets (composite UNIQUE on self for consult_events FK; composite FK to accounts + forms_submission)
- `migrations/021_async_consult_tenant_boundary_constraints.sql` — idempotent ALTERs for the upgraded-DB path

### §1.2 Named constraints for cross-version idempotency

**Rule:** every constraint that ANY rollback or follow-on ALTER references MUST have an explicit `CONSTRAINT <name>` clause at creation time. Auto-generated names (Postgres default `<table>_<column>_<key|fkey>`) are NOT stable across migration paths.

**Why:** when a fresh-DB applies migration N inline + an upgraded-DB applies migration N + N+1 (where N+1 is the idempotent ALTER for the upgrade path), constraint names must match across the two paths so rollback can drop by name uniformly.

**Pattern:** see TLC-021a r3 closure at `migrations/020_async_consult.sql` — every composite UNIQUE + composite FK has an explicit `CONSTRAINT <name>` clause; matching constraint names appear in `migrations/021_async_consult_tenant_boundary_constraints.sql` ALTERs.

### §1.3 to_regclass guards on rollback table-targeting statements

**Rule (UNIVERSAL):** any operation against a table in a rollback (`DROP POLICY`, `DROP TRIGGER`, `ALTER TABLE DROP CONSTRAINT`, `ALTER TABLE ADD CONSTRAINT`, etc.) MUST be wrapped in a `DO $$ BEGIN IF to_regclass('<table>') IS NOT NULL THEN ... END IF; END$$;` block. Only `DROP TABLE IF EXISTS` is table-existence-safe by default.

**Why:** `IF EXISTS` qualifiers on most statements only check the inner object (the policy / constraint / trigger) — they abort if the target table is missing. Partial-apply states (migration N created table A but failed before creating table B; then we try to roll back) leave the rollback aborted halfway, with partially-created objects still in the schema.

**Pattern:** see Codex r4 + r5 closures at `migrations/rollback/020_rollback.sql` — every table-targeting operation is wrapped.

### §1.4 Migration commit + verification cycle

**Rule:** when authoring a migration that adds tenant-scoped tables, update `tests/contracts/rls-policy-coverage-lockdown.test.ts` `TENANT_SCOPED_TABLES` array AND `TENANT_SCOPED_TABLE_COUNT` count IN THE SAME COMMIT.

**Why:** the lockdown test's whole value is catching unintentional schema drift. Intentional additions update the inventory + count; unintentional additions trigger §2 count drift detection.

---

## §2 Repository patterns (Sprint 9 r6 codified)

### §2.1 Explicit tenant_id predicate alongside RLS

**Rule:** every tenant-scoped SELECT/UPDATE in a repo MUST include `WHERE ... AND tenant_id = $N` explicitly, not rely solely on RLS.

**Why:** RLS alone is insufficient on the `externalTx` path. A service/test/retry path with stale or wrong tenant context would otherwise read/mutate cross-tenant rows silently — RLS would still appear green because the connection's tenant context matches the rows it returns. The explicit predicate guarantees same-tenant filtering independent of the connection's RLS context.

**Pattern:**

```typescript
const result = await client.query<Row>(
  `SELECT ${COLUMNS} FROM table
    WHERE id = $1 AND tenant_id = $2`,  // explicit predicate
  [id, tenantId],
);
```

**Examples:**
- `src/modules/async-consult/internal/repositories/consult-repo.ts:152` (Sprint 9 r6 closure)
- `src/modules/tenant-config/internal/repositories/ccr-config-repo.ts:67` (existing pattern)

### §2.2 externalTx parameter pattern

**Rule:** every repo function takes an optional `externalTx?: DbClient` (or `DbTransaction`) parameter. When provided, the repo runs against the supplied tx (no `withTenantBoundConnection` wrap; assumes caller bound the tenant context). When absent, the repo wraps in `withTenantBoundConnection`.

**Pattern:** see `consult-repo.ts:97-122` for the canonical `runner` helper pattern.

---

## §3 Service-layer patterns (Sprint 9 + Sprint 10 codified)

### §3.1 withTransaction + manual set_tenant_context composition

**Rule:** service-layer transactions use `withTransaction(async (tx) => { await tx.query('SELECT set_tenant_context($1)', [ctx.tenantId]); ... })`. `withTransaction` does NOT bind tenant context; the manual `set_tenant_context` call is required as the FIRST statement of the tx callback.

**Why:** `withTransaction` (per `src/lib/db.ts:476`) handles BEGIN/COMMIT/ROLLBACK + connection lifecycle but not tenant binding. `withTenantBoundConnection` handles binding but not transaction wrapping. The composition pattern is the canonical solution.

**Pattern:** see `submission-service.ts:398-414` (canonical) + `consult-service.ts:initiate` (Sprint 10).

### §3.2 Same-transaction audit + domain event emission

**Rule:** for any state-changing service operation, audit emission AND domain event emission run INSIDE the same transaction as the state UPDATE. Audit BEFORE domain event. Rollback discards all three together.

**Why:** I-003 audit append-only + I-016 outbox consistency. If audit committed but the state UPDATE rolled back, the audit chain would record an event that never happened. Same-tx prevents this.

**Pattern:**

```typescript
await withTransaction(async (tx) => {
  await tx.query('SELECT set_tenant_context($1)', [ctx.tenantId]);
  const updated = await repo.update({...}, tx);
  await emitFooAudit({...}, tx);            // BEFORE domain event
  await emitFooDomainEvent(tx, {...});      // same tx; rollback together
}, externalTx);
```

### §3.3 Defense-in-depth ownership enforcement

**Rule (CRITICAL):** for any service operation that reads or mutates patient-data-bearing rows, apply BOTH cross-tenant AND cross-patient defense:

| Layer | What it prevents | Where |
| --- | --- | --- |
| L1: SQL tenant predicate | cross-tenant via externalTx misuse | repo SELECT/UPDATE WHERE clauses |
| L2: Composite FK | cross-tenant via known-id binding | migration |
| L3: RLS + withTenantBoundConnection | cross-tenant default path | foundation library |
| L4: Service-layer assertConsultOwnership (or equivalent) | cross-PATIENT within same tenant | service entry point |
| L5: Cross-slice verification before GuardContext construction | guard satisfaction proof | service operation |
| L6: State machine GuardContext type system | wrong-event-for-state | state-machine module |
| L7: Optimistic-concurrency UPDATE | concurrent transition races | repo UPDATE WHERE clause |

**Why:** RLS prevents cross-tenant; nothing in RLS prevents cross-patient within the same tenant. Service layer must explicitly verify the actor owns the patient-data-bearing row before mutation OR read.

**Pattern:** see `consult-service.ts:assertConsultOwnership` (Sprint 10 r9 closure for write paths; r13 closure for read paths).

### §3.4 Tenant-blind error mapping (I-025)

**Rule:** ownership failures (cross-patient within same tenant) MUST map to 404 at the handler layer, NOT 403. Distinguishing "exists but not yours" from "doesn't exist" leaks cross-patient existence to a same-tenant attacker.

**Pattern:** see `consults.ts:mapServiceError` — both `ConsultNotFoundError` AND `ConsultPatientOwnershipError` map to 404 `internal.resource.not_found`.

### §3.5 Fail-closed on unverified guards

**Rule:** for transitions whose guard satisfaction depends on un-authored upstream slices (e.g., Payment slice for `payment_confirmed`; AI Service slice for `process` authorization), the service operation MUST fail-closed at v0.1. The exported function exists so eventual upstream callers have a stable target; until the SI closes, it unconditionally throws.

**Why:** hard-coding `payment_confirmed: true` would let unpaid consults advance through the payment-guarded transition with the audit trail recording the transition as if payment had been verified. The audit chain becomes unrecoverable evidence of a guard that never fired.

**Pattern:** `consult-service.ts:startIntake` (SI-006 gate; r9 closure) + `consult-service.ts:process` (SI-007 gate; r11+r12 closures).

### §3.6 Cross-slice public-interface authorization enforcement

**Rule:** when a slice exposes a public-interface function for cross-slice consumption, authorization MUST be enforced INSIDE the providing slice, not delegated to the calling slice. Return only minimal authorization-result data, NOT full PHI rows.

**Why:** PHI exposed to cross-slice callers expands the trust boundary of the providing slice indefinitely. Once a function returns `FormSubmission` with the responses payload, ANY future cross-module caller can read PHI by supplying tenantId + submissionId.

**Pattern:** `forms-intake/index.ts:verifySubmissionBindingEligibility` (Sprint 10 r10 closure) — returns `{valid: boolean; reason?: ...}`, never the full submission. Replaced earlier `getSubmissionForBinding` which returned the full PHI row.

---

## §4 State machine patterns (Sprint 9 r7 + r8 codified)

### §4.1 Typed GuardContext discriminated union

**Rule:** transitions with documented guards (per State Machines §3) MUST require a typed `GuardContext` parameter. Compile-time discriminated union forces callers to commit to per-event guard fields; runtime validation enforces numeric/boolean guard truth.

**Pattern:** `state-machine.ts:137-144` (Sprint 9 r7 closure).

### §4.2 Event/context match enforcement

**Rule:** `validateTransition(from, event, ctx)` MUST take the event explicitly AND assert `event === ctx.event` at runtime. Untyped runtime callers (queue consumers, JSON-decoded requests) could otherwise supply mismatched event/context pairs to bypass guards.

**Pattern:** `state-machine.ts:validateTransition + GuardContextEventMismatchError` (Sprint 9 r8 closure).

### §4.3 Explicit deferred-event distinction

**Rule:** events not yet implemented at v0.1 are explicitly listed in `SPRINT_<N>_DEFERRED_EVENTS`. `validateTransition` throws `UnsupportedTransitionError` (NOT `InvalidTransitionError`) for these — the distinction lets handler layers surface different error messages.

**Pattern:** `state-machine.ts:SPRINT_10_DEFERRED_EVENTS`.

---

## §5 Codex review discipline (Sprint 9 retro #3)

### §5.1 5+ rounds = pause + reassess

**Rule:** if a single sub-story's Codex review hits 5+ fix-forward rounds, pause the sub-story. Either descope, re-author from scratch with the convergence pattern in hand, OR surface to Evans for scope-inflation decision.

**Why:** TLC-021a precedent (5 rounds before convergence) shows that beyond 5 rounds the sub-story is structurally too complex for the current authoring approach. Continuing past the cap risks burning sprint budget on a cascade of correlated findings without productive progress.

### §5.2 Codex FIRE on novel work; SKIP on pattern-mirrors

**Rule:** FIRE Codex review on every sub-story that introduces novel-of-class authoring (new module class, novel data flow, novel cross-slice integration). SKIP Codex on pattern-mirror work (4th application of an established skeleton recipe; pure docs; lockdown-on-existing-code).

**Validation:** Sprint 1-10 cumulative shows the heuristic is correct — Codex finds real defects on novel work (4 substantive findings on Sprints 1/5/6/7); SKIP-when-pattern-mirror has not yielded a missed defect.

### §5.3 HIGH = fix-forward in-sprint; MEDIUM = severity-context-dependent

**Rule:** HIGH Codex findings = fix-forward in-sprint (no exceptions). MEDIUM findings on contract-lockdown surfaces (`tests/contracts/`) where the fix is trivial (≤5 LOC) AND the finding hits the test's core value proposition = fix-forward in-sprint. General MEDIUM-deferral rule remains for non-contract-lockdown surfaces.

---

## §6 PM-brief verification gate (Sprint 6 + Evans 2026-05-05 oversight directive)

See `docs/SCRUM_OPERATING_MODEL.md` §"PM-brief verification gate" for the full mechanical procedure. Summary:

- After PM brief returns, SM mechanically verifies every cited identifier against its source-of-truth file BEFORE accepting the brief.
- 4 PM rubric sub-rules under decision rule 4 govern PM brief content (verify before authoring; wire-protocol vocabulary check; spec-corpus identifier check; internal-canonicalization-pattern check).
- 5 consecutive clean PM briefs since the gate was instituted at `804c294`. Sprint 3 + Sprint 5 hallucination class has not recurred.

---

## §7 Living-doc filename convention (Sprint 5 retro)

**Rule:** audit / coverage / status / convention docs use non-dated filenames (single living artifact) with a revision-history block at the top. Example: `CRISIS_DETECTION_COVERAGE_AUDIT.md`, `BUILD_VS_SPEC_TRACEABILITY_MATRIX.md`, this doc.

**Why:** date-stamped filenames break lockdown tests that assert documents by name (e.g., `crisis-detection-coverage-lockdown.test.ts §3a`). Single living doc with revision history preserves the audit trail without breaking external references.

---

## Spec references

- I-003 (audit append-only)
- I-016 (domain events same-tx)
- I-019 (crisis detection platform-floor)
- I-023 (three-layer tenant isolation)
- I-024 (cross-actor break-glass discipline)
- I-025 (tenant-blind error envelopes)
- I-027 (every audit record carries tenant_id)
- ADR-001 (modular monolith — public-interface-only cross-module access)
- ADR-023 (Model A multi-tenancy)
- Master PRD v1.10 §17 + Glossary v5.2 C3 (tenant_id stripped from patient surfaces)
- Sprint 9 + Sprint 10 Codex closure series (async-consult-r1..r15)

---

## Sprint reference

Authored Sprint 10 (TLC-022) on the autonomous Scrum cycle. Closes the Sprint 9 retro #4 process change deliverable (codify Sprint 9 patterns into project conventions doc). Future migrations + repos + services + state machines reference this doc rather than re-deriving the patterns per slice.
