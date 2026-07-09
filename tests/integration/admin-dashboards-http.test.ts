/**
 * admin-dashboards-http.test.ts — live-PostgreSQL HTTP integration tests
 * for the three SI-023 §5 dashboard read endpoints (Admin Backend Basics
 * slice, RATIFIED P-041):
 *
 *   GET /v1/admin/dashboards/crisis-operational-health   (044 §1 wrapper, 074 fix)
 *   GET /v1/admin/dashboards/consult-queue-health        (065 §2 wrapper)
 *   GET /v1/admin/dashboards/mode1-volume-health         (069 §2 wrapper)
 *
 * WHY THIS SUITE EXISTS (Phase-D sweep closure, 2026-07-08): the dashboard
 * wrappers had NO live-PG coverage — the handler unit tests mock all SQL,
 * and CREATE OR REPLACE parses but does not plan the body. That blind spot
 * hid a latent 42702 (ambiguous_column) in the 044 §1 wrapper — the CTAS
 * `WHERE tenant_id = p_tenant_id` collided with the tenant_id RETURNS
 * TABLE OUT param — which made EVERY live crisis-operational-health read
 * fail. Same latent-defect class as the crisis sweep wrapper fixed in
 * migration 071 (which survived 18 Codex rounds the same way). Migration
 * 074 fixes the wrapper; test §A1 here is the regression pin, and §B/§C
 * prove the two sibling wrappers (already alias-qualified) actually run
 * on live PG so the class cannot recur silently on any dashboard surface.
 *
 * Exercises the REAL composition end-to-end (crisis-response-http.test.ts
 * harness): JWT verify → SI-010 bind (real bind pool authenticated as
 * bind_actor_context_role) → tenant context → LAYER B admin-role gate →
 * SET LOCAL ROLE admin_basic_operator → SECDEF dashboard wrapper →
 * co-transactional I-027 read-trail INSERT.
 *
 * Coverage:
 *
 *   Group A — crisis-operational-health (the 074 regression pin)
 *     A1 admin token → 200 with rows array; I-027 read-trail row inserted
 *        with dashboard_name='admin_crisis_operational_health_v'.
 *        (Pre-074 this failed: PL/pgSQL raised SQLSTATE 42702 at the CTAS
 *        site on every invocation.)
 *     A2 two sequential calls → 200 both (repeat-call safety; 044 §1
 *        R1 MED-1 DROP-IF-EXISTS pattern) + read-trail row per call
 *     A3 patient token → 403 at the LAYER B admin gate; NO read-trail row
 *
 *   Group B — consult-queue-health
 *     B1 admin token → 200 with rows array; read-trail row with
 *        dashboard_name='admin_consult_queue_health_v'
 *
 *   Group C — mode1-volume-health
 *     C1 admin token → 200 with rows array; read-trail row with
 *        dashboard_name='admin_mode1_volume_health_v'
 *
 *   Group D — tenant scoping (I-023 / I-027)
 *     D1 Ghana admin on the Ghana host → 200; the Ghana read-trail row
 *        carries tenant_id='Telecheck-Ghana' (per-tenant trail separation)
 *
 * Spec references: SI-023 v1.0 P-041 §3.5 + §5; CDM v1.10→v1.11 Amendment
 * §4.NEW8b/c/d (P-042); migrations 039-044, 065, 069, 074; I-023, I-025,
 * I-027; migration 071 (first instance of the 42702 class).
 */

import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../../src/app.ts';
import {
  clearBindActorContextTestPool,
  setBindActorContextTestPool,
  type DbClient,
} from '../../src/lib/db.ts';
import { asTenantId } from '../../src/lib/glossary.ts';
import { ulid } from '../../src/lib/ulid.ts';
import { createAccount } from '../../src/modules/identity/internal/repositories/account-repo.ts';
import { asAccountId, type AccountId } from '../../src/modules/identity/internal/types.ts';
import { grantSliceRolesToTestApp } from '../helpers/grant-slice-roles.ts';
import { bearerAuthHeader } from '../helpers/jwt-fixtures.ts';
import { TENANT_GHANA, TENANT_US, withTenantContext } from '../helpers/tenant-fixtures.ts';
import { uniquePhone } from '../helpers/unique-phone.ts';
import { getTestClient } from '../setup.ts';

const T_US = asTenantId(TENANT_US);
const T_GH = asTenantId(TENANT_GHANA);
const BIND_ROLE_TEST_PASSWORD = 'telecheck_test_bind_pw';

