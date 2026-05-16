# SI-010 — Session Actor Context DB Binding (F-3 successor)

**Raised by:** Engineering (autonomous run 2026-05-15; SI-009 R5+R6 trigger)
**Date:** 2026-05-15
**Severity:** medium (does NOT block current slices; prerequisite for any future SECURITY DEFINER procedure that needs server-derived actor identity — SI-009's `record_consult_escalation_target_swap()` and SI-008's `record_workflow_pointer_swap()` both depend on this infrastructure)
**Status:** Open — awaiting spec-corpus team scoping for Identity slice extension
**Target spec doc:** new section in `Telecheck_Identity_Authentication_Spec_v1_0.md` OR a dedicated Identity-RBAC slice expansion
**Parallel SIs:** SI-008 (AiWorkflowExecution — needs this infrastructure), SI-009 (SyncSession — needs this infrastructure), SI-005 (Consult/ConsultEvent — `record_consult_clinician_decision` procedure also needs this)

---

## What this is

A successor / expansion of the originally-deferred Phase 2 F-3 (JWT session-liveness check). The 72-hr cycle's deep-integrity work (SI-008 R5/R6 + SI-009 R5/R6) identified that secure SECURITY DEFINER procedures require server-derived actor identity, NOT caller-supplied identity. That requires DB-side infrastructure that doesn't yet exist:

- A trusted DB-side actor context bound transaction-locally to each request
- Helper functions (`current_actor_account_id()`, `current_actor_role()`, etc.) that the procedures call
- authContextPlugin wiring that populates the context on every authenticated request

This SI scopes that infrastructure as its own Identity-slice deliverable.

## Why this needs to exist before SI-005/008/009 procedures land

SI-005's `record_consult_clinician_decision` + `rotate_consult_clinician_decision_kms`, SI-008's `record_workflow_pointer_swap`, and SI-009's `record_consult_escalation_target_swap` are all SECURITY DEFINER procedures that bypass RLS. Each of them needs to know:

1. **Who is the authenticated actor?** (`account_id`, `role`)
2. **What tenant does the actor's account belong to?** (`tenant_id`)
3. **For platform_admin: what is the home tenant for audit attribution?** (`admin_home_tenant_id` per F-4)
4. **Is the session live?** (session not revoked/expired since JWT issued)

Without server-derived identity, the procedures must accept these as parameters → caller can spoof → privilege escalation surface (as Codex correctly identified in SI-009 R5 HIGH).

## Placeholder design (Sprint X+1)

### `_session_actor_context` table

Mirror of the existing `_session_tenant_context` table from migration 003. Per-request actor identity binding:

```sql
CREATE TABLE _session_actor_context (
    pg_backend_pid          INTEGER     NOT NULL,
    txid                    BIGINT      NOT NULL,
    actor_account_id        VARCHAR(26) NOT NULL,
    actor_account_tenant_id TEXT        NOT NULL REFERENCES tenants(id),
    actor_role              VARCHAR(50) NOT NULL CHECK (actor_role IN (
        'patient', 'clinician', 'tenant_admin', 'platform_admin', 'delegate'
    )),
    actor_admin_home_tenant_id TEXT NULL  -- non-null only for platform_admin (F-4 attribution)
    session_id              VARCHAR(26) NOT NULL,
    nonce                   UUID        NOT NULL,
    bound_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at              TIMESTAMPTZ NOT NULL,

    PRIMARY KEY (pg_backend_pid, txid)
);
```

Pooled-connection safety: `(pg_backend_pid, txid)` composite PK means each transaction gets a UNIQUE row. SET LOCAL ALSO sets values (defense-in-depth from SI-009 R6).

### `SET LOCAL` GUCs

Set by authContextPlugin alongside the table INSERT:

```sql
SET LOCAL app.actor_account_id = '<accountId>';
SET LOCAL app.actor_account_tenant_id = '<tenantId>';
SET LOCAL app.actor_role = '<role>';
SET LOCAL app.actor_admin_home_tenant_id = '<adminHomeTenantId or empty>';
SET LOCAL app.session_id = '<sessionId>';
SET LOCAL app.request_nonce = '<uuid>';
```

