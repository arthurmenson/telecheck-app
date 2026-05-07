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
 *
 * SECURITY: The endpoint key prefers Fastify's matched route pattern
 * (`request.routeOptions.url`) over the raw request URL. The routed
 * pattern is the canonical invariant — Fastify has already normalized
 * case + trailing slashes during routing — so a TTL override (e.g.,
 * 900s for the auth-flow paths) cannot be bypassed by sending a path
 * variant (`/v0/identity/login/verify/`, mounted-prefix variation,
 * etc.) that would silently fall back to the 24h default and leave
 * plaintext tokens in cache for a day. Per Codex Sprint 33 PR-F1
 * adversarial review 2026-05-07 (HIGH-1).
 *
 * The fallback to `request.url` covers test harnesses that synthesize
 * requests without going through Fastify's router (no `routeOptions`);
 * route-pattern handling in production code paths is the primary
 * surface.
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
  // Prefer the matched Fastify route pattern over raw URL — see SECURITY
  // note in the doc-comment above. Falls back to URL-without-querystring
  // if route metadata is unavailable (e.g., test harness without router).
  const routedPattern = request.routeOptions?.url;
  const endpoint =
    routedPattern && routedPattern.length > 0
      ? routedPattern
      : (request.url.split('?')[0] ?? '') || request.url;
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
// Per-endpoint TTL overrides for the idempotency cache.
// ---------------------------------------------------------------------------

/**
 * Per-endpoint TTL overrides for the idempotency cache.
 *
 * Default TTL is 24h (86400s) per IDEMPOTENCY v5.1. Overrides reduce TTL
 * for endpoints whose response_body contains sensitive plaintext that
 * SHOULD NOT dwell in the cache table for 24h.
 *
 * Sprint 33 / SI-006 PR-F (security hardening per AppSec review of
 * Sprint 33 identity-handler migration). The auth-flow paths cache
 * plaintext access_token + refresh_token to satisfy the IDEMPOTENCY
 * v5.1 retry contract.
 *
 * SECURITY ALIGNMENT (post Sprint 33 AppSec gate verification 2026-05-07):
 * The cache TTL MUST be >= the JWT access_token TTL so that an
 * idempotency replay never returns a token that has already expired
 * in the JWT layer (which would surface as a confusing 401 to a
 * legitimate retry). Conversely, the cache TTL MUST be <= the JWT
 * access_token TTL plus a small grace window — caching a body whose
 * access_token has long-since expired wastes DB rows and extends the
 * plaintext-credentials-in-cache exposure window beyond the bearer
 * token's own lifetime, which is the right upper bound for the
 * sensitive material.
 *
 * The platform-floor JWT access_token TTL is 900s (15 min), defined by
 * `ACCESS_TOKEN_TTL_SECONDS` at `src/lib/jwt.ts:62` and pinned by
 * `tests/unit/jwt.test.ts:73`. We therefore align the cache TTL to
 * 900s for these auth-flow paths — exact match to the access_token
 * lifetime, no slack on either side.
 *
 * vs. 24h default: the cache exposure window for plaintext credentials
 * is reduced 96x (24h / 15min). vs. the original 5-minute draft: the
 * cache no longer expires before the JWT, so retries within the JWT
 * lifetime always replay successfully (not silently restart the OTP
 * flow). The refresh_token has its own 30-day TTL (session-service.ts);
 * its replay window is bounded by the cache row, not by the cache TTL
 * relative to refresh_token TTL, because refresh_token rotation +
 * session-revocation is enforced at the session layer.
 *
 * Adding a path to this map requires explicit AppSec review of:
 *   1. What sensitive material the response_body contains
 *   2. The TTL of any bearer token in the body (cache TTL = bearer TTL)
 *   3. Confirmation that any session-revocation path also invalidates
 *      the cached row (or accepts the cache-replay-window risk)
 */
