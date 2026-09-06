/** Executable synthetic acceptance: real HTTP and isolated PostgreSQL logins. */
import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';

import pg from 'pg';

import { buildApp } from '../src/app.js';
import { bindActorContextForRequest } from '../src/lib/actor-context-binding.js';
import { closePool, closeBindActorContextPool } from '../src/lib/db.js';
import { asTenantId } from '../src/lib/glossary.js';
import { issueAccessToken, verifyAccessToken } from '../src/lib/jwt.js';
import { ulid } from '../src/lib/ulid.js';
import { closeBillingPool } from '../src/modules/billing/internal/database.js';

assert.equal(process.env['NODE_ENV'], 'development');
assert.equal(process.env['BILLING_ALLOW_MOCK'], 'true');
const setup = new pg.Client({ connectionString: process.env['BILLING_TEST_SETUP_DATABASE_URL'] });
const ordinary = new pg.Client({ connectionString: process.env['DATABASE_URL'] });
const binder = new pg.Client({ connectionString: process.env['BIND_ACTOR_CONTEXT_DATABASE_URL'] });
await setup.connect();
await ordinary.connect();
await binder.connect();
const app = await buildApp({ logger: false });
const evidence: string[] = [];
async function register(host: string) {
  const email = `billing-runtime-${randomUUID()}@example.invalid`;
  const start = await app.inject({
    method: 'POST',
    url: '/v0/identity/registration/email/start',
    headers: { host, 'idempotency-key': ulid() },
    payload: { email },
  });
  assert.equal(start.statusCode, 200, 'registration start');
  const verified = await app.inject({
    method: 'POST',
    url: '/v0/identity/registration/email/verify',
    headers: { host, 'idempotency-key': ulid() },
    payload: {
      email,
      passcode: start.json<{ dev_passcode: string }>().dev_passcode,
      pin: '583926',
      first_name: 'Synthetic',
      last_name: 'Billing',
      date_of_birth: '1990-01-01',
      gender: 'prefer_not_to_say',
    },
  });
  assert.equal(verified.statusCode, 201, 'registration verify');
  const session = verified.json<{ access_token: string; refresh_token: string }>();
  const token = verifyAccessToken(session.access_token, process.env['JWT_SIGNING_KEY']!);
  assert.ok(token.ok);
  return {
    headers: { host, authorization: `Bearer ${session.access_token}` },
    claims: token.claims,
    ...session,
  };
}
async function post(
  url: string,
  headers: Record<string, string>,
  payload: Record<string, unknown>,
  key = ulid(),
) {
  return app.inject({
    method: 'POST',
    url,
    headers: { ...headers, 'idempotency-key': key },
    payload,
  });
}
async function providerFailureProbes(
  host: string,
  tenant: string,
  adminHeaders: Record<string, string>,
  version: number,
) {
  // Only the external Stripe HTTP boundary is controlled here. Every local
  // reservation, retry, role check, transaction and consult uses the real API/DB.
  const originalFetch = globalThis.fetch;
  const originalRegistry = process.env['BILLING_PROVIDERS_JSON']!;
  const registry = JSON.parse(originalRegistry) as Record<string, unknown>;
  process.env['BILLING_ACCEPTANCE_STRIPE_SECRET'] =
    'sk_test_synthetic_acceptance_no_provider_account';
  process.env['BILLING_ACCEPTANCE_STRIPE_WEBHOOK'] =
    'whsec_synthetic_acceptance_no_provider_account';
  registry[tenant] = {
    provider: 'stripe',
    mode: 'sandbox',
    account: 'acct_synthetic_acceptance',
    secret_env: 'BILLING_ACCEPTANCE_STRIPE_SECRET',
    webhook_secret_env: 'BILLING_ACCEPTANCE_STRIPE_WEBHOOK',
    publishable_key: 'pk_test_synthetic_acceptance',
    return_url: 'https://example.invalid/care',
  };
  process.env['BILLING_PROVIDERS_JSON'] = JSON.stringify(registry);
  await setup.query(
    "UPDATE public.ccr_configs SET config_value='\"stripe\"'::jsonb WHERE tenant_id=$1 AND config_key='payment.processor'",
    [tenant],
  );
  try {
    assert.equal(
      (
        await post('/v1/billing/consult-prices', adminHeaders, {
          consult_type: 'general',
          version,
          amount_minor: 5100,
          turnaround_minutes: 60,
          quote_ttl_seconds: 600,
        })
      ).statusCode,
      201,
    );
    for (const fault of ['response_lost', 'persistence_failed', 'session_revoked'] as const) {
      const patient = await register(host);
      const quote = await post('/v1/billing/consult-quotes', patient.headers, {
        consult_type: 'general',
      });
      assert.equal(quote.statusCode, 201);
      const quoteId = quote.json<{ quote_id: string }>().quote_id;
      const body = {
        consult_type: 'general',
        initiation_source: 'care_tab',
        accepted_quote_id: quoteId,
      };
      const key = ulid();
      const ledger = new Map<string, Record<string, unknown>>();
      let calls = 0;
      globalThis.fetch = async (url, options) => {
        assert.equal(url, 'https://api.stripe.com/v1/payment_intents');
        assert.equal(options?.method, 'POST');
        const headers = new Headers(options?.headers);
        assert.equal(headers.get('stripe-account'), 'acct_synthetic_acceptance');
        const reference = headers.get('idempotency-key')!;
        assert.ok(reference.startsWith('tc-'));
        assert.equal(typeof options?.body, 'string');
        const request = new URLSearchParams(options.body as string);
        assert.equal(request.get('metadata[telecheck_reference]'), reference);
        if (!ledger.has(reference))
          ledger.set(reference, {
            object: 'payment_intent',
            id: `pi_${reference}`,
            livemode: false,
            amount: Number(request.get('amount')),
            currency: request.get('currency'),
            metadata: {
              telecheck_payment_id: request.get('metadata[telecheck_payment_id]'),
              telecheck_reference: reference,
            },
            status: 'requires_payment_method',
            client_secret: `pi_${reference}_secret_synthetic`,
          });
        calls++;
        if (calls === 1 && fault === 'response_lost')
          throw new Error('synthetic response lost after acceptance');
        if (calls === 1 && fault === 'session_revoked')
          await setup.query(
            "UPDATE public.sessions SET revoked_at=clock_timestamp(),revoked_reason='patient_logout' WHERE tenant_id=$1 AND session_id=$2",
            [tenant, patient.claims.session_id],
          );
        return new Response(JSON.stringify(ledger.get(reference)), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      };
      if (fault === 'persistence_failed') {
        await setup.query(
          "CREATE FUNCTION public.billing_acceptance_persist_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic_billing_unavailable'; END $$",
        );
        await setup.query(
          "CREATE TRIGGER billing_acceptance_persist_fault BEFORE UPDATE ON public.billing_payment_intent FOR EACH ROW WHEN (NEW.status='requires_payment') EXECUTE FUNCTION public.billing_acceptance_persist_fault()",
        );
      }
      try {
        const first = await post('/v1/async-consults', patient.headers, body, key);
        assert.equal(first.statusCode, fault === 'session_revoked' ? 403 : 503, fault);
        const persisted = (
          await setup.query<{ status: string }>(
            'SELECT status FROM public.billing_payment_intent WHERE tenant_id=$1 AND quote_id=$2',
            [tenant, quoteId],
          )
        ).rows;
        assert.equal(persisted.length, 1);
        assert.equal(persisted[0]!.status, 'creation_unknown');
        assert.equal(
          (
            await setup.query<{ n: number }>(
              'SELECT count(*)::int AS n FROM public.consult c JOIN public.billing_payment_intent i ON (i.tenant_id,i.id)=(c.tenant_id,c.payment_intent_id) WHERE i.tenant_id=$1 AND i.quote_id=$2',
              [tenant, quoteId],
            )
          ).rows[0]!.n,
          0,
        );
      } finally {
        if (fault === 'persistence_failed') {
          await setup.query(
            'DROP TRIGGER billing_acceptance_persist_fault ON public.billing_payment_intent',
          );
          await setup.query('DROP FUNCTION public.billing_acceptance_persist_fault()');
        }
      }
      const retry = await post('/v1/async-consults', patient.headers, body, key);
      assert.equal(retry.statusCode, fault === 'session_revoked' ? 403 : 201, fault);
      assert.equal(calls, fault === 'session_revoked' ? 1 : 2);
      assert.equal(ledger.size, 1, 'one provider object under the stable reference');
      if (fault !== 'session_revoked') {
        const result = retry.json<{ payment_intent_id: string; confirmation: { href: string } }>();
        const confirmation = await app.inject({
          method: 'GET',
          url: result.confirmation.href,
          headers: patient.headers,
        });
        assert.equal(confirmation.statusCode, 200);
        assert.equal(confirmation.headers['cache-control'], 'no-store');
        assert.equal(confirmation.json<{ kind: string }>().kind, 'stripe');
        const cached = (
          await setup.query<{ response_body: unknown }>(
            'SELECT response_body FROM public.idempotency_keys WHERE tenant_id=$1 AND key=$2',
            [tenant, key],
          )
        ).rows[0]!.response_body;
        assert.ok(!JSON.stringify(cached).includes('client_secret'));
        assert.ok(!JSON.stringify(cached).includes('_secret_synthetic'));
        assert.equal(
          (
            await setup.query<{ n: number }>(
              'SELECT count(*)::int AS n FROM public.billing_payment_intent WHERE tenant_id=$1 AND quote_id=$2',
              [tenant, quoteId],
            )
          ).rows[0]!.n,
          1,
        );
        if (fault === 'persistence_failed') {
          // A role's session default must never turn live authorization into a
          // repeatable-read snapshot retained across a blocked protected read.
          await closeBillingPool();
          await setup.query(
            "ALTER ROLE billing_service_role SET default_transaction_isolation='repeatable read'",
          );
          try {
            assert.equal(
              (
                await app.inject({
                  method: 'GET',
                  url: result.confirmation.href,
                  headers: patient.headers,
                })
              ).statusCode,
              200,
            );
          } finally {
            await setup.query(
              'ALTER ROLE billing_service_role RESET default_transaction_isolation',
            );
            await closeBillingPool();
          }
          await setup.query('BEGIN');
          await setup.query('LOCK TABLE public.billing_payment_intent IN ACCESS EXCLUSIVE MODE');
          const blocked = app
            .inject({ method: 'GET', url: result.confirmation.href, headers: patient.headers })
            .then((response) => response);
          try {
            let waiting = false;
            for (let attempt = 0; attempt < 50; attempt++) {
              await setup.query('SELECT pg_stat_clear_snapshot()');
              waiting = (
                await setup.query<{ waiting: boolean }>(
                  "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE usename='billing_service_role' AND wait_event_type='Lock') AS waiting",
                )
              ).rows[0]!.waiting;
              if (waiting) break;
              await new Promise((resolve) => setTimeout(resolve, 10));
            }
            assert.ok(waiting, 'confirmation reached the blocked protected read');
            await setup.query(
              "UPDATE public.sessions SET revoked_at=clock_timestamp(),revoked_reason='patient_logout' WHERE tenant_id=$1 AND session_id=$2",
              [tenant, patient.claims.session_id],
            );
            await setup.query('COMMIT');
            const refused = await blocked;
            assert.equal(
              refused.statusCode,
              403,
              'session revoked during the read cannot disclose confirmation',
            );
            assert.ok(!refused.body.includes('_secret_synthetic'));
            evidence.push(
              'Real Billing role forces READ COMMITTED despite role default and denies a confirmation blocked across session revocation',
            );
          } catch (error) {
            await setup.query('ROLLBACK');
            await blocked;
            throw error;
          }
        }
      }
      evidence.push(
        `Controlled Stripe HTTP / real local roles: ${fault}, durable uncertainty, stable reference, no unauthorized consult or cached secret`,
      );
    }
  } finally {
    globalThis.fetch = originalFetch;
    process.env['BILLING_PROVIDERS_JSON'] = originalRegistry;
    delete process.env['BILLING_ACCEPTANCE_STRIPE_SECRET'];
    delete process.env['BILLING_ACCEPTANCE_STRIPE_WEBHOOK'];
    await setup.query(
      "UPDATE public.ccr_configs SET config_value='\"mock_local_dev\"'::jsonb WHERE tenant_id=$1 AND config_key='payment.processor'",
      [tenant],
    );
  }
}
async function blockedConsultAuthorizationProbes(host: string, tenant: string) {
  for (const fault of ['outbox_commit', 'cached_replay'] as const) {
    const patient = await register(host);
    const quote = await post('/v1/billing/consult-quotes', patient.headers, {
      consult_type: 'general',
    });
    assert.equal(quote.statusCode, 201);
    const quoteId = quote.json<{ quote_id: string }>().quote_id;
    const body = {
      consult_type: 'general',
      initiation_source: 'care_tab',
      accepted_quote_id: quoteId,
    };
    const key = ulid();
    if (fault === 'cached_replay')
      assert.equal((await post('/v1/async-consults', patient.headers, body, key)).statusCode, 201);
    await setup.query('BEGIN');
    if (fault === 'outbox_commit')
      await setup.query('LOCK TABLE public.domain_events_outbox IN ACCESS EXCLUSIVE MODE');
    else await setup.query('LOCK TABLE public.idempotency_keys IN ACCESS EXCLUSIVE MODE');
    const blocked = post('/v1/async-consults', patient.headers, body, key);
    try {
      let waiting = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        await setup.query('SELECT pg_stat_clear_snapshot()');
        waiting = (
          await setup.query<{ waiting: boolean }>(
            "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE usename='telecheck_app_role' AND wait_event_type='Lock') AS waiting",
          )
        ).rows[0]!.waiting;
        if (waiting) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.ok(waiting, `request reached blocked ${fault}`);
      await setup.query(
        "UPDATE public.sessions SET revoked_at=clock_timestamp(),revoked_reason='patient_logout' WHERE tenant_id=$1 AND session_id=$2",
        [tenant, patient.claims.session_id],
      );
      await setup.query('COMMIT');
      const denied = await blocked;
      assert.equal(denied.statusCode, 403, `revocation during ${fault}`);
      assert.ok(!denied.body.includes('consult_id'));
      if (fault === 'outbox_commit') {
        assert.equal(
          (
            await setup.query<{ n: number }>(
              'SELECT count(*)::int AS n FROM public.consult WHERE tenant_id=$1 AND patient_id=$2',
              [tenant, patient.claims.sub],
            )
          ).rows[0]!.n,
          0,
        );
        assert.equal(
          (
            await setup.query<{ n: number }>(
              'SELECT count(*)::int AS n FROM public.idempotency_keys WHERE tenant_id=$1 AND key=$2',
              [tenant, key],
            )
          ).rows[0]!.n,
          0,
        );
        assert.equal(
          (
            await setup.query<{ status: string }>(
              'SELECT status FROM public.billing_payment_intent WHERE tenant_id=$1 AND quote_id=$2',
              [tenant, quoteId],
            )
          ).rows[0]!.status,
          'requires_payment',
        );
      }
      evidence.push(
        `Real app/Billing roles: session revocation during blocked ${fault} returns 403 without metadata disclosure or unauthorized local commit`,
      );
    } catch (error) {
      await setup.query('ROLLBACK');
      await blocked;
      throw error;
    }
  }
}
try {
  await ordinary.query("SELECT public.set_tenant_context('Telecheck-US')");
  for (const table of [
    'billing_consult_price',
    'billing_consult_quote',
    'billing_payment_intent',
    'billing_provider_event',
    'billing_refund_intent',
  ])
    await assert.rejects(
      ordinary.query(`SELECT * FROM public.${table}`),
      (error: unknown) => (error as { code: string }).code === '42501',
    );
  await assert.rejects(
    ordinary.query('SET ROLE billing_service_role'),
    (error: unknown) => (error as { code: string }).code === '42501',
  );
  await assert.rejects(
    ordinary.query('SELECT public.billing_apply_verified_payment($1,$2)', [ulid(), ulid()]),
    (error: unknown) => (error as { code: string }).code === '42501',
  );
  evidence.push(
    'ordinary application cannot read five Billing tables, assume Billing role, or invoke payment consumer',
  );
  for (const [host, tenant, country, currency] of [
    ['localhost', 'Telecheck-US', 'US', 'USD'],
    ['ghana.localhost', 'Telecheck-Ghana', 'GH', 'GHS'],
  ] as const) {
    // Synthetic provisioning only: tenant adapter choice and operator membership.
    // Prices, quotes, intents, consults and payment transitions are all real APIs.
    await setup.query('SELECT public.set_tenant_context($1)', [tenant]);
    await setup.query(
      "INSERT INTO public.ccr_configs(id,tenant_id,config_key,config_value) VALUES($1,$2,'payment.processor','\"mock_local_dev\"'::jsonb) ON CONFLICT(tenant_id,config_key) DO UPDATE SET config_value=EXCLUDED.config_value",
      [ulid(), tenant],
    );
    const operator = await register(host);
    const person = await register(host);
    const other = await register(host);
    await setup.query(
      "UPDATE public.accounts SET account_type='tenant_admin' WHERE tenant_id=$1 AND account_id=$2",
      [tenant, operator.claims.sub],
    );
    const adminHeaders = {
      host,
      authorization: `Bearer ${issueAccessToken({ account_id: operator.claims.sub, tenant_id: asTenantId(tenant), session_id: operator.claims.session_id, role: 'tenant_admin', admin_tenant_binding: tenant, country_of_care: country }, process.env['JWT_SIGNING_KEY']!)}`,
    };
    const version = Number(
      (
        await setup.query<{ v: number }>(
          'SELECT COALESCE(max(version),0)+1 AS v FROM public.billing_consult_price WHERE tenant_id=$1 AND consult_type=$2',
          [tenant, 'general'],
        )
      ).rows[0]!.v,
    );
    const price = {
      consult_type: 'general',
      version,
      amount_minor: country === 'US' ? 4900 : 9900,
      turnaround_minutes: 60,
      quote_ttl_seconds: 600,
    };
    assert.equal((await post('/v1/billing/consult-prices', person.headers, price)).statusCode, 403);
    const published = await post('/v1/billing/consult-prices', adminHeaders, price);
    assert.equal(published.statusCode, 201, `price publication ${published.statusCode}`);
    assert.equal(published.json<{ currency: string }>().currency, currency);
    assert.equal(
      (await post('/v1/billing/consult-prices', adminHeaders, { ...price, amount_minor: 1 }))
        .statusCode,
      409,
    );
    const quote = await post('/v1/billing/consult-quotes', person.headers, {
      consult_type: 'general',
    });
    assert.equal(quote.statusCode, 201, 'quote');
    const q = quote.json<{ quote_id: string; amount_minor: number; mode: string }>();
    assert.equal(q.amount_minor, price.amount_minor);
    assert.equal(q.mode, 'mock_local_dev');
    const body = {
      consult_type: 'general',
      initiation_source: 'care_tab',
      accepted_quote_id: q.quote_id,
    };
    assert.equal(
      (await post('/v1/async-consults', other.headers, body)).statusCode,
      409,
      'wrong patient quote',
    );
    assert.equal(
      (await post('/v1/async-consults', person.headers, { ...body, consult_fee_cents: 1 }))
        .statusCode,
      400,
      'client money rejected',
    );
    const initiationKey = ulid();
    const initiated = await post('/v1/async-consults', person.headers, body, initiationKey);
    assert.equal(initiated.statusCode, 201, `initiation ${initiated.statusCode}`);
    const c = initiated.json<{
      consult_id: string;
      payment_intent_id: string;
      confirmation: { href: string };
    }>();
    const replay = await post('/v1/async-consults', person.headers, body, initiationKey);
    assert.equal(replay.statusCode, 201);
    assert.equal(replay.json<{ consult_id: string }>().consult_id, c.consult_id);
    assert.equal(
      (
        await post(
          '/v1/async-consults',
          person.headers,
          { ...body, initiation_source: 'medication_detail' },
          initiationKey,
        )
      ).statusCode,
      409,
    );
    assert.equal(
      (await post('/v1/async-consults', person.headers, body)).statusCode,
      409,
      'quote single use',
    );
    const before = (
      await setup.query<{ to_state: string }>(
        'SELECT to_state FROM public.consult_lifecycle_transition WHERE tenant_id=$1 AND consult_id=$2 ORDER BY transition_at DESC LIMIT 1',
        [tenant, c.consult_id],
      )
    ).rows[0];
    assert.equal(before!.to_state, 'initiated');
    const nonce = await bindActorContextForRequest(binder, {
      actorAccountId: person.claims.sub,
      actorAccountTenantId: tenant,
      actorRole: 'patient',
      actorAdminHomeTenantId: null,
      sessionId: person.claims.session_id,
    });
    await ordinary.query('BEGIN');
    await ordinary.query('SELECT public.set_tenant_context($1)', [tenant]);
    await ordinary.query("SELECT set_config('app.request_nonce',$1,true)", [nonce.nonce]);
    await ordinary.query('SET LOCAL ROLE async_consult_patient_initiator');
    await assert.rejects(
      ordinary.query(
        'SELECT public.record_consult_intake_submission($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)',
        [
          ulid(),
          tenant,
          c.consult_id,
          person.claims.sub,
          ulid(),
          'v1',
          Buffer.from('x'),
          ulid(),
          Buffer.alloc(12),
          Buffer.alloc(16),
          'AES-256-GCM',
          '2',
          Buffer.from('x'),
          new Date(),
          ulid(),
          ulid(),
          person.claims.sub,
          'patient',
        ],
      ),
      (error: unknown) => (error as { code: string }).code === '23514',
    );
    await ordinary.query('ROLLBACK');
    const confirm = await app.inject({
      method: 'GET',
      url: c.confirmation.href,
      headers: person.headers,
    });
    assert.equal(confirm.statusCode, 200);
    assert.equal(confirm.headers['cache-control'], 'no-store');
    assert.equal(confirm.json<{ kind: string }>().kind, 'mock_local_dev');
    assert.equal(
      (await app.inject({ method: 'GET', url: c.confirmation.href, headers: other.headers }))
        .statusCode,
      404,
    );
    const paid = await post(
      `/v1/billing/payment-intents/${c.payment_intent_id}/mock-confirm`,
      person.headers,
      {},
    );
    assert.equal(paid.statusCode, 200, `mock confirmation ${paid.statusCode}`);
    assert.equal(
      (
        await post(
          `/v1/billing/payment-intents/${c.payment_intent_id}/mock-confirm`,
          person.headers,
          {},
        )
      ).statusCode,
      200,
    );
    assert.equal(
      (
        await setup.query<{ n: number }>(
          "SELECT count(*)::int AS n FROM public.consult_lifecycle_transition WHERE tenant_id=$1 AND consult_id=$2 AND to_state='intake'",
          [tenant, c.consult_id],
        )
      ).rows[0]!.n,
      1,
    );
    assert.equal(
      (
        await setup.query<{ n: number }>(
          'SELECT count(*)::int AS n FROM public.billing_provider_event WHERE tenant_id=$1 AND intent_id=$2',
          [tenant, c.payment_intent_id],
        )
      ).rows[0]!.n,
      1,
    );
    assert.equal(
      (
        await setup.query<{ n: number }>(
          "SELECT count(*)::int AS n FROM public.audit_records WHERE tenant_id=$1 AND resource_id=$2 AND action='payment_processed'",
          [tenant, c.payment_intent_id],
        )
      ).rows[0]!.n,
      1,
    );
    assert.equal(
      (
        await app.inject({ method: 'GET', url: c.confirmation.href, headers: person.headers })
      ).json<{ kind: string }>().kind,
      'complete',
    );
    const data = (
      await setup.query<{ confirmation_ciphertext: Buffer }>(
        'SELECT confirmation_ciphertext FROM public.billing_payment_intent WHERE tenant_id=$1 AND id=$2',
        [tenant, c.payment_intent_id],
      )
    ).rows[0]!.confirmation_ciphertext;
    assert.ok(Buffer.isBuffer(data));
    assert.ok(!data.toString().includes('Synthetic payment'));
    const cache = (
      await setup.query<{ response_body: unknown }>(
        'SELECT response_body FROM public.idempotency_keys WHERE tenant_id=$1 AND key=$2',
        [tenant, initiationKey],
      )
    ).rows[0];
    assert.ok(!JSON.stringify(cache).includes('client_secret'));
    assert.ok(!JSON.stringify(cache).includes('confirmation_ciphertext'));
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: '/v1/billing/webhooks/mock_local_dev',
          headers: {
            host,
            'content-type': 'application/json',
            'x-telecheck-mock-signature': 'bad',
          },
          payload: '{}',
        })
      ).statusCode,
      400,
    );
    // Authenticated provider events still cannot change the amount or merchant.
    const providerReference = (
      await setup.query<{ provider_reference: string }>(
        'SELECT provider_reference FROM public.billing_payment_intent WHERE tenant_id=$1 AND id=$2',
        [tenant, c.payment_intent_id],
      )
    ).rows[0]!.provider_reference;
    const mockEvent = {
      eventId: `mock:${c.payment_intent_id}:adversarial`,
      type: 'paid',
      paymentId: c.payment_intent_id,
      objectId: providerReference,
      reference: providerReference,
      amountMinor: price.amount_minor,
      currency,
      account: country === 'US' ? 'synthetic_us' : 'synthetic_gh',
      mode: 'mock_local_dev',
    };
    const deliver = async (value: Record<string, unknown>, suffix = '') => {
      const bytes = Buffer.from(JSON.stringify(value));
      const signature = createHmac('sha256', process.env['BILLING_TEST_MOCK_SECRET']!)
        .update(bytes)
        .digest('hex');
      return app.inject({
        method: 'POST',
        url: '/v1/billing/webhooks/mock_local_dev',
        headers: {
          host,
          'content-type': 'application/json',
          'x-telecheck-mock-signature': signature,
        },
        payload: bytes.toString() + suffix,
      });
    };
    assert.equal((await deliver({ ...mockEvent, amountMinor: 1 })).statusCode, 400);
    assert.equal((await deliver({ ...mockEvent, account: 'wrong_merchant' })).statusCode, 400);
    assert.equal((await deliver(mockEvent, ' ')).statusCode, 400);
    assert.equal((await deliver(mockEvent)).statusCode, 200);
    assert.equal((await deliver({ ...mockEvent, currency: 'XXX' })).statusCode, 400);

    // Failure injection changes only the test outbox adapter. The payment is
    // created by the API; local consult/audit/cache must all roll back together.
    const rollbackQuote = (
      await post('/v1/billing/consult-quotes', person.headers, { consult_type: 'general' })
    ).json<{ quote_id: string }>();
    const rollbackBody = {
      consult_type: 'general',
      initiation_source: 'care_tab',
      accepted_quote_id: rollbackQuote.quote_id,
    };
    const rollbackKey = ulid();
    await setup.query(
      "CREATE FUNCTION public.billing_acceptance_outbox_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic_outbox_unavailable'; END $$",
    );
    await setup.query(
      "CREATE TRIGGER billing_acceptance_outbox_fault BEFORE INSERT ON public.domain_events_outbox FOR EACH ROW WHEN (NEW.event_type='async_consult.initiated.v1') EXECUTE FUNCTION public.billing_acceptance_outbox_fault()",
    );
    try {
      assert.equal(
        (await post('/v1/async-consults', person.headers, rollbackBody, rollbackKey)).statusCode,
        500,
      );
      assert.equal(
        (
          await setup.query<{ n: number }>(
            'SELECT count(*)::int AS n FROM public.consult c JOIN public.billing_payment_intent i ON (i.tenant_id,i.id)=(c.tenant_id,c.payment_intent_id) WHERE i.tenant_id=$1 AND i.quote_id=$2',
            [tenant, rollbackQuote.quote_id],
          )
        ).rows[0]!.n,
        0,
      );
      assert.equal(
        (
          await setup.query<{ n: number }>(
            'SELECT count(*)::int AS n FROM public.idempotency_keys WHERE tenant_id=$1 AND key=$2',
            [tenant, rollbackKey],
          )
        ).rows[0]!.n,
        0,
      );
    } finally {
      await setup.query(
        'DROP TRIGGER billing_acceptance_outbox_fault ON public.domain_events_outbox',
      );
      await setup.query('DROP FUNCTION public.billing_acceptance_outbox_fault()');
    }
    const resumed = await post('/v1/async-consults', person.headers, rollbackBody, rollbackKey);
    assert.equal(resumed.statusCode, 201);
    assert.equal(
      (
        await setup.query<{ n: number }>(
          'SELECT count(*)::int AS n FROM public.billing_payment_intent WHERE tenant_id=$1 AND quote_id=$2',
          [tenant, rollbackQuote.quote_id],
        )
      ).rows[0]!.n,
      1,
    );

    // A newer immutable price requires a new explicit patient acceptance.
    const stale = (
      await post('/v1/billing/consult-quotes', person.headers, { consult_type: 'general' })
    ).json<{ quote_id: string }>();
    assert.equal(
      (
        await post('/v1/billing/consult-prices', adminHeaders, {
          ...price,
          version: version + 1,
          amount_minor: price.amount_minor + 100,
        })
      ).statusCode,
      201,
    );
    assert.equal(
      (
        await post('/v1/async-consults', person.headers, {
          ...body,
          accepted_quote_id: stale.quote_id,
        })
      ).statusCode,
      409,
    );
    // Expiry precondition only: a historical quote inserted by the fixture setup
    // is rejected; no consult/payment intermediate is inserted by this probe.
    const expired = ulid();
    await setup.query(
      `INSERT INTO public.billing_consult_quote(id,tenant_id,patient_id,price_id,operation_key,created_at,expires_at)
      SELECT $1,$2,$3,id,repeat('f',64),clock_timestamp()-interval '2 minutes',clock_timestamp()-interval '1 minute'
      FROM public.billing_consult_price WHERE tenant_id=$2 AND consult_type='general' ORDER BY version DESC LIMIT 1`,
      [expired, tenant, person.claims.sub],
    );
    assert.equal(
      (await post('/v1/async-consults', person.headers, { ...body, accepted_quote_id: expired }))
        .statusCode,
      409,
    );

    // An authenticated later payment event cannot reopen a terminal consult.
    for (const [from, to, reason] of [
      ['intake', 'abandoned', 'intake_abandoned'],
      ['abandoned', 'expired', 'intake_expired'],
    ]) {
      await setup.query(
        `INSERT INTO public.consult_lifecycle_transition(id,tenant_id,consult_id,from_state,to_state,transition_reason,transition_at,transition_by_actor_id,transition_by_actor_role,metadata)
        VALUES($1,$2,$3,$4,$5,$6,clock_timestamp(),NULL,'scheduler','{}')`,
        [ulid(), tenant, c.consult_id, from, to, reason],
      );
    }
    assert.equal(
      (await deliver({ ...mockEvent, eventId: `mock:${c.payment_intent_id}:late` })).statusCode,
      200,
    );
    assert.equal(
      (
        await setup.query<{ to_state: string }>(
          'SELECT to_state FROM public.consult_lifecycle_transition WHERE tenant_id=$1 AND consult_id=$2 ORDER BY transition_at DESC LIMIT 1',
          [tenant, c.consult_id],
        )
      ).rows[0]!.to_state,
      'expired',
    );

    if (country === 'US') {
      const originalDsn = process.env['BILLING_DATABASE_URL']!;
      await closeBillingPool();
      process.env['BILLING_DATABASE_URL'] =
        'postgresql://billing_service_role:must-never-appear@127.0.0.1:invalid/unused';
      try {
        const denied = await app.inject({
          method: 'GET',
          url: c.confirmation.href,
          headers: person.headers,
        });
        assert.equal(denied.statusCode, 503);
        assert.ok(!denied.body.includes('must-never-appear'));
        assert.equal(
          denied.json<{ error: { code: string } }>().error.code,
          'billing.persistence_unavailable',
        );
      } finally {
        await closeBillingPool();
        process.env['BILLING_DATABASE_URL'] = originalDsn;
      }
      evidence.push(
        'Malformed private Billing connection configuration returns a fixed error without credential-bearing parser input',
      );
      await blockedConsultAuthorizationProbes(host, tenant);
      await providerFailureProbes(host, tenant, adminHeaders, version + 2);
    }
    const logout = await post('/v0/identity/sessions/logout', person.headers, {
      refresh_token: person.refresh_token,
    });
    assert.equal(logout.statusCode, 204);
    assert.equal(
      (await post('/v1/async-consults', person.headers, body, initiationKey)).statusCode,
      403,
      'revoked cached replay',
    );
    evidence.push(
      `${country}: actual registration, operator price publication, currency, quote ownership, immutable price, client tamper rejection, durable initiation/replay, SQL unpaid-intake rejection, signed synthetic payment/dedup, private confirmation, signed wrong-money/account/raw-body rejection, outbox rollback/resume, changed/expired quote rejection, terminal-state preservation and revoked replay`,
    );
  }
  console.log(JSON.stringify({ adapter: 'mock_local_dev', real_money: false, evidence }, null, 2));
} finally {
  await app.close();
  await closePool();
  await closeBindActorContextPool();
  await closeBillingPool();
  await setup.end();
  await ordinary.end();
  await binder.end();
}
