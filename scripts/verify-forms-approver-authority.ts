/** Synthetic authority races for independent approval, not clinical approval. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { bindActorContextForRequest } from '../src/lib/actor-context-binding.js';
import { asTenantId } from '../src/lib/glossary.js';
import { ulid } from '../src/lib/ulid.js';
import { emitFormsGovernanceEvidence } from '../src/modules/forms-intake/audit.js';
import type { ConsultPresentation } from '../src/modules/forms-intake/internal/services/consult-definition.js';

import type { FormsAcceptanceContext } from './verify-forms-boundaries.js';

type Kind = 'clinical_review' | 'marketing_copy' | 'mode2_contract';
type Change = 'membership' | 'retype' | 'suspend' | 'delete' | 'artifact' | 'hash';
export async function verifyFormsApproverAuthority(
  ctx: FormsAcceptanceContext,
  tenant: 'Telecheck-US' | 'Telecheck-Ghana',
) {
  const { admin, ordinary, binder, app, actor, request } = ctx;
  const country = tenant === 'Telecheck-US' ? 'US' : 'GH';
  assert.deepEqual(
    (
      await ordinary.query(`SELECT
        has_function_privilege(current_user,'public.forms_require_approved_artifact(text,uuid,text,text,boolean)','EXECUTE') AS artifact_helper,
        has_function_privilege(current_user,'public.forms_assert_publication_contract(public.forms_template,boolean)','EXECUTE') AS contract_helper,
        has_column_privilege(current_user,'public.forms_governance_membership','account_id','UPDATE') AS membership_update,
        has_column_privilege(current_user,'public.accounts','account_id','UPDATE') AS account_update`)
    ).rows[0],
    {
      artifact_helper: false,
      contract_helper: false,
      membership_update: false,
      account_update: false,
    },
  );
  const makeTarget = async (kind: Kind) => {
    const author = await actor(tenant, 'tenant_admin', ['operator']);
    const publisher = await actor(tenant, 'tenant_admin', ['reviewer']);
    const capability =
      kind === 'clinical_review'
        ? 'clinical_reviewer'
        : kind === 'marketing_copy'
          ? 'marketing_reviewer'
          : 'mode2_reviewer';
    const approver = await actor(
      tenant,
      kind === 'clinical_review' ? 'clinician' : 'tenant_admin',
      [capability],
    );
    const program = ulid();
    const presentation: ConsultPresentation = {
      contract_version: 'consult_intake_v1',
      kind: 'program',
      locale: `en-${country}`,
      title: 'Synthetic approval authority',
      fields: [{ id: 'concern', type: 'text', label: 'Concern', required: true, max_length: 200 }],
      elements: [],
    };
    const body = {
      program_id: program,
      name: 'Synthetic approval authority',
      presentation,
      branching_logic: {},
      eligibility_logic: {} as Record<string, unknown>,
      approval_governance: { mode: 'mode1', development_only: true } as Record<string, unknown>,
    };
    const prior = await request(author, 'POST', '/v0/forms/consult-templates', body);
    await request(
      publisher,
      'POST',
      `/v0/forms/consult-templates/${prior.template_id}/publish`,
      {},
    );
    await request(author, 'POST', `/v0/forms/consult-templates/${prior.template_id}/deploy`, {});
    let artifact: { artifact_id: string; content_hash: string } | undefined;
    if (kind !== 'clinical_review') {
      artifact = await request(author, 'POST', '/v0/forms/governance/artifacts', {
        kind,
        development_only: true,
        content:
          kind === 'marketing_copy'
            ? {
                text: 'Synthetic approved copy',
                molecule_id: 'synthetic',
                country_of_care: country,
              }
            : { fields: [{ id: 'concern', type: 'text', required: true }] },
      });
      await request(
        approver,
        'POST',
        `/v0/forms/governance/artifacts/${artifact.artifact_id}/decision`,
        { content_hash: artifact.content_hash, decision: 'approved' },
      );
      if (kind === 'marketing_copy')
        presentation.elements = [
          {
            copy_classification: 'molecule_level',
            marketing_copy_id: artifact.artifact_id,
            content_hash: artifact.content_hash,
          },
        ];
      else
        body.approval_governance = {
          mode: 'mode2',
          mode2_contract_id: artifact.artifact_id,
          mode2_contract_hash: artifact.content_hash,
          development_only: true,
        };
    } else
      body.eligibility_logic = {
        eligibility_rules: [
          {
            field_id: 'concern',
            operator: 'equals',
            value: 'synthetic',
            outcome: 'clinical_review_required',
          },
        ],
        contraindications: [],
      };
    const target = await request(author, 'POST', '/v0/forms/consult-templates', body);
    if (kind === 'clinical_review') {
      artifact = await request(author, 'POST', '/v0/forms/governance/artifacts', {
        kind,
        template_id: target.template_id,
        content: {},
        development_only: true,
      });
      await request(
        approver,
        'POST',
        `/v0/forms/governance/artifacts/${artifact.artifact_id}/decision`,
        { content_hash: artifact.content_hash, decision: 'approved' },
      );
    }
    assert.ok(artifact);
    return { author, publisher, approver, capability, program, prior, target, artifact };
  };
  type Setup = Awaited<ReturnType<typeof makeTarget>>;
  const invalidate = async (setup: Setup, change: Change) => {
    if (change === 'membership')
      await admin.query(
        'UPDATE public.forms_governance_membership SET revoked_at=clock_timestamp() WHERE tenant_id=$1 AND account_id=$2 AND capability=$3',
        [tenant, setup.approver.accountId, setup.capability],
      );
    else if (change === 'retype')
      await admin.query(
        "UPDATE public.accounts SET account_type='patient' WHERE tenant_id=$1 AND account_id=$2",
        [tenant, setup.approver.accountId],
      );
    else if (change === 'suspend')
      await admin.query(
        "UPDATE public.accounts SET status='suspended' WHERE tenant_id=$1 AND account_id=$2",
        [tenant, setup.approver.accountId],
      );
    else if (change === 'delete')
      await admin.query(
        'UPDATE public.accounts SET deleted_at=clock_timestamp() WHERE tenant_id=$1 AND account_id=$2',
        [tenant, setup.approver.accountId],
      );
    else if (change === 'artifact')
      await admin.query(
        "UPDATE public.forms_governance_artifact SET status='withdrawn' WHERE artifact_id=$1",
        [setup.artifact.artifact_id],
      );
    else
      await admin.query(
        "UPDATE public.forms_governance_artifact SET content_hash=repeat('f',64) WHERE artifact_id=$1",
        [setup.artifact.artifact_id],
      );
  };
  const assertRolledBack = async (setup: Setup, review?: string) => {
    assert.deepEqual(
      (
        await admin.query<{ status: string; snapshot: boolean }>(
          `SELECT t.status,EXISTS(SELECT 1 FROM public.forms_published_definition d WHERE d.tenant_id=t.tenant_id AND d.template_id=t.template_id) AS snapshot FROM public.forms_template t WHERE t.template_id=$1`,
          [setup.target.template_id],
        )
      ).rows[0],
      { status: 'draft', snapshot: false },
    );
    assert.equal(
      (
        await admin.query<{ status: string }>(
          'SELECT status FROM public.forms_template WHERE template_id=$1',
          [setup.prior.template_id],
        )
      ).rows[0]?.status,
      'published',
    );
    if (review)
      assert.equal(
        (
          await admin.query<{ to_state: string }>(
            'SELECT to_state FROM public.forms_template_admin_review_lifecycle_transition WHERE review_id=$1 ORDER BY transition_at DESC,id DESC LIMIT 1',
            [review],
          )
        ).rows[0]?.to_state,
        'pending_review',
      );
    assert.equal(
      (
        await admin.query<{ n: number }>(
          "SELECT count(*)::int AS n FROM public.audit_records WHERE tenant_id=$1 AND resource_id=$2 AND payload->>'intent'='forms.publication.checked'",
          [tenant, setup.target.template_id],
        )
      ).rows[0]!.n,
      0,
    );
    assert.equal(
      (
        await admin.query<{ n: number }>(
          "SELECT count(*)::int AS n FROM public.domain_events_outbox WHERE tenant_id=$1 AND aggregate_id=$2 AND event_type='forms.publication.checked'",
          [tenant, setup.target.template_id],
        )
      ).rows[0]!.n,
      0,
    );
    assert.equal(
      (
        await admin.query<{ active: boolean }>(
          "SELECT EXISTS(SELECT 1 FROM public.forms_governance_membership m JOIN public.accounts a ON a.tenant_id=m.tenant_id AND a.account_id=m.account_id WHERE m.tenant_id=$1 AND m.account_id=$2 AND m.capability='reviewer' AND m.revoked_at IS NULL AND a.status='active' AND a.deleted_at IS NULL) AS active",
          [tenant, setup.publisher.accountId],
        )
      ).rows[0]!.active,
      true,
      'Publisher remains valid; independent approval caused denial',
    );
  };
  const waitForFixture = async () => {
    for (let i = 0; i < 300; i++) {
      await admin.query('SELECT pg_stat_clear_snapshot()');
      if (
        (
          await admin.query<{ blocked: boolean }>(
            "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE usename='telecheck_app_role' AND wait_event_type='Lock' AND pg_backend_pid()=ANY(pg_blocking_pids(pid))) AS blocked",
          )
        ).rows[0]!.blocked
      )
        return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.fail('Publisher did not reach the fixture-held wait');
  };
  const bindAndPublish = async (setup: Setup) => {
    const bound = await bindActorContextForRequest(binder, {
      actorAccountId: setup.publisher.accountId,
      actorAccountTenantId: tenant,
      actorRole: setup.publisher.role,
      actorAdminHomeTenantId: null,
      sessionId: setup.publisher.sessionId,
    });
    await ordinary.query('BEGIN');
    await ordinary.query("SET LOCAL statement_timeout='15s'");
    const rebind = async () => {
      await ordinary.query('SELECT public.set_tenant_context($1)', [tenant]);
      await ordinary.query("SELECT set_config('app.request_nonce',$1,true)", [bound.nonce]);
    };
    await rebind();
    await ordinary.query('SELECT public.forms_publish_template($1)', [setup.target.template_id]);
    const receipt = (
      await ordinary.query<{ receipt: { schema_hash: string } }>(
        'SELECT public.forms_publication_receipt($1) AS receipt',
        [setup.target.template_id],
      )
    ).rows[0]!.receipt;
    await emitFormsGovernanceEvidence(
      {
        tenantId: asTenantId(tenant),
        actorId: setup.publisher.accountId,
        actorRole: 'operator',
        countryOfCare: country,
        resourceId: setup.target.template_id,
        intent: 'forms.publication.checked',
        detail: { schema_hash: receipt.schema_hash },
      },
      ordinary,
    );
    await rebind();
  };
  for (const kind of ['clinical_review', 'marketing_copy', 'mode2_contract'] as const) {
    for (const route of ['direct', 'si023'] as const) {
      for (const wait of ['snapshot', 'outbox'] as const) {
        for (const change of [
          'membership',
          'retype',
          'suspend',
          'delete',
          'artifact',
          'hash',
        ] as const) {
          const setup = await makeTarget(kind);
          const review =
            route === 'si023'
              ? (
                  await request(
                    setup.author,
                    'POST',
                    `/v1/admin/templates/${setup.target.template_id}/submit-for-review`,
                    {},
                  )
                ).review_id
              : undefined;
          await admin.query('BEGIN');
          await admin.query(
            wait === 'snapshot'
              ? 'LOCK TABLE public.forms_published_definition IN SHARE MODE'
              : 'LOCK TABLE public.domain_events_outbox IN SHARE MODE',
          );
          const pending = app.inject({
            method: 'POST',
            url:
              route === 'direct'
                ? `/v0/forms/consult-templates/${setup.target.template_id}/publish`
                : `/v1/admin/templates/${setup.target.template_id}/reviews/${review!}/decision`,
            headers: { ...setup.publisher.headers, 'idempotency-key': randomUUID() },
            payload: route === 'direct' ? {} : { decision: 'approve', decision_payload: {} },
          });
          try {
            await waitForFixture();
            await invalidate(setup, change);
            await admin.query('COMMIT');
            const response = await pending;
            assert.equal(
              response.statusCode,
              400,
              `${tenant}/${kind}/${route}/${wait}/${change}: ${response.body}`,
            );
            await assertRolledBack(setup, review);
          } finally {
            await admin.query('ROLLBACK');
            await pending;
          }
        }
      }
      // An old reviewer session is not a prerequisite for a still-qualified approval.
      const setup = await makeTarget(kind);
      await admin.query(
        "UPDATE public.sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE session_id=$1",
        [setup.approver.sessionId],
      );
      if (route === 'direct')
        await request(
          setup.publisher,
          'POST',
          `/v0/forms/consult-templates/${setup.target.template_id}/publish`,
          {},
        );
      else {
        const review = await request(
          setup.author,
          'POST',
          `/v1/admin/templates/${setup.target.template_id}/submit-for-review`,
          {},
        );
        await request(
          setup.publisher,
          'POST',
          `/v1/admin/templates/${setup.target.template_id}/reviews/${review.review_id}/decision`,
          { decision: 'approve', decision_payload: {} },
        );
      }
    }
    for (const change of [
      'membership',
      'retype',
      'suspend',
      'delete',
      'artifact',
      'hash',
    ] as const) {
      const setup = await makeTarget(kind);
      try {
        await bindAndPublish(setup);
        await invalidate(setup, change);
        await assert.rejects(
          ordinary.query('COMMIT'),
          (error: unknown) => (error as { code?: string }).code === '22023',
          `${kind}/${change}: deferred SQL gate must deny commit`,
        );
      } finally {
        await ordinary.query('ROLLBACK');
      }
      await assertRolledBack(setup);
      const blockedSetup = await makeTarget(kind);
      let pendingCommit: Promise<string | undefined> | undefined;
      try {
        await bindAndPublish(blockedSetup);
        await admin.query('BEGIN');
        if (change === 'membership')
          await admin.query(
            'SELECT 1 FROM public.forms_governance_membership WHERE tenant_id=$1 AND account_id=$2 AND capability=$3 FOR UPDATE',
            [tenant, blockedSetup.approver.accountId, blockedSetup.capability],
          );
        else if (change === 'artifact' || change === 'hash')
          await admin.query(
            'SELECT 1 FROM public.forms_governance_artifact WHERE artifact_id=$1 FOR UPDATE',
            [blockedSetup.artifact.artifact_id],
          );
        else
          await admin.query(
            'SELECT 1 FROM public.accounts WHERE tenant_id=$1 AND account_id=$2 FOR UPDATE',
            [tenant, blockedSetup.approver.accountId],
          );
        pendingCommit = ordinary.query('COMMIT').then(
          () => 'committed',
          (error: unknown) => (error as { code?: string }).code,
        );
        await waitForFixture();
        await invalidate(blockedSetup, change);
        await admin.query('COMMIT');
        assert.equal(
          await pendingCommit,
          '22023',
          `${kind}/${change}: final authority lock wait rechecks changed row`,
        );
      } finally {
        await admin.query('ROLLBACK');
        await pendingCommit;
        await ordinary.query('ROLLBACK');
      }
      await assertRolledBack(blockedSetup);
    }
    // Once the deferred constraint is flushed, every selected approval authority
    // row stays protected until commit. Revocation then serializes after publication.
    for (const change of ['membership', 'retype', 'artifact'] as const) {
      const setup = await makeTarget(kind);
      const adminPid = (await admin.query<{ pid: number }>('SELECT pg_backend_pid() AS pid'))
        .rows[0]!.pid;
      let pending: Promise<void> | undefined;
      try {
        await bindAndPublish(setup);
        await ordinary.query('SET CONSTRAINTS forms_publication_evidence IMMEDIATE');
        await ordinary.query('SET CONSTRAINTS forms_publication_evidence DEFERRED');
        pending = invalidate(setup, change);
        let blocked = false;
        for (let i = 0; i < 300; i++) {
          blocked = (
            await ordinary.query<{ blocked: boolean }>(
              'SELECT pg_backend_pid()=ANY(pg_blocking_pids($1)) AS blocked',
              [adminPid],
            )
          ).rows[0]!.blocked;
          if (blocked) break;
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        assert.ok(
          blocked,
          `${kind}/${change}: authority row remains locked after early constraint flush`,
        );
        await ordinary.query('COMMIT');
        await pending;
        assert.equal(
          (
            await admin.query<{ status: string }>(
              'SELECT status FROM public.forms_template WHERE template_id=$1',
              [setup.target.template_id],
            )
          ).rows[0]?.status,
          'published',
        );
      } finally {
        await ordinary.query('ROLLBACK');
        await pending;
      }
    }
  }
  console.log(
    `${tenant}: independent approval authority passed 72 HTTP wait denials, 36 deferred SQL commit denials including final row waits, 9 early-flush row-lock checks and 6 historical-session positive controls`,
  );
}
