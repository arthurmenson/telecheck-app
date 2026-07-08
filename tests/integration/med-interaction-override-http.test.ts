/**
 * med-interaction-override-http.test.ts — live-PostgreSQL HTTP integration
 * tests for the migration 070 evidence-unlock of the override wrapper
 * (SI-019 §6.NEW7) + the fail-closed 503 posture of resolve/expire.
 *
 * Exercises the REAL composition end-to-end (mirrors the
 * async-consult-v1-http.test.ts harness): JWT verify → SI-010 bind (real
 * bind pool authenticated as bind_actor_context_role) → tenant context →
 * SET LOCAL ROLE slice role → SECDEF wrappers (migrations 049/050/070) →
 * RLS → same-tx Cat A audit emission.
 *
 * Coverage:
 *
 *   Group A — Override happy path over live infrastructure
 *     A1 evaluation → signal (medications_involved = live products) →
 *        activate → override (clinician token + pre-encrypted envelope)
 *        → 201; interaction_signal_override row persisted with envelope
 *        bytes; latest lifecycle transition = overridden; TWO Cat A audit
 *        rows (interaction_signal_override + lifecycle attestation).
 *
 *   Group B — Evidence-check rejections (migration 070 §1)
 *     B1 medications_involved product with NO live medication_request row
 *        → 409 medication_not_on_active_list (STEP 3; 55000)
 *     B2 signal not yet active (no activate step) → 404 tenant-blind
 *     B3 patient-role token → 403 (LAYER B route gate)
 *     B4 missing envelope → 400 (migration 047 §3 NOT NULL envelope)
 *
 *   Group C — Cross-tenant isolation (I-023 / I-025)
 *     C1 Ghana clinician probing a US signal id → 404 tenant-blind
 *
 *   Group D — Fail-closed wrappers stay fail-closed (savepoint-recovered
 *   rejection attestation COMMITs per I-003)
 *     D1 resolve → 503 resolution_capability_not_yet_available + committed
 *        rejection attestation (42501 execute-not-granted convergence)
 *     D2 expire (structurally-valid attempt: time_window_basis present +
 *        emission row) → 503 expiry_capability_not_yet_available +
 *        committed rejection attestation (0A000)
 *
 * Spec references: SI-019 v2.0 P-033 Sub-decision 8; CDM v1.6 → v1.7
 * §6.NEW7 P-034; migrations 046-050 + 070; I-002, I-003, I-023, I-025,
 * I-027, I-035.
 */

import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../../src/app.ts';
import { config } from '../../src/lib/config.ts';
import {
  clearBindActorContextTestPool,
  setBindActorContextTestPool,
  type DbClient,
} from '../../src/lib/db.ts';
import { asTenantId } from '../../src/lib/glossary.ts';
import { issueAccessToken, type AccessTokenRole } from '../../src/lib/jwt.ts';
import { ulid } from '../../src/lib/ulid.ts';
import { SLICE_ROLES } from '../../src/lib/with-db-role.ts';
import { createAccount } from '../../src/modules/identity/internal/repositories/account-repo.ts';
import { asAccountId, type AccountId } from '../../src/modules/identity/internal/types.ts';
import { TENANT_GHANA, TENANT_US, withTenantContext } from '../helpers/tenant-fixtures.ts';
import { uniquePhone } from '../helpers/unique-phone.ts';
import { getTestClient } from '../setup.ts';

const T_US = asTenantId(TENANT_US);
const T_GH = asTenantId(TENANT_GHANA);
const BIND_ROLE_TEST_PASSWORD = 'telecheck_test_bind_pw';

let app: FastifyInstance | null = null;
let bindPool: pg.Pool | null = null;

let patient: { accountId: AccountId; token: string };
let clinician: { accountId: AccountId; token: string };
let ghClinician: { accountId: AccountId; token: string };

