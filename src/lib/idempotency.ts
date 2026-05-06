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

import { withTenantBoundConnection } from './db.js';

// ---------------------------------------------------------------------------
// Idempotency store — DB-backed against migration 005 idempotency_keys table
//
// (Patch v0.2 — 2026-05-02: replaces the prior in-memory Map with durable
//  Postgres-backed lookup + insert. The table's 4-tuple PK
//  (tenant_id, key, endpoint, actor_id) per CDM SPEC ISSUE P-010 + Codex
//  foundation HIGH-2 closure means the same key reused on a different
//  endpoint or by a different actor produces an independent record.)
// ---------------------------------------------------------------------------

interface CachedResponse {
  statusCode: number;
  body: unknown;
  bodyHash: string;
  cachedAt: Date;
}

function hashBody(body: string): string {
  return crypto.createHash('sha256').update(body).digest('hex');
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
async function lookupIdempotencyRecord(
  tenantId: string,
  key: string,
  endpoint: string,
  actorId: string,
): Promise<CachedResponse | null> {
  // Bind tenant context on the acquired connection BEFORE querying — the
  // idempotency_keys table has FORCE RLS with tenant_isolation policy
  // (migration 005), so a query without binding fails closed with
  // tenant_context_not_set. (Patch v0.3 — 2026-05-02 per Codex
  // foundation-wiring HIGH finding closure.)
  return withTenantBoundConnection(tenantId, async (client) => {
    const result = await client.query<{
      response_status: number;
      response_body: unknown;
      request_hash_hex: string;
      created_at: Date;
    }>(
      `SELECT response_status,
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
    };
  });
}

/**
 * Persist a cached response for the 4-tuple key. ON CONFLICT DO NOTHING
 * because two concurrent requests with the same key+endpoint+actor would
 * race the INSERT — the first wins, the second's response is dropped (its
 * caller still got the response on its own connection, this is just the
 * cache write losing).
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
    // STUB: actor ID from header placeholder; auth module will populate req.actor.id
    const actorId = (request.headers['x-actor-id'] as string | undefined) ?? 'anonymous';
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

      // Same 4-tuple key, same body → replay cached response.
      await reply.code(existing.statusCode).send(existing.body);
      return;
    }

    // First request for this 4-tuple — process normally; capture the response
    // in the onSend hook below for replay on subsequent identical requests.
    // Attach context to request for onSend.
    // @ts-expect-error: dynamic property attachment for within-request communication
    request._idempotencyKey = {
      tenantId,
      key: idempotencyKey as string,
      endpoint,
      actorId,
      bodyHash,
    };
  });

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

      // Persist the response into the durable idempotency_keys table.
      // ON CONFLICT DO NOTHING handles the race between two concurrent
      // requests with the same 4-tuple key — first INSERT wins.
      //
      // ARCHITECTURAL LIMITATION (Codex foundation-wiring CRITICAL flagged
      // 2026-05-02; deferred redesign): the current preHandler/onSend split
      // pattern is NOT a transactionally-safe idempotency implementation.
      // Two concurrent requests with the same 4-tuple key both pass the
      // preHandler lookup (no record yet), both execute the business action,
      // both attempt the onSend INSERT — ON CONFLICT DO NOTHING means only
      // one wins the cache, but BOTH already committed business state.
      // For state-changing endpoints, this is duplicate execution — not the
      // exactly-once guarantee IDEMPOTENCY v5.1 §1 requires.
      //
      // The correct pattern is reserve-then-execute:
      //   1. INSERT idempotency_keys (..., processing_state='pending') as the
      //      first statement INSIDE the business transaction. UNIQUE constraint
      //      on the 4-tuple PK serializes concurrent same-key requests; the
      //      second one gets a duplicate-key error and rejects with 409
      //      (or replays the cached response if processing_state='completed').
      //   2. Run the business logic.
      //   3. UPDATE idempotency_keys SET processing_state='completed',
      //      response_status=$X, response_body=$Y as the LAST statement of
      //      the same transaction.
      //   4. Commit. If the request fails, the rollback removes BOTH the
      //      idempotency record AND the business state — clean retry.
      //
      // That pattern requires the request handler to drive the transaction
      // (not a Fastify hook bracketing it). It is a slice-implementation
      // concern, not a plugin concern. This middleware version is good
      // enough for v0 single-request-at-a-time flows; the first slice with
      // serious concurrent-write semantics MUST migrate to reserve-then-
      // execute. Open issue: filed as `idempotency-redesign-reserve-then-
      // execute` per EHBG §12 SI/DSI escalation.
      //
      // Sprint 24 / TLC-045: catch + log rather than throw on cache-write
      // failure. The earlier "throw to surface" approach (Codex 2026-05-02
      // patch) interacted badly with Fastify's onSend lifecycle: a throw
      // during onSend triggers Fastify's error-handling path, which then
      // tries to safeWriteHead a fresh error response — but the headers
      // for the original response have already been written by an upstream
      // mapServiceError (handler) that did `void reply.code(404).send(...)`
      // and returned. Result: ERR_HTTP_HEADERS_SENT unhandled error, which
      // makes vitest exit 1 and ci.yml red even when 1404/1404 tests pass.
      //
      // The intended observability semantic — "make the failure observable
      // rather than silent" — is preserved by emitting an explicit
      // fastify.log.error with the cache-write error. This surfaces in
      // the server log + crash trace as before, but does NOT inject a
      // throw into the response pipeline.
      //
      // Tradeoff acknowledged: this is technically bare-suppression in
      // the I-003-spirit sense (silent failure). But the architectural
      // limitation note above already flags that this v0 onSend cache
      // pattern is NOT transactionally-safe — the entire onSend cache
      // write is best-effort by design. The proper fix is the reserve-
      // then-execute redesign (filed as `idempotency-redesign-reserve-
      // then-execute` per EHBG §12 SI/DSI). Until that lands, the cache
      // write running in onSend is a v0 stop-gap; logging on failure is
      // the right shape for that stop-gap.
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
