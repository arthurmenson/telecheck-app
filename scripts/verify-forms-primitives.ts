/** Primitive parity and publication rollback through actual HTTP and ordinary SQL. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { bindActorContextForRequest } from '../src/lib/actor-context-binding.js';
import { ulid } from '../src/lib/ulid.js';
import { ConsultPresentationSchema } from '../src/modules/forms-intake/internal/services/consult-definition.js';
import {
  identifierPrimitiveCases,
  presentationPrimitiveMutations,
  primitivePresentation,
} from '../tests/helpers/forms-presentation-primitives.js';

import type { FormsAcceptanceContext } from './verify-forms-boundaries.js';

export async function verifyFormsPrimitives(
  ctx: FormsAcceptanceContext,
  tenant: 'Telecheck-US' | 'Telecheck-Ghana',
) {
  const { admin, ordinary, binder, app, actor, request } = ctx;
  const country = tenant === 'Telecheck-US' ? 'US' : 'GH';
  const author = await actor(tenant, 'tenant_admin', ['operator']);
  const reviewer = await actor(tenant, 'tenant_admin', ['reviewer', 'mode2_reviewer']);
  const clinicalReviewer = await actor(tenant, 'clinician', ['clinical_reviewer']);
  const patient = await actor(tenant, 'patient');
  const presentation = { ...primitivePresentation(country), elements: [] };
  const body = (program = ulid()) => ({
    program_id: program,
    name: 'Synthetic primitive validation',
    presentation,
    branching_logic: {},
    eligibility_logic: {} as Record<string, unknown>,
    approval_governance: { mode: 'mode1', development_only: true } as Record<string, unknown>,
  });
  const bind = async (who = author) => {
    const bound = await bindActorContextForRequest(binder, {
      actorAccountId: who.accountId,
      actorAccountTenantId: tenant,
      actorRole: who.role,
      actorAdminHomeTenantId: null,
      sessionId: who.sessionId,
    });
    await ordinary.query('BEGIN');
    await ordinary.query('SELECT public.set_tenant_context($1)', [tenant]);
    await ordinary.query("SELECT set_config('app.request_nonce',$1,true)", [bound.nonce]);
  };
  const sqlCreate = (id: string, program: string, value: unknown) =>
    ordinary.query('SELECT public.forms_create_consult_template($1,$2,$3,$4,$5,$6,$7)', [
      id,
      program,
      'Synthetic primitive validation',
      value === undefined ? null : JSON.stringify(value),
      {},
      {},
      { mode: 'mode1', development_only: true },
    ]);
  const invalidInput = (error: unknown) => (error as { code?: string }).code === '22023';
  const assertNoPublication = async (
    id: string,
    priorId: string,
    program: string,
    reviewId?: string,
  ) => {
    assert.deepEqual(
      (
        await admin.query(
          'SELECT template_id,status FROM public.forms_template WHERE tenant_id=$1 AND program_id=$2 ORDER BY template_version',
          [tenant, program],
        )
      ).rows,
      [
        { template_id: priorId, status: 'published' },
        { template_id: id, status: 'draft' },
      ],
    );
    const counts = (
      await admin.query<{ snapshots: number; audits: number; events: number }>(
        `SELECT (SELECT count(*)::int FROM public.forms_published_definition WHERE tenant_id=$1 AND template_id=$2) AS snapshots,
        (SELECT count(*)::int FROM public.audit_records WHERE tenant_id=$1 AND resource_id=$2 AND payload->>'intent'='forms.publication.checked') AS audits,
        (SELECT count(*)::int FROM public.domain_events_outbox WHERE tenant_id=$1 AND aggregate_id=$2 AND event_type='forms.publication.checked') AS events`,
        [tenant, id],
      )
    ).rows[0];
    assert.deepEqual(counts, { snapshots: 0, audits: 0, events: 0 });
    if (reviewId)
      assert.equal(
        (
          await admin.query<{ to_state: string }>(
            'SELECT to_state FROM public.forms_template_admin_review_lifecycle_transition WHERE review_id=$1 ORDER BY transition_at DESC,id DESC LIMIT 1',
            [reviewId],
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
    assert.equal(resolved.json<{ template_id: string }>().template_id, priorId);
  };

  // Differential corpus uses the public SQL creation operation, never privileged
  // validator execution. Every trial rolls back; no malformed state is persisted.
  let accepted = 0;
  const mutations = presentationPrimitiveMutations(country);
  for (const example of mutations) {
    const runtime = ConsultPresentationSchema.safeParse(example.presentation).success;
    await bind();
    try {
      let sql = true;
      try {
        await sqlCreate(ulid(), ulid(), example.presentation);
      } catch (error) {
        assert.match(
          (error as { code: string }).code,
          /^22/,
          `${example.name}: must be an input denial`,
        );
        sql = false;
      }
      assert.equal(sql, runtime, `${tenant}/${example.name}: SQL creation and runtime disagree`);
      if (sql) accepted++;
    } finally {
      await ordinary.query('ROLLBACK');
    }
  }

  // Actual request rejection and aborted SQL creation, then legacy persisted
  // malformed drafts exercise the repeated publication boundary and rollback.
  const identifierCases = identifierPrimitiveCases(country);
  for (const example of identifierCases) {
    await request(
      author,
      'POST',
      '/v0/forms/consult-templates',
      { ...body(), presentation: example.presentation },
      400,
    );
    const rejectedId = ulid();
    await bind();
    try {
      await assert.rejects(sqlCreate(rejectedId, ulid(), example.presentation), invalidInput);
      assert.equal((await ordinary.query('COMMIT')).command, 'ROLLBACK');
    } finally {
      await ordinary.query('ROLLBACK');
    }
    assert.equal(
      (await admin.query('SELECT 1 FROM public.forms_template WHERE template_id=$1', [rejectedId]))
        .rowCount,
      0,
    );
    for (const path of ['direct', 'si023']) {
      const program = ulid();
      const prior = await request(author, 'POST', '/v0/forms/consult-templates', body(program));
      await request(
        reviewer,
        'POST',
        `/v0/forms/consult-templates/${prior.template_id}/publish`,
        {},
      );
      await request(author, 'POST', `/v0/forms/consult-templates/${prior.template_id}/deploy`, {});
      const target = await request(author, 'POST', '/v0/forms/consult-templates', body(program));
      const review = await request(
        author,
        'POST',
        `/v1/admin/templates/${target.template_id}/submit-for-review`,
        {},
      );
      // Privileged setup models a draft persisted before this migration correction;
      // all attempted publication and resolution use the ordinary application login.
      await admin.query(
        'UPDATE public.forms_template SET presentation_content=$1 WHERE template_id=$2',
        [JSON.stringify(example.presentation), target.template_id],
      );
      const response = await app.inject({
        method: 'POST',
        url:
          path === 'direct'
            ? `/v0/forms/consult-templates/${target.template_id}/publish`
            : `/v1/admin/templates/${target.template_id}/reviews/${review.review_id}/decision`,
        headers: { ...reviewer.headers, 'idempotency-key': randomUUID() },
        payload: path === 'direct' ? {} : { decision: 'approve', decision_payload: {} },
      });
      assert.equal(response.statusCode, 400, `${example.name}/${path}: ${response.body}`);
      await bind(reviewer);
      try {
        await assert.rejects(
          ordinary.query('SELECT public.forms_publish_template($1)', [target.template_id]),
          invalidInput,
        );
        assert.equal((await ordinary.query('COMMIT')).command, 'ROLLBACK');
      } finally {
        await ordinary.query('ROLLBACK');
      }
      await assertNoPublication(target.template_id, prior.template_id, program, review.review_id);
    }
  }

  // Approval input fields are checked without coerced identifiers or booleans.
  let artifactDenials = 0;
  for (const kind of ['mode2_contract', 'marketing_copy']) {
    const valid =
      kind === 'mode2_contract'
        ? { fields: [{ id: 'true', type: 'boolean', required: false }] }
        : { text: 'Synthetic copy', molecule_id: 'true', country_of_care: country };
    const keys =
      kind === 'mode2_contract'
        ? ['id', 'type', 'required']
        : ['text', 'molecule_id', 'country_of_care'];
    for (const key of keys)
      for (const value of [
        null,
        0,
        1,
        [],
        {},
        ...(key === 'required' ? ['true', 'false'] : [true, false]),
      ]) {
        const content = structuredClone(valid);
        const node = kind === 'mode2_contract' ? content.fields![0]! : content;
        Object.assign(node, { [key]: value });
        await request(
          author,
          'POST',
          '/v0/forms/governance/artifacts',
          { kind, content, development_only: true },
          400,
        );
        await bind();
        try {
          await assert.rejects(
            ordinary.query('SELECT public.forms_submit_governance_artifact($1,NULL,$2,true)', [
              kind,
              JSON.stringify(content),
            ]),
            invalidInput,
          );
          assert.equal((await ordinary.query('COMMIT')).command, 'ROLLBACK');
        } finally {
          await ordinary.query('ROLLBACK');
        }
        artifactDenials++;
      }
  }

  // L3 exact-hash approval cannot turn a boolean reference into a string. The
  // corresponding literal string references and Mode2 contract publish/resolve.
  for (const value of [true, false])
    for (const path of ['direct', 'si023']) {
      for (const valid of [false, true]) {
        const program = ulid();
        const prior = await request(author, 'POST', '/v0/forms/consult-templates', body(program));
        await request(
          reviewer,
          'POST',
          `/v0/forms/consult-templates/${prior.template_id}/publish`,
          {},
        );
        await request(
          author,
          'POST',
          `/v0/forms/consult-templates/${prior.template_id}/deploy`,
          {},
        );
        const next = body(program);
        next.presentation = {
          ...presentation,
          fields: [{ id: String(value), type: 'boolean', label: 'Question', required: false }],
        };
        next.eligibility_logic = {
          eligibility_rules: [
            {
              field_id: valid ? String(value) : value,
              operator: 'equals',
              value: false,
              outcome: 'clinical_review_required',
            },
          ],
          contraindications: [],
        };
        const contract = await request(author, 'POST', '/v0/forms/governance/artifacts', {
          kind: 'mode2_contract',
          content: { fields: [{ id: String(value), type: 'boolean', required: false }] },
          development_only: true,
        });
        await request(
          reviewer,
          'POST',
          `/v0/forms/governance/artifacts/${contract.artifact_id}/decision`,
          { content_hash: contract.content_hash, decision: 'approved' },
        );
        next.approval_governance = {
          mode: 'mode2',
          development_only: true,
          mode2_contract_id: contract.artifact_id,
          mode2_contract_hash: contract.content_hash,
        };
        const target = await request(author, 'POST', '/v0/forms/consult-templates', next);
        const clinical = await request(author, 'POST', '/v0/forms/governance/artifacts', {
          kind: 'clinical_review',
          template_id: target.template_id,
          content: {},
          development_only: true,
        });
        await request(
          clinicalReviewer,
          'POST',
          `/v0/forms/governance/artifacts/${clinical.artifact_id}/decision`,
          { content_hash: clinical.content_hash, decision: 'approved' },
        );
        const review = await request(
          author,
          'POST',
          `/v1/admin/templates/${target.template_id}/submit-for-review`,
          {},
        );
        await request(
          reviewer,
          'POST',
          path === 'direct'
            ? `/v0/forms/consult-templates/${target.template_id}/publish`
            : `/v1/admin/templates/${target.template_id}/reviews/${review.review_id}/decision`,
          path === 'direct' ? {} : { decision: 'approve', decision_payload: {} },
          valid ? 201 : 400,
        );
        if (!valid)
          await assertNoPublication(
            target.template_id,
            prior.template_id,
            program,
            review.review_id,
          );
        else {
          await request(
            author,
            'POST',
            `/v0/forms/consult-templates/${target.template_id}/deploy`,
            {},
          );
          const resolved = await app.inject({
            method: 'GET',
            url: `/v0/forms/consult-definitions?kind=program&programId=${program}`,
            headers: patient.headers,
          });
          assert.equal(resolved.statusCode, 200, resolved.body);
          assert.deepEqual(
            resolved.json<{ presentation: unknown }>().presentation,
            next.presentation,
          );
        }
      }
    }
  console.log(
    `${tenant}: ${mutations.length} ordinary-SQL/runtime primitive comparisons (${accepted} accepted, zero mismatches); ${identifierCases.length} HTTP/SQL creation denials; ${identifierCases.length * 2} HTTP and SQL publication rollback controls; ${artifactDenials} HTTP/SQL artifact primitive denials; 4 L3 boolean-reference publication denials and 4 string true/false L3/Mode2 publication/resolution controls`,
  );
}
