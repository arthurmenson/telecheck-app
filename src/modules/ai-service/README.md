# AI Service module — mode_1_persistence_wired

## Status (post-Mode-1-persistence wiring: 2026-07-08)

This module hosts the Telecheck platform's two-mode AI surface per **AI Clinical Assistant Slice PRD v1.0** + **AI_LAYERING v5.2**. As of the Mode 2 case-prep handler mount (PR H 2026-05-23), **Mode 1 chat (POST /v0/ai/chat) is LIVE; Mode 2 case-prep (POST /v0/ai/case-prep) is DEFINED but CONFIG-GATED behind `AI_MODE2_ENABLED` (default `false`)** per Codex PR #210 R1 NEEDS-WORK closure (2026-05-24). Mode 1 exercises the full I-019 crisis-detection floor, FLOOR-020 audit emission, and AI-RESIL-001 fail-soft path; every non-crisis response is currently the documented "AI temporarily unavailable" envelope because the LLM provider abstraction routes every workload to NullLLMProvider until real adapters (Anthropic primary + Bedrock + Azure OpenAI per ADR-020) ship with secrets-management resolution.

As of 2026-07-08 the Mode 1 chat handler **persists every turn into the migration-067 conversation entities** (P-035 Mode 1 Handler Spec v0.4 + P-036 CDM v1.8) — see the "Mode 1 conversation persistence" section below. `/v0/ai/ready` still returns **503**: persistence narrows the pending list but the real-provider + clinical-grade-crisis-classifier + protocol-engine gates remain.

## Mode 1 conversation persistence (migrations 066/067/068)

Every `POST /v0/ai/chat` turn is persisted **in the same transaction** as the idempotency reservation and the FLOOR-020 response audit, under the dedicated `ai_service_mode1` DB role (created + granted INSERT/SELECT on exactly the 4 lifecycle tables by migration 068, per the P-035-ratified Mode 1 spec §5.1 Layer 1 "dedicated DB role" sentence; acquired via `SET LOCAL ROLE` through `withDbRole` per the migration-051 Option B pattern):

| Entity (CDM v1.8) | What lands | When |
| --- | --- | --- |
| `ai_mode1_conversation` | Conversation envelope; id is deterministic per Idempotency-Key when the client sends no `ai_chat_session_id`; when the client supplies one, the row is loaded + patient-ownership-validated (tenant-blind 404 per I-025 on any miss) | every persisted turn |
| `ai_mode1_conversation_turn_admission` | `turn_id` (deterministic UUID), raw `user_message`, `request_body_hash` (idempotency hasher output), `history_snapshot_high_water_mark` (spec §6.3; `-infinity` floor for first turns), window 20 | every persisted turn |
| `ai_mode1_conversation_turn_detector_result` | `severity NULL + crisis_server_signal_id NULL` no-crisis shape + detector version/latency; its existence is the §4.2 `detector_completed` precondition SELECT-verified before any provider call | **non-crisis turns only** (see spec-gated deferral) |
| `ai_mode1_conversation_turn_result` | Terminal state: `completed` (crisis sentinel or — future — real assistant text + provider/model/tokens) or `failed` (`llm_provider_unavailable` / `during_llm` for the NullProvider fail-soft path; `assistant_message NULL`) | every persisted turn |

**Wire-shape note:** `ai_chat_session_id` / `message_id` in `Mode1ChatResponseView` are now the conversation / turn UUID primary keys. The request body accepts an optional `ai_chat_session_id` (UUID) to thread an existing conversation — ownership is validated server-side, which closes the R3 H2 client-trust hazard that previously forced one-shot sessions.

**Spec-gated deferrals (do not "fix" these inline — they are ratification-blocked):**

1. **Crisis-positive detector-result rows are NOT persisted.** The ratified `signal_iff_severity` CHECK requires a `crisis_server_signal_id` referencing the I-019 enqueue-ack log, whose canonical code-repo target is DEFERRED in migration 067 pending ratifier confirmation (`i019_enqueue_ack_log` does not exist), and the keyword-stub detector's `CrisisType` taxonomy does not map bijectively onto the ratified severity enum. The Category A `crisis_detection_trigger` audit (own-tx, rollback-immune) remains the durable I-019 record for crisis turns.
2. **`ai.mode1.*` audit action IDs (AUDIT_EVENTS v5.10, 11 IDs)** are not yet registered at the app layer; the existing `ai_chat_response_emitted` placeholder + crisis Cat A emission discipline is unchanged. Registration + per-phase emission is a follow-up PR.
3. **No conversation-history/state READ endpoint.** The P-035 spec ratifies only `POST` (§2.1); no GET surface is ratified, so none is implemented. The `ai_mode1_conversation_state` view + `ai_mode1_reader` role (migration 067) stay unconsumed by this module until a read endpoint is ratified.
4. **I-026 at-rest encryption for `user_message` / `assistant_message`** rides the platform KMS integration (src/lib/kms.ts is a throwing stub outside tests; Track 5) — same posture as every other PHI-bearing TEXT column in the repo.
5. **`internal_error`-class turn-result rows** cannot survive their own transaction's rollback (unknown errors rethrow → tx rollback); a durable own-tx failure writer is deferred alongside item 2.

## Mode 2 case-prep route mount gate (`AI_MODE2_ENABLED`)

`POST /v0/ai/case-prep` is **DEFINED but NOT mounted by default**. Set `AI_MODE2_ENABLED=true` in the environment to mount the route.

**Production rollout requires ALL THREE Day-3+ prerequisites before flipping the flag to `true`:**

