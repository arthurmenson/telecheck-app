/**
 * pharmacy-clinician-write-http.test.ts — HTTP integration tests for the
 * clinician-origin write surface per Sprint 35-36 / TLC-055 PR E.
 *
 * Endpoints under test:
 *   POST /v0/pharmacy/prescriptions          — clinician createDraft
 *   POST /v0/pharmacy/prescriptions/:id/submit — clinician submit_for_review
 *
 * Both are clinician-only (requireClinicianActorContext via the shared
 * requireClinicianLiveSession helper) and NOT I-012-gated. The
 * activation routes (clinician_approve / protocol_authorized_prescribing)
 * and remaining clinician transitions (decline / discontinue / supersede /
 * modify) land in subsequent pharmacy PRs.
 *
 * Coverage (6 groups, 18 cases):
 *
 *   Group A — Happy path: createDraft
 *     A1 clinician → 201 + draft view (status=draft, interaction=pending)
 *     A2 audit chain records medication_request.drafted with actor_type=clinician
 *
 *   Group B — Auth + role gates
 *     B1 patient JWT → 403 internal.auth.insufficient_scope
 *     B2 no JWT → 401
 *
 *   Group C — Body validation
 *     C1 missing patient_account_id → 400 internal.request.invalid
 *     C2 quantity=0 → 400 (must be positive integer)
 *     C3 protocol_id without protocol_version → 400
 *
 *   Group D — Cross-tenant FK protection
 *     D1 patient_account_id from a different tenant → 400 (FK violation)
 *     D2 nonexistent product_catalog_id → 400
 *
 *   Group E — submit_for_review state-machine transition
 *     E1 happy path: draft → pending_interaction_check + audit
 *        medication_request.submitted_for_review
 *     E2 submit on already-submitted row → 409 state conflict
 *     E3 submit on nonexistent id → 404 tenant-blind
 *     E4 submit on malformed id → 404 (side-channel closure per I-025)
 *
 *   Group F — Cross-row invariants (Codex PR-119 R1 HIGH/MEDIUM closures)
 *     F1 country_of_care supplied in body → 400 (must be server-derived)
 *     F2 patient_account_id resolves to a clinician account → 400
 *     F3 prescribing_consult_id belongs to a different patient → 400
 *     F4 non-existent and existing-clinician patient_account_id produce
 *        byte-identical 400 envelopes (R2 oracle closure)
 *     F5 invalid product_catalog_id with nonexistent vs existing-patient
 *        patient_account_id produce byte-identical 400 envelopes (R3
 *        FK-error oracle closure)
 *     F6 overlength product_catalog_id with nonexistent vs existing-patient
 *        patient_account_id produce byte-identical 400 envelopes (R4
 *        truncation-error oracle closure)
 *
 * Spec references:
 *   - State Machines v1.2 §19 (submit_for_review: draft → pending_interaction_check)
 *   - CDM v1.3 §4.16 MedicationRequest
 *   - AUDIT_EVENTS v5.3 (medication_request.drafted, .submitted_for_review)
 *   - I-023 / I-025 / I-027 (tenant isolation + tenant-blind 404)
 *   - migrations/027_accounts_account_type_clinician.sql (clinician role)
 *   - src/modules/pharmacy/internal/handlers/prescriptions.ts
 *   - src/modules/pharmacy/internal/services/medication-request-service.ts
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

async function seedProduct(ctx: TenantContext): Promise<string> {
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
  return id;
}

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

/**
 * Minimal valid request body for createDraft.
 *
 * NOTE: `country_of_care` is intentionally absent — Codex PR-119 R1
 * HIGH closure 2026-05-13. The field is derived server-side from
 * tenant context; passing it in the body returns 400.
 */
function makeDraftBody(overrides: {
  patientId: string;
  productId: string;
  quantity?: number;
  protocolId?: string | null;
  protocolVersion?: string | null;
  prescribingConsultId?: string | null;
}): Record<string, unknown> {
  return {
    patient_account_id: overrides.patientId,
    product_catalog_id: overrides.productId,
    medication_name: 'Test Medication',
    strength: '10mg',
    formulation: 'tablet',
    dose_instructions: '1 tablet daily',
    quantity: overrides.quantity ?? 30,
    quantity_unit: 'tablet',
    refills_allowed: 0,
    indication: null,
    clinical_notes: null,
    prescribing_consult_id: overrides.prescribingConsultId ?? null,
    protocol_id: overrides.protocolId ?? null,
    protocol_version: overrides.protocolVersion ?? null,
  };
}

