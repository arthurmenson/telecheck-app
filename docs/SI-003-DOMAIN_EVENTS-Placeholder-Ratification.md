# SI-003 — DOMAIN_EVENTS placeholder event-type strings

**Raised by:** Engineering (autonomous turn 2026-05-05)
**Date:** 2026-05-05
**v0.2 advanced:** 2026-05-14 (concrete proposals + pre-ratification gate alignment)
**v0.3 advanced:** 2026-05-14 (close Codex R1 HIGH — subscriber-compat protocol for cutover)
**v0.4 advanced:** 2026-05-14 (close Codex R2 HIGH — dispatcher-side observability + merge-time inventory re-run)
**v0.5 advanced:** 2026-05-14 (close Codex R3 HIGH — split protocol into v1.0 vs v1.X+; explicit prerequisite block)
**v0.6 advanced:** 2026-05-14 (close Codex R4 HIGH — v1.0 CI guardrail blocks unregistered consumers)
**v0.7 advanced:** 2026-05-14 (close Codex R5 HIGH — concrete enforceable v1.0 guardrail; valid CODEOWNERS syntax)
**v0.8 advanced:** 2026-05-14 (close Codex R6 HIGH — G-2 scans ALL changed files; manifest purpose field enforces emits-only)
**v0.9 advanced:** 2026-05-14 (close Codex R7 HIGH — G-5 single-API-surface fail-closed on outbox-reader imports + dynamic-selector tests)
**Severity:** medium
**Status:** OPEN — v0.9 DRAFT, ratification-ready (6 HIGH findings closed across pre-ratification rounds; remaining gaps tracked as implementation-PR deliverables not architecture-ratification blockers)
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

### Decision 7 — Transition contract (split protocol: v1.0 vs v1.X+; v0.5 revised)

**v0.5 revision (Codex R3 HIGH closure 2026-05-14):** the v0.4 5-step protocol depended on dispatcher infrastructure (outbox-relay, subscriber_registry table, `POST /v0/internal/outbox/subscribe` endpoint, merge-time CI check) that does NOT exist in the v1.0 codebase. Without splitting the protocol, the rename either blocks indefinitely (because the infrastructure is unowned and unimplemented) or gets manually waived (defeating the safety gate). v0.5 explicitly splits the protocol into two regimes:

#### Decision 7A — v1.0 cutover protocol (active until first external subscriber registers)

**Preconditions assumed in this regime:** no external subscriber service has been deployed against the outbox; the 3 emitting slices (consent, identity, forms-intake) are the ONLY code that touches the canonical event_type strings; the dispatcher / outbox-relay infrastructure (Decision 7B) does NOT exist.

**Producer-cutover protocol (3 steps):**

1. **Comprehensive grep audit** (mandatory in cutover PR description). The cutover author MUST run a project-wide grep across the entire telecheck-app monorepo for the placeholder string about to be renamed. The output MUST show only:
   - The emitting slice's `events.ts` call sites (will be edited by the cutover PR)
   - The slice's outbox-landing test file (will be edited by the cutover PR)
   - The SI-003 documentation itself (catalog references; preserved as-is)
   - The canonicalization map artifact `docs/DOMAIN_EVENT_TYPE_CANONICALIZATION_MAP_P_015.md` (cataloged references; preserved as-is)
   Any OTHER match is a blocking finding. The grep output is committed to the PR description verbatim.
2. **Forward-compat fixture committed in cutover PR.** The cutover PR MUST add a test fixture at `tests/integration/domain-event-canonicalization-fixture.test.ts` that asserts: for each renamed event_type, the canonical string is emitted by the slice; the placeholder string is NOT emitted; the canonicalization map artifact lists the pair. This is the canary that would fail if a subsequent slice or migration accidentally re-introduces the placeholder string.
3. **Producer cutover (one PR per slice).** Each slice atomically replaces placeholder strings with canonical strings in `src/modules/<slice>/events.ts` AND the slice's outbox-landing test file AND the forward-compat fixture (step 2). PRs are squash-merged; CI gate is the standard test-suite green + the new fixture green.

