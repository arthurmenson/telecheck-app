/**
 * med-interaction slice — plugin wiring smoke test.
 *
 * Sprint 1 / PR 6 of 6 (the final DB-layer scaffold-update PR) of the
 * post-P-033/P-034 ratified Med-Interaction Engine implementation series.
 *
 * Spec layer COMPLETE: SI-019 Med-Interaction Engine Slice PRD v2.0
 * RATIFIED 2026-05-21 P-033 + CDM v1.6 → v1.7 + AUDIT_EVENTS v5.8 → v5.9
 * + OpenAPI v0.2 → v0.3 + State Machines v1.1 → v1.2 + RBAC v1.1 → v1.2
 * RATIFIED P-034. DB layer COMPLETE through migration 050 (PRs 1-5 merged;
 * 21 Codex adversarial-review rounds total): 12 RBAC roles (046) +
 * 4 entities + RLS + per-table append-only + server-assigned monotonic-
 * ordering triggers (047) + SECURITY BARRIER view + optional MV + SECDEF
 * access function with MV access-discipline (048) + raw lifecycle writer
 * SECDEF + anti-bypass EXECUTE matrix + STEP-3.5 advisory-locked
 * activation-override-evidence check (049) + 6 reason-specific wrappers
 * (050; 3 operational + 3 fail-closed pending evidence-source migrations).
 * Subsequent PRs (7+) land Fastify handler implementation + Cat A audit
 * emission + LAYER B role-membership check + integration tests.
 *
 * At this PR we ship the directory + plugin shell so that:
 *   1. The module boundary (per ADR-001) is established
 *   2. App-level wiring (`src/app.ts`) is stable across the upcoming PRs
 *   3. Cross-module callers can typed-import branded ID types ahead of
 *      full handler implementation (Pharmacy clinician-commit gate per
 *      I-002; Async Consult; Mode 2 protocol agents)
 *
 * This test asserts the only currently-mounted routes return the
 * documented SKELETON state — liveness/readiness split applies the
 * canonical BLOCKED-aware pattern (pharmacy / med-interaction's own
 * prior skeleton / subscription / async-consult / crisis-response /
 * admin-backend modules). The /ready reason now reflects
 * handlers_not_yet_implemented (post-P-033/P-034 ratification), NOT
 * an obsolete "PRD not ratified" blocker.
 *
 * Spec references:
 *   - src/modules/med-interaction/README.md
 *   - docs/med-interaction-implementation-plan.md
 *   - ADR-001 (modular monolith)
 *   - Master PRD v1.10 §7 (interaction engine as platform-floor)
 *   - I-002 (interaction engine runs BEFORE clinician commits
 *     medication_request)
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

describe('med-interaction slice — §1 plugin wiring', () => {
  it('§1a GET /v0/med-interaction/health returns 200 (liveness — module alive) with Sprint 1 skeleton metadata', async () => {
    const r = await app!.inject({
      method: 'GET',
      url: '/v0/med-interaction/health',
      headers: { host: 'localhost' },
    });
    expect(r.statusCode).toBe(200);
    const body = r.json<{
      status: string;
      module: string;
      blocked: string;
      blocked_message: string;
    }>();
    expect(body.status).toBe('ok');
    expect(body.module).toBe('med-interaction');
    expect(body.blocked).toContain('Sprint 1 of N');
    // Post-P-033/P-034 ratification — blocker is implementation, NOT
    // unratified spec.
    expect(body.blocked_message).toContain('Spec layer COMPLETE');
    expect(body.blocked_message).toContain('P-033');
    expect(body.blocked_message).toContain('P-034');
  });

  it('§1b GET /v0/med-interaction/ready returns 503 (handlers not yet mounted) with implementation-pending reason', async () => {
    const r = await app!.inject({
      method: 'GET',
      url: '/v0/med-interaction/ready',
      headers: { host: 'localhost' },
    });
    expect(r.statusCode).toBe(503);
    const body = r.json<{
      status: string;
      module: string;
      reason: string;
      reason_message: string;
    }>();
    expect(body.status).toBe('unavailable');
    expect(body.module).toBe('med-interaction');
    // Post-P-033/P-034 ratification — distinct from a hypothetical
    // ratification-blocked reason.
    expect(body.reason).toBe('handlers_not_yet_implemented');
    expect(body.reason_message).toContain('PR 7+');
    // Post-PR-5: DB layer COMPLETE through migration 050; the only
    // remaining gap is the Fastify HTTP surface.
    expect(body.reason_message).toContain('DB layer COMPLETE through migration 050');
  });
});
