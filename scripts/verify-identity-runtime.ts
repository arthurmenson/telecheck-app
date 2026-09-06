/** Synthetic acceptance probe using real ordinary-role application connections. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import pg from 'pg';

// Fail before importing the application or generating any account data.
assert.equal(process.env['NODE_ENV'], 'development');
assert.equal(process.env['AUTH_DEV_OTP_ECHO'], 'true');
assert.equal(process.env['EMAIL_PROVIDER'], 'noop');
assert.equal(process.env['SMS_PROVIDER'], 'noop');
assert.ok(process.env['BIND_ACTOR_CONTEXT_DATABASE_URL']);
const appConnection = new pg.Client({ connectionString: process.env['DATABASE_URL'] });
await appConnection.connect();
const bindConnection = new pg.Client({
  connectionString: process.env['BIND_ACTOR_CONTEXT_DATABASE_URL'],
});
await bindConnection.connect();
try {
  for (const [connection, expectedRole] of [
    [appConnection, 'telecheck_app_role'],
    [bindConnection, 'bind_actor_context_role'],
  ] as const) {
    const role = (
      await connection.query(
        'SELECT rolname, rolsuper, rolbypassrls, rolinherit FROM pg_roles WHERE rolname=session_user',
      )
    ).rows[0] as { rolname: string; rolsuper: boolean; rolbypassrls: boolean; rolinherit: boolean };
    assert.equal(role.rolname, expectedRole);
    assert.equal(role.rolsuper, false);
    assert.equal(role.rolbypassrls, false);
    if (expectedRole === 'telecheck_app_role') assert.equal(role.rolinherit, false);
  }
} finally {
  await appConnection.end();
  await bindConnection.end();
}

const { buildApp } = await import('../src/app.js');
const app = await buildApp({ logger: false });
const usHost = process.env['IDENTITY_PROBE_US_HOST'] ?? 'localhost';
const ghHost = process.env['IDENTITY_PROBE_GH_HOST'] ?? 'ghana.localhost';
async function register(host: string) {
  const email = `synthetic-runtime-${randomUUID()}@example.invalid`;
  const start = await app.inject({
    method: 'POST',
    url: '/v0/identity/registration/email/start',
    headers: { host, 'idempotency-key': randomUUID() },
    payload: { email },
  });
  assert.equal(start.statusCode, 200);
  const verify = await app.inject({
    method: 'POST',
    url: '/v0/identity/registration/email/verify',
    headers: { host, 'idempotency-key': randomUUID() },
    payload: {
      email,
      passcode: start.json<{ dev_passcode: string }>().dev_passcode,
      pin: '583926',
      first_name: 'Synthetic',
      last_name: 'Runtime',
      date_of_birth: '1990-01-01',
      gender: 'prefer_not_to_say',
    },
  });
  assert.equal(verify.statusCode, 201);
  const session = verify.json<{ access_token: string; refresh_token: string }>();
  const headers = { host, authorization: `Bearer ${session.access_token}` };
  const own = await app.inject({ method: 'GET', url: '/v0/identity/accounts/me', headers });
  assert.equal(own.statusCode, 200);
  assert.ok(!own.body.includes('"tenant_id"'));
  return { headers, ...session, accountId: own.json<{ account_id: string }>().account_id };
}
try {
  for (const host of [usHost, ghHost]) {
    const brand = await app.inject({
      method: 'GET',
      url: '/v0/tenant-config/me',
      headers: { host },
    });
    assert.equal(brand.statusCode, 200);
  }
  const own = await register(usHost);
  const other = await register(usHost);
  const ghana = await register(ghHost);
  const headers = { ...own.headers, 'idempotency-key': randomUUID() };
  const payload = { platform: 'web', device_public_key: 'SYNTHETIC-ACCEPTANCE-PUBLIC-KEY' };
  const registered = await app.inject({
    method: 'POST',
    url: '/v0/identity/devices',
    headers,
    payload,
  });
  assert.equal(registered.statusCode, 201);
  assert.equal(registered.json<{ account_id: string }>().account_id, own.accountId);
  const deviceId = registered.json<{ device_id: string }>().device_id;
  const replay = await app.inject({
    method: 'POST',
    url: '/v0/identity/devices',
    headers,
    payload,
  });
  assert.equal(replay.statusCode, 201);
  assert.equal(replay.json<{ device_id: string }>().device_id, deviceId);
  const foreignRevoke = await app.inject({
    method: 'DELETE',
    url: `/v0/identity/devices/${deviceId}`,
    headers: { ...other.headers, 'idempotency-key': randomUUID() },
  });
  assert.equal(foreignRevoke.statusCode, 204);
  const list = await app.inject({
    method: 'GET',
    url: '/v0/identity/devices',
    headers: own.headers,
  });
  assert.equal(list.statusCode, 200);
  assert.equal(list.json<{ devices: unknown[] }>().devices.length, 1);
  for (const authorization of [undefined, ghana.headers.authorization]) {
    const denied = await app.inject({
      method: 'GET',
      url: '/v0/identity/accounts/me',
      headers: {
        host: usHost,
        'x-account-id': own.accountId,
        ...(authorization ? { authorization } : {}),
      },
    });
    assert.equal(denied.statusCode, 401);
  }
  const logout = await app.inject({
    method: 'POST',
    url: '/v0/identity/sessions/logout',
    headers: { ...own.headers, 'idempotency-key': randomUUID() },
    payload: { refresh_token: own.refresh_token },
  });
  assert.equal(logout.statusCode, 204);
  const revokedReplay = await app.inject({
    method: 'POST',
    url: '/v0/identity/devices',
    headers,
    payload,
  });
  assert.equal(revokedReplay.statusCode, 401);
  console.log(
    'PASS: ordinary app/bind roles, two-tenant registration, self-read, devices, ownership, idempotency, logout and revoked replay.',
  );
} finally {
  await app.close();
  const { closePool, closeBindActorContextPool } = await import('../src/lib/db.js');
  await closePool();
  await closeBindActorContextPool();
}
