/**
 * med-interaction/routes.ts — Fastify route registration (Sprint 1 skeleton).
 *
 * Status at v0.1 (post-PR-1-5 DB-layer COMPLETE; this commit = PR 6 of 6
 * for the Med-Interaction DB-layer series): SKELETON — only `/health`
 * (200) + `/ready` (503) are mounted. Liveness/readiness split applies
 * the canonical BLOCKED-aware pattern from pharmacy / med-interaction's
 * own prior skeleton / subscription / async-consult / crisis-response /
 * admin-backend modules.
 *
 * Post-P-033/P-034 ratified + DB-layer-implemented state (2026-05-23):
 * SI-019 Slice PRD v2.0 RATIFIED P-033 + CDM v1.6 → v1.7 + AUDIT_EVENTS
 * v5.8 → v5.9 + OpenAPI v0.2 → v0.3 + State Machines v1.1 → v1.2 + RBAC
 * v1.1 → v1.2 RATIFIED P-034 (both 2026-05-21). DB layer COMPLETE through
 * migration 050:
 *   - migration 046: 12 net-new RBAC roles (4 application + 6 wrapper-
 *     owner + 2 service-level-owner)
 *   - migration 047: 4 entities (interaction_engine_evaluation +
 *     interaction_signal + interaction_signal_override +
 *     interaction_signal_lifecycle_transition) + RLS + per-table append-
 *     only triggers + server-assigned monotonic-ordering trigger with
 *     state-continuity check + caller-tenant guard (7 Codex rounds)
 *   - migration 048: 1 SECURITY BARRIER view + 1 optional MV + SECDEF
 *     access function + MV access-discipline (preflight + immediate
 *     REVOKE + aclexplode loop + final verifier; 5 Codex rounds)
 *   - migration 049: raw lifecycle writer SECDEF + anti-bypass EXECUTE
 *     matrix (6 wrapper-owners) + STEP 3.5 advisory-locked activation-
 *     override-evidence check (3 Codex rounds)
 *   - migration 050: 6 reason-specific wrappers (3 operational: emission
 *     + activation + supersession; 3 fail-closed: resolution + expiry +
 *     override pending evidence-source migrations) (3 Codex rounds)
 *
 * Subsequent PRs (PR 7+) land Fastify handler implementation:
 *   - POST /v1/med-interaction/evaluations         — initiate evaluation
 *   - POST /v1/med-interaction/signals             — emit signal
 *   - POST /v1/med-interaction/signals/:id/activate
 *   - POST /v1/med-interaction/signals/:id/override
 *   - POST /v1/med-interaction/signals/:id/resolve  (gated; fail-closed
 *                                                    wrapper in 050)
 *   - POST /v1/med-interaction/signals/:id/expire   (gated; fail-closed)
 *   - POST /v1/med-interaction/signals/:id/supersede
 *   - GET  /v1/med-interaction/signals/:id          — read via SECDEF
 *                                                    access function or
 *                                                    SECURITY BARRIER view
 *   + Cat A audit emission (6 audit events under medication_interaction.*)
 *   + LAYER B role-membership check at route layer (SI-024.1 JWT-binding
 *     deferred per Option 2)
 *
 * Spec references:
 *   - Master PRD v1.10 §7 (interaction engine as platform-floor)
 *   - SI-019 Med-Interaction Engine Slice PRD v2.0 (RATIFIED 2026-05-21
 *     P-033)
 *   - CDM v1.6 → v1.7 Amendment (RATIFIED 2026-05-21 P-034)
 *   - I-002 (interaction engine runs BEFORE clinician commits
 *     medication_request)
 *   - I-023 (tenant scoping via foundation tenantContext plugin)
 *   - I-025 (tenant-blind error envelopes)
 *   - src/modules/med-interaction/README.md
 *   - docs/med-interaction-implementation-plan.md
 */

import type { FastifyInstance, FastifyPluginAsync } from 'fastify';

import { getSignalHandler } from './internal/handlers/get-signal.js';
import { supersedeSignalHandler } from './internal/handlers/supersede-signal.js';
import { overrideSignalHandler } from './internal/handlers/override-signal.js';
import { resolveSignalHandler } from './internal/handlers/resolve-signal.js';
import { expireSignalHandler } from './internal/handlers/expire-signal.js';

