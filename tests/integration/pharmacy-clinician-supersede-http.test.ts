/**
 * pharmacy-clinician-supersede-http.test.ts — HTTP integration tests
 * for the supersession write-path per Sprint 35-36 / TLC-055 PR J.
 *
 * Endpoint under test:
 *   POST /v0/pharmacy/prescriptions/:id/supersede
 *   Body: { supersedes_medication_request_id, supersession_reason }
 *
 * `:id` is the NEW row (currently at pending_clinician_review) that
 * will activate. `supersedes_medication_request_id` is the OLD active
 * row that will be marked superseded.
 *
 * State Machines v1.2 §19 composition:
 *   - NEW row: pending_clinician_review --[clinician_approve]--> active
 *     (I-012-gated; supersedes_id threaded through activation envelope)
 *   - OLD row: active --[supersede_by_new_prescription]--> superseded
 *     (NOT I-012-gated; superseded_by_id set via markSuperseded)
 *
 * Coverage (5 groups, 10 cases):
 *
 *   Group A — Happy path
 *     A1 supersession completes; new row active with supersedes_id,
 *        old row superseded with superseded_by_id; audit + domain
 *        events emitted.
 *
 *   Group B — Auth + role gate
 *     B1 patient JWT → 403
 *     B2 no JWT      → 401
 *
 *   Group C — Body validation
 *     C1 missing supersedes_medication_request_id → 400
 *     C2 missing supersession_reason → 400
 *     C3 unexpected body field → 400
 *
 *   Group D — Resource resolution
 *     D1 nonexistent new id → 404 tenant-blind
 *     D2 nonexistent old id → 404 tenant-blind
 *     D3 cross-patient (old row belongs to a different patient than
 *        new row) → 404 (I-025 collapsed)
 *
 *   Group E — State machine + anti-self-loop
 *     E1 anti-self-loop (new id === old id) → 400
 *     E2 old row not active (draft) → 409
 *
 * Spec references:
 *   - State Machines v1.2 §19 (supersede_by_new_prescription + clinician_approve)
 *   - CDM v1.3 §4.16 (supersedes_id, superseded_by_id pointers)
 *   - migration 025 (medication_requests_superseded_by_id_only_on_superseded
 *     + medication_requests_supersedes_id_only_on_replacement CHECKs)
 *   - migration 026 (deferred CONSTRAINT TRIGGER validating reciprocity)
 *   - AUDIT_EVENTS v5.3 (prescribing.approved on new + medication_request.
 *     superseded on old; both Category A)
 *   - DOMAIN_EVENTS v5.2 (medication_request.approved.v1 +
 *     medication_request.superseded.v1)
 *   - I-012 reject-unless three-clause rule on the clinician_approve
 *     transition for the new row
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
import { TENANT_US, withTenantContext } from '../helpers/tenant-fixtures.ts';
import { uniquePhone } from '../helpers/unique-phone.ts';
import { getTestClient } from '../setup.ts';

const T_US = asTenantId(TENANT_US);

const US_CTX: TenantContext = {
  tenantId: T_US,
  displayName: 'Telecheck-US',
  countryOfCare: 'US',
  kmsKeyAlias: 'alias/telecheck-us-data-key',
  consumerDba: 'Heros Health',
  legalEntity: 'Telecheck Health LLC',
  consumerSubdomain: 'heroshealth.com',
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

async function seedRow(options: {
  ctx: TenantContext;
  patientAccountId: AccountId;
  productCatalogId: ProductCatalogId;
  status: 'draft' | 'pending_clinician_review' | 'active';
  prescriberAccountId?: AccountId;
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
        isActive ? (options.prescriberAccountId ?? options.patientAccountId) : null,
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
      country_of_care: 'US',
    },
    config.jwtSigningKey,
  );
}

function expectNoTenantLeak(response: { body: string }): void {
  expect(response.body).not.toContain('"tenant_id"');
  expect(response.body).not.toContain('Telecheck-US');
}

// ===========================================================================
// Group A — Happy path
// ===========================================================================

describe('pharmacy supersession — Group A: happy path', () => {
  it('A1 supersedes active row → new=active+supersedes_id, old=superseded+superseded_by_id, both audits + domain events', async () => {
    const clinician = await insertAccountOfType(US_CTX, 'clinician', '+1');
    const patient = await insertAccountOfType(US_CTX, 'patient', '+1');
    const product = await seedProduct(US_CTX);
    const oldMrId = await seedRow({
      ctx: US_CTX,
      patientAccountId: patient,
      productCatalogId: product,
      status: 'active',
      prescriberAccountId: clinician,
    });
    const newMrId = await seedRow({
      ctx: US_CTX,
      patientAccountId: patient,
      productCatalogId: product,
      status: 'pending_clinician_review',
    });
    const token = await mintTokenForRole(T_US, clinician, 'clinician');

    const r = await app!.inject({
      method: 'POST',
      url: `/v0/pharmacy/prescriptions/${newMrId}/supersede`,
      headers: {
        host: 'heroshealth.com',
        authorization: `Bearer ${token}`,
        'idempotency-key': ulid(),
      },
      payload: {
        supersedes_medication_request_id: oldMrId,
        supersession_reason: 'Patient requested dosage increase per consult notes.',
      },
    });
    expect(r.statusCode).toBe(200);
    const body = r.json<{
      id: string;
      status: string;
      supersedes_id: string | null;
    }>();
    expect(body.id).toBe(newMrId);
    expect(body.status).toBe('active');
    expect(body.supersedes_id).toBe(oldMrId);
    expectNoTenantLeak(r);

    // Verify both rows now in the expected states.
    await withTenantContext(T_US, async () => {
      const client = getTestClient();
      const oldRow = await client.query<{ status: string; superseded_by_id: string | null }>(
        `SELECT status, superseded_by_id FROM medication_requests WHERE tenant_id=$1 AND id=$2`,
        [T_US, oldMrId],
      );
      expect(oldRow.rows[0]!.status).toBe('superseded');
      expect(oldRow.rows[0]!.superseded_by_id).toBe(newMrId);

      // Audit: prescribing.approved (new row) + medication_request.superseded (old row).
      const audits = await client.query<{ action: string; resource_id: string }>(
        `SELECT action, resource_id FROM audit_records
          WHERE tenant_id = $1
            AND resource_id IN ($2, $3)
            AND action IN ('prescribing.approved', 'medication_request.superseded')`,
        [T_US, newMrId, oldMrId],
      );
      const approved = audits.rows.find(
        (r) => r.action === 'prescribing.approved' && r.resource_id === newMrId,
      );
      const superseded = audits.rows.find(
        (r) => r.action === 'medication_request.superseded' && r.resource_id === oldMrId,
      );
      expect(approved).toBeDefined();
      expect(superseded).toBeDefined();

      // Domain events: medication_request.approved.v1 + .superseded.v1
      const events = await client.query<{ event_type: string; aggregate_id: string }>(
        `SELECT event_type, aggregate_id FROM domain_events_outbox
          WHERE tenant_id = $1
            AND aggregate_id IN ($2, $3)
            AND event_type IN ('medication_request.approved.v1',
                               'medication_request.superseded.v1')`,
        [T_US, newMrId, oldMrId],
      );
      expect(
        events.rows.find(
          (r) => r.event_type === 'medication_request.approved.v1' && r.aggregate_id === newMrId,
        ),
      ).toBeDefined();
      expect(
        events.rows.find(
          (r) => r.event_type === 'medication_request.superseded.v1' && r.aggregate_id === oldMrId,
        ),
      ).toBeDefined();
    });
  });
});

// ===========================================================================
// Group B — Auth + role gate
// ===========================================================================

describe('pharmacy supersession — Group B: auth + role gate', () => {
  async function setup() {
    const clinician = await insertAccountOfType(US_CTX, 'clinician', '+1');
    const patient = await insertAccountOfType(US_CTX, 'patient', '+1');
    const product = await seedProduct(US_CTX);
    const oldMrId = await seedRow({
      ctx: US_CTX,
      patientAccountId: patient,
      productCatalogId: product,
      status: 'active',
      prescriberAccountId: clinician,
    });
    const newMrId = await seedRow({
      ctx: US_CTX,
      patientAccountId: patient,
      productCatalogId: product,
      status: 'pending_clinician_review',
    });
    return { clinician, patient, oldMrId, newMrId };
  }

  it('B1 patient JWT → 403', async () => {
    const { patient, oldMrId, newMrId } = await setup();
    const token = await mintTokenForRole(T_US, patient, 'patient');
    const r = await app!.inject({
      method: 'POST',
      url: `/v0/pharmacy/prescriptions/${newMrId}/supersede`,
      headers: {
        host: 'heroshealth.com',
        authorization: `Bearer ${token}`,
        'idempotency-key': ulid(),
      },
      payload: {
        supersedes_medication_request_id: oldMrId,
        supersession_reason: 'x',
      },
    });
    expect(r.statusCode).toBe(403);
    expectNoTenantLeak(r);
  });

  it('B2 no JWT → 401', async () => {
    const { oldMrId, newMrId } = await setup();
    const r = await app!.inject({
      method: 'POST',
      url: `/v0/pharmacy/prescriptions/${newMrId}/supersede`,
      headers: { host: 'heroshealth.com', 'idempotency-key': ulid() },
      payload: {
        supersedes_medication_request_id: oldMrId,
        supersession_reason: 'x',
      },
    });
    expect(r.statusCode).toBe(401);
    expectNoTenantLeak(r);
  });
});

// ===========================================================================
// Group C — Body validation
// ===========================================================================

describe('pharmacy supersession — Group C: body validation', () => {
  async function setup() {
    const clinician = await insertAccountOfType(US_CTX, 'clinician', '+1');
    const patient = await insertAccountOfType(US_CTX, 'patient', '+1');
    const product = await seedProduct(US_CTX);
    const oldMrId = await seedRow({
      ctx: US_CTX,
      patientAccountId: patient,
      productCatalogId: product,
      status: 'active',
      prescriberAccountId: clinician,
    });
    const newMrId = await seedRow({
      ctx: US_CTX,
      patientAccountId: patient,
      productCatalogId: product,
      status: 'pending_clinician_review',
    });
    const token = await mintTokenForRole(T_US, clinician, 'clinician');
    return { token, oldMrId, newMrId };
  }

  it('C1 missing supersedes_medication_request_id → 400', async () => {
    const { token, newMrId } = await setup();
    const r = await app!.inject({
      method: 'POST',
      url: `/v0/pharmacy/prescriptions/${newMrId}/supersede`,
      headers: {
        host: 'heroshealth.com',
        authorization: `Bearer ${token}`,
        'idempotency-key': ulid(),
      },
      payload: { supersession_reason: 'x' },
    });
    expect(r.statusCode).toBe(400);
    expectNoTenantLeak(r);
  });

  it('C2 missing supersession_reason → 400', async () => {
    const { token, oldMrId, newMrId } = await setup();
    const r = await app!.inject({
      method: 'POST',
      url: `/v0/pharmacy/prescriptions/${newMrId}/supersede`,
      headers: {
        host: 'heroshealth.com',
        authorization: `Bearer ${token}`,
        'idempotency-key': ulid(),
      },
      payload: { supersedes_medication_request_id: oldMrId },
    });
    expect(r.statusCode).toBe(400);
    expectNoTenantLeak(r);
  });

  it('C3 unexpected body field → 400', async () => {
    const { token, oldMrId, newMrId } = await setup();
    const r = await app!.inject({
      method: 'POST',
      url: `/v0/pharmacy/prescriptions/${newMrId}/supersede`,
      headers: {
        host: 'heroshealth.com',
        authorization: `Bearer ${token}`,
        'idempotency-key': ulid(),
      },
      payload: {
        supersedes_medication_request_id: oldMrId,
        supersession_reason: 'x',
        extra: 'not_allowed',
      },
    });
    expect(r.statusCode).toBe(400);
    expectNoTenantLeak(r);
  });
});

// ===========================================================================
// Group D — Resource resolution
// ===========================================================================

describe('pharmacy supersession — Group D: resource resolution', () => {
  it('D1 nonexistent new id → 404', async () => {
    const clinician = await insertAccountOfType(US_CTX, 'clinician', '+1');
    const patient = await insertAccountOfType(US_CTX, 'patient', '+1');
    const product = await seedProduct(US_CTX);
    const oldMrId = await seedRow({
      ctx: US_CTX,
      patientAccountId: patient,
      productCatalogId: product,
      status: 'active',
      prescriberAccountId: clinician,
    });
    const token = await mintTokenForRole(T_US, clinician, 'clinician');
    const fakeNewId = `mrx_${ulid()}`;
    const r = await app!.inject({
      method: 'POST',
      url: `/v0/pharmacy/prescriptions/${fakeNewId}/supersede`,
      headers: {
        host: 'heroshealth.com',
        authorization: `Bearer ${token}`,
        'idempotency-key': ulid(),
      },
      payload: { supersedes_medication_request_id: oldMrId, supersession_reason: 'x' },
    });
    expect(r.statusCode).toBe(404);
    expectNoTenantLeak(r);
  });

  it('D2 nonexistent old id → 404', async () => {
    const clinician = await insertAccountOfType(US_CTX, 'clinician', '+1');
    const patient = await insertAccountOfType(US_CTX, 'patient', '+1');
    const product = await seedProduct(US_CTX);
    const newMrId = await seedRow({
      ctx: US_CTX,
      patientAccountId: patient,
      productCatalogId: product,
      status: 'pending_clinician_review',
    });
    const token = await mintTokenForRole(T_US, clinician, 'clinician');
    const fakeOldId = `mrx_${ulid()}`;
    const r = await app!.inject({
      method: 'POST',
      url: `/v0/pharmacy/prescriptions/${newMrId}/supersede`,
      headers: {
        host: 'heroshealth.com',
        authorization: `Bearer ${token}`,
        'idempotency-key': ulid(),
      },
      payload: {
        supersedes_medication_request_id: fakeOldId,
        supersession_reason: 'x',
      },
    });
    expect(r.statusCode).toBe(404);
    expectNoTenantLeak(r);
  });

  it('D3 cross-patient (old belongs to a different patient) → 404 (I-025 collapsed)', async () => {
    const clinician = await insertAccountOfType(US_CTX, 'clinician', '+1');
    const patientA = await insertAccountOfType(US_CTX, 'patient', '+1');
    const patientB = await insertAccountOfType(US_CTX, 'patient', '+1');
    const product = await seedProduct(US_CTX);
    const oldMrIdForB = await seedRow({
      ctx: US_CTX,
      patientAccountId: patientB,
      productCatalogId: product,
      status: 'active',
      prescriberAccountId: clinician,
    });
    const newMrIdForA = await seedRow({
      ctx: US_CTX,
      patientAccountId: patientA,
      productCatalogId: product,
      status: 'pending_clinician_review',
    });
    const token = await mintTokenForRole(T_US, clinician, 'clinician');
    const r = await app!.inject({
      method: 'POST',
      url: `/v0/pharmacy/prescriptions/${newMrIdForA}/supersede`,
      headers: {
        host: 'heroshealth.com',
        authorization: `Bearer ${token}`,
        'idempotency-key': ulid(),
      },
      payload: {
        supersedes_medication_request_id: oldMrIdForB,
        supersession_reason: 'x',
      },
    });
    expect(r.statusCode).toBe(404);
    expectNoTenantLeak(r);
  });
});

// ===========================================================================
// Group E — State machine + anti-self-loop
// ===========================================================================

describe('pharmacy supersession — Group E: state machine + anti-self-loop', () => {
  it('E1 anti-self-loop (new id === old id) → 400', async () => {
    const clinician = await insertAccountOfType(US_CTX, 'clinician', '+1');
    const patient = await insertAccountOfType(US_CTX, 'patient', '+1');
    const product = await seedProduct(US_CTX);
    const mrId = await seedRow({
      ctx: US_CTX,
      patientAccountId: patient,
      productCatalogId: product,
      status: 'pending_clinician_review',
    });
    const token = await mintTokenForRole(T_US, clinician, 'clinician');
    const r = await app!.inject({
      method: 'POST',
      url: `/v0/pharmacy/prescriptions/${mrId}/supersede`,
      headers: {
        host: 'heroshealth.com',
        authorization: `Bearer ${token}`,
        'idempotency-key': ulid(),
      },
      payload: { supersedes_medication_request_id: mrId, supersession_reason: 'x' },
    });
    expect(r.statusCode).toBe(400);
    expectNoTenantLeak(r);
  });

  it('E2 old row not active (draft) → 409', async () => {
    const clinician = await insertAccountOfType(US_CTX, 'clinician', '+1');
    const patient = await insertAccountOfType(US_CTX, 'patient', '+1');
    const product = await seedProduct(US_CTX);
    const oldDraftId = await seedRow({
      ctx: US_CTX,
      patientAccountId: patient,
      productCatalogId: product,
      status: 'draft',
    });
    const newMrId = await seedRow({
      ctx: US_CTX,
      patientAccountId: patient,
      productCatalogId: product,
      status: 'pending_clinician_review',
    });
    const token = await mintTokenForRole(T_US, clinician, 'clinician');
    const r = await app!.inject({
      method: 'POST',
      url: `/v0/pharmacy/prescriptions/${newMrId}/supersede`,
      headers: {
        host: 'heroshealth.com',
        authorization: `Bearer ${token}`,
        'idempotency-key': ulid(),
      },
      payload: {
        supersedes_medication_request_id: oldDraftId,
        supersession_reason: 'x',
      },
    });
    expect(r.statusCode).toBe(409);
    expectNoTenantLeak(r);
  });
});
