# `src/modules/forms-intake/` — Forms / Intake Engine module

Implementation of **Forms / Intake Engine Slice PRD v2.1** (Canonical for development; supersedes v1.0).

This is the platform's structured-data-collection layer AND the conversion engine for DTC tenants. Per the slice PRD §1, both clinical-safety rigor (Mode 2 input quality) and conversion-optimization tooling (A/B variants, save-and-resume, abandonment recovery) must be satisfied without trade-off.

This module is **scaffold-only** at the current commit — every route handler throws `'not implemented'`, every service has a typed signature with a TODO body, and every repository shows the canonical `withTransaction` / `withTenantBoundConnection` pattern in at least one example. Subsequent commits fill in the logic incrementally without re-architecting.

## Module structure (per `src/modules/README.md` template)

```
forms-intake/
├── index.ts              ← public interface (cross-module-safe exports)
├── plugin.ts             ← Fastify plugin entry point (registered in src/app.ts)
├── routes.ts             ← Fastify route registration under /v0/forms
├── schemas.ts            ← Zod request/response schemas
├── events.ts             ← DOMAIN_EVENTS v5.2 emitters (intake_response, etc.)
├── audit.ts              ← AUDIT_EVENTS v5.2 emitters (forms_*, variant lifecycle)
├── README.md             ← (this file)
└── internal/             ← module-private; no cross-module imports allowed
    ├── types.ts          ← four-layer + variant + resume-state internal types
    ├── handlers/         ← route handler implementations (skeletons)
    │   ├── templates.ts
    │   ├── deployments.ts
    │   ├── submissions.ts
    │   ├── variants.ts
    │   └── resume.ts
    ├── services/         ← business logic (skeletons)
    │   ├── template-service.ts
    │   ├── submission-service.ts
    │   └── snapshot-service.ts
    └── repositories/     ← DB access via lib/db.ts helpers (RLS pattern shown)
        ├── template-repo.ts
        ├── submission-repo.ts
        └── snapshot-repo.ts
```

## Spec anchors (per file)

| File | Slice PRD reference | Contracts Pack reference |
|---|---|---|
| `index.ts` | §11 subscription-handoff dependencies | — (cross-module boundary per ADR-001) |
| `plugin.ts` | — | — |
| `routes.ts` | §6 builder workflows; §7 onboarding; §8 save-and-resume; §14 A/B testing; §17 subscription handoff | — (SPEC ISSUE: OpenAPI v0.2 lacks `/v0/forms/*` paths) |
| `schemas.ts` | §4 element model; §10 Mode 2 input contract | — |
| `events.ts` | §17 subscription handoff | DOMAIN_EVENTS v5.2 `intake_response` aggregate |
| `audit.ts` | §8.5 save/resume audit; §14.6 variant audit | AUDIT_EVENTS v5.2 `forms_*` actions |
| `internal/types.ts` | §4 four-layer + variant + resume state | FORMS_ENGINE v5.2 four-layer architecture |
| `internal/handlers/*` | §3 actors; §6/§7/§8/§14/§17 endpoints | — |
| `internal/services/template-service.ts` | §6 visual builder; §10 Mode 2 contract; §25.1 marketing-copy classification; §25.3 I-030 static analysis | FORMS_ENGINE v5.2 §Research consent integration |
| `internal/services/submission-service.ts` | §7 onboarding; §8 save-and-resume; §14 variant assignment; §17 subscription handoff | DOMAIN_EVENTS v5.2; INVARIANT I-019 crisis detection |
| `internal/services/snapshot-service.ts` | §4 snapshot layer; §25.4 Layer 4 CCR resolution captured in snapshot | FORMS_ENGINE v5.2 §Form versioning immutability |
| `internal/repositories/*` | §5 tenant scoping | INVARIANT I-023 (RLS); INVARIANT I-013 (immutable published versions) |

## Foundation helpers consumed

- `lib/tenant-context.ts` — `requireTenantContext(req)` resolves `tenant_id` + CCR fields per I-023 fail-closed.
- `lib/db.ts` — `withTransaction` (write paths emitting audit + events); `withTenantBoundConnection` (read paths under RLS).
- `lib/audit.ts` — `emitAudit()` + `AuditEnvelopeInput` per AUDIT_EVENTS v5.2.
- `lib/domain-events.ts` — `emitDomainEvent()` per DOMAIN_EVENTS v5.2.
- `lib/glossary.ts` — `TenantId` brand type per I-014 + Master PRD §17 brand-structure rules.
- `lib/error-envelope.ts` — global plugin handles tenant-blind ERROR_MODEL v5.1 envelopes for all `/v0/forms/*` errors per I-025.

## SPEC ISSUEs flagged in this scaffold

