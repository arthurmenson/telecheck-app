import { emitAudit } from '../../../../lib/audit.js';
import type { DbTransaction } from '../../../../lib/db.js';
import { emitDomainEvent } from '../../../../lib/domain-events.js';
import type { TenantContext } from '../../../../lib/tenant-context.js';

export async function emitStaffEvidence(
  tx: DbTransaction,
  tenant: TenantContext,
  actorId: string,
  resourceId: string,
  operation: 'enrolled' | 'roster_read',
) {
  const intent = `identity.clinician.${operation}`;
  const detail =
    operation === 'enrolled'
      ? { intent, account_id: resourceId, status: 'pending_verification' }
      : { intent };
  const audit = await emitAudit(
    {
      timestamp: new Date().toISOString(),
      tenant_id: tenant.tenantId,
      actor_type: 'operator',
      actor_id: actorId,
      actor_tenant_id: tenant.tenantId,
      target_patient_id: null,
      delegate_context: null,
      action: 'config_change_validated',
      category: 'B',
      audit_sensitivity_level: 'standard',
      resource_type: 'identity_staff_enrollment',
      resource_id: resourceId,
      detail,
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
      country_of_care: tenant.countryOfCare,
      break_glass: null,
    },
    tx,
  );
  if (operation === 'enrolled')
    await emitDomainEvent(tx, {
      tenant_id: tenant.tenantId,
      aggregate_type: 'IdentityStaffEnrollment',
      aggregate_id: resourceId,
      event_type: intent,
      occurred_at: new Date().toISOString(),
      payload: { ...detail, audit_id: audit.audit_id },
    });
}