`SET LOCAL` is transaction-local — cleared on COMMIT/ROLLBACK regardless of connection pooling. Prevents cross-request bleed.

### Helper functions (SECURITY DEFINER, IMMUTABLE per-tx)

```sql
CREATE OR REPLACE FUNCTION current_actor_account_id() RETURNS TEXT
LANGUAGE sql STABLE AS $$
    SELECT current_setting('app.actor_account_id', /*missing_ok=*/false);
$$;

CREATE OR REPLACE FUNCTION current_actor_account_tenant_id() RETURNS TEXT
LANGUAGE sql STABLE AS $$
    SELECT current_setting('app.actor_account_tenant_id', false);
$$;

CREATE OR REPLACE FUNCTION current_actor_role() RETURNS TEXT
LANGUAGE sql STABLE AS $$
    SELECT current_setting('app.actor_role', false);
$$;

CREATE OR REPLACE FUNCTION current_actor_admin_home_tenant_id() RETURNS TEXT
LANGUAGE sql STABLE AS $$
    SELECT NULLIF(current_setting('app.actor_admin_home_tenant_id', false), '');
$$;
```

`missing_ok=false` means `current_setting()` raises `undefined_object` if the GUC isn't set — procedures FAIL CLOSED on unauthenticated invocation.

### Nonce assertion helper (defense-in-depth from SI-009 R6)

```sql
CREATE OR REPLACE FUNCTION assert_request_nonce_bound() RETURNS BOOLEAN
LANGUAGE plpgsql STABLE AS $$
DECLARE
    v_nonce UUID;
BEGIN
    v_nonce := current_setting('app.request_nonce', false)::UUID;
    PERFORM 1 FROM _session_actor_context
     WHERE pg_backend_pid = pg_backend_pid()
       AND txid = txid_current()
       AND nonce = v_nonce;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'request_nonce_unbound'
            USING HINT = 'No _session_actor_context row matches current (pg_backend_pid, txid, nonce). Either authContextPlugin did not bind, or context was inherited from another tx/savepoint.';
    END IF;
    RETURN TRUE;
END;
$$;
```

Procedures call `assert_request_nonce_bound()` as the FIRST validation. This catches:
- Inadvertent inheritance of `SET LOCAL` values across savepoints
- Autonomous-transaction calls without explicit context establishment
- Missing authContextPlugin invocation on a code path

### authContextPlugin wiring

The Fastify plugin's onRequest hook (after the existing JWT verify + tenant context resolution) issues the SET LOCAL statements + INSERT into `_session_actor_context` inside the request's transaction. Pseudo-code:

```typescript
fastify.addHook('onRequest', async (request, _reply) => {
  // ... existing JWT verify + tenantContext resolution ...

  if (request.actorContext === undefined) {
    return;  // unauthenticated; pre-auth endpoints don't need DB binding
  }

  const nonce = crypto.randomUUID();
  await request.db.query(`
    INSERT INTO _session_actor_context
      (pg_backend_pid, txid, actor_account_id, actor_account_tenant_id, actor_role,
       actor_admin_home_tenant_id, session_id, nonce, expires_at)
    VALUES
      (pg_backend_pid(), txid_current(), $1, $2, $3, $4, $5, $6, NOW() + INTERVAL '5 minutes');

    SET LOCAL app.actor_account_id = $1;
    SET LOCAL app.actor_account_tenant_id = $2;
    SET LOCAL app.actor_role = $3;
    SET LOCAL app.actor_admin_home_tenant_id = COALESCE($4, '');
    SET LOCAL app.session_id = $5;
    SET LOCAL app.request_nonce = $6;
  `, [
    request.actorContext.accountId,
    request.actorContext.tenantId, // actor's home tenant
    request.actorContext.role,
    request.actorContext.adminHomeTenantId,
    request.actorContext.sessionId,
    nonce,
  ]);
});
```

The `_session_actor_context` row is automatically cleaned up at transaction end (COMMIT/ROLLBACK).

## Session-liveness check (the original F-3)

