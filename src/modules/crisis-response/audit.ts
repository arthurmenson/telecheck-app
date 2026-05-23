/**
 * crisis-response/audit.ts — Cat A audit envelope emitter for the
 * lifecycle-bound `crisis.detected` event (SI-022 §3 normative table line 1
 * + CDM v1.9→v1.10 Amendment §3.1 normative landing).
 *
 * **Distinction from `crisis_detection_trigger`:**
 *   - `crisis_detection_trigger` (Cat A, baseline AUDIT_EVENTS, emitted
 *     pre-INSERT by Mode 1 FLOOR-020 at `src/modules/ai-service/internal/
 *     crisis/audit.ts`) records the surface-side detection signal
 *     — this is the event the AI / forms / community pipeline emits when
 *     a crisis signal first fires.
 *   - `crisis.detected` (Cat A, AUDIT_EVENTS v5.12 amendment via SI-022
 *     §3 line 1, emitted in the SAME atomic tx as the `record_crisis_
 *     initiation()` SECDEF wrapper INSERT + the `none → detected` lifecycle
 *     transition) records the lifecycle-bound entry of the crisis into
 *     the response surface — this is THIS module's emission point.
 *
 * **Placeholder pattern (parity with `forms-intake/audit.ts`):**
 *   The action ID `crisis.detected` is ratified in SI-022 §3 / CDM
 *   v1.9→v1.10 Amendment §3.1 (P-039 + P-040 2026-05-21) but has NOT
 *   yet been landed in `src/lib/audit.ts`'s `AuditAction` enum (which
 *   tracks AUDIT_EVENTS v5.3 — the v5.12 amendment lands in a future
 *   spec-corpus ratification cycle per Track 6). To unblock the Sprint 2
 *   write-path PR without leaning on a non-canonical enum edit, this
 *   helper uses the same single-sanctioned-cast pattern that
 *   `formsAuditPlaceholder()` uses: a typed string literal cast at exactly
 *   ONE call site, grep-discoverable for the future migration that
 *   replaces the placeholder with the canonical enum value.
 *
 *   When the v5.12 amendment ratifies and `lib/audit.ts` adds
 *   `'crisis.detected'` to the `CategoryAAction` union, the migration is
 *   a 1-step grep:
 *     git grep "crisisAuditPlaceholder("
 *   Delete this helper + every call site reverts to passing the canonical
 *   string literal directly.
 *
 * **Hard rules per I-003 / I-019 / I-027:**
 *   - emission MUST run in the SAME tx as the `record_crisis_initiation`
 *     wrapper call (FLOOR-020 fail-closed; ratifier Option 2 deferred
 *     audit emission from SQL wrapper to application layer per
 *     `docs/crisis-response-implementation-plan.md` + README §"Option 2
 *     ratifier decision")
 *   - emission MUST carry tenant_id (I-027); the underlying `emitAudit()`
 *     re-validates this
 *   - bare suppression on emission failure is FORBIDDEN (I-003); the
 *     handler re-throws so the surrounding transaction rolls back, the
 *     crisis_event INSERT rolls back with it, and the FLOOR-020 contract
 *     holds (no orphan crisis_event row without its audit record)
 *
 * **Audit_sensitivity_level:** `'standard'` — the crisis lifecycle row
 *   itself does NOT include the intake_payload PHI (that's KMS-encrypted
 *   on the crisis_event table per ADR-021); the audit `detail` carries
 *   classification + identifier fields only.
 *
 * Spec references:
 *   - SI-022 Crisis Response Slice v1.0 §3 normative AUDIT_EVENTS table
 *     row 1 (`crisis.detected` Cat A, NOT sampled, P1 keyed by patient_id)
 *   - CDM v1.9 → v1.10 Amendment §3.1 normative landing (P-040)
 *   - AUDIT_EVENTS v5.12 amendment (target — currently at v5.3 in
 *     `lib/audit.ts`; v5.12 lands at Track 6 spec-corpus ratification)
 *   - I-019 (crisis detection always-on platform-floor)
 *   - I-027 (audit records always carry tenant_id)
 *   - I-003 (audit append-only; bare suppression forbidden)
 *   - FLOOR-020 (Cat A fail-closed same-tx audit emission discipline)
 */

