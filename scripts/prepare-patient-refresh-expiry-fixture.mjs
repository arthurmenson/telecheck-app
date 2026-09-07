// Author acceptance on a disposable local database; sends no external email.
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { request as send } from 'node:http';
import { resolve } from 'node:path';
import pg from 'pg';
import { applyMigrations } from './migrate.mjs';

const uri = new URL(process.env.PIN_RECOVERY_TEST_DATABASE_URL);
assert.equal(uri.hostname, '127.0.0.1');
assert.equal(uri.port, '56597');
const bootstrap = new pg.Client({ connectionString: uri.href });
await bootstrap.connect();
const name = 'telecheck_patient_refresh_verify';
if (!(await bootstrap.query('SELECT 1 FROM pg_database WHERE datname=$1', [name])).rowCount)
  await bootstrap.query(`CREATE DATABASE ${name}`);
await bootstrap.end();
uri.pathname = '/' + name;
const setup = new pg.Client({ connectionString: uri.href });
await setup.connect();
if (!(await setup.query("SELECT 1 FROM pg_roles WHERE rolname='telecheck_app_role'")).rowCount)
  await setup.query('CREATE ROLE telecheck_app_role NOLOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT');
const migrationDirectory = resolve(process.env.PIN_RECOVERY_MIGRATIONS ?? 'migrations');
await applyMigrations(setup, migrationDirectory);
const ledger = (
  await setup.query('SELECT filename,checksum_sha FROM schema_migrations ORDER BY filename')
).rows;
const urls = {};
for (const role of ['telecheck_app_role', 'identity_service_role', 'bind_actor_context_role']) {
  const password = randomBytes(32).toString('hex');
  await setup.query(
    (
      await setup.query(
        "SELECT format('ALTER ROLE %I LOGIN PASSWORD %L',$1::text,$2::text) AS sql",
        [role, password],
      )
    ).rows[0].sql,
  );
  const login = new URL(uri);
  login.username = role;
  login.password = password;
  urls[role] = login.href;
}
Object.assign(process.env, {
  NODE_ENV: 'development',
  DEPLOY_ENV: 'test',
  DATABASE_URL: urls.telecheck_app_role,
  IDENTITY_DATABASE_URL: urls.identity_service_role,
  BIND_ACTOR_CONTEXT_DATABASE_URL: urls.bind_actor_context_role,
  DATABASE_SSL_MODE: 'disable',
  EMAIL_PROVIDER: 'noop',
  SMS_PROVIDER: 'noop',
  AUTH_DEV_OTP_ECHO: 'true',
  LOG_LEVEL: 'fatal',
  JWT_SIGNING_KEY: randomBytes(32).toString('hex'),
  REDIS_URL: 'redis://127.0.0.1:1',
  TENANT_KMS_LOCAL_DEV_KEY: 'dev-only-not-for-production-32-chars',
});
const { buildApp } = await import('../src/app.ts');
const { closeIdentityPool } = await import('../src/modules/identity/internal/database.ts');
const { closePool, closeBindActorContextPool } = await import('../src/lib/db.ts');
const { getEmailSender } = await import('../src/lib/email/index.ts');
const sender = getEmailSender();
const originalSend = sender.sendPasscode.bind(sender);
let sendAttempts = 0;
sender.sendPasscode = (message) => {
  sendAttempts += 1;
  return originalSend(message);
};
const app = await buildApp({ logger: false });
const origin = await app.listen({ host: '127.0.0.1', port: 0 });
const results = [];
function http(host, path, { method = 'POST', body, key = randomUUID(), token } = {}) {
  return new Promise((resolveRequest, reject) => {
    const bytes = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = send(
      new URL(path, origin),
      {
        method,
        headers: {
          host,
          'idempotency-key': key,
          ...(token ? { authorization: 'Bearer ' + token } : {}),
          ...(bytes ? { 'content-type': 'application/json', 'content-length': bytes.length } : {}),
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          try {
            const text = Buffer.concat(chunks).toString();
            const result = { status: res.statusCode, body: text ? JSON.parse(text) : null };
            if (result.status >= 400)
              assert(
                !/permission denied|sqlstate|synthetic_audit_failure|account_pin_credentials|password_hash/u.test(
                  text,
                ),
              );
            resolveRequest(result);
          } catch (error) {
            reject(error);
          }
        });
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    if (bytes) req.write(bytes);
    req.end();
  });
}
async function register(host) {
  const email = 'synthetic-pin-' + randomUUID() + '@example.invalid',
    pin = '583926';
  const start = await http(host, '/v0/identity/registration/email/start', { body: { email } });
  assert.equal(start.status, 200);
  const body = {
      email,
      passcode: start.body.dev_passcode,
      pin,
      first_name: 'Synthetic',
      last_name: 'PinReset',
      date_of_birth: '1990-01-01',
      gender: 'prefer_not_to_say',
    },
    key = randomUUID();
  const registration = await http(host, '/v0/identity/registration/email/verify', { body, key });
  assert.equal(registration.status, 201, 'registration_status_' + registration.status);
  return {
    email,
    pin,
    registration: registration.body,
    registrationBody: body,
    registrationKey: key,
  };
}
async function recovery(host, subject, newPin = '694827') {
  const start = await http(host, '/v0/identity/recovery/pin/start', {
    body: { email: subject.email },
  });
  assert.equal(start.status, 200);
  return {
    key: randomUUID(),
    body: { email: subject.email, passcode: start.body.dev_passcode, new_pin: newPin },
  };
}
async function profile(host, token) {
  return http(host, '/v0/identity/accounts/me', { method: 'GET', token });
}
try {
  const fixtures = [];
  for (const [host, tenantId] of [
    ['localhost', 'Telecheck-US'],
    ['ghana.heroshealth.com', 'Telecheck-Ghana'],
  ])
    fixtures.push({ host, tenantId, subject: await register(host) });
  await writeFile(
    process.env.PATIENT_REFRESH_FIXTURE_FILE,
    JSON.stringify({ urls, signingKey: process.env.JWT_SIGNING_KEY, fixtures }, null, 2),
  );
  process.stdout.write(
    JSON.stringify({
      prepared: fixtures.length,
      issuedAt: new Date().toISOString(),
      naturalAccessExpiryMinutes: 15,
    }) + '\n',
  );
} finally {
  await app.close();
  await closeIdentityPool();
  await closePool();
  await closeBindActorContextPool();
  await setup.end();
}
