/**
 * medication-request-repo — unit tests with mocked DbClient.
 *
 * Sprint 35 / TLC-055 PR A. Pure unit tests (no real DB; the DbClient is
 * a `vi.fn()`-backed mock). Verifies:
 *   §1 row → entity mapping correctness
 *   §2 createDraft INSERT shape
 *   §3 findById / listForPatient query shape
 *   §4 recordInteractionEvaluation optimistic-concurrency precondition
 *   §5 transitionStatus calls validateTransition BEFORE the UPDATE
 *      (rejection from validateTransition aborts before any SQL fires)
 *   §6 transitionStatus(to_status='active') requires prescribed_by + prescribed_at
 *   §7 transitionStatus(to_status='discontinued') requires reason + timestamp
 *   §8 supersedeWithNewPrescription anti-self-loop + tenant mismatch + 2-row tx
 *
 * DB-backed integration tests (live RLS + CHECK constraints + supersession
 * reciprocity trigger) land in TLC-055 PR B + repository-integration test
 * scaffolding once TEST_DATABASE_URL is wired in CI.
 *
 * Spec references:
 *   - migrations/025_medication_requests.sql (the durable boundary;
 *     these tests verify the APPLICATION layer that composes against it)
 *   - src/modules/pharmacy/internal/repositories/medication-request-repo.ts
 *   - State Machines v1.2 §19
 *   - AUDIT_EVENTS v5.3 §I-012 closure rule
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';

import type { DbClient } from '../../src/lib/db.ts';
import * as dbModule from '../../src/lib/db.ts';
import {
  type CreateDraftInput,
  type TransitionStatusInput,
  createDraft,
  findById,
  listForPatient,
  markSuperseded,
  recordInteractionEvaluation,
  transitionStatus,
} from '../../src/modules/pharmacy/internal/repositories/medication-request-repo.ts';
import {
  AUDIT_ACTIONS,
  I012RejectError,
  InvalidTransitionError,
  type I012GuardContext,
  type PendingTransitionContext,
} from '../../src/modules/pharmacy/internal/state-machine.ts';
import {
  asMedicationRequestId,
  asProductCatalogId,
} from '../../src/modules/pharmacy/internal/types.ts';

// ---------------------------------------------------------------------------
// Mock DbClient helper — captures every query for assertion
// ---------------------------------------------------------------------------

interface CapturedQuery {
  text: string;
  values: readonly unknown[] | undefined;
}

function makeMockClient(rowsByQueryIndex: ReadonlyArray<ReadonlyArray<Record<string, unknown>>>): {
  client: DbClient;
  captured: CapturedQuery[];
} {
  const captured: CapturedQuery[] = [];
  let queryIndex = 0;
  const client = {
    query: vi.fn(async (text: string, values?: readonly unknown[]) => {
      captured.push({ text, values });
      const rows = rowsByQueryIndex[queryIndex] ?? [];
      queryIndex += 1;
      return { rows: [...rows], rowCount: rows.length };
    }),
  } as unknown as DbClient;
  return { client, captured };
}

/**
 * Build a fully-populated row from sensible defaults. Test cases override
 * fields via the `overrides` partial.
 */
function buildRowFixture(
  overrides: Partial<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    id: 'mrx_01H00000000000000000000001',
    tenant_id: 'Telecheck-US',
    patient_account_id: 'usr_01HABCPATIENTID000000000',
    product_catalog_id: 'prc_01HABCPRODUCTCATALOG0000',
    medication_name: 'Semaglutide',
    strength: '0.25mg/ml',
    formulation: 'injection',
    dose_instructions: 'Inject 0.25mg subcutaneously once weekly',
    quantity: 4,
    quantity_unit: 'ml',
    refills_allowed: 3,
    indication: 'Weight management',
    clinical_notes: null,
    status: 'draft',
    prescribed_at: null,
    activated_at: null,
    discontinued_at: null,
    discontinued_reason: null,
    expires_at: null,
    prescribed_by_clinician_account_id: null,
    prescribing_consult_id: 'cns_01HCONSULTID000000000000',
    interaction_signals_evaluated_at: null,
    interaction_signals_status: 'pending',
    ai_workload_type: null,
    autonomy_level: null,
    protocol_id: null,
    protocol_version: null,
    supersedes_id: null,
    superseded_by_id: null,
    country_of_care: 'US',
    created_at: new Date('2026-05-13T00:00:00.000Z'),
    updated_at: new Date('2026-05-13T00:00:00.000Z'),
    ...overrides,
  };
}

