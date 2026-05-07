/**
 * idempotency-helper.test.ts — Helper-level integration tests for
 * the SI-006 reserve-then-execute helper (`src/lib/idempotency.ts`
 * `withIdempotency`).
 *
 * Sprint 32 / SI-006 PR-D. Covers the contract surface that
 * `idempotency-http.test.ts` exercises only indirectly through
 * route handlers:
 *
 *   Group A — same-body concurrent race (replay path).
 *   Group B — different-body concurrent race (body-mismatch path).
 *   Group C — rollback cleanup (failed handler → reservation gone).
 *   Group D — expired-row recovery (DELETE-purge CTE).
 *   Group E — transaction-discipline check (SAVEPOINT enforcement).
 *
 * Why integration-level (real DB):
 *   `withIdempotency` mechanics depend on Postgres semantics:
 *     - SAVEPOINT requiring an open BEGIN
 *     - INSERT ON CONFLICT DO NOTHING under tenant-bound RLS
 *     - DELETE-purge CTE atomicity for expired rows
 *     - UPDATE ... WHERE processing_state='pending' guard
 *   None of these can be exercised by a Postgres mock without
 *   reimplementing the database. Real DB integration is the only
 *   honest test surface.
 *
 * Spec references:
 *   - docs/SI-006-Idempotency-Reserve-Then-Execute-Redesign.md (v0.2)
 *   - PR-A + r2: src/lib/idempotency.ts withIdempotency
 *   - IDEMPOTENCY v5.1 §1 (exactly-once execution)
 *   - I-023 (tenant isolation)
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { type DbTransaction, withTransaction } from '../../src/lib/db.ts';
import {
  IdempotencyBodyMismatchError,
  IdempotencyInFlightError,
  IdempotencyReplayError,
  type IdempotencyCtx,
  hashBody,
  withIdempotency,
} from '../../src/lib/idempotency.ts';
import { ulid } from '../../src/lib/ulid.ts';
import { TENANT_US } from '../helpers/tenant-fixtures.ts';
import { getTestClient } from '../setup.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a fresh IdempotencyCtx for each test. Random key prevents
 * cross-test collision; tenantId/endpoint/actorId are constant per
 * test invocation but use random suffixes for safety against
 * cross-fork pollution (audit-emit's TLC-050 lesson).
 */
function freshCtx(overrides: Partial<IdempotencyCtx> = {}): IdempotencyCtx {
  const random = ulid().slice(-10);
  return {
    tenantId: TENANT_US,
    idempotencyKey: ulid(),
    endpoint: `/v0/test/idem/${random}`,
    actorId: `acct_${random}`,
    bodyHash: hashBody(JSON.stringify({ test: random })),
    ...overrides,
  };
}

/**
 * Run withIdempotency inside a transaction with tenant context set
 * — the standard caller pattern from withIdempotentExecution.
 */
async function runWithIdem<T>(
  ctx: IdempotencyCtx,
  body: () => Promise<{ status: number; body: T }>,
): Promise<{ status: number; body: T }> {
  return withTransaction(async (tx: DbTransaction) => {
    await tx.query('SELECT set_tenant_context($1)', [ctx.tenantId]);
    return await withIdempotency(tx, ctx, body);
  });
}

// ---------------------------------------------------------------------------
// Test app lifecycle (no Fastify needed; helper-level tests)
// ---------------------------------------------------------------------------

beforeAll(async () => {
  process.env['NODE_ENV'] = 'test';
});

afterAll(async () => {
  // The shared test client is closed by tests/setup.ts globalTeardown.
});

// ---------------------------------------------------------------------------
// Group A — same-body concurrent race
// ---------------------------------------------------------------------------

