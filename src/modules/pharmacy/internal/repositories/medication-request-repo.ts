/**
 * medication-request-repo.ts — DB access for `medication_requests`
 * (migration 025).
 *
 * DRAFT pre-SI-001-ratification. Repository pattern (mirror of
 * consent-repo + async-consult consult-repo):
 *   - Pure DB access; no domain logic
 *   - Returns null on tenant-blind miss (I-025)
 *   - All SELECTs filter by tenant_id explicitly (defense in depth on
 *     top of FORCE RLS)
 *   - Append-only via supersession: createDraft INSERTs a draft row;
 *     status-change UPDATEs use optimistic concurrency on
 *     `status = $expected_from_status`; supersession creates a new row
 *     + flips the prior row's status+superseded_by_id under controlled
 *     UPDATE that the I-003 hash-chain audit picks up
 *
 * Spec references:
 *   - migrations/025_medication_requests.sql
 *   - SI-001 DRAFT §"Proposed CDM §4.16"
 *   - PROJECT_CONVENTIONS r5 §1.1 (composite UNIQUE + composite FK)
 *   - I-023 / I-025 / I-027
 */

import type { DbClient, DbTransaction } from '../../../../lib/db.js';
import { withTenantBoundConnection } from '../../../../lib/db.js';
import type { TenantId } from '../../../../lib/glossary.js';
import type { AccountId } from '../../../identity/internal/types.js';
import {
  asMedicationRequestId,
  // asInteractionOverrideId removed (SI-001 v1.0 Path 1 P-011 — column dropped)
  asProductCatalogId,
  asProtocolId,
  type DiscontinuedReason,
  type InteractionSignalsStatus,
  type MedicationRequest,
  type MedicationRequestId,
  type MedicationRequestStatus,
  type ProductCatalogId,
  type ProtocolId,
} from '../types.js';

// ---------------------------------------------------------------------------
// Row mapping
// ---------------------------------------------------------------------------

interface MedicationRequestRow {
  id: string;
  tenant_id: string;
  patient_account_id: string;
  product_catalog_id: string;
  medication_name: string;
  strength: string;
  formulation: string;
  dose_instructions: string;
  quantity: number;
  quantity_unit: string;
  refills_allowed: number;
  indication: string | null;
  clinical_notes: string | null;
  status: string;
  prescribed_at: Date | string | null;
  activated_at: Date | string | null;
  discontinued_at: Date | string | null;
  discontinued_reason: string | null;
  expires_at: Date | string | null;
  prescribed_by_clinician_account_id: string | null;
  prescribing_consult_id: string | null;
  interaction_signals_evaluated_at: Date | string | null;
  interaction_signals_status: string;
  // interaction_override_id REMOVED per SI-001 v1.0 ratification (Path 1, P-011)
  ai_workload_type: string | null;
  autonomy_level: string | null;
  protocol_id: string | null;
  protocol_version: string | null;
  supersedes_id: string | null;
  superseded_by_id: string | null;
  country_of_care: string;
  created_at: Date | string;
  updated_at: Date | string;
}

function tsToIso(v: Date | string): string {
  return typeof v === 'string' ? v : v.toISOString();
}
function tsToIsoNullable(v: Date | string | null): string | null {
  if (v === null) return null;
  return tsToIso(v);
}

function rowToMedicationRequest(row: MedicationRequestRow): MedicationRequest {
  return {
    id: asMedicationRequestId(row.id),
    tenant_id: row.tenant_id as TenantId,
    patient_account_id: row.patient_account_id as AccountId,
    product_catalog_id: asProductCatalogId(row.product_catalog_id),
    medication_name: row.medication_name,
    strength: row.strength,
    formulation: row.formulation,
    dose_instructions: row.dose_instructions,
    quantity: row.quantity,
    quantity_unit: row.quantity_unit,
    refills_allowed: row.refills_allowed,
    indication: row.indication,
    clinical_notes: row.clinical_notes,
    status: row.status as MedicationRequestStatus,
    prescribed_at: tsToIsoNullable(row.prescribed_at),
    activated_at: tsToIsoNullable(row.activated_at),
    discontinued_at: tsToIsoNullable(row.discontinued_at),
    discontinued_reason: row.discontinued_reason as DiscontinuedReason | null,
    expires_at: tsToIsoNullable(row.expires_at),
    prescribed_by_clinician_account_id: row.prescribed_by_clinician_account_id as AccountId | null,
    prescribing_consult_id: row.prescribing_consult_id,
    interaction_signals_evaluated_at: tsToIsoNullable(row.interaction_signals_evaluated_at),
    interaction_signals_status: row.interaction_signals_status as InteractionSignalsStatus,
    // interaction_override_id REMOVED per SI-001 v1.0 ratification (Path 1, P-011).
    // Med Interaction Engine slice integrates via the
    // `medication_request.interaction_safety_hold_triggered` domain event.
    ai_workload_type: row.ai_workload_type,
    autonomy_level: row.autonomy_level,
    protocol_id: row.protocol_id === null ? null : asProtocolId(row.protocol_id),
    protocol_version: row.protocol_version,
    supersedes_id: row.supersedes_id === null ? null : asMedicationRequestId(row.supersedes_id),
    superseded_by_id:
      row.superseded_by_id === null ? null : asMedicationRequestId(row.superseded_by_id),
    country_of_care: row.country_of_care,
    created_at: tsToIso(row.created_at),
    updated_at: tsToIso(row.updated_at),
  };
}

