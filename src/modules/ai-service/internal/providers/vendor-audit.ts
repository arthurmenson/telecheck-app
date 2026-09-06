/** Durable, tenant-bound Layer 4 evidence, independent of chat rollback. */
import { createHash } from 'node:crypto';

import { emitAudit } from '../../../../lib/audit.js';
import { withTransaction } from '../../../../lib/db.js';
import { isTenantIdFormat, type TenantId } from '../../../../lib/glossary.js';
import type { IdempotencyCtx } from '../../../../lib/idempotency.js';
import { PII_PATTERNS } from '../../../../lib/pii-screener/patterns.js';

import type { LLMProviderName } from './types.js';
import { VendorAuditUnavailableError, type VendorBoundaryDecision } from './vendor-boundary.js';

/** Only the current, authenticated Mode 1 caller has this attribution contract. */
export interface VendorAuditContext {
  readonly tenantId: TenantId;
  readonly countryOfCare: string;
  readonly patientId: string;
  readonly conversationId: string;
  readonly messageId: string;
  readonly idempotency: IdempotencyCtx;
  /** Actual reservation cutoff; a retry must not extend an existing marker. */
  readonly reservationExpiresAt: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/;
const ULID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
const CLINICAL_PROVIDERS = new Set(['anthropic', 'bedrock_claude', 'azure_openai']);

export function validateVendorAuditContext(context: VendorAuditContext): void {
  try {
    const identity = context.idempotency;
    if (
      !isTenantIdFormat(context.tenantId) ||
      !/^[A-Z]{2}$/.test(context.countryOfCare) ||
      !ULID.test(context.patientId) ||
      !UUID.test(context.conversationId) ||
      !UUID.test(context.messageId) ||
      identity.tenantId !== context.tenantId ||
      identity.actorId !== context.patientId ||
      identity.endpoint !== '/v0/ai/chat' ||
      !ULID.test(identity.idempotencyKey) ||
      !SHA256.test(identity.bodyHash) ||
      typeof context.reservationExpiresAt !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}(?::\d{2})?)$/.test(
        context.reservationExpiresAt,
      ) ||
      !Number.isFinite(Date.parse(context.reservationExpiresAt))
    ) {
      throw new VendorAuditUnavailableError();
    }
  } catch {
    throw new VendorAuditUnavailableError();
  }
}

function validate(
  context: VendorAuditContext,
  provider: LLMProviderName,
  decision: VendorBoundaryDecision,
): void {
  validateVendorAuditContext(context);
  if (!CLINICAL_PROVIDERS.has(provider)) throw new VendorAuditUnavailableError();

  const patterns = decision.patternIds.map((id) =>
    PII_PATTERNS.find((pattern) => pattern.id === id),
  );
  if (patterns.some((pattern) => pattern === undefined)) throw new VendorAuditUnavailableError();
  if (decision.reason === 'screening_failed') {
    if (
      decision.action !== 'block' ||
      decision.hitCount !== 0 ||
      patterns.length !== 0 ||
      decision.candidateFingerprint !== null
    ) {
      throw new VendorAuditUnavailableError();
    }
    return;
  }
  if (
    !Number.isSafeInteger(decision.hitCount) ||
    decision.hitCount < 1 ||
    patterns.length === 0 ||
    patterns.length > decision.hitCount ||
    typeof decision.candidateFingerprint !== 'string' ||
    !SHA256.test(decision.candidateFingerprint) ||
    (decision.action === 'block'
      ? decision.reason !== 'high_confidence_match' ||
        !patterns.some((pattern) => pattern?.confidence === 'high_confidence')
      : decision.action !== 'redact' ||
        decision.reason !== 'low_confidence_redacted' ||
        patterns.some((pattern) => pattern?.confidence !== 'low_confidence'))
  ) {
    throw new VendorAuditUnavailableError();
  }
}

/**
 * A successful return means evidence committed, or an equivalent atomic
 * marker+event already committed within the original idempotency window.
 * No external transaction parameter: savepoints cannot provide durability.
 */
