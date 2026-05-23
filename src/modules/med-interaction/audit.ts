/**
 * med-interaction/audit.ts — module-specific audit envelope emitters.
 *
 * Wraps `lib/audit.ts emitAudit()` for Med-Interaction Engine (SI-019)
 * write-path events per the CDM v1.6 → v1.7 + AUDIT_EVENTS v5.8 → v5.9
 * Amendment §4 (P-034 RATIFIED 2026-05-21).
 *
 * **PR 8 of N — FIRST WRITE-PATH AUDIT EMITTER.** Ships alongside the first
 * Med-Interaction write handler (`POST /v0/med-interaction/evaluations`). The
 * get-signal read handler (PR 7) emits no audit (reads are not cataloged);
 * this is the slice's first cataloged emission.
 *
 * Unlike the async-consult / forms-intake / consent placeholder emitters, the
 * Med-Interaction action IDs are CANONICAL and ratified — `medication_interaction.*`
 * was landed in AUDIT_EVENTS v5.9 (P-034), so there is no `as AuditAction`
 * placeholder cast here. The action IDs resolve directly against the
 * `lib/audit.ts` catalog union.
 *
 * Cataloged write-path events (6 total per the amendment §4 per-row table):
 *   - medication_interaction.engine_evaluation_completed   Cat A — THIS PR
 *   - medication_interaction.signal_emitted                Cat A — PR 9 (POST signals)
 *   - medication_interaction.engine_evaluation_failed      Cat B — PR 9+
 *   - medication_interaction.engine_knowledge_base_updated Cat B — KB-update PR
 *   - medication_interaction.engine_signal_enforcement_override Cat B — override PR
 *   - medication_interaction.engine_projection_divergence_detected Cat B — recon cron
 *
 * Spec references:
 *   - CDM v1.6 → v1.7 + AUDIT_EVENTS v5.8 → v5.9 Amendment §4 (P-034)
 *   - SI-019 Medication Interaction Engine Slice PRD v2.0 §Sub-decision 2
 *   - I-003 (audit append-only; bare suppression forbidden)
 *   - I-027 (every audit record carries tenant_id)
 *   - I-002 (interaction engine runs BEFORE clinician commit)
 */

import {
  type AuditDbClient,
  type AuditEnvelope,
  type AuditEnvelopeInput,
  emitAudit,
} from '../../lib/audit.js';
import type { TenantId } from '../../lib/glossary.js';

// ---------------------------------------------------------------------------
// engine_evaluation_completed (Cat A)
//
// Emitted by the engine on every interaction_engine_evaluation row INSERT
// (success OR no-signals). The interaction engine is a deterministic
// knowledge-base check, not an AI/LLM workload, and the action is not in the
// I-012 action-class set — so ai_workload_type / autonomy_level remain null
// per the WORKLOAD_TAXONOMY v5.2 nullability rule (mirrors the legacy
// `interaction_engine_evaluation` catalog row whose canonical actor is
// `system` with no workload fields).
//
// actor_type='system' (the engine is the acting authority; the triggering
// clinician/pharmacist/engine identity is recorded in detail.triggered_by* +
// resolved separately). Per the F-4 attribution rule, system actors may omit
// actor_tenant_id; we populate it for forensic completeness anyway.
// ---------------------------------------------------------------------------

const ENGINE_SYSTEM_ACTOR_ID = 'med-interaction.engine';

export async function emitEngineEvaluationCompletedAudit(
  args: {
    tenantId: TenantId;
    evaluationId: string;
    patientId: string;
    countryOfCare: string;
    triggeredBy: string;
    triggeredByResourceId: string;
    engineVersion: string;
    knowledgeBaseVersion: string;
    evaluationWindowMs: number;
  },
  tx: AuditDbClient,
): Promise<AuditEnvelope> {
  const envelope: AuditEnvelopeInput = {
    timestamp: new Date().toISOString(),
    tenant_id: args.tenantId,
    actor_type: 'system',
    actor_id: ENGINE_SYSTEM_ACTOR_ID,
    actor_tenant_id: args.tenantId,
    target_patient_id: args.patientId,
    delegate_context: null,
    action: 'medication_interaction.engine_evaluation_completed',
    category: 'A',
    audit_sensitivity_level: 'standard',
    resource_type: 'interaction_engine_evaluation',
    resource_id: args.evaluationId,
    detail: {
      triggered_by: args.triggeredBy,
      triggered_by_resource_id: args.triggeredByResourceId,
      engine_version: args.engineVersion,
      knowledge_base_version: args.knowledgeBaseVersion,
      evaluation_window_ms: args.evaluationWindowMs,
    },
    engine_versions: {
      interaction_engine: args.engineVersion,
      knowledge_base: args.knowledgeBaseVersion,
    },
    ai_workload_type: null,
    autonomy_level: null,
    agent_id: null,
    agent_version: null,
    tool_call_id: null,
    memory_read_set_id: null,
    memory_write_set_id: null,
    supervising_policy_id: null,
    knowledge_source_versions: [
      { knowledge_base_id: 'interaction_engine', version: args.knowledgeBaseVersion },
    ],
    signals: null,
    override: null,
    linked_events: [],
    compliance_flags: [],
    country_of_care: args.countryOfCare,
    break_glass: null,
  };
  return emitAudit(envelope, tx);
}