import type {
  AuditAction,
  AuditDbClient,
  AuditEnvelope,
  AuditEnvelopeInput,
} from '../../lib/audit.js';
import { emitAudit } from '../../lib/audit.js';
import type { TenantId } from '../../lib/glossary.js';

import type {
  CrisisEventId,
  CrisisSeverity,
  CrisisType,
  ServerSignalId,
} from './internal/types.js';

/**
 * Source-surface enum for `crisis.detected` (mirrors
 * `crisis.detected.v1` DOMAIN_EVENT payload per SI-022 §4 line 916).
 * Identifies where on the platform the detection originated, BEFORE
 * routing into the Crisis Response slice's initiation wrapper.
 */
export type CrisisDetectionSourceSurface =
  | 'mode_1_chat'
  | 'community'
  | 'forms'
  | 'messaging';

/**
 * Forbidden-alias-typed placeholder set for the SI-022 §3 amendment
 * action IDs that have NOT yet landed in `lib/audit.ts`'s AuditAction
 * enum. Compile-time string-literal union prevents typos at every
 * call site even though the runtime payload is an unchecked string
 * cast at `crisisAuditPlaceholder()`.
 *
 * As the Crisis Response slice's write-path PRs land (Sprint 2-3:
 * acknowledge / respond / resolve / sweep / no-acknowledgement-
 * escalation), this union accumulates the additional ratified-but-
 * un-landed action IDs from SI-022 §3 (12 total Cat A + Cat C).
 * Sprint 2 PR 2 (this PR) adds only the `crisis.detected` member.
 */
type CrisisAuditActionPlaceholder = 'crisis.detected';

/**
 * crisisAuditPlaceholder — single sanctioned `as AuditAction` cast site
 * for SI-022 §3 amendment action IDs.
 *
 * Mirrors the `formsAuditPlaceholder()` pattern in
 * `src/modules/forms-intake/audit.ts` — see that file's JSDoc for the
 * full rationale. One-line summary: a contained cast that is
 * compile-time-typo-protected on input and grep-discoverable for the
 * future migration that removes the placeholder when AUDIT_EVENTS v5.12
 * lands in `lib/audit.ts`.
 *
 *   git grep "crisisAuditPlaceholder("
 *
 * gives the full migration list at the future ratification cycle.
 */
function crisisAuditPlaceholder(actionId: CrisisAuditActionPlaceholder): AuditAction {
  return actionId as AuditAction;
}

/**
 * emitCrisisDetectedAudit — Cat A fail-closed audit emission for the
 * lifecycle-bound `crisis.detected` event. MUST be called in the SAME
 * transaction as the `record_crisis_initiation()` SECDEF wrapper INSERT
 * per FLOOR-020 (handler ensures this by passing the same `tx` into
 * both the wrapper-query and this emitter — see
 * `internal/handlers/post-crisis-event.ts`).
 *
 * **actor_type discipline:**
 *   The initiation route is invoked by a clinician / on-call clinician /
 *   ai_mode1_service per SI-022 §7 `crisis_initiator` role membership.
 *   Sprint 2 PR 2 (this PR) is gated by `requireClinicianActorContext`
 *   per Layer B closest-available pattern (see PR 1 file header §"Layer
 *   B authorization DEFERRED"); the audit therefore carries
 *   `actor_type: 'clinician'`. When the JWT-role → DB-slice-role mapping
 *   lands (Phase A successor to SI-010 / SI-024.1) + the
 *   ai_mode1_service identity is wired through to `crisis_initiator`
 *   role membership, the call site's actor_type derivation expands to
 *   distinguish clinician vs ai_mode1_service per the actual bound
 *   identity. The 1-call-site discipline keeps this migration localized.
 *
 * **ai_workload_type / autonomy_level discipline:**
 *   `crisis.detected` is NOT in the I-012 action-class set (I-012
 *   governs prescribing / refill / medication-order execution
 *   confirmation per AUDIT_EVENTS v5.3 §I-012 closure rule). Per
 *   WORKLOAD_TAXONOMY v5.2 §1 nullability rule, non-AI events from
 *   non-AI actors carry `ai_workload_type: null` + `autonomy_level: null`.
 *   The clinician-initiated path uses null/null; an ai_mode1_service-
 *   initiated path (when wired) would carry
 *   `ai_workload_type: 'conversational_assistant'` +
 *   `autonomy_level: 'advisory'` per parity with the upstream
 *   `crisis_detection_trigger` Mode 1 audit envelope.
 */
