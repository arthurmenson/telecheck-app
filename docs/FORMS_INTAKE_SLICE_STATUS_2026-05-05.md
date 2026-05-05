# Forms / Intake Engine Slice — Implementation Status

**Date:** 2026-05-05
**Author:** Autonomous turn (Claude Sonnet 4.5)
**Final commit:** `86b7844` (Slice 1 itself stable since pre-`d2b6ea9`; cross-cutting hardening + JWT migration extends through `692206e`)
**CI status:** ✅ Green at `86b7844` (per the autonomous-turn record; not re-verified at this doc's authoring because `gh` is not authenticated in this session)

---

## Summary

The Forms / Intake Engine slice (Slice 1 of 17 per EHBG §10b sprint plan; **Slice 1** is the platform foundation that unblocks Identity, Consent, Subscription, and every clinical surface that depends on intake-driven account creation) is **implementation-complete on its v2.1 surface**.

The full **template authoring → deployment → patient-facing intake → crisis-detection gate → snapshot at submit → resume after pause** pipeline works end-to-end. The slice was the first to land in this code repo and established the canonical patterns every subsequent slice has mirrored:

- Modular-monolith layout (`src/modules/<name>/{public-index, plugin, routes, audit, internal/{types, repositories, services, handlers}}`)
- Same-transaction audit emission via `txCallback` hook (I-003)
- PHI-safe view pattern (rest-spread strip of `tenant_id` per Master PRD v1.10 §17 + Glossary v5.2 C3)
- AUDIT_EVENTS placeholder pattern (`{slice}AuditPlaceholder()`) for unratified action IDs
- Tenant-scoped idempotency on every state-changing endpoint (IDEMPOTENCY v5.1)
- Cross-tenant isolation enforced via `withTenantBoundConnection()` + RLS layer-1 + app-layer tenant filter

Every slice that followed (Identity, Consent) inherited these patterns.

---

## What's built

### CDM §3 / Forms Engine §4 entities — all six scaffolded with migrations + repos + services

Migrations 006 + 007 + 008 + 009 + 010 + 011. The base schema landed in `006_forms_intake.sql`; subsequent migrations are backwards-compatible refinements (uniqueness-constraint hardening, audit-target invariant backfill, type widening for cross-locale program-id and actor-id text inputs).

| Entity           | Migration | Repo            | Service                | Audit emitter family                                                    | HTTP handler   |
| ---------------- | --------- | --------------- | ---------------------- | ----------------------------------------------------------------------- | -------------- |
| FormsTemplate    | 006       | template-repo   | template-service       | forms.template.created / version_published                              | templates.ts   |
| FormsDeployment  | 006       | template-repo   | template-service       | forms.deployment.created / retired                                      | deployments.ts |
| FormsSubmission  | 006 + 008 | submission-repo | submission-service     | forms.submission.started / completed                                    | submissions.ts |
| FormsSnapshot    | 006 + 009 | snapshot-repo   | snapshot-service       | (ephemeral; snapshot is the audit artifact itself per Forms Engine §13) | snapshots.ts   |
| FormsVariant     | 006       | template-repo   | template-service       | forms.variant.created / winner_promoted / retired                       | variants.ts    |
| FormsResumeState | 006       | submission-repo | resume-token + service | forms.resume.state_saved / state_restored                               | resume.ts      |

Migration 008 enforces "at most one `in_progress` forms_submission per `(tenant_id, deployment_id, patient_id)`" (the I-022-adjacent intake ergonomic invariant). Migration 009 enforces "at most one forms_snapshot per `(tenant_id, submission_id)`" — snapshots are append-only at submit-time, not amendment-style. Migrations 010 + 011 widen `program_id` and actor-id columns from `VARCHAR(26)` to `TEXT` so non-ULID identifiers from upstream brands and B2B partners don't break ingestion.

### HTTP API surface — 19 routes mounted under `/v0/forms`

| Method | Path                                                 | Purpose                                                                 |
| ------ | ---------------------------------------------------- | ----------------------------------------------------------------------- |
| GET    | `/health`                                            | Module health probe                                                     |
| POST   | `/templates`                                         | Author a new form template (operator)                                   |
| GET    | `/templates`                                         | List templates for the tenant                                           |
| GET    | `/templates/:templateId`                             | Read a template + its versions                                          |
| POST   | `/templates/:templateId/versions/:versionId/publish` | Publish a version (transitions DRAFT → PUBLISHED)                       |
| POST   | `/deployments`                                       | Deploy a published template version under a CCR-driven program          |
| GET    | `/deployments/:deploymentId`                         | Read deployment metadata                                                |
| POST   | `/deployments/:deploymentId/retire`                  | Retire a deployment (no future submissions accept this deployment)      |
| POST   | `/submissions`                                       | Patient starts a submission against an active deployment                |
| GET    | `/submissions/:submissionId`                         | Patient or operator reads in-progress responses                         |
| PATCH  | `/submissions/:submissionId/responses`               | Patient updates partial responses (resume-state-saving on the path)     |
| POST   | `/submissions/:submissionId/submit`                  | Finalize submission → emit Category C completion audit + write snapshot |
| GET    | `/submissions/:submissionId/snapshot`                | Read the snapshot for a completed submission                            |
| GET    | `/snapshots/:snapshotId`                             | Read a snapshot by its own id                                           |
| POST   | `/variants`                                          | Author an A/B variant of a published template                           |
| GET    | `/variants/:variantId`                               | Read a variant + its assignment rule                                    |
| POST   | `/variants/:variantId/promote`                       | Promote a variant to the canonical published version                    |
| POST   | `/resume`                                            | Issue a resume token for an in-progress submission (HMAC-signed)        |
| GET    | `/resume/:resumeToken`                               | Redeem a resume token → re-attach the in-progress submission            |

### Audit emitters — 14 lifecycle events across Categories B + C

- **Category B (governance):** `forms.eligibility_logic.edited`, `forms.approval_governance.edited`
- **Category C (operational):** `forms.template.created`, `forms.template.version_published`, `forms.deployment.created`, `forms.deployment.retired`, `forms.submission.started`, `forms.submission.completed`, `forms.resume.state_saved`, `forms.resume.state_restored`, `forms.variant.created`, `forms.variant.winner_promoted`, `forms.variant.retired`
- **Category A (safety-critical):** `crisis_detection.trigger` (per I-019 platform-floor; emitted from inside the submission-service's response-evaluation pass)

All emitted via `formsIntakeAuditPlaceholder()` (single sanctioned `as AuditAction` cast site; pending AUDIT_EVENTS v5.2 ratification of canonical IDs).

### Schemas + types (cross-module-stable)

- **`src/modules/forms-intake/schemas.ts`** — Zod-style request/response shapes; the canonical wire-contract surface re-used by deployments/variants/snapshots/submissions handlers.
- **`src/modules/forms-intake/internal/types.ts`** — branded ID types (FormsTemplateId, FormsTemplateVersionId, FormsDeploymentId, FormsSubmissionId, FormsSnapshotId, FormsVariantId, FormsResumeStateId).
- **`src/modules/forms-intake/events.ts`** — domain-event emission scaffolding; deferred at v1.0 (outbox-only emission), wired against migration `004_domain_events_outbox.sql`.

### Cross-module public interface

```ts
import {
  formsIntakePlugin, // Fastify plugin for app.ts wiring
  getActiveDeployment, // The canonical "which deployment serves this patient" resolver
  type FormDeployment, // The deployment view consumed by other slices
  type CrisisSignals, // Crisis-detection signal envelope per I-019
  type FormsCcrPolicy, // Per-tenant CCR policy used by submission-service
} from 'src/modules/forms-intake';
```

---

## Test coverage

| Test file                                      | Cases   | Layer                                          |
| ---------------------------------------------- | ------- | ---------------------------------------------- |
| forms-intake-templates-http.test.ts            | 19      | HTTP integration                               |
| forms-intake-deployments-http.test.ts          | 14      | HTTP integration                               |
| forms-intake-submissions-http.test.ts          | 16      | HTTP integration                               |
| forms-intake-snapshot-http.test.ts             | 5       | HTTP integration                               |
| forms-intake-variants-http.test.ts             | 14      | HTTP integration                               |
| forms-intake-resume-http.test.ts               | 11      | HTTP integration                               |
| forms-intake-submission.test.ts                | 30      | Service                                        |
| forms-intake-variants.test.ts                  | 18      | Service                                        |
| forms-intake-resume.test.ts                    | 17      | Service                                        |
| forms-intake-restore.test.ts                   | 10      | Service (resume-state restore)                 |
| forms-intake-pause.test.ts                     | 5       | Service (resume-state save / pause)            |
| forms-intake-publish.test.ts                   | 6       | Service (template version publish)             |
| forms-intake-events.test.ts                    | 16      | Cross-cutting (domain-event emission contract) |
| forms-intake-admin.test.ts                     | 12      | Admin/operator surface                         |
| resume-token.test.ts                           | 32      | Unit (HMAC sign + verify + replay defense)     |
| submission-delegate-ownership.test.ts          | 4       | I-024 (delegate cross-tenant denial)           |
| i019-crisis-detection.test.ts                  | 9       | Invariant (Category A floor)                   |
| **Total Forms-Intake + crisis + resume-token** | **238** | —                                              |

Plus the schema-level migration tests in the foundation set (000-005 + 006-011) — those are the canonical schema fixtures consumed by every test downstream.

---

## Security gates active

- **I-019** crisis-detection — platform-floor; never gated behind config; emits Category A `crisis_detection.trigger` audit when any of the canonical phrase-bank or heuristic signals fire on a response. `tests/invariants/i019-crisis-detection.test.ts` proves the gate is live and untestable-via-config-disable.
- **I-022** consent-clarity / single-active-submission — DB-level partial unique index in migration 008; service-layer surfaces a 409 envelope when a patient tries to start a second `in_progress` submission against the same deployment.
- **I-023** — three-layer tenant isolation: RLS layer-1 + app-layer tenant filter in every repo SELECT + per-tenant KMS via `tenant.kms_key_alias` for resume-state encryption.
- **I-024** — cross-actor / break-glass: delegate-cross-tenant attempts return 404 tenant-blind via `submission-delegate-ownership.test.ts`. The slice does NOT support break-glass at v1.0; that lands with the Admin Backend slice.
- **I-025** — tenant-blind error envelopes: every 4xx envelope across the 19 routes carries no tenant identifier or DBA substring (verified by the canonical `tests/integration/error-envelope-http.test.ts`, which targets the forms-intake surface specifically).
- **I-027** every audit row carries `tenant_id` (DB-enforced NOT NULL on `audit_records.tenant_id` per migration 002).
- **I-003** audit append-only — same-tx emission via `txCallback`; idempotent endpoint replay (per IDEMPOTENCY v5.1) emits NO spurious audit on cache hit (the cached response is returned without re-running the handler).
- **Master PRD v1.10 §17 + Glossary v5.2 C3** — `tenant_id` stripped from every patient-surface response (deployments, submissions, snapshots, resume-state views).
- **Resume-token integrity** — HMAC-SHA256 signed; server-side fail-closed verification rejects forged tokens; `RESUME_TOKEN_SECRET` env var ≥32 chars production-gated in `src/lib/config.ts`.

---

## JWT migration (Slice 2 follow-on, applied here)

All 6 forms-intake handlers were migrated from the original `x-actor-id` / `x-patient-id` header shim (Tier 2) to honor JWT `req.actorContext` (Tier 1) when populated by the `authContextPlugin`. Tier 2 remains as a fallback for tests/dev convenience and is gated by the `ALLOW_ACTOR_HEADER_AUTH` env var (fail-closed in production).

The migration touched: `templates.ts`, `deployments.ts`, `variants.ts`, `resume.ts`, `snapshots.ts`, `submissions.ts` (commits `42d1694` + `1b7e011`).

---

## Known limitations / deferred work

| Item                                                                     | Status                                                                                                                                                                                           |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Domain-event emission alongside audit (forms-intake outbox)              | Scaffolded in `events.ts`; outbox table exists (`migrations/004`); end-to-end emission deferred — pattern consumed by Slice 3 (consent) status doc                                               |
| Forms-intake header-shim Tier 2 retirement                               | Deferred — pending migration of every forms-intake test to JWT-bearing requests                                                                                                                  |
| AUDIT_EVENTS v5.2 ratification of forms-intake action IDs                | Open SPEC ISSUE — emitted via `formsIntakeAuditPlaceholder()` pattern; same approach inherited by Identity (`identityAuditPlaceholder`) and Consent (`consentAuditPlaceholder`)                  |
| Crisis-detection escalation routing (operator alert → on-call clinician) | Deferred — `crisis_detection.trigger` audit is emitted; the consumer (alerting + on-call routing) lands with the Admin Backend slice and the on-call rotation infra                              |
| Multi-language template support                                          | Schema supports a `locale` column; runtime resolution + UX deferred until per-jurisdiction Market Rollout Cockpit work                                                                           |
| Variant traffic-split runtime evaluation                                 | `forms_variant.assignment_rule_jsonb` accepts the rule shape; runtime variant-evaluator lands with the Acquisition & Engagement slice (PostHog A/B integration per EHBG §10b Sprint 3 detail)    |
| Codex review §1c rest-spread "false-confidence" finding                  | Deferred indefinitely — current FormSnapshot / FormSubmission fields are all patient-safe; the rest-spread pattern is preserved for future-safety but the explicit allowlist refactor is on hold |

---

## Resumed-turn relationship to Slices 2 + 3

Forms-Intake landed BEFORE the resumed turn that produced Slices 2 + 3. The pre-resumed-turn baseline (per the conversation summary) was 802 test cases; Slice 1 contributed the bulk of those. The resumed turn added Slice 2 (~212 cases per `IDENTITY_SLICE_STATUS_2026-05-05.md` accounting) and Slice 3 (~90 cases per `CONSENT_SLICE_STATUS_2026-05-05.md` plus follow-on hardening tests).

Backward-compat preserved: the JWT migration of forms-intake handlers (commits `42d1694` + `1b7e011`) was specifically designed so every pre-resumed-turn forms-intake test continues to pass against the Tier 2 header shim — the migration is additive (Tier 1 if JWT, fall through to Tier 2). The companion test for Tier 1 wiring lives in `tests/integration/identity-jwt-end-to-end.test.ts` (4 cross-cutting cases including cross-tenant token-forge defense).

---

## Next-engineer pickup notes

**To start using the Forms-Intake slice in a downstream slice:**

1. Cross-module callers import from `src/modules/forms-intake/index.ts` — never reach into `./internal/*`. The public surface is intentionally minimal (`formsIntakePlugin`, `getActiveDeployment`, plus the public types).
2. CCR-driven program selection: `getActiveDeployment(ctx, deploymentId)` returns the `FormDeployment` view. Downstream slices that need to know "which template version is currently being served to patients in this CCR" should call this resolver.
3. The submission-service emits `forms.submission.completed` audit at submit-time AND writes the snapshot. Downstream consumers (e.g., Subscription's draft creation, Consent's first-grant capture) can hook on the snapshot or the audit event — pick one and document the choice in the consumer's slice PRD.
4. Resume-state encryption is per-tenant-KMS-keyed via `tenant.kms_key_alias`. Tests that need to inspect resume-state contents must go through the same `lib/kms.ts` decrypt path; never read the encrypted column directly.
5. The patient's `account_id` is the `patient_id` per CDM §3.2 (Account ≡ Patient at v1.0); forms-intake does not author its own patient-side identity. Account creation is owned by the Identity slice.

**Production deployment checklist:**

1. Set `RESUME_TOKEN_SECRET` env var (≥32 chars; `openssl rand -base64 48`) — `config.ts` throws at startup if missing or too short.
2. Set `JWT_SIGNING_KEY` env var (≥32 chars) — required by Slice 2's authContextPlugin which the forms-intake handlers transitively depend on for Tier 1.
3. Ensure `ALLOW_ACTOR_HEADER_AUTH` is **UNSET** in production (Tier 2 fail-closed); set it only in dev/test.
4. KMS Master key configured per tenant; `tenant.kms_key_alias` populated in seed.
5. PostHog API key (per CCR) configured if variant traffic-split is enabled in that market.
6. Database migrations 000–017 applied in order; 008 + 009 + 010 + 011 are forms-intake hardening migrations and must land before any v1.0 patient traffic.
