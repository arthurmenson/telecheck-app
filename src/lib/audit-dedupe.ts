/**
 * audit-dedupe.ts — Cross-cutting dedupe-claim helper for Category A
 * audit events emitted from idempotency-protected request paths.
 *
 * Sprint 34 / SI-006 audit-dedupe SI (2026-05-08). Closes the deferred
 * HIGH from Sprint 33 PR-F2 r4: Category A `crisis_detection_trigger`
 * audits could duplicate across a crash/DB-failure window.
 *
 * The hazard: when a Category A audit is emitted on an INDEPENDENT
 * transaction (so its durability survives the caller's business-tx
 * rollback — the I-019 / I-003 contract), a crash between the audit
 * commit and the idempotency completion UPDATE can leave the audit
 * durably committed but the idempotency reservation rolled back. A
 * client retry under the same Idempotency-Key sees no completed cache
 * row, runs the handler again, hits the same crisis-detection (or
 * other Category A trigger) path, emits a SECOND durable audit. The
 * audit table accumulates duplicate trigger records on every retry —
 * polluting compliance data + clinical alerting systems.
 *
 * The fix: a separate `audit_dedupe_markers` table (migration 022)
 * with (tenant_id, dedupe_key) PK. Callers claim a slot via
 * `claimAuditDedupeSlot` BEFORE emitting the audit. The first call
 * with a given key inserts the marker and returns true; subsequent
 * calls (e.g., from retries after the partial-failure window) hit
 * ON CONFLICT DO NOTHING and return false — caller skips the audit
 * emit.
 *
 * Why a separate table (not a column on audit_records):
 *   audit_records is hash-chained + append-only (I-003); its INSERT
 *   path runs a trigger that computes prev_hash + record_hash. Adding
 *   a dedupe column would pull the dedupe contract into the chain-
 *   management surface and complicate the trigger's reasoning. The
 *   separate marker table keeps audit_records semantics unchanged
 *   and isolates the dedupe concern.
 *
 * Marker TTL is 30 days (migration 022) — must be >= IDEMPOTENCY v5.1
 * cache TTL (24h max) so retries within the cache window always see
 * the marker. Cleanup is via background job; expired markers are
 * silently re-claimable since the originating cache row is also long
 * gone.
 *
 * KNOWN LIMITATION: if the marker INSERT commits but the subsequent
 * audit emit fails (DB error, network failure, etc.), the marker
 * stays — a retry will skip the emit, leaving the audit missing.
 * This is documented and accepted scope for this SI; if a caller
 * needs guaranteed audit emission, it should use a compensating-
 * action pattern (Sprint 35+ if it becomes a real problem).
 *
 * Spec references:
 *   - docs/SI-006-Idempotency-Reserve-Then-Execute-Redesign.md (v0.2)
 *   - migrations/022_audit_dedupe_markers.sql
 *   - IDEMPOTENCY v5.1 §1
 *   - I-003 (audit append-only)
 *   - I-019 (crisis detection durability)
 *   - AUDIT_EVENTS v5.2 §Category A
 */

import crypto from 'crypto';

import type { DbClient } from './db.js';
import { ttlSecondsForEndpoint } from './idempotency.js';

/**
 * The 6-tuple from which a dedupe key is computed.
 *
 *   tenantId          — tenant scope
 *   idempotencyKey    — client's Idempotency-Key header (ULID)
 *   endpoint          — route pattern serving the request
 *   actorId           — resolved actor for the cache 4-tuple
 *   bodyHash          — SHA-256 hex of the request body
 *   auditAction       — AUDIT_EVENTS v5.2 catalog action ID
 *
 * Matches the idempotency cache 4-tuple PLUS bodyHash + auditAction.
 *
 * Why bodyHash is part of the key (Sprint 34 audit-dedupe SI Codex
 * 2026-05-08 HIGH closure): without bodyHash, a client that
 * coincidentally reuses the same Idempotency-Key after the cache
 * expires (24h default) — but with a different request body —
 * would hit the still-live 30-day marker and have its Category A
 * audit silently SUPPRESSED. The marker would falsely match. With
 * bodyHash in the key, a different body produces a different
 * dedupe key + a fresh marker; the audit emits correctly. Defense
 * in depth on top of TTL alignment (which bounds the staleness
 * window via `ttlSecondsForAuditDedupeMarker`).
 *
 * Why auditAction is part of the key: a single request emitting
 * multiple distinct Category A audits (e.g., the patch-side and
 * merged-set crisis-gate paths in `pauseSubmission`) gets distinct
 * dedupe keys so each emission is de-duped independently.
 */
