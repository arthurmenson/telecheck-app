/**
 * idempotency.ts — Tenant-scoped idempotency key handling.
 *
 * Purpose:
 *   Implements the IDEMPOTENCY v5.1 contract: tenant-scoped idempotency keys
 *   with 24-hour TTL, request-body hash matching, and 409 on mismatch.
 *   The same Idempotency-Key in different tenants produces independent results.
 *
 * Spec references:
 *   - IDEMPOTENCY contract v5.1:
 *       * Key format: ULID in `Idempotency-Key` header.
 *       * Cache PK: `(tenant_id, idempotency_key, endpoint, actor_id)`.
 *       * Same key + same body → replay cached response (no re-processing).
 *       * Same key + different body → 409 Conflict (body_mismatch).
 *       * TTL: 24 hours; after expiry treated as first request.
 *       * Storage: primary DB (not volatile cache) per crash semantics.
 *       * Idempotency key insertion + business logic MUST be in the same DB
 *         transaction (atomicity guarantee).
 *   - I-023 (tenant isolation): same key in different tenants is independent;
 *     cache PK includes `tenant_id`.
 *   - ERROR_MODEL v5.1: 409 uses code `internal.idempotency.body_mismatch`.
 *
 * Implementation notes:
 *   - GET and exempt endpoints (PUT /locale, PUT /notification-preferences)
 *     skip idempotency per IDEMPOTENCY v5.1 §exemptions.
 *   - The body hash uses SHA-256 of the raw request body string.
 *   - Cached response replay preserves the original HTTP status code.
 *
 * Open questions for Engineering Lead:
 *   - DB vs Redis: IDEMPOTENCY v5.1 specifies primary DB storage for crash
 *     durability. This stub uses an in-memory Map (safe for tests; NOT for
 *     production). Real implementation inserts into `idempotency_keys` table
 *     (migration 005, not yet authored) within the same DB transaction as
 *     the business logic.
 *   - Actor ID extraction: currently reads from `X-Actor-Id` header as a
 *     placeholder. The auth module (future) will populate `req.actor.id`.
 *   - Body replay: Fastify 5 does not natively buffer the response body for
 *     replay. The stub stores and replays via `reply.send()`. A real
 *     implementation may use a Fastify reply-serialization hook to capture
 *     the serialized body before sending.
 */

import crypto from 'crypto';

import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';

import { type DbClient, withTenantBoundConnection } from './db.js';

// ---------------------------------------------------------------------------
// SI-006 reserve-then-execute redesign — Sprint 32 / PR-A.
//
// Replaces the v0 onSend-cache-write pattern with a handler-driven
// reserve-then-execute helper (`withIdempotency`) that runs INSIDE the
// caller's business transaction. The plugin retains the preHandler
// cache-replay fast path for already-completed records, but the cache
// WRITE moves out of onSend (which was best-effort and not
// transactionally-safe) and into the helper, atomically with the
// business state mutation.
//
// Spec: docs/SI-006-Idempotency-Reserve-Then-Execute-Redesign.md (v0.2;
// design landed via PR #34 with cross-family Codex review).
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Error classes — thrown by withIdempotency; caught by the route handler.
// ---------------------------------------------------------------------------

/**
 * Thrown by `withIdempotency` when the 4-tuple key has an existing
 * `processing_state='completed'` record AND the request body hash matches.
 * Caller catches and replays the cached response with the cached status
 * and body. No business logic runs.
 */
export class IdempotencyReplayError extends Error {
  /** ERROR_MODEL v5.1 conceptual code; not used in HTTP response (replay
   * uses the cached statusCode directly). Kept for log clarity. */
  readonly errorCode = 'internal.idempotency.replay' as const;
  readonly cachedStatus: number;
  readonly cachedBody: unknown;
  constructor(status: number, body: unknown) {
    super('idempotent replay');
    this.name = 'IdempotencyReplayError';
    this.cachedStatus = status;
    this.cachedBody = body;
  }
}

/**
 * Thrown by `withIdempotency` when the 4-tuple key has an existing
 * `processing_state='pending'` record. A concurrent request owns the
 * reservation. Caller catches and returns 409 — client should retry
 * after a short back-off.
 */
