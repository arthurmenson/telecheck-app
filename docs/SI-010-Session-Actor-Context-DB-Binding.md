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

### `_session_actor_context` table — TEMPORARY with ON COMMIT DELETE ROWS (R1 HIGH closure 2026-05-15)

R1 HIGH correctly identified that a normal permanent table keyed by `(pg_backend_pid, txid)` would NOT be auto-cleaned at transaction end. Rows would accumulate indefinitely, violating the security invariant ("transaction-local binding") and creating unbounded retention of session identity data.

The DDL must use Postgres' `TEMPORARY` + `ON COMMIT DELETE ROWS` to make the table actually transaction-scoped:

```sql
-- Created in the auth/security migration as a SESSION-LOCAL temporary
-- table with auto-truncate semantics. Each Postgres connection gets
-- its own physical instance of this table (no cross-connection
-- visibility — matches the per-pg_backend_pid security model). All
-- rows are deleted at every transaction COMMIT or ROLLBACK.
CREATE TEMPORARY TABLE IF NOT EXISTS _session_actor_context (
    pg_backend_pid          INTEGER     NOT NULL,
    txid                    BIGINT      NOT NULL,
    actor_account_id        VARCHAR(26) NOT NULL,
    actor_account_tenant_id TEXT        NOT NULL,  -- no cross-schema FK on a temp table
    actor_role              VARCHAR(50) NOT NULL CHECK (actor_role IN (
        'patient', 'clinician', 'tenant_admin', 'platform_admin', 'delegate'
    )),
    actor_admin_home_tenant_id TEXT NULL,  -- non-null only for platform_admin (F-4 attribution)
    session_id              VARCHAR(26) NOT NULL,
    nonce                   UUID        NOT NULL,
    bound_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at              TIMESTAMPTZ NOT NULL,

    PRIMARY KEY (pg_backend_pid, txid)
)
ON COMMIT DELETE ROWS;  -- R1 HIGH closure: rows auto-deleted at every COMMIT/ROLLBACK
```

**Implications of TEMPORARY + ON COMMIT DELETE ROWS:**

- **Connection-scoped, not global:** the table exists in `pg_temp_<N>` schema for each Postgres backend. Connection pooling reuses backends, so the table persists across requests on the same backend BUT the rows are wiped at every transaction boundary.
- **Bootstrap-on-first-use:** the `CREATE TEMPORARY TABLE IF NOT EXISTS` runs at the start of every Postgres session (on connection check-out from pool). For pgbouncer-style transaction-pooling, this MUST run as the first statement of every transaction on a fresh-checkout backend. authContextPlugin's pre-INSERT path is responsible.
- **No cross-tenant FK:** Postgres forbids FK from temp tables to permanent tables; the `tenants(id)` FK is replaced by the application-layer guarantee that `actor_account_tenant_id` was sourced from a JWT verified against `KNOWN_TENANT_IDS` (per F-2).
- **Pooled-connection safety preserved:** even though the temp table is connection-scoped, the `ON COMMIT DELETE ROWS` guarantees that request A's row is wiped before request B can run. The `(pg_backend_pid, txid)` PK is now redundant for cross-request safety (the row never coexists with another's data) but is preserved for defense-in-depth + nonce-assertion semantics.

**Updated nonce assertion (uses `expires_at` per R1 HIGH closure):**

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
       AND nonce = v_nonce
       AND expires_at > NOW();  -- R1 closure: expiry enforced (defense in depth even with ON COMMIT DELETE ROWS)
    IF NOT FOUND THEN
        RAISE EXCEPTION 'request_nonce_unbound_or_expired'
            USING HINT = 'No live _session_actor_context row matches current (pg_backend_pid, txid, nonce). Context not bound, expired, or inherited from another tx/savepoint.';
    END IF;
    RETURN TRUE;
