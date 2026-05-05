# SI-002 — AUDIT_EVENTS v5.2 placeholder action IDs awaiting ratification

**Raised by:** Engineering (autonomous turn 2026-05-05)
**Date:** 2026-05-05
**Severity:** medium
**Status:** Open — awaiting Privacy/Compliance + Engineering Lead ratification
**Target spec doc:** `Telecheck_Contracts_Pack_v5_00_AUDIT_EVENTS.md` (v5.2 in headers)
**Related slice PRDs:** Forms/Intake v2.1 §13, Identity Spec §3, Consent Slice PRD v1.0 §10

---

## What I'm trying to implement

Three slices (Forms/Intake, Identity & Auth, Consent + Delegated Access) emit lifecycle audit events end-to-end via the established `txCallback` same-transaction emission pattern. Every emission carries the canonical AUDIT_EVENTS v5.2 envelope per I-027 (`tenant_id` mandatory) + I-003 (chain-integrity preserved). The hash chain is intact, the trigger validates inputs, and the chain walker (`assertAuditChainIntact`) confirms all 8 Consent slice events + 9 Identity slice events + 14 Forms/Intake slice events round-trip correctly.

What's missing: **canonical action ID strings ratified in AUDIT_EVENTS v5.2**.

## What the spec says

`Telecheck_Contracts_Pack_v5_00_AUDIT_EVENTS.md` (v5.2) enumerates Category-A safety-critical action IDs (e.g., `crisis_detection.trigger`, `prescription.execution_rejected`) but does not enumerate per-slice lifecycle Category-B / Category-C action IDs for the operational events emitted by:

- Forms/Intake: 14 events covering template + deployment + submission + variant + resume lifecycle
- Identity & Auth: 9 events covering account + session + OTP + device lifecycle
- Consent + Delegated Access: 8 events covering consent + delegation + scope lifecycle

EHBG §12 applies — engineering doesn't author canonical action IDs. The slices ship with a placeholder pattern (single `as AuditAction` cast site per slice) that compiles cleanly and emits well-formed audit rows, but the action strings themselves are NOT ratified.

## What's unclear

The 31 placeholder action ID strings are listed below. Each needs:

1. **Ratification** — does Privacy/Compliance accept this exact string? Or should the casing / dot-vs-underscore / namespacing change?
2. **Category assignment** — which AUDIT_EVENTS v5.2 safety classification (A / B / C) does each event belong to? The slices currently emit as Category C (operational); some may belong in Category B (governance) once ratified.
3. **Schema-shape ratification** — what fields are mandatory in `envelope.detail` for each action? The slices emit a slice-specific shape; the canonical AUDIT_EVENTS v5.2 schema likely expects a more constrained shape.

## What I'd propose

### Forms/Intake placeholder action IDs (14)

| Placeholder string                 | Slice section                                                                | Proposed canonical (illustrative)  |
| ---------------------------------- | ---------------------------------------------------------------------------- | ---------------------------------- |
| `forms_template_created`           | Forms Engine v2.1 §3, §13                                                    | `forms.template.created`           |
| `forms_template_version_published` | Forms Engine v2.1 §3, §13                                                    | `forms.template.version_published` |
| `forms_eligibility_logic_edited`   | Forms Engine v2.1 §13 (Cat B)                                                | `forms.eligibility_logic.edited`   |
| `forms_approval_governance_edited` | Forms Engine v2.1 §13 (Cat B)                                                | `forms.approval_governance.edited` |
| `forms_deployment_created`         | Forms Engine v2.1 §3, §13                                                    | `forms.deployment.created`         |
| `forms_deployment_retired`         | Forms Engine v2.1 §3, §13                                                    | `forms.deployment.retired`         |
| `forms_submission_started`         | Forms Engine v2.1 §13                                                        | `forms.submission.started`         |
| `forms_submission_paused`          | Forms Engine v2.1 §13                                                        | `forms.submission.paused`          |
| `forms_submission_resumed`         | Forms Engine v2.1 §13                                                        | `forms.submission.resumed`         |
| `forms_submission_completed`       | Forms Engine v2.1 §13                                                        | `forms.submission.completed`       |
| `forms_variant_created`            | Forms Engine v2.1 §6, §13                                                    | `forms.variant.created`            |
| `forms_variant_winner_promoted`    | Forms Engine v2.1 §6, §13                                                    | `forms.variant.winner_promoted`    |
| `forms_variant_retired`            | Forms Engine v2.1 §6, §13                                                    | `forms.variant.retired`            |
| (intake\_\*) crisis-related family | I-019 platform floor; emitted via different code path; unaffected by this SI |

### Identity & Auth placeholder action IDs (9)

| Placeholder string               | Slice section      | Proposed canonical (illustrative) |
| -------------------------------- | ------------------ | --------------------------------- |
| `identity_account_created`       | Identity Spec §3.1 | `identity.account.created`        |
| `identity_account_activated`     | Identity Spec §3.1 | `identity.account.activated`      |
| `identity_session_issued`        | Identity Spec §3.2 | `identity.session.issued`         |
| `identity_session_revoked`       | Identity Spec §3.2 | `identity.session.revoked`        |
| `identity_otp_issued`            | Identity Spec §3.4 | `identity.otp.issued`             |
| `identity_otp_consumed`          | Identity Spec §3.4 | `identity.otp.consumed`           |
| `identity_otp_lockout_triggered` | Identity Spec §3.4 | `identity.otp.lockout_triggered`  |
| `identity_device_registered`     | Identity Spec §3.3 | `identity.device.registered`      |
| `identity_device_revoked`        | Identity Spec §3.3 | `identity.device.revoked`         |

