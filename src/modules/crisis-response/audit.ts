/**
 * crisis-response/audit.ts — Cat A audit envelope emitters for the
 * lifecycle-bound `crisis.*` events (SI-022 §3 normative table + CDM
 * v1.9→v1.10 Amendment normative landings).
 *
 * Emitters landed so far (union accumulates as Sprint 2 PRs merge):
 *   - `emitCrisisDetectedAudit`     — `crisis.detected`     (Sprint 2 PR 2, §3.1)
 *   - `emitCrisisAcknowledgedAudit` — `crisis.acknowledged` (Sprint 2 PR 3, §3.3)
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
 *   - `crisis.acknowledged` (Cat A; SI-022 §3 line 2) records the
 *     lifecycle transition into `acknowledged` by a clinician /
 *     care-team actor via `record_crisis_acknowledgement_claim()`
 *     (clinician_acknowledgement transition triples #7 + #8 —
 *     detected → acknowledged OR escalated → acknowledged).
 *
 * **Placeholder pattern (parity with `forms-intake/audit.ts`):**
 *   The action IDs `crisis.detected` / `crisis.acknowledged` are ratified
 *   in SI-022 §3 / CDM v1.9→v1.10 Amendment §3.1 + §3.3 (P-039 + P-040
 *   2026-05-21) but have NOT yet been landed in `src/lib/audit.ts`'s
 *   `AuditAction` enum (which tracks AUDIT_EVENTS v5.3 — the v5.12
 *   amendment lands in a future spec-corpus ratification cycle per
 *   Track 6). To unblock the Sprint 2 write-path PRs without leaning on
 *   a non-canonical enum edit, this helper uses the same single-
 *   sanctioned-cast pattern that `formsAuditPlaceholder()` uses: a typed
 *   string literal cast at exactly ONE call site, grep-discoverable for
 *   the future migration that replaces the placeholder with the canonical
 *   enum value.
 *
 *   When the v5.12 amendment ratifies and `lib/audit.ts` adds the
 *   `crisis.*` members to the `CategoryAAction` union, the migration is
 *   a 1-step grep:
 *     git grep "crisisAuditPlaceholder("
 *   Delete this helper + every call site reverts to passing the canonical
 *   string literal directly.
 *
 * **Hard rules per I-003 / I-019 / I-027:**
 *   - emission MUST run in the SAME tx as the corresponding SECDEF
 *     wrapper call (FLOOR-020 fail-closed; ratifier Option 2 deferred
 *     audit emission from SQL wrapper to application layer per
 *     `docs/crisis-response-implementation-plan.md` + README §"Option 2
 *     ratifier decision")
 *   - emission MUST carry tenant_id (I-027); the underlying `emitAudit()`
 *     re-validates this
 *   - bare suppression on emission failure is FORBIDDEN (I-003); the
 *     handler re-throws so the surrounding transaction rolls back, the
 *     lifecycle INSERT / SELECT rolls back with it, and the FLOOR-020
 *     contract holds (no orphan lifecycle row without its audit record)
 *
 * **Audit_sensitivity_level:** `'standard'` — neither the crisis
 *   lifecycle row nor the lifecycle_transition row include the
 *   intake_payload PHI (that's KMS-encrypted on the crisis_event table
 *   per ADR-021); the audit `detail` carries classification + identifier
 *   fields only.
 *
 * Spec references:
 *   - SI-022 Crisis Response Slice v1.0 §3 normative AUDIT_EVENTS table
 *     rows 1 + 2 (`crisis.detected` / `crisis.acknowledged` Cat A, NOT
 *     sampled, P1 keyed by patient_id)
 *   - CDM v1.9 → v1.10 Amendment §3.1 + §3.3 normative landing (P-040)
 *   - AUDIT_EVENTS v5.12 amendment (target — currently at v5.3 in
 *     `lib/audit.ts`; v5.12 lands at Track 6 spec-corpus ratification)
 *   - I-019 (crisis detection always-on platform-floor)
 *   - I-027 (audit records always carry tenant_id)
 *   - I-003 (audit append-only; bare suppression forbidden)
 *   - FLOOR-020 (Cat A fail-closed same-tx audit emission discipline)
 */

import type {
  ActorType,
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
  CrisisSweepExecutionId,
  CrisisSweepOutcome,
  CrisisType,
  ServerSignalId,
} from './internal/types.js';

