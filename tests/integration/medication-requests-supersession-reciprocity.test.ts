/**
 * migrations/026_medication_requests_supersession_reciprocity.sql —
 * DB-backed integration tests for the supersession reciprocity constraint
 * trigger.
 *
 * The trigger is DEFERRABLE INITIALLY DEFERRED so it normally fires at
 * transaction commit time. The test harness (tests/setup.ts) runs every
 * test inside a long-running outer transaction with per-test savepoints
 * and never commits. To exercise the trigger we issue
 * `SET CONSTRAINTS ALL IMMEDIATE` inside each test — which forces all
 * deferred constraints (including our trigger) to evaluate now and raise
 * if any row violates reciprocity. This is the same evaluation Postgres
 * would run at COMMIT in production.
 *
 * Scenarios:
 *   §1 happy path                — reciprocal A↔B passes
 *   §2 one-sided forward         — A.superseded_by=B but B.supersedes_id=NULL
 *   §3 mismatched edge           — A.superseded_by=B but B.supersedes_id=C
 *   §4 cross-patient supersession — A.patient=P1, B.patient=P2 — fails
 *   §5 reverse-edge bad-status    — B.supersedes_id=A but A.status='active'
 *
 * Same-tenant scope. Cross-tenant edges are already prevented at the FK
 * layer (composite FK on (tenant_id, supersedes_id) / (tenant_id,
 * superseded_by_id) in migration 025), so the trigger's tenant check is
 * defense-in-depth and is not exercised here.
 *
 * Dangling-reference cases are also FK-prevented and not exercised here.
 *
 * Spec references:
 *   - migrations/026_medication_requests_supersession_reciprocity.sql
 *   - migrations/025_medication_requests.sql (target table)
 *   - CDM v1.3 §4.16 MedicationRequest
 *   - State Machines v1.2 §19 (8-state lifecycle)
 *   - PROJECT_CONVENTIONS r5 §1.1 (composite UNIQUE / composite FK pattern)
 *   - I-023 / I-027 (tenant scoping; RLS active in this test process)
 */

import { describe, expect, it } from 'vitest';

import { ulid } from '../../src/lib/ulid.ts';
import { TENANT_US, createTestUser, withTenantContext } from '../helpers/tenant-fixtures.ts';
import { uniquePhone } from '../helpers/unique-phone.ts';
import { getTestClient } from '../setup.ts';

// ---------------------------------------------------------------------------
// Local helpers
// ---------------------------------------------------------------------------

/**
 * Generate a canonical MedicationRequestId: `mrx_` + 26-char Crockford
 * base32 (first char ∈ [0-7], remaining 25 from the Crockford alphabet
 * minus I, L, O, U). The migration's row-local CHECK constraint
 * `medication_requests_id_canonical_format` enforces this pattern.
 */
function mrxId(): string {
  return `mrx_${ulid()}`;
}

interface InsertMedicationRequestInput {
  id?: string;
  tenant_id: string;
  patient_account_id: string;
  product_catalog_id: string;
  status:
    | 'draft'
    | 'pending_interaction_check'
    | 'pending_clinician_review'
    | 'active'
    | 'discontinued'
    | 'superseded'
    | 'expired'
    | 'rejected';
  supersedes_id?: string | null;
  superseded_by_id?: string | null;
  discontinued_reason?: string | null;
  interaction_signals_status?: 'pending' | 'clean' | 'caution' | 'safety_hold';
}

/**
 * Insert a medication_request row. Defaults the snapshot/clinical columns
 * to canonical fixture values; the test only configures the fields the
 * supersession trigger cares about (id, tenant_id, patient_account_id,
 * status, supersedes_id, superseded_by_id).
 *
 * MUST be invoked inside a withTenantContext() block — RLS WITH CHECK
 * requires current_tenant_id() to match the row's tenant_id at INSERT.
 */