const ENDPOINT_TTL_OVERRIDES: ReadonlyMap<string, number> = new Map([
  // 900s = JWT access_token TTL (jwt.ts:62 ACCESS_TOKEN_TTL_SECONDS).
  // Cache TTL aligned exactly to access_token lifetime so retries within
  // the token's own window replay successfully and the cache row is
  // purged the moment its bearer token would expire anyway.
  ['/v0/identity/login/verify', 900], // plaintext access_token + refresh_token in body
  ['/v0/identity/registration/verify', 900], // plaintext PatientAccountView + tokens
]);

const DEFAULT_TTL_SECONDS = 86400; // 24h per IDEMPOTENCY v5.1

function ttlSecondsForEndpoint(endpoint: string): number {
  return ENDPOINT_TTL_OVERRIDES.get(endpoint) ?? DEFAULT_TTL_SECONDS;
}

// ---------------------------------------------------------------------------
// withIdempotency — reserve-then-execute helper (SI-006 PR-A r2).
//
// PR-A r2 (Sprint 32 / Codex retro fixes 2026-05-07): API and SQL
// hardening per Codex retrospective findings on the merged PR-A
// (commit 5509bdb):
//   - HIGH-1: SAVEPOINT-based transaction-discipline check. Postgres
//     throws "SAVEPOINT can only be used in transaction blocks" if the
//     caller isn't inside an explicit BEGIN, so misuse now fails loudly
//     at the first SAVEPOINT statement instead of silently autocommitting
//     a 24h-pending blocker.
//   - HIGH-2: body() now returns `{ status, body }` — caller chooses
//     the cache-safe projected response. The cache stores the
//     post-projection shape, eliminating the I-025 / PHI leak risk
//     of caching pre-projection service results that include tenant_id
//     and other internal fields.
//   - MEDIUM-2: DELETE-purge CTE before INSERT atomically clears
//     expired rows so a stale 24h row no longer blocks a fresh
//     reservation. The previous expired-row path threw a false
//     IdempotencyInFlightError until cleanup ran.
//   - MEDIUM-Concern-10: response_status is now caller-provided
//     (resolved by the HIGH-2 API change).
//
// Caller invariants the helper still assumes:
//   1. Caller has opened a transaction on `client` (BEGIN issued).
//      r2 enforces this via SAVEPOINT — undocumented misuse is now a
//      runtime error, not a silent durability failure.
//   2. Caller has set tenant context on `client` (FORCE RLS on
//      idempotency_keys requires this; absent context fails closed via
//      `tenant_context_not_set`).
//   3. Caller will COMMIT after this returns OR ROLLBACK if the
//      surrounding transaction throws.
//
// Throw contract:
//   - IdempotencyReplayError      → caller replays cached response
//                                    (err.cachedStatus, err.cachedBody)
//   - IdempotencyInFlightError    → caller returns 409
//   - IdempotencyBodyMismatchError → caller returns 409
//   - <body() throws>             → propagated; caller's tx rolls back
//   - <SAVEPOINT throws>          → caller used non-transactional client
// ---------------------------------------------------------------------------

interface CachedResponse {
  statusCode: number;
  body: unknown;
  bodyHash: string;
  cachedAt: Date;
}

/**
 * Caller-projected cache payload returned by `body()`. The `body` field
 * is what gets cached AND replayed — handlers MUST project away any
 * fields they would normally strip before sending to the client (e.g.,
 * `tenant_id` per I-025, internal IDs, audit metadata).
 *
 * Equivalent: handlers that would normally call
 * `reply.code(status).send(toViewProjection(serviceResult))` must
 * instead return `{ status, body: toViewProjection(serviceResult) }`
 * from `body()` and then `reply.code(status).send(returnedBody)` on
 * the helper's return.
 */
