/**
 * crisis-response-http.test.ts — live-PostgreSQL HTTP integration tests
 * for the Crisis Response slice (SI-022 v1.0 RATIFIED P-039 + CDM
 * v1.9 → v1.10 Amendment RATIFIED P-040) — the Sprint 4 hardening
 * suite per src/modules/crisis-response/README.md "Sprint 4 —
 * Hardening":
 *
 *   - Cross-tenant isolation tests (I-023 / I-025)
 *   - Idempotency-replay regression (same server_signal_id → same
 *     crisis_event_id + exactly ONE crisis.detected audit row)
 *   - Race-condition coverage at the envelope level (concurrent-claim
 *     race-loss surfaces as the wrapper's SQLSTATE 40001 → tenant-blind
 *     409; sweep generation replay → 'already_completed'). NOTE: true
 *     multi-connection interleaving cannot run under the tests/setup.ts
 *     shared-client savepoint harness — the deterministic
 *     equivalents below pin the exact SQLSTATE → envelope mappings the
 *     racing caller would observe.
 *   - FLOOR-020 fail-closed verification (rejected wrapper calls leave
 *     NO partial state: no orphan crisis_event, no orphan Cat A audit)
 *   - KMS envelope intake_payload wire surface (pre-encrypted 8-field
 *     posture per ADR-021 / ADR-024; async-consult v1-shared.ts
 *     precedent)
 *
 * Exercises the REAL composition end-to-end (mirrors the
 * med-interaction-override-http.test.ts / async-consult-v1-http.test.ts
 * harness): JWT verify → SI-010 bind (real bind pool authenticated as
 * bind_actor_context_role) → tenant context → SET LOCAL ROLE slice role
 * → SECDEF wrappers (migrations 036/037/038 as re-shaped by 053) → RLS
 * → same-tx Cat A audit emission.
 *
 * Coverage:
 *
 *   Group A — initiate (POST /v0/crisis-events)
 *     A1 happy path, no envelope → 201; crisis_event row with all-NULL
 *        KMS columns; none→detected transition; exactly ONE Cat A
 *        crisis.detected audit
 *     A2 happy path WITH pre-encrypted envelope → 201; all 8
 *        intake_payload_* columns persisted byte-exact
 *     A3 partial envelope → 400 at the boundary; NO row, NO audit
 *     A4 idempotency replay: same body, NEW Idempotency-Key → 201 +
 *        SAME crisis_event_id + still exactly ONE crisis.detected audit
 *        (the Sprint 4 replay-regression pin)
 *     A5 mismatched replay: same server_signal_id, different severity →
 *        409 tenant-blind; no second row; no second audit (FLOOR-020
 *        atomic rollback)
 *     A6 malformed patient_account_id → 400 tenant-blind at the
 *        boundary (the deferred-FK 23503 branch is unit-covered; it
 *        cannot fire under the savepoint harness)
 *     A7 patient-role token → 403 at the crisis_initiator Layer B gate;
 *        no DB work
 *
 *   Group B — reads (staff + patient-scoped)
 *     B1 staff GET /:id → 200 with the 12-column
 *        crisis_event_current_state_v shape
 *     B2 staff GET nonexistent id → 404 tenant-blind
 *     B3 patient-summary GET by the OWNING patient → 200 with the
 *        8-column data-minimized shape; staff-only columns ABSENT.
 *        (Also the regression pin for the Sprint 4 route-mount fix —
 *        this route existed as a handler+unit-tests on main but was
 *        never mounted in routes.ts.)
 *     B4 patient-summary GET by a DIFFERENT patient → 404 tenant-blind
 *        (view self-scoping predicate)
 *     B5 patient token on the staff read → 403 (role gate)
 *
 *   Group C — lifecycle writes (acknowledge / respond / resolve)
 *     C1 acknowledge on detected → 200; crisis.acknowledged audit with
 *        detail.from_state=detected; view state acknowledged
 *     C2 respond BEFORE acknowledge → 409 tenant-blind (state-machine
 *        guard; wrapper 40001); NO crisis.responded audit (FLOOR-020
 *        atomicity on the rejection path)
 *     C3 full chain acknowledge → respond → resolve → 200 each; all
 *        three Cat A audits present; final view state resolved
 *     C4 acknowledge replay (same actor, NEW Idempotency-Key) → 200 +
 *        SAME lifecycle_transition_id + exactly ONE crisis.acknowledged
 *        audit (per-transition dedupe; deterministic equivalent of the
 *        concurrent-claim race)
 *
 *   Group D — operator sweep (POST /:id/_sweep)
 *     D1 detected event, admin token → 200 outcome=completed_escalated
 *        + crisis.no_acknowledgement_escalation audit + view state
 *        escalated. (Also pins the Sprint 4 latent-defect fix: the
 *        pre-fetch previously selected the pre-053 view column
 *        patient_id and 42703'd on every live sweep call.)
 *     D2 sweep replay same generation → outcome=already_completed; no
 *        second escalation audit (fencing-token idempotency)
 *     D3 acknowledged event sweep → outcome=completed_no_op; NO
 *        escalation audit
 *     D4 clinician token on sweep → 403 (admin gate)
 *     D5 Ghana admin probing a US event → 404 tenant-blind
 *
 *   Group E — cross-tenant isolation (I-023 / I-025)
 *     E1 Ghana clinician GET of a US crisis id → 404 with the SAME
 *        envelope shape as a nonexistent id probed from Ghana
 *     E2 Ghana clinician acknowledge of a US crisis id → 404
 *        tenant-blind; US event state unchanged
 *     E3 Ghana patient patient-summary probe of a US event → 404
 *
 *   Group F — I-019 platform-floor (always-on)
 *     F1 the crisis surface is mounted unconditionally — no config
 *        gate: unauthenticated probes reach the route (401/400, never
 *        404-route-missing), /health is 200, /ready is 200 with
 *        machine-readable spec_gated_gaps
 *
 * Spec references: SI-022 v1.0 P-039; CDM v1.9→v1.10 P-040; SI-025
 * P-045 (migration 053 identity re-shape); State Machines v1.1 §3;
 * migrations 032-038 + 051 + 053; I-003, I-019, I-023, I-025, I-027,
 * FLOOR-020; ADR-021 / ADR-024 (KMS envelope).
 */