async function insertMedicationRequest(input: InsertMedicationRequestInput): Promise<string> {
  const client = getTestClient();
  const id = input.id ?? mrxId();
  await client.query(
    `INSERT INTO medication_requests (
        id, tenant_id,
        patient_account_id, product_catalog_id,
        medication_name, strength, formulation,
        dose_instructions, quantity, quantity_unit, refills_allowed,
        status,
        prescribed_at, activated_at,
        prescribed_by_clinician_account_id,
        interaction_signals_status,
        supersedes_id, superseded_by_id,
        discontinued_reason, discontinued_at,
        country_of_care
     ) VALUES (
        $1, $2,
        $3, $4,
        $5, $6, $7,
        $8, $9, $10, $11,
        $12,
        $13, $14,
        $15,
        $16,
        $17, $18,
        $19, $20,
        $21
     )`,
    [
      id,
      input.tenant_id,
      input.patient_account_id,
      input.product_catalog_id,
      'Test Medication',
      '10mg',
      'tablet',
      '1 tablet daily',
      30,
      'tablet',
      0,
      input.status,
      // Pre-active rows leave prescribed_at/activated_at NULL; post-draft
      // rows get a timestamp so the row resembles a real activation.
      input.status === 'draft' ? null : new Date().toISOString(),
      input.status === 'draft' ? null : new Date().toISOString(),
      // prescribed_by_clinician_account_id is nullable only when status='draft'.
      // For test rows that need a clinician, supply one from the closure.
      null,
      input.interaction_signals_status ?? 'pending',
      input.supersedes_id ?? null,
      input.superseded_by_id ?? null,
      input.discontinued_reason ?? (input.status === 'discontinued' ? 'clinical_decision' : null),
      input.status === 'discontinued' ? new Date().toISOString() : null,
      'US',
    ],
  );
  return id;
}

/**
 * Insert a minimal patient account under the given tenant context. Returns
 * the account_id (ULID).
 */
async function insertPatient(tenantId: string): Promise<string> {
  const client = getTestClient();
  const accountId = ulid();
  await client.query(
    `INSERT INTO accounts (
        account_id, tenant_id, phone_e164, email,
        first_name, last_name, date_of_birth, gender, national_id,
        country_of_residence, country_of_care, locale,
        account_type, status
     ) VALUES ($1, $2, $3, $4,
               $5, $6, $7, $8, $9,
               $10, $11, $12,
               $13, $14)`,
    [
      accountId,
      tenantId,
      uniquePhone(),
      null,
      'Test',
      'Patient',
      '1990-01-01',
      'prefer_not_to_say',
      null,
      'US',
      'US',
      'en-US',
      'patient',
      'active',
    ],
  );
  return accountId;
}

/**
 * Insert a minimal product_catalog row. Mirrors the canonical insert from
 * tests/integration/product-catalog-migration.test.ts.
 */
async function insertProduct(tenantId: string): Promise<string> {
  const client = getTestClient();
  const id = ulid();
  await client.query(
    `INSERT INTO product_catalog (
        id, tenant_id, display_name, generic_name, rxnorm_code, ndc_codes,
        form, strength, package_size, program, category, available_adapters,
        preferred_adapter, is_compounded, compounding_pharmacy_type, pricing,
        subscription_eligible, status
     ) VALUES (
        $1, $2, $3, $4, $5, $6::jsonb,
        $7, $8, $9, $10, $11, $12::jsonb,
        $13, $14, $15, $16::jsonb,
        $17, $18
     )`,
    [
      id,
      tenantId,
      'Test Medication',
      'test_generic',
      null,
      JSON.stringify(null),
      'tablet',
      '10mg',
      '30 tablets',
      'weight_loss',
      'primary_treatment',
      JSON.stringify(['truepill']),
      'truepill',
      false,
      null,
      JSON.stringify({ monthly: 199.0 }),
      true,
      'active',
    ],
  );
  return id;
}

/**
 * Force the DEFERRABLE INITIALLY DEFERRED reciprocity trigger to evaluate
 * NOW. Mirrors the COMMIT-time evaluation Postgres would do in production.
 * Returns the trigger error message if a violation was raised, or null on
 * pass.
 */
