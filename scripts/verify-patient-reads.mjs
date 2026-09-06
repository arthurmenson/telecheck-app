import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
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
const { buildApp } = await import('../src/app.ts');
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
          'Idempotency-Key': randomUUID(),
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
      'SET LOCAL ROLE pharmacy_patient_read_owner',
      'SET LOCAL ROLE bind_actor_context_role',
      'SET LOCAL ROLE identity_service_role',
      'SET LOCAL ROLE kms_service_role',
    ]) {
      await assert.rejects(
        sqlRead(tenant, nonce, (client) => client.query(query)),
        (error) => error.code === '42501',
      );
    }
    for (const isolation of ['REPEATABLE READ', 'SERIALIZABLE']) {
      await assert.rejects(
        sqlRead(
          tenant,
          nonce,
          async (client) => {
            await client.query('SET LOCAL ROLE pharmacy_patient_reader');
            return client.query('SELECT * FROM public.read_patient_medication_requests()');
          },
          isolation,
        ),
        (error) => error.code === 'PT503',
      );
    }
    for (const invalidNonce of ['', randomUUID(), 'malformed']) {
      await assert.rejects(
        sqlRead(tenant, invalidNonce, async (client) => {
          await client.query('SET LOCAL ROLE pharmacy_patient_reader');
          return client.query('SELECT * FROM public.read_patient_medication_requests()');
        }),
        (error) => error.code === 'PT401',
      );
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
      actualThreeRoleConnections: true,
      results,
    }),
  );
  console.log(
    'PASS: real HTTP, three ordinary login roles, US/GH registration, history, exact medication projections, SQL isolation and concurrent revocation denials. No clinical journey completion claim.',
  );
} finally {
  await binder.end();
  await control.end();
  await app.close();
  const { closePool, closeBindActorContextPool } = await import('../src/lib/db.ts');
  await closePool();
  await closeBindActorContextPool();
}
