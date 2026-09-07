import { createHash, randomUUID } from 'node:crypto';

import { withActorContext } from '../../../lib/actor-context-binding.js';
import { crisisDetector } from '../../../lib/crisis-detection.js';
import { withTransaction, type DbTransaction } from '../../../lib/db.js';
import { emitDomainEvent } from '../../../lib/domain-events.js';
import { logger } from '../../../lib/logger.js';
import { withTenantContext } from '../../../lib/rls.js';
import type { TenantContext } from '../../../lib/tenant-context.js';
import { withDbRole } from '../../../lib/with-db-role.js';
import { getTenantCountryProfile } from '../../tenant-config/index.js';
import { emitCrisisDetectedAudit } from '../audit.js';

import { withPatientCareRead } from './patient-care-read.js';
import { asCrisisEventId, asServerSignalId } from './types.js';

export interface PatientCareAdmissionContext {
  tenant: TenantContext;
  accountId: string;
  sessionId: string;
  actorNonce: string;
  /** Retry selector only; never an actor, patient, event or signal identifier. */
  idempotencyKey?: string;
}
export interface PatientCrisisResources {
  country_of_care: string;
  emergency_number: string | null;
  crisis_helplines: Array<{ name: string; number: string; available_hours: string }>;
  status: 'available' | 'unavailable';
}
export type PatientCareAdmissionResult =
  | { kind: 'no_detection' }
  | {
      kind: 'crisis_interruption';
      resources: PatientCrisisResources;
      detector_version: 'keyword_engineering_v1';
      recording_status: 'recorded';
      crisis_event_id: string;
      disclosure_status: 'available';
      escalation_status: 'pending';
    }
  | {
      kind: 'crisis_interruption';
      resources: PatientCrisisResources;
      detector_version: 'keyword_engineering_v1';
      recording_status: 'recorded';
      disclosure_status: 'unavailable';
      escalation_status: 'pending';
    }
  | {
      kind: 'crisis_interruption';
      resources: PatientCrisisResources;
      detector_version: 'keyword_engineering_v1';
      recording_status: 'not_recorded';
      escalation_status: 'not_queued';
    }
  | {
      kind: 'crisis_interruption';
      resources: PatientCrisisResources;
      detector_version: 'keyword_engineering_v1';
      recording_status: 'unconfirmed';
      escalation_status: 'unconfirmed';
    };

const MAX_ADMITTED_BYTES = 1_048_576;
/** JSON ingress may be malformed for the business schema. Scan every string value. */
export function collectPatientCareText(body: unknown): string[] {
  const pending: unknown[] = [body];
  const seen = new WeakSet<object>();
  const strings: string[] = [];
  let bytes = 0;
  let nodes = 0;
  while (pending.length) {
    const value = pending.pop();
    if (++nodes > MAX_ADMITTED_BYTES) throw new Error('crisis_input_limit');
    if (typeof value === 'string') {
      bytes += Buffer.byteLength(value, 'utf8');
      if (bytes > MAX_ADMITTED_BYTES) throw new Error('crisis_input_limit');
      strings.push(value);
    } else if (value && typeof value === 'object' && !seen.has(value)) {
      seen.add(value);
      for (const item of Object.values(value)) pending.push(item);
    }
  }
  return strings;
}

let nextSignalAt = -Infinity;
function signalAdmissionUnavailable(): void {
  if (performance.now() < nextSignalAt) return;
  nextSignalAt = performance.now() + 60_000;
  try {
    logger.error({ event: 'crisis.admission.unavailable' }, 'Crisis admission unavailable');
  } catch {
    // Do not replace the patient safety response with a logger failure.
  }
}

async function assertPatient(tx: DbTransaction, ctx: PatientCareAdmissionContext): Promise<void> {
  const result = await withDbRole(tx, 'crisis_care_patient', () =>
    tx.query<{ actor: Record<string, unknown> }>(
      'SELECT public.crisis_care_live_patient() AS actor',
    ),
  );
  const actor = result.rows[0]?.actor;
  if (
    actor?.['account_id'] !== ctx.accountId ||
    actor?.['session_id'] !== ctx.sessionId ||
    actor?.['tenant_id'] !== ctx.tenant.tenantId ||
    actor?.['country_of_care'] !== ctx.tenant.countryOfCare
  )
    throw Object.assign(new Error('crisis_unauthenticated'), { code: 'PT401' });
}

function patientTransaction<T>(
  ctx: PatientCareAdmissionContext,
  work: (tx: DbTransaction) => Promise<T>,
  beforeCommit: () => void = () => undefined,
): Promise<T> {
  return withTransaction(async (tx) => {
    const result = await withTenantContext(tx, ctx.tenant.tenantId, () =>
      withActorContext(tx, ctx.actorNonce, async () => {
        await tx.query("SET LOCAL statement_timeout='5s'");
        await tx.query("SET LOCAL lock_timeout='2s'");
        await assertPatient(tx, ctx);
        const result = await work(tx);
        await assertPatient(tx, ctx);
        await tx.query('SET CONSTRAINTS crisis_care_evidence IMMEDIATE');
        await assertPatient(tx, ctx);
        return result;
      }),
    );
    beforeCommit();
    return result;
  }).catch((error: unknown) => {
    if ((error as { code?: unknown } | null)?.code === 'PT401')
      throw Object.assign(new Error('crisis_unauthenticated'), { code: 'PT401', statusCode: 401 });
    throw error;
  });
}

