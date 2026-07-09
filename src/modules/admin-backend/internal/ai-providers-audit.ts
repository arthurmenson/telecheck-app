/**
 * admin-backend/internal/ai-providers-audit.ts — SI-025 Cat B governance
 *   audit emitters for AI provider credential mutations.
 *
 * Three mutation events per SI-025 §2 (all Category B governance):
 *   - ai_provider_credential.set     — first credential set for a provider
 *   - ai_provider_credential.rotated — active credential replaced (revoke+insert)
 *   - ai_provider_credential.revoked — active credential revoked (DELETE endpoint)
 *
 * Each envelope carries `provider`, `actor`, `key_last4`, `key_fingerprint`
 * (SHA-256 of plaintext — for rotation detection) and NEVER the plaintext key
 * or the ciphertext (SI-025 §7). The fingerprint is a one-way digest, not a
 * plaintext-recovery vector.
 *
 * **Placeholder-cast discipline (async-consult / admin-backend precedent):**
 * the 3 `ai_provider_credential.*` action IDs are not yet in the canonical
 * `lib/audit.ts` AuditAction union (AUDIT_EVENTS amendment is Track-6
 * SPEC-GATED). Until that amendment lands, this module routes every emission
 * through ONE sanctioned cast helper (`aiProviderCredentialAuditPlaceholder`)
 * so reviewers can grep every unratified emission:
 *   git grep "aiProviderCredentialAuditPlaceholder("
 * The compile-time union prevents typos. Placeholder-cast has NO runtime
 * impact (naming-provenance gap only).
 *
 * **I-003 durability:** emitters MUST be called with a `tx` handle so the
 * audit INSERT runs in the same transaction as the credential write;
 * `emitAudit()` throws on missing-tx in production. Callers MUST NOT swallow.
 *
 * **Platform-scope note:** the credential is platform-scoped (SI-025 fork 2),
 * but the audit envelope still requires a `tenant_id` (I-027). We use the
 * request's tenant context as the audit tenant (the platform_admin acting
 * within a tenant context) and `actor_type='operator'`, mirroring the
 * admin-backend governance-audit convention. `target_patient_id` is null
 * (platform-scope governance action → 'PLATFORM' hash-chain partition).
 *
 * Spec references:
 *   - SI-025 §2 (audit: provider/actor/key_last4/key_fingerprint; never plaintext)
 *   - SI-025 §7 (plaintext never in audit)
 *   - I-003 (audit durability), I-027 (tenant_id on every record)
 *   - src/modules/admin-backend/audit.ts (placeholder-cast precedent)
 */

import {
  type AuditAction,
  type AuditDbClient,
  type AuditEnvelope,
  type AuditEnvelopeInput,
  emitAudit,
} from '../../../lib/audit.js';
import type { TenantId } from '../../../lib/glossary.js';

// ---------------------------------------------------------------------------
// SPEC ISSUE — unratified ai_provider_credential.* audit action IDs.
// Single sanctioned cast site (grep-able); compile-time union prevents typos.
// ---------------------------------------------------------------------------

type AiProviderCredentialAuditActionPlaceholder =
  | 'ai_provider_credential.set'
  | 'ai_provider_credential.rotated'
  | 'ai_provider_credential.revoked';

export function aiProviderCredentialAuditPlaceholder(
  id: AiProviderCredentialAuditActionPlaceholder,
): AuditAction {
  return id as AuditAction;
}

export type AiProviderCredentialMutation = 'set' | 'rotated' | 'revoked';

const MUTATION_TO_ACTION: Record<
  AiProviderCredentialMutation,
  AiProviderCredentialAuditActionPlaceholder
> = {
  set: 'ai_provider_credential.set',
  rotated: 'ai_provider_credential.rotated',
  revoked: 'ai_provider_credential.revoked',
};

/**
 * Emit the Cat B governance audit for an AI-provider-credential mutation.
 *
 * NEVER pass the plaintext key or ciphertext into `detail`. Only the
 * non-secret `provider`, `key_last4`, and `key_fingerprint` are carried.
 * For a revoke, `keyLast4`/`keyFingerprint` describe the credential being
 * revoked (for forensic linkage), still non-secret.
 */
export async function emitAiProviderCredentialMutationAudit(
  args: {
    tenantId: TenantId;
    actorId: string;
    actorTenantId: string | null;
    countryOfCare: string;
    mutation: AiProviderCredentialMutation;
    provider: string;
    credentialId: string;
    keyLast4: string;
    keyFingerprint: string;
  },
  tx: AuditDbClient,
): Promise<AuditEnvelope> {
  const envelope: AuditEnvelopeInput = {
    timestamp: new Date().toISOString(),
    tenant_id: args.tenantId,
    actor_type: 'operator',
    actor_id: args.actorId,
    actor_tenant_id: args.actorTenantId,
    target_patient_id: null,
    delegate_context: null,
    action: aiProviderCredentialAuditPlaceholder(MUTATION_TO_ACTION[args.mutation]),
    category: 'B',
    audit_sensitivity_level: 'standard',
    resource_type: 'ai_provider_credential',
    resource_id: args.credentialId,
    detail: {
      provider: args.provider,
      // NON-secret metadata ONLY. Never key_ciphertext, never plaintext.
      key_last4: args.keyLast4,
      key_fingerprint: args.keyFingerprint,
      mutation: args.mutation,
    },
    engine_versions: null,
    ai_workload_type: null,
    autonomy_level: null,
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
    country_of_care: args.countryOfCare,
    break_glass: null,
  };
  return emitAudit(envelope, tx);
}
