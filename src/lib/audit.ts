/**
 * audit.ts — AUDIT_EVENTS v5.3 envelope emitter with hash chain.
 *
 * Version: bumped v5.2 → v5.3 at P-011 / SI-001 closure 2026-05-11. v5.3 adds
 * 7 net-new Category A action IDs (6 `medication_request.*` lifecycle events +
 * 1 `prescribing.protocol_authorization_granted` clinician confirmation event)
 * and amends the §I-012 closure rule's authoritative I-012 action-class set to
 * include `prescribing.protocol_authorization_granted`. Live emissions of the
 * new I-012 confirmation action MUST resolve against v5.3 or later. Carry-
 * forward prose from v5.2 is preserved unchanged.
 *
 * Purpose:
 *   Type-safe audit event emission per AUDIT_EVENTS v5.3. Enforces:
 *     - Every record carries `tenant_id` (I-027)
 *     - Append-only semantics (I-003): throws on any attempt to suppress emission
 *     - SHA-256 hash chain per patient partition (AUDIT_EVENTS v5.2 §hash-chain;
 *       carried forward unchanged at v5.3)
 *     - `audit_sensitivity_level` required on every record (I-031)
 *     - `ai_workload_type` + `autonomy_level` rules per I-012 closure rule
 *       (v5.3 amendment includes `prescribing.protocol_authorization_granted`
 *       in the authoritative I-012 action-class set)
 *     - Sentinel values (`rejected_invalid_attempt`, `n/a`) validated against
 *       their permitted-use contexts
 *
 * Spec references:
 *   - I-003: audit trail is immutable and append-only; bare suppression is forbidden.
 *   - I-027: every audit record carries `tenant_id`.
 *   - I-031: research data export emits at `audit_sensitivity_level = high_pii`.
 *   - AUDIT_EVENTS v5.3 (bumped from v5.2 at P-011 / SI-001 closure 2026-05-11):
 *       * Envelope schema (all required fields; carries forward v5.2 unchanged)
 *       * Hash chain construction (§hash-chain; carries forward v5.2 unchanged)
 *       * I-012 closure rule with v5.3 amendment adding
 *         prescribing.protocol_authorization_granted to the authoritative set
 *       * Sentinel `rejected_invalid_attempt` valid ONLY on `*.execution_rejected` events
 *       * Sentinel `n/a` valid ONLY on I-012 clinician-only approval records with no AI upstream
 *
 * Design decisions on the action enum (open question documented below):
 *   The spec defines a closed action catalog. We model the category-prefixed string
 *   union rather than an enum to keep the type extensible as slices add actions.
 *   Runtime validation in `emitAudit()` is the enforcement layer.
 *
 * Open questions for Engineering Lead:
 *   - Hash chain partition: partitioned by `target_patient_id`. For platform-
 *     scope events with no patient (e.g., `market_launch_approved`), a synthetic
 *     partition key is needed. Engineering Lead to specify the partition key
 *     convention for non-patient audit events.
 *   - `assertAuditEmittedFor()`: currently tracks emission in-process (in-memory
 *     map). Production implementation queries the audit store. Suitable for
 *     integration tests; not a production safety check.
 *
 * Resolved (Codex foundation-layer review patch v0.2 — 2026-05-02):
 *   - DB persistence: `emitAudit()` now performs the durable INSERT into
 *     `audit_records` (migration 002) when called with a transaction handle.
 *     In production, calling without a `tx` throws — bare suppression would
 *     itself be an I-003 violation. Test-only callers may omit `tx` under
 *     NODE_ENV=test to use the in-memory `_emissionLog` for unit-test
 *     assertions via `assertAuditEmittedFor()`.
 */

import crypto from 'crypto';

import { z } from 'zod';

import type { TenantId } from './glossary.js';

// ---------------------------------------------------------------------------
// AUDIT_EVENTS v5.2 — action catalog (closed string union by category prefix)
// ---------------------------------------------------------------------------

/** Category A — Safety-critical clinical actions */
type CategoryAAction =
  | 'prescribing.initiated'
  | 'prescribing.approved'
  | 'prescribing.declined'
  | 'prescribing.modified'
  | 'prescribing.protocol_authorization_granted' // added v5.3 (P-011 / SI-001 closure 2026-05-11) — I-012 confirmation event for the protocol-authorized prescribing route
  | 'refill.approved'
  | 'refill.declined'
  | 'protocol_authorized_prescribing'
  | 'protocol_authorized_refill_renewal'
  | 'protocol_authorized_dispensing_release'
  | 'prescribing.execution_rejected' // added v5.2 — I-012 bare-suppression closure
  | 'refill.execution_rejected' // added v5.2 — I-012 bare-suppression closure
  | 'medication_order.execution_rejected' // added v5.2 — I-012 bare-suppression closure
  // MedicationRequest lifecycle (added v5.3 under P-011 / SI-001 closure 2026-05-11)
  | 'medication_request.drafted'
  | 'medication_request.submitted_for_review'
  | 'medication_request.interaction_evaluation_completed'
  | 'medication_request.discontinued'
  | 'medication_request.superseded'
  | 'medication_request.expired'
  | 'interaction_signal_override'
  | 'herb_drug_signal_override'
  | 'dispensing_release'
  | 'adverse_event_reported'
  | 'adverse_event_investigated'
  | 'adverse_event_regulatory_reported'
  | 'emergency_escalation'
  | 'crisis_detection_trigger'
  | 'safety_hold_activated'
  | 'safety_hold_resolved'
  | 'bridge_supply_authorized'
  | 'interaction_engine_evaluation'
  // Med-Interaction Engine (SI-019) — 2 Cat A action IDs added under
  // AUDIT_EVENTS v5.8 → v5.9 (P-034 RATIFIED 2026-05-21; CDM v1.6 → v1.7
  // Amendment §4). The canonical `medication_interaction.*` namespace
  // supersedes the legacy bare `interaction_engine_evaluation` id above for
  // new emissions. NB: the amendment's summary line states "4 Cat A + 2 Cat B"
  // while its per-row enumeration table (the authoritative form) lists these 2
  // as Cat A and the other 4 as Cat B — observed spec inconsistency surfaced to
  // the AUDIT_EVENTS owner; the per-row table governs here.
  | 'medication_interaction.engine_evaluation_completed' // Cat A — engine evaluator on every evaluation row INSERT (success or no-signals)
  | 'medication_interaction.signal_emitted' // Cat A — engine evaluator on every signal row INSERT (one per signal)
  | 'herb_drug_engine_evaluation'
  | 'ai_mode_2_evaluation'
  | 'ai_mode_2_physician_approve'
  | 'ai_mode_2_physician_modify'
  | 'ai_mode_2_physician_decline';

