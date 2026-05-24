/**
 * crisis-response slice — plugin wiring smoke test.
 *
 * Sprint 2 of 4 for this slice — first real handler merged (Sprint 2 PR 1:
 * GET /v0/crisis-events/:id staff-scoped read, commit e4cb312). The skeleton
 * /health + /ready introspection text advanced when that handler landed, so
 * the §1a/§1b assertions below track the v0.2 wording, and §1c now asserts the
 * global idempotency guard's 400 (it precedes routing) rather than the v0.1
 * route-not-mounted 404. Standalone stale-assertion reconciliation in the
 * spirit of PR #193 (ai-service /health + /ready introspection accuracy);
 * remaining write-path handlers (acknowledge/respond/resolve/sweep) ride the
 * May-26 cascade and will advance this introspection again.
 *
 * The DB layer is COMPLETE through migration 038 (PRs 1-6 on `main`; 18
 * rounds of Codex APPROVE; 6 tables + 2 views + 6 SECDEF procedures +
 * 15 RBAC roles). The TypeScript application layer is at Sprint 1 —
 * module skeleton + public interface + branded ID types + canonical
 * state/classification vocabularies. Handler implementation +
 * application-layer audit emission + KMS envelope + cross-tenant
 * isolation tests land across Sprints 2-4.
 *
 * At v0.1 we ship the directory + plugin shell so that:
 *   1. The module boundary (per ADR-001) is established now
 *   2. App-level wiring (`src/app.ts`) is stable across sprints
 *   3. Cross-module callers can typed-import branded ID types +
 *      crisis-type/severity/state vocabularies ahead of full
 *      implementation (Admin Backend operator dashboards,
 *      Notification dispatch, Adverse Events all reference Crisis
 *      Response types per SI-022 + downstream PRDs)
 *
 * This test asserts the only currently-mounted routes return the
 * documented SKELETON state — liveness/readiness split applied per the
 * canonical BLOCKED-aware skeleton pattern (5th application after
 * pharmacy / med-interaction / subscription / async-consult).
 *
 * Spec references:
 *   - SI-022 Crisis Response Slice v1.0 (RATIFIED 2026-05-21 P-039)
 *   - CDM v1.9 → v1.10 Amendment (RATIFIED 2026-05-21 P-040)
 *   - src/modules/crisis-response/README.md
 *   - docs/crisis-response-implementation-plan.md
 *   - ADR-001 (modular monolith)
 */

import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../../src/app.ts';

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

describe('crisis-response slice — §1 plugin wiring', () => {
  it('§1a GET /v0/crisis-events/health returns 200 (liveness — module alive) with Sprint 2 v0.2 metadata', async () => {
    const r = await app!.inject({
      method: 'GET',
      url: '/v0/crisis-events/health',
      headers: { host: 'localhost' },
    });
    expect(r.statusCode).toBe(200);
    const body = r.json() as {
      status: string;
      module: string;
      blocked: string;
      blocked_message: string;
    };
    expect(body.status).toBe('ok');
    expect(body.module).toBe('crisis-response');
    expect(body.blocked).toContain('Sprint 2 of 4 at v0.2');
    expect(body.blocked_message).toContain('DB layer COMPLETE through migration 038');
  });

  it('§1b GET /v0/crisis-events/ready returns 503 (readiness — write-path handlers not yet mounted) with BLOCKED reason', async () => {
    const r = await app!.inject({
      method: 'GET',
      url: '/v0/crisis-events/ready',
      headers: { host: 'localhost' },
    });
    expect(r.statusCode).toBe(503);
    const body = r.json() as {
      status: string;
      module: string;
      reason: string;
      reason_message: string;
    };
    expect(body.status).toBe('unavailable');
    expect(body.module).toBe('crisis-response');
    expect(body.reason).toBe('write_path_handlers_not_yet_implemented');
    expect(body.reason_message).toContain('Sprint 4');
  });

  // §1c — paired-probe coverage proving the write collection-root POST is
  // still NOT mounted (initiate lands in PR #201 of the Sprint 2 cascade).
  // Codex R1 follow-up (2026-05-24): the single 400 assertion was forward-
  // stable (would keep passing even after the handler mounts, because it
  // deliberately omits Idempotency-Key) and thus stopped proving "no mounted
  // write handler." Replaced with a PAIR of probes that together hold the
  // wiring honest:
  //
  //   §1c-guard: POST WITHOUT Idempotency-Key → 400
  //     Exercises the global idempotency preHandler guard
  //     (`internal.idempotency.missing_key`). The guard fires before routing.
  //     Forward-stable (will keep passing post-handler-mount).
  //
  //   §1c-route: POST WITH Idempotency-Key → 404
  //     Bypasses the idempotency guard and lets the request reach the router,
  //     which currently has no matching write route. Forward-CHANGING: when
  //     PR #201 lands and mounts the actual initiate handler, this assertion
  //     will start failing — at which point this §1c-route block gets
  //     advanced to the next chain link's status code (probably 401
  //     unauthenticated or 422 schema-invalid, depending on what fires next).
  //     That failure is the wiring-honesty signal we want.
  //
  // Together the pair proves BOTH (a) the global idempotency guard fires
  // before routing AND (b) the router currently lands on no-such-route. This
  // is route-specific coverage that holds the wiring honest across the
  // Sprint 2 cascade.
  it('§1c-guard POST /v0/crisis-events returns 400 (idempotency guard precedes routing; no Idempotency-Key)', async () => {
    const r = await app!.inject({
      method: 'POST',
      url: '/v0/crisis-events',
      headers: { host: 'localhost', 'content-type': 'application/json' },
      payload: {},
    });
    expect(r.statusCode).toBe(400);
    const body = r.json() as { error: { code: string } };
    expect(body.error.code).toBe('internal.idempotency.missing_key');
  });

  it('§1c-route POST /v0/crisis-events with Idempotency-Key returns 404 (route still not mounted)', async () => {
    const r = await app!.inject({
      method: 'POST',
      url: '/v0/crisis-events',
      headers: {
        host: 'localhost',
        'content-type': 'application/json',
        'idempotency-key': '00000000-0000-0000-0000-000000000000',
      },
      payload: {},
    });
    expect(r.statusCode).toBe(404);
  });

  // R1 MED closure 2026-05-22 (PR 7 Codex review): probe paths must reach
  // the handler WITHOUT relying on a resolvable Host header. tenantContextPlugin
  // rejects unresolvable Hosts before the handler runs — so the probe must be
  // in `allowlistedPaths`. These tests assert the allowlist actually bypasses
  // tenant resolution for the new probes (would fail with 400 otherwise).
  it('§1d GET /v0/crisis-events/health works without a resolvable Host header (allowlisted)', async () => {
    const r = await app!.inject({
      method: 'GET',
      url: '/v0/crisis-events/health',
      headers: { host: 'unresolved.load-balancer.invalid' },
    });
    expect(r.statusCode).toBe(200);
  });

  it('§1e GET /v0/crisis-events/ready works without a resolvable Host header (allowlisted)', async () => {
    const r = await app!.inject({
      method: 'GET',
      url: '/v0/crisis-events/ready',
      headers: { host: 'unresolved.load-balancer.invalid' },
    });
    expect(r.statusCode).toBe(503);
  });
});
