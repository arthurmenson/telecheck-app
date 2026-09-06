/** Patient projection through the database's live-identity read capability. */
import { withActorContext } from '../../../../lib/actor-context-binding.js';
import { withTransaction } from '../../../../lib/db.js';
import type { TenantId } from '../../../../lib/glossary.js';
import { withTenantContext } from '../../../../lib/rls.js';
import { withDbRole } from '../../../../lib/with-db-role.js';
import type { MedicationRequestStatus } from '../types.js';

export interface PatientMedicationRequestReadView {
  id: string;
  medication_name: string;
  strength: string;
  formulation: string;
  dose_instructions: string;
  quantity: number;
  quantity_unit: string;
  refills_allowed: number;
  status: MedicationRequestStatus;
  prescribed_at: string | null;
  activated_at: string | null;
  expires_at: string | null;
}

type ReadRow = Omit<
  PatientMedicationRequestReadView,
  'prescribed_at' | 'activated_at' | 'expires_at'
> & {
  prescribed_at: Date | null;
  activated_at: Date | null;
  expires_at: Date | null;
};

export async function readPatientMedicationRequests(
  tenantId: TenantId,
  nonce: string,
  options: { id?: string; status?: MedicationRequestStatus; limit?: number },
): Promise<PatientMedicationRequestReadView[]> {
  return withTransaction(async (tx) => {
    await tx.query("SET LOCAL statement_timeout = '5s'");
    await tx.query("SET LOCAL lock_timeout = '2s'");
    return withTenantContext(tx, tenantId, () =>
      withActorContext(tx, nonce, () =>
        withDbRole(tx, 'pharmacy_patient_reader', async () => {
          const result = await tx.query<ReadRow>(
            `SELECT id, medication_name, strength, formulation, dose_instructions,
                    quantity, quantity_unit, refills_allowed, status,
                    prescribed_at, activated_at, expires_at
               FROM public.read_patient_medication_requests($1, $2, $3)`,
            [options.id ?? null, options.status ?? null, Math.min(options.limit ?? 50, 500)],
          );
          return result.rows.map((row) => ({
            id: row.id,
            medication_name: row.medication_name,
            strength: row.strength,
            formulation: row.formulation,
            dose_instructions: row.dose_instructions,
            quantity: row.quantity,
            quantity_unit: row.quantity_unit,
            refills_allowed: row.refills_allowed,
            status: row.status,
            prescribed_at: row.prescribed_at?.toISOString() ?? null,
            activated_at: row.activated_at?.toISOString() ?? null,
            expires_at: row.expires_at?.toISOString() ?? null,
          }));
        }),
      ),
    );
  });
}
