import { randomUUID } from 'node:crypto';

import { emitAudit, type AuditAction } from '../../../lib/audit.js';
import type { DbTransaction } from '../../../lib/db.js';
import { emitDomainEvent } from '../../../lib/domain-events.js';
import { ulid } from '../../../lib/ulid.js';
import { asAccountId, findAccountById } from '../../identity/index.js';
import { resolveCurrencyCode, resolvePaymentProcessor } from '../../tenant-config/index.js';

import { mockConfirmation, openConfirmation, sealConfirmation } from './confirmation.js';
import { billingTransaction } from './database.js';
import { resolveProviderConfig } from './provider-config.js';
import {
  assertObservation,
  createProviderIntent,
  fingerprint,
  mockSignedObservation,
  verifyWebhook,
} from './providers.js';
import {
  BillingError,
  type BillingActor,
  type Confirmation,
  type ConsultSelection,
  type PaymentIntent,
  type Price,
  type ProviderObservation,
} from './types.js';

const intentSql = `SELECT p.*, i.id AS payment_id, i.patient_id, i.quote_id, i.request_hash,i.initiation_source,
  i.provider_reference,i.provider_object_id,i.status,i.lease_token,i.lease_expires_at,i.accepted_at,
  i.provider_created_at,i.verified_at,i.confirmation_ciphertext,i.confirmation_dek_id,i.confirmation_iv,i.confirmation_tag,
  i.confirmation_alg,i.confirmation_alg_version,i.confirmation_aad,i.confirmation_encrypted_at FROM public.billing_payment_intent i
  JOIN public.billing_consult_price p ON (p.tenant_id,p.id) = (i.tenant_id,i.price_id)`;
