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
assert(['56579', '56585'].includes(uri.port), 'unexpected_disposable_cluster_port');
const bootstrap = new pg.Client({ connectionString: uri.href });
await bootstrap.connect();
const name = 'telecheck_pin_recovery_verify';
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
async function waitAccountBlocked(count) {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    const found = await setup.query(
      "SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=$1 AND wait_event_type='Lock' AND query LIKE '%lower(email)=lower($2)%'",
      [name],
    );
    if (found.rows[0].count >= count) return;
    await new Promise((done) => setTimeout(done, 20));
  }
  throw Error('account_lock_wait_not_observed');
}
async function auditRollback(host, tenantId) {
  const subject = await register(host),
    reset = await recovery(host, subject),
    accountId = subject.registration.account.account_id;
  const snapshot = () =>
    setup.query(
      `SELECT (SELECT pin_hash FROM account_pin_credentials WHERE tenant_id=$1 AND account_id=$2) AS pin_hash,
 (SELECT count(*)::int FROM sessions WHERE tenant_id=$1 AND account_id=$2 AND revoked_at IS NOT NULL) AS revoked,
 (SELECT count(*)::int FROM email_passcodes WHERE tenant_id=$1 AND email=$3 AND purpose='pin_recovery' AND consumed_at IS NOT NULL) AS consumed,
 (SELECT count(*)::int FROM audit_records WHERE tenant_id=$1 AND target_patient_id=$2) AS audits,
 (SELECT count(*)::int FROM domain_events_outbox WHERE tenant_id=$1 AND payload->>'account_id'=$2) AS events`,
      [tenantId, accountId, subject.email],
    );
  const before = (await snapshot()).rows[0];
  const definition = await setup.query(
    "SELECT format('CREATE FUNCTION public.pin_probe_reject_audit() RETURNS trigger LANGUAGE plpgsql AS %L', $1::text) AS sql",
    [
      `BEGIN IF NEW.action='identity_session_revoked' AND NEW.target_patient_id='${accountId}' THEN RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='synthetic_audit_failure'; END IF; RETURN NEW; END`,
    ],
  );
  await setup.query(definition.rows[0].sql);
  await setup.query(
    'CREATE TRIGGER pin_probe_reject_audit BEFORE INSERT ON audit_records FOR EACH ROW EXECUTE FUNCTION public.pin_probe_reject_audit()',
  );
  try {
    assert.equal((await http(host, '/v0/identity/recovery/pin/verify', reset)).status, 503);
    assert.deepEqual((await snapshot()).rows[0], before);
    assert.equal((await profile(host, subject.registration.access_token)).status, 200);
  } finally {
    await setup.query('DROP TRIGGER pin_probe_reject_audit ON audit_records');
    await setup.query('DROP FUNCTION public.pin_probe_reject_audit()');
  }
  assert.equal((await http(host, '/v0/identity/recovery/pin/verify', reset)).status, 200);
  assert.equal((await profile(host, subject.registration.access_token)).status, 401);
}
async function race(host, tenantId, loginFirst) {
  const subject = await register(host),
    reset = await recovery(host, subject),
    holder = new pg.Client({ connectionString: uri.href });
  await holder.connect();
  await holder.query('BEGIN');
  await holder.query(
    'SELECT account_id FROM accounts WHERE tenant_id=$1 AND account_id=$2 FOR UPDATE',
    [tenantId, subject.registration.account.account_id],
  );
  const login = () =>
      http(host, '/v0/identity/login/pin', { body: { email: subject.email, pin: subject.pin } }),
    recover = () => http(host, '/v0/identity/recovery/pin/verify', reset);
  let first, second;
  try {
    first = loginFirst ? login() : recover();
    await waitAccountBlocked(1);
    second = loginFirst ? recover() : login();
    await waitAccountBlocked(2);
    await holder.query('COMMIT');
    const [a, b] = await Promise.all([first, second]);
    const loginResult = loginFirst ? a : b,
      resetResult = loginFirst ? b : a;
    assert.equal(resetResult.status, 200);
    assert.equal(loginResult.status, loginFirst ? 200 : 401);
    if (loginFirst) assert.equal((await profile(host, loginResult.body.access_token)).status, 401);
  } finally {
    await holder.query('ROLLBACK').catch(() => {});
    await holder.end();
    await Promise.allSettled([first, second].filter(Boolean));
  }
}
async function waitPasscodeBlocked() {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    const found = await setup.query(
      "SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=$1 AND wait_event_type='Lock' AND query LIKE '%FROM email_passcodes%FOR UPDATE%'",
      [name],
    );
    if (found.rows[0].count >= 1) return;
    await new Promise((done) => setTimeout(done, 20));
  }
  throw Error('passcode_lock_wait_not_observed');
}