function expectNoTenantLeak(response: { body: string }): void {
  expect(response.body).not.toContain('"tenant_id"');
  expect(response.body).not.toContain('Telecheck-US');
  expect(response.body).not.toContain('Telecheck-Ghana');
}

// ===========================================================================
// Group A — Happy path: createDraft
// ===========================================================================

describe('pharmacy clinician write — Group A: createDraft happy path', () => {
  it('A1 clinician → 201 + draft view (status=draft, interaction=pending)', async () => {
    const clinician = await insertAccountOfType(US_CTX, 'clinician', '+1');
    const patient = await insertAccountOfType(US_CTX, 'patient', '+1');
    const product = await seedProduct(US_CTX);
    const token = await mintTokenForRole(T_US, clinician, 'clinician');

    const r = await app!.inject({
      method: 'POST',
      url: '/v0/pharmacy/prescriptions',
      headers: {
        host: 'heroshealth.com',
        authorization: `Bearer ${token}`,
        'idempotency-key': ulid(),
      },
      payload: makeDraftBody({ patientId: patient, productId: product }),
    });

    expect(r.statusCode).toBe(201);
    const body = r.json<{
      id: string;
      status: string;
      patient_account_id: string;
      interaction_signals_status: string;
      ai_workload_type: string | null;
      tenant_id?: undefined;
    }>();
    expect(body.id).toMatch(/^mrx_[0-7][0-9A-HJKMNPQRSTVWXYZ]{25}$/);
    expect(body.status).toBe('draft');
    expect(body.patient_account_id).toBe(patient);
    expect(body.interaction_signals_status).toBe('pending');
    // Clinician-only path → AI envelope fields stay null per the
    // I-012 envelope CHECK clause (a). Activation lands later.
    expect(body.ai_workload_type).toBeNull();
    expect(body).not.toHaveProperty('tenant_id');
    expectNoTenantLeak(r);
  });

  it('A2 audit chain records medication_request.drafted with actor_type=clinician', async () => {
    const clinician = await insertAccountOfType(US_CTX, 'clinician', '+1');
    const patient = await insertAccountOfType(US_CTX, 'patient', '+1');
    const product = await seedProduct(US_CTX);
    const token = await mintTokenForRole(T_US, clinician, 'clinician');

    const r = await app!.inject({
      method: 'POST',
      url: '/v0/pharmacy/prescriptions',
      headers: {
        host: 'heroshealth.com',
        authorization: `Bearer ${token}`,
        'idempotency-key': ulid(),
      },
      payload: makeDraftBody({ patientId: patient, productId: product }),
    });
    expect(r.statusCode).toBe(201);
    const body = r.json<{ id: string }>();

    // Verify the audit row landed with the right discriminators. The
    // canonical action_id for medication_request lifecycle is the
    // row's id (state-machine §9 convention).
    const auditRows = await withTenantContext(T_US, async () => {
      const client = getTestClient();
      const result = await client.query<{
        action: string;
        actor_type: string;
        actor_id: string;
        resource_id: string;
        category: string;
      }>(
        `SELECT action, actor_type, actor_id, resource_id, category
           FROM audit_records
          WHERE tenant_id = $1 AND resource_id = $2
          ORDER BY emitted_at`,
        [T_US, body.id],
      );
      return result.rows;
    });
    expect(auditRows.length).toBeGreaterThanOrEqual(1);
    const draftAudit = auditRows.find((row) => row.action === 'medication_request.drafted');
    expect(draftAudit).toBeDefined();
    expect(draftAudit!.actor_type).toBe('clinician');
    expect(draftAudit!.actor_id).toBe(clinician);
    expect(draftAudit!.resource_id).toBe(body.id);
    expect(draftAudit!.category).toBe('A');
  });
});

// ===========================================================================
// Group B — Auth + role gates
// ===========================================================================

