/** Destructive rollback regression for an explicitly disposable test database. */
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import pg from 'pg';

import { bindActorContextForRequest, withActorContext } from '../src/lib/actor-context-binding.js';
import { asTenantId } from '../src/lib/glossary.js';
import { withTenantContext } from '../src/lib/rls.js';
import { ulid } from '../src/lib/ulid.js';
import { withDbRole } from '../src/lib/with-db-role.js';

assert.equal(process.env['NODE_ENV'], 'development');
assert.equal(
  process.env['FORMS_ROLLBACK_DISPOSABLE_DATABASE'],
  'true',
  'Rollback verification must explicitly name a disposable database',
);
const admin = new pg.Client({ connectionString: process.env['FORMS_MIGRATION_DATABASE_URL'] });
const ordinary = new pg.Client({ connectionString: process.env['DATABASE_URL'] });
const binder = new pg.Client({ connectionString: process.env['BIND_ACTOR_CONTEXT_DATABASE_URL'] });
await Promise.all([admin.connect(), ordinary.connect(), binder.connect()]);
const fixtures: {
  tenant: string;
  account: string;
  session: string;
  template: string;
  expected: '42P17' | 'accepted';
}[] = [];

async function verifySubmissionStates() {
  for (const fixture of fixtures) {
    const bound = await bindActorContextForRequest(binder, {
      actorAccountId: fixture.account,
      actorAccountTenantId: fixture.tenant,
      actorRole: 'tenant_admin',
      actorAdminHomeTenantId: null,
      sessionId: fixture.session,
    });
    await ordinary.query('BEGIN');
    let result: string;
    try {
      await withTenantContext(ordinary, asTenantId(fixture.tenant), () =>
        withActorContext(ordinary, bound.nonce, () =>
          withDbRole(ordinary, 'admin_basic_operator', async () => {
            const response = await ordinary.query<{ review_id: string }>(
              'SELECT public.submit_forms_template_for_admin_review($1,$2) AS review_id',
              [fixture.tenant, fixture.template],
            );
            assert.match(response.rows[0]!.review_id, /^[0-9a-f-]{36}$/);
          }),
        ),
      );
      result = 'accepted';
    } catch (error) {
      result = String((error as { code?: string }).code);
    } finally {
      await ordinary.query('ROLLBACK');
    }
    assert.equal(
      result,
      fixture.expected,
      'The latest pre-090 draft/deletion guard must survive committed rollback',
    );
  }
}

async function expectedBody(file: string, name: string) {
  const source = await readFile(new URL(`../migrations/${file}`, import.meta.url), 'utf8');
  const match = source.match(
    new RegExp(`CREATE OR REPLACE FUNCTION ${name}\\([\\s\\S]*?AS \\$\\$([\\s\\S]*?)\\$\\$;`),
  );
  assert.ok(match, 'Latest baseline function source exists');
  return match[1];
}

try {
  assert.deepEqual(
    (
      await ordinary.query(
        'SELECT rolsuper,rolbypassrls,rolinherit FROM pg_roles WHERE rolname=session_user',
      )
    ).rows[0],
    { rolsuper: false, rolbypassrls: false, rolinherit: false },
  );
  for (const tenant of ['Telecheck-US', 'Telecheck-Ghana']) {
    const account = ulid(),
      session = ulid();
    const country = tenant === 'Telecheck-US' ? 'US' : 'GH';
    await admin.query('BEGIN');
    try {
      await withTenantContext(admin, asTenantId(tenant), async () => {
        await admin.query(
          `INSERT INTO public.accounts(account_id,tenant_id,email,first_name,last_name,date_of_birth,gender,country_of_residence,country_of_care,locale,account_type,status)
      VALUES($1,$2,$3,'Synthetic','Rollback','1990-01-01','prefer_not_to_say',$4,$4,$5,'tenant_admin','active')`,
          [account, tenant, `${randomUUID()}@example.invalid`, country, `en-${country}`],
        );
        await admin.query(
          "INSERT INTO public.sessions(session_id,tenant_id,account_id,refresh_token_hash,expires_at) VALUES($1,$2,$3,$4,clock_timestamp()+interval '1 hour')",
          [session, tenant, account, randomBytes(32).toString('hex')],
        );
        await admin.query(
          "INSERT INTO public.forms_governance_membership(tenant_id,account_id,capability) VALUES($1,$2,'operator')",
          [tenant, account],
        );
      });
      await admin.query('COMMIT');
    } catch (error) {
      await admin.query('ROLLBACK');
      throw error;
    }
    for (const state of ['published', 'superseded', 'archived', 'deleted_draft', 'draft']) {
      const template = ulid();
      // Fixture-only rows isolate the submission guard from new publication gates.
      await admin.query(
        `INSERT INTO public.forms_template(template_id,tenant_id,program_id,country_of_care,template_version,name,presentation_content,branching_logic,eligibility_logic,approval_governance,created_by,status,deleted_at)
        VALUES($1,$2,$3,$4,1,'Synthetic rollback fixture','{}','{}','{}','{}',$5,$6,$7)`,
        [
          template,
          tenant,
          ulid(),
          country,
          account,
          state === 'deleted_draft' ? 'draft' : state,
          state === 'deleted_draft' ? new Date() : null,
        ],
      );
      fixtures.push({
        tenant,
        account,
        session,
        template,
        expected: state === 'draft' ? 'accepted' : '42P17',
      });
    }
  }
  await verifySubmissionStates();
  await admin.query('BEGIN');
  try {
    for (const id of ['092', '091', '090'])
      await admin.query(
        await readFile(
          new URL(`../migrations/rollback/${id}_rollback.sql`, import.meta.url),
          'utf8',
        ),
      );
    await admin.query('COMMIT');
  } catch (error) {
    await admin.query('ROLLBACK');
    throw error;
  }
  assert.equal(
    (
      await admin.query<{ count: number }>(
        "SELECT count(*)::INTEGER AS count FROM pg_roles WHERE rolname='forms_publication_owner'",
      )
    ).rows[0]!.count,
    0,
  );
  for (const [name, source] of [
    ['submit_forms_template_for_admin_review', '052_admin_backend_submit_draft_state_guard.sql'],
    ['record_forms_template_admin_decision', '043_admin_backend_template_wrappers.sql'],
  ]) {
    const restored = await admin.query<{ prosrc: string }>(
      "SELECT prosrc FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname=$1",
      [name],
    );
    assert.equal(
      restored.rows[0]!.prosrc,
      await expectedBody(source!, name!),
      `Restore exact latest baseline body for ${name}`,
    );
  }
  await verifySubmissionStates();
  console.log(
    JSON.stringify(
      {
        passed: true,
        committedRollback: true,
        ordinaryRoleGuardChecks: fixtures.length * 2,
        restoredSubmitBaseline: '052',
        restoredDecisionBaseline: '043',
        states: ['published', 'superseded', 'archived', 'soft-deleted draft', 'valid draft'],
        countries: ['US', 'GH'],
      },
      null,
      2,
    ),
  );
} finally {
  await Promise.all([admin.end(), ordinary.end(), binder.end()]);
}