/** Category B — Governance and configuration actions */
type CategoryBAction =
  | 'protocol_activated'
  | 'protocol_deactivated'
  | 'guardrail_template_deployed'
  | 'guardrail_template_rolled_back'
  | 'guardrail_template_test_run'
  | 'moderation_policy_changed'
  | 'market_launch_approved'
  | 'market_paused'
  | 'market_retired'
  | 'forms_eligibility_logic_edited'
  | 'forms_approval_governance_edited'
  | 'knowledge_base_updated'
  | 'clinical_exclusion_rule_changed'
  | 'dual_control_approval'
  | 'fake_med_flag_raised'
  | 'fake_med_flag_resolved'
  | 'config_change_validated'
  | 'incident_opened'
  | 'incident_resolved'
  | 'signal_enforcement_trigger'
  // Med-Interaction Engine (SI-019) — 4 Cat B action IDs added under
  // AUDIT_EVENTS v5.8 → v5.9 (P-034 RATIFIED 2026-05-21; CDM v1.6 → v1.7
  // Amendment §4 per-row enumeration table).
  | 'medication_interaction.engine_evaluation_failed' // engine evaluator on evaluation failure (timeout, KB unreachable, schema mismatch)
  | 'medication_interaction.engine_knowledge_base_updated' // admin endpoint on dual-control KB version bump (per I-015)
  | 'medication_interaction.engine_signal_enforcement_override' // dual-control safety pathway on critical/major-block override
  | 'medication_interaction.engine_projection_divergence_detected' // hourly reconciliation cron on MV-vs-transition-table divergence
  // Research events (added v5.2 per ADR-028)
  | 'research.consent_granted'
  | 'research.consent_revoked'
  | 'research.dsa_activated'
  | 'research.cohort_defined'
  | 'research.export_initiated'
  | 'research.export_completed'
  // Marketing events (added v5.2 per ADR-027)
  | 'marketing.surface_rendered'
  | 'marketing.surface_drift';

/** Category C — Operational and engagement actions */
type CategoryCAction =
  | 'patient_account_created'
  | 'patient_identity_verified'
  | 'consent_granted'
  | 'consent_revoked'
  | 'delegation_setup'
  | 'delegation_revoked'
  | 'message_sent'
  | 'consult_booked'
  | 'consult_started'
  | 'consult_completed'
  | 'consult_converted_to_sync'
  | 'lab_uploaded'
  | 'lab_ai_interpreted'
  | 'lab_clinician_reviewed'
  | 'community_post_created'
  | 'community_post_flagged'
  | 'community_moderation_action'
  | 'notification_sent'
  | 'payment_processed'
  | 'payment_failed'
  | 'delivery_status_updated'
  | 'rpm_metric_submitted'
  | 'rpm_alert_triggered'
  | 'ai_mode_1_session_started'
  | 'ai_mode_1_escalation'
  | 'refill_reminder_sent'
  | 'login_successful'
  | 'login_failed';

export type AuditAction = CategoryAAction | CategoryBAction | CategoryCAction;
export type AuditCategory = 'A' | 'B' | 'C';
export type AuditSensitivityLevel = 'standard' | 'high_pii';

// Authoritative I-012 action-class set per AUDIT_EVENTS v5.3 §I-012 closure rule
// (bumped v5.2 → v5.3 at P-011 / SI-001 closure 2026-05-11; v5.3 amendment adds
// `prescribing.protocol_authorization_granted` to the authoritative set and
// broadens the future-extension carve-out to include `prescribing.*` confirmation
// actions added by an I-012-amending SI promotion). This set is the single source
// of truth — do not re-declare in WORKLOAD_TAXONOMY, AUTONOMY_LEVELS,
// STATE_MACHINES, or TYPES.
const I012_ACTION_CLASS_SET = new Set<AuditAction>([
  'prescribing.initiated',
  'prescribing.approved',
  'prescribing.declined',
  'prescribing.modified',
  'prescribing.protocol_authorization_granted', // added v5.3 under P-011
  'refill.approved',
  'refill.declined',
  'protocol_authorized_prescribing',
  'protocol_authorized_refill_renewal',
  'protocol_authorized_dispensing_release',
  'prescribing.execution_rejected',
  'refill.execution_rejected',
  'medication_order.execution_rejected',
]);

const EXECUTION_REJECTED_ACTIONS = new Set<AuditAction>([
  'prescribing.execution_rejected',
  'refill.execution_rejected',
  'medication_order.execution_rejected',
]);

const RESEARCH_HIGH_PII_ACTIONS = new Set<AuditAction>([
  'research.export_initiated',
  'research.export_completed',
]);

// ---------------------------------------------------------------------------
// Audit envelope types
// ---------------------------------------------------------------------------

export type ActorType =
  | 'patient'
  | 'clinician'
  | 'pharmacist'
  | 'operator'
  | 'delegate'
  | 'protocol_engine' // legacy alias — map to ai_workload for new v1.10+ code
  | 'ai_workload' // canonical v1.10+ actor type
  | 'ai_mode_1' // deprecated alias; preserved for backward-compat reads only
  | 'ai_mode_2' // deprecated alias; preserved for backward-compat reads only
  | 'system'
  | 'platform_admin';

