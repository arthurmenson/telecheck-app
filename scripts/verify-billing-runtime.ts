/** Executable synthetic acceptance: real HTTP and isolated PostgreSQL logins. */
import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';

import pg from 'pg';

import { buildApp } from '../src/app.js';
import { bindActorContextForRequest } from '../src/lib/actor-context-binding.js';
import { closePool, closeBindActorContextPool } from '../src/lib/db.js';
import { asTenantId } from '../src/lib/glossary.js';
import { issueAccessToken, verifyAccessToken } from '../src/lib/jwt.js';
import { closeClassifiedKmsPool } from '../src/lib/kms-classified-store.js';
import { ulid } from '../src/lib/ulid.js';
import { closeBillingPool } from '../src/modules/billing/internal/database.js';
import { paystackCredentialAccount } from '../src/modules/billing/internal/provider-config.js';

import {
  installControlledBillingAws,
  provisionSyntheticBillingKms,
} from './billing-controlled-aws.js';

assert.equal(process.env['NODE_ENV'], 'development');
assert.equal(process.env['BILLING_ALLOW_MOCK'], 'true');
const controlledAws = installControlledBillingAws();
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
    for (const fault of [
      'missing_binding',
      'kms_failure',
      'response_lost',
      'persistence_failed',
      'session_revoked',
    ] as const) {
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
      if (fault === 'kms_failure') controlledAws.fail = true;
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
        controlledAws.fail = false;
        if (fault === 'persistence_failed') {
          await setup.query(
            'DROP TRIGGER billing_acceptance_persist_fault ON public.billing_payment_intent',
          );
          await setup.query('DROP FUNCTION public.billing_acceptance_persist_fault()');
        }
      }
      if (fault === 'missing_binding') {
        assert.equal(
          (
            await setup.query<{ n: number }>(
              'SELECT count(*)::int AS n FROM public.tenant_kms_bindings WHERE tenant_id=$1',
              [tenant],
            )
          ).rows[0]!.n,
          0,
        );
        await provisionSyntheticBillingKms(setup, tenant);
      }
      const discovered = await app.inject({
        method: 'GET',
        url: '/v1/billing/consult-payments',
        headers: patient.headers,
      });
      assert.equal(discovered.statusCode, fault === 'session_revoked' ? 403 : 200);
      let retry;
      if (fault === 'session_revoked') {
        retry = await post('/v1/async-consults', patient.headers, body, key);
      } else {
        const page = discovered.json<{
          items: Array<{
            payment_intent_id: string;
            consult_id: null;
            payment_status: string;
            resume_available: boolean;
          }>;
          has_unresolved_payment: boolean;
        }>();
        assert.equal(page.items.length, 1);
        assert.equal(page.items[0]!.consult_id, null);
        assert.equal(page.items[0]!.payment_status, 'creation_unknown');
        assert.equal(page.items[0]!.resume_available, true);
        assert.equal(page.has_unresolved_payment, true);
        const paymentId = page.items[0]!.payment_intent_id;
        if (fault === 'response_lost') {
          await setup.query(
            "UPDATE public.billing_payment_intent SET lease_token=$3,lease_expires_at=clock_timestamp()+interval '30 seconds' WHERE tenant_id=$1 AND id=$2",
            [tenant, paymentId, randomUUID()],
          );
          const leased = await post(
            `/v1/async-consults/payments/${paymentId}/resume`,
            patient.headers,
            {},
          );
          assert.equal(leased.statusCode, 409);
          assert.equal(
            leased.json<{ error: { code: string } }>().error.code,
            'billing.creation_in_flight',
          );
          assert.equal(calls, 1, 'a live lease cannot create another provider attempt');
          await setup.query(
            "UPDATE public.billing_payment_intent SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE tenant_id=$1 AND id=$2",
            [tenant, paymentId],
          );
        }
        retry = await post(`/v1/async-consults/payments/${paymentId}/resume`, patient.headers, {});
      }
      assert.equal(retry.statusCode, fault === 'session_revoked' ? 403 : 201, fault);
      assert.equal(calls, fault === 'session_revoked' ? 1 : 2);
      assert.equal(ledger.size, 1, 'one provider object under the stable reference');
      if (fault !== 'session_revoked') {
        const originalRetry = await post('/v1/async-consults', patient.headers, body, key);
        assert.equal(originalRetry.statusCode, 201);
        assert.equal(
          originalRetry.json<{ consult_id: string }>().consult_id,
          retry.json<{ consult_id: string }>().consult_id,
        );
        assert.equal(calls, 2, 'original initiation also resolves the recovered provider intent');
      }
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
            assert.ok(
              [403, 503].includes(refused.statusCode),
              'session revoked during classified decryption cannot disclose confirmation',
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
    await financialConfirmationProbes(host, tenant);
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
async function financialConfirmationProbes(host: string, tenant: string) {
  // Only the external provider/AWS transports are controlled. Financial class
  // keys, ciphertext, session checks, SQL roles and audit commits are real.
  const objects = new Map<string, Record<string, unknown>>();
  globalThis.fetch = async (url, options) => {
    assert.equal(url, 'https://api.stripe.com/v1/payment_intents');
    const fields = new URLSearchParams(options?.body as string);
    const id = fields.get('metadata[telecheck_payment_id]')!;
    const value = {
      id: `pi_${id}`,
      object: 'payment_intent',
      livemode: false,
      status: 'requires_payment_method',
      amount: Number(fields.get('amount')),
      currency: fields.get('currency'),
      client_secret: `pi_${id}_secret_synthetic`,
      metadata: {
        telecheck_payment_id: id,
        telecheck_reference: fields.get('metadata[telecheck_reference]'),
      },
    };
    objects.set(id, value);
    return new Response(JSON.stringify(value), { status: 200 });
  };
  const fixture = async () => {
    const person = await register(host);
    const q = await post('/v1/billing/consult-quotes', person.headers, { consult_type: 'general' });
    assert.equal(q.statusCode, 201);
    const c = await post('/v1/async-consults', person.headers, {
      consult_type: 'general',
      initiation_source: 'care_tab',
      accepted_quote_id: q.json<{ quote_id: string }>().quote_id,
    });
    assert.equal(c.statusCode, 201);
    return { person, ...c.json<{ payment_intent_id: string; confirmation: { href: string } }>() };
  };
  const get = (f: Awaited<ReturnType<typeof fixture>>) =>
    app.inject({ method: 'GET', url: f.confirmation.href, headers: f.person.headers });
  const count = async (id: string, action: string) =>
    (
      await setup.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM public.audit_records WHERE tenant_id=$1 AND resource_id=$2 AND action=$3',
        [tenant, id, action],
      )
    ).rows[0]!.n;
  const f = await fixture();
  const before = await count(f.payment_intent_id, 'kms.decrypt_invoked');
  const result = await get(f);
  assert.equal(result.statusCode, 200);
  assert.ok(result.json<{ client_secret: string }>().client_secret.endsWith('_secret_synthetic'));
  assert.equal(await count(f.payment_intent_id, 'kms.decrypt_invoked'), before + 1);
  const stored = (
    await setup.query<{
      confirmation_aad: Buffer;
      confirmation_ciphertext: Buffer;
      confirmation_data_class: string;
      confirmation_dek_id: string;
    }>(
      'SELECT confirmation_aad,confirmation_ciphertext,confirmation_data_class,confirmation_dek_id FROM public.billing_payment_intent WHERE tenant_id=$1 AND id=$2',
      [tenant, f.payment_intent_id],
    )
  ).rows[0]!;
  assert.equal(stored.confirmation_data_class, 'pii_financial');
  assert.equal(stored.confirmation_ciphertext.subarray(0, 8).toString(), 'TCROW002');
  assert.ok(!stored.confirmation_ciphertext.toString().includes('_secret_synthetic'));
  const aad = JSON.parse(stored.confirmation_aad.toString()) as unknown[];
  assert.equal(aad[4], f.person.claims.sub);
  assert.equal(aad[6], f.payment_intent_id);
  assert.equal(aad[7], 'payment_confirmation');
  for (const [index, value] of [
    [2, 'Telecheck-Ghana'],
    [3, 'pii_demographic'],
    [4, ulid()],
    [6, ulid()],
    [7, 'wrong_field'],
  ] as const) {
    const altered = [...aad];
    altered[index] = value;
    await setup.query(
      'UPDATE public.billing_payment_intent SET confirmation_aad=$3 WHERE tenant_id=$1 AND id=$2',
      [tenant, f.payment_intent_id, Buffer.from(JSON.stringify(altered))],
    );
    const calls = controlledAws.calls;
    const denied = await get(f);
    assert.equal(denied.statusCode, 503);
    assert.ok(!denied.body.includes('_secret_synthetic'));
    assert.equal(controlledAws.calls, calls);
  }
  await setup.query(
    'UPDATE public.billing_payment_intent SET confirmation_aad=$3 WHERE tenant_id=$1 AND id=$2',
    [tenant, f.payment_intent_id, stored.confirmation_aad],
  );
  assert.ok((await count(f.payment_intent_id, 'kms.decrypt_failed')) >= 5);
  controlledAws.fail = true;
  try {
    const denied = await get(f);
    assert.equal(denied.statusCode, 503);
    assert.ok(!denied.body.includes('_secret_synthetic'));
  } finally {
    controlledAws.fail = false;
  }
  const successBefore = await count(f.payment_intent_id, 'kms.decrypt_invoked');
  await setup.query(
    "CREATE FUNCTION public.billing_financial_audit_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic_financial_audit_unavailable'; END $$",
  );
  await setup.query(
    "CREATE TRIGGER billing_financial_audit_fault BEFORE INSERT ON public.audit_records FOR EACH ROW WHEN (NEW.action='kms.decrypt_invoked') EXECUTE FUNCTION public.billing_financial_audit_fault()",
  );
  try {
    const denied = await get(f);
    assert.equal(denied.statusCode, 503);
    assert.ok(!denied.body.includes('_secret_synthetic'));
    assert.equal(await count(f.payment_intent_id, 'kms.decrypt_invoked'), successBefore);
  } finally {
    await setup.query('DROP TRIGGER billing_financial_audit_fault ON public.audit_records');
    await setup.query('DROP FUNCTION public.billing_financial_audit_fault()');
  }
  for (const fault of [
    'crypto_revocation',
    'crypto_nonce_expiry',
    'audit_session_expiry',
  ] as const) {
    const victim = await fixture();
    const n = await count(victim.payment_intent_id, 'kms.decrypt_invoked');
    if (fault !== 'audit_session_expiry') {
      controlledAws.beforeCrypto = async () => {
        if (fault === 'crypto_revocation')
          await setup.query(
            "UPDATE public.sessions SET revoked_at=clock_timestamp(),revoked_reason='patient_logout' WHERE session_id=$1",
            [victim.person.claims.session_id],
          );
        else {
          await setup.query(
            "UPDATE public._session_actor_context SET expires_at=clock_timestamp()+interval '30 milliseconds' WHERE session_id=$1",
            [victim.person.claims.session_id],
          );
          await new Promise((resolve) => setTimeout(resolve, 60));
        }
      };
      const denied = await get(victim);
      assert.ok([403, 503].includes(denied.statusCode));
      assert.ok(!denied.body.includes('_secret_synthetic'));
    } else {
      await setup.query(
        'CREATE FUNCTION public.billing_financial_audit_wait() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_advisory_xact_lock(9140388); RETURN NEW; END $$',
      );
      await setup.query(
        "CREATE TRIGGER billing_financial_audit_wait BEFORE INSERT ON public.audit_records FOR EACH ROW WHEN (NEW.action='kms.decrypt_invoked') EXECUTE FUNCTION public.billing_financial_audit_wait()",
      );
      await setup.query('BEGIN');
      await setup.query('SELECT pg_advisory_xact_lock(9140388)');
      const pending = get(victim).then((value) => value);
      try {
        let waiting = false;
        for (let attempt = 0; attempt < 70; attempt++) {
          await setup.query('SELECT pg_stat_clear_snapshot()');
          waiting = (
            await setup.query<{ ok: boolean }>(
              "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE usename='kms_service_role' AND wait_event_type='Lock') AS ok",
            )
          ).rows[0]!.ok;
          if (waiting) break;
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        assert.ok(waiting, 'financial success audit reached contention');
        await setup.query(
          "UPDATE public.sessions SET expires_at=clock_timestamp()+interval '30 milliseconds' WHERE session_id=$1",
          [victim.person.claims.session_id],
        );
        await new Promise((resolve) => setTimeout(resolve, 60));
        await setup.query('COMMIT');
        const denied = await pending;
        assert.ok([403, 503].includes(denied.statusCode));
        assert.ok(!denied.body.includes('_secret_synthetic'));
      } finally {
        await setup.query('ROLLBACK');
        await pending;
        await setup.query('DROP TRIGGER billing_financial_audit_wait ON public.audit_records');
        await setup.query('DROP FUNCTION public.billing_financial_audit_wait()');
      }
    }
    assert.equal(
      await count(victim.payment_intent_id, 'kms.decrypt_invoked'),
      n,
      'no success audit committed after lost authority',
    );
  }
  const webhook = async (type: string, raw: Record<string, unknown>, id: string) => {
    const bytes = Buffer.from(
      JSON.stringify({
        id,
        type,
        account: 'acct_synthetic_acceptance',
        livemode: false,
        data: { object: raw },
      }),
    );
    const t = Math.floor(Date.now() / 1000).toString();
    const signature = createHmac('sha256', process.env['BILLING_ACCEPTANCE_STRIPE_WEBHOOK']!)
      .update(`${t}.`)
      .update(bytes)
      .digest('hex');
    return app.inject({
      method: 'POST',
      url: '/v1/billing/webhooks/stripe',
      headers: {
        host,
        'content-type': 'application/json',
        'stripe-signature': `t=${t},v1=${signature}`,
      },
      payload: bytes,
    });
  };
  for (const order of [
    ['payment_intent.canceled', 'payment_intent.payment_failed'],
    ['payment_intent.payment_failed', 'payment_intent.canceled'],
  ]) {
    const cancelled = await fixture();
    const raw = objects.get(cancelled.payment_intent_id)!;
    for (const type of order) {
      const eventId = `evt_${ulid()}`;
      const data = {
        ...raw,
        status: type === 'payment_intent.canceled' ? 'canceled' : 'requires_payment_method',
      };
      assert.equal((await webhook(type, data, eventId)).statusCode, 200);
      assert.equal((await webhook(type, data, eventId)).statusCode, 200);
    }
    const state = (
      await setup.query<{ status: string }>(
        'SELECT status FROM public.billing_payment_intent WHERE tenant_id=$1 AND id=$2',
        [tenant, cancelled.payment_intent_id],
      )
    ).rows[0]!.status;
    assert.equal(state, 'cancelled');
    assert.equal((await get(cancelled)).statusCode, 409);
    assert.equal(
      (
        await setup.query<{ n: number }>(
          'SELECT count(*)::int AS n FROM public.billing_provider_event WHERE tenant_id=$1 AND intent_id=$2',
          [tenant, cancelled.payment_intent_id],
        )
      ).rows[0]!.n,
      2,
    );
    await assert.rejects(
      setup.query(
        "UPDATE public.billing_payment_intent SET status='requires_payment' WHERE tenant_id=$1 AND id=$2",
        [tenant, cancelled.payment_intent_id],
      ),
      (error: unknown) => (error as { code: string }).code === '23514',
    );
  }
  evidence.push(
    'Financial class uses tenant KMS and durable successful-decrypt audit; wrong tenant/class/patient/payment/field, KMS failure, audit failure and authority loss during crypto/audit never disclose a secret',
  );
  evidence.push(
    'Both Stripe cancellation/failure delivery orders and duplicate events preserve cancelled, deny confirmation and retain immutable event evidence; SQL regression also denied',
  );
}
async function paystackRuntimeProbes(
  host: string,
  tenant: string,
  adminHeaders: Record<string, string>,
  version: number,
) {
  const originalFetch = globalThis.fetch,
    originalRegistry = process.env['BILLING_PROVIDERS_JSON']!;
  const secret = 'sk_test_controlled_paystack_no_real_merchant_account';
  process.env['BILLING_ACCEPTANCE_PAYSTACK_SECRET'] = secret;
  const account = paystackCredentialAccount(secret);
  const registry = JSON.parse(originalRegistry) as Record<string, unknown>;
  registry[tenant] = {
    provider: 'paystack',
    mode: 'sandbox',
    account,
    secret_env: 'BILLING_ACCEPTANCE_PAYSTACK_SECRET',
    webhook_secret_env: 'BILLING_ACCEPTANCE_PAYSTACK_SECRET',
    return_url: 'https://example.invalid/care',
  };
  process.env['BILLING_PROVIDERS_JSON'] = JSON.stringify(registry);
  await setup.query(
    "UPDATE public.ccr_configs SET config_value='\"paystack\"'::jsonb WHERE tenant_id=$1 AND config_key='payment.processor'",
    [tenant],
  );
  const ledger = new Map<string, Record<string, unknown>>();
  let initializeCalls = 0;
  let loseNext = false;
  globalThis.fetch = async (target, options) => {
    assert.equal(new Headers(options?.headers).get('authorization'), `Bearer ${secret}`);
    const url = String(target);
    assert.ok(url.startsWith('https://api.paystack.co/transaction/'));
    if (url.endsWith('/initialize')) {
      initializeCalls++;
      const body = JSON.parse(options?.body as string) as Record<string, unknown>;
      const reference = String(body['reference']);
      const metadata = JSON.parse(body['metadata'] as string) as Record<string, unknown>;
      assert.ok(!ledger.has(reference), 'each Paystack reference initializes once');
      // Official documented verify/event shape: no top-level integration ID.
      ledger.set(reference, {
        id: 900000 + initializeCalls,
        domain: 'test',
        status: loseNext ? 'success' : 'abandoned',
        reference,
        amount: body['amount'],
        currency: body['currency'],
        metadata,
        ['customer']: {},
        authorization: {},
        subaccount: {},
        fees_split: null,
      });
      if (loseNext) {
        loseNext = false;
        throw new Error('controlled accepted Paystack response lost');
      }
      return new Response(
        JSON.stringify({
          status: true,
          data: {
            reference,
            authorization_url: `https://checkout.paystack.com/${reference}`,
            access_code: reference,
          },
        }),
        { status: 200 },
      );
    }
    const reference = decodeURIComponent(url.split('/').at(-1)!);
    assert.ok(ledger.has(reference));
    return new Response(JSON.stringify({ status: true, data: ledger.get(reference) }), {
      status: 200,
    });
  };
  try {
    await provisionSyntheticBillingKms(setup, tenant);
    assert.equal(
      (
        await post('/v1/billing/consult-prices', adminHeaders, {
          consult_type: 'general',
          version,
          amount_minor: 9900,
          turnaround_minutes: 60,
          quote_ttl_seconds: 600,
        })
      ).statusCode,
      201,
    );
    const person = await register(host);
    const quote = await post('/v1/billing/consult-quotes', person.headers, {
      consult_type: 'general',
    });
    assert.equal(quote.statusCode, 201);
    const body = {
      consult_type: 'general',
      initiation_source: 'care_tab',
      accepted_quote_id: quote.json<{ quote_id: string }>().quote_id,
    };
    const initiated = await post('/v1/async-consults', person.headers, body);
    assert.equal(initiated.statusCode, 201);
    const c = initiated.json<{ payment_intent_id: string; confirmation: { href: string } }>();
    const confirmation = await app.inject({
      method: 'GET',
      url: c.confirmation.href,
      headers: person.headers,
    });
    assert.equal(confirmation.statusCode, 200);
    assert.equal(confirmation.json<{ kind: string }>().kind, 'redirect');
    assert.equal(
      (
        await setup.query<{ n: number }>(
          "SELECT count(*)::int AS n FROM public.audit_records WHERE tenant_id=$1 AND resource_id=$2 AND action='kms.decrypt_invoked' AND payload->>'data_class'='pii_financial'",
          [tenant, c.payment_intent_id],
        )
      ).rows[0]!.n,
      1,
    );
    const calls = initializeCalls;
    process.env['BILLING_ACCEPTANCE_PAYSTACK_SECRET'] =
      'sk_test_wrong_integration_secret_000000000';
    try {
      const denied = await app.inject({
        method: 'GET',
        url: c.confirmation.href,
        headers: person.headers,
      });
      assert.equal(denied.statusCode, 503);
      assert.equal(initializeCalls, calls);
    } finally {
      process.env['BILLING_ACCEPTANCE_PAYSTACK_SECRET'] = secret;
    }
    const reference = `tc-${c.payment_intent_id}`;
    const raw = { ...ledger.get(reference), status: 'success' };
    const deliver = async (value: Record<string, unknown>, key = secret) => {
      const bytes = Buffer.from(JSON.stringify({ event: 'charge.success', data: value }));
      const signature = createHmac('sha512', key).update(bytes).digest('hex');
      return app.inject({
        method: 'POST',
        url: '/v1/billing/webhooks/paystack',
        headers: { host, 'content-type': 'application/json', 'x-paystack-signature': signature },
        payload: bytes,
      });
    };
    assert.equal((await deliver(raw, 'sk_test_another_merchant')).statusCode, 400);
    assert.equal((await deliver({ ...raw, amount: 1 })).statusCode, 400);
    assert.equal((await deliver({ ...raw, domain: 'live' })).statusCode, 503);
    assert.equal((await deliver(raw)).statusCode, 200);
    assert.equal((await deliver(raw)).statusCode, 200);
    assert.equal(
      (
        await app.inject({ method: 'GET', url: c.confirmation.href, headers: person.headers })
      ).json<{ kind: string }>().kind,
      'complete',
    );
    const nextQuote = await post('/v1/billing/consult-quotes', person.headers, {
      consult_type: 'general',
    });
    assert.equal(nextQuote.statusCode, 201);
    const nextBody = {
        ...body,
        accepted_quote_id: nextQuote.json<{ quote_id: string }>().quote_id,
      },
      key = ulid();
    loseNext = true;
    assert.equal((await post('/v1/async-consults', person.headers, nextBody, key)).statusCode, 503);
    const beforeRetry = initializeCalls;
    const retry = await post('/v1/async-consults', person.headers, nextBody, key);
    assert.equal(retry.statusCode, 201);
    assert.equal(
      initializeCalls,
      beforeRetry,
      'ambiguous Paystack creation resumes by authenticated verify only',
    );
    const recovered = retry.json<{ confirmation: { href: string } }>();
    assert.equal(
      (
        await app.inject({
          method: 'GET',
          url: recovered.confirmation.href,
          headers: person.headers,
        })
      ).json<{ kind: string }>().kind,
      'complete',
    );
    evidence.push(
      'GH Paystack documented initialize/verify/webhook shape succeeds without data.integration; immutable credential authority, wrong key/mode/money denial, financial decrypt audit, callback dedup and verify-only ambiguous recovery pass under real roles',
    );
  } finally {
    globalThis.fetch = originalFetch;
    process.env['BILLING_PROVIDERS_JSON'] = originalRegistry;
    delete process.env['BILLING_ACCEPTANCE_PAYSTACK_SECRET'];
    await setup.query(
      "UPDATE public.ccr_configs SET config_value='\"mock_local_dev\"'::jsonb WHERE tenant_id=$1 AND config_key='payment.processor'",
      [tenant],
    );
  }
}
async function blockedRecoveryAuthorizationProbes(host: string, tenant: string) {
  for (const fault of ['payment_list', 'reservation_lock', 'resume_replay'] as const) {
    const person = await register(host);
    const quote = await post('/v1/billing/consult-quotes', person.headers, {
      consult_type: 'general',
    });
    assert.equal(quote.statusCode, 201);
    const created = await post('/v1/async-consults', person.headers, {
      consult_type: 'general',
      initiation_source: 'care_tab',
      accepted_quote_id: quote.json<{ quote_id: string }>().quote_id,
    });
    assert.equal(created.statusCode, 201);
    const c = created.json<{ payment_intent_id: string; consult_id: string }>();
    const url = `/v1/async-consults/payments/${c.payment_intent_id}/resume`;
    const key = ulid();
    if (fault === 'resume_replay')
      assert.equal((await post(url, person.headers, {}, key)).statusCode, 201);
    const operation = (
      await setup.query<{ operation_key: string }>(
        'SELECT operation_key FROM public.billing_payment_intent WHERE tenant_id=$1 AND id=$2',
        [tenant, c.payment_intent_id],
      )
    ).rows[0]!.operation_key;
    await setup.query('BEGIN');
    if (fault === 'payment_list')
      await setup.query('LOCK TABLE public.billing_payment_intent IN ACCESS EXCLUSIVE MODE');
    else if (fault === 'resume_replay')
      await setup.query('LOCK TABLE public.idempotency_keys IN ACCESS EXCLUSIVE MODE');
    else
      await setup.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        `billing_reserve:${tenant}:${person.claims.sub}:${operation}`,
      ]);
    const blocked =
      fault === 'payment_list'
        ? app.inject({
            method: 'GET',
            url: '/v1/billing/consult-payments',
            headers: person.headers,
          })
        : post(url, person.headers, {}, key);
    try {
      let waiting = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        await setup.query('SELECT pg_stat_clear_snapshot()');
        waiting = (
          await setup.query<{ waiting: boolean }>(
            "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE usename IN ('billing_service_role','telecheck_app_role') AND wait_event_type='Lock' AND pg_backend_pid()=ANY(pg_blocking_pids(pid))) AS waiting",
          )
        ).rows[0]!.waiting;
        if (waiting) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.ok(waiting, `recovery reached blocked ${fault}`);
      await setup.query(
        "UPDATE public.sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE tenant_id=$1 AND session_id=$2",
        [tenant, person.claims.session_id],
      );
      await setup.query('COMMIT');
      const denied = await blocked;
      assert.equal(denied.statusCode, 403, `recovery expired while blocked ${fault}`);
      assert.ok(!denied.body.includes(c.payment_intent_id));
      assert.ok(!denied.body.includes(c.consult_id));
      assert.equal(
        (
          await setup.query<{ n: number }>(
            'SELECT count(*)::int AS n FROM public.consult WHERE tenant_id=$1 AND patient_id=$2',
            [tenant, person.claims.sub],
          )
        ).rows[0]!.n,
        1,
      );
      evidence.push(
        `${tenant}: ${fault} reauthorizes after actual lock wait; expired session receives no payment/case metadata`,
      );
    } catch (error) {
      await setup.query('ROLLBACK');
      await blocked;
      throw error;
    }
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
      (error: unknown) => (error as { code: string }).code === '42501',
    );
    await ordinary.query('ROLLBACK');
    // The old caller-supplied envelope capability is retired. Prove the payment
    // guard through the actual replacement SQL capability and HTTP ingress too.
    await ordinary.query('BEGIN');
    await ordinary.query('SELECT public.set_tenant_context($1)', [tenant]);
    await ordinary.query("SELECT set_config('app.request_nonce',$1,true)", [nonce.nonce]);
    await assert.rejects(
      ordinary.query('SELECT public.care_bind_intake($1)', [c.consult_id]),
      (error: unknown) =>
        (error as { code: string; message: string }).code === 'PT409' &&
        (error as { message: string }).message === 'care_payment_required',
    );
    await ordinary.query('ROLLBACK');
    const unpaidIntake = await post(
      `/v1/async-consults/${c.consult_id}/intake/begin`,
      person.headers,
      {},
    );
    assert.equal(unpaidIntake.statusCode, 409);
    assert.equal(
      unpaidIntake.json<{ error: { code: string } }>().error.code,
      'care.payment_required',
    );
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
    const completedPage = await app.inject({
      method: 'GET',
      url: '/v1/billing/consult-payments',
      headers: person.headers,
    });
    assert.equal(completedPage.statusCode, 200);
    assert.equal(
      completedPage.json<{ has_unresolved_payment: boolean }>().has_unresolved_payment,
      false,
    );
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
    assert.equal(data, null, 'mock stores no credential ciphertext or global-key envelope');
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
    // The browser lost its original initiation key. Discover the durable Billing
    // reservation and resume by its server identifier without accepting new money.
    const discovered = await app.inject({
      method: 'GET',
      url: '/v1/billing/consult-payments',
      headers: person.headers,
    });
    assert.equal(discovered.statusCode, 200);
    assert.equal(discovered.headers['cache-control'], 'no-store');
    const page = discovered.json<{
      items: Array<{
        payment_intent_id: string;
        consult_id: string | null;
        payment_status: string;
        accepted_at: string;
        price: Record<string, unknown>;
        resume_available: boolean;
      }>;
      offset: number;
      limit: number;
      has_more: boolean;
      has_unresolved_payment: boolean;
    }>();
    assert.deepEqual(
      Object.keys(page).sort(),
      ['items', 'offset', 'limit', 'has_more', 'has_unresolved_payment'].sort(),
    );
    assert.equal(page.offset, 0);
    assert.equal(page.limit, 25);
    assert.equal(page.has_unresolved_payment, true);
    const orphan = page.items.find((item) => item.consult_id === null)!;
    assert.ok(orphan);
    assert.deepEqual(
      Object.keys(orphan).sort(),
      [
        'payment_intent_id',
        'consult_id',
        'payment_status',
        'accepted_at',
        'price',
        'resume_available',
      ].sort(),
    );
    assert.equal(orphan.payment_status, 'requires_payment');
    assert.equal(orphan.resume_available, true);
    assert.ok(Number.isFinite(Date.parse(orphan.accepted_at)));
    assert.deepEqual(orphan.price, {
      amount_minor: price.amount_minor,
      currency,
      provider: 'mock_local_dev',
      mode: 'mock_local_dev',
    });
    const offpage = await app.inject({
      method: 'GET',
      url: '/v1/billing/consult-payments?offset=25',
      headers: person.headers,
    });
    assert.equal(offpage.statusCode, 200);
    assert.deepEqual(offpage.json<{ items: unknown[] }>().items, []);
    assert.equal(offpage.json<{ has_unresolved_payment: boolean }>().has_unresolved_payment, true);
    const unrelated = await app.inject({
      method: 'GET',
      url: '/v1/billing/consult-payments',
      headers: other.headers,
    });
    assert.equal(unrelated.statusCode, 200);
    assert.deepEqual(unrelated.json<{ items: unknown[] }>().items, []);
    assert.equal(
      unrelated.json<{ has_unresolved_payment: boolean }>().has_unresolved_payment,
      false,
    );
    assert.equal(
      (
        await app.inject({
          method: 'GET',
          url: '/v1/billing/consult-payments',
          headers: adminHeaders,
        })
      ).statusCode,
      403,
    );
    for (const query of [
      'offset=-1',
      'offset=10001',
      'offset=0.5',
      'offset=invalid',
      'patient_id=' + person.claims.sub,
    ]) {
      assert.equal(
        (
          await app.inject({
            method: 'GET',
            url: '/v1/billing/consult-payments?' + query,
            headers: person.headers,
          })
        ).statusCode,
        400,
      );
    }
    const resumeUrl = `/v1/async-consults/payments/${orphan.payment_intent_id}/resume`;
    assert.equal((await post(resumeUrl, other.headers, {})).statusCode, 404);
    assert.equal((await post(resumeUrl, adminHeaders, {})).statusCode, 403);
    assert.equal((await post(resumeUrl, person.headers, { amount_minor: 1 })).statusCode, 400);
    assert.equal((await post(resumeUrl + '?amount_minor=1', person.headers, {})).statusCode, 400);
    const resumeKey = ulid();
    const resumed = await post(resumeUrl, person.headers, {}, resumeKey);
    assert.equal(resumed.statusCode, 201);
    assert.equal(
      resumed.json<{ payment_intent_id: string }>().payment_intent_id,
      orphan.payment_intent_id,
    );
    assert.equal(
      (await post(resumeUrl, person.headers, {}, resumeKey)).json<{ consult_id: string }>()
        .consult_id,
      resumed.json<{ consult_id: string }>().consult_id,
    );
    const originalRetry = await post(
      '/v1/async-consults',
      person.headers,
      rollbackBody,
      rollbackKey,
    );
    assert.equal(originalRetry.statusCode, 201);
    assert.equal(
      originalRetry.json<{ consult_id: string }>().consult_id,
      resumed.json<{ consult_id: string }>().consult_id,
    );
    const parallelResumes = await Promise.all([
      post(resumeUrl, person.headers, {}),
      post(resumeUrl, person.headers, {}),
    ]);
    for (const response of parallelResumes) {
      assert.equal(response.statusCode, 201);
      assert.equal(
        response.json<{ consult_id: string }>().consult_id,
        resumed.json<{ consult_id: string }>().consult_id,
      );
    }
    evidence.push(
      `${country}: discover orphan accepted payment after local rollback; metadata-only own list and off-page unresolved flag; new-key, original-key and concurrent resume retain the single payment and case`,
    );
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

    await blockedRecoveryAuthorizationProbes(host, tenant);
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
    if (country === 'GH') await paystackRuntimeProbes(host, tenant, adminHeaders, version + 2);
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
  console.log(
    JSON.stringify(
      {
        adapter: 'mock_local_dev + controlled Stripe/Paystack',
        aws_transport: 'controlled SDK only; no live AWS policy evidence',
        real_money: false,
        evidence,
      },
      null,
      2,
    ),
  );
} finally {
  await app.close();
  await closePool();
  await closeBindActorContextPool();
  await closeBillingPool();
  await closeClassifiedKmsPool();
  controlledAws.restore();
  await setup.end();
  await ordinary.end();
  await binder.end();
}