const TENANT = 'Telecheck-US';
const ROW_ID = asMedicationRequestId('mrx_01H00000000000000000000001');
const ROW_ID_2 = asMedicationRequestId('mrx_01H00000000000000000000002');
const PATIENT = 'usr_01HABCPATIENTID000000000';
const CLINICIAN = 'usr_01HABCCLINICIANID0000000';
const PRODUCT = asProductCatalogId('prc_01HABCPRODUCTCATALOG0000');

beforeEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// §1 — Row → entity mapping
// ---------------------------------------------------------------------------

describe('medication-request-repo — §1 row → entity mapping', () => {
  it('§1a findById maps a row through asMedicationRequestId (validates mrx_ prefix)', async () => {
    const { client, captured } = makeMockClient([[buildRowFixture()]]);
    const result = await findById(TENANT, ROW_ID, client);
    expect(result).not.toBeNull();
    expect(result?.id).toBe('mrx_01H00000000000000000000001');
    expect(result?.product_catalog_id).toBe('prc_01HABCPRODUCTCATALOG0000');
    expect(result?.tenant_id).toBe(TENANT);
    expect(result?.status).toBe('draft');
    // Explicit tenant predicate verified
    expect(captured[0]?.text).toContain('WHERE id = $1 AND tenant_id = $2');
    expect(captured[0]?.values).toEqual([ROW_ID, TENANT]);
  });

  it('§1b findById returns null on empty result', async () => {
    const { client } = makeMockClient([[]]);
    const result = await findById(TENANT, ROW_ID, client);
    expect(result).toBeNull();
  });

  it('§1c supersession ids map through asMedicationRequestId (nullable both sides)', async () => {
    const { client } = makeMockClient([
      [
        buildRowFixture({
          supersedes_id: 'mrx_01H00000000000000000000003',
          superseded_by_id: null,
        }),
      ],
    ]);
    const result = await findById(TENANT, ROW_ID, client);
    expect(result?.supersedes_id).toBe('mrx_01H00000000000000000000003');
    expect(result?.superseded_by_id).toBeNull();
  });

  it('§1d rejects a row with a noncanonical id at the mapping boundary (mrx_ shape required)', async () => {
    const { client } = makeMockClient([[buildRowFixture({ id: 'not-a-valid-id' })]]);
    await expect(findById(TENANT, ROW_ID, client)).rejects.toThrow(
      /MedicationRequestId must match the canonical/,
    );
  });
});

// ---------------------------------------------------------------------------
// §2 — createDraft INSERT shape
// ---------------------------------------------------------------------------

