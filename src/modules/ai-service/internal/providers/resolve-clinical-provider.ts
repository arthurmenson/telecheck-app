/**
 * ai-service/internal/providers/resolve-clinical-provider.ts — SI-025 real
 *   provider resolution for clinical workloads.
 *
 * Per SI-025 §5: constructs the real AnthropicLLMProvider from the resolved
 * API key — read from the admin-managed DB credential (via the SECDEF
 * `read_active_ai_provider_key` path under the ai_service_credential_reader
 * role), or the ANTHROPIC_API_KEY env fallback (bootstrap). When NO active
 * credential AND no env fallback resolve, returns NullLLMProvider so the
 * AI-RESIL-001 fail-soft path is preserved.
 *
 * **Precedence (SI-025 §2 bootstrap fallback):**
 *   1. Active DB credential for the provider (once configured, takes
 *      precedence).
 *   2. ANTHROPIC_API_KEY env var (preserves current behavior + bootstrap).
 *   3. Neither → NullLLMProvider (fail-soft; /ready stays honest).
 *
 * **Key-safety:** the plaintext key is resolved, decrypted in-process, and
 * handed to the adapter constructor. It is NEVER logged here. The envelope
 * read + decrypt never surface the key into a log line or error.
 *
 * **Separation from the sync `resolveProvider` registry:** the sync registry
 * (`registry.ts`) still owns the workload-type routing decision (which
 * reserved/sentinel types throw, which clinical types get a provider). This
 * async resolver owns the credential-read + adapter-construction step for the
 * clinical Anthropic default. Callers that need a real provider call this.
 *
 * Spec references:
 *   - SI-025 §5 (AI-service read-path wiring; env-fallback bootstrap)
 *   - ADR-020 (Anthropic primary; clinical paths platform-scoped)
 *   - migration 079 (read_active_ai_provider_key SECDEF wrapper +
 *     ai_service_credential_reader role)
 *   - src/lib/with-db-role.ts (SET LOCAL ROLE elevation to the reader role)
 */

import {
  decryptAiProviderKey,
  type AiProviderKeyEnvelope,
} from '../../../../lib/ai-provider-credential-envelope.js';
import { config } from '../../../../lib/config.js';
import type { DbClient } from '../../../../lib/db.js';
import { withDbRole } from '../../../../lib/with-db-role.js';

import { AnthropicLLMProvider } from './anthropic-provider.js';
import { NullLLMProvider } from './null-provider.js';
import type { LLMProvider } from './types.js';
import {
  recordVendorDecision,
  validateVendorAuditContext,
  type VendorAuditContext,
} from './vendor-audit.js';
import { VendorAuditUnavailableError, withVendorBoundary } from './vendor-boundary.js';

/** The provider identifiers the credential store recognizes (matches the
 *  ai_provider_credential.provider CHECK). */
export type CredentialProvider = 'anthropic' | 'aws_bedrock' | 'azure_openai';

/** Raw row shape returned by read_active_ai_provider_key. BYTEA columns come
 *  back as Node Buffers from `pg`. */
interface AiProviderKeyEnvelopeRow {
  key_ciphertext: Buffer;
  key_kms_envelope_dek_id: string;
  key_kms_envelope_iv: Buffer;
  key_kms_envelope_tag: Buffer;
  key_kms_envelope_alg: string;
  key_kms_envelope_alg_version: string;
  key_kms_envelope_aad: Buffer;
  key_kms_envelope_encrypted_at: Date;
  key_last4: string;
  key_fingerprint: string;
}

/**
 * Read the active DB credential for a provider via the SECDEF wrapper under
 * the ai_service_credential_reader role, decrypt it in-process, and return
 * the plaintext key — or null when no active credential exists.
 *
 * MUST be called inside an open transaction (the SET LOCAL ROLE elevation is
 * tx-scoped). The plaintext is returned to the immediate caller and never
 * logged.
 */
export async function readActiveProviderKeyPlaintext(
  tx: DbClient,
  provider: CredentialProvider,
): Promise<string | null> {
  const rows = await withDbRole(tx, 'ai_service_credential_reader', async () => {
    const r = await tx.query<AiProviderKeyEnvelopeRow>(
      'SELECT * FROM read_active_ai_provider_key($1)',
      [provider],
    );
    return r.rows;
  });

  const row = rows[0];
  if (row === undefined) {
    return null;
  }

  const envelope: AiProviderKeyEnvelope = {
    ciphertext: row.key_ciphertext,
    dekId: row.key_kms_envelope_dek_id,
    iv: row.key_kms_envelope_iv,
    tag: row.key_kms_envelope_tag,
    alg: row.key_kms_envelope_alg,
    algVersion: row.key_kms_envelope_alg_version,
    aad: row.key_kms_envelope_aad,
    encryptedAt: row.key_kms_envelope_encrypted_at,
  };
  return decryptAiProviderKey(envelope);
}

