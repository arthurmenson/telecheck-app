# Telecheck-app project conventions

**Sprint 10 / TLC-022.** Lifts patterns established across Sprints 6, 9, 10 (especially the 16+ Codex HIGH/MEDIUM closures on Sprint 9 + Sprint 10 schema/state-machine/service authoring) into a single discoverable conventions doc.

Authoring discipline: **read this doc before authoring schema migrations, repos, services, handlers, or state machines** for new slice work. The patterns below are the result of substantial Codex adversarial-review iteration; treating them as load-bearing rules saves the time + risk of re-deriving them per slice.

**Living artifact** — amend in place when new patterns emerge; bump the revision-line below.

**Revision history:**
- **r1 (2026-05-05, Sprint 10 / TLC-022):** initial codification of Sprint 6/9/10 patterns.
- **r2 (2026-05-05, Sprint 15 / TLC-028):** Sprint 13 + Sprint 14 retro patterns — §5.4 closure-path-overclaim pre-emption pattern; §5.5 structural-constraint-not-code-defect escalation pattern (Sprint 12 original + Sprint 14 round-1 environment-availability extension); §6 sub-rule 5 environment-dependency check at planning (raises PM rubric from 4 → 5 sub-rules — first new sub-rule since Sprint 6 baseline).
- **r3 (2026-05-06, Sprint 18 / TLC-033):** Sprint 17 retro patterns. §5.4 extended with 6th finding-class (**module-load class** — does the file's top-level imports + import-side-effect-calls throw under the CI workflow that loads it?). §5.4 also extended with **lockdown-test pinning rule** (after 3+ rounds of Codex fix-forward on the same finding-class, pin resolved invariants as a lockdown contract test). Sprint 17 canonical examples: `tests/contracts/canonicalize-db-url.test.ts` 19-case lockdown pins r10-C → r11-2 → r12 → r13 trajectory; `requireBenchDb()` at module-load throw + `*.db.bench.ts` glob exclude pins module-load class. NEW §5.6 dual-close milestone pattern (when a sprint closes BOTH an escalation AND an ORT row, document explicitly in retro + traceability matrix bump). Sprint 17 = first dual-close milestone (TLC-027 escalation + OR-218 ORT row).

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

**Exception:** when §5.5 structural-constraint escalation applies, HIGH-severity findings can be ESCALATED to a Sprint N+1 story without in-sprint closure. Sprint 14's TLC-025 r10 (2 HIGH + 2 MEDIUM, all environment-availability constrained) is the precedent — first-ever HIGH-severity escalation; first sprint with zero in-sprint Codex closures.

### §5.4 Closure-path-overclaim pre-emption pattern (Sprint 13 retro)

**Rule:** when authoring a closure-path artifact (CI workflow, enforcement scaffold, gate-correctness self-test, machine-enforced metadata guard, etc.), pre-emptively check at authoring time:

- **Hollow-coverage class:** does the layer I'm building actually exercise the gate path it claims to protect, or only helper functions in isolation? (Sprint 13 r5: `selfTest()` called helpers in isolation rather than driving fixtures through `runGate()`.)
- **Doc-only-discipline class:** is the "enforcement" claim machine-enforced or just documented? (Sprint 13 r6: `[scope=baseline-refresh]` tag described as enforcement but only checkable post-merge by grep.)
- **Loose-grep class:** are regex patterns anchored, or substring-loose? (Sprint 13 r7-A: bare `\b\d{10,}\b` accepts incidental timestamps; r8-B: `[Rr]un-[Ii]d:` accepts `fooRun-Id:` substring matches.)
- **Wrong-git-semantics class:** is the diff semantic correct for the trigger context? (Sprint 13 r8-A: two-dot diff misclassifies PRs after main updates target file; triple-dot merge-base is required for PR-change-set semantics.)
- **Path-filter required-check class:** does the workflow always run for the trigger context, or could path filtering leave required-checks hung on a missing context? (Sprint 13 r7-B: path-filtered required-check blocks unrelated PRs.)
- **Module-load class** (Sprint 17 r17-CI / Sprint 18 r3 codification): does the file's top-level imports + import-side-effect-calls throw under the CI workflow that loads it? (Sprint 17 first-EXECUTE landing: `tests/perf/audit/emit-audit.bench.ts` called `requireBenchDb()` at module-load → threw in CI's `perf.yml` which doesn't set `BENCH_DATABASE_URL` → vitest collected the file → entire bench session failed even though only this ONE bench file actually needed the env. Closed at fix-forward by renaming to `*.db.bench.ts` + `vitest.bench.config.ts` glob exclude. Pre-empt at authoring time: when a bench / test / setup file has top-level calls that throw on missing env, ensure the workflow that loads it actually sets the env, OR rename to a glob-excluded variant.)

**Why:** Sprint 13's r5 → r6 → r7-A → r7-B → r8-A → r8-B chain demonstrated that every layer of "enforcement" is itself a candidate for the same overclaim class Codex has been hammering on. r5 was hollow-coverage in a scaffold built to prevent hollow coverage. r6 was doc-only-discipline in a §"Enforcement mechanism" section. r7-A was loose-grep in a workflow titled "Verify metadata." r7-B + r8-A + r8-B continued the pattern at successively finer layers. Pre-empting these classes at authoring time saves a Codex round each.

**Sprint 14 corollary — scaffold-can-be-structural-too:** the closure-path-overclaim recurrence can manifest at the SCAFFOLD architecture layer, not just at the in-scaffold-code layer. Sprint 14's TLC-025-SCAFFOLD authored bench-mode setup using `setTestPool()`'s BEGIN/COMMIT savepoint translation — a pattern that's correct for integration tests but breaks `pg_advisory_xact_lock` lifetime semantics for the planned `emitAudit` bench. The scaffold would have measured the wrong thing. Codex r10-B caught this in one pass.

**Sprint 17 / TLC-033 extension — lockdown-test pinning rule:** after 3+ rounds of Codex fix-forward on the SAME finding-class within a single sub-story, pin the resolved invariants from EACH round as a lockdown contract test (under `tests/contracts/`) so future regressions on any round's invariant fail the lockdown rather than requiring another Codex round. Sprint 17 canonical example: `tests/contracts/canonicalize-db-url.test.ts` 19-case lockdown pins the URL-canonicalization trajectory r10-C → r11-2 → r12 → r13. Each round's invariant is a discrete `it()` block with the round citation in the test name. The lockdown is a one-time investment that prevents the same finding-class from re-emerging in a later sprint when the original closure rationale isn't fresh.

### §5.5 Structural-constraint-not-code-defect escalation pattern (Sprint 12 retro original + Sprint 14 retro extension)

**Rule (combined):** when a Codex finding class converges on "this requires data/environment we don't have yet" — either across 3+ fix-forward rounds (original Sprint 12 codification) **OR** at Codex round 1 if the findings all require an environment dependency the autonomous shell doesn't have (Sprint 14 extension) — escalate to a Sprint N+1 story rather than continuing iterative fix-forward. The Sprint N retro records this explicitly. Distinct from §5.1 5+ rounds = pause cap (which addresses scope inflation, not structural data/environment gaps).

**Original (Sprint 12) trigger conditions:**
- 3+ fix-forward rounds on the same finding class
- Each round produces a valid finding while introducing the next round's complaint
- Underlying constraint is structural (e.g., needs CI calibration; needs a slice that doesn't exist yet; needs a spec ratification upstream)

**Extension (Sprint 14) trigger conditions:**
- Codex round 1 (no prior fix-forward rounds required)
- Findings all require an environment dependency the autonomous shell doesn't have (Postgres, gh auth, Redis, secrets, CI access, etc.)
- Closing any finding would require either a production-code change ruled out at planning OR hands-on env-validation infeasible in the autonomous shell

**Closure precedents:**
- TLC-024 r4 → Sprint 13 TLC-026 [Sprint 12 original pattern; closed Sprint 13 via 4-round fix-forward chain converging at r9 APPROVED clean]
- TLC-025 r10 → Sprint 15+ TLC-027 [Sprint 14 extension pattern; pending — first HIGH-severity escalation; first sprint with zero in-sprint closures]

**When NOT to escalate (still fix-forward):**
- The finding has a contained-scope fix that doesn't require env-validation (regex anchoring, type-narrowing, doc-edit) — fix-forward
- The finding is on a non-env-dependent code path (lint-rule violation, missing test on pure-function helper) — fix-forward
- The fix is a Sprint N+1 story scoped against env that's BLOCKED but the fix itself is in-budget for a future env-available sprint — escalate but document the env-availability precondition

### §5.6 Dual-close milestone pattern (Sprint 17 retro / Sprint 18 codification)

**Rule:** when a sprint closes BOTH a previously-escalated Codex finding-class AND a Tier 1 ORT row, document the dual-close explicitly in:
1. Sprint review/retro ACCEPTANCE line (call out "first/Nth dual-close milestone")
2. `docs/BUILD_VS_SPEC_TRACEABILITY_MATRIX.md` revision bump with both closures
3. Cumulative-state recompute in retro (Codex closures + ORT rows closed + escalation status)

**Why:** Sprint 17 demonstrated that escalations + ORT rows closing in the same sprint compound the closure-trajectory's signal value — Sprint 14 escalated TLC-025 → Sprint 17 closed it AND the OR-218 ORT row that the escalated TLC-027 was infrastructure for. The dual-close is non-obvious reading retros sequentially; documenting it explicitly preserves the milestone signal for future sprint-history readers.

**Sprint 17 canonical example:** TLC-027 (Sprint 14 escalation) + OR-218 (Tier 1 ORT row) both closed 2026-05-06. First-ever dual-close. Documented in `docs/SPRINT_17_REVIEW.md` ACCEPTANCE line + `docs/BUILD_VS_SPEC_TRACEABILITY_MATRIX.md` r3 → r4 revision bump.

---

## §6 PM-brief verification gate (Sprint 6 + Evans 2026-05-05 oversight directive; Sprint 14 sub-rule 5 extension)

See `docs/SCRUM_OPERATING_MODEL.md` §"PM-brief verification gate" for the full mechanical procedure. Summary:

- After PM brief returns, SM mechanically verifies every cited identifier against its source-of-truth file BEFORE accepting the brief.
- **5 PM rubric sub-rules** under decision rule 4 govern PM brief content (raised from 4 → 5 at Sprint 14 retro):
  1. Verify before authoring
  2. Wire-protocol vocabulary check
  3. Spec-corpus identifier check
  4. Internal-canonicalization-pattern check
  5. **Environment-dependency check at planning** (Sprint 14 retro NEW): for each proposed sub-story, explicitly check whether closure requires an environment dependency (Postgres, Redis, gh auth, secrets, CI access) the autonomous shell doesn't have. If YES, split into PLAN-ONLY (planning artifact + escalation conditions) and EXECUTE (env-available sprint). If NO, execute. Sprint 14 / TLC-025 cost demonstrated the rule's value: ~400 lines authored, full revert, escalation.
- **9 consecutive clean PM briefs** since the gate was instituted at `804c294` (PM hallucination class has not recurred since Sprint 6 baseline; Sprint 3 + Sprint 5 hallucination class is eradicated).

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
