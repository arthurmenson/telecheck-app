/**
 * subscription/internal/handlers/read-handlers.ts — the three subscription
 * read endpoints (OpenAPI v0.2 §20.1 / §20.2 / §20.7):
 *
 *   GET /v0/subscriptions                          — list (§20.1)
 *   GET /v0/subscriptions/:subscription_id         — get (§20.2)
 *   GET /v0/subscriptions/:subscription_id/events  — event history (§20.7)
 *
 * Caller-scope routing (resolveReaderScope): patient → self-scoped;
 * tenant_admin → tenant-wide staff read. Other roles → 403. The service
 * layer applies the scope predicate under the appropriate reader slice role
 * on top of tenant RLS.
 *
 * Composition: withTransaction → withTenantContext → <service read>
 * (the service owns the innermost withDbRole). Read-only — no audit, no
 * idempotency. 42501 → tenant-blind 403 wraps the service call (I-025;
 * covers SET LOCAL ROLE acquisition inside the service).
 *
 * Zero rows on a single-resource read → tenant-blind 404 (I-025): absent,
 * cross-tenant, and not-owned-by-this-patient are indistinguishable.
 *
 * Spec references: OpenAPI v0.2 §20.1/§20.2/§20.7, I-023/I-025,
 * migrations/075-077.
 */

import type { FastifyReply, FastifyRequest } from 'fastify';

import { withTransaction } from '../../../../lib/db.js';
import { withTenantContext } from '../../../../lib/rls.js';
import { requireTenantContext } from '../../../../lib/tenant-context.js';
import {
  getSubscription,
  listSubscriptions,
  listSubscriptionEvents,
  type ListSubscriptionsFilters,
  type ReaderScope,
  type SubscriptionEventListRow,
} from '../service.js';
import { SUBSCRIPTION_STATUSES, type SubscriptionStatus } from '../types.js';

import {
  isProductIdShape,
  isSubscriptionIdShape,
  makeErrorEnvelope,
  pgErrorCode,
  resolveReaderScope,
  toSubscriptionView,
} from './shared.js';

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

// ---------------------------------------------------------------------------
// Keyset cursor codec (opaque base64url token over { created_at, id })
// ---------------------------------------------------------------------------

function encodeCursor(createdAt: Date, id: string): string {
  return Buffer.from(JSON.stringify({ c: createdAt.toISOString(), i: id }), 'utf8').toString(
    'base64url',
  );
}

function decodeCursor(token: string): { createdAt: string; id: string } | null {
  try {
    const raw = Buffer.from(token, 'base64url').toString('utf8');
    const obj = JSON.parse(raw) as { c?: unknown; i?: unknown };
    if (
      typeof obj.c === 'string' &&
      typeof obj.i === 'string' &&
      !Number.isNaN(Date.parse(obj.c))
    ) {
      return { createdAt: obj.c, id: obj.i };
    }
    return null;
  } catch {
    return null;
  }
}

/** Run a read-only service call under tenant context, mapping 42501 → 403. */
async function runRead<T>(
  req: FastifyRequest,
  tenantId: string,
  fn: (tx: import('../../../../lib/db.js').DbTransaction) => Promise<T>,
): Promise<T> {
  return withTransaction<T>(async (tx) => {
    return withTenantContext(tx, tenantId, async () => {
      try {
        return await fn(tx);
      } catch (err) {
        if (pgErrorCode(err) === '42501') {
          throw req.server.httpErrors.forbidden('Insufficient scope for this request.');
        }
        throw err;
      }
    });
  });
}

// ---------------------------------------------------------------------------
// GET /v0/subscriptions  (§20.1 list)
// ---------------------------------------------------------------------------

interface ListQuery {
  status?: string;
  product_id?: string;
  patient_id?: string;
  limit?: string;
  cursor?: string;
}