export interface AuditDedupeIdentity {
  tenantId: string;
  idempotencyKey: string;
  endpoint: string;
  actorId: string;
  bodyHash: string;
  /** AUDIT_EVENTS v5.2 catalog action ID (e.g., 'crisis_detection_trigger'). */
  auditAction: string;
}

/**
 * Compute the deterministic dedupe key for an idempotency-protected
 * audit emission. SHA-256 hex of the 6-tuple joined by ASCII unit
 * separator (\x1F) so no value can collide with a literal-character
 * concatenation of another tuple's fields.
 *
 * Exported for tests + observability (e.g., a structured-log entry
 * including the dedupe key for correlation across attempts).
 */
export function computeAuditDedupeKey(identity: AuditDedupeIdentity): string {
  const SEP = '\x1F';
  const input = [
    identity.tenantId,
    identity.idempotencyKey,
    identity.endpoint,
    identity.actorId,
    identity.bodyHash,
    identity.auditAction,
  ].join(SEP);
  return crypto.createHash('sha256').update(input).digest('hex');
}

/**
 * Marker TTL aligned to the idempotency cache TTL for the same
 * endpoint. The marker MUST NOT outlive the cache row it is gated
 * against — a stale marker would suppress a legitimate emit on a
 * fresh post-cache-expiry request (Sprint 34 audit-dedupe SI Codex
 * 2026-05-08 HIGH closure).
 *
 * Default 24h endpoints: marker TTL = 24h, cache TTL = 24h → aligned.
 * Auth-flow override endpoints: marker TTL = 900s, cache TTL = 900s
 * → aligned.
 *
 * This delegates to `idempotency.ttlSecondsForEndpoint`, which is the
 * single source of truth for the per-endpoint TTL contract.
 */
export function ttlSecondsForAuditDedupeMarker(endpoint: string): number {
  return ttlSecondsForEndpoint(endpoint);
}

/**
 * Try to claim a dedupe slot. Returns true if this is the first
 * attempt (caller MUST proceed to emit the actual audit). Returns
 * false if a prior attempt already claimed (caller MUST skip the
 * emit).
 *
 * The claim is performed via INSERT ... ON CONFLICT (tenant_id,
 * dedupe_key) DO NOTHING RETURNING tenant_id. ON CONFLICT semantics
 * mean the INSERT is silently absorbed when a marker already exists;
 * the empty RETURNING set is the signal for the caller.
 *
 * MUST be called from a connection that COMMITS independently of any
 * business-logic transaction the caller is inside — otherwise the
 * marker rolls back with the business tx and the dedupe protection
 * disappears. See `runCrisisGate` in
 * `src/modules/forms-intake/internal/services/submission-service.ts`
 * for the canonical caller pattern: open a fresh withTransaction,
 * claim the slot, emit the audit, throw the sentinel.
 *
 * The expired-marker recovery semantic is implicit: rows whose
 * expires_at <= NOW() should be cleaned up by a background job. Until
 * cleanup runs, expired markers BLOCK new claims with the same key —
 * which is correct: an expired marker's idempotency cache row has
 * also expired, so the originating client-retry cannot reach the
 * audit emit path anyway. The dedupe protection becomes a no-op for
 * truly-late retries; the cache layer is the gate.
 */
