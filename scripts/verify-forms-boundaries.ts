/** Checked-in actual-role regressions for every Forms SQL return boundary. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import type { FastifyInstance } from 'fastify';
import type pg from 'pg';

import { bindActorContextForRequest } from '../src/lib/actor-context-binding.js';
import { ulid } from '../src/lib/ulid.js';
import { ConsultPresentationSchema } from '../src/modules/forms-intake/internal/services/consult-definition.js';
import { presentationTextBoundaries } from '../tests/helpers/forms-presentation-boundaries.js';

type Actor = {
  tenant: 'Telecheck-US' | 'Telecheck-Ghana';
  role: 'patient' | 'tenant_admin' | 'clinician';
  country: string;
  accountId: string;
  sessionId: string;
  headers: { host: string; authorization: string };
};
type Receipt = {
  template_id: string;
  deployment_id: string;
  artifact_id: string;
  content_hash: string;
  review_id: string;
};
export type FormsAcceptanceContext = {
  admin: pg.Client;
  ordinary: pg.Client;
  binder: pg.Client;
  app: FastifyInstance;
  actor: (tenant: Actor['tenant'], role: Actor['role'], capabilities?: string[]) => Promise<Actor>;
  request: (
    who: Actor,
    method: 'GET' | 'POST',
    url: string,
    payload?: Record<string, unknown>,
    expected?: number,
  ) => Promise<Receipt>;
};

export async function verifyFormsBoundaries(ctx: FormsAcceptanceContext, tenant: Actor['tenant']) {
  const { admin, ordinary, binder, app, actor, request } = ctx;
  const country = tenant === 'Telecheck-US' ? 'US' : 'GH';
  const body = (program = ulid()) => ({
    program_id: program,
    name: 'Synthetic boundary validation',
    presentation: {
      contract_version: 'consult_intake_v1',
      kind: 'program',
      locale: `en-${country}`,
      title: 'Synthetic consultation',
      fields: [{ id: 'concern', type: 'text', label: 'Concern', required: true, max_length: 4000 }],
      elements: [],
    },
    branching_logic: {},
    eligibility_logic: {},
    approval_governance: { mode: 'mode1', development_only: true },
  });
  const draft = (who: Actor, program?: string) =>
    request(who, 'POST', '/v0/forms/consult-templates', body(program));
  const bind = async (who: Actor, role?: 'admin_template_reviewer') => {
    const bound = await bindActorContextForRequest(binder, {
      actorAccountId: who.accountId,
      actorAccountTenantId: tenant,
      actorRole: who.role,
      actorAdminHomeTenantId: null,
      sessionId: who.sessionId,
    });
    await ordinary.query('BEGIN');
    await ordinary.query('SET LOCAL statement_timeout=15000');
    await ordinary.query('SELECT public.set_tenant_context($1)', [tenant]);
    await ordinary.query("SELECT set_config('app.request_nonce',$1,true)", [bound.nonce]);
    if (role) await ordinary.query('SET LOCAL ROLE admin_template_reviewer');
    return bound;
  };
  const snapshot = async () => {
    const rows: unknown[] = [];
    // Only fixed fixture table names, never caller-controlled SQL identifiers.
    for (const table of [
      'forms_template',
      'forms_deployment',
      'forms_governance_artifact',
      'forms_published_definition',
      'forms_template_admin_review',
      'forms_template_admin_review_lifecycle_transition',
      'admin_template_decision_idempotency_key',
    ]) {
      rows.push(
        (
          await admin.query<{ rows: unknown }>(
            `SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY to_jsonb(r)::text),'[]') AS rows FROM public.${table} r WHERE tenant_id=$1`,
            [tenant],
          )
        ).rows[0],
      );
    }
    return rows;
  };
  const blockedByFixture = async (pid: number) => {
    for (let attempt = 0; attempt < 300; attempt++) {
      await admin.query('SELECT pg_stat_clear_snapshot()');
      const result = await admin.query<{ blocked: boolean }>(
        "SELECT wait_event_type='Lock' AND $2=ANY(pg_blocking_pids(pid)) AS blocked FROM pg_stat_activity WHERE pid=$1",
        [pid, (await admin.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid],
      );
      if (result.rows[0]?.blocked) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.fail('SQL operation did not reach the fixture-held lock');
  };

  for (const family of [
    'create',
    'artifact-marketing',
    'artifact-mode2',
    'artifact-clinical',
    'deploy',
    'retire',
    'review-marketing',
    'review-mode2',
    'review-clinical',
    'decision-fresh',
    'decision-replay',
    'publication-receipt',
    'submission-receipt',
    'artifact-read',
    'authorize-review',
    'publish-template',
    'publish-snapshot',
    'authorize-create',
    'authorize-publish',
  ]) {
    for (const invalidation of ['membership', 'session', 'nonce']) {
      const capability =
        family === 'review-clinical'
          ? 'clinical_reviewer'
          : family === 'review-mode2'
            ? 'mode2_reviewer'
            : family === 'review-marketing' ||
                family === 'artifact-read' ||
                family === 'authorize-review'
              ? 'marketing_reviewer'
              : family === 'authorize-publish' ||
                  family.startsWith('decision-') ||
                  family.startsWith('publish-') ||
                  family === 'publication-receipt'
                ? 'reviewer'
                : 'operator';
      const who = await actor(
        tenant,
        capability === 'clinical_reviewer' ? 'clinician' : 'tenant_admin',
        [capability],
      );
      const author =
        capability === 'operator' ? who : await actor(tenant, 'tenant_admin', ['operator']);
      let sql = '',
        params: unknown[] = [],
        lock = '',
        lockParams: unknown[] = [];
      if (family === 'authorize-create' || family === 'authorize-publish') {
        sql = 'SELECT public.forms_authorize_operation($1,NULL,$2,$3)';
        params = [
          family === 'authorize-create'
            ? 'forms.consult_template.created'
            : 'forms.publication.checked',
          who.accountId,
          who.sessionId,
        ];
        lock = 'LOCK TABLE public.forms_governance_membership IN ACCESS EXCLUSIVE MODE';
      } else if (family === 'create') {
        const value = body();
        sql = 'SELECT public.forms_create_consult_template($1,$2,$3,$4,$5,$6,$7)';
        params = [
          ulid(),
          value.program_id,
          value.name,
          value.presentation,
          {},
          {},
          value.approval_governance,
        ];
        lock = 'LOCK TABLE public.forms_template IN SHARE MODE';
      } else if (family.startsWith('artifact-') && family !== 'artifact-read') {
        const kind =
          family === 'artifact-clinical'
            ? 'clinical_review'
            : family === 'artifact-mode2'
              ? 'mode2_contract'
              : 'marketing_copy';
        const target = kind === 'clinical_review' ? await draft(author) : null;
        const content =
          kind === 'marketing_copy'
            ? {
                text: 'Synthetic approved copy',
                molecule_id: 'synthetic',
                country_of_care: country,
              }
            : kind === 'mode2_contract'
              ? { fields: [{ id: 'concern', type: 'text', required: true }] }
              : {};
        sql = 'SELECT public.forms_submit_governance_artifact($1,$2,$3,true)';
        params = [kind, target?.template_id ?? null, content];
        lock = 'LOCK TABLE public.forms_governance_artifact IN SHARE MODE';
      } else if (
        family.startsWith('review-') ||
        family === 'artifact-read' ||
        family === 'authorize-review'
      ) {
        const kind =
          family === 'review-clinical'
            ? 'clinical_review'
            : family === 'review-mode2'
              ? 'mode2_contract'
              : 'marketing_copy';
        const target = kind === 'clinical_review' ? await draft(author) : null;
        const submitted = await request(author, 'POST', '/v0/forms/governance/artifacts', {
          kind,
          ...(target ? { template_id: target.template_id } : {}),
          development_only: true,
          content:
            kind === 'marketing_copy'
              ? {
                  text: 'Synthetic approved copy',
                  molecule_id: 'synthetic',
                  country_of_care: country,
                }
              : kind === 'mode2_contract'
                ? { fields: [{ id: 'concern', type: 'text', required: true }] }
                : {},
        });
        if (family === 'artifact-read') {
          sql = 'SELECT public.forms_read_governance_artifact($1)';
          params = [submitted.artifact_id];
        } else if (family === 'authorize-review') {
          sql = "SELECT public.forms_authorize_operation('forms.governance.reviewed',$1,$2,$3)";
          params = [submitted.artifact_id, who.accountId, who.sessionId];
        } else {
          sql = "SELECT public.forms_review_governance_artifact($1,$2,'approved')";
          params = [submitted.artifact_id, submitted.content_hash];
        }
        lock = family.startsWith('review-')
          ? 'LOCK TABLE public.forms_governance_artifact IN SHARE MODE'
          : 'LOCK TABLE public.forms_governance_artifact IN ACCESS EXCLUSIVE MODE';
      } else {
        const target = await draft(author);
        if (family.startsWith('decision-') || family === 'submission-receipt') {
          const review = await request(
            author,
            'POST',
            `/v1/admin/templates/${target.template_id}/submit-for-review`,
            {},
          );
          const key = randomUUID();
          if (family === 'submission-receipt') {
            sql = 'SELECT public.forms_admin_submission_receipt($1)';
            params = [review.review_id];
            lock =
              'LOCK TABLE public.forms_template_admin_review_lifecycle_transition IN ACCESS EXCLUSIVE MODE';
          } else {
            if (family === 'decision-replay') {
              const response = await app.inject({
                method: 'POST',
                url: `/v1/admin/templates/${target.template_id}/reviews/${review.review_id}/decision`,
                headers: { ...who.headers, 'idempotency-key': key },
                payload: { decision: 'reject', decision_payload: {} },
              });
              assert.equal(response.statusCode, 201, response.body);
              lock = 'SELECT 1 FROM public.forms_template WHERE template_id=$1 FOR UPDATE';
              lockParams = [target.template_id];
            } else lock = 'LOCK TABLE public.admin_template_decision_idempotency_key IN SHARE MODE';
            sql =
              "SELECT public.record_forms_template_admin_decision($1,$2,'reject','{}'::jsonb,$3)";
            params = [tenant, review.review_id, key];
          }
        } else if (family.startsWith('publish-')) {
          sql = 'SELECT public.forms_publish_template($1)';
          params = [target.template_id];
          lock =
            family === 'publish-template'
              ? 'LOCK TABLE public.forms_template IN SHARE MODE'
              : 'LOCK TABLE public.forms_published_definition IN SHARE MODE';
        } else {
          await request(
            await actor(tenant, 'tenant_admin', ['reviewer']),
            'POST',
            `/v0/forms/consult-templates/${target.template_id}/publish`,
            {},
          );
          if (family === 'publication-receipt') {
            sql = 'SELECT public.forms_publication_receipt($1)';
            params = [target.template_id];
            lock = 'LOCK TABLE public.forms_published_definition IN ACCESS EXCLUSIVE MODE';
          } else {
            lock = 'LOCK TABLE public.forms_deployment IN SHARE MODE';
            if (family === 'retire') {
              const deployed = await request(
                author,
                'POST',
                `/v0/forms/consult-templates/${target.template_id}/deploy`,
                {},
              );
              sql = 'SELECT public.forms_retire_consult_deployment($1)';
              params = [deployed.deployment_id];
            } else {
              sql = 'SELECT public.forms_deploy_consult_template($1,$2)';
              params = [target.template_id, ulid()];
            }
          }
        }
      }
      const before = await snapshot();
      const bound = await bind(
        who,
        family.startsWith('decision-') ? 'admin_template_reviewer' : undefined,
      );
      const pid = (await ordinary.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!
        .pid;
      await admin.query('BEGIN');
      await admin.query(lock, lockParams);
      const pending = ordinary.query(sql, params).then(
        (result) => ({ code: 'accepted', rows: result.rows }),
        (error: unknown) => ({ code: (error as { code?: string }).code, rows: [] }),
      );
      try {
        await blockedByFixture(pid);
        if (invalidation === 'membership')
          await admin.query(
            'UPDATE public.forms_governance_membership SET revoked_at=clock_timestamp() WHERE tenant_id=$1 AND account_id=$2 AND capability=$3',
            [tenant, who.accountId, capability],
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
        assert.equal(
          result.code,
          '42501',
          `${tenant}/${family}/${invalidation}: no SQL success after authority loss`,
        );
        assert.deepEqual(result.rows, [], 'No receipt or replay result returned');
        assert.equal(commit.command, 'ROLLBACK');
        assert.deepEqual(
          await snapshot(),
          before,
          'No Forms write survived, including earlier lifecycle work',
        );
      } finally {
        await admin.query('ROLLBACK');
        await pending;
        await ordinary.query('ROLLBACK');
      }
    }
  }

  // Deleted drafts cannot remove a working deployed version, including deletion
  // committed while the direct/SI-023 operation waits for its serialization lock.
  const author = await actor(tenant, 'tenant_admin', ['operator']);
  const reviewer = await actor(tenant, 'tenant_admin', ['reviewer']);
  const patient = await actor(tenant, 'patient');
  for (const path of ['direct', 'si023']) {
    for (const timing of ['before', 'during-wait']) {
      const program = ulid();
      const previous = await draft(author, program);
      await request(
        reviewer,
        'POST',
        `/v0/forms/consult-templates/${previous.template_id}/publish`,
        {},
      );
      await request(
        author,
        'POST',
        `/v0/forms/consult-templates/${previous.template_id}/deploy`,
        {},
      );
      const target = await draft(author, program);
      const review =
        path === 'si023'
          ? await request(
              author,
              'POST',
              `/v1/admin/templates/${target.template_id}/submit-for-review`,
              {},
            )
          : undefined;
      if (timing === 'during-wait') {
        await admin.query('BEGIN');
        await admin.query('SELECT 1 FROM public.forms_template WHERE template_id=$1 FOR UPDATE', [
          target.template_id,
        ]);
      } else
        await admin.query(
          'UPDATE public.forms_template SET deleted_at=clock_timestamp() WHERE template_id=$1',
          [target.template_id],
        );
      const response = app.inject({
        method: 'POST',
        url:
          path === 'direct'
            ? `/v0/forms/consult-templates/${target.template_id}/publish`
            : `/v1/admin/templates/${target.template_id}/reviews/${review!.review_id}/decision`,
        headers: { ...reviewer.headers, 'idempotency-key': randomUUID() },
        payload: path === 'direct' ? {} : { decision: 'approve', decision_payload: {} },
      });
      try {
        if (timing === 'during-wait') {
          let blocked = false;
          for (let attempt = 0; attempt < 300; attempt++) {
            await admin.query('SELECT pg_stat_clear_snapshot()');
            blocked = (
              await admin.query<{ blocked: boolean }>(
                "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE usename='telecheck_app_role' AND wait_event_type='Lock' AND pg_backend_pid()=ANY(pg_blocking_pids(pid))) AS blocked",
              )
            ).rows[0]!.blocked;
            if (blocked) break;
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
          assert.ok(blocked, 'Publication reached the template lock before deletion');
          await admin.query(
            'UPDATE public.forms_template SET deleted_at=clock_timestamp() WHERE template_id=$1',
            [target.template_id],
          );
          await admin.query('COMMIT');
        }
        assert.equal((await response).statusCode, 400, `${path}/${timing}: deleted draft rejected`);
        const states = (
          await admin.query(
            'SELECT status,deleted_at IS NOT NULL AS deleted FROM public.forms_template WHERE tenant_id=$1 AND program_id=$2 ORDER BY template_version',
            [tenant, program],
          )
        ).rows;
        assert.deepEqual(states, [
          { status: 'published', deleted: false },
          { status: 'draft', deleted: true },
        ]);
        if (review)
          assert.equal(
            (
              await admin.query<{ to_state: string }>(
                'SELECT to_state FROM public.forms_template_admin_review_lifecycle_transition WHERE review_id=$1 ORDER BY transition_at DESC,id DESC LIMIT 1',
                [review.review_id],
              )
            ).rows[0]?.to_state,
            'pending_review',
          );
        const resolved = await app.inject({
          method: 'GET',
          url: `/v0/forms/consult-definitions?kind=program&programId=${program}`,
          headers: patient.headers,
        });
        assert.equal(resolved.statusCode, 200, resolved.body);
        assert.equal(resolved.json<{ template_id: string }>().template_id, previous.template_id);
        // Privileged fixture UPDATE still hits the shared trigger's deletion guard.
        await admin.query('BEGIN');
        await assert.rejects(
          admin.query("UPDATE public.forms_template SET status='published' WHERE template_id=$1", [
            target.template_id,
          ]),
          (error: unknown) => (error as { code?: string }).code === '22023',
        );
        await admin.query('ROLLBACK');
      } finally {
        await admin.query('ROLLBACK');
        await response;
      }
    }
  }

  for (const example of presentationTextBoundaries(country)) {
    assert.equal(ConsultPresentationSchema.safeParse(example.presentation).success, example.valid);
    const id = ulid(),
      program = ulid();
    await bind(author);
    try {
      const pending = ordinary.query(
        'SELECT public.forms_create_consult_template($1,$2,$3,$4,$5,$6,$7)',
        [
          id,
          program,
          'Synthetic Unicode bounds',
          example.presentation,
          {},
          {},
          { mode: 'mode1', development_only: true },
        ],
      );
      if (!example.valid) {
        await assert.rejects(
          pending,
          (error: unknown) => (error as { code?: string }).code === '22023',
        );
        assert.equal((await ordinary.query('COMMIT')).command, 'ROLLBACK');
      } else {
        await pending;
        await ordinary.query('COMMIT');
        await request(reviewer, 'POST', `/v0/forms/consult-templates/${id}/publish`, {});
        await request(author, 'POST', `/v0/forms/consult-templates/${id}/deploy`, {});
        const resolved = await app.inject({
          method: 'GET',
          url: `/v0/forms/consult-definitions?kind=program&programId=${program}`,
          headers: patient.headers,
        });
        assert.equal(
          resolved.statusCode,
          200,
          `${String(example.name)} ${example.units}: ${resolved.body}`,
        );
        assert.deepEqual(
          resolved.json<{ presentation: unknown }>().presentation,
          example.presentation,
        );
      }
    } finally {
      await ordinary.query('ROLLBACK');
    }
  }
  // Preserve the review's exact 128-code-point / 256-unit title counterexample.
  const reportedTitle = { ...body().presentation, title: '\u{1f33f}'.repeat(128) };
  assert.equal(ConsultPresentationSchema.safeParse(reportedTitle).success, false);
  await bind(author);
  try {
    await assert.rejects(
      ordinary.query('SELECT public.forms_create_consult_template($1,$2,$3,$4,$5,$6,$7)', [
        ulid(),
        ulid(),
        'Synthetic reported Unicode regression',
        reportedTitle,
        {},
        {},
        { mode: 'mode1', development_only: true },
      ]),
      (error: unknown) => (error as { code?: string }).code === '22023',
    );
    assert.equal((await ordinary.query('COMMIT')).command, 'ROLLBACK');
  } finally {
    await ordinary.query('ROLLBACK');
  }
  console.log(
    `${tenant}: 57 SQL write/receipt/control wait cases denied and rolled back; deleted drafts rejected before/during both publication paths with prior version retained; 30 shared Unicode examples agree across SQL/runtime/public resolution`,
  );
}
