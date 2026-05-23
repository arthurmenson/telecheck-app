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

import { mode1ChatHandler } from './internal/handlers/chat.js';

export const registerAIServiceRoutes: FastifyPluginAsync = async (
  app: FastifyInstance,
): Promise<void> => {
  // Liveness probe — process is alive. Returns 200 always (module is
  // running), with `phase` carried as informational metadata for
  // operator monitoring. Allowlisted in tenantContextPlugin.
  app.get('/health', async () => ({
    status: 'ok',
    module: 'ai-service',
    phase: 'mode_1_chat_mounted',
    workload_types_at_v1: ['conversational_assistant', 'protocol_execution'],
    workload_types_reserved: ['autonomous_agent', 'multi_agent_supervisor', 'tool_using_agent'],
    autonomy_levels_at_v1: ['advisory', 'suggestion', 'action_with_confirm'],
    autonomy_levels_reserved: ['action_with_audit_only', 'fully_autonomous'],
    mode_1_chat_wire_contract_published: true,
    mode_1_chat_wire_contract_published_by:
      'TLC-AI PR B (Mode1ChatResponseView exported from module index; HTTP handler deliberately NOT mounted — requires I-019 crisis-detection wire-in + FLOOR-020 audit emission before /v0/ai/chat goes live; lands in PRs D + E + F)',
    mode_2_case_prep_wire_contract_published: true,
    mode_2_case_prep_wire_contract_published_by:
      'TLC-AI PR C (Mode2CasePrepResponseView exported from module index; HTTP handler deliberately NOT mounted — same I-019 + FLOOR-020 gating as Mode 1, plus dependency on the protocol-engine integration that drives the I-012 reject-unless three-clause rule at the downstream prescribing boundary per State Machines v1.2 §19 §19.X)',
    provider_abstraction_published: true,
    provider_abstraction_published_by:
      'TLC-AI PR D (LLMProvider interface + NullLLMProvider + resolveProvider registry exported; per ADR-020 the v1.0 registry routes every active workload to NullLLMProvider — real Anthropic/Bedrock/Azure adapters land when secrets management is resolved)',
    guardrail_templates_wired: true,
    guardrail_templates_wired_by:
      'TLC-AI PR E (Conservative Default hardcoded + immutable per AI-GUARD-003; platform-floor compliance validator per AI-GUARD-002; emergency rollback entry point per AI-GUARD-005; Ghana launch program-specific templates wire in alongside their slices)',
    crisis_gate_wired: true,
    crisis_gate_wired_by:
      'TLC-AI PR F (runCrisisGate exported from module index; wraps the platform-singleton crisisDetector from src/lib/crisis-detection.ts + emits crisis_detection_trigger Category A audit per AUDIT_EVENTS v5.3; service-callable only — consumed by the Mode 1 chat handler which runs the I-019 input gate per request)',
    // Per-handler mount state (precise; supersedes the single
    // `handlers_wired` rollup which only flips true at full-surface
    // readiness). Mode 1 chat is live; Mode 2 case-prep remains the
    // sole un-mounted documented handler.
    mode_1_chat_handler_mounted: true,
    mode_1_chat_handler_mounted_by:
      'TLC-AI Mode 1 chat handler MOUNTED 2026-05-15 (POST /v0/ai/chat); full lifecycle wired — I-019 input crisis gate (Cat A audit) → Conservative Default guardrail → provider via NullLLMProvider (AI-RESIL-001 fail-soft) → FLOOR-020 Cat C response audit; patient-only + delegate-reject gates; tenant-blind errors; idempotent execution',
    mode_2_case_prep_handler_mounted: false,
    handlers_wired: false,
    handlers_wired_tracking:
      'Mode 1 chat MOUNTED (see mode_1_chat_handler_mounted); provider abstraction, guardrail templates, and crisis gate all wired (see the respective *_wired flags above). Sole remaining documented handler: PR C (Mode 2 case-prep, POST /v0/ai/case-prep) — gated on the protocol-engine integration that drives the I-012 reject-unless three-clause rule at the downstream prescribing boundary. handlers_wired flips true only when Mode 2 case-prep mounts.',
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
      phase: 'mode_1_chat_mounted',
      pending: 'PR C (Mode 2 case-prep, POST /v0/ai/case-prep)',
      pending_message:
        'Module is not yet ready to serve traffic — the AI surface is partial. Mode 1 chat ' +
        '(POST /v0/ai/chat) is MOUNTED, and the provider abstraction, guardrail templates ' +
        '(Conservative Default), and crisis-detection gate (FLOOR-009 / I-019 platform-floor) ' +
        'are all wired. The sole remaining documented handler is Mode 2 case-prep ' +
        '(POST /v0/ai/case-prep), gated on the protocol-engine integration that drives the ' +
        'I-012 reject-unless three-clause rule at the downstream prescribing boundary. ' +
        'Per the readiness-flip precedent (async-consult + pharmacy), /ready stays 503 until ' +
        'the FULL documented surface is live; a partial surface is intentionally not ' +
        'readiness-acceptable. Separately, real Anthropic / Bedrock / Azure OpenAI adapters ' +
        'replace the v1.0 NullLLMProvider when secrets management is resolved. Per ' +
        'AI_LAYERING v5.2 §2 + ADR-029, the v1.0 workload ' +
        'taxonomy admits exactly two active types: conversational_assistant and ' +
        'protocol_execution; reserved types (autonomous_agent, multi_agent_supervisor, ' +
        'tool_using_agent) require a successor ADR + activation audit event before code ' +
        'paths exist. Per AI_LAYERING v5.2 §9, conversations are tenant-scoped — ' +
        '(tenant_id, ai_chat_session_id) is the authorization pair. Per ADR-020, the ' +
        'multi-provider abstraction (Anthropic primary + Bedrock + Azure OpenAI ' +
        'resilience) is platform-scoped; tenants do not select providers.',
    });
  });

  // Mode 1 conversational assistant — MOUNTED 2026-05-15.
  //
  // Lifecycle (per AI_LAYERING v5.2 + Slice PRD v1.0 §3):
  //   1. tenantContext (foundation plugin) + actorContext (JWT)
  //   2. Patient-only role gate (Mode 1 is patient-facing)
  //   3. Body validation (Zod; tenant-blind 400 on failure)
  //   4. runCrisisGate on INPUT text (I-019; emits Cat A audit on positive)
  //   5. On crisis: return crisis-resource sentinel (no LLM call)
  //   6. On no crisis: call resolveProvider → sendCompletion
  //      (v1.0 NullProvider always throws → AI-RESIL-001 fail-soft)
  //   7. Emit FLOOR-020 audit (`ai_chat_response_emitted` Cat C)
  //   8. Return Mode1ChatResponseView
  //
  // The (future) crisis gate on OUTPUT text is planned alongside real
  // provider integration; at v1.0 the only AI-generated text paths are
  // the fail-soft envelope ("AI temporarily unavailable") and the
  // crisis sentinel ("contact your care team") — both authored at
  // module level and not subject to runtime classification.
  //
  // Mode 2 case-prep (POST /v0/ai/case-prep) remains gated pending the
  // protocol-engine integration that drives the I-012 reject-unless
  // three-clause rule at the downstream prescribing boundary per
  // State Machines v1.2 §19 §19.X.
  app.post('/chat', mode1ChatHandler);
};