describe('pharmacy clinician write — Group B: auth/role', () => {
  it('B1 patient JWT → 403 internal.auth.insufficient_scope', async () => {
    const patient = await insertAccountOfType(US_CTX, 'patient', '+1');
    const product = await seedProduct(US_CTX);
    const token = await mintTokenForRole(T_US, patient, 'patient');

    const r = await app!.inject({
      method: 'POST',
      url: '/v0/pharmacy/prescriptions',
      headers: {
        host: 'heroshealth.com',
        authorization: `Bearer ${token}`,
        'idempotency-key': ulid(),
      },
      payload: makeDraftBody({ patientId: patient, productId: product }),
    });

    expect(r.statusCode).toBe(403);
    const body = r.json<{ error: { code: string } }>();
    expect(body.error.code).toBe('internal.auth.insufficient_scope');
    expectNoTenantLeak(r);
  });

  it('B2 no Bearer JWT → 401', async () => {
    const patient = await insertAccountOfType(US_CTX, 'patient', '+1');
    const product = await seedProduct(US_CTX);

    const r = await app!.inject({
      method: 'POST',
      url: '/v0/pharmacy/prescriptions',
      headers: { host: 'heroshealth.com', 'idempotency-key': ulid() },
      payload: makeDraftBody({ patientId: patient, productId: product }),
    });

    expect(r.statusCode).toBe(401);
    expectNoTenantLeak(r);
  });
});

// ===========================================================================
// Group C — Body validation
// ===========================================================================

describe('pharmacy clinician write — Group C: body validation', () => {
  it('C1 missing patient_account_id → 400 internal.request.invalid', async () => {
    const clinician = await insertAccountOfType(US_CTX, 'clinician', '+1');
    const product = await seedProduct(US_CTX);
    const token = await mintTokenForRole(T_US, clinician, 'clinician');

    const body = makeDraftBody({ patientId: 'placeholder', productId: product });
    delete (body as { patient_account_id?: unknown }).patient_account_id;

    const r = await app!.inject({
      method: 'POST',
      url: '/v0/pharmacy/prescriptions',
      headers: {
        host: 'heroshealth.com',
        authorization: `Bearer ${token}`,
        'idempotency-key': ulid(),
      },
      payload: body,
    });

    expect(r.statusCode).toBe(400);
    const respBody = r.json<{ error: { code: string } }>();
    expect(respBody.error.code).toBe('internal.request.invalid');
    expectNoTenantLeak(r);
  });

  it('C2 quantity=0 → 400 (must be positive integer)', async () => {
    const clinician = await insertAccountOfType(US_CTX, 'clinician', '+1');
    const patient = await insertAccountOfType(US_CTX, 'patient', '+1');
    const product = await seedProduct(US_CTX);
    const token = await mintTokenForRole(T_US, clinician, 'clinician');

    const r = await app!.inject({
      method: 'POST',
      url: '/v0/pharmacy/prescriptions',
      headers: {
        host: 'heroshealth.com',
        authorization: `Bearer ${token}`,
        'idempotency-key': ulid(),
      },
      payload: makeDraftBody({ patientId: patient, productId: product, quantity: 0 }),
    });

    expect(r.statusCode).toBe(400);
    const body = r.json<{ error: { code: string } }>();
    expect(body.error.code).toBe('internal.request.invalid');
    expectNoTenantLeak(r);
  });

  it('C3 protocol_id without protocol_version → 400', async () => {
    const clinician = await insertAccountOfType(US_CTX, 'clinician', '+1');
    const patient = await insertAccountOfType(US_CTX, 'patient', '+1');
    const product = await seedProduct(US_CTX);
    const token = await mintTokenForRole(T_US, clinician, 'clinician');

    const r = await app!.inject({
      method: 'POST',
      url: '/v0/pharmacy/prescriptions',
      headers: {
        host: 'heroshealth.com',
        authorization: `Bearer ${token}`,
        'idempotency-key': ulid(),
      },
      payload: makeDraftBody({
        patientId: patient,
        productId: product,
        protocolId: 'protocol_v1',
        protocolVersion: null,
      }),
    });

    expect(r.statusCode).toBe(400);
    const body = r.json<{ error: { code: string } }>();
    expect(body.error.code).toBe('internal.request.invalid');
    expectNoTenantLeak(r);
  });
});

// ===========================================================================
// Group D — Cross-tenant FK protection
// ===========================================================================