**Promotion trigger from v1.0 → v1.X protocol.** The FIRST time a non-test external service (a worker, a separate microservice, an analytics consumer, etc.) issues `POST /v0/internal/outbox/subscribe` to the dispatcher, Decision 7B activates. The activation is observable: the `subscriber_registry` table goes from 0 rows to 1+ rows. The first registration MUST be paired with a Promotion Ledger entry "P-NNN — Outbox subscriber inventory crossed zero; Decision 7B activates" and any in-flight rename PR MUST pause and re-evaluate under 7B.

**v0.7 — concrete enforceable v1.0 CI guardrail (Codex R4+R5 HIGH closure 2026-05-14).** The activation observation point (`POST /v0/internal/outbox/subscribe` + `subscriber_registry`) is itself part of the deferred Decision 7B infrastructure. Without an enforceable v1.0 interim control, a first consumer could be deployed BEFORE P-1 through P-5 exist by directly querying `domain_events_outbox` or matching event_type strings in its own code, and the registry would remain empty even though a consumer is reading the outbox. **v0.6's grep-based proposal used unsupported CODEOWNERS extglob syntax (Codex R5) — v0.7 replaces it with truly enforceable path-based + registration-manifest controls.**

- **G-1. Path-based CODEOWNERS (valid GitHub syntax).** The file `.github/CODEOWNERS` is amended with the following block, using only path-pattern syntax that GitHub actually supports (no `!` exclusion; no diff-content predicates):

  ```
  # SI-003 v0.7: any new outbox-consumer code path requires @platform-eventing-team review.
  # The allowlist below is the EXHAUSTIVE set of v1.0 consumers permitted to touch
  # domain_events_outbox directly. New consumers MUST extend this list via a PR that
  # requires @platform-eventing-team approval per the catchall rule below.
  /src/modules/consent/                      @consent-team @platform-eventing-team
  /src/modules/identity/                     @identity-team @platform-eventing-team
  /src/modules/forms-intake/                 @forms-team @platform-eventing-team
  /src/lib/domain-events.ts                  @platform-eventing-team
  /src/lib/outbox-relay.ts                   @platform-eventing-team
  /tests/integration/*outbox*                @platform-eventing-team
  /docs/SI-003-*.md                          @platform-eventing-team
  /docs/DOMAIN_EVENT_TYPE_CANONICALIZATION_MAP_*.md  @platform-eventing-team
  /.github/workflows/outbox-consumer-guard.yml      @platform-eventing-team
  /docs/outbox-consumer-registry.yaml        @platform-eventing-team
  ```
  This is purely path-based; GitHub enforces it natively. The catchall is enforced by G-2 (any new outbox reader added in a path NOT in this list will be flagged by G-2 and routed back to @platform-eventing-team via the bypass-label flow).

