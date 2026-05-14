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
import { ulid } from '../../src/lib/ulid.ts';

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
    expect(body.phase).toBe('provider_abstraction_published_pr_d');
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
    expect(body.phase).toBe('provider_abstraction_published_pr_d');
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

  it('§1d POST /v0/ai/chat is NOT mounted at PR B/C — Fastify returns 404 (Codex PR B R2 CRITICAL closure)', async () => {
    // Per Codex PR B R2 CRITICAL closure 2026-05-14, the Mode 1 chat
    // route is deliberately NOT registered until PR F lands the
    // I-019 crisis-detection wire-in + the FLOOR-020 audit-emission
    // boundary. Even validating a body MUST NOT happen before
    // crisis detection runs on the input — by not mounting the
    // route at all, we close that risk by construction. Locking
    // this in: a future PR that accidentally mounts /chat without
    // PR F's gating will trip this test and fail loud.
    //
    // We MUST supply an Idempotency-Key header because the global
    // idempotency-plugin preHandler returns 400
    // `internal.idempotency.missing_key` on every state-changing
    // POST before route resolution fires. Sending a valid key lets
    // the request reach route-matching, which then returns 404 for
    // the unregistered path.
    const r = await app!.inject({
      method: 'POST',
      url: '/v0/ai/chat',
      headers: { host: 'heroshealth.com', 'idempotency-key': ulid() },
      payload: { message: 'hi' },
    });
    expect(r.statusCode).toBe(404);
  });

  it('§1e POST /v0/ai/case-prep is NOT mounted at PR C — Fastify returns 404', async () => {
    // Per Codex PR B R2 CRITICAL closure 2026-05-14 (applied to Mode 2
    // by analogy at PR C), the Mode 2 case-prep route is deliberately
    // NOT registered. Mode 2 inputs (clinician-supplied symptoms,
    // patient notes) may contain crisis text that must trip the
    // I-019 platform-floor detector + audit + escalation. The route
    // is gated until PR F lands crisis detection AND the protocol-
    // engine integration ships (the I-012 reject-unless three-clause
    // rule at the downstream prescribing boundary per State Machines
    // v1.2 §19 §19.X depends on it).
    //
    // Same Idempotency-Key trick as §1d so the route-not-found 404
    // surfaces instead of being shadowed by the idempotency-plugin's
    // missing-key 400.
    const r = await app!.inject({
      method: 'POST',
      url: '/v0/ai/case-prep',
      headers: { host: 'heroshealth.com', 'idempotency-key': ulid() },
      payload: { consult_id: 'aiwfe_stub', protocol_id: 'p_stub' },
    });
    expect(r.statusCode).toBe(404);
  });
});