const COLUMNS = `
  id, tenant_id, patient_account_id, product_catalog_id,
  medication_name, strength, formulation, dose_instructions,
  quantity, quantity_unit, refills_allowed, indication, clinical_notes,
  status,
  prescribed_at, activated_at, discontinued_at, discontinued_reason, expires_at,
  prescribed_by_clinician_account_id, prescribing_consult_id,
  interaction_signals_evaluated_at, interaction_signals_status,
  ai_workload_type, autonomy_level, protocol_id, protocol_version,
  supersedes_id, superseded_by_id,
  country_of_care, created_at, updated_at
`;

// ---------------------------------------------------------------------------
// CreateDraftInput — initial INSERT at status='draft'
// ---------------------------------------------------------------------------

export interface CreateDraftInput {
  id: MedicationRequestId;
  tenant_id: TenantId;
  patient_account_id: AccountId;
  product_catalog_id: ProductCatalogId;
  medication_name: string;
  strength: string;
  formulation: string;
  dose_instructions: string;
  quantity: number;
  quantity_unit: string;
  refills_allowed: number;
  indication?: string | null;
  clinical_notes?: string | null;
  country_of_care: string;
  /** Clinician anchor — nullable while status='draft' per SI-001 DRAFT. */
  prescribed_by_clinician_account_id?: AccountId | null;
  prescribing_consult_id?: string | null;
  expires_at?: string | null;
}

/**
 * INSERT a new medication_request at status='draft'. Composite FK
 * `medication_requests_tenant_patient_fk` enforces same-tenant patient
 * binding at the DB layer. Same-transaction audit + domain-event
 * emission is the service layer's responsibility (this repo is pure
 * DB access).
 */
export async function createDraft(
  input: CreateDraftInput,
  txCallback: (tx: DbTransaction, row: MedicationRequest) => Promise<void>,
  externalTx?: DbTransaction,
): Promise<MedicationRequest> {
  const runFn = async (tx: DbClient): Promise<MedicationRequest> => {
    const result = await tx.query<MedicationRequestRow>(
      `INSERT INTO medication_requests (
          id, tenant_id, patient_account_id, product_catalog_id,
          medication_name, strength, formulation, dose_instructions,
          quantity, quantity_unit, refills_allowed, indication, clinical_notes,
          status, country_of_care,
          prescribed_by_clinician_account_id, prescribing_consult_id, expires_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
                 'draft', $14, $15, $16, $17)
       RETURNING ${COLUMNS}`,
      [
        input.id,
        input.tenant_id,
        input.patient_account_id,
        input.product_catalog_id,
        input.medication_name,
        input.strength,
        input.formulation,
        input.dose_instructions,
        input.quantity,
        input.quantity_unit,
        input.refills_allowed,
        input.indication ?? null,
        input.clinical_notes ?? null,
        input.country_of_care,
        input.prescribed_by_clinician_account_id ?? null,
        input.prescribing_consult_id ?? null,
        input.expires_at ?? null,
      ],
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw new Error('createDraft: INSERT returned no rows');
    }
    const mr = rowToMedicationRequest(row);
    await txCallback(tx, mr);
    return mr;
  };
  if (externalTx !== undefined) return runFn(externalTx);
  return withTenantBoundConnection(input.tenant_id, runFn);
}

// ---------------------------------------------------------------------------
// findById — tenant-blind null on miss (I-025)
// ---------------------------------------------------------------------------

export async function findById(
  tenantId: TenantId,
  id: MedicationRequestId,
  externalTx?: DbClient,
): Promise<MedicationRequest | null> {
  const runner = externalTx
    ? (fn: (client: DbClient) => Promise<MedicationRequest | null>) => fn(externalTx)
    : (fn: (client: DbClient) => Promise<MedicationRequest | null>) =>
        withTenantBoundConnection(tenantId, fn);
  return runner(async (client) => {
    // Defense-in-depth: explicit tenant_id predicate on top of RLS
    // (mirrors consult-repo / consent-repo pattern).
    const result = await client.query<MedicationRequestRow>(
      `SELECT ${COLUMNS}
         FROM medication_requests
        WHERE id = $1 AND tenant_id = $2
        LIMIT 1`,
      [id, tenantId],
    );
    if (result.rows.length === 0) return null;
    const row = result.rows[0];
    if (row === undefined) return null;
    return rowToMedicationRequest(row);
  });
}

