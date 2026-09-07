import { z } from 'zod';

import { withActorContext } from '../../../../lib/actor-context-binding.js';
import { withTransaction, type DbTransaction } from '../../../../lib/db.js';
import { IdempotencyReplayError } from '../../../../lib/idempotency.js';
import { withTenantContext } from '../../../../lib/rls.js';
import type { TenantContext } from '../../../../lib/tenant-context.js';
import { ulid } from '../../../../lib/ulid.js';
import { withDbRole } from '../../../../lib/with-db-role.js';
import { CCR_KEYS, getTenantCountryProfile, resolveCcrKey } from '../../../tenant-config/index.js';
import { emitCareChoiceEvidence } from '../../audit.js';

import {
  CareConsentChoicesSchema,
  CarePolicyProposalSchema,
  CarePolicyTermSchema,
  evaluateCareConsentChoices,
  hashCarePolicy,
} from './care-policy-contract.js';

const id = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/u);
const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const binding = z
  .object({ publication_id: id, policy_hash: hash, development_only: z.boolean() })
  .strict();
const configuredBindings = z.record(
  z.string().regex(/^(general|[0-9A-HJKMNP-TV-Z]{26})$/u),
  binding,
);
export const ResolvedCareConsentSchema = z
  .object({
    publication_id: id,
    policy_hash: hash,
    content: CarePolicyProposalSchema,
  })
  .strict();
export const CareChoiceReceiptSchema = z
  .object({
    publication_id: id,
    policy_hash: hash,
    decisions: z
      .array(
        z
          .object({
            decision_id: id,
            consent_id: id.nullable(),
            term_key: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/u),
            consent_type: z.enum(['platform', 'care', 'jurisdictional', 'data_use']),
            scope_id: z.string().nullable(),
            consent_version_id: id,
            accepted: z.boolean(),
            status: z.enum(['granted', 'revoked', 'declined']),
          })
          .strict(),
      )
      .min(1)
      .max(11),
  })
  .strict();
const CareConsentHistoryItemSchema = z
  .object({
    decision_id: id,
    publication_id: id,
    policy_hash: hash,
    term_key: z.string(),
    consent_type: z.enum(['platform', 'care', 'jurisdictional', 'data_use']),
    scope_id: z.string().nullable(),
    consent_version_id: id,
    accepted: z.boolean(),
    status: z.enum(['granted', 'revoked', 'declined']),
    recorded_at: z.string().datetime({ offset: true }),
    policy_status: z.enum(['published', 'superseded', 'withdrawn']),
    title: z.string().min(1).max(160),
    version_label: z.string(),
    country_of_care: z.string().regex(/^[A-Z]{2}$/u),
    program_id: id.nullable(),
    current_choice: z.boolean(),
    can_withdraw: z.boolean(),
    requires_account_closure: z.boolean(),
  })
  .strict();
const CareConsentDecisionDetailSchema = CareConsentHistoryItemSchema.extend({
  locale: z.string(),
  development_only: z.boolean(),
  term: CarePolicyTermSchema,
});
const CareConsentHistorySchema = z
  .object({
    offset: z.number().int().min(0).max(10000),
    limit: z.literal(25),
    has_more: z.boolean(),
    items: z.array(CareConsentHistoryItemSchema).max(25),
  })
  .strict();
const CareConsentStatusSchema = z
  .object({
    publication_id: id,
    policy_hash: hash,
    required_care_active: z.boolean(),
    ai_interpretation_active: z.boolean(),
    terms: z
      .array(
        z
          .object({ term_key: z.string(), decision_id: id.nullable(), active: z.boolean() })
          .strict(),
      )
      .min(2)
      .max(11),
  })
  .strict();

export interface CareConsentPatientContext {
  tenant: TenantContext;
  accountId: string;
  sessionId: string;
  actorNonce: string;
}

function unavailable(code = 'PT503'): never {
  throw Object.assign(new Error('consent_unavailable'), { code });
}

export async function assertCareConsentPatient(
  tx: DbTransaction,
  ctx: CareConsentPatientContext,
): Promise<void> {
  const result = await withDbRole(tx, 'consent_care_patient', () =>
    tx.query<{ actor: Record<string, unknown> }>(
      'SELECT public.consent_care_live_actor(NULL) AS actor',
    ),
  );
  const actor = result.rows[0]?.actor;
  if (
    actor?.['account_id'] !== ctx.accountId ||
    actor?.['session_id'] !== ctx.sessionId ||
    actor?.['tenant_id'] !== ctx.tenant.tenantId ||
    actor?.['country_of_care'] !== ctx.tenant.countryOfCare
  )
    unavailable('PT401');
}

/** Includes cache reservation/replay/completion and outbox work in the live boundary. */
export function careConsentTransaction(ctx: CareConsentPatientContext): typeof withTransaction {
  return <T>(work: (tx: DbTransaction) => Promise<T>): Promise<T> =>
    withTransaction((tx) =>
      withTenantContext(tx, ctx.tenant.tenantId, () =>
        withActorContext(tx, ctx.actorNonce, async () => {
          await tx.query("SET LOCAL statement_timeout='5s'");
          await tx.query("SET LOCAL lock_timeout='2s'");
          await assertCareConsentPatient(tx, ctx);
          let result: T;
          try {
            result = await work(tx);
          } catch (error) {
            if (error instanceof IdempotencyReplayError) await assertCareConsentPatient(tx, ctx);
            throw error;
          }
          await assertCareConsentPatient(tx, ctx);
          await tx.query('SET CONSTRAINTS consent_care_choice_evidence IMMEDIATE');
          await assertCareConsentPatient(tx, ctx);
          return result;
        }),
      ),
    );
}

