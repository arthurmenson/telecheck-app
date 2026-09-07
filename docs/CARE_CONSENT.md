# Versioned care consent

Patients resolve an explicitly configured publication, read the reviewed copy, and submit a deliberate boolean choice for each term. The server binds each decision to the authenticated patient, tenant, country, session, publication, hash and canonical version. Initial refusal remains a refusal; optional AI use never becomes a requirement for ordinary care.

## Publication and activation

The closed `care_consent_v1` JSON contract contains country, locale, nullable program, development-only flag, jurisdictional review reference/conclusion and 2–11 terms. Exactly one platform term and one correctly scoped care term are required. Jurisdictional terms must agree with the review conclusion. The optional data-use term supported here is `ai_interpretation`; research or marketing grants are not inferred.

Each term has a stable key, version label, title, summary, ordered sections, duration and withdrawal effect. Optional AI terms additionally describe declining. SQL and TypeScript enforce matching UTF-16 text bounds and a 64 KiB canonical JSON boundary. Plain text is not executable markup. Hashing sorts object keys while preserving array order and every displayed character.

An active tenant administrator also needs explicit `policy_author` or `policy_reviewer` membership. Authors cannot approve their own drafts. Publication verifies the hash, serializes policy-family/version changes and binds exact copy to canonical versions. A label cannot be reused with different terms. Publication supersedes the prior policy for that country/locale/program family. Reviewers can withdraw published or superseded policies; patient history remains available.

Tenant Config selects through registered key `consent.care_policy_publications`, a flat object keyed by `general` or program ULID. Each value is `{publication_id,policy_hash,development_only}`. The service uses Tenant Config's public interface; SQL independently checks and locks the same configuration and publication. Country, locale and program must match. There is no implicit fallback. Production rejects development-only policies.

Acceptance provisions memberships/configuration as explicit synthetic fixtures. This does not implement administration onboarding or production activation.

## Patient API

All routes below are under `/v0/consent`, require the patient's own context, reject delegate context and send `Cache-Control: no-store`. Optional `program_id` applies only to terms, choices and status. Caller-supplied subjects, evidence, timestamps, device identifiers and canonical grant IDs are rejected.

| Endpoint                         | Contract                                                                                           |
| -------------------------------- | -------------------------------------------------------------------------------------------------- |
| `GET /care/terms`                | `{publication_id,policy_hash,content}`                                                             |
| `POST /care/choices`             | `{publication_id,policy_hash,choices:[{term_key,accepted}]}`; exactly one explicit choice per term |
| `GET /care/status`               | Publication/hash, `required_care_active`, independent `ai_interpretation_active`, per-term state   |
| `GET /care/history?offset=0`     | `{offset,limit:25,has_more,items}`; integer offset 0–10000                                         |
| `GET /care/history/:decision_id` | Own historical decision, exact term and current withdrawal eligibility                             |
| `POST /care/withdraw`            | `{decision_id}` for the current accepted non-platform choice                                       |

Writes use idempotency keys. Receipts contain decision ID, nullable canonical consent ID, term key/type/scope/version, explicit boolean and `granted`, `revoked` or `declined` status. Initial false choices create no fabricated revocation. Replays do not duplicate decisions or audit.

History items contain decision/publication/hash, term key/type/scope/version, original boolean/status/time, publication status, readable title/version label, country/program, `current_choice`, `can_withdraw` and `requires_account_closure`. They omit subject IDs, session and internal evidence. Detail adds locale, development flag and the exact `CarePolicyTerm` snapshot. An old `status:granted` describes the historical event; `current_choice:false` and `can_withdraw:false` describe its current eligibility. Ordering uses a monotonic sequence allocated after the patient's serialization lock.

Patients can withdraw current non-platform grants after supersession or policy withdrawal without first accepting replacement terms. Stale targets conflict; idempotent replay retains its original receipt. Accepted platform terms require a separate account-closure workflow and currently return `409 consent.account_closure_required`; no closure is simulated.

Status checks the latest decision for type/scope, required canonical version, grant validity and policy withdrawal. General-care grants cannot substitute for program-care grants; old versions cannot satisfy changed required terms. This patient-only status API is not an authorized clinician or worker capability.

## Operator API

Under `/v0/consent/governance/care-policies`: `POST /` creates the immutable draft; `GET /:policy_id` reads it; `POST /:policy_id/publish` independently approves the exact hash; `POST /:policy_id/withdraw` retires a reviewed policy while retaining evidence. The patient does not select arbitrary publications for admission.

## Authorization and evidence

Migration 093 uses forced tenant RLS, two callable roles and a private unassumable owner. Authority derives from live nonce, session, account, tenant and country; operators additionally need current staff type and capability. READ COMMITTED visibility and wall-clock expiry are required. Authorization surrounds blocked reads/writes, audit/outbox work and cached replay. Guessed identifiers do not disclose another patient or tenant.

Policy mutations require same-transaction `config_change_validated` audit and linked `consent.policy.drafted/published/superseded/withdrawn` events. Each patient choice requires Category C `consent_choice_recorded` and linked `consent.choice_recorded`. Canonical grants/revocations additionally require their existing audit/domain events. Deferred constraints enforce correlated evidence before commit. Payloads contain IDs, type/scope/version and policy hash, not full terms, device data or patient prose.

New audit/domain names and the CCR key need canonical registration in the accompanying continuity update. Internal unversioned consent service tests retain legacy coverage; they do not establish a reviewed care journey.

## Recovery and verification

An empty migration-093 deployment supports rollback/reapplication. The companion locks all four owned tables before checking emptiness. Any policy, mapping, decision or membership causes `0A000 consent_rollback_requires_reviewed_forward_migration` before schema removal. Populated deployments preserve evidence and require a reviewed forward correction. Canonical consents, versions, audit and outbox remain in either case.

`scripts/verify-care-consent-ci.mjs` requires an empty local synthetic `telecheck_consent` database. It applies/replays the full chain, verifies committed empty rollback/reapplication, provisions separate restricted application/Identity/binder logins, runs actual HTTP acceptance, then verifies populated rollback refusal/preservation. CI covers PostgreSQL 15 and 16. Synthetic terms and fixture approvals do not prove real legal/clinical approval, delivery or provider activation.

US/Ghana acceptance includes independent publication, exact hash/configuration, required evidence, required versus optional choices, replay/conflicts, program/jurisdiction/version separation, pagination, exact historical terms, eligibility, other-patient/staff denial, policy withdrawal and authority invalidation during controlled waits. Full existing tests, pure contracts, migration tests, typecheck, lint, format, build, log scan and SQL encoding checks remain required.