async function audit(
  tx: DbTransaction,
  tenant: string,
  country: string,
  patient: string | null,
  resource: string,
  action: AuditAction,
  detail: Record<string, unknown>,
  actor?: BillingActor,
): Promise<void> {
  await emitAudit(
    {
      timestamp: new Date().toISOString(),
      tenant_id: tenant as BillingActor['context']['tenantId'],
      actor_type: actor ? (actor.role === 'patient' ? 'patient' : 'operator') : 'system',
      actor_id: actor?.accountId ?? 'billing_service',
      actor_tenant_id: tenant,
      target_patient_id: patient,
      delegate_context: null,
      action,
      category: action === 'billing.price_published' ? 'B' : 'C',
      audit_sensitivity_level: 'standard',
      resource_type: 'billing_payment_intent',
      resource_id: resource,
      detail,
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
      country_of_care: country,
      break_glass: null,
    },
    tx,
  );
}
function patient(actor: BillingActor): void {
  if (actor.role !== 'patient') throw new BillingError('billing.actor_unavailable', 403);
}
async function configured(actor: BillingActor, tx: DbTransaction) {
  const provider = await resolvePaymentProcessor(actor.context, tx);
  const currency = await resolveCurrencyCode(actor.context, tx);
  if (!provider || !currency || !/^[A-Z]{3}$/.test(currency))
    throw new BillingError('billing.configuration_unavailable');
  return { adapter: resolveProviderConfig(actor.context.tenantId, provider), currency };
}
function assertConfig(price: Price): void {
  const config = resolveProviderConfig(price.tenant_id, price.provider);
  if (config.account !== price.provider_account || config.mode !== price.provider_mode)
    throw new BillingError('billing.configuration_changed', 409);
}
export interface PublishPriceInput extends ConsultSelection {
  version: number;
  amount_minor: number;
  turnaround_minutes: number;
  quote_ttl_seconds: number;
}
export async function publishConsultPrice(
  actor: BillingActor,
  input: PublishPriceInput,
): Promise<Price> {
  if (actor.role !== 'tenant_admin') throw new BillingError('billing.actor_unavailable', 403);
  return billingTransaction(
    actor.context.tenantId,
    async (tx) => {
      const conf = await configured(actor, tx);
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        `billing_price:${actor.context.tenantId}:${input.consult_type}:${input.program_id ?? ''}`,
      ]);
      const prior = (
        await tx.query<Price>(
          'SELECT * FROM public.billing_consult_price WHERE tenant_id=$1 AND consult_type=$2 AND program_id IS NOT DISTINCT FROM $3 ORDER BY version DESC LIMIT 1',
          [actor.context.tenantId, input.consult_type, input.program_id],
        )
      ).rows[0];
      if (prior?.version === input.version) {
        if (
          prior.amount_minor !== input.amount_minor ||
          prior.turnaround_minutes !== input.turnaround_minutes ||
          prior.quote_ttl_seconds !== input.quote_ttl_seconds ||
          prior.provider !== conf.adapter.provider ||
          prior.provider_account !== conf.adapter.account ||
          prior.provider_mode !== conf.adapter.mode ||
          prior.currency !== conf.currency
        )
          throw new BillingError('billing.price_version_conflict', 409);
        return prior;
      }
      if (input.version !== (prior?.version ?? 0) + 1)
        throw new BillingError('billing.price_version_conflict', 409);
      const id = ulid();
      const result = await tx.query<Price>(
        `INSERT INTO public.billing_consult_price(id,tenant_id,country_of_care,consult_type,program_id,version,amount_minor,currency,provider,provider_account,provider_mode,turnaround_minutes,quote_ttl_seconds,refund_policy,published_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'full_before_review_or_decline_v1',$14) RETURNING *`,
        [
          id,
          actor.context.tenantId,
          actor.context.countryOfCare,
          input.consult_type,
          input.program_id,
          input.version,
          input.amount_minor,
          conf.currency,
          conf.adapter.provider,
          conf.adapter.account,
          conf.adapter.mode,
          input.turnaround_minutes,
          input.quote_ttl_seconds,
          actor.accountId,
        ],
      );
      await audit(
        tx,
        actor.context.tenantId,
        actor.context.countryOfCare,
        null,
        id,
        'billing.price_published',
        {
          version: input.version,
          amount_minor: input.amount_minor,
          currency: conf.currency,
          provider: conf.adapter.provider,
          mode: conf.adapter.mode,
        },
        actor,
      );
      return result.rows[0]!;
    },
    actor,
  );
}
export async function quoteConsult(actor: BillingActor, selection: ConsultSelection, key: string) {
  patient(actor);
  return billingTransaction(
    actor.context.tenantId,
    async (tx) => {
      const conf = await configured(actor, tx);
      const operation = fingerprint(`quote:${key}`);
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        `billing_quote:${actor.context.tenantId}:${actor.accountId}:${operation}`,
      ]);
      const old = (
        await tx.query<Price & { quote_id: string; expires_at: Date }>(
          `SELECT p.*,q.id AS quote_id,q.expires_at FROM public.billing_consult_quote q JOIN public.billing_consult_price p ON (p.tenant_id,p.id)=(q.tenant_id,q.price_id) WHERE q.tenant_id=$1 AND q.patient_id=$2 AND q.operation_key=$3`,
          [actor.context.tenantId, actor.accountId, operation],
        )
      ).rows[0];
      if (old) {
        if (old.consult_type !== selection.consult_type || old.program_id !== selection.program_id)
          throw new BillingError('billing.idempotency_mismatch', 409);
        return quoteView(old, old.quote_id, old.expires_at);
      }
      const price = (
        await tx.query<Price>(
          'SELECT * FROM public.billing_consult_price WHERE tenant_id=$1 AND consult_type=$2 AND program_id IS NOT DISTINCT FROM $3 ORDER BY version DESC LIMIT 1',
          [actor.context.tenantId, selection.consult_type, selection.program_id],
        )
      ).rows[0];
      if (!price) throw new BillingError('billing.price_unavailable', 409);
      if (price.currency !== conf.currency)
        throw new BillingError('billing.configuration_changed', 409);
      assertConfig(price);
      const id = ulid();
      const q = await tx.query<{ expires_at: Date }>(
        `INSERT INTO public.billing_consult_quote(id,tenant_id,patient_id,price_id,operation_key,created_at,expires_at) VALUES($1,$2,$3,$4,$5,statement_timestamp(),statement_timestamp()+$6*interval '1 second') RETURNING expires_at`,
        [id, actor.context.tenantId, actor.accountId, price.id, operation, price.quote_ttl_seconds],
      );
      return quoteView(price, id, q.rows[0]!.expires_at);
    },
    actor,
  );
}
function quoteView(p: Price, id: string, expires: Date) {
  return {
    quote_id: id,
    pricing_version: p.version,
    amount_minor: p.amount_minor,
    currency: p.currency,
    provider: p.provider,
    mode: p.provider_mode,
    expires_at: expires.toISOString(),
    expected_turnaround_minutes: p.turnaround_minutes,
    refund_policy: p.refund_policy,
    consult_type: p.consult_type,
    program_id: p.program_id,
  };
}
export interface ConsultPaymentInput extends ConsultSelection {
  accepted_quote_id: string;
  initiation_source: string;
}
type PaymentReservation = { intent: PaymentIntent; create: boolean };