/** Caller supplies an already bound transaction; a policy ID is never a selector. */
export async function resolveCareConsentInTransaction(
  tx: DbTransaction,
  ctx: CareConsentPatientContext,
  programId: string | null,
) {
  await assertCareConsentPatient(tx, ctx);
  const configured = configuredBindings.safeParse(
    await resolveCcrKey(ctx.tenant, CCR_KEYS.CONSENT_CARE_POLICY_PUBLICATIONS, tx),
  );
  if (!configured.success) unavailable();
  const selected = configured.data[programId ?? 'general'];
  if (!selected || (process.env['NODE_ENV'] === 'production' && selected.development_only))
    unavailable();
  const profile = await getTenantCountryProfile(ctx.tenant, tx);
  const result = await withDbRole(tx, 'consent_care_patient', () =>
    tx.query<{ result: unknown }>('SELECT public.consent_care_resolve_policy($1) AS result', [
      programId,
    ]),
  );
  const view = ResolvedCareConsentSchema.parse(result.rows[0]?.result);
  if (
    view.publication_id !== selected.publication_id ||
    view.policy_hash !== selected.policy_hash ||
    hashCarePolicy(view.content) !== view.policy_hash ||
    view.content.country_of_care !== ctx.tenant.countryOfCare ||
    view.content.locale !== profile?.default_locale ||
    view.content.program_id !== programId ||
    view.content.development_only !== selected.development_only
  )
    unavailable();
  await assertCareConsentPatient(tx, ctx);
  return view;
}

export async function recordCareConsentChoices(
  tx: DbTransaction,
  ctx: CareConsentPatientContext,
  programId: string | null,
  input: unknown,
) {
  const body = CareConsentChoicesSchema.parse(input);
  const policy = await resolveCareConsentInTransaction(tx, ctx, programId);
  if (body.publication_id !== policy.publication_id) unavailable('PT409');
  evaluateCareConsentChoices(policy.content, body);
  const result = await withDbRole(tx, 'consent_care_patient', () =>
    tx.query<{ result: unknown }>(
      'SELECT public.consent_care_record_choices($1,$2,$3,$4::jsonb,$5::jsonb) AS result',
      [
        programId,
        body.publication_id,
        body.policy_hash,
        JSON.stringify(body.choices),
        JSON.stringify(body.choices.map(() => ({ decision_id: ulid(), consent_id: ulid() }))),
      ],
    ),
  );
  const receipt = CareChoiceReceiptSchema.parse(result.rows[0]?.result);
  for (const decision of receipt.decisions)
    await emitCareChoiceEvidence(
      {
        tenantId: ctx.tenant.tenantId,
        accountId: ctx.accountId,
        countryOfCare: ctx.tenant.countryOfCare,
        publicationId: receipt.publication_id,
        policyHash: receipt.policy_hash,
        decision,
      },
      tx,
    );
  return receipt;
}

export async function listCareConsentHistory(
  tx: DbTransaction,
  ctx: CareConsentPatientContext,
  offset: number,
) {
  await assertCareConsentPatient(tx, ctx);
  const result = await withDbRole(tx, 'consent_care_patient', () =>
    tx.query<{ result: unknown }>('SELECT public.consent_care_history($1) AS result', [offset]),
  );
  const view = CareConsentHistorySchema.parse(result.rows[0]?.result);
  await assertCareConsentPatient(tx, ctx);
  return view;
}

export async function getCareConsentDecisionDetail(
  tx: DbTransaction,
  ctx: CareConsentPatientContext,
  decisionId: string,
) {
  await assertCareConsentPatient(tx, ctx);
  const result = await withDbRole(tx, 'consent_care_patient', () =>
    tx.query<{ result: unknown }>('SELECT public.consent_care_decision_detail($1) AS result', [
      decisionId,
    ]),
  );
  const view = CareConsentDecisionDetailSchema.parse(result.rows[0]?.result);
  if (
    view.country_of_care !== ctx.tenant.countryOfCare ||
    view.term.key !== view.term_key ||
    view.term.consent_type !== view.consent_type ||
    view.term.scope_id !== view.scope_id ||
    view.term.title !== view.title ||
    view.term.version_label !== view.version_label
  )
    unavailable();
  await assertCareConsentPatient(tx, ctx);
  return view;
}

export async function getCareConsentStatus(
  tx: DbTransaction,
  ctx: CareConsentPatientContext,
  programId: string | null,
) {
  const resolved = await resolveCareConsentInTransaction(tx, ctx, programId);
  const result = await withDbRole(tx, 'consent_care_patient', () =>
    tx.query<{ result: unknown }>('SELECT public.consent_care_status($1) AS result', [programId]),
  );
  const view = CareConsentStatusSchema.parse(result.rows[0]?.result);
  if (view.publication_id !== resolved.publication_id || view.policy_hash !== resolved.policy_hash)
    unavailable('PT409');
  await assertCareConsentPatient(tx, ctx);
  return view;
}

export async function withdrawCareConsent(
  tx: DbTransaction,
  ctx: CareConsentPatientContext,
  decisionId: string,
) {
  await assertCareConsentPatient(tx, ctx);
  const result = await withDbRole(tx, 'consent_care_patient', () =>
    tx.query<{ result: unknown }>('SELECT public.consent_care_withdraw($1,$2,$3) AS result', [
      decisionId,
      ulid(),
      ulid(),
    ]),
  );
  const receipt = CareChoiceReceiptSchema.parse(result.rows[0]?.result);
  for (const decision of receipt.decisions)
    await emitCareChoiceEvidence(
      {
        tenantId: ctx.tenant.tenantId,
        accountId: ctx.accountId,
        countryOfCare: ctx.tenant.countryOfCare,
        publicationId: receipt.publication_id,
        policyHash: receipt.policy_hash,
        decision,
      },
      tx,
    );
  return receipt;
}