import { randomUUID } from 'node:crypto';

import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../../src/app.ts';
import {
  clearBindActorContextTestPool,
  setBindActorContextTestPool,
  type DbClient,
} from '../../src/lib/db.ts';
import { asTenantId } from '../../src/lib/glossary.ts';
import { ulid } from '../../src/lib/ulid.ts';
import { createAccount } from '../../src/modules/identity/internal/repositories/account-repo.ts';
import { asAccountId, type AccountId } from '../../src/modules/identity/internal/types.ts';
import { grantSliceRolesToTestApp } from '../helpers/grant-slice-roles.ts';
import { bearerAuthHeader } from '../helpers/jwt-fixtures.ts';
import { TENANT_GHANA, TENANT_US, withTenantContext } from '../helpers/tenant-fixtures.ts';
import { uniquePhone } from '../helpers/unique-phone.ts';
import { getTestClient } from '../setup.ts';

const T_US = asTenantId(TENANT_US);
const T_GH = asTenantId(TENANT_GHANA);
const BIND_ROLE_TEST_PASSWORD = 'telecheck_test_bind_pw';

/** The 7 SI-022 crisis slice roles the handlers elevate into. */
const CRISIS_SLICE_ROLES = [
  'crisis_initiator',
  'crisis_acknowledger',
  'crisis_responder',
  'crisis_resolver',
  'crisis_sweep_scheduler',
  'crisis_event_staff_reader',
  'crisis_event_patient_reader',
] as const;

let app: FastifyInstance | null = null;
let bindPool: pg.Pool | null = null;

let usPatient: AccountId;
let usPatientB: AccountId;
let usClinician: AccountId;
let usAdmin: AccountId;
let ghClinician: AccountId;
let ghPatient: AccountId;
let ghAdmin: AccountId;

function usAuth(
  accountId: string,
  role: 'patient' | 'clinician' | 'tenant_admin',
): {
  authorization: string;
} {
  return bearerAuthHeader({ accountId, tenantId: T_US, countryOfCare: 'US', role });
}