describe('withIdempotency — Group A: same-body concurrent race', () => {
  it('first request reserves + executes; second identical request replays cached response', async () => {
    const ctx = freshCtx();
    let executionCount = 0;
    const body = async (): Promise<{ status: number; body: { count: number } }> => {
      executionCount += 1;
      return { status: 200, body: { count: executionCount } };
    };

    // First request
    const first = await runWithIdem(ctx, body);
    expect(first.status).toBe(200);
    expect(first.body.count).toBe(1);
    expect(executionCount).toBe(1);

    // Second identical request — body() should NOT execute; replay error.
    await expect(runWithIdem(ctx, body)).rejects.toThrow(IdempotencyReplayError);
    expect(executionCount).toBe(1); // unchanged

    // Verify the thrown ReplayError carries the correct cached state.
    let caughtErr: IdempotencyReplayError | null = null;
    try {
      await runWithIdem(ctx, body);
    } catch (err) {
      if (err instanceof IdempotencyReplayError) caughtErr = err;
    }
    expect(caughtErr).not.toBeNull();
    expect(caughtErr!.cachedStatus).toBe(200);
    expect(caughtErr!.cachedBody).toEqual({ count: 1 });
  });

  it('replay carries non-200 status (e.g., 201 from POST initiate)', async () => {
    const ctx = freshCtx();
    let caughtErr: IdempotencyReplayError | null = null;

    // First request — 201
    await runWithIdem(ctx, async () => ({ status: 201, body: { id: 'created' } }));

    // Second — replay
    try {
      await runWithIdem(ctx, async () => ({ status: 201, body: { id: 'created' } }));
    } catch (err) {
      if (err instanceof IdempotencyReplayError) caughtErr = err;
    }
    expect(caughtErr).not.toBeNull();
    expect(caughtErr!.cachedStatus).toBe(201);
  });
});

// ---------------------------------------------------------------------------
// Group B — different-body concurrent race
// ---------------------------------------------------------------------------

describe('withIdempotency — Group B: different-body race', () => {
  it('same key + different body hash → IdempotencyBodyMismatchError on second', async () => {
    const baseCtx = freshCtx();
    const ctxWithBodyA = { ...baseCtx, bodyHash: hashBody('{"version":"A"}') };
    const ctxWithBodyB = { ...baseCtx, bodyHash: hashBody('{"version":"B"}') };

    // First with body A succeeds.
    await runWithIdem(ctxWithBodyA, async () => ({ status: 200, body: { won: 'A' } }));

    // Second with body B (same 4-tuple key but different body hash) → 409.
    await expect(
      runWithIdem(ctxWithBodyB, async () => ({ status: 200, body: { won: 'B' } })),
    ).rejects.toThrow(IdempotencyBodyMismatchError);
  });

  it('body-mismatch fires regardless of completed/pending state', async () => {
    // The existing row's body hash determines mismatch. With our test
    // model (sequential), the row is always 'completed' by the time
    // the second request runs, so this test confirms the completed
    // path. Pending-state body-mismatch would require a multi-fork
    // setup that we cover elsewhere via the transition() handler tests.
    const baseCtx = freshCtx();
    await runWithIdem({ ...baseCtx, bodyHash: hashBody('original') }, async () => ({
      status: 201,
      body: { id: 1 },
    }));
    await expect(
      runWithIdem({ ...baseCtx, bodyHash: hashBody('changed') }, async () => ({
        status: 201,
        body: { id: 2 },
      })),
    ).rejects.toThrow(IdempotencyBodyMismatchError);
  });
});

// ---------------------------------------------------------------------------
// Group C — rollback cleanup (handler throws → reservation gone)
// ---------------------------------------------------------------------------

