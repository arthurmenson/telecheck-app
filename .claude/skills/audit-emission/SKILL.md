---
name: audit-emission
description: Emit AUDIT_EVENTS v5.2 envelopes with the correct canonical action ID, tenant-context-bound envelope, AI workload sentinel handling for null/unknown/reserved cases, hash-chain awareness, I-031 high-PII sensitivity for research events, and bare-suppression-forbidden discipline (rejected paths still emit). Use whenever you need to emit an audit event.
when_to_invoke: Any time code changes state, denies an action, observes a security-relevant event, or completes/invalidates a research export. If you would normally call console.log() to record what happened — emit audit instead.
tools_used: Read, Edit, Write, Grep
---

## When to use this skill

Any time code does any of the following, an audit event must be emitted:
- a state-machine transition succeeds or is rejected
- an authorization check denies an action
- a break-glass / cross-tenant access is opened or closed
- a tenant configuration change lands
- a research data export is completed, invalidated, or signal-enforcement-triggered
- an AI workload completes or is rejected
- a notification is delivered (use `notification-emission` skill which then calls into this one)

If you find yourself thinking "this rejection is obvious, I won't audit it" — **stop**. I-003 forbids bare suppression on rejection.

## Read first

Set `${SPEC}` = `${TELECHECK_SPEC_PATH:-../telecheckONE/Telecheck Master Bundle FINAL US REGION BASELINE}`.

1. `${SPEC}/Telecheck_Contracts_Pack_v5_00_AUDIT_EVENTS.md` (v5.2) — envelope shape + canonical action IDs catalog
2. `${SPEC}/Telecheck_Contracts_Pack_v5_00_INVARIANTS.md` — I-003 (append-only + hash chain + bare-suppression-forbidden), I-005 (full attribution on AI), I-018 (delegate attribution), I-027 (envelope tenant_id), I-031 (research at high_pii)
3. `${SPEC}/Telecheck_Contracts_Pack_v5_00_WORKLOAD_TAXONOMY.md` (v5.2) — for `ai_workload_type` field values + sentinel rule
4. `${SPEC}/Telecheck_Contracts_Pack_v5_00_AUTONOMY_LEVELS.md` (v5.2) — for `autonomy_level` field values
5. ADR-029 — AI workload taxonomy
6. `${SPEC}/Telecheck_Contracts_Pack_v5_00_GLOSSARY.md` — for canonical action ID naming convention

## Workflow

1. **Find or assign the canonical action ID** in AUDIT_EVENTS v5.2. Format: `<entity>.<verb_past_tense>` for success (`appointment.scheduled`, `medication_request.submitted`), `<entity>.<verb>_rejected` for guard rejection (`medication_request.execution_rejected`), `<entity>.<verb>_denied` for RBAC denial. Research export invalidation: `research.export_completed(status=invalidated)` paired with `signal_enforcement_trigger` Category B audit. If your action is not in the catalog, propose it via §12 SI/DSI escalation; do NOT invent.
2. **Build the envelope.** Required fields per AUDIT_EVENTS v5.2:
   - `tenant_id` — always (I-027). Sourced from `req.tenantContext.tenantId`.
   - `actor_id` — the authenticated subject. For delegate actions, also `delegate_actor_id` (I-018).
   - `action` — canonical action ID from step 1
   - `resource_type`, `resource_id`
   - `outcome` — one of `success` | `denied` | `failed` | `invalidated` (last one for research)
   - `correlation_id` — propagated from request
   - `request_id` — per request
   - `timestamp` — server-side `now()`
   - `hash_chain_prev` — handled by audit storage layer (do not set manually)
3. **AI fields (per ADR-029 + WORKLOAD_TAXONOMY v5.2 envelope-population rule).** If the action involves AI:
   - `ai_workload_type` — one of the defined values from WORKLOAD_TAXONOMY. **Sentinel rule:** if the workload type is null/unknown/reserved-future (not yet activated by a successor ADR), populate with the `none` sentinel (or `unknown` for resolution-failure cases). Per Codex Round-4 envelope-population rule.
   - `autonomy_level` — one of the AUTONOMY_LEVELS values; same sentinel rule for null/unknown/reserved.
   - `model_version`
   - `guardrail_template_id` (Mode 1) OR `protocol_id` + `protocol_version` (Mode 2)
   - `source_type`
4. **Sensitivity classification.** Default is `audit_sensitivity_level: standard`. **Research data export events MUST emit at `high_pii` per I-031.** Break-glass and tenant-config changes default to `elevated`.
5. **Rejection emission discipline (I-003).** When a guard rejects, an RBAC check denies, or an I-029 condition fails: emit the audit BEFORE returning the error to the caller. Include `denial_reason` (canonical enum value where one exists — e.g., the 6-value `invalidation_reason` for research export invalidation).
6. **Hash chain awareness.** The audit storage layer computes `hash_chain_curr = hash(prev_hash || envelope_json)`. Application code must NOT compute or set the hash. Application code must NOT update or delete audit rows (I-003 — enforced by `.claude/settings.json` permissions deny rule and by DB grants in production).
7. **Same DB transaction** as the action being audited. The `audit.emit({ ... })` helper accepts a `tx` parameter; pass the tx in. If the underlying action rolls back, the audit should too — otherwise you have an audit row describing something that didn't happen.
8. **Test.** For every audit-emitting code path: assert the audit row exists post-call, assert envelope fields match expectations, assert the `outcome` is correct on success and rejection, assert the AI fields use the sentinel where the workload is null/reserved.

## Hard rules

- **I-003:** append-only. No UPDATE, no DELETE on audit_records. Hash chain integrity must hold. Bare suppression on rejection forbidden.
- **I-027:** envelope carries `tenant_id`. Always.
- **I-031:** research data export at `high_pii`.
- **I-005:** AI content audits include full attribution (workload type, autonomy level, model_version, guardrail/protocol).
- **I-018:** delegate actions carry both `actor_id` (the delegate) and the principal's identity for attribution.
- **Sentinel rule:** null/unknown/reserved AI workload type → `none` (or `unknown` for resolution failure). Do not omit the field.
- **Same DB transaction** as the auditable action.
- **Glossary:** action IDs use canonical entity names (`medication_request`, not `prescription`).

## Common mistakes

- **Emitting outside the transaction.** Audit row commits even when the underlying action rolls back. Worst case in audit hygiene.
- **Skipping audit on rejection** because "the user already saw the error." I-003 violation.
- **Using `console.log` to record what happened.** Audit is the system of record, not stdout.
- **Setting `hash_chain_curr` manually.** Storage layer computes; app code provides the envelope.
- **Inventing an action ID** that isn't in AUDIT_EVENTS v5.2. Always reference the catalog; if missing, escalate via §12.
- **Leaving `ai_workload_type` unset on an AI-emitting endpoint.** Use the sentinel — do not omit.
- **Logging PHI in audit `denial_reason` strings.** `denial_reason` is an enum, not a free-text field. PHI never goes in audit free-text outside designated structured fields.

## Reporting

- **Action IDs emitted:** list with success / rejection variants
- **Envelope fields populated:** list, especially AI fields if applicable + sensitivity level
- **Sentinel applied?** yes/no, where, and which value (`none` / `unknown`)
- **Spec citations:** AUDIT_EVENTS v5.2 §X; INVARIANTS §I-XXX; ADR if applicable
- **Tests added:** assertion coverage for envelope, outcome, sensitivity, sentinel