export async function listConsultPayments(actor: BillingActor, offset: number) {
  patient(actor);
  if (!Number.isInteger(offset) || offset < 0 || offset > 10000)
    throw new BillingError('billing.page_invalid', 400);
  return billingTransaction(
    actor.context.tenantId,
    async (tx) => {
      const result = await tx.query<{ page: Record<string, unknown> }>(
        'SELECT public.billing_patient_consult_payments($1) AS page',
        [offset],
      );
      if (!result.rows[0]?.page) throw new BillingError('billing.persistence_unavailable');
      return result.rows[0].page;
    },
    actor,
  );
}

/** Caller holds the original operation's reservation lock. No new price or intent. */
async function reserveExistingPayment(
  tx: DbTransaction,
  actor: BillingActor,
  prior: PaymentIntent,
): Promise<PaymentReservation> {
  assertConfig(prior);
  if (['requires_payment', 'paid', 'refund_pending', 'refunded'].includes(prior.status))
    return { intent: prior, create: false };
  if (prior.status === 'cancelled' || prior.status === 'failed')
    throw new BillingError('billing.payment_unavailable', 409);
  if (prior.lease_expires_at && prior.lease_expires_at.getTime() > Date.now())
    throw new BillingError('billing.creation_in_flight', 409);
  const lease = randomUUID();
  await tx.query(
    "UPDATE public.billing_payment_intent SET status='creation_unknown',lease_token=$3,lease_expires_at=clock_timestamp()+interval '30 seconds' WHERE tenant_id=$1 AND id=$2",
    [actor.context.tenantId, prior.payment_id, lease],
  );
  return { intent: { ...prior, status: 'creation_unknown', lease_token: lease }, create: true };
}

/** Resume the patient's existing accepted reservation even after a browser reload. */
export async function resumeConsultPayment(
  actor: BillingActor,
  paymentId: string,
): Promise<PaymentIntent> {
  patient(actor);
  const reserved = await billingTransaction(
    actor.context.tenantId,
    async (tx) => {
      const operation = (
        await tx.query<{ operation_key: string }>(
          "SELECT operation_key FROM public.billing_payment_intent WHERE tenant_id=$1 AND id=$2 AND patient_id=$3 AND purpose='async_consult'",
          [actor.context.tenantId, paymentId, actor.accountId],
        )
      ).rows[0]?.operation_key;
      if (!operation) throw new BillingError('billing.payment_unavailable', 404);
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        `billing_reserve:${actor.context.tenantId}:${actor.accountId}:${operation}`,
      ]);
      const prior = (
        await tx.query<PaymentIntent>(
          intentSql +
            " WHERE i.tenant_id=$1 AND i.id=$2 AND i.patient_id=$3 AND i.purpose='async_consult'",
          [actor.context.tenantId, paymentId, actor.accountId],
        )
      ).rows[0];
      if (!prior || prior.country_of_care !== actor.context.countryOfCare)
        throw new BillingError('billing.payment_unavailable', 404);
      if (['failed', 'cancelled', 'refund_pending', 'refunded'].includes(prior.status))
        throw new BillingError('billing.payment_unavailable', 409);
      return reserveExistingPayment(tx, actor, prior);
    },
    actor,
  );
  return completeReservedPayment(actor, reserved);
}