async function expiredRecoveryAfterWait(host, tenantId, accountWait, wrongCode = false) {
  const subject = await register(host),
    reset = await recovery(host, subject);
  if (wrongCode) reset.body.passcode = reset.body.passcode === '000000' ? '111111' : '000000';
  const accountId = subject.registration.account.account_id;
  const before = (
    await setup.query(
      'SELECT pin_hash FROM account_pin_credentials WHERE tenant_id=$1 AND account_id=$2',
      [tenantId, accountId],
    )
  ).rows[0].pin_hash;
  const passcodeId = (
    await setup.query(
      "UPDATE email_passcodes SET expires_at=clock_timestamp()+interval '1 second' WHERE tenant_id=$1 AND email=$2 AND purpose='pin_recovery' AND consumed_at IS NULL RETURNING passcode_id",
      [tenantId, subject.email],
    )
  ).rows[0].passcode_id;
  const holder = new pg.Client({ connectionString: uri.href });
  await holder.connect();
  await holder.query('BEGIN');
  await holder.query(
    accountWait
      ? 'SELECT account_id FROM accounts WHERE tenant_id=$1 AND account_id=$2 FOR UPDATE'
      : 'SELECT passcode_id FROM email_passcodes WHERE tenant_id=$1 AND passcode_id=$2 FOR UPDATE',
    [tenantId, accountWait ? accountId : passcodeId],
  );
  let pending;
  try {
    pending = http(host, '/v0/identity/recovery/pin/verify', reset);
    if (accountWait) await waitAccountBlocked(1);
    else await waitPasscodeBlocked();
    await new Promise((done) => setTimeout(done, 1300));
    await holder.query('COMMIT');
    assert.equal((await pending).status, 400);
    const state = (
      await setup.query(
        'SELECT consumed_at IS NOT NULL AS consumed, expires_at<clock_timestamp() AS expired, attempts_remaining FROM email_passcodes WHERE tenant_id=$1 AND passcode_id=$2',
        [tenantId, passcodeId],
      )
    ).rows[0];
    assert.deepEqual(state, { consumed: false, expired: true, attempts_remaining: 3 });
    assert.equal(
      (
        await setup.query(
          'SELECT pin_hash FROM account_pin_credentials WHERE tenant_id=$1 AND account_id=$2',
          [tenantId, accountId],
        )
      ).rows[0].pin_hash,
      before,
    );
    assert.equal((await profile(host, subject.registration.access_token)).status, 200);
  } finally {
    await holder.query('ROLLBACK').catch(() => {});
    await holder.end();
    if (pending) await Promise.allSettled([pending]);
  }
}

async function startDispatchCommitBoundary(host, tenantId, recoveryStart, fault) {
  const subject = recoveryStart
    ? await register(host)
    : { email: 'synthetic-commit-' + randomUUID() + '@example.invalid' };
  const path = recoveryStart
    ? '/v0/identity/recovery/pin/start'
    : '/v0/identity/registration/email/start';
  const purpose = recoveryStart ? 'pin_recovery' : 'email_registration';
  const key = randomUUID(),
    body = { email: subject.email };
  const action =
    fault === 'disconnect'
      ? 'PERFORM pg_terminate_backend(pg_backend_pid());'
      : "RAISE EXCEPTION 'synthetic_completion_failure' USING ERRCODE='23514';";
  await setup.query(
    `CREATE FUNCTION pin_probe_completion_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.processing_state='completed' THEN ${action} END IF; RETURN NEW; END $$`,
  );
  await setup.query(
    fault === 'completion'
      ? 'CREATE TRIGGER pin_probe_completion_fault BEFORE UPDATE ON identity_idempotency_keys FOR EACH ROW EXECUTE FUNCTION pin_probe_completion_fault()'
      : 'CREATE CONSTRAINT TRIGGER pin_probe_completion_fault AFTER UPDATE ON identity_idempotency_keys DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION pin_probe_completion_fault()',
  );
  const before = sendAttempts;
  try {
    assert.equal((await http(host, path, { body, key })).status, 503);
    await new Promise((done) => setTimeout(done, 25));
    assert.equal(sendAttempts, before, 'failed_transaction_must_not_dispatch');
    const state = (
      await setup.query(
        'SELECT (SELECT count(*)::int FROM email_passcodes WHERE tenant_id=$1 AND email=$2 AND purpose=$3) AS passcodes,(SELECT count(*)::int FROM identity_idempotency_keys WHERE tenant_id=$1 AND key=$4) AS cached',
        [tenantId, subject.email, purpose, key],
      )
    ).rows[0];
    assert.deepEqual(state, { passcodes: 0, cached: 0 });
  } finally {
    await setup.query('DROP TRIGGER pin_probe_completion_fault ON identity_idempotency_keys');
    await setup.query('DROP FUNCTION pin_probe_completion_fault()');
  }
  assert.equal((await http(host, path, { body, key })).status, 200);
  await new Promise((done) => setTimeout(done, 25));
  assert.equal(sendAttempts, before + 1, 'acknowledged_commit_dispatches_once');
  assert.equal((await http(host, path, { body, key })).status, 200);
  await new Promise((done) => setTimeout(done, 25));
  assert.equal(sendAttempts, before + 1, 'cached_replay_must_not_dispatch_again');
}

