# SI-006 — Idempotency Reserve-Then-Execute Redesign

**Filed:** 2026-05-06 (Sprint 27 / TLC-046)
**Filer:** Autonomous-arc Claude session
**Filed under:** EHBG §12 SI/DSI (Spec Issue / Design Spec Issue) escalation
**Severity:** ARCHITECTURAL LIMITATION — blocking before any slice with patient-visible state mutation (Sprint 30 corrected scope; see "Severity / blocking conditions" below)
**Owner:** Engineering Lead (per EHBG §12 default ownership for SI/DSI)
**Revision history:**
- v0.1 (2026-05-06, Sprint 27 / TLC-046): initial filing
- **v0.2 (2026-05-06, Sprint 30 corrections):** three corrections per Agent X / Codex Sprint 30 SME advisory:
  1. Removed false claim that `processing_state` column "needs verification" — the column already exists in `migrations/005_idempotency_keys.sql:77-84` with the correct CHECK constraint
  2. Filled in the duplicate-key handling pseudocode that v0.1 glossed over (Postgres aborted-tx semantics + recommended approach)
  3. Reframed the gate: the redesign is BLOCKING before any patient-visible state-mutating slice (not just Pharmacy); Async-Consult and Consent already past that line

---

## Summary

The current `src/lib/idempotency.ts` v0 implementation uses a **preHandler-lookup + onSend-cache-write** split that is **NOT transactionally-safe**. Two concurrent requests with the same 4-tuple idempotency key (`tenant_id`, `key`, `endpoint`, `actor_id`) both pass the preHandler lookup (no record yet), both execute the business action, both attempt the onSend INSERT — `ON CONFLICT DO NOTHING` ensures only one wins the cache, but **BOTH already committed business state**. For state-changing endpoints, this is **duplicate execution** — not the exactly-once guarantee IDEMPOTENCY v5.1 §1 requires.

The proper fix is **reserve-then-execute** (run the idempotency state machine *inside* the business transaction). This is a **slice-implementation concern** — not a plugin concern — because it requires the request handler to drive the transaction, not a Fastify hook bracketing it.

This SI/DSI files the design escalation per EHBG §12 + the documented ARCHITECTURAL LIMITATION comment block in `src/lib/idempotency.ts:297-326`.

---

## Background

### v0 implementation (current; landed Sprint 17, hardened through Sprint 26)

```
┌─ preHandler ──────────────────────────────────────────────┐
│   1. Read idempotency-key from request header             │
│   2. Look up cache by 4-tuple PK                          │
│   3a. If hit: replay cached response (handler short-circuit) │
│   3b. If miss: stash context on request; let handler run  │
└────────────────────────────────────────────────────────────┘
                           │
                  Handler runs business logic
                  (typically opens its own DB transaction,
                   commits, returns response)
                           │
┌─ onSend ───────────────────────────────────────────────────┐
│   1. Read context from request                            │
│   2. INSERT idempotency_keys ON CONFLICT DO NOTHING       │
│      (so race losers' INSERTs are silently dropped)       │
└────────────────────────────────────────────────────────────┘
```

