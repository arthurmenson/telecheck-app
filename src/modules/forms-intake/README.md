# `src/modules/forms-intake/` — Forms / Intake Engine module

Implementation of **Forms / Intake Engine Slice PRD v2.1** (Canonical for development; supersedes v1.0).

This is the platform's structured-data-collection layer AND the conversion engine for DTC tenants. Per the slice PRD §1, both clinical-safety rigor (Mode 2 input quality) and conversion-optimization tooling (A/B variants, save-and-resume, abandonment recovery) must be satisfied without trade-off.

## Status: feature-complete at v0.1 (within upstream-bounded scope)

All five route handler suites are implemented end-to-end with HTTP-level
integration test coverage. Every batch has been through Codex adversarial
review with at least one needs-attention round before final approve.
Remaining stubs are upstream-blocked, documented inline as SPEC ISSUEs:

- **PostHog variant assignment** (`startSubmission`) — needs analytics adapter slice.
- **Mode 2 input contract emission** (`submitSubmission`) — needs Mode 2 slice.
- **`intake_subscription_intent` event** (`submitSubmission`) — needs Pharmacy + Refill consumer.
- **§8.2 device-anonymous patient flow** — blocked by `forms_submission.patient_id NOT NULL` in migration 006; requires migration 010 + downstream cascade.
- **`buildAndPersistSnapshot` four-layer rendering** — captures available content + nulls forward-stable upstream-pending fields.

## Module structure (per `src/modules/README.md` template)

```
forms-intake/
├── index.ts              ← public interface (cross-module-safe exports)
├── plugin.ts             ← Fastify plugin entry point (registered in src/app.ts)
├── routes.ts             ← Fastify route registration under /v0/forms
├── schemas.ts            ← Zod request/response schemas
├── events.ts             ← DOMAIN_EVENTS v5.2 emitters
├── audit.ts              ← AUDIT_EVENTS v5.2 emitters
├── README.md             ← (this file)
└── internal/             ← module-private; no cross-module imports allowed
    ├── types.ts          ← four-layer + variant + resume-state internal types
    ├── handlers/         ← route handler implementations
    │   ├── templates.ts        — admin (create/list/get/publish)
    │   ├── deployments.ts      — admin (create/get/retire)
    │   ├── submissions.ts      — patient (start/get/update+pause/submit)
    │   ├── variants.ts         — admin (create/get/promote)
    │   ├── resume.ts           — patient (read metadata + restore)
    │   └── snapshots.ts        — patient (read by submission / by id)
    ├── services/         ← business logic
    │   ├── template-service.ts
    │   ├── submission-service.ts
    │   ├── snapshot-service.ts
    │   └── resume-token.ts     — HMAC self-contained tokens
    └── repositories/     ← DB access via lib/db.ts helpers (RLS pattern)
        ├── template-repo.ts
        ├── submission-repo.ts
        └── snapshot-repo.ts
```

## Endpoints (registered under `/v0/forms` per `routes.ts`)

| Method | Path                                                 | Handler                            | Audience                    |
| ------ | ---------------------------------------------------- | ---------------------------------- | --------------------------- |
| POST   | `/templates`                                         | `createTemplateHandler`            | admin                       |
| GET    | `/templates`                                         | `listTemplatesHandler`             | admin                       |
| GET    | `/templates/:templateId`                             | `getTemplateHandler`               | admin                       |
| POST   | `/templates/:templateId/versions/:versionId/publish` | `publishVersionHandler`            | admin                       |
| POST   | `/deployments`                                       | `createDeploymentHandler`          | admin                       |
| GET    | `/deployments/:deploymentId`                         | `getDeploymentHandler`             | admin                       |
| POST   | `/deployments/:deploymentId/retire`                  | `retireDeploymentHandler`          | admin                       |
| POST   | `/submissions`                                       | `startSubmissionHandler`           | patient                     |
| GET    | `/submissions/:submissionId`                         | `getSubmissionHandler`             | patient                     |
| PATCH  | `/submissions/:submissionId/responses`               | `updateSubmissionResponsesHandler` | patient (auto-save + pause) |
| POST   | `/submissions/:submissionId/submit`                  | `submitSubmissionHandler`          | patient                     |
| GET    | `/submissions/:submissionId/snapshot`                | `getSnapshotForSubmissionHandler`  | patient                     |
| GET    | `/snapshots/:snapshotId`                             | `getSnapshotByIdHandler`           | patient                     |
| POST   | `/variants`                                          | `createVariantHandler`             | admin                       |
| GET    | `/variants/:variantId`                               | `getVariantHandler`                | admin                       |
| POST   | `/variants/:variantId/promote`                       | `promoteVariantHandler`            | admin                       |
| POST   | `/resume`                                            | `resumeSubmissionHandler`          | patient (restore)           |
| GET    | `/resume/:resumeToken`                               | `getResumeStateHandler`            | patient (metadata)          |