/**
 * Invoke before ordinary validation and outside the ordinary business transaction.
 * A keyword engineering detector is not a clinically validated classifier. No input
 * text, text fingerprint, or ordinary intake record is retained by this operation.
 */
export async function admitPatientCareInput(
  ctx: PatientCareAdmissionContext,
  body: unknown,
  source: 'form_response' | 'messaging',
): Promise<PatientCareAdmissionResult> {
  const detection = crisisDetector.detect(
    collectPatientCareText(body).join('\n'),
    ctx.tenant.tenantId,
    source,
  );
  if (!detection.crisisDetected) {
    await patientTransaction(ctx, async () => undefined);
    return { kind: 'no_detection' };
  }
  const resources: PatientCrisisResources = {
    country_of_care: ctx.tenant.countryOfCare,
    emergency_number: null,
    crisis_helplines: [],
    status: 'unavailable',
  };
  let commitPossible = false;
  let authenticated = false;
  let crisisEventId: string | undefined;
  let recordingStatus: 'recorded' | 'not_recorded' | 'unconfirmed';
  try {
    crisisEventId = await patientTransaction(
      ctx,
      async (tx) => {
        authenticated = true;
        const sourceSurface = source === 'form_response' ? 'forms' : 'messaging';
        // Hash only the transport retry selector, never clinical text or body bytes.
        const keyHash = createHash('sha256')
          .update(ctx.idempotencyKey ?? randomUUID())
          .digest('hex');
        const result = await withDbRole(tx, 'crisis_care_patient', () =>
          tx.query<{
            result: { crisis_event_id: string; server_signal_id?: string; created: boolean };
          }>('SELECT public.crisis_care_record($1,$2,$3) AS result', [
            detection.crisisType,
            sourceSurface,
            keyHash,
          ]),
        );
        const record = result.rows[0]?.result;
        if (!record) throw new Error('crisis_record_unavailable');
        if (record.created) {
          if (!record.server_signal_id) throw new Error('crisis_record_unavailable');
          const audit = await emitCrisisDetectedAudit(
            {
              tenantId: ctx.tenant.tenantId,
              crisisInitiatorIdentity: 'patient',
              actorAccountId: ctx.accountId,
              actorTenantId: ctx.tenant.tenantId,
              countryOfCare: ctx.tenant.countryOfCare,
              crisisEventId: asCrisisEventId(record.crisis_event_id),
              targetPatientId: ctx.accountId,
              serverSignalId: asServerSignalId(record.server_signal_id),
              crisisType: detection.crisisType,
              severity: 'unassessed',
              regulatoryReportingEnabled: false,
              sourceSurface,
              detectorVersion: 'keyword_engineering_v1',
            },
            tx,
          );
          await emitDomainEvent(tx, {
            tenant_id: ctx.tenant.tenantId,
            aggregate_type: 'CrisisEvent',
            aggregate_id: record.crisis_event_id,
            event_type: 'crisis.detected.v1',
            occurred_at: new Date().toISOString(),
            payload: {
              crisis_event_id: record.crisis_event_id,
              audit_id: audit.audit_id,
              severity: 'unassessed',
              source_surface: sourceSurface,
              detector_version: 'keyword_engineering_v1',
              escalation_status: 'pending',
            },
          });
        }
        return record.crisis_event_id;
      },
      () => {
        commitPossible = true;
      },
    );
    recordingStatus = 'recorded';
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    if (code === 'PT401') throw error;
    if (code === '42501' && !authenticated)
      throw Object.assign(new Error('crisis_forbidden'), { code: '42501', statusCode: 403 });
    signalAdmissionUnavailable();
    recordingStatus = commitPossible ? 'unconfirmed' : 'not_recorded';
  }

  // Recording has already settled. Public configuration can neither prevent
  // that transaction nor change its acknowledged/uncertain outcome.
  try {
    const profile = await withPatientCareRead((tx) => getTenantCountryProfile(ctx.tenant, tx));
    if (profile) {
      resources.emergency_number = profile.emergency_number;
      resources.crisis_helplines = profile.crisis_helplines.map((line) => ({ ...line }));
      resources.status = 'available';
    } else signalAdmissionUnavailable();
  } catch {
    signalAdmissionUnavailable();
  }
  const common = {
    kind: 'crisis_interruption' as const,
    detector_version: 'keyword_engineering_v1' as const,
    resources,
  };
  if (recordingStatus === 'not_recorded')
    return { ...common, recording_status: 'not_recorded', escalation_status: 'not_queued' };
  if (recordingStatus === 'unconfirmed')
    return { ...common, recording_status: 'unconfirmed', escalation_status: 'unconfirmed' };

  // Revalidate after the resource wait before disclosing an event identifier.
  // This separate, bounded read cannot undo an acknowledged recording commit.
  try {
    await withPatientCareRead((tx) =>
      withTenantContext(tx, ctx.tenant.tenantId, () =>
        withActorContext(tx, ctx.actorNonce, () => assertPatient(tx, ctx)),
      ),
    );
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    if (code === 'PT401')
      throw Object.assign(new Error('crisis_unauthenticated'), { code: 'PT401', statusCode: 401 });
    if (code === '42501')
      throw Object.assign(new Error('crisis_forbidden'), { code: '42501', statusCode: 403 });
    signalAdmissionUnavailable();
    return {
      ...common,
      recording_status: 'recorded',
      escalation_status: 'pending',
      disclosure_status: 'unavailable',
    };
  }
  return {
    ...common,
    recording_status: 'recorded',
    crisis_event_id: crisisEventId!,
    escalation_status: 'pending',
    disclosure_status: 'available',
  };
}
