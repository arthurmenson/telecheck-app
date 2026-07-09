/**
 * subscription-http.test.ts — live-PostgreSQL HTTP integration tests for the
 * Subscription slice §20 surface (CDM v1.2 §4.7/§4.8; State Machines v1.1
 * §15; OpenAPI v0.2 §20; migrations 075-077).
 *
 * Exercises the REAL composition end-to-end (crisis-response-http /
 * med-interaction-override-http harness): JWT verify → tenant context →
 * SET LOCAL ROLE slice role (withDbRole, inside the service) → direct
 * INSERT/UPDATE under RLS → same-tx §15 audit. The subscription service
 * derives actor identity from the handler-passed SubscriptionActor (no
 * SI-010 nonce), so no bind pool is wired here.
 *
 * Coverage:
 *   Group A — pause (§20.3)
 *     A1 patient pauses ACTIVE → 200 PAUSED + paused_at/pause_until set +
 *        'paused' event + a §15 audit row; view carries NO tenant_id
 *     A2 pause_until > 90 days → 400 invalid_pause_duration; row unchanged
 *     A3 pause a PAUSED subscription → 409 invalid_state (+ rejection audit)
 *   Group B — resume (§20.4) / cancel (§20.6)
 *     B1 patient resumes PAUSED → 200 ACTIVE, paused fields cleared
 *     B2 patient cancels ACTIVE → 200 CANCELLATION_PENDING + cancel_reason
 *   Group C — switch (§20.5)
 *     C1 patient switches ACTIVE → 202 SWITCHING + switching_initiated event
 *        carrying the requested new_product_id
 *   Group D — tenant isolation + actor gating (I-023/I-025)
 *     D1 a DIFFERENT patient (same tenant) GET → 404 tenant-blind (self-scope)
 *     D2 a Ghana patient GET the US subscription → 404 tenant-blind (cross-tenant)
 *     D3 clinician token on pause → 403 (actor not permitted)
 *     D4 patient pauses a subscription they do not own → 404 (self-scope: not-
 *        owned indistinguishable from absent)
 *   Group E — reads (§20.1/§20.2/§20.7)
 *     E1 owning patient GET → 200 view (no tenant_id; medication_request_id set)
 *     E2 tenant_admin staff list → 200 sees the subscription tenant-wide
 *     E3 patient list → 200 self-scoped
 *     E4 GET events → 200 ordered event log
 *   Group F — idempotency (IDEMPOTENCY v5.1)
 *     F1 pause replay: same Idempotency-Key + same body → 200 replay, exactly
 *        one 'paused' event (no duplicate side effect)
 *
 * Spec references: CDM v1.2 §4.7/§4.8; State Machines v1.1 §15; OpenAPI v0.2
 * §20; I-003/I-023/I-025/I-027; IDEMPOTENCY v5.1; migrations 075-077.
 */

import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../../src/app.ts';
import { asTenantId } from '../../src/lib/glossary.ts';
import { ulid } from '../../src/lib/ulid.ts';
import { createAccount } from '../../src/modules/identity/internal/repositories/account-repo.ts';
import { asAccountId, type AccountId } from '../../src/modules/identity/internal/types.ts';
import {
  createSubscriptionDraft,
  executeSubscriptionTransition,
  type SubscriptionActor,
  type TransitionContext,
} from '../../src/modules/subscription/internal/service.ts';
import { grantSliceRolesToTestApp } from '../helpers/grant-slice-roles.ts';
import { bearerAuthHeader } from '../helpers/jwt-fixtures.ts';
import { TENANT_GHANA, TENANT_US, withTenantContext } from '../helpers/tenant-fixtures.ts';
import { uniquePhone } from '../helpers/unique-phone.ts';
import { getTestClient } from '../setup.ts';

const T_US = asTenantId(TENANT_US);
const T_GH = asTenantId(TENANT_GHANA);

/** The 4 subscription slice roles the handlers/service elevate into. */
const SUBSCRIPTION_SLICE_ROLES = [
  'subscription_patient_manager',
  'subscription_clinician_reviewer',
  'subscription_system_scheduler',
  'subscription_staff_reader',
] as const;

let app: FastifyInstance | null = null;