/** The single SI-023 slice role every dashboard handler elevates into. */
const ADMIN_SLICE_ROLES = ['admin_basic_operator'] as const;

const DASHBOARD_URLS = {
  crisis: '/v1/admin/dashboards/crisis-operational-health',
  consult: '/v1/admin/dashboards/consult-queue-health',
  mode1: '/v1/admin/dashboards/mode1-volume-health',
} as const;

let app: FastifyInstance | null = null;
let bindPool: pg.Pool | null = null;

let usAdmin: AccountId;
let usPatient: AccountId;
let ghAdmin: AccountId;

function usAuth(
  accountId: string,
  role: 'patient' | 'clinician' | 'tenant_admin',
): { authorization: string } {
  return bearerAuthHeader({ accountId, tenantId: T_US, countryOfCare: 'US', role });
}

function ghAuth(
  accountId: string,
  role: 'patient' | 'clinician' | 'tenant_admin',
): { authorization: string } {
  return bearerAuthHeader({ accountId, tenantId: T_GH, countryOfCare: 'GH', role });
}

async function seedAccount(
  accountType: 'patient' | 'tenant_admin',
  tenantId: typeof T_US,
): Promise<AccountId> {
  const accountId = asAccountId(ulid());
  await withTenantContext(tenantId, () =>
    createAccount(
      {
        account_id: accountId,
        tenant_id: tenantId,
        phone_e164: uniquePhone(tenantId === TENANT_GHANA ? '+233' : '+1'),
        first_name: 'Admin',
        last_name: 'Dashboards',
        date_of_birth: '1990-01-01',
        gender: 'prefer_not_to_say',
        country_of_residence: tenantId === TENANT_GHANA ? 'GH' : 'US',
        country_of_care: tenantId === TENANT_GHANA ? 'GH' : 'US',
        account_type: accountType,
      },
      async () => {},
    ),
  );
  return accountId;
}

async function injectDashboard(args: {
  url: string;
  auth: { authorization: string };
  host?: string;
}): Promise<{ statusCode: number; body: string }> {
  return app!.inject({
    method: 'GET',
    url: args.url,
    headers: {
      host: args.host ?? 'localhost',
      ...args.auth,
    },
  });
}

function json<T>(res: { body: string }): T {
  return JSON.parse(res.body) as T;
}

/** Count I-027 read-trail rows for (tenant, dashboard, executor). */
async function countReadTrailRows(
  tenantId: typeof T_US,
  dashboardName: string,
  executorPrincipalId: string,
): Promise<number> {
  return withTenantContext(tenantId, async () => {
    const r = await getTestClient().query(
      `SELECT COUNT(*)::int AS n FROM admin_dashboard_query_execution
        WHERE tenant_id = $1 AND dashboard_name = $2 AND executor_principal_id = $3`,
      [tenantId, dashboardName, executorPrincipalId],
    );
    return (r.rows[0] as { n: number }).n;
  });
}

beforeAll(async () => {
  process.env['NODE_ENV'] = 'test';

  // SI-010 bind-pool provisioning + slice-role membership mirroring
  // (grant-slice-roles helper; every suite grants its own roles because
  // vitest fork order is nondeterministic).
  const superuser = new pg.Client({
    connectionString: process.env['TEST_DATABASE_URL'] as string,
  });
  await superuser.connect();
  try {
    await superuser.query(
      `ALTER ROLE bind_actor_context_role WITH LOGIN PASSWORD '${BIND_ROLE_TEST_PASSWORD}'`,
    );
  } finally {
    await superuser.end();
  }
  await grantSliceRolesToTestApp(ADMIN_SLICE_ROLES);

  const testUrl = new URL(process.env['TEST_DATABASE_URL'] as string);
  testUrl.username = 'bind_actor_context_role';
  testUrl.password = BIND_ROLE_TEST_PASSWORD;
  bindPool = new pg.Pool({ connectionString: testUrl.toString(), max: 2 });
  setBindActorContextTestPool(bindPool as unknown as DbClient);

  app = await buildApp({ logger: false });
  await app.ready();

  usAdmin = await seedAccount('tenant_admin', T_US);
  usPatient = await seedAccount('patient', T_US);
  ghAdmin = await seedAccount('tenant_admin', T_GH);
}, 60_000);

afterAll(async () => {
  clearBindActorContextTestPool();
  if (app !== null) {
    await app.close();
  }
  if (bindPool !== null) {
    await bindPool.end();
  }
});

// ===========================================================================
// Tests. tests/setup.ts wraps EVERY test in a savepoint rolled back at test
// end — each test below is fully self-contained.
// ===========================================================================

