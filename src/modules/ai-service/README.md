# AI Service module — crisis_gate_wired_pr_f

## Status (post-PR F merge: 2026-05-14)

This module hosts the Telecheck platform's two-mode AI surface per **AI Clinical Assistant Slice PRD v1.0** + **AI_LAYERING v5.2**. After PRs A–F, every safety primitive needed for live AI handlers is in place; **handlers are NOT mounted** pending three external dependencies (see "What's NOT live" below).

### `/v0/ai/health` reports `phase: 'crisis_gate_wired_pr_f'`

```json
{
  "status": "ok",
  "module": "ai-service",
  "phase": "crisis_gate_wired_pr_f",
  "workload_types_at_v1": ["conversational_assistant", "protocol_execution"],
  "workload_types_reserved": ["autonomous_agent", "multi_agent_supervisor", "tool_using_agent"],
  "autonomy_levels_at_v1": ["advisory", "suggestion", "action_with_confirm"],
  "autonomy_levels_reserved": ["action_with_audit_only", "fully_autonomous"],
  "handlers_wired": false,
  "handlers_wired_tracking": "see /ready body for the unblockers"
}
```

`/v0/ai/ready` returns **503** with structured unblocker fields until a future PR mounts handlers.

## What's live (PRs A–F)

| Layer                                                                                                                        | Provided by                       |
| ---------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| Module boundary + Fastify plugin                                                                                             | PR A                              |
| Branded ID types (`AIChatSessionId`, `AIWorkflowExecutionId`, `GuardrailTemplateId`)                                         | PR A                              |
| Mode 1 chat wire-shape `Mode1ChatResponseView` (type-only — handler NOT mounted)                                             | PR B                              |
| Mode 2 case-prep wire-shape `Mode2CasePrepResponseView` (type-only)                                                          | PR C                              |
| `LLMProvider` interface + `BaseLLMProvider` fail-soft wrap + `NullLLMProvider` + registry stub                               | PR D                              |
| `ActiveLLMWorkloadType` narrowing (rejects reserved workload types at the compile layer)                                     | PR D                              |
| `CONSERVATIVE_DEFAULT_TEMPLATE` (immutable per AI-GUARD-003, deep-frozen via `Object.freeze`)                                | PR E                              |
| `PLATFORM_FLOOR_RULES` enumeration (FLOOR-007..FLOOR-013)                                                                    | PR E                              |
| `validatePlatformFloorCompliance`, `getActiveGuardrailTemplate`, `getEmergencyRollbackTemplate`                              | PR E                              |
| `runCrisisGate` — every AI surface MUST traverse this BEFORE patient input or AI output                                      | **PR F**                          |
| `emitAICrisisDetectionTrigger` — Category A `crisis_detection_trigger` audit emitter                                         | **PR F**                          |
| `AICrisisDetectionSource` granular enum (input/output × Mode 1/Mode 2)                                                       | **PR F**                          |
| FLOOR-020 audit envelope correctness (workload + autonomy derived from `resourceType`)                                       | **PR F R1**                       |
| Idempotency dedupe wired via `audit_dedupe_markers` per Sprint 34 / SI-006                                                   | **PR F R1**                       |
| Tenant-equality + discriminator-shape + required-field validation (fallback-emit on failure)                                 | **PR F R3/R7/R8/R10/R12/R13/R15** |
| PHI-leak protection across audit chain + log stream                                                                          | **PR F R14/R16**                  |
| Operational signaling via `logger.error` (`crisis_audit_emission_failed` / `crisis_audit_emitted_on_wiring_fallback` events) | **PR F R11/R12**                  |

## What's NOT live (deliberately, by design)

The `POST /v0/ai/chat` (Mode 1) and `POST /v0/ai/case-prep` (Mode 2) routes return **404** by design. Mounting them is the Codex PR B R2 CRITICAL closure — handlers cannot validate-and-reject before crisis detection fires. Mounting blocks on:

1. **Anthropic SDK + secrets management** — `NullLLMProvider` is the only registered provider. Real adapters (Anthropic primary, Bedrock + Azure OpenAI for resilience per ADR-020) need AWS Secrets Manager setup + per-tenant KMS key derivation contract.
2. **Clinical-grade NLP crisis classifier** — `src/lib/crisis-detection.ts` is a v1.0 keyword stub. The file-level open-question requires AI Safety Lead sign-off before patient-facing deployment.
3. **Protocol-engine slice** — Mode 2 case-prep depends on the protocol-engine + I-012 reject-unless three-clause rule wiring per State Machines v1.2 §19 §19.X.
4. **CCR-driven crisis escalation resolver** — `CrisisGateContext.escalationDestination` is currently caller-supplied. Production handlers need `resolveCrisisEscalation(tenantId, crisisType)` reading the tenant's CCR.
5. **Delivery-outcome audit emission path** — The gate emits `response_provided: null` because at gate time the response has not been delivered. A live handler must emit a follow-up delivery-outcome audit once the crisis-resource envelope reaches the patient (R9 / R12 contract).