export type AIWorkloadType =
  | 'conversational_assistant'
  | 'protocol_execution'
  | 'autonomous_agent' // RESERVED
  | 'multi_agent_supervisor' // RESERVED
  | 'tool_using_agent' // RESERVED
  | 'rejected_invalid_attempt' // SENTINEL — execution_rejected events only
  | 'n/a' // SENTINEL — I-012 clinician-only approval records only
  | null; // nullable for non-AI events / legacy backfill

export type AutonomyLevel =
  | 'advisory'
  | 'suggestion'
  | 'action_with_confirm'
  | 'action_with_audit_only' // RESERVED
  | 'fully_autonomous' // RESERVED
  | 'rejected_invalid_attempt' // SENTINEL — execution_rejected events only
  | 'n/a' // SENTINEL — I-012 clinician-only approval records only
  | null; // nullable for non-AI events / legacy backfill

export interface HashChain {
  partition: string; // target_patient_id
  sequence_number: number;
  previous_hash: string;
  record_hash: string;
}

export interface AuditEnvelope {
  audit_id: string; // 'aud_<ULID>'
  timestamp: string; // ISO 8601 with timezone
  tenant_id: TenantId; // I-027: required on every record
  actor_type: ActorType;
  actor_id: string;
  actor_tenant_id: string | null; // null only for platform_admin actors
  target_patient_id: string | null; // null for platform-scope events (e.g., forms_template_created); the DB trigger uses 'PLATFORM' sentinel for the hash-chain partition in that case (matching the SQL COALESCE(target_patient_id, 'PLATFORM') in migration 002 audit_records_hash_insert)
  delegate_context: { delegate_id: string; scope: string } | null;
  action: AuditAction;
  category: AuditCategory;
  audit_sensitivity_level: AuditSensitivityLevel; // required — default 'standard'
  resource_type: string;
  resource_id: string;
  detail: Record<string, unknown>;
  engine_versions: Record<string, string> | null;
  // Workload taxonomy fields (v5.2)
  ai_workload_type: AIWorkloadType;
  autonomy_level: AutonomyLevel;
  // Reserved agentic-context fields (nullable; populate when capability activates)
  agent_id: string | null;
  agent_version: string | null;
  tool_call_id: string | null;
  memory_read_set_id: string | null;
  memory_write_set_id: string | null;
  supervising_policy_id: string | null;
  knowledge_source_versions: Array<{ knowledge_base_id: string; version: string }> | null;
  signals: Array<{
    signal_id: string;
    severity: string;
    source_engine: string;
    check_class: string;
  }> | null;
  override: { signal_id: string; rationale: string; clinician_id: string } | null;
  linked_events: string[];
  compliance_flags: string[];
  country_of_care: string; // ISO 3166-1 alpha-2
  break_glass: {
    session_id: string;
    reason: string;
    authorized_until: string;
    privacy_officer_review_status: 'pending' | 'reviewed';
  } | null;
  hash_chain: HashChain;
}

// Input type — caller provides all fields except hash_chain and audit_id (computed here)
export type AuditEnvelopeInput = Omit<AuditEnvelope, 'audit_id' | 'hash_chain'>;

// ---------------------------------------------------------------------------
// Zod validation schema for required fields
// ---------------------------------------------------------------------------

const AuditEnvelopeInputSchema = z.object({
  tenant_id: z.string().min(1, 'tenant_id is required on every audit record (I-027)'),
  actor_type: z.string().min(1),
  actor_id: z.string().min(1),
  // Nullable for platform-scope events (e.g., forms_template_created,
  // market_launch_approved); the DB trigger maps NULL to the 'PLATFORM'
  // hash-chain partition sentinel per migration 002. (Patch v0.4 — 2026-05-02
  // per Codex first-handler-implementation CRITICAL finding closure: prior
  // schema rejected null and forced callers to pass a synthetic empty string
  // that itself failed `min(1)` validation, breaking every platform-scope
  // audit emission end-to-end.)
  target_patient_id: z.union([z.string().min(1), z.null()]),
  action: z.string().min(1),
  category: z.enum(['A', 'B', 'C']),
  audit_sensitivity_level: z.enum(['standard', 'high_pii']),
  resource_type: z.string().min(1),
  resource_id: z.string().min(1),
  // zod 4: z.record(V) is now z.record(K, V) — explicit key schema required.
  detail: z.record(z.string(), z.unknown()),
  country_of_care: z.string().length(2, 'country_of_care must be ISO 3166-1 alpha-2'),
  timestamp: z.string().min(1),
});

// ---------------------------------------------------------------------------
// In-process emission tracker (test / assertion support)
// STUB: production implementation queries audit store.
// ---------------------------------------------------------------------------

type EmissionRecord = { actionId: string; action: AuditAction; emittedAt: Date };
const _emissionLog: EmissionRecord[] = [];

/**
 * assertAuditEmittedFor — verifies an audit record was emitted for a given
 * `actionId` and `action` in this process lifetime.
 *
 * For integration tests and runtime invariant checks. Does NOT query the
 * persistent audit store — that is a separate verification path.
 *
 * @throws If no matching emission is found.
 */
export function assertAuditEmittedFor(actionId: string, action: AuditAction): void {
  const found = _emissionLog.some((r) => r.actionId === actionId && r.action === action);
  if (!found) {
    throw new Error(
      `assertAuditEmittedFor: no audit emission found for actionId="${actionId}" action="${action}". ` +
        'Per I-003, bare suppression of audit events is forbidden.',
    );
  }
}

// ---------------------------------------------------------------------------
// Hash chain helper
// ---------------------------------------------------------------------------

/**
 * Compute the genesis hash for a partition. Per AUDIT_EVENTS v5.2 hash-chain
 * construction, the FIRST record in any partition uses prev_hash =
 * SHA-256('GENESIS:' || partition_key). The DB-side trigger
 * (audit_records_hash_insert in migration 002) computes the same value
 * canonically; this app-side helper exists so the envelope returned by
 * emitAudit is byte-identical to what the DB stored.
 *
 * The partition key is `tenant_id || ':' || COALESCE(target_patient_id,
 * 'PLATFORM')` per the trigger's HIGH-1 closure 2026-05-03 — keeping the
 * app- and DB-side derivations aligned is what lets the chain walker
 * verify both layers with a single canonicalization function.
 */
