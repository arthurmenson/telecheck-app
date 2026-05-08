# Telecheck-app project conventions

**Sprint 10 / TLC-022.** Lifts patterns established across Sprints 6, 9, 10 (especially the 16+ Codex HIGH/MEDIUM closures on Sprint 9 + Sprint 10 schema/state-machine/service authoring) into a single discoverable conventions doc.

Authoring discipline: **read this doc before authoring schema migrations, repos, services, handlers, or state machines** for new slice work. The patterns below are the result of substantial Codex adversarial-review iteration; treating them as load-bearing rules saves the time + risk of re-deriving them per slice.

**Living artifact** — amend in place when new patterns emerge; bump the revision-line below.

**Revision history:**
- **r5 (2026-05-08, Sprint 33-34 / SI-006 closure):** Sprint 33-34 SI-006 reserve-then-execute redesign + audit-dedupe SI patterns. NEW §3.7 reserve-then-execute (handler-owned idempotency cache atomically) — Sprint 33 PR-A through PR-E + cleanup-sweep canonical; NEW §3.8 return-cached-vs-throw discipline for sentinel paths inside `withIdempotency` — Sprint 33 PR-F2 r3 canonical (CRISIS_DETECTED + RESPONSE_PAYLOAD_TOO_LARGE + isHandledSentinel return-as-cached path); NEW §3.9 independent-tx Category A audit emission with dedupe markers — Sprint 33 PR-F2 r2 (independent-tx) + Sprint 34 PR #49 (audit_dedupe_markers + bodyHash + per-endpoint TTL alignment); NEW §5.11 comment-stripped source-grep for regression lockdowns — Sprint 33 PR-E r2 canonical (Group F lockdown stripComments helper); NEW §5.12 asymptotic-convergence expectation on cross-cutting concurrency changes — Sprint 33-34 cumulative pattern (18 substantive Codex findings closed across 11 PR iterations; matched the v1.10.1 hygiene cycle's 12-round asymptote). Three+ proof-points per sub-rule.
- **r1 (2026-05-05, Sprint 10 / TLC-022):** initial codification of Sprint 6/9/10 patterns.
- **r2 (2026-05-05, Sprint 15 / TLC-028):** Sprint 13 + Sprint 14 retro patterns — §5.4 closure-path-overclaim pre-emption pattern; §5.5 structural-constraint-not-code-defect escalation pattern (Sprint 12 original + Sprint 14 round-1 environment-availability extension); §6 sub-rule 5 environment-dependency check at planning (raises PM rubric from 4 → 5 sub-rules — first new sub-rule since Sprint 6 baseline).
- **r3 (2026-05-06, Sprint 18 / TLC-033):** Sprint 17 retro patterns. §5.4 extended with 6th finding-class (**module-load class** — does the file's top-level imports + import-side-effect-calls throw under the CI workflow that loads it?). §5.4 also extended with **lockdown-test pinning rule** (after 3+ rounds of Codex fix-forward on the same finding-class, pin resolved invariants as a lockdown contract test). Sprint 17 canonical examples: `tests/contracts/canonicalize-db-url.test.ts` 19-case lockdown pins r10-C → r11-2 → r12 → r13 trajectory; `requireBenchDb()` at module-load throw + `*.db.bench.ts` glob exclude pins module-load class. NEW §5.6 dual-close milestone pattern (when a sprint closes BOTH an escalation AND an ORT row, document explicitly in retro + traceability matrix bump). Sprint 17 = first dual-close milestone (TLC-027 escalation + OR-218 ORT row).
- **r4 (2026-05-06, Sprint 25 / TLC-038):** Sprint 19→24 CI-recovery-arc retro patterns (5 sprints; 8 PRs landed; ci.yml 91/101 → fully green workflow conclusion). NEW §5.7 shared-root-cause cluster discipline (Sprint 22 canonical: TLC-040 §3b + TLC-041 §1-7 → 8 cases, 1 commit, 40% budget); NEW §5.8 pattern-mirror SKIP discipline (Sprint 23 canonical: TLC-044 mirrors Sprint 19 TLC-034 advisory-lock); NEW §5.9 Fastify-idiom-mismatch finding-class (Sprint 24 canonical: TLC-045 r2 `void reply.send(); return;` → `return reply` after `reply.send()`); NEW §5.10 r1-r2 hypothesis-iteration discipline (Sprint 24 canonical: r1 idempotency.ts hypothesis wrong → r2 handler-pattern hypothesis right). Three+ proof-points each.

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

### §3.7 Reserve-then-execute is the only path for state-changing handlers (Sprint 33-34 SI-006 closure)

**Rule:** every state-changing HTTP handler MUST own its idempotency cache atomically via `withIdempotency` / `withIdempotentExecution`. The reservation INSERT, business mutation, completion UPDATE, and cached-response write all run inside ONE handler-owned transaction. The legacy preHandler-lookup + onSend-cache-write split (which existed pre-Sprint 33) is DEAD — the hook + writer + stash flag are gone, and Group F source-grep lockdowns pin their absence so a future regression cannot silently reintroduce dual-write semantics.

**Why:** the v0 split was not transactionally-safe. Two concurrent requests with the same 4-tuple key both passed the preHandler lookup, both executed business actions, both raced the onSend INSERT — `ON CONFLICT DO NOTHING` ensured only one cache row won, but BOTH committed business state. Duplicate execution. Plus subtler failure modes Codex surfaced through 11 PR iterations: legacy onSend ignored TTL overrides (PR-F1 r2); cached 4xx envelopes tripped body-mismatch 409 on legitimate corrected retries (PR-F2 r3); reservation-lock TTL conflated with cached-response TTL allowed stuck-handler dup-execute (PR-F1 r4); session-revoke window orphaned cached 200 (PR-F3 r4-r5).

**Pattern:** `src/lib/idempotent-handler.ts:withIdempotentExecution<TView>(req, reply, mapServiceError, body)`. Body callback signature is `(tx, idempotencyCtx) => Promise<{ status, view }>` — the `view` is the caller-projected response (no tenant_id leak per I-025; projection happens INSIDE the body callback so the cached response is post-projection). The `idempotencyCtx` second parameter is forwarded to service-layer audit-dedupe claims (see §3.9).

**Per-endpoint TTL overrides:** `src/lib/idempotency.ts:ENDPOINT_TTL_OVERRIDES` maps specific endpoints to a TTL different from the IDEMPOTENCY v5.1 default 24h. Auth-flow paths (`/v0/identity/login/verify`, `/v0/identity/registration/verify`) cache plaintext bearer tokens to satisfy the v5.1 retry contract; their TTL is bound to **900s aligned to the JWT `access_token` TTL** (`jwt.ts:62`). The pin: cache TTL = JWT TTL means cached responses cannot outlive the bearer they contain. Path normalization (lowercase + trailing-slash strip) inside `ttlSecondsForEndpoint` closes case/slash bypass paths.

**Reservation-lock vs cached-response TTL split:** the pending row's `expires_at` is the **reservation-lock lifetime**; the completed row's `expires_at` is the **cached-response dwell time**. The pending INSERT keeps the migration-005 column-default 24h reservation-lock; the override TTL is applied only at the pending → completed UPDATE.

**Source-grep lockdown:** `tests/integration/idempotency-helper.test.ts` Group F pins absence of `addHook('onSend')`, `storeIdempotencyRecord`, `request._idempotencyKey =`, `_idempotencyManagedByHandler`, and the helper-function name `markIdempotencyManagedByHandler` itself. See §5.11 for the comment-stripping convention.

**Canonical proof-points:**
- PR #43 PR-F1 (TTL overrides + reservation/cache TTL split, 4 Codex rounds, 3 HIGH closures)
- PR #47 PR-E (legacy onSend cache-write removal + Group F lockdown, 2 Codex rounds, 1 MEDIUM closure)
- PR #48 cleanup-sweep (delete `markIdempotencyManagedByHandler` + 31 call sites + lockdown extension)
- 5 migrated handler modules: async-consult, consent + delegations, forms-intake, identity, tenant-config (503-stub markers)

### §3.8 Return-cached-vs-throw discipline for sentinel paths inside withIdempotency (Sprint 33 PR-F2 r3 canonical)

**Rule:** when a deterministic 4xx outcome occurs inside `withIdempotency` body callback (CRISIS_DETECTED, payload-too-large, state-machine guard violations, validation sentinels, body-validation failures), the handler MUST **return** a `{ status: 4xx, view: errorEnvelope }` from the body callback rather than **throw** an httpError. Throwing rolls back the reservation; cached return commits the row so retries replay deterministically.

**Why:** the failure mode is exactly-once-on-retry. A throw inside `withIdempotency` body causes the SAVEPOINT rollback → reservation row gone → client retry with same Idempotency-Key sees no completed cache row → handler runs again → re-emits Category A audits, re-runs crisis scanner, re-fires irreversible side effects. The exactly-once IDEMPOTENCY v5.1 §1 guarantee is violated. Return-as-cached commits the 4xx envelope; the next retry hits the cache and replays the same 409 / 422 without re-execution.

**Pattern:** `src/modules/forms-intake/internal/handlers/submissions.ts` (Sprint 33 PR-F2 r3 closure). Three sentinel-classes converted from throw to return-as-cached:
- `CRISIS_DETECTED` → `{ status: 409, view: { error: { code: 'internal.resource.conflict', ... } } }`
- `RESPONSE_PAYLOAD_TOO_LARGE` → `{ status: 413, view: { error: { code: 'internal.request.payload_too_large', ... } } }`
- `isHandledSentinel(message)` → `{ status: 400, view: { error: { code: 'internal.request.semantically_invalid', ... } } }`

The error-envelope shape MUST match the canonical `ErrorEnvelope` from `src/lib/error-envelope.ts` (`code` + `message` + `trace_id` + `timestamp`) so cached and Fastify-global-handler-routed responses are indistinguishable to clients (PR-F2 r4 medium closure).

**Throw is still correct for:** unhandled exceptions (DB failures, connectivity errors, programming bugs) — those SHOULD roll back the reservation so a clean retry is possible. Only deterministic-4xx-outcomes-of-input get the return-as-cached treatment.

**Generic widening note:** when the body's success path returns `{ status, view: ServiceTypedView }` and the sentinel-catch returns `{ status, view: ErrorEnvelope }`, declare the helper generic as `withIdempotentExecution<unknown>(...)` so both shapes are assignable. The cached body is JSON regardless; the type widening is purely compile-time.

**Canonical proof-points:** PR-F2 r3 (CRISIS_DETECTED + RESPONSE_PAYLOAD_TOO_LARGE + isHandledSentinel migration); PR-F2 r4 (envelope-shape alignment to `error-envelope.ts`); PR #51 r4 (CI-revealed `InvalidTransitionError` 500 leak — fixed by adding mapping to handler `mapServiceError`, NOT by adding return-as-cached because the throw originates outside `withIdempotency` body).

### §3.9 Independent-tx Category A audit emission with dedupe markers (Sprint 33 PR-F2 r2 + Sprint 34 PR #49)

**Rule:** Category A audit emissions (per AUDIT_EVENTS v5.2 §Category A — `crisis_detection_trigger`, prescribing.* execution_rejected, etc.) on idempotency-protected handler paths MUST follow this 3-step pattern:
1. **Emit on a fresh independent transaction.** Open a `withTransaction(...)` with NO `externalTx` argument. The handler-owned business tx and the audit emission MUST be different transactions so the audit survives a business-tx rollback (which is the I-019 + I-003 durability contract — even if the handler throws CRISIS_DETECTED and the business state never persists, the escalation event MUST persist).
2. **Claim a dedupe slot before emit.** When `idempotencyCtx` is supplied (the handler is on an HTTP path), call `claimAuditDedupeSlot(client, identity)` inside the audit tx BEFORE the emit. The 6-tuple identity hashes `(tenant_id, idempotency_key, endpoint, actor_id, bodyHash, auditAction)` so cross-tenant + different-body + different-action requests get distinct dedupe keys.
3. **Skip emit if marker already claimed.** `claimAuditDedupeSlot` returns `false` when a prior attempt already committed the marker; the caller skips the emit (the audit is already durable from the prior attempt) but the surrounding throw still fires so the handler's CRISIS_DETECTED handling proceeds normally.

**Why:** PR-F2 r4 documented a deferred HIGH: a process crash between the independent-tx audit commit and the idempotency completion UPDATE leaves the audit durable but the reservation rolled back. A retry under the same Idempotency-Key re-runs the gate and emits a SECOND Category A audit. The dedupe marker (Sprint 34 PR #49) closes that gap with a separate `audit_dedupe_markers` table — the marker is independent of audit_records (which is hash-chained append-only; not a place to add dedupe semantics) and aligns its TTL to the per-endpoint idempotency cache TTL so a stale marker can't suppress a legitimate emit on a fresh post-cache-expiry request with different content.

**Pattern:** `src/modules/forms-intake/internal/services/submission-service.ts:runCrisisGate` is the canonical pattern. Service signatures must accept and forward `idempotencyCtx?: IdempotencyCtx` so the handler can pass it through. The `withIdempotentExecution` body callback signature was widened in PR #49 from `(tx)` to `(tx, idempotencyCtx)` specifically to enable this forwarding without re-computing the ctx.

**Distinct audit_action labels for distinct emit sites:** when a single request can trigger multiple Category A audits at different sites (e.g., `pauseSubmission` runs `runCrisisGate` BOTH for the patch-side scan AND for the merged-set scan inside the atomic tx), each site uses a distinct `auditAction` label (`'crisis_detection_trigger'` vs `'crisis_detection_trigger.merged_set'`) so each emission gets a distinct dedupe key — both audits can fire on a single request, and each is exactly-once on retries.

**Documented limitation:** if `claimAuditDedupeSlot` succeeds but the subsequent audit emission fails (DB error mid-tx, network failure), the marker stays — a retry will skip the emit and the audit is lost. Documented at the top of `src/lib/audit-dedupe.ts`. If a caller needs guaranteed audit emission, it should use a compensating-action pattern (out of scope for SI-006).

**Canonical proof-points:**
- PR-F2 r2 (`runCrisisGate` independent-tx fix; closes the rollback-with-handler-tx HIGH)
- PR-F2 r3 (return-cached-vs-throw inside `withIdempotency`; closes the duplicate-emit-on-retry HIGH — see §3.8)
- PR #49 (audit_dedupe_markers cross-cutting infra + bodyHash + per-endpoint TTL alignment; closes the crash-window HIGH that was deferred from PR-F2 r4)

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

### §5.7 Shared-root-cause cluster discipline (Sprint 22 retro / Sprint 25 codification)

**Rule:** when 2+ tickets share a diagnostic shape (same expected-vs-actual symptom, same upstream-of-handler position, same test-infra signature), defer them as a cluster and investigate together. ONE root-cause find closes ALL members.

**Why:** Sprint 21 attempted to fix TLC-040 §3b in isolation (2 PR rounds, both unsuccessful) before Sprint 21 retro flagged that §3b's `expected 400 to be 404` shape matched TLC-041's `expected 400 to be 503` exactly — both non-GET, both with valid auth, both 400-fires-before-handler. Sprint 22 investigated the cluster ONCE, found `src/lib/idempotency.ts` returning 400 `internal.idempotency.missing_key` for state-changing requests without `Idempotency-Key` header per IDEMPOTENCY v5.1, and closed 8 test cases across 2 files in 1 commit. The "investigate ONCE, close MANY" leverage is large: Sprint 22 used 40% of commit budget to close what 4 isolated investigations might have used 200%+ of budget on.

**Diagnostic shape recognition cues** (high signal for sharing root cause):
- Same HTTP status code expected vs same status code actual
- All non-GET (or all GET) — request method clusters
- Same `expected X to be Y` symptom across multiple test files
- Symptom fires upstream of the assertion's target (e.g., 400 before reaching the 404-or-503 handler precedence test)
- Failing tests have the same test-helper / fixture signature

**Sprint 22 canonical example:** TLC-040 §3b (POST /:id/abandon) + TLC-041 §1-7 (PATCH/POST/DELETE under /v0/admin/*) → both `expected 400 to be ___` → both fixed by adding `'idempotency-key': ulid()` header. 8 test cases / 2 files / 1 commit / 40% budget.

**Anti-pattern (avoid):** investigating each ticket in isolation when the cluster shape is visible at PM-brief authoring time. Either commit to the isolated investigation explicitly, OR defer to a cluster investigation. Don't drift between the two.

---

### §5.8 Pattern-mirror SKIP discipline (Sprint 23 retro / Sprint 25 codification)

**Rule:** when the second instance of an already-closed finding-class appears (same fix shape applies; same architectural rationale), Codex round is OPTIONAL — pattern-mirror is **novel-of-class-NEGATIVE** per §5.2. Apply the prior fix; no Codex round; cap fix-cost at ~1 commit.

**Why:** Sprint 19 TLC-034 closed migration concurrency via `pg_advisory_lock(hashtext('telecheck_test_migrations')::int)` serialization. Sprint 23 TLC-044 surfaced a sibling failure: 6 test files failing with `tuple concurrently updated` at `installTestAppRole`'s GRANT/REVOKE statements — a mirror-image race on Postgres catalog rows during parallel-fork test setup. The fix is structurally identical (advisory-lock with a distinct lock-key domain). No new architectural insight surfaced; no Codex round needed; closed in 1 commit.

**Pattern-mirror identification cues:**
- Same root-cause class as a previously-closed ticket (e.g., "parallel-fork race on Postgres catalog rows")
- Same fix shape (e.g., "wrap with `pg_advisory_lock(hashtext(...)::int)`")
- Distinct call-site / context (e.g., applyMigrations vs installTestAppRole)
- No new abstractions or architectural decisions introduced by the second fix

**Escalation gate:** if the mirror-fix DOESN'T close the second instance in 1 commit, the apparent mirror is NOT actually a mirror — escalate to fresh investigation (likely a related-but-distinct finding-class). Cap iteration in pattern-mirror SKIP mode at 1 commit; if it spills, switch modes.

**Sprint 23 canonical example:** TLC-044 mirrors TLC-034. Both wrap a Postgres-catalog-touching parallel-fork operation in `pg_advisory_lock`. Distinct lock-key domains (`telecheck_test_install_role` vs `telecheck_test_migrations`) so they don't share queues. Closed 6 files in 1 commit; no Codex round.

---

### §5.9 Fastify-idiom-mismatch finding-class (Sprint 24 retro / Sprint 25 codification)

**Rule:** when CI surfaces a Node/Fastify lifecycle error (`ERR_HTTP_HEADERS_SENT`, `ECONNRESET`, `ERR_STREAM_PREMATURE_CLOSE`, `Cannot set headers after they are sent to the client`) that isn't a test logic failure (i.e., the test PASSED), suspect a handler-pattern mismatch with the framework version — NOT an application logic bug.

**Why:** Sprint 24 TLC-045's first hypothesis blamed `src/lib/idempotency.ts:onSend` because the unhandled error fired during the §3b POST /abandon test path that newly exercised the idempotency middleware after Sprint 22's idempotency-key fix. r1 fix (catch+log on storeIdempotencyRecord throws) did NOT close the issue. Re-investigation found the actual root cause was in `src/modules/async-consult/internal/handlers/consults.ts`'s `mapServiceError` pattern: `void reply.code(404).send(...)` + `return;` (undefined). In Fastify v5, returning undefined when the reply hasn't finished its onSend pipeline triggers a phantom `reply.send(undefined)` that races with the first send → `safeWriteHead` on already-sent headers.

**Fix idioms:**
- **Fastify v5:** when a handler has already called `reply.send()` (or invoked a helper that did), `return reply;` rather than `return;`. This signals to Fastify "I've handled the response, don't auto-wrap my return value."
- **Avoid `void reply.send(...)`** in error-mapping or fall-through branches. Either `await reply.send(...)` or `return reply.send(...)`. The fire-and-forget shape interacts badly with Fastify's lifecycle.
- For helper functions that call `reply.send()` internally and return a boolean (like `mapServiceError`), have the caller `return reply` after the helper returns true.

**Cue: TEST PASSED + UNHANDLED ERROR.** This combination is the strongest fingerprint of a Fastify-idiom-mismatch. The response was correct (test asserts the right thing); the error fired during reply finalization AFTER the test moved on. App logic is fine; framework integration is wrong.

**Sprint 24 canonical example:** TLC-045 r2 — change `if (mapServiceError(err, reply, req.id)) return;` → `return reply;` at all 6 call sites in async-consult handlers. Closes the unhandled `ERR_HTTP_HEADERS_SENT` error in §3b's POST /abandon path. ci.yml workflow conclusion goes fully green for the first time in the autonomous arc.

---

### §5.10 r1-r2 hypothesis-iteration discipline (Sprint 24 retro / Sprint 25 codification)

**Rule:** when an r1 fix lands and CI shows the same symptom unchanged, the **hypothesis is wrong**, not the implementation. Iterate to a corrected hypothesis from CI evidence + source inspection inside the same sprint cap (budget 1 r2). If r2 also misses, escalate to investigation-sprint deferral.

**Why:** when a hypothesis is wrong, retrying the same fix shape (or larger versions of it) wastes budget. The right move is to update the hypothesis from new CI evidence — often the unchanged-symptom result IS the new evidence. Sprint 24 TLC-045 hypothesized r1 was the fix (wrap storeIdempotencyRecord in try/catch); when r1 landed and CI still showed `ERR_HTTP_HEADERS_SENT`, the corrected hypothesis came from the persistence pattern: error survives even when the suspected throw-site is gagged → throw-site isn't the source. Stack-trace re-inspection + handler-pattern check identified the real source in async-consult handlers. r2 closed cleanly.

**Hypothesis-iteration mechanics:**
1. **r1 hypothesis:** generated at sprint planning from initial evidence. Land r1 fix.
2. **r1 verdict:** if CI green → r1 was right. If CI shows same symptom → hypothesis is wrong; update it.
3. **r2 hypothesis:** generated from r1 verdict + new CI evidence + source re-inspection. Land r2 fix.
4. **r2 verdict:** if CI green → close. If still red → DON'T author r3 inside the same sprint; defer to investigation sprint.

**Budget shape:** r1-r2 fits in a 5-commit sprint cap (1 r1 + 1 r2 + 1 close + 2 reserves). r3+ implies the symptom needs deeper investigation than the sprint cap supports — escalate cleanly.

**Defense-in-depth retention:** even when r1 was the wrong primary hypothesis, the r1 change may still be the right shape (better practice; aligned-with-design-intent; future-proofing). Keep r1 if so. Sprint 24 retained r1 (idempotency.ts catch+log) as defense-in-depth even though r2 (handler return-reply) was the actual root-cause fix.

**Sprint 24 canonical example:** TLC-045. r1 idempotency.ts catch+log → wrong primary hypothesis but retained as DiD. r2 async-consult `return reply` → right hypothesis, closed cleanly.

### §5.11 Comment-stripped source-grep for regression lockdowns (Sprint 33 PR-E r2 canonical)

**Rule:** when a source-grep lockdown test pins the absence of a removed symbol, identifier, or code-shape, the grep MUST run against **comment-stripped source**, not raw file content. Doc-comments that intentionally reference removed symbols by name (deprecation notices, tombstone blocks, regression-trigger explanations) would otherwise produce false positives that a future engineer would silence by deleting the explanatory comments — exactly the documentation that makes the lockdown understandable.

**Why:** the SI-006 PR-E lockdown initially used narrow regexes (`addHook(\s*['"]onSend`) to avoid matching comment text. Codex r2 review surfaced that a future regression could reintroduce the legacy path via spelling variants (`addHook ('onSend',`, `fastify['addHook']('onSend')`, `const storeIdempotencyRecord = async (...)=>`, `request['_idempotencyKey'] =`, `if (request._idempotencyManagedByHandler)`) and the narrow regexes would all miss. Broadening the patterns to catch every spelling AND running against raw source would false-positive on the doc-comment block in `idempotency.ts` that says "the legacy onSend hook + storeIdempotencyRecord were REMOVED in PR-E." Stripping comments first lets the patterns be **broad** (catches spelling variants) AND **precise** (no false positives on doc-comments).

**Pattern:** `tests/integration/idempotency-helper.test.ts` Group F `stripComments(src)` helper:
```typescript
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')          // block comments
    .replace(/(^|[^:\\])\/\/.*$/gm, '$1');     // line comments (avoid http://, file://)
}
```

The negative-character class `[^:\\]` before `//` avoids stripping URL fragments inside string literals. After stripping, the patterns are deliberately broad:
- `/['"`]onSend['"`]/` — any quoted form of the literal string
- `/\bstoreIdempotencyRecord\b/` — bare identifier (decl OR call)
- `/_idempotencyKey['"`\]]?\s*=[^=]/` — dot OR bracket assignment, excluding `==`
- `/_idempotencyManagedByHandler\b/` — any read of the legacy flag

**When to apply:** any lockdown test that pins **absence** of a code shape after a substantive removal. NOT needed for lockdowns that pin **presence** (e.g., `expect(src).toMatch(/SAVEPOINT idempotency_reserve/)`) — presence pins don't false-positive on comments because the comment ALSO matches the desired pattern.

**Canonical proof-points:** PR #47 PR-E r2 (Codex MEDIUM closure on regex bypassability); PR #48 cleanup-sweep extending the lockdown to pin `markIdempotencyManagedByHandler` identifier absence (relies on the same comment-stripping helper).

### §5.12 Asymptotic-convergence expectation on cross-cutting concurrency changes (Sprint 33-34 cumulative pattern)

**Rule:** when a sub-story touches cross-cutting concurrency / atomicity / multi-handler contracts, expect **asymptotic Codex review convergence** — each round closes some HIGHs but typically reveals 1-2 subtler ones in the same area. Plan budget for 4-5 rounds per such PR. Do NOT trigger §5.1 (5+ rounds = pause) on the first 4 rounds when the iteration shape is "found new HIGH each round, fixed it, surfaced the next one". Trigger §5.1 only when rounds stop closing findings AND start oscillating between fixes that contradict each other.

**Why:** the SI-006 cycle PRs converged like this:
- PR #43 PR-F1: r1 → r4 (4 rounds, 3 HIGH closures) — TTL bypass → legacy-onSend gap → reservation-lock TTL conflict
- PR #44 PR-F2: r1 → r5 (5 rounds, 4 HIGH/1 MEDIUM) — crisis audit rolled back → sentinel-throw replay → cached-envelope shape → audit-dedupe-deferred-HIGH (closed in #49)
- PR #45 PR-F3: r1 → r5 (5 rounds, 2 HIGH/3 MEDIUM) — token-cache TTL gate → PHONE_TAKEN unmapped → aborted-tx poison → sessionRefresh cache → upgrade-path replay
- PR #51 r1 → r4 (4 rounds, 4 MEDIUM) — assertion-strength + PHI-leak helper-coverage + event_type pinning + CI-revealed handler bug

Each round was productive: a real new finding closed, not the same finding re-litigated. The pattern matches the v1.10.1 hygiene cycle's 12-round asymptote (~95 findings closed) and the Sprint 25 retro § §5.7 shared-root-cause cluster discipline.

**How to recognize it (vs §5.1 trigger):**
- ✅ asymptotic-convergence pattern: each round closes a finding distinct from prior rounds; cumulative findings increase monotonically; the area-under-review is genuinely cross-cutting (touches multiple atomicity contracts, concurrency boundaries, or shared invariants).
- ❌ §5.1 trigger pattern: rounds 4+ surface findings that contradict prior fixes; a round's fix opens a finding the previous round's fix had closed; or the same finding-class re-appears in a new spelling.

**Test for "cross-cutting":** does the change touch (a) `withIdempotency` / `withIdempotentExecution` / cache semantics, OR (b) audit-emission paths that cross transactions, OR (c) multi-handler shared invariants (RLS + KMS + tenant context), OR (d) state-machine guards that can fire from multiple slices? If yes, use the asymptotic budget. If no, use the standard §5.1 cap.

**Mitigation: per-PR Codex review, not just final-PR review.** Run `codex-companion adversarial-review --base main` on each substantive iteration of the PR, not only at sprint exit. Each iteration's review surfaces 1-2 findings; closing them in-PR keeps the trajectory linear instead of accumulating into a single intractable batch.

**Canonical proof-points:** Sprint 33-34 cumulative — 18 substantive findings closed across 11 PR iterations on 7 PRs. Zero §5.1 escalations. Zero contradicting fix oscillations. The pattern matched the v1.10.1 hygiene cycle's published asymptote behavior.

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
- IDEMPOTENCY v5.1 §1 (cache 4-tuple + exactly-once execution)
- AUDIT_EVENTS v5.2 §Category A (Category A audit durability requirements)
- Sprint 9 + Sprint 10 Codex closure series (async-consult-r1..r15)
- Sprint 33-34 SI-006 closure series (PRs #43-#49 + #51); see `docs/SI-006-Idempotency-Reserve-Then-Execute-Redesign.md` v0.3 Implementation Closure section

---

## Sprint reference

Authored Sprint 10 (TLC-022) on the autonomous Scrum cycle. Closes the Sprint 9 retro #4 process change deliverable (codify Sprint 9 patterns into project conventions doc). Future migrations + repos + services + state machines reference this doc rather than re-deriving the patterns per slice.

**r5 amendment (Sprint 33-34, 2026-05-08):** codifies SI-006 reserve-then-execute redesign + audit-dedupe SI patterns into §3.7 / §3.8 / §3.9 (service-layer) and §5.11 / §5.12 (review discipline). 18 substantive Codex findings closed across 11 PR iterations during the SI-006 cycle; this amendment lifts the patterns out of PR commit messages and SI-006 v0.3 closure section into reusable conventions so future cross-cutting concurrency work doesn't re-derive them.