1. **`routes.ts` / `schemas.ts`** — OpenAPI v0.2 does not enumerate `/v0/forms/*` endpoint paths. The slice PRD v2.1 references endpoint behavior but does not pin canonical paths. Paths used here are derived from §6 builder workflows + §7/§8/§14/§17 verbs + RESTful convention; they MUST be reconciled against an OpenAPI v0.2 amendment before slice ships. (Filed per EHBG §12 SI/DSI escalation.)
2. **`audit.ts`** — AUDIT_EVENTS v5.2 does not enumerate canonical action IDs for forms-engine submission lifecycle (`forms_submission_paused`, `_resumed`, `_abandoned`, `_completed`) or for variant deploy/retire/promote (`forms_variant_deployed`, `_retired`, `_winner_promoted`). Slice PRD §8.5 / §14.6 require these to be audited (Category C / B respectively). The scaffold uses `config_change_validated` as a placeholder Category B action with a rich `detail` block carrying the intended semantics. Engineering Lead + Contracts Pack owner should add canonical action IDs in a future AUDIT_EVENTS amendment.
3. **`events.ts`** — DOMAIN_EVENTS v5.2 lists `intake_response` aggregate with `submitted/ai_evaluated/physician_reviewed/approved/declined` event types. The scaffold adds `intake_response.started` and `intake_response.abandoned` for funnel-analysis symmetry with PostHog `intake_started` / `intake_abandoned` events (Slice PRD §14.3). Engineering Lead should ratify these in DOMAIN_EVENTS or the scaffold should rename to canonical event types.
4. **`audit.ts` save-and-resume** — Slice PRD §8.5 says save/resume/expiry are audited at Category C. The scaffold emits at Category B via the placeholder action above; reconcile category once canonical action IDs land.

## Hard rules honored at scaffold time

- **I-023 three-layer tenant isolation.** Every repo function uses `withTenantBoundConnection` (reads) or `withTransaction` + `set_tenant_context` (writes). RLS policy fires at the DB layer even if the WHERE clause is wrong.
- **I-027 audit carries `tenant_id`.** All audit-emitter envelopes thread `tenantId` from the route handler's tenant context.
- **I-003 audit append-only + bare-suppression-forbidden.** No catch block in this module swallows audit emission errors. The underlying `emitAudit()` throws on failure; we re-throw.
- **I-013 published-version immutability.** Repository never exposes an `updateVersionPayload()` for published versions; the only legal mutation is `updateVersionStatus()`.
- **I-016 + I-023 same-transaction outbox.** Every `emitDomainEvent()` call is invoked under `withTransaction`. Rollback discards both the aggregate write and the outbox row.
- **I-019 crisis detection.** Free-text response handlers route through `lib/crisis-detection.ts` (consumed by `submission-service.updateResponses`).
- **I-025 tenant-blind 404.** Service layer returns `null` on tenant mismatch; the global error-envelope plugin renders the byte-identical 404 envelope.
- **I-030 forms-engine I-030 enforcement.** Six-category static analysis on `research_data_use_consent_block` runs in `template-service.publishVersion`; documented in the file header.
- **Glossary v5.2.** No use of `prescription`, `chatbot`, `customer`, or bare `Heros`. ESLint `id-denylist` rule will catch regressions.
- **ADR-001 module boundary.** Cross-module consumers use only the names re-exported from `index.ts`. Internal types and repositories are private.

## Migration coupling

`migrations/006_forms_intake.sql` is being authored in parallel by another agent. Repository column references in this scaffold assume the canonical FORMS_ENGINE v5.2 four-layer schema (Template / Version / Deployment / Submission / Snapshot + Variant + ResumeState). Once 006 lands, repository column names and types tighten to match (single integration commit; the public function signatures here do not need to change).

## Build sequence (per EHBG §10b sprint plan)

1. **(this commit)** Module scaffolding — handlers/services/repos throw `'not implemented'`.
2. **Next:** Fill in `template-service.createDraftTemplate` + `template-repo.createDraftTemplate` end-to-end with audit emission inside `withTransaction`. Tests cover the happy path + the I-023 cross-tenant rejection case.
3. **Next:** `submission-service.startSubmission` + `submission-repo.createSubmission` with PostHog variant assignment and `intake_response.started` domain event emission.
4. **Next:** `template-service.publishVersion` with the six-category I-030 static-analysis evaluator and the marketing-copy resolver.
5. **Next:** `submission-service.submitSubmission` with snapshot persistence + `intake_response.submitted` + conditional `intake_subscription_intent`.
6. **Next:** Save-and-resume end-to-end (services/repos for ResumeState).
7. **Next:** Variant lifecycle (create / promote winner) + variant-aware submission rendering.
8. **Final integration:** Pharmacy + Refill consumes `getActiveDeployment` and the `intake_subscription_intent` event from this module's public interface.
