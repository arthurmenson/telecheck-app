/**
 * admin-cross-tenant-isolation.test.ts — live-PostgreSQL HTTP integration
 * tests proving I-023 (tenant isolation) + I-025 (tenant-blind errors) on
 * the SI-023 Admin Backend surface (Sprint 4 hardening, 2026-07-09).
 *
 * This is the cross-tenant-isolation suite called for by the Sprint 4
 * hardening set (README §"Sprint 4 — Hardening": "Cross-tenant isolation
 * tests (the wrapper-level LAYER C is one defense; the route-level LAYER B
 * is the other)"). It complements admin-dashboards-http.test.ts (which
 * proves the wrappers plan + run on live PG) by focusing exclusively on
 * the tenant-boundary guarantees across BOTH read (dashboard) and write
 * (template submit) admin surfaces.
 *
 * The isolation guarantees under test:
 *
 *   1. **Dashboard reads are tenant-scoped.** A US admin reading a
 *      dashboard on the US host gets ONLY Telecheck-US rows; the I-027
 *      read-trail row lands under Telecheck-US. (Group A)
 *   2. **A US-issued admin JWT cannot administer Telecheck-Ghana.** Sent
 *      to the Ghana host, the authContextPlugin rejects the tenant_id
 *      claim mismatch (cross-tenant token forge defense) → actorContext
 *      undefined → the LAYER B gate 401s tenant-blind. NO Ghana read-trail
 *      row is created (the request never reaches the wrapper). This is the
 *      I-023 + I-025 boundary: an admin bound to tenant A gets a
 *      tenant-blind denial on tenant B, with no cross-tenant data leak +
 *      no side-effect. (Group B)
 *   3. **The read-trail is per-tenant separated.** A Ghana admin's read
 *      lands ONLY under Telecheck-Ghana, never under Telecheck-US, and
 *      vice-versa. (Group C)
 *   4. **The write surface (template submit) enforces the same boundary.**
 *      A US-issued admin JWT on the Ghana host is denied tenant-blind; no
 *      forms_template_admin_review row is created under Ghana. (Group D)
 *
 * WHY the cross-tenant denial is a 401 (not 403): the authContextPlugin
 * verifies the JWT's tenant_id claim against the request's resolved tenant
 * context (Host header → tenant). A US-issued JWT (tenant_id claim =
 * Telecheck-US) sent to the Ghana host (resolved tenant = Telecheck-Ghana)
 * fails the claim-vs-context equality check → the plugin leaves
 * actorContext undefined WITHOUT distinguishing "wrong tenant" from
 * "no auth" (tenant-blind per I-025). The downstream requireSliceRoleMembership
 * → requireAdminRole sees actorContext undefined + bearerTokenPresented
 * true → 401 ("could not be verified"). The response body carries NO
 * tenant identifiers.
 *
 * Exercises the REAL composition end-to-end (same harness as
 * admin-dashboards-http.test.ts): JWT verify → SI-010 bind → tenant
 * context → LAYER B slice-role-membership gate → SET LOCAL ROLE
 * admin_basic_operator → SECDEF wrapper → co-transactional read-trail +
 * Cat A audit.
 *
 * Spec references: SI-023 v1.0 P-041 §5; I-023 (three-layer tenancy),
 * I-025 (tenant-blind errors), I-027 (per-tenant audit trail); migrations
 * 039-044, 065, 069, 074; auth-context.ts (cross-tenant token-forge
 * defense).
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

/** Both SI-023 slice roles so the write-surface (submit) path elevates too. */
const ADMIN_SLICE_ROLES = ['admin_basic_operator', 'admin_template_reviewer'] as const;

const US_HOST = 'localhost'; // resolves to Telecheck-US per tenant-context dev alias
const GH_HOST = 'ghana.heroshealth.com';

const DASHBOARD_CRISIS = '/v1/admin/dashboards/crisis-operational-health';
const CRISIS_DASHBOARD_VIEW = 'admin_crisis_operational_health_v';

