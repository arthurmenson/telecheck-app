# SI-006 — Idempotency Reserve-Then-Execute Redesign

**Filed:** 2026-05-06 (Sprint 27 / TLC-046)
**Filer:** Autonomous-arc Claude session
**Filed under:** EHBG §12 SI/DSI (Spec Issue / Design Spec Issue) escalation
**Severity:** ARCHITECTURAL LIMITATION — non-blocking at v0; blocking before first slice with serious concurrent-write semantics
**Owner:** Engineering Lead (per EHBG §12 default ownership for SI/DSI)

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
  2. Handles duplicate-key error: lookup existing → either replay (completed) or 409 (pending)
  3. Runs business logic
  4. UPDATEs `idempotency_keys` to `processing_state='completed'` as last statement before COMMIT
- **`migrations/`:** add `processing_state` column to `idempotency_keys` if not already present (currently per migration 005 the schema uses `response_status` directly — needs verification).

### Testing strategy

- **Lockdown test:** assert that `src/lib/idempotency.ts` does NOT have an `addHook('onSend', ...)` cache write after the redesign lands. Pin per §5.4 lockdown discipline.
- **Concurrent-write integration test:** simulate 2 concurrent requests with same 4-tuple key (vitest can spawn promises in parallel). Assert: both either replay the same response OR one gets 409 + the other commits. Never: both succeed with distinct business state.
- **Failure-rollback test:** trigger a handler exception in the middle of a state-changing request. Assert: idempotency_keys row gone after rollback; retry succeeds cleanly.

### Helper API (proposal)

```typescript
// src/lib/idempotency.ts — exposed for handler use after redesign
export async function withIdempotency<T>(
  client: DbClient,                          // running inside business transaction
  ctx: { tenantId, idempotencyKey, endpoint, actorId, bodyHash },
  body: () => Promise<T>,
): Promise<T | { __replay: { statusCode: number; body: unknown } }>;
```

Handler usage:

```typescript
const result = await db.transaction(async (client) => {
  return await withIdempotency(client, ctx, async () => {
    return await consultService.abandon(...);
  });
});
if ('__replay' in result) {
  return reply.code(result.__replay.statusCode).send(result.__replay.body);
}
return reply.code(200).send(toView(result));
```

---

## Severity / blocking conditions

**v0 acceptable for:** single-request-at-a-time flows where concurrent same-key requests are rare or the business action is itself idempotent (e.g., authenticated patient creating consults — rare to have concurrent retries within 24h TTL).

**v0 NOT acceptable for:**
- Payment processing (concurrent retry could double-charge)
- Pharmacy / medication-request submission (concurrent retry could create duplicate orders)
- Webhook receivers from upstream systems with at-least-once delivery guarantees
- Any endpoint where the business action mutates external state (third-party API call, message queue publish, etc.)

**Blocking before:** first slice landing serious concurrent-write semantics. Per build sequence (EHBG §10 + ART backlog), Pharmacy + Refill v2.1 slice is the first such slice. **MUST be redesigned before Pharmacy slice lands.**

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
