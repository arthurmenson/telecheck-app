# AI Service module — scaffold (PR A)

## Status

This module is a **directory skeleton** authored as the first PR in the AI Service rollout (TLC-AI PR A). The full AI surface (Mode 1 conversational chat, Mode 2 protocol-execution case-prep, provider abstraction, guardrail templates, crisis detection) lands across subsequent PRs.

## What ships at PR A

- Module directory boundary (per ADR-001 modular monolith)
- Fastify plugin shell registering `/v0/ai`
- Liveness probe (`GET /v0/ai/health` → 200) with informational `phase` + workload-type metadata for operator monitoring
- Readiness probe (`GET /v0/ai/ready` → 503) — Kubernetes / load-balancer will keep traffic off the module until the surface is production-ready
- Branded ID types — `AIChatSessionId`, `AIWorkflowExecutionId`, `GuardrailTemplateId` — identifier hygiene only, not schema
- Re-exports of `AIWorkloadType` and `AutonomyLevel` from `src/lib/audit.ts` (canonical workload + autonomy enums per WORKLOAD_TAXONOMY v5.2 + AUTONOMY_LEVELS v5.2)
- Plugin smoke test (`tests/integration/ai-service-plugin-wiring.test.ts`)

## What does NOT ship at PR A

- Real handlers (`POST /v0/ai/chat` Mode 1, `POST /v0/ai/case-prep` Mode 2, etc.)
- Conversation persistence schema (chat sessions + messages) or row-shape interfaces
- AI execution audit-event emitters
- Guardrail-template repo or runtime enforcement
- Crisis-detection scaffold (FLOOR-009 / I-019 platform-floor)
- LLM provider clients (Anthropic primary; Bedrock + Azure OpenAI resilience per ADR-020)
- Domain-event emitters (the AI service may emit `ai.chat_response_emitted.v1` / `ai.case_prepared.v1` events in PR B+ if downstream consumers need them)
- Database migrations

## Why this is intentionally a skeleton

Per EHBG §7, engineering does not author canonical schema; the slice PRD owns it. The AI Clinical Assistant Slice PRD v1.0 ratified the two-mode architecture, the audit envelope (FLOOR-020), the guardrail-template invariants (AI-GUARD-001..005), and the immutable AI boundaries (FLOOR-007..FLOOR-013) — but the conversation-persistence row shapes (chat_sessions, chat_messages, ai_executions) are not yet expanded in CDM v1.2. Authoring schema now would silently fork the spec corpus.

The skeleton lands now so that:

1. **Module boundary is established** under ADR-001 — the public-interface surface is fixed; plugin internals can evolve without re-touching `app.ts`
2. **App-level wiring is stable** — `src/app.ts` registers `aiServicePlugin` once
3. **Downstream slices can typed-import branded IDs** — async-consult Mode 2 integration, pharmacy clinician-write surface (for Mode 2 protocol_authorized_prescribing route, deferred at v1.0), labs interpretation, and the admin AI-suggestion surfaces can all hold typed references to `AIChatSessionId` / `AIWorkflowExecutionId` ahead of full schema ratification
4. **Liveness / readiness pattern is consistent** with the pharmacy + med-interaction + async-consult precedents: `/health` 200 with metadata, `/ready` 503 until every documented endpoint is wired

## Hard rules (platform-floor; bind independent of PR sequencing)

Per CLAUDE.md, AI_LAYERING v5.2, and Master PRD v1.10:

- **FLOOR-007:** Every AI response carries `source_type: "ai"`. Identity never concealed.
- **FLOOR-008:** No impersonation of named human clinicians.
- **FLOOR-009 / I-019:** Crisis detection runs on every conversation regardless of guardrail template. No template, no admin configuration, can disable it.
- **FLOOR-010:** No specific dosing advice outside an authenticated, consented care relationship.
- **FLOOR-011:** No definitive diagnosis without clinician review.
- **FLOOR-012:** AI-initiated workflows pass through the same service gates as user-initiated workflows.
- **FLOOR-013:** Mandatory escalation conditions cannot be bypassed by guardrail config.
- **AI-ARCH-001 (v5.2 §10 scope statement):** At v1.0 the platform admits exactly two active workload types — `conversational_assistant` (Mode 1) and `protocol_execution` (Mode 2). Reserved types (`autonomous_agent`, `multi_agent_supervisor`, `tool_using_agent`) require successor ADR + activation audit event before code paths exist.
- **I-012:** Mode 2 may only reach `executed` state for prescribing actions via `action_with_confirm` + explicit clinician confirmation + RBAC-authorized confirming actor (reject-unless three-clause rule).
- **Tenant scoping (§9):** Conversations are tenant-scoped; `(tenant_id, ai_chat_session_id)` is the authorization pair; guardrail templates are platform-scoped with tenant override capacity (RBAC v1.1 gates the override); provider selection is platform-scoped (tenants cannot override).
- **AI-GUARD-003:** Conservative Default guardrail template is **immutable**. Cannot be modified or deactivated.
- **AI-RESIL-001:** LLM provider unavailability does NOT cascade to clinical workflows. If AI Service is down, Mode 1 chat shows "AI assistant temporarily unavailable" with alternative actions; Mode 2 cases queue for clinician review without AI summary.

## On-resume notes for subsequent PRs

| PR    | Scope                                                                                                                                                                                                                                                                                                                                                                               |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **B** | Mode 1 `POST /v0/ai/chat` stub: accepts patient JWT + body { message }; returns canned response with full audit envelope (source_type='ai', ai_workload_type='conversational_assistant', autonomy_level='advisory', guardrail_template_id='conservative_default', model_version='stub-v0'). No real LLM call yet. Audit row + integration tests on envelope shape + tenant scoping. |
| **C** | Mode 2 `POST /v0/ai/case-prep` stub: accepts clinician JWT + body { consult_id, protocol_id }; returns canned summary with full audit envelope (ai_workload_type='protocol_execution', autonomy_level='action_with_confirm', protocol_id, protocol_version).                                                                                                                        |
| **D** | Real Anthropic provider integration. Multi-provider abstraction per ADR-020. Secrets via the platform's secret-manager path. Resilience fallback per AI-RESIL-001 (degrade to "AI unavailable" on provider error).                                                                                                                                                                  |
| **E** | Guardrail-template repo + Conservative Default enforcement (immutable per AI-GUARD-003). Tenant override capacity. Test-suite gating per AI-GUARD-004. Rollback-to-default one-action operation per AI-GUARD-005.                                                                                                                                                                   |
| **F** | Crisis-detection scaffold per FLOOR-009 + I-019. Runs on EVERY conversation, INDEPENDENT of guardrail templates. Classifier integration is a separate sub-project; PR F lands the structural hook + audit-emission boundary.                                                                                                                                                        |

## Spec references

- ADR-001 modular monolith
- ADR-002 binary AI mode framing (preserved at v1.0 for current workloads; ADR-029 prospective successor)
- ADR-005 protocolized autonomy (preserved at `action_with_confirm` for `protocol_execution`)
- ADR-020 multi-provider LLM abstraction
- ADR-023 multi-tenancy Model A
- ADR-029 AI workload taxonomy
- AI Clinical Assistant Slice PRD v1.0
- AI_LAYERING v5.2 §1–§10
- WORKLOAD_TAXONOMY v5.2
- AUTONOMY_LEVELS v5.2
- AUDIT_EVENTS v5.3
- FLOOR-007 through FLOOR-013, FLOOR-020 (AI-portion platform floor)
- I-012, I-019, I-023, I-025, I-027

## Sprint reference

Authored on the autonomous program-build cycle after the Pharmacy slice closure (TLC-055 PRs C–K merged 2026-05-13/14). First PR in the AI Service rollout; intentionally narrow (scaffold only) to mirror the med-interaction precedent and let Codex review the module-boundary shape before the substantive handler PRs land.