## How to use the crisis gate (for future handler authors)

```ts
import { runCrisisGate, type CrisisGateContext } from 'src/modules/ai-service';
import { buildIdempotencyCtx } from 'src/lib/idempotency';

// At the FIRST step of the handler, BEFORE any LLM provider call:
const inputCtx: CrisisGateContext = {
  tenantId: req.tenantContext.tenantId,
  countryOfCare: req.tenantContext.countryOfCare,
  aiActorId: 'system:ai_mode_1',
  patientId: req.user.patientId,
  resourceType: 'ai_chat_session',
  resourceId: chatSessionId,
  escalationDestination: await resolveCrisisEscalation(/* CCR */),
  idempotencyCtx: buildIdempotencyCtx(req),
};
const inputOutcome = await runCrisisGate(inputCtx, req.body.message, 'ai_chat_input');
if (inputOutcome.kind === 'crisis') {
  // Map to documented crisis-resources response envelope.
  // (audit row is already durable; the gate handled FLOOR-020 emission.)
  return renderCrisisResourceResponse(inputOutcome);
}

// ... call the LLM provider ...
const aiResponseText = await provider.sendCompletion(...);

// AT THE LAST STEP, BEFORE surfacing the AI response (defense-in-depth):
const outputOutcome = await runCrisisGate(inputCtx, aiResponseText, 'ai_chat_output');
if (outputOutcome.kind === 'crisis') {
  // Suppress the AI response; surface crisis resources instead.
  return renderCrisisResourceResponse(outputOutcome);
}

return { /* normal AI response envelope */ };
```

For Mode 2 case-prep handlers that scan multiple consult segments, supply `auditDedupeDiscriminator` (a non-PHI segment id) per call so each segment emits its own audit:

```ts
await runCrisisGate(
  { ...ctx, auditDedupeDiscriminator: 'chief_complaint' },
  consultData.chiefComplaint,
  'ai_case_prep_input',
);
```

## Hard rules (platform-floor; bind independent of PR sequencing)

Per CLAUDE.md, AI_LAYERING v5.2, and Master PRD v1.10:

- **FLOOR-007:** Every AI response carries `source_type: "ai"`. Identity never concealed.
- **FLOOR-008:** No impersonation of named human clinicians.
- **FLOOR-009 / I-019:** Crisis detection runs on every conversation regardless of guardrail template. No template, no admin configuration, can disable it. Implemented at `internal/crisis/gate.ts`.
- **FLOOR-010:** No specific dosing advice outside an authenticated, consented care relationship.
- **FLOOR-011:** No definitive diagnosis without clinician review.
- **FLOOR-012:** AI-initiated workflows pass through the same service gates as user-initiated workflows.
- **FLOOR-013:** Mandatory escalation conditions cannot be bypassed by guardrail config — including the post-generation AI-output scan (R2 closure: dedupe key discriminates input vs output).
- **AI-ARCH-001 (v5.2 §10 scope statement):** At v1.0 the platform admits exactly two active workload types — `conversational_assistant` (Mode 1) and `protocol_execution` (Mode 2). Reserved types require successor ADR + activation audit event before code paths exist (enforced at the type level via `ActiveLLMWorkloadType`).
- **I-012:** Mode 2 may only reach `executed` state for prescribing actions via `action_with_confirm` + explicit clinician confirmation + RBAC-authorized confirming actor (reject-unless three-clause rule). Enforcement lives in the protocol-engine slice (not this module).
- **Tenant scoping (§9):** Conversations are tenant-scoped; `(tenant_id, ai_chat_session_id)` is the authorization pair; guardrail templates are platform-scoped with tenant override capacity (RBAC v1.1 gates the override); provider selection is platform-scoped.
- **AI-GUARD-003:** Conservative Default guardrail template is **immutable** (deep-frozen at module load per PR E R1 HIGH closure).
- **AI-RESIL-001:** LLM provider unavailability does NOT cascade to clinical workflows. `BaseLLMProvider` wraps subclass methods in fail-soft try/catch (PR D R1 HIGH closure).
- **FLOOR-020 + crisis-write exception:** If crisis-audit emission fails at the infrastructure layer, the gate still returns the crisis sentinel so the patient gets the response. Caller-wiring errors fall through to a best-effort emit path with `wiring_error` recorded in detail; the audit row STILL lands in all caller-error cases except invalid `tenantId` (no safe substitution; falls to `audit_emitted: false` + `crisis_audit_emission_failed` log).