export class IdempotencyInFlightError extends Error {
  /** ERROR_MODEL v5.1 canonical code for the 409 response. */
  readonly errorCode = 'internal.idempotency.in_flight' as const;
  readonly hint =
    'A request with this idempotency key is currently in flight. Retry after a short back-off.' as const;
  constructor() {
    super('idempotent request in flight');
    this.name = 'IdempotencyInFlightError';
  }
}

/**
 * Thrown by `withIdempotency` when the 4-tuple key has an existing record
 * (in any processing_state) AND the request body hash differs from the
 * stored body hash. Per IDEMPOTENCY v5.1 §1: same key + different body →
 * 409 Conflict.
 *
 * Note: the brief considered choosing in-flight 409 (privacy-preserving)
 * over body-mismatch 409 (more informative) for the pending-record case,
 * but body-mismatch is the correct semantic — different bodies are
 * categorically different requests regardless of the original's
 * processing state. The original's body hash was committed with the
 * reservation; honoring its identity is the v5.1 contract.
 */
export class IdempotencyBodyMismatchError extends Error {
  readonly errorCode = 'internal.idempotency.body_mismatch' as const;
  constructor() {
    super('idempotency key reused with different request body');
    this.name = 'IdempotencyBodyMismatchError';
  }
}

/**
 * Pre-computed idempotency context that the handler passes to
 * `withIdempotency`. The caller computes this BEFORE opening the
 * transaction (the request body, headers, and tenant context are
 * stable during the request lifecycle).
 */
export interface IdempotencyCtx {
  tenantId: string;
  idempotencyKey: string;
  endpoint: string;
  actorId: string;
  bodyHash: string;
}

// ---------------------------------------------------------------------------
// hashBody — exported for handler-side pre-compute (Sprint 32 / SI-006).
// ---------------------------------------------------------------------------

/**
 * SHA-256 hex of the request body string. Exported so handlers can
 * pre-compute the body hash for `IdempotencyCtx` before opening the
 * business transaction.
 */
export function hashBody(body: string): string {
  return crypto.createHash('sha256').update(body).digest('hex');
}

// ---------------------------------------------------------------------------
// resolveActorId + buildIdempotencyCtx — handler-side helpers.
// ---------------------------------------------------------------------------

/**
 * Resolve the actor_id for the idempotency 4-tuple. Same chain as
 * preHandler line 244-247 (TLC-048): JWT actorContext first, legacy
 * `x-actor-id` header second, `'anonymous'` final fallback.
 *
 * Exported so handler-side pre-compute uses the identical chain — drift
 * between the plugin's preHandler resolution and the helper's
 * resolution would cause cache misses (one connection sees actor 'X',
 * another sees 'anonymous', cache lookup fails).
 */
export function resolveActorId(request: FastifyRequest): string {
  return (
    request.actorContext?.accountId ??
    (request.headers['x-actor-id'] as string | undefined) ??
    'anonymous'
  );
}

/**
 * Mark the request as having had its idempotency caching managed by a
 * handler-side `withIdempotency` call. The plugin's onSend hook (legacy
 * v0 cache write) reads this flag and skips its own write — preventing
 * a duplicate INSERT (no-op via ON CONFLICT DO NOTHING but still a
 * wasted round-trip).
 *
 * Migrated handlers MUST call this after `withIdempotency` resolves
 * with a value. The `IdempotencyReplayError` and `IdempotencyInFlightError`
 * paths do NOT need to call this — they short-circuit via the catch
 * block, no business logic ran, and the legacy onSend would no-op
 * anyway because the request never reaches a state where its own cache
 * write would apply (the handler returns the cached/409 response without
 * setting up its own ctx).
 */
export function markIdempotencyManagedByHandler(request: FastifyRequest): void {
  // @ts-expect-error: dynamic property attachment for plugin/handler
  // communication. Read by the legacy onSend hook in this same module.
  request._idempotencyManagedByHandler = true;
}

/**
 * Build the IdempotencyCtx from the request. Helper for handlers
 * migrating to `withIdempotency`. Throws if the request is missing the
 * Idempotency-Key header (handlers should not reach this point — the
 * preHandler returns 400 earlier).
 */
