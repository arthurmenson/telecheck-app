/**
 * signal-read-repo.ts — Med-Interaction read-model repository (PR 7).
 *
 * Single responsibility: read the current-state projection for one
 * interaction signal via the SECDEF access function
 * `get_interaction_signal_current_state(p_signal_id)` created in
 * migration 048.
 *
 * **Read path (SI-019 Sub-decision 9 — HOT-PATH DISPLAY):**
 *   The access function is the canonical singleton read path for display
 *   consumers. It is SECURITY DEFINER (owned by `mv_refresh_owner`, the
 *   role that holds SELECT on the access-disciplined materialized view),
 *   with a locked search_path, and enforces tenant scope INSIDE its body
 *   via `current_tenant_id()`. App callers reach it by elevating into the
 *   `medication_interaction_signal_viewer` slice role (migration 048
 *   GRANTs EXECUTE to exactly that role).
 *
 * **Why withDbRole (Option B app-role acquisition; migration 051):**
 *   `telecheck_app_role` is NOINHERIT + a member of the 13 slice roles, so
 *   the viewer role's EXECUTE grant only applies inside an explicit
 *   `SET LOCAL ROLE medication_interaction_signal_viewer` block. The
 *   `withDbRole` helper performs that elevation safely (capture-and-restore
 *   prior role in a finally) AFTER the route-layer Layer B authorization
 *   has validated the actor is entitled to read signals. This is the first
 *   handler-layer consumer of withDbRole.
 *
 * **Required nesting order (Codex Pass-2 mandate; see with-db-role.ts):**
 *   withTransaction → withTenantContext → withDbRole → fn
 *   No withActorContext: this is a pure read with NO Cat A audit emission
 *   (SI-019 §6 audit catalog has no read event), so there is no actor-bound
 *   write needing the SI-010 nonce. The access function only consumes the
 *   tenant GUC, which withTenantContext binds.
 *
 * **Invariants:**
 *   - I-023: tenant scope is enforced at the SECDEF body via
 *     current_tenant_id(); withTenantContext binds the GUC for the tx.
 *   - I-025: a signal absent in the caller's tenant returns null here →
 *     the handler renders a tenant-blind 404 identical to "does not exist".
 *   - I-035: the MV behind the access function is non-authoritative; this
 *     read path is for display only, never for enforcement/gating.
 *
 * Spec references:
 *   - SI-019 Medication Interaction Engine Slice PRD v2.0 §Sub-decision 9
 *     (read-path consumer classification) + §5 endpoint 3 (read a single
 *     signal)
 *   - CDM v1.7 §4.NEW5 (access function DDL)
 *   - migrations/048_med_interaction_view_mv_access_function.sql
 *   - migrations/051_app_role_acquisition_foundation.sql + src/lib/with-db-role.ts
 */

import { withTransaction } from '../../../../lib/db.js';
import { withTenantContext } from '../../../../lib/rls.js';
import { withDbRole } from '../../../../lib/with-db-role.js';
import type { InteractionSignalCurrentState } from '../types.js';

interface AccessFunctionRow {
  signal_id: string;
  current_state: string;
  as_of: Date;
  transition_reason: string;
}

/**
 * Read the current-state projection for one signal, scoped to `tenantId`.
 *
 * Returns null when the signal does not exist in the caller's tenant —
 * the access function's `WHERE tenant_id = current_tenant_id()` predicate
 * makes a cross-tenant signal indistinguishable from a non-existent one,
 * which the handler surfaces as a tenant-blind 404 (I-025).
 *
 * @param tenantId  Operating-tenant identifier (`Telecheck-{country}`).
 * @param signalId  Caller-supplied signal ULID (validated as ULID-shaped
 *                  by the handler before reaching here, so it can never
 *                  overflow the access function's VARCHAR(26) parameter).
 */
export async function readSignalCurrentState(
  tenantId: string,
  signalId: string,
): Promise<InteractionSignalCurrentState | null> {
  return withTransaction(async (tx) =>
    withTenantContext(tx, tenantId, async () =>
      withDbRole(tx, 'medication_interaction_signal_viewer', async () => {
        const result = await tx.query<AccessFunctionRow>(
          'SELECT signal_id, current_state, as_of, transition_reason ' +
            'FROM get_interaction_signal_current_state($1)',
          [signalId],
        );
        const row = result.rows[0];
        if (row === undefined) {
          return null;
        }
        return {
          signal_id: row.signal_id,
          current_state: row.current_state,
          as_of: row.as_of,
          transition_reason: row.transition_reason,
        };
      }),
    ),
  );
}