## Codex adversarial-review trajectory on PR F

PR F (the crisis-gate wiring) passed through **16 rounds** of Codex adversarial review (R1–R16), each closing exactly one or two HIGH findings before merge. The trajectory mirrors the v1.10.1 hygiene cycle's long-tail asymptote pattern. See `Telecheck_v1_10_PRD_Update/AI_Service_Rollout_24h_Status_2026-05-14.md` in the spec corpus for the per-round closure table.

Notable architectural decisions surfaced by the review:

- The **safety contract** ("crisis sentinel ALWAYS returns on positive detection") and the **audit contract** ("emit on every positive detection") are cleanly separated. Wiring errors don't block patient safety AND don't suppress the audit row (R10 + R12).
- The (Mode 1 vs Mode 2) workload-type pair is **derived** from `resourceType`, not free on the API surface — preventing mislabeled emissions by construction (R1).
- Idempotency dedupe key is composed of `(tenant, idempotencyKey, endpoint, actor, bodyHash, source, resourceId, optional discriminator)` — covers input-vs-output, multi-resource, and multi-segment scans without cross-contamination (R2/R5/R6/R7/R8).
- PHI never reaches the audit chain or log stream from any validation path — shape-only metadata only (R14/R16).
- Caller-side rollback of an outer business transaction cannot erase the audit row — `withTransaction` opens a fresh pool connection (R4; `externalTx` parameter removed by-design).

## Spec references

- ADR-001 modular monolith
- ADR-002 binary AI mode framing (preserved at v1.0)
- ADR-005 protocolized autonomy (preserved at `action_with_confirm` for `protocol_execution`)
- ADR-020 multi-provider LLM abstraction
- ADR-023 multi-tenancy Model A
- ADR-029 AI workload taxonomy
- AI Clinical Assistant Slice PRD v1.0
- AI_LAYERING v5.2 §1–§10
- WORKLOAD_TAXONOMY v5.2 + AUTONOMY_LEVELS v5.2
- AUDIT_EVENTS v5.3 §Category A `crisis_detection_trigger`
- FLOOR-007 through FLOOR-013, FLOOR-020 (AI-portion platform floor)
- I-003, I-012, I-019, I-023, I-025, I-027

## Module layout

```
src/modules/ai-service/
├── README.md                                  # this file
├── index.ts                                   # public interface (ADR-001 surface)
├── plugin.ts                                  # Fastify plugin registration
├── routes.ts                                  # /v0/ai/{health,ready} routes
└── internal/                                  # NOT exported; module-internal only
    ├── types.ts                                # branded IDs, response views, workload types
    ├── providers/
    │   ├── types.ts                            # LLMProvider interface + BaseLLMProvider + errors
    │   ├── null-provider.ts                    # NullLLMProvider stub (PR D)
    │   └── registry.ts                         # resolveProvider(workload_type) routing (PR D)
    ├── guardrails/
    │   ├── types.ts                            # GuardrailTemplate + PLATFORM_FLOOR_RULES (PR E)
    │   ├── conservative-default.ts             # immutable Conservative Default (PR E)
    │   └── registry.ts                         # getActiveGuardrailTemplate + validator (PR E)
    └── crisis/
        ├── audit.ts                            # emitAICrisisDetectionTrigger (PR F)
        └── gate.ts                             # runCrisisGate (PR F)
```

## Integration tests

- `tests/integration/ai-service-plugin-wiring.test.ts` — `/health`, `/ready`, `/chat`/`/case-prep` 404, tenant-blind probes
- `tests/integration/ai-service-guardrails.test.ts` — Conservative Default immutability + platform-floor validator
- `tests/integration/ai-service-crisis-gate.test.ts` — 30+ test cases covering all 16 R-closures: no-crisis path, positive Mode 1/Mode 2 emissions, workload-envelope correctness, idempotency dedupe (single + multi-resource + multi-segment), wiring-error fallback, PHI-leak protection across audit + log, tenant equality, discriminator shape validation, required-field substitution, operational signaling
