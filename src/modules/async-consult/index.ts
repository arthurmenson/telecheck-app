/**
 * Async Consult module — public interface (skeleton).
 *
 * Per ADR-001: cross-module callers consume the Async Consult module
 * ONLY through this file. At v0.1 (Sprint 8) the only exported surface
 * is the Fastify plugin (for app.ts wiring), branded ID types (for
 * downstream slices that hold typed references to consult_id /
 * consult_event_id without needing full row shapes), and the canonical
 * state-value vocabulary (so dependent slices can compile against
 * typed state references before Sprint 9's transition logic lands).
 *
 * Schema authoring (the real `Consult`, `ConsultEvent` row interfaces
 * + repos + state machine + HTTP handlers + cross-slice integration)
 * is sequenced across Sprints 8-10:
 *   - Sprint 8 (THIS): module skeleton + plugin shell + branded IDs
 *     + state vocabulary + plugin smoke test
 *   - Sprint 9: repos (tenant-scoped) + service layer + state-machine
 *     transition logic + initial HTTP handlers
 *   - Sprint 10: full HTTP integration tests + audit event emitters +
 *     domain event emitters + cross-tenant isolation tests
 *
 * Audit event vocabulary: PRD v1.0 §13 enumerates 11 events; canonical
 * AUDIT_EVENTS contract grep returned 0 matches at Sprint 8 PM kickoff.
 * Sprint 9 / 10 wire-protocol vocabulary ratification is an upstream
 * spec task (likely SI-004 candidate). Skeleton ships without audit
 * emitters — handlers don't exist yet to emit from.
 *
 * Spec references:
 *   - ADR-001 (modular monolith — public-interface-only cross-module access)
 *   - ADR-029 (AI workload taxonomy — Async Consult uses Mode 2 per PRD §1)
 *   - Async Consult Slice PRD v1.0 (target spec; PRD §12 / §13 / §15)
 *   - State Machines v1.1 §3 (canonical state inventory; SOURCE OF TRUTH)
 *   - CDM v1.2 §3 entities #15 (Consult) + #16 (ConsultEvent)
 */

// Branded ID types — safe to ship at v0.1 because they are identifier
// hygiene, not schema. Downstream slices (Pharmacy + Refill, RPM/CCM,
// Adverse Events, Messaging) can compile clean against typed Consult
// references before Sprint 9 authoring.
export type {
  ConsultId,
  ConsultEventId,
  ConsultState,
} from './internal/types.js';

export {
  asConsultId,
  asConsultEventId,
  CONSULT_STATES,
} from './internal/types.js';

// Fastify plugin for app.ts wiring. Currently exposes only `/health` + `/ready`.
export { asyncConsultPlugin } from './plugin.js';
