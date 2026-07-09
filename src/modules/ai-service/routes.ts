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

import { config } from '../../lib/config.js';

import { mode2CasePrepHandler } from './internal/handlers/case-prep.js';
import { mode1ChatHandler } from './internal/handlers/chat.js';
import { isEnvAnthropicKeyPresent } from './internal/providers/resolve-clinical-provider.js';

export const registerAIServiceRoutes: FastifyPluginAsync = async (
  app: FastifyInstance,
): Promise<void> => {
  // Mode 2 case-prep mount gate. Codex PR #210 R1 NEEDS-WORK closure:
  // the route is DEFINED but NOT mounted by default — flipping
  // AI_MODE2_ENABLED=true mounts it. Honest-failure-until-wiring-lands
  // pattern matching the C1 cockpit precedent. Production rollout
  // requires (a) clinical-anchor authorization (clinician-on-care-team
  // for the named protocol — beyond JWT-role gating), (b) real
  // protocol-engine provider execution wiring the I-012 reject-unless
  // three-clause rule at the downstream prescribing boundary per
  // State Machines v1.2 §19 §19.X, and (c) audit-emission discipline
  // per I-019 / I-027 verified end-to-end against a live Postgres +
  // real LLM provider. Until all three land, AI_MODE2_ENABLED MUST
  // remain false in production.
  const mode2CasePrepMounted = config.aiMode2Enabled;
  // Liveness probe — process is alive. Returns 200 always (module is
  // running), with `phase` carried as informational metadata for
  // operator monitoring. Allowlisted in tenantContextPlugin.
  app.get('/health', async () => ({
    status: 'ok',
    module: 'ai-service',
    phase: 'crisis_gate_wired_pr_f',
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
    // Honest startup-state introspection per Codex PR #210 R1 NEEDS-WORK
    // closure. Reports whether POST /v0/ai/case-prep is reachable under
    // the active config. Default is `false` — Day-3+ wiring (real
    // clinical-anchor auth + real protocol-engine provider execution
    // + verified audit emission) flips AI_MODE2_ENABLED=true.
    mode2_case_prep_mounted: mode2CasePrepMounted,
    mode2_case_prep_mount_gate: 'AI_MODE2_ENABLED',
    mode2_case_prep_day3_prerequisites: [
      'clinical_anchor_authorization (clinician-on-care-team-for-named-protocol)',
      'real_protocol_provider_execution (I-012 reject-unless three-clause at prescribing boundary)',
      'verified_audit_emission_discipline (I-019 + I-027 end-to-end against live Postgres + real LLM provider)',
    ],
    provider_abstraction_published: true,
    provider_abstraction_published_by:
      'TLC-AI PR D (LLMProvider interface + NullLLMProvider + resolveProvider registry) + SI-025 (real AnthropicLLMProvider + resolveClinicalProvider: resolves the admin-managed DB credential via the read_active_ai_provider_key SECDEF path or the ANTHROPIC_API_KEY env fallback; NullLLMProvider only when NEITHER is configured, preserving AI-RESIL-001). Bedrock/Azure adapters remain deferred per ADR-020.',
    guardrail_templates_wired: true,
    guardrail_templates_wired_by:
      'TLC-AI PR E (Conservative Default hardcoded + immutable per AI-GUARD-003; platform-floor compliance validator per AI-GUARD-002; emergency rollback entry point per AI-GUARD-005; Ghana launch program-specific templates wire in alongside their slices)',
    crisis_gate_wired: true,
    crisis_gate_wired_by:
      'TLC-AI PR F (runCrisisGate exported from module index; wraps the platform-singleton crisisDetector from src/lib/crisis-detection.ts + emits crisis_detection_trigger Category A audit per AUDIT_EVENTS v5.3; service-callable only — handlers that consume the gate land when Mode 1 chat / Mode 2 case-prep routes go online)',
    handlers_wired: true,
    // Codex PR #210 R2 MEDIUM closure: tracking text must agree with
    // mode2_case_prep_mounted. The boolean is source-of-truth.
    handlers_wired_tracking: mode2CasePrepMounted
      ? 'Mode 1 chat (PR G 2026-05-15) + Mode 2 case-prep (PR H 2026-05-23) MOUNTED; ' +
        'real Anthropic provider integration wired per SI-025 (admin-managed DB credential ' +
        'or ANTHROPIC_API_KEY env fallback; NullLLMProvider fail-soft only when neither is configured)'
      : 'Mode 1 chat (PR G 2026-05-15) MOUNTED; Mode 2 case-prep (PR H 2026-05-23) ' +
        'DEFINED + config-gated behind AI_MODE2_ENABLED (default false) per Codex PR #210 ' +
        'R1 NEEDS-WORK closure — POST /v0/ai/case-prep returns 404 until the flag is on. ' +
        'Real Anthropic provider integration wired per SI-025 (admin-managed DB credential ' +
        'or ANTHROPIC_API_KEY env fallback; NullLLMProvider fail-soft only when neither is configured)',
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
  // Codex PR #210 R2 MEDIUM closure (2026-05-24): /ready descriptive
  // text MUST agree with the mode2_case_prep_mounted introspection
  // field. The boolean is the source of truth; the human-readable
  // string echoes that state so an operator parsing prose can't
  // arrive at a different conclusion than an operator parsing the
  // boolean.
  const mode2DescriptiveText = mode2CasePrepMounted
    ? 'Mode 2 case-prep (POST /v0/ai/case-prep) is MOUNTED and exercises the full ' +
      'I-019 crisis-detection floor, FLOOR-020 audit emission, and AI-RESIL-001 ' +
      'fail-soft path (AI_MODE2_ENABLED=true in this environment; production rollout ' +
      'still blocks on the three Day-3+ prerequisites per Codex PR #210 R1 closure)'
    : 'Mode 2 case-prep (POST /v0/ai/case-prep) is DEFINED but NOT mounted — ' +
      'AI_MODE2_ENABLED=false gates the route registration per Codex PR #210 R1 ' +
      "NEEDS-WORK closure. POST requests return Fastify's documented 404. The flag " +
      'is held off until clinical-anchor authorization + real protocol-engine ' +
      'provider execution + verified end-to-end audit-emission discipline land in ' +
      'lockstep';

  app.get('/ready', async (_req, reply) => {
    return reply.code(503).send({
      status: 'not_ready',
      module: 'ai-service',
      phase: 'crisis_gate_wired_pr_f',
      mode2_case_prep_mounted: mode2CasePrepMounted,
      mode2_case_prep_mount_gate: 'AI_MODE2_ENABLED',
      // SI-025 provider-credential readiness (honest split from the
      // separate crisis-classifier gate). The provider-credential gate is
      // SATISFIABLE: resolveClinicalProvider constructs the real Anthropic
      // adapter from an admin-managed DB credential (PUT /v1/admin/ai-providers)
      // OR the ANTHROPIC_API_KEY env fallback. `provider_credential_env_present`
      // reflects the sync env-fallback check; an admin-managed DB credential is
      // resolved at request time (requires a tx, not visible to this sync probe).
      provider_credential_satisfiable: true,
      provider_credential_env_present: isEnvAnthropicKeyPresent(),
      provider_credential_gate:
        'admin-managed DB credential (SI-025) OR ANTHROPIC_API_KEY env fallback',
      remaining_readiness_gate:
        'crisis-classifier NLP upgrade (AI Safety Lead sign-off) + Mode 2 route wiring — ' +
        'NOT the provider credential, which SI-025 made runtime-configurable',
      pending:
        'Clinical-grade NLP crisis classifier (src/lib/crisis-detection.ts ' +
        'is a v1.0 keyword stub; AI Safety Lead sign-off required) + protocol-engine ' +
        'integration (downstream I-012 reject-unless three-clause rule binds at the ' +
        'prescribing boundary, not at case-prep itself) + Mode 2 case-prep route ' +
        'authorization wiring (clinical-anchor auth + real protocol provider execution + ' +
        'verified audit emission) — AI_MODE2_ENABLED gates the route mount until all ' +
        'three Day-3+ prerequisites land per Codex PR #210 R1 NEEDS-WORK closure',
      pending_message:
        'Module is NOT yet production-ready — Mode 1 chat (POST /v0/ai/chat) is MOUNTED ' +
        'and exercises the full I-019 crisis-detection floor, FLOOR-020 audit emission, ' +
        'the AI-RESIL-001 fail-soft path, AND same-transaction Mode 1 conversation/turn ' +
        'persistence into the migration-067 ai_mode1_* entities under the ' +
        'ai_service_mode1 writer role (migration 068 per Mode 1 Handler Spec v0.4 ' +
        'P-035 §5.1 Layer 1; CDM v1.8 P-036). Readiness intentionally stays 503 on the ' +
        'remaining gates in `pending`. ' +
        mode2DescriptiveText +
        '. Per SI-025 the LLM provider abstraction (ADR-020) now resolves the ' +
        'real Anthropic adapter from an admin-managed DB credential (SECDEF read) ' +
        'or the ANTHROPIC_API_KEY env fallback; when NEITHER is configured it ' +
        'falls back to NullLLMProvider — in which case the non-crisis response is ' +
        'the documented "AI temporarily unavailable" envelope (persisted as a ' +
        "turn_outcome='failed' / failure_class='llm_provider_unavailable' turn-result " +
        'row). Per AI_LAYERING v5.2 §2 + ADR-029, the ' +
        'v1.0 workload taxonomy admits exactly two active types: conversational_assistant ' +
        'and protocol_execution; reserved types (autonomous_agent, multi_agent_supervisor, ' +
        'tool_using_agent) require a successor ADR + activation audit event before code ' +
        'paths exist. Per AI_LAYERING v5.2 §9, conversations are tenant-scoped — ' +
        '(tenant_id, ai_chat_session_id) is the authorization pair, now DB-enforced by ' +
        'the ai_mode1_conversation composite tenant-scoped FKs + RLS. Per ADR-020, the ' +
        'multi-provider abstraction (Anthropic primary + Bedrock + Azure OpenAI ' +
        'resilience) is platform-scoped; tenants do not select providers.',
    });
  });

  // Mode 1 conversational assistant — MOUNTED 2026-05-15; conversation
  // persistence wired per migrations 066/067/068 (P-035/P-036).
  //
  // Lifecycle (per AI_LAYERING v5.2 + Slice PRD v1.0 §3 + Mode 1
  // Handler Spec v0.4 §4/§6):
  //   1. tenantContext (foundation plugin) + actorContext (JWT)
  //   2. Patient-only role gate (Mode 1 is patient-facing)
  //   3. Body validation (Zod; tenant-blind 400 on failure)
  //   4. runCrisisGate on INPUT text (I-019; emits Cat A audit on positive)
  //   5. Persist conversation (create-or-validate-ownership) +
  //      turn-admission + detector-result rows into the ai_mode1_*
  //      entities under the ai_service_mode1 role, same tx as the
  //      idempotency reservation
  //   6. On crisis: return crisis-resource sentinel (no LLM call)
  //   7. On no crisis: verify the detector-result row exists (spec §4.2
  //      runtime ordering precondition), then call the provider
  //      (v1.0 NullProvider always throws → AI-RESIL-001 fail-soft)
  //   8. Persist the turn-result terminal row (completed / failed)
  //   9. Emit FLOOR-020 audit (`ai_chat_response_emitted` Cat C)
  //  10. Return Mode1ChatResponseView
  //
  // The (future) crisis gate on OUTPUT text is planned alongside real
  // provider integration; at v1.0 the only AI-generated text paths are
  // the fail-soft envelope ("AI temporarily unavailable") and the
  // crisis sentinel ("contact your care team") — both authored at
  // module level and not subject to runtime classification.
  //
  // Mode 2 case-prep — MOUNTED 2026-05-23.
  //
  // Lifecycle (per AI_LAYERING v5.2 + Slice PRD v1.0 §4.2 + ADR-029):
  //   1. tenantContext + actorContext
  //   2. Clinician-only role gate (Mode 2 is clinician-driven; patients
  //      never interact with Mode 2 directly per Slice PRD v1.0 §4.2)
  //   3. Two-stage body validation (Zod after crisis-gate per R6 H1)
  //   4. runCrisisGate on INPUT context (I-019; emits Cat A audit on
  //      positive; auditDedupeDiscriminator='context_serialized')
  //   5. On crisis: return crisis-bypass sentinel (no LLM call); route
  //      to immediate clinician review
  //   6. On no crisis: call resolveProvider → sendCompletion
  //      (v0.1 NullProvider always throws → AI-RESIL-001 fail-soft)
  //   7. Emit Cat A `ai_mode_2_evaluation` audit (AUDIT_EVENTS v5.3
  //      canonical action ID)
  //   8. Return Mode2CasePrepResponseView with the recommendation +
  //      canonical AI envelope (protocol_id + protocol_version stamped;
  //      guardrail_template_id NOT used — that's Mode 1's field)
  //
  // The I-012 reject-unless three-clause rule binds at the downstream
  // prescribing boundary (protocol-engine slice per State Machines
  // v1.2 §19 §19.X) — case-prep itself does NOT execute prescribing,
  // so the rule does not bind here. The case-prep envelope is the
  // audit anchor the downstream `prescribing.protocol_authorization_granted`
  // event references via ai_workflow_execution_id.
  app.post('/chat', mode1ChatHandler);

  // Mode 2 case-prep is gated by the AI_MODE2_ENABLED config flag per
  // Codex PR #210 R1 NEEDS-WORK closure. Default OFF — the route is
  // DEFINED in source but NOT registered with Fastify, so Fastify
  // returns the documented 404 on POST /v0/ai/case-prep until the
  // Day-3+ wiring (clinical-anchor auth + real protocol provider +
  // verified audit emission) lands and the operator flips
  // AI_MODE2_ENABLED=true in non-production environments first.
  //
  // When the flag is off we log a structured warn so an operator
  // inspecting startup logs sees the gate explicitly — silent
  // unmount would be a worse trade than a noisy startup line.
  if (mode2CasePrepMounted) {
    app.post('/case-prep', mode2CasePrepHandler);
  } else {
    app.log.warn(
      {
        gate: 'AI_MODE2_ENABLED',
        route: 'POST /v0/ai/case-prep',
        prerequisites: [
          'clinical_anchor_authorization',
          'real_protocol_provider_execution',
          'verified_audit_emission_discipline',
        ],
      },
      'ai-service: Mode 2 case-prep route NOT mounted — AI_MODE2_ENABLED=false ' +
        '(Day-3+ obligation per ADR-029 + clinical-anchor auth + protocol-engine integration ' +
        'per State Machines v1.2 §19 §19.X)',
    );
  }
};