describe('withIdempotency — Group C: rollback cleanup', () => {
  it('body() throws → reservation rolled back; next call reserves cleanly', async () => {
    const ctx = freshCtx();

    // First call throws inside body.
    await expect(
      runWithIdem(ctx, async () => {
        throw new Error('handler exploded mid-execution');
      }),
    ).rejects.toThrow('handler exploded mid-execution');

    // Second call with the same ctx should succeed — the failed
    // reservation rolled back; the slot is free.
    const result = await runWithIdem(ctx, async () => ({
      status: 200,
      body: { ok: true },
    }));
    expect(result.body).toEqual({ ok: true });
  });

  it('successful first call commits; subsequent throwing body inside replay is unreachable', async () => {
    const ctx = freshCtx();
    await runWithIdem(ctx, async () => ({ status: 200, body: { v: 'first' } }));

    // Even if the second call's body would throw, replay short-circuits
    // before body() runs; we never reach the throw.
    let bodyExecuted = false;
    await expect(
      runWithIdem(ctx, async () => {
        bodyExecuted = true;
        throw new Error('this should never execute');
      }),
    ).rejects.toThrow(IdempotencyReplayError);
    expect(bodyExecuted).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Group D — expired-row recovery (DELETE-purge CTE)
// ---------------------------------------------------------------------------

describe('withIdempotency — Group D: expired-row recovery', () => {
  it('expired row is purged by the DELETE-purge CTE; new reservation succeeds cleanly', async () => {
    const ctx = freshCtx();
    const client = getTestClient();

    // Manually insert an expired pending row for this 4-tuple.
    // Bypass the helper to set expires_at in the past.
    await client.query('SELECT set_tenant_context($1)', [ctx.tenantId]);
    await client.query(
      `INSERT INTO idempotency_keys
         (tenant_id, key, endpoint, actor_id, request_hash,
          processing_state, response_status, response_body,
          created_at, expires_at)
       VALUES ($1, $2, $3, $4, decode($5, 'hex'),
               'pending', 0, NULL,
               NOW() - INTERVAL '48 hours', NOW() - INTERVAL '24 hours')`,
      [ctx.tenantId, ctx.idempotencyKey, ctx.endpoint, ctx.actorId, ctx.bodyHash],
    );

    // Now run withIdempotency — the DELETE-purge CTE should clear the
    // expired row, then the INSERT proceeds normally.
    const result = await runWithIdem(ctx, async () => ({
      status: 200,
      body: { fresh: true },
    }));
    expect(result.body).toEqual({ fresh: true });
  });
});

// ---------------------------------------------------------------------------
// Group E — IdempotencyInFlightError on pending row
// ---------------------------------------------------------------------------

describe('withIdempotency — Group E: pending-row in-flight detection', () => {
  it('manually-seeded pending row → IdempotencyInFlightError on subsequent call', async () => {
    const ctx = freshCtx();
    const client = getTestClient();

    // Manually insert a NON-expired pending row for this 4-tuple +
    // SAME body hash. Mirrors the case where another connection has
    // reserved but not yet completed.
    await client.query('SELECT set_tenant_context($1)', [ctx.tenantId]);
    await client.query(
      `INSERT INTO idempotency_keys
         (tenant_id, key, endpoint, actor_id, request_hash,
          processing_state, response_status, response_body,
          created_at, expires_at)
       VALUES ($1, $2, $3, $4, decode($5, 'hex'),
               'pending', 0, NULL,
               NOW(), NOW() + INTERVAL '24 hours')`,
      [ctx.tenantId, ctx.idempotencyKey, ctx.endpoint, ctx.actorId, ctx.bodyHash],
    );

    // Now call withIdempotency with the same 4-tuple. INSERT conflicts
    // (row not expired); SELECT finds it; processing_state='pending'
    // → IdempotencyInFlightError.
    let bodyExecuted = false;
    await expect(
      runWithIdem(ctx, async () => {
        bodyExecuted = true;
        return { status: 200, body: { unreachable: true } };
      }),
    ).rejects.toThrow(IdempotencyInFlightError);
    expect(bodyExecuted).toBe(false);
  });

  it('different body hash on pending row → IdempotencyBodyMismatchError (NOT in-flight)', async () => {
    const ctx = freshCtx();
    const client = getTestClient();
    const originalBodyHash = hashBody('{"original":true}');

    await client.query('SELECT set_tenant_context($1)', [ctx.tenantId]);
    await client.query(
      `INSERT INTO idempotency_keys
         (tenant_id, key, endpoint, actor_id, request_hash,
          processing_state, response_status, response_body,
          created_at, expires_at)
       VALUES ($1, $2, $3, $4, decode($5, 'hex'),
               'pending', 0, NULL,
               NOW(), NOW() + INTERVAL '24 hours')`,
      [ctx.tenantId, ctx.idempotencyKey, ctx.endpoint, ctx.actorId, originalBodyHash],
    );

    // Call with DIFFERENT body hash. Body-mismatch fires regardless
    // of processing_state per IDEMPOTENCY v5.1 §1.
    const ctxWithDifferentBody = { ...ctx, bodyHash: hashBody('{"different":true}') };
    await expect(
      runWithIdem(ctxWithDifferentBody, async () => ({
        status: 200,
        body: { unreachable: true },
      })),
    ).rejects.toThrow(IdempotencyBodyMismatchError);
  });
});

// ---------------------------------------------------------------------------
// Group F — source-grep lockdown for SAVEPOINT discipline
// ---------------------------------------------------------------------------

describe('withIdempotency — Group F: source-grep discipline lockdown', () => {
  /**
   * Read idempotency.ts once for all source-grep assertions in this
   * group. Resolves relative to the test-file directory so it works
   * under both ESM (`import.meta.dirname`) and CJS (`__dirname`)
   * test runners.
   */
  async function readIdempotencySource(): Promise<string> {
    const fs = await import('node:fs');
    const path = await import('node:path');
    return fs.readFileSync(
      path.resolve(import.meta.dirname ?? __dirname, '../../src/lib/idempotency.ts'),
      'utf8',
    );
  }

  /**
   * Strip TypeScript comments so source-grep assertions fire against
   * actual code, not the doc-comments that reference removed symbols
   * (e.g., the explanatory block in idempotency.ts that mentions
   * `addHook('onSend', ...)` in prose). Without stripping, lockdown
   * patterns produce false positives on the very comments that
   * document the removal. Hardening per Codex Sprint 33 PR-E review
   * 2026-05-07 (MEDIUM closure).
   *
   * Strips `/star ... star/` block comments and `// ...` line
   * comments (the slash-star spelling cannot be quoted literally inside
   * this very block comment without terminating it early). The
   * implementation is tolerant of multi-line block comments and
   * preserves string-literal contents (e.g., the `'onSend'` reference
   * in a comment is stripped, but a real `addHook('onSend')` call in
   * code is preserved because string-literal handling is left to the
   * regex; we don't fully parse TS, just remove comment syntax). The
   * patterns below are designed to match any reasonable spelling of
   * the regression — quoted-string property access, whitespace
   * variants, function-vs-arrow declaration forms, etc.
   */
  function stripComments(src: string): string {
    return src
      .replace(/\/\*[\s\S]*?\*\//g, '') // block comments
      .replace(/(^|[^:\\])\/\/.*$/gm, '$1'); // line comments (avoid matching inside http://, file://)
  }

  it('idempotency.ts opens SAVEPOINT idempotency_reserve as the first statement', async () => {
    // Source-grep lockdown: the SAVEPOINT-as-tx-discipline-check is the
    // mechanism that throws "SAVEPOINT can only be used in transaction
    // blocks" when a caller passes a non-transactional client. The
    // integration test setup wraps everything in a session-wide BEGIN
    // so we can't actually reach that error path at runtime. This
    // source-grep replaces what was a vacuous Group E `expect(typeof
    // withIdempotency).toBe('function')` check (PR-D r1 / Codex review
    // CHALLENGE).
    const src = await readIdempotencySource();
    expect(src).toMatch(/SAVEPOINT\s+idempotency_reserve/);
    expect(src).toMatch(/RELEASE\s+SAVEPOINT\s+idempotency_reserve/);
  });

  it('idempotency.ts has NO legacy onSend cache-write hook (PR-E lockdown)', async () => {
    // Sprint 33 / SI-006 PR-E (2026-05-07): the legacy onSend cache-
    // write hook was REMOVED once every state-changing handler migrated
    // to withIdempotency. The hook was a transactional-safety hazard —
    // it could persist a cached 200 response after the business
    // transaction rolled back, or cache a 4xx error envelope that then
    // tripped body-mismatch 409 on a legitimate corrected retry.
    //
    // The patterns below run against COMMENT-STRIPPED source so the
    // doc-comments that reference these symbols by name don't trigger
    // false positives. They're designed to catch any reasonable
    // spelling of a regression:
    //   - addHook with any whitespace + dotted/bracket/template access
    //   - storeIdempotencyRecord declared as function, async function,
    //     const-assigned-arrow, or method
    //   - _idempotencyKey assigned via dot OR bracket property access
    //   - _idempotencyManagedByHandler READ in any conditional /
    //     comparison form (=== / !== / standalone truthy check)
    //
    // Reintroducing any of these would silently re-enable the dual-
    // write path and break IDEMPOTENCY v5.1 atomicity for migrated
    // handlers. The lockdown is intentionally strict.
    const code = stripComments(await readIdempotencySource());

    // The legacy onSend hook registration in any reasonable spelling.
    // Matches: addHook('onSend', ...), addHook ("onSend"), addHook(
    //   `onSend` ), bracket-access ['addHook']('onSend'), etc. The key
    // tell is the literal 'onSend' / "onSend" / `onSend` string used
    // as Fastify's hook-name argument — there is no other reason for
    // this string to appear in idempotency.ts code.
    expect(code).not.toMatch(/['"`]onSend['"`]/);

    // The legacy storeIdempotencyRecord identifier as a declaration
    // OR a call site. Catches:
    //   async function storeIdempotencyRecord(...)
    //   function storeIdempotencyRecord(...)
    //   const storeIdempotencyRecord = async (...) => ...
    //   const storeIdempotencyRecord = function (...) ...
    //   await storeIdempotencyRecord(...)
    expect(code).not.toMatch(/\bstoreIdempotencyRecord\b/);

    // The preHandler→onSend communication stash. Catches dot AND
    // bracket property assignment:
    //   request._idempotencyKey = { ... }
    //   request['_idempotencyKey'] = { ... }
    //   request[`_idempotencyKey`] = { ... }
    expect(code).not.toMatch(/_idempotencyKey['"`\]]?\s*=[^=]/);

    // The legacy flag READ. Sprint 34 cleanup-sweep DELETED the
    // `markIdempotencyManagedByHandler` helper itself — no SET, no READ,
    // no declaration, no call site. The substring must not appear in
    // code-only source (comment-stripped) in any form. Catches:
    //   request._idempotencyManagedByHandler === true
    //   if (request._idempotencyManagedByHandler) { ... }
    //   request._idempotencyManagedByHandler ? a : b
    //   request['_idempotencyManagedByHandler']
    expect(code).not.toMatch(/_idempotencyManagedByHandler\b/);

    // Sprint 34 SI-006 cleanup-sweep: the helper FUNCTION ITSELF
    // (`markIdempotencyManagedByHandler`) was deleted from idempotency.ts
    // along with all 50+ call sites. Pin the function-name absence in
    // code-only source so any future re-introduction (export,
    // declaration, call) trips this assertion. The function name strictly
    // contains the `_idempotencyManagedByHandler` substring above, so
    // this is a stricter-and-more-specific lockdown layered on top of the
    // flag-read pin — both regexes run for defense in depth.
    expect(code).not.toMatch(/\bmarkIdempotencyManagedByHandler\b/);
  });
});
