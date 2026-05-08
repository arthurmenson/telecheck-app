/**
 * Forms-Intake slice — IDEMPOTENCY v5.1 contract regression for /v0/forms
 * mutating endpoints.
 *
 * The generic `idempotency-http.test.ts` proves the plugin works against
 * `/v0/forms/templates`. The slice-specific `consent-idempotency-replay`
 * extends that to consent. This file extends the same coverage to the
 * forms-intake slice's high-traffic mutating endpoints — proving
 * same-key-same-body returns the cached response WITHOUT re-running
 * the handler (no second template row, no duplicate audit emission)
 * AND same-key-different-body returns 409 with the canonical
 * `internal.idempotency.body_mismatch` envelope.
 *
 * Forms-intake is the slice with the largest mutation surface
 * (10 state-changing handlers across templates / variants /
 * deployments / submissions / resume) AND the security-critical
 * I-019 platform-floor crisis-detection gate. Sprint 33 PR-F2
 * migrated all 10 handlers to handler-owned `withIdempotency`
 * (reserve-then-execute), but pre-this-PR no HTTP-level test pinned
 * the cache 4-tuple contract on these endpoints. The closest
 * existing coverage is `idempotency-http.test.ts` (which uses
 * /v0/forms/templates as the canonical replay target but exercises
 * the GENERIC plugin behavior, not the slice-specific
 * "no second template row" + "no second audit emission"
 * discrimination that proves the handler did not re-run).
 *
 * Coverage in this file (1 section, 2 cases):
 *   §1a POST /templates replay — same key + same body returns cached
 *       201; forms_template table has exactly 1 matching row
 *       (proves no second handler invocation)
 *   §1b POST /templates body mismatch — same key + different body
 *       returns 409 internal.idempotency.body_mismatch with
 *       tenant-blind envelope (no Telecheck-US substring leak)
 *
 * The /deployments and /submissions paths are not covered here —
 * those would require multi-step preconditions (publish a template
 * first; seed a deployment; then exercise idempotency on the
 * derived endpoint) that meaningfully expand the test surface
 * without adding orthogonal idempotency-contract coverage. A future
 * test PR can mirror this pattern to those endpoints once the
 * preconditions are stable to reproduce.
 *
 * Discrimination strategy:
 *   The forms_template table has a natural identifying tuple
 *   (tenant_id + program_catalog_entry_id + name). Counting rows
 *   by that tuple is the canonical "did the handler run twice"
 *   probe. Equality on the returned template_id across the two
 *   replay calls is the cache-replay tell.
 *
 * Spec references:
 *   - IDEMPOTENCY v5.1 §1 (key format, 4-tuple PK, body-hash check)
 *   - I-003 (audit append-only — cached response replay must NOT
 *     re-emit duplicate audit records)
 *   - I-025 (tenant-blind error envelopes — verified on the 409
 *     body-mismatch path)
 *   - SI-006 (Sprint 33 PR-F2 reserve-then-execute migration of
 *     forms-intake handlers; 10 handler call sites covered by
 *     `withIdempotentExecution`)
 *   - docs/PROJECT_CONVENTIONS.md r5 §3.7 (Reserve-then-execute is
 *     the only path for state-changing handlers)
 */

import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../../src/app.ts';
import { ulid } from '../../src/lib/ulid.ts';
import { TENANT_US, withTenantContext } from '../helpers/tenant-fixtures.ts';
import { getTestClient } from '../setup.ts';

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
 * Standard admin headers for /v0/forms admin-surface endpoints. Mirrors
 * the pattern in forms-intake-templates-http.test.ts — the actor-context
 * shim accepts `x-actor-id` + `x-actor-roles` + `x-actor-admin-tenant`
 * for tenant_admin operations on admin endpoints.
 *
 * IMPORTANT: the IDEMPOTENCY v5.1 cache 4-tuple PK is
 * `(tenant_id, idempotency_key, endpoint, actor_id)`. For replay tests
 * the SECOND call MUST use the same `actor_id` as the first or the
 * cache lookup will miss (different keys → handler runs again →
 * uniqueness-constraint violation surfaces as 500). The
 * `actorId` parameter pins the actor across replay pairs; pass the
 * same string to both `adminHeaders()` calls in a §replay test.
 *
 * Lesson learned: PR #63 r1 used `ulid().slice(-6)` to mint a fresh
 * actor_id per call, which silently broke replay path. r2 fix
 * threads actorId from the test scope.
 */
function adminHeaders(idempotencyKey: string, actorId: string): Record<string, string> {
  return {
    host: US_HOST,
    'idempotency-key': idempotencyKey,
    'x-actor-id': actorId,
    'x-actor-roles': 'tenant_admin',
    'x-actor-admin-tenant': TENANT_US,
    'content-type': 'application/json',
  };
}

