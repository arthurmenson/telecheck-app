import { commitAuthorityTransaction } from '../../../../lib/commit-authority-transaction.js';
import { type DbTransaction, type withTransaction } from '../../../../lib/db.js';
import { emitDomainEvent } from '../../../../lib/domain-events.js';
import { ulid } from '../../../../lib/ulid.js';
import type { CareConsentPatientContext } from '../../../consent/index.js';
import { resolveConsultIntakeDefinition } from '../../../forms-intake/index.js';
import {
  emitAsyncConsultIntakeDefinitionBoundAudit,
  emitAsyncConsultIntakeSubmittedAudit,
} from '../../audit.js';

import {
  CareIntakeError,
  type BoundCareIntake,
  type CareIntakeRepository,
} from './clinical-intake.js';

async function bind(tx: DbTransaction, ctx: CareConsentPatientContext) {
  await tx.query('SELECT set_tenant_context($1)', [ctx.tenant.tenantId]);
  await tx.query("SELECT set_config('app.request_nonce',$1,true)", [ctx.actorNonce]);
}

async function actor(tx: DbTransaction, ctx: CareConsentPatientContext) {
  await bind(tx, ctx);
  const result = await tx
    .query<{
      account_id: string;
      session_id: string;
      tenant_id: string;
      actor_role: string;
      country_of_care: string;
    }>('SELECT * FROM public.kms_current_actor_context()')
    .catch((error: unknown) => {
      const failure = error as { code?: string; message?: string };
      if (failure.code === 'P0001' && failure.message === 'kms_actor_unavailable')
        throw Object.assign(new Error('care_unauthenticated'), { code: 'PT401' });
      throw error;
    });
  const current = result.rows[0];
  if (
    !current ||
    current.account_id !== ctx.accountId ||
    current.session_id !== ctx.sessionId ||
    current.tenant_id !== ctx.tenant.tenantId ||
    current.actor_role !== 'patient' ||
    current.country_of_care !== ctx.tenant.countryOfCare
  )
    throw Object.assign(new Error('care_unauthenticated'), { code: 'PT401' });
}

/**
 * Runs `work` in a transaction whose COMMIT is itself authority-checked.
 *
 * The previous shape — `withTransaction(() => withTenantContext(() =>
 * withActorContext(work)))` followed by `SET CONSTRAINTS
 * care_intake_evidence,care_binding_evidence IMMEDIATE` — was the
 * deferred-authority-trigger defect class (PRs #302–#307): the binding was
 * cleared and the trigger events consumed before the real COMMIT. The
 * module-internal owned-client fix from PR #303 now lives in the shared
 * primitive (PR #306), which also closes the FATAL/PANIC-after-COMMIT
 * misclassification that copy inherited. The deferred triggers — which call
 * `consent_care_live_actor()` first and last — fire AT COMMIT with both
 * bindings live; an unconfirmed COMMIT surfaces as PT503 (503).
 *
 * Keeps `typeof withTransaction` so `withIdempotentExecution` can consume
 * it unchanged.
 */
export function careIntakeTransaction(ctx: CareConsentPatientContext): typeof withTransaction {
  return commitAuthorityTransaction({
    tenantId: ctx.tenant.tenantId,
    nonce: ctx.actorNonce,
    assertLive: (tx) => actor(tx, ctx),
    unconfirmed: () => Object.assign(new Error('care_commit_unconfirmed'), { code: 'PT503' }),
    discardEvent: 'care_intake.recording_connection.discarded',
    statementTimeoutMs: 10_000,
    lockTimeoutMs: 3_000,
  });
}

