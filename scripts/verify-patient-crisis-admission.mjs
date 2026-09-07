/** Synthetic real-HTTP harness for the public module API; no production test route. */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import http from 'node:http';
import pg from 'pg';
import { bindActorContextForRequest } from '../src/lib/actor-context-binding.ts';
import { requirePatientActorContext } from '../src/lib/auth-context.ts';
import { closePool, closeBindActorContextPool } from '../src/lib/db.ts';
import { requireTenantContext } from '../src/lib/tenant-context.ts';
import { admitPatientCareInput } from '../src/modules/crisis-response/index.ts';

assert.equal(process.env.NODE_ENV, 'development');
assert.equal(process.env.AUTH_DEV_OTP_ECHO, 'true');
assert.equal(process.env.EMAIL_PROVIDER, 'noop');
const target = new URL(process.env.DATABASE_URL);
assert(['127.0.0.1', 'localhost'].includes(target.hostname));
for (const name of [
  'CRISIS_ACCEPTANCE_ADMIN_DATABASE_URL',
  'BIND_ACTOR_CONTEXT_DATABASE_URL',
  'IDENTITY_DATABASE_URL',
]) {
  const value = new URL(process.env[name]);
  assert.equal(value.host, target.host);
  assert.equal(value.pathname, target.pathname);
}
const control = new pg.Client({
  connectionString: process.env.CRISIS_ACCEPTANCE_ADMIN_DATABASE_URL,
});
const ordinary = new pg.Client({ connectionString: process.env.DATABASE_URL });
const binder = new pg.Client({ connectionString: process.env.BIND_ACTOR_CONTEXT_DATABASE_URL });
await Promise.all([control.connect(), ordinary.connect(), binder.connect()]);
const role = (
  await ordinary.query(
    'SELECT session_user AS name,rolsuper,rolinherit,rolbypassrls FROM pg_roles WHERE rolname=session_user',
  )
).rows[0];
assert.deepEqual(role, {
  name: 'telecheck_app_role',
  rolsuper: false,
  rolinherit: false,
  rolbypassrls: false,
});
const { buildApp } = await import('../src/app.ts');
const app = await buildApp({ logger: false });
let ordinaryValidationCount = 0;
app.post('/__synthetic-crisis-admission', async (req, reply) => {
  const tenant = requireTenantContext(req),
    actor = requirePatientActorContext(req);
  assert(req.actorNonce);
  const result = await admitPatientCareInput(
    {
      tenant,
      accountId: actor.accountId,
      sessionId: actor.sessionId,
      actorNonce: req.actorNonce,
      idempotencyKey: req.headers['idempotency-key'],
    },
    req.body,
    'form_response',
  );
  reply.header('Cache-Control', 'no-store');
  if (result.kind === 'crisis_interruption')
    return reply.code(result.recording_status === 'recorded' ? 409 : 503).send(result);
  ordinaryValidationCount++;
  return reply.code(400).send({ error: 'synthetic_business_validation_failed' });
});
const origin = await app.listen({ host: '127.0.0.1', port: 0 });
async function call(host, path, body, token, key = randomUUID()) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      origin + path,
      {
        method: 'POST',
        headers: {
          host,
          'content-type': 'application/json',
          'idempotency-key': key,
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          try {
            resolve({
              status: res.statusCode,
              cache: res.headers['cache-control'],
              body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
            });
          } catch (e) {
            reject(e);
          }
        });
      },
    );
    req.on('error', reject);
    req.end(JSON.stringify(body));
  });
}
async function register(host, tenant, country) {
  const email = `synthetic-crisis-${randomUUID()}@example.invalid`;
  const start = await call(host, '/v0/identity/registration/email/start', { email });
  assert.equal(start.status, 200);
  const verified = await call(host, '/v0/identity/registration/email/verify', {
    email,
    passcode: start.body.dev_passcode,
    pin: '583926',
    first_name: 'Synthetic',
    last_name: 'Crisis',
    date_of_birth: '1990-01-01',
    gender: 'prefer_not_to_say',
  });
  assert.equal(verified.status, 201);
  const token = verified.body.access_token,
    claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url'));
  return {
    host,
    tenant,
    country,
    token,
    accountId: claims.sub,
    sessionId: claims.session_id,
  };
}
async function bound(who, work, actorRole = 'patient') {
  const context = await bindActorContextForRequest(binder, {
    actorAccountId: who.accountId,
    actorAccountTenantId: who.tenant,
    actorRole,
    actorAdminHomeTenantId: null,
    sessionId: who.sessionId,
  });
  await ordinary.query('BEGIN');
  try {
    await ordinary.query('SELECT public.set_tenant_context($1)', [who.tenant]);
    await ordinary.query("SELECT set_config('app.request_nonce',$1,true)", [context.nonce]);
    return await work(context.nonce);
  } finally {
    await ordinary.query('ROLLBACK');
  }
}
let assertions = 0;
async function delayedAuthorization(who, fault) {
  const lock = new pg.Client({
    connectionString: process.env.CRISIS_ACCEPTANCE_ADMIN_DATABASE_URL,
  });
  await lock.connect();
  let response;
  try {
    await lock.query('BEGIN');
    await lock.query('LOCK TABLE public.crisis_care_admission IN ACCESS EXCLUSIVE MODE');
    const request = call(
      who.host,
      '/__synthetic-crisis-admission',
      { invalid_field: 'in crisis' },
      who.token,
    );
    let waiting = false;
    for (let i = 0; i < 100; i++) {
      const activity = await control.query(
        "SELECT count(*)::INT AS n FROM pg_stat_activity WHERE usename='telecheck_app_role' AND wait_event_type='Lock' AND query LIKE '%crisis_care_record%'",
      );
      if (activity.rows[0].n > 0) {
        waiting = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert(waiting, 'request reached the deliberately blocked SQL admission');
    if (fault === 'nonce_expired')
      await control.query(
        "UPDATE public._session_actor_context SET expires_at=clock_timestamp()-interval '1 second' WHERE actor_account_tenant_id=$1 AND actor_account_id=$2",
        [who.tenant, who.accountId],
      );
    else if (fault === 'session_expired')
      await control.query(
        "UPDATE public.sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE tenant_id=$1 AND session_id=$2",
        [who.tenant, who.sessionId],
      );
    else
      await control.query(
        "UPDATE public.accounts SET status='suspended' WHERE tenant_id=$1 AND account_id=$2",
        [who.tenant, who.accountId],
      );
    await lock.query('COMMIT');
    response = await request;
  } finally {
    await lock.query('ROLLBACK');
    await lock.end();
  }
  assert.equal(response.status, 401);
  const count = await control.query(
    'SELECT count(*)::INT AS n FROM public.crisis_care_admission WHERE tenant_id=$1 AND patient_account_id=$2',
    [who.tenant, who.accountId],
  );
  assert.equal(count.rows[0].n, 0);
}
try {
  for (const [host, tenant, country] of [
    ['localhost', 'Telecheck-US', 'US'],
    ['ghana.localhost', 'Telecheck-Ghana', 'GH'],
  ]) {
    const who = await register(host, tenant, country),
      other = await register(host, tenant, country);
    for (const fault of ['nonce_expired', 'session_expired', 'account_suspended'])
      await delayedAuthorization(await register(host, tenant, country), fault);
    const marker = `SYNTHETIC-PRIVATE-${randomUUID()}`;
    const body = {
      wrong_form_id: 'invalid',
      unknown: { nested: [false, 123, { unexpected: `${marker} I am being abused` }] },
      patient_account_id: other.accountId,
      severity: 'non_imminent',
    };
    const key = randomUUID();
    const attempts = await Promise.all(
      Array.from({ length: 4 }, () =>
        call(host, '/__synthetic-crisis-admission', body, who.token, key),
      ),
    );
    for (const result of attempts) {
      assert.equal(result.status, 409);
      assert.equal(result.cache, 'no-store');
      assert.equal(result.body.recording_status, 'recorded');
    }
    const first = attempts[0].body;
    assert(attempts.every((result) => result.body.crisis_event_id === first.crisis_event_id));
    assert.equal(first.resources.country_of_care, country);
    assert.equal(first.resources.status, 'available');
    assert.equal(first.escalation_status, 'pending');
    const event = (
      await control.query('SELECT * FROM public.crisis_event WHERE tenant_id=$1 AND id=$2', [
        tenant,
        first.crisis_event_id,
      ])
    ).rows[0];
    assert.equal(event.patient_account_id, who.accountId);
    assert.equal(event.crisis_type, 'abuse_disclosure');
    assert.equal(event.severity, 'unassessed');
    assert.equal(event.intake_payload_ciphertext, null);
    const audits = (
      await control.query(
        "SELECT * FROM public.audit_records WHERE tenant_id=$1 AND resource_id=$2 AND action='crisis.detected'",
        [tenant, event.id],
      )
    ).rows;
    assert.equal(audits.length, 1);
    assert.equal(audits[0].actor_type, 'patient');
    assert.equal(audits[0].actor_id, who.accountId);
    const outbox = (
      await control.query(
        'SELECT * FROM public.domain_events_outbox WHERE tenant_id=$1 AND aggregate_id=$2',
        [tenant, event.id],
      )
    ).rows;
    assert.equal(outbox.length, 1);
    assert.equal(outbox[0].payload.escalation_status, 'pending');
    assert(!JSON.stringify({ event, audits, outbox }).includes(marker));
    assert.equal(ordinaryValidationCount, 0);
    const otherResult = await call(host, '/__synthetic-crisis-admission', body, other.token, key);
    assert.equal(otherResult.status, 409);
    assert.notEqual(otherResult.body.crisis_event_id, event.id);
    const wrongTenant = await call(
      country === 'US' ? 'ghana.localhost' : 'localhost',
      '/__synthetic-crisis-admission',
      body,
      who.token,
      key,
    );
    assert(
      [400, 401, 403].includes(wrongTenant.status),
      `wrong-tenant status ${wrongTenant.status}`,
    );
    // Direct SQL cannot commit without Cat A + outbox evidence or read private PHI.
    await bound(who, async () => {
      await ordinary.query('SET LOCAL ROLE crisis_care_patient');
      await ordinary.query('SELECT public.crisis_care_record($1,$2,$3)', [
        'self_harm',
        'forms',
        createHash('sha256').update(randomUUID()).digest('hex'),
      ]);
      await assert.rejects(
        () => ordinary.query('SET CONSTRAINTS ALL IMMEDIATE'),
        (error) => error.code === '23514',
      );
    });
    await bound(who, async () => {
      await assert.rejects(
        () => ordinary.query('SELECT * FROM public.crisis_care_admission'),
        (error) => error.code === '42501',
      );
    });
    await bound(who, async () => {
      await ordinary.query('SET LOCAL ROLE crisis_initiator');
      await assert.rejects(
        () =>
          ordinary.query('SELECT public.record_crisis_initiation($1,$2,$3,$4,$5,$6)', [
            tenant,
            who.accountId,
            event.server_signal_id,
            'abuse_disclosure',
            'unassessed',
            false,
          ]),
        (error) => error.code === '42501',
      );
    });
    // Fault injection uses real PostgreSQL triggers, with no app mocks.
    const triggerName = 'synthetic_crisis_outbox_failure';
    await control.query(
      `CREATE OR REPLACE FUNCTION pg_temp.fail_crisis_outbox() RETURNS TRIGGER LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic_outbox_unavailable'; END $$`,
    );
    await control.query(
      `CREATE TRIGGER ${triggerName} BEFORE INSERT ON public.domain_events_outbox FOR EACH ROW WHEN (NEW.event_type='crisis.detected.v1') EXECUTE FUNCTION pg_temp.fail_crisis_outbox()`,
    );
    let failed;
    const failKey = randomUUID();
    try {
      failed = await call(host, '/__synthetic-crisis-admission', body, who.token, failKey);
    } finally {
      await control.query(`DROP TRIGGER ${triggerName} ON public.domain_events_outbox`);
    }
    assert.equal(failed.status, 503);
    assert.equal(failed.body.recording_status, 'not_recorded');
    assert.equal(failed.body.escalation_status, 'not_queued');
    assert(!failed.body.crisis_event_id);
    assert.equal(failed.body.resources.status, 'available');
    const recovered = await call(host, '/__synthetic-crisis-admission', body, who.token, failKey);
    assert.equal(recovered.status, 409);
    await control.query(
      "UPDATE public.sessions SET revoked_at=clock_timestamp(),revoked_reason='patient_logout' WHERE tenant_id=$1 AND session_id=$2",
      [tenant, who.sessionId],
    );
    assert.equal(
      (await call(host, '/__synthetic-crisis-admission', body, who.token, key)).status,
      401,
    );
    const auth = await bindActorContextForRequest(binder, {
      actorAccountId: who.accountId,
      actorAccountTenantId: tenant,
      actorRole: 'patient',
      actorAdminHomeTenantId: null,
      sessionId: who.sessionId,
    });
    await assert.rejects(
      () =>
        admitPatientCareInput(
          {
            tenant: { tenantId: tenant, countryOfCare: country },
            accountId: who.accountId,
            sessionId: who.sessionId,
            actorNonce: auth.nonce,
            idempotencyKey: key,
          },
          body,
          'form_response',
        ),
      (error) => error.code === 'PT401',
    );
    // Business-invalid ordinary input reaches ordinary validation only after no detection.
    assert.equal(
      (await call(host, '/__synthetic-crisis-admission', { invalid: true }, other.token)).status,
      400,
    );
    ordinaryValidationCount = 0;
    assertions += 24;
  }
  console.log(
    JSON.stringify({
      status: 'passed',
      assertion_groups: assertions,
      markets: ['US', 'GH'],
      transport: 'real loopback HTTP; synthetic ingress harness',
      roles: 'ordinary app + separate bind/Identity',
      retained_trigger_text: false,
      notification_delivery_verified: false,
    }),
  );
} finally {
  await app.close();
  await closePool();
  await closeBindActorContextPool();
  await Promise.all([control.end(), ordinary.end(), binder.end()]);
}