function mintToken(accountId: string, role: AccessTokenRole, tenantId: typeof T_US): string {
  return issueAccessToken(
    {
      account_id: accountId,
      tenant_id: tenantId,
      session_id: ulid(),
      role,
      country_of_care: tenantId === TENANT_GHANA ? 'GH' : 'US',
      delegate_id: null,
      admin_tenant_binding: null,
    },
    config.jwtSigningKey,
  );
}

async function seedAccount(
  accountType: 'patient' | 'clinician',
  tenantId: typeof T_US,
): Promise<AccountId> {
  const accountId = asAccountId(ulid());
  await withTenantContext(tenantId, () =>
    createAccount(
      {
        account_id: accountId,
        tenant_id: tenantId,
        phone_e164: uniquePhone(tenantId === TENANT_GHANA ? '+233' : '+1'),
        first_name: 'MedInt',
        last_name: 'Override',
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

/** Seed a product_catalog row (FK target for medication_requests). */
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
        'Override Test Medication',
        'testmedicine',
        'rx-test-1',
        JSON.stringify(['ndc-test-1']),
        'tablet',
        '10mg',
        30,
        'primary_treatment',
        'primary_treatment',
        JSON.stringify(['truepill']),
        'truepill',
        false,
        null,
        JSON.stringify({ monthly: 99.0 }),
        true,
        'active',
      ],
    );
  });
  return id;
}

/**
 * Seed a medication_request at the requested status (bypassing the state
 * machine — pharmacy integration-test precedent) so the migration 070 §1
 * STEP 3 active-list predicate has live/removed rows to read.
 */
async function seedMedicationRequest(options: {
  patientAccountId: AccountId;
  productCatalogId: string;
  status: 'active' | 'pending_clinician_review' | 'discontinued';
}): Promise<string> {
  const id = `mrx_${ulid()}`;
  const now = new Date().toISOString();
  const isActiveOrPost = options.status === 'active' || options.status === 'discontinued';
  await withTenantContext(T_US, async () => {
    await getTestClient().query(
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
        T_US,
        options.patientAccountId,
        options.productCatalogId,
        'Override Test Medication',
        '10mg',
        'tablet',
        '1 tablet daily',
        30,
        'tablet',
        0,
        options.status,
        isActiveOrPost ? now : null,
        options.status === 'active' ? now : null,
        options.status === 'discontinued' ? now : null,
        options.status === 'discontinued' ? 'clinical_decision' : null,
        isActiveOrPost ? clinician.accountId : null,
        isActiveOrPost ? 'clean' : 'pending',
        isActiveOrPost ? now : null,
        'US',
      ],
    );
  });
  return id;
}

/** Complete pre-encrypted 8-field wire envelope (I-026 wire shape). */
function makeEnvelope(label: string): Record<string, unknown> {
  return {
    ciphertext_b64: Buffer.from(`sealed:${label}`).toString('base64'),
    dek_id: ulid(),
    iv_b64: Buffer.from('0123456789ab').toString('base64'),
    tag_b64: Buffer.from('0123456789abcdef').toString('base64'),
    alg: 'AES-256-GCM',
    alg_version: '1',
    aad_b64: Buffer.from('tenant:synthetic').toString('base64'),
    encrypted_at: new Date().toISOString(),
  };
}

interface InjectArgs {
  method: 'GET' | 'POST';
  url: string;
  token: string;
  host?: string;
  payload?: unknown;
}

async function inject(args: InjectArgs): Promise<{ statusCode: number; body: string }> {
  return app!.inject({
    method: args.method,
    url: args.url,
    headers: {
      host: args.host ?? 'localhost',
      authorization: `Bearer ${args.token}`,
      'content-type': 'application/json',
      ...(args.method === 'POST' ? { 'idempotency-key': ulid() } : {}),
    },
    ...(args.payload !== undefined ? { payload: args.payload as object } : {}),
  });
}

function json<T>(res: { body: string }): T {
  return JSON.parse(res.body) as T;
}