export async function claimAuditDedupeSlot(
  client: DbClient,
  identity: AuditDedupeIdentity,
): Promise<boolean> {
  const dedupeKey = computeAuditDedupeKey(identity);
  const ttlSeconds = ttlSecondsForAuditDedupeMarker(identity.endpoint);
  // expires_at is set explicitly to NOW() + per-endpoint cache TTL so
  // the marker cannot outlive its companion idempotency cache row.
  // The migration-022 column default (NOW() + INTERVAL '30 days') is
  // OVERRIDDEN here — the schema default is a safe upper bound for
  // crash-recovery, but the runtime contract is tight TTL alignment.
  // Per Sprint 34 audit-dedupe SI Codex 2026-05-08 HIGH closure.
  const result = await client.query<{ tenant_id: string }>(
    `INSERT INTO audit_dedupe_markers (tenant_id, dedupe_key, expires_at)
     VALUES ($1, $2, NOW() + ($3 || ' seconds')::interval)
     ON CONFLICT (tenant_id, dedupe_key) DO NOTHING
     RETURNING tenant_id`,
    [identity.tenantId, dedupeKey, ttlSeconds],
  );
  return result.rows.length > 0;
}

/**
 * The 4-tuple identifying a RESOURCE-LIFECYCLE audit dedupe slot.
 *
 *   tenantId       — tenant scope
 *   resourceType   — canonical resource type (e.g., 'crisis_event')
 *   resourceId     — canonical resource ID (e.g., the wrapper-returned UUID)
 *   auditAction    — AUDIT_EVENTS catalog action ID (e.g., 'crisis.detected')
 *
 * Distinct from `AuditDedupeIdentity` (the HTTP-request-shape 6-tuple).
 * Used when the dedupe anchor is the RESOURCE itself, not the request
 * envelope — i.e., when:
 *   - A lifecycle-bound Category A audit MUST emit exactly once per
 *     (tenant, resource_id, action) regardless of how many distinct
 *     HTTP Idempotency-Keys (or no Idempotency-Key at all) reach the
 *     same resource via a wrapper-level idempotent-replay path.
 *   - The audit emit is co-transactional with the resource INSERT
 *     (FLOOR-020 same-tx fail-closed) — so the marker rolls back with
 *     the resource on failure (correct) and only persists when both
 *     resource INSERT + audit emit committed atomically.
 *
 * Canonical caller: `POST /v0/crisis-events` handler. The
 * `record_crisis_initiation()` SECDEF wrapper has its own internal
 * idempotency keyed on `(tenant_id, server_signal_id)` — it returns
 * the existing crisis_event_id on duplicate-server-signal retries
 * WITHOUT INSERTing a new row. Different HTTP Idempotency-Keys
 * against the same server_signal_id would each reach the wrapper +
 * each re-emit the `crisis.detected` Cat A audit → duplicate audit
 * rows. The resource-lifecycle marker prevents the duplicate at the
 * audit boundary.
 *
 * Co-transactional safety: unlike `claimAuditDedupeSlot` (which
 * REQUIRES an independent-tx commit for I-019 durability of
 * `crisis_detection_trigger` Cat A pre-INSERT signals), this slot
 * lives in the SAME tx as the lifecycle audit it gates. The
 * atomicity is the dedupe contract:
 *   - First successful tx: marker INSERT + audit emit + resource
 *     INSERT all commit together. Future replays see the marker and
 *     skip the emit.
 *   - First-attempt rollback (audit emit fails, wrapper throws, etc.):
 *     marker also rolls back; retry runs cleanly + the marker is
 *     RE-INSERTABLE because no row was committed.
 *
 * Per FLOOR-020 + I-003: the audit row IS the canonical record. The
 * marker only EXISTS when the audit row exists.
 */
export interface ResourceLifecycleAuditDedupeIdentity {
  tenantId: string;
  /** Canonical resource type (e.g., 'crisis_event'). */
  resourceType: string;
  /** Canonical resource ID (UUID of the lifecycle resource). */
  resourceId: string;
  /** AUDIT_EVENTS catalog action ID (e.g., 'crisis.detected'). */
  auditAction: string;
}

/**
 * Compute the deterministic dedupe key for a RESOURCE-LIFECYCLE audit.
 * SHA-256 hex of the 4-tuple joined by ASCII unit separator (\x1F).
 *
 * Key shape is intentionally distinct from `computeAuditDedupeKey`'s
 * 6-tuple — the inputs are different (resource_id replaces the
 * idempotency 4-tuple + bodyHash) so collisions across the two key
 * spaces are not possible. A `resource_audit:` prefix on the input
 * makes the key namespace explicit in the hash domain.
 *
 * Exported for tests + observability.
 */
