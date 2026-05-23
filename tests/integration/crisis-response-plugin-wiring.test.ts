/**
 * crisis-response slice — plugin wiring smoke test.
 *
 * Sprint 1 of 4 for this slice (PR 7 — Fastify module scaffold).
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
  it('§1a GET /v0/crisis-events/health returns 200 (liveness — module alive) with Sprint 1 skeleton metadata', async () => {
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
    expect(body.blocked).toContain('Sprint 1 of 4');
    expect(body.blocked_message).toContain('DB layer COMPLETE through migration 038');
  });

  it('§1b GET /v0/crisis-events/ready returns 503 (readiness — handlers not yet mounted) with BLOCKED reason', async () => {
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
    expect(body.reason).toBe('handlers_not_yet_implemented');
    expect(body.reason_message).toContain('Sprint 4');
  });

  it('§1c POST /v0/crisis-events returns 404 (route NOT mounted at v0.1; lands in Sprint 2)', async () => {
    const r = await app!.inject({
      method: 'POST',
      url: '/v0/crisis-events',
      headers: { host: 'localhost', 'content-type': 'application/json' },
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