## Auth gates applied per handler

Every handler runs `requireTenantContext(req)` first (foundation
middleware in `src/lib/tenant-context.ts`; fails 400 closed if absent).

- **Patient surfaces** additionally call `resolvePatient(req)` /
  `resolveResumeOwnership(req)` / `resolvePatientId(req)` (per-handler-file
  shims duplicated for boundary obviousness). They read `x-patient-id`
  and (for resume) `x-device-anonymous-token`; production fail-closed
  unless `ALLOW_ACTOR_HEADER_AUTH=true`.

- **Admin surfaces** additionally call `resolveActorId(req)` (identity)
  AND `requireAdminRole(req)` (authorization) per Codex
  `deployments-http-r1` closure. The role shim is in
  `src/lib/admin-role.ts` and asserts:
  - `platform_admin` — global scope (any tenant)
  - `tenant_admin` — must carry `x-actor-admin-tenant` header matching
    the resolved tenant context (no cross-tenant administration)

The Identity & Auth slice replaces all shims with verified RBAC
permissions when it lands.

## Spec anchors (per file)

| File                                      | Slice PRD reference                                         | Contracts Pack reference                               |
| ----------------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------ |
| `index.ts`                                | §11 subscription-handoff dependencies                       | — (cross-module boundary per ADR-001)                  |
| `plugin.ts`                               | —                                                           | —                                                      |
| `routes.ts`                               | §6 / §7 / §8 / §14 / §17 endpoints                          | — (SPEC ISSUE: OpenAPI v0.2 lacks `/v0/forms/*` paths) |
| `schemas.ts`                              | §4 element model; §10 Mode 2 input contract                 | —                                                      |
| `events.ts`                               | §17 subscription handoff                                    | DOMAIN_EVENTS v5.2 `intake_response` aggregate         |
| `audit.ts`                                | §8.5 save/resume audit; §14.6 variant audit                 | AUDIT*EVENTS v5.2 `forms*\*` actions                   |
| `internal/types.ts`                       | §4 four-layer + variant + resume state                      | FORMS_ENGINE v5.2 four-layer architecture              |
| `internal/handlers/*`                     | §3 actors; §6/§7/§8/§14/§17 endpoints                       | —                                                      |
| `internal/services/template-service.ts`   | §6 visual builder; §10 Mode 2 contract; §25.1/3             | FORMS_ENGINE v5.2 §Research consent                    |
| `internal/services/submission-service.ts` | §7 onboarding; §8 save-and-resume; §14 variant; §17 handoff | DOMAIN_EVENTS v5.2; INVARIANT I-019                    |
| `internal/services/snapshot-service.ts`   | §4 snapshot layer; §25.4 CCR captured in snapshot           | FORMS_ENGINE v5.2 §Form versioning                     |
| `internal/services/resume-token.ts`       | §8.4 resume token                                           | — (HMAC self-contained per inline design)              |
| `internal/repositories/*`                 | §5 tenant scoping                                           | INVARIANT I-023 (RLS); INVARIANT I-013 (immutable)     |

## Foundation helpers consumed

