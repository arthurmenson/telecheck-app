# SI-003 — DOMAIN_EVENTS placeholder event-type strings

**Raised by:** Engineering (autonomous turn 2026-05-05)
**Date:** 2026-05-05
**v0.2 advanced:** 2026-05-14 (concrete proposals + pre-ratification gate alignment)
**Severity:** medium
**Status:** OPEN — v0.2 DRAFT, awaiting Engineering Lead + Privacy/Compliance ratification (Codex pre-ratification gate pending; mirror SI-007 / SI-002 cadence)
**Target spec doc:** `Telecheck_Contracts_Pack_v5_00_DOMAIN_EVENTS.md` (v5.2 → **v5.3**)
**Promotion Ledger target:** **P-015** (P-013 consumed by SI-007 merged 2026-05-14; P-014 reserved by SI-002 in flight at PR #136)
**Parallel SI:** SI-002 (audit-side placeholder gap; concurrent dot-namespaced naming convention)
**Related slice PRDs:** Forms/Intake v2.1 §17, Identity Spec §3, Consent Slice PRD v1.0 §10

---

## What I'm trying to implement

Three implementation-complete slices (Forms/Intake, Identity & Auth, Consent + Delegated Access) emit lifecycle domain events end-to-end via the established same-transaction outbox pattern (`lib/domain-events.ts emitDomainEvent()`). Every emission carries the canonical DOMAIN_EVENTS v5.2 envelope per I-016 (immutable; INSERT failure aborts the tx) + I-023 (every event carries `tenant_id`; partition key is composite `tenant_id:aggregate_id`). The outbox table accepts the events, the chain works, and outbox-landing tests assert correct delivery (4 cases consent at `f3c759f`, 5 cases identity at `4fa12b3`).

What's missing: **canonical event-type strings ratified in DOMAIN_EVENTS v5.3**.

## What the spec says (v0.1 unchanged)

`Telecheck_Contracts_Pack_v5_00_DOMAIN_EVENTS.md` (v5.2) enumerates the `intake_response` aggregate (event types `intake_response.submitted`, `.ai_evaluated`, `.physician_reviewed`, `.approved`, `.declined`) but does NOT enumerate event-type strings for:

- **Forms/Intake aggregates beyond `intake_response`:** `forms_template`, `forms_deployment`, `forms_variant`, `forms_resume_state`
- **Identity aggregates:** `account`, `session`, `otp`, `device`
- **Consent + Delegation aggregates:** `consent`, `delegation`, `delegation_scope`

EHBG §12 applies — engineering doesn't author canonical event types. The slices ship with the strings inline (no placeholder cast helper because the strings are passed positionally to `emitDomainEvent`); the values themselves are not ratified.

## v0.2 concrete proposals (NEW)

### Decision 1 — Naming convention: dot-namespaced (`<aggregate>.<lifecycle_event>`)

Aligns with:

- The already-ratified `intake_response.*` strings (Forms/Intake v2.1 §17)
- The Category A audit action IDs ratified at P-011 (e.g., `account.created`, `session.issued`)
- The SI-007 (Refill/Dispensing/Shipment) audit-action IDs ratified at P-013 (e.g., `refill.requested`, `shipment.dispatched`)
- The SI-002 v0.2+ proposal for AUDIT_EVENTS placeholder ratification

**Forbidden alternates** (rejected): snake_case-with-underscores within domain (`identity_session_issued`); hyphenated; `<Module>.<Aggregate>.<Event>` (3-segment overkill for v1.0).

### Decision 2 — Aggregate-type assignment

The aggregate-type stored in `domain_events_outbox.aggregate_type` matches the leading segment of the event-type string (one-to-one):

| Aggregate-type column   | Event-type prefix | Slice              |
| ----------------------- | ----------------- | ------------------ |
| `forms_template`        | `forms_template.*`        | Forms/Intake v2.1 |
| `forms_deployment`      | `forms_deployment.*`      | Forms/Intake v2.1 |
| `forms_variant`         | `forms_variant.*`         | Forms/Intake v2.1 |
| `forms_resume_state`    | `forms_resume_state.*`    | Forms/Intake v2.1 |
| `intake_response`       | `intake_response.*`       | Forms/Intake v2.1 (ratified) |
| `account`               | `identity.account.*` → `account.*` (see Decision 3) | Identity Spec §3 |
| `session`               | `identity.session.*` → `session.*` | Identity Spec §3 |
| `otp`                   | `identity.otp.*` → `otp.*` | Identity Spec §3 |
| `device`                | `identity.device.*` → `device.*` | Identity Spec §3 |
| `consent`               | `consent.*`               | Consent Slice §7  |
| `delegation`            | `delegation.*`            | Consent Slice §6  |
| `delegation_scope`      | `delegation.scope_*` → `delegation_scope.*` (see Decision 3) | Consent Slice §6 |

### Decision 3 — Drop the `identity.` prefix from identity events; align with SI-002 audit-side ratification

**Rationale:**

1. The `intake_response.*` ratified strings do not carry a `forms_intake.` module prefix. Identity events should be consistent.
2. The Category A audit action IDs ratified at P-011 are `account.created`, `session.issued`, etc. — no `identity.` prefix.
3. SI-002 v0.3 (PR #136 in flight) categorizes the audit-side placeholder strings as Category B (governance) with bare `account.*` / `session.*` / `otp.*` / `device.*` names — domain events must match exactly so a downstream consumer subscribing to "session lifecycle" can match both audit and domain events with the same prefix selector.
4. The `delegation.scope_*` → `delegation_scope.*` rename normalizes the aggregate-type column relationship one-to-one. Otherwise the `delegation_scope` aggregate would emit events under the `delegation.*` prefix, breaking the leading-segment-equals-aggregate-type rule.

### Decision 4 — Ratified 28-string canonical table

Final canonical strings (v5.3 enumeration block):

#### Forms/Intake (12 strings; 1 of which is already-ratified `intake_response.submitted`)

| Canonical string                   | Aggregate-type     | Slice section           |
| ---------------------------------- | ------------------ | ----------------------- |
| `forms_template.created`           | `forms_template`     | Forms Engine v2.1 §6    |
| `forms_template.version_published` | `forms_template`     | Forms Engine v2.1 §6    |
| `forms_deployment.created`         | `forms_deployment`   | Forms Engine v2.1 §3    |
| `forms_deployment.retired`         | `forms_deployment`   | Forms Engine v2.1 §3    |
| `forms_variant.created`            | `forms_variant`      | Forms Engine v2.1 §14.5 |
| `forms_variant.winner_promoted`    | `forms_variant`      | Forms Engine v2.1 §14.5 |
| `forms_variant.retired`            | `forms_variant`      | Forms Engine v2.1 §14.5 |
| `forms_resume_state.saved`         | `forms_resume_state` | Forms Engine v2.1 §8.2  |
| `forms_resume_state.restored`      | `forms_resume_state` | Forms Engine v2.1 §8.2  |
| `intake_response.submitted` (✅)   | `intake_response`    | (canonical in v5.2)     |
| `intake_response.completed`        | `intake_response`    | Forms Engine v2.1 §13   |
| `intake_subscription_intent`       | `intake_response`    | Forms Engine v2.1 §17.1 |

Note: `intake_subscription_intent` does NOT follow the dot-namespaced rule because it pre-dates the rule and is already ratified at v5.2. **Preserved as-is.** Future intake-subscription events SHOULD use `intake_subscription.*` shape.

#### Identity + JWT (9 strings; all v0.2 RENAMED)

| Canonical string (v0.2 rename) | Aggregate-type | Slice section      |
| ------------------------------ | -------------- | ------------------ |
| `account.created`              | `account`      | Identity Spec §3.1 |
| `account.activated`            | `account`      | Identity Spec §3.1 |
| `session.issued`               | `session`      | Identity Spec §3.2 |
| `session.revoked`              | `session`      | Identity Spec §3.2 |
| `otp.issued`                   | `otp`          | Identity Spec §3.4 |
| `otp.consumed`                 | `otp`          | Identity Spec §3.4 |
| `otp.lockout_triggered`        | `otp`          | Identity Spec §3.4 |
| `device.registered`            | `device`       | Identity Spec §3.3 |
| `device.revoked`               | `device`       | Identity Spec §3.3 |

#### Consent + Delegated Access (8 strings; 2 of which are v0.2 RENAMED)

| Canonical string (v0.2 rename if applicable) | Aggregate-type | Slice section      |
| -------------------------------------------- | -------------- | ------------------ |
| `consent.granted`                            | `consent`           | Consent Slice §7.1 |
| `consent.revoked`                            | `consent`           | Consent Slice §7.1 |
| `delegation.invited`                         | `delegation`        | Consent Slice §6.1 |
| `delegation.accepted`                        | `delegation`        | Consent Slice §6.1 |
| `delegation.declined`                        | `delegation`        | Consent Slice §6.1 |
| `delegation.revoked`                         | `delegation`        | Consent Slice §6.1 |
| `delegation_scope.granted` (was `delegation.scope_granted`) | `delegation_scope` | Consent Slice §6.2 |
| `delegation_scope.revoked` (was `delegation.scope_revoked`) | `delegation_scope` | Consent Slice §6.2 |

**Net rename count at ratification:** 11 placeholder strings change body (9 identity drops `identity.` prefix + 2 delegation_scope flatten). 17 strings already match the canonical convention.

### Decision 5 — Mandatory `payload` shape (top-level required fields)

Per DOMAIN_EVENTS v5.2 §envelope, the outer envelope already carries `event_id`, `event_type`, `aggregate_type`, `aggregate_id`, `tenant_id`, `partition_key`, `occurred_at`, `schema_version`. The **`payload`** is the inner free-form JSON. v0.2 proposal: every `payload` MUST minimally carry:

- `correlation_id` — string, ULID; pairs domain events to audit events emitted in the same transaction (per I-016 same-tx outbox discipline). Sourced from the request's correlation ID (set by `correlationIdPlugin`).
- `causation_id` — string, ULID, nullable; the upstream event_id that caused this event (for event-chain reconstruction). Null on root-of-causation events.
- `audit_id` — string, ULID, nullable; the audit_records.audit_id emitted in the same tx (for paired audit↔domain-event reconciliation). MAY be null if no audit was emitted (forms-intake template creation is operational-only, no Category A/B/C audit).
- `actor_id` — string; the principal that triggered the state transition (account_id for patient-initiated; system actor for AI-initiated).

Per-event-type detail shapes follow Decision 6.

### Decision 6 — Per-event-type payload detail-shape proposals

Twelve detail-shape archetypes, one per aggregate-prefix. Listed here for ratification.

#### `forms_template.*` (template lifecycle)
- `created`: `{ ...minimum, template_id: ULID, program_id: ULID, country_of_care: 'US'|'GH', template_version: integer }`
- `version_published`: `{ ...minimum, template_id: ULID, template_version: integer, prior_version: integer | null }`

#### `forms_deployment.*` (deployment lifecycle)
- `created`: `{ ...minimum, deployment_id: ULID, template_id: ULID, program_id: ULID }`
- `retired`: `{ ...minimum, deployment_id: ULID, retired_reason: string }`

#### `forms_variant.*` (A/B testing)
- `created`: `{ ...minimum, variant_id: ULID, template_id: ULID, traffic_split_pct: integer }`
- `winner_promoted`: `{ ...minimum, variant_id: ULID, template_id: ULID, conversion_lift_pct: number }`
- `retired`: `{ ...minimum, variant_id: ULID, template_id: ULID }`

#### `forms_resume_state.*` (save-and-resume)
- `saved`: `{ ...minimum, resume_state_id: ULID, submission_id: ULID, patient_id: ULID | null, device_anonymous_token_hash: string | null, expires_at: ISO8601 }` — never the raw resume token
- `restored`: `{ ...minimum, resume_state_id: ULID, submission_id: ULID }`

#### `intake_response.*` (submission lifecycle; ratified shapes preserved)
- `completed`: `{ ...minimum, submission_id: ULID, deployment_id: ULID, patient_id: ULID, completed_at: ISO8601 }`
- `submitted` (ratified): per v5.2

#### `intake_subscription_intent` (ratified; no rename)
- per v5.2 §17.1

#### `account.*` (account lifecycle)
- `created`: `{ ...minimum, account_id: ULID, role: 'patient'|'clinician', country_of_care: 'US'|'GH' }`
- `activated`: `{ ...minimum, account_id: ULID, activation_method: 'magic_link'|'otp' }`

#### `session.*` (session lifecycle)
- `issued`: `{ ...minimum, session_id: ULID, account_id: ULID, expires_at: ISO8601 }`
- `revoked`: `{ ...minimum, session_id: ULID, account_id: ULID, revoked_reason: 'logout'|'expiry'|'forced' }`

#### `otp.*` (OTP lifecycle)
- `issued`: `{ ...minimum, otp_id: ULID, account_id: ULID, channel: 'sms'|'email', expires_at: ISO8601 }` — never the raw code
- `consumed`: `{ ...minimum, otp_id: ULID, account_id: ULID }`
- `lockout_triggered`: `{ ...minimum, account_id: ULID, channel: 'sms'|'email', attempts_count: integer }`

#### `device.*` (device lifecycle)
- `registered`: `{ ...minimum, device_id: ULID, account_id: ULID, platform: 'ios'|'android'|'web' }`
- `revoked`: `{ ...minimum, device_id: ULID, account_id: ULID, revoked_reason: 'user_action'|'forced'|'expired' }`

#### `consent.*` (consent lifecycle)
- `granted`: `{ ...minimum, consent_id: ULID, account_id: ULID, scope: string, valid_until: ISO8601 | null, country_of_care: 'US'|'GH' }`
- `revoked`: `{ ...minimum, consent_id: ULID, account_id: ULID, revoked_reason: string }`

#### `delegation.*` (delegate lifecycle)
- `invited`: `{ ...minimum, delegation_id: ULID, inviter_account_id: ULID, invitee_email_hash: string }` — never raw email
- `accepted`: `{ ...minimum, delegation_id: ULID, accepting_account_id: ULID }`
- `declined`: `{ ...minimum, delegation_id: ULID, declining_account_id: ULID }`
- `revoked`: `{ ...minimum, delegation_id: ULID, revoked_by_account_id: ULID, revoked_reason: string }`

#### `delegation_scope.*` (scope lifecycle)
- `granted`: `{ ...minimum, delegation_scope_id: ULID, delegation_id: ULID, scope: string }`
- `revoked`: `{ ...minimum, delegation_scope_id: ULID, delegation_id: ULID }`

### Decision 7 — Transition contract (atomic per-slice cutover; mirror SI-002 Decision)

**No dual-write window.** Each affected slice's events.ts file (`consent`, `identity`, `forms-intake`) cuts over from placeholder strings to canonical strings in a single atomic commit per slice. The cutover commit:

1. Updates the placeholder string literal in the `emitDomainEvent` call site
2. Updates the corresponding test-assertion literal in the slice's outbox-landing test file
3. Lands in a dedicated PR (one per slice; 3 PRs total: `consent`, `identity`, `forms-intake`)

**Rationale:** the outbox table's `event_type` column is free-form TEXT — there is no schema migration. The cost of a brief dual-state (placeholder in events.ts, canonical in tests OR vice versa) is a test failure on the cutover PR's branch, which is acceptable. Avoiding dual-write keeps subscribers' match logic linear.

**Cross-slice migration matrix:** an additional artifact `docs/DOMAIN_EVENT_TYPE_CANONICALIZATION_MAP_P_015.md` SHALL be authored at ratification time, listing every (placeholder → canonical) pair so consumers can be migrated mechanically.

### Decision 8 — Cross-SI alignment with SI-002 (NEW; per Codex pre-ratification expectation)

SI-002 (PR #136) ratifies AUDIT_EVENTS placeholder strings with dot-namespaced naming. SI-003 (this doc) ratifies DOMAIN_EVENTS placeholder strings with the SAME naming convention. **A subset of (audit, domain) event pairs are emitted in the same transaction** (e.g., `account.created` audit + `account.created` domain event). At ratification:

- The same action-id prefix SHALL be used for both audit and domain events when emitted in pair (`account.created` audit row + `account.created` domain row).
- Consumers subscribing to "account lifecycle" can use a single match selector to query both tables.
- This is enforced at the developer-discipline level (no schema constraint) — the convention is documented in DOMAIN_EVENTS v5.3 §X-bridge and AUDIT_EVENTS v5.5 §X-bridge cross-pointers.

### Decision 9 — Schema version bump

`schema_version` per DOMAIN_EVENTS envelope SHALL go from `1` (current) to `2` at v5.3 ratification, signaling that:

- The naming convention has been ratified (consumers should expect canonical dot-namespaced strings).
- The minimum `payload` shape (Decision 5) is now enforced.

Existing rows at `schema_version=1` are NOT migrated (per I-016 immutability). Consumers MUST handle `schema_version=1` rows tolerantly during the transition window.

## Resolution path (v0.2 updated)

### Step 1 (spec corpus, owned by Engineering Lead + Privacy/Compliance + Codex pre-ratification reviewer)

1. **Codex pre-ratification gate** — multi-round adversarial review against v0.2+ proposals. Mirror SI-007 cadence (target: convergence in 6-12 rounds; ~95 findings closed in SI-007's case). Document closures inline in this file as `### v0.X — close Codex R{N} HIGH ...`.
2. Engineering Lead + Privacy/Compliance ratify after Codex convergence.
3. Author the DOMAIN_EVENTS v5.3 enumeration block adding all 28 ratified event-type strings + the `payload` shape definitions per Decision 5/6.
4. Author the canonicalization map artifact (`docs/DOMAIN_EVENT_TYPE_CANONICALIZATION_MAP_P_015.md`).
5. Promotion Ledger entry **P-015** closes this SI.

### Step 2 (this code repo, owned by Engineering)

Once Step 1 lands, **three atomic cutover PRs** (one per slice):

1. `consent` cutover: rename 2 placeholder strings (`delegation.scope_*` → `delegation_scope.*`). Update `src/modules/consent/events.ts` + `tests/integration/consent-domain-events.test.ts` + the canonical 4-case outbox-landing assertions.
2. `identity` cutover: rename 9 placeholder strings (drop `identity.` prefix). Update `src/modules/identity/events.ts` + `tests/integration/identity-domain-events.test.ts` + the canonical 5-case outbox-landing assertions.
3. `forms-intake` cutover: zero string renames (all already canonical). Add the 9 missing variant + resume_state outbox-landing test cases (deferred at v0.1 per §136). Update `src/modules/forms-intake/events.ts` JSDoc to add the ratification pointer.

Each PR runs the Codex per-PR pre-ratification gate before squash-merge (existing autoinvocation directive per Evans 2026-04-28).

## What I'm doing in the meantime (v0.1 unchanged)

**Continuing to ship slice work using the inline-string pattern.** Every new domain event from a future slice (Pharmacy, Med Interaction, Subscription, etc.) follows the same inline approach. The pattern is well-established (3 slices × ~10 events each, 28 total) and the cost of mass-renaming when SI-003 closes is bounded.

Same autonomous-turn discipline as SI-002: **never invent new canonical contract artifacts in the code repo.** Spec gaps surface as SIs.

## Required from product (v0.2 updated)

| Item                                                                                 | Owner                                 | Severity |
| ------------------------------------------------------------------------------------ | ------------------------------------- | -------- |
| DOMAIN_EVENTS v5.3 — ratify 28 placeholder event-type strings per Decision 4         | Engineering Lead + Privacy/Compliance | medium   |
| Confirm dot-namespaced naming convention (Decision 1)                                | Engineering Lead                      | low      |
| Confirm aggregate-type one-to-one with leading event-type segment (Decision 2)       | Engineering Lead                      | low      |
| Confirm `identity.` prefix drop (Decision 3)                                         | Engineering Lead                      | low      |
| Confirm mandatory `payload` minimum shape (Decision 5)                               | Engineering Lead + Slice owners       | medium   |
| Confirm per-event detail shapes (Decision 6)                                         | Engineering Lead + Slice owners       | medium   |
| Confirm atomic per-slice cutover discipline (Decision 7)                             | Engineering Lead                      | medium   |
| Confirm SI-002 cross-alignment (Decision 8)                                          | Engineering Lead                      | medium   |
| Confirm `schema_version` bump 1 → 2 at v5.3 (Decision 9)                             | Engineering Lead                      | low      |

---

## Cross-references

- EHBG v1.3 §12 — SI escalation template
- DOMAIN_EVENTS v5.2 §envelope — current shape (no enumerated event-type list beyond `intake_response.*`)
- I-016 — domain events immutable (preserved regardless of event-type names)
- I-023 — every event carries tenant_id (preserved regardless of names)
- `src/modules/consent/events.ts` — 8 emitters
- `src/modules/identity/events.ts` — 9 emitters
- `src/modules/forms-intake/events.ts` — 13 emitters (12 placeholder + 1 ratified)
- SI-002 — parallel audit-side placeholder gap (Decision 8 cross-alignment)
- SI-007 — Refill/Dispensing/Shipment schema gap (precedent for Codex pre-ratification cadence; 18 rounds, 21 closures)

## Companion code-repo state at SI-003 v0.2 (unchanged from v0.1)

- **Slices emitting domain events via placeholder strings:** Forms/Intake, Identity + JWT, Consent + Delegated Access (28 placeholder event-type strings; 1 ratified).
- **Outbox-landing test coverage:** consent (4 cases at `f3c759f`), identity (5 cases at `4fa12b3`), forms-intake variant + resume_restored (deferred — happy-path emission verified by code paths but not yet asserted explicitly).
- **Slices that will inherit the pattern:** every future slice (Pharmacy, Med Interaction, Subscription, Sync Video, Async Consult, Labs, Adverse Event, RPM/CCM, etc.) until SI-003 closes.

## Resolution expectations (v0.2 updated)

- **Target close-out:** Promotion Ledger entry **P-015** (P-013 consumed by SI-007 merged 2026-05-14; P-014 reserved by SI-002 in flight at PR #136). DOMAIN_EVENTS bumps **v5.2 → v5.3** at promotion.
- **Codex pre-ratification gate:** multi-round adversarial review begins on PR opening (mirror SI-007 / SI-002 cadence). Target convergence: 6-12 rounds.
- **Until then:** SI-003 stays open in this file; all slices use inline event-type strings; tests pin the strings as assertion predicates so out-of-band rename surfaces as test failure.