function computeGenesisHash(partitionKey: string): string {
  return crypto.createHash('sha256').update(`GENESIS:${partitionKey}`).digest('hex');
}

function computeRecordHash(envelope: Omit<AuditEnvelope, 'hash_chain'>): string {
  return crypto.createHash('sha256').update(JSON.stringify(envelope)).digest('hex');
}

/**
 * Look up the most recent record_hash + sequence_number for a partition
 * within the caller's tenant.
 *
 * Partition key = `tenant_id || ':' || COALESCE(target_patient_id, 'PLATFORM')`
 * per the trigger's HIGH-1 closure 2026-05-03. The DB query MUST also
 * filter by tenant_id — when the calling transaction can see rows from
 * multiple tenants (e.g., during break-glass or platform-admin work),
 * a tenant-blind partition lookup would return another tenant's
 * record_hash and the returned envelope's `hash_chain.previous_hash`
 * would be wrong (the DB trigger then overwrites the storage value, but
 * the envelope returned to the caller carries the wrong value through
 * to the wire). HIGH-4 closure 2026-05-03 per Codex CI-fix verify-r3.
 *
 * When a `tx` is provided, queries the real audit_records table within
 * the caller's transaction.
 *
 * When `tx` is omitted, returns genesis values — used by:
 *   - NODE_ENV=test paths where unit tests don't carry a DB context
 *   - The first record in any partition (DB returns no rows; we return
 *     genesis regardless of whether tx was passed)
 *
 * **Why no `FOR UPDATE`** (Codex publishVersion-r1 follow-on 2026-05-03):
 * the prior version held a `FOR UPDATE` row lock on the latest record
 * for serialization, but (a) the BEFORE INSERT trigger now holds
 * `pg_advisory_xact_lock` per partition (HIGH-3 closure), and (b) the
 * INSERT...RETURNING in emitAudit reads the trigger-authoritative
 * values back so the wire-out envelope is correct regardless of what
 * the app pre-computed (HIGH-5 closure). The trigger does the real
 * serialization; this lookup is only used to populate the INSERT's
 * parameters that the trigger overwrites. `FOR UPDATE` also requires
 * UPDATE privilege on the table per PG semantics — keeping it would
 * force every audit-emitting role to be granted UPDATE on audit_records,
 * defeating the I-003 REVOKE discipline.
 */
async function getPreviousHashForPartition(
  tenantId: string,
  patientId: string,
  tx?: AuditDbClient,
): Promise<{ previousHash: string; sequenceNumber: number }> {
  const normalizedPatient = patientId.length > 0 ? patientId : 'PLATFORM';
  const partitionKey = `${tenantId}:${normalizedPatient}`;

  if (tx === undefined) {
    return {
      previousHash: computeGenesisHash(partitionKey),
      sequenceNumber: 0,
    };
  }

  const result = await tx.query(
    `SELECT encode(record_hash, 'hex') AS record_hash_hex, sequence_number
       FROM audit_records
      WHERE tenant_id = $1
        AND COALESCE(target_patient_id, 'PLATFORM') = $2
      ORDER BY sequence_number DESC
      LIMIT 1`,
    [tenantId, normalizedPatient],
  );

  const rows = result.rows as Array<{
    record_hash_hex: string;
    sequence_number: number;
  }>;

  if (rows.length === 0) {
    return {
      previousHash: computeGenesisHash(partitionKey),
      sequenceNumber: 0,
    };
  }

  const row = rows[0];
  if (row === undefined) {
    return {
      previousHash: computeGenesisHash(partitionKey),
      sequenceNumber: 0,
    };
  }

  return {
    previousHash: row.record_hash_hex,
    sequenceNumber: row.sequence_number,
  };
}

// ---------------------------------------------------------------------------
// Workload field validation per I-012 closure rule and sentinel rules
// ---------------------------------------------------------------------------