describe('pharmacy clinician write — Group D: cross-tenant FK', () => {
  it('D1 patient_account_id from a different tenant → 400 (FK)', async () => {
    const clinician = await insertAccountOfType(US_CTX, 'clinician', '+1');
    const ghPatient = await insertAccountOfType(GH_CTX, 'patient', '+233');
    const product = await seedProduct(US_CTX);
    const token = await mintTokenForRole(T_US, clinician, 'clinician');

    const r = await app!.inject({
      method: 'POST',
      url: '/v0/pharmacy/prescriptions',
      headers: {
        host: 'heroshealth.com',
        authorization: `Bearer ${token}`,
        'idempotency-key': ulid(),
      },
      // Cross-tenant patient — composite FK rejects.
      payload: makeDraftBody({ patientId: ghPatient, productId: product }),
    });

    expect(r.statusCode).toBe(400);
    expectNoTenantLeak(r);
  });

  it('D2 nonexistent product_catalog_id → 400', async () => {
    const clinician = await insertAccountOfType(US_CTX, 'clinician', '+1');
    const patient = await insertAccountOfType(US_CTX, 'patient', '+1');
    const token = await mintTokenForRole(T_US, clinician, 'clinician');

    const r = await app!.inject({
      method: 'POST',
      url: '/v0/pharmacy/prescriptions',
      headers: {
        host: 'heroshealth.com',
        authorization: `Bearer ${token}`,
        'idempotency-key': ulid(),
      },
      payload: makeDraftBody({ patientId: patient, productId: ulid() /* not seeded */ }),
    });

    expect(r.statusCode).toBe(400);
    expectNoTenantLeak(r);
  });
});

// ===========================================================================
// Group E — submit_for_review state-machine transition
// ===========================================================================