**Race window:** between preHandler step 2 (lookup miss) and onSend step 2 (INSERT). Two concurrent requests with same 4-tuple key both:
1. Pass the lookup (no record exists)
2. Run the handler in parallel (both commit business state)
3. Race on the INSERT (first wins; second's INSERT is no-op)

**Net effect:** business action executed twice; idempotency cache only has one record.

### Sprint 22 + 24 + 26 hardening

Sprint 22 (TLC-040 §3b + TLC-041) closed test-side gaps where state-changing tests didn't include `Idempotency-Key` headers. Sprint 24 (TLC-045) closed the Fastify lifecycle issue where onSend hook throws poisoned the response pipeline. Sprint 26 (TLC-048) closed the JWT actor scoping issue where authenticated requests collapsed to `actor_id='anonymous'`. These fixes hardened the v0 contract surface but did NOT close the underlying race window — by design, those were narrow stop-gaps within the v0 limitation.

---

## The proper design — reserve-then-execute

### Mechanics

```
┌─ Inside business transaction (handler-driven) ──────────┐
│                                                          │
│   1. INSERT idempotency_keys (4-tuple PK,                │
│      processing_state='pending') as the FIRST statement  │
│                                                          │
│      - UNIQUE constraint on PK serializes concurrent     │
│        same-key requests; second one gets duplicate-key  │
│        error                                             │
│      - On duplicate-key: lookup existing row;            │
│         - If processing_state='pending': 409 (concurrent │
│           in-flight; client should retry)                │
│         - If processing_state='completed': replay cached │
│           response                                       │
│                                                          │
│   2. Run business logic                                  │
│                                                          │
│   3. UPDATE idempotency_keys SET                         │
│        processing_state='completed',                     │
│        response_status = $X,                             │
│        response_body = $Y                                │
│      as the LAST statement before COMMIT                 │
│                                                          │
│   4. COMMIT.                                              │
│                                                          │
│      - If anything fails: ROLLBACK removes BOTH the     │
│        idempotency reservation AND the business state — │
│        clean retry possible                              │
└──────────────────────────────────────────────────────────┘
```

### Why this is correct

- **Reservation INSERT is the serialization point.** The UNIQUE constraint is the lock; concurrent same-key requests cannot both reserve.
- **Business logic + cache-write are atomic.** Either both succeed or both roll back.
- **Failed requests don't poison the cache.** A handler exception → ROLLBACK → reservation gone → next request retries cleanly.
- **Concurrent same-key requests get a deterministic outcome.** Either replay (if first completed) or 409 (if first in-flight).

---

## Implementation hand-off

### Surface area affected

- **`src/lib/idempotency.ts`:** the v0 plugin's preHandler + onSend hooks must be removed or repurposed. The plugin should still parse the header, validate format, and short-circuit on cache replay (read-only); but the cache WRITE must move into handlers.
- **Each state-changing handler:** must wrap business logic in a transaction that:
  1. INSERTs into `idempotency_keys` with `processing_state='pending'` as first statement
  2. Handles duplicate-key (4-tuple unique) outcome: lookup existing → either replay (completed) or 409 (pending). See "Duplicate-key handling" below for the Postgres semantics that the naive INSERT-then-catch pattern fails on.
  3. Runs business logic
  4. UPDATEs `idempotency_keys` to `processing_state='completed'` as last statement before COMMIT
- **`migrations/`:** the `processing_state` column already exists in `migrations/005_idempotency_keys.sql:77-84` with `CHECK (processing_state IN ('pending', 'completed'))` and `DEFAULT 'pending'`. No schema migration required for the redesign. (v0.1 of this doc incorrectly listed this as needing verification; corrected in v0.2.)

### Duplicate-key handling (Sprint 30 / v0.2 expansion)

The naive shape — `try { INSERT } catch (e) { if e.code === '23505' { SELECT existing } }` — does NOT work in Postgres. When an INSERT raises `unique_violation`, the surrounding transaction enters an **aborted state** in which subsequent statements (including the SELECT meant to fetch the existing row) fail with `current transaction is aborted, commands ignored until end of transaction block`. This is documented Postgres behavior; `tests/setup.ts:397-411` already encounters and handles the same condition for unrelated reasons.

**Recommended approach (use this):**

```sql
-- Single statement; no aborted-tx hazard:
INSERT INTO idempotency_keys (tenant_id, key, endpoint, actor_id, request_hash, processing_state)
VALUES ($1, $2, $3, $4, decode($5, 'hex'), 'pending')
ON CONFLICT (tenant_id, key, endpoint, actor_id) DO NOTHING
RETURNING tenant_id;
```

If `RETURNING` produces a row → INSERT succeeded → run business logic, then UPDATE `processing_state='completed'`.
If `RETURNING` produces zero rows → conflict (existing record) → SELECT it in a fresh statement (no aborted tx because the INSERT did not raise; `ON CONFLICT DO NOTHING` is silent):

```sql
SELECT processing_state, response_status, response_body
FROM idempotency_keys
WHERE tenant_id = $1 AND key = $2 AND endpoint = $3 AND actor_id = $4;
```

If `processing_state='pending'` → 409 (concurrent in-flight request).
If `processing_state='completed'` → replay cached response.

**Alternative approach (use only if specific need):** wrap the INSERT in a `SAVEPOINT` so the duplicate-key throw is contained and can be caught + recovered. More complex; only justified if you need branch-specific behavior on the conflict (e.g., different error response for body-mismatch vs in-flight).

**Approach NOT recommended for PHI/audit paths:** the `INSERT ... ON CONFLICT (...) DO UPDATE ... RETURNING xmax = 0 AS inserted` "xmax trick" — while clever (`xmax=0` distinguishes inserted vs updated rows), it triggers UPDATE semantics and can interact with row-level triggers in surprising ways. Sprint 30 cross-family review (Codex) flagged this as an anti-pattern in audit-sensitive contexts. Avoid.

**Hard rule for handlers:** if `withIdempotency` throws (handler logic raised an exception that propagated), the surrounding transaction MUST roll back. The handler MUST NOT catch-and-commit after withIdempotency throws — that would leave the `processing_state='pending'` reservation orphaned and block all future requests with the same idempotency key for the 24h TTL window.

### Testing strategy

- **Lockdown test:** assert that `src/lib/idempotency.ts` does NOT have an `addHook('onSend', ...)` cache write after the redesign lands. Pin per §5.4 lockdown discipline.
- **Concurrent-write integration test:** simulate 2 concurrent requests with same 4-tuple key (vitest can spawn promises in parallel). Assert: both either replay the same response OR one gets 409 + the other commits. Never: both succeed with distinct business state.
- **Failure-rollback test:** trigger a handler exception in the middle of a state-changing request. Assert: idempotency_keys row gone after rollback; retry succeeds cleanly.

### Helper API (proposal)

v0.1 sketched a helper that returned `T | { __replay: ... }` — a discriminated-union sentinel. Sprint 30 review flagged this as fragile (every call site must type-narrow on the sentinel; easy to forget). v0.2 proposes a thrown-replay pattern that mirrors how Fastify expects errors to propagate:

```typescript
// src/lib/idempotency.ts — exposed for handler use after redesign

export class IdempotencyReplayError extends Error {
  readonly cachedStatus: number;
  readonly cachedBody: unknown;
  constructor(status: number, body: unknown) {
    super('idempotent replay');
    this.cachedStatus = status;
    this.cachedBody = body;
  }
}

export class IdempotencyInFlightError extends Error {
  constructor() { super('idempotent request in flight'); }
}

export async function withIdempotency<T>(
  client: DbClient,           // running inside business transaction
  ctx: { tenantId: string; idempotencyKey: string; endpoint: string; actorId: string; bodyHash: string },
  body: () => Promise<T>,
): Promise<T>;
// throws:
//   IdempotencyReplayError       — if existing record has processing_state='completed'
//   IdempotencyInFlightError     — if existing record has processing_state='pending'
//   <whatever body() throws>     — propagated; caller's tx should roll back
```

Handler usage:

```typescript
try {
  const result = await db.transaction(async (client) => {
    return await withIdempotency(client, ctx, async () => {
      return await consultService.abandon(...);
    });
  });
  return reply.code(200).send(toView(result));
} catch (err) {
  if (err instanceof IdempotencyReplayError) {
    return reply.code(err.cachedStatus).send(err.cachedBody);
  }
  if (err instanceof IdempotencyInFlightError) {
    return reply.code(409).send(makeErrorEnvelope(req.id, 'internal.idempotency.in_flight', 'Request in flight; retry shortly.'));
  }
  throw err;
}
```

**Carve-outs to document inline in the helper:**
- `withIdempotency` is for state-changing endpoints only. The plugin still handles GET/HEAD/OPTIONS exemption (`isExempt` at `idempotency.ts:174`); handlers wrapping their state-changing logic in `withIdempotency` don't need to re-check exempt-ness.
- The helper expects a tenant-bound DB connection (RLS context already set for the tenant). It does NOT call `withTenantBoundConnection` itself — that's the handler's responsibility (and is done by `requireTenantContext` middleware in current handlers).

---

## Severity / blocking conditions (v0.2 corrected scope)

**v0.1 framing was too generous.** v0.1 said the redesign was BLOCKING only before the Pharmacy slice, with v0 "acceptable for" rare-concurrent-retry flows. Sprint 30 cross-family review (Agent X + Codex) flagged that two slices ALREADY in the codebase have patient-visible state mutations:

- **Async-Consult** (e.g., POST /v0/consults/:id/abandon, /resume, /patient-responds — `src/modules/async-consult/internal/handlers/consults.ts`): a patient mobile-app retry could double-emit `consult_abandoned` audit events, polluting the I-003 hash chain and producing two distinct ConsultEvent rows with the same idempotency key. Not as severe as double-charging but corrupts audit-trail linearity.
- **Consent** (e.g., POST /v0/consents/grant, /revoke — `src/modules/consent/internal/handlers/consents.ts`): concurrent retries could leave consent state ambiguous (one request sees `granted`, the other sees `revoked`).

Both are past the "v0 acceptable" line. The redesign is therefore BLOCKING **before any slice with patient-visible state mutation** — which means it should land **next sprint**, not "before Pharmacy."

**v0 strictly acceptable for:** read-only / GET endpoints (idempotency middleware exempts these per `src/lib/idempotency.ts:174 isExempt`); pre-auth flows that don't mutate persistent state; endpoints whose action is itself naturally idempotent under retry (UPDATE-by-PK to a value the client already chose).

**v0 NOT acceptable for:**
- Async-Consult state transitions (already implemented; should be retrofitted in same sprint as the redesign)
- Consent grant/revoke (already implemented; same)
- Payment processing (not yet implemented; concurrent retry could double-charge)
- Pharmacy / medication-request submission (not yet implemented; concurrent retry could create duplicate orders)
- Webhook receivers from upstream systems with at-least-once delivery guarantees
- Any endpoint where the business action mutates external state (third-party API call, message queue publish, etc.)

**Blocking before:** the next state-mutating slice land OR a slice retrofit pass on Async-Consult + Consent — whichever comes first. **Recommend Sprint 31 scope.**

---

## Spec references

- IDEMPOTENCY v5.1 §1 (exactly-once execution guarantee)
- I-023 (three-layer tenant isolation — `actor_id` scoping is part of this)
- ADR-001 (modular monolith — public-interface-only access)
- EHBG §12 (SI/DSI escalation procedure)
- `src/lib/idempotency.ts:297-326` (existing ARCHITECTURAL LIMITATION comment block)

---

## Status

- **Filed:** 2026-05-06 (Sprint 27 / TLC-046)
- **Open:** awaiting Engineering Lead acceptance + slice owner assignment
- **Closure path:** when redesign lands, mark this SI as Resolved; bump IDEMPOTENCY contract from v5.1 → v5.2 (or whatever the spec authority decides) noting the implementation pattern is now reserve-then-execute.

---

## Sprint reference

Filed Sprint 27 / TLC-046 on the autonomous Scrum cycle. Closes the Sprint 26 retro priority-1 hand-off item to file the redesign SI/DSI before the autonomous arc enters next-slice work or before the first concurrent-write-sensitive slice (Pharmacy + Refill v2.1) begins.