export async function listSubscriptionsHandler(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<unknown> {
  const ctx = requireTenantContext(req);
  const scope = resolveReaderScope(req); // 401/403 via typed errors

  const query = (req.query ?? {}) as ListQuery;

  // limit — clamp to [1, MAX_LIMIT]; default DEFAULT_LIMIT.
  let limit = DEFAULT_LIMIT;
  if (query.limit !== undefined) {
    const parsed = Number(query.limit);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_LIMIT) {
      return reply
        .code(400)
        .send(
          makeErrorEnvelope(
            req.id,
            'internal.request.invalid',
            `Query parameter limit must be an integer in [1, ${MAX_LIMIT}].`,
          ),
        );
    }
    limit = parsed;
  }

  // status — must be a canonical state when present.
  if (
    query.status !== undefined &&
    !SUBSCRIPTION_STATUSES.includes(query.status as SubscriptionStatus)
  ) {
    return reply
      .code(400)
      .send(
        makeErrorEnvelope(
          req.id,
          'internal.request.invalid',
          `Query parameter status must be one of ${SUBSCRIPTION_STATUSES.join('|')}.`,
        ),
      );
  }

  // product_id — canonical shape when present.
  if (query.product_id !== undefined && !isProductIdShape(query.product_id)) {
    return reply
      .code(400)
      .send(
        makeErrorEnvelope(
          req.id,
          'internal.request.invalid',
          'Query parameter product_id must be a canonical prd_<ULID>.',
        ),
      );
  }

  // cursor — opaque token; malformed → 400.
  let cursor: { createdAt: string; id: string } | undefined;
  if (query.cursor !== undefined) {
    const decoded = decodeCursor(query.cursor);
    if (decoded === null) {
      return reply
        .code(400)
        .send(
          makeErrorEnvelope(
            req.id,
            'internal.request.invalid',
            'Query parameter cursor is malformed.',
          ),
        );
    }
    cursor = decoded;
  }

  const filters: ListSubscriptionsFilters = {
    limit,
    ...(query.status !== undefined ? { status: query.status as SubscriptionStatus } : {}),
    ...(query.product_id !== undefined ? { productId: query.product_id } : {}),
    // patient_id is a staff-only filter (§20.1); the service ignores it for
    // patient scope (self-scoped) — passing it through is safe.
    ...(query.patient_id !== undefined ? { patientId: query.patient_id } : {}),
    ...(cursor !== undefined ? { cursor } : {}),
  };

  const rows = await runRead(req, ctx.tenantId, (tx) => listSubscriptions(tx, scope, filters));

  const subscriptions = rows.map(toSubscriptionView);
  // next_cursor: only when the page was full (a further page may exist).
  const nextCursor =
    rows.length === limit
      ? encodeCursor(rows[rows.length - 1]!.created_at, rows[rows.length - 1]!.id)
      : null;

  return reply.code(200).send({ subscriptions, next_cursor: nextCursor });
}

// ---------------------------------------------------------------------------
// GET /v0/subscriptions/:subscription_id  (§20.2 get)
// ---------------------------------------------------------------------------

export async function getSubscriptionHandler(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<unknown> {
  const ctx = requireTenantContext(req);
  const scope: ReaderScope = resolveReaderScope(req);

  const params = (req.params ?? {}) as { subscription_id?: string };
  if (!isSubscriptionIdShape(params.subscription_id)) {
    return reply
      .code(400)
      .send(
        makeErrorEnvelope(
          req.id,
          'internal.request.invalid',
          'Path parameter subscription_id must be a canonical sub_<ULID>.',
        ),
      );
  }
  const subscriptionId = params.subscription_id;

  const row = await runRead(req, ctx.tenantId, (tx) => getSubscription(tx, scope, subscriptionId));
  if (row === undefined) {
    return reply
      .code(404)
      .send(makeErrorEnvelope(req.id, 'internal.resource.not_found', 'Subscription not found.'));
  }

  return reply.code(200).send(toSubscriptionView(row));
}

// ---------------------------------------------------------------------------
// GET /v0/subscriptions/:subscription_id/events  (§20.7 event history)
//
// v1.0 returns the full ordered event log for the subscription (bounded by
// the subscription lifecycle — a handful of rows). Server-side from/to/
// event_type filtering + cursor pagination are a named follow-up (module
// README); the pagination envelope is returned with has_more=false so the
// wire shape is forward-stable.
// ---------------------------------------------------------------------------

interface SubscriptionEventView {
  id: string;
  event_type: string;
  actor: { type: string; id: string | null };
  occurred_at: string;
  event_data: Record<string, unknown>;
}

function toEventView(row: SubscriptionEventListRow): SubscriptionEventView {
  return {
    id: row.id,
    event_type: row.event_type,
    actor: { type: row.actor_type, id: row.actor_id },
    occurred_at: row.occurred_at.toISOString(),
    event_data: row.event_data,
  };
}

export async function listSubscriptionEventsHandler(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<unknown> {
  const ctx = requireTenantContext(req);
  const scope: ReaderScope = resolveReaderScope(req);

  const params = (req.params ?? {}) as { subscription_id?: string };
  if (!isSubscriptionIdShape(params.subscription_id)) {
    return reply
      .code(400)
      .send(
        makeErrorEnvelope(
          req.id,
          'internal.request.invalid',
          'Path parameter subscription_id must be a canonical sub_<ULID>.',
        ),
      );
  }
  const subscriptionId = params.subscription_id;

  const events = await runRead(req, ctx.tenantId, (tx) =>
    listSubscriptionEvents(tx, scope, subscriptionId),
  );
  if (events === undefined) {
    // Parent subscription not visible to the caller → tenant-blind 404.
    return reply
      .code(404)
      .send(makeErrorEnvelope(req.id, 'internal.resource.not_found', 'Subscription not found.'));
  }

  return reply
    .code(200)
    .send({ events: events.map(toEventView), pagination: { cursor: null, has_more: false } });
}
