/**
 * medication-request-repo.ts — durable read+write access to the
 * `medication_requests` table per migration 025 / CDM v1.3 §4.16.
 *
 * Sprint 35 / TLC-055 part A (the repository layer). This module is
 * INTERNAL to the pharmacy module per ADR-001 — cross-module callers
 * consume the pharmacy surface via the module's public service layer
 * (TLC-055 part C; route handlers), NOT this repo directly.
 *
 * The repository is a thin layer over SQL. It is responsible for:
 *   - Tenant-scoped CRUD (RLS enforced via `tenant_isolation` policy on
 *     the table; tenant context set per-connection via
 *     `withTenantBoundConnection`).
 *   - Optimistic-concurrency state transitions (`WHERE status =
 *     expected_from_status`) so concurrent writers don't double-advance
 *     the row.
 *   - Calling `validateTransition()` BEFORE issuing the UPDATE so the
 *     I-012 reject-unless three-clause rule + bound-context attestation
 *     cross-check fire at the application layer first (the DB CHECKs
 *     are the durable boundary; the state machine is defense-in-depth).
 *
 * The repository does NOT emit audit or domain events. The service
 * layer (TLC-055 part C) composes:
 *   1. `validateTransition(...)` via the repo's transition methods.
 *   2. Repository UPDATE (durable boundary; optimistic concurrency).
 *   3. `emitAudit(...)` per AUDIT_EVENTS v5.3 (the canonical I-012
 *      action_id IS the row's id per the §9 convention).
 *   4. `emitDomainEvent(...)` per DOMAIN_EVENTS v5.2.
 * All four steps run inside the same transaction so a failure rolls
 * back the entire prescribing decision atomically.
 *
 * Spec references:
 *   - migrations/025_medication_requests.sql (table schema + 14 CHECK
 *     constraints + 6 composite FKs + 2 partial UNIQUE indexes)
 *   - CDM v1.3 §4.16 MedicationRequest (telecheckONE 879cd57)
 *   - State Machines v1.2 §19 MedicationRequest lifecycle
 *   - AUDIT_EVENTS v5.3 §I-012 closure rule
 *   - DOMAIN_EVENTS v5.2 (medication_request.approved.v1 reuse for
 *     both I-012-gated routes; medication_request.{discontinued,
 *     superseded, expired, interaction_safety_hold_triggered}.v1
 *     additions under P-011)
 *   - WORKLOAD_TAXONOMY v5.2 §2.1/§2.2
 *   - AUTONOMY_LEVELS v5.2
 *   - I-003 (audit append-only; bare suppression forbidden)
 *   - I-012 (reject-unless three-clause rule for prescribing execution)
 *   - I-023 / I-025 / I-027 (tenant scoping; tenant-blind errors;
 *     every PHI row carries tenant_id)
 *   - src/modules/pharmacy/internal/state-machine.ts (the
 *     validateTransition() entry point + I012GuardContext +
 *     PendingTransitionContext discriminated unions)
 *   - src/lib/db.ts (withTenantBoundConnection, withTransaction)
 *   - src/lib/glossary.ts (canonical MedicationRequestId validator —
 *     mrx_<26-char ULID> shape; PR #113 R6 closure)
 */

import type { DbClient } from '../../../../lib/db.js';
import { withTenantBoundConnection } from '../../../../lib/db.js';
import {
  type I012GuardContext,
  type PendingTransitionContext,
  validateTransition,
} from '../state-machine.js';
import {
  type AIWorkloadType,
  type AutonomyLevel,
  type InteractionSignalsStatus,
  type MedicationRequest,
  type MedicationRequestDiscontinuedReason,
  type MedicationRequestId,
  type MedicationRequestStatus,
  type ProductCatalogId,
  asMedicationRequestId,
  asProductCatalogId,
} from '../types.js';

// ---------------------------------------------------------------------------
// Column projection + row → entity mapping
// ---------------------------------------------------------------------------

