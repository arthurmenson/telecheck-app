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
 * FK ORDERING: migration 025 declares the supersession self-FKs without
 * DEFERRABLE, so they remain IMMEDIATE. SET CONSTRAINTS ALL DEFERRED
 * cannot defer them. Tests must insert rows in an order the IMMEDIATE
 * FKs accept:
 *   1. INSERT A as status='active' with NULL forward pointer
 *   2. INSERT B as status='active' with supersedes_id=A.id (B's FK to A
 *      satisfied because A already exists)
 *   3. UPDATE A SET status='superseded', superseded_by_id=B.id (A's FK
 *      to B satisfied because B exists)
 *   4. SET CONSTRAINTS ALL IMMEDIATE — forces the deferred reciprocity
 *      trigger to evaluate at this point
 *
 * Scenarios:
 *   §1 happy path                 — reciprocal A↔B passes
 *   §2 one-sided forward          — A.superseded_by=B but B.supersedes_id=NULL
 *   §3 mismatched edge            — A.superseded_by=B but B.supersedes_id=C
 *   §4 cross-patient supersession — A.patient=P1, B.patient=P2 — fails
 *   §5 reverse-edge bad-status    — B.supersedes_id=A but A.status='active'
 *   §6 search_path shadow-table   — TEMP TABLE attack does NOT bypass the trigger
 *   §7 RLS-context-switch attack  — switching tenant binding before COMMIT does NOT bypass
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
import { TENANT_GHANA, TENANT_US, withTenantContext } from '../helpers/tenant-fixtures.ts';
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
  id: string;
  tenant_id: string;
  patient_account_id: string;
  prescriber_account_id: string;
  product_catalog_id: string;
  status: 'active' | 'superseded';
  supersedes_id?: string | null;
}

/**
 * INSERT a medication_request row with status ∈ {'active', 'superseded'}.
 * Defaults the snapshot/clinical columns to canonical fixture values.
 * Used only as the FIRST step of a 2-row reciprocity scenario; the
 * forward-pointer half of the edge is applied via a follow-up UPDATE
 * (see setForwardPointer below) so the IMMEDIATE self-FK in migration
 * 025 never sees a dangling reference.
 *
 * MUST be invoked inside a withTenantContext() block — RLS WITH CHECK
 * requires current_tenant_id() to match the row's tenant_id at INSERT.
 */
async function insertMedicationRequest(input: InsertMedicationRequestInput): Promise<void> {
  const client = getTestClient();
  // Migration 025's medication_requests_interaction_resolved_when_active
  // CHECK requires that status IN ('active', 'discontinued', 'superseded',
  // 'expired') is paired with interaction_signals_status ∈ {'clean',
  // 'caution'} AND interaction_signals_evaluated_at IS NOT NULL — the
  // engine must have written back before activation. We're inserting
  // active/post-active rows directly for trigger-test purposes, so
  // populate both fields to satisfy the row-local CHECK.
  const now = new Date().toISOString();
  await client.query(
    `INSERT INTO medication_requests (
        id, tenant_id,
        patient_account_id, product_catalog_id,
        medication_name, strength, formulation,
        dose_instructions, quantity, quantity_unit, refills_allowed,
        status,
        prescribed_at, activated_at,
        prescribed_by_clinician_account_id,
        interaction_signals_status, interaction_signals_evaluated_at,
        supersedes_id,
        country_of_care
     ) VALUES (
        $1, $2,
        $3, $4,
        $5, $6, $7,
        $8, $9, $10, $11,
        $12,
        $13, $14,
        $15,
        $16, $17,
        $18,
        $19
     )`,
    [
      input.id,
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
      now,
      now,
      input.prescriber_account_id,
      'clean',
      now,
      input.supersedes_id ?? null,
      'US',
    ],
  );
}

/**
 * UPDATE a medication_request row to flip it into the 'superseded' state
 * with a forward pointer. Migration 025's row-local CHECKs require the
 * combination (status='superseded' AND superseded_by_id IS NOT NULL) or
 * (status<>'superseded' AND superseded_by_id IS NULL); this helper sets
 * both in one statement so the per-row CHECK is satisfied at the same
 * instant the UPDATE lands.
 */