- **G-2. CI script with concrete diff parsing (`scripts/check-outbox-consumer-guard.sh`; v0.8 redesigned).** A bash script invoked by `.github/workflows/outbox-consumer-guard.yml` performs the diff inspection. **v0.8 R6 closure (Codex 2026-05-14):** v0.7 allowed manifest-covered paths to bypass the diff grep, which meant a developer could add an outbox-read selector inside `src/modules/consent/` (a manifest-covered emitter directory) and never be flagged. v0.8 inverts the logic: **all changed files are scanned for outbox reads regardless of manifest coverage; the manifest's `purpose` field is enforced as a constraint, not as a bypass.**
  1. Reads `docs/outbox-consumer-registry.yaml` (the manifest; shape per G-3 below).
  2. Runs `git diff --name-only origin/main HEAD` to identify changed files.
  3. **For EVERY changed file (regardless of manifest coverage)**, runs `git diff origin/main HEAD -- <file>` and greps the ADDED lines (`^+`) for the following patterns: `domain_events_outbox`, `\bdomain_events_outbox\b`, `from\s+['"].*outbox.*['"]` (import-from), `subscribe\(.*event_type`, `where.*event_type`, `\.event_type\s*=`, `select.*from.*outbox`. **A match in any added line is a finding.**
  4. **Finding-disposition rule (v0.8 NEW):**
     - **If the file is covered by a manifest entry with `purpose: reads-and-writes` OR `purpose: reads-only`** AND every matched event_type literal in the added lines is listed in the entry's `allowed_event_types`, the finding is RESOLVED — proceed.
     - **If the file is covered by a manifest entry with `purpose: emits-only`** (the case for the 3 producer slices), ANY outbox-read pattern in the added lines is a BLOCKING finding. The manifest's `purpose: emits-only` becomes a positive constraint: emitter directories may not acquire reader code. Fixing requires either splitting the new reader code into a non-emitter directory + adding it as a new manifest entry, OR amending the entry's `purpose` to `reads-and-writes` (which itself requires @platform-eventing-team review per CODEOWNERS).
     - **If the file is NOT covered by any manifest entry**, the finding is BLOCKING regardless of pattern. Adding outbox-read code in an unregistered path is the case the guard was designed to prevent.
  5. The script ALSO greps for known canonical event_type STRINGS (the full 28-string canonical list per Decision 4) in added lines across **all changed files**. The same finding-disposition rule applies: only manifest entries with `purpose: reads-*` AND explicit allowlist entries for the matched strings permit the addition.
  6. The script exits non-zero on any BLOCKING finding; the workflow gates the PR.
  7. The CI gate is bypass-able only by the `outbox-consumer-guard: bypass` label applied by @platform-eventing-team (label-protected via repo settings). Bypasses are logged to `docs/outbox-consumer-guard-bypass-log.md` (append-only) via a separate workflow that runs on label-add.

- **G-3. Registration manifest (`docs/outbox-consumer-registry.yaml`).** A YAML manifest enumerates every authorized v1.0 outbox reader. Adding a new reader requires editing this manifest AND triggering @platform-eventing-team review via G-1 (the manifest path is in the CODEOWNERS list). The manifest is the v1.0 surrogate for the eventual Decision 7B `subscriber_registry` table — same shape, file-based instead of DB-based.

  Example shape:
  ```yaml
  consumers:
    - path: src/modules/consent/
      owner: consent-team
      registered_at: 2026-05-XX  # at SI-003 ratification
      allowed_event_types:
        - consent.granted
        - consent.revoked
        - delegation.invited
        - delegation.accepted
        - delegation.declined
        - delegation.revoked
        - delegation_scope.granted
        - delegation_scope.revoked
      purpose: emits-only (no external read path)
    - path: src/modules/identity/
      owner: identity-team
      registered_at: 2026-05-XX
      allowed_event_types:
        - account.created
        - account.activated
        - session.issued
        - session.revoked
        - otp.issued
        - otp.consumed
        - otp.lockout_triggered
        - device.registered
        - device.revoked
      purpose: emits-only
    - path: src/modules/forms-intake/
      owner: forms-team
      registered_at: 2026-05-XX
      allowed_event_types:
        - forms_template.created
        - forms_template.version_published
        - forms_deployment.created
        - forms_deployment.retired
        - forms_variant.created
        - forms_variant.winner_promoted
        - forms_variant.retired
        - forms_resume_state.saved
        - forms_resume_state.restored
        - intake_response.submitted
        - intake_response.completed
        - intake_subscription_intent
      purpose: emits-only
  ```

