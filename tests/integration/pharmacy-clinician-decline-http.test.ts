/**
 * pharmacy-clinician-decline-http.test.ts — HTTP integration tests for
 * the clinician-side decline endpoint per Sprint 35-36 / TLC-055 PR H.
 *
 * Endpoint under test:
 *   POST /v0/pharmacy/prescriptions/:id/decline
 *
 * State Machines v1.2 §19:
 *   pending_clinician_review --[clinician_decline]--> rejected (terminal)
 *
 * NOT I-012-gated: a clinician's deliberate refusal is the opposite of
 * an execution. Audit envelope uses the clinician-only workload+autonomy
 * 'n/a' sentinel pair (mirrors prescribing.declined emitter — NOT a
 * prescribing.execution_rejected I-012 audit).
 *
 * Body: { reason_code, reason_text?, recommended_action? }
 *   reason_code enum: unsafe | inappropriate_indication |
 *                     insufficient_information | other
 *
 * Coverage (5 groups, 12 cases):
 *
 *   Group A — Happy path
 *     A1 reason_code='unsafe' → 200 + rejected + audit emit
 *     A2 reason_code='inappropriate_indication' + reason_text +
 *        recommended_action → 200 + rejected + audit detail populated
 *
 *   Group B — Auth + role gate
 *     B1 patient JWT → 403
 *     B2 no JWT      → 401
 *
 *   Group C — Body validation
 *     C1 missing reason_code → 400
 *     C2 reason_code out of enum → 400
 *     C3 unexpected body field → 400
 *
 *   Group D — Resource resolution
 *     D1 nonexistent id → 404 tenant-blind
 *     D2 malformed id   → 404 tenant-blind
 *     D3 cross-tenant Ghana row via US clinician → 404
 *
 *   Group E — State machine
 *     E1 draft row → 409 (not pending_clinician_review)
 *     E2 active row → 409
 *
 * Spec references:
 *   - State Machines v1.2 §19 (clinician_decline route)
 *   - CDM v1.3 §4.16 (MedicationRequest rejected state)
 *   - AUDIT_EVENTS v5.3 (prescribing.declined Category A; clinician-
 *     only workload+autonomy 'n/a' sentinel)
 *   - RBAC v1.1 §1.2
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
// Seeding helpers (same shape as the approve test file)
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
        'Test',
        'test',
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

async function seedMedicationRequest(options: {
  ctx: TenantContext;
  patientAccountId: AccountId;
  productCatalogId: ProductCatalogId;
  status: 'draft' | 'pending_clinician_review' | 'active';
}): Promise<MedicationRequestId> {
  const id = asMedicationRequestId(`mrx_${ulid()}`);
  await withTenantContext(options.ctx.tenantId, async () => {
    const client = getTestClient();
    const now = new Date().toISOString();
    const isActive = options.status === 'active';
    const engineEvaluated = options.status === 'pending_clinician_review' || isActive;
    await client.query(
      `INSERT INTO medication_requests (
          id, tenant_id, patient_account_id, product_catalog_id,
          medication_name, strength, formulation,
          dose_instructions, quantity, quantity_unit, refills_allowed,
          status, prescribed_at, activated_at,
          discontinued_at, discontinued_reason,
          prescribed_by_clinician_account_id,
          interaction_signals_status, interaction_signals_evaluated_at,
          country_of_care
       ) VALUES (
          $1, $2, $3, $4,
          $5, $6, $7,
          $8, $9, $10, $11,
          $12, $13, $14,
          NULL, NULL,
          $15,
          $16, $17,
          $18
       )`,
      [
        id,
        options.ctx.tenantId,
        options.patientAccountId,
        options.productCatalogId,
        'Test',
        '10mg',
        'tablet',
        '1 tablet daily',
        30,
        'tablet',
        0,
        options.status,
        isActive ? now : null,
        isActive ? now : null,
        isActive ? options.patientAccountId : null,
        engineEvaluated ? 'clean' : 'pending',
        engineEvaluated ? now : null,
        options.ctx.countryOfCare,
      ],
    );
  });
  return id;
}

async function mintTokenForRole(
  tenantId: TenantId,
  accountId: AccountId,
  role: 'patient' | 'clinician',
): Promise<string> {
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

describe('pharmacy clinician decline — Group A: happy path', () => {
  it('A1 reason_code=unsafe → 200 + status=rejected + audit emit', async () => {
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
      url: `/v0/pharmacy/prescriptions/${mrId}/decline`,
      headers: {
        host: 'heroshealth.com',
        authorization: `Bearer ${token}`,
        'idempotency-key': ulid(),
      },
      payload: { reason_code: 'unsafe' },
    });
    expect(r.statusCode).toBe(200);
    const body = r.json<{ id: string; status: string }>();
    expect(body.id).toBe(mrId);
    expect(body.status).toBe('rejected');
    expectNoTenantLeak(r);

    await withTenantContext(T_US, async () => {
      const client = getTestClient();
      const rows = await client.query<{
        action: string;
        actor_type: string;
        actor_id: string;
        ai_workload_type: string;
        autonomy_level: string;
      }>(
        `SELECT action, actor_type, actor_id, ai_workload_type, autonomy_level
           FROM audit_records
          WHERE tenant_id = $1 AND resource_id = $2 AND action = 'prescribing.declined'`,
        [T_US, mrId],
      );
      expect(rows.rows.length).toBe(1);
      const row = rows.rows[0]!;
      expect(row.actor_type).toBe('clinician');
      expect(row.actor_id).toBe(clinician);
      expect(row.ai_workload_type).toBe('n/a');
      expect(row.autonomy_level).toBe('n/a');
    });
  });

  it('A2 reason_code=inappropriate_indication + reason_text + recommended_action → 200 + audit detail populated', async () => {
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
      url: `/v0/pharmacy/prescriptions/${mrId}/decline`,
      headers: {
        host: 'heroshealth.com',
        authorization: `Bearer ${token}`,
        'idempotency-key': ulid(),
      },
      payload: {
        reason_code: 'inappropriate_indication',
        reason_text: 'BMI below program threshold for GLP-1 therapy.',
        recommended_action: 'request_more_history',
      },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json<{ status: string }>().status).toBe('rejected');

    await withTenantContext(T_US, async () => {
      const client = getTestClient();
      const rows = await client.query<{ payload: Record<string, unknown> }>(
        `SELECT payload FROM audit_records
          WHERE tenant_id = $1 AND resource_id = $2 AND action = 'prescribing.declined'`,
        [T_US, mrId],
      );
      expect(rows.rows.length).toBe(1);
      // The `payload` JSONB column is the audit envelope's `detail`
      // field directly (per lib/audit.ts L881 `JSON.stringify(envelope.detail)`),
      // NOT a nested { detail: {...} } wrapper. The emitter spreads
      // args.detail (caller-supplied; {} here) and then adds the
      // decline-specific fields, so the persisted payload looks like:
      //   { reason_code, reason_text, recommended_action }
      const payload = rows.rows[0]!.payload;
      expect(payload.reason_code).toBe('inappropriate_indication');
      expect(payload.reason_text).toBe('BMI below program threshold for GLP-1 therapy.');
      expect(payload.recommended_action).toBe('request_more_history');
    });
  });
});

// ===========================================================================
// Group B — Auth + role gate
// ===========================================================================

describe('pharmacy clinician decline — Group B: auth + role gate', () => {
  it('B1 patient JWT → 403', async () => {
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
      url: `/v0/pharmacy/prescriptions/${mrId}/decline`,
      headers: {
        host: 'heroshealth.com',
        authorization: `Bearer ${token}`,
        'idempotency-key': ulid(),
      },
      payload: { reason_code: 'unsafe' },
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
      url: `/v0/pharmacy/prescriptions/${mrId}/decline`,
      headers: { host: 'heroshealth.com', 'idempotency-key': ulid() },
      payload: { reason_code: 'unsafe' },
    });
    expect(r.statusCode).toBe(401);
    expectNoTenantLeak(r);
  });
});

// ===========================================================================
// Group C — Body validation
// ===========================================================================

describe('pharmacy clinician decline — Group C: body validation', () => {
  async function setup() {
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
    return { mrId, token };
  }

  it('C1 missing reason_code → 400', async () => {
    const { mrId, token } = await setup();
    const r = await app!.inject({
      method: 'POST',
      url: `/v0/pharmacy/prescriptions/${mrId}/decline`,
      headers: {
        host: 'heroshealth.com',
        authorization: `Bearer ${token}`,
        'idempotency-key': ulid(),
      },
      payload: {},
    });
    expect(r.statusCode).toBe(400);
    expectNoTenantLeak(r);
  });

  it('C2 reason_code out of enum → 400', async () => {
    const { mrId, token } = await setup();
    const r = await app!.inject({
      method: 'POST',
      url: `/v0/pharmacy/prescriptions/${mrId}/decline`,
      headers: {
        host: 'heroshealth.com',
        authorization: `Bearer ${token}`,
        'idempotency-key': ulid(),
      },
      payload: { reason_code: 'made_up_reason' },
    });
    expect(r.statusCode).toBe(400);
    expectNoTenantLeak(r);
  });

  it('C3 unexpected body field → 400', async () => {
    const { mrId, token } = await setup();
    const r = await app!.inject({
      method: 'POST',
      url: `/v0/pharmacy/prescriptions/${mrId}/decline`,
      headers: {
        host: 'heroshealth.com',
        authorization: `Bearer ${token}`,
        'idempotency-key': ulid(),
      },
      payload: { reason_code: 'unsafe', extra_field: 'not_allowed' },
    });
    expect(r.statusCode).toBe(400);
    expectNoTenantLeak(r);
  });
});

// ===========================================================================
// Group D — Resource resolution
// ===========================================================================

describe('pharmacy clinician decline — Group D: resource resolution', () => {
  it('D1 nonexistent id → 404 tenant-blind', async () => {
    const clinician = await insertAccountOfType(US_CTX, 'clinician', '+1');
    const token = await mintTokenForRole(T_US, clinician, 'clinician');
    const r = await app!.inject({
      method: 'POST',
      url: `/v0/pharmacy/prescriptions/mrx_${ulid()}/decline`,
      headers: {
        host: 'heroshealth.com',
        authorization: `Bearer ${token}`,
        'idempotency-key': ulid(),
      },
      payload: { reason_code: 'unsafe' },
    });
    expect(r.statusCode).toBe(404);
    expectNoTenantLeak(r);
  });

  it('D2 malformed id → 404 tenant-blind', async () => {
    const clinician = await insertAccountOfType(US_CTX, 'clinician', '+1');
    const token = await mintTokenForRole(T_US, clinician, 'clinician');
    const r = await app!.inject({
      method: 'POST',
      url: `/v0/pharmacy/prescriptions/not-a-valid-id/decline`,
      headers: {
        host: 'heroshealth.com',
        authorization: `Bearer ${token}`,
        'idempotency-key': ulid(),
      },
      payload: { reason_code: 'unsafe' },
    });
    expect(r.statusCode).toBe(404);
    expectNoTenantLeak(r);
  });

  it('D3 cross-tenant Ghana row via US clinician → 404', async () => {
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
      url: `/v0/pharmacy/prescriptions/${ghMrId}/decline`,
      headers: {
        host: 'heroshealth.com',
        authorization: `Bearer ${usToken}`,
        'idempotency-key': ulid(),
      },
      payload: { reason_code: 'unsafe' },
    });
    expect(r.statusCode).toBe(404);
    expectNoTenantLeak(r);
  });
});

// ===========================================================================
// Group E — State machine
// ===========================================================================

describe('pharmacy clinician decline — Group E: state machine', () => {
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
      url: `/v0/pharmacy/prescriptions/${mrId}/decline`,
      headers: {
        host: 'heroshealth.com',
        authorization: `Bearer ${token}`,
        'idempotency-key': ulid(),
      },
      payload: { reason_code: 'unsafe' },
    });
    expect(r.statusCode).toBe(409);
    expectNoTenantLeak(r);
  });

  it('E2 active row → 409', async () => {
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
      url: `/v0/pharmacy/prescriptions/${mrId}/decline`,
      headers: {
        host: 'heroshealth.com',
        authorization: `Bearer ${token}`,
        'idempotency-key': ulid(),
      },
      payload: { reason_code: 'unsafe' },
    });
    expect(r.statusCode).toBe(409);
    expectNoTenantLeak(r);
  });
});