- `lib/tenant-context.ts` — `requireTenantContext(req)` resolves `tenant_id` + CCR fields per I-023 fail-closed.
- `lib/admin-role.ts` — `requireAdminRole(req)` asserts admin authorization with tenant scope (Codex deployments-http-r1 closure).
- `lib/db.ts` — `withTransaction` (write paths emitting audit + events); `withTenantBoundConnection` (read paths under RLS).
- `lib/audit.ts` — `emitAudit()` + `AuditEnvelopeInput` per AUDIT_EVENTS v5.2.
- `lib/domain-events.ts` — `emitDomainEvent()` per DOMAIN_EVENTS v5.2.
- `lib/glossary.ts` — `TenantId` brand type per I-014 + Master PRD §17 brand-structure rules.
- `lib/error-envelope.ts` — global plugin handles tenant-blind ERROR_MODEL v5.1 envelopes for all `/v0/forms/*` errors per I-025.
- `lib/idempotency.ts` — `Idempotency-Key` header required on every state-changing request; tenant-scoped 4-tuple PK cache per IDEMPOTENCY v5.1.
- `lib/kms.ts` — per-tenant KMS encryption used by `pauseSubmission` for partial responses.
- `lib/logger.ts` — structured operator-visible warning on RESTORE_AMBIGUOUS_SUBMISSION + SNAPSHOT_AMBIGUOUS_FOR_SUBMISSION schema-drift sentinels.
- `lib/crisis-detection.ts` — I-019 platform-floor scanner (free-text crisis detection) called from `updateResponses` + `pauseSubmission` BEFORE merge persistence.

## SPEC ISSUEs flagged (subset; full list inline in code)

1. **`routes.ts` / `schemas.ts`** — OpenAPI v0.2 does not enumerate `/v0/forms/*` endpoint paths. The slice PRD references endpoint behavior but does not pin paths. Paths used here are derived from §6/§7/§8/§14/§17 verbs + RESTful convention; reconcile against an OpenAPI v0.2 amendment before slice ships. (Filed per EHBG §12.)
2. **`audit.ts`** — AUDIT*EVENTS v5.2 doesn't enumerate canonical action IDs for `forms_template*_`, `forms*deployment*_`, `forms*submission*_`, `forms*variant*_`, or `forms*resume_state*\*`lifecycle. Two patterns are in play pending Engineering Lead ratification: (1) the`formsAuditPlaceholder()`helper — a typed-cast helper with a closed`FormsAuditActionPlaceholder`union containing the 9 placeholder IDs (template create/publish, deployment create/retire, submission start/complete, variant create/promote/retire). The single`as AuditAction`cast is contained inside the helper so`git grep "formsAuditPlaceholder("`inventories every unratified emission across the module. (2) The legacy`config_change_validated`+`detail.intent` pattern — still used by 3 emitters (resume save/restore, variant deployed). Engineering Lead should ratify canonical IDs in a future AUDIT_EVENTS amendment so all emitters can normalize on pattern (1) and the helper can be deleted.
3. **`events.ts`** — DOMAIN_EVENTS v5.2 lists `intake_response` aggregate with five event types. The slice adds `intake_response.started` and `intake_response.abandoned` for funnel-analysis symmetry; ratify in DOMAIN_EVENTS or rename to canonical.
4. **`forms_resume_state.submission_id` missing** in migration 006; restore reconstructs the binding via `(tenant, deployment, patient, status='in_progress')` with disambiguity guarded by migration 008's partial unique index + the defensive count-check in `findInProgressSubmissionForRestore` that throws `RESTORE_AMBIGUOUS_SUBMISSION` on schema drift.
5. **`forms_submission.patient_id NOT NULL`** blocks the §8.2 device-anonymous flow end-to-end. The repo + service signatures plumb `device_anonymous_token` through for forward-compatibility, but the column constraint must relax via migration 010 (deferred).
6. **`presented_content` JSONB shape** — `buildAndPersistSnapshot` emits a forward-stable shape with `ccr_resolution_snapshot`/`variant_id`/`research_consent_text_version` set to `null` until their upstream slices land.

## Hard rules honored throughout