function validateWorkloadFields(input: AuditEnvelopeInput): void {
  const { action, actor_type, ai_workload_type, autonomy_level } = input;
  const isI012Action = I012_ACTION_CLASS_SET.has(action);
  const isExecutionRejected = EXECUTION_REJECTED_ACTIONS.has(action);
  const isAIWorkload = actor_type === 'ai_workload';

  // I-012 closure rule: ai_workload_type and autonomy_level are required
  // on ALL I-012 action-class records, regardless of actor_type.
  if (isI012Action && !isExecutionRejected) {
    if (ai_workload_type === null || ai_workload_type === undefined) {
      throw new Error(
        `I-012 closure rule violation: ai_workload_type is required on action "${action}" ` +
          '(use "n/a" for clinician-only approvals with no AI workload upstream). ' +
          'See AUDIT_EVENTS v5.3 §I-012 closure rule.',
      );
    }
    if (autonomy_level === null || autonomy_level === undefined) {
      throw new Error(
        `I-012 closure rule violation: autonomy_level is required on action "${action}" ` +
          '(use "n/a" for clinician-only approvals with no AI workload upstream). ' +
          'See AUDIT_EVENTS v5.3 §I-012 closure rule.',
      );
    }
    // Sentinel `rejected_invalid_attempt` is NOT valid on successful execution records
    if (ai_workload_type === 'rejected_invalid_attempt') {
      throw new Error(
        `Sentinel "rejected_invalid_attempt" is only valid on *.execution_rejected events. ` +
          `Action "${action}" is not a rejection event.`,
      );
    }
    if (autonomy_level === 'rejected_invalid_attempt') {
      throw new Error(
        `Sentinel "rejected_invalid_attempt" is only valid on *.execution_rejected events. ` +
          `Action "${action}" is not a rejection event.`,
      );
    }
    // Sentinel `n/a` validation: only valid when no AI workload was upstream.
    // Per AUDIT_EVENTS v5.3 §I-012 closure rule line 127 clinician-only
    // carve-out, ai_workload_type and autonomy_level MUST travel together:
    // either both 'n/a' (clinician-only, no upstream AI) or both canonical
    // non-sentinel values. Asymmetric pairing (one 'n/a', one canonical) is
    // a corrupt envelope.
    if (ai_workload_type === 'n/a' && isAIWorkload) {
      throw new Error(
        'Sentinel "n/a" for ai_workload_type is only valid for clinician-only approval records ' +
          'where no AI workload was upstream. actor_type=ai_workload contradicts this.',
      );
    }
    if (autonomy_level === 'n/a' && isAIWorkload) {
      throw new Error(
        'Sentinel "n/a" for autonomy_level is only valid for clinician-only approval records ' +
          'where no AI workload was upstream. actor_type=ai_workload contradicts this.',
      );
    }
    // Symmetric n/a pairing: ai_workload_type=n/a iff autonomy_level=n/a
    // (added v5.3 round 4 per Codex pharmacy-scaffold-rebuild R3 HIGH closure
    // 2026-05-12). Mixed-pairing examples that previously slipped through:
    //   - ai_workload_type='protocol_execution' + autonomy_level='n/a' on
    //     prescribing.approved would have made an AI-attributed success
    //     record look partially clinician-only.
    //   - ai_workload_type='n/a' + autonomy_level='action_with_confirm' on
    //     any I-012 action would have claimed no AI workload while still
    //     asserting an AI-execution autonomy level.
    if ((ai_workload_type === 'n/a') !== (autonomy_level === 'n/a')) {
      throw new Error(
        `Sentinel "n/a" must travel as a pair: ai_workload_type and autonomy_level ` +
          `MUST both be "n/a" (clinician-only carve-out per AUDIT_EVENTS v5.3 §I-012 ` +
          `closure rule line 127) or both be canonical non-sentinel values. Got ` +
          `ai_workload_type="${ai_workload_type}", autonomy_level="${autonomy_level}".`,
      );
    }
    // Action-scoped `n/a` validation (added v5.3 under P-011 / SI-001 closure
    // 2026-05-11): the protocol-authorized prescribing route has upstream AI
    // workload by definition (the protocol engine emits the recommendation
    // that the clinician authorizes), so the route's audit events MUST carry
    // ai_workload_type='protocol_execution' / autonomy_level='action_with_confirm'
    // — NOT the clinician-only n/a sentinel. Otherwise post-incident audit
    // reconstruction would mis-classify the prescribing decision as
    // clinician-only when it was protocol-authorized.
    const PROTOCOL_ROUTE_ACTIONS = new Set<AuditAction>([
      'prescribing.protocol_authorization_granted',
      'protocol_authorized_prescribing',
      'protocol_authorized_refill_renewal',
      'protocol_authorized_dispensing_release',
    ]);
    if (PROTOCOL_ROUTE_ACTIONS.has(action)) {
      if (ai_workload_type === 'n/a' || autonomy_level === 'n/a') {
        throw new Error(
          `Sentinel "n/a" for ai_workload_type or autonomy_level is forbidden on ` +
            `protocol-authorized prescribing route actions ("${action}"). These actions ` +
            `have upstream AI workload by definition (Mode 2 protocol-engine route); the ` +
            `envelope MUST carry ai_workload_type='protocol_execution' and ` +
            `autonomy_level='action_with_confirm' per AUDIT_EVENTS v5.3 §I-012 closure rule. ` +
            `The "n/a" sentinel is reserved for the clinician-only route (e.g., ` +
            `prescribing.approved without upstream AI advice).`,
        );
      }
      if (ai_workload_type !== 'protocol_execution') {
        throw new Error(
          `Protocol-authorized route action "${action}" MUST carry ` +
            `ai_workload_type='protocol_execution' (got "${ai_workload_type}"). Per AUDIT_EVENTS ` +
            `v5.3 §I-012 closure rule and WORKLOAD_TAXONOMY v5.2 §2.2.`,
        );
      }
      if (autonomy_level !== 'action_with_confirm') {
        throw new Error(
          `Protocol-authorized route action "${action}" MUST carry ` +
            `autonomy_level='action_with_confirm' (got "${autonomy_level}"). Per AUDIT_EVENTS ` +
            `v5.3 §I-012 closure rule and AUTONOMY_LEVELS v5.2.`,
        );
      }

      // Action-scoped actor_type validation (added v5.3 round 4 per Codex
      // pharmacy-scaffold-rebuild R4 HIGH closure 2026-05-12). Without these
      // checks, prescribing.protocol_authorization_granted could be emitted
      // with actor_type='ai_workload' (making an AI workload appear to have
      // supplied its own I-012 confirmation), and protocol_authorized_prescribing
      // could be emitted with actor_type='clinician' (making protocol execution
      // look clinician-executed). Both break post-incident audit reconstruction.
      //
      //   prescribing.protocol_authorization_granted: actor_type='clinician'
      //     — this is the clinician confirmation event that authorizes the
      //     protocol-engine route. The CLINICIAN is the actor; the protocol
      //     engine identity is captured on the subsequent execution event.
      //   protocol_authorized_prescribing / _refill_renewal /
      //     _dispensing_release: actor_type='ai_workload' (or the legacy
      //     'protocol_engine' alias only for pre-v1.10 backfill) — these
      //     are the protocol-engine execution audits. The engine is the
      //     executing actor authority; the accountable clinician is
      //     captured in the payload's accountable_clinician_id field.
      if (action === 'prescribing.protocol_authorization_granted') {
        if (actor_type !== 'clinician') {
          throw new Error(
            `Action "${action}" MUST carry actor_type='clinician' (got "${actor_type}"). ` +
              `This is the clinician confirmation event that anchors the I-012 protocol-` +
              `authorized prescribing route; an AI workload cannot supply its own I-012 ` +
              `confirmation. Per AUDIT_EVENTS v5.3 §I-012 closure rule + Codex pharmacy-` +
              `scaffold-rebuild R4 HIGH closure 2026-05-12.`,
          );
        }
      } else {
        // protocol_authorized_prescribing / _refill_renewal / _dispensing_release
        // — live emissions MUST use actor_type='ai_workload'. The legacy
        // 'protocol_engine' alias is rejected in this path per Codex
        // pharmacy-scaffold-rebuild R5 HIGH closure 2026-05-12 (R4 fix had a
        // hole: emitAudit can't distinguish a live emission from a backfill
        // import, so accepting 'protocol_engine' here would let a live
        // emission slip through with the deprecated alias). Backfill imports
        // for pre-v1.10 records — if they're ever needed — MUST go through a
        // separate backfill-only API with an explicit `is_backfill: true`
        // flag and a record-version cutoff. That backfill path is not built
        // (and may never be needed if pre-v1.10 records aren't migrated);
        // this comment names the constraint for any future backfill design.
        if (actor_type !== 'ai_workload') {
          throw new Error(
            `Action "${action}" MUST carry actor_type='ai_workload'; got "${actor_type}". ` +
              `This is the protocol-engine execution audit; the accountable clinician ` +
              `is recorded in the payload's accountable_clinician_id field. The legacy ` +
              `'protocol_engine' actor_type is non-compliant per AUDIT_EVENTS v5.3 §I-012 ` +
              `closure rule line 66 and MUST be mapped at emission time to ` +
              `'ai_workload' (workload type 'protocol_execution'). Pre-v1.10 backfill ` +
              `imports — if ever needed — require a separate backfill-only API path that ` +
              `is not currently built. Per Codex pharmacy-scaffold-rebuild R5 HIGH ` +
              `closure 2026-05-12.`,
          );
        }
      }
    }
  }

  // Execution_rejected events: validate sentinel usage
  if (isExecutionRejected) {
    // These events MUST carry ai_workload_type and autonomy_level — populated
    // from the attempted values (or sentinel if null/unknown/reserved).
    if (ai_workload_type === undefined || ai_workload_type === null) {
      throw new Error(
        `execution_rejected audit event "${action}" must carry ai_workload_type ` +
          '(use "rejected_invalid_attempt" if the attempted value was null/unknown/reserved).',
      );
    }
    if (autonomy_level === undefined || autonomy_level === null) {
      throw new Error(
        `execution_rejected audit event "${action}" must carry autonomy_level ` +
          '(use "rejected_invalid_attempt" if the attempted value was null/unknown/reserved).',
      );
    }
  }

  // New v1.10+ AI events with actor_type=ai_workload require ai_workload_type populated
  if (isAIWorkload && (ai_workload_type === null || ai_workload_type === undefined)) {
    throw new Error(
      'New v1.10+ AI audit events with actor_type=ai_workload require ai_workload_type ' +
        'to be populated per WORKLOAD_TAXONOMY v5.2 §1 nullability rule.',
    );
  }

  // Reserved workload types must not appear on successful execution records
  const reservedWorkloadTypes = new Set([
    'autonomous_agent',
    'multi_agent_supervisor',
    'tool_using_agent',
  ]);
  if (ai_workload_type && reservedWorkloadTypes.has(ai_workload_type)) {
    throw new Error(
      `Reserved ai_workload_type "${ai_workload_type}" cannot appear on audit records at v1.0. ` +
        'Activation requires successor ADR + activation audit event per WORKLOAD_TAXONOMY v5.2 §3.',
    );
  }

  // Reserved autonomy levels must not appear on successful execution records
  const reservedAutonomyLevels = new Set(['action_with_audit_only', 'fully_autonomous']);
  if (autonomy_level && reservedAutonomyLevels.has(autonomy_level) && !isExecutionRejected) {
    throw new Error(
      `Reserved autonomy_level "${autonomy_level}" cannot appear on audit records at v1.0. ` +
        'Activation requires ADR-030 + activation audit event per AUTONOMY_LEVELS v5.2 §3.',
    );
  }
}

