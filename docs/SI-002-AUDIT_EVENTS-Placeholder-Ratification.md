# SI-002 — AUDIT_EVENTS v5.2 placeholder action IDs awaiting ratification

**Raised by:** Engineering (autonomous turn 2026-05-05)
**Date raised:** 2026-05-05
**Severity:** medium
**Status:** **OPEN — v0.4 DRAFT** (Codex R2 HIGH closed 2026-05-14: explicit transition contract added — atomic cutover, no dual-write window, test-update sequence ratified)
**Target spec doc:** `Telecheck_Contracts_Pack_v5_00_AUDIT_EVENTS.md` (v5.2 → v5.5 proposed; v5.3 was bumped at P-011 for crisis-detection MedicationRequest closure, v5.4 by SI-007 P-013 for refill/dispensing/shipment, so SI-002 closure targets v5.5)
**Promotion Ledger:** **P-014** (updated from v0.1's P-012 — P-012 slot was deferred to a future implementation-milestone-class entry per Addendum 4 status doc; P-013 is now claimed by SI-007 v0.19 merged 2026-05-14)
**Related slice PRDs:** Forms/Intake v2.1 §13, Identity Spec §3, Consent Slice PRD v1.0 §10
**Companion SIs:** SI-001 (CLOSED P-011), SI-003 (DOMAIN_EVENTS — same pattern, sibling doc), SI-004 (Async-Consult — same pattern, downstream consumer of SI-002 v5.5 amendment), SI-007 (v0.19 merged 2026-05-14; closes at P-013)
**Pre-ratification gate:** mandatory per SI-001 + SI-007 retrospective lessons — multi-round Codex convergence before ratification attempt

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

## Concrete proposals (v0.2 — 2026-05-14)

### Naming convention: dot-namespaced

The corpus mixes both `snake_case` (placeholder shape) and `dot.namespaced` (Category A canonical IDs like `crisis_detection_trigger`, `prescribing.protocol_authorization_granted`). v0.2 proposes **dot-namespaced** as canonical for SI-002's 31 actions because:

1. **Consistency with Category A precedent.** The P-011 + SI-007 Category A additions (`crisis_detection_trigger`, `prescribing.protocol_authorization_granted`, `refill.expired`, `shipment.cancelled_before_dispatch`, etc.) use dot-namespaced. The v0.2 31-action proposal extends the established pattern; v0.1's snake_case would create an inconsistent two-style corpus.
2. **Hierarchical filtering.** Audit-query tooling (compliance dashboards, ops triage, denylist filters) needs to group events by domain (`forms.*`, `identity.*`, `consent.*`). Dot-namespacing makes this a prefix match; snake_case requires per-event registration.
3. **Forward-compat with reserved namespaces.** ADR-029 reserved workload types (`autonomous_agent`, `multi_agent_supervisor`, `tool_using_agent`) will emit audits under their own namespace when activated (e.g., `autonomous_agent.action_executed`). Dot-namespacing scales cleanly.

The "Proposed canonical (illustrative)" column in the v0.1 tables below is now the **proposed CANONICAL** column (not illustrative). Implementation closure replaces `{slice}AuditPlaceholder('forms_template_created')` with the direct typed reference to `'forms.template.created'`.

### Category assignment (A / B / C per AUDIT_EVENTS v5.2 §classification)

Three categories per AUDIT_EVENTS v5.2:

- **Category A:** safety-critical (crisis detection, prescribing execution, etc.) — strict immutability + escalation-on-emission semantics.
- **Category B:** governance (template publishing, governance edits, deployment lifecycle) — visible to compliance review + audit chain integrity, but no escalation.
- **Category C:** operational (account activity, session lifecycle, submission lifecycle) — chain-integrity-preserved but treated as observability.

Per-event categorization for the 31 IDs (v0.2 proposal):

#### Forms/Intake (14 events)

| Canonical ID                       | Category | Rationale                                                                                                                                                                                   |
| ---------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `forms.template.created`           | B        | Template authorship is governance-class; alters what patients can see                                                                                                                       |
| `forms.template.version_published` | B        | Publishing is a governance event (Slice PRD v2.1 §3.5 approval rule)                                                                                                                        |
| `forms.eligibility_logic.edited`   | B        | Eligibility logic is governance-class per Slice PRD §13 explicit assignment                                                                                                                 |
| `forms.approval_governance.edited` | B        | Approval-governance edits are explicitly Category B per Slice PRD §13                                                                                                                       |
| `forms.deployment.created`         | B        | Deployment is a governance event (binds template version to a market)                                                                                                                       |
| `forms.deployment.retired`         | B        | Retirement is governance — patient surface changes                                                                                                                                          |
| `forms.submission.started`         | C        | Patient activity; operational                                                                                                                                                               |
| `forms.submission.paused`          | C        | Patient activity; operational                                                                                                                                                               |
| `forms.submission.resumed`         | C        | Patient activity; operational                                                                                                                                                               |
| `forms.submission.completed`       | C        | Patient activity; operational. (Note: distinct from `crisis_detection_trigger` Category A which fires inside `submission.responses.patched` via I-019 — separate event, separate category.) |
| `forms.submission.abandoned`       | C        | Patient activity; operational                                                                                                                                                               |
| `forms.variant.created`            | B        | A/B variant authorship is governance                                                                                                                                                        |
| `forms.variant.winner_promoted`    | B        | Promotion changes patient surface; governance                                                                                                                                               |
| `forms.variant.retired`            | B        | Retirement changes patient surface; governance                                                                                                                                              |

#### Identity & Auth (9 events)

| Canonical ID                     | Category | Rationale                                                                                                                                                  |
| -------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `identity.account.created`       | C        | Account lifecycle; operational                                                                                                                             |
| `identity.account.activated`     | C        | Account lifecycle; operational                                                                                                                             |
| `identity.session.issued`        | **B**    | Authentication proof: security/compliance review must reconstruct who got authenticated when. Promoted from C → B per Codex R1 HIGH closure 2026-05-14.    |
| `identity.session.revoked`       | B        | Revocation has security-policy significance; governance                                                                                                    |
| `identity.otp.issued`            | **B**    | Authentication-proof issuance: compliance must see issuance regardless of whether lockout fires. Promoted from C → B per Codex R1 HIGH closure 2026-05-14. |
| `identity.otp.consumed`          | **B**    | Authentication-proof consumption: compliance must see successful proof independently of lockout. Promoted from C → B per Codex R1 HIGH closure 2026-05-14. |
| `identity.otp.lockout_triggered` | B        | Lockout is a security event; governance for ops review                                                                                                     |
| `identity.device.registered`     | C        | Device lifecycle; operational                                                                                                                              |
| `identity.device.revoked`        | B        | Device revocation has security significance; governance                                                                                                    |

#### Consent + Delegated Access (8 events)

| Canonical ID               | Category | Rationale                                                           |
| -------------------------- | -------- | ------------------------------------------------------------------- |
| `consent.granted`          | B        | Consent is a regulatory artifact (HIPAA, GDPR); governance category |
| `consent.revoked`          | B        | Revocation has compliance significance; governance                  |
| `delegation.invited`       | B        | Delegated-access creation is governance                             |
| `delegation.accepted`      | B        | Delegated-access activation is governance                           |
| `delegation.declined`      | B        | Outcome of delegated-access flow; governance                        |
| `delegation.revoked`       | B        | Revocation has compliance significance; governance                  |
| `delegation.scope.granted` | B        | Scope changes affect what the delegate can do; governance           |
| `delegation.scope.revoked` | B        | Scope changes; governance                                           |

**Summary:** **17 Category B (governance) + 14 Category C (operational)** post-Codex-R1 closure. Zero Category A in SI-002 — Category A is reserved for safety-critical events (crisis, prescribing); the SI-002 set is operational + governance lifecycle. (Counts updated v0.2 → v0.3 per Codex R1 HIGH closure: 3 identity authentication-proof events `session.issued`, `otp.issued`, `otp.consumed` promoted C → B; was 14 B + 17 C in v0.2.)

### Detail-shape ratification per action

The AUDIT_EVENTS v5.2 envelope's `detail` JSONB column is currently free-shape. v0.2 proposes the following **mandatory minimum field set** per action (additional fields are optional and slice-specific):

| Action prefix                                               | Required `detail` fields                                                                                                                                                                                      |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `forms.template.*`                                          | `template_id`, `template_version`, `program_id`                                                                                                                                                               |
| `forms.eligibility_logic.*` / `forms.approval_governance.*` | `template_id`, `template_version`, `changed_by_actor_id`, `change_summary`                                                                                                                                    |
| `forms.deployment.*`                                        | `deployment_id`, `template_id`, `template_version`, `program_id`, `country_of_care`                                                                                                                           |
| `forms.submission.started`                                  | `submission_id`, `deployment_id`, `patient_id`, `event_attempt_id` (correlation ID for retry-safe reconstruction). NO `status_before` (no prior state) per Codex R1 MEDIUM closure 2026-05-14.                |
| `forms.submission.paused` / `.resumed` / `.abandoned`       | `submission_id`, `deployment_id`, `patient_id`, `status_before`, `status_after`, `transition_id` (correlation ID for idempotency-safe reconstruction across retries)                                          |
| `forms.submission.completed`                                | `submission_id`, `deployment_id`, `patient_id`, `status_before` (typically `in_progress`), `status_after` (`completed`), `snapshot_id` (FK to forms_submission_snapshot row written same-tx), `transition_id` |
| `forms.variant.*`                                           | `variant_id`, `template_id`, `assignment_rule_summary`                                                                                                                                                        |
| `identity.account.*`                                        | `account_id`, `phone_e164_hash` (NEVER plaintext phone), `account_type`                                                                                                                                       |
| `identity.session.*`                                        | `session_id`, `account_id`, `device_id` (nullable; null for password-flow sessions), `revocation_reason` (for `.revoked` only)                                                                                |
| `identity.otp.*`                                            | `otp_id`, `account_id`, `purpose` (`login` / `mfa` / etc.), `attempt_count` (for `.lockout_triggered` only)                                                                                                   |
| `identity.device.*`                                         | `device_id`, `account_id`, `device_fingerprint_hash` (NEVER plaintext fingerprint), `revocation_reason` (for `.revoked` only)                                                                                 |
| `consent.*`                                                 | `consent_id`, `account_id`, `consent_type`, `granted_at` (for `.granted` only), `revoked_at` + `revocation_reason` (for `.revoked` only)                                                                      |
| `delegation.*`                                              | `delegation_id`, `patient_account_id`, `delegate_account_id`, `scope_codes[]`, `status_before`, `status_after`                                                                                                |
| `delegation.scope.*`                                        | `delegation_id`, `scope_code`, `granted_at` (for `.granted`) / `revoked_at` + `revocation_reason` (for `.revoked`)                                                                                            |

**PHI guarantee:** every `detail` shape above either (a) references PHI by ID rather than value, OR (b) uses a hash (`phone_e164_hash`, `device_fingerprint_hash`) so the audit chain never carries plaintext PHI. This mirrors the SI-007 + crisis-detection-trigger discipline.

### Transition contract: placeholder → canonical cutover (v0.4 per Codex R2 HIGH closure)

The transition from placeholder action IDs (`forms_template_created`, etc.) to canonical IDs (`forms.template.created`, etc.) MUST be **atomic per slice**, not dual-write. Rationale:

1. **No dual-write window.** Dual-write (emitter emits BOTH `forms_template_created` AND `forms.template.created` for the same event during a transition window) would double the audit chain entries for every emission, double-count compliance dashboards, and require downstream consumers to dedupe — fragile and audit-chain-non-additive (I-003 append-only contract makes "the chain has BOTH placeholder and canonical for the same business event" hard to interpret post-cutover).
2. **No `LIKE` matching across both naming styles.** Audit-query tooling MUST NOT carry a `WHERE action LIKE 'forms_%' OR action LIKE 'forms.%'` compatibility predicate — that masks the migration permanently and obscures whether the cutover completed.
3. **Per-slice atomic cutover.** Each slice (forms-intake, identity, consent) gets its own cutover PR; within that PR the slice's audit emitter, placeholder type definition, and slice-side tests all change to canonical IDs in a single commit. CI gate ensures no row of the slice emits the old ID after the PR merges.

**Concrete cutover sequence per slice:**

| Step | Action                                                                                                                                                                                                                                                                                                               | Atomicity                                       |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| 1    | Spec corpus: AUDIT_EVENTS v5.4 → v5.5 promotion bumps adds the 31 canonical IDs (P-014).                                                                                                                                                                                                                             | Spec-corpus side, single Promotion Ledger entry |
| 2    | Implementation: per-slice cutover PR — `src/modules/{slice}/audit.ts` changes placeholder type definition + cast helper to use canonical IDs; all test predicate matchers in `tests/integration/{slice}-*.test.ts` updated in lockstep.                                                                              | Single PR per slice; CI rejects mixed-state     |
| 3    | Historical audit rows: NOT migrated. Pre-P-014 rows retain placeholder strings (audit chain is append-only per I-003; rewriting prior rows would break the chain hash).                                                                                                                                              | Permanent split at the P-014 timestamp boundary |
| 4    | Compliance tooling: a one-time `audit_action_id_canonicalization` mapping table documents the 31 placeholder→canonical pairs for queries that need to span the P-014 boundary. NOT a runtime DB table — a static doc artifact (e.g., `docs/AUDIT_ACTION_ID_CANONICALIZATION_MAP_P_014.md` authored alongside P-014). | One-time spec-corpus artifact                   |

**Compatibility window: zero.** The cutover PR is the cutover; there is no overlap period. Code reviewers verify the per-slice PR's diff replaces 100% of references atomically before merge.

**Compliance-query bridge:** the mapping artifact (Step 4) is the canonical compatibility layer. A compliance review needing all `forms.template.created` events for a quarter that spans the P-014 boundary queries:

```sql
SELECT * FROM audit_records
WHERE action IN ('forms.template.created', 'forms_template_created')
```

The two-element `IN` list is the bridge; once historical-row retention timelines pass the P-014 timestamp + audit retention period, the bridge can be dropped.

### v5.2 → v5.5 promotion semantics

- AUDIT_EVENTS v5.2 → v5.3 was bumped at P-011 (MedicationRequest § amendment).
- AUDIT_EVENTS v5.3 → v5.4 was bumped at SI-007 P-013 (Refill + Dispensing + Shipment additions; 38 net-new IDs).
- AUDIT_EVENTS v5.4 → v5.5 is proposed for SI-002 closure (31 net-new IDs across forms-intake, identity, consent; ratification of placeholder pattern).
- Total net-new at v5.5: 31 IDs + canonical-name ratification of the placeholder pattern.

The version bump is the smallest semver step appropriate to additive-only Category-B + Category-C enumeration (no normative-rule change to envelope; just enumeration). Precedent: P-011 (v5.2 → v5.3) and P-013 (v5.3 → v5.4) used the same semver-minimal step for additive Category-A enumeration.

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

- **Target close-out:** Spec Issue resolution lands as Promotion Ledger entry **P-014** (P-012 was deferred to a future implementation-milestone-class entry per the Addendum 4 status doc; P-013 is now claimed by SI-007 v0.19 merged 2026-05-14).
- **Until then:** SI-002 stays open in this file; all slices use placeholder cast helpers; tests pin the 31 strings as assertion predicates so an out-of-band rename surfaces as test failure.

---

## Document control

- **v0.1 — 2026-05-05** — Initial DRAFT raised during the Sprint 33-34 cycle. Identified 31 placeholder action IDs across 3 slices (Forms/Intake + Identity + Consent). Left naming convention, category assignment, and detail-shape questions open.
- **v0.2 — 2026-05-14** — Concrete proposals added:
  - **Naming convention picked:** dot-namespaced (consistency with Category A precedent from P-011 + SI-007; hierarchical filtering for compliance tooling; forward-compat with ADR-029 reserved workload namespaces).
  - **Per-event category assignment:** 14 Category B (governance) + 17 Category C (operational). Zero Category A in SI-002 set.
  - **Detail-shape proposals:** mandatory minimum field set per action prefix; PHI-by-ID + hashed-when-necessary discipline mirroring SI-007 + crisis-detection-trigger pattern.
  - **Promotion Ledger target updated:** P-012 → P-014 (P-013 claimed by SI-007 v0.19 merged 2026-05-14).
  - **AUDIT_EVENTS version target updated:** v5.2 → v5.5 (was v5.2 → v5.3 in v0.1; v5.3 + v5.4 bumps consumed at P-011 + P-013).
  - **Pre-ratification gate added** per SI-001 + SI-007 retrospective lessons.
- **v0.3 — 2026-05-14** — Codex R1 HIGH + MEDIUM closed:
  - **HIGH — Authentication-proof events were misclassified as operational.** v0.2 had `identity.session.issued`, `identity.otp.issued`, `identity.otp.consumed` as Category C. Codex R1: these are the audit trail for authentication proof + account-takeover investigation; under brute-force / replay / SIM-swap / compromised-account scenarios, compliance review needs visibility BEFORE `lockout_triggered` fires (which is a happy-path assumption that attacks cross the lockout threshold). Fix: promoted all 3 events to Category B. Recomputed counts: 17 B + 14 C (was 14 B + 17 C in v0.2).
  - **MEDIUM — `forms.submission.*` prefix detail shape conflated state-transition events with non-transition events.** v0.2 mandated `status_before` + `status_after` for the whole `forms.submission.*` prefix, but `forms.submission.started` has no meaningful prior state. Fix: split the row per-event:
    - `started`: `event_attempt_id` (no `status_before`).
    - `paused` / `resumed` / `abandoned`: `status_before` + `status_after` + `transition_id`.
    - `completed`: `status_before` + `status_after` + `transition_id` + `snapshot_id` (FK to same-tx snapshot row).
- **v0.4 — 2026-05-14** — Codex R2 HIGH closed:
  - **HIGH — Placeholder-to-canonical rename had no transition contract.** v0.3 proposed the rename (snake_case → dot-namespaced) but the "What I'm doing in the meantime" section still said "all slices use placeholder cast helpers and tests pin the 31 strings until close-out" — ambiguous on whether the cutover is dual-write, atomic, or a permanent compatibility window. Audit-corpus split across two naming styles would be a real risk.
  - Fix: added an explicit **Transition contract: placeholder → canonical cutover** section specifying:
    - **Atomic per-slice cutover** (no dual-write window).
    - **No `LIKE` matching** across both naming styles (would mask migration completion permanently).
    - **Per-slice cutover PR** changes audit.ts emitter + tests in one commit; CI rejects mixed-state.
    - **Historical audit rows NOT migrated** (audit chain append-only per I-003; rewriting prior rows would break chain-hash).
    - **One-time mapping artifact** at `docs/AUDIT_ACTION_ID_CANONICALIZATION_MAP_P_014.md` documents the 31 pairs for queries that span the P-014 boundary.
    - **Compliance-query bridge** via two-element `IN` list (`WHERE action IN ('forms.template.created', 'forms_template_created')`) for the audit-retention overlap period; dropped after retention window passes.
- **Next:** v0.5 after Codex R3 review. Iterate to convergence per the SI-007 trajectory pattern (R1 → R18 was SI-007's path; SI-002's scope is broader and may extend longer).