- **G-5. Single-API-surface fail-closed on outbox-reader helper imports (v0.9 NEW; Codex R7 HIGH closure).** G-2's added-line regex grep can miss consumers that use dynamic selectors, query-builder APIs, or imported event-type constants. v0.9 closes this gap by mandating a **single canonical outbox-reader API surface** at `src/lib/outbox-reader.ts` (or `src/lib/domain-events-reader.ts`; exact name TBD at v5.3 promotion). ALL programmatic outbox-read access flows through this module — no other code may construct an SQL query against `domain_events_outbox`, instantiate a query-builder targeting it, or import event-type constants for filter-construction outside this module.

  **G-5 enforcement (CI script extensions):**
  1. The G-2 script extends its grep set to flag any `import ... from ['"].*outbox-reader.*['"]` (and the equivalent `require()`) in ADDED lines of any changed file. The disposition rule (per G-2 step 4) applies: `purpose: emits-only` entries fail, no manifest entry fails, only `purpose: reads-*` entries with explicit allowlist hits pass.
  2. The G-2 script also flags any `import ... from ['"].*domain-event-types.*['"]` (the canonical event_type constants module, also TBD at v5.3 promotion). Same disposition rule.
  3. The G-2 unit test suite is extended with at least 5 additional cases: (a) dynamic-string-built `event_type IN (...)` query, (b) query-builder API targeting the outbox table, (c) array of event_type constants used as filter, (d) helper function call that internally hits the outbox, (e) re-export of outbox-reader module from a non-manifest path.
  4. A baseline-enforcement workflow (`.github/workflows/outbox-reader-api-surface-check.yml`) runs once per CI invocation to assert that `src/lib/outbox-reader.ts` is the ONLY file performing direct `domain_events_outbox` SQL access, by AST-walking every `.ts` file under `src/` and failing if any other file constructs a Postgres query string mentioning the table. The walk uses `ts-morph` or equivalent (lightweight; runs in CI in <30s).

  **G-5 is a STATIC architectural invariant** (single-reader-API surface) backed by AST-level enforcement, not just diff-grep. This eliminates the Codex R7 "indirect consumer via helper-import" gap.

- **G-4. Architectural gate for out-of-monorepo consumers.** If an external service can live outside this monorepo (a separate microservice with its own repo, a third-party analytics consumer, etc.), no in-repo CI can detect it. v0.7 requires an **architectural Promotion Ledger entry** before any out-of-monorepo service is permitted to read `domain_events_outbox`. The entry name format: `P-NNN — Out-of-monorepo outbox consumer registered: <service-name> @ <repo-url>`. This entry is observable in the Promotion Ledger (which is append-only per the spec corpus discipline) and pairs with a `docs/outbox-consumer-registry.yaml` entry adding the external service. **No external service can read the outbox without this entry.** Enforcement is governance-level (not CI), but the rule is auditable: any external service emitting metrics tagged with telecheck event_types but lacking a corresponding Promotion Ledger entry is a finding for the Platform Eventing team to triage.

**Interim v1.0 deliverables (NOT deferred; part of SI-003 ratification):**

- **G-1 deliverable:** `.github/CODEOWNERS` amendment, committed in the v5.3 promotion PR.
- **G-2 deliverable:** `.github/workflows/outbox-consumer-guard.yml` + `scripts/check-outbox-consumer-guard.sh`, committed in the v5.3 promotion PR. Script MUST include a unit-test suite at `scripts/check-outbox-consumer-guard.test.sh` exercising at least 8 test cases: (1) new file in allowlisted path passes, (2) new file outside allowlist with no outbox reference passes, (3) new file outside allowlist with `domain_events_outbox` reference fails, (4) new file outside allowlist matching a canonical event_type string in a SQL-like context fails, (5) new file outside allowlist with a helper-import from `lib/outbox-*.ts` fails, (6) manifest-added entry permits a new path, (7) the bypass label permits override, (8) a malformed manifest fails the script's preflight.
- **G-3 deliverable:** `docs/outbox-consumer-registry.yaml`, committed in the v5.3 promotion PR with the 3 emitting slices' entries.
- **G-4 deliverable:** Promotion Ledger discipline documented in the v5.3 promotion PR's release notes. Enforcement is procedural (no CI artifact required for v1.0 since no out-of-monorepo consumers exist yet).
- **G-5 deliverable (v0.9):** `src/lib/outbox-reader.ts` single-API-surface module + `.github/workflows/outbox-reader-api-surface-check.yml` + AST baseline-enforcement workflow + G-2 script extensions for outbox-reader-helper-import + canonical event-type-constants-module-import detection + 5 additional unit-test cases.

