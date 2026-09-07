import { withActorContext } from '../../../../lib/actor-context-binding.js';
import { withTransaction, type DbClient, type DbTransaction } from '../../../../lib/db.js';
import type { TenantId } from '../../../../lib/glossary.js';
import { IdempotencyReplayError } from '../../../../lib/idempotency.js';
import { withTenantContext } from '../../../../lib/rls.js';
import { emitFormsGovernanceEvidence } from '../../audit.js';

type FormsGovernanceContext = {
  tenantId: TenantId;
  accountId: string;
  sessionId: string;
  actorNonce: string;
};

/** Authorize both sides of the entire idempotency transaction, including cache
 * waits, outbox writes, cache completion and replay (which skips the body).
 * SQL failures may have aborted the transaction: preserve them without issuing
 * another query. A replay is a JavaScript control-flow exception with a live
 * transaction, so its final authorization must run before it reaches HTTP. */
export function formsGovernanceTransaction(
  context: FormsGovernanceContext,
  operation: string,
  resourceId: string | null = null,
): typeof withTransaction {
  return <T>(body: (tx: DbTransaction) => Promise<T>, externalTx?: DbTransaction) =>
    withTransaction(async (tx) => {
      await assertFormsGovernanceScope(tx, context, operation, resourceId);
      let result: T;
      try {
        result = await body(tx);
      } catch (error) {
        if (error instanceof IdempotencyReplayError)
          await assertFormsGovernanceScope(tx, context, operation, resourceId);
        throw error;
      }
      await assertFormsGovernanceScope(tx, context, operation, resourceId);
      return result;
    }, externalTx);
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
  // Verify while trusted tenant/actor bindings are still in scope; the context
  // helpers clear them before the surrounding transaction commits. The SQL
  // check also locks the approved content and its current reviewer authority
  // through commit, protecting any later cache/outbox waits after this flush.
  await tx.query('SET CONSTRAINTS forms_publication_evidence IMMEDIATE');
  await tx.query('SET CONSTRAINTS forms_publication_evidence DEFERRED');
}