export async function recordVendorDecision(
  context: VendorAuditContext,
  provider: LLMProviderName,
  decision: VendorBoundaryDecision,
): Promise<void> {
  try {
    validate(context, provider, decision);
    // Capture all attribution before the first await. Neither caller mutation
    // nor audit callback latency can change what a claim attests.
    const { tenantId, countryOfCare, patientId, conversationId, messageId } = context;
    // Preserve PostgreSQL microseconds from expires_at::text. A Date roundtrip
    // would truncate the reservation cutoff and allow early marker expiry.
    const expiresAt = context.reservationExpiresAt;
    const { idempotencyKey, endpoint, actorId, bodyHash } = context.idempotency;
    const { reason, hitCount, candidateFingerprint } = decision;
    const patternIds = [...new Set(decision.patternIds)].sort();
    const action =
      decision.action === 'block' ? 'pii.screener.egress_block' : 'pii.screener.egress_redact';
    // JSON tuple encoding is unambiguous even if future identifiers contain
    // separators. Candidate/rule identity is opaque inside this marker only.
    const dedupeKey =
      candidateFingerprint === null
        ? null
        : createHash('sha256')
            .update(
              JSON.stringify([
                'vendor-egress:4:v1',
                tenantId,
                idempotencyKey,
                endpoint,
                actorId,
                bodyHash,
                action,
                provider,
                patientId,
                conversationId,
                messageId,
                candidateFingerprint,
                reason,
                patternIds,
                hitCount,
              ]),
            )
            .digest('hex');

    await withTransaction(async (tx) => {
      // Existing pool acquisition is bounded at 5s. Lock contention must also
      // fail closed, including an outer transaction holding this audit chain.
      await tx.query("SET LOCAL lock_timeout = '2s'");
      await tx.query("SET LOCAL statement_timeout = '5s'");
      await tx.query('SELECT set_tenant_context($1)', [tenantId]);
      const attribution = await tx.query<{ country_of_care: string }>(
        'SELECT country_of_care FROM tenants WHERE id = $1',
        [tenantId],
      );
      if (attribution.rows[0]?.country_of_care !== countryOfCare) {
        throw new VendorAuditUnavailableError();
      }

      if (dedupeKey !== null) {
        const window = await tx.query<{ active: boolean }>(
          'SELECT $1::timestamptz > NOW() AS active',
          [expiresAt],
        );
        // NOW() is stable for this transaction, matching the idempotency
        // reservation semantics. Never re-check against a later wall clock
        // between claim and proof: crossing expiry there could double emit.
        // An already-expired request emits evidence without a stale marker.
        if (window.rows[0]?.active === true) {
          await tx.query(
            `DELETE FROM audit_dedupe_markers
              WHERE tenant_id = $1 AND dedupe_key = $2 AND expires_at <= NOW()`,
            [tenantId, dedupeKey],
          );
          const claim = await tx.query<{ tenant_id: string }>(
            `INSERT INTO audit_dedupe_markers (tenant_id, dedupe_key, expires_at)
             VALUES ($1, $2, $3::timestamptz)
             ON CONFLICT (tenant_id, dedupe_key) DO NOTHING RETURNING tenant_id`,
            [tenantId, dedupeKey, expiresAt],
          );
          // Concurrent INSERT waits for the winner's complete marker+event
          // transaction. A rollback lets this INSERT become the fresh owner.
          if (claim.rows.length === 0) return;
        }
      }

      await emitAudit(
        {
          timestamp: new Date().toISOString(),
          tenant_id: tenantId,
          actor_type: 'system',
          actor_id: 'system:ai_mode_1',
          actor_tenant_id: tenantId,
          target_patient_id: null,
          delegate_context: null,
          action,
          category: 'B',
          audit_sensitivity_level: 'standard',
          resource_type: 'ai_chat_session',
          resource_id: conversationId,
          detail: {
            layer: 4,
            provider,
            patient_id: patientId,
            message_id: messageId,
            pattern_ids: patternIds,
            hit_count: reason === 'screening_failed' ? null : hitCount,
            reason,
          },
          engine_versions: null,
          ai_workload_type: 'conversational_assistant',
          autonomy_level: 'advisory',
          agent_id: null,
          agent_version: null,
          tool_call_id: null,
          memory_read_set_id: null,
          memory_write_set_id: null,
          supervising_policy_id: null,
          knowledge_source_versions: null,
          signals: null,
          override: null,
          linked_events: [],
          compliance_flags: [],
          country_of_care: countryOfCare,
          break_glass: null,
        },
        tx,
      );
    });
  } catch {
    // PostgreSQL diagnostics can contain failed bind values. No cause/raw
    // exception reaches the provider, handler, response or structured logs.
    throw new VendorAuditUnavailableError();
  }
}
