/** Synthetic actual-role HTTP and SQL acceptance. Requires an isolated migrated DB. */
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';

import pg from 'pg';

import { bindActorContextForRequest, withActorContext } from '../src/lib/actor-context-binding.js';
import { closeBindActorContextPool, closePool } from '../src/lib/db.js';
import { asTenantId } from '../src/lib/glossary.js';
import { issueAccessToken } from '../src/lib/jwt.js';
import { withTenantContext } from '../src/lib/rls.js';
import { ulid } from '../src/lib/ulid.js';

import { verifyFormsApproverAuthority } from './verify-forms-approver-authority.js';
import { verifyFormsBoundaries } from './verify-forms-boundaries.js';
import { verifyFormsPrimitives } from './verify-forms-primitives.js';

assert.equal(process.env['NODE_ENV'], 'development');
const admin = new pg.Client({ connectionString: process.env['FORMS_MIGRATION_DATABASE_URL'] });
const ordinary = new pg.Client({ connectionString: process.env['DATABASE_URL'] });
const binder = new pg.Client({ connectionString: process.env['BIND_ACTOR_CONTEXT_DATABASE_URL'] });
await Promise.all([admin.connect(), ordinary.connect(), binder.connect()]);
const { buildApp } = await import('../src/app.js');
const app = await buildApp({ logger: false });
const proofs: string[] = [];
async function actor(
  tenant: 'Telecheck-US' | 'Telecheck-Ghana',
  role: 'patient' | 'tenant_admin' | 'clinician',
  capabilities: string[] = [],
) {
  const accountId = ulid(),
    sessionId = ulid();
  const country = tenant === 'Telecheck-US' ? 'US' : 'GH';
  await admin.query('BEGIN');
  try {
    await withTenantContext(admin, asTenantId(tenant), async () => {
      await admin.query(
        `INSERT INTO public.accounts(account_id,tenant_id,email,first_name,last_name,date_of_birth,gender,country_of_residence,country_of_care,locale,account_type,status)
    VALUES($1,$2,$3,'Synthetic','Governance','1990-01-01','prefer_not_to_say',$4,$4,$5,$6,'active')`,
        [accountId, tenant, `${randomUUID()}@example.invalid`, country, `en-${country}`, role],
      );
      await admin.query(
        `INSERT INTO public.sessions(session_id,tenant_id,account_id,refresh_token_hash,expires_at) VALUES($1,$2,$3,$4,clock_timestamp()+interval '1 hour')`,
        [sessionId, tenant, accountId, randomBytes(32).toString('hex')],
      );
      for (const capability of capabilities)
        await admin.query(
          'INSERT INTO public.forms_governance_membership(tenant_id,account_id,capability) VALUES($1,$2,$3)',
          [tenant, accountId, capability],
        );
    });
    await admin.query('COMMIT');
  } catch (error) {
    await admin.query('ROLLBACK');
    throw error;
  }
  const token = issueAccessToken(
    {
      account_id: accountId,
      tenant_id: asTenantId(tenant),
      session_id: sessionId,
      role,
      country_of_care: country,
      ...(role === 'tenant_admin' ? { admin_tenant_binding: tenant } : {}),
    },
    process.env['JWT_SIGNING_KEY']!,
  );
  return {
    accountId,
    sessionId,
    role,
    tenant,
    country,
    headers: {
      host: country === 'US' ? 'localhost' : 'ghana.localhost',
      authorization: `Bearer ${token}`,
    },
  };
}
type Actor = Awaited<ReturnType<typeof actor>>;
async function request(
  who: Actor,
  method: 'GET' | 'POST',
  url: string,
  payload?: Record<string, unknown>,
  expected = 201,
) {
  const response = await app.inject({
    method,
    url,
    headers: { ...who.headers, 'idempotency-key': randomUUID() },
    ...(payload === undefined ? {} : { payload }),
  });
  assert.equal(
    response.statusCode,
    expected,
    `${method} ${url}: ${response.statusCode} ${response.body}`,
  );
  return response.json<{
    template_id: string;
    template_version: number;
    deployment_id: string;
    schema_hash: string;
    development_only: boolean;
    artifact_id: string;
    content_hash: string;
    review_id: string;
  }>();
}
async function deniedSql(who: Actor, sql: string, params: unknown[] = [], expected = '42501') {
  const bound = await bindActorContextForRequest(binder, {
    actorAccountId: who.accountId,
    actorAccountTenantId: who.tenant,
    actorRole: who.role,
    actorAdminHomeTenantId: null,
    sessionId: who.sessionId,
  });
  await ordinary.query('BEGIN');
  try {
    await assert.rejects(
      withTenantContext(ordinary, asTenantId(who.tenant), () =>
        withActorContext(ordinary, bound.nonce, async () => {
          await ordinary.query(sql, params);
          await ordinary.query('SET CONSTRAINTS ALL IMMEDIATE');
        }),
      ),
      (error: unknown) => (error as { code?: string }).code === expected,
    );
  } finally {
    await ordinary.query('ROLLBACK');
  }
}
async function readDefinition(
  who: Actor,
  deploymentId: string,
  kind = 'general_consult',
  programId: string | null = null,
) {
  const bound = await bindActorContextForRequest(binder, {
    actorAccountId: who.accountId,
    actorAccountTenantId: who.tenant,
    actorRole: who.role,
    actorAdminHomeTenantId: null,
    sessionId: who.sessionId,
  });
  await ordinary.query('BEGIN');
  try {
    return await withTenantContext(ordinary, asTenantId(who.tenant), () =>
      withActorContext(ordinary, bound.nonce, async () => {
        const result = await ordinary.query<{ definition: { template_id: string } }>(
          'SELECT public.forms_resolve_consult_definition($1,$2,$3,$4,$5,true) AS definition',
          [who.accountId, who.sessionId, deploymentId, kind, programId],
        );
        return result.rows[0]!.definition;
      }),
    );
  } finally {
    await ordinary.query('ROLLBACK');
  }
}
async function expiredWhileBlocked(who: Actor, deploymentId: string, expiry: 'session' | 'nonce') {
  const bound = await bindActorContextForRequest(binder, {
    actorAccountId: who.accountId,
    actorAccountTenantId: who.tenant,
    actorRole: who.role,
    actorAdminHomeTenantId: null,
    sessionId: who.sessionId,
  });
  const pid = (await ordinary.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!
    .pid;
  await admin.query('BEGIN');
  await admin.query('SELECT 1 FROM public.forms_deployment WHERE deployment_id=$1 FOR UPDATE', [
    deploymentId,
  ]);
  await ordinary.query('BEGIN');
  const pending = withTenantContext(ordinary, asTenantId(who.tenant), () =>
    withActorContext(ordinary, bound.nonce, () =>
      ordinary.query(
        "SELECT public.forms_resolve_consult_definition($1,$2,$3,'general_consult',NULL,true)",
        [who.accountId, who.sessionId, deploymentId],
      ),
    ),
  ).then(
    () => 'disclosed',
    (error: unknown) => (error as { code?: string }).code,
  );
  try {
    let blocked = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      blocked =
        (
          await admin.query<{ blocked: boolean }>(
            "SELECT wait_event_type='Lock' AS blocked FROM pg_stat_activity WHERE pid=$1",
            [pid],
          )
        ).rows[0]?.blocked === true;
      if (blocked) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
      await admin.query('SELECT pg_stat_clear_snapshot()');
    }
    assert.equal(blocked, true, 'Definition query reached the locked deployment');
    if (expiry === 'session')
      await admin.query(
        "UPDATE public.sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE session_id=$1",
        [who.sessionId],
      );
    else
      await admin.query(
        "UPDATE public._session_actor_context SET expires_at=clock_timestamp()-interval '1 second' WHERE nonce=$1",
        [bound.nonce],
      );
    await admin.query('COMMIT');
    assert.equal(
      await pending,
      '42501',
      `${expiry} expiry during a lock wait must deny disclosure`,
    );
  } finally {
    await admin.query('ROLLBACK');
    await pending;
    await ordinary.query('ROLLBACK');
  }
}
const presentation = (country: string) => ({
  contract_version: 'consult_intake_v1',
  kind: 'general_consult',
  locale: `en-${country}`,
  title: 'Synthetic general consultation',
  fields: [
    {
      id: 'concern',
      type: 'text',
      label: 'What brings you here?',
      required: true,
      max_length: 4000,
    },
  ],
  elements: [],
});

