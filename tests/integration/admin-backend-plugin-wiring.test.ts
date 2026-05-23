/**
 * admin-backend slice — plugin wiring smoke test.
 *
 * Sprint 2 of N for this slice — first real handler merged (Sprint 2 PR 1:
 * GET /v1/admin/dashboards/crisis-operational-health, commit e4cb312). The
 * skeleton /health + /ready introspection text advanced when that handler
 * landed, so the §1a/§1b assertions below track the v0.2 wording, and §1c now
 * asserts the global idempotency guard's 400 (it precedes routing) rather than
 * the v0.1 route-not-mounted 404. Standalone stale-assertion reconciliation in
 * the spirit of PR #193 (ai-service /health + /ready introspection accuracy);
 * the remaining template write handlers (submit + decision) ride the May-26
 * cascade and will advance this introspection again.
 *
 * The DB layer is COMPLETE through migration 044 (PRs 1-5 on `main`; 14
 * rounds of Codex APPROVE; 4 tables + 2 views + 4 SECDEF procedures +
 * 12 RBAC roles; 2 dashboard views + 2 dashboard wrappers DEFERRED per
 * Option 2 carryforward). The TypeScript application layer is at Sprint 1
 * — module skeleton + public interface + branded ID types + canonical
 * lifecycle-state + decision + dashboard-name vocabularies. Handler
 * implementation + Cat A audit emission + LAYER B role-membership check
 * + integration tests land across Sprints 2-N.
 *
 * At v0.1 we ship the directory + plugin shell so that:
 *   1. The module boundary (per ADR-001) is established now
 *   2. App-level wiring (`src/app.ts`) is stable across sprints
 *   3. Cross-module callers can typed-import branded ID types +
 *      lifecycle-state / decision / dashboard-name vocabularies ahead of
 *      full implementation (Forms Intake admin-review gate;
 *      future ops surfaces all reference Admin Backend types per
 *      SI-023 + downstream PRDs)
 *
 * This test asserts the only currently-mounted routes return the
 * documented SKELETON state — liveness/readiness split applied per the
 * canonical BLOCKED-aware skeleton pattern (6th application after
 * pharmacy / med-interaction / subscription / async-consult /
 * crisis-response).
 *
 * Spec references:
 *   - SI-023 Admin Backend Basics Slice v1.0 (RATIFIED 2026-05-22 P-041)
 *   - CDM v1.10 → v1.11 Amendment (RATIFIED 2026-05-22 P-042)
 *   - src/modules/admin-backend/README.md
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

describe('admin-backend slice — §1 plugin wiring', () => {
  it('§1a GET /v1/admin/health returns 200 (liveness — module alive) with Sprint 2 v0.2 metadata', async () => {
    const r = await app!.inject({
      method: 'GET',
      url: '/v1/admin/health',
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
    expect(body.module).toBe('admin-backend');
    expect(body.blocked).toContain('Sprint 2 PR 1 of N at v0.2');
    expect(body.blocked_message).toContain('DB layer COMPLETE through migration 044');
  });

  it('§1b GET /v1/admin/ready returns 503 (readiness — full surface incomplete) with BLOCKED reason', async () => {
    const r = await app!.inject({
      method: 'GET',
      url: '/v1/admin/ready',
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
    expect(body.module).toBe('admin-backend');
    expect(body.reason).toBe('partial_handlers_mounted_full_surface_incomplete');
    expect(body.reason_message).toContain('Sprint 4');
  });

  // §1c — the template submit-for-review write route is still NOT mounted
  // (submit + decision land in the Sprint 2 cascade). At v0.1 this surfaced as
  // a 404 from the router. It now surfaces as a 400 from the global idempotency
  // preHandler guard (`internal.idempotency.missing_key`): every state-changing
  // request without an Idempotency-Key is rejected before routing can produce a
  // 404. This 400 is forward-stable — it holds even after the write handler
  // mounts, because this probe deliberately sends no Idempotency-Key. The
  // assertion thus still proves "no mounted write handler served this request".
  it('§1c POST /v1/admin/templates/:id/submit-for-review returns 400 (idempotency guard precedes routing; no Idempotency-Key)', async () => {
    const r = await app!.inject({
      method: 'POST',
      url: '/v1/admin/templates/01H8Z6QY9V3MF8KR7XJW2NTPDB/submit-for-review',
      headers: { host: 'localhost', 'content-type': 'application/json' },
      payload: {},
    });
    expect(r.statusCode).toBe(400);
    const body = r.json() as { error: { code: string } };
    expect(body.error.code).toBe('internal.idempotency.missing_key');
  });

  // Probe paths must reach the handler WITHOUT relying on a resolvable
  // Host header. tenantContextPlugin rejects unresolvable Hosts before the
  // handler runs — so the probe must be in `allowlistedPaths`. These tests
  // assert the allowlist actually bypasses tenant resolution for the new
  // probes (would fail with 400 otherwise).
  it('§1d GET /v1/admin/health works without a resolvable Host header (allowlisted)', async () => {
    const r = await app!.inject({
      method: 'GET',
      url: '/v1/admin/health',
      headers: { host: 'unresolved.load-balancer.invalid' },
    });
    expect(r.statusCode).toBe(200);
  });

  it('§1e GET /v1/admin/ready works without a resolvable Host header (allowlisted)', async () => {
    const r = await app!.inject({
      method: 'GET',
      url: '/v1/admin/ready',
      headers: { host: 'unresolved.load-balancer.invalid' },
    });
    expect(r.statusCode).toBe(503);
  });
});
