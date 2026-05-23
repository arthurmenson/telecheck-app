/**
 * Crisis Response module — public interface.
 *
 * Per ADR-001: cross-module callers consume the Crisis Response module
 * ONLY through this file. At Sprint 1 (PR 7 — this commit) the exported
 * surface is the Fastify plugin (for app.ts wiring) + branded ID types +
 * canonical state/classification vocabularies (so downstream slices —
 * Notification, Adverse Events, Admin Backend dashboards — can compile
 * against typed Crisis Response references before Sprint 2's handler
 * implementation lands).
 *
 * **Status at v0.1 (Sprint 1):** SKELETON — module shell only. The DB
 * layer is complete (migrations 032-038: 6 tables + 2 views + 6 SECDEF
 * procedures + 15 RBAC roles + 18 rounds of Codex APPROVE). The Sprint 2+
 * application-layer work is:
 *
 *   - Sprint 2 — POST /v0/crisis-events (initiate via FLOOR-020) +
 *     POST /v0/crisis-events/:id/acknowledge + GET /v0/crisis-events/:id
 *     (read via crisis_event_current_state_v or
 *     crisis_event_patient_summary_v depending on caller role)
 *   - Sprint 3 — POST /v0/crisis-events/:id/respond + .../resolve +
 *     POST /v0/crisis-events/:id/sweep (operator-initiated; scheduler
 *     calls execute_crisis_no_acknowledgement_sweep)
 *   - Sprint 4 — full audit emission (Cat A crisis.detected /
 *     crisis.acknowledged / crisis.responded / crisis.resolved /
 *     crisis.no_acknowledgement_escalation) + KMS envelope encryption
 *     of intake_payload + cross-tenant isolation tests + idempotency-
 *     replay regression on initiation
 *
 * Per Option 2 ratifier decision 2026-05-22: SQL wrappers use SI-010
 * `current_actor_*()` helpers, not SI-024.1 JWT trust anchor. Application
 * layer is responsible for FLOOR-020 fail-closed Cat A audit emission
 * (must wrap the SECDEF wrapper call + the `emitAudit()` call in a
 * single DB transaction).
 *
 * Spec references:
 *   - SI-022 Crisis Response Slice v1.0 (RATIFIED 2026-05-21 P-039)
 *   - CDM v1.9 → v1.10 Amendment (RATIFIED 2026-05-21 P-040)
 *   - docs/crisis-response-implementation-plan.md (Option 2 adaptation
 *     rationale + 4 recorded divergences from spec)
 *   - I-019 (crisis-detection-always-on platform-floor)
 *   - I-035 (append-only lifecycle per migration 033 triggers)
 *   - ADR-001 (modular monolith — public-interface-only cross-module access)
 *   - ADR-024 (per-tenant KMS — intake_payload encryption envelope at
 *     migration 033 §4)
 */

export { crisisResponsePlugin } from './plugin.js';

// Branded ID types
export type {
  CrisisEventId,
  CrisisLifecycleTransitionId,
  CrisisSweepExecutionId,
  ServerSignalId,
} from './internal/types.js';
export {
  asCrisisEventId,
  asCrisisLifecycleTransitionId,
  asCrisisSweepExecutionId,
  asServerSignalId,
} from './internal/types.js';

// Canonical vocabularies
export type {
  CrisisType,
  CrisisSeverity,
  CrisisLifecycleState,
  CrisisLifecycleTransitionReason,
  CrisisSweepOutcome,
} from './internal/types.js';
export {
  CRISIS_TYPES,
  CRISIS_SEVERITIES,
  CRISIS_LIFECYCLE_STATES,
} from './internal/types.js';
