/**
 * pharmacy-discontinue-http.test.ts — HTTP integration tests for the
 * patient-origin discontinue endpoint per Sprint 35-36 / TLC-055 PR D.
 *
 * Endpoint under test:
 *   POST /v0/pharmacy/prescriptions/:id/discontinue
 *
 * Coverage (6 groups, 11 cases):
 *
 *   Group A — Happy path
 *     A1 patient discontinues own active medication_request → 200 +
 *        PHI-safe view with status=discontinued + discontinued_reason='patient_request'
 *
 *   Group B — Tenant-blind 404 + cross-patient-blind 404
 *     B1 nonexistent id → 404
 *     B2 malformed id → 404 (NOT 400; side-channel closure per I-025)
 *     B3 cross-tenant — Ghana row queried via US JWT → 404
 *     B4 cross-patient same-tenant — patient B discontinues patient A's row → 404
 *
 *   Group C — State conflict
 *     C1 attempt to discontinue a row that is already 'discontinued' → 409
 *     C2 attempt to discontinue a row that is still 'draft' → 409
 *
 *   Group D — Idempotency (IDEMPOTENCY v5.1)
 *     D1 same key + same body → cached 200 replay
 *     (body-mismatch test removed: discontinue accepts no body at all,
 *      so the body-mismatch path isn't reachable through this endpoint.)
 *
 *   Group E — Auth
 *     E1 no Bearer JWT → 401
 *
 *   Group F — Body validation (Codex PR-117 R1 HIGH closure)
 *     F1 non-empty body (e.g., {"reason": "adverse_event"}) → 400
 *     F2 array body → 400
 *
 *   (Global PHI-leak guard applied to every response body)
 *
 * Spec references:
 *   - src/modules/pharmacy/internal/handlers/prescriptions.ts (discontinue handler)
 *   - src/modules/pharmacy/internal/services/medication-request-service.ts
 *   - State Machines v1.2 §19 (active → discontinued via patient_request_discontinue)
 *   - AUDIT_EVENTS v5.3 (medication_request.discontinued Category A)
 *   - DOMAIN_EVENTS v5.2 (medication_request.discontinued.v1)
 *   - ERROR_MODEL v5.1 (envelope + canonical codes)
 *   - IDEMPOTENCY v5.1 §1 (cache 4-tuple, replay, body-mismatch)
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

// ---------------------------------------------------------------------------
// Tenant + context fixtures
// ---------------------------------------------------------------------------

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

async function seedAccountInTenant(ctx: TenantContext, phonePrefix: string): Promise<AccountId> {
  const accountId = asAccountId(ulid());
  const phone = uniquePhone(phonePrefix);
  await withTenantContext(ctx.tenantId, () =>
    createAccount(
      {
        account_id: accountId,
        tenant_id: ctx.tenantId,
        phone_e164: phone,
        first_name: 'A',
        last_name: 'B',
        date_of_birth: '1990-01-01',
        gender: 'prefer_not_to_say',
        country_of_residence: ctx.countryOfCare,
        country_of_care: ctx.countryOfCare,
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

interface SeedMedicationRequestOptions {
  ctx: TenantContext;
  patientAccountId: AccountId;
  productCatalogId: ProductCatalogId;
  status: 'draft' | 'active' | 'discontinued';
}

/**
 * Insert a medication_request row at the requested terminal status,
 * bypassing the state machine. Used as a test fixture so the
 * discontinue endpoint can be exercised against rows in a variety of
 * pre-conditions (active for happy path, draft/discontinued for
 * state-conflict tests). All migration 025 CHECK constraints are
 * satisfied: active/post-active rows carry interaction_signals_status=
 * 'clean' + interaction_signals_evaluated_at + prescribed_by_clinician_
 * account_id + prescribed_at. The clinician-only path is used (AI
 * envelope fields stay null per CHECK clause (a)).
 */
