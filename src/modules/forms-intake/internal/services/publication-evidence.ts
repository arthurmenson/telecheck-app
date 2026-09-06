import { withActorContext } from '../../../../lib/actor-context-binding.js';
import type { DbClient } from '../../../../lib/db.js';
import type { TenantId } from '../../../../lib/glossary.js';
import { withTenantContext } from '../../../../lib/rls.js';
import { emitFormsGovernanceEvidence } from '../../audit.js';

export async function assertFormsGovernanceScope(
  tx: DbClient,
  context: {
    tenantId: TenantId;
    accountId: string;
    sessionId: string;
    actorNonce: string;
  },
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
  // helpers clear them before the surrounding transaction commits.
  await tx.query('SET CONSTRAINTS forms_publication_evidence IMMEDIATE');
  await tx.query('SET CONSTRAINTS forms_publication_evidence DEFERRED');
}
