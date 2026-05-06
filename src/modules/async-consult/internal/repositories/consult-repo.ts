/**
 * consult-repo.ts — read + write access to the `consults` table per
 * migration 020 / SI-005 placeholder schema.
 *
 * Tenant-scoped (RLS enforced via `tenant_isolation` policy on the table
 * + the composite FKs from migration 020 inline / migration 021 ALTER).
 * All queries route through `withTenantBoundConnection(tenantId, ...)`
 * which sets the per-connection tenant context that RLS reads via
 * `current_tenant_id()`.
 *
 * This repo is INTERNAL to the async-consult module per ADR-001.
 * Cross-module callers consume the consult surface via the module's
 * public service layer (Sprint 9 TLC-021d), NOT this repo directly.
 *
 * Spec references:
 *   - migrations/020_async_consult.sql (placeholder schema)
 *   - migrations/021_async_consult_tenant_boundary_constraints.sql
 *     (composite-FK retrofit for upgraded DBs)
 *   - SI-005 (Consult / ConsultEvent schema gap; resume gate)
 *   - I-023 (tenant scoping; 3-layer enforcement — RLS at this layer)
 *   - I-027 (tenant_id on every PHI record; composite FKs prove
 *     same-tenant binding to patient + intake form)
 */

import type { DbClient } from '../../../../lib/db.js';
import { withTenantBoundConnection } from '../../../../lib/db.js';
import {
  asConsultId,
  type Consult,
  type ConsultId,
  type ConsultModality,
  type ConsultState,
  type ConsultType,
} from '../types.js';

const CONSULT_COLUMNS = `
  id            AS consult_id,
  tenant_id,
  patient_id,
  consult_type,
  modality,
  state,
  current_program_catalog_entry_id,
  intake_form_submission_id,
  created_at::text AS created_at,
  updated_at::text AS updated_at
`;

interface ConsultRow {
  consult_id: string;
  tenant_id: string;
  patient_id: string;
  consult_type: ConsultType;
  modality: ConsultModality;
  state: ConsultState;
  current_program_catalog_entry_id: string | null;
  intake_form_submission_id: string | null;
  created_at: string;
  updated_at: string;
}