export function buildIdempotencyCtx(request: FastifyRequest): IdempotencyCtx {
  const idempotencyKey = request.headers['idempotency-key'];
  if (typeof idempotencyKey !== 'string' || idempotencyKey.length === 0) {
    throw new Error(
      'buildIdempotencyCtx called without an Idempotency-Key header — preHandler should have returned 400 first',
    );
  }
  const tenantId = request.tenantContext?.tenantId ?? 'unknown';
  const actorId = resolveActorId(request);
  const endpoint = (request.url.split('?')[0] ?? '') || request.url;
  const rawBody =
    typeof request.body === 'string' ? request.body : JSON.stringify(request.body ?? '');
  return {
    tenantId,
    idempotencyKey,
    endpoint,
    actorId,
    bodyHash: hashBody(rawBody),
  };
}

// ---------------------------------------------------------------------------
// withIdempotency — reserve-then-execute helper (SI-006 PR-A).
//
// Caller invariants the helper assumes (per design brief §5):
//   1. Caller has already opened a transaction on `client` (BEGIN issued).
//   2. Caller has already set tenant context on `client` (FORCE RLS on
//      idempotency_keys requires this; absent context fails closed with
//      `tenant_context_not_set`).
//   3. Caller will COMMIT after this returns OR ROLLBACK if anything in
//      the surrounding transaction throws (including this helper's
//      thrown errors).
//
// Helper does NOT open its own transaction, set tenant context, or call
// `withTenantBoundConnection` — it operates on the caller's connection.
//
// Throw contract:
//   - IdempotencyReplayError      → caller replays cached response
//   - IdempotencyInFlightError    → caller returns 409
//   - IdempotencyBodyMismatchError → caller returns 409
//   - <body() throws>             → propagated; caller's tx rolls back
// ---------------------------------------------------------------------------

interface CachedResponse {
  statusCode: number;
  body: unknown;
  bodyHash: string;
  cachedAt: Date;
}

/**
 * Run `body()` exactly-once for the given idempotency 4-tuple, atomically
 * with the surrounding business transaction.
 *
 * Mechanics:
 *   1. Reserve: INSERT idempotency_keys (..., processing_state='pending')
 *      ON CONFLICT DO NOTHING RETURNING tenant_id.
 *   2a. If RETURNING produced a row → reservation succeeded; run body();
 *       on success, UPDATE row to processing_state='completed' with the
 *       response status + body cached. Return the body's value.
 *   2b. If RETURNING produced no rows → conflict; SELECT existing row;
 *       throw the appropriate Replay/InFlight/BodyMismatch error.
 *
 * The reserve INSERT writes `response_status=0` as a sentinel for the
 * pending state (the schema requires NOT NULL). Consumers must NEVER
 * read `response_status` without first checking `processing_state` —
 * a value of `0` in a `pending` row indicates the reservation has not
 * yet been completed.
 */
