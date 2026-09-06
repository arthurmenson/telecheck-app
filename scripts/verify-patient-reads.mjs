import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import http from 'node:http';
import pg from 'pg';
import { ulid } from '../src/lib/ulid.ts';

// Synthetic development acceptance only. Use an isolated, fully migrated loopback database.
assert.equal(process.env.NODE_ENV, 'development');
assert.equal(process.env.AUTH_DEV_OTP_ECHO, 'true');
assert.equal(process.env.EMAIL_PROVIDER, 'noop');
assert.equal(process.env.SMS_PROVIDER, 'noop');
const adminUrl = process.env.PATIENT_READ_ACCEPTANCE_ADMIN_DATABASE_URL;
assert.ok(adminUrl, 'An isolated migration connection is required for synthetic fixtures.');
const target = new URL(process.env.DATABASE_URL);
assert(
  ['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname),
  'Loopback acceptance database required.',
);
const dbOptions = {
  host: target.hostname,
  port: Number(target.port || 5432),
  database: target.pathname.slice(1),
};
for (const configured of [
  adminUrl,
  process.env.BIND_ACTOR_CONTEXT_DATABASE_URL,
  process.env.IDENTITY_DATABASE_URL,
  process.env.BILLING_DATABASE_URL,
]) {
  const url = new URL(configured);
  assert.equal(url.hostname, target.hostname);
  assert.equal(url.port, target.port);
  assert.equal(url.pathname, target.pathname);
}
const appConnection = new pg.Client({ connectionString: process.env.DATABASE_URL });
await appConnection.connect();
const role = (
  await appConnection.query(
    'SELECT session_user AS name, rolsuper, rolbypassrls, rolinherit FROM pg_catalog.pg_roles WHERE rolname=session_user',
  )
).rows[0];
assert.deepEqual(role, {
  name: 'telecheck_app_role',
  rolsuper: false,
  rolbypassrls: false,
  rolinherit: false,
});
await appConnection.end();
// Explicit synthetic Billing configuration for the paid history-read fixture.
// No money is charged; the price, quote, intent and consult still use public APIs.
process.env.BILLING_ALLOW_MOCK = 'true';
process.env.BILLING_CARE_READ_MOCK_SECRET = randomBytes(32).toString('hex');
process.env.BILLING_PROVIDERS_JSON = JSON.stringify(
  Object.fromEntries(
    ['Telecheck-US', 'Telecheck-Ghana'].map((tenant) => [
      tenant,
      {
        provider: 'mock_local_dev',
        mode: 'mock_local_dev',
        account: `synthetic_care_${tenant}`,
        secret_env: 'BILLING_CARE_READ_MOCK_SECRET',
        webhook_secret_env: 'BILLING_CARE_READ_MOCK_SECRET',
        return_url: 'http://localhost/care',
      },
    ]),
  ),
);
const { buildApp } = await import('../src/app.ts');
const { issueAccessToken, verifyAccessToken } = await import('../src/lib/jwt.ts');
const app = await buildApp({ logger: false });
const origin = await app.listen({ host: '127.0.0.1', port: 0 });
async function call(host, method, path, body, token) {
  return new Promise((resolve, reject) => {
    const request = http.request(
      origin + path,
      {
        method,
        headers: {
          Host: host,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          'Idempotency-Key': ulid(),
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
      },
      (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => {
          try {
            resolve({
              status: response.statusCode,
              cache: response.headers['cache-control'],
              body:
                response.statusCode === 204
                  ? null
                  : JSON.parse(Buffer.concat(chunks).toString('utf8')),
            });
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    request.on('error', reject);
    request.end(body === undefined ? undefined : JSON.stringify(body));
  });
}
const results = [];
const control = new pg.Client({ connectionString: adminUrl });
await control.connect();
const binder = new pg.Client({ connectionString: process.env.BIND_ACTOR_CONTEXT_DATABASE_URL });
await binder.connect();
const { bindActorContextForRequest } = await import('../src/lib/actor-context-binding.ts');
async function sqlRead(tenant, nonce, operation, isolation = 'READ COMMITTED') {
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    await client.query(`BEGIN ISOLATION LEVEL ${isolation}`);
    await client.query('SELECT public.set_tenant_context($1)', [tenant]);
    await client.query("SELECT pg_catalog.set_config('app.request_nonce', $1, true)", [nonce]);
    return await operation(client);
  } finally {
    await client.query('ROLLBACK');
    await client.end();
  }
}
const projection = [
  'id',
  'medication_name',
  'strength',
  'formulation',
  'dose_instructions',
  'quantity',
  'quantity_unit',
  'refills_allowed',
  'status',
  'prescribed_at',
  'activated_at',
  'expires_at',
].sort();
try {
  for (const host of ['localhost', 'ghana.heroshealth.com']) {
    const email = `synthetic-care-read-${randomUUID()}@example.invalid`;
    const start = await call(host, 'POST', '/v0/identity/registration/email/start', { email });
    assert.equal(start.status, 200, JSON.stringify(start.body.error));
    const registration = await call(host, 'POST', '/v0/identity/registration/email/verify', {
      email,
      passcode: start.body.dev_passcode,
      pin: '583926',
      first_name: 'Synthetic',
      last_name: 'CareRead',
      date_of_birth: '1990-01-01',
      gender: 'prefer_not_to_say',
    });
    assert.equal(registration.status, 201);
    const token = registration.body.access_token;
    const profile = await call(host, 'GET', '/v0/identity/accounts/me', undefined, token);
    assert.equal(profile.status, 200);
    const medicationsPath = `/v0/pharmacy/patients/${profile.body.account_id}/prescriptions`;
    const medications = await call(host, 'GET', medicationsPath, undefined, token);
    assert.equal(medications.status, 200, JSON.stringify(medications.body.error));
    assert.equal(medications.cache, 'no-store');
    assert.deepEqual(medications.body, { prescriptions: [] });
    const missingMedication = await call(
      host,
      'GET',
      '/v0/pharmacy/prescriptions/mrx_00000000000000000000000000',
      undefined,
      token,
    );
    assert.equal(missingMedication.status, 404);
    // Explicitly synthetic SQL fixture for read-boundary testing, not a completed prescribing journey.
    const tenant = host === 'localhost' ? 'Telecheck-US' : 'Telecheck-Ghana';
    const country = host === 'localhost' ? 'US' : 'GH';
    const productId = ulid(),
      medicationId = `mrx_${ulid()}`;
    await control.query('SELECT public.set_tenant_context($1)', [tenant]);
    await control.query(
      `INSERT INTO public.product_catalog
      (id,tenant_id,display_name,generic_name,form,strength,package_size,program,category,available_adapters,preferred_adapter,is_compounded,pricing,subscription_eligible,status)
      VALUES ($1,$2,'Synthetic read fixture','synthetic','tablet','fixture','fixture','weight_loss','primary_treatment','["truepill"]','truepill',false,'{"monthly":0}',false,'active')`,
      [productId, tenant],
    );
    await control.query(
      `INSERT INTO public.medication_requests
      (id,tenant_id,patient_account_id,product_catalog_id,medication_name,strength,formulation,dose_instructions,quantity,quantity_unit,refills_allowed,clinical_notes,status,country_of_care)
      VALUES ($1,$2,$3,$4,'Synthetic read fixture','fixture','tablet','Synthetic fixture only',1,'tablet',0,'INTERNAL-DO-NOT-RETURN','draft',$5)`,
      [medicationId, tenant, profile.body.account_id, productId, country],
    );
    const populated = await call(host, 'GET', medicationsPath, undefined, token);
    assert.equal(populated.status, 200);
    assert.equal(populated.body.prescriptions.length, 1);
    assert.deepEqual(Object.keys(populated.body.prescriptions[0]).sort(), projection);
    assert(!JSON.stringify(populated.body).includes('INTERNAL-DO-NOT-RETURN'));
    const detail = await call(
      host,
      'GET',
      `/v0/pharmacy/prescriptions/${medicationId}`,
      undefined,
      token,
    );
    assert.equal(detail.status, 200);
    assert.deepEqual(detail.body, populated.body.prescriptions[0]);
    const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
    const { nonce } = await bindActorContextForRequest(binder, {
      actorAccountId: profile.body.account_id,
      actorAccountTenantId: tenant,
      actorRole: 'patient',
      actorAdminHomeTenantId: null,
      sessionId: claims.session_id,
    });
    for (const query of [
      'SELECT id FROM public.medication_requests',
      'SELECT nonce FROM public._session_actor_context',
      'SELECT * FROM public.read_patient_medication_requests()',
      'SELECT * FROM public.async_consult_assert_live_patient()',
      'SET LOCAL ROLE pharmacy_patient_read_owner',
      'SET LOCAL ROLE async_consult_history_read_owner',
      'SET LOCAL ROLE bind_actor_context_role',
      'SET LOCAL ROLE identity_service_role',
      'SET LOCAL ROLE kms_service_role',
    ]) {
      await assert.rejects(
        sqlRead(tenant, nonce, (client) => client.query(query)),
        (error) => error.code === '42501',
      );
    }
    for (const [reader, operation] of [
      ['pharmacy_patient_reader', 'SELECT * FROM public.read_patient_medication_requests()'],
      ['async_consult_patient_reader', 'SELECT * FROM public.async_consult_assert_live_patient()'],
    ]) {
      for (const isolation of ['REPEATABLE READ', 'SERIALIZABLE']) {
        await assert.rejects(
          sqlRead(
            tenant,
            nonce,
            async (client) => {
              await client.query(`SET LOCAL ROLE ${reader}`);
              return client.query(operation);
            },
            isolation,
          ),
          (error) => error.code === 'PT503',
        );
      }
      for (const invalidNonce of ['', randomUUID(), 'malformed']) {
        await assert.rejects(
          sqlRead(tenant, invalidNonce, async (client) => {
            await client.query(`SET LOCAL ROLE ${reader}`);
            return client.query(operation);
          }),
          (error) => error.code === 'PT401',
        );
      }
    }
    const shadow = await sqlRead(tenant, nonce, async (client) => {
      for (const table of [
        'medication_requests',
        'accounts',
        'sessions',
        'tenants',
        '_session_actor_context',
      ])
        await client.query(`CREATE TEMP TABLE ${table} (placeholder TEXT)`);
      await client.query('SET LOCAL search_path = pg_temp, public, pg_catalog');
      await client.query('SET LOCAL ROLE pharmacy_patient_reader');
      return client.query('SELECT * FROM public.read_patient_medication_requests()');
    });
    assert.equal(shadow.rows.length, 1);
    assert.equal(shadow.rows[0].id, medicationId);
    for (const denial of ['deleted', 'revoked']) {
      const blocker = new pg.Client({ connectionString: adminUrl });
      await blocker.connect();
      await blocker.query('BEGIN');
      await blocker.query('LOCK TABLE public.medication_requests IN ACCESS EXCLUSIVE MODE');
      let requestFinished = false;
      const pending = call(host, 'GET', medicationsPath, undefined, token).finally(() => {
        requestFinished = true;
      });
      try {
        let blocked = false;
        for (let attempt = 0; attempt < 100; attempt++) {
          const waiting = await control.query(
            "SELECT count(*)::int AS count FROM pg_catalog.pg_stat_activity WHERE datname=$1 AND usename='telecheck_app_role' AND wait_event_type='Lock' AND query LIKE '%read_patient_medication_requests%'",
            [dbOptions.database],
          );
          if (waiting.rows[0].count > 0) {
            blocked = true;
            break;
          }
          if (requestFinished) break;
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        assert(blocked, 'real medication query must wait on independent lock');
        if (denial === 'deleted')
          await control.query(
            'UPDATE public.accounts SET deleted_at=clock_timestamp() WHERE account_id=$1',
            [profile.body.account_id],
          );
        else
          await control.query(
            "UPDATE public.sessions SET revoked_at=clock_timestamp(), revoked_reason='admin_revoked' WHERE session_id=$1",
            [claims.session_id],
          );
      } finally {
        await blocker.query('COMMIT');
        await blocker.end();
      }
      const denied = await pending;
      assert.equal(denied.status, 401);
      assert(!JSON.stringify(denied.body).includes('Synthetic read fixture'));
      await control.query('UPDATE public.accounts SET deleted_at=NULL WHERE account_id=$1', [
        profile.body.account_id,
      ]);
      await control.query(
        'UPDATE public.sessions SET revoked_at=NULL,revoked_reason=NULL WHERE session_id=$1',
        [claims.session_id],
      );
    }
    const history = await call(host, 'GET', '/v1/async-consults', undefined, token);
    assert.equal(history.status, 200);
    assert.equal(history.cache, 'no-store');
    assert.deepEqual(history.body, { rows: [], limit: 25, offset: 0, has_more: false });
    // Synthetic paid fixture through the real price → quote → intent → consult
    // boundary, so nonempty expiry controls obey the Billing FK and intake gate.
    await control.query(
      `INSERT INTO public.ccr_configs(id,tenant_id,config_key,config_value)
       VALUES($1,$2,'payment.processor','"mock_local_dev"'::jsonb)
       ON CONFLICT(tenant_id,config_key) DO UPDATE SET config_value=EXCLUDED.config_value`,
      [ulid(), tenant],
    );
    const operatorEmail = `synthetic-care-operator-${randomUUID()}@example.invalid`;
    const operatorStart = await call(host, 'POST', '/v0/identity/registration/email/start', {
      email: operatorEmail,
    });
    assert.equal(operatorStart.status, 200);
    const operator = await call(host, 'POST', '/v0/identity/registration/email/verify', {
      email: operatorEmail,
      passcode: operatorStart.body.dev_passcode,
      pin: '583926',
      first_name: 'Synthetic',
      last_name: 'CareOperator',
      date_of_birth: '1990-01-01',
      gender: 'prefer_not_to_say',
    });
    assert.equal(operator.status, 201);
    const verifiedOperator = verifyAccessToken(
      operator.body.access_token,
      process.env.JWT_SIGNING_KEY,
    );
    assert(verifiedOperator.ok);
    const operatorClaims = verifiedOperator.claims;
    // Explicit synthetic operator provisioning; the nonce resolves this actual live session.
    await control.query(
      "UPDATE public.accounts SET account_type='tenant_admin' WHERE tenant_id=$1 AND account_id=$2",
      [tenant, operatorClaims.sub],
    );
    const adminToken = issueAccessToken(
      {
        account_id: operatorClaims.sub,
        tenant_id: tenant,
        session_id: operatorClaims.session_id,
        role: 'tenant_admin',
        admin_tenant_binding: tenant,
        country_of_care: country,
      },
      process.env.JWT_SIGNING_KEY,
    );
    const version = Number(
      (
        await control.query(
          'SELECT COALESCE(max(version),0)+1 AS v FROM public.billing_consult_price WHERE tenant_id=$1 AND consult_type=$2',
          [tenant, 'general'],
        )
      ).rows[0].v,
    );
    const price = await call(
      host,
      'POST',
      '/v1/billing/consult-prices',
      {
        consult_type: 'general',
        version,
        amount_minor: 100,
        turnaround_minutes: 60,
        quote_ttl_seconds: 600,
      },
      adminToken,
    );
    assert.equal(price.status, 201, JSON.stringify(price.body.error));
    const quote = await call(
      host,
      'POST',
      '/v1/billing/consult-quotes',
      { consult_type: 'general' },
      token,
    );
    assert.equal(quote.status, 201);
    const initiated = await call(
      host,
      'POST',
      '/v1/async-consults',
      {
        consult_type: 'general',
        initiation_source: 'care_tab',
        accepted_quote_id: quote.body.quote_id,
      },
      token,
    );
    assert.equal(initiated.status, 201, JSON.stringify(initiated.body.error));
    const consultId = initiated.body.consult_id;
    const paid = await call(
      host,
      'POST',
      `/v1/billing/payment-intents/${initiated.body.payment_intent_id}/mock-confirm`,
      {},
      token,
    );
    assert.equal(paid.status, 200);
    const populatedHistory = await call(host, 'GET', '/v1/async-consults', undefined, token);
    assert.equal(populatedHistory.status, 200);
    assert.equal(populatedHistory.body.rows.length, 1);
    assert.equal(populatedHistory.body.rows[0].consult_id, consultId);
    for (const kind of ['medication', 'history']) {
      for (const expiration of ['session', 'nonce']) {
        const blocker = new pg.Client({ connectionString: adminUrl });
        await blocker.connect();
        await blocker.query('BEGIN');
        const relation = kind === 'history' ? 'consult' : 'medication_requests';
        await blocker.query(`LOCK TABLE public.${relation} IN ACCESS EXCLUSIVE MODE`);
        // The JWT remains valid; only the owned persisted session is expiring.
        if (expiration === 'session') {
          await control.query(
            "UPDATE public.sessions SET expires_at=clock_timestamp()+interval '1 second' WHERE session_id=$1",
            [claims.session_id],
          );
        }
        let finished = false;
        const pending = call(
          host,
          'GET',
          kind === 'history' ? '/v1/async-consults' : medicationsPath,
          undefined,
          token,
        ).finally(() => {
          finished = true;
        });
        try {
          let blocked = false;
          for (let attempt = 0; attempt < 100; attempt++) {
            const waiting = await control.query(
              "SELECT count(*)::int AS count FROM pg_catalog.pg_stat_activity WHERE datname=$1 AND usename='telecheck_app_role' AND wait_event_type='Lock' AND query LIKE $2",
              [
                dbOptions.database,
                kind === 'history'
                  ? '%async_consult_patient_summary_v%'
                  : '%read_patient_medication_requests%',
              ],
            );
            if (waiting.rows[0].count > 0) {
              blocked = true;
              break;
            }
            if (finished) break;
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
          assert(
            blocked,
            'read must reach the protected relation after successful preauthorization',
          );
          if (expiration === 'nonce') {
            await control.query(
              "UPDATE public._session_actor_context SET expires_at=clock_timestamp()+interval '0.1 second' WHERE actor_account_id=$1",
              [profile.body.account_id],
            );
          }
          await new Promise((resolve) =>
            setTimeout(resolve, expiration === 'session' ? 1100 : 200),
          );
          const expired =
            expiration === 'session'
              ? await control.query(
                  'SELECT expires_at <= clock_timestamp() AS expired FROM public.sessions WHERE session_id=$1',
                  [claims.session_id],
                )
              : await control.query(
                  'SELECT bool_and(expires_at <= clock_timestamp()) AS expired FROM public._session_actor_context WHERE actor_account_id=$1',
                  [profile.body.account_id],
                );
          assert.equal(expired.rows[0].expired, true);
        } finally {
          await blocker.query('COMMIT');
          await blocker.end();
        }
        try {
          const denied = await pending;
          assert.equal(
            denied.status,
            401,
            `${country} ${kind} ${expiration} expiry must deny disclosure`,
          );
          assert.equal(denied.cache, 'no-store');
          assert.equal(denied.body.rows, undefined);
          assert.equal(denied.body.prescriptions, undefined);
        } finally {
          await control.query(
            "UPDATE public.sessions SET expires_at=clock_timestamp()+interval '1 hour' WHERE session_id=$1",
            [claims.session_id],
          );
        }
      }
    }
    const foreign = await call(
      host === 'localhost' ? 'ghana.heroshealth.com' : 'localhost',
      'GET',
      '/v1/async-consults',
      undefined,
      token,
    );
    assert.equal(foreign.status, 401);
    const logout = await call(
      host,
      'POST',
      '/v0/identity/sessions/logout',
      { refresh_token: registration.body.refresh_token },
      token,
    );
    assert.equal(logout.status, 204);
    const revoked = await call(host, 'GET', '/v1/async-consults', undefined, token);
    assert.equal(revoked.status, 401);
    assert.equal((await call(host, 'GET', medicationsPath, undefined, token)).status, 401);
    results.push({
      host,
      registration: true,
      persistedEmptyHistory: true,
      realMedicationList: true,
      exactProjection: true,
      rawTableAndOwnerDenied: true,
      strongerIsolationDenied: true,
      malformedNonceDenied: true,
      shadowObjectsIgnored: true,
      concurrentDeletionAndRevocationDenied: true,
      historyAndMedicationWallClockExpiryDenied: true,
      syntheticPaidBillingHistoryFixture: true,
      missingMedication: true,
      noStore: true,
      foreignTenantDenied: true,
      revokedSessionDenied: true,
    });
  }
  console.log(
    JSON.stringify({
      checkedAt: new Date().toISOString(),
      syntheticOnly: true,
      actualHttp: true,
      actualFourRoleConnections: true,
      results,
    }),
  );
  console.log(
    'PASS: real HTTP, four ordinary login roles, US/GH registration, synthetic Billing-paid history fixtures, exact medication projections, SQL isolation and concurrent revocation denials. No clinical journey completion claim.',
  );
} finally {
  await binder.end();
  await control.end();
  await app.close();
  const { closePool, closeBindActorContextPool } = await import('../src/lib/db.ts');
  await closePool();
  await closeBindActorContextPool();
  const { closeBillingPool } = await import('../src/modules/billing/internal/database.ts');
  await closeBillingPool();
}