export async function ensureConsultPayment(
  actor: BillingActor,
  input: ConsultPaymentInput,
  key: string,
): Promise<PaymentIntent> {
  patient(actor);
  const operation = fingerprint(`async-consult:${key}`);
  const hash = fingerprint(
    JSON.stringify([
      input.consult_type,
      input.program_id,
      input.initiation_source,
      input.accepted_quote_id,
    ]),
  );
  const reserved = await billingTransaction(
    actor.context.tenantId,
    async (tx) => {
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        `billing_reserve:${actor.context.tenantId}:${actor.accountId}:${operation}`,
      ]);
      const prior = (
        await tx.query<PaymentIntent>(
          intentSql + ' WHERE i.tenant_id=$1 AND i.patient_id=$2 AND i.operation_key=$3',
          [actor.context.tenantId, actor.accountId, operation],
        )
      ).rows[0];
      if (prior) {
        if (prior.request_hash !== hash)
          throw new BillingError('billing.idempotency_mismatch', 409);
        return reserveExistingPayment(tx, actor, prior);
      }
      const conf = await configured(actor, tx);
      const quote = (
        await tx.query<Price>(
          `SELECT p.* FROM public.billing_consult_quote q JOIN public.billing_consult_price p ON (p.tenant_id,p.id)=(q.tenant_id,q.price_id)
      WHERE q.tenant_id=$1 AND q.id=$2 AND q.patient_id=$3 AND q.expires_at>clock_timestamp()
      AND p.consult_type=$4 AND p.program_id IS NOT DISTINCT FROM $5
      AND NOT EXISTS(SELECT 1 FROM public.billing_consult_price newer WHERE newer.tenant_id=p.tenant_id AND newer.consult_type=p.consult_type AND newer.program_id IS NOT DISTINCT FROM p.program_id AND newer.version>p.version)`,
          [
            actor.context.tenantId,
            input.accepted_quote_id,
            actor.accountId,
            input.consult_type,
            input.program_id,
          ],
        )
      ).rows[0];
      if (!quote || quote.currency !== conf.currency)
        throw new BillingError('billing.quote_reacceptance_required', 409);
      assertConfig(quote);
      if (
        (
          await tx.query(
            'SELECT id FROM public.billing_payment_intent WHERE tenant_id=$1 AND quote_id=$2',
            [actor.context.tenantId, input.accepted_quote_id],
          )
        ).rowCount
      )
        throw new BillingError('billing.quote_already_used', 409);
      const id = ulid();
      const lease = randomUUID();
      await tx.query(
        `INSERT INTO public.billing_payment_intent(id,tenant_id,patient_id,purpose,quote_id,price_id,operation_key,request_hash,initiation_source,provider_reference,status,lease_token,lease_expires_at)
      VALUES($1,$2,$3,'async_consult',$4,$5,$6,$7,$8,$9,'creating',$10,clock_timestamp()+interval '30 seconds')`,
        [
          id,
          actor.context.tenantId,
          actor.accountId,
          input.accepted_quote_id,
          quote.id,
          operation,
          hash,
          input.initiation_source,
          `tc-${id}`,
          lease,
        ],
      );
      const intent = (
        await tx.query<PaymentIntent>(intentSql + ' WHERE i.tenant_id=$1 AND i.id=$2', [
          actor.context.tenantId,
          id,
        ])
      ).rows[0]!;
      await audit(
        tx,
        actor.context.tenantId,
        actor.context.countryOfCare,
        actor.accountId,
        id,
        'billing.payment_intent_reserved',
        {
          quote_id: input.accepted_quote_id,
          pricing_version: quote.version,
          amount_minor: quote.amount_minor,
          currency: quote.currency,
          mode: quote.provider_mode,
        },
        actor,
      );
      return { intent, create: true };
    },
    actor,
  );
  return completeReservedPayment(actor, reserved);
}