const MEDICATION_REQUEST_COLUMNS = `
  id,
  tenant_id,
  patient_account_id,
  product_catalog_id,
  medication_name,
  strength,
  formulation,
  dose_instructions,
  quantity,
  quantity_unit,
  refills_allowed,
  indication,
  clinical_notes,
  status,
  prescribed_at,
  activated_at,
  discontinued_at,
  discontinued_reason,
  expires_at,
  prescribed_by_clinician_account_id,
  prescribing_consult_id,
  interaction_signals_evaluated_at,
  interaction_signals_status,
  ai_workload_type,
  autonomy_level,
  protocol_id,
  protocol_version,
  supersedes_id,
  superseded_by_id,
  country_of_care,
  created_at,
  updated_at
`;

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
  status: MedicationRequestStatus;
  prescribed_at: Date | null;
  activated_at: Date | null;
  discontinued_at: Date | null;
  discontinued_reason: MedicationRequestDiscontinuedReason | null;
  expires_at: Date | null;
  prescribed_by_clinician_account_id: string | null;
  prescribing_consult_id: string | null;
  interaction_signals_evaluated_at: Date | null;
  interaction_signals_status: InteractionSignalsStatus;
  ai_workload_type: AIWorkloadType | null;
  autonomy_level: AutonomyLevel | null;
  protocol_id: string | null;
  protocol_version: string | null;
  supersedes_id: string | null;
  superseded_by_id: string | null;
  country_of_care: string;
  created_at: Date;
  updated_at: Date;
}