export async function emitCrisisDetectedAudit(
  args: {
    tenantId: TenantId;
    actorAccountId: string;
    /** Actor's home tenant per F-4 attribution (R5 HIGH closure
     *  2026-05-15). For clinician role acting in own tenant this
     *  equals `tenantId`; passed explicitly so the call site
     *  threads `resolveActorTenantIdForAudit(req, ctx.tenantId)`
     *  consistently with the rest of the codebase. */
    actorTenantId: string;
    countryOfCare: string;
    crisisEventId: CrisisEventId;
    targetPatientId: string;
    serverSignalId: ServerSignalId;
    crisisType: CrisisType;
    severity: CrisisSeverity;
    regulatoryReportingEnabled: boolean;
    sourceSurface: CrisisDetectionSourceSurface;
  },
  tx: AuditDbClient,
): Promise<AuditEnvelope> {
  const input: AuditEnvelopeInput = {
    timestamp: new Date().toISOString(),
    tenant_id: args.tenantId,
    // Sprint 2 PR 2: handler is gated by requireClinicianActorContext
    // (Layer B closest-available per PR 1 header). When ai_mode1_service
    // identity is wired into crisis_initiator role membership, this
    // emitter's call site will branch on actor identity to emit
    // 'ai_workload' for those calls — handled at the call site, not
    // inside this helper (single-responsibility: this helper builds the
    // envelope from supplied args; the handler decides actor identity).
    actor_type: 'clinician',
    actor_id: args.actorAccountId,
    actor_tenant_id: args.actorTenantId,
    target_patient_id: args.targetPatientId,
    delegate_context: null,
    action: crisisAuditPlaceholder('crisis.detected'),
    category: 'A',
    audit_sensitivity_level: 'standard',
    resource_type: 'crisis_event',
    resource_id: args.crisisEventId,
    detail: {
      server_signal_id: args.serverSignalId,
      patient_id: args.targetPatientId,
      crisis_type: args.crisisType,
      severity: args.severity,
      regulatory_reporting_enabled: args.regulatoryReportingEnabled,
      // Per SI-022 §4 line 916 `crisis.detected.v1` DOMAIN_EVENT
      // payload contract. Mirrored on the audit envelope so post-
      // incident reconstruction can correlate the audit row to the
      // detecting surface without joining domain-events.
      source_surface: args.sourceSurface,
    },
    engine_versions: null,
    // crisis.detected is NOT an I-012 action-class member (I-012
    // governs prescribing/refill/medication-order). Per WORKLOAD_TAXONOMY
    // v5.2 §1 nullability rule, non-AI emissions from non-AI actors
    // carry null/null.
    ai_workload_type: null,
    autonomy_level: null,
    agent_id: null,
    agent_version: null,
    tool_call_id: null,
    memory_read_set_id: null,
    memory_write_set_id: null,
    supervising_policy_id: null,
    knowledge_source_versions: null,
    signals: null,
    override: null,
    linked_events: [],
    compliance_flags: [],
    country_of_care: args.countryOfCare,
    break_glass: null,
  };
  return emitAudit(input, tx);
}