async function forceConstraintCheck(): Promise<string | null> {
  const client = getTestClient();
  try {
    await client.query('SET CONSTRAINTS ALL IMMEDIATE');
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

describe('migration 026 — supersession reciprocity trigger', () => {
  it('§1 well-formed reciprocal edge A↔B passes commit-time evaluation', async () => {
    const T = TENANT_US;

    await withTenantContext(T, async () => {
      // Establish a non-superuser clinician identity for the actor channel.
      // Not directly referenced by the trigger, but documents the scenario.
      await createTestUser(T, 'clinician');

      const patient = await insertPatient(T);
      const product = await insertProduct(T);

      // Build the canonical activation pair:
      //   A — the original (status='superseded', superseded_by_id=B)
      //   B — the replacement (status='active', supersedes_id=A)
      // Both same tenant + same patient + status set consistently with
      // the row-local CHECK constraints in migration 025.
      const aId = mrxId();
      const bId = mrxId();

      // Insert A initially as 'superseded' pointing forward at B. The
      // composite self-FK requires B to exist first, so insert B first,
      // then A — but A's status='superseded' requires superseded_by_id
      // to be set per CHECK constraint
      // `medication_requests_superseded_by_id_only_on_superseded`. Order:
      //   1. INSERT B (status='active', supersedes_id=A) — FK to A needs A to exist.
      //   2. INSERT A (status='superseded', superseded_by_id=B).
      // Two FKs would create a chicken-and-egg. Resolution: use
      // SET CONSTRAINTS ALL DEFERRED inside this test so the two
      // self-FKs are also deferred — they evaluate at SET CONSTRAINTS
      // ALL IMMEDIATE alongside the reciprocity trigger.
      await getTestClient().query('SET CONSTRAINTS ALL DEFERRED');

      await insertMedicationRequest({
        id: bId,
        tenant_id: T,
        patient_account_id: patient,
        product_catalog_id: product,
        status: 'active',
        supersedes_id: aId,
        interaction_signals_status: 'clean',
      });
      await insertMedicationRequest({
        id: aId,
        tenant_id: T,
        patient_account_id: patient,
        product_catalog_id: product,
        status: 'superseded',
        superseded_by_id: bId,
        interaction_signals_status: 'clean',
      });

      const result = await forceConstraintCheck();
      expect(result).toBeNull();
    });
  });

  it('§2 one-sided forward edge (A→B, B.supersedes_id=NULL) fails at commit-time', async () => {
    const T = TENANT_US;

    await withTenantContext(T, async () => {
      const patient = await insertPatient(T);
      const product = await insertProduct(T);

      const aId = mrxId();
      const bId = mrxId();

      await getTestClient().query('SET CONSTRAINTS ALL DEFERRED');

      // B exists but does NOT carry the matching back-pointer.
      await insertMedicationRequest({
        id: bId,
        tenant_id: T,
        patient_account_id: patient,
        product_catalog_id: product,
        status: 'active',
        supersedes_id: null,
        interaction_signals_status: 'clean',
      });
      // A points forward at B but B doesn't point back. One-sided edge.
      await insertMedicationRequest({
        id: aId,
        tenant_id: T,
        patient_account_id: patient,
        product_catalog_id: product,
        status: 'superseded',
        superseded_by_id: bId,
        interaction_signals_status: 'clean',
      });

      const result = await forceConstraintCheck();
      expect(result).not.toBeNull();
      expect(result).toMatch(/reciprocity violated/i);
      // Direction A's reciprocity check fires: row A has superseded_by=B but
      // B.supersedes_id IS NULL, which IS DISTINCT FROM A's id.
      expect(result).toMatch(/supersedes_id/);
    });
  });

  it('§3 mismatched edge (A→B, B→C) fails at commit-time', async () => {
    const T = TENANT_US;

    await withTenantContext(T, async () => {
      const patient = await insertPatient(T);
      const product = await insertProduct(T);

      const aId = mrxId();
      const bId = mrxId();
      const cId = mrxId();

      await getTestClient().query('SET CONSTRAINTS ALL DEFERRED');

      // C is a separate prior row — also 'superseded' so a back-pointer
      // would be plausible. C.superseded_by points forward at B (for the
      // sake of populating C's required forward pointer); B points back
      // at C, not at A. Result: A's forward edge to B is unreciprocated.
      await insertMedicationRequest({
        id: cId,
        tenant_id: T,
        patient_account_id: patient,
        product_catalog_id: product,
        status: 'superseded',
        superseded_by_id: bId,
        interaction_signals_status: 'clean',
      });
      await insertMedicationRequest({
        id: bId,
        tenant_id: T,
        patient_account_id: patient,
        product_catalog_id: product,
        status: 'active',
        supersedes_id: cId,
        interaction_signals_status: 'clean',
      });
      await insertMedicationRequest({
        id: aId,
        tenant_id: T,
        patient_account_id: patient,
        product_catalog_id: product,
        status: 'superseded',
        superseded_by_id: bId,
        interaction_signals_status: 'clean',
      });

      const result = await forceConstraintCheck();
      expect(result).not.toBeNull();
      expect(result).toMatch(/reciprocity violated/i);
    });
  });

  it('§4 cross-patient supersession (A.patient=P1, B.patient=P2) fails', async () => {
    const T = TENANT_US;

    await withTenantContext(T, async () => {
      const p1 = await insertPatient(T);
      const p2 = await insertPatient(T);
      const product = await insertProduct(T);

      const aId = mrxId();
      const bId = mrxId();

      await getTestClient().query('SET CONSTRAINTS ALL DEFERRED');

      // A and B reciprocate at the pointer level but anchor different
      // patients — the trigger MUST reject the cross-patient edge.
      await insertMedicationRequest({
        id: bId,
        tenant_id: T,
        patient_account_id: p2,
        product_catalog_id: product,
        status: 'active',
        supersedes_id: aId,
        interaction_signals_status: 'clean',
      });
      await insertMedicationRequest({
        id: aId,
        tenant_id: T,
        patient_account_id: p1,
        product_catalog_id: product,
        status: 'superseded',
        superseded_by_id: bId,
        interaction_signals_status: 'clean',
      });

      const result = await forceConstraintCheck();
      expect(result).not.toBeNull();
      expect(result).toMatch(/cross-patient/i);
    });
  });

  it('§5 reverse-edge bad-status (B.supersedes_id=A, A.status=active) fails', async () => {
    const T = TENANT_US;

    await withTenantContext(T, async () => {
      const patient = await insertPatient(T);
      const product = await insertProduct(T);

      const aId = mrxId();
      const bId = mrxId();

      await getTestClient().query('SET CONSTRAINTS ALL DEFERRED');

      // A is 'active' (NOT 'superseded') and carries no forward pointer.
      // B is 'active' and points back at A via supersedes_id. Direction B
      // of the trigger requires the referenced row (A) to have
      // status='superseded' — A's status='active' violates that.
      await insertMedicationRequest({
        id: aId,
        tenant_id: T,
        patient_account_id: patient,
        product_catalog_id: product,
        status: 'active',
        superseded_by_id: null,
        interaction_signals_status: 'clean',
      });
      await insertMedicationRequest({
        id: bId,
        tenant_id: T,
        patient_account_id: patient,
        product_catalog_id: product,
        status: 'active',
        supersedes_id: aId,
        interaction_signals_status: 'clean',
      });

      const result = await forceConstraintCheck();
      expect(result).not.toBeNull();
      // Direction B fires first because A.superseded_by_id IS NULL means
      // Direction A is a no-op for the A row. The error is either the
      // reciprocity-pointer mismatch ("row B has supersedes_id=A but row
      // A has superseded_by_id=null") OR the status mismatch ("row B
      // points back at row A with status=active"). Both are acceptable
      // — both indicate the trigger caught the malformed edge.
      expect(result).toMatch(/reciprocity violated/i);
    });
  });
});
