/**
 * pharmacy-clinician-approve-http.test.ts — HTTP integration tests for
 * the clinician-side approve endpoint per Sprint 35-36 / TLC-055 PR G.
 *
 * Endpoint under test:
 *   POST /v0/pharmacy/prescriptions/:id/approve
 *
 * This is the FIRST I-012-gated activation in the pharmacy slice.
 * State Machines v1.2 §19 admits two routes from
 * pending_clinician_review → active; PR G ships the clinician-only
 * route (clinician_approve). The Mode 2 route
 * (protocol_authorized_prescribing) is NOT exposed at v1.0 — it lands
 * with the protocol engine slice.
 *
 * For the clinician_approve route, the I-012 three-clause rule
 * collapses cleanly:
 *
 *   (1) AI-participating execution attribution — vacuously satisfied
 *       (no AI workload contributed; row envelope null/null per
 *       migration 025 CHECK (a); audit envelope 'n/a'/'n/a' per
 *       AUDIT_EVENTS v5.3 clinician-only carve-out).
 *   (2) Audit-chain confirmation event scoped to action_id — the
 *       prescribing.approved emission IS the confirmation event;
 *       emitted in the same transaction immediately before the
 *       transitionStatus call.
 *   (3) RBAC-authorized confirming actor — enforced upstream by
 *       requireClinicianLiveSession (tenant context + clinician role
 *       + live session + clinician account binding from TLC-058).
 *
 * Coverage (5 groups, 12 cases):
 *
 *   Group A — Happy path
 *     A1 200 + status=active + prescribed_at + prescribed_by set
 *     A2 audit verification: prescribing.approved Category A emitted
 *
 *   Group B — Auth + role gate
 *     B1 patient JWT → 403
 *     B2 no JWT      → 401
 *
 *   Group C — Body validation
 *     C1 non-empty body → 400 (approve takes no parameters)
 *     C2 body as array  → 400
 *
 *   Group D — Resource resolution
 *     D1 nonexistent id → 404 tenant-blind
 *     D2 malformed id   → 404 tenant-blind
 *     D3 cross-tenant Ghana row queried via US clinician → 404
 *
 *   Group E — State machine
 *     E1 draft row → 409 (not pending_clinician_review)
 *     E2 active row → 409 (already approved)
 *     E3 discontinued row → 409
 *
 * Spec references:
 *   - State Machines v1.2 §19 (clinician_approve route + I-012 three-
 *     clause rule wired via I012GuardClinicianOnly)
 *   - CDM v1.3 §4.16 (MedicationRequest activation envelope)
 *   - AUDIT_EVENTS v5.3 (prescribing.approved Category A; clinician-
 *     confirmation carve-out workload+autonomy='n/a')
 *   - DOMAIN_EVENTS v5.2 (medication_request.approved.v1 with
 *     approval_pathway='clinician_reviewed')
 *   - RBAC v1.1 §1.2 (clinician-role authority within tenant)
 *   - ERROR_MODEL v5.1, IDEMPOTENCY v5.1
 *   - I-012 (reject-unless three-clause rule; rejection emits
 *     prescribing.execution_rejected — defense-in-depth for v1.0
 *     clinician-only path)
 *   - I-023 / I-025 / I-027
 */

import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../../src/app.ts';
import { config } from '../../src/lib/config.ts';
import { asTenantId, type TenantId } from '../../src/lib/glossary.ts';
import { issueAccessToken } from '../../src/lib/jwt.ts';
import type { TenantContext } from '../../src/lib/tenant-context.ts';
import { ulid } from '../../src/lib/ulid.ts';
import { createAccount } from '../../src/modules/identity/internal/repositories/account-repo.ts';
import * as sessionRepo from '../../src/modules/identity/internal/repositories/session-repo.ts';
import {
  asAccountId,
  asSessionId,
  type AccountId,
} from '../../src/modules/identity/internal/types.ts';
import {
  asMedicationRequestId,
  asProductCatalogId,
  type MedicationRequestId,
  type ProductCatalogId,
} from '../../src/modules/pharmacy/internal/types.ts';
import { TENANT_GHANA, TENANT_US, withTenantContext } from '../helpers/tenant-fixtures.ts';
import { uniquePhone } from '../helpers/unique-phone.ts';
import { getTestClient } from '../setup.ts';