export interface IdempotencyCachePayload<TBody = unknown> {
  /** HTTP status code to cache and replay (e.g., 200, 201, 204). */
  status: number;
  /** Response body to cache and replay — MUST be the post-projection
   * client-facing shape, not the raw service result. */
  body: TBody;
}

/**
 * Run `body()` exactly-once for the given idempotency 4-tuple, atomically
 * with the surrounding business transaction.
 *
 * Mechanics:
 *   0. Open SAVEPOINT — fails fast if caller isn't in a transaction.
 *   1. Reserve: WITH purged AS (DELETE expired rows), INSERT pending
 *      ON CONFLICT DO NOTHING RETURNING tenant_id.
 *   2a. If RETURNING produced a row → reservation succeeded; run body();
 *       on success, UPDATE row to processing_state='completed' with the
 *       caller-provided status + body cached. Return body()'s payload.
 *   2b. If RETURNING produced no rows → conflict on a non-expired row;
 *       SELECT existing row; throw the appropriate
 *       Replay/InFlight/BodyMismatch error.
 *
 * The reserve INSERT writes `response_status=0` as a sentinel for the
 * pending state. Consumers must check `processing_state='completed'`
 * before reading `response_status`.
 */
export async function withIdempotency<TBody>(
  client: DbClient,
  ctx: IdempotencyCtx,
  body: () => Promise<IdempotencyCachePayload<TBody>>,
): Promise<IdempotencyCachePayload<TBody>> {
  // -------------------------------------------------------------------------
  // 0. Transaction-discipline check via SAVEPOINT (PR-A r2 / HIGH-1).
  //
  //    SAVEPOINT requires an open explicit transaction. Postgres throws
  //    `25P01 no_active_sql_transaction` ("SAVEPOINT can only be used in
  //    transaction blocks") if the caller passed a non-transactional
  //    client (e.g., raw pool.connect() result without BEGIN). Loud
  //    failure beats a silent 24h pending blocker.
  //
  //    The savepoint is otherwise unused — no rollback to it on conflict
  //    (ON CONFLICT DO NOTHING doesn't abort the tx; SELECT on the
  //    next line works fine). We RELEASE it before returning. If body()
  //    throws, the caller's tx rolls back which transparently releases
  //    the savepoint as well.
  // -------------------------------------------------------------------------
  await client.query('SAVEPOINT idempotency_reserve');

  // -------------------------------------------------------------------------
  // 1. Reserve — DELETE-purge CTE + INSERT ON CONFLICT DO NOTHING.
  //
  //    The CTE atomically clears any expired row for this 4-tuple BEFORE
  //    the INSERT proceeds (PR-A r2 / MEDIUM-Concern-2). This eliminates
  //    the false-in-flight failure mode where an expired row continues
  //    to block fresh reservations until the async cleanup job runs.
  //
  //    ON CONFLICT DO NOTHING covers the table's only unique constraint
  //    (PRIMARY KEY tenant_id+key+endpoint+actor_id per
  //    migrations/005_idempotency_keys.sql:108). Conflicts ONLY on
  //    non-expired rows.
  //
  // PR-A r3 (Sprint 32 / Codex verification round on PR-D): split
  // DELETE and INSERT into TWO statements. The earlier r2 design used
  // a single statement with `WITH purged AS (DELETE ...) INSERT ...`,
  // but Postgres CTE snapshot-isolation means the modifying CTE and
  // the sub-INSERT see the SAME snapshot — the INSERT still conflicts
  // on the row the DELETE just removed (per
  // https://www.postgresql.org/docs/current/queries-with.html on data-
  // modifying CTE visibility). Runtime evidence: PR-D's Group D
  // expired-row recovery test exercised this case and got
  // IdempotencyInFlightError instead of a fresh reservation. Two
  // separate statements within the same SAVEPOINT see the DELETE's
  // effect for the subsequent INSERT.
  // -------------------------------------------------------------------------
  await client.query(
    `DELETE FROM idempotency_keys
      WHERE tenant_id = $1
        AND key       = $2
        AND endpoint  = $3
        AND actor_id  = $4
        AND expires_at <= NOW()`,
    [ctx.tenantId, ctx.idempotencyKey, ctx.endpoint, ctx.actorId],
  );

  // Per-endpoint TTL override (Sprint 33 / SI-006 PR-F security
  // hardening). Default 24h per IDEMPOTENCY v5.1; auth-flow endpoints
  // that cache plaintext credentials override to 300s (see
  // ENDPOINT_TTL_OVERRIDES). The `($6 || ' seconds')::interval` cast
  // ensures Postgres treats the integer as an interval literal —
  // equivalent to INTERVAL '300 seconds' for ttlSeconds=300. Overrides
  // the migration 005 column default (NOW() + INTERVAL '24 hours').
  const ttlSeconds = ttlSecondsForEndpoint(ctx.endpoint);

  const insertResult = await client.query<{ tenant_id: string }>(
    `INSERT INTO idempotency_keys
       (tenant_id, key, endpoint, actor_id, request_hash,
        processing_state, response_status, response_body, expires_at)
     VALUES ($1, $2, $3, $4, decode($5, 'hex'),
             'pending', 0, NULL, NOW() + ($6 || ' seconds')::interval)
     ON CONFLICT (tenant_id, key, endpoint, actor_id) DO NOTHING
     RETURNING tenant_id`,
    [ctx.tenantId, ctx.idempotencyKey, ctx.endpoint, ctx.actorId, ctx.bodyHash, ttlSeconds],
  );

  if (insertResult.rows.length > 0) {
    // -----------------------------------------------------------------------
    // Reservation succeeded. Run business logic, then complete.
    //
    // body() returns a caller-projected { status, body } payload. The
    // body is what gets stored in idempotency_keys.response_body — by
    // contract, the handler has already projected away any fields that
    // would otherwise leak (tenant_id per I-025, internal IDs, etc.).
    //
    // body() exceptions propagate up; caller's tx rolls back; reservation
    // gone; clean retry possible.
    // -----------------------------------------------------------------------
    const payload = await body();

    // ---------------------------------------------------------------------
    // Complete — UPDATE row to processing_state='completed' with the
    // caller-provided status + projected body.
    //
    // The `processing_state='pending'` guard prevents a second concurrent
    // UPDATE from corrupting the row.
    // ---------------------------------------------------------------------
    await client.query(
      `UPDATE idempotency_keys
          SET processing_state = 'completed',
              response_status  = $5,
              response_body    = $6::jsonb
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
        payload.status,
        payload.body === null || payload.body === undefined ? null : JSON.stringify(payload.body),
      ],
    );

    await client.query('RELEASE SAVEPOINT idempotency_reserve');
    return payload;
  }

  // -------------------------------------------------------------------------
  // 2. Conflict — INSERT returned empty (DELETE-purge didn't clear,
  //    meaning the existing row is non-expired).
  //
  //    Look up the existing row; throw appropriate error.
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

  // Release the savepoint on the conflict path before throwing — the
  // throw will propagate to the caller's outer tx which rolls back, but
  // RELEASE keeps the local savepoint state clean in case the caller
  // catches the error and continues without rolling back (rare, but
  // possible for handler-level error mapping).
  await client.query('RELEASE SAVEPOINT idempotency_reserve');

  if (lookupResult.rows.length === 0) {
    // Existing row was either deleted by DELETE-purge AND a concurrent
    // request slipped between purge and INSERT (extremely narrow), OR
    // the row was deleted by an external cleanup job between INSERT and
    // SELECT. Treat as in-flight; client retries.
    throw new IdempotencyInFlightError();
  }
  const row = lookupResult.rows[0]!;

  if (row.request_hash_hex !== ctx.bodyHash) {
    throw new IdempotencyBodyMismatchError();
  }

  if (row.processing_state === 'pending') {
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