describe('medication-request-repo — §2 createDraft', () => {
  const baseInput: CreateDraftInput = {
    id: ROW_ID,
    tenant_id: TENANT,
    patient_account_id: PATIENT,
    product_catalog_id: PRODUCT,
    medication_name: 'Semaglutide',
    strength: '0.25mg/ml',
    formulation: 'injection',
    dose_instructions: 'Inject weekly',
    quantity: 4,
    quantity_unit: 'ml',
    refills_allowed: 3,
    indication: null,
    clinical_notes: null,
    prescribing_consult_id: 'cns_01HCONSULTID000000000000',
    protocol_id: null,
    protocol_version: null,
    country_of_care: 'US',
  };

  it('§2a INSERT shape includes the row at status=draft + interaction_signals_status=pending', async () => {
    const { client, captured } = makeMockClient([[buildRowFixture()]]);
    const result = await createDraft(baseInput, client);
    expect(result.status).toBe('draft');
    const insert = captured[0];
    expect(insert?.text).toContain('INSERT INTO medication_requests');
    expect(insert?.text).toMatch(/'draft'/);
    expect(insert?.text).toMatch(/'pending'/);
    // No ai_workload_type / autonomy_level columns in the INSERT — they
    // MUST stay null at status=draft per the envelope CHECK.
    expect(insert?.text).not.toContain('ai_workload_type,');
    expect(insert?.text).not.toContain('autonomy_level,');
  });

  it('§2b passes protocol_id + protocol_version as route-intent on the draft row', async () => {
    const { captured, client } = makeMockClient([
      [
        buildRowFixture({
          protocol_id: 'prot_01HPROTOCOL000000000000',
          protocol_version: 'v1.0',
        }),
      ],
    ]);
    await createDraft(
      { ...baseInput, protocol_id: 'prot_01HPROTOCOL000000000000', protocol_version: 'v1.0' },
      client,
    );
    expect(captured[0]?.values).toContain('prot_01HPROTOCOL000000000000');
    expect(captured[0]?.values).toContain('v1.0');
  });

  it('§2c throws when INSERT returns no row', async () => {
    const { client } = makeMockClient([[]]);
    await expect(createDraft(baseInput, client)).rejects.toThrow(/INSERT returned no row/);
  });
});

// ---------------------------------------------------------------------------
// §3 — findById + listForPatient query shape
// ---------------------------------------------------------------------------