const T_US = asTenantId(TENANT_US);
const T_GH = asTenantId(TENANT_GHANA);

const US_CTX: TenantContext = {
  tenantId: T_US,
  displayName: 'Telecheck-US',
  countryOfCare: 'US',
  kmsKeyAlias: 'alias/telecheck-us-data-key',
  consumerDba: 'Heros Health',
  legalEntity: 'Telecheck Health LLC',
  consumerSubdomain: 'heroshealth.com',
};

const GH_CTX: TenantContext = {
  tenantId: T_GH,
  displayName: 'Telecheck-Ghana',
  countryOfCare: 'GH',
  kmsKeyAlias: 'alias/telecheck-gh-data-key',
  consumerDba: 'Heros Health Ghana',
  legalEntity: 'Telecheck-Ghana Ltd.',
  consumerSubdomain: 'ghana.heroshealth.com',
};

let app: FastifyInstance | null = null;

beforeAll(async () => {
  process.env['NODE_ENV'] = 'test';
  app = await buildApp({ logger: false });
  await app.ready();
});

afterAll(async () => {
  if (app !== null) {
    await app.close();
  }
});

// ---------------------------------------------------------------------------
// Seeding helpers
// ---------------------------------------------------------------------------

async function insertAccountOfType(
  ctx: TenantContext,
  accountType: 'patient' | 'clinician',
  phonePrefix: string,
): Promise<AccountId> {
  const accountId = asAccountId(ulid());
  await withTenantContext(ctx.tenantId, () =>
    createAccount(
      {
        account_id: accountId,
        tenant_id: ctx.tenantId,
        phone_e164: uniquePhone(phonePrefix),
        first_name: 'A',
        last_name: 'B',
        date_of_birth: '1990-01-01',
        gender: 'prefer_not_to_say',
        country_of_residence: ctx.countryOfCare,
        country_of_care: ctx.countryOfCare,
        account_type: accountType,
      },
      async () => {
        /* no-op */
      },
    ),
  );
  return accountId;
}

async function seedProduct(ctx: TenantContext): Promise<ProductCatalogId> {
  const id = ulid();
  await withTenantContext(ctx.tenantId, async () => {
    const client = getTestClient();
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
        ctx.tenantId,
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
  });
  return asProductCatalogId(id);
}

/**
 * Seed a medication_request directly at the requested status (bypassing
 * the state machine) so tests can exercise clinician-approve against
 * a row already in `pending_clinician_review`. Also supports `draft`,
 * `active`, and `discontinued` for state-machine negative tests.
 *
 * Per migration 025 CHECKs:
 *   - Pre-active (draft, pending_interaction_check,
 *     pending_clinician_review, rejected): ai_workload_type AND
 *     autonomy_level MUST both be null; prescribed_at + activated_at +
 *     prescribed_by_clinician_account_id MUST be null.
 *   - Active and post-active: prescribed_at + activated_at +
 *     prescribed_by_clinician_account_id required.
 *   - interaction_signals_status: 'pending' before engine; 'clean' /
 *     'caution' / 'safety_hold' after engine has evaluated.
 */