/** evaluation → signal → (optional) activate; returns the signal id. */
async function seedSignalChain(options: {
  medicationsInvolved: string[];
  activate: boolean;
  signalPayload?: Record<string, unknown>;
}): Promise<string> {
  const evalRes = await inject({
    method: 'POST',
    url: '/v0/med-interaction/evaluations',
    token: clinician.token,
    payload: {
      triggered_by: 'prescribing',
      triggered_by_resource_id: ulid(),
      patient_id: patient.accountId,
      engine_version: '1.0.0',
      knowledge_base_version: '2026.07',
      medication_set_snapshot: { medications: options.medicationsInvolved },
      condition_set_snapshot: {},
      lab_set_snapshot: {},
    },
  });
  expect(evalRes.statusCode).toBe(201);
  const evaluationId = json<{ evaluation_id: string }>(evalRes).evaluation_id;

  const signalRes = await inject({
    method: 'POST',
    url: '/v0/med-interaction/signals',
    token: clinician.token,
    payload: {
      evaluation_id: evaluationId,
      patient_id: patient.accountId,
      check_class: 'drug_drug',
      severity: 'major',
      recommended_action: 'warn',
      medications_involved: options.medicationsInvolved,
      evidence_sources: { kb: 'test-kb-2026.07' },
      signal_payload: options.signalPayload ?? { summary: 'test interaction' },
    },
  });
  expect(signalRes.statusCode).toBe(201);
  const signalId = json<{ signal_id: string }>(signalRes).signal_id;

  if (options.activate) {
    const actRes = await inject({
      method: 'POST',
      url: `/v0/med-interaction/signals/${signalId}/activate`,
      token: clinician.token,
      payload: {},
    });
    expect(actRes.statusCode).toBe(200);
  }
  return signalId;
}

async function queryAuditActions(resourceIdOrSignalId: string): Promise<string[]> {
  const rows = await withTenantContext(T_US, async () => {
    const r = await getTestClient().query(
      `SELECT action FROM audit_records
        WHERE tenant_id = $1
          AND (resource_id = $2 OR payload->>'signal_id' = $2)
        ORDER BY sequence_number ASC`,
      [T_US, resourceIdOrSignalId],
    );
    return r.rows as Array<{ action: string }>;
  });
  return rows.map((r) => r.action);
}

beforeAll(async () => {
  process.env['NODE_ENV'] = 'test';

  // SI-010 bind-pool provisioning + slice-role membership mirroring
  // (async-consult-v1-http.test.ts precedent; see tests/helpers/
  // grant-slice-roles.ts for why every suite grants its own roles).
  const superuser = new pg.Client({
    connectionString: process.env['TEST_DATABASE_URL'] as string,
  });
  await superuser.connect();
  try {
    await superuser.query(
      `ALTER ROLE bind_actor_context_role WITH LOGIN PASSWORD '${BIND_ROLE_TEST_PASSWORD}'`,
    );
    for (const sliceRole of SLICE_ROLES) {
      await superuser.query(`GRANT ${sliceRole} TO telecheck_test_app`);
    }
  } finally {
    await superuser.end();
  }

  const testUrl = new URL(process.env['TEST_DATABASE_URL'] as string);
  testUrl.username = 'bind_actor_context_role';
  testUrl.password = BIND_ROLE_TEST_PASSWORD;
  bindPool = new pg.Pool({ connectionString: testUrl.toString(), max: 2 });
  setBindActorContextTestPool(bindPool as unknown as DbClient);

  app = await buildApp({ logger: false });
  await app.ready();

  const patientId = await seedAccount('patient', T_US);
  const clinicianId = await seedAccount('clinician', T_US);
  const ghClinicianId = await seedAccount('clinician', T_GH);
  patient = { accountId: patientId, token: mintToken(patientId, 'patient', T_US) };
  clinician = { accountId: clinicianId, token: mintToken(clinicianId, 'clinician', T_US) };
  ghClinician = {
    accountId: ghClinicianId,
    token: mintToken(ghClinicianId, 'clinician', T_GH),
  };
}, 60_000);

afterAll(async () => {
  clearBindActorContextTestPool();
  if (app !== null) {
    await app.close();
  }
  if (bindPool !== null) {
    await bindPool.end();
  }
});