export async function withIdempotency<T>(
  client: DbClient,
  ctx: IdempotencyCtx,
  body: () => Promise<T>,
): Promise<T> {
  // -------------------------------------------------------------------------
  // 1. Reserve — INSERT ON CONFLICT DO NOTHING RETURNING.
  //
  //    ON CONFLICT DO NOTHING is comprehensive here because the table's
  //    PRIMARY KEY (tenant_id, key, endpoint, actor_id) is the only unique
  //    constraint (verified migrations/005_idempotency_keys.sql:108). No
  //    secondary unique index can raise an unhandled unique_violation that
  //    would abort the transaction.
  // -------------------------------------------------------------------------
  const insertResult = await client.query<{ tenant_id: string }>(
    `INSERT INTO idempotency_keys
       (tenant_id, key, endpoint, actor_id, request_hash,
        processing_state, response_status, response_body)
     VALUES ($1, $2, $3, $4, decode($5, 'hex'),
             'pending', 0, NULL)
     ON CONFLICT (tenant_id, key, endpoint, actor_id) DO NOTHING
     RETURNING tenant_id`,
    [ctx.tenantId, ctx.idempotencyKey, ctx.endpoint, ctx.actorId, ctx.bodyHash],
  );

  if (insertResult.rows.length > 0) {
    // -----------------------------------------------------------------------
    // Reservation succeeded. Run business logic, then complete.
    //
    // body() exceptions propagate up; the caller's transaction will
    // ROLLBACK, removing both the reservation and any business-state
    // writes — clean retry possible.
    // -----------------------------------------------------------------------
    const result = await body();

    // ---------------------------------------------------------------------
    // 3. Complete — UPDATE row to completed.
    //
    // The `processing_state='pending'` guard prevents a second concurrent
    // UPDATE from corrupting the row state. Under correct discipline this
    // guard always matches (the reserving connection always completes its
    // own reservation), but the floor protects against future call-site
    // mistakes.
    //
    // Best-effort cache: we do NOT report an HTTP status here (the helper
    // doesn't have one). The caller's reply.code(...).send(...) happens
    // after this returns; the helper stores `response_status=200` as a
    // generic-success sentinel on completion. Handlers that need to cache
    // a non-200 success status (e.g., 201, 204) should pass an explicit
    // status to a future `withIdempotencyAndStatus(client, ctx, status, body)`
    // overload — out of scope for PR-A.
    //
    // Similarly, the response BODY caching here uses what body() returned.
    // Most state-changing handlers return the response payload from body(),
    // and the calling handler does `reply.send(result)`. If the handler
    // post-processes (e.g., filters PHI fields), the cache will store the
    // pre-processing shape — acceptable for v1 reserve-then-execute, but
    // worth flagging as a future enhancement.
    // ---------------------------------------------------------------------
    await client.query(
      `UPDATE idempotency_keys
          SET processing_state = 'completed',
              response_status  = 200,
              response_body    = $5::jsonb
        WHERE tenant_id   = $1
          AND key         = $2
          AND endpoint    = $3
          AND actor_id    = $4
          AND processing_state = 'pending'`,
      [
        ctx.tenantId,
        ctx.idempotencyKey,
        ctx.endpoint,
        ctx.actorId,
        result === null || result === undefined ? null : JSON.stringify(result),
      ],
    );

    return result;
  }

  // -------------------------------------------------------------------------
  // 2. Conflict — INSERT returned empty. Look up the existing row.
  //
  //    ON CONFLICT DO NOTHING is silent (no error raised), so the
  //    transaction is NOT in aborted state. We can issue a fresh SELECT
  //    against the same client.
  //
  //    Edge case: if the existing row has expired (expires_at <= NOW()),
  //    the SELECT returns zero rows. This is a narrow window between the
  //    INSERT (which conflicted on a stale row) and the SELECT. The
  //    safest fail-closed behavior is to throw IdempotencyInFlightError —
  //    the client retries with backoff and the next attempt either finds
  //    the expired row gone (cleanup job) or ages out naturally.
  // -------------------------------------------------------------------------
  const lookupResult = await client.query<{
    processing_state: 'pending' | 'completed';
    response_status: number;
    response_body: unknown;
    request_hash_hex: string;
  }>(
    `SELECT processing_state,
            response_status,
            response_body,
            encode(request_hash, 'hex') AS request_hash_hex
       FROM idempotency_keys
      WHERE tenant_id = $1
        AND key       = $2
        AND endpoint  = $3
        AND actor_id  = $4
        AND expires_at > NOW()`,
    [ctx.tenantId, ctx.idempotencyKey, ctx.endpoint, ctx.actorId],
  );

  if (lookupResult.rows.length === 0) {
    // Expired-row race; fail closed.
    throw new IdempotencyInFlightError();
  }
  const row = lookupResult.rows[0]!;

  if (row.request_hash_hex !== ctx.bodyHash) {
    // Body mismatch — different request reusing the same key.
    // Per IDEMPOTENCY v5.1 §1: 409 regardless of processing_state.
    throw new IdempotencyBodyMismatchError();
  }

  if (row.processing_state === 'pending') {
    // Concurrent request owns the reservation.
    throw new IdempotencyInFlightError();
  }

  // processing_state === 'completed' AND body hashes match → replay.
  throw new IdempotencyReplayError(row.response_status, row.response_body);
}

