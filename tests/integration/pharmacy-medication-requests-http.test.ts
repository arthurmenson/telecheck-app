/**
 * pharmacy-medication-requests-http.test.ts — Pharmacy slice HTTP read
 * handler integration tests per Sprint 35-36 / TLC-055 PR C.
 *
 * Exercises the two read endpoints wired in PR C via Fastify inject()
 * with Bearer JWT auth. Mirrors the established async-consult-http.test
 * structure (helpers, PHI-leak guard, tenant fixture pattern).
 *
 * Coverage (7 groups, 17 cases):
 *
 *   Group A — Happy path (GET /prescriptions/:id)
 *     A1 200 + PHI-safe view on a freshly-seeded medication_request
 *
 *   Group B — Tenant-blind 404 (GET /prescriptions/:id)
 *     B1 well-formed but non-existent id → 404 (not found)
 *     B2 malformed id → 404 (NOT 400; side-channel closure per I-025)
 *     B3 cross-tenant — Ghana row queried via US JWT → 404
 *     B4 cross-patient same-tenant — patient B reads patient A's row → 404
 *
 *   Group C — Happy path (GET /patients/:patientId/prescriptions)
 *     C1 multi-row list, most-recently-created first
 *     C2 empty list when patient has no medication_requests
 *
 *   Group D — Query validation (list endpoint)
 *     D1 ?status=active filters to active rows only
 *     D2 ?status=NOT_A_REAL_STATUS → 400
 *     D3 ?limit=2 truncates the list
 *     D4 ?limit=99999 silently clamps at the repo layer (no 400)
 *     D5 ?limit=abc → 400
 *     D6 ?limit=0 → 400
 *
 *   Group E — Cross-patient (list endpoint)
 *     E1 GET /v0/pharmacy/patients/<other-account>/prescriptions → 404
 *
 *   Group F — Auth failures
 *     F1 no Bearer JWT → 401
 *     F1c revoked session → 401 (Codex R1 HIGH closure: session-liveness check)
 *     F1d nonexistent session_id → 401 (Codex R1 HIGH closure)
 *
 *   Group G — PHI projection — global guard
 *     enforced at every assertion via expectNoTenantLeak()
 *
 * Spec references:
 *   - src/modules/pharmacy/internal/handlers/prescriptions.ts (target)
 *   - Pharmacy + Refill Slice PRD v2.1 §8
 *   - ERROR_MODEL v5.1 (envelope shape + canonical codes)
 *   - I-023 / I-025 / I-027 (tenant scoping, tenant-blind 404, tenant_id on every row)
 *   - Master PRD v1.10 §17 + Glossary v5.2 C3 (PHI-safe patient views)
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
import * as medicationRequestRepo from '../../src/modules/pharmacy/internal/repositories/medication-request-repo.ts';
import {
  asMedicationRequestId,
  asProductCatalogId,
  type MedicationRequest,
  type MedicationRequestId,
  type MedicationRequestStatus,
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

/**
 * Insert a minimal product_catalog row scoped to the given tenant. The
 * pharmacy module's repository requires a same-tenant product_catalog
 * id when creating a medication_request draft. Mirrors the canonical
 * insert from tests/integration/product-catalog-migration.test.ts.
 */
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
}

/**
 * Seed a draft medication_request via the canonical repo helper. Returns
 * the inserted row so callers can pull the id, status, etc. without a
 * follow-up read.
 */
async function seedMedicationRequest(
  options: SeedMedicationRequestOptions,
): Promise<MedicationRequest> {
  return withTenantContext(options.ctx.tenantId, async () =>
    medicationRequestRepo.createDraft({
      id: asMedicationRequestId(`mrx_${ulid()}`),
      tenant_id: options.ctx.tenantId,
      patient_account_id: options.patientAccountId,
      product_catalog_id: options.productCatalogId,
      medication_name: 'Test Medication',
      strength: '10mg',
      formulation: 'tablet',
      dose_instructions: '1 tablet daily',
      quantity: 30,
      quantity_unit: 'tablet',
      refills_allowed: 0,
      indication: null,
      clinical_notes: null,
      prescribing_consult_id: null,
      country_of_care: options.ctx.countryOfCare,
      protocol_id: null,
      protocol_version: null,
    }),
  );
}