export function careIntakeRepository(ctx: CareConsentPatientContext): CareIntakeRepository {
  return {
    async authorize(tx, consultId) {
      await actor(tx, ctx);
      const result = await tx.query<{ binding: BoundCareIntake }>(
        'SELECT public.care_authorize_intake($1) AS binding',
        [consultId],
      );
      if (!result.rows[0]?.binding) throw new CareIntakeError('care.intake_unavailable');
      return result.rows[0].binding;
    },
    async append(tx, record) {
      await actor(tx, ctx);
      const e = record.envelope;
      await tx.query(
        'SELECT public.care_append_intake($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb)',
        [
          record.submissionId,
          record.binding.consult_id,
          e.ciphertext,
          e.dekId,
          e.iv,
          e.tag,
          e.alg,
          e.algVersion,
          e.aad,
          e.encryptedAt,
          ulid(),
          ulid(),
          JSON.stringify(record.consent),
        ],
      );
    },
    async evidence(tx, record) {
      await actor(tx, ctx);
      const audit = await emitAsyncConsultIntakeSubmittedAudit(
        {
          tenantId: ctx.tenant.tenantId,
          submissionId: record.submissionId,
          consultId: record.binding.consult_id,
          patientId: ctx.accountId,
          actorId: ctx.accountId,
          actorTenantId: ctx.tenant.tenantId,
          countryOfCare: ctx.tenant.countryOfCare,
          templateId: record.binding.definition.template_id,
          templateVersion: String(record.binding.definition.template_version),
        },
        tx,
      );
      await emitDomainEvent(tx, {
        tenant_id: ctx.tenant.tenantId,
        aggregate_type: 'consult',
        aggregate_id: record.binding.consult_id,
        event_type: 'async_consult.intake_submitted.v1',
        payload: {
          submission_id: record.submissionId,
          audit_id: audit.audit_id,
          publication_id: record.consent.publication_id,
          policy_hash: record.consent.policy_hash,
          ai_interpretation_active: record.consent.ai_interpretation_active,
        },
        occurred_at: new Date().toISOString(),
      });
    },
  };
}

/** Binds once when intake starts; subsequent calls retain that exact version. */
export async function beginCareIntake(
  tx: DbTransaction,
  ctx: CareConsentPatientContext,
  consultId: string,
) {
  await actor(tx, ctx);
  const result = await tx.query<{ binding: BoundCareIntake & { created: boolean } }>(
    'SELECT public.care_bind_intake($1) AS binding',
    [consultId],
  );
  const bound = result.rows[0]?.binding;
  if (!bound || bound.patient_id !== ctx.accountId || bound.consult_id !== consultId)
    throw new CareIntakeError('care.intake_unavailable');
  const definition = await resolveConsultIntakeDefinition(
    tx,
    {
      tenantId: ctx.tenant.tenantId,
      accountId: ctx.accountId,
      sessionId: ctx.sessionId,
      actorNonce: ctx.actorNonce,
      countryOfCare: bound.definition.country_of_care,
    },
    {
      deploymentId: bound.definition.deployment_id,
      kind: bound.consult_type === 'general' ? 'general_consult' : 'program',
      programId: bound.definition.program_id,
      existingBinding: true,
    },
  );
  if (
    definition.schema_hash !== bound.definition.schema_hash ||
    definition.template_id !== bound.definition.template_id ||
    definition.template_version !== bound.definition.template_version ||
    definition.country_of_care !== ctx.tenant.countryOfCare
  )
    throw new CareIntakeError('care.form_review_required');
  await actor(tx, ctx);
  if (bound.created) {
    const audit = await emitAsyncConsultIntakeDefinitionBoundAudit(
      {
        tenantId: ctx.tenant.tenantId,
        consultId,
        patientId: ctx.accountId,
        countryOfCare: ctx.tenant.countryOfCare,
        templateId: definition.template_id,
        templateVersion: definition.template_version,
        deploymentId: definition.deployment_id,
        schemaHash: definition.schema_hash,
      },
      tx,
    );
    await emitDomainEvent(tx, {
      tenant_id: ctx.tenant.tenantId,
      aggregate_type: 'consult',
      aggregate_id: consultId,
      event_type: 'async_consult.intake_definition_bound.v1',
      payload: {
        audit_id: audit.audit_id,
        schema_hash: definition.schema_hash,
        deployment_id: definition.deployment_id,
      },
      occurred_at: new Date().toISOString(),
    });
  }
  return { consult_id: consultId, definition };
}
