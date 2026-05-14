/**
 * ai-service/routes.ts — Fastify route registration (skeleton at PR A).
 *
 * Status at v0.1: scaffold only. Only `/health` (200) + `/ready` (503)
 * are mounted; every other path under `/v0/ai` will return the
 * canonical tenant-blind error envelope until subsequent PRs ship the
 * Mode 1 chat surface (PR B), Mode 2 case-prep surface (PR C), real
 * Anthropic provider integration (PR D), guardrail-template repo
 * (PR E), and crisis-detection scaffold (PR F).
 *
 * The `/ready` 503 follows the async-consult + pharmacy precedent:
 * readiness flips to 200 only when the slice is FULLY production-
 * ready (every documented endpoint wired), not when an arbitrary
 * subset responds.
 *
 * Spec references:
 *   - AI Clinical Assistant Slice PRD v1.0 (slice scope)
 *   - AI_LAYERING v5.2 (two-mode architecture; platform-floor
 *     boundaries FLOOR-007..FLOOR-013; tenant scoping §9)
 *   - WORKLOAD_TAXONOMY v5.2 (canonical discriminator
 *     `conversational_assistant` / `protocol_execution`)
 *   - AUTONOMY_LEVELS v5.2 (autonomy enum + reserved/activation rules)
 *   - ADR-029 (workload taxonomy; ADR-002 prospective supersession;
 *     ADR-005 + I-012 preserved at v1.0 active levels)
 *   - ADR-020 (multi-provider LLM abstraction; Anthropic primary,
 *     Bedrock + Azure OpenAI resilience)
 *   - I-019 (crisis detection platform-floor; runs independent of
 *     guardrail templates per FLOOR-013)
 *   - I-023 / I-025 / I-027 (tenant scoping; tenant-blind errors;
 *     tenant_id on every audit record)
 */

import type { FastifyInstance, FastifyPluginAsync } from 'fastify';

export const registerAIServiceRoutes: FastifyPluginAsync = async (
  app: FastifyInstance,
): Promise<void> => {
  // Liveness probe — process is alive. Returns 200 always (module is
  // running), with `phase` carried as informational metadata for
  // operator monitoring. Allowlisted in tenantContextPlugin.
  app.get('/health', async () => ({
    status: 'ok',
    module: 'ai-service',
    phase: 'type_contract_published_pr_b',
    workload_types_at_v1: ['conversational_assistant', 'protocol_execution'],
    workload_types_reserved: ['autonomous_agent', 'multi_agent_supervisor', 'tool_using_agent'],
    autonomy_levels_at_v1: ['advisory', 'suggestion', 'action_with_confirm'],
    autonomy_levels_reserved: ['action_with_audit_only', 'fully_autonomous'],
    mode_1_chat_wire_contract_published: true,
    mode_1_chat_wire_contract_published_by:
      'TLC-AI PR B (Mode1ChatResponseView exported from module index; HTTP handler deliberately NOT mounted — requires I-019 crisis-detection wire-in + FLOOR-020 audit emission before /v0/ai/chat goes live; lands in PRs D + E + F)',
    handlers_wired: false,
    handlers_wired_tracking:
      'PR C (Mode 2 case-prep stub) + PR D (Anthropic provider) + PR E (guardrail templates) + PR F (crisis detection)',
  }));

  // Readiness probe — module is READY to serve traffic. Returns 503
  // while the AI surface is not yet wired. Per the async-consult and
  // pharmacy readiness-flip precedent, /ready flips to 200 only when
  // the slice is FULLY production-ready (Mode 1 chat + Mode 2 case-
  // prep + real provider + guardrails + crisis detection all live).
  //
  // A partial surface is intentionally not readiness-acceptable so a
  // Kubernetes / load-balancer probe keeps traffic away from this
  // module until the AI surface can serve every documented capability
  // with the platform-floor invariants (FLOOR-007..FLOOR-013, I-019,
  // AI-ARCH-001/002, AI-GUARD-001..005, AI-RESIL-001/002) enforced.
  app.get('/ready', async (_req, reply) => {
    return reply.code(503).send({
      status: 'not_ready',
      module: 'ai-service',
      phase: 'type_contract_published_pr_b',
      pending:
        'PR C (Mode 2 case-prep stub) + PR D (Anthropic provider) + PR E (guardrail templates) + PR F (crisis detection)',
      pending_message:
        'Module is not yet ready to serve traffic — only the scaffold + branded ID types ' +
        '(AIChatSessionId / AIWorkflowExecutionId / GuardrailTemplateId) are wired at PR A. ' +
        'Mode 1 chat (POST /v0/ai/chat), Mode 2 case-prep (POST /v0/ai/case-prep), real ' +
        'Anthropic provider integration, guardrail-template repo + Conservative Default ' +
        'enforcement, and crisis-detection scaffold (FLOOR-009 / I-019 platform-floor) all ' +
        'land in subsequent PRs. Per AI_LAYERING v5.2 §2 + ADR-029, the v1.0 workload ' +
        'taxonomy admits exactly two active types: conversational_assistant and ' +
        'protocol_execution; reserved types (autonomous_agent, multi_agent_supervisor, ' +
        'tool_using_agent) require a successor ADR + activation audit event before code ' +
        'paths exist. Per AI_LAYERING v5.2 §9, conversations are tenant-scoped — ' +
        '(tenant_id, ai_chat_session_id) is the authorization pair. Per ADR-020, the ' +
        'multi-provider abstraction (Anthropic primary + Bedrock + Azure OpenAI ' +
        'resilience) is platform-scoped; tenants do not select providers.',
    });
  });

  // Mode 1 conversational assistant — DELIBERATELY NOT MOUNTED at PR B
  // (Codex PR B R2 CRITICAL closure 2026-05-14). A live /v0/ai/chat
  // surface that accepts patient free-text input MUST run I-019
  // crisis detection on every message AND emit the FLOOR-020 audit
  // record for every response. Both land later:
  //   - PR D: real Anthropic provider integration (ADR-020
  //     multi-provider)
  //   - PR E: guardrail-template repo + Conservative Default
  //     enforcement (AI-GUARD-003)
  //   - PR F: crisis-detection wire-in to the chat surface (lib/
  //     crisis-detection.ts exists; this PR doesn't wire it because
  //     the platform-floor integration requires the audit-emission
  //     boundary + escalation pathway which the audit-event spec
  //     amendment must name first)
  //
  // The Mode1ChatResponseView wire contract IS exported from the
  // module's public interface (see index.ts) so frontends can
  // integrate against the response shape ahead of the handler.
  //
  // Mode 2 case-prep (POST /v0/ai/case-prep) lands in PR C with the
  // same gating posture: route not mounted until I-012 audit-chain
  // + protocol confirmation are wired (the surface inherits the
  // clinician_approve I-012 reject-unless contract from State
  // Machines v1.2 §19 §19.X).
};
