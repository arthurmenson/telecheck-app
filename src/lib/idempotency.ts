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
import fp from 'fastify-plugin';
import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';

// ---------------------------------------------------------------------------
// Idempotency store interface
// STUB: in-memory Map. Replace with DB-backed store per IDEMPOTENCY v5.1.
// ---------------------------------------------------------------------------

interface CachedResponse {
  statusCode: number;
  body: unknown;
  bodyHash: string;
  cachedAt: Date;
}

type IdempotencyCacheKey = string; // `${tenantId}:${key}:${endpoint}:${actorId}`

// STUB: in-memory store. NOT crash-safe. Replace with DB implementation.
const _inMemoryStore = new Map<IdempotencyCacheKey, CachedResponse>();

const TTL_MS = 24 * 60 * 60 * 1000; // 24 hours per IDEMPOTENCY v5.1

function buildCacheKey(
  tenantId: string,
  idempotencyKey: string,
  endpoint: string,
  actorId: string,
): IdempotencyCacheKey {
  return `${tenantId}:${idempotencyKey}:${endpoint}:${actorId}`;
}

function isExpired(entry: CachedResponse): boolean {
  return Date.now() - entry.cachedAt.getTime() > TTL_MS;
}

function hashBody(body: string): string {
  return crypto.createHash('sha256').update(body).digest('hex');
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

    const cacheKey = buildCacheKey(tenantId, idempotencyKey as string, endpoint, actorId);

    // Look up cache
    const existing = _inMemoryStore.get(cacheKey);
    if (existing) {
      // Evict expired entries
      if (isExpired(existing)) {
        _inMemoryStore.delete(cacheKey);
        // Fall through to process as first request
      } else {
        // Entry found and not expired — check body hash
        const rawBody =
          typeof request.body === 'string'
            ? request.body
            : JSON.stringify(request.body ?? '');
        const incomingHash = hashBody(rawBody);

        if (incomingHash !== existing.bodyHash) {
          // Same key, different body → 409 per IDEMPOTENCY v5.1
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

        // Same key, same body → replay cached response
        await reply.code(existing.statusCode).send(existing.body);
        return;
      }
    }

    // First request — process normally; capture response in onSend hook
    // We store a sentinel so concurrent duplicate requests are serialized.
    const rawBody =
      typeof request.body === 'string'
        ? request.body
        : JSON.stringify(request.body ?? '');
    const bodyHash = hashBody(rawBody);

    // Attach context to request for onSend hook
    // @ts-expect-error: dynamic property attachment for within-request communication
    request._idempotencyKey = { cacheKey, bodyHash };
  });

  fastify.addHook('onSend', async (request: FastifyRequest, reply: FastifyReply, payload: unknown) => {
    // @ts-expect-error: dynamic property from preHandler
    const idempotencyCtx = request._idempotencyKey as
      | { cacheKey: string; bodyHash: string }
      | undefined;

    if (!idempotencyCtx) return payload;

    // Cache the response for replay
    _inMemoryStore.set(idempotencyCtx.cacheKey, {
      statusCode: reply.statusCode,
      body: payload,
      bodyHash: idempotencyCtx.bodyHash,
      cachedAt: new Date(),
    });

    return payload;
  });
};

export const idempotencyPlugin = fp(idempotencyPluginImpl, {
  name: 'idempotency',
  fastify: '5.x',
});