/**
 * Source-surface enum for `crisis.detected` (mirrors
 * `crisis.detected.v1` DOMAIN_EVENT payload per SI-022 §4 line 916).
 * Identifies where on the platform the detection originated, BEFORE
 * routing into the Crisis Response slice's initiation wrapper.
 */
export type CrisisDetectionSourceSurface = 'mode_1_chat' | 'community' | 'forms' | 'messaging';

/**
 * SI-022 §7 ratified `crisis_initiator` slice-role membership maps
 * directly onto canonical AUDIT_EVENTS `actor_type` values:
 *
 *   - clinician + on-call clinician           → 'clinician'
 *   - ai_mode1_service (Mode 1 service acct)  → 'ai_workload'
 *
 * The SI-022 §3 `crisis.detected` row is normatively a Cat A audit
 * with `actor_type` derived from the bound actor identity, NOT a
 * gate-fixed literal. This map is the single sanctioned site for
 * deriving the canonical `ActorType` from the slice-role identity
 * the caller has authenticated as. Sprint 2 PR 2 (this PR) only
 * exercises the `'clinician'` branch (the JWT-role-to-DB-slice-role
 * mapping for ai_mode1_service lands in a successor PR — see file
 * header §"crisis_initiator role membership"); the `'ai_workload'`
 * branch is wired here so the future ai_mode1_service caller
 * automatically gets correct attribution without a 2nd code change.
 *
 * Per Codex R1 #201 finding 2 closure 2026-05-24: replaces the
 * earlier hard-coded `actor_type: 'clinician'` literal in
 * `emitCrisisDetectedAudit` envelope construction. The slice-role
 * → ActorType derivation is now centralized at this site.
 */
export type CrisisInitiatorActorIdentity = 'clinician' | 'on_call_clinician' | 'ai_mode1_service';

const CRISIS_INITIATOR_ACTOR_TYPE: Readonly<Record<CrisisInitiatorActorIdentity, ActorType>> = {
  clinician: 'clinician',
  on_call_clinician: 'clinician',
  ai_mode1_service: 'ai_workload',
};

/**
 * Forbidden-alias-typed placeholder set for the SI-022 §3 amendment
 * action IDs that have NOT yet landed in `lib/audit.ts`'s AuditAction
 * enum. Compile-time string-literal union prevents typos at every
 * call site even though the runtime payload is an unchecked string
 * cast at `crisisAuditPlaceholder()`.
 *
 * As the Crisis Response slice's write-path PRs land (Sprint 2-3:
 * detected / acknowledge / respond / resolve / sweep / no-acknowledgement-
 * escalation), this union accumulates the additional ratified-but-
 * un-landed action IDs from SI-022 §3 (12 total Cat A + Cat C).
 * Sprint 2 PR 2 landed `crisis.detected`; Sprint 2 PR 3 added
 * `crisis.acknowledged`; Sprint 2 PR 4 adds `crisis.responded` +
 * `crisis.resolved`.
 */