let app: FastifyInstance | null = null;
let bindPool: pg.Pool | null = null;

let usAdmin: AccountId;
let ghAdmin: AccountId;

function usAdminAuth(accountId: string): { authorization: string } {
  return bearerAuthHeader({
    accountId,
    tenantId: T_US,
    countryOfCare: 'US',
    role: 'tenant_admin',
  });
}

function ghAdminAuth(accountId: string): { authorization: string } {
  return bearerAuthHeader({
    accountId,
    tenantId: T_GH,
    countryOfCare: 'GH',
    role: 'tenant_admin',
  });
}

async function seedAdmin(tenantId: typeof T_US): Promise<AccountId> {
  const accountId = asAccountId(ulid());
  await withTenantContext(tenantId, () =>
    createAccount(
      {
        account_id: accountId,
        tenant_id: tenantId,
        phone_e164: uniquePhone(tenantId === TENANT_GHANA ? '+233' : '+1'),
        first_name: 'Admin',
        last_name: 'CrossTenant',
        date_of_birth: '1990-01-01',
        gender: 'prefer_not_to_say',
        country_of_residence: tenantId === TENANT_GHANA ? 'GH' : 'US',
        country_of_care: tenantId === TENANT_GHANA ? 'GH' : 'US',
        account_type: 'tenant_admin',
      },
      async () => {},
    ),
  );
  return accountId;
}

