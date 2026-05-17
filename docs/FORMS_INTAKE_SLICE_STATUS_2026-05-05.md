# Forms / Intake Engine Slice — Implementation Status

**Date:** 2026-05-05 (Sprint 33-34 amendment 2026-05-08; **publish-gate-disclosure amendment 2026-05-17 — see top section**)
**Author:** Autonomous turn (Claude Sonnet 4.5)
**Status (2026-05-17):** **COMPLETE-EXCEPT-PUBLISH-GATES** — 11 HTTP surfaces ship + pass tests; publish route is fail-closed in non-test environments via `FORMS_PUBLISH_GATES_BYPASS='unsafe-test-only'` sentinel pending SI-011 IMPL (production-deploy blocker)
**Final commit:** `4ab2663` (forms-intake variant + resume_restored domain events wired at `ba2bc41`; SI-003 raised at `f2a16f3`; test-side flip at `4ab2663`; original Slice 1 stable since pre-`d2b6ea9`; JWT migration through `692206e`; status doc landed at `39a0ede`)
**Sprint 33-34 amendment final commit:** `dc06541` (PR #44 PR-F2 forms-intake migration + PR #49 audit-dedupe wiring + PR #48 cleanup-sweep)
**CI status:** ✅ Green (test path; publish gates exercise the bypass sentinel)

---

## 2026-05-17 publish-gate-disclosure amendment (PR #173 per-slice STATUS refresh)

**Trigger:** PR #172 Sibling-Doc Cross-Validation Audit 2026-05-17 §2.2 surfaced that this STATUS doc claims `implementation-complete on its v2.1 surface` without disclosing the `FORMS_PUBLISH_GATES_BYPASS='unsafe-test-only'` sentinel that fails-closed the publish path in non-test environments OR the SI-011 publish-time governance gates that need 4 IMPL-readiness gates to ratify. The production-deploy blocker was hidden behind the `implementation-complete` framing. This amendment makes the publish-gate state explicit without rewriting the existing Sprint 33-34 amendment content below.

### Current publish-gate state

`templateService.publishVersion()` at `src/modules/forms-intake/internal/services/template-service.ts` documents FOUR pre-publish governance gates that MUST run before a draft template can be promoted to `published` status:

1. **I-015 L3 dual-control** — Tenant Clinical Lead approval recorded for any L3 (eligibility) edits; the clinician who authored an eligibility-logic change MUST NOT be the same operator who authorizes publish.
2. **I-030 six-category static analysis** — reject publish if ANY of {branching, visibility, validation, eligibility/triage, pricing/commerce, outcome messaging} depends on the `research_consent_status` PHI field per FORMS_ENGINE v5.2 + Slice PRD §25.3.
3. **L4 MarketingCopy approval** — all molecule-level L1 elements referenced in `presentation_content` MUST resolve to `MarketingCopy` rows in `status='approved'`.
4. **Mode 2 input contract conformance** — any Mode 2 case-prep workflow integration MUST conform to the contract validator per Slice PRD §10.

At HEAD, the publish path fails closed in production via the `FORMS_PUBLISH_GATES_BYPASS='unsafe-test-only'` sentinel. The bypass is intentionally hostile-named so a routine env-config typo cannot accidentally open the gate. But the gates aren't wired:

- Production cannot legitimately publish without setting the bypass
- Setting the bypass = ALL FOUR gates skipped (test-only posture)
- Neither posture is acceptable beyond v1.0 pilot

### SI-011 IMPL-gating

**[SI-011 Forms-Intake publish-time governance gates](./SI-011-Forms-Publish-Governance-Gates.md)** ratifies the 4 publish-gate audit events. SI-011's downstream IMPL has 4 IMPL-readiness gates per its source file:

- **SI-010** Session Actor Context DB Binding (for the L3 dual-control's `current_actor_role()` helper)
- **SI-008** AiWorkflowExecution CDM (for the L2 Mode 2 input contract conformance)
- **MarketingCopy CDM §4 row-shape ratification** (for the L4 MarketingCopy approval gate; per Slice PRD §25.1; NOT a separate SI today — chair option (a) ratifies in-scope of SI-011 OR option (b) schedules as sibling readiness-gate SI)
- **FORMS_ENGINE §I-030 detection-rule canonicalization** (for the six-category static analysis; per Slice PRD §25.3; same scope/scheduling decision needed)

Until SI-011 + its 4 IMPL-readiness gates all ratify (Q2 2026 Ratifier Ceremony per Ratifier Ceremony Agenda + Per-Track SI Navigation), the production-deploy gate replacement work cannot land. SI-011 targets per its source file: `P-021 (umbrella) + P-022 through P-025 (per sub-SI a/b/c/d)`.

### What this amendment intentionally DOES NOT change

- The Sprint 33-34 amendment + the existing Summary below + all body sections are PRESERVED VERBATIM (per the established Sprint-amendment layering pattern in this repo).
- The phrase `implementation-complete on its v2.1 surface` in the existing Summary remains as-is — this amendment surfaces the publish-gate disclosure at the TOP so a reader sees it before the Summary, but the historical Summary text is left intact for traceability.

### Spec references for the 2026-05-17 amendment

- `docs/Sibling-Doc-Cross-Validation-Audit-2026-05-17.md` §2.2 (the audit that surfaced this STATUS doc as missing publish-gate disclosure)
- `docs/Implementation-State-Audit-2026-05-17.md` §1 (Forms-Intake module reclassification COMPLETE → COMPLETE-EXCEPT-PUBLISH-GATES)
- `docs/Per-Track-SI-Navigation-2026-05-17.md` §1 Track 3 (Forms-Intake publish-gate IMPL row)
- `docs/SI-011-Forms-Publish-Governance-Gates.md` (the ratifier-blocking SI)
- `src/modules/forms-intake/internal/services/template-service.ts` `publishVersion()` (the TODO-deferred gate documentation)

---

## Sprint 33-34 amendment (2026-05-08)

The Forms-Intake slice received the most security-critical migration in the SI-006 reserve-then-execute cycle because it owns the **I-019 platform-floor crisis-detection gate**. **PR #44 (PR-F2, 5 Codex rounds, 4 HIGH + 1 MEDIUM closures)** migrated 10 state-mutating handlers and rebuilt the Category A audit-emission pattern.

### Migrated handlers

Verified against `src/modules/forms-intake/internal/handlers/*.ts` and the PR #48 cleanup-sweep diff per-file deletion counts (`a02f101`):

| Handler file     | Handlers migrated                                                                                                                                                   | Endpoints                                                                                                     |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `templates.ts`   | `createTemplateHandler`, `publishVersionHandler`                                                                                                                    | POST `/templates` + POST `/templates/:templateId/versions/:versionId/publish`                                 |
| `variants.ts`    | `createVariantHandler`, `promoteVariantHandler`                                                                                                                     | POST `/variants` + POST `/variants/:variantId/promote`                                                        |
| `deployments.ts` | `createDeploymentHandler`, `retireDeploymentHandler`                                                                                                                | POST `/deployments` + POST `/deployments/:deploymentId/retire`                                                |
| `submissions.ts` | `startSubmissionHandler`, **`updateSubmissionResponsesHandler`** (the PATCH handler that runs the I-019 crisis gate via `runCrisisGate`), `submitSubmissionHandler` | POST `/submissions` + PATCH `/submissions/:submissionId/responses` + POST `/submissions/:submissionId/submit` |
| `resume.ts`      | `resumeSubmissionHandler`                                                                                                                                           | POST `/resume`                                                                                                |

### Service-layer change: `externalTx` threading

`template-service.ts:createDeployment` and `submission-repo.ts:createActiveDeployment` gained an optional `externalTx?: DbTransaction` parameter so the handler-owned transaction is reused end-to-end (reservation INSERT + business mutation + completion UPDATE all atomic on the same connection — required for SAVEPOINT idempotency_reserve discipline). When `externalTx` is undefined the service still opens its own transaction (backward-compatible path preserved).

### `runCrisisGate` rebuilt — 3-phase audit-durability hardening

The crisis-detection gate at `submission-service.ts:runCrisisGate` went through 3 distinct hardenings during the cycle, each closing a Codex HIGH:

1. **PR-F2 r2 — Independent-tx Category A audit emission.** Pre-PR-F2 the gate forwarded `externalTx` (the handler's tx) to `emitCrisisDetectionTrigger`. When `runCrisisGate` then threw `CRISIS_DETECTED`, the handler-owned tx rolled back — and the audit rolled back with it. **Silent loss of Category A escalation record violates I-019 + I-003 durability.** Fix: drop the `externalTx` parameter; emit on a fresh `withTransaction(...)` (no `externalTx`). The audit commits independently of business outcome.
2. **PR-F2 r3 — Return-cached-vs-throw for sentinel paths.** With audit emission durably independent, the next failure mode was: a throw inside `withIdempotency` body callback rolls back the reservation; client retry re-runs the gate, emits a SECOND audit. Fix: `submissions.ts` `updateSubmissionResponsesHandler` (which runs `runCrisisGate` for both auto-save and pause-mode patches) and `submitSubmissionHandler` now **return** `{ status: 4xx, view: errorEnvelope }` from the body callback for `CRISIS_DETECTED` / `RESPONSE_PAYLOAD_TOO_LARGE` / `isHandledSentinel` instead of throwing httpErrors. Cached 4xx replays from cache; no re-execution; exactly-once preserved.
3. **PR #49 — `audit_dedupe_markers` cross-cutting infra.** Even with #1 + #2, a process crash between the independent-tx audit commit and the idempotency completion UPDATE leaves the audit durable but the reservation rolled back — a retry under the same Idempotency-Key re-runs the gate. Fix: `runCrisisGate` accepts an optional `idempotencyCtx` parameter; when supplied (HTTP-handler path), claims a slot via `claimAuditDedupeSlot(client, identity)` BEFORE the audit emit. The 6-tuple identity hashes `(tenant_id || idempotency_key || endpoint || actor_id || bodyHash || auditAction)` so cross-tenant + different-body + different-action requests get distinct dedupe keys. If the slot is already claimed (a prior attempt already emitted), skip the emit; the throw still fires.

### Distinct audit_action labels for distinct emit sites

`pauseSubmission` runs `runCrisisGate` BOTH for the patch-side scan AND for the merged-set scan inside the atomic tx. Each site uses a distinct `auditAction` label (`'crisis_detection_trigger'` vs `'crisis_detection_trigger.merged_set'`) so a single request triggering BOTH (rare — would require a payload that's individually clean but crisis-positive only after merging with prior submission state) emits BOTH audits exactly once each, not de-duped against each other.

### `withIdempotentExecution` body-callback widened

PR #49 widened the helper's body-callback signature from `(tx)` to `(tx, idempotencyCtx)` so handlers can forward the ctx into service-layer audit-dedupe claims without re-computing. Backward-compat: existing callers that don't reference the second parameter continued to typecheck.

### Cleanup-sweep impact (PR #48)

`markIdempotencyManagedByHandler(req)` call sites deleted (verified against `git show a02f101`):

- `deployments.ts`: 2 calls (`createDeploymentHandler`, `retireDeploymentHandler`)
- `resume.ts`: 1 call (`resumeSubmissionHandler`)
- `submissions.ts`: 3 calls (`startSubmissionHandler`, `updateSubmissionResponsesHandler`, `submitSubmissionHandler`)
- `templates.ts`: 2 calls (`createTemplateHandler`, `publishVersionHandler`)
- `variants.ts`: 2 calls (`createVariantHandler`, `promoteVariantHandler`)

Total: 10 call sites + 5 import-line deletions. Functionally a no-op since PR #47 (PR-E) had already removed the legacy onSend hook the flag controlled.

### Test impact

- Existing forms-intake-{templates,variants,deployments,submissions,resume,governance,events,admin,pause,restore,publish}-http tests continued to pass.
- New: `tests/integration/audit-dedupe.test.ts` (PR #49) — 7 groups covering claim semantics + auditAction discrimination + cross-tenant isolation + purge-expired + bodyHash + post-cache-expiry-different-body + computeAuditDedupeKey collision safety.
- Documented limitation: tests for non-empty consult_events PHI projection in adjacent slices (e.g., async-consult) wait until SI-001 forms_submission integration enables driving cross-slice transitions cleanly from HTTP integration tests.

### Spec references for the amendment

- `docs/SI-006-Idempotency-Reserve-Then-Execute-Redesign.md` v0.3 (Implementation Closure section)
- `docs/PROJECT_CONVENTIONS.md` r5 §3.7 / §3.8 / §3.9 (reserve-then-execute + return-cached-vs-throw + independent-tx Category A + dedupe markers)
- `docs/BUILD_VS_SPEC_TRACEABILITY_MATRIX.md` r5 §1 I-019 row + §2 Forms-Intake slice row + §2 audit-dedupe.ts library row + §3 Forms submission lifecycle row
- `migrations/022_audit_dedupe_markers.sql` (new table + rollback)
- `src/lib/audit-dedupe.ts` (new cross-cutting helper)

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

### HTTP API surface — 18 routes mounted under `/v0/forms`

(Codex R2 M1 closure 2026-05-17: route count corrected from 19 → 18 + the nonexistent `GET /health` row removed. The Forms-Intake plugin does NOT register a module health probe per `src/modules/forms-intake/routes.ts`; the 18-route count is verified by `grep -E "app\.(get|post|put|patch|delete)" src/modules/forms-intake/routes.ts | wc -l`.)

| Method | Path                                                 | Purpose                                                                 |
| ------ | ---------------------------------------------------- | ----------------------------------------------------------------------- |
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
- **I-025** — tenant-blind error envelopes: every 4xx envelope across the 18 routes carries no tenant identifier or DBA substring (verified by the canonical `tests/integration/error-envelope-http.test.ts`, which targets the forms-intake surface specifically).
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

| Item                                                                     | Status                                                                                                                                                                                                                                                                                  |
| ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Domain-event emission alongside audit (forms-intake outbox)              | ✅ Delivered (12 lifecycle events in `events.ts` wired across template-service + submission-service same-tx outbox; SI-003 raised at `f2a16f3` for the placeholder event-type strings; `forms_resume_state.restored` round-trip asserted at forms-intake-restore.test.ts §"happy path") |
| Forms-intake header-shim Tier 2 retirement                               | Deferred — pending migration of every forms-intake test to JWT-bearing requests                                                                                                                                                                                                         |
| AUDIT_EVENTS v5.2 ratification of forms-intake action IDs                | Open SPEC ISSUE — emitted via `formsIntakeAuditPlaceholder()` pattern; same approach inherited by Identity (`identityAuditPlaceholder`) and Consent (`consentAuditPlaceholder`)                                                                                                         |
| Crisis-detection escalation routing (operator alert → on-call clinician) | Deferred — `crisis_detection.trigger` audit is emitted; the consumer (alerting + on-call routing) lands with the Admin Backend slice and the on-call rotation infra                                                                                                                     |
| Multi-language template support                                          | Schema supports a `locale` column; runtime resolution + UX deferred until per-jurisdiction Market Rollout Cockpit work                                                                                                                                                                  |
| Variant traffic-split runtime evaluation                                 | `forms_variant.assignment_rule_jsonb` accepts the rule shape; runtime variant-evaluator lands with the Acquisition & Engagement slice (PostHog A/B integration per EHBG §10b Sprint 3 detail)                                                                                           |
| Codex review §1c rest-spread "false-confidence" finding                  | Deferred indefinitely — current FormSnapshot / FormSubmission fields are all patient-safe; the rest-spread pattern is preserved for future-safety but the explicit allowlist refactor is on hold                                                                                        |

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
