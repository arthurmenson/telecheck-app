---
name: tenant-scoped-endpoint
description: Scaffold a tenant-scoped Fastify route with the correct middleware ordering, RLS-friendly query construction via withTenantContext(), audit emission with sentinel-handled envelope, and tenant-blind error responses per I-025. Use whenever you add or modify any HTTP endpoint that touches PHI or any tenant-scoped entity.
when_to_invoke: Adding or modifying a Fastify route handler for any tenant-scoped resource (which is essentially every clinical, scheduling, pharmacy, billing, AI, or research endpoint per CDM v1.2).
tools_used: Read, Edit, Write, Grep, Glob
---

## When to use this skill

Any new or modified Fastify route handler that:
- reads or writes a tenant-scoped entity (per CDM v1.2 §4 — almost everything)
- accepts a tenant identifier in the path (`/tenants/{tenant_id}/...`)
- emits an audit or domain event
- returns a resource that must not leak across tenants

If you are adding a public, tenant-blind endpoint (e.g., health probe, status page) you do **not** need this skill — but flag the endpoint in the route file with a comment explaining why no tenant context is required.

## Read first

Set `${SPEC}` = `${TELECHECK_SPEC_PATH:-../telecheckONE/Telecheck Master Bundle FINAL US REGION BASELINE}`.

1. `${SPEC}/Telecheck_Tenant_Threading_Addendum_v1_0.md` §3.X for the slice you are implementing
2. `${SPEC}/Telecheck_Contracts_Pack_v5_00_INVARIANTS.md` — I-023 (three-layer isolation), I-024 (break-glass), I-025 (tenant-blind errors), I-027 (audit envelope tenant_id)
3. `${SPEC}/Telecheck_OpenAPI_v0_2.md` for the endpoint contract
4. `${SPEC}/Telecheck_Contracts_Pack_v5_00_AUDIT_EVENTS.md` (v5.2) for the audit envelope shape
5. `${SPEC}/Telecheck_Contracts_Pack_v5_00_ERROR_MODEL.md` (v5.1) for the tenant-blind error envelope
6. `${SPEC}/Telecheck_RBAC_Permissions_Matrix_v1_1.md` for the role check
7. ADR-029 + `${SPEC}/Telecheck_Contracts_Pack_v5_00_WORKLOAD_TAXONOMY.md` if the endpoint emits AI content

## Workflow

1. **Locate the endpoint in OpenAPI v0.2.** Confirm path, method, request schema, response schema, and required RBAC scope.
2. **Confirm tenant scoping.** Path SHOULD be `/tenants/{tenant_id}/...`. If the OpenAPI spec disagrees with the slice PRD, OpenAPI wins — see source-of-truth hierarchy.
3. **Add the route under `src/modules/<module>/routes.ts`.** One route per file is fine for complex handlers; co-locate with internal logic in `internal/`.
4. **Middleware order (critical):**
   1. authn (resolves the actor's identity)
   2. tenant-context middleware (resolves `req.tenantContext` from the path param + actor's tenant memberships; rejects with **I-025-compliant tenant-blind 404** if actor is not a member)
   3. rbac check (verifies actor's role permits the action per RBAC v1.1)
   4. request schema validation (Zod / Fastify schema)
   5. handler
6. **Query construction.** Wrap every DB call in `withTenantContext(req.tenantContext, async (db) => { ... })`. The helper sets `SET LOCAL app.tenant_id = $1` so RLS policies match. Do not pass `tenant_id` as a where clause — let RLS enforce it. Belt + suspenders: app-layer middleware verifies the result row's `tenant_id` matches `req.tenantContext.tenantId` before serializing.
7. **Audit emission.** On every state-changing operation, emit an audit event via `audit.emit({ ... })`. Envelope MUST include: `tenant_id`, `actor_id`, `action`, `resource_type`, `resource_id`, `outcome` (`success` | `denied` | `failed`), `correlation_id`, `request_id`, `timestamp`. If the action involves AI, also include `ai_workload_type` (per WORKLOAD_TAXONOMY) and `autonomy_level` — apply the **sentinel** `none` (or `unknown` for resolution-failure cases) when the AI workload is null/unknown/reserved per Codex Round-4 envelope-population rule. **Bare suppression on rejection is forbidden per I-003** — denied paths still emit `outcome: "denied"`.
8. **Error envelope.** Use `replyWithError(res, errorCode)` from `src/lib/errors.ts`. The helper produces the canonical tenant-blind shape: `{ error: { code, message, request_id, correlation_id } }`. Never include `tenant_id`, internal IDs from other tenants, or row-existence hints in the message.
9. **Test.** Write tests covering: (a) happy path; (b) actor in a different tenant gets 404 (NOT 403, NOT 401, NOT a body that says "you don't have access to this tenant"); (c) actor with insufficient role gets 403 + audit `denied`; (d) RLS bypass attempt (synthetic — set `app.tenant_id` to a different value via raw SQL in the test) produces zero rows.

## Hard rules

- **I-023:** every PHI-touching query goes through `withTenantContext()`. No direct `prisma.$queryRaw` without it.
- **I-024:** break-glass cross-tenant access requires the `breakGlass()` helper, which writes a `break_glass.opened` audit event with justification before the cross-tenant query runs.
- **I-025:** error envelope is tenant-blind. 404 for "doesn't exist" and "exists but not in your tenant" are indistinguishable.
- **I-027:** audit envelope always carries `tenant_id`. There is no platform-scoped audit class for tenant-scoped resources.
- **ADR-029 + I-012:** if the endpoint executes a prescribing/refill/medication-order action, enforce the **three-clause reject-unless rule** (`autonomy_level == "action_with_confirm"` AND explicit clinician confirmation in audit chain AND confirming actor RBAC-authorized) before commit; on rejection emit `<action_class>.execution_rejected`.
- **Glossary:** use `medication_request`, never `prescription`. Use `tenant`, never `customer`. Per `Telecheck_Contracts_Pack_v5_00_GLOSSARY.md`.
- **Brand structure (Master PRD v1.10 §17):** never render `tenant.id` to a patient — use `tenant.consumer_dba` for patient-facing strings.

## Common mistakes

- **Adding `WHERE tenant_id = ?` manually instead of relying on RLS.** This works but defeats the layered defense — RLS lint will flag it as suspicious. Use `withTenantContext()`.
- **Returning 403 instead of 404** when the actor is in a different tenant. Leaks existence. I-025 violation.
- **Emitting audit only on success.** Denied/failed paths must also emit audit (I-003 bare-suppression-forbidden discipline).
- **Putting tenant context resolution inside the handler.** It must run as middleware so RBAC and validation can use `req.tenantContext`.
- **Using `console.log(req.body)` in handlers.** Logs PHI. Use `req.log.info({ event: "..." }, "...")` with structured fields and rely on the redaction config.
- **Forgetting `ai_workload_type` on AI-emitting endpoints.** Even when "no AI was involved" you may still need to populate the field with the `none` sentinel — check WORKLOAD_TAXONOMY v5.2.

## Reporting

When done, report:

- **Endpoint(s) added:** method + path + module
- **Spec citations:** OpenAPI v0.2 §X.Y; slice PRD §Z; Tenant Threading Addendum §3.X; ADRs invoked
- **Audit actions emitted:** canonical action IDs (e.g., `appointment.scheduled`, `medication_request.execution_rejected`)
- **Tests added:** happy path, cross-tenant 404, role-denied, RLS bypass attempt
- **Open questions / spec issues:** anything the slice PRD and OpenAPI disagree on (flag via §12 SI/DSI escalation, do not silently fork)