// ---------------------------------------------------------------------------
// Auth helpers — seed a real session row, then mint a JWT bound to it
//
// PR C handlers enforce session liveness via `requireLiveSession()` (which
// looks up sessions by session_id and rejects if revoked or expired).
// Tests therefore MUST seed a real sessions row before minting a JWT so
// the liveness lookup hits a live row. Synthetic session_ids would 401.
//
// The `mintToken` helper is async + auto-seeds a session row alongside
// the JWT. Tests that want to exercise the revoked-session path call
// `seedSession` directly and pass the returned sessionId to
// `mintTokenForSession`.
// ---------------------------------------------------------------------------

async function seedSession(tenantId: TenantId, accountId: AccountId): Promise<SessionId> {
  const sessionId = asSessionId(ulid());
  // A 64-char hex string satisfies the migration's CHECK constraint on
  // refresh_token_hash without exercising the real refresh-token flow.
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
        /* test seeding doesn't need post-INSERT side effects */
      },
    ),
  );
  return sessionId;
}

function mintTokenForSession(
  tenantId: TenantId,
  accountId: AccountId,
  sessionId: SessionId,
): string {
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

/**
 * Seed a session row + mint a JWT bound to it. Replaces the JWT-only
 * helper from PR C v1; PR C v2 (Codex R1 closure) enforces session
 * liveness so a synthetic session_id no longer authenticates.
 */
async function mintToken(tenantId: TenantId, accountId: AccountId): Promise<string> {
  const sessionId = await seedSession(tenantId, accountId);
  return mintTokenForSession(tenantId, accountId, sessionId);
}

// ---------------------------------------------------------------------------
// PHI projection guard — asserted on EVERY response body
// ---------------------------------------------------------------------------

/**
 * Assert that a response body — success OR error envelope — leaks
 * neither the literal `tenant_id` JSON key nor either operating-tenant
 * identifier anywhere in its serialized body. Applied to every
 * `app.inject()` response per the async-consult-http precedent (Codex
 * Sprint 34 PR-51 MEDIUM closure).
 */
function expectNoTenantLeak(response: { body: string }): void {
  expect(response.body).not.toContain('"tenant_id"');
  expect(response.body).not.toContain('Telecheck-US');
  expect(response.body).not.toContain('Telecheck-Ghana');
}

// ===========================================================================
// Group A — Happy path (GET /prescriptions/:id)
// ===========================================================================

describe('pharmacy HTTP — Group A: GET /prescriptions/:id happy path', () => {
  it('A1 returns 200 + PHI-safe MedicationRequest view', async () => {
    const patient = await seedAccountInTenant(US_CTX, '+1');
    const product = await seedProduct(US_CTX);
    const seeded = await seedMedicationRequest({
      ctx: US_CTX,
      patientAccountId: patient,
      productCatalogId: product,
    });
    const token = await mintToken(T_US, patient);

    const response = await app!.inject({
      method: 'GET',
      url: `/v0/pharmacy/prescriptions/${seeded.id}`,
      headers: {
        host: 'heroshealth.com',
        authorization: `Bearer ${token}`,
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json<{
      id: MedicationRequestId;
      patient_account_id: string;
      status: MedicationRequestStatus;
      medication_name: string;
      tenant_id?: undefined;
    }>();
    expect(body.id).toBe(seeded.id);
    expect(body.patient_account_id).toBe(patient);
    expect(body.status).toBe('draft');
    expect(body.medication_name).toBe('Test Medication');
    // PHI projection — the serialized body MUST NOT carry tenant_id.
    expect(body).not.toHaveProperty('tenant_id');
    expectNoTenantLeak(response);
  });
});

// ===========================================================================
// Group B — Tenant-blind 404 (GET /prescriptions/:id)
// ===========================================================================

describe('pharmacy HTTP — Group B: GET /prescriptions/:id tenant-blind 404', () => {
  it('B1 well-formed but non-existent id → 404 internal.resource.not_found', async () => {
    const patient = await seedAccountInTenant(US_CTX, '+1');
    const token = await mintToken(T_US, patient);
    const nonexistent = `mrx_${ulid()}`;

    const response = await app!.inject({
      method: 'GET',
      url: `/v0/pharmacy/prescriptions/${nonexistent}`,
      headers: { host: 'heroshealth.com', authorization: `Bearer ${token}` },
    });

    expect(response.statusCode).toBe(404);
    const body = response.json<{ error: { code: string } }>();
    expect(body.error.code).toBe('internal.resource.not_found');
    expectNoTenantLeak(response);
  });

  it('B2 malformed id → 404 (NOT 400; side-channel closure per I-025)', async () => {
    const patient = await seedAccountInTenant(US_CTX, '+1');
    const token = await mintToken(T_US, patient);
    // Not an mrx_<ULID> — fails canonical-id validation in the handler.
    // The handler MUST return 404 not 400 so the malformed case is
    // byte-identical to a tenant-blind not-found.
    const malformed = 'not-a-valid-id';

    const response = await app!.inject({
      method: 'GET',
      url: `/v0/pharmacy/prescriptions/${malformed}`,
      headers: { host: 'heroshealth.com', authorization: `Bearer ${token}` },
    });

    expect(response.statusCode).toBe(404);
    const body = response.json<{ error: { code: string } }>();
    expect(body.error.code).toBe('internal.resource.not_found');
    expectNoTenantLeak(response);
  });

  it('B3 cross-tenant — Ghana-seeded row queried via US JWT → 404', async () => {
    // Seed a medication_request in Ghana via the repo, then attempt to
    // GET it as a US-authenticated patient. The handler resolves
    // tenantContext from the US host header; repo.findById filters by
    // tenant_id; RLS additionally enforces the boundary. End result: a
    // 404 envelope byte-identical to "doesn't exist".
    const ghPatient = await seedAccountInTenant(GH_CTX, '+233');
    const ghProduct = await seedProduct(GH_CTX);
    const ghMr = await seedMedicationRequest({
      ctx: GH_CTX,
      patientAccountId: ghPatient,
      productCatalogId: ghProduct,
    });

    // US-authed patient (independent of the Ghana row).
    const usPatient = await seedAccountInTenant(US_CTX, '+1');
    const usToken = await mintToken(T_US, usPatient);

    const response = await app!.inject({
      method: 'GET',
      url: `/v0/pharmacy/prescriptions/${ghMr.id}`,
      headers: { host: 'heroshealth.com', authorization: `Bearer ${usToken}` },
    });

    expect(response.statusCode).toBe(404);
    const body = response.json<{ error: { code: string } }>();
    expect(body.error.code).toBe('internal.resource.not_found');
    expectNoTenantLeak(response);
  });

  it('B4 cross-patient same-tenant — patient B reads patient A row → 404', async () => {
    // Patient A's medication_request, patient B's JWT — same tenant,
    // different patient. I-025 forbids leaking "exists but not yours";
    // handler must 404 tenant-blind / cross-patient-blind.
    const patientA = await seedAccountInTenant(US_CTX, '+1');
    const patientB = await seedAccountInTenant(US_CTX, '+1');
    const product = await seedProduct(US_CTX);
    const mrA = await seedMedicationRequest({
      ctx: US_CTX,
      patientAccountId: patientA,
      productCatalogId: product,
    });
    const tokenB = await mintToken(T_US, patientB);

    const response = await app!.inject({
      method: 'GET',
      url: `/v0/pharmacy/prescriptions/${mrA.id}`,
      headers: { host: 'heroshealth.com', authorization: `Bearer ${tokenB}` },
    });

    expect(response.statusCode).toBe(404);
    const body = response.json<{ error: { code: string } }>();
    expect(body.error.code).toBe('internal.resource.not_found');
    expectNoTenantLeak(response);
  });
});

// ===========================================================================
// Group C — Happy path (GET /patients/:patientId/prescriptions)
// ===========================================================================

describe('pharmacy HTTP — Group C: list happy path', () => {
  it('C1 returns 200 + multi-row list, most-recently-created first', async () => {
    const patient = await seedAccountInTenant(US_CTX, '+1');
    const product = await seedProduct(US_CTX);
    const first = await seedMedicationRequest({
      ctx: US_CTX,
      patientAccountId: patient,
      productCatalogId: product,
    });
    // Yield to the event loop so the second row's created_at strictly
    // postdates the first — the repo orders by created_at DESC.
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    const second = await seedMedicationRequest({
      ctx: US_CTX,
      patientAccountId: patient,
      productCatalogId: product,
    });

    const token = await mintToken(T_US, patient);
    const response = await app!.inject({
      method: 'GET',
      url: `/v0/pharmacy/patients/${patient}/prescriptions`,
      headers: { host: 'heroshealth.com', authorization: `Bearer ${token}` },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json<{ prescriptions: Array<{ id: string }> }>();
    expect(body.prescriptions).toHaveLength(2);
    expect(body.prescriptions[0]?.id).toBe(second.id);
    expect(body.prescriptions[1]?.id).toBe(first.id);
    expectNoTenantLeak(response);
  });

  it('C2 empty list when patient has no medication_requests', async () => {
    const patient = await seedAccountInTenant(US_CTX, '+1');
    const token = await mintToken(T_US, patient);

    const response = await app!.inject({
      method: 'GET',
      url: `/v0/pharmacy/patients/${patient}/prescriptions`,
      headers: { host: 'heroshealth.com', authorization: `Bearer ${token}` },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json<{ prescriptions: unknown[] }>();
    expect(body.prescriptions).toEqual([]);
    expectNoTenantLeak(response);
  });
});

// ===========================================================================
// Group D — Query validation (list endpoint)
// ===========================================================================

describe('pharmacy HTTP — Group D: list query validation', () => {
  it('D1 ?status=draft returns rows matching that status', async () => {
    const patient = await seedAccountInTenant(US_CTX, '+1');
    const product = await seedProduct(US_CTX);
    await seedMedicationRequest({
      ctx: US_CTX,
      patientAccountId: patient,
      productCatalogId: product,
    });

    const token = await mintToken(T_US, patient);
    const response = await app!.inject({
      method: 'GET',
      url: `/v0/pharmacy/patients/${patient}/prescriptions?status=draft`,
      headers: { host: 'heroshealth.com', authorization: `Bearer ${token}` },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json<{ prescriptions: Array<{ status: string }> }>();
    expect(body.prescriptions.length).toBeGreaterThanOrEqual(1);
    for (const row of body.prescriptions) {
      expect(row.status).toBe('draft');
    }
    expectNoTenantLeak(response);
  });

  it('D2 ?status=NOT_A_REAL_STATUS → 400 internal.request.invalid', async () => {
    const patient = await seedAccountInTenant(US_CTX, '+1');
    const token = await mintToken(T_US, patient);

    const response = await app!.inject({
      method: 'GET',
      url: `/v0/pharmacy/patients/${patient}/prescriptions?status=NOT_A_REAL_STATUS`,
      headers: { host: 'heroshealth.com', authorization: `Bearer ${token}` },
    });

    expect(response.statusCode).toBe(400);
    const body = response.json<{ error: { code: string } }>();
    expect(body.error.code).toBe('internal.request.invalid');
    expectNoTenantLeak(response);
  });

  it('D3 ?limit=2 truncates a 3-row list to 2', async () => {
    const patient = await seedAccountInTenant(US_CTX, '+1');
    const product = await seedProduct(US_CTX);
    for (let i = 0; i < 3; i++) {
      await seedMedicationRequest({
        ctx: US_CTX,
        patientAccountId: patient,
        productCatalogId: product,
      });
    }

    const token = await mintToken(T_US, patient);
    const response = await app!.inject({
      method: 'GET',
      url: `/v0/pharmacy/patients/${patient}/prescriptions?limit=2`,
      headers: { host: 'heroshealth.com', authorization: `Bearer ${token}` },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json<{ prescriptions: unknown[] }>();
    expect(body.prescriptions).toHaveLength(2);
    expectNoTenantLeak(response);
  });

  it('D4 ?limit=99999 is accepted (repo clamps to 500; no 400)', async () => {
    const patient = await seedAccountInTenant(US_CTX, '+1');
    const token = await mintToken(T_US, patient);

    const response = await app!.inject({
      method: 'GET',
      url: `/v0/pharmacy/patients/${patient}/prescriptions?limit=99999`,
      headers: { host: 'heroshealth.com', authorization: `Bearer ${token}` },
    });

    expect(response.statusCode).toBe(200);
    expectNoTenantLeak(response);
  });

  it('D5 ?limit=abc → 400 internal.request.invalid', async () => {
    const patient = await seedAccountInTenant(US_CTX, '+1');
    const token = await mintToken(T_US, patient);

    const response = await app!.inject({
      method: 'GET',
      url: `/v0/pharmacy/patients/${patient}/prescriptions?limit=abc`,
      headers: { host: 'heroshealth.com', authorization: `Bearer ${token}` },
    });

    expect(response.statusCode).toBe(400);
    const body = response.json<{ error: { code: string } }>();
    expect(body.error.code).toBe('internal.request.invalid');
    expectNoTenantLeak(response);
  });

  it('D6 ?limit=0 → 400 internal.request.invalid', async () => {
    const patient = await seedAccountInTenant(US_CTX, '+1');
    const token = await mintToken(T_US, patient);

    const response = await app!.inject({
      method: 'GET',
      url: `/v0/pharmacy/patients/${patient}/prescriptions?limit=0`,
      headers: { host: 'heroshealth.com', authorization: `Bearer ${token}` },
    });

    expect(response.statusCode).toBe(400);
    const body = response.json<{ error: { code: string } }>();
    expect(body.error.code).toBe('internal.request.invalid');
    expectNoTenantLeak(response);
  });
});

// ===========================================================================
// Group E — Cross-patient (list endpoint)
// ===========================================================================

describe('pharmacy HTTP — Group E: list cross-patient blind 404', () => {
  it('E1 GET /v0/pharmacy/patients/<other-account>/prescriptions → 404', async () => {
    const patientA = await seedAccountInTenant(US_CTX, '+1');
    const patientB = await seedAccountInTenant(US_CTX, '+1');
    const tokenB = await mintToken(T_US, patientB);

    const response = await app!.inject({
      method: 'GET',
      url: `/v0/pharmacy/patients/${patientA}/prescriptions`,
      headers: { host: 'heroshealth.com', authorization: `Bearer ${tokenB}` },
    });

    expect(response.statusCode).toBe(404);
    const body = response.json<{ error: { code: string } }>();
    expect(body.error.code).toBe('internal.resource.not_found');
    expectNoTenantLeak(response);
  });
});

// ===========================================================================
// Group F — Auth failures
// ===========================================================================

describe('pharmacy HTTP — Group F: auth failures', () => {
  it('F1 GET /prescriptions/:id without Bearer JWT → 401', async () => {
    const response = await app!.inject({
      method: 'GET',
      url: `/v0/pharmacy/prescriptions/mrx_${ulid()}`,
      headers: { host: 'heroshealth.com' },
    });

    expect(response.statusCode).toBe(401);
    expectNoTenantLeak(response);
  });

  it('F1b GET /patients/:patientId/prescriptions without Bearer JWT → 401', async () => {
    const response = await app!.inject({
      method: 'GET',
      url: `/v0/pharmacy/patients/${ulid()}/prescriptions`,
      headers: { host: 'heroshealth.com' },
    });

    expect(response.statusCode).toBe(401);
    expectNoTenantLeak(response);
  });

  it('F1c valid JWT for a REVOKED session → 401 (Codex R1 HIGH closure)', async () => {
    // Seed account + session, mint JWT bound to it, then REVOKE the
    // session row before issuing the request. The JWT remains
    // cryptographically valid (signature + expiry + tenant match all
    // check), but the session-liveness lookup inside the handler
    // resolves null because revoked_at is now set. By I-025 the
    // three null causes (revoked / expired / nonexistent) collapse to
    // a single 401 envelope.
    const patient = await seedAccountInTenant(US_CTX, '+1');
    const sessionId = await seedSession(T_US, patient);
    const token = mintTokenForSession(T_US, patient, sessionId);
    await withTenantContext(T_US, async () => {
      const client = getTestClient();
      await client.query(
        `UPDATE sessions SET revoked_at = NOW(), revoked_reason = 'admin_revoked' WHERE session_id = $1`,
        [sessionId],
      );
    });

    const response = await app!.inject({
      method: 'GET',
      url: `/v0/pharmacy/prescriptions/mrx_${ulid()}`,
      headers: { host: 'heroshealth.com', authorization: `Bearer ${token}` },
    });

    expect(response.statusCode).toBe(401);
    expectNoTenantLeak(response);
  });

  it('F1d valid JWT for a NONEXISTENT session_id → 401 (Codex R1 HIGH closure)', async () => {
    // Mint a JWT that references a session_id with no corresponding
    // row in the sessions table — simulates a fabricated session_id or
    // a token outliving its session row's lifecycle. Liveness lookup
    // returns null; handler 401s.
    const patient = await seedAccountInTenant(US_CTX, '+1');
    const fakeSessionId = asSessionId(ulid()); // not seeded
    const token = mintTokenForSession(T_US, patient, fakeSessionId);

    const response = await app!.inject({
      method: 'GET',
      url: `/v0/pharmacy/prescriptions/mrx_${ulid()}`,
      headers: { host: 'heroshealth.com', authorization: `Bearer ${token}` },
    });

    expect(response.statusCode).toBe(401);
    expectNoTenantLeak(response);
  });
});
