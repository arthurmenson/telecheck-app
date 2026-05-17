# SI-003 — DOMAIN_EVENTS v5.2 placeholder event-type strings

**Raised by:** Engineering (autonomous turn 2026-05-05)
**Date:** 2026-05-05
**Severity:** medium
**Status:** Open — awaiting Engineering Lead + Privacy/Compliance ratification
**Target spec doc:** `Telecheck_Contracts_Pack_v5_00_DOMAIN_EVENTS.md` (v5.2 in headers)
**Parallel SI:** SI-002 (audit-side placeholder gap)
**Related slice PRDs:** Forms/Intake v2.1 §17, Identity Spec §3, Consent Slice PRD v1.0 §10

---

## What I'm trying to implement

Three implementation-complete slices (Forms/Intake, Identity & Auth, Consent + Delegated Access) emit lifecycle domain events end-to-end via the established same-transaction outbox pattern (`lib/domain-events.ts emitDomainEvent()`). Every emission carries the canonical DOMAIN_EVENTS v5.2 envelope per I-016 (immutable; INSERT failure aborts the tx) + I-023 (every event carries `tenant_id`; partition key is composite `tenant_id:aggregate_id`). The outbox table accepts the events, the chain works, and outbox-landing tests assert correct delivery (4 cases consent at `f3c759f`, 5 cases identity at `4fa12b3`).

What's missing: **canonical event-type strings ratified in DOMAIN_EVENTS v5.2**.

## What the spec says

`Telecheck_Contracts_Pack_v5_00_DOMAIN_EVENTS.md` (v5.2) enumerates the `intake_response` aggregate (event types `intake_response.submitted`, `.ai_evaluated`, `.physician_reviewed`, `.approved`, `.declined`) but does NOT enumerate event-type strings for:

- **Forms/Intake aggregates beyond `intake_response`:** `forms_template`, `forms_deployment`, `forms_variant`, `forms_resume_state`
- **Identity aggregates:** `account`, `session`, `otp`, `device`
- **Consent + Delegation aggregates:** `consent`, `delegation`, `delegation_scope`

EHBG §12 applies — engineering doesn't author canonical event types. The slices ship with the strings inline (no placeholder cast helper because the strings are passed positionally to `emitDomainEvent`); the values themselves are not ratified.

## What's unclear

The 28 placeholder event-type strings emitted by the 3 slices are listed below. Each needs:

1. **Ratification** — does Engineering Lead accept this exact string? Snake_case-with-underscores within domain (`identity.account.created`) vs hyphenated, dot-namespaced, etc. — pick one convention and apply consistently.
2. **Aggregate-type assignment** — which canonical aggregate names (`account` vs `identity.account` vs `Account`)?
3. **Payload-shape ratification** — what fields are mandatory in `payload` per event? Slices currently emit a slice-specific shape; v5.2 may require additional metadata fields (correlation_id, causation_id, audit_id, schema_version per the `domain_events_outbox` migration comment).
4. **Compatibility with Forms/Intake v2.1 §17 ratified events** — the existing `intake_response.*` and `intake_subscription_intent` events are canonical; the new strings should not collide or contradict.

## What I'd propose

### Forms/Intake placeholder event-type strings (12)

| Placeholder string                 | Aggregate          | Slice section           |
| ---------------------------------- | ------------------ | ----------------------- |
| `forms_template.created`           | forms_template     | Forms Engine v2.1 §6    |
| `forms_template.version_published` | forms_template     | Forms Engine v2.1 §6    |
| `forms_deployment.created`         | forms_deployment   | Forms Engine v2.1 §3    |
| `forms_deployment.retired`         | forms_deployment   | Forms Engine v2.1 §3    |
| `forms_variant.created`            | forms_variant      | Forms Engine v2.1 §14.5 |
| `forms_variant.winner_promoted`    | forms_variant      | Forms Engine v2.1 §14.5 |
| `forms_variant.retired`            | forms_variant      | Forms Engine v2.1 §14.5 |
| `forms_resume_state.saved`         | forms_resume_state | Forms Engine v2.1 §8.2  |
| `forms_resume_state.restored`      | forms_resume_state | Forms Engine v2.1 §8.2  |
| `intake_response.submitted` (✅)   | intake_response    | (canonical in v5.2)     |
| `intake_response.completed`        | intake_response    | Forms Engine v2.1 §13   |
| `intake_subscription_intent`       | intake_response    | Forms Engine v2.1 §17.1 |

### Identity & Auth placeholder event-type strings (9)

| Placeholder string               | Aggregate | Slice section      |
| -------------------------------- | --------- | ------------------ |
| `identity.account.created`       | account   | Identity Spec §3.1 |
| `identity.account.activated`     | account   | Identity Spec §3.1 |
| `identity.session.issued`        | session   | Identity Spec §3.2 |
| `identity.session.revoked`       | session   | Identity Spec §3.2 |
| `identity.otp.issued`            | otp       | Identity Spec §3.4 |
| `identity.otp.consumed`          | otp       | Identity Spec §3.4 |
| `identity.otp.lockout_triggered` | otp       | Identity Spec §3.4 |
| `identity.device.registered`     | device    | Identity Spec §3.3 |
| `identity.device.revoked`        | device    | Identity Spec §3.3 |

### Consent + Delegated Access placeholder event-type strings (8)