END;
$$;
```

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

### Helper functions — self-authenticating from `_session_actor_context` (R3 HIGH closure 2026-05-15)

R3 HIGH correctly identified that helpers returning `current_setting('app.*')` directly trust caller-settable GUCs. A procedure that forgets to call `assert_request_nonce_bound()` first would allow an attacker to spoof actor identity by setting their own `app.*` GUCs. The trust invariant must be inside the helper, not a caller convention.

The helpers read DIRECTLY from `_session_actor_context` keyed by `(pg_backend_pid(), txid_current(), current_setting('app.request_nonce'))`. The temp table is `ON COMMIT DELETE ROWS` so only the current transaction's authContextPlugin-inserted row is visible. A caller cannot fake a row in `_session_actor_context` because the temp table is `pg_temp_<N>` schema-scoped + `(pg_backend_pid, txid)` PK + `ON COMMIT DELETE ROWS`.

```sql
-- Internal helper — fetches the single live actor-context row for
-- the current backend + transaction + supplied nonce. Returns
-- (account_id, account_tenant_id, role, admin_home_tenant_id) or
-- raises 'actor_context_unbound' if no live row matches.
CREATE OR REPLACE FUNCTION _current_actor_context_row()
RETURNS TABLE (
    account_id              TEXT,
    account_tenant_id       TEXT,
    role                    TEXT,
    admin_home_tenant_id    TEXT
)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    v_nonce UUID;
BEGIN
    v_nonce := current_setting('app.request_nonce', /*missing_ok=*/false)::UUID;
    RETURN QUERY
    SELECT s.actor_account_id, s.actor_account_tenant_id, s.actor_role, s.actor_admin_home_tenant_id
      FROM _session_actor_context s
     WHERE s.pg_backend_pid = pg_backend_pid()
       AND s.txid = txid_current()
       AND s.nonce = v_nonce
       AND s.expires_at > NOW();
    IF NOT FOUND THEN
        RAISE EXCEPTION 'actor_context_unbound'
            USING HINT = 'No live _session_actor_context row matches current (pg_backend_pid, txid, nonce). Either authContextPlugin did not bind, context expired, or the request_nonce GUC was supplied without a corresponding table row.';
    END IF;
END;
$$;

-- Public helpers — each is a one-liner that reads from the trusted
-- row. They CANNOT be spoofed by caller-set GUCs because the row's
-- existence is the trust anchor, not the GUC values.
CREATE OR REPLACE FUNCTION current_actor_account_id() RETURNS TEXT
LANGUAGE sql STABLE AS $$
    SELECT account_id FROM _current_actor_context_row();
$$;

CREATE OR REPLACE FUNCTION current_actor_account_tenant_id() RETURNS TEXT
LANGUAGE sql STABLE AS $$
    SELECT account_tenant_id FROM _current_actor_context_row();
$$;

CREATE OR REPLACE FUNCTION current_actor_role() RETURNS TEXT
LANGUAGE sql STABLE AS $$
    SELECT role FROM _current_actor_context_row();
$$;

CREATE OR REPLACE FUNCTION current_actor_admin_home_tenant_id() RETURNS TEXT
LANGUAGE sql STABLE AS $$
    SELECT NULLIF(admin_home_tenant_id, '') FROM _current_actor_context_row();