// ---------------------------------------------------------------------------
// emitAudit — primary emission function
// ---------------------------------------------------------------------------

/**
 * Minimal structural type for a Postgres transaction client. Matches the
 * shape exposed by `pg` (`pg.Client` / `pg.PoolClient`) without importing
 * the lib here — the lib boundary is `src/lib/db.ts` (future) and this
 * type-only contract avoids a dep coupling in the audit module.
 */
export interface AuditDbClient {
  query(
    text: string,
    values?: ReadonlyArray<unknown>,
  ): Promise<{ rows: unknown[]; rowCount: number | null }>;
}

/**
 * emitAudit — construct, validate, and persist an audit envelope.
 *
 * **Durability contract (I-003 bare-suppression-forbidden):**
 * Production callers MUST provide a `tx` handle so the INSERT into
 * `audit_records` (migration 002) runs inside the caller's transaction —
 * if the business state change rolls back, the audit record rolls back
 * too, preserving the same-transaction guarantee. Without `tx` in
 * production, this function THROWS rather than silently log: a
 * non-durable audit emission is itself an I-003 violation, since the
 * audit chain would have no record of an action that may have changed
 * business state.
 *
 * **Test-only opt-out:** when `process.env.NODE_ENV === 'test'`, omitting
 * `tx` falls through to the in-memory `_emissionLog` so unit tests that
 * don't carry a DB context can still assert emission via
 * `assertAuditEmittedFor()`. Integration tests that exercise persistence
 * MUST pass a real `tx`.
 *
 * Throws (does NOT silently log) on:
 *   - Missing required fields (I-003 / I-027)
 *   - I-012 closure rule violations
 *   - Sentinel misuse
 *   - Reserved workload type / autonomy level on successful execution records
 *   - Missing `tx` in non-test environments (I-003 durability)
 *   - INSERT failure (I-003 durability)
 *
 * Per I-003, bare suppression of audit events is FORBIDDEN.
 * Any catch block that swallows this function's error is an I-003 violation.
 *
 * Patch v0.2 — 2026-05-02 per Codex foundation-layer review CRITICAL-2
 * finding: prior implementation returned the envelope without persisting,
 * leaving production audit emission non-durable. This patch adds the
 * required `tx` parameter and gates the in-memory path behind NODE_ENV.
 */
