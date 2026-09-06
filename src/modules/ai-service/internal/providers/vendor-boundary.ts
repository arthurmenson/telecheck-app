/**
 * Provider-independent Layer 4 composition, installed by the clinical resolver.
 */
import type { LLMCompletionRequest, LLMProvider } from './types.js';
import { screenVendorRequest, type VendorRequestScope } from './vendor-payload-screening.js';

/** Internal decision metadata. The recorder projects the canonical audit detail. */
export interface VendorBoundaryDecision {
  readonly action: 'block' | 'redact';
  readonly reason: 'high_confidence_match' | 'low_confidence_redacted' | 'screening_failed';
  readonly patternIds: readonly string[];
  readonly hitCount: number;
  /** Opaque retry identity; never part of the audit event's detail. */
  readonly candidateFingerprint: string | null;
}

export class VendorEgressBlockedError extends Error {
  constructor() {
    super('ai.provider.egress_blocked');
    this.name = 'VendorEgressBlockedError';
  }
}

export class VendorAuditUnavailableError extends Error {
  constructor() {
    super('AI provider egress audit unavailable');
    this.name = 'VendorAuditUnavailableError';
  }
}

/**
 * recordDecision must resolve only after durable audit commit, independently
 * of a business transaction that can roll back. There is deliberately no
 * default/no-op recorder. The clinical resolver must provide the approved
 * implementation with trusted tenant/actor context; a logger is insufficient.
 */
export function withVendorBoundary(
  provider: LLMProvider,
  recordDecision: (decision: VendorBoundaryDecision) => Promise<void>,
  scope?: VendorRequestScope,
): LLMProvider {
  if (typeof recordDecision !== 'function') throw new VendorAuditUnavailableError();
  return {
    name: provider.name,
    healthcheck: () => provider.healthcheck(),
    async sendCompletion(request: LLMCompletionRequest) {
      const result = screenVendorRequest(request, scope);
      if (result.action !== 'pass') {
        try {
          await recordDecision({
            action: result.action,
            reason: result.action === 'block' ? result.reason : 'low_confidence_redacted',
            patternIds: result.patternIds,
            hitCount: result.hitCount,
            candidateFingerprint: result.candidateFingerprint,
          });
        } catch {
          // The recorder's exception may carry candidate or DB diagnostic
          // content. Retain neither its text nor its cause on this error.
          throw new VendorAuditUnavailableError();
        }
      }
      if (result.action === 'block') throw new VendorEgressBlockedError();
      return provider.sendCompletion(result.request);
    },
  };
}