async function seedMedicationRequest(options: {
  ctx: TenantContext;
  patientAccountId: AccountId;
  productCatalogId: ProductCatalogId;
  status: 'draft' | 'pending_clinician_review' | 'active' | 'discontinued';
  /** When status='pending_clinician_review', seed the clinician account so
   *  the test can use it (but the column stays null until activation). */
  pretendPrescriberAccountId?: AccountId;
}): Promise<MedicationRequestId> {
  const id = asMedicationRequestId(`mrx_${ulid()}`);
  await withTenantContext(options.ctx.tenantId, async () => {
    const client = getTestClient();
    const now = new Date().toISOString();
    const isActiveOrPost = options.status === 'active' || options.status === 'discontinued';
    const engineEvaluated = options.status === 'pending_clinician_review' || isActiveOrPost;
    await client.query(
      `INSERT INTO medication_requests (
          id, tenant_id,
          patient_account_id, product_catalog_id,
          medication_name, strength, formulation,
          dose_instructions, quantity, quantity_unit, refills_allowed,
          status,
          prescribed_at, activated_at,
          discontinued_at, discontinued_reason,
          prescribed_by_clinician_account_id,
          interaction_signals_status, interaction_signals_evaluated_at,
          country_of_care
       ) VALUES (
          $1, $2, $3, $4,
          $5, $6, $7,
          $8, $9, $10, $11,
          $12,
          $13, $14,
          $15, $16,
          $17,
          $18, $19,
          $20
       )`,
      [
        id,
        options.ctx.tenantId,
        options.patientAccountId,
        options.productCatalogId,
        'Test Medication',
        '10mg',
        'tablet',
        '1 tablet daily',
        30,
        'tablet',
        0,
        options.status,
        isActiveOrPost ? now : null,
        isActiveOrPost ? now : null,
        options.status === 'discontinued' ? now : null,
        options.status === 'discontinued' ? 'clinical_decision' : null,
        // Prescribed-by column populates only at activation per migration 025
        // medication_requests_prescriber_set_when_active CHECK.
        isActiveOrPost ? options.patientAccountId : null,
        engineEvaluated ? 'clean' : 'pending',
        engineEvaluated ? now : null,
        options.ctx.countryOfCare,
      ],
    );
  });
  return id;
}

// ---------------------------------------------------------------------------
// Auth helpers
// ---------------------------------------------------------------------------

async function seedSession(tenantId: TenantId, accountId: AccountId): Promise<string> {
  const sessionId = asSessionId(ulid());
  await withTenantContext(tenantId, () =>
    sessionRepo.createSession(
      {
        session_id: sessionId,
        tenant_id: tenantId,
        account_id: accountId,
        refresh_token_hash: '0'.repeat(64),
        expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      },
      async () => {
        /* no-op */
      },
    ),
  );
  return sessionId;
}

async function mintTokenForRole(
  tenantId: TenantId,
  accountId: AccountId,
  role: 'patient' | 'clinician',
): Promise<string> {
  const sessionId = await seedSession(tenantId, accountId);
  return issueAccessToken(
    {
      account_id: accountId,
      tenant_id: tenantId,
      session_id: asSessionId(sessionId),
      role,
      country_of_care: tenantId === T_US ? 'US' : 'GH',
    },
    config.jwtSigningKey,
  );
}

function expectNoTenantLeak(response: { body: string }): void {
  expect(response.body).not.toContain('"tenant_id"');
  expect(response.body).not.toContain('Telecheck-US');
  expect(response.body).not.toContain('Telecheck-Ghana');
}

// ===========================================================================
// Group A — Happy path
// ===========================================================================

