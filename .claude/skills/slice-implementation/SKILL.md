---
name: slice-implementation
description: Read a slice PRD end-to-end and produce the corresponding code module under src/modules/<name>/ with index.ts, routes.ts, internal/, schemas.ts, events.ts, audit.ts, and README.md, plus wire registration in src/app.ts. Use when starting a new slice (Forms/Intake, Pharmacy, Refill, Admin Backend, AI Clinical Assistant, etc.) or substantially extending an existing one.
when_to_invoke: Beginning implementation of a slice listed in EHBG §10b sprint plan, or when a slice's scope materially expands and a new module structure is needed.
tools_used: Read, Edit, Write, Grep, Glob
---

## When to use this skill

When you are about to write the first code for a new module that maps to a slice PRD. Examples:
- starting Forms/Intake Engine v2.1 (Sprint 1 per EHBG §10b — first slice)
- adding a new module like AI Clinical Assistant, Pharmacy + Refill, Research Data Module
- materially extending an existing module that has outgrown its initial structure

If you are adding **one endpoint** to an existing module, use the `tenant-scoped-endpoint` skill instead — this skill is for module-level scaffolding.

## Read first (in this order)

Set `${SPEC}` = `${TELECHECK_SPEC_PATH:-../telecheckONE/Telecheck Master Bundle FINAL US REGION BASELINE}`.

1. **The slice PRD** — `${SPEC}/Telecheck_<Slice>_Slice_PRD_v*.md` (read fully, not just the headers)
2. **Tenant Threading Addendum §3.X** if the slice is at v1.0 — `${SPEC}/Telecheck_Tenant_Threading_Addendum_v1_0.md`
3. **Relevant ADRs** — start with ADR-023 (multi-tenancy), ADR-024 (CCR), ADR-001 (modular monolith). Add ADR-029 if AI workload is involved; ADR-027/028 for marketing/research; ADR-026 for region/DR.
4. **State Machines v1.1** for every entity the slice touches
5. **OpenAPI v0.2** for every endpoint listed in the slice
6. **CDM v1.2** for every entity schema the slice references
7. **Contracts Pack v5.2** files cited by the slice — minimum: INVARIANTS, AUDIT_EVENTS, DOMAIN_EVENTS, GLOSSARY, TYPES, ERROR_MODEL (v5.1), IDEMPOTENCY (v5.1)
8. **RBAC v1.1** for every role mentioned in the slice
9. **Design Implementation Contract v1.1** if the slice has UI surfaces; Patient mock v7 is the binding visual reference

## Workflow

1. **Confirm canonicality.** Open `${SPEC}/Telecheck_Active_Document_Index_v1_0.md` and confirm the slice PRD version you are reading is in the Active section, not Superseded.
2. **List the deliverables.** From the slice PRD, extract:
   - Entities (CDM v1.2 references)
   - Endpoints (OpenAPI v0.2 references)
   - State machines (State Machines v1.1 references)
   - Audit actions (canonical action IDs from AUDIT_EVENTS v5.2)
   - Domain events (DOMAIN_EVENTS v5.2)
   - RBAC roles + permissions
   - Migrations needed (per CDM v1.2 — engineering implements per CDM, does NOT author new schema)
3. **Module scaffolding.** Create:

   ```
   src/modules/<name>/
   ├── index.ts            ← public interface; exports the registration function + types
   ├── routes.ts           ← Fastify route registration; one handler per endpoint
   ├── schemas.ts          ← Zod / Fastify request+response schemas (referencing OpenAPI v0.2)
   ├── events.ts           ← domain event types + publishers (DOMAIN_EVENTS v5.2 envelope)
   ├── audit.ts            ← audit emission helpers for this module's actions
   ├── internal/           ← module-private code; not exported
   │   ├── transitions/    ← state-machine transition functions
   │   ├── queries/        ← DB queries via withTenantContext()
   │   └── ...
   └── README.md           ← module overview + slice PRD reference + module map
   ```

4. **Wire registration in `src/app.ts`.** Each module exports a `register<Module>()` Fastify plugin that the app shell calls. Register order matters — modules with cross-module event subscriptions register after their producers.
5. **Implement migrations** for the entities. Use the `migration-with-rls` skill.
6. **Implement state machines.** Use the `state-machine-transition` skill for each transition.
7. **Implement endpoints.** Use the `tenant-scoped-endpoint` skill for each route.
8. **Wire audit emission.** Use the `audit-emission` skill — the module's `audit.ts` is the central place where canonical action IDs live.
9. **Wire notifications** if the slice fires patient/clinician notifications. Use the `notification-emission` skill.
10. **Tests.** Per `tests/` layout convention: unit tests alongside code (`<file>.test.ts`); slice-level integration tests under `tests/integration/<slice>/`; tenant-isolation tests under `tests/invariants/`.
11. **README.md for the module.** ~30-50 lines: slice PRD reference, entity list with CDM citations, endpoint list with OpenAPI citations, state machine list, audit action ID list, RBAC roles required.

## Hard rules

- **Engineering does NOT author new schema.** Implement per CDM v1.2. If CDM is missing your entity, flag via §12 SI/DSI escalation; do not invent.
- **Cross-module data access is via the public interface only.** No direct DB queries across module boundaries (ADR-001 modular monolith). Module A consumes Module B's events or calls Module B's exported functions; no `prisma.moduleB_table.findMany` from inside Module A.
- **Honor the source-of-truth hierarchy.** Slice vs CDM → CDM wins. Slice vs OpenAPI → OpenAPI wins. Slice vs State Machines → State Machines wins. Open a Spec Issue (§12) on any conflict.
- **Glossary terms are canonical.** `medication_request`, `tenant`, `Mode 1`/`Mode 2`. Forbidden aliases listed in GLOSSARY v5.2.
- **Brand structure (Master PRD v1.10 §17).** Internal/B2B surfaces (admin, audit, code, schema) use `tenant.id` (`Telecheck-{country}`). Patient-facing surfaces use `tenant.consumer_dba` (`Heros Health` / `Heros Health Ghana`).

## Common mistakes

- **Skipping the Tenant Threading Addendum** because the slice PRD already mentions tenant context. The Addendum is more authoritative for v1.0 slice tenant threading specifics.
- **Authoring new fields on an entity** because the slice PRD describes a UI behavior that needs them. CDM is the source. Engineering escalates via §12 instead of editing CDM.
- **Implementing a "shortcut" path that skips the state machine.** Every state mutation goes through a transition function.
- **Cross-module raw DB access** because "it's faster than emitting an event and consuming it." ADR-001 forbids this. Refactor through the public interface.
- **Reading a Superseded slice PRD version.** Always check Active Document Index first.

## Reporting

- **Slice:** name + version + canonical PRD path
- **Module:** path under `src/modules/`
- **Entities:** list with CDM v1.2 §X.Y citations
- **Endpoints:** list with OpenAPI v0.2 §X.Y citations
- **State machines:** list with State Machines v1.1 §X.Y citations
- **Audit actions:** canonical action IDs implemented
- **Domain events:** event types implemented
- **RBAC roles:** roles wired
- **Migrations:** list of migration files
- **Tests:** unit + integration + invariant
- **Spec issues filed:** any §12 escalations opened