// ===========================================================================
// Tests. tests/setup.ts wraps EVERY test in a savepoint rolled back at test
// end — each test below is fully self-contained (async-consult precedent).
// ===========================================================================

describe('med-interaction override — migration 070 evidence-unlock (live SI-010 + SECDEF + RLS)', () => {
  it('A1. evaluation → signal → activate → override: 201 + override row with envelope bytes + overridden transition + two Cat A audits', async () => {
    const productA = await seedProduct();
    const productB = await seedProduct();
    await seedMedicationRequest({
      patientAccountId: patient.accountId,
      productCatalogId: productA,
      status: 'active',
    });
    await seedMedicationRequest({
      patientAccountId: patient.accountId,
      productCatalogId: productB,
      status: 'pending_clinician_review',
    });
    const signalId = await seedSignalChain({
      medicationsInvolved: [productA, productB],
      activate: true,
    });

    const res = await inject({
      method: 'POST',
      url: `/v0/med-interaction/signals/${signalId}/override`,
      token: clinician.token,
      payload: {
        override_rationale_envelope: makeEnvelope('override-rationale'),
        metadata: { reason: 'benefit outweighs interaction risk' },
      },
    });
    expect(res.statusCode).toBe(201);
    const view = json<{ signal_id: string; override_id: string; status: string }>(res);
    expect(view.signal_id).toBe(signalId);
    expect(view.status).toBe('overridden');

    // Evidence row persisted with the envelope bytes (migration 047 §3
    // NOT NULL columns) + clinician attribution from the SI-010 actor.
    const overrideRow = await withTenantContext(T_US, async () => {
      const r = await getTestClient().query(
        `SELECT id, override_by_clinician_account_id,
                override_rationale_kms_envelope_ciphertext,
                override_rationale_kms_envelope_alg
           FROM interaction_signal_override
          WHERE tenant_id = $1 AND signal_id = $2`,
        [T_US, signalId],
      );
      return r.rows[0] as
        | {
            id: string;
            override_by_clinician_account_id: string;
            override_rationale_kms_envelope_ciphertext: Buffer;
            override_rationale_kms_envelope_alg: string;
          }
        | undefined;
    });
    expect(overrideRow).toBeDefined();
    expect(overrideRow!.id).toBe(view.override_id);
    expect(overrideRow!.override_by_clinician_account_id).toBe(clinician.accountId);
    expect(Buffer.from(overrideRow!.override_rationale_kms_envelope_ciphertext).toString()).toBe(
      'sealed:override-rationale',
    );
    expect(overrideRow!.override_rationale_kms_envelope_alg).toBe('AES-256-GCM');

    // Latest lifecycle transition = overridden / override, carrying the
    // override_id in metadata (raw-writer correlation contract).
    const latest = await withTenantContext(T_US, async () => {
      const r = await getTestClient().query(
        `SELECT to_state, transition_reason, metadata
           FROM interaction_signal_lifecycle_transition
          WHERE tenant_id = $1 AND signal_id = $2
          ORDER BY transition_at DESC, id DESC LIMIT 1`,
        [T_US, signalId],
      );
      return r.rows[0] as {
        to_state: string;
        transition_reason: string;
        metadata: { override_id?: string };
      };
    });
    expect(latest.to_state).toBe('overridden');
    expect(latest.transition_reason).toBe('override');
    expect(latest.metadata.override_id).toBe(view.override_id);

    // Two-event Cat A rule: canonical override attestation + lifecycle
    // attestation, in that order (I-027; audit.ts CANONICAL RULE).
    const actions = await queryAuditActions(signalId);
    const overrideIdx = actions.indexOf('interaction_signal_override');
    expect(overrideIdx).toBeGreaterThanOrEqual(0);
    const lifecycleActions = actions.filter(
      (a) => a === 'interaction_signal_lifecycle_transition_emitted',
    );
    expect(lifecycleActions.length).toBeGreaterThanOrEqual(1);
    expect(actions.lastIndexOf('interaction_signal_lifecycle_transition_emitted')).toBeGreaterThan(
      overrideIdx,
    );
  });

  it('B1. involved product with NO live medication_request row → 409 medication_not_on_active_list (STEP 3 evidence)', async () => {
    const liveProduct = await seedProduct();
    const removedProduct = await seedProduct();
    await seedMedicationRequest({
      patientAccountId: patient.accountId,
      productCatalogId: liveProduct,
      status: 'active',
    });
    // removedProduct: only a DISCONTINUED row → off the list per the
    // migration 070 §1 live-status predicate.
    await seedMedicationRequest({
      patientAccountId: patient.accountId,
      productCatalogId: removedProduct,
      status: 'discontinued',
    });
    const signalId = await seedSignalChain({
      medicationsInvolved: [liveProduct, removedProduct],
      activate: true,
    });

    const res = await inject({
      method: 'POST',
      url: `/v0/med-interaction/signals/${signalId}/override`,
      token: clinician.token,
      payload: { override_rationale_envelope: makeEnvelope('stale-evidence') },
    });
    expect(res.statusCode).toBe(409);
    const body = json<{ error: { code: string; message: string } }>(res);
    expect(body.error.code).toBe('med_interaction.medication_not_on_active_list');
    // Tenant-blind: no tenant ids, no raw wrapper detail counts leak.
    expect(body.error.message).not.toContain('Telecheck-');

    // No override row, no overridden transition (fail-closed atomicity).
    const overrideCount = await withTenantContext(T_US, async () => {
      const r = await getTestClient().query(
        `SELECT COUNT(*)::int AS n FROM interaction_signal_override
          WHERE tenant_id = $1 AND signal_id = $2`,
        [T_US, signalId],
      );
      return (r.rows[0] as { n: number }).n;
    });
    expect(overrideCount).toBe(0);
  });

  it('B2. signal not yet active (no activate step) → 404 tenant-blind', async () => {
    const product = await seedProduct();
    await seedMedicationRequest({
      patientAccountId: patient.accountId,
      productCatalogId: product,
      status: 'active',
    });
    const signalId = await seedSignalChain({ medicationsInvolved: [product], activate: false });
    const res = await inject({
      method: 'POST',
      url: `/v0/med-interaction/signals/${signalId}/override`,
      token: clinician.token,
      payload: { override_rationale_envelope: makeEnvelope('not-active') },
    });
    expect(res.statusCode).toBe(404);
    expect(json<{ error: { code: string } }>(res).error.code).toBe(
      'med_interaction.signal_not_found_or_wrong_state',
    );
  });

  it('B3. patient-role token → 403 at the LAYER B route gate (no DB work)', async () => {
    const res = await inject({
      method: 'POST',
      url: `/v0/med-interaction/signals/${ulid()}/override`,
      token: patient.token,
      payload: { override_rationale_envelope: makeEnvelope('wrong-role') },
    });
    expect(res.statusCode).toBe(403);
  });

  it('B4. missing/partial envelope → 400 (migration 047 §3 NOT NULL envelope)', async () => {
    const res = await inject({
      method: 'POST',
      url: `/v0/med-interaction/signals/${ulid()}/override`,
      token: clinician.token,
      payload: { override_rationale_envelope: { dek_id: ulid() } },
    });
    expect(res.statusCode).toBe(400);
  });

  it('C1. Ghana clinician probing a US signal id → 404 tenant-blind (I-023 / I-025)', async () => {
    const product = await seedProduct();
    await seedMedicationRequest({
      patientAccountId: patient.accountId,
      productCatalogId: product,
      status: 'active',
    });
    const usSignalId = await seedSignalChain({ medicationsInvolved: [product], activate: true });

    const res = await inject({
      method: 'POST',
      url: `/v0/med-interaction/signals/${usSignalId}/override`,
      token: ghClinician.token,
      host: 'ghana.heroshealth.com',
      payload: { override_rationale_envelope: makeEnvelope('cross-tenant-probe') },
    });
    // The Ghana-scoped state read finds no transitions for this signal →
    // 23514 signal_not_active('<none>') → tenant-blind 404, indistinguishable
    // from a nonexistent signal.
    expect(res.statusCode).toBe(404);
    expect(json<{ error: { code: string } }>(res).error.code).toBe(
      'med_interaction.signal_not_found_or_wrong_state',
    );

    // And the US signal is untouched.
    const usLatest = await withTenantContext(T_US, async () => {
      const r = await getTestClient().query(
        `SELECT to_state FROM interaction_signal_lifecycle_transition
          WHERE tenant_id = $1 AND signal_id = $2
          ORDER BY transition_at DESC, id DESC LIMIT 1`,
        [T_US, usSignalId],
      );
      return (r.rows[0] as { to_state: string }).to_state;
    });
    expect(usLatest).toBe('active');
  });

  it('D1. resolve stays FAIL-CLOSED: 503 + COMMITTED rejection attestation (savepoint recovery)', async () => {
    const product = await seedProduct();
    await seedMedicationRequest({
      patientAccountId: patient.accountId,
      productCatalogId: product,
      status: 'active',
    });
    const signalId = await seedSignalChain({ medicationsInvolved: [product], activate: true });

    const res = await inject({
      method: 'POST',
      url: `/v0/med-interaction/signals/${signalId}/resolve`,
      token: clinician.token,
      payload: { discontinuation_event_id: ulid() },
    });
    expect(res.statusCode).toBe(503);
    expect(json<{ error: { code: string } }>(res).error.code).toBe(
      'med_interaction.resolution_capability_not_yet_available',
    );

    // The rejected attempt is attested in the audit chain (I-003) — the
    // savepoint recovery lets the attestation COMMIT even though the
    // wrapper call aborted.
    const rejection = await withTenantContext(T_US, async () => {
      const r = await getTestClient().query(
        `SELECT payload FROM audit_records
          WHERE tenant_id = $1
            AND action = 'interaction_signal_lifecycle_transition_emitted'
            AND payload->>'signal_id' = $2
            AND payload->>'to_state' = 'rejected'`,
        [T_US, signalId],
      );
      return r.rows[0] as { payload: { transition_reason: string } } | undefined;
    });
    expect(rejection).toBeDefined();
    expect(rejection!.payload.transition_reason).toMatch(/resolve_rejected/);
  });

  it('D2. expire stays FAIL-CLOSED on a structurally-valid attempt: 503 + COMMITTED rejection attestation', async () => {
    const product = await seedProduct();
    await seedMedicationRequest({
      patientAccountId: patient.accountId,
      productCatalogId: product,
      status: 'active',
    });
    // time_window_basis present so the wrapper's structural preflights
    // pass and the attempt reaches the 0A000 (per-basis cadence config
    // still absent per the migration 070 narrowed deferral).
    const signalId = await seedSignalChain({
      medicationsInvolved: [product],
      activate: true,
      signalPayload: { time_window_basis: 'monitoring_interval' },
    });

    const res = await inject({
      method: 'POST',
      url: `/v0/med-interaction/signals/${signalId}/expire`,
      token: clinician.token,
      payload: {},
    });
    expect(res.statusCode).toBe(503);
    expect(json<{ error: { code: string } }>(res).error.code).toBe(
      'med_interaction.expiry_capability_not_yet_available',
    );

    const rejection = await withTenantContext(T_US, async () => {
      const r = await getTestClient().query(
        `SELECT payload FROM audit_records
          WHERE tenant_id = $1
            AND action = 'interaction_signal_lifecycle_transition_emitted'
            AND payload->>'signal_id' = $2
            AND payload->>'to_state' = 'rejected'`,
        [T_US, signalId],
      );
      return r.rows[0] as { payload: { transition_reason: string } } | undefined;
    });
    expect(rejection).toBeDefined();
    expect(rejection!.payload.transition_reason).toContain('expire_rejected');
  });
});