export interface ResolveClinicalProviderDeps {
  /** Open transaction/client for the SECDEF credential read. Optional — when
   *  omitted, resolution skips the DB read and uses only the env fallback
   *  (e.g. a probe path that has no tx). */
  tx?: DbClient;
  /** Trusted Mode 1 context; required for a real completion, not a healthcheck.
   * Reservation expiry is read from this caller's transaction, never the child
   * audit transaction (which cannot see the uncommitted reservation). */
  auditContext?: Omit<VendorAuditContext, 'reservationExpiresAt'>;
}

/**
 * Resolve the clinical LLM provider (Anthropic at v1.0 per ADR-020).
 *
 * Precedence: active DB credential → ANTHROPIC_API_KEY env → NullLLMProvider.
 * Never logs the resolved key.
 */
export async function resolveClinicalProvider(
  deps: ResolveClinicalProviderDeps = {},
): Promise<LLMProvider> {
  const tx = deps.tx;
  // Copy before any await so later caller mutation cannot change attribution.
  const auditInput =
    deps.auditContext === undefined
      ? undefined
      : {
          ...deps.auditContext,
          idempotency: { ...deps.auditContext.idempotency },
        };
  let apiKey: string | null = null;

  // 1. Admin-managed DB credential (takes precedence once configured).
  if (tx !== undefined) {
    apiKey = await readActiveProviderKeyPlaintext(tx, 'anthropic');
  }

  // 2. Env fallback (bootstrap; preserves pre-SI-025 behavior).
  if (apiKey === null) {
    const envKey = config.anthropicApiKey;
    if (typeof envKey === 'string' && envKey.length > 0) {
      apiKey = envKey;
    }
  }

  // 3. Neither → fail-soft Null provider (AI-RESIL-001 preserved).
  if (apiKey === null) {
    return new NullLLMProvider();
  }

  const model = config.anthropicModel;
  const provider = new AnthropicLLMProvider({ apiKey, model });
  return {
    name: provider.name,
    healthcheck: () => provider.healthcheck(),
    async sendCompletion(request) {
      let auditContext: VendorAuditContext;
      try {
        if (tx === undefined || auditInput === undefined) throw new VendorAuditUnavailableError();
        const identity = auditInput.idempotency;
        const reservation = await tx.query<{ expires_at: string }>(
          `SELECT expires_at::text AS expires_at FROM idempotency_keys
            WHERE tenant_id = $1 AND key = $2 AND endpoint = $3 AND actor_id = $4
              AND request_hash = decode($5, 'hex') AND processing_state = 'pending'`,
          [
            auditInput.tenantId,
            identity.idempotencyKey,
            identity.endpoint,
            identity.actorId,
            identity.bodyHash,
          ],
        );
        const expiresAt = reservation.rows[0]?.expires_at;
        if (typeof expiresAt !== 'string') throw new VendorAuditUnavailableError();
        auditContext = { ...auditInput, reservationExpiresAt: expiresAt };
        validateVendorAuditContext(auditContext);
      } catch {
        // DB/validation diagnostics may contain candidate values. Keep this
        // distinct from a provider outage and do not retain the original cause.
        throw new VendorAuditUnavailableError();
      }
      return withVendorBoundary(
        provider,
        (decision) => recordVendorDecision(auditContext, provider.name, decision),
        { tenantId: auditContext.tenantId, workloadType: 'conversational_assistant', model },
      ).sendCompletion(request);
    },
  };
}

/**
 * Synchronous check: is an Anthropic clinical provider satisfiable from the
 * ENV fallback alone (without a DB read)? Used by the ai-service /ready probe
 * to decide whether the provider-credential readiness gate is met. Returns
 * true when ANTHROPIC_API_KEY is present. A DB-credential-only configuration
 * (no env key) is surfaced separately by the readiness probe's DB check.
 */
export function isEnvAnthropicKeyPresent(): boolean {
  const envKey = config.anthropicApiKey;
  return typeof envKey === 'string' && envKey.length > 0;
}