let usPatient: AccountId;
let usPatientB: AccountId;
let usClinician: AccountId;
let usAdmin: AccountId;
let ghPatient: AccountId;
let usProductId: string;
let usMedicationRequestId: string;

function usAuth(
  accountId: string,
  role: 'patient' | 'clinician' | 'tenant_admin',
): { authorization: string } {
  return bearerAuthHeader({ accountId, tenantId: T_US, countryOfCare: 'US', role });
}

function ghAuth(accountId: string): { authorization: string } {
  return bearerAuthHeader({ accountId, tenantId: T_GH, countryOfCare: 'GH', role: 'patient' });
}

async function seedAccount(
  accountType: 'patient' | 'clinician' | 'tenant_admin',
  tenantId: typeof T_US,
): Promise<AccountId> {
  const accountId = asAccountId(ulid());
  await withTenantContext(tenantId, () =>
    createAccount(
      {
        account_id: accountId,
        tenant_id: tenantId,
        phone_e164: uniquePhone(tenantId === TENANT_GHANA ? '+233' : '+1'),
        first_name: 'Sub',
        last_name: 'Slice',
        date_of_birth: '1990-01-01',
        gender: 'prefer_not_to_say',
        country_of_residence: tenantId === TENANT_GHANA ? 'GH' : 'US',
        country_of_care: tenantId === TENANT_GHANA ? 'GH' : 'US',
        account_type: accountType,
      },
      async () => {},
    ),
  );
  return accountId;
}