describe('pharmacy clinician approve — Group A: happy path', () => {
  it('A1 pending_clinician_review → 200 + status=active + prescribed envelope set', async () => {
    const clinician = await insertAccountOfType(US_CTX, 'clinician', '+1');
    const patient = await insertAccountOfType(US_CTX, 'patient', '+1');
    const product = await seedProduct(US_CTX);
    const mrId = await seedMedicationRequest({
      ctx: US_CTX,
      patientAccountId: patient,
      productCatalogId: product,
      status: 'pending_clinician_review',
    });
    const token = await mintTokenForRole(T_US, clinician, 'clinician');

    const r = await app!.inject({
      method: 'POST',
      url: `/v0/pharmacy/prescriptions/${mrId}/approve`,
      headers: {
        host: 'heroshealth.com',
        authorization: `Bearer ${token}`,
        'idempotency-key': ulid(),
      },
      payload: {},
    });
    expect(r.statusCode).toBe(200);
    const body = r.json<{
      id: string;
      status: string;
      prescribed_at: string | null;
      activated_at: string | null;
    }>();
    expect(body.id).toBe(mrId);
    expect(body.status).toBe('active');
    expect(body.prescribed_at).not.toBeNull();
    expect(body.activated_at).not.toBeNull();
    expectNoTenantLeak(r);
  });

  it('A2 audit-row verification: prescribing.approved Category A emitted with clinician actor + n/a envelope', async () => {
    const clinician = await insertAccountOfType(US_CTX, 'clinician', '+1');
    const patient = await insertAccountOfType(US_CTX, 'patient', '+1');
    const product = await seedProduct(US_CTX);
    const mrId = await seedMedicationRequest({
      ctx: US_CTX,
      patientAccountId: patient,
      productCatalogId: product,
      status: 'pending_clinician_review',
    });
    const token = await mintTokenForRole(T_US, clinician, 'clinician');

    const r = await app!.inject({
      method: 'POST',
      url: `/v0/pharmacy/prescriptions/${mrId}/approve`,
      headers: {
        host: 'heroshealth.com',
        authorization: `Bearer ${token}`,
        'idempotency-key': ulid(),
      },
      payload: {},
    });
    expect(r.statusCode).toBe(200);

    await withTenantContext(T_US, async () => {
      const client = getTestClient();
      const rows = await client.query<{
        action: string;
        actor_type: string;
        actor_id: string;
        ai_workload_type: string;
        autonomy_level: string;
        category: string;
      }>(
        `SELECT action, actor_type, actor_id, ai_workload_type,
                autonomy_level, category
           FROM audit_records
          WHERE tenant_id = $1
            AND resource_id = $2
            AND action = 'prescribing.approved'`,
        [T_US, mrId],
      );
      expect(rows.rows.length).toBe(1);
      const row = rows.rows[0]!;
      expect(row.actor_type).toBe('clinician');
      expect(row.actor_id).toBe(clinician);
      expect(row.ai_workload_type).toBe('n/a');
      expect(row.autonomy_level).toBe('n/a');
      expect(row.category).toBe('A');
    });
  });
});

// ===========================================================================
// Group B — Auth + role gate
// ===========================================================================

describe('pharmacy clinician approve — Group B: auth + role gate', () => {
  it('B1 patient JWT → 403 internal.auth.insufficient_scope', async () => {
    const patient = await insertAccountOfType(US_CTX, 'patient', '+1');
    const product = await seedProduct(US_CTX);
    const mrId = await seedMedicationRequest({
      ctx: US_CTX,
      patientAccountId: patient,
      productCatalogId: product,
      status: 'pending_clinician_review',
    });
    const token = await mintTokenForRole(T_US, patient, 'patient');

    const r = await app!.inject({
      method: 'POST',
      url: `/v0/pharmacy/prescriptions/${mrId}/approve`,
      headers: {
        host: 'heroshealth.com',
        authorization: `Bearer ${token}`,
        'idempotency-key': ulid(),
      },
      payload: {},
    });
    expect(r.statusCode).toBe(403);
    expectNoTenantLeak(r);
  });

  it('B2 no JWT → 401', async () => {
    const patient = await insertAccountOfType(US_CTX, 'patient', '+1');
    const product = await seedProduct(US_CTX);
    const mrId = await seedMedicationRequest({
      ctx: US_CTX,
      patientAccountId: patient,
      productCatalogId: product,
      status: 'pending_clinician_review',
    });

    const r = await app!.inject({
      method: 'POST',
      url: `/v0/pharmacy/prescriptions/${mrId}/approve`,
      headers: { host: 'heroshealth.com', 'idempotency-key': ulid() },
      payload: {},
    });
    expect(r.statusCode).toBe(401);
    expectNoTenantLeak(r);
  });
});