async function seedMedicationRequest(
  options: SeedMedicationRequestOptions,
): Promise<MedicationRequestId> {
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
          $1, $2,
          $3, $4,
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
        // Reuse the patient account as a stand-in prescriber. The
        // accounts table's account_type_check at v1.0 only permits
        // patient | delegate, and the medication_requests composite FK
        // doesn't restrict account_type. Bounded to test fixtures.
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
// Auth helpers — seed real session, mint JWT bound to it
// ---------------------------------------------------------------------------

async function seedSession(tenantId: TenantId, accountId: AccountId): Promise<SessionId> {
  const sessionId = asSessionId(ulid());
  const refreshTokenHash = '0'.repeat(64);
  await withTenantContext(tenantId, () =>
    sessionRepo.createSession(
      {
        session_id: sessionId,
        tenant_id: tenantId,
        account_id: accountId,
        refresh_token_hash: refreshTokenHash,
        expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      },
      async () => {
        /* no-op */
      },
    ),
  );
  return sessionId;
}

async function mintToken(tenantId: TenantId, accountId: AccountId): Promise<string> {
  const sessionId = await seedSession(tenantId, accountId);
  return issueAccessToken(
    {
      account_id: accountId,
      tenant_id: tenantId,
      session_id: sessionId,
      country_of_care: tenantId === T_US ? 'US' : 'GH',
    },
    config.jwtSigningKey,
  );
}

// ---------------------------------------------------------------------------
// PHI projection guard
// ---------------------------------------------------------------------------

function expectNoTenantLeak(response: { body: string }): void {
  expect(response.body).not.toContain('"tenant_id"');
  expect(response.body).not.toContain('Telecheck-US');
  expect(response.body).not.toContain('Telecheck-Ghana');
}

// ===========================================================================
// Group A — Happy path
// ===========================================================================

describe('pharmacy discontinue — Group A: happy path', () => {
  it('A1 patient discontinues own active row → 200 + status=discontinued + reason=patient_request', async () => {
    const patient = await seedAccountInTenant(US_CTX, '+1');
    const product = await seedProduct(US_CTX);
    const mrId = await seedMedicationRequest({
      ctx: US_CTX,
      patientAccountId: patient,
      productCatalogId: product,
      status: 'active',
    });
    const token = await mintToken(T_US, patient);

    const response = await app!.inject({
      method: 'POST',
      url: `/v0/pharmacy/prescriptions/${mrId}/discontinue`,
      headers: {
        host: 'heroshealth.com',
        authorization: `Bearer ${token}`,
        'idempotency-key': ulid(),
      },
      payload: {},
    });

    expect(response.statusCode).toBe(200);
    const body = response.json<{
      id: string;
      status: string;
      discontinued_reason: string;
      discontinued_at: string;
    }>();
    expect(body.id).toBe(mrId);
    expect(body.status).toBe('discontinued');
    expect(body.discontinued_reason).toBe('patient_request');
    expect(body.discontinued_at).toBeTruthy();
    expect(body).not.toHaveProperty('tenant_id');
    expectNoTenantLeak(response);
  });
});

// ===========================================================================
// Group B — Tenant-blind 404 + cross-patient-blind 404
// ===========================================================================

describe('pharmacy discontinue — Group B: tenant-blind / cross-patient-blind 404', () => {
  it('B1 nonexistent id → 404 internal.resource.not_found', async () => {
    const patient = await seedAccountInTenant(US_CTX, '+1');
    const token = await mintToken(T_US, patient);
    const nonexistent = `mrx_${ulid()}`;

    const response = await app!.inject({
      method: 'POST',
      url: `/v0/pharmacy/prescriptions/${nonexistent}/discontinue`,
      headers: {
        host: 'heroshealth.com',
        authorization: `Bearer ${token}`,
        'idempotency-key': ulid(),
      },
      payload: {},
    });

    expect(response.statusCode).toBe(404);
    const body = response.json<{ error: { code: string } }>();
    expect(body.error.code).toBe('internal.resource.not_found');
    expectNoTenantLeak(response);
  });

  it('B2 malformed id → 404 (NOT 400)', async () => {
    const patient = await seedAccountInTenant(US_CTX, '+1');
    const token = await mintToken(T_US, patient);

    const response = await app!.inject({
      method: 'POST',
      url: '/v0/pharmacy/prescriptions/not-a-valid-id/discontinue',
      headers: {
        host: 'heroshealth.com',
        authorization: `Bearer ${token}`,
        'idempotency-key': ulid(),
      },
      payload: {},
    });

    expect(response.statusCode).toBe(404);
    const body = response.json<{ error: { code: string } }>();
    expect(body.error.code).toBe('internal.resource.not_found');
    expectNoTenantLeak(response);
  });

  it('B3 cross-tenant — Ghana row queried via US JWT → 404', async () => {
    const ghPatient = await seedAccountInTenant(GH_CTX, '+233');
    const ghProduct = await seedProduct(GH_CTX);
    const ghMrId = await seedMedicationRequest({
      ctx: GH_CTX,
      patientAccountId: ghPatient,
      productCatalogId: ghProduct,
      status: 'active',
    });

    const usPatient = await seedAccountInTenant(US_CTX, '+1');
    const usToken = await mintToken(T_US, usPatient);

    const response = await app!.inject({
      method: 'POST',
      url: `/v0/pharmacy/prescriptions/${ghMrId}/discontinue`,
      headers: {
        host: 'heroshealth.com',
        authorization: `Bearer ${usToken}`,
        'idempotency-key': ulid(),
      },
      payload: {},
    });

    expect(response.statusCode).toBe(404);
    const body = response.json<{ error: { code: string } }>();
    expect(body.error.code).toBe('internal.resource.not_found');
    expectNoTenantLeak(response);
  });

  it('B4 cross-patient same-tenant — patient B discontinues patient A row → 404', async () => {
    const patientA = await seedAccountInTenant(US_CTX, '+1');
    const patientB = await seedAccountInTenant(US_CTX, '+1');
    const product = await seedProduct(US_CTX);
    const mrA = await seedMedicationRequest({
      ctx: US_CTX,
      patientAccountId: patientA,
      productCatalogId: product,
      status: 'active',
    });
    const tokenB = await mintToken(T_US, patientB);

    const response = await app!.inject({
      method: 'POST',
      url: `/v0/pharmacy/prescriptions/${mrA}/discontinue`,
      headers: {
        host: 'heroshealth.com',
        authorization: `Bearer ${tokenB}`,
        'idempotency-key': ulid(),
      },
      payload: {},
    });

    expect(response.statusCode).toBe(404);
    const body = response.json<{ error: { code: string } }>();
    expect(body.error.code).toBe('internal.resource.not_found');
    expectNoTenantLeak(response);
  });
});

// ===========================================================================
// Group C — State conflict
// ===========================================================================

describe('pharmacy discontinue — Group C: state conflict 409', () => {
  it('C1 already-discontinued row → 409 internal.resource.conflict', async () => {
    const patient = await seedAccountInTenant(US_CTX, '+1');
    const product = await seedProduct(US_CTX);
    const mrId = await seedMedicationRequest({
      ctx: US_CTX,
      patientAccountId: patient,
      productCatalogId: product,
      status: 'discontinued',
    });
    const token = await mintToken(T_US, patient);

    const response = await app!.inject({
      method: 'POST',
      url: `/v0/pharmacy/prescriptions/${mrId}/discontinue`,
      headers: {
        host: 'heroshealth.com',
        authorization: `Bearer ${token}`,
        'idempotency-key': ulid(),
      },
      payload: {},
    });

    expect(response.statusCode).toBe(409);
    const body = response.json<{ error: { code: string } }>();
    expect(body.error.code).toBe('internal.resource.conflict');
    expectNoTenantLeak(response);
  });

  it('C2 draft row → 409 internal.resource.conflict', async () => {
    const patient = await seedAccountInTenant(US_CTX, '+1');
    const product = await seedProduct(US_CTX);
    const mrId = await seedMedicationRequest({
      ctx: US_CTX,
      patientAccountId: patient,
      productCatalogId: product,
      status: 'draft',
    });
    const token = await mintToken(T_US, patient);

    const response = await app!.inject({
      method: 'POST',
      url: `/v0/pharmacy/prescriptions/${mrId}/discontinue`,
      headers: {
        host: 'heroshealth.com',
        authorization: `Bearer ${token}`,
        'idempotency-key': ulid(),
      },
      payload: {},
    });

    expect(response.statusCode).toBe(409);
    const body = response.json<{ error: { code: string } }>();
    expect(body.error.code).toBe('internal.resource.conflict');
    expectNoTenantLeak(response);
  });
});

// ===========================================================================
// Group D — Idempotency replay (IDEMPOTENCY v5.1)
// ===========================================================================

describe('pharmacy discontinue — Group D: idempotency replay', () => {
  it('D1 same key + same body → cached 200 replay', async () => {
    const patient = await seedAccountInTenant(US_CTX, '+1');
    const product = await seedProduct(US_CTX);
    const mrId = await seedMedicationRequest({
      ctx: US_CTX,
      patientAccountId: patient,
      productCatalogId: product,
      status: 'active',
    });
    const token = await mintToken(T_US, patient);
    const key = ulid();

    const first = await app!.inject({
      method: 'POST',
      url: `/v0/pharmacy/prescriptions/${mrId}/discontinue`,
      headers: {
        host: 'heroshealth.com',
        authorization: `Bearer ${token}`,
        'idempotency-key': key,
      },
      payload: {},
    });
    expect(first.statusCode).toBe(200);
    const firstBody = first.json<{ id: string; status: string; discontinued_at: string }>();
    expectNoTenantLeak(first);

    // Replay with the SAME key + SAME body. The cache hit MUST return
    // the cached 200, NOT re-run the discontinue path (which would
    // now state-conflict because the row is already discontinued).
    // Compare parsed JSON, not raw serialized body — the cached body
    // may be re-serialized with subtle whitespace/key-order
    // differences that don't affect semantics (matches the async-
    // consult E1 idempotency-replay assertion pattern).
    const replay = await app!.inject({
      method: 'POST',
      url: `/v0/pharmacy/prescriptions/${mrId}/discontinue`,
      headers: {
        host: 'heroshealth.com',
        authorization: `Bearer ${token}`,
        'idempotency-key': key,
      },
      payload: {},
    });
    expect(replay.statusCode).toBe(200);
    const replayBody = replay.json<{ id: string; status: string; discontinued_at: string }>();
    // Prove no new row was created: replay returns the same row id,
    // the row stayed in status='discontinued' (didn't re-attempt the
    // active → discontinued transition, which would have state-
    // conflicted), and the cached discontinued_at timestamp was
    // returned verbatim (not re-stamped at replay time).
    expect(replayBody.id).toBe(firstBody.id);
    expect(replayBody.status).toBe('discontinued');
    expect(replayBody.discontinued_at).toBe(firstBody.discontinued_at);
    expectNoTenantLeak(replay);
  });
});

// ===========================================================================
// Group F — Body validation (Codex PR-117 R1 HIGH closure)
//
// The discontinue endpoint forces discontinued_reason='patient_request'
// server-side because that's the only patient-origin discontinue
// transition at v1.0. A patient POSTing arbitrary content (e.g., to
// flag adverse_event) must be rejected loud — silently dropping the
// safety signal AND emitting a misleading audit/domain-event payload
// would be a patient-safety surface failure.
// ===========================================================================

describe('pharmacy discontinue — Group F: body validation', () => {
  it('F1 non-empty body with arbitrary fields → 400 internal.request.invalid', async () => {
    const patient = await seedAccountInTenant(US_CTX, '+1');
    const product = await seedProduct(US_CTX);
    const mrId = await seedMedicationRequest({
      ctx: US_CTX,
      patientAccountId: patient,
      productCatalogId: product,
      status: 'active',
    });
    const token = await mintToken(T_US, patient);

    // Patient attempts to flag adverse event by sending a body field.
    // Endpoint MUST reject loud rather than silently coerce to
    // patient_request — otherwise the audit chain miscodes the
    // patient's safety signal.
    const response = await app!.inject({
      method: 'POST',
      url: `/v0/pharmacy/prescriptions/${mrId}/discontinue`,
      headers: {
        host: 'heroshealth.com',
        authorization: `Bearer ${token}`,
        'idempotency-key': ulid(),
      },
      payload: { reason: 'adverse_event' },
    });

    expect(response.statusCode).toBe(400);
    const body = response.json<{ error: { code: string } }>();
    expect(body.error.code).toBe('internal.request.invalid');
    expectNoTenantLeak(response);
  });

  it('F2 array body → 400 internal.request.invalid', async () => {
    // Defense against `payload: ['a', 'b']` being typed as object by
    // typeof — the guard explicitly rejects arrays.
    const patient = await seedAccountInTenant(US_CTX, '+1');
    const product = await seedProduct(US_CTX);
    const mrId = await seedMedicationRequest({
      ctx: US_CTX,
      patientAccountId: patient,
      productCatalogId: product,
      status: 'active',
    });
    const token = await mintToken(T_US, patient);

    const response = await app!.inject({
      method: 'POST',
      url: `/v0/pharmacy/prescriptions/${mrId}/discontinue`,
      headers: {
        host: 'heroshealth.com',
        authorization: `Bearer ${token}`,
        'idempotency-key': ulid(),
      },
      payload: ['something'],
    });

    expect(response.statusCode).toBe(400);
    const body = response.json<{ error: { code: string } }>();
    expect(body.error.code).toBe('internal.request.invalid');
    expectNoTenantLeak(response);
  });
});

// ===========================================================================
// Group E — Auth
// ===========================================================================

describe('pharmacy discontinue — Group E: auth failures', () => {
  it('E1 no Bearer JWT → 401', async () => {
    const response = await app!.inject({
      method: 'POST',
      url: `/v0/pharmacy/prescriptions/mrx_${ulid()}/discontinue`,
      headers: {
        host: 'heroshealth.com',
        'idempotency-key': ulid(),
      },
      payload: {},
    });

    expect(response.statusCode).toBe(401);
    expectNoTenantLeak(response);
  });
});
