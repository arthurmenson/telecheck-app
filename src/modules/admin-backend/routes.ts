/**
 * admin-backend/routes.ts — Fastify route registration.
 *
 * Status at v0.3 (Sprint 2 cascade): the crisis-operational-health read
 * (PR 1) + the submit-for-review write (PR 2) + the review-decision write
 * (PR 3) are mounted on `main`; this commit (Sprint 2 PR 4) additionally
 * mounts the two remaining dashboard reads as FAIL-CLOSED 503 scaffolds
 * pending their data-source landings.
 *
 *   - GET  /dashboards/crisis-operational-health    (Sprint 2 PR 1; LIVE)
 *     wraps the SECDEF read wrapper read_admin_crisis_operational_health
 *     from migration 044 §1.
 *   - POST /templates/:template_id/submit-for-review (Sprint 2 PR 2)
 *     wraps the SECDEF write wrapper submit_forms_template_for_admin_review
 *     from migration 043 §1. First WRITE handler for the slice;
 *     establishes the canonical write composition (withIdempotentExecution
 *     → withTenantContext → withActorContext → withDbRole(admin_basic_operator)
 *     → wrapper call → same-tx Cat A audit emission under restored
 *     app role).
 *   - POST /templates/:template_id/reviews/:review_id/decision
 *     (Sprint 2 PR 3) wraps the SECDEF write wrapper
 *     record_forms_template_admin_decision from migration 043 §3 under the
 *     admin_template_reviewer slice role; same-tx Cat A audit emission
 *     (admin.template_review_decision).
 *   - GET /dashboards/consult-queue-health (NEW Sprint 2 PR 4;
 *     FAIL-CLOSED 503 pending Async Consult slice). Handler scaffold
 *     mirrors the crisis-dashboard composition pipeline; auth + role
 *     gates run; the wrapper SELECT surfaces PG 42883 (undefined_function)
 *     today, mapped to a canonical 503 tenant-blind envelope. Zero
 *     handler change when migration 044 §3's deferred wrapper lands.
 *   - GET /dashboards/mode1-volume-health (NEW Sprint 2 PR 4;
 *     FAIL-CLOSED 503 pending Mode 1 slice). Same pattern as the consult
 *     dashboard sibling.
 *
 *   - /health (200) + /ready (still 503 until Sprint 4 hardening closes
 *     — see /ready body for the remaining-blockers list).
 *
 * All routes are mounted under the spec-canonical `/v1/admin` plugin
 * prefix (admin-backend/plugin.ts), so absolute URLs are
 *   /v1/admin/health
 *   /v1/admin/ready
 *   /v1/admin/dashboards/crisis-operational-health
 *   /v1/admin/templates/:template_id/submit-for-review
 *   /v1/admin/templates/:template_id/reviews/:review_id/decision
 *   /v1/admin/dashboards/consult-queue-health           ← NEW (fail-closed)
 *   /v1/admin/dashboards/mode1-volume-health            ← NEW (fail-closed)
 *
 * With this PR all 5 SI-023 §5 endpoints are mounted (the 2 dashboard
 * reads fail-closed pending their data-source landings per Option 2).
 *
 * Spec references:
 *   - SI-023 Admin Backend Basics Slice v1.0 (RATIFIED 2026-05-22 P-041)
 *   - CDM v1.10 → v1.11 Amendment §4.NEW1-NEW9 (RATIFIED 2026-05-22 P-042)
 *   - I-023 (tenant scoping via foundation tenantContext plugin)
 *   - I-025 (tenant-blind error envelopes — 503 message contains no
 *     tenant identifiers per the deferred-scaffold pattern)
 *   - I-027 (audit completeness on admin read + write paths)
 */

import type { FastifyInstance, FastifyPluginAsync } from 'fastify';

import { getConsultQueueHealthHandler } from './internal/handlers/get-consult-queue-health.js';
import { getCrisisOperationalHealthHandler } from './internal/handlers/get-crisis-operational-health.js';
import { getMode1VolumeHealthHandler } from './internal/handlers/get-mode1-volume-health.js';
import { postFormsTemplateDecisionHandler } from './internal/handlers/post-forms-template-decision.js';
import { postFormsTemplateSubmitHandler } from './internal/handlers/post-forms-template-submit.js';