describe('pharmacy clinician write — Group E: submit_for_review', () => {
  async function createDraftViaHttp(
    clinicianToken: string,
    patientId: AccountId,
    productId: string,
  ): Promise<string> {
    const r = await app!.inject({
      method: 'POST',
      url: '/v0/pharmacy/prescriptions',
      headers: {
        host: 'heroshealth.com',
        authorization: `Bearer ${clinicianToken}`,
        'idempotency-key': ulid(),
      },
      payload: makeDraftBody({ patientId, productId }),
    });
    expect(r.statusCode).toBe(201);
    return r.json<{ id: string }>().id;
  }

  it('E1 happy path: draft → pending_interaction_check + audit emitted', async () => {
    const clinician = await insertAccountOfType(US_CTX, 'clinician', '+1');
    const patient = await insertAccountOfType(US_CTX, 'patient', '+1');
    const product = await seedProduct(US_CTX);
    const token = await mintTokenForRole(T_US, clinician, 'clinician');

    const mrId = await createDraftViaHttp(token, patient, product);

    const r = await app!.inject({
      method: 'POST',
      url: `/v0/pharmacy/prescriptions/${mrId}/submit`,
      headers: {
        host: 'heroshealth.com',
        authorization: `Bearer ${token}`,
        'idempotency-key': ulid(),
      },
      payload: {},
    });

    expect(r.statusCode).toBe(200);
    const body = r.json<{ status: string }>();
    expect(body.status).toBe('pending_interaction_check');
    expectNoTenantLeak(r);

    // Audit emitted with the submitted_for_review action.
    const auditRows = await withTenantContext(T_US, async () => {
      const client = getTestClient();
      const result = await client.query<{ action: string; actor_id: string }>(
        `SELECT action, actor_id FROM audit_records
          WHERE tenant_id = $1 AND resource_id = $2`,
        [T_US, mrId],
      );
      return result.rows;
    });
    const submitAudit = auditRows.find(
      (row) => row.action === 'medication_request.submitted_for_review',
    );
    expect(submitAudit).toBeDefined();
    expect(submitAudit!.actor_id).toBe(clinician);
  });

  it('E2 submit on already-submitted row → 409 state conflict', async () => {
    const clinician = await insertAccountOfType(US_CTX, 'clinician', '+1');
    const patient = await insertAccountOfType(US_CTX, 'patient', '+1');
    const product = await seedProduct(US_CTX);
    const token = await mintTokenForRole(T_US, clinician, 'clinician');

    const mrId = await createDraftViaHttp(token, patient, product);

    // First submit succeeds.
    const r1 = await app!.inject({
      method: 'POST',
      url: `/v0/pharmacy/prescriptions/${mrId}/submit`,
      headers: {
        host: 'heroshealth.com',
        authorization: `Bearer ${token}`,
        'idempotency-key': ulid(),
      },
      payload: {},
    });
    expect(r1.statusCode).toBe(200);

    // Second submit with a NEW idempotency-key — service runs again
    // and detects the row is no longer 'draft' → 409.
    const r2 = await app!.inject({
      method: 'POST',
      url: `/v0/pharmacy/prescriptions/${mrId}/submit`,
      headers: {
        host: 'heroshealth.com',
        authorization: `Bearer ${token}`,
        'idempotency-key': ulid(),
      },
      payload: {},
    });
    expect(r2.statusCode).toBe(409);
    const body = r2.json<{ error: { code: string } }>();
    expect(body.error.code).toBe('internal.resource.conflict');
    expectNoTenantLeak(r2);
  });

  it('E3 submit on nonexistent id → 404 tenant-blind', async () => {
    const clinician = await insertAccountOfType(US_CTX, 'clinician', '+1');
    const token = await mintTokenForRole(T_US, clinician, 'clinician');
    const nonexistent = `mrx_${ulid()}`;

    const r = await app!.inject({
      method: 'POST',
      url: `/v0/pharmacy/prescriptions/${nonexistent}/submit`,
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

  it('E4 submit on malformed id → 404 (side-channel closure per I-025)', async () => {
    const clinician = await insertAccountOfType(US_CTX, 'clinician', '+1');
    const token = await mintTokenForRole(T_US, clinician, 'clinician');

    const r = await app!.inject({
      method: 'POST',
      url: '/v0/pharmacy/prescriptions/not-a-real-id/submit',
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
});

// ===========================================================================
// Group F — Cross-row invariants (Codex PR-119 R1 HIGH/MEDIUM closures)
// ===========================================================================

describe('pharmacy clinician write — Group F: cross-row invariants', () => {
  it('F1 country_of_care in body → 400 (server-derived only)', async () => {
    const clinician = await insertAccountOfType(US_CTX, 'clinician', '+1');
    const patient = await insertAccountOfType(US_CTX, 'patient', '+1');
    const product = await seedProduct(US_CTX);
    const token = await mintTokenForRole(T_US, clinician, 'clinician');

    const bodyWithCountry = {
      ...makeDraftBody({ patientId: patient, productId: product }),
      // The attacker's payload — try to override CCR routing to Ghana
      // on a US tenant.
      country_of_care: 'GH',
    };

    const r = await app!.inject({
      method: 'POST',
      url: '/v0/pharmacy/prescriptions',
      headers: {
        host: 'heroshealth.com',
        authorization: `Bearer ${token}`,
        'idempotency-key': ulid(),
      },
      payload: bodyWithCountry,
    });

    expect(r.statusCode).toBe(400);
    const body = r.json<{ error: { code: string; message: string } }>();
    expect(body.error.code).toBe('internal.request.invalid');
    expect(body.error.message).toContain('country_of_care');
    expectNoTenantLeak(r);
  });

  it('F2 patient_account_id resolves to a clinician → 400', async () => {
    const clinician1 = await insertAccountOfType(US_CTX, 'clinician', '+1');
    // Second clinician — used as the "patient_account_id" in the attack.
    const clinician2 = await insertAccountOfType(US_CTX, 'clinician', '+1');
    const product = await seedProduct(US_CTX);
    const token = await mintTokenForRole(T_US, clinician1, 'clinician');

    const r = await app!.inject({
      method: 'POST',
      url: '/v0/pharmacy/prescriptions',
      headers: {
        host: 'heroshealth.com',
        authorization: `Bearer ${token}`,
        'idempotency-key': ulid(),
      },
      // Anchor the medication_request on a clinician account_id —
      // must be rejected. The composite FK alone would accept this
      // (FK targets accounts by composite (tenant_id, account_id),
      // type-agnostic). The service-layer account_type check catches it.
      payload: makeDraftBody({ patientId: clinician2, productId: product }),
    });

    expect(r.statusCode).toBe(400);
    const body = r.json<{ error: { code: string } }>();
    expect(body.error.code).toBe('internal.request.invalid');
    expectNoTenantLeak(r);
  });

  it('F3 prescribing_consult_id belongs to a different patient → 400', async () => {
    const clinician = await insertAccountOfType(US_CTX, 'clinician', '+1');
    const patientA = await insertAccountOfType(US_CTX, 'patient', '+1');
    const patientB = await insertAccountOfType(US_CTX, 'patient', '+1');
    const product = await seedProduct(US_CTX);
    const token = await mintTokenForRole(T_US, clinician, 'clinician');

    // Seed a consult owned by patient B.
    const consultIdB = ulid();
    await withTenantContext(T_US, async () => {
      const client = getTestClient();
      await client.query(
        `INSERT INTO consults (
            id, tenant_id, patient_id, state, consult_type, modality, created_at, updated_at
         ) VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW())`,
        [consultIdB, T_US, patientB, 'INITIATED', 'general', 'async'],
      );
    });

    // Clinician tries to anchor a draft on patient A but tie it to
    // patient B's consult — clinical-provenance corruption attempt.
    const r = await app!.inject({
      method: 'POST',
      url: '/v0/pharmacy/prescriptions',
      headers: {
        host: 'heroshealth.com',
        authorization: `Bearer ${token}`,
        'idempotency-key': ulid(),
      },
      payload: makeDraftBody({
        patientId: patientA,
        productId: product,
        prescribingConsultId: consultIdB,
      }),
    });

    expect(r.statusCode).toBe(400);
    const body = r.json<{ error: { code: string } }>();
    expect(body.error.code).toBe('internal.request.invalid');
    // The public message is intentionally generic (Codex PR-119 R2
    // closure) so we don't assert on specific reason text here —
    // F4 verifies the envelope shape is identical across cases.
    expectNoTenantLeak(r);
  });

  it('F4 nonexistent vs existing-clinician patient_account_id → byte-identical 400 envelopes (Codex R2 oracle closure)', async () => {
    // The service distinguishes "no such account" vs "account exists
    // but isn't a patient" internally (for ops/telemetry) but MUST
    // NOT expose the difference publicly. Probing the difference
    // would let a same-tenant clinician enumerate accountIds + types.
    // This test mounts two attacks with the same shape and asserts
    // the public envelopes are identical (code, message,
    // status-code, no leakage).
    const clinician = await insertAccountOfType(US_CTX, 'clinician', '+1');
    const otherClinician = await insertAccountOfType(US_CTX, 'clinician', '+1');
    const product = await seedProduct(US_CTX);
    const token = await mintTokenForRole(T_US, clinician, 'clinician');

    // Attack A: nonexistent patient_account_id (ULID never seeded).
    const aResp = await app!.inject({
      method: 'POST',
      url: '/v0/pharmacy/prescriptions',
      headers: {
        host: 'heroshealth.com',
        authorization: `Bearer ${token}`,
        'idempotency-key': ulid(),
      },
      payload: makeDraftBody({ patientId: ulid(), productId: product }),
    });

    // Attack B: existing-clinician patient_account_id.
    const bResp = await app!.inject({
      method: 'POST',
      url: '/v0/pharmacy/prescriptions',
      headers: {
        host: 'heroshealth.com',
        authorization: `Bearer ${token}`,
        'idempotency-key': ulid(),
      },
      payload: makeDraftBody({ patientId: otherClinician, productId: product }),
    });

    expect(aResp.statusCode).toBe(400);
    expect(bResp.statusCode).toBe(400);
    const aBody = aResp.json<{ error: { code: string; message: string } }>();
    const bBody = bResp.json<{ error: { code: string; message: string } }>();
    expect(aBody.error.code).toBe('internal.request.invalid');
    expect(bBody.error.code).toBe(aBody.error.code);
    // Generic message must be byte-identical between the two oracle
    // attacks. Request-id differs (per-request) so compare just the
    // message string.
    expect(bBody.error.message).toBe(aBody.error.message);
    expectNoTenantLeak(aResp);
    expectNoTenantLeak(bResp);
  });

  it('F5 invalid product_catalog_id: nonexistent vs existing-patient patient_account_id → byte-identical 400 (R3 FK oracle closure)', async () => {
    // Codex PR-119 R3 closure 2026-05-13: the FK-error code path
    // (Postgres 23503 on a bad product_catalog_id) previously emitted
    // a DIFFERENT envelope from the service-layer validation path.
    // That gave an attacker a 2-payload oracle:
    //   - Fixed bad product + nonexistent patient → validation 400
    //     (collapsed message via MedicationRequestInputValidationError;
    //     service rejected before reaching repo INSERT).
    //   - Fixed bad product + existing-patient patient → FK 23503
    //     (validation passed; insert failed on product FK; PREVIOUS
    //     envelope had a different message → "patient exists" oracle).
    // R3 fix re-throws 23503 as MedicationRequestInputValidationError
    // so both responses are byte-identical.
    const clinician = await insertAccountOfType(US_CTX, 'clinician', '+1');
    const existingPatient = await insertAccountOfType(US_CTX, 'patient', '+1');
    const token = await mintTokenForRole(T_US, clinician, 'clinician');

    // Constant: an invalid (never-seeded) product_catalog_id.
    const badProductId = ulid();

    // Attack A: nonexistent patient + same bad product (service
    // validation fails BEFORE the FK check).
    const aResp = await app!.inject({
      method: 'POST',
      url: '/v0/pharmacy/prescriptions',
      headers: {
        host: 'heroshealth.com',
        authorization: `Bearer ${token}`,
        'idempotency-key': ulid(),
      },
      payload: makeDraftBody({ patientId: ulid(), productId: badProductId }),
    });

    // Attack B: existing-patient + same bad product (service passes,
    // FK fires on the product → previously different envelope).
    const bResp = await app!.inject({
      method: 'POST',
      url: '/v0/pharmacy/prescriptions',
      headers: {
        host: 'heroshealth.com',
        authorization: `Bearer ${token}`,
        'idempotency-key': ulid(),
      },
      payload: makeDraftBody({ patientId: existingPatient, productId: badProductId }),
    });

    expect(aResp.statusCode).toBe(400);
    expect(bResp.statusCode).toBe(400);
    const aBody = aResp.json<{ error: { code: string; message: string } }>();
    const bBody = bResp.json<{ error: { code: string; message: string } }>();
    expect(aBody.error.code).toBe('internal.request.invalid');
    expect(bBody.error.code).toBe(aBody.error.code);
    // Byte-identical messages — no oracle.
    expect(bBody.error.message).toBe(aBody.error.message);
    expectNoTenantLeak(aResp);
    expectNoTenantLeak(bResp);
  });

  it('F6 overlength product_catalog_id: nonexistent vs existing-patient patient_account_id → byte-identical 400 (R4 truncation oracle closure)', async () => {
    // Codex PR-119 R4 closure 2026-05-13: previously, an overlength
    // product_catalog_id bypassed the FK violation (23503) and
    // triggered Postgres 22001 string-data-right-truncation, which
    // produced a different envelope class than the R3-collapsed
    // generic envelope. That re-opened the patient_account_id
    // existence oracle even after R3.
    //
    // Fix: body parser now requires every ID field to match the
    // 26-char Crockford-base32 ULID shape. An overlength value
    // fails AT THE PARSER with the same 400 envelope regardless of
    // patient_account_id existence (parser fires before service /
    // repo / DB). Both branches return the byte-identical
    // body-validation message.
    const clinician = await insertAccountOfType(US_CTX, 'clinician', '+1');
    const existingPatient = await insertAccountOfType(US_CTX, 'patient', '+1');
    const token = await mintTokenForRole(T_US, clinician, 'clinician');

    // Constant: a clearly-overlength product_catalog_id (50 chars).
    // Fails the ULID-shape check at the body parser.
    const overlengthProductId = '0'.repeat(50);

    const aResp = await app!.inject({
      method: 'POST',
      url: '/v0/pharmacy/prescriptions',
      headers: {
        host: 'heroshealth.com',
        authorization: `Bearer ${token}`,
        'idempotency-key': ulid(),
      },
      payload: makeDraftBody({ patientId: ulid(), productId: overlengthProductId }),
    });

    const bResp = await app!.inject({
      method: 'POST',
      url: '/v0/pharmacy/prescriptions',
      headers: {
        host: 'heroshealth.com',
        authorization: `Bearer ${token}`,
        'idempotency-key': ulid(),
      },
      payload: makeDraftBody({ patientId: existingPatient, productId: overlengthProductId }),
    });

    expect(aResp.statusCode).toBe(400);
    expect(bResp.statusCode).toBe(400);
    const aBody = aResp.json<{ error: { code: string; message: string } }>();
    const bBody = bResp.json<{ error: { code: string; message: string } }>();
    expect(aBody.error.code).toBe('internal.request.invalid');
    expect(bBody.error.code).toBe(aBody.error.code);
    expect(bBody.error.message).toBe(aBody.error.message);
    expectNoTenantLeak(aResp);
    expectNoTenantLeak(bResp);
  });
});