The authContextPlugin's INSERT into `_session_actor_context` is the natural place to add the deferred F-3 session-liveness check: before INSERTing the context row, query the `sessions` table for the JWT's session_id and verify it's not revoked:

```typescript
const session = await request.db.query(`
  SELECT revoked_at FROM sessions
   WHERE session_id = $1 AND tenant_id = $2
   LIMIT 1
`, [request.actorContext.sessionId, request.actorContext.tenantId]);

if (session.rows.length === 0 || session.rows[0].revoked_at !== null) {
  // Session was revoked or deleted post-JWT-issuance.
  request.actorContext = undefined;  // fail closed
  return;
}
```

This closes F-3 in the same wiring change that introduces the DB-side actor context.

## Resolution path

When SI-010 closes:

1. Migration N adds `_session_actor_context` table + helper functions
2. authContextPlugin wiring sets `SET LOCAL` GUCs + inserts the context row + performs session-liveness check
3. The session-liveness check closes the Phase 2 F-3 deferred follow-on documented in PHASE_2_ADMIN_JWT_SCOPE_AND_FOLLOW_ONS.md
4. SI-008 + SI-009 stored procedures can land (each calls `current_actor_*()` helpers + `assert_request_nonce_bound()`)
5. SI-005's `record_consult_clinician_decision` + `rotate_consult_clinician_decision_kms` procedures also adopt the same helpers when they land
6. Regression test (per SI-009 R6): pooled-connection bleed test asserts request B on same connection as A reads B's context

## Cross-cutting impact

This SI is on the critical path for FIVE separate procedures across SI-005 + SI-008 + SI-009. Landing it unblocks all three SIs to move from spec → implementation.

The Identity slice's existing JWT verify path + authContextPlugin already has the actor identity in TypeScript-land; SI-010 is "merely" the DB-side propagation. Estimated scope: 1 migration + 1 plugin update + 1 regression test + 4 helper functions.

## Open questions for Identity slice author

- **Transaction boundary:** authContextPlugin currently runs in `onRequest` BEFORE the route handler opens its business transaction. If the binding INSERT happens in a separate transaction, SET LOCAL won't persist. Need to align: either authContextPlugin opens a transaction that wraps the entire request (Fastify-Postgres-typed-rolling-tx pattern) OR a different binding mechanism (e.g., advisory locks).
- **`SET LOCAL` value-type coercion:** `current_setting()` returns TEXT. UUIDs, timestamps, etc. need explicit casts at read-time. Acceptable but adds boilerplate.
- **Pre-auth endpoint behavior:** GETs to `/health`, OTP-start flows, etc. don't have an actor. Should the plugin INSERT a NULL-bound row (with sentinel `actor_role='unauthenticated'`) OR skip entirely (procedures fail closed via `current_setting(missing_ok=false)`)?
- **Multi-statement transaction across requests:** if a single transaction spans multiple `await`-suspended request handlers (unusual but possible), SET LOCAL persists. Probably fine but document the behavior.

## Spec references

- Identity & Authentication Spec v1.0 §3.3 (JWT claims)
- SI-005 Decision 8 (record_consult_clinician_decision + rotate_consult_clinician_decision_kms — DEPENDS on SI-010)
- SI-008 (record_workflow_pointer_swap — DEPENDS on SI-010)
- SI-009 (record_consult_escalation_target_swap — DEPENDS on SI-010)
- Phase 2 F-3 deferred follow-on (PHASE_2_ADMIN_JWT_SCOPE_AND_FOLLOW_ONS.md)
- migration 003 (`_session_tenant_context` precedent pattern)
- F-4 R5 (admin home tenant attribution; this SI's actor context propagates it)

## Status

- **Filed:** 2026-05-15 (autonomous run; SI-009 R5+R6 trigger)
- **Target Promotion Ledger entry:** P-020
- **Closes:** Phase 2 F-3 (JWT session-liveness) — by virtue of the authContextPlugin wiring change
- **Unblocks:** SI-005 (stored procedures), SI-008 (pointer-swap procedure), SI-009 (escalation-swap procedure)