async function setForwardPointer(
  id: string,
  forwardId: string,
  newStatus: 'superseded' = 'superseded',
): Promise<void> {
  await getTestClient().query(
    `UPDATE medication_requests
        SET status = $2, superseded_by_id = $3
      WHERE id = $1`,
    [id, newStatus, forwardId],
  );
}

/**
 * Insert a minimal account under the given tenant context. Returns
 * the account_id (ULID).
 *
 * Note on account_type: migration 012's accounts_account_type_check
 * limits account_type to 'patient' | 'delegate' at v1.0 — clinicians
 * live elsewhere in the data model (not yet wired into this repo's
 * accounts table at the moment). The medication_requests CHECK
 * constraints + composite FK on
 * (tenant_id, prescribed_by_clinician_account_id) reference accounts
 * by (tenant_id, account_id) and do NOT enforce account_type, so we
 * can satisfy the FK + the prescriber_set_when_active CHECK by
 * reusing a 'patient'-typed account as the prescriber. The reciprocity
 * trigger under test doesn't care about account_type either. The
 * semantic mixup is bounded to fixtures here; production prescriber
 * accounts come from the (future) clinicians table.
 */
async function insertAccount(tenantId: string): Promise<string> {
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
      'Account',
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

async function insertPatient(tenantId: string): Promise<string> {
  return insertAccount(tenantId);
}

async function insertClinician(tenantId: string): Promise<string> {
  // See the account_type note on insertAccount: clinicians are not yet
  // wired into the accounts table at v1.0, so a 'patient'-typed account
  // stands in as the prescriber FK target for fixtures.
  return insertAccount(tenantId);
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
 * NOW. Mirrors the COMMIT-time evaluation Postgres would do in
 * production. Returns the trigger error message if a violation was
 * raised, or null on pass.
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
      const patient = await insertPatient(T);
      const product = await insertProduct(T);
      const clinician = await insertClinician(T);

      // FK-safe insert order:
      //   1. A as 'active' (no pointers)
      //   2. B as 'active' with supersedes_id=A.id (FK to A satisfied)
      //   3. UPDATE A to 'superseded' with superseded_by_id=B.id (FK to B satisfied)
      // After step 3 both halves of the edge are reciprocal; the
      // deferred trigger queued for B (step 2 INSERT) and A (step 3
      // UPDATE) fires at SET CONSTRAINTS IMMEDIATE.
      const aId = mrxId();
      const bId = mrxId();
      await insertMedicationRequest({
        id: aId,
        tenant_id: T,
        patient_account_id: patient,
        prescriber_account_id: clinician,
        product_catalog_id: product,
        status: 'active',
      });
      await insertMedicationRequest({
        id: bId,
        tenant_id: T,
        patient_account_id: patient,
        prescriber_account_id: clinician,
        product_catalog_id: product,
        status: 'active',
        supersedes_id: aId,
      });
      await setForwardPointer(aId, bId);

      const result = await forceConstraintCheck();
      expect(result).toBeNull();
    });
  });

  it('§2 one-sided forward edge (A→B, B.supersedes_id=NULL) fails at commit-time', async () => {
    const T = TENANT_US;

    await withTenantContext(T, async () => {
      const patient = await insertPatient(T);
      const product = await insertProduct(T);
      const clinician = await insertClinician(T);

      // A and B both 'active'; B never points back at A. Then flip A
      // to 'superseded' with forward pointer to B — but B's back
      // pointer remains NULL. Reciprocity violated.
      const aId = mrxId();
      const bId = mrxId();
      await insertMedicationRequest({
        id: aId,
        tenant_id: T,
        patient_account_id: patient,
        prescriber_account_id: clinician,
        product_catalog_id: product,
        status: 'active',
      });
      await insertMedicationRequest({
        id: bId,
        tenant_id: T,
        patient_account_id: patient,
        prescriber_account_id: clinician,
        product_catalog_id: product,
        status: 'active',
        // B does NOT carry the matching back-pointer.
        supersedes_id: null,
      });
      await setForwardPointer(aId, bId);

      const result = await forceConstraintCheck();
      expect(result).not.toBeNull();
      expect(result).toMatch(/reciprocity violated/i);
      // Direction A's reciprocity check fires: row A has superseded_by=B
      // but B.supersedes_id IS NULL, which IS DISTINCT FROM A's id.
      expect(result).toMatch(/supersedes_id/);
    });
  });

  it('§3 mismatched edge (A→B, B.supersedes_id=C) fails at commit-time', async () => {
    const T = TENANT_US;

    await withTenantContext(T, async () => {
      const patient = await insertPatient(T);
      const product = await insertProduct(T);
      const clinician = await insertClinician(T);

      // Insert C and B such that B points back at C (not at A). Then
      // insert A pointing forward at B. A's forward edge to B is
      // unreciprocated (B points back at C instead).
      const aId = mrxId();
      const bId = mrxId();
      const cId = mrxId();
      await insertMedicationRequest({
        id: cId,
        tenant_id: T,
        patient_account_id: patient,
        prescriber_account_id: clinician,
        product_catalog_id: product,
        status: 'active',
      });
      await insertMedicationRequest({
        id: bId,
        tenant_id: T,
        patient_account_id: patient,
        prescriber_account_id: clinician,
        product_catalog_id: product,
        status: 'active',
        supersedes_id: cId,
      });
      await insertMedicationRequest({
        id: aId,
        tenant_id: T,
        patient_account_id: patient,
        prescriber_account_id: clinician,
        product_catalog_id: product,
        status: 'active',
      });
      await setForwardPointer(aId, bId);

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
      const clinician = await insertClinician(T);

      // A anchors P1; B anchors P2 with supersedes_id=A — pointer-level
      // reciprocity but mismatched patient. The trigger MUST reject
      // the cross-patient edge.
      const aId = mrxId();
      const bId = mrxId();
      await insertMedicationRequest({
        id: aId,
        tenant_id: T,
        patient_account_id: p1,
        prescriber_account_id: clinician,
        product_catalog_id: product,
        status: 'active',
      });
      await insertMedicationRequest({
        id: bId,
        tenant_id: T,
        patient_account_id: p2,
        prescriber_account_id: clinician,
        product_catalog_id: product,
        status: 'active',
        supersedes_id: aId,
      });
      await setForwardPointer(aId, bId);

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
      const clinician = await insertClinician(T);

      // A and B both 'active'; B carries supersedes_id=A. A's status
      // never flips to 'superseded'. Direction B of the trigger
      // requires the referenced row (A) to have status='superseded';
      // A.status='active' violates that.
      const aId = mrxId();
      const bId = mrxId();
      await insertMedicationRequest({
        id: aId,
        tenant_id: T,
        patient_account_id: patient,
        prescriber_account_id: clinician,
        product_catalog_id: product,
        status: 'active',
      });
      await insertMedicationRequest({
        id: bId,
        tenant_id: T,
        patient_account_id: patient,
        prescriber_account_id: clinician,
        product_catalog_id: product,
        status: 'active',
        supersedes_id: aId,
      });

      const result = await forceConstraintCheck();
      expect(result).not.toBeNull();
      // Direction B fires: A.superseded_by_id IS NULL means Direction A
      // is a no-op for A. The error is either the reciprocity-pointer
      // mismatch ('row B has supersedes_id=A but row A has
      // superseded_by_id=null') OR the status mismatch ('row B points
      // back at row A with status=active'). Both are acceptable —
      // both indicate the trigger caught the malformed edge.
      expect(result).toMatch(/reciprocity violated/i);
    });
  });

  it('§6 search_path shadow-table attack does NOT bypass the trigger', async () => {
    // Codex R2 HIGH closure regression: the trigger function declares
    // `SET search_path = pg_catalog, public` and schema-qualifies every
    // `public.medication_requests` reference. If either guard were
    // weakened, a session that creates a TEMP TABLE named
    // `medication_requests` (which lives in pg_temp) and prepends pg_temp
    // to its search_path could make the function's re-fetch resolve to
    // the shadow table — returning NOT FOUND on a real corrupt row and
    // letting a one-sided supersession edge silently commit.
    //
    // This test mounts that attack and asserts the trigger still
    // rejects the malformed edge. If the test passes, the search_path
    // lock + schema qualification are both effective; if it begins to
    // fail (no error raised), one of those defenses regressed and an
    // adversary with SQL access could bypass reciprocity enforcement.
    const T = TENANT_US;

    await withTenantContext(T, async () => {
      const patient = await insertPatient(T);
      const product = await insertProduct(T);
      const clinician = await insertClinician(T);

      const client = getTestClient();

      // Attempt the shadow-table attack: create an empty TEMP TABLE
      // with the same name, then prepend pg_temp to search_path so
      // unqualified lookups resolve to the empty shadow first.
      await client.query(
        'CREATE TEMP TABLE medication_requests (id VARCHAR(30) PRIMARY KEY) ON COMMIT DROP',
      );
      await client.query('SET LOCAL search_path = pg_temp, public');

      // Construct a one-sided edge (same as §2). If the trigger's
      // function-level search_path lock is in place, the SELECT inside
      // the trigger resolves to public.medication_requests despite the
      // session's pg_temp-first search_path, and the violation is
      // caught. If the lock is missing, the SELECT resolves to the
      // empty pg_temp shadow, returns NOT FOUND, and the trigger
      // silently returns NULL — letting the bad edge commit.
      const aId = mrxId();
      const bId = mrxId();
      await insertMedicationRequest({
        id: aId,
        tenant_id: T,
        patient_account_id: patient,
        prescriber_account_id: clinician,
        product_catalog_id: product,
        status: 'active',
      });
      await insertMedicationRequest({
        id: bId,
        tenant_id: T,
        patient_account_id: patient,
        prescriber_account_id: clinician,
        product_catalog_id: product,
        status: 'active',
        supersedes_id: null,
      });
      await setForwardPointer(aId, bId);

      const result = await forceConstraintCheck();
      expect(result).not.toBeNull();
      expect(result).toMatch(/reciprocity violated/i);
    });
  });

  it('§7 RLS context switch before COMMIT does NOT bypass the trigger', async () => {
    // Codex R3 HIGH closure regression: a SECURITY INVOKER trigger
    // function evaluates its re-fetch under the calling session's RLS
    // context. An adversary with SQL access could:
    //   1. set_tenant_context('Telecheck-US')
    //   2. INSERT a malformed one-sided supersession edge in tenant US
    //   3. set_tenant_context('Telecheck-Ghana') BEFORE SET CONSTRAINTS
    //      IMMEDIATE / COMMIT
    //   4. trigger fires, re-fetches by NEW.id under the Ghana RLS
    //      filter, sees zero rows (US row is RLS-invisible), hits the
    //      NOT FOUND branch, returns silently — letting the bad edge
    //      commit.
    //
    // Fix: trigger function is SECURITY DEFINER, owned by the
    // migration-applying role (superuser / BYPASSRLS). The re-fetch
    // bypasses FORCE RLS and sees the real row regardless of caller
    // tenant binding.
    //
    // This test mounts that attack and asserts the trigger still
    // raises. If SECURITY DEFINER regresses to SECURITY INVOKER, this
    // test starts failing.
    const T = TENANT_US;
    const client = getTestClient();

    await withTenantContext(T, async () => {
      const patient = await insertPatient(T);
      const product = await insertProduct(T);
      const clinician = await insertClinician(T);

      // Construct a one-sided edge under tenant US (same shape as §2).
      const aId = mrxId();
      const bId = mrxId();
      await insertMedicationRequest({
        id: aId,
        tenant_id: T,
        patient_account_id: patient,
        prescriber_account_id: clinician,
        product_catalog_id: product,
        status: 'active',
      });
      await insertMedicationRequest({
        id: bId,
        tenant_id: T,
        patient_account_id: patient,
        prescriber_account_id: clinician,
        product_catalog_id: product,
        status: 'active',
        supersedes_id: null,
      });
      await setForwardPointer(aId, bId);

      // Switch the session's tenant binding to Ghana BEFORE forcing
      // the deferred trigger to fire. The US rows are now RLS-invisible
      // to the SECURITY INVOKER lookup path; SECURITY DEFINER is the
      // mechanism that lets the trigger still see them.
      await client.query('SELECT set_tenant_context($1)', [TENANT_GHANA]);
    });

    const result = await forceConstraintCheck();
    expect(result).not.toBeNull();
    expect(result).toMatch(/reciprocity violated/i);
  });
});
