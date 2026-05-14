/**
 * pharmacy-clinician-discontinue-http.test.ts — HTTP integration tests
 * for the clinician-side discontinue endpoint per Sprint 35-36 / TLC-055 PR F.
 *
 * Endpoint under test:
 *   POST /v0/pharmacy/prescriptions/:id/clinician-discontinue
 *
 * Body: { reason: 'clinical_decision' | 'adverse_event' }
 *
 * Both reasons drive non-I-012-gated transitions from active →
 * discontinued. Symmetric counterpart to PR D's patient-self
 * /:id/discontinue but with:
 *   - clinician role gate (requireClinicianLiveSession)
 *   - body reason discriminator (PR D had no body)
 *   - actor_type='clinician' in audit chain
 *   - no cross-patient ownership check at v1.0 (RBAC v1.1 §1.2)
 *
 * Coverage (5 groups, 12 cases):
 *
 *   Group A — Happy path
 *     A1 clinical_decision → 200 + discontinued + audit emit
 *     A2 adverse_event     → 200 + discontinued + audit emit
 *
 *   Group B — Auth + role gate
 *     B1 patient JWT → 403 internal.auth.insufficient_scope
 *     B2 no JWT      → 401
 *
 *   Group C — Body validation
 *     C1 missing reason → 400
 *     C2 reason='patient_request' (out-of-clinician-enum) → 400
 *     C3 unexpected body field → 400
 *
 *   Group D — Resource resolution
 *     D1 nonexistent id → 404 tenant-blind
 *     D2 malformed id   → 404 tenant-blind (side-channel closure)
 *     D3 cross-tenant Ghana row queried via US clinician → 404
 *
 *   Group E — State machine
 *     E1 already-discontinued row → 409 state conflict
 *     E2 draft row → 409 (not active)
 *
 * Spec references:
 *   - State Machines v1.2 §19 (clinician_discontinue, adverse_event_discontinue)
 *   - CDM v1.3 §4.16 (discontinued_reason enum)
 *   - AUDIT_EVENTS v5.3 (medication_request.discontinued Category A)
 *   - DOMAIN_EVENTS v5.2 (medication_request.discontinued.v1)
 *   - RBAC v1.1 §1.2 (clinician-role authority within tenant)
 *   - ERROR_MODEL v5.1, IDEMPOTENCY v5.1
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
  type SessionId,
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
 * the state machine) so tests can exercise clinician-discontinue against
 * 'active', 'discontinued', or 'draft' rows.
 */
async function seedMedicationRequest(options: {
  ctx: TenantContext;
  patientAccountId: AccountId;
  productCatalogId: ProductCatalogId;
  status: 'draft' | 'active' | 'discontinued';
}): Promise<MedicationRequestId> {
  const id = asMedicationRequestId(`mrx_${ulid()}`);
  await withTenantContext(options.ctx.tenantId, async () => {
    const client = getTestClient();
    const now = new Date().toISOString();
    const isActiveOrPost = options.status === 'active' || options.status === 'discontinued';
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
        // Reuse the patient account as a stand-in prescriber (account_type
        // CHECK only admits patient | delegate | clinician; the medication_requests
        // composite FK doesn't restrict type — bounded to test fixtures).
        isActiveOrPost ? options.patientAccountId : null,
        isActiveOrPost ? 'clean' : 'pending',
        isActiveOrPost ? now : null,
        'US',
      ],
    );
  });
  return id;
}

// ---------------------------------------------------------------------------
// Auth helpers
// ---------------------------------------------------------------------------

async function seedSession(tenantId: TenantId, accountId: AccountId): Promise<SessionId> {
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
      session_id: sessionId,
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

describe('pharmacy clinician discontinue — Group A: happy path', () => {
  it('A1 reason=clinical_decision → 200 + status=discontinued + audit clinician actor', async () => {
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
      url: `/v0/pharmacy/prescriptions/${mrId}/clinician-discontinue`,
      headers: {
        host: 'heroshealth.com',
        authorization: `Bearer ${token}`,
        'idempotency-key': ulid(),
      },
      payload: { reason: 'clinical_decision' },
    });

    expect(r.statusCode).toBe(200);
    const body = r.json<{
      id: string;
      status: string;
      discontinued_reason: string;
      discontinued_at: string;
    }>();
    expect(body.id).toBe(mrId);
    expect(body.status).toBe('discontinued');
    expect(body.discontinued_reason).toBe('clinical_decision');
    expect(body.discontinued_at).toBeTruthy();
    expectNoTenantLeak(r);

    // Audit emitted with actor_type='clinician' and the chosen reason.
    const auditRows = await withTenantContext(T_US, async () => {
      const client = getTestClient();
      const result = await client.query<{
        action: string;
        actor_type: string;
        actor_id: string;
      }>(
        `SELECT action, actor_type, actor_id FROM audit_records
          WHERE tenant_id = $1 AND resource_id = $2`,
        [T_US, mrId],
      );
      return result.rows;
    });
    const discAudit = auditRows.find((row) => row.action === 'medication_request.discontinued');
    expect(discAudit).toBeDefined();
    expect(discAudit!.actor_type).toBe('clinician');
    expect(discAudit!.actor_id).toBe(clinician);
  });

  it('A2 reason=adverse_event → 200 + discontinued_reason=adverse_event', async () => {
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
      url: `/v0/pharmacy/prescriptions/${mrId}/clinician-discontinue`,
      headers: {
        host: 'heroshealth.com',
        authorization: `Bearer ${token}`,
        'idempotency-key': ulid(),
      },
      payload: { reason: 'adverse_event' },
    });

    expect(r.statusCode).toBe(200);
    const body = r.json<{ status: string; discontinued_reason: string }>();
    expect(body.status).toBe('discontinued');
    expect(body.discontinued_reason).toBe('adverse_event');
    expectNoTenantLeak(r);
  });
});