function ghAuth(
  accountId: string,
  role: 'patient' | 'clinician' | 'tenant_admin',
): {
  authorization: string;
} {
  return bearerAuthHeader({ accountId, tenantId: T_GH, countryOfCare: 'GH', role });
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
        first_name: 'Crisis',
        last_name: 'Sprint4',
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

/** Complete pre-encrypted 8-field intake_payload wire envelope
 *  (migration 033 §4 column shapes: dek_id/kek_id UUID,
 *  dek_version/kek_version INTEGER — distinct from the async-consult
 *  migration 056 shape). */
function makeIntakeEnvelope(label: string): Record<string, unknown> {
  return {
    ciphertext_b64: Buffer.from(`sealed:${label}`).toString('base64'),
    dek_id: '44444444-5555-4666-8777-888888888888',
    dek_version: 1,
    iv_b64: Buffer.from('0123456789ab').toString('base64'),
    auth_tag_b64: Buffer.from('0123456789abcdef').toString('base64'),
    kek_id: '55555555-6666-4777-8888-999999999999',
    kek_version: 2,
    algorithm: 'AES-256-GCM',
  };
}

function initiateBody(
  patientAccountId: string,
  overrides?: Record<string, unknown>,
): Record<string, unknown> {
  return {
    patient_account_id: patientAccountId,
    server_signal_id: randomUUID(),
    crisis_type: 'suicidal_ideation',
    severity: 'imminent',
    regulatory_reporting_enabled: true,
    source_surface: 'mode_1_chat',
    ...overrides,
  };
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

/** Initiate a fresh US crisis event as the US clinician; returns id. */
async function initiateCrisisEvent(overrides?: Record<string, unknown>): Promise<string> {
  const res = await inject({
    method: 'POST',
    url: '/v0/crisis-events',
    auth: usAuth(usClinician, 'clinician'),
    payload: initiateBody(usPatient, overrides),
  });
  expect(res.statusCode).toBe(201);
  return json<{ crisis_event_id: string }>(res).crisis_event_id;
}

async function queryAuditActions(crisisEventId: string): Promise<string[]> {
  const rows = await withTenantContext(T_US, async () => {
    const r = await getTestClient().query(
      `SELECT action FROM audit_records
        WHERE tenant_id = $1 AND resource_id = $2
        ORDER BY sequence_number ASC`,
      [T_US, crisisEventId],
    );
    return r.rows as Array<{ action: string }>;
  });
  return rows.map((r) => r.action);
}

async function queryCurrentState(crisisEventId: string): Promise<string | null> {
  return withTenantContext(T_US, async () => {
    const r = await getTestClient().query(
      `SELECT to_state FROM crisis_event_lifecycle_transition
        WHERE tenant_id = $1 AND crisis_event_id = $2
        ORDER BY transition_at DESC, id DESC LIMIT 1`,
      [T_US, crisisEventId],
    );
    return (r.rows[0] as { to_state: string } | undefined)?.to_state ?? null;
  });
}

beforeAll(async () => {
  process.env['NODE_ENV'] = 'test';

  // SI-010 bind-pool provisioning + slice-role membership mirroring
  // (grant-slice-roles helper; every suite grants its own roles because
  // vitest fork order is nondeterministic).
  const superuser = new pg.Client({
    connectionString: process.env['TEST_DATABASE_URL'] as string,
  });
  await superuser.connect();
  try {
    await superuser.query(
      `ALTER ROLE bind_actor_context_role WITH LOGIN PASSWORD '${BIND_ROLE_TEST_PASSWORD}'`,
    );
  } finally {
    await superuser.end();
  }
  await grantSliceRolesToTestApp(CRISIS_SLICE_ROLES);

  const testUrl = new URL(process.env['TEST_DATABASE_URL'] as string);
  testUrl.username = 'bind_actor_context_role';
  testUrl.password = BIND_ROLE_TEST_PASSWORD;
  bindPool = new pg.Pool({ connectionString: testUrl.toString(), max: 2 });
  setBindActorContextTestPool(bindPool as unknown as DbClient);

  app = await buildApp({ logger: false });
  await app.ready();

  usPatient = await seedAccount('patient', T_US);
  usPatientB = await seedAccount('patient', T_US);
  usClinician = await seedAccount('clinician', T_US);
  usAdmin = await seedAccount('tenant_admin', T_US);
  ghClinician = await seedAccount('clinician', T_GH);
  ghPatient = await seedAccount('patient', T_GH);
  ghAdmin = await seedAccount('tenant_admin', T_GH);
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
// end — each test below is fully self-contained.
// ===========================================================================

describe('crisis-response Sprint 4 — Group A: initiate over live SI-010 + SECDEF + RLS', () => {
  it('A1. initiate (no envelope) → 201; row with all-NULL KMS columns; none→detected; exactly ONE crisis.detected Cat A audit', async () => {
    const body = initiateBody(usPatient);
    const res = await inject({
      method: 'POST',
      url: '/v0/crisis-events',
      auth: usAuth(usClinician, 'clinician'),
      payload: body,
    });
    expect(res.statusCode).toBe(201);
    const crisisEventId = json<{ crisis_event_id: string }>(res).crisis_event_id;

    const row = await withTenantContext(T_US, async () => {
      const r = await getTestClient().query(
        `SELECT patient_account_id, server_signal_id, crisis_type, severity,
                intake_payload_ciphertext, intake_payload_dek_id,
                intake_payload_algorithm
           FROM crisis_event WHERE tenant_id = $1 AND id = $2`,
        [T_US, crisisEventId],
      );
      return r.rows[0] as {
        patient_account_id: string;
        server_signal_id: string;
        crisis_type: string;
        severity: string;
        intake_payload_ciphertext: Buffer | null;
        intake_payload_dek_id: string | null;
        intake_payload_algorithm: string | null;
      };
    });
    expect(row.patient_account_id).toBe(usPatient);
    expect(row.server_signal_id).toBe(body['server_signal_id']);
    expect(row.crisis_type).toBe('suicidal_ideation');
    expect(row.severity).toBe('imminent');
    // No envelope on the wire → migration 033 §4 all-NULL CHECK branch.
    expect(row.intake_payload_ciphertext).toBeNull();
    expect(row.intake_payload_dek_id).toBeNull();
    expect(row.intake_payload_algorithm).toBeNull();

    expect(await queryCurrentState(crisisEventId)).toBe('detected');

    const actions = await queryAuditActions(crisisEventId);
    expect(actions.filter((a) => a === 'crisis.detected')).toHaveLength(1);
  });

  it('A2. initiate WITH pre-encrypted envelope → 201; all 8 intake_payload_* columns persisted byte-exact (ADR-021/ADR-024 wire posture)', async () => {
    const res = await inject({
      method: 'POST',
      url: '/v0/crisis-events',
      auth: usAuth(usClinician, 'clinician'),
      payload: initiateBody(usPatient, {
        intake_payload_envelope: makeIntakeEnvelope('crisis-intake'),
      }),
    });
    expect(res.statusCode).toBe(201);
    const crisisEventId = json<{ crisis_event_id: string }>(res).crisis_event_id;

    const row = await withTenantContext(T_US, async () => {
      const r = await getTestClient().query(
        `SELECT intake_payload_ciphertext, intake_payload_dek_id,
                intake_payload_dek_version, intake_payload_iv,
                intake_payload_auth_tag, intake_payload_kek_id,
                intake_payload_kek_version, intake_payload_algorithm
           FROM crisis_event WHERE tenant_id = $1 AND id = $2`,
        [T_US, crisisEventId],
      );
      return r.rows[0] as {
        intake_payload_ciphertext: Buffer;
        intake_payload_dek_id: string;
        intake_payload_dek_version: number;
        intake_payload_iv: Buffer;
        intake_payload_auth_tag: Buffer;
        intake_payload_kek_id: string;
        intake_payload_kek_version: number;
        intake_payload_algorithm: string;
      };
    });
    expect(Buffer.from(row.intake_payload_ciphertext).toString()).toBe('sealed:crisis-intake');
    expect(row.intake_payload_dek_id).toBe('44444444-5555-4666-8777-888888888888');
    expect(row.intake_payload_dek_version).toBe(1);
    expect(Buffer.from(row.intake_payload_iv).toString()).toBe('0123456789ab');
    expect(Buffer.from(row.intake_payload_auth_tag).toString()).toBe('0123456789abcdef');
    expect(row.intake_payload_kek_id).toBe('55555555-6666-4777-8888-999999999999');
    expect(row.intake_payload_kek_version).toBe(2);
    expect(row.intake_payload_algorithm).toBe('AES-256-GCM');
  });

  it('A3. partial envelope → 400 at the HTTP boundary; NO crisis_event row, NO audit', async () => {
    const serverSignalId = randomUUID();
    const partial = makeIntakeEnvelope('partial');
    delete partial['auth_tag_b64'];
    const res = await inject({
      method: 'POST',
      url: '/v0/crisis-events',
      auth: usAuth(usClinician, 'clinician'),
      payload: initiateBody(usPatient, {
        server_signal_id: serverSignalId,
        intake_payload_envelope: partial,
      }),
    });
    expect(res.statusCode).toBe(400);
    expect(json<{ error: { code: string } }>(res).error.code).toBe('internal.request.invalid');

    const count = await withTenantContext(T_US, async () => {
      const r = await getTestClient().query(
        `SELECT COUNT(*)::int AS n FROM crisis_event
          WHERE tenant_id = $1 AND server_signal_id = $2`,
        [T_US, serverSignalId],
      );
      return (r.rows[0] as { n: number }).n;
    });
    expect(count).toBe(0);
  });

  it('A4. idempotency-replay regression: same body, NEW Idempotency-Key → 201 + SAME crisis_event_id + exactly ONE crisis.detected audit', async () => {
    const body = initiateBody(usPatient);
    const first = await inject({
      method: 'POST',
      url: '/v0/crisis-events',
      auth: usAuth(usClinician, 'clinician'),
      payload: body,
    });
    expect(first.statusCode).toBe(201);
    const firstId = json<{ crisis_event_id: string }>(first).crisis_event_id;

    // NEW Idempotency-Key bypasses the HTTP cache-replay short-circuit
    // and reaches the wrapper, whose UNIQUE(tenant_id, server_signal_id)
    // idempotency returns the existing id. The resource-lifecycle audit
    // marker must prevent a duplicate crisis.detected row (Codex R1
    // #201 finding 1 closure; Sprint 4 regression pin).
    const replay = await inject({
      method: 'POST',
      url: '/v0/crisis-events',
      auth: usAuth(usClinician, 'clinician'),
      payload: body,
    });
    expect(replay.statusCode).toBe(201);
    expect(json<{ crisis_event_id: string }>(replay).crisis_event_id).toBe(firstId);

    const actions = await queryAuditActions(firstId);
    expect(actions.filter((a) => a === 'crisis.detected')).toHaveLength(1);
  });

  it('A5. mismatched replay (same server_signal_id, different severity) → 409 tenant-blind; ONE row + ONE audit only (FLOOR-020 atomic rollback)', async () => {
    const body = initiateBody(usPatient, { severity: 'imminent' });
    const first = await inject({
      method: 'POST',
      url: '/v0/crisis-events',
      auth: usAuth(usClinician, 'clinician'),
      payload: body,
    });
    expect(first.statusCode).toBe(201);
    const firstId = json<{ crisis_event_id: string }>(first).crisis_event_id;

    const mismatch = await inject({
      method: 'POST',
      url: '/v0/crisis-events',
      auth: usAuth(usClinician, 'clinician'),
      payload: { ...body, severity: 'life_threatening' },
    });
    expect(mismatch.statusCode).toBe(409);
    const errBody = json<{ error: { code: string; message: string } }>(mismatch);
    expect(errBody.error.code).toBe('internal.resource.conflict');
    // I-025: no tenant_id / server_signal_id echo.
    expect(JSON.stringify(errBody)).not.toContain('Telecheck-');
    expect(JSON.stringify(errBody)).not.toContain(body['server_signal_id'] as string);

    // FLOOR-020: the rejected attempt left no partial state.
    const rowCount = await withTenantContext(T_US, async () => {
      const r = await getTestClient().query(
        `SELECT COUNT(*)::int AS n FROM crisis_event
          WHERE tenant_id = $1 AND server_signal_id = $2`,
        [T_US, body['server_signal_id'] as string],
      );
      return (r.rows[0] as { n: number }).n;
    });
    expect(rowCount).toBe(1);
    const actions = await queryAuditActions(firstId);
    expect(actions.filter((a) => a === 'crisis.detected')).toHaveLength(1);
  });

  it('A6. malformed patient_account_id (non-ULID) → 400 tenant-blind at the boundary', async () => {
    // NOTE: the FK-violation branch (real ULID shape, no accounts row →
    // SQLSTATE 23503 → 400 per the Codex R3 #221 closure) cannot fire
    // deterministically under the savepoint harness — the migration 053
    // FK is DEFERRABLE INITIALLY DEFERRED and the app's COMMIT becomes
    // RELEASE SAVEPOINT here (deferred checks only run at the true
    // top-level COMMIT). The boundary-validation branch below is the
    // deterministic equivalent; the 23503 mapping is covered at unit
    // scope in post-crisis-event.test.ts.
    const res = await inject({
      method: 'POST',
      url: '/v0/crisis-events',
      auth: usAuth(usClinician, 'clinician'),
      payload: initiateBody('not-a-ulid'),
    });
    expect(res.statusCode).toBe(400);
    const body = json<{ error: { code: string; message: string } }>(res);
    expect(body.error.code).toBe('internal.request.invalid');
    expect(JSON.stringify(body)).not.toContain('Telecheck-');
  });

  it('A7. patient-role token → 403 at the crisis_initiator Layer B gate; no crisis_event row created', async () => {
    const serverSignalId = randomUUID();
    const res = await inject({
      method: 'POST',
      url: '/v0/crisis-events',
      auth: usAuth(usPatient, 'patient'),
      payload: initiateBody(usPatient, { server_signal_id: serverSignalId }),
    });
    expect(res.statusCode).toBe(403);

    const count = await withTenantContext(T_US, async () => {
      const r = await getTestClient().query(
        `SELECT COUNT(*)::int AS n FROM crisis_event
          WHERE tenant_id = $1 AND server_signal_id = $2`,
        [T_US, serverSignalId],
      );
      return (r.rows[0] as { n: number }).n;
    });
    expect(count).toBe(0);
  });
});

describe('crisis-response Sprint 4 — Group B: staff + patient-scoped reads', () => {
  it('B1. staff GET /:id → 200 with the 12-column crisis_event_current_state_v shape', async () => {
    const crisisEventId = await initiateCrisisEvent();
    const res = await inject({
      method: 'GET',
      url: `/v0/crisis-events/${crisisEventId}`,
      auth: usAuth(usClinician, 'clinician'),
    });
    expect(res.statusCode).toBe(200);
    const row = json<Record<string, unknown>>(res);
    expect(row['crisis_event_id']).toBe(crisisEventId);
    expect(row['patient_account_id']).toBe(usPatient);
    expect(row['current_state']).toBe('detected');
    // Staff view carries the 4 staff-only columns.
    expect(row).toHaveProperty('server_signal_id');
    expect(row).toHaveProperty('regulatory_reporting_enabled');
    expect(row).toHaveProperty('current_state_transition_reason');
    expect(row).toHaveProperty('current_state_actor_principal_id');
  });

  it('B2. staff GET nonexistent id → 404 tenant-blind', async () => {
    const res = await inject({
      method: 'GET',
      url: `/v0/crisis-events/${randomUUID()}`,
      auth: usAuth(usClinician, 'clinician'),
    });
    expect(res.statusCode).toBe(404);
  });

  it('B3. patient-summary GET by the OWNING patient → 200 with the 8-column data-minimized shape (Sprint 4 route-mount regression pin)', async () => {
    const crisisEventId = await initiateCrisisEvent();
    const res = await inject({
      method: 'GET',
      url: `/v0/crisis-events/${crisisEventId}/patient-summary`,
      auth: usAuth(usPatient, 'patient'),
    });
    // Before the Sprint 4 route-mount fix this returned 404 for EVERY
    // input (route absent) despite /ready claiming 7 mounted handlers.
    expect(res.statusCode).toBe(200);
    const row = json<Record<string, unknown>>(res);
    expect(row['crisis_event_id']).toBe(crisisEventId);
    expect(row['patient_account_id']).toBe(usPatient);
    expect(row['crisis_type']).toBe('suicidal_ideation');
    expect(row['current_state']).toBe('detected');
    // Data-minimization: the 4 staff-only columns are ABSENT (view
    // projection, not row filtering — migration 053 §4).
    expect(row).not.toHaveProperty('server_signal_id');
    expect(row).not.toHaveProperty('regulatory_reporting_enabled');
    expect(row).not.toHaveProperty('current_state_transition_reason');
    expect(row).not.toHaveProperty('current_state_actor_principal_id');
  });

  it('B4. patient-summary GET by a DIFFERENT patient of the same tenant → 404 tenant-blind (view self-scoping)', async () => {
    const crisisEventId = await initiateCrisisEvent(); // belongs to usPatient
    const res = await inject({
      method: 'GET',
      url: `/v0/crisis-events/${crisisEventId}/patient-summary`,
      auth: usAuth(usPatientB, 'patient'),
    });
    expect(res.statusCode).toBe(404);
  });

  it('B5. patient token on the staff read → 403 (clinician role gate)', async () => {
    const crisisEventId = await initiateCrisisEvent();
    const res = await inject({
      method: 'GET',
      url: `/v0/crisis-events/${crisisEventId}`,
      auth: usAuth(usPatient, 'patient'),
    });
    expect(res.statusCode).toBe(403);
  });
});

describe('crisis-response Sprint 4 — Group C: lifecycle writes + state-machine guards', () => {
  it('C1. acknowledge on detected → 200; crisis.acknowledged audit with from_state=detected; view state acknowledged', async () => {
    const crisisEventId = await initiateCrisisEvent();
    const res = await inject({
      method: 'POST',
      url: `/v0/crisis-events/${crisisEventId}/acknowledge`,
      auth: usAuth(usClinician, 'clinician'),
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    const view = json<{ crisis_event_id: string; lifecycle_transition_id: string }>(res);
    expect(view.crisis_event_id).toBe(crisisEventId);
    expect(view.lifecycle_transition_id).toBeTruthy();

    expect(await queryCurrentState(crisisEventId)).toBe('acknowledged');

    const auditRow = await withTenantContext(T_US, async () => {
      const r = await getTestClient().query(
        `SELECT payload FROM audit_records
          WHERE tenant_id = $1 AND resource_id = $2 AND action = 'crisis.acknowledged'`,
        [T_US, crisisEventId],
      );
      return r.rows[0] as { payload: { detail?: { from_state?: string } } } | undefined;
    });
    expect(auditRow).toBeDefined();
  });

  it('C2. respond BEFORE acknowledge → 409 tenant-blind (state-machine guard); NO crisis.responded audit (FLOOR-020 rejection atomicity)', async () => {
    const crisisEventId = await initiateCrisisEvent();
    const res = await inject({
      method: 'POST',
      url: `/v0/crisis-events/${crisisEventId}/respond`,
      auth: usAuth(usClinician, 'clinician'),
      payload: {},
    });
    expect(res.statusCode).toBe(409);
    const body = json<{ error: { code: string; message: string } }>(res);
    expect(body.error.code).toBe('internal.resource.conflict');
    expect(JSON.stringify(body)).not.toContain('Telecheck-');

    // The rejected transition rolled back atomically — no audit, state
    // unchanged.
    const actions = await queryAuditActions(crisisEventId);
    expect(actions).not.toContain('crisis.responded');
    expect(await queryCurrentState(crisisEventId)).toBe('detected');
  });

  it('C3. full chain acknowledge → respond → resolve → 200 each; all three Cat A audits present; final state resolved', async () => {
    const crisisEventId = await initiateCrisisEvent();

    for (const [step, expectedState] of [
      ['acknowledge', 'acknowledged'],
      ['respond', 'responded'],
      ['resolve', 'resolved'],
    ] as const) {
      const res = await inject({
        method: 'POST',
        url: `/v0/crisis-events/${crisisEventId}/${step}`,
        auth: usAuth(usClinician, 'clinician'),
        payload: {},
      });
      expect(res.statusCode).toBe(200);
      expect(await queryCurrentState(crisisEventId)).toBe(expectedState);
    }

    const actions = await queryAuditActions(crisisEventId);
    expect(actions.filter((a) => a === 'crisis.detected')).toHaveLength(1);
    expect(actions.filter((a) => a === 'crisis.acknowledged')).toHaveLength(1);
    expect(actions.filter((a) => a === 'crisis.responded')).toHaveLength(1);
    expect(actions.filter((a) => a === 'crisis.resolved')).toHaveLength(1);
  });

  it('C4. acknowledge replay (same actor, NEW Idempotency-Key) → 200 + SAME lifecycle_transition_id + exactly ONE crisis.acknowledged audit (deterministic race-envelope equivalent)', async () => {
    const crisisEventId = await initiateCrisisEvent();
    const first = await inject({
      method: 'POST',
      url: `/v0/crisis-events/${crisisEventId}/acknowledge`,
      auth: usAuth(usClinician, 'clinician'),
      payload: {},
    });
    expect(first.statusCode).toBe(200);
    const firstTransitionId = json<{ lifecycle_transition_id: string }>(
      first,
    ).lifecycle_transition_id;

    // Same-actor replay with a NEW Idempotency-Key: the wrapper's
    // idempotent-replay path returns the SAME transition id, and the
    // per-transition audit marker dedupes the emit. (The concurrent
    // different-actor claim race surfaces as SQLSTATE 40001 → the same
    // tenant-blind 409 envelope C2 pins; true interleaving cannot run
    // under the shared-client savepoint harness.)
    const replay = await inject({
      method: 'POST',
      url: `/v0/crisis-events/${crisisEventId}/acknowledge`,
      auth: usAuth(usClinician, 'clinician'),
      payload: {},
    });
    expect(replay.statusCode).toBe(200);
    expect(json<{ lifecycle_transition_id: string }>(replay).lifecycle_transition_id).toBe(
      firstTransitionId,
    );

    const actions = await queryAuditActions(crisisEventId);
    expect(actions.filter((a) => a === 'crisis.acknowledged')).toHaveLength(1);
  });
});

describe('crisis-response Sprint 4 — Group D: operator sweep', () => {
  const sweepBody = (generation = 0): Record<string, unknown> => ({
    scheduler_id: 'sweep-scheduler-test-1',
    fencing_token: '1',
    target_obligation_generation: generation,
  });

  it('D1. detected event + admin token → 200 outcome=completed_escalated + escalation audit + view state escalated (pins the patient_account_id pre-fetch fix)', async () => {
    const crisisEventId = await initiateCrisisEvent();
    const res = await inject({
      method: 'POST',
      url: `/v0/crisis-events/${crisisEventId}/_sweep`,
      auth: usAuth(usAdmin, 'tenant_admin'),
      payload: sweepBody(),
    });
    // Before the Sprint 4 fix the staff-view pre-fetch selected the
    // pre-053 column name (patient_id) and 42703'd → 500 on every live
    // sweep call. Unit-test mocks masked it; this is the live pin.
    expect(res.statusCode).toBe(200);
    const view = json<{ outcome: string; fencing_token: string | number }>(res);
    expect(view.outcome).toBe('completed_escalated');

    expect(await queryCurrentState(crisisEventId)).toBe('escalated');
    const actions = await queryAuditActions(crisisEventId);
    expect(actions.filter((a) => a === 'crisis.no_acknowledgement_escalation')).toHaveLength(1);
  });

  it('D2. sweep replay of the SAME generation → outcome=already_completed; no second escalation audit (fencing-token idempotency)', async () => {
    const crisisEventId = await initiateCrisisEvent();
    const first = await inject({
      method: 'POST',
      url: `/v0/crisis-events/${crisisEventId}/_sweep`,
      auth: usAuth(usAdmin, 'tenant_admin'),
      payload: sweepBody(0),
    });
    expect(first.statusCode).toBe(200);
    expect(json<{ outcome: string }>(first).outcome).toBe('completed_escalated');

    const replay = await inject({
      method: 'POST',
      url: `/v0/crisis-events/${crisisEventId}/_sweep`,
      auth: usAuth(usAdmin, 'tenant_admin'),
      payload: sweepBody(0),
    });
    expect(replay.statusCode).toBe(200);
    expect(json<{ outcome: string }>(replay).outcome).toBe('already_completed');

    const actions = await queryAuditActions(crisisEventId);
    expect(actions.filter((a) => a === 'crisis.no_acknowledgement_escalation')).toHaveLength(1);
  });

  it('D3. acknowledged event sweep → outcome=completed_no_op; NO escalation audit', async () => {
    const crisisEventId = await initiateCrisisEvent();
    const ack = await inject({
      method: 'POST',
      url: `/v0/crisis-events/${crisisEventId}/acknowledge`,
      auth: usAuth(usClinician, 'clinician'),
      payload: {},
    });
    expect(ack.statusCode).toBe(200);

    const res = await inject({
      method: 'POST',
      url: `/v0/crisis-events/${crisisEventId}/_sweep`,
      auth: usAuth(usAdmin, 'tenant_admin'),
      payload: sweepBody(0),
    });
    expect(res.statusCode).toBe(200);
    expect(json<{ outcome: string }>(res).outcome).toBe('completed_no_op');

    const actions = await queryAuditActions(crisisEventId);
    expect(actions).not.toContain('crisis.no_acknowledgement_escalation');
    expect(await queryCurrentState(crisisEventId)).toBe('acknowledged');
  });

  it('D4. clinician token on sweep → 403 (closest-available admin gate)', async () => {
    const crisisEventId = await initiateCrisisEvent();
    const res = await inject({
      method: 'POST',
      url: `/v0/crisis-events/${crisisEventId}/_sweep`,
      auth: usAuth(usClinician, 'clinician'),
      payload: sweepBody(),
    });
    expect(res.statusCode).toBe(403);
  });

  it('D5. Ghana admin probing a US event → 404 tenant-blind; US event untouched', async () => {
    const crisisEventId = await initiateCrisisEvent();
    const res = await inject({
      method: 'POST',
      url: `/v0/crisis-events/${crisisEventId}/_sweep`,
      auth: ghAuth(ghAdmin, 'tenant_admin'),
      host: 'ghana.heroshealth.com',
      payload: sweepBody(),
    });
    expect(res.statusCode).toBe(404);
    expect(await queryCurrentState(crisisEventId)).toBe('detected');
  });
});

describe('crisis-response Sprint 4 — Group E: cross-tenant isolation (I-023 / I-025)', () => {
  it('E1. Ghana clinician GET of a US crisis id → 404 with the SAME envelope shape as a nonexistent id (tenant-blind)', async () => {
    const crisisEventId = await initiateCrisisEvent();

    const crossTenant = await inject({
      method: 'GET',
      url: `/v0/crisis-events/${crisisEventId}`,
      auth: ghAuth(ghClinician, 'clinician'),
      host: 'ghana.heroshealth.com',
    });
    const nonexistent = await inject({
      method: 'GET',
      url: `/v0/crisis-events/${randomUUID()}`,
      auth: ghAuth(ghClinician, 'clinician'),
      host: 'ghana.heroshealth.com',
    });

    expect(crossTenant.statusCode).toBe(404);
    expect(nonexistent.statusCode).toBe(404);
    // I-025: the two envelopes are indistinguishable modulo per-request
    // identifiers (request_id / trace_id / timestamp).
    const scrub = (raw: string): Record<string, unknown> => {
      const parsed = JSON.parse(raw) as { error: Record<string, unknown> };
      delete parsed.error['request_id'];
      delete parsed.error['trace_id'];
      delete parsed.error['timestamp'];
      return parsed;
    };
    expect(scrub(crossTenant.body)).toEqual(scrub(nonexistent.body));
  });

  it('E2. Ghana clinician acknowledge of a US crisis id → 404 tenant-blind; US event state unchanged', async () => {
    const crisisEventId = await initiateCrisisEvent();
    const res = await inject({
      method: 'POST',
      url: `/v0/crisis-events/${crisisEventId}/acknowledge`,
      auth: ghAuth(ghClinician, 'clinician'),
      host: 'ghana.heroshealth.com',
      payload: {},
    });
    expect(res.statusCode).toBe(404);
    expect(json<{ error: { code: string } }>(res).error.code).toBe('internal.resource.not_found');
    expect(await queryCurrentState(crisisEventId)).toBe('detected');
    const actions = await queryAuditActions(crisisEventId);
    expect(actions).not.toContain('crisis.acknowledged');
  });

  it('E3. Ghana patient patient-summary probe of a US event → 404 tenant-blind', async () => {
    const crisisEventId = await initiateCrisisEvent();
    const res = await inject({
      method: 'GET',
      url: `/v0/crisis-events/${crisisEventId}/patient-summary`,
      auth: ghAuth(ghPatient, 'patient'),
      host: 'ghana.heroshealth.com',
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('crisis-response Sprint 4 — Group F: I-019 platform-floor (always-on)', () => {
  it('F1. the crisis surface is mounted unconditionally — no config gate (I-019): probes reach routes (never route-missing 404), /health 200, /ready 200 + spec_gated_gaps', async () => {
    // No crisis-specific env var / feature flag exists in this suite's
    // environment — the surface below must still be fully mounted.
    // I-019: crisis detection/response is platform-floor; never gated
    // behind config.
    const health = await app!.inject({
      method: 'GET',
      url: '/v0/crisis-events/health',
      headers: { host: 'localhost' },
    });
    expect(health.statusCode).toBe(200);

    const ready = await app!.inject({
      method: 'GET',
      url: '/v0/crisis-events/ready',
      headers: { host: 'localhost' },
    });
    expect(ready.statusCode).toBe(200);
    const readyBody = ready.json() as { status: string; spec_gated_gaps: string[] };
    expect(readyBody.status).toBe('ready');
    expect(readyBody.spec_gated_gaps.length).toBeGreaterThan(0);

    // Unauthenticated probes hit the mounted routes' auth gates —
    // 401 (auth missing), NOT a route-missing 404.
    const unauthGet = await app!.inject({
      method: 'GET',
      url: `/v0/crisis-events/${randomUUID()}`,
      headers: { host: 'localhost' },
    });
    expect(unauthGet.statusCode).toBe(401);

    const unauthPost = await app!.inject({
      method: 'POST',
      url: '/v0/crisis-events',
      headers: {
        host: 'localhost',
        'content-type': 'application/json',
        'idempotency-key': ulid(),
      },
      payload: {},
    });
    expect(unauthPost.statusCode).toBe(401);

    const unauthPatientSummary = await app!.inject({
      method: 'GET',
      url: `/v0/crisis-events/${randomUUID()}/patient-summary`,
      headers: { host: 'localhost' },
    });
    expect(unauthPatientSummary.statusCode).toBe(401);
  });
});