// ---------------------------------------------------------------------------
// findByPatient — list all rows for a patient (active + historical)
// ---------------------------------------------------------------------------

export async function findByPatient(
  tenantId: TenantId,
  patientAccountId: AccountId,
  externalTx?: DbClient,
): Promise<MedicationRequest[]> {
  const runner = externalTx
    ? (fn: (client: DbClient) => Promise<MedicationRequest[]>) => fn(externalTx)
    : (fn: (client: DbClient) => Promise<MedicationRequest[]>) =>
        withTenantBoundConnection(tenantId, fn);
  return runner(async (client) => {
    const result = await client.query<MedicationRequestRow>(
      `SELECT ${COLUMNS}
         FROM medication_requests
        WHERE tenant_id = $1 AND patient_account_id = $2
        ORDER BY created_at DESC, id DESC`,
      [tenantId, patientAccountId],
    );
    return result.rows.map(rowToMedicationRequest);
  });
}

// ---------------------------------------------------------------------------
// UpdateStatusInput — optimistic-concurrency state transition
// ---------------------------------------------------------------------------

export interface UpdateStatusInput {
  id: MedicationRequestId;
  tenant_id: TenantId;
  to_status: MedicationRequestStatus;
  /**
   * Expected from-status (optimistic concurrency). UPDATE matches zero
   * rows if the medication_request has advanced past this status; the
   * function returns null. Service layer maps null → conflict.
   */
  expected_from_status: MedicationRequestStatus;

  // Optional column writes that pair with the status change:
  prescribed_at?: string;
  activated_at?: string;
  discontinued_at?: string;
  discontinued_reason?: DiscontinuedReason;
  expires_at?: string;
  prescribed_by_clinician_account_id?: AccountId;
  interaction_signals_evaluated_at?: string;
  interaction_signals_status?: InteractionSignalsStatus;

  // I-012 envelope writes (paired on the prescribing-decision transitions)
  ai_workload_type?: string;
  autonomy_level?: string;
  protocol_id?: ProtocolId;
  protocol_version?: string;
}

/**
 * Update status + optional companion columns. Optimistic concurrency on
 * `status = $expected_from_status`. Returns the updated row, or null if
 * the from-status precondition didn't match.
 *
 * Defense-in-depth: explicit `tenant_id = $N` predicate (mirrors
 * async-consult updateConsultState — Codex async-consult-r6 HIGH
 * closure).
 */
export async function updateStatus(
  input: UpdateStatusInput,
  externalTx?: DbClient,
): Promise<MedicationRequest | null> {
  const runner = externalTx
    ? (fn: (client: DbClient) => Promise<MedicationRequest | null>) => fn(externalTx)
    : (fn: (client: DbClient) => Promise<MedicationRequest | null>) =>
        withTenantBoundConnection(input.tenant_id, fn);
  return runner(async (client) => {
    // Build dynamic SET clause for the optional companion columns.
    const sets: string[] = ['status = $1', 'updated_at = NOW()'];
    const params: unknown[] = [input.to_status];
    let i = 2;

    const addSet = (col: string, val: unknown): void => {
      sets.push(`${col} = $${i}`);
      params.push(val);
      i += 1;
    };

    if (input.prescribed_at !== undefined) addSet('prescribed_at', input.prescribed_at);
    if (input.activated_at !== undefined) addSet('activated_at', input.activated_at);
    if (input.discontinued_at !== undefined) addSet('discontinued_at', input.discontinued_at);
    if (input.discontinued_reason !== undefined)
      addSet('discontinued_reason', input.discontinued_reason);
    if (input.expires_at !== undefined) addSet('expires_at', input.expires_at);
    if (input.prescribed_by_clinician_account_id !== undefined)
      addSet('prescribed_by_clinician_account_id', input.prescribed_by_clinician_account_id);
    if (input.interaction_signals_evaluated_at !== undefined)
      addSet('interaction_signals_evaluated_at', input.interaction_signals_evaluated_at);
    if (input.interaction_signals_status !== undefined)
      addSet('interaction_signals_status', input.interaction_signals_status);
    if (input.ai_workload_type !== undefined) addSet('ai_workload_type', input.ai_workload_type);
    if (input.autonomy_level !== undefined) addSet('autonomy_level', input.autonomy_level);
    if (input.protocol_id !== undefined) addSet('protocol_id', input.protocol_id);
    if (input.protocol_version !== undefined) addSet('protocol_version', input.protocol_version);

    const idIdx = i;
    params.push(input.id);
    const tenantIdx = i + 1;
    params.push(input.tenant_id);
    const fromIdx = i + 2;
    params.push(input.expected_from_status);

    const sql = `
      UPDATE medication_requests
         SET ${sets.join(', ')}
       WHERE id = $${idIdx}
         AND tenant_id = $${tenantIdx}
         AND status = $${fromIdx}
       RETURNING ${COLUMNS}
    `;
    const result = await client.query<MedicationRequestRow>(sql, params);
    if (result.rows.length === 0) return null;
    const row = result.rows[0];
    if (row === undefined) return null;
    return rowToMedicationRequest(row);
  });
}

