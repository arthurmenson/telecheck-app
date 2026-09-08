import { withActorContext } from '../../../../lib/actor-context-binding.js';
import { commitAuthorityTransaction } from '../../../../lib/commit-authority-transaction.js';
import { type DbClient, type withTransaction } from '../../../../lib/db.js';
import type { TenantId } from '../../../../lib/glossary.js';
import { withTenantContext } from '../../../../lib/rls.js';
import { emitFormsGovernanceEvidence } from '../../audit.js';

type FormsGovernanceContext = {
  tenantId: TenantId;
  accountId: string;
  sessionId: string;
  actorNonce: string;
};

/**
 * Authorize both sides of the entire idempotency transaction, including cache
 * waits, outbox writes, cache completion and replay (which skips the body) —
 * and AT COMMIT.
 *
 * The previous shape ran under `withTransaction` while the body nested
 * `withTenantContext` / `withActorContext`, and `recordFormsPublicationEvidence`
 * forced the deferred `forms_publication_evidence` trigger IMMEDIATE (then
 * re-DEFERRED it, which does not re-queue a consumed event). That is the
 * deferred-authority-trigger defect class fixed in PRs #302/#303/#304 and
 * consent: at the real COMMIT the tenant binding had been cleared and the
 * trigger event consumed, so `forms_live_actor('reviewer')` never ran at
 * COMMIT and an actor nonce expiring in that window was committed under
 * expired authority.
 *
 * Now the shared primitive owns the client, holds tenant + actor bindings
 * live through COMMIT, and lets the deferred trigger fire there as a genuine
 * authority gate. The live-scope check runs before the body, after it, and
 * before disclosing an idempotency replay/mismatch/in-flight outcome. An
 * unconfirmed COMMIT (stalled, or transport/class-08 failure after COMMIT was
 * issued) surfaces as PT503 -> 503 so the caller checks status before
 * retrying. SQL failures may have aborted the transaction: they are preserved
 * without issuing another query.
 */
export function formsGovernanceTransaction(
  context: FormsGovernanceContext,
  operation: string,
  resourceId: string | null = null,
): typeof withTransaction {
  return commitAuthorityTransaction({
    tenantId: context.tenantId,
    nonce: context.actorNonce,
    assertLive: (tx) => assertFormsGovernanceScope(tx, context, operation, resourceId),
    unconfirmed: () => Object.assign(new Error('forms.commit_unconfirmed'), { code: 'PT503' }),
    discardEvent: 'forms.recording_connection.discarded',
  });
}

export async function assertFormsGovernanceScope(
  tx: DbClient,
  context: FormsGovernanceContext,
  operation: string,
  resourceId: string | null = null,
): Promise<void> {
  await withTenantContext(tx, context.tenantId, () =>
    withActorContext(tx, context.actorNonce, async () => {
      await tx.query('SELECT public.forms_authorize_operation($1,$2,$3,$4)', [
        operation,
        resourceId,
        context.accountId,
        context.sessionId,
      ]);
    }),
  );
}

/** Call after publication in the same actor-bound transaction, before commit. */
export async function recordFormsPublicationEvidence(
  tx: DbClient,
  context: {
    tenantId: TenantId;
    actorId: string;
    actorRole: 'clinician' | 'operator';
    countryOfCare: string;
  },
  templateId: string,
): Promise<void> {
  const result = await tx.query<{
    receipt: {
      schema_hash: string;
      template_version: number;
      governance: { development_only: boolean };
    };
  }>('SELECT public.forms_publication_receipt($1) AS receipt', [templateId]);
  const receipt = result.rows[0]?.receipt;
  if (receipt === undefined) throw new Error('forms.publication_receipt_unavailable');
  if (receipt.governance.development_only && process.env['NODE_ENV'] === 'production')
    throw new Error('forms.development_definition_unavailable');
  await emitFormsGovernanceEvidence(
    {
      ...context,
      resourceId: templateId,
      intent: 'forms.publication.checked',
      detail: {
        schema_hash: receipt.schema_hash,
        template_version: receipt.template_version,
        development_only: receipt.governance.development_only,
        research_independence: {
          branching: true,
          visibility: true,
          validation: true,
          eligibility_triage: true,
          pricing_commerce: true,
          outcome_messaging: true,
        },
      },
    },
    tx,
  );
  // The deferred `forms_publication_evidence` trigger fires AT COMMIT, with
  // the tenant and actor bindings held live by formsGovernanceTransaction.
  // It must NOT be forced IMMEDIATE here: that consumes the trigger event
  // (re-DEFERRING does not re-queue it), and the real COMMIT would then run
  // with no `forms_live_actor('reviewer')` re-validation.
}
