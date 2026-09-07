import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import http from 'node:http';
import pg from 'pg';

import { bindActorContextForRequest } from '../src/lib/actor-context-binding.ts';
import { closeBindActorContextPool, closePool } from '../src/lib/db.ts';
import { asTenantId } from '../src/lib/glossary.ts';
import { issueAccessToken } from '../src/lib/jwt.ts';
import { ulid } from '../src/lib/ulid.ts';
import { hashCarePolicy } from '../src/modules/consent/internal/services/care-policy-contract.ts';

assert.equal(process.env.NODE_ENV, 'development');
assert.equal(process.env.EMAIL_PROVIDER, 'noop');
assert.equal(process.env.SMS_PROVIDER, 'noop');
const target = new URL(process.env.DATABASE_URL);
assert(['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname));
for (const url of [
  process.env.CONSENT_ACCEPTANCE_ADMIN_DATABASE_URL,
  process.env.BIND_ACTOR_CONTEXT_DATABASE_URL,
  process.env.IDENTITY_DATABASE_URL,
]) {
  const parsed = new URL(url);
  assert.equal(parsed.hostname, target.hostname);
  assert.equal(parsed.port, target.port);
  assert.equal(parsed.pathname, target.pathname);
}
const control = new pg.Client({
  connectionString: process.env.CONSENT_ACCEPTANCE_ADMIN_DATABASE_URL,
});
const binder = new pg.Client({ connectionString: process.env.BIND_ACTOR_CONTEXT_DATABASE_URL });
const ordinary = new pg.Client({ connectionString: process.env.DATABASE_URL });
await Promise.all([control.connect(), binder.connect(), ordinary.connect()]);
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
if (process.env.CONSENT_ACCEPTANCE_DIAGNOSTICS === 'true')
  app.addHook('onError', async (_request, _reply, error) => {
    console.error({ code: error.code, message: error.message, where: error.where });
  });
const origin = await app.listen({ host: '127.0.0.1', port: 0 });

async function staff(tenant, country, capabilities, accountRole = 'tenant_admin') {
  const accountId = ulid(),
    sessionId = ulid();
  await control.query(
    `INSERT INTO public.accounts(account_id,tenant_id,email,first_name,last_name,date_of_birth,gender,country_of_residence,country_of_care,locale,account_type,status)
    VALUES($1,$2,$3,'Synthetic','Consent','1990-01-01','prefer_not_to_say',$4,$4,$5,$6,'active')`,
    [accountId, tenant, `${randomUUID()}@example.invalid`, country, `en-${country}`, accountRole],
  );
  await control.query(
    `INSERT INTO public.sessions(session_id,tenant_id,account_id,refresh_token_hash,expires_at) VALUES($1,$2,$3,$4,clock_timestamp()+interval '1 hour')`,
    [sessionId, tenant, accountId, randomBytes(32).toString('hex')],
  );
  for (const capability of capabilities)
    await control.query(
      'INSERT INTO public.consent_care_membership(tenant_id,account_id,capability) VALUES($1,$2,$3)',
      [tenant, accountId, capability],
    );
  const token = issueAccessToken(
    {
      account_id: accountId,
      tenant_id: asTenantId(tenant),
      session_id: sessionId,
      role: accountRole,
      country_of_care: country,
      ...(accountRole === 'tenant_admin' ? { admin_tenant_binding: tenant } : {}),
    },
    process.env.JWT_SIGNING_KEY,
  );
  return { accountId, sessionId, tenant, country, role: accountRole, token };
}
async function call(who, method, path, body, key = randomUUID()) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      origin + path,
      {
        method,
        headers: {
          Host: who.country === 'US' ? 'localhost' : 'ghana.localhost',
          Authorization: `Bearer ${who.token}`,
          'Idempotency-Key': key,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
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
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}
const root = '/v0/consent/governance/care-policies';
function policy(country, version) {
  const copy = {
    version_label: version,
    title: 'Synthetic development terms',
    summary: 'Engineering test only.',
    sections: [
      { heading: 'Scope', body: 'Synthetic acceptance content; no legal or clinical approval.' },
    ],
    withdrawal_effect: 'Synthetic withdrawal explanation.',
    duration: 'until_withdrawn',
  };
  return {
    contract_version: 'care_consent_v1',
    country_of_care: country,
    locale: `en-${country}`,
    program_id: null,
    development_only: true,
    jurisdictional_review: {
      artifact_reference: 'synthetic-review',
      conclusion: 'no_additional_consent',
    },
    terms: [
      { ...copy, key: 'platform', consent_type: 'platform', scope_id: null },
      { ...copy, key: 'care', consent_type: 'care', scope_id: null },
      {
        ...copy,
        key: 'ai',
        consent_type: 'data_use',
        scope_id: 'ai_interpretation',
        decline_effect: 'Manual care remains available.',
      },
    ],
  };
}
async function expectStatus(response, status, label) {
  assert.equal(response.status, status, `${label}: ${response.status}`);
  return response.body;
}
async function sqlDenied(who, sql, values, expected = '42501', role = 'consent_care_operator') {
  const bound = await bindActorContextForRequest(binder, {
    actorAccountId: who.accountId,
    actorAccountTenantId: who.tenant,
    actorRole: who.role,
    actorAdminHomeTenantId: null,
    sessionId: who.sessionId,
  });
  await ordinary.query('BEGIN');
  try {
    await ordinary.query('SELECT public.set_tenant_context($1)', [who.tenant]);
    await ordinary.query("SELECT set_config('app.request_nonce',$1,true)", [bound.nonce]);
    assert(['consent_care_operator', 'consent_care_patient'].includes(role));
    await ordinary.query(`SET LOCAL ROLE ${role}`);
    await assert.rejects(
      async () => {
        await ordinary.query(sql, values);
        await ordinary.query('SET CONSTRAINTS ALL IMMEDIATE');
      },
      (error) => error.code === expected,
    );
  } finally {
    await ordinary.query('ROLLBACK');
  }
}
async function blockedReplay(tenant, country, fault, body) {
  const who = await staff(tenant, country, ['policy_author']);
  const key = randomUUID();
  const initial = await call(who, 'POST', root, body, key);
  await expectStatus(initial, 201, 'initial replay receipt');
  const blocker = new pg.Client({
    connectionString: process.env.CONSENT_ACCEPTANCE_ADMIN_DATABASE_URL,
  });
  await blocker.connect();
  await blocker.query('BEGIN');
  await blocker.query('LOCK TABLE public.idempotency_keys IN SHARE MODE');
  const pending = call(who, 'POST', root, body, key);
  try {
    let waiting = false;
    for (let i = 0; i < 80; i++) {
      waiting = (
        await control.query(
          "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND usename='telecheck_app_role' AND wait_event_type='Lock' AND query ILIKE '%DELETE FROM idempotency_keys%') AS waiting",
        )
      ).rows[0].waiting;
      if (waiting) break;
      await new Promise((resolve) => setTimeout(resolve, 15));
    }
    assert(waiting, 'cache reservation blocked after initial authorization');
    if (fault === 'membership')
      await control.query(
        'UPDATE public.consent_care_membership SET revoked_at=clock_timestamp() WHERE tenant_id=$1 AND account_id=$2',
        [tenant, who.accountId],
      );
    else if (fault === 'session')
      await control.query(
        "UPDATE public.sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE tenant_id=$1 AND session_id=$2",
        [tenant, who.sessionId],
      );
    else
      await control.query(
        "UPDATE public._session_actor_context SET expires_at=clock_timestamp()-interval '1 second' WHERE actor_account_tenant_id=$1 AND actor_account_id=$2 AND session_id=$3",
        [tenant, who.accountId, who.sessionId],
      );
    await blocker.query('COMMIT');
    const result = await pending;
    await expectStatus(result, fault === 'membership' ? 403 : 401, `blocked ${fault} replay`);
    assert.equal(result.body.policy_id, undefined);
    assert.equal(result.cache, 'no-store');
    console.log(`PASS ${country} cached receipt denied after blocked ${fault} invalidation`);
  } finally {
    await blocker.query('ROLLBACK').catch(() => {});
    await blocker.end();
    await pending.catch(() => {});
  }
}
async function patientAuthorityWait(tenant, country, phase, fault, choices) {
  const who = await staff(tenant, country, [], 'patient');
  const key = randomUUID();
  const care = '/v0/consent/care';
  let seeded;
  if (phase !== 'outbox')
    seeded = await expectStatus(
      await call(who, 'POST', `${care}/choices`, choices, key),
      201,
      'seed own choices',
    );
  const before = (
    await control.query(
      'SELECT count(*)::int AS count FROM public.consent_care_decision WHERE tenant_id=$1 AND account_id=$2',
      [tenant, who.accountId],
    )
  ).rows[0].count;
  const blocker = new pg.Client({
    connectionString: process.env.CONSENT_ACCEPTANCE_ADMIN_DATABASE_URL,
  });
  await blocker.connect();
  await blocker.query('BEGIN');
  const table =
    phase === 'replay'
      ? 'idempotency_keys'
      : phase === 'history' || phase === 'detail'
        ? 'consent_care_decision'
        : 'domain_events_outbox';
  await blocker.query(
    `LOCK TABLE public.${table} IN ${phase === 'history' || phase === 'detail' ? 'ACCESS EXCLUSIVE' : 'SHARE'} MODE`,
  );
  const pending =
    phase === 'detail'
      ? call(who, 'GET', `${care}/history/${seeded.decisions[1].decision_id}`)
      : phase === 'history'
        ? call(who, 'GET', `${care}/history`)
        : call(who, 'POST', `${care}/choices`, choices, key);
  try {
    let waiting = false;
    for (let i = 0; i < 80; i++) {
      const pattern =
        phase === 'detail'
          ? '%consent_care_decision_detail%'
          : phase === 'history'
            ? '%consent_care_history%'
            : phase === 'replay'
              ? '%DELETE FROM idempotency_keys%'
              : '%domain_events_outbox%';
      waiting = (
        await control.query(
          "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND usename='telecheck_app_role' AND wait_event_type='Lock' AND query ILIKE $1) AS waiting",
          [pattern],
        )
      ).rows[0].waiting;
      if (waiting) break;
      await new Promise((resolve) => setTimeout(resolve, 15));
    }
    assert(waiting, `${phase} reached its controlled wait`);
    if (fault === 'session')
      await control.query(
        "UPDATE public.sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE tenant_id=$1 AND session_id=$2",
        [tenant, who.sessionId],
      );
    else if (fault === 'nonce')
      await control.query(
        "UPDATE public._session_actor_context SET expires_at=clock_timestamp()-interval '1 second' WHERE actor_account_tenant_id=$1 AND actor_account_id=$2 AND session_id=$3",
        [tenant, who.accountId, who.sessionId],
      );
    else
      await control.query(
        "UPDATE public.accounts SET status='suspended',suspended_at=clock_timestamp() WHERE tenant_id=$1 AND account_id=$2",
        [tenant, who.accountId],
      );
    await blocker.query('COMMIT');
    const result = await pending;
    await expectStatus(result, 401, `${phase} ${fault} invalidation`);
    assert.equal(result.cache, 'no-store');
    assert.equal(result.body.items, undefined);
    assert.equal(result.body.decisions, undefined);
    assert.equal(result.body.term, undefined);
    assert.equal(
      (
        await control.query(
          'SELECT count(*)::int AS count FROM public.consent_care_decision WHERE tenant_id=$1 AND account_id=$2',
          [tenant, who.accountId],
        )
      ).rows[0].count,
      before,
    );
    if (phase === 'outbox')
      assert.equal(
        (
          await control.query(
            "SELECT count(*)::int AS count FROM public.audit_records WHERE tenant_id=$1 AND target_patient_id=$2 AND action IN ('consent_choice_recorded','consent_granted','consent_revoked')",
            [tenant, who.accountId],
          )
        ).rows[0].count,
        0,
      );
    console.log(
      `PASS ${country} patient ${phase} denies ${fault} invalidation and retains only prior committed evidence`,
    );
  } finally {
    await blocker.query('ROLLBACK').catch(() => {});
    await blocker.end();
    await pending.catch(() => {});
  }
}

async function programAndVersionAcceptance(author, reviewer, body, generalChoices) {
  const { tenant, country } = author;
  const who = await staff(tenant, country, [], 'patient');
  const care = '/v0/consent/care';
  const original = await expectStatus(
    await call(who, 'POST', `${care}/choices`, generalChoices),
    201,
    'original general consent',
  );
  const programId = ulid();
  const content = structuredClone(body);
  content.program_id = programId;
  content.terms.find((t) => t.consent_type === 'care').scope_id = programId;
  content.jurisdictional_review.conclusion = 'requirements_listed';
  const { scope_id: _scope, key: _key, consent_type: _type, ...copy } = content.terms[0];
  content.terms.push({
    ...copy,
    key: 'market_notice',
    consent_type: 'jurisdictional',
    scope_id: 'synthetic_market_notice',
    regulatory_reference: 'Synthetic engineering fixture only',
  });
  const proposal = await expectStatus(
    await call(author, 'POST', root, content),
    201,
    'program consent proposal',
  );
  await expectStatus(
    await call(reviewer, 'POST', `${root}/${proposal.policy_id}/publish`, {
      policy_hash: proposal.content_hash,
    }),
    201,
    'program policy review',
  );
  const binding = {
    publication_id: proposal.policy_id,
    policy_hash: proposal.content_hash,
    development_only: true,
  };
  await control.query(
    "UPDATE public.ccr_configs SET config_value=config_value || jsonb_build_object($2::text,$3::jsonb) WHERE tenant_id=$1 AND config_key='consent.care_policy_publications'",
    [tenant, programId, JSON.stringify(binding)],
  );
  const suffix = `?program_id=${programId}`;
  const before = await expectStatus(
    await call(who, 'GET', `${care}/status${suffix}`),
    200,
    'program status',
  );
  assert.equal(before.required_care_active, false);
  assert.equal(before.terms.find((t) => t.term_key === 'care').active, false);
  const programChoices = {
    publication_id: binding.publication_id,
    policy_hash: binding.policy_hash,
    choices: content.terms.map((t) => ({
      term_key: t.key,
      accepted: t.consent_type === 'platform' || t.consent_type === 'care',
    })),
  };
  await expectStatus(
    await call(who, 'POST', `${care}/choices${suffix}`, generalChoices),
    409,
    'general policy cannot grant program consent',
  );
  await expectStatus(
    await call(who, 'POST', `${care}/choices${suffix}`, programChoices),
    201,
    'jurisdictional refusal remains explicit',
  );
  assert.equal(
    (
      await expectStatus(
        await call(who, 'GET', `${care}/status${suffix}`),
        200,
        'jurisdictional refusal state',
      )
    ).required_care_active,
    false,
  );
  programChoices.choices.find((t) => t.term_key === 'market_notice').accepted = true;
  let latest;
  for (let i = 0; i < 6; i++)
    latest = await expectStatus(
      await call(who, 'POST', `${care}/choices${suffix}`, programChoices),
      201,
      'deliberate program choice',
    );
  const complete = await expectStatus(
    await call(who, 'GET', `${care}/status${suffix}`),
    200,
    'program required consent granted',
  );
  assert.equal(complete.required_care_active, true);
  assert.equal(complete.ai_interpretation_active, false);
  const page = await expectStatus(
    await call(who, 'GET', `${care}/history`),
    200,
    'history first page',
  );
  const next = await expectStatus(
    await call(who, 'GET', `${care}/history?offset=25`),
    200,
    'history next page',
  );
  assert.equal(page.items.length, 25);
  assert.equal(page.has_more, true);
  assert.equal(next.items.length, 6);
  assert.equal(next.has_more, false);
  assert.equal(new Set([...page.items, ...next.items].map((t) => t.decision_id)).size, 31);
  assert.deepEqual(
    page.items.slice(0, 4).map((t) => t.decision_id),
    latest.decisions.map((t) => t.decision_id).reverse(),
  );
  await expectStatus(await call(who, 'GET', `${care}/history?offset=10001`), 400, 'history bound');
  const updated = structuredClone(body);
  updated.terms.forEach((t) => {
    t.version_label = t.version_label.replace('v1.', 'v2.');
    t.summary = 'New synthetic engineering terms version.';
  });
  const versioned = await expectStatus(
    await call(author, 'POST', root, updated),
    201,
    'changed terms proposal',
  );
  await expectStatus(
    await call(reviewer, 'POST', `${root}/${versioned.policy_id}/publish`, {
      policy_hash: versioned.content_hash,
    }),
    201,
    'changed terms reviewed',
  );
  await expectStatus(
    await call(who, 'GET', `${care}/terms`),
    503,
    'superseded configured pointer unavailable',
  );
  // A patient can withdraw an old grant without agreeing to a newer policy.
  await expectStatus(
    await call(who, 'POST', `${care}/withdraw`, {
      decision_id: original.decisions.find((t) => t.consent_type === 'care').decision_id,
    }),
    201,
    'withdraw superseded-version grant',
  );
  await control.query(
    "UPDATE public.ccr_configs SET config_value=jsonb_set(config_value,'{general}',$2::jsonb) WHERE tenant_id=$1 AND config_key='consent.care_policy_publications'",
    [
      tenant,
      JSON.stringify({
        publication_id: versioned.policy_id,
        policy_hash: versioned.content_hash,
        development_only: true,
      }),
    ],
  );
  const newStatus = await expectStatus(
    await call(who, 'GET', `${care}/status`),
    200,
    'new terms status',
  );
  assert.equal(newStatus.required_care_active, false);
  await expectStatus(
    await call(who, 'POST', `${care}/choices`, generalChoices),
    409,
    'stale publication rejected',
  );
  await expectStatus(
    await call(reviewer, 'POST', `${root}/${versioned.policy_id}/withdraw`, {
      policy_hash: versioned.content_hash,
    }),
    201,
    'withdraw synthetic replacement',
  );
  console.log(
    `PASS ${country} program isolation, required jurisdictional refusal, optional AI, ordered pagination, version changes and superseded-grant withdrawal`,
  );
}

try {
  const version = `v1.${Date.now() % 10000}`;
  for (const [tenant, country] of [
    ['Telecheck-US', 'US'],
    ['Telecheck-Ghana', 'GH'],
  ]) {
    const author = await staff(tenant, country, ['policy_author', 'policy_reviewer']);
    const reviewer = await staff(tenant, country, ['policy_reviewer']);
    const patient = await staff(tenant, country, [], 'patient');
    const body = policy(country, version);
    await expectStatus(
      await call(patient, 'POST', root, body),
      403,
      'patient cannot publish policy',
    );
    const key = randomUUID();
    const createdResponse = await call(author, 'POST', root, body, key);
    const created = await expectStatus(createdResponse, 201, 'draft policy');
    assert.equal(created.content_hash, hashCarePolicy(body));
    assert.equal(createdResponse.cache, 'no-store');
    const replay = await expectStatus(
      await call(author, 'POST', root, body, key),
      201,
      'draft replay',
    );
    assert.deepEqual(replay, created);
    const inspected = await expectStatus(
      await call(reviewer, 'GET', `${root}/${created.policy_id}`),
      200,
      'review exact content',
    );
    assert.deepEqual(inspected.content, body);
    await expectStatus(
      await call(author, 'POST', `${root}/${created.policy_id}/publish`, {
        policy_hash: created.content_hash,
      }),
      403,
      'self approval denied',
    );
    await expectStatus(
      await call(reviewer, 'POST', `${root}/${created.policy_id}/publish`, {
        policy_hash: '0'.repeat(64),
      }),
      409,
      'stale hash denied',
    );
    const published = await expectStatus(
      await call(reviewer, 'POST', `${root}/${created.policy_id}/publish`, {
        policy_hash: created.content_hash,
      }),
      201,
      'independent publication',
    );
    assert.equal(published.status, 'published');
    const count = (
      await control.query(
        'SELECT count(*)::int AS count FROM public.consent_care_policy_term WHERE tenant_id=$1 AND policy_id=$2',
        [tenant, created.policy_id],
      )
    ).rows[0].count;
    assert.equal(count, 3);
    const repeated = await expectStatus(
      await call(author, 'POST', root, body),
      201,
      'replacement proposal',
    );
    const replacement = await expectStatus(
      await call(reviewer, 'POST', `${root}/${repeated.policy_id}/publish`, {
        policy_hash: repeated.content_hash,
      }),
      201,
      'replacement publication',
    );
    assert.equal(replacement.superseded[0].policy_id, created.policy_id);
    const care = '/v0/consent/care';
    await expectStatus(
      await call(patient, 'GET', `${care}/terms`),
      503,
      'unconfigured terms unavailable',
    );
    const binding = {
      publication_id: replacement.policy_id,
      policy_hash: replacement.content_hash,
      development_only: true,
    };
    await control.query(
      `INSERT INTO public.ccr_configs(id,tenant_id,config_key,config_value) VALUES($1,$2,'consent.care_policy_publications',$3::jsonb)
      ON CONFLICT(tenant_id,config_key) DO UPDATE SET config_value=EXCLUDED.config_value`,
      [ulid(), tenant, JSON.stringify({ general: binding })],
    );
    const terms = await expectStatus(
      await call(patient, 'GET', `${care}/terms`),
      200,
      'patient sees configured exact terms',
    );
    assert.deepEqual(terms, {
      publication_id: binding.publication_id,
      policy_hash: binding.policy_hash,
      content: body,
    });
    const initialStatus = await expectStatus(
      await call(patient, 'GET', `${care}/status`),
      200,
      'initial consent status',
    );
    assert.equal(initialStatus.required_care_active, false);
    assert.equal(initialStatus.ai_interpretation_active, false);
    const choices = {
      publication_id: binding.publication_id,
      policy_hash: binding.policy_hash,
      choices: [
        { term_key: 'platform', accepted: true },
        { term_key: 'care', accepted: true },
        { term_key: 'ai', accepted: false },
      ],
    };
    const decisionKey = randomUUID();
    const receipt = await expectStatus(
      await call(patient, 'POST', `${care}/choices`, choices, decisionKey),
      201,
      'deliberate patient choices',
    );
    assert.deepEqual(
      receipt.decisions.map((d) => [d.accepted, d.status]),
      [
        [true, 'granted'],
        [true, 'granted'],
        [false, 'declined'],
      ],
    );
    assert.equal(receipt.decisions[2].consent_id, null);
    const grantedStatus = await expectStatus(
      await call(patient, 'GET', `${care}/status`),
      200,
      'required consent active',
    );
    assert.equal(grantedStatus.required_care_active, true);
    assert.equal(grantedStatus.ai_interpretation_active, false);
    assert.deepEqual(
      await expectStatus(
        await call(patient, 'POST', `${care}/choices`, choices, decisionKey),
        201,
        'choices replay',
      ),
      receipt,
    );
    const recorded = (
      await control.query(
        'SELECT count(*)::int AS count FROM public.consent_care_decision WHERE tenant_id=$1 AND account_id=$2',
        [tenant, patient.accountId],
      )
    ).rows[0].count;
    assert.equal(recorded, 3);
    const canonical = (
      await control.query(
        'SELECT status,evidence FROM public.consent WHERE tenant_id=$1 AND account_id=$2',
        [tenant, patient.accountId],
      )
    ).rows;
    assert.equal(canonical.length, 2);
    assert(
      canonical.every(
        (c) =>
          c.status === 'granted' &&
          c.evidence.session_id === patient.sessionId &&
          c.evidence.policy_hash === binding.policy_hash,
      ),
    );
    await expectStatus(
      await call(patient, 'POST', `${care}/choices`, {
        ...choices,
        evidence: { timestamp: 'invented' },
      }),
      400,
      'request evidence refused',
    );
    await expectStatus(
      await call(patient, 'POST', `${care}/choices`, { ...choices, policy_hash: '0'.repeat(64) }),
      409,
      'stale choice hash',
    );
    await expectStatus(
      await call(patient, 'POST', `${care}/choices`, {
        ...choices,
        choices: [choices.choices[0], choices.choices[0], choices.choices[2]],
      }),
      400,
      'duplicate choices',
    );
    await expectStatus(
      await call(patient, 'POST', `${care}/choices`, {
        ...choices,
        choices: choices.choices.map((c) => ({ ...c, accepted: false })),
      }),
      409,
      'platform withdrawal requires account closure',
    );
    const optedIn = { ...choices, choices: choices.choices.map((c) => ({ ...c, accepted: true })) };
    await expectStatus(
      await call(patient, 'POST', `${care}/choices`, optedIn),
      201,
      'optional AI explicit opt in',
    );
    assert.equal(
      (await expectStatus(await call(patient, 'GET', `${care}/status`), 200, 'AI opted in state'))
        .ai_interpretation_active,
      true,
    );
    const optedOut = await expectStatus(
      await call(patient, 'POST', `${care}/choices`, choices),
      201,
      'optional AI withdrawal',
    );
    assert.equal(optedOut.decisions[2].status, 'revoked');
    assert(optedOut.decisions[2].consent_id);
    const history = await expectStatus(
      await call(patient, 'GET', `${care}/history`),
      200,
      'private history',
    );
    assert.equal(history.items.length, 9);
    assert.equal(history.has_more, false);
    assert.equal(history.items.filter((item) => item.current_choice).length, 3);
    assert.equal(history.items.filter((item) => item.can_withdraw).length, 1);
    assert.equal(history.items.filter((item) => item.requires_account_closure).length, 1);
    for (const item of history.items) {
      const term = body.terms.find((candidate) => candidate.key === item.term_key);
      assert.equal(item.title, term.title);
      assert.equal(item.version_label, term.version_label);
      assert.equal(item.country_of_care, country);
      assert.equal(item.program_id, null);
    }
    const detailPath = `${care}/history/${optedOut.decisions[1].decision_id}`;
    const detail = await expectStatus(
      await call(patient, 'GET', detailPath),
      200,
      'own exact term detail',
    );
    assert.deepEqual(detail.term, body.terms[1]);
    assert.equal(detail.current_choice, true);
    assert.equal(detail.can_withdraw, true);
    assert.equal(detail.requires_account_closure, false);
    assert.equal(detail.evidence, undefined);
    assert.equal(detail.session_id, undefined);
    await expectStatus(
      await call(author, 'GET', detailPath),
      403,
      'operator cannot read decision detail',
    );
    await expectStatus(
      await call(patient, 'GET', `${detailPath}?account_id=${patient.accountId}`),
      400,
      'detail rejects subject query',
    );
    assert(
      history.items.every(
        (item) =>
          item.evidence === undefined &&
          item.session_id === undefined &&
          item.account_id === undefined &&
          item.tenant_id === undefined,
      ),
    );
    assert.equal(
      (
        await expectStatus(
          await call(author, 'GET', `${care}/history`),
          403,
          'operator cannot read patient history',
        )
      ).items,
      undefined,
    );
    const secondPatient = await staff(tenant, country, [], 'patient');
    await expectStatus(
      await call(secondPatient, 'GET', detailPath),
      404,
      'other patient cannot read decision detail',
    );
    assert.equal(
      (
        await expectStatus(
          await call(secondPatient, 'GET', `${care}/history`),
          200,
          'other patient empty history',
        )
      ).items.length,
      0,
    );
    await expectStatus(
      await call(secondPatient, 'POST', `${care}/withdraw`, {
        decision_id: optedOut.decisions[1].decision_id,
      }),
      404,
      'other patient cannot withdraw',
    );
    const withdrawalKey = randomUUID();
    const withdrawalBody = { decision_id: optedOut.decisions[1].decision_id };
    const withdrawal = await expectStatus(
      await call(patient, 'POST', `${care}/withdraw`, withdrawalBody, withdrawalKey),
      201,
      'dedicated care withdrawal',
    );
    assert.equal(withdrawal.decisions.length, 1);
    assert.equal(withdrawal.decisions[0].status, 'revoked');
    const oldDetail = await expectStatus(
      await call(patient, 'GET', detailPath),
      200,
      'historical grant after withdrawal',
    );
    assert.deepEqual(oldDetail.term, detail.term);
    assert.equal(oldDetail.current_choice, false);
    assert.equal(oldDetail.can_withdraw, false);
    const withdrawnDetail = await expectStatus(
      await call(patient, 'GET', `${care}/history/${withdrawal.decisions[0].decision_id}`),
      200,
      'current revocation detail',
    );
    assert.equal(withdrawnDetail.current_choice, true);
    assert.equal(withdrawnDetail.can_withdraw, false);
    assert.equal(withdrawnDetail.status, 'revoked');
    assert.deepEqual(
      await expectStatus(
        await call(patient, 'POST', `${care}/withdraw`, withdrawalBody, withdrawalKey),
        201,
        'withdrawal replay',
      ),
      withdrawal,
    );
    assert.equal(
      (
        await expectStatus(
          await call(patient, 'GET', `${care}/status`),
          200,
          'withdrawn care state',
        )
      ).required_care_active,
      false,
    );
    await expectStatus(
      await call(patient, 'POST', `${care}/withdraw`, withdrawalBody),
      409,
      'stale withdrawal target',
    );
    await sqlDenied(
      patient,
      'SELECT * FROM public.consent_care_decision',
      [],
      '42501',
      'consent_care_patient',
    );
    await sqlDenied(
      patient,
      'SELECT public.consent_care_record_choices($1,$2,$3,$4::jsonb,$5::jsonb)',
      [
        null,
        binding.publication_id,
        binding.policy_hash,
        JSON.stringify(choices.choices),
        JSON.stringify(choices.choices.map(() => ({ decision_id: ulid(), consent_id: ulid() }))),
      ],
      '23514',
      'consent_care_patient',
    );
    console.log(
      `PASS ${country} configured exact terms, explicit choices, initial decline without grant, optional opt-in/withdrawal, replay and mandatory evidence`,
    );
    const foreign = await staff(
      tenant === 'Telecheck-US' ? 'Telecheck-Ghana' : 'Telecheck-US',
      country === 'US' ? 'GH' : 'US',
      ['policy_reviewer'],
    );
    await expectStatus(
      await call(foreign, 'GET', `${root}/${created.policy_id}`),
      404,
      'cross tenant policy',
    );
    await sqlDenied(author, 'SELECT * FROM public.consent_care_policy', []);
    await sqlDenied(author, 'SET LOCAL ROLE consent_care_owner', []);
    await sqlDenied(
      author,
      'SELECT public.consent_care_create_policy($1,$2::jsonb,$3)',
      [ulid(), body, hashCarePolicy(body)],
      '23514',
    );
    const evidence = (
      await control.query(
        "SELECT count(*)::int AS count FROM public.audit_records WHERE tenant_id=$1 AND resource_id=$2 AND action='config_change_validated'",
        [tenant, created.policy_id],
      )
    ).rows[0].count;
    assert.equal(evidence, 3);
    console.log(
      `PASS ${country} real-role HTTP proposal/review/publication/supersession, exact terms, replay, isolation and mandatory audit/outbox`,
    );
    for (const fault of ['membership', 'session', 'nonce'])
      await blockedReplay(tenant, country, fault, body);
    for (const phase of ['replay', 'history', 'detail', 'outbox'])
      for (const fault of ['session', 'nonce', 'account'])
        await patientAuthorityWait(tenant, country, phase, fault, choices);
    for (const path of ['/v0/consent/consents', '/v0/consent/consents/revoke'])
      await expectStatus(
        await call(patient, 'POST', path, {
          consent_type: 'platform',
          evidence: { timestamp: 'caller-authored' },
        }),
        410,
        'legacy evidence route retired',
      );
    await expectStatus(
      await call(patient, 'GET', '/v0/consent/consents/me'),
      410,
      'legacy unbounded history retired',
    );
    await programAndVersionAcceptance(author, reviewer, body, choices);
    const withdrewPolicy = await expectStatus(
      await call(reviewer, 'POST', `${root}/${replacement.policy_id}/withdraw`, {
        policy_hash: replacement.content_hash,
      }),
      201,
      'operator withdraws exact policy',
    );
    assert.equal(withdrewPolicy.status, 'withdrawn');
    await expectStatus(
      await call(patient, 'GET', `${care}/terms`),
      503,
      'withdrawn policy cannot resolve',
    );
    await expectStatus(
      await call(patient, 'POST', `${care}/choices`, choices),
      503,
      'withdrawn policy cannot accept choices',
    );
    const retainedHistory = await expectStatus(
      await call(patient, 'GET', `${care}/history`),
      200,
      'withdrawal preserves patient history',
    );
    assert.equal(retainedHistory.items.length, 10);
    assert(retainedHistory.items.every((item) => item.policy_status === 'withdrawn'));
    console.log(
      `PASS ${country} operator policy withdrawal closes new decisions and retains historical patient records`,
    );
  }
  console.log(
    'PASS consent policy governance, patient choices/history/status and dedicated withdrawal acceptance. Account closure and clinical consent integration remain open in this checkpoint.',
  );
} finally {
  await app.close();
  await Promise.all([control.end(), binder.end(), ordinary.end()]);
  await closeBindActorContextPool();
  await closePool();
}
