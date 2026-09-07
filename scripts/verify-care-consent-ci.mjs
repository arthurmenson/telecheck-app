/** Fresh isolated synthetic consent verification; never a deployment seeder. */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { applyMigrations } from './migrate.mjs';
import { verifyCareConsentRollback } from './verify-care-consent-rollback.mjs';

assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.CONSENT_SYNTHETIC_ACCEPTANCE, 'true');
const setupUrl = new URL(process.env.MIGRATION_DATABASE_URL);
assert(['127.0.0.1', 'localhost'].includes(setupUrl.hostname));
assert.equal(setupUrl.pathname, '/telecheck_consent');
const setup = new pg.Client({ connectionString: setupUrl.toString() });
await setup.connect();
const credentials = {};
try {
  assert.equal(
    (await setup.query("SELECT to_regclass('public.consent') AS table_name")).rows[0].table_name,
    null,
    'Use an empty isolated consent acceptance database.',
  );
  if (!(await setup.query("SELECT 1 FROM pg_roles WHERE rolname='postgres'")).rowCount)
    await setup.query('CREATE ROLE postgres SUPERUSER');
  if (!(await setup.query("SELECT 1 FROM pg_roles WHERE rolname='telecheck_app_role'")).rowCount)
    await setup.query('CREATE ROLE telecheck_app_role NOLOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT');
  const directory = fileURLToPath(new URL('../migrations/', import.meta.url));
  console.log('Consent complete chain', await applyMigrations(setup, directory));
  const replay = await applyMigrations(setup, directory);
  assert.equal(replay.applied, 0);
  console.log('Consent replay', replay);
  await verifyCareConsentRollback(setup, false);
  for (const role of ['telecheck_app_role', 'identity_service_role', 'bind_actor_context_role']) {
    const password = randomBytes(32).toString('hex');
    const statement = await setup.query(
      "SELECT format('ALTER ROLE %I LOGIN PASSWORD %L',$1::text,$2::text) AS sql",
      [role, password],
    );
    await setup.query(statement.rows[0].sql);
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
  BIND_ACTOR_CONTEXT_DATABASE_URL: credentials.bind_actor_context_role,
  CONSENT_ACCEPTANCE_ADMIN_DATABASE_URL: setupUrl.toString(),
  DATABASE_SSL_MODE: 'disable',
  REDIS_URL: 'redis://127.0.0.1:6379',
  JWT_SIGNING_KEY: randomBytes(32).toString('hex'),
  RESUME_TOKEN_SECRET: randomBytes(32).toString('hex'),
  TENANT_HOST_OVERRIDES: 'localhost=Telecheck-US,ghana.localhost=Telecheck-Ghana',
  AUTH_DEV_OTP_ECHO: 'true',
  EMAIL_PROVIDER: 'noop',
  SMS_PROVIDER: 'noop',
});
await import('./verify-care-consent.mjs');
const preservation = new pg.Client({ connectionString: setupUrl.toString() });
await preservation.connect();
try {
  await verifyCareConsentRollback(preservation, true);
} finally {
  await preservation.end();
}
