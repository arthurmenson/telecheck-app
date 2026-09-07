/** Called only inside the isolated synthetic full-chain care acceptance. */
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import { ulid } from '../src/lib/ulid.ts';

export async function verifyStaffEnrollment({
  admin,
  ordinary,
  inject,
  context,
  staff,
  author,
  reviewer,
  patient,
}) {
  assert.equal(process.env.CARE_SYNTHETIC_ACCEPTANCE, 'true');
  const path = '/v0/identity/staff/enrollments';
  const headers = (who, key = randomUUID()) => ({
    host: who.host,
    authorization: `Bearer ${who.token}`,
    'idempotency-key': key,
  });
  const body = {
    first_name: 'Synthetic',
    last_name: 'Clinician',
    phone_e164: `+1202${String(Math.floor(Math.random() * 10000000)).padStart(7, '0')}`,
    email: null,
  };
  const call = (who, payload = body, key = randomUUID()) =>
    inject({ method: 'POST', url: path, headers: headers(who, key), payload });
  assert.equal((await call(author)).statusCode, 403, 'role alone cannot enroll');
  assert.equal((await call(patient)).statusCode, 403, 'patient cannot enroll');
  await admin.query(
    `INSERT INTO public.identity_staff_membership(tenant_id,account_id,capability,granted_by,evidence_sha256,provisioning_reference)
    VALUES($1,$2,'clinician_enroller',$3,$4,'synthetic-isolated-acceptance-only')`,
    [
      author.tenant,
      author.account,
      reviewer.account,
      createHash('sha256').update('synthetic privileged provisioning').digest('hex'),
    ],
  );
  const key = randomUUID();
  const created = await call(author, body, key);
  assert.equal(created.statusCode, 201, created.body);
  assert.equal(created.headers['cache-control'], 'no-store');
  const receipt = created.json();
  assert.deepEqual(Object.keys(receipt).sort(), ['account_id', 'status']);
  assert.equal(receipt.status, 'pending_verification');
  const replay = await call(author, body, key);
  assert.equal(replay.statusCode, 201, replay.body);
  assert.deepEqual(replay.json(), created.json());
  assert.equal((await call(author, { ...body, last_name: 'Changed' }, key)).statusCode, 409);
  assert.equal(
    (await call(author, body)).statusCode,
    409,
    'duplicate contact is definite conflict',
  );
  for (const extra of ['tenant_id', 'account_type', 'status', 'license_verified'])
    assert.equal((await call(author, { ...body, [extra]: 'injected' })).statusCode, 400);
  const account = (
    await admin.query(
      'SELECT account_type,status,date_of_birth,gender,country_of_residence,activated_at FROM public.accounts WHERE tenant_id=$1 AND account_id=$2',
      [author.tenant, receipt.account_id],
    )
  ).rows[0];
  assert.deepEqual(account, {
    account_type: 'clinician',
    status: 'pending_verification',
    date_of_birth: null,
    gender: null,
    country_of_residence: null,
    activated_at: null,
  });
  assert.equal(
    Number(
      (
        await admin.query(
          'SELECT count(*) FROM public.identity_staff_enrollment WHERE tenant_id=$1 AND account_id=$2',
          [author.tenant, receipt.account_id],
        )
      ).rows[0].count,
    ),
    1,
  );
  const roster = await inject({ method: 'GET', url: path, headers: headers(author) });
  assert.equal(roster.statusCode, 200, roster.body);
  assert.equal(roster.headers['cache-control'], 'no-store');
  assert(roster.json().items.some((x) => x.account_id === receipt.account_id));
  for (const denied of [
    'tenant_id',
    'phone_e164',
    'email',
    'date_of_birth',
    'gender',
    'license_number',
    'refresh_token',
  ])
    assert(!roster.body.includes(`"${denied}"`));
  for (const query of ['?offset=01', '?offset=10001', '?tenant_id=Telecheck-US'])
    assert.equal(
      (await inject({ method: 'GET', url: path + query, headers: headers(author) })).statusCode,
      400,
    );
  assert.equal(
    (await inject({ method: 'GET', url: path, headers: headers(reviewer) })).statusCode,
    403,
  );
  const opposite = { ...author, host: author.country === 'US' ? 'ghana.localhost' : 'localhost' };
  assert(
    [401, 403].includes(
      (await inject({ method: 'GET', url: path, headers: headers(opposite) })).statusCode,
    ),
  );

  const identity = new pg.Client({ connectionString: process.env.IDENTITY_DATABASE_URL });
  await identity.connect();
  const bound = await context(author);
  async function denied(sql, params, code) {
    await identity.query('BEGIN');
    try {
      await identity.query('SELECT public.set_tenant_context($1)', [author.tenant]);
      await identity.query("SELECT set_config('app.request_nonce',$1,true)", [bound.actorNonce]);
      await assert.rejects(
        async () => {
          await identity.query(sql, params);
          await identity.query('COMMIT');
        },
        (e) => e.code === code,
      );
    } finally {
      await identity.query('ROLLBACK');
    }
  }
  try {
    await denied(
      'SELECT public.identity_enroll_clinician($1,$2,$3,$4,$5)',
      [ulid(), 'Synthetic', 'MissingAudit', body.phone_e164.replace(/.$/, '8') + '8', null],
      '23514',
    );
    await denied(
      "UPDATE public.accounts SET status='active',activated_at=clock_timestamp() WHERE tenant_id=$1 AND account_id=$2",
      [author.tenant, receipt.account_id],
      '42501',
    );
    // An intermediate suspended/archived status cannot bypass staff setup.
    await identity.query('BEGIN');
    try {
      await identity.query('SELECT public.set_tenant_context($1)', [author.tenant]);
      await identity.query(
        "UPDATE public.accounts SET status='suspended' WHERE tenant_id=$1 AND account_id=$2",
        [author.tenant, receipt.account_id],
      );
      await assert.rejects(
        identity.query(
          "UPDATE public.accounts SET status='active' WHERE tenant_id=$1 AND account_id=$2",
          [author.tenant, receipt.account_id],
        ),
        (e) => e.code === '42501',
      );
    } finally {
      await identity.query('ROLLBACK');
    }
    await denied(
      "INSERT INTO public.sessions(session_id,tenant_id,account_id,refresh_token_hash,expires_at) VALUES($1,$2,$3,$4,clock_timestamp()+interval '1 hour')",
      [ulid(), author.tenant, receipt.account_id, randomBytes(32).toString('hex')],
      '42501',
    );
    await denied(
      "UPDATE public.accounts SET account_type='tenant_admin' WHERE tenant_id=$1 AND account_id=$2",
      [author.tenant, receipt.account_id],
      '42501',
    );
    await denied(
      'DELETE FROM public.identity_staff_enrollment WHERE tenant_id=$1 AND account_id=$2',
      [author.tenant, receipt.account_id],
      '42501',
    );
  } finally {
    await identity.end();
  }
  for (const sql of [
    'SELECT public.identity_enroll_clinician(NULL,NULL,NULL,NULL,NULL)',
    'SELECT * FROM public.identity_staff_membership',
    'SELECT * FROM public.identity_staff_enrollment',
  ]) {
    await ordinary.query('BEGIN');
    try {
      await ordinary.query('SELECT public.set_tenant_context($1)', [author.tenant]);
      await assert.rejects(ordinary.query(sql), (e) => e.code === '42501');
    } finally {
      await ordinary.query('ROLLBACK');
    }
  }
  for (const endpoint of ['/v0/identity/login/start', '/v0/identity/login/verify']) {
    const response = await inject({
      method: 'POST',
      url: endpoint,
      headers: { host: author.host, 'idempotency-key': randomUUID() },
      payload: { phone_e164: body.phone_e164, code: '123456' },
    });
    assert.equal(response.statusCode, 403, response.body);
    assert(!response.body.includes('access_token'));
  }
  // All three real blocking boundaries must deny after session expiry.
  for (const [table, method] of [
    ['audit_records', 'POST'],
    ['audit_records', 'GET'],
    ['identity_staff_membership', 'POST'],
  ]) {
    const actor = await staff(author.tenant, author.country, 'tenant_admin', [], []);
    await admin.query(
      `INSERT INTO public.identity_staff_membership(tenant_id,account_id,capability,granted_by,evidence_sha256,provisioning_reference)
      VALUES($1,$2,'clinician_enroller',$3,$4,'synthetic-blocked-expiry')`,
      [
        actor.tenant,
        actor.account,
        reviewer.account,
        createHash('sha256').update('synthetic-expiry').digest('hex'),
      ],
    );
    const blocker = new pg.Client({ connectionString: process.env.CARE_TEST_SETUP_DATABASE_URL });
    await blocker.connect();
    const blockedBody = {
      ...body,
      phone_e164: `+1800${String(Math.floor(Math.random() * 10000000)).padStart(7, '0')}`,
    };
    let waiting;
    try {
      await blocker.query('BEGIN');
      await blocker.query(
        `LOCK TABLE public.${table} IN ${table === 'audit_records' ? 'SHARE' : 'ACCESS EXCLUSIVE'} MODE`,
      );
      waiting = inject({
        method,
        url: path,
        headers: headers(actor),
        ...(method === 'POST' ? { payload: blockedBody } : {}),
      });
      let blocked = false;
      for (let attempt = 0; attempt < 150; attempt++) {
        blocked = (
          await admin.query(
            "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND usename='identity_service_role' AND wait_event_type='Lock') AS blocked",
          )
        ).rows[0].blocked;
        if (blocked) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert(blocked, `${table}/${method} request reached real lock`);
      await admin.query(
        "UPDATE public.sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE tenant_id=$1 AND session_id=$2",
        [actor.tenant, actor.session],
      );
      await blocker.query('COMMIT');
      const denied = await waiting;
      assert.equal(denied.statusCode, 401, denied.body);
      assert(!denied.body.includes('"items"'));
      assert.equal(
        (
          await admin.query('SELECT 1 FROM public.accounts WHERE tenant_id=$1 AND phone_e164=$2', [
            actor.tenant,
            blockedBody.phone_e164,
          ])
        ).rowCount,
        0,
      );
    } finally {
      await blocker.query('ROLLBACK');
      await blocker.end();
      if (waiting) await waiting;
    }
  }
  // A real row cannot commit after outbox evidence is missing or contradictory.
  for (const mutation of [
    "NEW.payload:=NEW.payload-'status'",
    "NEW.payload:=jsonb_set(NEW.payload,'{account_id}','null'::jsonb)",
    "NEW.aggregate_type:='Wrong'",
  ]) {
    await admin.query(`CREATE FUNCTION public.synthetic_staff_event_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.event_type='identity.clinician.enrolled' THEN ${mutation}; END IF; RETURN NEW; END $$`);
    await admin.query(
      'CREATE TRIGGER synthetic_staff_event_fault BEFORE INSERT ON public.domain_events_outbox FOR EACH ROW EXECUTE FUNCTION public.synthetic_staff_event_fault()',
    );
    const badBody = {
      ...body,
      phone_e164: `+1888${String(Math.floor(Math.random() * 10000000)).padStart(7, '0')}`,
    };
    try {
      const denied = await call(author, badBody);
      assert.equal(denied.statusCode, 409, denied.body);
      assert.equal(
        (
          await admin.query('SELECT 1 FROM public.accounts WHERE tenant_id=$1 AND phone_e164=$2', [
            author.tenant,
            badBody.phone_e164,
          ])
        ).rowCount,
        0,
      );
    } finally {
      await admin.query('DROP TRIGGER synthetic_staff_event_fault ON public.domain_events_outbox');
      await admin.query('DROP FUNCTION public.synthetic_staff_event_fault()');
    }
  }
  await admin.query(
    "UPDATE public.identity_staff_membership SET revoked_at=clock_timestamp(),revocation_reference='synthetic-revoke' WHERE tenant_id=$1 AND account_id=$2",
    [author.tenant, author.account],
  );
  assert.equal(
    (await call(author, body, key)).statusCode,
    403,
    'replay rechecks operator capability',
  );
  assert.equal(
    (await inject({ method: 'GET', url: path, headers: headers(author) })).statusCode,
    403,
  );
  console.log(
    `${author.country}: staff enrollment real HTTP, private identity capability, replay/role/tenant, pending activation/session denial, evidence rollback and revoked roster PASS`,
  );
}