export function computeResourceLifecycleAuditDedupeKey(
  identity: ResourceLifecycleAuditDedupeIdentity,
): string {
  const SEP = '\x1F';
  const NAMESPACE = 'resource_audit';
  const input = [
    NAMESPACE,
    identity.tenantId,
    identity.resourceType,
    identity.resourceId,
    identity.auditAction,
  ].join(SEP);
  return crypto.createHash('sha256').update(input).digest('hex');
}

/**
 * Try to claim a RESOURCE-LIFECYCLE audit dedupe slot. Returns true if
 * this is the first attempt (caller MUST proceed to emit the actual
 * audit in the same transaction). Returns false if a prior committed
 * attempt already claimed (caller MUST skip the emit — the audit row
 * is already durable from the prior commit).
 *
 * **CRITICAL: MUST run in the SAME transaction as the audit emission
 * AND the resource INSERT it gates** — the OPPOSITE invariant from
 * `claimAuditDedupeSlot`. See `ResourceLifecycleAuditDedupeIdentity`
 * doc-comment for the rationale; one-line summary: lifecycle audits
 * are co-transactional with their resource INSERT per FLOOR-020, so
 * the marker MUST share the resource's atomicity envelope.
 *
 * Canonical caller: `POST /v0/crisis-events` handler
 * (`postCrisisEventHandler`). The wrapper-level idempotent-replay
 * path returns the existing crisis_event_id when the same
 * server_signal_id reaches it from a NEW Idempotency-Key (or no
 * Idempotency-Key); without this dedupe, the handler would re-emit
 * `crisis.detected` Cat A on every such replay.
 *
 * TTL: hard-coded to 30 days (matches the migration-022 column
 * default). Unlike `claimAuditDedupeSlot` (where TTL aligns with the
 * idempotency cache TTL since the marker IS the cache row's audit
 * companion), this marker's anchor is the RESOURCE — which is
 * durable indefinitely. The marker only needs to outlive any
 * realistic retry window for the same `server_signal_id` (FLOOR-020
 * retries from Mode 1 / forms / community + clinician-initiated
 * misclicks within the same operational period). 30 days is
 * generous; the marker becomes a no-op for genuinely-late retries.
 */
export async function claimResourceLifecycleAuditSlot(
  client: DbClient,
  identity: ResourceLifecycleAuditDedupeIdentity,
): Promise<boolean> {
  const dedupeKey = computeResourceLifecycleAuditDedupeKey(identity);
  // 30 days — matches migration-022 column default for the markers
  // table. See the function doc-comment for the rationale (the
  // marker's lifetime is anchored to the resource, not the request).
  const ttlSeconds = 30 * 24 * 60 * 60;
  const result = await client.query<{ tenant_id: string }>(
    `INSERT INTO audit_dedupe_markers (tenant_id, dedupe_key, expires_at)
     VALUES ($1, $2, NOW() + ($3 || ' seconds')::interval)
     ON CONFLICT (tenant_id, dedupe_key) DO NOTHING
     RETURNING tenant_id`,
    [identity.tenantId, dedupeKey, ttlSeconds],
  );
  return result.rows.length > 0;
}

/**
 * Purge expired markers for the given tenant. Returns the count
 * deleted. Intended for a periodic background job (cron-style) but
 * exported so tests can exercise the cleanup path explicitly.
 *
 * NOT called automatically by `claimAuditDedupeSlot` — the claim path
 * stays on a single round-trip. Cleanup latency is acceptable because
 * the existing markers, even when stale, only block re-claims with
 * the same exact 5-tuple (which a cache-expired retry can't reach
 * anyway; see `claimAuditDedupeSlot` doc-comment for the rationale).
 */
export async function purgeExpiredAuditDedupeMarkers(
  client: DbClient,
  tenantId: string,
): Promise<number> {
  const result = await client.query(
    `DELETE FROM audit_dedupe_markers
      WHERE tenant_id = $1
        AND expires_at <= NOW()`,
    [tenantId],
  );
  return result.rowCount ?? 0;
}