/**
 * Look up a cached response for the given 4-tuple key. Returns null if no
 * record exists OR the record exists but has expired (the cleanup job
 * deletes expired rows asynchronously; we treat them as absent here).
 *
 * Throws on connection / query failure — per the audit-bare-suppression
 * discipline, an idempotency lookup that silently returns null on DB error
 * could let duplicate writes through. Callers must let the error propagate
 * so the request fails closed.
 */
interface LookupResult extends CachedResponse {
  /**
   * SI-006 / Sprint 32: includes processing_state so the preHandler can
   * distinguish completed (replay candidate) from pending (concurrent
   * request in flight; pass-through, let handler's withIdempotency
   * handle the in-flight 409).
   */
  processingState: 'pending' | 'completed';
}

async function lookupIdempotencyRecord(
  tenantId: string,
  key: string,
  endpoint: string,
  actorId: string,
): Promise<LookupResult | null> {
  // Bind tenant context on the acquired connection BEFORE querying — the
  // idempotency_keys table has FORCE RLS with tenant_isolation policy
  // (migration 005), so a query without binding fails closed with
  // tenant_context_not_set. (Patch v0.3 — 2026-05-02 per Codex
  // foundation-wiring HIGH finding closure.)
  return withTenantBoundConnection(tenantId, async (client) => {
    const result = await client.query<{
      processing_state: 'pending' | 'completed';
      response_status: number;
      response_body: unknown;
      request_hash_hex: string;
      created_at: Date;
    }>(
      `SELECT processing_state,
              response_status,
              response_body,
              encode(request_hash, 'hex') AS request_hash_hex,
              created_at
         FROM idempotency_keys
        WHERE tenant_id = $1
          AND key = $2
          AND endpoint = $3
          AND actor_id = $4
          AND expires_at > NOW()`,
      [tenantId, key, endpoint, actorId],
    );

    if (result.rows.length === 0) return null;
    const row = result.rows[0];
    if (row === undefined) return null;

    return {
      statusCode: row.response_status,
      body: row.response_body,
      bodyHash: row.request_hash_hex,
      cachedAt: row.created_at,
      processingState: row.processing_state,
    };
  });
}

/**
 * Persist a cached response for the 4-tuple key. ON CONFLICT DO NOTHING
 * because two concurrent requests with the same key+endpoint+actor would
 * race the INSERT — the first wins, the second's response is dropped (its
 * caller still got the response on its own connection, this is just the
 * cache write losing).
 *
 * Sprint 32 / SI-006 PR-A status: this function and the onSend hook below
 * are PRESERVED as backward-compat for handlers not yet migrated to
 * `withIdempotency`. Once Async-Consult (PR-B) and Consent (PR-C) handlers
 * migrate, no caller writes via this path — and PR-E removes the function
 * and the onSend hook with a source-grep lockdown.
 *
 * Until then, both paths coexist: handlers using `withIdempotency` get
 * transactional reserve-then-execute; legacy handlers continue to rely on
 * the best-effort onSend cache write. preHandler replay works for both
 * (cache rows from either path read identically).
 */
async function storeIdempotencyRecord(
  tenantId: string,
  key: string,
  endpoint: string,
  actorId: string,
  bodyHash: string,
  statusCode: number,
  body: unknown,
): Promise<void> {
  // Same RLS gating as lookupIdempotencyRecord — bind tenant context
  // before INSERTing into the FORCE RLS table. (Patch v0.3 — 2026-05-02.)
  await withTenantBoundConnection(tenantId, async (client) => {
    await client.query(
      `INSERT INTO idempotency_keys (
          tenant_id, key, endpoint, actor_id,
          request_hash, response_status, response_body, processing_state
       ) VALUES ($1, $2, $3, $4, decode($5, 'hex'), $6, $7::jsonb, 'completed')
       ON CONFLICT (tenant_id, key, endpoint, actor_id) DO NOTHING`,
      [
        tenantId,
        key,
        endpoint,
        actorId,
        bodyHash,
        statusCode,
        body === null || body === undefined ? null : JSON.stringify(body),
      ],
    );
  });
}

// ---------------------------------------------------------------------------
// Exempt endpoint patterns
// ---------------------------------------------------------------------------

const EXEMPT_PATHS = new Set([
  // Per IDEMPOTENCY v5.1 §exemptions: inherently idempotent PUTs
  '/patients/:id/locale',
  '/patients/:id/notification-preferences',
  '/health',
]);

