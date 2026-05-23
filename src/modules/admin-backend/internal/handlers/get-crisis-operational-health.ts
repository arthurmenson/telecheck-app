/**
 * admin-backend/internal/handlers/get-crisis-operational-health.ts —
 * First real Fastify handler for the Admin Backend Basics slice (SI-023),
 * landed in Sprint 2 PR 1 post-foundation-051 (Option B app-role
 * acquisition mechanism).
 *
 * Endpoint:
 *   GET /v1/admin/dashboards/crisis-operational-health
 *
 *   Plugin prefix is `/v1/admin` (admin-backend/plugin.ts §R1 MED-1
 *   closure 2026-05-22 — spec-canonical SI-023 §5 endpoint contract).
 *   The route path here is `/dashboards/crisis-operational-health`
 *   (plural `dashboards` per SI-023 §5 + CDM v1.10 → v1.11 Amendment §4
 *   endpoint list).
 *
 * What it does:
 *   1. LAYER B: authorize the request's actor as `admin_basic_operator`
 *      (placeholder admin-role gate via lib/admin-role.ts pending the
 *      full RBAC v1.1 wiring — same shim every other admin surface uses).
 *   2. Open a tx; bind tenant context + SI-010 actor nonce.
 *   3. Within the tx, elevate to the `admin_basic_operator` slice role
 *      via the Option B `withDbRole` helper (foundation 051 +
 *      src/lib/with-db-role.ts).
 *   4. Call the SECDEF wrapper `read_admin_crisis_operational_health()`
 *      (migration 044 §1). The wrapper:
 *        - LAYER C tenant scope match (current_actor_account_tenant_id
 *          must equal p_tenant_id).
 *        - SELECT view body into TEMP table.
 *        - Co-transactional INSERT into admin_dashboard_query_execution
 *          (I-027 audit-trail completeness on the read path).
 *        - RETURN QUERY rows.
 *   5. Return 200 with the rollup rows.
 *
 * What it does NOT do (deferred to a later Sprint per
 *  src/modules/admin-backend/README.md):
 *   - Cat A `admin.dashboard_query_executed` AUDIT_EVENTS v5.2 emission.
 *     READ endpoint scope per task brief — the I-027 read-trail row
 *     inserted by the SECDEF wrapper is the wrapper-level audit. The
 *     Cat A AUDIT_EVENTS envelope lands when the audit-emission helper
 *     for admin lands (Sprint 4 hardening per README §"Sprint 2+
 *     remaining work").
 *
 * Composability discipline (per lib/with-db-role.ts header):
 *   withTransaction → withTenantContext → withActorContext → withDbRole → fn
 *
 *   Each layer composes safely:
 *   - withTransaction opens the tx + manages BEGIN/COMMIT/ROLLBACK.
 *   - withTenantContext sets the private _session_tenant_context row +
 *     GUC binding (migration 003 SECURITY DEFINER set_tenant_context).
 *   - withActorContext sets the SI-010 app.request_nonce GUC so
 *     current_actor_*() helpers inside the SECDEF wrapper resolve the
 *     authenticated identity (migration 031).
 *   - withDbRole issues SET LOCAL ROLE admin_basic_operator (foundation
 *     051 NOINHERIT + membership) so the wrapper EXECUTE grant (anti-
 *     bypass'd in 044 §2 to admin_basic_operator only) succeeds.
 *
 * Tenant-blind error envelope (I-025) is handled by the global
 * error-envelope plugin — this handler does NOT format errors itself.
 * Layer C tenant-scope mismatch from the wrapper raises 42501 which
 * propagates through pg + the error-envelope plugin as a tenant-blind
 * 401/403 per ERROR_MODEL v5.1.
 *
 * Spec references:
 *   - SI-023 Admin Backend Basics Slice v1.0 (RATIFIED 2026-05-22 P-041)
 *     §3.5 (dashboard read-path canonical wrapper-only discipline)
 *     §5 endpoint contract (`/v1/admin/dashboards/crisis-operational-health`)
 *   - CDM v1.10 → v1.11 Amendment §4.NEW8b (RATIFIED 2026-05-22 P-042)
 *   - migrations/044_admin_backend_dashboard_wrappers.sql §1 (wrapper body)
 *   - migrations/051_app_role_acquisition_foundation.sql §2 (slice-role
 *     membership grant for admin_basic_operator)
 *   - src/lib/with-db-role.ts (Option B SET LOCAL ROLE helper)
 *   - I-023 (three-layer tenancy: RLS + tenant-context GUC + wrapper LAYER C)
 *   - I-025 (tenant-blind errors)
 *   - I-027 (audit completeness via wrapper-level
 *     admin_dashboard_query_execution INSERT)
 */

import type { FastifyReply, FastifyRequest } from 'fastify';

import { requireAdminRole } from '../../../../lib/admin-role.js';
import { withActorContext } from '../../../../lib/actor-context-binding.js';
import { withTransaction } from '../../../../lib/db.js';
import { withTenantContext } from '../../../../lib/rls.js';
import { requireTenantContext } from '../../../../lib/tenant-context.js';
import { withDbRole } from '../../../../lib/with-db-role.js';

/**
 * Row shape returned by `read_admin_crisis_operational_health(text, jsonb)`.
 * Mirrors the RETURNS TABLE definition in migration 044 §1.
 *
 * NOTE on field types: the wrapper returns Postgres `BIGINT` which the
 * `pg` driver surfaces as JS `string` (BigInt-safe). `NUMERIC` likewise
 * surfaces as `string`. The HTTP envelope passes these through verbatim
 * — callers either parse to Number/BigInt or display as-is. This matches
 * the existing convention in forms-intake handlers (no eager numeric
 * coercion on raw wrapper outputs).
 */