describe('medication-request-repo — §3 query shape', () => {
  it('§3a listForPatient builds SELECT with explicit tenant predicate + ORDER BY created_at DESC', async () => {
    const { client, captured } = makeMockClient([[buildRowFixture()]]);
    await listForPatient(TENANT, PATIENT, undefined, client);
    expect(captured[0]?.text).toContain('WHERE tenant_id = $1');
    expect(captured[0]?.text).toContain('AND patient_account_id = $2');
    expect(captured[0]?.text).toContain('ORDER BY created_at DESC');
  });

  it('§3b listForPatient with status filter adds AND status = $3', async () => {
    const { client, captured } = makeMockClient([[]]);
    await listForPatient(TENANT, PATIENT, { status: 'active' }, client);
    expect(captured[0]?.text).toContain('AND status = $3');
    expect(captured[0]?.values).toContain('active');
  });

  it('§3c listForPatient clamps limit to [1, 500]', async () => {
    const { client, captured } = makeMockClient([[], []]);
    await listForPatient(TENANT, PATIENT, { limit: 10000 }, client);
    expect(captured[0]?.values?.[2]).toBe(500);
    await listForPatient(TENANT, PATIENT, { limit: 0 }, client);
    expect(captured[1]?.values?.[2]).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// §4 — recordInteractionEvaluation optimistic-concurrency precondition
// ---------------------------------------------------------------------------

describe('medication-request-repo — §4 recordInteractionEvaluation', () => {
  it('§4a UPDATE precondition requires status=pending_interaction_check AND interaction_signals_status=pending', async () => {
    const { client, captured } = makeMockClient([
      [buildRowFixture({ status: 'pending_clinician_review' })],
    ]);
    await recordInteractionEvaluation(
      {
        id: ROW_ID,
        tenant_id: TENANT,
        interaction_signals_status: 'clean',
        interaction_signals_evaluated_at: new Date('2026-05-13T00:00:00.000Z'),
      },
      client,
    );
    const update = captured[0];
    expect(update?.text).toContain("AND status = 'pending_interaction_check'");
    expect(update?.text).toContain("AND interaction_signals_status = 'pending'");
  });

  it('§4b returns null when the precondition matched zero rows (concurrent writer raced)', async () => {
    const { client } = makeMockClient([[]]);
    const result = await recordInteractionEvaluation(
      {
        id: ROW_ID,
        tenant_id: TENANT,
        interaction_signals_status: 'clean',
        interaction_signals_evaluated_at: new Date(),
      },
      client,
    );
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// §5 — transitionStatus calls validateTransition BEFORE the UPDATE
// ---------------------------------------------------------------------------

describe('medication-request-repo — §5 validateTransition pre-check', () => {
  it('§5a InvalidTransitionError from validateTransition fires BEFORE any SQL is issued', async () => {
    const { client, captured } = makeMockClient([[]]);
    // active → clinician_approve is invalid (clinician_approve only runs
    // from pending_clinician_review). validateTransition throws before
    // the UPDATE.
    await expect(
      transitionStatus(
        {
          id: ROW_ID,
          tenant_id: TENANT,
          expected_from_status: 'active',
          to_status: 'active',
          event: 'clinician_approve',
        } as TransitionStatusInput,
        client,
      ),
    ).rejects.toThrow(InvalidTransitionError);
    // No query was issued — validateTransition rejected first.
    expect(captured).toHaveLength(0);
  });

  it('§5b I012RejectError from validateTransition fires BEFORE any SQL is issued (missing guard)', async () => {
    const { client, captured } = makeMockClient([[]]);
    await expect(
      transitionStatus(
        {
          id: ROW_ID,
          tenant_id: TENANT,
          expected_from_status: 'pending_clinician_review',
          to_status: 'active',
          event: 'clinician_approve',
          // No i012_guard / pending_transition supplied
        } as TransitionStatusInput,
        client,
      ),
    ).rejects.toThrow(I012RejectError);
    expect(captured).toHaveLength(0);
  });

  it('§5c happy path: non-I-012 transition fires the UPDATE with status precondition', async () => {
    const { client, captured } = makeMockClient([
      [buildRowFixture({ status: 'pending_interaction_check' })],
    ]);
    const result = await transitionStatus(
      {
        id: ROW_ID,
        tenant_id: TENANT,
        expected_from_status: 'draft',
        to_status: 'pending_interaction_check',
        event: 'submit_for_review',
      },
      client,
    );
    expect(result?.status).toBe('pending_interaction_check');
    expect(captured[0]?.text).toContain('UPDATE medication_requests');
    expect(captured[0]?.text).toContain('AND status = $4');
    expect(captured[0]?.values?.[3]).toBe('draft');
  });

  it('§5c2 rejects when caller-supplied to_status diverges from §19 canonical destination (anti-state-machine-bypass)', async () => {
    // clinician_modify is VALID from pending_clinician_review (it
    // reroutes back to pending_interaction_check). But if a caller
    // pairs it with to_status='active' to try to dispatch the SQL
    // through the activation branch, the validateTransition-return
    // ≠ to_status check (Codex R2 HIGH closure) rejects it.
    const { client, captured } = makeMockClient([]);
    await expect(
      transitionStatus(
        {
          id: ROW_ID,
          tenant_id: TENANT,
          expected_from_status: 'pending_clinician_review',
          to_status: 'active', // ← wrong: clinician_modify produces pending_interaction_check
          event: 'clinician_modify',
        } as TransitionStatusInput,
        client,
      ),
    ).rejects.toThrow(/does not match the canonical §19 destination/);
    expect(captured).toHaveLength(0);
  });

  it('§5d I-012 happy path: clinician_approve with bound guard fires the activation UPDATE', async () => {
    const guard: I012GuardContext = {
      route: 'clinician_approve',
      confirmation_event_audit_id: 'aud_01HCONFIRMATIONEVT0000000',
      attested_tenant_id: TENANT,
      attested_action_id: ROW_ID,
      attested_patient_account_id: PATIENT,
      attested_actor_id: CLINICIAN,
      confirming_actor_rbac_authorized: true,
    };
    const pending: PendingTransitionContext = {
      tenant_id: TENANT,
      action_id: ROW_ID,
      patient_account_id: PATIENT,
      actor_id: CLINICIAN,
      protocol_id: null,
      protocol_version: null,
    };
    const { client, captured } = makeMockClient([
      [
        buildRowFixture({
          status: 'active',
          prescribed_at: new Date('2026-05-13T00:00:00.000Z'),
          activated_at: new Date('2026-05-13T00:00:00.000Z'),
          prescribed_by_clinician_account_id: CLINICIAN,
        }),
      ],
    ]);
    const result = await transitionStatus(
      {
        id: ROW_ID,
        tenant_id: TENANT,
        expected_from_status: 'pending_clinician_review',
        to_status: 'active',
        event: 'clinician_approve',
        i012_guard: guard,
        pending_transition: pending,
        prescribed_by_clinician_account_id: CLINICIAN,
        prescribed_at: new Date('2026-05-13T00:00:00.000Z'),
      },
      client,
    );
    expect(result?.status).toBe('active');
    expect(captured[0]?.text).toContain("SET status = 'active'");
    expect(captured[0]?.text).toContain('prescribed_at = $1');
  });
});

// ---------------------------------------------------------------------------
// §6 — transitionStatus(to_status='active') input validation
// ---------------------------------------------------------------------------

describe('medication-request-repo — §6 activation input validation', () => {
  const baseGuard: I012GuardContext = {
    route: 'clinician_approve',
    confirmation_event_audit_id: 'aud_01HCONFIRMATIONEVT0000000',
    attested_tenant_id: TENANT,
    attested_action_id: ROW_ID,
    attested_patient_account_id: PATIENT,
    attested_actor_id: CLINICIAN,
    confirming_actor_rbac_authorized: true,
  };
  const basePending: PendingTransitionContext = {
    tenant_id: TENANT,
    action_id: ROW_ID,
    patient_account_id: PATIENT,
    actor_id: CLINICIAN,
    protocol_id: null,
    protocol_version: null,
  };

  it('§6a throws when to_status=active is requested without prescribed_by + prescribed_at', async () => {
    const { client } = makeMockClient([[buildRowFixture({ status: 'active' })]]);
    await expect(
      transitionStatus(
        {
          id: ROW_ID,
          tenant_id: TENANT,
          expected_from_status: 'pending_clinician_review',
          to_status: 'active',
          event: 'clinician_approve',
          i012_guard: baseGuard,
          pending_transition: basePending,
          // prescribed_by + prescribed_at missing
        } as TransitionStatusInput,
        client,
      ),
    ).rejects.toThrow(
      /prescribed_by_clinician_account_id \+ prescribed_at are required when to_status=active/,
    );
  });
});

// ---------------------------------------------------------------------------
// §7 — transitionStatus(to_status='discontinued') input validation
// ---------------------------------------------------------------------------

describe('medication-request-repo — §7 discontinuation input validation', () => {
  it('§7a throws when to_status=discontinued is requested without discontinued_reason + discontinued_at', async () => {
    const { client } = makeMockClient([[]]);
    await expect(
      transitionStatus(
        {
          id: ROW_ID,
          tenant_id: TENANT,
          expected_from_status: 'active',
          to_status: 'discontinued',
          event: 'clinician_discontinue',
        } as TransitionStatusInput,
        client,
      ),
    ).rejects.toThrow(
      /discontinued_reason \+ discontinued_at are required when to_status=discontinued/,
    );
  });

  it('§7b happy path: discontinue UPDATE writes status + reason + timestamp', async () => {
    const { client, captured } = makeMockClient([
      [
        buildRowFixture({
          status: 'discontinued',
          discontinued_reason: 'patient_request',
          discontinued_at: new Date('2026-05-13T01:00:00.000Z'),
        }),
      ],
    ]);
    const result = await transitionStatus(
      {
        id: ROW_ID,
        tenant_id: TENANT,
        expected_from_status: 'active',
        to_status: 'discontinued',
        event: 'patient_request_discontinue',
        discontinued_reason: 'patient_request',
        discontinued_at: new Date('2026-05-13T01:00:00.000Z'),
      },
      client,
    );
    expect(result?.status).toBe('discontinued');
    expect(captured[0]?.text).toContain("SET status = 'discontinued'");
    expect(captured[0]?.values).toContain('patient_request');
  });
});

// ---------------------------------------------------------------------------
// §8 — supersedeWithNewPrescription
// ---------------------------------------------------------------------------

describe('medication-request-repo — §8 markSuperseded', () => {
  it('§8a anti-self-loop: rejects when new_id === old_id', async () => {
    const { client } = makeMockClient([]);
    await expect(
      markSuperseded({ tenant_id: TENANT, old_id: ROW_ID, new_id: ROW_ID }, client),
    ).rejects.toThrow(/MUST differ from old_id/);
  });

  it('§8b happy path: UPDATE old row active → superseded + superseded_by_id=new_id', async () => {
    const supersededOldRow = buildRowFixture({
      id: ROW_ID,
      status: 'superseded',
      superseded_by_id: ROW_ID_2,
    });
    const { client, captured } = makeMockClient([[supersededOldRow]]);
    const result = await markSuperseded(
      { tenant_id: TENANT, old_id: ROW_ID, new_id: ROW_ID_2 },
      client,
    );
    expect(result?.id).toBe(ROW_ID);
    expect(result?.status).toBe('superseded');
    expect(result?.superseded_by_id).toBe(ROW_ID_2);
    expect(captured).toHaveLength(1);
    expect(captured[0]?.text).toContain("SET status = 'superseded'");
    expect(captured[0]?.text).toContain('superseded_by_id = $1');
    expect(captured[0]?.text).toContain("AND old.status = 'active'");
  });

  it('§8c returns null when old row no longer active (caller handles conflict)', async () => {
    const { client } = makeMockClient([[]]);
    const result = await markSuperseded(
      { tenant_id: TENANT, old_id: ROW_ID, new_id: ROW_ID_2 },
      client,
    );
    expect(result).toBeNull();
  });

  it('§8d UPDATE WHERE-clause includes EXISTS subquery requiring new row to be active + reciprocally-bound + same-patient', async () => {
    const { client, captured } = makeMockClient([[]]);
    await markSuperseded({ tenant_id: TENANT, old_id: ROW_ID, new_id: ROW_ID_2 }, client);
    const update = captured[0];
    // The reciprocity-at-write-boundary check (Codex R2 HIGH closure)
    expect(update?.text).toContain('EXISTS (');
    expect(update?.text).toContain('FROM medication_requests AS new_row');
    expect(update?.text).toContain("new_row.status = 'active'");
    expect(update?.text).toContain('new_row.supersedes_id = $2');
    // The same-patient binding (Codex R3 HIGH closure) — closes
    // cross-patient supersession at the write boundary.
    expect(update?.text).toContain('new_row.patient_account_id = old.patient_account_id');
  });
});

// ---------------------------------------------------------------------------
// §8.5 — Activation with supersedes_id (the new row's back-pointer at
//        activation; per the split-write design after Codex R1 closure)
// ---------------------------------------------------------------------------

describe('medication-request-repo — §8.5 activation back-pointer (supersedes_id at active)', () => {
  it('§8.5a transitionStatus to_status=active writes supersedes_id when supplied', async () => {
    const guard: I012GuardContext = {
      route: 'clinician_approve',
      confirmation_event_audit_id: 'aud_01HCONFIRMATIONEVT0000000',
      attested_tenant_id: TENANT,
      attested_action_id: ROW_ID_2,
      attested_patient_account_id: PATIENT,
      attested_actor_id: CLINICIAN,
      confirming_actor_rbac_authorized: true,
    };
    const pending: PendingTransitionContext = {
      tenant_id: TENANT,
      action_id: ROW_ID_2,
      patient_account_id: PATIENT,
      actor_id: CLINICIAN,
      protocol_id: null,
      protocol_version: null,
    };
    const { client, captured } = makeMockClient([
      [
        buildRowFixture({
          id: ROW_ID_2,
          status: 'active',
          supersedes_id: ROW_ID,
        }),
      ],
    ]);
    await transitionStatus(
      {
        id: ROW_ID_2,
        tenant_id: TENANT,
        expected_from_status: 'pending_clinician_review',
        to_status: 'active',
        event: 'clinician_approve',
        i012_guard: guard,
        pending_transition: pending,
        prescribed_by_clinician_account_id: CLINICIAN,
        prescribed_at: new Date('2026-05-13T00:00:00.000Z'),
        supersedes_id: ROW_ID,
      },
      client,
    );
    // UPDATE statement includes supersedes_id column write
    expect(captured[0]?.text).toContain('supersedes_id = $6');
    expect(captured[0]?.values).toContain(ROW_ID);
    // Activation back-pointer reciprocity (Codex R4 HIGH closure): the
    // UPDATE also EXISTS-checks the old row is same-tenant, same-patient,
    // active, and not already superseded.
    expect(captured[0]?.text).toContain('EXISTS (');
    expect(captured[0]?.text).toContain('FROM medication_requests AS old_row');
    expect(captured[0]?.text).toContain("old_row.status = 'active'");
    expect(captured[0]?.text).toContain('old_row.patient_account_id = new_row.patient_account_id');
    expect(captured[0]?.text).toContain('old_row.superseded_by_id IS NULL');
  });

  it('§8.5b activation WITHOUT supersedes_id uses the simple UPDATE path (no EXISTS check)', async () => {
    const guard: I012GuardContext = {
      route: 'clinician_approve',
      confirmation_event_audit_id: 'aud_01HCONFIRMATIONEVT0000000',
      attested_tenant_id: TENANT,
      attested_action_id: ROW_ID,
      attested_patient_account_id: PATIENT,
      attested_actor_id: CLINICIAN,
      confirming_actor_rbac_authorized: true,
    };
    const pending: PendingTransitionContext = {
      tenant_id: TENANT,
      action_id: ROW_ID,
      patient_account_id: PATIENT,
      actor_id: CLINICIAN,
      protocol_id: null,
      protocol_version: null,
    };
    const { client, captured } = makeMockClient([
      [buildRowFixture({ status: 'active', prescribed_by_clinician_account_id: CLINICIAN })],
    ]);
    await transitionStatus(
      {
        id: ROW_ID,
        tenant_id: TENANT,
        expected_from_status: 'pending_clinician_review',
        to_status: 'active',
        event: 'clinician_approve',
        i012_guard: guard,
        pending_transition: pending,
        prescribed_by_clinician_account_id: CLINICIAN,
        prescribed_at: new Date('2026-05-13T00:00:00.000Z'),
      },
      client,
    );
    // Simple UPDATE path: no EXISTS, supersedes_id = NULL explicitly
    expect(captured[0]?.text).not.toContain('EXISTS (');
    expect(captured[0]?.text).toContain('supersedes_id = NULL');
  });
});

// ---------------------------------------------------------------------------
// §8.6 — clinician_modify resets interaction evaluation state
// ---------------------------------------------------------------------------

describe('medication-request-repo — §8.6 clinician_modify resets interaction state', () => {
  it('§8.6a clinician_modify UPDATEs status + interaction_signals_status=pending + cleared evaluated_at', async () => {
    const { client, captured } = makeMockClient([
      [
        buildRowFixture({
          status: 'pending_interaction_check',
          interaction_signals_status: 'pending',
          interaction_signals_evaluated_at: null,
        }),
      ],
    ]);
    await transitionStatus(
      {
        id: ROW_ID,
        tenant_id: TENANT,
        expected_from_status: 'pending_clinician_review',
        to_status: 'pending_interaction_check',
        event: 'clinician_modify',
      },
      client,
    );
    const update = captured[0];
    expect(update?.text).toContain("interaction_signals_status = 'pending'");
    expect(update?.text).toContain('interaction_signals_evaluated_at = NULL');
  });
});

// ---------------------------------------------------------------------------
// §8.7 — Row-binding defense-in-depth (action_id and tenant_id must match)
// ---------------------------------------------------------------------------

describe('medication-request-repo — §8.7 row-binding defense', () => {
  const guard: I012GuardContext = {
    route: 'clinician_approve',
    confirmation_event_audit_id: 'aud_01HCONFIRMATIONEVT0000000',
    attested_tenant_id: TENANT,
    attested_action_id: ROW_ID,
    attested_patient_account_id: PATIENT,
    attested_actor_id: CLINICIAN,
    confirming_actor_rbac_authorized: true,
  };

  it('§8.7a rejects pending_transition.action_id != input.id (service-layer mix-up)', async () => {
    const pending: PendingTransitionContext = {
      tenant_id: TENANT,
      action_id: ROW_ID_2, // ← belongs to a different row
      patient_account_id: PATIENT,
      actor_id: CLINICIAN,
      protocol_id: null,
      protocol_version: null,
    };
    const { client } = makeMockClient([]);
    await expect(
      transitionStatus(
        {
          id: ROW_ID,
          tenant_id: TENANT,
          expected_from_status: 'pending_clinician_review',
          to_status: 'active',
          event: 'clinician_approve',
          i012_guard: guard,
          pending_transition: pending,
          prescribed_by_clinician_account_id: CLINICIAN,
          prescribed_at: new Date(),
        },
        client,
      ),
    ).rejects.toThrow(/does not match input.id/);
  });

  it('§8.7b rejects pending_transition.tenant_id != input.tenant_id (cross-tenant guard)', async () => {
    const pending: PendingTransitionContext = {
      tenant_id: 'Telecheck-Ghana', // ← different tenant
      action_id: ROW_ID,
      patient_account_id: PATIENT,
      actor_id: CLINICIAN,
      protocol_id: null,
      protocol_version: null,
    };
    const { client } = makeMockClient([]);
    await expect(
      transitionStatus(
        {
          id: ROW_ID,
          tenant_id: TENANT,
          expected_from_status: 'pending_clinician_review',
          to_status: 'active',
          event: 'clinician_approve',
          i012_guard: guard,
          pending_transition: pending,
          prescribed_by_clinician_account_id: CLINICIAN,
          prescribed_at: new Date(),
        },
        client,
      ),
    ).rejects.toThrow(/Cross-tenant guard binding is forbidden/);
  });
});

// ---------------------------------------------------------------------------
// §9 — externalTx path: does NOT call withTenantBoundConnection
// ---------------------------------------------------------------------------

describe('medication-request-repo — §9 externalTx routing', () => {
  it('§9a passing externalTx skips withTenantBoundConnection (the caller owns the tenant context)', async () => {
    const wtbcSpy = vi.spyOn(dbModule, 'withTenantBoundConnection');
    const { client } = makeMockClient([[buildRowFixture()]]);
    await findById(TENANT, ROW_ID, client);
    expect(wtbcSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// §10 — AUDIT_ACTIONS sanity: state-machine action-IDs are canonical strings
// ---------------------------------------------------------------------------

describe('medication-request-repo — §10 AUDIT_ACTIONS canonical strings', () => {
  it('§10a state-machine AUDIT_ACTIONS expose the canonical AUDIT_EVENTS v5.3 action IDs', () => {
    expect(AUDIT_ACTIONS.PRESCRIBING_APPROVED).toBe('prescribing.approved');
    expect(AUDIT_ACTIONS.PROTOCOL_AUTHORIZED_PRESCRIBING).toBe('protocol_authorized_prescribing');
    expect(AUDIT_ACTIONS.PRESCRIBING_PROTOCOL_AUTHORIZATION_GRANTED).toBe(
      'prescribing.protocol_authorization_granted',
    );
    expect(AUDIT_ACTIONS.PRESCRIBING_EXECUTION_REJECTED).toBe('prescribing.execution_rejected');
    expect(AUDIT_ACTIONS.MEDICATION_REQUEST_DRAFTED).toBe('medication_request.drafted');
    expect(AUDIT_ACTIONS.MEDICATION_REQUEST_DISCONTINUED).toBe('medication_request.discontinued');
    expect(AUDIT_ACTIONS.MEDICATION_REQUEST_SUPERSEDED).toBe('medication_request.superseded');
    expect(AUDIT_ACTIONS.MEDICATION_REQUEST_EXPIRED).toBe('medication_request.expired');
  });
});