async function completeReservedPayment(
  actor: BillingActor,
  reserved: PaymentReservation,
): Promise<PaymentIntent> {
  if (!reserved.create) return reserved.intent;
  const intent = reserved.intent;
  try {
    const account =
      intent.provider === 'paystack'
        ? await findAccountById(actor.context, asAccountId(actor.accountId))
        : null;
    const created = await createProviderIntent(
      resolveProviderConfig(actor.context.tenantId, intent.provider),
      intent,
      account?.email ?? null,
    );
    return await billingTransaction(
      actor.context.tenantId,
      async (tx) => {
        // The original real patient still authorizes financial encryption. If
        // crypto/authority fails after provider acceptance, retain uncertainty.
        // No fake worker session is created to make this write succeed.
        const envelope =
          created.confirmation && intent.provider !== 'mock_local_dev'
            ? await sealConfirmation(tx, intent, created.confirmation)
            : null;
        const result = await tx.query(
          `UPDATE public.billing_payment_intent SET provider_object_id=$4,provider_created_at=COALESCE(provider_created_at,clock_timestamp()),status='requires_payment',confirmation_ciphertext=$5,
          confirmation_dek_id=$6,confirmation_iv=$7,confirmation_tag=$8,confirmation_alg=$9,confirmation_alg_version=$10,confirmation_aad=$11,confirmation_encrypted_at=$12,
          lease_token=NULL,lease_expires_at=NULL,last_failure_code=NULL WHERE tenant_id=$1 AND id=$2 AND lease_token=$3 AND lease_expires_at>clock_timestamp() AND status IN ('creating','creation_unknown') RETURNING id`,
          [
            actor.context.tenantId,
            intent.payment_id,
            intent.lease_token,
            created.objectId,
            envelope?.ciphertext ?? null,
            envelope?.dekId ?? null,
            envelope?.iv ?? null,
            envelope?.tag ?? null,
            envelope?.alg ?? null,
            envelope?.algVersion ?? null,
            envelope?.aad ?? null,
            envelope?.encryptedAt ?? null,
          ],
        );
        if (!result.rowCount) throw new BillingError('billing.creation_superseded', 409);
        if (created.paid)
          await applyObservation(
            tx,
            { ...intent, provider_object_id: created.objectId },
            created.paid,
            fingerprint(JSON.stringify(created.paid)),
          );
        return (
          await tx.query<PaymentIntent>(intentSql + ' WHERE i.tenant_id=$1 AND i.id=$2', [
            actor.context.tenantId,
            intent.payment_id,
          ])
        ).rows[0]!;
      },
      actor,
    );
  } catch (error) {
    // Persist uncertainty even if the originating session was revoked while the
    // provider ran. This is operational evidence, never renewed user authority.
    await billingTransaction(actor.context.tenantId, async (tx) => {
      await tx.query(
        "UPDATE public.billing_payment_intent SET status='creation_unknown',lease_token=NULL,lease_expires_at=NULL,last_failure_code='creation_unknown' WHERE tenant_id=$1 AND id=$2 AND lease_token=$3 AND status IN ('creating','creation_unknown')",
        [actor.context.tenantId, intent.payment_id, intent.lease_token],
      );
    }).catch(() => undefined);
    if (error instanceof BillingError && error.statusCode === 403) throw error;
    throw new BillingError('billing.creation_unknown', 503);
  }
}
async function applyObservation(
  tx: DbTransaction,
  intent: PaymentIntent,
  observation: ProviderObservation,
  hash: string,
): Promise<void> {
  assertObservation(intent, observation);
  const existing = await tx.query<{ payload_hash: string }>(
    'SELECT payload_hash FROM public.billing_provider_event WHERE tenant_id=$1 AND provider=$2 AND provider_account=$3 AND event_id=$4',
    [intent.tenant_id, intent.provider, intent.provider_account, observation.eventId],
  );
  if (existing.rows[0]) {
    if (existing.rows[0].payload_hash !== hash)
      throw new BillingError('billing.webhook_event_conflict', 409);
    return;
  }
  await tx.query(
    'INSERT INTO public.billing_provider_event(tenant_id,provider,provider_account,event_id,intent_id,event_type,payload_hash) VALUES($1,$2,$3,$4,$5,$6,$7)',
    [
      intent.tenant_id,
      intent.provider,
      intent.provider_account,
      observation.eventId,
      intent.payment_id,
      observation.type,
      hash,
    ],
  );
  if (
    observation.type === 'paid' &&
    !['paid', 'refund_pending', 'refunded', 'cancelled'].includes(intent.status)
  ) {
    await tx.query(
      "UPDATE public.billing_payment_intent SET status='paid',provider_object_id=COALESCE(provider_object_id,$3),provider_created_at=COALESCE(provider_created_at,clock_timestamp()),verified_at=COALESCE(verified_at,clock_timestamp()),lease_token=NULL,lease_expires_at=NULL WHERE tenant_id=$1 AND id=$2",
      [intent.tenant_id, intent.payment_id, observation.objectId],
    );
    await audit(
      tx,
      intent.tenant_id,
      intent.country_of_care,
      intent.patient_id,
      intent.payment_id,
      'payment_processed',
      {
        amount_minor: intent.amount_minor,
        currency: intent.currency,
        provider: intent.provider,
        mode: intent.provider_mode,
      },
    );
    await emitDomainEvent(tx, {
      tenant_id: intent.tenant_id,
      aggregate_type: 'billing_payment_intent',
      aggregate_id: intent.payment_id,
      event_type: 'billing.payment_completed.v1',
      payload: {
        payment_intent_id: intent.payment_id,
        patient_id: intent.patient_id,
        amount_minor: intent.amount_minor,
        currency: intent.currency,
        mode: intent.provider_mode,
      },
      occurred_at: new Date().toISOString(),
    });
  } else if (
    ['failed', 'cancelled'].includes(observation.type) &&
    !['paid', 'refund_pending', 'refunded', 'cancelled'].includes(intent.status)
  ) {
    // A declined Stripe attempt does not destroy its PaymentIntent. The same
    // confirmation may be retried; only an explicit cancellation is terminal.
    await tx.query(
      "UPDATE public.billing_payment_intent SET status=$3,last_failure_code='provider_rejected' WHERE tenant_id=$1 AND id=$2",
      [
        intent.tenant_id,
        intent.payment_id,
        observation.type === 'failed' ? 'requires_payment' : 'cancelled',
      ],
    );
    await audit(
      tx,
      intent.tenant_id,
      intent.country_of_care,
      intent.patient_id,
      intent.payment_id,
      'payment_failed',
      { provider: intent.provider, mode: intent.provider_mode, status: observation.type },
    );
  }
  await tx.query('SELECT public.billing_apply_verified_payment($1,$2)', [
    intent.payment_id,
    ulid(),
  ]);
}
export async function receiveProviderWebhook(
  tenantId: string,
  provider: string,
  bytes: Buffer,
  headers: Record<string, unknown>,
): Promise<void> {
  const config = resolveProviderConfig(tenantId, provider);
  const observation = verifyWebhook(config, bytes, headers);
  if (!observation) return;
  await billingTransaction(tenantId, async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock(('x'||substr(md5($1),1,16))::bit(64)::bigint)", [
      `billing_intent:${tenantId}:${observation.paymentId}`,
    ]);
    const intent = (
      await tx.query<PaymentIntent>(intentSql + ' WHERE i.tenant_id=$1 AND i.id=$2', [
        tenantId,
        observation.paymentId,
      ])
    ).rows[0];
    if (!intent || intent.provider !== provider)
      throw new BillingError('billing.payment_unavailable', 404);
    await applyObservation(tx, intent, observation, fingerprint(bytes));
  });
}
export async function paymentConfirmation(actor: BillingActor, id: string): Promise<Confirmation> {
  patient(actor);
  return billingTransaction(
    actor.context.tenantId,
    async (tx) => {
      const intent = (
        await tx.query<PaymentIntent>(
          intentSql + ' WHERE i.tenant_id=$1 AND i.id=$2 AND i.patient_id=$3',
          [actor.context.tenantId, id, actor.accountId],
        )
      ).rows[0];
      if (!intent) throw new BillingError('billing.payment_unavailable', 404);
      assertConfig(intent);
      if (['paid', 'refund_pending', 'refunded'].includes(intent.status)) {
        await tx.query('SELECT public.billing_apply_verified_payment($1,$2)', [id, ulid()]);
        return {
          kind: 'complete',
          status: intent.status as 'paid' | 'refund_pending' | 'refunded',
        };
      }
      if (intent.status !== 'requires_payment')
        throw new BillingError('billing.confirmation_unavailable', 409);
      // Classified decryption/audit precedes any business advisory lock. After
      // crypto, serialize with callbacks and re-read terminal state before release.
      const confirmation =
        intent.provider === 'mock_local_dev'
          ? mockConfirmation(intent)
          : await openConfirmation(tx, intent);
      await tx.query("SELECT pg_advisory_xact_lock(('x'||substr(md5($1),1,16))::bit(64)::bigint)", [
        `billing_intent:${actor.context.tenantId}:${id}`,
      ]);
      const latest = (
        await tx.query<{ status: PaymentIntent['status'] }>(
          'SELECT status FROM public.billing_payment_intent WHERE tenant_id=$1 AND id=$2',
          [actor.context.tenantId, id],
        )
      ).rows[0];
      if (latest?.status === 'requires_payment') return confirmation;
      if (latest && ['paid', 'refund_pending', 'refunded'].includes(latest.status)) {
        await tx.query('SELECT public.billing_apply_verified_payment($1,$2)', [id, ulid()]);
        return {
          kind: 'complete',
          status: latest.status as 'paid' | 'refund_pending' | 'refunded',
        };
      }
      throw new BillingError('billing.confirmation_unavailable', 409);
    },
    actor,
  );
}
export async function reconcileConsultPayment(actor: BillingActor, id: string): Promise<void> {
  patient(actor);
  await billingTransaction(
    actor.context.tenantId,
    async (tx) => {
      const intent = (
        await tx.query<PaymentIntent>(
          intentSql + ' WHERE i.tenant_id=$1 AND i.id=$2 AND i.patient_id=$3',
          [actor.context.tenantId, id, actor.accountId],
        )
      ).rows[0];
      if (!intent) throw new BillingError('billing.payment_unavailable', 404);
      await tx.query('SELECT public.billing_apply_verified_payment($1,$2)', [id, ulid()]);
    },
    actor,
  );
}
export async function confirmMockPayment(actor: BillingActor, id: string): Promise<void> {
  patient(actor);
  const signed = await billingTransaction(
    actor.context.tenantId,
    async (tx) => {
      const intent = (
        await tx.query<PaymentIntent>(
          intentSql + ' WHERE i.tenant_id=$1 AND i.id=$2 AND i.patient_id=$3',
          [actor.context.tenantId, id, actor.accountId],
        )
      ).rows[0];
      if (!intent || !['requires_payment', 'paid'].includes(intent.status))
        throw new BillingError('billing.payment_unavailable', 404);
      return mockSignedObservation(
        resolveProviderConfig(actor.context.tenantId, 'mock_local_dev'),
        intent,
      );
    },
    actor,
  );
  await receiveProviderWebhook(
    actor.context.tenantId,
    'mock_local_dev',
    signed.bytes,
    signed.headers,
  );
  await reconcileConsultPayment(actor, id);
}