export const registerMedInteractionRoutes: FastifyPluginAsync = async (
  app: FastifyInstance,
): Promise<void> => {
  // Liveness probe — process is alive. Returns 200 always (module is
  // running), with `blocked` carried as informational metadata for
  // operator monitoring. Allowlisted in tenantContextPlugin.
  app.get('/health', async () => ({
    status: 'ok',
    module: 'med-interaction',
    blocked:
      'Med Interaction Engine handler implementation (Sprint 1 of N at v0.1; PR 7 of N — first real handler shipped)',
    blocked_message:
      'Spec layer COMPLETE: SI-019 v2.0 RATIFIED 2026-05-21 P-033 + CDM v1.6 → v1.7 ' +
      '+ AUDIT_EVENTS v5.8 → v5.9 + OpenAPI v0.2 → v0.3 + State Machines v1.1 → v1.2 ' +
      '+ RBAC v1.1 → v1.2 RATIFIED P-034. DB layer COMPLETE through migration 050 ' +
      '(PRs 1-5 merged; 21 Codex rounds total): 12 RBAC roles (046) + 4 entities + RLS + ' +
      'triggers (047) + view + MV + SECDEF access function (048) + raw lifecycle writer ' +
      'SECDEF + anti-bypass matrix (049) + 6 reason-specific wrappers (050; 3 ' +
      'operational + 3 fail-closed pending evidence-source migrations). ' +
      'PR 7 (this commit) ships the FIRST real Fastify handler post-foundation-051: ' +
      'GET /v0/med-interaction/signals/:id reading via the SECDEF access function from ' +
      'migration 048 under the canonical withTransaction → withTenantContext → ' +
      'withActorContext → withDbRole(medication_interaction_signal_viewer) composition. ' +
      '7 endpoints remain (POST evaluations + 6 signal lifecycle actions); they land in ' +
      'PRs 8-11 with Cat A audit emission + LAYER B role-membership tightening. See ' +
      'src/modules/med-interaction/README.md + docs/med-interaction-implementation-plan.md.',
  }));

  // Readiness probe — module is partially serving traffic at PR 7 (the
  // signal-read endpoint is live) but the slice as a whole is NOT yet
  // production-ready: 7 of 8 handlers remain, the audit emission helper is
  // not wired, and Layer B role-membership authorization is still the
  // deferred-permissive shape per the Option 2 ratifier decision. Returns
  // 503 with `reason: 'partial_handlers_wired'` to keep load-balancers /
  // deploy gates from advancing the slice through production rollout
  // until the full handler set ships. This follows the canonical
  // Crisis-Response / Admin-Backend scaffold convention where /ready
  // stays 503 with an updated reason until the slice's PR series closes.
  app.get('/ready', async (_req, reply) => {
    return reply.code(503).send({
      status: 'unavailable',
      module: 'med-interaction',
      reason: 'partial_handlers_wired',
      reason_message:
        '1 of 8 Med Interaction Engine Fastify handlers wired (PR 7: ' +
        'GET /v0/med-interaction/signals/:id via SECDEF access function from ' +
        'migration 048 under the canonical withDbRole composition). 7 endpoints ' +
        'remain: POST /evaluations + POST /signals + POST /signals/:id/{activate, ' +
        'override, resolve, expire, supersede}. Spec + DB layers COMPLETE through ' +
        'migration 050 + PR 7 first real handler. The /ready probe returns 200 once ' +
        'the full PR series (remaining handlers + Cat A audit emission + LAYER B ' +
        'role-membership check + integration tests) closes. See ' +
        'src/modules/med-interaction/README.md for the resume path.',
    });
  });

  // ----- Real routes -----

  // PR 7 of N: GET /v0/med-interaction/signals/:id — single-signal
  // current-state lookup via the SECDEF access function from migration
  // 048 §3. Read-only; no audit emission (SI-019 §6 catalogs only
  // write events). See handler file-level docstring for the canonical
  // composition order + Layer B deferral rationale.
  app.get('/signals/:id', getSignalHandler);

  // PR 9: 4 remaining write endpoints (supersede + override + resolve +
  // expire). Supersede is OPERATIONAL (calls record_signal_supersession,
  // migration 050 §3). The other 3 are FAIL-CLOSED at the wrapper layer
  // (RAISE EXCEPTION SQLSTATE 0A000 per Codex R1 closure 2026-05-23
  // pending evidence-source migrations — Async Consult discontinuation-
  // event log for resolve, per-basis cadence config for expire,
  // SI-024.1 JWT-binding for override). The handler scaffolds map 0A000
  // → tenant-blind 503 per I-025 and emit Cat A audit on rejection per
  // I-003 bare-suppression-forbidden (the rejected attempt belongs in
  // the audit chain).
  app.post('/signals/:id/supersede', supersedeSignalHandler);
  app.post('/signals/:id/override', overrideSignalHandler);
  app.post('/signals/:id/resolve', resolveSignalHandler);
  app.post('/signals/:id/expire', expireSignalHandler);

  // Remaining 7 endpoints (POST /evaluations, POST /signals, POST
  // /signals/:id/{activate, override, resolve, expire, supersede})
  // land in PR 8+ when write-handler implementation begins. They will
  // share the same withTransaction → withTenantContext → withActorContext
  // → withDbRole composition pattern as the PR 7 read handler; the
  // write variants additionally wire Cat A audit emission inside the
  // same DB transaction as the SECDEF wrapper call (so a partial commit
  // cannot leave a wrapper effect without its audit record, per the
  // module README's Option 2 carryforward).
};