function rowToConsult(row: ConsultRow): Consult {
  return {
    consult_id: asConsultId(row.consult_id),
    tenant_id: row.tenant_id,
    patient_id: row.patient_id,
    consult_type: row.consult_type,
    modality: row.modality,
    state: row.state,
    current_program_catalog_entry_id: row.current_program_catalog_entry_id,
    intake_form_submission_id: row.intake_form_submission_id,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

// ---------------------------------------------------------------------------
// INSERT — initiate a new consult at INITIATED state
// ---------------------------------------------------------------------------

export interface CreateConsultInput {
  consult_id: ConsultId;
  tenant_id: string;
  patient_id: string;
  consult_type: ConsultType;
  modality: ConsultModality;
  current_program_catalog_entry_id: string | null;
}

/**
 * Insert a new consult row at the INITIATED state. The composite FK
 * `consults_tenant_patient_fk` enforces at the DB layer that the
 * patient_id resolves to an account in the SAME tenant — preventing
 * cross-tenant patient binding even if the caller knows a patient_id
 * from another tenant. Codex async-consult-r1 HIGH closure 2026-05-05.
 */
export async function createConsult(
  input: CreateConsultInput,
  externalTx?: DbClient,
): Promise<Consult> {
  const runner = externalTx
    ? (fn: (client: DbClient) => Promise<Consult>) => fn(externalTx)
    : (fn: (client: DbClient) => Promise<Consult>) =>
        withTenantBoundConnection(input.tenant_id, fn);
  return runner(async (client) => {
    const result = await client.query<ConsultRow>(
      `INSERT INTO consults (
         id, tenant_id, patient_id, consult_type, modality, state,
         current_program_catalog_entry_id
       ) VALUES ($1, $2, $3, $4, $5, 'INITIATED', $6)
       RETURNING ${CONSULT_COLUMNS}`,
      [
        input.consult_id,
        input.tenant_id,
        input.patient_id,
        input.consult_type,
        input.modality,
        input.current_program_catalog_entry_id,
      ],
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw new Error('createConsult: INSERT returned no row');
    }
    return rowToConsult(row);
  });
}

// ---------------------------------------------------------------------------
// SELECT — read a consult by id (tenant-scoped via RLS)
// ---------------------------------------------------------------------------

/**
 * Look up a consult by id. Returns null if no consult with that id
 * exists in the current tenant context.
 *
 * Cross-tenant note (I-023 / I-025): if a consult with the given id
 * exists in ANOTHER tenant, this query returns null because BOTH the
 * explicit `tenant_id = $2` predicate AND RLS filter it out. The
 * handler layer maps null → 404 per I-025 tenant-blind error envelope;
 * the caller cannot distinguish "doesn't exist" from "exists in
 * another tenant".
 *
 * Defense-in-depth: explicit tenant_id predicate per Codex
 * async-consult-r6 HIGH closure 2026-05-05. RLS alone is insufficient
 * on the externalTx path because the connection's tenant context is
 * whatever the caller already bound — a service/test/retry path with
 * a stale or wrong tenant context could otherwise read cross-tenant
 * rows. The explicit predicate guarantees same-tenant filtering
 * independent of the connection's RLS context.
 */
export async function findConsultById(
  tenantId: string,
  consultId: ConsultId,
  externalTx?: DbClient,
): Promise<Consult | null> {
  const runner = externalTx
    ? (fn: (client: DbClient) => Promise<Consult | null>) => fn(externalTx)
    : (fn: (client: DbClient) => Promise<Consult | null>) =>
        withTenantBoundConnection(tenantId, fn);
  return runner(async (client) => {
    const result = await client.query<ConsultRow>(
      `SELECT ${CONSULT_COLUMNS} FROM consults
        WHERE id = $1 AND tenant_id = $2`,
      [consultId, tenantId],
    );
    if (result.rows.length === 0) return null;
    const row = result.rows[0];
    if (row === undefined) return null;
    return rowToConsult(row);
  });
}

// ---------------------------------------------------------------------------
// UPDATE — state transition
// ---------------------------------------------------------------------------

export interface UpdateConsultStateInput {
  consult_id: ConsultId;
  tenant_id: string;
  to_state: ConsultState;
  /**
   * Expected from_state (optimistic concurrency check). The UPDATE is
   * conditional on `state = expected_from_state` — if the consult has
   * advanced past expected_from_state under another caller, the UPDATE
   * matches zero rows and the function returns null.
   */
  expected_from_state: ConsultState;
  /**
   * Optional: populate intake_form_submission_id at the INTAKE → SUBMITTED
   * transition. Composite FK enforces same-tenant intake form (Codex
   * async-consult-r1 MEDIUM closure 2026-05-05).
   */
  intake_form_submission_id?: string | null;
}

/**
 * Update a consult's state with optimistic concurrency. Returns the
 * updated row, or null if the from_state precondition didn't match
 * (i.e., the consult was already advanced past `expected_from_state`
 * by another caller). Caller decides how to surface that — the service
 * layer typically maps null → conflict error.
 *
 * Defense-in-depth: explicit `tenant_id = $N` predicate per Codex
 * async-consult-r6 HIGH closure 2026-05-05. Same rationale as
 * findConsultById — RLS alone is insufficient on the externalTx path.
 */
export async function updateConsultState(
  input: UpdateConsultStateInput,
  externalTx?: DbClient,
): Promise<Consult | null> {
  const runner = externalTx
    ? (fn: (client: DbClient) => Promise<Consult | null>) => fn(externalTx)
    : (fn: (client: DbClient) => Promise<Consult | null>) =>
        withTenantBoundConnection(input.tenant_id, fn);
  return runner(async (client) => {
    // Two SET clauses depending on whether intake_form_submission_id
    // is being populated as part of the transition (INTAKE → SUBMITTED).
    if (input.intake_form_submission_id !== undefined) {
      const result = await client.query<ConsultRow>(
        `UPDATE consults
            SET state = $1,
                intake_form_submission_id = $2
          WHERE id = $3 AND tenant_id = $4 AND state = $5
          RETURNING ${CONSULT_COLUMNS}`,
        [
          input.to_state,
          input.intake_form_submission_id,
          input.consult_id,
          input.tenant_id,
          input.expected_from_state,
        ],
      );
      if (result.rows.length === 0) return null;
      return rowToConsult(result.rows[0] as ConsultRow);
    }

    const result = await client.query<ConsultRow>(
      `UPDATE consults
          SET state = $1
        WHERE id = $2 AND tenant_id = $3 AND state = $4
        RETURNING ${CONSULT_COLUMNS}`,
      [input.to_state, input.consult_id, input.tenant_id, input.expected_from_state],
    );
    if (result.rows.length === 0) return null;
    return rowToConsult(result.rows[0] as ConsultRow);
  });
}