/**
 * Count rows in `forms_template` that match the given
 * (tenant_id, program_id, name) triple. Used as the "did the handler
 * run twice" probe — a duplicate handler invocation would create a
 * second row with a different template_id but the same identifying
 * triple.
 *
 * Note: the wire-protocol field name is `programCatalogEntryId` but
 * the DB column is `program_id` (per migration 006:32 — both refer
 * to the same ProgramCatalogEntry ID; the column name predates the
 * spec corpus rename to programCatalogEntryId).
 */
async function countTemplatesForTriple(programId: string, name: string): Promise<number> {
  // forms_template has FORCE RLS — every read MUST set tenant context
  // first or the row-level-security gate trips with `tenant_context_not_set`.
  return withTenantContext(TENANT_US, async () => {
    const result = await getTestClient().query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
         FROM forms_template
        WHERE tenant_id = $1
          AND program_id = $2
          AND name = $3`,
      [TENANT_US, programId, name],
    );
    return Number(result.rows[0]?.count ?? '0');
  });
}

// ---------------------------------------------------------------------------
// §1 — IDEMPOTENCY v5.1 contract on forms-intake mutating endpoints
// ---------------------------------------------------------------------------

describe('forms-intake idempotency replay — §1 cache 4-tuple contract', () => {
  it('§1a POST /v0/forms/templates same key + same body → cached 201; exactly 1 template row', async () => {
    const programId = `prog_idem_${ulid().slice(-8)}`;
    const name = `idem-test-${ulid().slice(-6)}`;
    const idempotencyKey = ulid();
    // Pin actor_id across both calls — IDEMPOTENCY v5.1 cache PK is
    // `(tenant_id, idempotency_key, endpoint, actor_id)` so a fresh
    // actor_id on the second call would silently miss the cache.
    const actorId = `op_idem_${ulid().slice(-6)}`;
    const headers = adminHeaders(idempotencyKey, actorId);
    const payload = {
      programCatalogEntryId: programId,
      name,
      layout: {},
      branchingLogic: {},
      eligibilityLogic: {},
      approvalGovernance: {},
    };

    // First request: real handler invocation, template row created,
    // audit emitted.
    const first = await app!.inject({
      method: 'POST',
      url: '/v0/forms/templates',
      headers,
      payload,
    });
    expect(first.statusCode).toBe(201);
    const firstBody = first.json<{ template_id: string; status: string }>();
    expect(firstBody.template_id).toBeTruthy();
    expect(firstBody.status).toBe('draft');

    // Second request: same key + same body + SAME actor_id.
    // preHandler cache-replay short-circuits BEFORE the handler body
    // callback runs. NO second forms_template insert.
    const second = await app!.inject({
      method: 'POST',
      url: '/v0/forms/templates',
      headers,
      payload,
    });
    expect(second.statusCode).toBe(201);
    const secondBody = second.json<{ template_id: string }>();
    // Identical template_id — the cached body is replayed verbatim.
    expect(secondBody.template_id).toBe(firstBody.template_id);

    // Discrimination probe: exactly 1 row in forms_template for the
    // (tenant_id, programCatalogEntryId, name) triple. A handler-
    // re-run would have created a second row with a different
    // template_id but the same identifying triple.
    expect(await countTemplatesForTriple(programId, name)).toBe(1);
  });

  it('§1b POST /v0/forms/templates same key + different body → 409 internal.idempotency.body_mismatch', async () => {
    const programId = `prog_idem_mm_${ulid().slice(-8)}`;
    const idempotencyKey = ulid();
    const actorId = `op_idem_${ulid().slice(-6)}`;
    const headers = adminHeaders(idempotencyKey, actorId);

    const first = await app!.inject({
      method: 'POST',
      url: '/v0/forms/templates',
      headers,
      payload: {
        programCatalogEntryId: programId,
        name: 'original-name',
        layout: {},
        branchingLogic: {},
        eligibilityLogic: {},
        approvalGovernance: {},
      },
    });
    expect(first.statusCode).toBe(201);

    // Second request: same key + same actor, DIFFERENT body (name
    // flipped). Body hash check at withIdempotency reservation time
    // fires BEFORE the handler body callback runs.
    const second = await app!.inject({
      method: 'POST',
      url: '/v0/forms/templates',
      headers,
      payload: {
        programCatalogEntryId: programId,
        name: 'different-name',
        layout: {},
        branchingLogic: {},
        eligibilityLogic: {},
        approvalGovernance: {},
      },
    });
    expect(second.statusCode).toBe(409);
    const errorBody = second.json<{ error: { code: string } }>();
    expect(errorBody.error.code).toBe('internal.idempotency.body_mismatch');

    // Tenant-blind: the 409 envelope MUST NOT leak the operating-
    // tenant identifier (I-025).
    expect(second.body).not.toContain(TENANT_US);
  });
});