async function injectGet(args: {
  url: string;
  auth: { authorization: string };
  host: string;
}): Promise<{ statusCode: number; body: string }> {
  return app!.inject({
    method: 'GET',
    url: args.url,
    headers: { host: args.host, ...args.auth },
  });
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

/** Count Cat A admin.dashboard_query_executed audit rows for a tenant + executor. */
async function countDashboardAuditRows(
  tenantId: typeof T_US,
  executorPrincipalId: string,
): Promise<number> {
  return withTenantContext(tenantId, async () => {
    const r = await getTestClient().query(
      `SELECT COUNT(*)::int AS n FROM audit_records
        WHERE tenant_id = $1 AND action = 'admin.dashboard_query_executed'
          AND actor_id = $2`,
      [tenantId, executorPrincipalId],
    );
    return (r.rows[0] as { n: number }).n;
  });
}

beforeAll(async () => {
  process.env['NODE_ENV'] = 'test';

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

  usAdmin = await seedAdmin(T_US);
  ghAdmin = await seedAdmin(T_GH);
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
// tests/setup.ts wraps EVERY test in a savepoint rolled back at test end —
// each test below is self-contained.
// ===========================================================================

describe('admin cross-tenant isolation — Group A: same-tenant baseline (I-023 scoping)', () => {
  it('A1. US admin on US host → 200; every row is Telecheck-US; read-trail + Cat A audit under Telecheck-US', async () => {
    const res = await injectGet({
      url: DASHBOARD_CRISIS,
      auth: usAdminAuth(usAdmin),
      host: US_HOST,
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { rows: Array<{ tenant_id: string }> };
    for (const row of body.rows) {
      expect(row.tenant_id).toBe(T_US);
    }
    expect(await countReadTrailRows(T_US, CRISIS_DASHBOARD_VIEW, usAdmin)).toBe(1);
    // Sprint 4 Cat A emission proof: exactly one dashboard_query_executed
    // audit under the caller's tenant.
    expect(await countDashboardAuditRows(T_US, usAdmin)).toBe(1);
  });
});

describe('admin cross-tenant isolation — Group B: US admin JWT cannot administer Ghana (I-023/I-025)', () => {
  it('B1. US-issued admin JWT on the GHANA host → tenant-blind denial (401/403); body leaks NO tenant identifiers; NO Ghana read-trail row', async () => {
    const res = await injectGet({
      url: DASHBOARD_CRISIS,
      auth: usAdminAuth(usAdmin), // tenant_id claim = Telecheck-US
      host: GH_HOST, // resolved tenant = Telecheck-Ghana
    });

    // Cross-tenant token forge is rejected at the auth boundary. The
    // canonical response is tenant-blind (401 from the LAYER B gate when
    // actorContext is undefined + bearerTokenPresented; the exact code is
    // an auth-boundary detail — assert it is a denial, not a 200/500).
    expect([401, 403]).toContain(res.statusCode);
    expect(res.statusCode).not.toBe(200);
    expect(res.statusCode).not.toBe(500);

    // I-025: the response body must NOT reveal either tenant's identity or
    // any cross-tenant existence signal.
    expect(res.body).not.toContain('Telecheck-US');
    expect(res.body).not.toContain('Telecheck-Ghana');

    // I-023 side-effect isolation: the request never reached the wrapper,
    // so NO Ghana read-trail row was written for this US admin.
    expect(await countReadTrailRows(T_GH, CRISIS_DASHBOARD_VIEW, usAdmin)).toBe(0);
    // And no Cat A audit under Ghana for the US admin.
    expect(await countDashboardAuditRows(T_GH, usAdmin)).toBe(0);
  });
});

describe('admin cross-tenant isolation — Group C: per-tenant read-trail separation (I-027)', () => {
  it('C1. Ghana admin on Ghana host → 200; read-trail + Cat A audit land under Telecheck-Ghana, NEVER under Telecheck-US', async () => {
    const res = await injectGet({
      url: DASHBOARD_CRISIS,
      auth: ghAdminAuth(ghAdmin),
      host: GH_HOST,
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { rows: Array<{ tenant_id: string }> };
    for (const row of body.rows) {
      expect(row.tenant_id).toBe(T_GH);
    }
    // Trail + audit under Ghana; strictly zero cross-tenant bleed into US.
    expect(await countReadTrailRows(T_GH, CRISIS_DASHBOARD_VIEW, ghAdmin)).toBe(1);
    expect(await countReadTrailRows(T_US, CRISIS_DASHBOARD_VIEW, ghAdmin)).toBe(0);
    expect(await countDashboardAuditRows(T_GH, ghAdmin)).toBe(1);
    expect(await countDashboardAuditRows(T_US, ghAdmin)).toBe(0);
  });
});

describe('admin cross-tenant isolation — Group D: write surface enforces the same boundary', () => {
  it('D1. US-issued admin JWT submitting a template on the GHANA host → tenant-blind denial; NO Ghana review row created', async () => {
    // A syntactically-valid (26-char ULID) template_id that need not exist —
    // the request must be denied at the auth boundary BEFORE any DB lookup,
    // so the template's existence is irrelevant to the isolation proof.
    const templateId = ulid();
    const res = await app!.inject({
      method: 'POST',
      url: `/v1/admin/templates/${templateId}/submit-for-review`,
      headers: {
        host: GH_HOST, // resolved tenant = Telecheck-Ghana
        'idempotency-key': ulid(),
        ...usAdminAuth(usAdmin), // tenant_id claim = Telecheck-US
      },
      payload: {},
    });

    expect([401, 403]).toContain(res.statusCode);
    expect(res.statusCode).not.toBe(200);
    expect(res.statusCode).not.toBe(201);
    expect(res.body).not.toContain('Telecheck-US');
    expect(res.body).not.toContain('Telecheck-Ghana');

    // Side-effect isolation: no review row landed under Ghana for this
    // cross-tenant submit attempt.
    const reviewCount = await withTenantContext(T_GH, async () => {
      const r = await getTestClient().query(
        `SELECT COUNT(*)::int AS n FROM forms_template_admin_review
          WHERE tenant_id = $1 AND submitter_principal_id = $2`,
        [T_GH, usAdmin],
      );
      return (r.rows[0] as { n: number }).n;
    });
    expect(reviewCount).toBe(0);
  });
});