1. **Clinical-anchor authorization** — the JWT-role gate (`actor.role === 'clinician'`) is not sufficient. The handler must additionally verify the clinician is on the consult's care team for the named protocol. Until this lands, any clinician with a valid JWT can prepare a case for any patient under any protocol — a tenant-isolation-adjacent risk surface that the platform-floor does not yet enforce at the case-prep boundary.
2. **Real protocol-engine provider execution** — at v0.1 the route resolves to `NullLLMProvider` (which always throws `LLMProviderUnavailableError` → AI-RESIL-001 fail-soft envelope). The downstream protocol-engine slice + the I-012 reject-unless three-clause rule at the prescribing boundary (State Machines v1.2 §19 §19.X) must ship before the route is allowed to return a real AI recommendation. The case-prep envelope is the audit anchor the downstream `prescribing.protocol_authorization_granted` event references via `ai_workflow_execution_id`; until the downstream binding is live, the case-prep envelope is an orphan reference.
3. **Verified audit-emission discipline** — the unit-test mock confirms the `ai_mode_2_evaluation` Category A audit emits on every response path (crisis, success, fail-soft), and `mode2_case_prep_audit_emission_failed` maps to a tenant-blind 503 via `mapServiceError`. The end-to-end verification (live Postgres + I-027 tenant_id stamping + audit-chain hash continuity across the case-prep lifecycle) is pending the protocol-engine integration test harness.

Until all three land, **production MUST keep `AI_MODE2_ENABLED=false`**. This is the honest-failure-until-wiring-lands pattern, matching the C1 cockpit precedent — ship the route DEFINED but BEHIND A FLAG so prod can't reach it; Day-3+ wiring flips the flag.

**Operator-facing introspection:** both `/v0/ai/health` and `/v0/ai/ready` report `mode2_case_prep_mounted` honestly (true / false) along with the `mode2_case_prep_mount_gate` env-var name and (on `/health`) the three Day-3+ prerequisites. An operator who pings `/health` immediately sees whether the route is reachable in the active config.

**Startup-log signal:** when `AI_MODE2_ENABLED=false`, the route registrar logs a structured `warn` (`gate: 'AI_MODE2_ENABLED'`) at boot so an operator inspecting startup logs sees the gate explicitly. Silent unmount would be a worse trade than a noisy startup line.

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
  "handlers_wired": true,
  "handlers_wired_tracking": "Mode 1 chat (PR G) MOUNTED; Mode 2 case-prep (PR H) DEFINED + config-gated behind AI_MODE2_ENABLED (default false) per Codex PR #210 R1 NEEDS-WORK closure",
  "mode2_case_prep_mounted": false,
  "mode2_case_prep_mount_gate": "AI_MODE2_ENABLED",
  "mode2_case_prep_day3_prerequisites": [
    "clinical_anchor_authorization (clinician-on-care-team-for-named-protocol)",
    "real_protocol_provider_execution (I-012 reject-unless three-clause at prescribing boundary)",
    "verified_audit_emission_discipline (I-019 + I-027 end-to-end against live Postgres + real LLM provider)"
  ]
}
```

`/v0/ai/ready` returns **503** with structured unblocker fields — including `mode2_case_prep_mounted` and `mode2_case_prep_mount_gate` — until production rollout completes.

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

`POST /v0/ai/chat` (Mode 1) is now MOUNTED (PR G 2026-05-15). `POST /v0/ai/case-prep` (Mode 2) is DEFINED but **config-gated** behind `AI_MODE2_ENABLED` (default `false`) per Codex PR #210 R1 NEEDS-WORK closure (2026-05-24) — the route returns **404** in any environment that has not flipped the flag. See the "Mode 2 case-prep route mount gate" section above for the three Day-3+ prerequisites before the flag may be flipped in production.

Even when the Mode 2 flag is on, the documented "AI temporarily unavailable" envelope is the dominant response path — the handler still surfaces the AI-RESIL-001 fail-soft envelope because `NullLLMProvider` is the only registered provider. Real provider integration blocks on:

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
    ├── handlers/
    │   ├── chat.ts                             # Mode 1 chat handler (PR G; persistence wired 2026-07-08)
    │   └── case-prep.ts                        # Mode 2 case-prep handler (PR H; AI_MODE2_ENABLED-gated)
    └── crisis/
        ├── audit.ts                            # emitAICrisisDetectionTrigger (PR F)
        └── gate.ts                             # runCrisisGate (PR F)
```

## Integration tests

- `tests/integration/ai-service-plugin-wiring.test.ts` — `/health`, `/ready`, `/chat`/`/case-prep` 404, tenant-blind probes
- `tests/integration/ai-service-guardrails.test.ts` — Conservative Default immutability + platform-floor validator
- `tests/integration/ai-service-mode-1-chat-http.test.ts` — Mode 1 chat HTTP lifecycle (crisis bypass, fail-soft, idempotency, deterministic IDs) + Group P persistence assertions against the migration-067 entities
- `tests/integration/ai-service-mode-1-chat-audit-injection.test.ts` — FLOOR-020 audit-failure round-trip (503 + rollback + deterministic-ID retry; exactly-one Cat A crisis audit)
- `tests/integration/ai-service-crisis-gate.test.ts` — 30+ test cases covering all 16 R-closures: no-crisis path, positive Mode 1/Mode 2 emissions, workload-envelope correctness, idempotency dedupe (single + multi-resource + multi-segment), wiring-error fallback, PHI-leak protection across audit + log, tenant equality, discriminator shape validation, required-field substitution, operational signaling