$$;
```

**Trust anchor:** the `_session_actor_context` row IS the trust anchor. `SET LOCAL` GUCs are still set by authContextPlugin (for compatibility with the `current_tenant_id()` pattern + future tooling that inspects them), but the helpers IGNORE the GUC VALUES and trust ONLY the temp-table row. The only GUC the helpers consume is `app.request_nonce`, and that value MUST match a row in the temp table — which an attacker cannot fabricate (temp table is in `pg_temp_<N>` schema; attacker cannot INSERT into another backend's temp schema).

**Caller-set GUC defense:** even if an attacker sets `app.actor_account_id = 'spoofed'`, the helpers will not return it. The helpers query the table; the table row was inserted ONLY by authContextPlugin's authenticated path. The `app.request_nonce` value the attacker presents must correspond to a real row in the current transaction's temp table — which only authContextPlugin can create.

### Nonce assertion helper

The R1-closure definition above (with `expires_at > NOW()` predicate) is the canonical version. R2 HIGH closure 2026-05-15: removed an obsolete duplicate definition that would have overwritten the expiry-enforcing version if implementers applied snippets in document order. Procedures call `assert_request_nonce_bound()` as the FIRST validation. This catches:
- Inadvertent inheritance of `SET LOCAL` values across savepoints
- Autonomous-transaction calls without explicit context establishment
- Missing authContextPlugin invocation on a code path
- Stale context that outlives its 5-minute expiry (e.g., long-running transaction)

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

## Session-liveness check + fail-closed request termination (R3 HIGH-2 closure 2026-05-15)

R3 HIGH-2 correctly identified that the original snippet's `return;` from the Fastify `onRequest` hook does NOT abort the request — Fastify continues to the route handler with `request.actorContext = undefined`. Downstream guards (`requireActorContext`, `requireAdminRole`) would each have to fail closed; if any handler reaches business logic without explicit gating, a revoked-session request leaks through.

**Canonical fail-closed ordering:**

```typescript
fastify.addHook('onRequest', async (request, reply) => {
  // ... existing JWT verify + tenantContext resolution (gives request.actorContext) ...

  if (request.actorContext === undefined) {
    return;  // pre-auth endpoint; no DB binding needed; downstream guards 401 if they need auth
  }

  // STEP 1: Session-liveness check BEFORE any binding work
  const session = await request.db.query(`
    SELECT revoked_at, expires_at FROM sessions
     WHERE session_id = $1 AND tenant_id = $2
     LIMIT 1
  `, [request.actorContext.sessionId, request.actorContext.tenantId]);

  const revoked =
    session.rows.length === 0 ||
    session.rows[0].revoked_at !== null ||
    new Date(session.rows[0].expires_at).getTime() <= Date.now();

  if (revoked) {
    // FAIL CLOSED: throw to terminate the request. The error-envelope
    // plugin maps UnauthenticatedError to a tenant-blind 401 per I-025.
    request.actorContext = undefined;
    throw new UnauthenticatedError();  // terminates request; rolls back tx
  }

  // STEP 2: Bootstrap temp table on this backend (idempotent)
  await request.db.query(`
    CREATE TEMPORARY TABLE IF NOT EXISTS _session_actor_context (...)
      ON COMMIT DELETE ROWS;
  `);

  // STEP 3: SET LOCAL GUCs + INSERT context row
  const nonce = crypto.randomUUID();
  await request.db.query(`
    INSERT INTO _session_actor_context (...) VALUES (...);
    SET LOCAL app.actor_account_id = ...;
    ...
    SET LOCAL app.request_nonce = $nonce;
  `, [...]);
});
```

**Key invariants (R3 HIGH-2 closure):**
- Session-liveness check runs BEFORE any binding work.
- Revoked / missing / expired session → `throw UnauthenticatedError()`, which Fastify's error-envelope plugin maps to a 401 + rolls back the request transaction. The request DOES NOT proceed to the route handler.
- Binding work (temp-table bootstrap + INSERT + SET LOCAL) only runs after session-liveness passes. If the route handler later invokes a SECURITY DEFINER procedure, the temp-table row is present + nonce-validated.
- Pre-auth endpoints (`/health`, OTP-start, etc.) skip the entire path — they neither check sessions nor bind context.

**Regression test:** issue a JWT, revoke the session via `revokeSession()`, send a request with the now-orphaned JWT, assert 401 response + assert no `_session_actor_context` row exists post-rollback.

This closes Phase 2 F-3 (JWT session-liveness check) by virtue of the authContextPlugin wiring change.

## Resolution path (R2 HIGH-2 closure)

R2 HIGH-2 correctly identified that a migration that creates a TEMPORARY table won't provision it on the application's pool connections — temp tables are session-local and disappear when the migration's connection ends. The resolution path is amended:

When SI-010 closes:

1. **Migration N adds ONLY permanent objects:** the helper functions (`current_actor_account_id()`, `current_actor_account_tenant_id()`, `current_actor_role()`, `current_actor_admin_home_tenant_id()`, `assert_request_nonce_bound()`) + GRANT statements. **Migration N does NOT create `_session_actor_context`** — temp tables aren't installable via migration.
2. **authContextPlugin runs the temp-table bootstrap as the first statement of every authenticated request:**
   ```typescript
   await request.db.query(`
     CREATE TEMPORARY TABLE IF NOT EXISTS _session_actor_context (...)
       ON COMMIT DELETE ROWS;
   `);
   ```
   Postgres treats `CREATE TEMPORARY TABLE IF NOT EXISTS` as idempotent — if the table already exists in the current backend's `pg_temp_<N>` schema (from a prior request on the same checked-out connection), the statement is a no-op. Cheap to run on every request; required correctness for pgbouncer transaction-pooling where a backend may have been freshly assigned.
3. **authContextPlugin then sets `SET LOCAL` GUCs + INSERTs the context row + performs session-liveness check** (closes Phase 2 F-3).
4. SI-008 + SI-009 stored procedures can land (each calls `current_actor_*()` helpers + `assert_request_nonce_bound()`).
5. SI-005's `record_consult_clinician_decision` + `rotate_consult_clinician_decision_kms` procedures also adopt the same helpers.
6. **Regression tests required:**
   - Fresh pooled-connection test: assert a brand-new backend checkout succeeds (temp table created on demand)
   - Pooled-connection bleed test (per SI-009 R6): request B on same connection as A reads B's context (not A's)
   - Expired-context test: bind, sleep past expiry, attempt procedure invocation → `request_nonce_unbound_or_expired` rejection
   - Migration-deploy test: assert helper functions exist post-migration; `_session_actor_context` does NOT exist as a permanent table

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