function isExempt(method: string, url: string): boolean {
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return true;
  // Normalize path for exempt check
  const normalizedPath = url.split('?')[0] ?? '';
  for (const exempt of EXEMPT_PATHS) {
    if (normalizedPath === exempt || normalizedPath.startsWith(exempt)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

export interface IdempotencyPluginOptions {
  /** Additional path prefixes to exempt from idempotency checking. */
  additionalExemptPaths?: string[];
}

const idempotencyPluginImpl: FastifyPluginAsync<IdempotencyPluginOptions> = async (
  fastify: FastifyInstance,
  opts: IdempotencyPluginOptions,
) => {
  const additionalExempt = new Set(opts.additionalExemptPaths ?? []);

  fastify.addHook('preHandler', async (request: FastifyRequest, reply: FastifyReply) => {
    const method = request.method.toUpperCase();
    const url = request.url;

    // Check exemptions
    if (isExempt(method, url)) return;
    const normalizedPath = url.split('?')[0] ?? '';
    if (additionalExempt.has(normalizedPath)) return;

    const idempotencyKey = request.headers['idempotency-key'];
    if (!idempotencyKey) {
      // No Idempotency-Key header: per v5.1, all state-changing operations require it.
      // Return 400 to signal the missing header.
      await reply.code(400).send({
        error: {
          code: 'internal.idempotency.missing_key',
          message: 'State-changing requests require an Idempotency-Key header (ULID).',
          trace_id: request.id,
          timestamp: new Date().toISOString(),
        },
      });
      return;
    }

    // Extract tenant and actor from request context
    const tenantId = request.tenantContext?.tenantId ?? 'unknown';
    // Sprint 26 / TLC-048 (Codex retrospective HIGH closure): the idempotency
    // cache key is `(tenant_id, idempotency_key, endpoint, actor_id)`. After
    // Sprint 21 migrated authenticated tests from `x-actor-id` header to JWT
    // bearer tokens, falling back to `x-actor-id` here meant ALL JWT-
    // authenticated requests bucketed as `actor_id='anonymous'`, collapsing
    // the per-actor isolation the v5.1 contract requires. Two different
    // authenticated patients in the same tenant using the same idempotency
    // key on the same endpoint would either:
    //   - Get a false 409 (different bodies → spurious body-mismatch reject)
    //   - Or replay each other's cached response (same body → cross-actor
    //     PHI exposure)
    // Both outcomes violate IDEMPOTENCY v5.1 §1 actor-scoping + I-023 tenant
    // isolation hygiene. Fix: read from request.actorContext (populated by
    // auth-context plugin on JWT verify); preserve `x-actor-id` ONLY as the
    // stub-fallback for legacy paths still using the header during migration.
    // `anonymous` remains the final fallback for pre-auth state-changing
    // endpoints (rare, but the namespace must be deterministic — we don't
    // want preHandler to throw, that's the §5.9 Fastify-idiom-mismatch
    // anti-pattern).
    const actorId =
      request.actorContext?.accountId ??
      (request.headers['x-actor-id'] as string | undefined) ??
      'anonymous';
    const endpoint = normalizedPath;

    // Look up cache against the migration 005 idempotency_keys table.
    // The DB query filters by expires_at > NOW() so expired records are
    // implicitly absent (cleanup job deletes them async).
    const existing = await lookupIdempotencyRecord(
      tenantId,
      idempotencyKey as string,
      endpoint,
      actorId,
    );

    const rawBody =
      typeof request.body === 'string' ? request.body : JSON.stringify(request.body ?? '');
    const bodyHash = hashBody(rawBody);

    if (existing !== null) {
      if (bodyHash !== existing.bodyHash) {
        // Same 4-tuple key, different body → 409 per IDEMPOTENCY v5.1.
        // Body-mismatch fires for completed AND pending records (the
        // existing row's request_hash represents the original request's
        // body regardless of processing state; different body = different
        // request).
        await reply.code(409).send({
          error: {
            code: 'internal.idempotency.body_mismatch',
            message:
              'Idempotency key already used with a different request body. ' +
              'Generate a new Idempotency-Key for a different request.',
            trace_id: request.id,
            timestamp: new Date().toISOString(),
          },
        });
        return;
      }

      // Same 4-tuple key, same body — handle by processing_state:
      //
      //   completed → fast-path replay from the preHandler. Handler does
      //               not run.
      //   pending   → another request owns the reservation. The
      //               preHandler runs OUTSIDE the writing transaction,
      //               so it sees `pending` only after that transaction
      //               commits (MVCC; uncommitted reservations are
      //               invisible). When this branch fires, the writing
      //               request crashed mid-execution and left a
      //               'pending' row, OR a clean concurrent request is
      //               in a brief between-completion window. Either way:
      //               pass through. The handler's `withIdempotency`
      //               will see the same 'pending' row, throw
      //               IdempotencyInFlightError, and the handler returns
      //               409 cleanly. We don't 409 from preHandler because
      //               we can't distinguish stale-pending from
      //               in-flight-pending here without a serializable
      //               read, which is more cost than benefit.
      if (existing.processingState === 'completed') {
        await reply.code(existing.statusCode).send(existing.body);
        return;
      }
      // Fall through to context stash + handler invocation.
    }

    // First request OR pending-record pass-through. Stash context on
    // the request — handlers that have NOT migrated to `withIdempotency`
    // (legacy v0 path) read this for their own cache-write needs.
    // Migrated handlers can also read it (or call buildIdempotencyCtx
    // directly).
    // @ts-expect-error: dynamic property attachment for within-request communication
    request._idempotencyKey = {
      tenantId,
      key: idempotencyKey as string,
      endpoint,
      actorId,
      bodyHash,
    };
  });

  // Sprint 32 / SI-006 PR-A status: this onSend hook is PRESERVED as
  // backward-compat. It will be REMOVED in PR-E once Async-Consult
  // (PR-B) and Consent (PR-C) handlers migrate to `withIdempotency`.
  //
  // The v0 onSend write is best-effort and not transactionally-safe;
  // PR-A introduces the safe alternative (`withIdempotency`) without
  // removing the legacy path so existing tests stay green during the
  // multi-PR migration.
  //
  // After PR-B + PR-C land, no migrated handler relies on this hook.
  // The lockdown test in PR-E pins the absence of `addHook('onSend', ...)`
  // — at that point removing this block is safe.
  fastify.addHook(
    'onSend',
    async (request: FastifyRequest, reply: FastifyReply, payload: unknown) => {
      // @ts-expect-error: dynamic property from preHandler
      const idempotencyCtx = request._idempotencyKey as
        | {
            tenantId: string;
            key: string;
            endpoint: string;
            actorId: string;
            bodyHash: string;
          }
        | undefined;

      if (!idempotencyCtx) return payload;

      // -----------------------------------------------------------------
      // Skip the legacy onSend write when the handler used
      // `withIdempotency` (handler-driven path). The handler signals
      // this by attaching `_idempotencyManagedByHandler: true` to the
      // request after a successful `withIdempotency` invocation. This
      // prevents a duplicate INSERT (which would no-op via ON CONFLICT
      // DO NOTHING anyway, but better to skip the round-trip).
      // -----------------------------------------------------------------
      // @ts-expect-error: dynamic property from migrated handlers
      if (request._idempotencyManagedByHandler === true) {
        return payload;
      }

      // Sprint 24 / TLC-045: catch + log rather than throw on cache-write
      // failure — Fastify onSend lifecycle does not tolerate throws after
      // the response headers have been written.
      try {
        await storeIdempotencyRecord(
          idempotencyCtx.tenantId,
          idempotencyCtx.key,
          idempotencyCtx.endpoint,
          idempotencyCtx.actorId,
          idempotencyCtx.bodyHash,
          reply.statusCode,
          payload,
        );
      } catch (err) {
        fastify.log.error(
          { err, tenantId: idempotencyCtx.tenantId, endpoint: idempotencyCtx.endpoint },
          'idempotency cache write failed in onSend; logging and continuing — see TLC-045',
        );
      }

      return payload;
    },
  );
};

export const idempotencyPlugin = fp(idempotencyPluginImpl, {
  name: 'idempotency',
  fastify: '5.x',
});
