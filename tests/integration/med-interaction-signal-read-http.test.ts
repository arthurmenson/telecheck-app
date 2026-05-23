/**
 * med-interaction signal read — HTTP handler test (PR 7).
 *
 * Exercises GET /v0/med-interaction/signals/:id — the first handler of the
 * Med-Interaction series (cockpit Addendum 81: the lowest-risk read
 * endpoint, a pure read via the SECDEF access function from migration 048).
 *
 * Coverage split — what runs in CI here vs. what is deferred:
 *
 *   COVERED (CI-verifiable; these paths short-circuit BEFORE any
 *   med-interaction DB access, so they need only the base Telecheck-US
 *   tenant seed):
 *     - §A 401 when no JWT is presented (LAYER B requireActorContext).
 *     - §B 403 when a patient JWT is presented (patient is NOT a
 *       signal_viewer grantee per SI-019 §RBAC).
 *     - §C clinician JWT passes LAYER B, and a malformed (non-ULID) id
 *       resolves to a tenant-blind 404 (I-025) before the DB read — also
 *       proving the VARCHAR(26)-overflow guard.
 *
 *   DEFERRED (it.todo — requires SECDEF-aware test-harness extension):
 *     The 200 (signal found) and 404 (well-formed id, signal absent in
 *     tenant) paths exercise withDbRole's `SET LOCAL ROLE
 *     medication_interaction_signal_viewer` + the materialized-view read.
 *     The shared test session runs as `telecheck_test_app`
 *     (tests/setup.ts), which is NOT a member of the slice roles (migration
 *     051 grants them to `telecheck_app_role`), so `SET LOCAL ROLE` fails
 *     in the harness today; and the access function reads a materialized
 *     view that must be REFRESHed (owned by `mv_refresh_owner`) after
 *     seeding transition rows. Standing up these paths is the "live-DB
 *     integration tests land alongside the first real handler PR" followup
 *     called out in cockpit Addendum 81 (out-of-scope item #1) and is the
 *     reusable SECDEF-handler test pattern for Crisis Response Sprint 2 +
 *     Admin Backend Sprint 2 too. Tracked as a PR 7 follow-on; the /ready
 *     probe stays 503 until it (and the rest of the handler surface) closes.
 *
 * Spec references:
 *   - SI-019 Medication Interaction Engine Slice PRD v2.0 §5 + §RBAC +
 *     §Sub-decision 9
 *   - I-023 / I-025 (tenant scoping; tenant-blind not-found)
 *   - Master PRD v1.10 §17 + Glossary v5.2 C3 (no tenant_id leak)
 */

import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../../src/app.ts';
import { asTenantId } from '../../src/lib/glossary.ts';
import { ulid } from '../../src/lib/ulid.ts';
import { bearerAuthHeader } from '../helpers/jwt-fixtures.ts';
import { TENANT_US } from '../helpers/tenant-fixtures.ts';

const T_US = asTenantId(TENANT_US);
const US_HOST = 'localhost';

let app: FastifyInstance | null = null;

beforeAll(async () => {
  process.env['NODE_ENV'] = 'test';
  app = await buildApp({ logger: false });
  await app.ready();
});

afterAll(async () => {
  if (app !== null) {
    await app.close();
  }
});

/**
 * No response — success OR error envelope — may leak the literal
 * `tenant_id` key or the operating-tenant identifier (Master PRD §17 + C3).
 */
function expectNoTenantLeak(response: { body: string }): void {
  expect(response.body).not.toContain('"tenant_id"');
  expect(response.body).not.toContain('Telecheck-US');
}

describe('med-interaction signal read — §A authentication (LAYER B)', () => {
  it('§A1 GET /signals/:id without a JWT returns 401', async () => {
    const r = await app!.inject({
      method: 'GET',
      url: `/v0/med-interaction/signals/${ulid()}`,
      headers: { host: US_HOST },
    });
    expect(r.statusCode).toBe(401);
    const body = r.json<{ error: { code: string } }>();
    expect(body.error.code).toBe('internal.auth.unauthenticated');
    expectNoTenantLeak(r);
  });
});

describe('med-interaction signal read — §B role gate (LAYER B)', () => {
  it('§B1 patient JWT returns 403 (patient is not a signal_viewer grantee)', async () => {
    const r = await app!.inject({
      method: 'GET',
      url: `/v0/med-interaction/signals/${ulid()}`,
      headers: {
        host: US_HOST,
        ...bearerAuthHeader({
          accountId: ulid(),
          tenantId: T_US,
          countryOfCare: 'US',
          role: 'patient',
        }),
      },
    });
    expect(r.statusCode).toBe(403);
    const body = r.json<{ error: { code: string } }>();
    expect(body.error.code).toBe('internal.auth.insufficient_scope');
    expectNoTenantLeak(r);
  });
});

describe('med-interaction signal read — §C clinician passes LAYER B; input validation', () => {
  it('§C1 clinician JWT + malformed (non-ULID) id returns tenant-blind 404', async () => {
    const r = await app!.inject({
      method: 'GET',
      // Not a 26-char Crockford-base32 ULID — caught by the handler's shape
      // guard and mapped to 404 before any DB access (also guards the
      // access function's VARCHAR(26) parameter from an overflow 500).
      url: '/v0/med-interaction/signals/not-a-valid-ulid',
      headers: {
        host: US_HOST,
        ...bearerAuthHeader({
          accountId: ulid(),
          tenantId: T_US,
          countryOfCare: 'US',
          role: 'clinician',
        }),
      },
    });
    expect(r.statusCode).toBe(404);
    const body = r.json<{ error: { code: string } }>();
    // Tenant-blind: identical envelope to a well-formed-but-absent id.
    expect(body.error.code).toBe('internal.resource.not_found');
    expectNoTenantLeak(r);
  });

  it('§C2 clinician JWT + over-length id returns tenant-blind 404 (no VARCHAR(26) overflow)', async () => {
    const r = await app!.inject({
      method: 'GET',
      url: `/v0/med-interaction/signals/${'A'.repeat(40)}`,
      headers: {
        host: US_HOST,
        ...bearerAuthHeader({
          accountId: ulid(),
          tenantId: T_US,
          countryOfCare: 'US',
          role: 'clinician',
        }),
      },
    });
    expect(r.statusCode).toBe(404);
    const body = r.json<{ error: { code: string } }>();
    expect(body.error.code).toBe('internal.resource.not_found');
    expectNoTenantLeak(r);
  });
});

describe('med-interaction signal read — §D live-DB read path (deferred)', () => {
  // Requires the SECDEF-aware test-harness extension described in the file
  // header: grant the shared test session membership in
  // medication_interaction_signal_viewer + mv_refresh_owner (with
  // NOINHERIT-equivalent per-membership options matching migration 051), and
  // a seed→REFRESH MATERIALIZED VIEW helper. This is the reusable pattern
  // for all three SECDEF slices (Med-Interaction / Crisis / Admin).
  it.todo('§D1 clinician JWT + seeded active signal returns 200 with current-state projection');
  it.todo('§D2 clinician JWT + well-formed id absent in tenant returns tenant-blind 404 (I-025)');
  it.todo(
    '§D3 cross-tenant: signal seeded in Telecheck-Ghana is invisible to a Telecheck-US clinician (404)',
  );
});