async function verifyProtectedSqlSubmission(tenant: Actor['tenant']) {
  for (const wait of [
    'initial-template',
    'revision-review',
    'initial-transition',
    'revision-transition',
  ] as const) {
    for (const invalidation of ['membership', 'session', 'nonce'] as const) {
      const who = await actor(tenant, 'tenant_admin', ['operator']);
      const template = await request(who, 'POST', '/v0/forms/consult-templates', {
        program_id: ulid(),
        name: 'Synthetic SQL submission authorization',
        presentation: presentation(who.country),
        branching_logic: {},
        eligibility_logic: {},
        approval_governance: { mode: 'mode1', development_only: true },
      });
      let reviewId: string | undefined;
      if (wait.startsWith('revision-')) {
        const review = await request(
          who,
          'POST',
          `/v1/admin/templates/${template.template_id}/submit-for-review`,
          {},
        );
        reviewId = review.review_id;
        await request(
          await actor(tenant, 'tenant_admin', ['reviewer']),
          'POST',
          `/v1/admin/templates/${template.template_id}/reviews/${reviewId}/decision`,
          { decision: 'request_revision', decision_payload: {} },
        );
      }
      const persisted = async () => {
        const roots = await admin.query(
          'SELECT * FROM public.forms_template_admin_review WHERE tenant_id=$1 AND forms_template_id=$2 ORDER BY review_id',
          [tenant, template.template_id],
        );
        const transitions = await admin.query(
          `SELECT l.* FROM public.forms_template_admin_review_lifecycle_transition l
           JOIN public.forms_template_admin_review r ON r.tenant_id=l.tenant_id AND r.review_id=l.review_id
           WHERE r.tenant_id=$1 AND r.forms_template_id=$2 ORDER BY l.id`,
          [tenant, template.template_id],
        );
        return { roots: roots.rows, transitions: transitions.rows };
      };
      const before = await persisted();
      const bound = await bindActorContextForRequest(binder, {
        actorAccountId: who.accountId,
        actorAccountTenantId: tenant,
        actorRole: who.role,
        actorAdminHomeTenantId: null,
        sessionId: who.sessionId,
      });
      const pid = (await ordinary.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!
        .pid;
      await admin.query('BEGIN');
      if (wait === 'initial-template')
        await admin.query('SELECT 1 FROM public.forms_template WHERE template_id=$1 FOR UPDATE', [
          template.template_id,
        ]);
      else if (wait === 'revision-review')
        await admin.query(
          'SELECT 1 FROM public.forms_template_admin_review WHERE review_id=$1 FOR UPDATE',
          [reviewId],
        );
      else
        await admin.query(
          'LOCK TABLE public.forms_template_admin_review_lifecycle_transition IN SHARE MODE',
        );
      await ordinary.query('BEGIN');
      await ordinary.query('SELECT public.set_tenant_context($1)', [tenant]);
      await ordinary.query("SELECT set_config('app.request_nonce',$1,true)", [bound.nonce]);
      await ordinary.query('SET LOCAL ROLE admin_basic_operator');
      const pending = ordinary
        .query('SELECT public.submit_forms_template_for_admin_review($1,$2)', [
          tenant,
          template.template_id,
        ])
        .then(
          () => 'accepted',
          (error: unknown) => (error as { code?: string }).code,
        );
      try {
        let blocked = false;
        for (let attempt = 0; attempt < 200; attempt++) {
          await admin.query('SELECT pg_stat_clear_snapshot()');
          blocked =
            (
              await admin.query<{ blocked: boolean }>(
                "SELECT wait_event_type='Lock' AS blocked FROM pg_stat_activity WHERE pid=$1",
                [pid],
              )
            ).rows[0]?.blocked === true;
          if (blocked) break;
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        assert.equal(blocked, true, `${wait}: submission SQL reached the held lock`);
        if (invalidation === 'membership')
          await admin.query(
            "UPDATE public.forms_governance_membership SET revoked_at=clock_timestamp() WHERE tenant_id=$1 AND account_id=$2 AND capability='operator'",
            [tenant, who.accountId],
          );
        else if (invalidation === 'session')
          await admin.query(
            "UPDATE public.sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE session_id=$1",
            [who.sessionId],
          );
        else
          await admin.query(
            "UPDATE public._session_actor_context SET expires_at=clock_timestamp()-interval '1 second' WHERE nonce=$1",
            [bound.nonce],
          );
        await admin.query('COMMIT');
        const result = await pending;
        const commit = await ordinary.query('COMMIT');
        assert.equal(result, '42501', `${tenant} ${wait}: ${invalidation} must deny SQL success`);
        assert.equal(commit.command, 'ROLLBACK', 'SQL denial aborts the submission transaction');
        assert.deepEqual(await persisted(), before, 'No review root or lifecycle write survives');
      } finally {
        await admin.query('ROLLBACK');
        await pending;
        await ordinary.query('ROLLBACK');
      }
    }
  }
}

async function verifyProtectedReplay(tenant: Actor['tenant']) {
  for (const family of [
    'consult-create',
    'legacy-publish',
    'si023-submit',
    'si023-decision',
  ] as const) {
    for (const invalidation of ['membership', 'session', 'nonce'] as const) {
      const author = await actor(tenant, 'tenant_admin', ['operator']);
      const isReview = family === 'legacy-publish' || family === 'si023-decision';
      const who = isReview ? await actor(tenant, 'tenant_admin', ['reviewer']) : author;
      const body = {
        program_id: ulid(),
        name: 'Synthetic replay authorization',
        presentation: presentation(author.country),
        branching_logic: {},
        eligibility_logic: {},
        approval_governance: { mode: 'mode1', development_only: true },
      };
      let url = '/v0/forms/consult-templates';
      let payload: Record<string, unknown> = body;
      if (family !== 'consult-create') {
        const template = await request(author, 'POST', url, body);
        if (family === 'legacy-publish')
          url = `/v0/forms/templates/${template.template_id}/versions/${template.template_id}/publish`;
        else if (family === 'si023-submit')
          url = `/v1/admin/templates/${template.template_id}/submit-for-review`;
        else {
          const review = await request(
            author,
            'POST',
            `/v1/admin/templates/${template.template_id}/submit-for-review`,
            {},
          );
          url = `/v1/admin/templates/${template.template_id}/reviews/${review.review_id}/decision`;
        }
        payload = family === 'si023-decision' ? { decision: 'approve', decision_payload: {} } : {};
      }
      const options = {
        method: 'POST' as const,
        url,
        headers: { ...who.headers, 'idempotency-key': randomUUID() },
        payload,
      };
      const original = await app.inject(options);
      assert.equal(original.statusCode, family === 'legacy-publish' ? 200 : 201, original.body);
      const authorizedReplay = await app.inject(options);
      assert.equal(authorizedReplay.statusCode, original.statusCode);
      assert.deepEqual(authorizedReplay.json(), original.json());
      await admin.query('BEGIN');
      // The preHandler SELECT and early capability check can finish, while the
      // reservation DELETE waits. This reproduces the independent review's race.
      await admin.query('LOCK TABLE public.idempotency_keys IN SHARE MODE');
      const pending = app.inject(options);
      const response = pending.then((result) => result);
      try {
        let blocked = false;
        for (let attempt = 0; attempt < 500; attempt++) {
          await admin.query('SELECT pg_stat_clear_snapshot()');
          blocked =
            (
              await admin.query(
                "SELECT 1 FROM pg_stat_activity WHERE usename='telecheck_app_role' AND wait_event_type='Lock' AND query LIKE 'DELETE FROM idempotency_keys%' LIMIT 1",
              )
            ).rowCount === 1;
          if (blocked) break;
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        assert.equal(blocked, true, `${family} replay reached the reservation wait`);
        if (invalidation === 'membership')
          await admin.query(
            'UPDATE public.forms_governance_membership SET revoked_at=clock_timestamp() WHERE tenant_id=$1 AND account_id=$2 AND capability=$3',
            [tenant, who.accountId, isReview ? 'reviewer' : 'operator'],
          );
        else if (invalidation === 'session')
          await admin.query(
            "UPDATE public.sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE session_id=$1",
            [who.sessionId],
          );
        else
          await admin.query(
            "UPDATE public._session_actor_context SET expires_at=clock_timestamp()-interval '1 second' WHERE actor_account_id=$1",
            [who.accountId],
          );
        await admin.query('COMMIT');
        const denied = await response;
        assert.equal(
          denied.statusCode,
          403,
          `${tenant}/${family}/${invalidation} replay: ${denied.body}`,
        );
        assert.notDeepEqual(denied.json(), original.json());
      } finally {
        await admin.query('ROLLBACK');
        await response;
      }
    }
  }

  // Fresh success must also recheck after audit/outbox and cache completion.
  const author = await actor(tenant, 'tenant_admin', ['operator']);
  const program = ulid();
  await admin.query('BEGIN');
  await admin.query('LOCK TABLE public.domain_events_outbox IN SHARE MODE');
  const response = app
    .inject({
      method: 'POST',
      url: '/v0/forms/consult-templates',
      headers: { ...author.headers, 'idempotency-key': randomUUID() },
      payload: {
        program_id: program,
        name: 'Synthetic outbox wait',
        presentation: presentation(author.country),
        branching_logic: {},
        eligibility_logic: {},
        approval_governance: { mode: 'mode1', development_only: true },
      },
    })
    .then((result) => result);
  try {
    let blocked = false;
    for (let attempt = 0; attempt < 500; attempt++) {
      await admin.query('SELECT pg_stat_clear_snapshot()');
      blocked =
        (
          await admin.query(
            "SELECT 1 FROM pg_stat_activity WHERE usename='telecheck_app_role' AND wait_event_type='Lock' AND query LIKE '%INSERT INTO domain_events_outbox%' LIMIT 1",
          )
        ).rowCount === 1;
      if (blocked) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(blocked, true, 'Fresh mutation reached its outbox write');
    await admin.query(
      "UPDATE public.forms_governance_membership SET revoked_at=clock_timestamp() WHERE tenant_id=$1 AND account_id=$2 AND capability='operator'",
      [tenant, author.accountId],
    );
    await admin.query('COMMIT');
    const denied = await response;
    assert.equal(denied.statusCode, 403, denied.body);
    assert.equal(
      (
        await admin.query(
          'SELECT 1 FROM public.forms_template WHERE tenant_id=$1 AND program_id=$2',
          [tenant, program],
        )
      ).rowCount,
      0,
      'Lost authorization rolls back the fresh business mutation',
    );
  } finally {
    await admin.query('ROLLBACK');
    await response;
  }
}
try {
  const role = (
    await ordinary.query<{ rolsuper: boolean; rolbypassrls: boolean; rolinherit: boolean }>(
      'SELECT rolsuper,rolbypassrls,rolinherit FROM pg_roles WHERE rolname=session_user',
    )
  ).rows[0];
  assert.deepEqual(role, { rolsuper: false, rolbypassrls: false, rolinherit: false });
  const unsafeOwners = await admin.query<{
    count: number;
  }>(`SELECT count(*)::INTEGER AS count FROM pg_proc p JOIN pg_roles r ON r.oid=p.proowner
    WHERE p.proname IN ('forms_live_actor','forms_enforce_publication','forms_authorize_operation','forms_create_consult_template','forms_publish_template','forms_deploy_consult_template','forms_retire_consult_deployment','forms_resolve_consult_definition','forms_submit_governance_artifact','forms_review_governance_artifact','forms_read_governance_artifact','forms_publication_receipt','forms_require_publication_evidence','forms_admin_submission_receipt')
    AND p.prosecdef AND (r.rolsuper OR r.rolbypassrls OR r.rolinherit OR r.rolcanlogin)`);
  assert.equal(
    unsafeOwners.rows[0]!.count,
    0,
    'Forms security-definer owners are isolated NOLOGIN/NOBYPASSRLS roles',
  );
  for (const tenant of ['Telecheck-US', 'Telecheck-Ghana'] as const) {
    const author = await actor(tenant, 'tenant_admin', ['operator']);
    const reviewer = await actor(tenant, 'clinician', ['reviewer', 'clinical_reviewer']);
    const adminReviewer = await actor(tenant, 'tenant_admin', ['reviewer']);
    const contentReviewer = await actor(tenant, 'tenant_admin', [
      'marketing_reviewer',
      'mode2_reviewer',
    ]);
    const patient = await actor(tenant, 'patient');
    const program = ulid();
    const body = {
      program_id: program,
      name: 'Synthetic development template',
      presentation: presentation(author.country),
      branching_logic: {},
      eligibility_logic: {},
      approval_governance: { mode: 'mode1', development_only: true },
    };
    const created = await request(author, 'POST', '/v0/forms/consult-templates', body);
    await request(
      author,
      'POST',
      `/v0/forms/consult-templates/${created.template_id}/publish`,
      {},
      403,
    );
    await request(
      patient,
      'POST',
      `/v0/forms/consult-templates/${created.template_id}/publish`,
      {},
      403,
    );
    await deniedSql(
      patient,
      "UPDATE public.forms_template SET status='published' WHERE template_id=$1",
      [created.template_id],
    );
    await deniedSql(
      reviewer,
      'SELECT public.forms_publish_template($1)',
      [created.template_id],
      '23514',
    );
    await request(
      reviewer,
      'POST',
      `/v0/forms/consult-templates/${created.template_id}/publish`,
      {},
    );
    const deployment = await request(
      author,
      'POST',
      `/v0/forms/consult-templates/${created.template_id}/deploy`,
      {},
    );
    const definition = await request(
      patient,
      'GET',
      '/v0/forms/consult-definitions?kind=general_consult',
      undefined,
      200,
    );
    assert.equal(definition.template_id, created.template_id);
    assert.equal(definition.deployment_id, deployment.deployment_id);
    assert.equal(definition.schema_hash, created.schema_hash);
    assert.equal(definition.development_only, true);
    await deniedSql(patient, 'SELECT * FROM public.forms_governance_artifact');
    await deniedSql(patient, 'SET LOCAL ROLE forms_publication_owner');
    await deniedSql(
      reviewer,
      'SELECT public.forms_publish_template($1)',
      [created.template_id],
      '22023',
    );
    const bad = await request(author, 'POST', '/v0/forms/consult-templates', {
      ...body,
      branching_logic: { rules: [{ field: 'research_consent_status' }] },
    });
    await request(
      reviewer,
      'POST',
      `/v0/forms/consult-templates/${bad.template_id}/publish`,
      {},
      400,
    );
    const clinical = await request(author, 'POST', '/v0/forms/consult-templates', {
      ...body,
      presentation: { ...body.presentation, kind: 'program' },
      eligibility_logic: {
        eligibility_rules: [
          {
            field_id: 'concern',
            operator: 'equals',
            value: 'review',
            outcome: 'clinical_review_required',
          },
        ],
        contraindications: [],
      },
    });
    await request(
      reviewer,
      'POST',
      `/v0/forms/consult-templates/${clinical.template_id}/publish`,
      {},
      400,
    );
    const artifact = await request(author, 'POST', '/v0/forms/governance/artifacts', {
      kind: 'clinical_review',
      template_id: clinical.template_id,
      content: {},
      development_only: true,
    });
    const fetched = await request(
      reviewer,
      'GET',
      `/v0/forms/governance/artifacts/${artifact.artifact_id}`,
      undefined,
      200,
    );
    assert.equal(fetched.content_hash, clinical.schema_hash);
    await request(
      author,
      'POST',
      `/v0/forms/governance/artifacts/${artifact.artifact_id}/decision`,
      { content_hash: artifact.content_hash, decision: 'approved' },
      403,
    );
    await request(
      reviewer,
      'POST',
      `/v0/forms/governance/artifacts/${artifact.artifact_id}/decision`,
      { content_hash: '0'.repeat(64), decision: 'approved' },
      400,
    );
    await request(
      reviewer,
      'POST',
      `/v0/forms/governance/artifacts/${artifact.artifact_id}/decision`,
      { content_hash: artifact.content_hash, decision: 'approved' },
    );
    await request(
      reviewer,
      'POST',
      `/v0/forms/consult-templates/${clinical.template_id}/publish`,
      {},
    );
    const stale = await request(author, 'POST', '/v0/forms/consult-templates', {
      ...body,
      program_id: ulid(),
      presentation: { ...body.presentation, kind: 'program' },
      eligibility_logic: {
        eligibility_rules: [
          {
            field_id: 'concern',
            operator: 'equals',
            value: 'review',
            outcome: 'clinical_review_required',
          },
        ],
        contraindications: [],
      },
    });
    const staleArtifact = await request(author, 'POST', '/v0/forms/governance/artifacts', {
      kind: 'clinical_review',
      template_id: stale.template_id,
      content: {},
      development_only: true,
    });
    await request(
      reviewer,
      'POST',
      `/v0/forms/governance/artifacts/${staleArtifact.artifact_id}/decision`,
      { content_hash: staleArtifact.content_hash, decision: 'approved' },
    );
    await admin.query(
      "UPDATE public.forms_template SET presentation_content=jsonb_set(presentation_content,'{title}','\"Changed synthetic title\"') WHERE template_id=$1",
      [stale.template_id],
    );
    await request(
      reviewer,
      'POST',
      `/v0/forms/consult-templates/${stale.template_id}/publish`,
      {},
      400,
    );
    const marketing = await request(author, 'POST', '/v0/forms/governance/artifacts', {
      kind: 'marketing_copy',
      content: {
        text: 'Synthetic review-only copy.',
        molecule_id: 'synthetic-molecule',
        country_of_care: author.country,
      },
      development_only: true,
    });
    const marketingBody = {
      ...body,
      program_id: ulid(),
      presentation: {
        ...body.presentation,
        kind: 'program',
        elements: [
          {
            copy_classification: 'molecule_level',
            marketing_copy_id: marketing.artifact_id,
            content_hash: marketing.content_hash,
          },
        ],
      },
    };
    const marketingTemplate = await request(
      author,
      'POST',
      '/v0/forms/consult-templates',
      marketingBody,
    );
    await request(
      reviewer,
      'POST',
      `/v0/forms/consult-templates/${marketingTemplate.template_id}/publish`,
      {},
      400,
    );
    await request(
      contentReviewer,
      'POST',
      `/v0/forms/governance/artifacts/${marketing.artifact_id}/decision`,
      { content_hash: marketing.content_hash, decision: 'approved' },
    );
    await request(
      reviewer,
      'POST',
      `/v0/forms/consult-templates/${marketingTemplate.template_id}/publish`,
      {},
    );
    const wrongCopyHash = await request(author, 'POST', '/v0/forms/consult-templates', {
      ...marketingBody,
      presentation: {
        ...marketingBody.presentation,
        elements: [{ ...marketingBody.presentation.elements[0], content_hash: '0'.repeat(64) }],
      },
    });
    await request(
      reviewer,
      'POST',
      `/v0/forms/consult-templates/${wrongCopyHash.template_id}/publish`,
      {},
      400,
    );
    const contract = await request(author, 'POST', '/v0/forms/governance/artifacts', {
      kind: 'mode2_contract',
      content: { fields: [{ id: 'concern', type: 'text', required: true }] },
      development_only: true,
    });
    const mode2Body = {
      ...body,
      program_id: ulid(),
      presentation: { ...body.presentation, kind: 'program' },
      approval_governance: {
        mode: 'mode2',
        development_only: true,
        mode2_contract_id: contract.artifact_id,
        mode2_contract_hash: contract.content_hash,
      },
    };
    const mode2 = await request(author, 'POST', '/v0/forms/consult-templates', mode2Body);
    await request(
      reviewer,
      'POST',
      `/v0/forms/consult-templates/${mode2.template_id}/publish`,
      {},
      400,
    );
    await request(
      contentReviewer,
      'POST',
      `/v0/forms/governance/artifacts/${contract.artifact_id}/decision`,
      { content_hash: contract.content_hash, decision: 'approved' },
    );
    await request(reviewer, 'POST', `/v0/forms/consult-templates/${mode2.template_id}/publish`, {});
    const mode2Mismatch = await request(author, 'POST', '/v0/forms/consult-templates', {
      ...mode2Body,
      presentation: {
        ...mode2Body.presentation,
        fields: [{ ...mode2Body.presentation.fields[0], required: false }],
      },
    });
    await request(
      reviewer,
      'POST',
      `/v0/forms/consult-templates/${mode2Mismatch.template_id}/publish`,
      {},
      400,
    );
    await admin.query(
      "UPDATE public.accounts SET account_type='patient' WHERE tenant_id=$1 AND account_id=$2",
      [tenant, contentReviewer.accountId],
    );
    try {
      for (const source of [marketingBody, mode2Body]) {
        for (const path of ['direct', 'si023']) {
          const unqualified = await request(author, 'POST', '/v0/forms/consult-templates', {
            ...source,
            program_id: ulid(),
          });
          if (path === 'direct')
            await request(
              reviewer,
              'POST',
              `/v0/forms/consult-templates/${unqualified.template_id}/publish`,
              {},
              400,
            );
          else {
            const review = await request(
              author,
              'POST',
              `/v1/admin/templates/${unqualified.template_id}/submit-for-review`,
              {},
            );
            await request(
              adminReviewer,
              'POST',
              `/v1/admin/templates/${unqualified.template_id}/reviews/${review.review_id}/decision`,
              { decision: 'approve', decision_payload: {} },
              400,
            );
          }
          assert.equal(
            (
              await admin.query(
                "SELECT 1 FROM public.forms_template WHERE template_id=$1 AND status='draft'",
                [unqualified.template_id],
              )
            ).rowCount,
            1,
          );
        }
      }
    } finally {
      await admin.query(
        "UPDATE public.accounts SET account_type='tenant_admin' WHERE tenant_id=$1 AND account_id=$2",
        [tenant, contentReviewer.accountId],
      );
    }
    // The SI-023 route must traverse the same publication and evidence gate.
    const adminTemplate = await request(author, 'POST', '/v0/forms/consult-templates', {
      ...body,
      program_id: ulid(),
    });
    const adminReview = await request(
      author,
      'POST',
      `/v1/admin/templates/${adminTemplate.template_id}/submit-for-review`,
      {},
    );
    await request(
      adminReviewer,
      'POST',
      `/v1/admin/templates/${adminTemplate.template_id}/reviews/${adminReview.review_id}/decision`,
      { decision: 'approve', decision_payload: {} },
    );
    const legacyTemplate = await request(author, 'POST', '/v0/forms/consult-templates', {
      ...body,
      program_id: ulid(),
    });
    await request(
      adminReviewer,
      'POST',
      `/v0/forms/templates/${legacyTemplate.template_id}/versions/${legacyTemplate.template_id}/publish`,
      {},
      200,
    );
    const legacyInvalid = await request(author, 'POST', '/v0/forms/consult-templates', {
      ...body,
      program_id: ulid(),
      branching_logic: { pricing_rule: 'unsupported' },
    });
    await request(
      adminReviewer,
      'POST',
      `/v0/forms/templates/${legacyInvalid.template_id}/versions/${legacyInvalid.template_id}/publish`,
      {},
      400,
    );
    const blockedTemplate = await request(author, 'POST', '/v0/forms/consult-templates', {
      ...body,
      program_id: ulid(),
      branching_logic: { rules: [{ source: 'research_consent_status' }] },
    });
    const blockedReview = await request(
      author,
      'POST',
      `/v1/admin/templates/${blockedTemplate.template_id}/submit-for-review`,
      {},
    );
    await request(
      adminReviewer,
      'POST',
      `/v1/admin/templates/${blockedTemplate.template_id}/reviews/${blockedReview.review_id}/decision`,
      { decision: 'approve', decision_payload: {} },
      400,
    );
    const replayKey = randomUUID();
    const replayOptions = {
      method: 'POST' as const,
      url: `/v0/forms/consult-templates/${adminTemplate.template_id}/deploy`,
      headers: { ...author.headers, 'idempotency-key': replayKey },
      payload: {},
    };
    assert.equal((await app.inject(replayOptions)).statusCode, 201);
    await admin.query(
      "UPDATE public.forms_governance_membership SET revoked_at=clock_timestamp() WHERE tenant_id=$1 AND account_id=$2 AND capability='operator'",
      [tenant, author.accountId],
    );
    assert.equal((await app.inject(replayOptions)).statusCode, 403);
    await admin.query(
      "UPDATE public.forms_governance_membership SET revoked_at=NULL WHERE tenant_id=$1 AND account_id=$2 AND capability='operator'",
      [tenant, author.accountId],
    );
    assert.equal(
      (await readDefinition(patient, deployment.deployment_id)).template_id,
      created.template_id,
      'Superseded versions remain pinned until explicit retirement',
    );
    const foreign = await actor(
      tenant === 'Telecheck-US' ? 'Telecheck-Ghana' : 'Telecheck-US',
      'patient',
    );
    await deniedSql(
      foreign,
      "SELECT public.forms_resolve_consult_definition($1,$2,$3,'general_consult',NULL,true)",
      [foreign.accountId, foreign.sessionId, deployment.deployment_id],
      '02000',
    );
    await expiredWhileBlocked(await actor(tenant, 'patient'), deployment.deployment_id, 'session');
    await expiredWhileBlocked(await actor(tenant, 'patient'), deployment.deployment_id, 'nonce');
    await request(
      author,
      'POST',
      `/v0/forms/consult-deployments/${deployment.deployment_id}/retire`,
      {},
    );
    await deniedSql(
      patient,
      "SELECT public.forms_resolve_consult_definition($1,$2,$3,'general_consult',NULL,true)",
      [patient.accountId, patient.sessionId, deployment.deployment_id],
      '02000',
    );
    await admin.query(
      "UPDATE public.sessions SET revoked_at=clock_timestamp(),revoked_reason='admin_revoked' WHERE session_id=$1",
      [patient.sessionId],
    );
    await request(
      patient,
      'GET',
      '/v0/forms/consult-definitions?kind=general_consult',
      undefined,
      403,
    );
    await verifyProtectedReplay(tenant);
    await verifyProtectedSqlSubmission(tenant);
    await verifyFormsBoundaries({ admin, ordinary, binder, app, actor, request }, tenant);
    await verifyFormsApproverAuthority({ admin, ordinary, binder, app, actor, request }, tenant);
    await verifyFormsPrimitives({ admin, ordinary, binder, app, actor, request }, tenant);
    proofs.push(
      `${tenant}: real-role create/publish/deploy/resolve; operator/reviewer separation; app SQL/owner denial; missing evidence rollback; research gate; independent exact-hash clinical review and stale hash rejection; approved marketing copy and Mode2 contract matching; current staff role required for both content approvals and publication paths; SI023 shared gate; all four handler families deny membership/session/nonce invalidation during blocked cached replay; fresh mutation rolls back after outbox-wait revocation; 12 direct SQL submission cases deny membership/session/nonce invalidation across template/review/initial-transition/revision-transition waits and retain no writes; immutable superseded pin; cross-tenant denial; session/nonce expiry during a blocked read; emergency retirement; revoked session`,
    );
  }
  console.log(JSON.stringify({ passed: true, proofs }, null, 2));
} finally {
  await app.close();
  await Promise.all([closePool(), closeBindActorContextPool()]);
  await Promise.all([admin.end(), ordinary.end(), binder.end()]);
}
