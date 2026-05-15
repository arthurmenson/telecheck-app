# Phase 2 admin-role JWT widening — scope + deferred findings

This doc tracks deferred Codex pre-ratification findings explicitly
scoped out of PR #140 (the type-system + JWT path widening), with
clear rationale for each deferral and the follow-on PR that closes it.

## Phase 2 PR #140 scope (in-scope)

- AccessTokenRole enum widening: `{patient, clinician}` → `{patient, clinician, tenant_admin, platform_admin}`
- `admin_tenant_binding` claim + role/binding consistency rules at issue + verify
- authContextPlugin: tenant-scope semantics per role + platform_admin global scope with KNOWN_TENANT_IDS home-tenant validation + case-insensitive Bearer parsing
- `bearerTokenPresented` flag for fail-closed when JWT presented but rejected
- Role-gate helpers: `requireTenantAdminActorContext` + `requirePlatformAdminActorContext` + `requireAdminActorContext`
- ActorContext: `adminTenantBinding` + `adminHomeTenantId`
- Tier-1 JWT admin authorization in `requireAdminRole` (legacy header shim ONLY when no JWT presented)
- Test helper jwt-fixtures: `adminTenantBinding` param + admin role minting

## In-PR closures (5 HIGH)

| Round | Finding | Closure |
|---|---|---|
| R1 | JWT path fall-through to forged x-actor-roles header | Fail-closed when `req.actorContext` present (commit `8401420`) |
| R2 | Presented-but-rejected JWT can elevate via header shim | `bearerTokenPresented` flag set BEFORE verification (commit `254040f`) |
| R3 | platform_admin JWTs tenant-pinned (defeated global scope) | Skip tenant-equality check for platform_admin; populate `tenantId` from resolved tenant; add `adminHomeTenantId` (commit `d52f5f4`) |
| R4 HIGH-2 | platform_admin home tenant accepted any string | KNOWN_TENANT_IDS set; validate `claims.tenant_id ∈ KNOWN_TENANT_IDS` for platform_admin (commit `b970c58`) |
| R5 HIGH-1 | Lowercase `bearer` skipped JWT rejection flag | Case-insensitive scheme parsing per RFC 7235 §2.1 (commit `41658de`) |

## Deferred findings (out-of-scope; named follow-on PRs)

### F-1 — Production admin minting (R1 MEDIUM / R4 HIGH-1)

`src/modules/identity/internal/services/session-service.ts` cannot mint admin JWTs — only test fixtures can. The session-service maps AccountType → AccessTokenRole, and AccountType doesn't include admin types yet.

**Why deferred:** Phase 2's mission is the JWT type-system + verify path. The production minting path requires:
- AccountType enum widening for admin types
- Admin-role provisioning workflow (RBAC v1.1 permissions matrix)
- session-service.issueSession mapping update
- End-to-end login-to-admin-route integration test

**Closed by:** F-1 follow-on PR — Identity-slice extension for admin account-type provisioning.

### F-2 — Active-tenant DB validation for platform_admin home tenant (R5 HIGH-2)

`KNOWN_TENANT_IDS` in `tenant-context.ts` is a static compile-time set, not consulted against DB tenant lifecycle status. A platform_admin token with a DB-inactive home tenant would still authenticate as long as its ID is in the static set.

**Why deferred:** Production session-service.ts cannot mint admin tokens today (see F-1). No path exists in production to a platform_admin token whose home tenant is in KNOWN_TENANT_IDS but DB-inactive. The static-set defense is sufficient for the test-fixture-only minting path.

**Closed by:** F-1 follow-on PR (concurrently with admin minting). The active-tenant validator should land in the same PR that wires production admin issuance, so the two together close the entire admin-issuance trust chain.

### F-3 — Session-liveness check for admin JWTs (R6 HIGH-1)

`requireAdminRole` accepts the JWT's role claim as authoritative; no DB session-liveness lookup. A revoked/demoted admin can still authorize admin writes for the JWT TTL window (15 minutes).

**Why deferred:** This is a pre-existing property of the JWT design documented in `jwt-fixtures.ts` (the production verification path does NOT consult the sessions table on every request — the JWT itself is the per-request cache; session liveness is enforced by the 15-minute JWT TTL + the login-flow's session creation). Phase 2 does not change this property; it widens the roles it applies to.

**Closed by:** F-3 follow-on PR (separate from Phase 2 admin) — a JWT-revocation / session-denylist mechanism for high-impact authorization roles. Would also benefit clinician role (existing gap). Likely a separate Identity / RBAC slice deliverable.

### F-4 — platform_admin audit attribution (R6 HIGH-2)

`actorContext.adminHomeTenantId` is populated for platform_admin but existing admin handlers + services pass only `ctx.tenantId` (resolved tenant) to audit emitters. A US platform_admin acting on Ghana resources is recorded as a Ghana actor — wrong audit attribution.

**Why deferred:** Phase 2 only widens the AccessTokenRole enum + adds the `adminHomeTenantId` field. Audit emission code lives in service-layer functions across many modules; updating each emitter to use `adminHomeTenantId` is a cross-cutting code change that properly belongs to the Phase 2 follow-on PR that migrates the admin-endpoint TESTS (because the audit assertions will be the verification surface for the new attribution semantics).

**Closed by:** F-4 follow-on PR — paired with admin-endpoint test migration. Specifically:
1. Identify all audit emitters reachable from admin handlers
2. Update each to accept the full actorContext (not just actorId + ctx.tenantId)
3. Emit `actor_tenant_id` = `adminHomeTenantId` for platform_admin; `actor_tenant_id` = `tenantId` for all other roles
4. Test assertions verify cross-tenant platform_admin actions are attributed to the admin's home tenant, not the resource tenant

## Closure plan summary

| Finding | Severity | Phase 2 PR #140 | Follow-on |
|---|---|---|---|
| R1 HIGH (JWT path fail-closed) | HIGH | CLOSED ✅ | — |
| R2 HIGH (bearerTokenPresented) | HIGH | CLOSED ✅ | — |
| R3 HIGH (platform_admin tenant-scope) | HIGH | CLOSED ✅ | — |
| R4 HIGH-1 (production admin minting) | HIGH | DEFERRED | F-1 |
| R4 HIGH-2 (validate home tenant) | HIGH | CLOSED ✅ | — |
| R5 HIGH-1 (case-insensitive Bearer) | HIGH | CLOSED ✅ | — |
| R5 HIGH-2 (active-tenant DB validation) | HIGH | DEFERRED | F-2 (paired w/ F-1) |
| R6 HIGH-1 (session-liveness) | HIGH | DEFERRED (pre-existing) | F-3 |
| R6 HIGH-2 (audit attribution) | HIGH | DEFERRED | F-4 |
| R1 MEDIUM (production admin minting) | MEDIUM | DEFERRED | F-1 |

**5 HIGH closures in-PR; 4 HIGH deferred with named follow-on PRs.**