/** Seed a product_catalog row (subscription-eligible FK target). */
async function seedProduct(): Promise<string> {
  const id = ulid();
  await withTenantContext(T_US, async () => {
    await getTestClient().query(
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
        T_US,
        'Subscription Test Medication',
        'testmedicine',
        `rx-${id.slice(0, 8)}`,
        JSON.stringify([`ndc-${id.slice(0, 8)}`]),
        'tablet',
        '10mg',
        30,
        'primary_treatment',
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

/** Seed an active medication_request (composite-FK target for the sub). */
async function seedMedicationRequest(productCatalogId: string): Promise<string> {
  const id = `mrx_${ulid()}`;
  const now = new Date().toISOString();
  await withTenantContext(T_US, async () => {
    await getTestClient().query(
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
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
          $15, $16, $17, $18, $19, $20
       )`,
      [
        id,
        T_US,
        usPatient,
        productCatalogId,
        'Subscription Test Medication',
        '10mg',
        'tablet',
        '1 tablet daily',
        30,
        'tablet',
        0,
        'active',
        now,
        now,
        null,
        null,
        usClinician,
        'clean',
        now,
        'US',
      ],
    );
  });
  return id;
}

/**
 * Seed an ACTIVE subscription row + its `created` event directly (the
 * pharmacy/med-interaction seed-via-SQL precedent — the DRAFT→ACTIVE path is
 * the Payments-module create + clinician_approval, out of this slice's HTTP
 * surface). Owned by `usPatient` unless a patient override is given.
 */
async function seedActiveSubscription(patientId: string = usPatient): Promise<string> {
  const subId = `sub_${ulid()}`;
  await withTenantContext(T_US, async () => {
    await getTestClient().query(
      `INSERT INTO subscriptions (
          id, tenant_id, patient_id, product_id, prescription_id, cadence,
          unit_price, currency, status, started_at, preauth_window_months,
          preauth_renewals_remaining, payment_method_id, next_renewal_at
       ) VALUES (
          $1, $2, $3, $4, $5, 'monthly', 199.00, 'USD', 'ACTIVE', NOW(),
          12, 6, 'pm_mock_local_dev_1', NOW() + INTERVAL '1 month'
       )`,
      [subId, T_US, patientId, usProductId, usMedicationRequestId],
    );
    await getTestClient().query(
      `INSERT INTO subscription_events (
          id, tenant_id, subscription_id, event_type, event_data, actor_type, actor_id
       ) VALUES ($1, $2, $3, 'created', '{}'::jsonb, 'system', NULL)`,
      [`sue_${ulid()}`, T_US, subId],
    );
  });
  return subId;
}

interface InjectArgs {
  method: 'GET' | 'POST';
  url: string;
  auth: { authorization: string };
  host?: string;
  payload?: unknown;
  idempotencyKey?: string;
}

async function inject(args: InjectArgs): Promise<{ statusCode: number; body: string }> {
  return app!.inject({
    method: args.method,
    url: args.url,
    headers: {
      host: args.host ?? 'localhost',
      ...args.auth,
      'content-type': 'application/json',
      ...(args.method === 'POST' ? { 'idempotency-key': args.idempotencyKey ?? ulid() } : {}),
    },
    ...(args.payload !== undefined ? { payload: args.payload as object } : {}),
  });
}

function json<T>(res: { body: string }): T {
  return JSON.parse(res.body) as T;
}

async function queryStatus(subId: string): Promise<string | null> {
  return withTenantContext(T_US, async () => {
    const r = await getTestClient().query(
      `SELECT status FROM subscriptions WHERE tenant_id = $1 AND id = $2`,
      [T_US, subId],
    );
    return (r.rows[0] as { status: string } | undefined)?.status ?? null;
  });
}

async function queryEventTypes(subId: string): Promise<string[]> {
  return withTenantContext(T_US, async () => {
    const r = await getTestClient().query(
      `SELECT event_type FROM subscription_events
        WHERE tenant_id = $1 AND subscription_id = $2
        ORDER BY occurred_at ASC, id ASC`,
      [T_US, subId],
    );
    return (r.rows as Array<{ event_type: string }>).map((row) => row.event_type);
  });
}

async function queryAuditActions(subId: string): Promise<string[]> {
  return withTenantContext(T_US, async () => {
    const r = await getTestClient().query(
      `SELECT action FROM audit_records
        WHERE tenant_id = $1 AND resource_id = $2
        ORDER BY sequence_number ASC`,
      [T_US, subId],
    );
    return (r.rows as Array<{ action: string }>).map((row) => row.action);
  });
}

function futureIso(days: number): string {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
}

beforeAll(async () => {
  process.env['NODE_ENV'] = 'test';

  // Provide the app's login principal (telecheck_test_app) membership in the
  // 4 subscription slice roles so the handlers' SET LOCAL ROLE succeeds.
  await grantSliceRolesToTestApp(SUBSCRIPTION_SLICE_ROLES);

  app = await buildApp({ logger: false });
  await app.ready();

  usPatient = await seedAccount('patient', T_US);
  usPatientB = await seedAccount('patient', T_US);
  usClinician = await seedAccount('clinician', T_US);
  usAdmin = await seedAccount('tenant_admin', T_US);
  ghPatient = await seedAccount('patient', T_GH);

  usProductId = await seedProduct();
  usMedicationRequestId = await seedMedicationRequest(usProductId);
}, 60_000);

afterAll(async () => {
  if (app !== null) {
    await app.close();
  }
});

// ===========================================================================
// tests/setup.ts wraps EVERY test in a savepoint rolled back at test end —
// each test seeds its own subscription and is fully self-contained.
// ===========================================================================

describe('subscription §20.3 — pause', () => {
  it('A1. patient pauses ACTIVE → 200 PAUSED + fields set + event + audit; view is tenant-blind', async () => {
    const subId = await seedActiveSubscription();
    const res = await inject({
      method: 'POST',
      url: `/v0/subscriptions/${subId}/pause`,
      auth: usAuth(usPatient, 'patient'),
      payload: { reason: 'travel', pause_until: futureIso(30), notes: 'abroad' },
    });
    expect(res.statusCode).toBe(200);
    const view = json<Record<string, unknown>>(res);
    expect(view['status']).toBe('PAUSED');
    expect(view['paused_at']).not.toBeNull();
    expect(view['pause_until']).not.toBeNull();
    expect(view['medication_request_id']).toBe(usMedicationRequestId);
    // I-025: the wire view never carries tenant_id (or the payment handle).
    expect(view['tenant_id']).toBeUndefined();
    expect(view['payment_method_id']).toBeUndefined();

    expect(await queryStatus(subId)).toBe('PAUSED');
    expect(await queryEventTypes(subId)).toContain('paused');
    expect(await queryAuditActions(subId)).toContain('subscription_paused');
  });

  it('A2. pause_until > 90 days → 400 invalid_pause_duration; row stays ACTIVE', async () => {
    const subId = await seedActiveSubscription();
    const res = await inject({
      method: 'POST',
      url: `/v0/subscriptions/${subId}/pause`,
      auth: usAuth(usPatient, 'patient'),
      payload: { reason: 'break', pause_until: futureIso(120) },
    });
    expect(res.statusCode).toBe(400);
    expect(json<{ error: { code: string } }>(res).error.code).toBe(
      'internal.subscription.invalid_pause_duration',
    );
    expect(await queryStatus(subId)).toBe('ACTIVE');
  });

  it('A3. pause an already-PAUSED subscription → 409 invalid_state', async () => {
    const subId = await seedActiveSubscription();
    const first = await inject({
      method: 'POST',
      url: `/v0/subscriptions/${subId}/pause`,
      auth: usAuth(usPatient, 'patient'),
      payload: { reason: 'travel', pause_until: futureIso(15) },
    });
    expect(first.statusCode).toBe(200);
    const second = await inject({
      method: 'POST',
      url: `/v0/subscriptions/${subId}/pause`,
      auth: usAuth(usPatient, 'patient'),
      payload: { reason: 'travel', pause_until: futureIso(20) },
    });
    expect(second.statusCode).toBe(409);
    expect(json<{ error: { code: string } }>(second).error.code).toBe(
      'internal.subscription.invalid_state_transition',
    );
  });
});

describe('subscription §20.4/§20.6 — resume / cancel', () => {
  it('B1. patient resumes a PAUSED subscription → 200 ACTIVE, paused fields cleared', async () => {
    const subId = await seedActiveSubscription();
    await inject({
      method: 'POST',
      url: `/v0/subscriptions/${subId}/pause`,
      auth: usAuth(usPatient, 'patient'),
      payload: { reason: 'travel', pause_until: futureIso(30) },
    });
    const res = await inject({
      method: 'POST',
      url: `/v0/subscriptions/${subId}/resume`,
      auth: usAuth(usPatient, 'patient'),
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    const view = json<Record<string, unknown>>(res);
    expect(view['status']).toBe('ACTIVE');
    expect(view['paused_at']).toBeNull();
    expect(view['pause_until']).toBeNull();
    expect(view['next_renewal_at']).not.toBeNull();
  });

  it('B2. patient cancels ACTIVE → 200 CANCELLATION_PENDING + cancel_reason (deflection non-blocking)', async () => {
    const subId = await seedActiveSubscription();
    const res = await inject({
      method: 'POST',
      url: `/v0/subscriptions/${subId}/cancel`,
      auth: usAuth(usPatient, 'patient'),
      payload: {
        reason: 'side_effects',
        feedback: 'nausea',
        deflection_attempted: true,
        deflection_outcome: 'patient_continued_to_cancel',
      },
    });
    expect(res.statusCode).toBe(200);
    const view = json<Record<string, unknown>>(res);
    expect(view['status']).toBe('CANCELLATION_PENDING');
    expect(view['cancel_reason']).toBe('side_effects');
    expect(await queryEventTypes(subId)).toContain('cancellation_pending');
  });
});

describe('subscription §20.5 — switch', () => {
  it('C1. patient switches ACTIVE → 202 SWITCHING + switching_initiated event carries new_product_id', async () => {
    const subId = await seedActiveSubscription();
    const res = await inject({
      method: 'POST',
      url: `/v0/subscriptions/${subId}/switch`,
      auth: usAuth(usPatient, 'patient'),
      payload: { new_product_id: `prd_${ulid()}`, reason: 'side_effects' },
    });
    expect(res.statusCode).toBe(202);
    expect(json<Record<string, unknown>>(res)['status']).toBe('SWITCHING');
    expect(await queryStatus(subId)).toBe('SWITCHING');
    expect(await queryEventTypes(subId)).toContain('switching_initiated');
  });
});

describe('subscription — tenant isolation + actor gating (I-023/I-025)', () => {
  it('D1. a different patient (same tenant) GET → 404 tenant-blind (self-scope)', async () => {
    const subId = await seedActiveSubscription();
    const res = await inject({
      method: 'GET',
      url: `/v0/subscriptions/${subId}`,
      auth: usAuth(usPatientB, 'patient'),
    });
    expect(res.statusCode).toBe(404);
    expect(json<{ error: { code: string } }>(res).error.code).toBe('internal.resource.not_found');
  });

  it('D2. a Ghana patient GET the US subscription → 404 tenant-blind (cross-tenant)', async () => {
    const subId = await seedActiveSubscription();
    const res = await inject({
      method: 'GET',
      url: `/v0/subscriptions/${subId}`,
      auth: ghAuth(ghPatient),
      host: 'ghana.heroshealth.com',
    });
    expect(res.statusCode).toBe(404);
  });

  it('D3. clinician token on pause → 403 (actor not permitted; no ratified clinician write endpoint)', async () => {
    const subId = await seedActiveSubscription();
    const res = await inject({
      method: 'POST',
      url: `/v0/subscriptions/${subId}/pause`,
      auth: usAuth(usClinician, 'clinician'),
      payload: { reason: 'travel', pause_until: futureIso(30) },
    });
    expect(res.statusCode).toBe(403);
    expect(await queryStatus(subId)).toBe('ACTIVE');
  });

  it('D4. patient pauses a subscription they do not own → 404 (self-scope; not-owned == absent)', async () => {
    const subId = await seedActiveSubscription(usPatient);
    const res = await inject({
      method: 'POST',
      url: `/v0/subscriptions/${subId}/pause`,
      auth: usAuth(usPatientB, 'patient'),
      payload: { reason: 'travel', pause_until: futureIso(30) },
    });
    expect(res.statusCode).toBe(404);
    expect(await queryStatus(subId)).toBe('ACTIVE');
  });
});

describe('subscription §20.1/§20.2/§20.7 — reads', () => {
  it('E1. owning patient GET → 200 view (no tenant_id; canonical medication_request_id)', async () => {
    const subId = await seedActiveSubscription();
    const res = await inject({
      method: 'GET',
      url: `/v0/subscriptions/${subId}`,
      auth: usAuth(usPatient, 'patient'),
    });
    expect(res.statusCode).toBe(200);
    const view = json<Record<string, unknown>>(res);
    expect(view['id']).toBe(subId);
    expect(view['tenant_id']).toBeUndefined();
    expect(view['medication_request_id']).toBe(usMedicationRequestId);
  });

  it('E2. tenant_admin staff list → 200 sees the subscription tenant-wide', async () => {
    const subId = await seedActiveSubscription();
    const res = await inject({
      method: 'GET',
      url: `/v0/subscriptions?patient_id=${usPatient}`,
      auth: usAuth(usAdmin, 'tenant_admin'),
    });
    expect(res.statusCode).toBe(200);
    const body = json<{ subscriptions: Array<{ id: string }> }>(res);
    expect(body.subscriptions.some((s) => s.id === subId)).toBe(true);
  });

  it('E3. patient list → 200 self-scoped (own subscription present)', async () => {
    const subId = await seedActiveSubscription();
    const res = await inject({
      method: 'GET',
      url: '/v0/subscriptions',
      auth: usAuth(usPatient, 'patient'),
    });
    expect(res.statusCode).toBe(200);
    const body = json<{ subscriptions: Array<{ id: string }> }>(res);
    expect(body.subscriptions.some((s) => s.id === subId)).toBe(true);
  });

  it('E4. GET events → 200 ordered event log (created present)', async () => {
    const subId = await seedActiveSubscription();
    const res = await inject({
      method: 'GET',
      url: `/v0/subscriptions/${subId}/events`,
      auth: usAuth(usPatient, 'patient'),
    });
    expect(res.statusCode).toBe(200);
    const body = json<{ events: Array<{ event_type: string }> }>(res);
    expect(body.events.map((e) => e.event_type)).toContain('created');
  });
});

describe('subscription — idempotency (IDEMPOTENCY v5.1)', () => {
  it('F1. pause replay: same Idempotency-Key + body → 200 replay, exactly one paused event', async () => {
    const subId = await seedActiveSubscription();
    const key = ulid();
    const body = { reason: 'travel', pause_until: futureIso(30) };
    const first = await inject({
      method: 'POST',
      url: `/v0/subscriptions/${subId}/pause`,
      auth: usAuth(usPatient, 'patient'),
      payload: body,
      idempotencyKey: key,
    });
    expect(first.statusCode).toBe(200);
    const second = await inject({
      method: 'POST',
      url: `/v0/subscriptions/${subId}/pause`,
      auth: usAuth(usPatient, 'patient'),
      payload: body,
      idempotencyKey: key,
    });
    expect(second.statusCode).toBe(200);
    // Replay must not double-fire the side effect.
    const paused = (await queryEventTypes(subId)).filter((t) => t === 'paused');
    expect(paused).toHaveLength(1);
  });
});

describe('subscription — createSubscriptionDraft service (DRAFT create + clinician_approval)', () => {
  const ctx = (): TransitionContext => ({
    tenantId: T_US,
    countryOfCare: 'US',
    actorTenantIdForAudit: T_US,
  });

  it('G1. createSubscriptionDraft inserts a DRAFT row + created event + Cat C subscription_created audit', async () => {
    const productId = await seedProduct();
    const mrxId = await seedMedicationRequest(productId);
    const patientActor: SubscriptionActor = { type: 'patient', id: usPatient };

    const created = await withTenantContext(T_US, async () =>
      createSubscriptionDraft(getTestClient(), {
        ctx: ctx(),
        actor: patientActor,
        patientId: usPatient,
        productId,
        medicationRequestId: mrxId,
        cadence: 'monthly',
        unitPrice: '199.00',
        currency: 'USD',
        preauthWindowMonths: 12,
        preauthRenewalsRemaining: 11,
        paymentMethodId: `pm_${ulid()}`,
      }),
    );

    expect(created.outcome).toBe('created');
    if (created.outcome !== 'created') return; // narrow for TS
    const subId = created.row.id;
    expect(subId).toMatch(/^sub_[0-7][0-9A-HJKMNPQRSTVWXYZ]{25}$/);
    expect(created.row.status).toBe('DRAFT');
    expect(created.row.prescription_id).toBe(mrxId);
    expect(created.row.version).toBe(1);

    expect(await queryStatus(subId)).toBe('DRAFT');
    expect(await queryEventTypes(subId)).toContain('created');
    // Cat C creation audit is emitted same-tx (I-003/I-027).
    expect(await queryAuditActions(subId)).toContain('subscription_created');
  });

  it('G2. clinician_approval advances DRAFT → ACTIVE + activated event + audit; non-owner-actor gates hold', async () => {
    const productId = await seedProduct();
    const mrxId = await seedMedicationRequest(productId);
    const patientActor: SubscriptionActor = { type: 'patient', id: usPatient };
    const clinicianActor: SubscriptionActor = { type: 'clinician', id: usClinician };

    const subId = await withTenantContext(T_US, async () => {
      const created = await createSubscriptionDraft(getTestClient(), {
        ctx: ctx(),
        actor: patientActor,
        patientId: usPatient,
        productId,
        medicationRequestId: mrxId,
        cadence: 'monthly',
        unitPrice: '199.00',
        currency: 'USD',
        preauthWindowMonths: 12,
        preauthRenewalsRemaining: 11,
        paymentMethodId: `pm_${ulid()}`,
      });
      if (created.outcome !== 'created') throw new Error('create failed');

      // A patient actor cannot drive clinician_approval (actor gate).
      const patientAttempt = await executeSubscriptionTransition(getTestClient(), {
        ctx: ctx(),
        actor: patientActor,
        subscriptionId: created.row.id,
        transition: 'clinician_approval',
      });
      expect(patientAttempt.outcome).toBe('guard_failed');

      const approved = await executeSubscriptionTransition(getTestClient(), {
        ctx: ctx(),
        actor: clinicianActor,
        subscriptionId: created.row.id,
        transition: 'clinician_approval',
      });
      expect(approved.outcome).toBe('transitioned');
      return created.row.id;
    });

    expect(await queryStatus(subId)).toBe('ACTIVE');
    expect(await queryEventTypes(subId)).toContain('activated');
    expect(await queryAuditActions(subId)).toContain('subscription_activated');
  });
});