// ===========================================================================
// Group B — Auth + role gate
// ===========================================================================

describe('pharmacy clinician discontinue — Group B: auth/role', () => {
  it('B1 patient JWT → 403 internal.auth.insufficient_scope', async () => {
    const patient = await insertAccountOfType(US_CTX, 'patient', '+1');
    const product = await seedProduct(US_CTX);
    const mrId = await seedMedicationRequest({
      ctx: US_CTX,
      patientAccountId: patient,
      productCatalogId: product,
      status: 'active',
    });
    const token = await mintTokenForRole(T_US, patient, 'patient');

    const r = await app!.inject({
      method: 'POST',
      url: `/v0/pharmacy/prescriptions/${mrId}/clinician-discontinue`,
      headers: {
        host: 'heroshealth.com',
        authorization: `Bearer ${token}`,
        'idempotency-key': ulid(),
      },
      payload: { reason: 'clinical_decision' },
    });

    expect(r.statusCode).toBe(403);
    const body = r.json<{ error: { code: string } }>();
    expect(body.error.code).toBe('internal.auth.insufficient_scope');
    expectNoTenantLeak(r);
  });

  it('B2 no Bearer JWT → 401', async () => {
    const r = await app!.inject({
      method: 'POST',
      url: `/v0/pharmacy/prescriptions/mrx_${ulid()}/clinician-discontinue`,
      headers: { host: 'heroshealth.com', 'idempotency-key': ulid() },
      payload: { reason: 'clinical_decision' },
    });

    expect(r.statusCode).toBe(401);
    expectNoTenantLeak(r);
  });
});

// ===========================================================================
// Group C — Body validation
// ===========================================================================

describe('pharmacy clinician discontinue — Group C: body validation', () => {
  async function setupClinicianAndActiveRow(): Promise<{
    token: string;
    mrId: MedicationRequestId;
  }> {
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
    return { token, mrId };
  }

  it('C1 missing reason → 400 internal.request.invalid', async () => {
    const { token, mrId } = await setupClinicianAndActiveRow();
    const r = await app!.inject({
      method: 'POST',
      url: `/v0/pharmacy/prescriptions/${mrId}/clinician-discontinue`,
      headers: {
        host: 'heroshealth.com',
        authorization: `Bearer ${token}`,
        'idempotency-key': ulid(),
      },
      payload: {},
    });
    expect(r.statusCode).toBe(400);
    const body = r.json<{ error: { code: string } }>();
    expect(body.error.code).toBe('internal.request.invalid');
    expectNoTenantLeak(r);
  });

  it('C2 reason=patient_request (out-of-clinician-enum) → 400', async () => {
    // patient_request is a valid discontinued_reason but is reserved for
    // the patient-self route. Clinician endpoint accepts only
    // clinical_decision | adverse_event.
    const { token, mrId } = await setupClinicianAndActiveRow();
    const r = await app!.inject({
      method: 'POST',
      url: `/v0/pharmacy/prescriptions/${mrId}/clinician-discontinue`,
      headers: {
        host: 'heroshealth.com',
        authorization: `Bearer ${token}`,
        'idempotency-key': ulid(),
      },
      payload: { reason: 'patient_request' },
    });
    expect(r.statusCode).toBe(400);
    const body = r.json<{ error: { code: string } }>();
    expect(body.error.code).toBe('internal.request.invalid');
    expectNoTenantLeak(r);
  });

  it('C3 unexpected body field → 400', async () => {
    // Defense against a clinician slipping in unmodeled attributes
    // (e.g., trying to override discontinued_at).
    const { token, mrId } = await setupClinicianAndActiveRow();
    const r = await app!.inject({
      method: 'POST',
      url: `/v0/pharmacy/prescriptions/${mrId}/clinician-discontinue`,
      headers: {
        host: 'heroshealth.com',
        authorization: `Bearer ${token}`,
        'idempotency-key': ulid(),
      },
      payload: { reason: 'clinical_decision', discontinued_at: '2020-01-01T00:00:00Z' },
    });
    expect(r.statusCode).toBe(400);
    const body = r.json<{ error: { code: string } }>();
    expect(body.error.code).toBe('internal.request.invalid');
    expectNoTenantLeak(r);
  });
});

