// Actual normal intake HTTP with real crisis admission; synthetic providers and catalog.
import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import http from 'node:http';
import { verifyStaffEnrollment } from './verify-staff-enrollment-runtime.mjs';
import pg from 'pg';
import { buildApp } from '../src/app.ts';
import { bindActorContextForRequest } from '../src/lib/actor-context-binding.ts';
import { asTenantId } from '../src/lib/glossary.ts';
import { issueAccessToken, verifyAccessToken } from '../src/lib/jwt.ts';
import { closePool, closeBindActorContextPool } from '../src/lib/db.ts';
import { closeClassifiedKmsPool } from '../src/lib/kms-classified-store.ts';
import { ulid } from '../src/lib/ulid.ts';
import { closeBillingPool } from '../src/modules/billing/internal/database.ts';
import { createCareIntakeService } from '../src/modules/async-consult/internal/services/clinical-intake.ts';
import {
  beginCareIntake,
  careIntakeRepository,
  careIntakeTransaction,
} from '../src/modules/async-consult/internal/services/clinical-intake-repository.ts';
import {
  installControlledBillingAws,
  provisionSyntheticBillingKms,
} from './billing-controlled-aws.ts';
assert.equal(process.env.NODE_ENV, 'development');
assert.equal(process.env.CARE_SYNTHETIC_ACCEPTANCE, 'true');
assert.equal(process.env.AUTH_DEV_OTP_ECHO, 'true');
assert.equal(process.env.EMAIL_PROVIDER, 'noop');
assert.equal(process.env.BILLING_ALLOW_MOCK, 'true');
const target = new URL(process.env.DATABASE_URL);
assert(['127.0.0.1', 'localhost'].includes(target.hostname));
for (const name of [
  'CARE_TEST_SETUP_DATABASE_URL',
  'BIND_ACTOR_CONTEXT_DATABASE_URL',
  'IDENTITY_DATABASE_URL',
  'KMS_DATABASE_URL',
  'BILLING_DATABASE_URL',
]) {
  const value = new URL(process.env[name]);
  assert.equal(value.host, target.host);
  assert.equal(value.pathname, target.pathname);
}
const aws = installControlledBillingAws('pii_sensitive_clinical');
const admin = new pg.Client({ connectionString: process.env.CARE_TEST_SETUP_DATABASE_URL });
const binder = new pg.Client({ connectionString: process.env.BIND_ACTOR_CONTEXT_DATABASE_URL });
const ordinary = new pg.Client({ connectionString: process.env.DATABASE_URL });
await Promise.all([admin.connect(), binder.connect(), ordinary.connect()]);
assert.deepEqual(
  (
    await ordinary.query(
      'SELECT session_user AS name,rolsuper,rolinherit,rolbypassrls FROM pg_roles WHERE rolname=session_user',
    )
  ).rows[0],
  { name: 'telecheck_app_role', rolsuper: false, rolinherit: false, rolbypassrls: false },
);
const app = await buildApp({ logger: false });
const origin = await app.listen({ host: '127.0.0.1', port: 0 });
async function inject(options) {
  const body = options.payload === undefined ? undefined : JSON.stringify(options.payload);
  return new Promise((resolve, reject) => {
    const req = http.request(
      new URL(options.url, origin),
      {
        method: options.method,
        headers: {
          ...options.headers,
          ...(body === undefined
            ? {}
            : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) }),
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('error', reject);
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          resolve({
            statusCode: res.statusCode,
            body: text,
            headers: res.headers,
            json: () => JSON.parse(text),
          });
        });
      },
    );
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}
async function request(who, path, body, status = 201, method = 'POST') {
  const r = await inject({
    method,
    url: path,
    headers: { host: who.host, authorization: `Bearer ${who.token}`, 'idempotency-key': ulid() },
    ...(body === undefined ? {} : { payload: body }),
  });
  assert.equal(r.statusCode, status, `${method} ${path}: ${r.statusCode} ${r.body}`);
  return r.json();
}
async function staff(tenant, country, role, forms, consent) {
  const account = ulid(),
    session = ulid();
  await admin.query(
    `INSERT INTO public.accounts(account_id,tenant_id,email,first_name,last_name,date_of_birth,gender,country_of_residence,country_of_care,locale,account_type,status) VALUES($1,$2,$3,'Synthetic','Care','1990-01-01','prefer_not_to_say',$4,$4,$5,$6,'active')`,
    [account, tenant, `${randomUUID()}@example.invalid`, country, `en-${country}`, role],
  );
  await admin.query(
    "INSERT INTO public.sessions(session_id,tenant_id,account_id,refresh_token_hash,expires_at) VALUES($1,$2,$3,$4,clock_timestamp()+interval '1 hour')",
    [session, tenant, account, randomBytes(32).toString('hex')],
  );
  for (const capability of forms)
    await admin.query(
      'INSERT INTO public.forms_governance_membership(tenant_id,account_id,capability) VALUES($1,$2,$3)',
      [tenant, account, capability],
    );
  for (const capability of consent)
    await admin.query(
      'INSERT INTO public.consent_care_membership(tenant_id,account_id,capability) VALUES($1,$2,$3)',
      [tenant, account, capability],
    );
  const token = issueAccessToken(
    {
      account_id: account,
      tenant_id: asTenantId(tenant),
      session_id: session,
      role,
      country_of_care: country,
      admin_tenant_binding: tenant,
    },
    process.env.JWT_SIGNING_KEY,
  );
  return {
    account,
    session,
    tenant,
    country,
    role,
    token,
    host: country === 'US' ? 'localhost' : 'ghana.localhost',
  };
}
async function register(host, tenant, country) {
  const email = `care-${randomUUID()}@example.invalid`;
  const start = await inject({
    method: 'POST',
    url: '/v0/identity/registration/email/start',
    headers: { host, 'idempotency-key': randomUUID() },
    payload: { email },
  });
  assert.equal(start.statusCode, 200);
  const end = await inject({
    method: 'POST',
    url: '/v0/identity/registration/email/verify',
    headers: { host, 'idempotency-key': randomUUID() },
    payload: {
      email,
      passcode: start.json().dev_passcode,
      pin: '583926',
      first_name: 'Synthetic',
      last_name: 'Care',
      date_of_birth: '1990-01-01',
      gender: 'prefer_not_to_say',
    },
  });
  assert.equal(end.statusCode, 201);
  const token = end.json().access_token;
  const verified = verifyAccessToken(token, process.env.JWT_SIGNING_KEY);
  assert(verified.ok);
  return {
    host,
    tenant,
    country,
    account: verified.claims.sub,
    session: verified.claims.session_id,
    token,
    role: 'patient',
  };
}
async function context(who) {
  const { nonce } = await bindActorContextForRequest(binder, {
    actorAccountId: who.account,
    actorAccountTenantId: who.tenant,
    actorRole: who.role,
    actorAdminHomeTenantId: null,
    sessionId: who.session,
  });
  return {
    tenant: { tenantId: asTenantId(who.tenant), countryOfCare: who.country },
    accountId: who.account,
    sessionId: who.session,
    actorNonce: nonce,
  };
}
try {
  for (const [tenant, country, host] of [
    ['Telecheck-US', 'US', 'localhost'],
    ['Telecheck-Ghana', 'GH', 'ghana.localhost'],
  ]) {
    await admin.query('SELECT public.set_tenant_context($1)', [tenant]);
    await admin.query(
      "INSERT INTO public.ccr_configs(id,tenant_id,config_key,config_value) VALUES($1,$2,'payment.processor','\"mock_local_dev\"'::jsonb) ON CONFLICT(tenant_id,config_key) DO UPDATE SET config_value=EXCLUDED.config_value",
      [ulid(), tenant],
    );
    if (
      !(await admin.query('SELECT 1 FROM public.tenant_kms_bindings WHERE tenant_id=$1', [tenant]))
        .rowCount
    )
      await provisionSyntheticBillingKms(admin, tenant);
    const author = await staff(tenant, country, 'tenant_admin', ['operator'], ['policy_author']);
    const reviewer = await staff(
      tenant,
      country,
      'tenant_admin',
      ['reviewer'],
      ['policy_reviewer'],
    );
    const patient = await register(host, tenant, country);
    await verifyStaffEnrollment({
      admin,
      ordinary,
      inject,
      context,
      staff,
      author,
      reviewer,
      patient,
    });
    const form = await request(author, '/v0/forms/consult-templates', {
      program_id: ulid(),
      name: 'Synthetic first-care intake',
      presentation: {
        contract_version: 'consult_intake_v1',
        kind: 'general_consult',
        locale: `en-${country}`,
        title: 'Synthetic care intake',
        fields: [
          { id: 'concern', type: 'text', label: 'Concern', required: true, max_length: 4000 },
        ],
        elements: [],
      },
      branching_logic: {},
      eligibility_logic: {},
      approval_governance: { mode: 'mode1', development_only: true },
    });
    await request(reviewer, `/v0/forms/consult-templates/${form.template_id}/publish`, {});
    const deployed = await request(
      author,
      `/v0/forms/consult-templates/${form.template_id}/deploy`,
      {},
    );
    const copy = {
      version_label: 'v9001.0',
      title: 'Synthetic terms',
      summary: 'Development acceptance only.',
      sections: [{ heading: 'Scope', body: 'Synthetic content, no legal or clinical approval.' }],
      withdrawal_effect: 'Synthetic withdrawal explanation.',
      duration: 'until_withdrawn',
    };
    const policy = await request(author, '/v0/consent/governance/care-policies', {
      contract_version: 'care_consent_v1',
      country_of_care: country,
      locale: `en-${country}`,
      program_id: null,
      development_only: true,
      jurisdictional_review: {
        artifact_reference: 'synthetic',
        conclusion: 'no_additional_consent',
      },
      terms: [
        { ...copy, key: 'platform', consent_type: 'platform', scope_id: null },
        { ...copy, key: 'care', consent_type: 'care', scope_id: null },
        {
          ...copy,
          key: 'ai',
          consent_type: 'data_use',
          scope_id: 'ai_interpretation',
          decline_effect: 'Manual care remains available.',
        },
      ],
    });
    await request(reviewer, `/v0/consent/governance/care-policies/${policy.policy_id}/publish`, {
      policy_hash: policy.content_hash,
    });
    await admin.query(
      "INSERT INTO public.ccr_configs(id,tenant_id,config_key,config_value) VALUES($1,$2,'consent.care_policy_publications',$3::jsonb) ON CONFLICT(tenant_id,config_key) DO UPDATE SET config_value=EXCLUDED.config_value",
      [
        ulid(),
        tenant,
        JSON.stringify({
          general: {
            publication_id: policy.policy_id,
            policy_hash: policy.content_hash,
            development_only: true,
          },
        }),
      ],
    );
    await request(patient, '/v0/consent/care/choices', {
      publication_id: policy.policy_id,
      policy_hash: policy.content_hash,
      choices: [
        { term_key: 'platform', accepted: true },
        { term_key: 'care', accepted: true },
        { term_key: 'ai', accepted: false },
      ],
    });
    const version = Number(
      (
        await admin.query(
          "SELECT COALESCE(max(version),0)+1 AS version FROM public.billing_consult_price WHERE tenant_id=$1 AND consult_type='general'",
          [tenant],
        )
      ).rows[0].version,
    );
    await request(author, '/v1/billing/consult-prices', {
      consult_type: 'general',
      version,
      amount_minor: 4900,
      turnaround_minutes: 60,
      quote_ttl_seconds: 600,
    });
    const quote = await request(patient, '/v1/billing/consult-quotes', { consult_type: 'general' });
    const consult = await request(patient, '/v1/async-consults', {
      consult_type: 'general',
      initiation_source: 'care_tab',
      accepted_quote_id: quote.quote_id,
    });
    const progressPath = `/v1/async-consults/${consult.consult_id}/care-progress`;
    const unpaidProgress = await request(patient, progressPath, undefined, 200, 'GET');
    assert.deepEqual(unpaidProgress, {
      consult_id: consult.consult_id,
      payment_intent_id: consult.payment_intent_id,
      payment_status: 'requires_payment',
      current_state: 'initiated',
      intake_status: 'not_started',
      latest_submission_id: null,
      price: {
        amount_minor: 4900,
        currency: country === 'US' ? 'USD' : 'GHS',
        provider: 'mock_local_dev',
        mode: 'mock_local_dev',
      },
    });
    const ctx = await context(patient);
    await assert.rejects(
      careIntakeTransaction(ctx)((tx) => beginCareIntake(tx, ctx, consult.consult_id)),
      (error) => error.code === 'PT409',
    );
    await request(
      patient,
      `/v1/billing/payment-intents/${consult.payment_intent_id}/mock-confirm`,
      {},
      200,
    );
    for (const [field, value] of [
      ['deployment_id', ulid()],
      ['deployment_id', undefined],
      ['deployment_id', null],
      ['deployment_id', 17],
      ['schema_hash', null],
      ['schema_hash', undefined],
      ['audit_id', 0],
      ['audit_id', null],
    ]) {
      await assert.rejects(
        careIntakeTransaction(ctx)((tx) =>
          beginCareIntake(
            {
              ...tx,
              query: (sql, params) => {
                if (/INSERT INTO domain_events_outbox/u.test(sql)) {
                  const next = [...params];
                  const payload = JSON.parse(next[6]);
                  if (value === undefined) delete payload[field];
                  else payload[field] = value;
                  next[6] = JSON.stringify(payload);
                  return tx.query(sql, next);
                }
                return tx.query(sql, params);
              },
            },
            ctx,
            consult.consult_id,
          ),
        ),
        (error) => error.code === '23514',
      );
      assert.equal(
        Number(
          (
            await admin.query(
              'SELECT count(*) AS n FROM public.consult_care_binding WHERE tenant_id=$1 AND consult_id=$2',
              [tenant, consult.consult_id],
            )
          ).rows[0].n,
        ),
        0,
      );
    }
    console.log(`${country}: 8 mismatched binding-evidence attempts roll back PASS`);
    const bound = await request(
      patient,
      `/v1/async-consults/${consult.consult_id}/intake/begin`,
      {},
      200,
    );
    assert.equal(bound.definition.deployment_id, deployed.deployment_id);
    const begunProgress = await request(patient, progressPath, undefined, 200, 'GET');
    assert.equal(begunProgress.intake_status, 'in_progress');
    assert.equal(begunProgress.payment_status, 'paid');
    const second = await request(
      patient,
      `/v1/async-consults/${consult.consult_id}/intake/begin`,
      {},
      200,
    );
    assert.deepEqual(second, bound);
    const service = createCareIntakeService({ repository: careIntakeRepository(ctx) });
    const input = {
      definition: {
        deployment_id: bound.definition.deployment_id,
        template_id: bound.definition.template_id,
        template_version: bound.definition.template_version,
        schema_hash: bound.definition.schema_hash,
      },
      answers: { concern: 'SYNTHETIC_CONFIDENTIAL_INTAKE_TEXT' },
    };
    const receipt = await request(
      patient,
      `/v1/async-consults/${consult.consult_id}/intake`,
      input,
    );
    assert.equal(receipt.status, 'submitted');
    const submittedProgress = await request(patient, progressPath, undefined, 200, 'GET');
    assert.equal(submittedProgress.intake_status, 'submitted');
    assert.equal(submittedProgress.latest_submission_id, receipt.submission_id);
    assert.equal(submittedProgress.current_state, 'submitted');
    assert(!JSON.stringify(submittedProgress).includes(input.answers.concern));
    const row = (
      await admin.query(
        'SELECT * FROM public.consult_intake_submission WHERE tenant_id=$1 AND id=$2',
        [tenant, receipt.submission_id],
      )
    ).rows[0];
    assert(!row.intake_payload_ciphertext.includes(Buffer.from(input.answers.concern)));
    assert.equal(row.intake_payload_kms_envelope_alg_version, '2');
    const proof = (
      await admin.query(
        'SELECT admission FROM public.consult_care_submission WHERE tenant_id=$1 AND submission_id=$2',
        [tenant, receipt.submission_id],
      )
    ).rows[0];
    assert.equal(proof.admission.required_care_active, true);
    assert.equal(proof.admission.ai_interpretation_active, false);
    console.log(
      `${country}: loopback HTTP, real registration/policy/form/price/quote/payment, immutable binding, actual classified encryption, submitted state and correlated evidence PASS`,
    );
    const other = await register(host, tenant, country);
    await request(other, progressPath, undefined, 404, 'GET');
    await request(author, progressPath, undefined, 403, 'GET');
    await request(patient, `${progressPath}?patient_id=${other.account}`, undefined, 400, 'GET');
    const otherCountry = country === 'US' ? 'GH' : 'US';
    const crossTenant = await register(
      otherCountry === 'US' ? 'localhost' : 'ghana.localhost',
      otherCountry === 'US' ? 'Telecheck-US' : 'Telecheck-Ghana',
      otherCountry,
    );
    await request(crossTenant, progressPath, undefined, 404, 'GET');
    await request(crossTenant, `/v1/async-consults/${consult.consult_id}/intake/begin`, {}, 404);
    await request(crossTenant, `/v1/async-consults/${consult.consult_id}/intake`, input, 404);
    await request(other, `/v1/async-consults/${consult.consult_id}/intake/begin`, {}, 404);
    await ordinary.query('BEGIN');
    try {
      await ordinary.query('SELECT set_tenant_context($1)', [tenant]);
      await ordinary.query("SELECT set_config('app.request_nonce',$1,true)", [ctx.actorNonce]);
      await ordinary.query('SET LOCAL ROLE async_consult_patient_initiator');
      await assert.rejects(
        ordinary.query(
          'SELECT public.record_consult_intake_submission($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)',
          [
            ulid(),
            tenant,
            consult.consult_id,
            patient.account,
            form.template_id,
            '1',
            Buffer.from('forged'),
            ulid(),
            Buffer.alloc(12),
            Buffer.alloc(16),
            'AES-256-GCM',
            '2',
            Buffer.from('[]'),
            new Date(),
            ulid(),
            ulid(),
            patient.account,
            'patient',
          ],
        ),
        (error) => error.code === '42501',
      );
    } finally {
      await ordinary.query('ROLLBACK');
    }
    async function nextCase() {
      const quote = await request(patient, '/v1/billing/consult-quotes', {
        consult_type: 'general',
      });
      const c = await request(patient, '/v1/async-consults', {
        consult_type: 'general',
        initiation_source: 'care_tab',
        accepted_quote_id: quote.quote_id,
      });
      await request(
        patient,
        `/v1/billing/payment-intents/${c.payment_intent_id}/mock-confirm`,
        {},
        200,
      );
      const begun = await request(
        patient,
        `/v1/async-consults/${c.consult_id}/intake/begin`,
        {},
        200,
      );
      return {
        c,
        input: {
          definition: {
            deployment_id: begun.definition.deployment_id,
            template_id: begun.definition.template_id,
            template_version: begun.definition.template_version,
            schema_hash: begun.definition.schema_hash,
          },
          answers: { concern: 'SYNTHETIC_FAILURE_CASE' },
        },
      };
    }
    async function noSubmission(c) {
      assert.equal(
        Number(
          (
            await admin.query(
              'SELECT count(*) AS n FROM public.consult_intake_submission WHERE tenant_id=$1 AND consult_id=$2',
              [tenant, c.consult_id],
            )
          ).rows[0].n,
        ),
        0,
      );
      assert.equal(
        (
          await admin.query(
            'SELECT to_state FROM public.consult_lifecycle_transition WHERE tenant_id=$1 AND consult_id=$2 ORDER BY transition_at DESC,id DESC LIMIT 1',
            [tenant, c.consult_id],
          )
        ).rows[0].to_state,
        'intake',
      );
    }
    async function delayedRequest(
      table,
      path,
      payload,
      retryKey,
      expectedBefore,
      changeBody = false,
      method = 'POST',
    ) {
      const headers = {
        host,
        authorization: `Bearer ${patient.token}`,
        'idempotency-key': retryKey,
      };
      if (expectedBefore !== null) {
        const initial = await inject({ method, url: path, headers, payload });
        assert.equal(initial.statusCode, expectedBefore, initial.body);
      }
      const oldExpiry = (
        await admin.query('SELECT expires_at FROM public.sessions WHERE session_id=$1', [
          patient.session,
        ])
      ).rows[0].expires_at;
      const blocker = new pg.Client({ connectionString: process.env.CARE_TEST_SETUP_DATABASE_URL });
      await blocker.connect();
      const pid = (await blocker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      let pending;
      try {
        await blocker.query('BEGIN');
        assert(
          [
            'idempotency_keys',
            'domain_events_outbox',
            'consult_care_submission',
            'billing_payment_intent',
          ].includes(table),
        );
        await blocker.query(`LOCK TABLE public.${table} IN ACCESS EXCLUSIVE MODE`);
        pending = inject({
          method,
          url: path,
          headers,
          payload: changeBody
            ? { ...payload, answers: { concern: 'A changed ordinary answer' } }
            : payload,
        });
        let waiting = false;
        for (let attempt = 0; attempt < 100; attempt++) {
          const blocked = await admin.query(
            'SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1::int=ANY(pg_blocking_pids(pid))) AS waiting',
            [pid],
          );
          if (blocked.rows[0].waiting) {
            waiting = true;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 15));
        }
        assert(waiting, `Expected actual ${table} request wait`);
        await admin.query(
          "UPDATE public.sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE session_id=$1",
          [patient.session],
        );
        await blocker.query('ROLLBACK');
        const denied = await pending;
        assert.equal(denied.statusCode, 401, denied.body);
        assert(!denied.body.includes('SYNTHETIC_CONFIDENTIAL'));
        assert(!denied.body.includes('submission_id'));
      } finally {
        await blocker.query('ROLLBACK');
        await blocker.end();
        if (pending) await pending;
        await admin.query('UPDATE public.sessions SET expires_at=$1 WHERE session_id=$2', [
          oldExpiry,
          patient.session,
        ]);
      }
    }
    const cached = await nextCase();
    await delayedRequest(
      'idempotency_keys',
      `/v1/async-consults/${cached.c.consult_id}/intake/begin`,
      {},
      ulid(),
      200,
    );
    const submitKey = ulid();
    await delayedRequest(
      'idempotency_keys',
      `/v1/async-consults/${cached.c.consult_id}/intake`,
      cached.input,
      submitKey,
      201,
    );
    await delayedRequest(
      'idempotency_keys',
      `/v1/async-consults/${cached.c.consult_id}/intake`,
      cached.input,
      submitKey,
      201,
      true,
    );
    const blockedWrite = await nextCase();
    await delayedRequest(
      'domain_events_outbox',
      `/v1/async-consults/${blockedWrite.c.consult_id}/intake`,
      blockedWrite.input,
      ulid(),
      null,
    );
    await noSubmission(blockedWrite.c);
    for (const table of ['consult_care_submission', 'billing_payment_intent']) {
      await delayedRequest(table, progressPath, undefined, ulid(), null, false, 'GET');
    }
    console.log(
      `${country}: live authorization after begin replay, submission replay, body mismatch, outbox and two actual care-progress read waits PASS`,
    );
    const invalid = await nextCase();
    await request(
      patient,
      `/v1/async-consults/${invalid.c.consult_id}/intake`,
      { ...invalid.input, intake_payload_envelope: {} },
      400,
    );
    await noSubmission(invalid.c);
    // Missing/invalid/reused business retry keys and malformed schema all pass
    // through the real crisis preValidation; ordinary intake stays untouched.
    for (const retryKey of [undefined, 'invalid', ulid()]) {
      const before = Number(
        (
          await admin.query(
            'SELECT count(*) AS n FROM public.crisis_care_admission WHERE tenant_id=$1 AND patient_account_id=$2',
            [tenant, patient.account],
          )
        ).rows[0].n,
      );
      const crisis = await inject({
        method: 'POST',
        url: '/v1/async-consults/invalid/intake?bad=query',
        headers: {
          host: patient.host,
          authorization: `Bearer ${patient.token}`,
          ...(retryKey ? { 'idempotency-key': retryKey } : {}),
        },
        payload: { unknown: { text: 'I want to hurt myself' }, answers: false },
      });
      assert.equal(crisis.statusCode, 202, crisis.body);
      const result = crisis.json();
      assert.equal(result.recording_status, 'recorded');
      assert.equal(result.escalation_status, 'pending');
      assert(result.crisis_event_id);
      assert.equal(
        Number(
          (
            await admin.query(
              'SELECT count(*) AS n FROM public.crisis_care_admission WHERE tenant_id=$1 AND patient_account_id=$2',
              [tenant, patient.account],
            )
          ).rows[0].n,
        ),
        before + 1,
      );
      const event = (
        await admin.query(
          'SELECT e.severity,e.crisis_type FROM public.crisis_event e WHERE e.tenant_id=$1 AND e.id=$2',
          [tenant, result.crisis_event_id],
        )
      ).rows[0];
      assert.equal(event.severity, 'unassessed');
      assert.equal(event.crisis_type, 'self_harm');
    }
    const repeatKey = ulid();
    const repeated = await Promise.all(
      Array.from({ length: 3 }, () =>
        inject({
          method: 'POST',
          url: `/v1/async-consults/${invalid.c.consult_id}/intake`,
          headers: { host, authorization: `Bearer ${patient.token}`, 'idempotency-key': repeatKey },
          payload: { ...invalid.input, unrecognized: 'I want to hurt myself' },
        }),
      ),
    );
    for (const response of repeated) assert.equal(response.statusCode, 202, response.body);
    assert.equal(new Set(repeated.map((response) => response.json().crisis_event_id)).size, 1);
    const eventId = repeated[0].json().crisis_event_id;
    const history = await request(patient, '/v1/crisis/mine', undefined, 200, 'GET');
    assert.deepEqual(
      Object.keys(history).sort(),
      ['items', 'active_event', 'offset', 'limit', 'has_more', 'resources'].sort(),
    );
    assert.equal(history.active_event.crisis_event_id, eventId);
    assert.equal(history.active_event.current_state, 'detected');
    assert.deepEqual(
      Object.keys(history.active_event).sort(),
      ['crisis_event_id', 'detected_at', 'current_state', 'state_changed_at'].sort(),
    );
    assert.equal(history.resources.country_of_care, country);
    assert.equal(history.resources.status, 'available');
    assert(history.items.some((item) => item.crisis_event_id === eventId));
    for (const unrelated of [other, crossTenant]) {
      const empty = await request(unrelated, '/v1/crisis/mine', undefined, 200, 'GET');
      assert.deepEqual(empty.items, []);
      assert.equal(empty.active_event, null);
    }
    await request(author, '/v1/crisis/mine', undefined, 403, 'GET');
    for (const invalidQuery of [
      'patient_id=' + patient.account,
      'offset=-1',
      'offset=10001',
      'offset=0.5',
      'offset=invalid',
    ])
      await request(patient, '/v1/crisis/mine?' + invalidQuery, undefined, 400, 'GET');
    // Actual admission creates enough immutable events to prove pagination and
    // durable safety state independent of the requested history page.
    const createdEvents = [eventId];
    for (let i = 0; i < 26; i++) {
      const interrupted = await request(
        patient,
        '/v1/async-consults/not-a-valid-case/intake',
        { unknown: 'I want to hurt myself' },
        202,
      );
      createdEvents.push(interrupted.crisis_event_id);
    }
    const firstPage = await request(patient, '/v1/crisis/mine', undefined, 200, 'GET');
    const secondPage = await request(patient, '/v1/crisis/mine?offset=25', undefined, 200, 'GET');
    assert.equal(firstPage.items.length, 25);
    assert.equal(firstPage.has_more, true);
    assert.equal(firstPage.active_event.crisis_event_id, createdEvents.at(-1));
    assert.equal(secondPage.active_event.crisis_event_id, firstPage.active_event.crisis_event_id);
    assert(
      !secondPage.items.some(
        (item) => item.crisis_event_id === firstPage.active_event.crisis_event_id,
      ),
    );
    assert.equal(
      new Set([...firstPage.items, ...secondPage.items].map((item) => item.crisis_event_id)).size,
      firstPage.items.length + secondPage.items.length,
    );
    const emptyPage = await request(patient, '/v1/crisis/mine?offset=10000', undefined, 200, 'GET');
    assert.deepEqual(emptyPage.items, []);
    assert.equal(emptyPage.has_more, false);
    assert.equal(emptyPage.active_event.crisis_event_id, firstPage.active_event.crisis_event_id);
    for (const table of ['crisis_event', 'crisis_event_lifecycle_transition', 'country_profiles']) {
      const victim = await register(host, tenant, country);
      const recorded = await request(
        victim,
        '/v1/async-consults/not-a-valid-case/intake',
        { unknown: 'I want to hurt myself' },
        202,
      );
      await admin.query('BEGIN');
      await admin.query('LOCK TABLE public.' + table + ' IN ACCESS EXCLUSIVE MODE');
      const blocked = inject({
        method: 'GET',
        url: '/v1/crisis/mine',
        headers: {
          host,
          authorization: `Bearer ${victim.token}`,
        },
      });
      try {
        let waiting = false;
        for (let attempt = 0; attempt < 100; attempt++) {
          await admin.query('SELECT pg_stat_clear_snapshot()');
          waiting = (
            await admin.query(
              "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name='crisis_care_bounded_read' AND wait_event_type='Lock' AND pg_backend_pid()=ANY(pg_blocking_pids(pid))) AS waiting",
            )
          ).rows[0].waiting;
          if (waiting) break;
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
        assert(waiting, `history reached ${table} read wait`);
        await admin.query(
          "UPDATE public.sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE tenant_id=$1 AND session_id=$2",
          [tenant, victim.session],
        );
        await admin.query('COMMIT');
        const denied = await blocked;
        assert.equal(denied.statusCode, 401, denied.body);
        assert(!denied.body.includes(recorded.crisis_event_id));
      } catch (error) {
        await admin.query('ROLLBACK');
        await blocked;
        throw error;
      }
    }
    console.log(
      `${country}: real crisis history/reload projection,30+ durable events,paging/global active event,otherpatient/country/admin/query denials,three blocked read expiry denials PASS`,
    );
    await noSubmission(invalid.c);
    console.log(
      `${country}: actual normal intake HTTP, legacy-envelope rejection, persisted crisis before invalid case/body/retry key, three concurrent safety retries PASS`,
    );
    const missing = await nextCase();
    const missingEvidence = createCareIntakeService({
      repository: { ...careIntakeRepository(ctx), evidence: async () => {} },
    });
    await assert.rejects(
      careIntakeTransaction(ctx)((tx) =>
        missingEvidence(tx, ctx, missing.c.consult_id, missing.input),
      ),
      (error) => error.code === '23514',
    );
    await noSubmission(missing.c);
    // Only the evidence adapter changes. Actual own-patient authorization,
    // classified encryption and ordinary-role transaction remain production code.
    const alteredEvidence = [
      ['publication_id', ulid()],
      ['publication_id', undefined],
      ['publication_id', null],
      ['publication_id', 17],
      ['ai_interpretation_active', true],
      ['ai_interpretation_active', undefined],
      ['ai_interpretation_active', null],
      ['ai_interpretation_active', 'false'],
      ['ai_interpretation_active', 0],
      ['policy_hash', null],
      ['submission_id', undefined],
      ['audit_id', 0],
    ];
    for (const [field, value] of alteredEvidence) {
      const repository = careIntakeRepository(ctx);
      const mismatched = createCareIntakeService({
        repository: {
          ...repository,
          evidence: (tx, record) =>
            repository.evidence(
              {
                ...tx,
                query: (sql, params) => {
                  if (/INSERT INTO domain_events_outbox/u.test(sql)) {
                    const next = [...params];
                    const payload = JSON.parse(next[6]);
                    if (value === undefined) delete payload[field];
                    else payload[field] = value;
                    next[6] = JSON.stringify(payload);
                    return tx.query(sql, next);
                  }
                  return tx.query(sql, params);
                },
              },
              record,
            ),
        },
      });
      await assert.rejects(
        careIntakeTransaction(ctx)((tx) =>
          mismatched(tx, ctx, missing.c.consult_id, missing.input),
        ),
        (error) => error.code === '23514',
        `mismatched ${field} / ${String(value)} must roll back`,
      );
      await noSubmission(missing.c);
    }
    console.log(
      `${country}: 12 contradictory/missing/null/wrong-type event-evidence attempts roll back PASS`,
    );
    const withdrawn = await nextCase();
    aws.beforeCrypto = async () => {
      await request(patient, '/v0/consent/care/choices', {
        publication_id: policy.policy_id,
        policy_hash: policy.content_hash,
        choices: [
          { term_key: 'platform', accepted: true },
          { term_key: 'care', accepted: false },
          { term_key: 'ai', accepted: false },
        ],
      });
    };
    await assert.rejects(
      careIntakeTransaction(ctx)((tx) => service(tx, ctx, withdrawn.c.consult_id, withdrawn.input)),
      (error) => ['PT409', 'care.consent_required'].includes(error.code),
    );
    await noSubmission(withdrawn.c);
    const withdrawnProgress = await request(patient, progressPath, undefined, 200, 'GET');
    assert.equal(withdrawnProgress.latest_submission_id, receipt.submission_id);
    assert.equal(withdrawnProgress.payment_status, 'paid');
    await request(patient, '/v0/consent/care/choices', {
      publication_id: policy.policy_id,
      policy_hash: policy.content_hash,
      choices: [
        { term_key: 'platform', accepted: true },
        { term_key: 'care', accepted: true },
        { term_key: 'ai', accepted: false },
      ],
    });
    const expired = await nextCase();
    aws.beforeCrypto = async () => {
      await admin.query(
        "UPDATE public.sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE session_id=$1",
        [patient.session],
      );
    };
    await assert.rejects(
      careIntakeTransaction(ctx)((tx) => service(tx, ctx, expired.c.consult_id, expired.input)),
      (error) => error.name === 'KmsOperationError' || ['PT401', '42501'].includes(error.code),
    );
    await noSubmission(expired.c);
    console.log(
      `${country}: wrong patient, retired ciphertext SQL capability, omitted evidence rollback, care withdrawal and session expiry during real provider boundary PASS`,
    );
  }
} finally {
  await app.close();
  await closePool();
  await closeBindActorContextPool();
  await closeBillingPool();
  await closeClassifiedKmsPool();
  aws.restore();
  await Promise.all([admin.end(), binder.end(), ordinary.end()]);
}