interface CrisisOperationalHealthRow {
  tenant_id: string;
  severity: string;
  active_event_count: string;
  escalation_obligation_backlog_count: string;
  stale_sweep_count: string;
  active_obligation_avg_tier: string | null;
  crisis_audit_24h_count: string;
}

/**
 * Response envelope. Plain object, JSON-serialized by Fastify. No
 * pagination — the view's rollup is small (rows = tenants × severities
 * with active state in the 24h window).
 */
export interface GetCrisisOperationalHealthResponse {
  rows: CrisisOperationalHealthRow[];
}

/**
 * GET /v1/admin/dashboards/crisis-operational-health
 *
 * Flow (5 phases):
 *   1. Resolve tenant context (foundation tenantContextPlugin; throws if
 *      absent → tenant-blind 400 via error-envelope).
 *   2. LAYER B: requireAdminRole (placeholder admin shim — see
 *      docs/SI-024.1 pending real RBAC). Throws 401/403 on failure.
 *   3. Open a tx via withTransaction.
 *   4. Within the tx, compose:
 *        withTenantContext (RLS + private tenant binding)
 *        → withActorContext (SI-010 nonce GUC; only if actorNonce bound)
 *        → withDbRole admin_basic_operator (Option B elevation)
 *        → SELECT * FROM read_admin_crisis_operational_health($1, $2)
 *   5. Return { rows: [...] }.
 */
export async function getCrisisOperationalHealthHandler(
  req: FastifyRequest,
  _reply: FastifyReply,
): Promise<GetCrisisOperationalHealthResponse> {
  // Phase 1 — tenant context.
  const ctx = requireTenantContext(req);

  // Phase 2 — LAYER B authorization (admin role gate).
  //
  // The Admin Backend slice's canonical LAYER B per SI-023 §3.5 is
  // "actor must be member of admin_basic_operator". Until the proper
  // RBAC v1.1 wiring lands (a future Identity & Auth slice extension),
  // this handler reuses the platform-wide admin shim — same one every
  // other admin surface uses (tenant_admin / platform_admin). Both
  // canonical RBAC v1.1 admin roles map to "permitted to call
  // admin_basic_operator wrappers" at this slice's v0.1.
  //
  // TODO(SI-023 Sprint 4): replace with explicit
  // `requireSliceRoleMembership('admin_basic_operator')` once the
  // identity slice surfaces per-actor slice-role membership. Until
  // then the admin-role shim provides the conservative gate (admin
  // identities only) without leaving the endpoint open to any
  // authenticated actor.
  requireAdminRole(req);

  // Phase 3-4 — open tx + compose context helpers in canonical order
  // (withTransaction → withTenantContext → withActorContext → withDbRole).
  //
  // Note on `tx` reuse inside the nested callbacks: `withTenantContext`
  // (from src/lib/rls.ts) declares its own narrow `DbClient` interface
  // whose `query` returns `Promise<unknown>` — fine for the binding-
  // helper internals but unwieldy for downstream wrapper calls. We
  // therefore use the `tx` handle from `withTransaction` (the canonical
  // `DbTransaction` interface with typed `query<R>` returns) throughout
  // the nested callbacks; the rls.ts inner callback's `boundTx` is the
  // SAME physical connection (just narrowed at the type boundary), so
  // calls on `tx` are equivalent to calls on `boundTx` at runtime.
  const rows = await withTransaction<CrisisOperationalHealthRow[]>(async (tx) => {
    return withTenantContext(tx, ctx.tenantId, async () => {
      // The SI-010 actor nonce is bound by authContextPlugin on requests
      // carrying a verified JWT. When the legacy header-shim auth path
      // runs (no JWT, ALLOW_ACTOR_HEADER_AUTH=true), actorNonce is
      // undefined. The wrapper's LAYER C check (current_actor_account_*())
      // requires the nonce to resolve the bound identity row, so without
      // a nonce the wrapper would raise 'no actor tenant bound' (42501).
      //
      // For the v0.1 handler we treat the missing-nonce case as fail-
      // closed: the wrapper itself enforces "no actor → reject", so we
      // simply let it raise; the global error envelope translates 42501
      // into a tenant-blind 401/403 per I-025. Skipping the
      // withActorContext call when the nonce is undefined leaves the
      // GUC unset — which is the correct fail-closed posture.
      const runWrapper = async (): Promise<CrisisOperationalHealthRow[]> => {
        return withDbRole(tx, 'admin_basic_operator', async () => {
          // The wrapper signature is
          //   read_admin_crisis_operational_health(p_tenant_id TEXT,
          //                                        p_query_params_jsonb JSONB)
          // Pass an empty `{}` for query params at v0.1 — the wrapper
          // body persists this into admin_dashboard_query_execution.
          // Future iterations may surface query filters from URL query
          // string (e.g., ?severity=high) and forward them here.
          const result = await tx.query<CrisisOperationalHealthRow>(
            'SELECT * FROM read_admin_crisis_operational_health($1, $2)',
            [ctx.tenantId, {}],
          );
          return result.rows;
        });
      };

      if (req.actorNonce !== undefined) {
        return withActorContext(tx, req.actorNonce, runWrapper);
      }
      return runWrapper();
    });
  });

  return { rows };
}
