/** Isolated synthetic care acceptance; never a deployment seeder. */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { applyMigrations } from './migrate.mjs';
import { verifyCareIntakeRollback } from './verify-care-intake-rollback.mjs';
import { verifyPatientCrisisHistoryRollback } from './verify-patient-crisis-history-rollback.mjs';
import { verifyStaffEnrollmentRollback } from './verify-staff-enrollment-rollback.mjs';

assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.CARE_SYNTHETIC_ACCEPTANCE, 'true');
const setupUrl = new URL(process.env.MIGRATION_DATABASE_URL);
assert(['127.0.0.1', 'localhost'].includes(setupUrl.hostname));
assert.equal(setupUrl.pathname, '/telecheck_care_intake');
const setup = new pg.Client({ connectionString: setupUrl.href });
await setup.connect();
const credentials = {};
try {
  assert.equal(
    (await setup.query("SELECT to_regclass('public.consult') AS existing")).rows[0].existing,
    null,
    'Use an empty isolated care acceptance database.',
  );
  if (!(await setup.query("SELECT 1 FROM pg_roles WHERE rolname='postgres'")).rowCount)
    await setup.query('CREATE ROLE postgres SUPERUSER');
  if (!(await setup.query("SELECT 1 FROM pg_roles WHERE rolname='telecheck_app_role'")).rowCount)
    await setup.query('CREATE ROLE telecheck_app_role NOLOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT');
  const directory = fileURLToPath(new URL('../migrations/', import.meta.url));
  console.log('Care complete chain', await applyMigrations(setup, directory));
  const replay = await applyMigrations(setup, directory);
  assert.equal(replay.applied, 0);
  console.log('Care replay', replay);
  await verifyCareIntakeRollback(setup);
  await verifyStaffEnrollmentRollback(setup);
  await verifyPatientCrisisHistoryRollback(setup);
  for (const role of [
    'telecheck_app_role',
    'identity_service_role',
    'billing_service_role',
    'bind_actor_context_role',
    'kms_service_role',
  ]) {
    const password = randomBytes(32).toString('hex');
    const statement = await setup.query(
      "SELECT format('ALTER ROLE %I LOGIN PASSWORD %L',$1::text,$2::text) AS sql",
      [role, password],
    );
    await setup.query(statement.rows[0].sql);
    const uri = new URL(setupUrl);
    uri.username = role;
    uri.password = password;
    credentials[role] = uri.href;
  }
} finally {
  await setup.end();
}
Object.assign(process.env, {
  NODE_ENV: 'development',
  DATABASE_URL: credentials.telecheck_app_role,
  IDENTITY_DATABASE_URL: credentials.identity_service_role,
  BILLING_DATABASE_URL: credentials.billing_service_role,
  KMS_DATABASE_URL: credentials.kms_service_role,
  BIND_ACTOR_CONTEXT_DATABASE_URL: credentials.bind_actor_context_role,
  CARE_TEST_SETUP_DATABASE_URL: setupUrl.href,
  DATABASE_SSL_MODE: 'disable',
  REDIS_URL: 'redis://127.0.0.1:1',
  TENANT_HOST_OVERRIDES: 'localhost=Telecheck-US,ghana.localhost=Telecheck-Ghana',
  JWT_SIGNING_KEY: randomBytes(32).toString('hex'),
  RESUME_TOKEN_SECRET: randomBytes(32).toString('hex'),
  AUTH_DEV_OTP_ECHO: 'true',
  SMS_PROVIDER: 'noop',
  EMAIL_PROVIDER: 'noop',
  BILLING_ALLOW_MOCK: 'true',
  BILLING_SYNTHETIC_ACCEPTANCE: 'true',
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
await import('./verify-care-intake-runtime.mjs');
const preservation = new pg.Client({ connectionString: setupUrl.href });
await preservation.connect();
try {
  await verifyCareIntakeRollback(preservation);
  await verifyStaffEnrollmentRollback(preservation);
  await verifyPatientCrisisHistoryRollback(preservation);
} finally {
  await preservation.end();
}