export const registerAdminBackendRoutes: FastifyPluginAsync = async (
  app: FastifyInstance,
): Promise<void> => {
  // Liveness probe — process is alive. Returns 200 always (module is
  // running), with `blocked` carried as informational metadata for
  // operator monitoring. Allowlisted in tenantContextPlugin.
  app.get('/health', async () => ({
    status: 'ok',
    module: 'admin-backend',
    ready: true,
    ready_message:
      'Sprint 4 hardening CLOSED 2026-07-09. All 5 SI-023 §5 endpoints live: ' +
      '3 dashboard reads (crisis-operational-health, consult-queue-health, ' +
      'mode1-volume-health) + 2 template writes (submit-for-review, decision). ' +
      'BUILDABLE hardening set complete: Cat A audit emission for all 4 admin.* ' +
      'IDs (dashboard_query_executed + template_submitted_for_review + ' +
      'template_review_decision + template_published_via_review_workflow); LAYER B ' +
      'slice-role-membership gate (requireSliceRoleMembership) replacing the legacy ' +
      'admin-role shim call; cross-tenant isolation integration tests. Only remaining ' +
      'item is Track-6 SPEC-GATED AUDIT_EVENTS catalog ratification of the admin.* ' +
      'namespace (placeholder-cast; no runtime impact; see /ready spec_gated_gaps + ' +
      'src/modules/admin-backend/README.md).',
  }));

  // Readiness probe — module is READY to serve full traffic (Sprint 4
  // hardening closed 2026-07-09). All 5 SI-023 §5 endpoints are LIVE with
  // the BUILDABLE hardening set complete:
  //   - Cat A audit emission for all 4 admin.* action IDs (dashboard_query_executed
  //     on the 3 dashboard reads; template_submitted_for_review + template_review_decision
  //     + template_published_via_review_workflow on the write paths), each same-tx
  //     with its SECDEF wrapper call under the restored telecheck_app_role.
  //   - Proper LAYER B slice-role-membership check (requireSliceRoleMembership),
  //     replacing the legacy admin-role shim call — fail-closed via the
  //     ratified admin-role boundary + the DB EXECUTE-grant floor
  //     (admin_basic_operator for dashboards + submit; admin_template_reviewer
  //     for decision).
  //   - Cross-tenant isolation integration tests (I-023/I-025).
  //
  // The ONLY remaining gap is Track-6 SPEC-GATED (not buildable here):
  // AUDIT_EVENTS catalog ratification of the admin.* action IDs. These are
  // emitted via the module-local `adminBackendAuditPlaceholder()` cast
  // (placeholder-cast) pending the bundle AUDIT_EVENTS v5.12 → v5.13
  // amendment per SI-023 §3. This is a NAMING-PROVENANCE gap only — it has
  // ZERO runtime impact: the audit rows commit correctly, the hash chain
  // validates, the payloads conform to SI-023 §3. This qualifies for the
  // 200 flip per the async-consult precedent (async-consult /ready is READY
  // with 17 placeholder-cast IDs). The gap is fail-conservative (audits
  // still emitted; only the canonical-catalog registration is pending) and
  // surfaced machine-readably in `spec_gated_gaps` below.
  app.get('/ready', async () => ({
    status: 'ok',
    module: 'admin-backend',
    spec_gated_gaps: [
      {
        gap: 'audit_events_catalog_ratification',
        detail:
          'The 4 admin.* Cat A action IDs (admin.dashboard_query_executed, ' +
          'admin.template_submitted_for_review, admin.template_review_decision, ' +
          'admin.template_published_via_review_workflow) are emitted via the ' +
          'module-local adminBackendAuditPlaceholder() cast pending the canonical ' +
          'AUDIT_EVENTS v5.12 → v5.13 amendment (SI-023 §3). Naming-provenance only; ' +
          'no runtime impact (audit rows commit, hash chain validates, payloads ' +
          'conform to SI-023 §3). Async-consult precedent: READY with placeholder-cast IDs.',
        track: 'Track-6 spec-corpus ratification',
        si_candidate: 'AUDIT_EVENTS admin.* namespace amendment (§12 SI)',
        fail_mode: 'fail_conservative',
        runtime_impact: 'none',
      },
    ],
  }));

  // -------------------------------------------------------------------------
  // Sprint 2 PR 1 — LIVE dashboard handler (post-foundation-051).
  //
  // GET /v1/admin/dashboards/crisis-operational-health
  //   - Wraps read_admin_crisis_operational_health (migration 044 §1).
  //   - Composes withTransaction → withTenantContext → withActorContext →
  //     withDbRole('admin_basic_operator') → SECDEF wrapper call.
  //   - I-027 read-trail row inserted co-transactionally by the wrapper.
  // -------------------------------------------------------------------------
  app.get('/dashboards/crisis-operational-health', getCrisisOperationalHealthHandler);

  // -------------------------------------------------------------------------
  // Sprint 2 PR 2 — FIRST WRITE HANDLER (post-foundation-051).
  //
  // POST /v1/admin/templates/:template_id/submit-for-review
  //   - Wraps submit_forms_template_for_admin_review (migration 043 §1).
  //   - Composes withIdempotentExecution → withTenantContext →
  //     withActorContext → withDbRole('admin_basic_operator') → SECDEF
  //     wrapper call → same-tx Cat A audit emission under restored
  //     telecheck_app_role.
  //   - LAYER B authorization via the platform admin-role shim
  //     (lib/admin-role.ts), pending proper RBAC v1.1 wiring in Sprint 4.
  //   - Cat A audit `admin.template_submitted_for_review` emitted via
  //     module-local emitter (admin-backend/audit.ts) with payload per
  //     SI-023 §3 row 2 (review_id + forms_template_id +
  //     submitter_principal_id + initial_submission/revision_resubmission
  //     path discriminator).
  //   - 42501 → tenant-blind 403 mapping wraps the entire withDbRole
  //     call (R2 MED-1 closure parity).
  //   - Idempotency via withIdempotentExecution (IDEMPOTENCY v5.1 +
  //     SI-006 reserve-then-execute).
  // -------------------------------------------------------------------------
  app.post('/templates/:template_id/submit-for-review', postFormsTemplateSubmitHandler);

  // -------------------------------------------------------------------------
  // POST /v1/admin/templates/:template_id/reviews/:review_id/decision
  //   (Sprint 2 PR 3 — second WRITE handler)
  //
  // Reviewer-decision endpoint per SI-023 §5 row 5. Calls SECDEF wrapper
  // record_forms_template_admin_decision from migration 043 §3 under the
  // admin_template_reviewer slice role (distinct from PR 2's
  // admin_basic_operator). Emits Cat A audit
  // admin.template_review_decision per SI-023 §3 row 3, same-tx with the
  // wrapper INSERT (I-003 durability). Idempotency via Idempotency-Key
  // header + the wrapper's internal p_idempotency_key parameter (both
  // resolved from the same canonical key per IDEMPOTENCY v5.1).
  // -------------------------------------------------------------------------
  app.post('/templates/:template_id/reviews/:review_id/decision', postFormsTemplateDecisionHandler);

  // -------------------------------------------------------------------------
  // Sprint 2 PR 4 — DEFERRED-WRAPPER dashboard handler scaffolds.
  //
  // Both handlers mirror the PR 1 reference handler's composition + the
  // R2 MED-1 42501 → 403 mapping (whole withDbRole wrapped, not just the
  // inner SELECT). They additionally map PG SQLSTATEs 42883 (undefined_
  // function — the live v0.1 state per migration 044 §3/§4 deferral)
  // and 0A000 (feature_not_supported — forward-compat with a possible
  // future intermediate hygiene state where the wrapper exists as a stub)
  // to a canonical 503 tenant-blind envelope.
  //
  // When the Async Consult slice + the matching Option-2 hygiene migration
  // land the consult view + read_admin_consult_queue_health wrapper, the
  // consult handler auto-unblocks (wrapper SELECT returns rows; the 503
  // mapping becomes dead code for that path). Same pattern for Mode 1.
  // -------------------------------------------------------------------------
  app.get('/dashboards/consult-queue-health', getConsultQueueHealthHandler);

  app.get('/dashboards/mode1-volume-health', getMode1VolumeHealthHandler);
};