function rowToMedicationRequest(row: MedicationRequestRow): MedicationRequest {
  return {
    id: asMedicationRequestId(row.id),
    tenant_id: row.tenant_id,
    patient_account_id: row.patient_account_id,
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
    status: row.status,
    prescribed_at: row.prescribed_at,
    activated_at: row.activated_at,
    discontinued_at: row.discontinued_at,
    discontinued_reason: row.discontinued_reason,
    expires_at: row.expires_at,
    prescribed_by_clinician_account_id: row.prescribed_by_clinician_account_id,
    prescribing_consult_id: row.prescribing_consult_id,
    interaction_signals_evaluated_at: row.interaction_signals_evaluated_at,
    interaction_signals_status: row.interaction_signals_status,
    ai_workload_type: row.ai_workload_type,
    autonomy_level: row.autonomy_level,
    protocol_id: row.protocol_id,
    protocol_version: row.protocol_version,
    supersedes_id: row.supersedes_id === null ? null : asMedicationRequestId(row.supersedes_id),
    superseded_by_id:
      row.superseded_by_id === null ? null : asMedicationRequestId(row.superseded_by_id),
    country_of_care: row.country_of_care,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/**
 * Shared runner — composes `withTenantBoundConnection` when no externalTx is
 * provided, OR runs `fn` directly with the caller's transaction handle when
 * an externalTx IS provided. This is the canonical repository pattern in this
 * repo (matches consult-repo, consent-repo, etc.). Centralized here so the
 * dispatcher logic isn't duplicated across every repository function.
 */
function makeRunner<T>(
  tenantId: string,
  externalTx: DbClient | undefined,
): (fn: (client: DbClient) => Promise<T>) => Promise<T> {
  return externalTx
    ? (fn: (client: DbClient) => Promise<T>): Promise<T> => fn(externalTx)
    : (fn: (client: DbClient) => Promise<T>): Promise<T> => withTenantBoundConnection(tenantId, fn);
}

// ---------------------------------------------------------------------------
// INSERT — createDraft (status='draft')
// ---------------------------------------------------------------------------

export interface CreateDraftInput {
  /** Canonical MedicationRequestId — `mrx_<26-char ULID>`. Validated at the
   *  `asMedicationRequestId` boundary by the caller; the repository does not
   *  re-validate.
   */
  id: MedicationRequestId;
  tenant_id: string;
  patient_account_id: string;
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
  prescribing_consult_id: string | null;
  country_of_care: string;
  /**
   * Optional route-intent: protocol_id + protocol_version. When set, the
   * draft row captures intent to take the protocol-authorized route at
   * activation time. Per the migration 025 state-dependent protocol-binding
   * CHECK, BOTH MUST be set together or BOTH null (PR #110 R10 closure).
   */
  protocol_id: string | null;
  protocol_version: string | null;
}

/**
 * Insert a new MedicationRequest at status='draft'.
 *
 * The composite FKs enforce same-tenant binding for patient, prescribing
 * consult, product catalog (per PROJECT_CONVENTIONS r5 §1.1):
 *   - patient_account_id resolves to accounts in the SAME tenant
 *   - prescribing_consult_id (if set) resolves to consults in the SAME tenant
 *   - product_catalog_id resolves to product_catalog in the SAME tenant
 * Cross-tenant binding fails at the FK layer even if the caller knows an
 * id from another tenant.
 *
 * The row is created at:
 *   - status='draft'
 *   - interaction_signals_status='pending' (default; engine writeback
 *     flips it via `recordInteractionEvaluation`)
 *   - ai_workload_type/autonomy_level=null (envelope CHECK requires this
 *     for pre-active states)
 *   - protocol_id/protocol_version=optional intent (per the state-dependent
 *     binding CHECK)
 *   - prescribed_by_clinician_account_id=null (set at activation)
 *
 * Returns the inserted row.
 *
 * Throws on:
 *   - FK violation (cross-tenant patient/consult/catalog)
 *   - CHECK violation (e.g., protocol_id without protocol_version)
 *   - PK collision (same id twice)
 */
export async function createDraft(
  input: CreateDraftInput,
  externalTx?: DbClient,
): Promise<MedicationRequest> {
  const runner = makeRunner<MedicationRequest>(input.tenant_id, externalTx);
  return runner(async (client) => {
    const result = await client.query<MedicationRequestRow>(
      `INSERT INTO medication_requests (
         id, tenant_id,
         patient_account_id, product_catalog_id,
         medication_name, strength, formulation,
         dose_instructions, quantity, quantity_unit, refills_allowed,
         indication, clinical_notes,
         status,
         prescribing_consult_id,
         interaction_signals_status,
         protocol_id, protocol_version,
         country_of_care
       ) VALUES (
         $1, $2,
         $3, $4,
         $5, $6, $7,
         $8, $9, $10, $11,
         $12, $13,
         'draft',
         $14,
         'pending',
         $15, $16,
         $17
       )
       RETURNING ${MEDICATION_REQUEST_COLUMNS}`,
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
        input.indication,
        input.clinical_notes,
        input.prescribing_consult_id,
        input.protocol_id,
        input.protocol_version,
        input.country_of_care,
      ],
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw new Error('createDraft: INSERT returned no row');
    }
    return rowToMedicationRequest(row);
  });
}

// ---------------------------------------------------------------------------
// SELECT — findById (tenant-scoped via explicit predicate + RLS)
// ---------------------------------------------------------------------------

/**
 * Find a MedicationRequest by id, scoped to the caller's tenant. Returns
 * null when no row exists in the tenant.
 *
 * Cross-tenant note (I-023 / I-025): if a MedicationRequest with the given
 * id exists in ANOTHER tenant, this query returns null because BOTH the
 * explicit `tenant_id = $2` predicate AND RLS filter it out. The service
 * layer maps null → 404 per the I-025 tenant-blind error envelope; the
 * caller cannot distinguish "doesn't exist" from "exists in another tenant".
 *
 * Defense-in-depth: explicit tenant_id predicate per the pattern Codex
 * established on consult-repo R6 — RLS alone is insufficient on the
 * externalTx path because the connection's tenant context is whatever the
 * caller already bound, which a service/test/retry path could conceivably
 * have wrong.
 */
export async function findById(
  tenantId: string,
  id: MedicationRequestId,
  externalTx?: DbClient,
): Promise<MedicationRequest | null> {
  const runner = makeRunner<MedicationRequest | null>(tenantId, externalTx);
  return runner(async (client) => {
    const result = await client.query<MedicationRequestRow>(
      `SELECT ${MEDICATION_REQUEST_COLUMNS}
         FROM medication_requests
        WHERE id = $1 AND tenant_id = $2`,
      [id, tenantId],
    );
    if (result.rows.length === 0) return null;
    const row = result.rows[0];
    if (row === undefined) return null;
    return rowToMedicationRequest(row);
  });
}

// ---------------------------------------------------------------------------
// SELECT — listForPatient
// ---------------------------------------------------------------------------

export interface ListForPatientOptions {
  /** Restrict to a single status. Omit for all statuses. */
  status?: MedicationRequestStatus;
  /** Limit the number of rows returned (default 50; cap 500). */
  limit?: number;
}

/**
 * List MedicationRequests for a patient in a tenant.
 *
 * Ordering: most-recently-created first. Cross-tenant patient identity does
 * NOT federate at launch (per the gotcha in CLAUDE.md); this query only
 * returns rows in the caller's tenant.
 */
export async function listForPatient(
  tenantId: string,
  patientAccountId: string,
  options?: ListForPatientOptions,
  externalTx?: DbClient,
): Promise<MedicationRequest[]> {
  const requestedLimit = options?.limit ?? 50;
  const limit = Math.min(Math.max(requestedLimit, 1), 500);
  const runner = makeRunner<MedicationRequest[]>(tenantId, externalTx);
  return runner(async (client) => {
    if (options?.status !== undefined) {
      const result = await client.query<MedicationRequestRow>(
        `SELECT ${MEDICATION_REQUEST_COLUMNS}
           FROM medication_requests
          WHERE tenant_id = $1
            AND patient_account_id = $2
            AND status = $3
          ORDER BY created_at DESC
          LIMIT $4`,
        [tenantId, patientAccountId, options.status, limit],
      );
      return result.rows.map(rowToMedicationRequest);
    }
    const result = await client.query<MedicationRequestRow>(
      `SELECT ${MEDICATION_REQUEST_COLUMNS}
         FROM medication_requests
        WHERE tenant_id = $1
          AND patient_account_id = $2
        ORDER BY created_at DESC
        LIMIT $3`,
      [tenantId, patientAccountId, limit],
    );
    return result.rows.map(rowToMedicationRequest);
  });
}

// ---------------------------------------------------------------------------
// UPDATE — engine writeback (recordInteractionEvaluation)
// ---------------------------------------------------------------------------

export interface RecordInteractionEvaluationInput {
  id: MedicationRequestId;
  tenant_id: string;
  /**
   * Result of the engine evaluation. Per migration 025 CHECK constraints:
   *   - 'clean' or 'caution': engine completed; row may transition to
   *     pending_clinician_review via the `engine_clean` event (state
   *     machine §19).
   *   - 'safety_hold': engine flagged a concerning interaction; row
   *     transitions to pending_clinician_review via the `engine_safety_hold`
   *     event (still §19), AND the service layer MUST emit the
   *     `medication_request.interaction_safety_hold_triggered.v1` domain
   *     event so the Med Interaction Engine slice can subscribe to the
   *     override workflow (Path 1 ratified at SI-001 v1.0).
   */
  interaction_signals_status: Exclude<InteractionSignalsStatus, 'pending'>;
  /**
   * Engine evaluation timestamp (typically `new Date()` at writeback time).
   * Required because the durable CHECK
   * `medication_requests_interaction_resolved_when_active` requires
   * `interaction_signals_evaluated_at IS NOT NULL` on active/post-active
   * rows; populating it here closes that requirement at the writeback step.
   */
  interaction_signals_evaluated_at: Date;
}

/**
 * Record the Med Interaction Engine's evaluation result on a
 * pending_interaction_check row. Optimistic concurrency: requires the row
 * to be at status='pending_interaction_check' AND
 * interaction_signals_status='pending' — engine writeback is one-shot per
 * evaluation. Returns null when the precondition didn't match (the engine
 * shouldn't re-evaluate a row whose status has already moved on; the
 * caller should surface the null as a conflict).
 *
 * The status is NOT transitioned here — the engine just writes back its
 * findings. The state-machine event (`engine_clean` /
 * `engine_safety_hold`) advances status separately via `transitionStatus`.
 * This split keeps the engine writeback idempotent against retries: a
 * subsequent `transitionStatus` call can be retried independently if
 * the audit/domain-event emission fails.
 */
export async function recordInteractionEvaluation(
  input: RecordInteractionEvaluationInput,
  externalTx?: DbClient,
): Promise<MedicationRequest | null> {
  const runner = makeRunner<MedicationRequest | null>(input.tenant_id, externalTx);
  return runner(async (client) => {
    const result = await client.query<MedicationRequestRow>(
      `UPDATE medication_requests
          SET interaction_signals_status = $1,
              interaction_signals_evaluated_at = $2,
              updated_at = NOW()
        WHERE id = $3
          AND tenant_id = $4
          AND status = 'pending_interaction_check'
          AND interaction_signals_status = 'pending'
        RETURNING ${MEDICATION_REQUEST_COLUMNS}`,
      [
        input.interaction_signals_status,
        input.interaction_signals_evaluated_at,
        input.id,
        input.tenant_id,
      ],
    );
    if (result.rows.length === 0) return null;
    const row = result.rows[0];
    if (row === undefined) return null;
    return rowToMedicationRequest(row);
  });
}

// ---------------------------------------------------------------------------
// UPDATE — transitionStatus (generic state transition)
// ---------------------------------------------------------------------------

export interface TransitionStatusInput {
  id: MedicationRequestId;
  tenant_id: string;
  /** Expected current status (optimistic concurrency precondition). */
  expected_from_status: MedicationRequestStatus;
  /** Target status per State Machines v1.2 §19 transition table. */
  to_status: MedicationRequestStatus;
  /**
   * The transition event being applied. Used to call
   * `validateTransition` BEFORE the UPDATE so the I-012 reject-unless
   * three-clause rule + the route-discriminator + the bound-context
   * attestation cross-check fire at the application layer first.
   *
   * Must match the event whose `to` state in the §19 transition table
   * equals `to_status` AND whose `from` state equals `expected_from_status`
   * — otherwise `validateTransition` throws `InvalidTransitionError`.
   */
  event: Parameters<typeof validateTransition>[1];
  /**
   * I-012 guard context — REQUIRED for I-012-gated events
   * (`clinician_approve`, `protocol_authorized_prescribing`); undefined
   * for all other events. Validated by `validateTransition`.
   */
  i012_guard?: I012GuardContext;
  /**
   * Pending transition context for I-012-gated events. Per the row.id ==
   * action_id convention (state-machine §9 + PR #113 closure), the service
   * layer constructs this from the actual MedicationRequest row; the state
   * machine cross-checks the guard's `attested_*` fields against these
   * values.
   */
  pending_transition?: PendingTransitionContext;
  /**
   * Optional activation-envelope fields. Required when `to_status='active'`
   * via the `protocol_authorized_prescribing` event (per migration 025
   * CHECK constraints). For the `clinician_approve` route these stay
   * undefined (envelope null/null per CHECK clause (a)).
   */
  activation_envelope?: {
    ai_workload_type: AIWorkloadType;
    autonomy_level: AutonomyLevel;
  };
  /** Required when `to_status='active'`. */
  prescribed_by_clinician_account_id?: string;
  /** Required when `to_status='active'`. */
  prescribed_at?: Date;
  /** Optional: prescription validity window end. */
  expires_at?: Date | null;
  /**
   * Optional: supersedes_id back-pointer (the new row's link back at
   * the row it replaces). Only valid when `to_status='active'` per the
   * migration 025 `medication_requests_supersedes_id_only_on_replacement`
   * CHECK — the back-pointer is established as part of the new row's
   * activation, NOT at draft time. Service layer (TLC-055 PR C) is
   * responsible for the full supersession composition:
   *   1. createDraft(new_draft) — no supersedes_id yet (CHECK forbids
   *      it on draft rows).
   *   2. recordInteractionEvaluation + advance through lifecycle.
   *   3. transitionStatus(new_id, to_status='active',
   *      supersedes_id=old_id, ...) — back-pointer established here.
   *   4. markSuperseded(old_id, new_id) — forward pointer established
   *      on the old row.
   * Added 2026-05-13 per Codex TLC-055 PR A R1 HIGH closure.
   */
  supersedes_id?: MedicationRequestId | null;
  /**
   * Required when `to_status='discontinued'` (any of the three discontinue
   * events). Must match one of the canonical reasons per the
   * `medication_requests_discontinued_reason_valid` CHECK.
   */
  discontinued_reason?: MedicationRequestDiscontinuedReason;
  /** Required when `to_status='discontinued'`. */
  discontinued_at?: Date;
}

/**
 * Apply a state transition to a MedicationRequest. Calls
 * `validateTransition(from, event, i012_guard?, pending_transition?)`
 * BEFORE issuing the UPDATE so I-012 + bound-context cross-checks fire
 * at the application layer; throws on rejection so the caller's
 * transaction aborts and the row stays unchanged.
 *
 * **Defense-in-depth row-binding check (added Codex TLC-055 PR A R1
 * MEDIUM closure 2026-05-13):** before delegating to validateTransition,
 * this function cross-checks `pending_transition.action_id === input.id`
 * and `pending_transition.tenant_id === input.tenant_id`. The
 * state-machine §9 convention says the canonical I-012 action_id IS the
 * row's id, so a guard whose attested context binds to a DIFFERENT row
 * means a service-layer mix-up (validated audit evidence for row B
 * applied to row A). Without this check, the durable UPDATE could land
 * with a guard from a different row.
 *
 * The UPDATE is optimistic-concurrency-guarded
 * (`WHERE status = expected_from_status`); when concurrent writers race,
 * the second UPDATE matches zero rows and this function returns null.
 * The caller (service layer) maps null → conflict-error response.
 *
 * Activation handling: when `to_status='active'`, this method ALSO writes
 * the activation envelope (ai_workload_type, autonomy_level, prescribed_by,
 * prescribed_at, activated_at, expires_at) per the migration 025
 * `medication_requests_i012_envelope_active_check` +
 * `medication_requests_prescriber_set_when_active` +
 * `medication_requests_i012_protocol_binding_check` CHECKs. The DB CHECKs
 * are the durable boundary; this method is defense-in-depth.
 *
 * Discontinuation handling: when `to_status='discontinued'`, this method
 * ALSO writes `discontinued_reason` and `discontinued_at` per the
 * `medication_requests_discontinued_reason_set_when_discontinued` CHECK.
 *
 * For the `expire_at_window_end` event: the caller sets
 * `to_status='expired'`; no extra columns required.
 *
 * For the `clinician_modify` event: the caller transitions back to
 * `pending_interaction_check` and is expected to ALSO call
 * `recordInteractionEvaluation` again afterwards (the engine re-evaluates
 * the modified payload). This method does not auto-reset
 * `interaction_signals_status` because the modify pattern is a re-route
 * that conceptually clears prior engine output.
 *
 * Supersession: the supersession-pair write (INSERT new + UPDATE old) is
 * implemented in the separate `supersedeWithNewPrescription` function
 * because it spans two rows in one transaction (and TLC-055 PR B will
 * add the deferrable constraint trigger that validates reciprocity at
 * commit time).
 */
export async function transitionStatus(
  input: TransitionStatusInput,
  externalTx?: DbClient,
): Promise<MedicationRequest | null> {
  // 0. Defense-in-depth row-binding check (Codex TLC-055 PR A R1 MEDIUM
  // closure 2026-05-13): per the state-machine §9 row.id == action_id
  // convention, the guard's pending_transition MUST bind to the row this
  // function is about to update. Otherwise a service-layer mix-up could
  // validate audit evidence for row B and apply the UPDATE to row A.
  if (input.pending_transition !== undefined) {
    if (input.pending_transition.action_id !== (input.id as string)) {
      throw new Error(
        `transitionStatus: pending_transition.action_id (${input.pending_transition.action_id}) ` +
          `does not match input.id (${input.id}). Per the state-machine §9 row.id == ` +
          'action_id convention, the guard MUST bind to the row being updated.',
      );
    }
    if (input.pending_transition.tenant_id !== input.tenant_id) {
      throw new Error(
        `transitionStatus: pending_transition.tenant_id (${input.pending_transition.tenant_id}) ` +
          `does not match input.tenant_id (${input.tenant_id}). Cross-tenant guard ` +
          'binding is forbidden per I-023 + I-027.',
      );
    }
  }

  // 1. State-machine pre-check — throws InvalidTransitionError or
  // I012RejectError BEFORE the DB is touched. This is the application-layer
  // defense; the DB CHECKs are the durable boundary.
  //
  // CRITICAL: capture validateTransition's return (the canonical §19
  // destination state for `event` from `expected_from_status`) and reject
  // when it ≠ caller's `to_status`. Without this check, a caller could
  // supply event=clinician_modify (valid from pending_clinician_review)
  // paired with to_status='active' (NOT what clinician_modify produces)
  // and the UPDATE dispatch would go through the activation branch,
  // landing the row at status=active without the I-012-gated
  // clinician_approve or protocol_authorized_prescribing path. Codex
  // TLC-055 PR A R2 HIGH closure 2026-05-13.
  const validatedDestination = validateTransition(
    input.expected_from_status,
    input.event,
    input.i012_guard,
    input.pending_transition,
  );
  if (validatedDestination !== input.to_status) {
    throw new Error(
      `transitionStatus: input.to_status (${input.to_status}) does not match the canonical ` +
        `§19 destination for event '${input.event}' from '${input.expected_from_status}' ` +
        `(canonical destination: ${validatedDestination}). Callers MUST supply the same ` +
        'destination state that the state-machine transition produces; mismatches indicate ' +
        'a service-layer bug or an attempt to bypass the state-machine semantics.',
    );
  }

  // 2. Optimistic-concurrency UPDATE with the right SET clause based on the
  // destination state.
  const runner = makeRunner<MedicationRequest | null>(input.tenant_id, externalTx);
  return runner(async (client) => {
    if (input.to_status === 'active') {
      // Activation: writes the full envelope. The DB CHECKs enforce the
      // route-discriminated semantics (clinician-only: null/null/null/null;
      // protocol-authorized: protocol_execution/action_with_confirm/
      // protocol_id/protocol_version).
      if (!input.prescribed_by_clinician_account_id || !input.prescribed_at) {
        throw new Error(
          'transitionStatus: prescribed_by_clinician_account_id + prescribed_at are required when to_status=active',
        );
      }
      const envelopeWorkload = input.activation_envelope?.ai_workload_type ?? null;
      const envelopeAutonomy = input.activation_envelope?.autonomy_level ?? null;
      const result = await client.query<MedicationRequestRow>(
        `UPDATE medication_requests
            SET status = 'active',
                prescribed_at = $1,
                activated_at = $1,
                prescribed_by_clinician_account_id = $2,
                expires_at = $3,
                ai_workload_type = $4,
                autonomy_level = $5,
                supersedes_id = $6,
                updated_at = NOW()
          WHERE id = $7
            AND tenant_id = $8
            AND status = $9
          RETURNING ${MEDICATION_REQUEST_COLUMNS}`,
        [
          input.prescribed_at,
          input.prescribed_by_clinician_account_id,
          input.expires_at ?? null,
          envelopeWorkload,
          envelopeAutonomy,
          input.supersedes_id ?? null,
          input.id,
          input.tenant_id,
          input.expected_from_status,
        ],
      );
      if (result.rows.length === 0) return null;
      return rowToMedicationRequest(result.rows[0] as MedicationRequestRow);
    }

    if (input.to_status === 'discontinued') {
      if (!input.discontinued_reason || !input.discontinued_at) {
        throw new Error(
          'transitionStatus: discontinued_reason + discontinued_at are required when to_status=discontinued',
        );
      }
      const result = await client.query<MedicationRequestRow>(
        `UPDATE medication_requests
            SET status = 'discontinued',
                discontinued_reason = $1,
                discontinued_at = $2,
                updated_at = NOW()
          WHERE id = $3
            AND tenant_id = $4
            AND status = $5
          RETURNING ${MEDICATION_REQUEST_COLUMNS}`,
        [
          input.discontinued_reason,
          input.discontinued_at,
          input.id,
          input.tenant_id,
          input.expected_from_status,
        ],
      );
      if (result.rows.length === 0) return null;
      return rowToMedicationRequest(result.rows[0] as MedicationRequestRow);
    }

    // clinician_modify resets the interaction evaluation atomically with
    // the status transition (Codex TLC-055 PR A R1 HIGH closure
    // 2026-05-13). The modify event reroutes the row back to
    // pending_interaction_check; if the prior engine writeback's
    // interaction_signals_status (clean / caution / safety_hold) carried
    // over, `recordInteractionEvaluation` would refuse to re-write (its
    // precondition is `interaction_signals_status = 'pending'`) AND the
    // stale evaluation could later satisfy the active-row CHECK during
    // activation. Resetting both fields in the same UPDATE closes that
    // safety gap. The DB CHECK
    // `medication_requests_interaction_resolved_when_active` enforces at
    // the durable boundary; this app-layer reset prevents the engine
    // writeback from being silently skipped.
    if (input.event === 'clinician_modify') {
      const result = await client.query<MedicationRequestRow>(
        `UPDATE medication_requests
            SET status = $1,
                interaction_signals_status = 'pending',
                interaction_signals_evaluated_at = NULL,
                updated_at = NOW()
          WHERE id = $2
            AND tenant_id = $3
            AND status = $4
          RETURNING ${MEDICATION_REQUEST_COLUMNS}`,
        [input.to_status, input.id, input.tenant_id, input.expected_from_status],
      );
      if (result.rows.length === 0) return null;
      return rowToMedicationRequest(result.rows[0] as MedicationRequestRow);
    }

    // Generic transition path (no extra column writes): submit_for_review,
    // engine_clean, engine_safety_hold, clinician_decline,
    // expire_at_window_end.
    const result = await client.query<MedicationRequestRow>(
      `UPDATE medication_requests
          SET status = $1,
              updated_at = NOW()
        WHERE id = $2
          AND tenant_id = $3
          AND status = $4
        RETURNING ${MEDICATION_REQUEST_COLUMNS}`,
      [input.to_status, input.id, input.tenant_id, input.expected_from_status],
    );
    if (result.rows.length === 0) return null;
    return rowToMedicationRequest(result.rows[0] as MedicationRequestRow);
  });
}

// ---------------------------------------------------------------------------
// UPDATE — markSuperseded (the supersession write path, scoped to the OLD row)
// ---------------------------------------------------------------------------

export interface MarkSupersededInput {
  tenant_id: string;
  /** The currently-active row that will be marked superseded. */
  old_id: MedicationRequestId;
  /** The id of the new replacement row. The new row MUST already exist
   *  in the same tenant (typically authored via createDraft + advanced
   *  through the lifecycle to active by the time this function is
   *  called); the supersession back-pointer (new.supersedes_id = old_id)
   *  is established as part of the new row's own activation transition,
   *  NOT here. */
  new_id: MedicationRequestId;
}

/**
 * Mark an active MedicationRequest as superseded. This is the OLD row's
 * side of the supersession write: flips its status to 'superseded' and
 * sets `superseded_by_id` pointing forward at the new replacement.
 *
 * Per migration 025 (post-Codex TLC-055 PR A R1 HIGH closure 2026-05-13)
 * the supersession write is split into the OLD-row side (this function)
 * and the NEW-row side (the new row carries `supersedes_id` only after
 * its own activation, when status=active satisfies the
 * `medication_requests_supersedes_id_only_on_replacement` CHECK). The
 * service layer (TLC-055 PR C) is responsible for composing the full
 * supersession flow:
 *   1. createDraft(new_draft) — new row at status=draft, no supersedes_id
 *   2. recordInteractionEvaluation + transitionStatus through the new
 *      row's normal lifecycle to active. At activation,
 *      transitionStatus's activation-envelope can ALSO set
 *      `supersedes_id` to old_id (the back-pointer satisfies the CHECK
 *      because the new row is now active).
 *   3. markSuperseded(old_id, new_id) — this function: old row at
 *      active → superseded, superseded_by_id = new_id (the forward
 *      pointer satisfies the
 *      `medication_requests_superseded_by_id_only_on_superseded` CHECK
 *      because the row's status flips to 'superseded' in the same
 *      UPDATE).
 *
 * Optimistic concurrency: the UPDATE requires `status='active'` — if
 * the old row is no longer active (e.g., concurrent discontinuation),
 * the UPDATE matches zero rows and this function returns null. The
 * caller (service layer) maps null to a conflict error.
 *
 * The DB CHECKs from migration 025 enforce:
 *   - Anti-self-loop: new_id MUST NOT equal old_id (the CHECK
 *     `medication_requests_superseded_by_id_not_self` fires)
 *   - Partial UNIQUE: the same new row CANNOT be claimed as the
 *     replacement of two different originals
 *   - Status-dependent pointers: superseded_by_id is only valid when
 *     this row's status is 'superseded' — that's why the UPDATE flips
 *     status AND sets superseded_by_id in the same SET clause
 *
 * NOT YET ENFORCED at the durable boundary: chain reciprocity (old's
 * superseded_by_id MUST equal new's id AND new's supersedes_id MUST
 * equal old's id). The TLC-055 PR B deferrable CONSTRAINT TRIGGER
 * closes that gap; until then, the same-transaction write semantics
 * here + the service-layer composition above are the runtime
 * guarantee.
 */
export async function markSuperseded(
  input: MarkSupersededInput,
  externalTx?: DbClient,
): Promise<MedicationRequest | null> {
  if (input.old_id === input.new_id) {
    throw new Error(
      'markSuperseded: new_id MUST differ from old_id (anti-self-loop; ' +
        'migration 025 medication_requests_superseded_by_id_not_self CHECK)',
    );
  }
  const runner = makeRunner<MedicationRequest | null>(input.tenant_id, externalTx);
  return runner(async (client) => {
    // Reciprocity-at-the-write-boundary check (Codex TLC-055 PR A R2 HIGH
    // closure 2026-05-13): the UPDATE only matches when the new
    // replacement row ALREADY exists, is in the same tenant, is at
    // status='active', AND already carries supersedes_id = old_id. This
    // closes the gap that would otherwise let a caller mark A superseded
    // by any unrelated row B (draft/rejected/different-patient) in the
    // same tenant — TLC-055 PR B's deferrable CONSTRAINT TRIGGER will be
    // the durable reciprocity enforcement; until that lands, this EXISTS
    // subquery is the repo-layer guarantee.
    //
    // The composition order matters: the service layer MUST have
    // activated the replacement (with supersedes_id=old_id supplied in
    // transitionStatus's activation envelope) BEFORE calling
    // markSuperseded; otherwise the EXISTS check fires and this returns
    // null (the caller maps to a conflict-error response).
    // Same-patient binding (added Codex TLC-055 PR A R3 HIGH closure
    // 2026-05-13): the EXISTS predicate also requires
    // new_row.patient_account_id = old.patient_account_id. Without this,
    // a service-layer mix-up could mark patient A's active prescription
    // as superseded by patient B's active replacement (same tenant, same
    // pointer shape, different patient). That would corrupt the
    // medication chain and cross-link PHI in downstream subscription /
    // notification / refill / audit consumers.
    const result = await client.query<MedicationRequestRow>(
      `UPDATE medication_requests AS old
          SET status = 'superseded',
              superseded_by_id = $1,
              updated_at = NOW()
        WHERE old.id = $2
          AND old.tenant_id = $3
          AND old.status = 'active'
          AND EXISTS (
            SELECT 1 FROM medication_requests AS new_row
             WHERE new_row.id = $1
               AND new_row.tenant_id = $3
               AND new_row.status = 'active'
               AND new_row.supersedes_id = $2
               AND new_row.patient_account_id = old.patient_account_id
          )
        RETURNING ${MEDICATION_REQUEST_COLUMNS}`,
      [input.new_id, input.old_id, input.tenant_id],
    );
    if (result.rows.length === 0) return null;
    const row = result.rows[0];
    if (row === undefined) return null;
    return rowToMedicationRequest(row);
  });
}
