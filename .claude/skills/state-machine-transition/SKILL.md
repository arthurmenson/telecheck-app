---
name: state-machine-transition
description: Implement a state-machine transition per State Machines v1.1 with guard evaluation, idempotency, audit emission on success AND rejection, and domain event emission within the same DB transaction. Use whenever you write code that moves an entity from one state to another (appointment scheduled→started, medication_request draft→submitted, research_export ready→delivered, etc.).
when_to_invoke: Implementing or modifying a state-machine transition for any entity governed by State Machines v1.1 (18 active state machines + 4 reserved-future on ProtocolAuthorizedAction per ADR-029).
tools_used: Read, Edit, Write, Grep, Glob
---

## When to use this skill

Any code path that mutates an entity's `state` (or `status`) column. State machines are listed in `Telecheck_State_Machines_v1_1.md` — if your entity is in that doc, you must use this skill.

If you are *creating* an entity at its initial state (e.g., a fresh `medication_request` at `draft`), that is also a transition (`<no-state> → draft`) — use this skill.

## Read first

Set `${SPEC}` = `${TELECHECK_SPEC_PATH:-../telecheckONE/Telecheck Master Bundle FINAL US REGION BASELINE}`.

1. `${SPEC}/Telecheck_State_Machines_v1_1.md` — the specific state machine for your entity (find by entity name)
2. `${SPEC}/Telecheck_Contracts_Pack_v5_00_INVARIANTS.md` — I-003 (audit append-only + bare-suppression-forbidden), I-012 (clinician sign-off three-clause rule for prescribing), I-016 (domain events immutable), I-029 (research export 6-condition gate)
3. `${SPEC}/Telecheck_Contracts_Pack_v5_00_AUDIT_EVENTS.md` (v5.2) for the audit envelope and canonical action IDs
4. `${SPEC}/Telecheck_Contracts_Pack_v5_00_DOMAIN_EVENTS.md` (v5.2) for the domain event envelope and `partition_key` rules
5. `${SPEC}/Telecheck_Contracts_Pack_v5_00_IDEMPOTENCY.md` (v5.1) for idempotency-key rules
6. The slice PRD that owns the entity, for guard semantics
7. ADR-029 if the transition is on `ProtocolAuthorizedAction` (4 reserved-future transitions)

## Workflow

1. **Locate the state machine.** Find your entity's state diagram in State Machines v1.1. Identify the `from_state`, `to_state`, the **guards** (reject-unless preconditions), and the **side effects** (audit + domain events).
2. **Implement as a single function.** Co-located in `src/modules/<module>/internal/transitions/<entity>__<from>_to_<to>.ts`. Signature roughly: `async function transition(ctx: TenantContext, input: TransitionInput, db: Tx): Promise<TransitionResult>`.
3. **Idempotency.** Accept an `idempotency_key` (tenant-scoped per IDEMPOTENCY v5.1). On retry with the same key, return the prior result without re-executing side effects. Use the `idempotency_records` table.
4. **Open a DB transaction.** All of: state column update, audit insert, domain event insert (outbox table) MUST be in one transaction. If any fails, all roll back.
5. **Evaluate guards.** Each guard is a reject-unless rule. Evaluate against the entity in its current state under `withTenantContext` so RLS applies. If any guard fails:
   - emit a canonical audit event with `outcome: "denied"` and `denial_reason` (e.g., `medication_request.execution_rejected` per I-012)
   - throw a typed `TransitionGuardError(reason)` that maps to the tenant-blind error envelope
   - **DO NOT bare-suppress.** I-003 forbids silent rejection.
6. **For prescribing / refill / medication-order transitions: enforce I-012 three-clause rule.** All three must hold before commit: `autonomy_level == "action_with_confirm"` (string equality, no looseness) AND explicit clinician confirmation present in audit chain AND confirming actor RBAC-authorized for the action class. Failure path emits `<action_class>.execution_rejected`.
7. **For `research_export` `ready → delivered`: enforce I-029 6-condition gate.** All six must hold: DSA active + k-anonymity floor met + permitted-domain match + consent-cohort hash match + per-patient active consent + per-export grant artifact unexpired/ID-hash-matched/signer-chain-attesting. Failure path emits `research.export_completed(status=invalidated)` with the canonical 6-value `invalidation_reason` enum + paired `signal_enforcement_trigger` Category B audit. I-031 emits at `audit_sensitivity_level: high_pii`.
8. **Commit the state change.** Use `UPDATE ... SET state = $new WHERE id = $id AND state = $expected` (optimistic lock — `expected` is the from-state). If `rowCount = 0`, the entity moved underneath you; treat as conflict and retry-or-abort per slice PRD.
9. **Emit success audit.** Canonical action ID format: `<entity>.<verb_past_tense>` (e.g., `appointment.started`, `medication_request.submitted`). Envelope includes `tenant_id`, `actor_id`, `resource_type`, `resource_id`, `from_state`, `to_state`, `outcome: "success"`, `correlation_id`, AI fields if applicable.
10. **Emit domain event** to the outbox table (`domain_events_outbox`) within the same transaction. `partition_key` for tenant-scoped aggregates is composite `tenant_id:aggregate_id` per DOMAIN_EVENTS v5.2. Outbox publisher polls and pushes to the bus asynchronously.
11. **Return.** Return the post-transition entity, the audit row's hash-chain index, and the domain event ID. Idempotency record now stores this for replay.
12. **Test.** (a) happy path; (b) each guard failure path emits the correct denial audit; (c) idempotency replay returns identical result without duplicate side effects; (d) optimistic-lock conflict (concurrent transition) is handled; (e) cross-tenant attempt is rejected by RLS.

## Hard rules

- **I-003:** audit append-only, hash chain integrity, bare-suppression forbidden. Every rejection emits an audit event.
- **I-016:** domain events immutable. The outbox row is written once; never UPDATE/DELETE.
- **Same DB transaction** for state update + audit + outbox row. If you find yourself emitting audit outside the transaction, stop.
- **Optimistic lock** on the from-state. `WHERE state = $expected` is the cheap concurrency guard.
- **Idempotency keys are tenant-scoped.** Same key in different tenants is independent.
- **Glossary:** use `medication_request`, not `prescription`.

## Common mistakes

- **Audit emitted outside the transaction** (so it commits even if state update fails). The audit row would describe a transition that never happened. Always inside the tx.
- **Calling `producer.publish(event)` directly instead of the outbox.** The outbox pattern is what guarantees at-least-once delivery aligned with the state change. Direct publish breaks atomicity.
- **Skipping the guard audit on rejection** because "the user already saw the error." I-003 violation. The audit trail is for governance, not the user.
- **Using `enum` updates without optimistic lock.** Concurrent transitions can both succeed if you don't include `WHERE state = $expected`.
- **For I-012 paths: comparing `autonomy_level` with loose equality / case-insensitive match.** Spec says string equality with `"action_with_confirm"`. Anything else is a violation.

## Reporting

- **Transition implemented:** `<entity> <from_state> → <to_state>`
- **Guards evaluated:** list each, with reject-unless rule and denial audit action ID
- **Audit actions emitted:** success path + each rejection path
- **Domain event:** event type + outbox table + partition_key composition
- **Idempotency key scope:** tenant-scoped + table reference
- **Tests added:** list happy + each guard rejection + idempotency + concurrency + cross-tenant
- **Spec citations:** State Machines v1.1 §X.Y; relevant invariants; ADR if applicable
