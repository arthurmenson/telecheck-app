import { commitAuthorityTransaction } from '../../../../lib/commit-authority-transaction.js';
import type { DbTransaction, withTransaction } from '../../../../lib/db.js';

/** What a consent transaction must prove, before, during and AT COMMIT. */
export interface ConsentAuthority {
  tenantId: string;
  /** The request's actor nonce (SI-010 trust anchor). */
  nonce: string;
  /** Re-validates the live actor; throws PT401 / 42501 when it no longer holds. */
  assertLive: (tx: DbTransaction) => Promise<void>;
}

/**
 * Runs `work` in a transaction whose COMMIT is itself authority-checked.
 *
 * The module-internal owned-client shape merged on PR #305 now lives in the
 * shared primitive (PR #306), which also closes the FATAL/PANIC-after-COMMIT
 * misclassification that copy inherited. The deferred
 * `consent_care_choice_evidence` / `consent_care_policy_evidence` triggers —
 * which call `consent_care_live_actor()` first and last — fire AT COMMIT
 * with both bindings live; an unconfirmed COMMIT surfaces as PT503 (503).
 *
 * Keeps `typeof withTransaction` so `withIdempotentExecution` can consume
 * it unchanged.
 */
export function consentAuthorityTransaction(authority: ConsentAuthority): typeof withTransaction {
  return commitAuthorityTransaction({
    tenantId: authority.tenantId,
    nonce: authority.nonce,
    assertLive: authority.assertLive,
    unconfirmed: () => Object.assign(new Error('consent_unavailable'), { code: 'PT503' }),
    discardEvent: 'consent.recording_connection.discarded',
  });
}