type CrisisAuditActionPlaceholder =
  | 'crisis.detected'
  | 'crisis.acknowledged'
  | 'crisis.responded'
  | 'crisis.resolved'
  | 'crisis.no_acknowledgement_escalation';

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
 * **actor_type discipline (Codex R1 #201 finding 2 closure 2026-05-24):**
 *   The initiation route is invoked by a clinician / on-call clinician /
 *   ai_mode1_service per SI-022 §7 `crisis_initiator` role membership.
 *   The emitter now takes a `crisisInitiatorIdentity` argument that
 *   drives the canonical `actor_type` via the
 *   `CRISIS_INITIATOR_ACTOR_TYPE` map (clinician / on_call_clinician →
 *   'clinician'; ai_mode1_service → 'ai_workload'). No hard-coded
 *   literal — caller passes the bound identity from
 *   `requireCrisisInitiatorActorContext`, the emitter derives the
 *   canonical ActorType.
 *
 *   Sprint 2 PR 2 (this PR) only exercises the `'clinician'` branch
 *   because the JWT-role → DB-slice-role mapping for ai_mode1_service
 *   has not yet landed (closest-available Layer B gate restricts to
 *   role='clinician'). When that mapping lands, the handler will
 *   route ai_mode1_service callers through the same emitter without
 *   any change to this file — only the handler's identity-derivation
 *   logic expands.
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
    /**
     * Per Codex R1 #201 finding 2 closure 2026-05-24: the bound
     * SI-022 §7 `crisis_initiator` slice-role identity (clinician /
     * on_call_clinician / ai_mode1_service). Drives the canonical
     * `actor_type` via the `CRISIS_INITIATOR_ACTOR_TYPE` map (no
     * hard-coded literal). When the JWT-role → DB-slice-role mapping
     * for on_call_clinician / ai_mode1_service lands, the handler
     * passes the actual bound identity here and the audit envelope
     * carries the correct actor_type automatically.
     */
    crisisInitiatorIdentity: CrisisInitiatorActorIdentity;
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
  const actorType = CRISIS_INITIATOR_ACTOR_TYPE[args.crisisInitiatorIdentity];
  // When the bound identity is ai_mode1_service the audit MUST carry the
  // Mode 1 AI workload taxonomy fields per WORKLOAD_TAXONOMY v5.2 §1
  // (parity with the upstream `crisis_detection_trigger` Mode 1 envelope).
  // Non-AI identities carry null/null per the same §1 nullability rule.
  const isAiInitiator = args.crisisInitiatorIdentity === 'ai_mode1_service';
  const input: AuditEnvelopeInput = {
    timestamp: new Date().toISOString(),
    tenant_id: args.tenantId,
    // Per Codex R1 #201 finding 2 closure: actor_type now derives from
    // the bound `crisisInitiatorIdentity` via CRISIS_INITIATOR_ACTOR_TYPE.
    // The hard-coded 'clinician' literal (and the call-site TODO it
    // carried) is gone.
    actor_type: actorType,
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
    // governs prescribing/refill/medication-order). Per
    // WORKLOAD_TAXONOMY v5.2 §1 nullability rule, non-AI emissions
    // from non-AI actors carry null/null; Mode 1 emissions populate
    // the AI fields per the upstream crisis_detection_trigger
    // envelope shape.
    ai_workload_type: isAiInitiator ? 'conversational_assistant' : null,
    autonomy_level: isAiInitiator ? 'advisory' : null,
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

/**
 * emitCrisisAcknowledgedAudit — Cat A fail-closed audit emission for
 * the lifecycle-bound `crisis.acknowledged` event. MUST be called in
 * the SAME transaction as the `record_crisis_acknowledgement_claim()`
 * SECDEF wrapper SELECT per FLOOR-020 (handler ensures this by passing
 * the same `tx` into both the wrapper-query and this emitter — see
 * `internal/handlers/post-crisis-acknowledge.ts`).
 *
 * **Resource binding:** the wrapper's RETURNS BIGINT is the
 * `crisis_event_lifecycle_transition.id` of the inserted (or replayed)
 * `acknowledged` row. The audit envelope's `resource_type` /
 * `resource_id` is the **crisis_event** itself — the audit's narrative
 * subject is the lifecycle entity, not the transition row. The
 * transition_id is carried in `detail.lifecycle_transition_id` so
 * post-incident reconstruction can join the audit to the specific
 * transition row without ambiguity.
 *
 * **from_state discipline:** two allowed from-states per migration 037
 * §1 (State Machines v1.1 §3 triples #7 `detected → acknowledged` + #8
 * `escalated → acknowledged`, both via clinician_acknowledgement). The
 * wrapper does NOT echo the from_state back; the handler carries it
 * explicitly on `detail.from_state`, read back AFTER the wrapper from the
 * committed `crisis_event_lifecycle_transition` row (keyed by the
 * wrapper-returned id). The pre-lock pre-fetch of
 * `crisis_event_current_state_v` (issued for the `patient_id` resolution +
 * tenant-scope pre-check) is NOT used for from_state — it is not
 * authoritative under a detected→escalated sweep race or same-actor replay
 * (Codex R1 #199 finding 1). Post-incident reconstruction can thus
 * identify which lifecycle path was taken without ambiguity.
 *
 * **actor_type discipline:**
 *   SI-022 §7 binds the `crisis_acknowledger` role to clinician +
 *   on-call clinician + care-team. Sprint 2 PR 3 (this PR) is gated by
 *   `requireClinicianActorContext` per Layer B closest-available
 *   pattern; the audit carries `actor_type: 'clinician'`. When the
 *   JWT-role → DB-slice-role membership mapping lands (Phase A
 *   successor to SI-010 / SI-024.1), the call site's actor_type
 *   derivation expands to distinguish the bound identity-class.
 *
 * **ai_workload_type / autonomy_level discipline:**
 *   `crisis.acknowledged` is NOT in the I-012 action-class set; the
 *   acknowledgement is by definition a clinician claim (no AI workload
 *   acknowledges a crisis on the patient's behalf at v1.0). Per
 *   WORKLOAD_TAXONOMY v5.2 §1 nullability rule, the envelope carries
 *   `ai_workload_type: null` + `autonomy_level: null`.
 */
export async function emitCrisisAcknowledgedAudit(
  args: {
    tenantId: TenantId;
    actorAccountId: string;
    /** Actor's home tenant per F-4 attribution. For clinician acting in
     *  own tenant this equals `tenantId`. */
    actorTenantId: string;
    countryOfCare: string;
    crisisEventId: CrisisEventId;
    targetPatientId: string;
    /** The wrapper's RETURNS BIGINT, serialized as a string by the pg
     *  driver. Carried as `detail.lifecycle_transition_id` for
     *  post-incident join. */
    lifecycleTransitionId: string;
    /** The from-state read back from the committed transition row — one
     *  of `'detected'` or `'escalated'` per migration 037 §1 allowed
     *  triples. Carried explicitly so post-incident reconstruction can
     *  identify which lifecycle path was taken without re-querying. */
    fromState: 'detected' | 'escalated';
  },
  tx: AuditDbClient,
): Promise<AuditEnvelope> {
  const input: AuditEnvelopeInput = {
    timestamp: new Date().toISOString(),
    tenant_id: args.tenantId,
    actor_type: 'clinician',
    actor_id: args.actorAccountId,
    actor_tenant_id: args.actorTenantId,
    target_patient_id: args.targetPatientId,
    delegate_context: null,
    action: crisisAuditPlaceholder('crisis.acknowledged'),
    category: 'A',
    audit_sensitivity_level: 'standard',
    resource_type: 'crisis_event',
    resource_id: args.crisisEventId,
    detail: {
      patient_id: args.targetPatientId,
      lifecycle_transition_id: args.lifecycleTransitionId,
      from_state: args.fromState,
      to_state: 'acknowledged',
      transition_reason: 'clinician_acknowledgement',
    },
    engine_versions: null,
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

/**
 * emitCrisisRespondedAudit — Cat A fail-closed audit emission for the
 * lifecycle-bound `crisis.responded` event. MUST be called in the SAME
 * transaction as the `record_crisis_response()` SECDEF wrapper SELECT
 * per FLOOR-020 (handler ensures this by passing the same `tx` into
 * both the wrapper-query and this emitter — see
 * `internal/handlers/post-crisis-respond.ts`).
 *
 * **Resource binding:** identical to acknowledged — the wrapper
 * RETURNS BIGINT lifecycle_transition_id; the audit's narrative
 * subject is the crisis_event entity, with the transition_id carried
 * in `detail.lifecycle_transition_id` for post-incident join. The
 * from_state for `crisis.responded` is always `acknowledged` per
 * migration 037 §2 (single allowed from-state per State Machines v1.1
 * §3 triple #9 `acknowledged → responded clinician_response`).
 *
 * **actor_type discipline:**
 *   SI-022 §7 binds the `crisis_responder` role to clinician + on-call
 *   clinician. Sprint 2 PR 4 (this PR) is gated by
 *   `requireClinicianActorContext` per Layer B closest-available
 *   pattern; the audit carries `actor_type: 'clinician'`. When the
 *   JWT-role → DB-slice-role membership mapping lands (Phase A
 *   successor to SI-010 / SI-024.1), the call site's actor_type
 *   derivation expands to distinguish the bound identity-class
 *   (clinician vs on-call-clinician).
 *
 * **ai_workload_type / autonomy_level discipline:**
 *   `crisis.responded` is NOT in the I-012 action-class set; the
 *   response is by definition a clinician intervention (no AI workload
 *   responds to a crisis on the patient's behalf at v1.0). Per
 *   WORKLOAD_TAXONOMY v5.2 §1 nullability rule, the envelope carries
 *   `ai_workload_type: null` + `autonomy_level: null`.
 */
export async function emitCrisisRespondedAudit(
  args: {
    tenantId: TenantId;
    actorAccountId: string;
    /** Actor's home tenant per F-4 attribution. For clinician acting
     *  in own tenant this equals `tenantId`. */
    actorTenantId: string;
    countryOfCare: string;
    crisisEventId: CrisisEventId;
    targetPatientId: string;
    /** The wrapper's RETURNS BIGINT, serialized as a string by the pg
     *  driver. */
    lifecycleTransitionId: string;
  },
  tx: AuditDbClient,
): Promise<AuditEnvelope> {
  const input: AuditEnvelopeInput = {
    timestamp: new Date().toISOString(),
    tenant_id: args.tenantId,
    actor_type: 'clinician',
    actor_id: args.actorAccountId,
    actor_tenant_id: args.actorTenantId,
    target_patient_id: args.targetPatientId,
    delegate_context: null,
    action: crisisAuditPlaceholder('crisis.responded'),
    category: 'A',
    audit_sensitivity_level: 'standard',
    resource_type: 'crisis_event',
    resource_id: args.crisisEventId,
    detail: {
      patient_id: args.targetPatientId,
      lifecycle_transition_id: args.lifecycleTransitionId,
      // Single allowed from-state per migration 037 §2 + State Machines
      // v1.1 §3 triple #9 (acknowledged → responded clinician_response).
      from_state: 'acknowledged',
      to_state: 'responded',
      transition_reason: 'clinician_response',
    },
    engine_versions: null,
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

/**
 * emitCrisisResolvedAudit — Cat A fail-closed audit emission for the
 * lifecycle-bound `crisis.resolved` event. MUST be called in the SAME
 * transaction as the `record_crisis_resolution()` SECDEF wrapper SELECT
 * per FLOOR-020 (handler ensures this by passing the same `tx` into
 * both the wrapper-query and this emitter — see
 * `internal/handlers/post-crisis-resolve.ts`).
 *
 * **Two allowed from-states per migration 037 §3:**
 *   - `responded → resolved` (State Machines v1.1 §3 triple #10)
 *   - `escalated → resolved` (State Machines v1.1 §3 triple #11)
 *
 * The wrapper does NOT echo the from_state back; the handler carries it
 * explicitly on `detail.from_state`, read back AFTER the wrapper from the
 * committed `crisis_event_lifecycle_transition` row (keyed by the
 * wrapper-returned id). The pre-lock pre-fetch of
 * `crisis_event_current_state_v` (issued for the `patient_id` resolution +
 * tenant-scope pre-check) is NOT used for from_state — it is not
 * authoritative under a responded_no_resolution_timeout sweep that
 * transitions responded→escalated in the pre-fetch→wrapper-lock window
 * (Codex R1 #202 — same closure as PR3 acknowledge finding 1). The
 * committed transition row carries the exact from_state (`responded` or
 * `escalated`) the wrapper recorded under its SELECT FOR UPDATE lock.
 *
 * **Resource binding:** identical to acknowledged + responded — the
 * audit's narrative subject is the crisis_event entity; the
 * transition_id is in `detail.lifecycle_transition_id`.
 *
 * **actor_type / ai_workload_type discipline:** identical to responded
 * (clinician action; null/null for AI fields).
 */
export async function emitCrisisResolvedAudit(
  args: {
    tenantId: TenantId;
    actorAccountId: string;
    actorTenantId: string;
    countryOfCare: string;
    crisisEventId: CrisisEventId;
    targetPatientId: string;
    /** The wrapper's RETURNS BIGINT, serialized as a string. */
    lifecycleTransitionId: string;
    /** The from-state read back from the committed transition row — one
     *  of `'responded'` or `'escalated'` per migration 037 §3 allowed
     *  triples. Carried explicitly so post-incident reconstruction can
     *  identify which lifecycle path was taken without re-querying. */
    fromState: 'responded' | 'escalated';
  },
  tx: AuditDbClient,
): Promise<AuditEnvelope> {
  const input: AuditEnvelopeInput = {
    timestamp: new Date().toISOString(),
    tenant_id: args.tenantId,
    actor_type: 'clinician',
    actor_id: args.actorAccountId,
    actor_tenant_id: args.actorTenantId,
    target_patient_id: args.targetPatientId,
    delegate_context: null,
    action: crisisAuditPlaceholder('crisis.resolved'),
    category: 'A',
    audit_sensitivity_level: 'standard',
    resource_type: 'crisis_event',
    resource_id: args.crisisEventId,
    detail: {
      patient_id: args.targetPatientId,
      lifecycle_transition_id: args.lifecycleTransitionId,
      from_state: args.fromState,
      to_state: 'resolved',
      transition_reason: 'clinician_resolution',
    },
    engine_versions: null,
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

/**
 * emitCrisisNoAcknowledgementEscalationAudit — Cat A fail-closed audit
 * emission for the lifecycle-bound `crisis.no_acknowledgement_escalation`
 * event. MUST be called in the SAME transaction as the
 * `execute_crisis_no_acknowledgement_sweep()` SECDEF wrapper SELECT per
 * FLOOR-020 (handler ensures this by passing the same `tx` into both
 * the wrapper-query and this emitter — see
 * `internal/handlers/post-crisis-sweep.ts`).
 *
 * **When to call (handler-side discipline):**
 *   The handler emits this audit ONLY when the sweep wrapper's outcome
 *   is `'completed_escalated'` — the only outcome where an escalation
 *   `crisis_event_lifecycle_transition` row was actually inserted. The
 *   other 4 outcomes do NOT emit `crisis.no_acknowledgement_escalation`:
 *
 *     - `'claimed_new'`        — should not be returned from the wrapper
 *                                 normally (wrapper continues past claim
 *                                 to emission phase before returning;
 *                                 reserved-for-future)
 *     - `'claimed_takeover'`   — same as above
 *     - `'already_completed'`  — idempotent replay of a previously-
 *                                 committed sweep; the original sweep's
 *                                 audit already exists; re-emitting
 *                                 would create a duplicate audit row
 *                                 for a single ratified state change
 *                                 (violates I-003 hash-chain semantics)
 *     - `'completed_no_op'`    — current state is acknowledged/responded/
 *                                 resolved; no escalation transition
 *                                 emitted; nothing to audit per SI-022 §6
 *                                 (the sweep simply records that it ran
 *                                 and found nothing to escalate)
 *
 *   Bare suppression on emission failure is FORBIDDEN per I-003. If
 *   `emitAudit()` raises, the handler re-throws so the surrounding tx
 *   rolls back atomically with the wrapper's lifecycle INSERT + sweep
 *   completion UPDATE. The next scheduler firing re-claims (or
 *   takes-over) the sweep row and retries — no escalation evidence is
 *   silently dropped.
 *
 * **actor_type discipline:**
 *   The sweep endpoint is operator-invoked (cron/scheduler), gated at
 *   the Fastify layer by `requireAdminActorContext` per closest-
 *   available role-gate pattern (the canonical `crisis_sweep_scheduler`
 *   identity has no dedicated JWT role at v0.1 pending SI-024 / Phase A
 *   role-mapping; admin is the closest-available gate that does NOT
 *   widen to clinician / patient — see file header in the handler).
 *   The audit carries `actor_type: 'system'` because the scheduler is a
 *   non-human background worker; this matches the WORKLOAD_TAXONOMY
 *   v5.2 §1 nullability rule for non-AI system actors (`ai_workload_type:
 *   null` + `autonomy_level: null`). When SI-024 lands the canonical
 *   scheduler-role mapping, the call-site's `actor_type` derivation may
 *   refine — single-call-site discipline keeps that migration localized.
 *
 * **ai_workload_type / autonomy_level discipline:**
 *   The no-ack escalation is NOT in the I-012 action-class set (I-012
 *   governs prescribing / refill / medication-order execution
 *   confirmation per AUDIT_EVENTS v5.3 §I-012 closure rule). The sweep
 *   scheduler is a non-AI background worker. Per WORKLOAD_TAXONOMY
 *   v5.2 §1 nullability rule, non-AI emissions from non-AI actors
 *   carry `ai_workload_type: null` + `autonomy_level: null`.
 *
 * **target_patient_id sourcing:**
 *   The wrapper's RETURNS TABLE does NOT echo patient_id (it returns
 *   `sweep_execution_id UUID, fencing_token BIGINT, outcome TEXT`). The
 *   handler resolves patient_id via a side SELECT against
 *   `crisis_event_current_state_v` under
 *   `withDbRole('crisis_event_staff_reader', ...)` in the SAME tx
 *   BEFORE the wrapper call — that read also serves as a tenant-scope
 *   guard (0 rows on cross-tenant or missing → tenant-blind 404 per
 *   I-025 before the wrapper is ever invoked). The audit envelope's
 *   `target_patient_id` is required per the P1 audit partitioning rule
 *   (SI-022 §3 row 5 + I-027).
 *
 * **detail payload:**
 *   Carries sweep-execution metadata + lifecycle transition correlation
 *   (no PHI). Fields:
 *     - patient_id                     UUID (P1 partition mirror)
 *     - sweep_execution_id             UUID (wrapper RETURNS field)
 *     - fencing_token                  BIGINT-as-string (wrapper RETURNS
 *                                       field; serialized as string by
 *                                       pg driver for safe JSON round-
 *                                       trip past JS Number.MAX_SAFE_INT)
 *     - sweep_outcome                  always 'completed_escalated' at
 *                                       this emit point (the handler
 *                                       calls this ONLY for that outcome
 *                                       per the discipline above)
 *     - target_obligation_generation   INT (input echo for correlation)
 *     - claim_ttl_seconds              INT (input echo for correlation)
 *     - worker_id                      TEXT (scheduler worker identity
 *                                       passed through to wrapper; aids
 *                                       post-incident reconstruction of
 *                                       which scheduler fired)
 */
export async function emitCrisisNoAcknowledgementEscalationAudit(
  args: {
    tenantId: TenantId;
    /** Actor account id for the scheduler worker. Sprint 2 PR 6 gates
     *  via `requireAdminActorContext` so this is the admin actor's
     *  accountId; when SI-024 lands the canonical
     *  `crisis_sweep_scheduler` JWT-role mapping, this will be the
     *  scheduler worker's principal id. */
    actorAccountId: string;
    /** Actor's home tenant per F-4 attribution. For an admin acting in
     *  the same tenant this equals `tenantId`; for cross-tenant
     *  platform-admin invocation this carries the admin's home
     *  tenant_id explicitly. */
    actorTenantId: string;
    countryOfCare: string;
    crisisEventId: CrisisEventId;
    targetPatientId: string;
    sweepExecutionId: CrisisSweepExecutionId;
    /** BIGINT serialized as string by the pg driver (safe JSON
     *  round-trip past JS Number.MAX_SAFE_INTEGER). */
    fencingToken: string;
    /** Always `'completed_escalated'` at this emit point per the
     *  emission discipline documented above; carried explicitly so the
     *  detail payload mirrors the wrapper's full RETURNS shape for
     *  post-incident correlation. */
    sweepOutcome: Extract<CrisisSweepOutcome, 'completed_escalated'>;
    targetObligationGeneration: number;
    claimTtlSeconds: number;
    workerId: string;
  },
  tx: AuditDbClient,
): Promise<AuditEnvelope> {
  const input: AuditEnvelopeInput = {
    timestamp: new Date().toISOString(),
    tenant_id: args.tenantId,
    // Sweep scheduler is a non-human background worker. When SI-024
    // lands the canonical `crisis_sweep_scheduler` JWT-role mapping,
    // the call site MAY branch on bound identity to refine actor_type;
    // for v0.1 the operator-invoked admin path carries `system`.
    actor_type: 'system',
    actor_id: args.actorAccountId,
    actor_tenant_id: args.actorTenantId,
    target_patient_id: args.targetPatientId,
    delegate_context: null,
    action: crisisAuditPlaceholder('crisis.no_acknowledgement_escalation'),
    category: 'A',
    audit_sensitivity_level: 'standard',
    resource_type: 'crisis_event',
    resource_id: args.crisisEventId,
    detail: {
      patient_id: args.targetPatientId,
      sweep_execution_id: args.sweepExecutionId,
      fencing_token: args.fencingToken,
      sweep_outcome: args.sweepOutcome,
      target_obligation_generation: args.targetObligationGeneration,
      claim_ttl_seconds: args.claimTtlSeconds,
      worker_id: args.workerId,
      // Single allowed to_state path at this emit point per migration
      // 038 §1.2: latest state was either `detected` or `escalated`,
      // and the wrapper escalates to `escalated`. The transition
      // reason is `no_acknowledgement_timeout` for detected→escalated
      // OR `tier_progression_no_acknowledgement` for escalated→
      // escalated. Carried for post-incident correlation; the
      // canonical row in `crisis_event_lifecycle_transition` is
      // authoritative.
      to_state: 'escalated',
    },
    engine_versions: null,
    // Per WORKLOAD_TAXONOMY v5.2 §1 nullability rule, non-AI emissions
    // from non-AI actors carry null/null.
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