// ---------------------------------------------------------------------------
// recordSupersession — atomic supersession-chain INSERT + UPDATE
// ---------------------------------------------------------------------------

export interface RecordSupersessionInput {
  /** The prior medication_request that is being superseded. */
  prior_id: MedicationRequestId;
  /** Pre-allocated id for the NEW row. */
  new_id: MedicationRequestId;
  tenant_id: TenantId;
  /**
   * Status of the NEW row. Per SI-001 DRAFT, discontinuation creates a
   * new row at status='discontinued' linked via supersedes_id; the prior
   * row's status flips to 'superseded' (see prior_to_status default).
   */
  new_status: MedicationRequestStatus;
  new_discontinued_reason?: DiscontinuedReason;
  new_discontinued_at?: string;
  /** Inherited fields from the prior row — caller computes from prior snapshot. */
  patient_account_id: AccountId;
  product_catalog_id: ProductCatalogId;
  medication_name: string;
  strength: string;
  formulation: string;
  dose_instructions: string;
  quantity: number;
  quantity_unit: string;
  refills_allowed: number;
  indication: string | null;
  clinical_notes: string | null;
  country_of_care: string;
}

/**
 * INSERT the new (superseding) row + UPDATE the prior row's
 * status='superseded' + superseded_by_id under a single tx. Caller
 * (service layer) supplies the transaction handle via externalTx OR
 * wraps in withTenantBoundConnection. Same-tx audit + domain emission
 * is the service layer's responsibility.
 *
 * Returns the new row.
 */
export async function recordSupersession(
  input: RecordSupersessionInput,
  txCallback: (tx: DbTransaction, newRow: MedicationRequest) => Promise<void>,
  externalTx?: DbTransaction,
): Promise<MedicationRequest> {
  const runFn = async (tx: DbClient): Promise<MedicationRequest> => {
    // Step 1: INSERT the new row with supersedes_id pointing at the prior
    const insertResult = await tx.query<MedicationRequestRow>(
      `INSERT INTO medication_requests (
          id, tenant_id, patient_account_id, product_catalog_id,
          medication_name, strength, formulation, dose_instructions,
          quantity, quantity_unit, refills_allowed, indication, clinical_notes,
          status, country_of_care,
          discontinued_reason, discontinued_at, supersedes_id
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
                 $14, $15, $16, $17, $18)
       RETURNING ${COLUMNS}`,
      [
        input.new_id,
        input.tenant_id,
        input.patient_account_id,
        input.product_catalog_id,
        input.medication_name,
        input.strength,
        input.formulation,
        input.dose_instructions,
        input.quantity,
        input.quantity_unit,
        input.refills_allowed,
        input.indication,
        input.clinical_notes,
        input.new_status,
        input.country_of_care,
        input.new_discontinued_reason ?? null,
        input.new_discontinued_at ?? null,
        input.prior_id,
      ],
    );
    const newRow = insertResult.rows[0];
    if (newRow === undefined) {
      throw new Error('recordSupersession: INSERT returned no rows');
    }

    // Step 2: UPDATE the prior row's status='superseded' + superseded_by_id
    const updateResult = await tx.query(
      `UPDATE medication_requests
          SET status = 'superseded',
              superseded_by_id = $1,
              updated_at = NOW()
        WHERE id = $2 AND tenant_id = $3 AND status = 'active'
        RETURNING id`,
      [input.new_id, input.prior_id, input.tenant_id],
    );
    if (updateResult.rowCount === 0) {
      throw new Error(
        `recordSupersession: prior medication_request ${String(
          input.prior_id,
        )} was not in 'active' status; supersession requires active prior row`,
      );
    }

    const newMr = rowToMedicationRequest(newRow);
    await txCallback(tx, newMr);
    return newMr;
  };
  if (externalTx !== undefined) return runFn(externalTx);
  return withTenantBoundConnection(input.tenant_id, runFn);
}