describe('admin-dashboards — Group A: crisis-operational-health (the migration 074 regression pin)', () => {
  it('A1. admin token → 200 with rows array + I-027 read-trail row (pre-074: SQLSTATE 42702 at the CTAS OUT-param collision on EVERY call)', async () => {
    const res = await injectDashboard({
      url: DASHBOARD_URLS.crisis,
      auth: usAuth(usAdmin, 'tenant_admin'),
    });
    expect(res.statusCode).toBe(200);
    const body = json<{ rows: Array<{ tenant_id: string }> }>(res);
    expect(Array.isArray(body.rows)).toBe(true);
    // Greenfield test DB: the rollup may legitimately be empty; every row
    // that IS present must be tenant-scoped to the caller.
    for (const row of body.rows) {
      expect(row.tenant_id).toBe(T_US);
    }

    expect(await countReadTrailRows(T_US, 'admin_crisis_operational_health_v', usAdmin)).toBe(1);
  });

  it('A2. two sequential calls → 200 both + one read-trail row each (repeat-call safety per the 044 §1 R1 MED-1 pattern)', async () => {
    const first = await injectDashboard({
      url: DASHBOARD_URLS.crisis,
      auth: usAuth(usAdmin, 'tenant_admin'),
    });
    expect(first.statusCode).toBe(200);
    const second = await injectDashboard({
      url: DASHBOARD_URLS.crisis,
      auth: usAuth(usAdmin, 'tenant_admin'),
    });
    expect(second.statusCode).toBe(200);

    expect(await countReadTrailRows(T_US, 'admin_crisis_operational_health_v', usAdmin)).toBe(2);
  });

  it('A3. patient token → 403 at the LAYER B admin gate; NO read-trail row', async () => {
    const res = await injectDashboard({
      url: DASHBOARD_URLS.crisis,
      auth: usAuth(usPatient, 'patient'),
    });
    expect(res.statusCode).toBe(403);

    expect(await countReadTrailRows(T_US, 'admin_crisis_operational_health_v', usPatient)).toBe(0);
  });
});

describe('admin-dashboards — Group B: consult-queue-health live-PG proof', () => {
  it('B1. admin token → 200 with rows array + I-027 read-trail row (065 §2 wrapper actually plans + runs on live PG)', async () => {
    const res = await injectDashboard({
      url: DASHBOARD_URLS.consult,
      auth: usAuth(usAdmin, 'tenant_admin'),
    });
    expect(res.statusCode).toBe(200);
    const body = json<{ rows: Array<{ tenant_id: string }> }>(res);
    expect(Array.isArray(body.rows)).toBe(true);
    for (const row of body.rows) {
      expect(row.tenant_id).toBe(T_US);
    }

    expect(await countReadTrailRows(T_US, 'admin_consult_queue_health_v', usAdmin)).toBe(1);
  });
});

describe('admin-dashboards — Group C: mode1-volume-health live-PG proof', () => {
  it('C1. admin token → 200 with rows array + I-027 read-trail row (069 §2 wrapper actually plans + runs on live PG)', async () => {
    const res = await injectDashboard({
      url: DASHBOARD_URLS.mode1,
      auth: usAuth(usAdmin, 'tenant_admin'),
    });
    expect(res.statusCode).toBe(200);
    const body = json<{ rows: Array<{ tenant_id: string }> }>(res);
    expect(Array.isArray(body.rows)).toBe(true);
    for (const row of body.rows) {
      expect(row.tenant_id).toBe(T_US);
    }

    expect(await countReadTrailRows(T_US, 'admin_mode1_volume_health_v', usAdmin)).toBe(1);
  });
});

describe('admin-dashboards — Group D: tenant scoping of the read trail (I-023 / I-027)', () => {
  it('D1. Ghana admin on the Ghana host → 200; read-trail row lands under Telecheck-Ghana, not Telecheck-US', async () => {
    const res = await injectDashboard({
      url: DASHBOARD_URLS.crisis,
      auth: ghAuth(ghAdmin, 'tenant_admin'),
      host: 'ghana.heroshealth.com',
    });
    expect(res.statusCode).toBe(200);
    const body = json<{ rows: Array<{ tenant_id: string }> }>(res);
    for (const row of body.rows) {
      expect(row.tenant_id).toBe(T_GH);
    }

    expect(await countReadTrailRows(T_GH, 'admin_crisis_operational_health_v', ghAdmin)).toBe(1);
    expect(await countReadTrailRows(T_US, 'admin_crisis_operational_health_v', ghAdmin)).toBe(0);
  });
});
