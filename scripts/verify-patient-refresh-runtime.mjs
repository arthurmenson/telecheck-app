// Actual author verifier; only the isolated56597 fixture environment is accepted.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { request as send } from 'node:http';
import pg from 'pg';
import { ulid } from 'ulid';
const fixtures = JSON.parse(await readFile(process.env.PATIENT_REFRESH_FIXTURE_FILE, 'utf8'));
const uri = new URL(process.env.PIN_RECOVERY_TEST_DATABASE_URL);
assert.equal(uri.hostname, '127.0.0.1');
assert.equal(uri.port, '56597');
uri.pathname = '/telecheck_patient_refresh_verify';
for (const [role, value] of Object.entries(fixtures.urls)) {
  const url = new URL(value);
  assert.equal(url.port, '56597');
  assert.equal(url.hostname, '127.0.0.1');
  assert.equal(url.username, role);
  assert.equal(url.pathname, uri.pathname);
}
const setup = new pg.Client({ connectionString: uri.href });
await setup.connect();
const name = 'telecheck_patient_refresh_verify';
Object.assign(process.env, {
  NODE_ENV: 'development',
  DEPLOY_ENV: 'test',
  DATABASE_URL: fixtures.urls.telecheck_app_role,
  IDENTITY_DATABASE_URL: fixtures.urls.identity_service_role,
  BIND_ACTOR_CONTEXT_DATABASE_URL: fixtures.urls.bind_actor_context_role,
  DATABASE_SSL_MODE: 'disable',
  EMAIL_PROVIDER: 'noop',
  SMS_PROVIDER: 'noop',
  AUTH_DEV_OTP_ECHO: 'true',
  LOG_LEVEL: 'fatal',
  JWT_SIGNING_KEY: fixtures.signingKey,
  REDIS_URL: 'redis://127.0.0.1:1',
  TENANT_KMS_LOCAL_DEV_KEY: 'dev-only-not-for-production-32-chars',
});
const { buildApp } = await import('../src/app.ts');
const { closeIdentityPool } = await import('../src/modules/identity/internal/database.ts');
const { closePool, closeBindActorContextPool } = await import('../src/lib/db.ts');
const { verifyAccessToken } = await import('../src/lib/jwt.ts');
const app = await buildApp({ logger: false });
const origin = await app.listen({ host: '127.0.0.1', port: 0 });
const results = [];
function http(host, path, { method = 'POST', body, key = ulid(), token } = {}) {
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
            if (['/v0/identity/sessions/refresh', '/v0/identity/sessions/logout'].includes(path))
              assert.equal(res.headers['cache-control'], 'no-store');
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

function refresh(host, token, key = ulid(), extra = {}) {
  return http(host, '/v0/identity/sessions/refresh', {
    body: { refresh_token: token },
    key,
    ...extra,
  });
}

function logout(host, token, refreshKey) {
  return http(host, '/v0/identity/sessions/logout', {
    body: {
      refresh_token: token,
      ...(refreshKey ? { refresh_idempotency_key: refreshKey } : {}),
    },
  });
}

async function assertLogoutEvidence(tenant, sessionId, expected = 1) {
  const state = (
    await setup.query(
      `SELECT revoked_at,revoked_reason,
        (SELECT count(*)::int FROM audit_records WHERE tenant_id=$1 AND resource_id=$2
          AND action='identity_session_revoked' AND payload->>'revoked_reason'='patient_logout') AS audits,
        (SELECT count(*)::int FROM domain_events_outbox WHERE tenant_id=$1 AND aggregate_id=$2
          AND event_type='identity.session.revoked' AND payload->>'revoked_reason'='patient_logout') AS events
        FROM sessions WHERE tenant_id=$1 AND session_id=$2`,
      [tenant, sessionId],
    )
  ).rows[0];
  assert(state);
  assert.equal(state.audits, expected);
  assert.equal(state.events, expected);
  assert.equal(state.revoked_at !== null, expected === 1);
  assert.equal(state.revoked_reason, expected === 1 ? 'patient_logout' : null);
}

async function setInactive(client, tenant, accountId, state) {
  await client.query(
    `UPDATE accounts SET status=$3,deleted_at=CASE WHEN $4 THEN clock_timestamp() ELSE NULL END
      WHERE tenant_id=$1 AND account_id=$2`,
    [tenant, accountId, state === 'soft_deleted' ? 'active' : state, state === 'soft_deleted'],
  );
}

async function logoutFault(host, tenant, table) {
  const subject = await register(host),
    sessionId = subject.registration.session_id;
  await setInactive(setup, tenant, subject.registration.account.account_id, 'suspended');
  const condition =
    table === 'audit_records'
      ? "NEW.action='identity_session_revoked'"
      : "NEW.event_type='identity.session.revoked'";
  await setup.query(`CREATE FUNCTION refresh_author_logout_fault() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF ${condition} THEN RAISE EXCEPTION 'refresh_author_logout_fault' USING ERRCODE='23514'; END IF; RETURN NEW; END $$`);
  await setup.query(`CREATE TRIGGER refresh_author_logout_fault BEFORE INSERT ON ${table}
    FOR EACH ROW EXECUTE FUNCTION refresh_author_logout_fault()`);
  try {
    const failed = await logout(host, subject.registration.refresh_token);
    assert.equal(failed.status, 503);
    assert.equal(failed.body.error.code, 'identity.authentication.unavailable');
    await assertLogoutEvidence(tenant, sessionId, 0);
  } finally {
    await setup.query(`DROP TRIGGER refresh_author_logout_fault ON ${table}`);
    await setup.query('DROP FUNCTION refresh_author_logout_fault()');
  }
  assert.equal((await logout(host, subject.registration.refresh_token)).status, 204);
  await assertLogoutEvidence(tenant, sessionId);
}

async function loseRefreshResponse(host, token, key) {
  const bytes = Buffer.from(JSON.stringify({ refresh_token: token }));
  await new Promise((resolveLost, reject) => {
    let headersReceived = false;
    const req = send(
      new URL('/v0/identity/sessions/refresh', origin),
      {
        method: 'POST',
        headers: {
          host,
          'idempotency-key': key,
          'content-type': 'application/json',
          'content-length': bytes.length,
        },
      },
      (res) => {
        headersReceived = true;
        // Discard the actual TCP response before reading any replacement credential.
        const success = res.statusCode === 200;
        res.destroy();
        req.destroy();
        if (success) resolveLost();
        else reject(Error('lost_reply_was_not_success'));
      },
    );
    req.on('error', (error) => {
      if (!headersReceived) reject(error);
    });
    req.end(bytes);
  });
}
async function liveState(tenant, accountId) {
  return (
    await setup.query(
      `SELECT
    (SELECT jsonb_agg(jsonb_build_object('id',session_id,'hash',refresh_token_hash,'revoked',revoked_at,'expires',expires_at) ORDER BY session_id) FROM sessions WHERE tenant_id=$1 AND account_id=$2) AS sessions,
    (SELECT count(*)::int FROM audit_records WHERE tenant_id=$1 AND target_patient_id=$2 AND action='identity_session_rotated') AS audits,
    (SELECT count(*)::int FROM domain_events_outbox WHERE tenant_id=$1 AND payload->>'account_id'=$2 AND event_type='identity.session.rotated') AS events`,
      [tenant, accountId],
    )
  ).rows[0];
}
function assertReply(response, original) {
  assert.equal(response.status, 200);
  assert.deepEqual(Object.keys(response.body).sort(), ['access_token', 'refresh_token', 'session']);
  assert.deepEqual(Object.keys(response.body.session).sort(), [
    'account_id',
    'created_at',
    'expires_at',
    'last_active_at',
    'session_id',
  ]);
  assert.equal(
    response.body.session.session_id,
    original.session_id ?? original.session?.session_id,
  );
  assert.notEqual(response.body.refresh_token, original.refresh_token);
  const verified = verifyAccessToken(response.body.access_token, fixtures.signingKey);
  assert(verified.ok);
  assert.equal(verified.claims.role, 'patient');
  assert.equal(verified.claims.delegate_id, undefined);
  return response.body;
}
async function waitBlocked(count = 1) {
  const deadline = Date.now() + 2200;
  while (Date.now() < deadline) {
    const result = await setup.query(
      "SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=$1 AND wait_event_type='Lock' AND query LIKE '%FROM accounts%FOR UPDATE%'",
      [name],
    );
    if (result.rows[0].count >= count) return;
    await new Promise((done) => setTimeout(done, 20));
  }
  throw Error('account_wait_not_observed');
}
async function lockAccount(tenant, accountId) {
  const client = new pg.Client({ connectionString: uri.href });
  await client.connect();
  await client.query('BEGIN');
  await client.query(
    'SELECT account_id FROM accounts WHERE tenant_id=$1 AND account_id=$2 FOR UPDATE',
    [tenant, accountId],
  );
  return client;
}
async function finishLock(client) {
  await client.query('COMMIT');
  await client.end();
}
async function rotationFault(host, tenant, commit) {
  const subject = await register(host),
    key = ulid(),
    before = await liveState(tenant, subject.registration.account.account_id);
  if (commit) {
    await setup.query(
      "CREATE FUNCTION refresh_author_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.endpoint='/v0/identity/sessions/refresh' AND NEW.processing_state='completed' THEN RAISE EXCEPTION 'refresh_author_fault' USING ERRCODE='23514'; END IF; RETURN NEW; END $$",
    );
    await setup.query(
      'CREATE CONSTRAINT TRIGGER refresh_author_fault AFTER UPDATE ON identity_idempotency_keys DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION refresh_author_fault()',
    );
  } else {
    await setup.query(
      "CREATE FUNCTION refresh_author_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='identity_session_rotated' THEN RAISE EXCEPTION 'refresh_author_fault' USING ERRCODE='23514'; END IF; RETURN NEW; END $$",
    );
    await setup.query(
      'CREATE TRIGGER refresh_author_fault BEFORE INSERT ON audit_records FOR EACH ROW EXECUTE FUNCTION refresh_author_fault()',
    );
  }
  try {
    const failed = await refresh(host, subject.registration.refresh_token, key);
    assert.equal(failed.status, 503);
    assert.equal(failed.body.error.code, 'identity.authentication.unavailable');
    assert.deepEqual(await liveState(tenant, subject.registration.account.account_id), before);
    assert.equal(
      (
        await setup.query(
          'SELECT count(*)::int AS count FROM identity_idempotency_keys WHERE tenant_id=$1 AND key=$2',
          [tenant, key],
        )
      ).rows[0].count,
      0,
    );
  } finally {
    await setup.query(
      'DROP TRIGGER refresh_author_fault ON ' +
        (commit ? 'identity_idempotency_keys' : 'audit_records'),
    );
    await setup.query('DROP FUNCTION refresh_author_fault()');
  }
  assertReply(await refresh(host, subject.registration.refresh_token, key), subject.registration);
}

let stage = 'start';
try {
  for (const [host, tenant] of [
    ['localhost', 'Telecheck-US'],
    ['ghana.heroshealth.com', 'Telecheck-Ghana'],
  ]) {
    const checks = [];
    const check = async (label, work) => {
      stage = tenant + ': ' + label;
      await work();
      checks.push(label);
    };
    await check('strict_rotation_replay_supersession_and_evidence', async () => {
      const subject = await register(host),
        original = subject.registration,
        key = ulid();
      const before = (
        await setup.query('SELECT expires_at FROM sessions WHERE tenant_id=$1 AND session_id=$2', [
          tenant,
          original.session_id,
        ])
      ).rows[0].expires_at.toISOString();
      const a = assertReply(await refresh(host, original.refresh_token, key), original);
      assert.equal(a.session.expires_at, before);
      assert.equal((await profile(host, a.access_token)).status, 200);
      const same = await refresh(host, original.refresh_token, key);
      assert.equal(same.status, 200);
      assert.deepEqual(same.body, a);
      assert.equal((await refresh(host, original.refresh_token)).status, 401);
      assert.equal((await refresh(host, a.refresh_token, key)).status, 409);
      const b = assertReply(await refresh(host, a.refresh_token), a);
      assert.equal((await refresh(host, original.refresh_token, key)).status, 401);
      assert.equal((await profile(host, b.access_token)).status, 200);
      const state = await liveState(tenant, original.account.account_id);
      assert.equal(state.audits, 2);
      assert.equal(state.events, 2);
    });
    await check('delegate_own_account_rotation', async () => {
      const subject = await register(host);
      await setup.query(
        "UPDATE accounts SET account_type='delegate' WHERE tenant_id=$1 AND account_id=$2",
        [tenant, subject.registration.account.account_id],
      );
      const login = await http(host, '/v0/identity/login/pin', {
        body: { email: subject.email, pin: subject.pin },
      });
      assert.equal(login.status, 200);
      const rotated = assertReply(await refresh(host, login.body.refresh_token), login.body);
      assert.equal(rotated.session.account_id, subject.registration.account.account_id);
      assert.equal((await logout(host, rotated.refresh_token)).status, 204);
      await assertLogoutEvidence(tenant, rotated.session.session_id);
      assert.equal((await profile(host, rotated.access_token)).status, 401);
    });
    for (const role of ['clinician', 'tenant_admin', 'platform_admin'])
      await check('actual_legacy_' + role + '_refresh_denied_logout_revokes', async () => {
        const subject = await register(host),
          phone = '+1202' + Math.floor(1000000 + Math.random() * 8999999);
        await setup.query(
          'UPDATE accounts SET account_type=$3,phone_e164=$4 WHERE tenant_id=$1 AND account_id=$2',
          [tenant, subject.registration.account.account_id, role, phone],
        );
        const start = await http(host, '/v0/identity/login/start', { body: { phone_e164: phone } });
        assert.equal(start.status, 200);
        const login = await http(host, '/v0/identity/login/verify', {
          body: { phone_e164: phone, code: start.body.dev_otp },
        });
        assert.equal(login.status, 200);
        assert.equal(
          verifyAccessToken(login.body.access_token, fixtures.signingKey).claims.role,
          role,
        );
        const before = await liveState(tenant, subject.registration.account.account_id);
        assert.equal((await refresh(host, login.body.refresh_token)).status, 401);
        assert.deepEqual(await liveState(tenant, subject.registration.account.account_id), before);
        assert.equal((await logout(host, login.body.refresh_token)).status, 204);
        assert.equal((await logout(host, login.body.refresh_token)).status, 204);
        await assertLogoutEvidence(tenant, login.body.session.session_id);
        await assertLogoutEvidence(tenant, subject.registration.session_id, 0);
      });
    for (const state of ['suspended', 'archived', 'soft_deleted']) {
      await check('direct_logout_' + state + '_cannot_revive_and_preserves_sibling', async () => {
        const subject = await register(host),
          original = subject.registration;
        const sibling = await http(host, '/v0/identity/login/pin', {
          body: { email: subject.email, pin: subject.pin },
        });
        assert.equal(sibling.status, 200);
        await setInactive(setup, tenant, original.account.account_id, state);
        assert.equal((await refresh(host, original.refresh_token)).status, 401);
        assert.equal(
          (
            await logout(
              host === 'localhost' ? 'ghana.heroshealth.com' : 'localhost',
              original.refresh_token,
            )
          ).status,
          204,
        );
        await assertLogoutEvidence(tenant, original.session_id, 0);
        assert.equal((await logout(host, 'A'.repeat(43))).status, 204);
        await assertLogoutEvidence(tenant, original.session_id, 0);
        assert.equal((await logout(host, original.refresh_token)).status, 204);
        assert.equal((await logout(host, original.refresh_token)).status, 204);
        await assertLogoutEvidence(tenant, original.session_id);
        await assertLogoutEvidence(tenant, sibling.body.session_id, 0);
        await setInactive(setup, tenant, original.account.account_id, 'active');
        assert.equal((await profile(host, original.access_token)).status, 401);
        assert.equal((await profile(host, sibling.body.access_token)).status, 200);
        assert.equal((await refresh(host, original.refresh_token)).status, 401);
      });
      await check('pending_receipt_logout_' + state + '_is_revoke_only', async () => {
        const subject = await register(host),
          original = subject.registration,
          key = ulid();
        const rotated = assertReply(await refresh(host, original.refresh_token, key), original);
        await setInactive(setup, tenant, original.account.account_id, state);
        assert.equal((await refresh(host, original.refresh_token, key)).status, 401);
        assert.equal((await refresh(host, rotated.refresh_token)).status, 401);
        assert.equal((await logout(host, original.refresh_token, key)).status, 204);
        assert.equal((await logout(host, original.refresh_token, key)).status, 204);
        await assertLogoutEvidence(tenant, original.session_id);
        await setInactive(setup, tenant, original.account.account_id, 'active');
        assert.equal((await profile(host, rotated.access_token)).status, 401);
        assert.equal((await refresh(host, original.refresh_token, key)).status, 401);
      });
      await check('logout_rechecks_after_wait_through_' + state, async () => {
        const subject = await register(host),
          original = subject.registration;
        const holder = await lockAccount(tenant, original.account.account_id);
        let pending;
        try {
          pending = logout(host, original.refresh_token);
          await waitBlocked();
          await setInactive(holder, tenant, original.account.account_id, state);
          await finishLock(holder);
          assert.equal((await pending).status, 204);
          await assertLogoutEvidence(tenant, original.session_id);
          await setInactive(setup, tenant, original.account.account_id, 'active');
          assert.equal((await profile(host, original.access_token)).status, 401);
        } finally {
          await holder.end().catch(() => {});
          if (pending) await Promise.allSettled([pending]);
        }
      });
    }
    await check('pending_receipt_after_role_change_can_only_revoke', async () => {
      for (const role of ['clinician', 'tenant_admin', 'platform_admin']) {
        const subject = await register(host),
          original = subject.registration,
          key = ulid();
        const rotated = assertReply(await refresh(host, original.refresh_token, key), original);
        await setup.query(
          'UPDATE accounts SET account_type=$3 WHERE tenant_id=$1 AND account_id=$2',
          [tenant, original.account.account_id, role],
        );
        assert.equal((await refresh(host, original.refresh_token, key)).status, 401);
        assert.equal((await refresh(host, rotated.refresh_token)).status, 401);
        assert.equal((await logout(host, original.refresh_token, key)).status, 204);
        await assertLogoutEvidence(tenant, original.session_id);
      }
    });
    await check('concurrent_suspended_logout_revokes_once', async () => {
      const subject = await register(host),
        original = subject.registration;
      await setInactive(setup, tenant, original.account.account_id, 'suspended');
      const holder = await lockAccount(tenant, original.account.account_id);
      let first, second;
      try {
        first = logout(host, original.refresh_token);
        await waitBlocked();
        second = logout(host, original.refresh_token);
        await waitBlocked(2);
        await finishLock(holder);
        assert.deepEqual(
          (await Promise.all([first, second])).map((r) => r.status),
          [204, 204],
        );
        await assertLogoutEvidence(tenant, original.session_id);
      } finally {
        await holder.end().catch(() => {});
        await Promise.allSettled([first, second].filter(Boolean));
      }
    });
    await check('inactive_receipt_logout_still_expires_after_wait', async () => {
      const subject = await register(host),
        original = subject.registration,
        key = ulid();
      const rotated = assertReply(await refresh(host, original.refresh_token, key), original);
      await setInactive(setup, tenant, original.account.account_id, 'soft_deleted');
      await setup.query(
        "UPDATE identity_idempotency_keys SET expires_at=clock_timestamp()+interval '1 second' WHERE tenant_id=$1 AND key=$2",
        [tenant, key],
      );
      const holder = await lockAccount(tenant, original.account.account_id);
      let pending;
      try {
        pending = logout(host, original.refresh_token, key);
        await waitBlocked();
        await new Promise((done) => setTimeout(done, 1300));
        await finishLock(holder);
        assert.equal((await pending).status, 204);
        await assertLogoutEvidence(tenant, original.session_id, 0);
      } finally {
        await holder.end().catch(() => {});
        if (pending) await Promise.allSettled([pending]);
      }
      assert.equal((await logout(host, rotated.refresh_token)).status, 204);
      await assertLogoutEvidence(tenant, original.session_id);
    });
    await check('inactive_logout_audit_failure_rolls_back', () =>
      logoutFault(host, tenant, 'audit_records'),
    );
    await check('inactive_logout_outbox_failure_rolls_back', () =>
      logoutFault(host, tenant, 'domain_events_outbox'),
    );
    await check('same_key_concurrency_rotates_once', async () => {
      const subject = await register(host),
        key = ulid();
      const [a, b] = await Promise.all([
        refresh(host, subject.registration.refresh_token, key),
        refresh(host, subject.registration.refresh_token, key),
      ]);
      assert.equal(a.status, 200);
      assert.deepEqual(a, b);
      assert.equal((await liveState(tenant, subject.registration.account.account_id)).audits, 1);
    });
    await check('actual_discarded_http_reply_recovers_exact_rotation', async () => {
      const subject = await register(host),
        key = ulid();
      await loseRefreshResponse(host, subject.registration.refresh_token, key);
      const rotated = assertReply(
        await refresh(host, subject.registration.refresh_token, key),
        subject.registration,
      );
      assert.equal((await profile(host, rotated.access_token)).status, 200);
      assert.equal((await liveState(tenant, subject.registration.account.account_id)).audits, 1);
    });
    await check('different_key_concurrency_one_winner', async () => {
      const subject = await register(host);
      const replies = await Promise.all([
        refresh(host, subject.registration.refresh_token),
        refresh(host, subject.registration.refresh_token),
      ]);
      assert.deepEqual(replies.map((r) => r.status).sort(), [200, 401]);
      assert.equal((await liveState(tenant, subject.registration.account.account_id)).audits, 1);
    });
    await check('session_expiry_after_account_wait', async () => {
      const subject = await register(host),
        accountId = subject.registration.account.account_id;
      await setup.query(
        "UPDATE sessions SET expires_at=clock_timestamp()+interval '1 second' WHERE tenant_id=$1 AND session_id=$2",
        [tenant, subject.registration.session_id],
      );
      const before = await liveState(tenant, accountId),
        holder = await lockAccount(tenant, accountId);
      let pending;
      try {
        pending = refresh(host, subject.registration.refresh_token);
        await waitBlocked();
        await new Promise((done) => setTimeout(done, 1300));
        await finishLock(holder);
        assert.equal((await pending).status, 401);
        assert.deepEqual(await liveState(tenant, accountId), before);
      } finally {
        await holder.end().catch(() => {});
        if (pending) await Promise.allSettled([pending]);
      }
    });
    await check('cached_receipt_expiry_after_account_wait', async () => {
      const subject = await register(host),
        key = ulid();
      assert.equal((await refresh(host, subject.registration.refresh_token, key)).status, 200);
      await setup.query(
        "UPDATE identity_idempotency_keys SET expires_at=clock_timestamp()+interval '1 second' WHERE tenant_id=$1 AND key=$2",
        [tenant, key],
      );
      const holder = await lockAccount(tenant, subject.registration.account.account_id);
      let pending;
      try {
        pending = refresh(host, subject.registration.refresh_token, key);
        await waitBlocked();
        await new Promise((done) => setTimeout(done, 1300));
        await finishLock(holder);
        assert.equal((await pending).status, 401);
      } finally {
        await holder.end().catch(() => {});
        if (pending) await Promise.allSettled([pending]);
      }
    });
    await check('pin_reset_serializes_both_rotation_orders', async () => {
      for (const refreshFirst of [false, true]) {
        const subject = await register(host),
          reset = await recovery(host, subject),
          holder = await lockAccount(tenant, subject.registration.account.account_id);
        let a, b;
        const rotate = () => refresh(host, subject.registration.refresh_token),
          recover = () => http(host, '/v0/identity/recovery/pin/verify', reset);
        try {
          a = refreshFirst ? rotate() : recover();
          await waitBlocked();
          b = refreshFirst ? recover() : rotate();
          await waitBlocked(2);
          await finishLock(holder);
          const replies = await Promise.all([a, b]),
            rr = replies[refreshFirst ? 0 : 1];
          assert.equal(replies[refreshFirst ? 1 : 0].status, 200);
          assert.equal(rr.status, refreshFirst ? 200 : 401);
          if (refreshFirst) assert.equal((await profile(host, rr.body.access_token)).status, 401);
        } finally {
          await holder.end().catch(() => {});
          await Promise.allSettled([a, b].filter(Boolean));
        }
      }
    });
    await check('logout_unknown_rotation_revokes_successor', async () => {
      const subject = await register(host),
        key = ulid(),
        rotated = assertReply(
          await refresh(host, subject.registration.refresh_token, key),
          subject.registration,
        );
      assert.equal(
        (
          await http(host, '/v0/identity/sessions/logout', {
            body: {
              refresh_token: subject.registration.refresh_token,
              refresh_idempotency_key: key,
            },
          })
        ).status,
        204,
      );
      assert.equal((await profile(host, rotated.access_token)).status, 401);
      assert.equal((await refresh(host, subject.registration.refresh_token, key)).status, 401);
      assert.equal((await refresh(host, rotated.refresh_token)).status, 401);
    });
    await check('logout_after_actual_discarded_reply_revokes_unknown_successor', async () => {
      const subject = await register(host),
        key = ulid();
      await loseRefreshResponse(host, subject.registration.refresh_token, key);
      assert.equal(
        (
          await http(host, '/v0/identity/sessions/logout', {
            body: {
              refresh_token: subject.registration.refresh_token,
              refresh_idempotency_key: key,
            },
          })
        ).status,
        204,
      );
      assert.equal((await refresh(host, subject.registration.refresh_token, key)).status, 401);
      const state = await liveState(tenant, subject.registration.account.account_id);
      assert(state.sessions.every((session) => session.revoked !== null));
    });
    await check('logout_serializes_both_rotation_orders', async () => {
      for (const refreshFirst of [false, true]) {
        const subject = await register(host),
          holder = await lockAccount(tenant, subject.registration.account.account_id);
        const rotate = () => refresh(host, subject.registration.refresh_token);
        const logout = () =>
          http(host, '/v0/identity/sessions/logout', {
            body: { refresh_token: subject.registration.refresh_token },
          });
        let a, b;
        try {
          a = refreshFirst ? rotate() : logout();
          await waitBlocked();
          b = refreshFirst ? logout() : rotate();
          await waitBlocked(2);
          await finishLock(holder);
          const replies = await Promise.all([a, b]),
            rr = replies[refreshFirst ? 0 : 1];
          assert.equal(replies[refreshFirst ? 1 : 0].status, 204);
          assert.equal(rr.status, refreshFirst ? 200 : 401);
          if (refreshFirst) assert.equal((await profile(host, rr.body.access_token)).status, 401);
        } finally {
          await holder.end().catch(() => {});
          await Promise.allSettled([a, b].filter(Boolean));
        }
      }
    });
    await check('logout_wrong_rotation_proof_does_not_revoke', async () => {
      const subject = await register(host),
        key = ulid(),
        rotated = assertReply(
          await refresh(host, subject.registration.refresh_token, key),
          subject.registration,
        );
      assert.equal(
        (
          await http(host, '/v0/identity/sessions/logout', {
            body: {
              refresh_token: subject.registration.refresh_token,
              refresh_idempotency_key: ulid(),
            },
          })
        ).status,
        204,
      );
      assert.equal((await profile(host, rotated.access_token)).status, 200);
      assert.equal(
        (
          await http(host, '/v0/identity/sessions/logout', {
            body: { refresh_token: rotated.refresh_token },
          })
        ).status,
        204,
      );
      assert.equal((await profile(host, rotated.access_token)).status, 401);
    });
    await check('required_rotation_audit_rolls_back', () => rotationFault(host, tenant, false));
    await check('actual_commit_failure_rolls_back', () => rotationFault(host, tenant, true));
    await check('strict_request_no_store_and_tenant_isolation', async () => {
      const subject = await register(host);
      assert.equal((await refresh(host, subject.registration.refresh_token, '')).status, 400);
      assert.equal(
        (
          await http(host, '/v0/identity/sessions/refresh', {
            body: { refresh_token: subject.registration.refresh_token, role: 'patient' },
          })
        ).status,
        400,
      );
      assert.equal(
        (
          await refresh(
            host === 'localhost' ? 'ghana.heroshealth.com' : 'localhost',
            subject.registration.refresh_token,
          )
        ).status,
        401,
      );
      assert.equal((await refresh(host, 'A'.repeat(43))).status, 401);
      await setup.query(
        "UPDATE accounts SET status='suspended' WHERE tenant_id=$1 AND account_id=$2",
        [tenant, subject.registration.account.account_id],
      );
      assert.equal((await refresh(host, subject.registration.refresh_token)).status, 401);
    });
    results.push({ tenant, checks });
  }
  if (process.env.PATIENT_REFRESH_NATURAL_EXPIRY === 'true') {
    stage = 'natural_access_expiry';
    for (const { host, tenantId, subject } of fixtures.fixtures) {
      const original = subject.registration;
      const verified = verifyAccessToken(original.access_token, fixtures.signingKey);
      assert.equal(verified.ok, false);
      assert.equal(verified.reason, 'expired');
      assert.equal((await profile(host, original.access_token)).status, 401);
      const rotated = assertReply(await refresh(host, original.refresh_token), original);
      assert.equal((await profile(host, rotated.access_token)).status, 200);
      results.push({
        tenant: tenantId,
        checks: ['natural_15_minute_access_expiry_refresh_restores_actual_patient_access'],
      });
    }
  }
  const ledger = (
    await setup.query('SELECT filename,checksum_sha FROM schema_migrations ORDER BY filename')
  ).rows;
  await writeFile(
    process.env.PATIENT_REFRESH_RESULT,
    JSON.stringify({ ledger, results }, null, 2) + '\n',
  );
  process.stdout.write(JSON.stringify({ results }) + '\n');
} catch (error) {
  process.stderr.write(
    JSON.stringify({
      stage,
      code: error.code ?? 'refresh_probe_failed',
      message: String(error.message).slice(0, 1000),
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
