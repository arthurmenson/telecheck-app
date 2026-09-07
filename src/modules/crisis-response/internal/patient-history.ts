import { withActorContext } from '../../../lib/actor-context-binding.js';
import type { DbClient } from '../../../lib/db.js';
import { withTenantContext } from '../../../lib/rls.js';
import { withDbRole } from '../../../lib/with-db-role.js';
import { getTenantCountryProfile } from '../../tenant-config/index.js';

import type {
  PatientCareAdmissionContext,
  PatientCrisisResources,
} from './patient-care-admission.js';
import { withPatientCareRead } from './patient-care-read.js';

export interface PatientCrisisHistoryEvent {
  crisis_event_id: string;
  detected_at: string;
  current_state:
    | 'unknown'
    | 'none'
    | 'detected'
    | 'escalated'
    | 'acknowledged'
    | 'responded'
    | 'resolved';
  state_changed_at: string | null;
}
export interface PatientCrisisHistory {
  items: PatientCrisisHistoryEvent[];
  active_event: PatientCrisisHistoryEvent | null;
  offset: number;
  limit: 25;
  has_more: boolean;
  resources: PatientCrisisResources;
}

async function authorize(tx: DbClient, ctx: PatientCareAdmissionContext): Promise<void> {
  const result = await withDbRole(tx, 'crisis_care_patient', () =>
    tx.query<{ actor: Record<string, unknown> }>(
      'SELECT public.crisis_care_live_patient() AS actor',
    ),
  );
  const a = result.rows[0]?.actor;
  if (
    a?.['tenant_id'] !== ctx.tenant.tenantId ||
    a?.['account_id'] !== ctx.accountId ||
    a?.['session_id'] !== ctx.sessionId ||
    a?.['country_of_care'] !== ctx.tenant.countryOfCare
  )
    throw Object.assign(new Error('crisis_unauthenticated'), { code: 'PT401' });
}

/** Durable own history, independent of ordinary intake, payment and care consent. */
export async function getPatientCrisisHistory(
  ctx: PatientCareAdmissionContext,
  offset: number,
): Promise<PatientCrisisHistory> {
  if (!Number.isInteger(offset) || offset < 0 || offset > 10000)
    throw Object.assign(new Error('crisis_page_invalid'), { code: '22023' });
  const history = await withPatientCareRead((tx) =>
    withTenantContext(tx, ctx.tenant.tenantId, () =>
      withActorContext(tx, ctx.actorNonce, async () => {
        await authorize(tx, ctx);
        const result = await withDbRole(tx, 'crisis_care_patient', () =>
          tx.query<{
            history: Omit<PatientCrisisHistory, 'resources'>;
          }>('SELECT public.crisis_care_patient_history($1) AS history', [offset]),
        );
        await authorize(tx, ctx);
        if (!result.rows[0]?.history) throw new Error('crisis_history_unavailable');
        return result.rows[0].history;
      }),
    ),
  );
  const resources: PatientCrisisResources = {
    country_of_care: ctx.tenant.countryOfCare,
    emergency_number: null,
    crisis_helplines: [],
    status: 'unavailable',
  };
  try {
    const profile = await withPatientCareRead((tx) => getTenantCountryProfile(ctx.tenant, tx));
    if (profile) {
      resources.emergency_number = profile.emergency_number;
      resources.crisis_helplines = profile.crisis_helplines.map((line) => ({ ...line }));
      resources.status = 'available';
    }
  } catch {
    // A configured-resource outage cannot fabricate an empty or resolved history.
  }
  // Country lookup can wait. No patient-specific metadata escapes a stale actor.
  await withPatientCareRead((tx) =>
    withTenantContext(tx, ctx.tenant.tenantId, () =>
      withActorContext(tx, ctx.actorNonce, () => authorize(tx, ctx)),
    ),
  );
  return { ...history, resources };
}