export async function emitAudit(
  input: AuditEnvelopeInput,
  tx?: AuditDbClient,
): Promise<AuditEnvelope> {
  // 1. Required-field validation
  const validationResult = AuditEnvelopeInputSchema.safeParse(input);
  if (!validationResult.success) {
    const messages = validationResult.error.issues
      .map((e) => `  ${e.path.join('.')}: ${e.message}`)
      .join('\n');
    throw new Error(
      `emitAudit: missing or invalid required fields — I-003 forbids suppression:\n${messages}`,
    );
  }

  // 2. Workload field validation (I-012 closure rule + sentinel rules)
  validateWorkloadFields(input);

  // 2b. F-4 R5+R6 closure (Codex 2026-05-15): runtime assertion that
  // non-system actors carry actor_tenant_id. The DB column is nullable
  // by design (legacy pre-029 rows + system actors), but new emissions
  // from non-system actors MUST populate it. Without this gate, a
  // future caller that forgets to thread actorTenantId through would
  // silently produce a non-system audit row with NULL attribution —
  // durable bad evidence rather than a detectable failure.
  //
  // R6 closure: the invariant is now deny-by-default (require attribution
  // for every actor_type except 'system' and 'ai_workload'). Including
  // platform_admin, tenant_admin, pharmacist, etc. Previously only
  // listed {patient, clinician, operator, delegate}, which left admin
  // and AI-adjacent actor types as a forensic blind spot.
  // R8 MEDIUM closure (2026-05-15): not just null/undefined — also
  // reject empty string + whitespace-only. Blank attribution defeats
  // the forensic purpose of the column.
  const NON_ATTRIBUTING_ACTOR_TYPES: ReadonlySet<string> = new Set(['system', 'ai_workload']);
  if (!NON_ATTRIBUTING_ACTOR_TYPES.has(input.actor_type)) {
    const rawAttribution = input.actor_tenant_id;
    const trimmed = typeof rawAttribution === 'string' ? rawAttribution.trim() : null;
    if (trimmed === null || trimmed.length === 0) {
      throw new Error(
        `emitAudit: action="${input.action}" actor_type="${input.actor_type}" requires ` +
          'non-null non-blank actor_tenant_id (F-4 attribution). Only system and ' +
          'ai_workload actor types may omit it; every other actor type must populate it ' +
          'with a usable tenant identifier. Caller must thread ' +
          'resolveActorTenantIdForAudit(req) into the audit emitter call site.',
      );
    }
  }

  // 3. Auto-enforce audit_sensitivity_level = high_pii for research export events (I-031)
  const sensitivityLevel: AuditSensitivityLevel = RESEARCH_HIGH_PII_ACTIONS.has(input.action)
    ? 'high_pii'
    : input.audit_sensitivity_level;

  if (RESEARCH_HIGH_PII_ACTIONS.has(input.action) && input.audit_sensitivity_level !== 'high_pii') {
    throw new Error(
      `I-031 violation: research export event "${input.action}" must carry ` +
        'audit_sensitivity_level="high_pii". Caller supplied "standard".',
    );
  }

  // 4. Compute hash chain (queries audit_records under tx for FOR UPDATE
  //    serialization on the same partition; falls back to genesis when no tx
  //    is provided per the test/unwired path).
  //    For platform-scope events with target_patient_id=null, use the
  //    'PLATFORM' sentinel matching the DB trigger's COALESCE(target_patient_id,
  //    'PLATFORM') in migration 002 audit_records_hash_insert. This keeps
  //    the app-side and DB-side hash chains aligned for the platform partition.
  //
  //    The lookup is tenant-scoped (HIGH-4 closure 2026-05-03): when the
  //    transaction can see rows from multiple tenants (break-glass; platform-
  //    admin; multi-tenant test setups), a tenant-blind partition match would
  //    return another tenant's record_hash. The trigger's tenant-scoped
  //    storage write would silently overwrite that to the correct value, but
  //    the envelope returned from `emitAudit` to the caller — which is what
  //    flows to logs, downstream consumers, and assertion helpers — would
  //    carry the wrong previous_hash.
  //
  //    HIGH-5 closure 2026-05-03 (Codex CI-fix verify-r4): even with the
  //    tenant-scoped pre-lookup, two concurrent inserts on an empty partition
  //    both observed NULL and both pre-computed seq=1 + genesis prev_hash.
  //    The DB advisory lock made one of them sequence=2 in storage, but the
  //    SECOND caller's emitAudit returned an envelope still claiming seq=1
  //    + genesis prev_hash. The wire-out envelope is what production code
  //    surfaces (logs, downstream events, test assertion helpers), so it has
  //    to match the trigger's actual computed values. The fix below uses
  //    `INSERT ... RETURNING` to read the trigger-computed columns back and
  //    overwrite the pre-computed envelope with the authoritative values.
  const partitionInput = input.target_patient_id ?? 'PLATFORM';
  const { previousHash: prePreviousHash, sequenceNumber: preSequenceNumber } =
    await getPreviousHashForPartition(input.tenant_id, partitionInput, tx);

  // Build the envelope without hash_chain first (needed for record_hash).
  // audit_id is a UUID v4 to match the audit_records.audit_id UUID column type.
  // (Patch v0.3 — 2026-05-02 per Codex foundation-verify-r2 CRITICAL-1 finding:
  //  the prior `aud_${Date.now()}` placeholder violated the DB column type and
  //  would have aborted every production INSERT with invalid UUID syntax.
  //  When a ULID library is added, this can be swapped to a ULID string AND
  //  the migration 002 column type changed to TEXT — both must change together.)
  const auditId = crypto.randomUUID();
  const partialEnvelope: Omit<AuditEnvelope, 'hash_chain'> = {
    audit_id: auditId,
    ...input,
    audit_sensitivity_level: sensitivityLevel,
  };

  // Pre-compute hash_chain for the no-tx (test/unwired) path. When tx is
  // provided, these values are OVERWRITTEN by INSERT ... RETURNING below
  // with whatever the trigger actually wrote.
  const preRecordHash = computeRecordHash(partialEnvelope);
  let envelope: AuditEnvelope = {
    ...partialEnvelope,
    hash_chain: {
      // Partition matches the DB trigger derivation: tenant_id-prefixed
      // (HIGH-1 closure 2026-05-03) to keep the chain tenant-scoped even
      // when two tenants share a target_patient_id.
      partition: `${input.tenant_id}:${partitionInput}`,
      sequence_number: preSequenceNumber + 1,
      previous_hash: prePreviousHash,
      record_hash: preRecordHash,
    },
  };

  // 5. Persist to audit store — durability gate per I-003
  if (tx) {
    // Production path: durable INSERT into the caller's transaction.
    // The DB-side BEFORE INSERT trigger (migration 002) recomputes
    // record_hash, prev_hash, and sequence_number — under the trigger's
    // pg_advisory_xact_lock per partition — and writes those to the row.
    // We then SELECT them back via RETURNING so the returned envelope
    // matches the stored row exactly, even when concurrent same-partition
    // inserts race on an empty partition.
    try {
      // F-4 R2 HIGH closure (2026-05-15; migration 029): persist
      // actor_tenant_id. Pre-F-4 the envelope carried this field
      // in-memory only — the INSERT did not project it, so cross-
      // tenant platform_admin attribution was lost on persistence.
      // Migration 029 adds the column; this INSERT now writes it.
      const result = await tx.query(
        `INSERT INTO audit_records (
            audit_id, tenant_id, category, audit_sensitivity_level, action,
            actor_type, actor_id, actor_tenant_id, ai_workload_type, autonomy_level,
            target_patient_id, delegate_context, resource_type, resource_id,
            country_of_care, break_glass, payload, prev_hash, record_hash,
            sequence_number, recorded_at
         ) VALUES (
            $1, $2, $3, $4, $5,
            $6, $7, $8, $9, $10,
            $11, $12::jsonb, $13, $14,
            $15, $16::jsonb, $17::jsonb, decode($18, 'hex'), decode($19, 'hex'),
            $20, $21
         )
         RETURNING
           encode(prev_hash,   'hex') AS prev_hash_hex,
           encode(record_hash, 'hex') AS record_hash_hex,
           sequence_number`,
        [
          envelope.audit_id,
          envelope.tenant_id,
          envelope.category,
          envelope.audit_sensitivity_level,
          envelope.action,
          envelope.actor_type,
          envelope.actor_id,
          envelope.actor_tenant_id,
          envelope.ai_workload_type,
          envelope.autonomy_level,
          envelope.target_patient_id,
          envelope.delegate_context ? JSON.stringify(envelope.delegate_context) : null,
          envelope.resource_type,
          envelope.resource_id,
          envelope.country_of_care,
          envelope.break_glass ? JSON.stringify(envelope.break_glass) : null,
          JSON.stringify(envelope.detail),
          envelope.hash_chain.previous_hash,
          envelope.hash_chain.record_hash,
          envelope.hash_chain.sequence_number,
          envelope.timestamp,
        ],
      );

      // Overwrite the pre-computed hash_chain with the trigger-authoritative
      // values. This is the HIGH-5 closure: the wire-out envelope now
      // matches the stored row regardless of concurrent-insert races.
      const rows = result.rows as Array<{
        prev_hash_hex: string;
        record_hash_hex: string;
        sequence_number: number | string;
      }>;
      const stored = rows[0];
      if (stored !== undefined) {
        envelope = {
          ...envelope,
          hash_chain: {
            partition: envelope.hash_chain.partition,
            sequence_number:
              typeof stored.sequence_number === 'string'
                ? Number.parseInt(stored.sequence_number, 10)
                : stored.sequence_number,
            previous_hash: stored.prev_hash_hex,
            record_hash: stored.record_hash_hex,
          },
        };
      }
    } catch (err) {
      // I-003: bare suppression forbidden. Re-throw with context so the
      // caller's transaction aborts and the upstream business action
      // rolls back — never let an audit-INSERT failure pass silently.
      throw new Error(
        `emitAudit: durable INSERT failed for action "${envelope.action}" ` +
          `(tenant=${envelope.tenant_id}, audit_id=${envelope.audit_id}): ` +
          `${err instanceof Error ? err.message : String(err)} — I-003 forbids ` +
          'suppression; the caller transaction MUST abort.',
      );
    }

    // Emission log is also populated under tx so test assertions that run
    // in integration mode see the same record they'd see in production.
    if (process.env['NODE_ENV'] === 'test') {
      _emissionLog.push({
        actionId: envelope.resource_id,
        action: envelope.action,
        emittedAt: new Date(),
      });
    }

    return envelope;
  }

  // No tx provided.
  if (process.env['NODE_ENV'] !== 'test') {
    // Production / dev / staging without a transaction handle is an
    // I-003 violation: an audit record that doesn't reach the durable
    // chain is bare suppression. Throw rather than emit-and-pretend.
    throw new Error(
      `emitAudit: refused to emit "${envelope.action}" without a transaction ` +
        'handle outside test environments. I-003 requires same-transaction ' +
        'durable persistence to the audit_records table. Pass a `tx` argument ' +
        'or run under NODE_ENV=test for unit-test stubs.',
    );
  }

  // Test-only path: in-memory emission for unit tests that don't carry a DB context.
  // Integration tests MUST pass a real tx and exercise the durable path above.
  _emissionLog.push({
    actionId: envelope.resource_id,
    action: envelope.action,
    emittedAt: new Date(),
  });

  return envelope;
}