// ===========================================================================
// Group C — Body validation
// ===========================================================================

describe('pharmacy clinician approve — Group C: body validation', () => {
  it('C1 non-empty body → 400 (approve takes no parameters)', async () => {
    const clinician = await insertAccountOfType(US_CTX, 'clinician', '+1');
    const patient = await insertAccountOfType(US_CTX, 'patient', '+1');
    const product = await seedProduct(US_CTX);
    const mrId = await seedMedicationRequest({
      ctx: US_CTX,
      patientAccountId: patient,
      productCatalogId: product,
      status: 'pending_clinician_review',
    });
    const token = await mintTokenForRole(T_US, clinician, 'clinician');

    const r = await app!.inject({
      method: 'POST',
      url: `/v0/pharmacy/prescriptions/${mrId}/approve`,
      headers: {
        host: 'heroshealth.com',
        authorization: `Bearer ${token}`,
        'idempotency-key': ulid(),
      },
      payload: { prescribed_at: '2099-01-01' },
    });
    expect(r.statusCode).toBe(400);
    const body = r.json<{ error: { code: string } }>();
    expect(body.error.code).toBe('internal.request.invalid');
    expectNoTenantLeak(r);
  });

  it('C2 body as array → 400', async () => {
    const clinician = await insertAccountOfType(US_CTX, 'clinician', '+1');
    const patient = await insertAccountOfType(US_CTX, 'patient', '+1');
    const product = await seedProduct(US_CTX);
    const mrId = await seedMedicationRequest({
      ctx: US_CTX,
      patientAccountId: patient,
      productCatalogId: product,
      status: 'pending_clinician_review',
    });
    const token = await mintTokenForRole(T_US, clinician, 'clinician');

    const r = await app!.inject({
      method: 'POST',
      url: `/v0/pharmacy/prescriptions/${mrId}/approve`,
      headers: {
        host: 'heroshealth.com',
        authorization: `Bearer ${token}`,
        'idempotency-key': ulid(),
      },
      payload: [],
    });
    expect(r.statusCode).toBe(400);
    expectNoTenantLeak(r);
  });
});

// ===========================================================================
// Group D — Resource resolution (I-025 tenant-blind 404)
// ===========================================================================

describe('pharmacy clinician approve — Group D: resource resolution', () => {
  it('D1 nonexistent id → 404 tenant-blind', async () => {
    const clinician = await insertAccountOfType(US_CTX, 'clinician', '+1');
    const token = await mintTokenForRole(T_US, clinician, 'clinician');

    const r = await app!.inject({
      method: 'POST',
      url: `/v0/pharmacy/prescriptions/mrx_${ulid()}/approve`,
      headers: {
        host: 'heroshealth.com',
        authorization: `Bearer ${token}`,
        'idempotency-key': ulid(),
      },
      payload: {},
    });
    expect(r.statusCode).toBe(404);
    const body = r.json<{ error: { code: string } }>();
    expect(body.error.code).toBe('internal.resource.not_found');
    expectNoTenantLeak(r);
  });

  it('D2 malformed id → 404 tenant-blind (side-channel closure)', async () => {
    const clinician = await insertAccountOfType(US_CTX, 'clinician', '+1');
    const token = await mintTokenForRole(T_US, clinician, 'clinician');

    const r = await app!.inject({
      method: 'POST',
      url: `/v0/pharmacy/prescriptions/not-a-valid-id/approve`,
      headers: {
        host: 'heroshealth.com',
        authorization: `Bearer ${token}`,
        'idempotency-key': ulid(),
      },
      payload: {},
    });
    expect(r.statusCode).toBe(404);
    expectNoTenantLeak(r);
  });

  it('D3 cross-tenant Ghana row queried via US clinician → 404', async () => {
    const ghPatient = await insertAccountOfType(GH_CTX, 'patient', '+233');
    const ghProduct = await seedProduct(GH_CTX);
    const ghMrId = await seedMedicationRequest({
      ctx: GH_CTX,
      patientAccountId: ghPatient,
      productCatalogId: ghProduct,
      status: 'pending_clinician_review',
    });

    const usClinician = await insertAccountOfType(US_CTX, 'clinician', '+1');
    const usToken = await mintTokenForRole(T_US, usClinician, 'clinician');

    const r = await app!.inject({
      method: 'POST',
      url: `/v0/pharmacy/prescriptions/${ghMrId}/approve`,
      headers: {
        host: 'heroshealth.com',
        authorization: `Bearer ${usToken}`,
        'idempotency-key': ulid(),
      },
      payload: {},
    });
    expect(r.statusCode).toBe(404);
    expectNoTenantLeak(r);
  });
});