### Consent + Delegated Access placeholder action IDs (8)

| Placeholder string         | Slice section      | Proposed canonical (illustrative) |
| -------------------------- | ------------------ | --------------------------------- |
| `consent_granted`          | Consent Slice §7.1 | `consent.granted`                 |
| `consent_revoked`          | Consent Slice §7.1 | `consent.revoked`                 |
| `delegation_invited`       | Consent Slice §6.1 | `delegation.invited`              |
| `delegation_accepted`      | Consent Slice §6.1 | `delegation.accepted`             |
| `delegation_declined`      | Consent Slice §6.1 | `delegation.declined`             |
| `delegation_revoked`       | Consent Slice §6.1 | `delegation.revoked`              |
| `delegation_scope_granted` | Consent Slice §6.2 | `delegation.scope.granted`        |
| `delegation_scope_revoked` | Consent Slice §6.2 | `delegation.scope.revoked`        |

## Resolution path

### Step 1 (spec corpus, owned by Privacy/Compliance + Engineering Lead)

1. Review the 31 placeholder strings above
2. Decide canonical naming convention (snake-case-with-underscores vs dot-namespaced — this corpus mixes both; pick one)
3. Author the AUDIT_EVENTS v5.2 enumeration block adding all 31 ratified IDs
4. Assign each to safety classification A/B/C
5. Define the mandatory `envelope.detail` shape per ID (field names, types, nullability)
6. Promotion Ledger entry P-012 closes this SI

### Step 2 (this code repo, owned by Engineering)

Once Step 1 lands:

1. Replace `{slice}AuditPlaceholder()` cast helpers with direct typed action references (the central `lib/audit.ts AuditAction` type re-exports the canonical union)
2. Update the placeholder type definitions to match the ratified strings
3. Update tests that reference the strings (e.g., `assertAuditRecordExists` predicate matchers)
4. The audit chain is intact regardless of action-ID name changes — the trigger hashes the rendered string verbatim — but `tests/integration/consent-audit-chain.test.ts §1b` asserts on the 8 distinct strings; that assertion needs updating in lockstep

## What I'm doing in the meantime

**Continuing to ship slice work using the placeholder pattern.** Every new audit event from a future slice (Pharmacy, Med Interaction, Subscription, etc.) will follow the same `{slice}AuditPlaceholder()` convention. The pattern is well-established (3 slices × ~10 events average) and the cost of mass-renaming when SI-002 closes is bounded (one type definition + one cast site per slice, plus test-side predicate matchers).

The autonomous-turn discipline: **never invent new canonical contract artifacts in the code repo.** Spec gaps surface as SIs and route to the spec corpus.

## Required from product

| Item                                                                                                 | Owner                                 | Severity |
| ---------------------------------------------------------------------------------------------------- | ------------------------------------- | -------- |
| AUDIT_EVENTS v5.2 — ratify 31 placeholder action IDs (14 forms + 9 identity + 8 consent)             | Privacy/Compliance + Engineering Lead | medium   |
| Decide naming convention (snake_case vs dot.namespaced) and apply consistently                       | Engineering Lead                      | low      |
| Define `envelope.detail` mandatory-field shape per action                                            | Privacy/Compliance + Slice owners     | medium   |
| Decide A/B/C category for each (slices currently emit Cat C; some may genuinely be Cat B governance) | Privacy/Compliance                    | medium   |

---

## Cross-references

- EHBG v1.3 §12 — SI escalation template (this doc follows it)
- AUDIT_EVENTS v5.2 §Audit record schema — current envelope shape (no enumerated action-ID list)
- I-003 — audit append-only / chain integrity (preserved regardless of action-ID names)
- I-027 — every audit row carries tenant_id (preserved regardless of action-ID names)
- `src/modules/consent/audit.ts` — `consentAuditPlaceholder()` cast site
- `src/modules/identity/audit.ts` — `identityAuditPlaceholder()` cast site
- `src/modules/forms-intake/audit.ts` — `formsIntakeAuditPlaceholder()` cast site
- `tests/integration/consent-audit-chain.test.ts §1b` — asserts the 8 distinct consent action strings (test would need updating in lockstep with SI-002 closure)

## Companion code-repo state at SI-002 raise

- **Slices implementation-complete with placeholder pattern:** Forms-Intake (14 events), Identity + JWT (9 events), Consent + Delegated Access (8 events) = **31 placeholder action IDs across 3 slices**.
- **Slices that will inherit the pattern:** every future slice (Pharmacy, Med Interaction, Subscription, Sync Video, Async Consult, Labs, Adverse Event, RPM/CCM, etc.) until SI-002 closes.
- **Estimated total placeholder count at v1.0 launch:** ~80-100 action IDs across 17 slice PRDs. SI-002 close-out becomes a forcing function on the AUDIT_EVENTS v5.2 → v5.3 amendment cycle.

## Resolution expectations

- **Target close-out:** Spec Issue resolution lands as Promotion Ledger entry **P-012** (next available P-NUM after P-011 closes SI-001 MedicationRequest schema).
- **Until then:** SI-002 stays open in this file; all slices use placeholder cast helpers; tests pin the 31 strings as assertion predicates so an out-of-band rename surfaces as test failure.