- **I-023 three-layer tenant isolation.** Every repo function uses `withTenantBoundConnection` (reads) or `withTransaction` + `set_tenant_context` (writes). RLS policy fires at the DB layer even if the WHERE clause is wrong.
- **I-027 audit carries `tenant_id`.** All audit-emitter envelopes thread `tenantId` from the route handler's tenant context.
- **I-003 audit append-only + bare-suppression-forbidden.** No catch block in this module swallows audit emission errors.
- **I-013 published-version immutability.** Snapshots are append-only (DB-level `REVOKE UPDATE/DELETE` on `forms_snapshot` from PUBLIC); migration 009's unique index guarantees one snapshot per submission.
- **I-016 + I-023 same-transaction outbox.** Every `emitDomainEvent()` call is invoked under `withTransaction`. Rollback discards both the aggregate write and the outbox row. Pause atomically wraps merge UPDATE + KMS encrypt + resume_state INSERT + audit + outbox in one tx.
- **I-019 crisis detection.** Iterative-stack scanner with explicit depth (64) + node (50_000) budgets; runs over the FULL merged response set on pause (not just the patch) so prior-content crisis can't slip through; emits Category A audit + 409 envelope on detection.
- **I-025 tenant-blind 404 / 400 envelopes.** Service layer returns `null` on every failure mode (cross-tenant, cross-patient, missing); the global error-envelope plugin renders byte-identical envelopes regardless of which gate tripped.
- **Master PRD v1.10 §17 patient surface.** Patient-facing handlers project to `PatientFormSubmissionView` / `PatientFormSnapshotView` / `ResumeStateMetadata` types that omit `tenant_id`; HTTP tests assert raw-body and recursive-key absence.
- **Glossary v5.2.** No use of `prescription`, `chatbot`, `customer`, or bare `Heros`. ESLint `id-denylist` rule will catch regressions.
- **ADR-001 module boundary.** Cross-module consumers use only the names re-exported from `index.ts`. Internal types and repositories are private.

## Migrations

- **006** — `forms_template`, `forms_deployment`, `forms_submission`, `forms_snapshot`, `forms_variant`, `forms_resume_state` (canonical FORMS_ENGINE v5.2 four-layer schema + variant + resume-state).
- **008** — Partial unique index `uq_forms_submission_one_in_progress_per_tuple` on `(tenant_id, deployment_id, patient_id) WHERE status='in_progress' AND deleted_at IS NULL`. Disambiguates the resume-restore tuple lookup. Includes preflight DO block that fails with a remediation query if existing duplicates would violate.
- **009** — Unique index `uq_forms_snapshot_one_per_submission` on `(tenant_id, submission_id)`. Snapshots are append-only and one-per-submission; the constraint guarantees the canonical view per I-013 immutability analog. Includes preflight DO block.

## Test coverage

Service-layer tests (one file per major surface) cover state machines, sentinel mappings, ownership checks, audit chain emission, and outbox events:

- `forms-intake-admin.test.ts` — template + deployment admin paths
- `forms-intake-publish.test.ts` — publish state machine (with FORMS_PUBLISH_GATES_BYPASS)
- `forms-intake-submission.test.ts` — submission lifecycle (start/get/update/submit + Codex r0/r1/r2 regressions)
- `forms-intake-variants.test.ts` — variant CRUD + promote (with deployment-FOR-UPDATE concurrency tests)
- `forms-intake-pause.test.ts` — save-and-resume pause path (KMS encrypt, atomic tx, crisis-on-merged)
- `forms-intake-restore.test.ts` — save-and-resume restore (token verify, in-progress lookup, replay protection)
- `forms-intake-resume.test.ts` — resume-state metadata read

HTTP-level tests (one file per handler suite, all using buildApp + Fastify `inject`):

- `forms-intake-templates-http.test.ts` — POST/GET/list/publish (incl. publish bypass discipline + 403 admin-role gate)
- `forms-intake-deployments-http.test.ts` — POST/GET/retire (incl. cross-tenant 404 via Ghana host)
- `forms-intake-submissions-http.test.ts` — POST start / GET / PATCH update+pause / POST submit (15 cases incl. crisis 409)
- `forms-intake-variants-http.test.ts` — POST/GET/promote (incl. cross-tenant tenant_admin 403, platform_admin global)
- `forms-intake-resume-http.test.ts` — GET metadata / POST restore (incl. tampered token, replay 404, normalized envelope equality)
- `forms-intake-snapshot-http.test.ts` — GET by submission / GET by id (incl. recursive tenant_id key scan)

Foundation infrastructure tests (`tests/integration/`):

- `tenant-context-http.test.ts` — host → tenant resolution (US/Ghana/localhost), allowlist `/health`, fail-closed
- `error-envelope-http.test.ts` — ERROR_MODEL v5.1 conformance, I-025 cross-tenant blindness, trace_id uniqueness
- `idempotency-http.test.ts` — missing key 400, replay (with side-effect verification), body mismatch 409, 4-tuple PK independence

Every state-changing HTTP test passes a fresh `Idempotency-Key` via the per-file `injectWithIdempotency` wrapper (auto-injects ULID for POST/PATCH/PUT/DELETE).