These four interim controls — G-1 path-based CODEOWNERS, G-2 CI script with concrete diff parsing + manifest validation + unit-tested patterns, G-3 file-based registration manifest, G-4 Promotion Ledger discipline for out-of-monorepo consumers — eliminate the Codex R5 gap. Zero infrastructure dependency remains (no dispatcher, no DB registry, no /v0/internal/ endpoint).

#### Decision 7B — v1.X+ cutover protocol (active once any external subscriber registers)

**Preconditions:** at least one external subscriber service exists and has registered with the dispatcher. The dispatcher / outbox-relay infrastructure (described below) is implemented.

**Prerequisite infrastructure (MUST be delivered BEFORE the first v1.X subscriber ships):**

- **P-1.** `lib/outbox-relay.ts` — outbox-relay component that publishes from `domain_events_outbox` to the downstream notification surface. Owner: Platform Eventing team (does not exist at v1.0; deferred SI to be raised when the first subscriber needs it).
- **P-2.** `subscriber_registry` table — schema migration with `(subscriber_id, event_type, registered_at, last_heartbeat_at)`. Tenant-scoped (every row carries `tenant_id` per I-023). Owner: Platform Eventing.
- **P-3.** `POST /v0/internal/outbox/subscribe` endpoint — registration write path; subscriber-authenticated via mutual TLS or internal-service JWT. Owner: Platform Eventing.
- **P-4.** `outbox.published_canonical_event_type{event_type, downstream_acks=N}` metric — emitted by `lib/outbox-relay.ts` per Decision 7B step 4a below. Owner: Platform Eventing + Observability.
- **P-5.** Merge-time CI check — queries `subscriber_registry` for placeholder-name entries; blocks merge if found. Implementation: GitHub Actions workflow that runs against a production-replica view of `subscriber_registry`. Owner: DevEx.

**These 5 deliverables are FORWARD-LOOKING. They are NOT part of the SI-003 ratification deliverables (P-015 closes SI-003 by enumerating canonical event-type strings and detail shapes; it does NOT include dispatcher infrastructure).** The dispatcher infrastructure will be specified by a separate SI when the first external subscriber concretely needs it. Until then, Decision 7A governs.

**Producer-cutover protocol once Decision 7B activates (5 steps):**

