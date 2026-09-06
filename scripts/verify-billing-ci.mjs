/** Fresh, local synthetic Billing acceptance bootstrap. Never a deployment seeder. */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { applyMigrations } from './migrate.mjs';
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.BILLING_SYNTHETIC_ACCEPTANCE, 'true');
const setupUrl = new URL(process.env.MIGRATION_DATABASE_URL);
assert.ok(['localhost', '127.0.0.1'].includes(setupUrl.hostname));
assert.equal(setupUrl.pathname, '/telecheck_billing');
const setup = new pg.Client({ connectionString: setupUrl.toString() });
await setup.connect();
const credentials = {};
try {
  assert.equal(
    (await setup.query("SELECT to_regclass('public.consult') AS table_name")).rows[0].table_name,
    null,
    'Use an empty disposable billing acceptance database.',
  );
  if (!(await setup.query("SELECT 1 FROM pg_roles WHERE rolname='postgres'")).rowCount)
    await setup.query('CREATE ROLE postgres SUPERUSER');
  if (!(await setup.query("SELECT 1 FROM pg_roles WHERE rolname='telecheck_app_role'")).rowCount)
    await setup.query('CREATE ROLE telecheck_app_role NOLOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT');
  const directory = fileURLToPath(new URL('../migrations/', import.meta.url));
  console.log('Billing full migration apply', await applyMigrations(setup, directory));
  console.log('Billing migration replay', await applyMigrations(setup, directory));
  for (const role of [
    'telecheck_app_role',
    'identity_service_role',
    'billing_service_role',
    'bind_actor_context_role',
  ]) {
    const password = randomBytes(32).toString('hex');
    await setup.query(`ALTER ROLE ${role} LOGIN PASSWORD '${password}'`);
    const url = new URL(setupUrl);
    url.username = role;
    url.password = password;
    credentials[role] = url.toString();
  }
} finally {
  await setup.end();
}
Object.assign(process.env, {
  NODE_ENV: 'development',
  DATABASE_URL: credentials.telecheck_app_role,
  IDENTITY_DATABASE_URL: credentials.identity_service_role,
  BILLING_DATABASE_URL: credentials.billing_service_role,
  BIND_ACTOR_CONTEXT_DATABASE_URL: credentials.bind_actor_context_role,
  BILLING_TEST_SETUP_DATABASE_URL: setupUrl.toString(),
  DATABASE_SSL_MODE: 'disable',
  REDIS_URL: 'redis://localhost:6379',
  TENANT_HOST_OVERRIDES: 'localhost=Telecheck-US,ghana.localhost=Telecheck-Ghana',
  JWT_SIGNING_KEY: randomBytes(32).toString('hex'),
  RESUME_TOKEN_SECRET: randomBytes(32).toString('hex'),
  AUTH_DEV_OTP_ECHO: 'true',
  SMS_PROVIDER: 'noop',
  EMAIL_PROVIDER: 'noop',
  BILLING_ALLOW_MOCK: 'true',
  BILLING_CONFIRMATION_KEY: randomBytes(32).toString('hex'),
  BILLING_TEST_MOCK_SECRET: randomBytes(32).toString('hex'),
  BILLING_PROVIDERS_JSON: JSON.stringify(
    Object.fromEntries(
      [
        ['Telecheck-US', 'localhost', 'synthetic_us'],
        ['Telecheck-Ghana', 'ghana.localhost', 'synthetic_gh'],
      ].map(([tenant, host, account]) => [
        tenant,
        {
          provider: 'mock_local_dev',
          mode: 'mock_local_dev',
          account,
          secret_env: 'BILLING_TEST_MOCK_SECRET',
          webhook_secret_env: 'BILLING_TEST_MOCK_SECRET',
          return_url: `http://${host}:4172/care`,
        },
      ]),
    ),
  ),
});
await import('./verify-billing-runtime.ts');