let stage = 'registration';
try {
  for (const [host, tenantId] of [
    ['localhost', 'Telecheck-US'],
    ['ghana.heroshealth.com', 'Telecheck-Ghana'],
  ]) {
    const checks = [];
    stage = tenantId + ': standard recovery';
    const subject = await register(host),
      loginKey = randomUUID(),
      loginBody = { email: subject.email, pin: subject.pin };
    const login = await http(host, '/v0/identity/login/pin', { body: loginBody, key: loginKey });
    assert.equal(login.status, 200);
    const reset = await recovery(host, subject);
    const changed = await http(host, '/v0/identity/recovery/pin/verify', reset);
    assert.equal(changed.status, 200);
    for (const session of [subject.registration, login.body]) {
      assert.equal((await profile(host, session.access_token)).status, 401);
      assert.equal(
        (
          await http(host, '/v0/identity/sessions/refresh', {
            body: { refresh_token: session.refresh_token },
          })
        ).status,
        400,
      );
    }
    assert.equal(
      (await http(host, '/v0/identity/login/pin', { body: loginBody, key: loginKey })).status,
      401,
    );
    assert.equal(
      (
        await http(host, '/v0/identity/registration/email/verify', {
          body: subject.registrationBody,
          key: subject.registrationKey,
        })
      ).status,
      401,
    );
    assert.equal((await http(host, '/v0/identity/login/pin', { body: loginBody })).status, 401);
    checks.push('all_old_bearer_refresh_and_cached_login_signup_receipts_denied');
    const fresh = await http(host, '/v0/identity/login/pin', {
      body: { email: subject.email, pin: reset.body.new_pin },
    });
    assert.equal(fresh.status, 200);
    assert.equal((await http(host, '/v0/identity/recovery/pin/verify', reset)).status, 200);
    assert.equal((await profile(host, fresh.body.access_token)).status, 200);
    checks.push('new_pin_login_works_and_reset_replay_preserves_new_session');
    const revoked = await setup.query(
      "SELECT s.session_id,(SELECT count(*) FROM audit_records a WHERE a.tenant_id=s.tenant_id AND a.resource_id=s.session_id AND a.action='identity_session_revoked' AND a.payload->>'revoked_reason'='password_changed')::int AS audits,(SELECT count(*) FROM domain_events_outbox e WHERE e.tenant_id=s.tenant_id AND e.aggregate_id=s.session_id AND e.event_type='identity.session.revoked' AND e.payload->>'revoked_reason'='password_changed')::int AS events FROM sessions s WHERE tenant_id=$1 AND account_id=$2 AND revoked_reason='password_changed'",
      [tenantId, subject.registration.account.account_id],
    );
    assert.equal(revoked.rowCount, 2);
    for (const row of revoked.rows) {
      assert.equal(row.audits, 1);
      assert.equal(row.events, 1);
    }
    checks.push('each_revoked_session_has_one_same_transaction_audit_and_event');
    stage = tenantId + ': reset wins race';
    await race(host, tenantId, false);
    checks.push('reset_before_waiting_old_pin_login_denies_session');
    stage = tenantId + ': login wins race';
    await race(host, tenantId, true);
    checks.push('earlier_old_pin_login_is_revoked_by_waiting_reset');
    stage = tenantId + ': audit rollback';
    await auditRollback(host, tenantId);
    checks.push('required_audit_failure_rolls_back_pin_passcode_sessions_events_and_reservation');
    stage = tenantId + ': recovery expiry after account wait';
    await expiredRecoveryAfterWait(host, tenantId, true);
    checks.push('recovery_expired_during_account_wait_denied_without_mutation');
    stage = tenantId + ': recovery expiry after passcode wait';
    await expiredRecoveryAfterWait(host, tenantId, false);
    checks.push('recovery_expired_during_passcode_wait_denied_without_mutation');
    stage = tenantId + ': wrong code expiry after passcode wait';
    await expiredRecoveryAfterWait(host, tenantId, false, true);
    checks.push('expired_passcode_attempt_budget_not_mutated_after_wait');
    for (const recoveryStart of [false, true]) {
      for (const fault of ['completion', 'commit', 'disconnect']) {
        stage =
          tenantId + ': dispatch ' + (recoveryStart ? 'recovery' : 'registration') + ' ' + fault;
        await startDispatchCommitBoundary(host, tenantId, recoveryStart, fault);
        checks.push(
          (recoveryStart ? 'recovery' : 'registration') +
            '_' +
            fault +
            '_failure_no_dispatch_retry_once_replay_no_dispatch',
        );
      }
    }
    results.push({ tenant: tenantId, checks });
  }
  await writeFile(
    process.env.PIN_RECOVERY_RESULT,
    JSON.stringify({ ledger, results }, null, 2) + '\n',
  );
  process.stdout.write(JSON.stringify({ results }) + '\n');
} catch (error) {
  process.stderr.write(
    JSON.stringify({
      stage,
      code: error.code ?? 'pin_probe_failed',
      message: String(error.message).slice(0, 1200),
    }) + '\n',
  );
  process.exitCode = 1;
} finally {
  await app.close();
  await closeIdentityPool();
  await closePool();
  await closeBindActorContextPool();
  await setup.end();
}