// ===========================================================================
// Group E — State machine
// ===========================================================================

describe('pharmacy clinician approve — Group E: state machine', () => {
  it('E1 draft row → 409 (not pending_clinician_review)', async () => {
    const clinician = await insertAccountOfType(US_CTX, 'clinician', '+1');
    const patient = await insertAccountOfType(US_CTX, 'patient', '+1');
    const product = await seedProduct(US_CTX);
    const mrId = await seedMedicationRequest({
      ctx: US_CTX,
      patientAccountId: patient,
      productCatalogId: product,
      status: 'draft',
    });
    const token = await mintTokenForRole(T_US, clinician, 'clinician');

    const r = await app!.inject({
      method: 'POST',
      url: `/v0/pharmacy/prescriptions/${mrId}/approve`,
      headers: {
        host: 'heroshealth.com',
        authorization: `Bearer ${token}`,
        'idempotency-key': ulid(),
      },
      payload: {},
    });
    expect(r.statusCode).toBe(409);
    const body = r.json<{ error: { code: string } }>();
    expect(body.error.code).toBe('internal.resource.conflict');
    expectNoTenantLeak(r);
  });

  it('E2 active row → 409 (already approved)', async () => {
    const clinician = await insertAccountOfType(US_CTX, 'clinician', '+1');
    const patient = await insertAccountOfType(US_CTX, 'patient', '+1');
    const product = await seedProduct(US_CTX);
    const mrId = await seedMedicationRequest({
      ctx: US_CTX,
      patientAccountId: patient,
      productCatalogId: product,
      status: 'active',
    });
    const token = await mintTokenForRole(T_US, clinician, 'clinician');

    const r = await app!.inject({
      method: 'POST',
      url: `/v0/pharmacy/prescriptions/${mrId}/approve`,
      headers: {
        host: 'heroshealth.com',
        authorization: `Bearer ${token}`,
        'idempotency-key': ulid(),
      },
      payload: {},
    });
    expect(r.statusCode).toBe(409);
    expectNoTenantLeak(r);
  });

  it('E3 discontinued row → 409', async () => {
    const clinician = await insertAccountOfType(US_CTX, 'clinician', '+1');
    const patient = await insertAccountOfType(US_CTX, 'patient', '+1');
    const product = await seedProduct(US_CTX);
    const mrId = await seedMedicationRequest({
      ctx: US_CTX,
      patientAccountId: patient,
      productCatalogId: product,
      status: 'discontinued',
    });
    const token = await mintTokenForRole(T_US, clinician, 'clinician');

    const r = await app!.inject({
      method: 'POST',
      url: `/v0/pharmacy/prescriptions/${mrId}/approve`,
      headers: {
        host: 'heroshealth.com',
        authorization: `Bearer ${token}`,
        'idempotency-key': ulid(),
      },
      payload: {},
    });
    expect(r.statusCode).toBe(409);
    expectNoTenantLeak(r);
  });
});