// ===========================================================================
// Group D — Resource resolution
// ===========================================================================

describe('pharmacy clinician discontinue — Group D: resource resolution', () => {
  it('D1 nonexistent id → 404 tenant-blind', async () => {
    const clinician = await insertAccountOfType(US_CTX, 'clinician', '+1');
    const token = await mintTokenForRole(T_US, clinician, 'clinician');
    const r = await app!.inject({
      method: 'POST',
      url: `/v0/pharmacy/prescriptions/mrx_${ulid()}/clinician-discontinue`,
      headers: {
        host: 'heroshealth.com',
        authorization: `Bearer ${token}`,
        'idempotency-key': ulid(),
      },
      payload: { reason: 'clinical_decision' },
    });
    expect(r.statusCode).toBe(404);
    const body = r.json<{ error: { code: string } }>();
    expect(body.error.code).toBe('internal.resource.not_found');
    expectNoTenantLeak(r);
  });

  it('D2 malformed id → 404 (NOT 400; side-channel closure per I-025)', async () => {
    const clinician = await insertAccountOfType(US_CTX, 'clinician', '+1');
    const token = await mintTokenForRole(T_US, clinician, 'clinician');
    const r = await app!.inject({
      method: 'POST',
      url: '/v0/pharmacy/prescriptions/not-a-valid-id/clinician-discontinue',
      headers: {
        host: 'heroshealth.com',
        authorization: `Bearer ${token}`,
        'idempotency-key': ulid(),
      },
      payload: { reason: 'clinical_decision' },
    });
    expect(r.statusCode).toBe(404);
    const body = r.json<{ error: { code: string } }>();
    expect(body.error.code).toBe('internal.resource.not_found');
    expectNoTenantLeak(r);
  });

  it('D3 cross-tenant Ghana row via US clinician → 404 (RLS-filtered)', async () => {
    // Seed an active row in Ghana, then attempt to discontinue from a
    // US-tenant clinician. The repo's findById filters by tenant_id;
    // RLS additionally enforces the boundary. Tenant-blind 404 emitted.
    const ghPatient = await insertAccountOfType(GH_CTX, 'patient', '+233');
    const ghProduct = await seedProduct(GH_CTX);
    const ghMrId = await seedMedicationRequest({
      ctx: GH_CTX,
      patientAccountId: ghPatient,
      productCatalogId: ghProduct,
      status: 'active',
    });

    const usClinician = await insertAccountOfType(US_CTX, 'clinician', '+1');
    const usToken = await mintTokenForRole(T_US, usClinician, 'clinician');

    const r = await app!.inject({
      method: 'POST',
      url: `/v0/pharmacy/prescriptions/${ghMrId}/clinician-discontinue`,
      headers: {
        host: 'heroshealth.com',
        authorization: `Bearer ${usToken}`,
        'idempotency-key': ulid(),
      },
      payload: { reason: 'clinical_decision' },
    });
    expect(r.statusCode).toBe(404);
    const body = r.json<{ error: { code: string } }>();
    expect(body.error.code).toBe('internal.resource.not_found');
    expectNoTenantLeak(r);
  });
});

// ===========================================================================
// Group E — State machine
// ===========================================================================

describe('pharmacy clinician discontinue — Group E: state machine', () => {
  it('E1 already-discontinued row → 409 internal.resource.conflict', async () => {
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
      url: `/v0/pharmacy/prescriptions/${mrId}/clinician-discontinue`,
      headers: {
        host: 'heroshealth.com',
        authorization: `Bearer ${token}`,
        'idempotency-key': ulid(),
      },
      payload: { reason: 'clinical_decision' },
    });
    expect(r.statusCode).toBe(409);
    const body = r.json<{ error: { code: string } }>();
    expect(body.error.code).toBe('internal.resource.conflict');
    expectNoTenantLeak(r);
  });

  it('E2 draft row → 409 (not active)', async () => {
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
      url: `/v0/pharmacy/prescriptions/${mrId}/clinician-discontinue`,
      headers: {
        host: 'heroshealth.com',
        authorization: `Bearer ${token}`,
        'idempotency-key': ulid(),
      },
      payload: { reason: 'clinical_decision' },
    });
    expect(r.statusCode).toBe(409);
    const body = r.json<{ error: { code: string } }>();
    expect(body.error.code).toBe('internal.resource.conflict');
    expectNoTenantLeak(r);
  });
});