1. **Subscriber inventory (precondition for any rename PR).** Before any producer-cutover PR is opened, the cutover author MUST enumerate every subscriber service that matches against the placeholder strings being renamed. At v1.0 the inventory is empty (no subscribers exist), and the empty result is recorded in the cutover PR description with a grep audit demonstrating no consumer-side match selectors exist outside the emitting slice + its outbox-landing test.
2. **Subscriber-side dual-read deploy first.** If the inventory is non-empty, each subscriber MUST first ship a release that accepts BOTH the placeholder and the canonical string (a `MATCH IN (...)` selector or equivalent). This release deploys to all environments BEFORE the producer cutover PR opens. No producer rename merges until every inventoried subscriber has dual-read live in production.
3. **Alias map artifact committed at ratification.** A static `docs/DOMAIN_EVENT_TYPE_CANONICALIZATION_MAP_P_015.md` enumerates every (placeholder → canonical) pair. Subscribers reference this artifact authoritatively. The map is committed as part of the v5.3 promotion PR (alongside DOMAIN_EVENTS v5.3 promotion). It does NOT live in the producer-cutover PRs.
4. **Dispatcher-side observability for stranded canonical events (v0.4 revised).** Subscriber-only metrics CANNOT detect the highest-risk failure mode: a subscriber whose outbox query filters by the **old placeholder string** never reads the renamed canonical rows, so it never emits an unmatched-event metric (the subscriber sees an empty result set, not an unmatched event). v0.4 closes this gap by requiring observability at the **dispatcher / outbox-publisher boundary**, independent of any subscriber's selector:
   - **a. Central outbox dispatcher metric:** `outbox.published_canonical_event_type{event_type=…, downstream_acks=N}` — emitted by the outbox-relay component (lib/outbox-relay.ts at the time it publishes from `domain_events_outbox` to the downstream notification surface). The `downstream_acks` label counts subscribers that ACKed receipt within the publish window. A 5-minute sustained value of `downstream_acks=0` for any canonical event_type that previously had `downstream_acks >= 1` (under its placeholder name) is the **silent-rename alarm**. The metric MUST be wired into the standard SLI dashboard with a PagerDuty alert on the regression transition.
   - **b. Subscriber-acknowledgement registry:** every subscriber MUST register its consumed event_types with the dispatcher at startup via a known endpoint (`POST /v0/internal/outbox/subscribe`). The dispatcher maintains an authoritative `subscriber_registry` table keyed by `(subscriber_id, event_type)`. At producer-cutover merge time, the cutover PR's CI check queries this registry and BLOCKS the merge if any subscriber's registry entry still lists a placeholder name (Decision 7 step 5 cannot run until the registry is canonical-only OR explicitly waived per the empty-inventory rule).
   - **c. Subscriber-side metric retained:** the per-subscriber `outbox.unmatched_event_type` metric per v0.3 IS still required as the **secondary** detector for subscribers that read events but drop them post-read. It is no longer the sole detector.
5. **Producer cutover (one PR per slice; merge-time inventory re-run).** Once steps 1-4 are satisfied AND the cutover PR's CI check confirms the dispatcher's subscriber_registry contains no placeholder entries for the renamed event_types, the producer-cutover PR may be squash-merged. **The CI check MUST re-run the registry query at merge time** (not just at PR open), so a subscriber that shipped a regression after the PR opened but before merge blocks the rename. Each slice's PR is independent (no cross-slice ordering dependency).

**Removal window.** After all producer-cutover PRs merge AND both detectors (dispatcher-side `outbox.published_canonical_event_type{downstream_acks}` regression alarm + subscriber-side `outbox.unmatched_event_type` metric) show no anomalies for **30 consecutive days**, the placeholder strings MAY be removed from subscriber dual-read selectors and from the alias map. The 30-day quiet period MUST be observed even when the inventory was empty at cutover, in case a new subscriber shipped during the cutover window without consulting the canonicalization map.

**Inventory staleness mitigation (v0.4 NEW).** The grep audit in step 1 is a **point-in-time check** — it cannot prove subscribers that exist outside the monorepo (e.g., a future Pharmacy-service subscriber that grew from another git history). The dispatcher-side subscriber_registry in step 4b is the **canonical** inventory; the grep audit is a corroborating signal but not the sole authority. At v1.0 with no subscribers shipped, the registry is empty and matches the grep audit; once the first external subscriber registers, the registry diverges from grep and the registry MUST win.

**Rationale for not waiting for consumers at v1.0:** the v1.0 outbox is producer-only — its consumers don't exist yet. Holding the SI-003 ratification until consumers exist would extend the placeholder-string emission window indefinitely, and the eventual rename would have N consumers (not zero) to migrate. Ratifying now establishes the canonical names; Decision 7A handles the v1.0 cutover (grep-based; dispatcher-free); Decision 7B handles cutovers once subscribers exist (dispatcher-gated). The Decision 7B prerequisites are explicitly deferred from SI-003 ratification deliverables.

**Cross-slice migration matrix:** the canonicalization map artifact (`docs/DOMAIN_EVENT_TYPE_CANONICALIZATION_MAP_P_015.md`) is committed at ratification time, listing every (placeholder → canonical) pair so consumers can be migrated mechanically and so the alarm metric in Decision 7B step 4a has a known key-set when activated.

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