| Placeholder string         | Aggregate        | Slice section      |
| -------------------------- | ---------------- | ------------------ |
| `consent.granted`          | consent          | Consent Slice §7.1 |
| `consent.revoked`          | consent          | Consent Slice §7.1 |
| `delegation.invited`       | delegation       | Consent Slice §6.1 |
| `delegation.accepted`      | delegation       | Consent Slice §6.1 |
| `delegation.declined`      | delegation       | Consent Slice §6.1 |
| `delegation.revoked`       | delegation       | Consent Slice §6.1 |
| `delegation.scope_granted` | delegation_scope | Consent Slice §6.2 |
| `delegation.scope_revoked` | delegation_scope | Consent Slice §6.2 |

**Total placeholder event types: 28** (12 forms-intake + 9 identity + 8 consent — minus 1 already-ratified `intake_response.submitted`).

## Resolution path

### Step 1 (spec corpus, owned by Engineering Lead + Privacy/Compliance)

1. Review the 28 placeholder strings above
2. Pick canonical naming convention (note Forms/Intake mixes `forms_template.created` with `intake_response.submitted` — both work; this corpus might benefit from picking `<aggregate>.<lifecycle_event>` uniformly)
3. Author the DOMAIN_EVENTS v5.2 enumeration block adding all 28 ratified event-type strings (or v5.3 amendment)
4. Define the mandatory `payload` shape per event (field names, types, nullability)
5. Promotion Ledger entry P-013 closes this SI

### Step 2 (this code repo, owned by Engineering)

Once Step 1 lands:

1. If naming convention shifts, do a sweeping rename across the 3 events.ts files (consent/identity/forms-intake)
2. Update tests that assert event-type strings (e.g., `tests/integration/consent-domain-events.test.ts` § asserts `'consent.granted'` literal; identity test similarly)
3. The outbox itself doesn't need migration — the `event_type` column is free-form TEXT
4. Cross-slice consumers using `subscribe(eventType)` patterns will need to update their match strings

## What I'm doing in the meantime

**Continuing to ship slice work using the inline-string pattern.** Every new domain event from a future slice (Pharmacy, Med Interaction, Subscription, etc.) follows the same inline approach. The pattern is well-established (3 slices × ~10 events each, 28 total) and the cost of mass-renaming when SI-003 closes is bounded.

Same autonomous-turn discipline as SI-002: **never invent new canonical contract artifacts in the code repo.** Spec gaps surface as SIs.

## Required from product

| Item                                                                                 | Owner                                 | Severity |
| ------------------------------------------------------------------------------------ | ------------------------------------- | -------- |
| DOMAIN_EVENTS v5.2 — ratify 28 placeholder event-type strings                        | Engineering Lead + Privacy/Compliance | medium   |
| Decide naming convention (consistent across forms/identity/consent)                  | Engineering Lead                      | low      |
| Define mandatory `payload` shape per event                                           | Engineering Lead + Slice owners       | medium   |
| Decide whether `correlation_id` / `causation_id` / `audit_id` are mandatory metadata | Engineering Lead                      | medium   |

---

## Cross-references

- EHBG v1.3 §12 — SI escalation template
- DOMAIN_EVENTS v5.2 §envelope — current shape (no enumerated event-type list beyond `intake_response.*`)
- I-016 — domain events immutable (preserved regardless of event-type names)
- I-023 — every event carries tenant_id (preserved regardless of names)
- `src/modules/consent/events.ts` — 8 emitters
- `src/modules/identity/events.ts` — 9 emitters
- `src/modules/forms-intake/events.ts` — 13 emitters (12 placeholder + 1 ratified)
- SI-002 — parallel audit-side placeholder gap (same resolution discipline applies)

## Companion code-repo state at SI-003 raise

- **Slices emitting domain events via placeholder strings:** Forms/Intake, Identity + JWT, Consent + Delegated Access (28 placeholder event-type strings; 1 ratified).
- **Outbox-landing test coverage:** consent (4 cases at `f3c759f`), identity (5 cases at `4fa12b3`), forms-intake variant + resume_restored (deferred — happy-path emission verified by code paths but not yet asserted explicitly).
- **Slices that will inherit the pattern:** every future slice (Pharmacy, Med Interaction, Subscription, Sync Video, Async Consult, Labs, Adverse Event, RPM/CCM, etc.) until SI-003 closes.

## Resolution expectations

- **Target close-out:** Promotion Ledger entry **next-available after P-014/SI-002 closes** (originally P-013 per the v0.1 plan, but **P-013 was claimed by SI-007 v0.19 merged 2026-05-14** for Refill/Dispensing/Shipment schema closure; **P-014 was claimed by SI-002 v0.5** for AUDIT_EVENTS placeholder ratification). SI-003's effective slot is now **next-available after P-018/SI-008** (since SI-005 → P-017 and SI-008 → P-018 also intervene per their Status blocks), pending the next ratification ceremony's queue ordering. **Retargeting added 2026-05-17 per PR #175 R2 MEDIUM closure** to make this SI's P-NUM situation authoritative on its own Status block rather than presenting a stale P-013 target the matrix r7 OPEN list had to flag as drifted.
- **Until then:** SI-003 stays open in this file; all slices use inline event-type strings; tests pin the strings as assertion predicates so out-of-band rename surfaces as test failure.
