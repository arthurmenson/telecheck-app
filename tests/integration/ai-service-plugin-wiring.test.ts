/**
 * ai-service slice — plugin wiring smoke test (PR A).
 *
 * The AI Service slice is scaffolded at PR A; full implementation
 * (Mode 1 chat, Mode 2 case-prep, real Anthropic provider, guardrail
 * templates, crisis detection) lands across subsequent PRs (B–F).
 *
 * At PR A we ship the directory + plugin shell so that:
 *   1. The module boundary (per ADR-001) is established
 *   2. App-level wiring (`src/app.ts`) is stable
 *   3. Cross-module callers can typed-import branded ID types ahead of
 *      full implementation (async-consult Mode 2 binding, pharmacy
 *      Mode 2 protocol_authorized_prescribing route, etc.)
 *
 * This test asserts the only currently-mounted routes return the
 * documented scaffold state.
 *
 * Spec references:
 *   - src/modules/ai-service/README.md
 *   - ADR-001 (modular monolith)
 *   - AI_LAYERING v5.2 §2 (two-mode architecture)
 *   - AI_LAYERING v5.2 §10 (workload taxonomy expansion per ADR-029)
 *   - ADR-029 (AI workload taxonomy)
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

describe('ai-service slice — §1 plugin wiring (PR A scaffold)', () => {
  it('§1a GET /v0/ai/health returns 200 (liveness — module alive) with scaffold metadata', async () => {
    const r = await app!.inject({
      method: 'GET',
      url: '/v0/ai/health',
      headers: { host: 'localhost' },
    });
    expect(r.statusCode).toBe(200);
    const body = r.json<{
      status: string;
      module: string;
      phase: string;
      workload_types_at_v1: string[];
      workload_types_reserved: string[];
      autonomy_levels_at_v1: string[];
      autonomy_levels_reserved: string[];
      handlers_wired: boolean;
      handlers_wired_tracking: string;
    }>();
    expect(body.status).toBe('ok');
    expect(body.module).toBe('ai-service');
    expect(body.phase).toBe('mode_1_chat_route_registered_503_pr_b');
    // Per AI_LAYERING v5.2 §10.2 + WORKLOAD_TAXONOMY v5.2 §2, the v1.0
    // active workload types are exactly `conversational_assistant` +
    // `protocol_execution`. Reserved types must be enumerated so a
    // ratifier can see what's pending (autonomous_agent / multi_agent_
    // supervisor / tool_using_agent require successor ADR + activation
    // audit event before code paths exist per AI-ARCH-001 supersession
    // scope statement).
    expect(body.workload_types_at_v1).toEqual(['conversational_assistant', 'protocol_execution']);
    expect(body.workload_types_reserved).toEqual([
      'autonomous_agent',
      'multi_agent_supervisor',
      'tool_using_agent',
    ]);
    expect(body.autonomy_levels_at_v1).toEqual(['advisory', 'suggestion', 'action_with_confirm']);
    expect(body.autonomy_levels_reserved).toEqual(['action_with_audit_only', 'fully_autonomous']);
    expect(body.handlers_wired).toBe(false);
    expect(body.handlers_wired_tracking).toContain('PR C');
    expect(body.handlers_wired_tracking).toContain('PR F');
  });

  it('§1b GET /v0/ai/ready returns 503 (not ready for traffic) while scaffold PR A is the latest', async () => {
    const r = await app!.inject({
      method: 'GET',
      url: '/v0/ai/ready',
      headers: { host: 'localhost' },
    });
    expect(r.statusCode).toBe(503);
    const body = r.json<{
      status: string;
      module: string;
      phase: string;
      pending: string;
      pending_message: string;
    }>();
    expect(body.status).toBe('not_ready');
    expect(body.module).toBe('ai-service');
    expect(body.phase).toBe('mode_1_chat_route_registered_503_pr_b');
    expect(body.pending).toContain('PR C');
    expect(body.pending_message).toContain('not yet ready');
    expect(body.pending_message).toContain('conversational_assistant');
    expect(body.pending_message).toContain('protocol_execution');
    // Per CLAUDE.md hard-rule: post-P-011 the schema is ratified;
    // pending_message must not claim otherwise.
    expect(body.pending_message).not.toContain('schema not yet ratified');
  });

  it('§1c probes are tenant-blind — /health + /ready resolve without a Host header (allowlisted)', async () => {
    // Codex PR-A R1 MEDIUM closure 2026-05-14: probes must be in the
    // tenantContextPlugin allowlist so a Kubernetes / load-balancer
    // probe with no Host (or an unresolvable Host) gets the documented
    // 200 / 503 instead of a tenant-resolution error. Mirrors the
    // pharmacy + med-interaction precedent.
    const health = await app!.inject({ method: 'GET', url: '/v0/ai/health' });
    expect(health.statusCode).toBe(200);
    expect(health.json<{ module: string }>().module).toBe('ai-service');

    const ready = await app!.inject({ method: 'GET', url: '/v0/ai/ready' });
    expect(ready.statusCode).toBe(503);
    expect(ready.json<{ module: string }>().module).toBe('ai-service');

    // Also exercise the unresolvable-Host case: a Host that isn't a
    // tenant consumer DBA should still pass through to the documented
    // probe response, not a tenant-not-found error.
    const healthUnknown = await app!.inject({
      method: 'GET',
      url: '/v0/ai/health',
      headers: { host: 'unknown.example.test' },
    });
    expect(healthUnknown.statusCode).toBe(200);
    const readyUnknown = await app!.inject({
      method: 'GET',
      url: '/v0/ai/ready',
      headers: { host: 'unknown.example.test' },
    });
    expect(readyUnknown.statusCode).toBe(503);
  });
});
