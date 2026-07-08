/**
 * async-consult-v1-http.test.ts — live-PostgreSQL HTTP integration tests
 * for the Sprint-10 /v1/async-consults surface (P-038 canonical entity
 * chain; migrations 055-064).
 *
 * Closes the "Live-PostgreSQL integration tests for the v1 endpoints are
 * pending" hardening item (async-consult README). Unlike the per-handler
 * unit suites (which mock every lib), this file exercises the REAL
 * composition end-to-end: JWT verify → SI-010 bind (real bind pool
 * authenticated as bind_actor_context_role) → tenant context → SET LOCAL
 * ROLE slice role → SECDEF wrappers → RLS → same-tx audit emission.
 *
 * **First suite to exercise the real SI-010 bind path** (per the
 * tests/setup.ts R2/R4 closure, bind wiring is slice-level opt-in): the
 * beforeAll provisions a password for `bind_actor_context_role` (created
 * LOGIN by migration 031; CI's TEST_DATABASE_URL user is superuser),
 * opens a DEDICATED pg.Pool as that role, and installs it via
 * `setBindActorContextTestPool()` BEFORE buildApp — so the app's SI-010
 * boot probe validates the same trust boundary production validates.
 *
 * Coverage (4 groups):
 *
 *   Group A — Full pilot loop over live infrastructure
 *     A1 initiate (patient) → 201 consult_id
 *     A2 intake (patient) → 201 submission_id
 *     A3 ai-preparation (ai_service) → 201 summary_id (submitted →
 *        processing → queued through the migration 059 §3 wrapper under
 *        ai_service_account; migration 064 wiring)
 *     A4 queue (clinician) lists the consult in state 'queued'
 *     A5 claim (clinician) → 201 claim_id
 *     A6 decision (clinician, recommend) → 201 decision_id
 *     A7 patient GET → current_state 'advised', decision_type 'recommend'
 *
 *   Group B — Endpoint #9 + follow-up messages (#10/#11) on a second loop
 *     B1 request-additional-data (clinician) → 201; patient GET shows
 *        'awaiting_data'
 *     B2 patient sends follow-up message → 201
 *     B3 clinician sends follow-up message → 201
 *     B4 patient lists → both messages, envelope round-trips, no tenant leak
 *     B5 clinician lists → both messages
 *
 *   Group C — Caller-class gates on the live surface
 *     C1 ai-preparation with a patient token → 403
 *     C2 ai-preparation with a clinician token → 403
 *     C3 queue with an ai_service token → 403
 *
 *   Group D — Tenant-blind self-scoping (I-025)
 *     D1 a SECOND patient's GET on the first patient's consult → 404
 *     D2 the second patient's follow-up list on that consult → empty rows
 *        (indistinguishable from a message-less consult)
 *
 * Spec references: P-038 §7 endpoints 1-11, migrations 055-064,
 * AUDIT_EVENTS v5.11 async_consult.*, I-003, I-023, I-025, I-026, I-027,
 * docs/SI-010-Session-Actor-Context-DB-Binding.md.
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
import { TENANT_US, withTenantContext } from '../helpers/tenant-fixtures.ts';
import { uniquePhone } from '../helpers/unique-phone.ts';
import { getTestClient } from '../setup.ts';

const T_US = asTenantId(TENANT_US);
const BIND_ROLE_TEST_PASSWORD = 'telecheck_test_bind_pw';

let app: FastifyInstance | null = null;
let bindPool: pg.Pool | null = null;

// Seeded identities (beforeAll).
let patient: { accountId: AccountId; token: string };
let patientB: { accountId: AccountId; token: string };
let clinician: { accountId: AccountId; token: string };
let aiServiceToken = '';
const AI_SERVICE_PRINCIPAL = ulid(); // service principal — no accounts row needed
let templateId = '';

function mintToken(accountId: string, role: AccessTokenRole): string {
  return issueAccessToken(
    {
      account_id: accountId,
      tenant_id: T_US,
      session_id: ulid(),
      role,
      country_of_care: 'US',
      delegate_id: null,
      admin_tenant_binding: null,
    },
    config.jwtSigningKey,
  );
}

async function seedAccount(accountType: 'patient' | 'clinician'): Promise<AccountId> {
  const accountId = asAccountId(ulid());
  await withTenantContext(T_US, () =>
    createAccount(
      {
        account_id: accountId,
        tenant_id: T_US,
        phone_e164: uniquePhone('+1'),
        first_name: 'V1',
        last_name: 'Integration',
        date_of_birth: '1990-01-01',
        gender: 'prefer_not_to_say',
        country_of_residence: 'US',
        country_of_care: 'US',
        account_type: accountType,
      },
      async () => {},
    ),
  );
  return accountId;
}

/** Synthetic pre-encrypted KMS envelope (I-026 wire shape; staging-smoke parity). */
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
  payload?: unknown;
}

async function inject(args: InjectArgs): Promise<{ statusCode: number; body: string }> {
  return app!.inject({
    method: args.method,
    url: args.url,
    headers: {
      host: 'localhost',
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

async function initiateConsult(token: string): Promise<string> {
  const res = await inject({
    method: 'POST',
    url: '/v1/async-consults',
    token,
    payload: {
      consult_type: 'general',
      initiation_source: 'care_tab',
      consult_fee_cents: 0,
      currency: 'USD',
      payment_provider: 'mock_local_dev',
      payment_intent_id: ulid(),
      expected_turnaround_at: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
    },
  });
  expect(res.statusCode).toBe(201);
  return json<{ consult_id: string }>(res).consult_id;
}

async function submitIntake(token: string, consultId: string): Promise<string> {
  const res = await inject({
    method: 'POST',
    url: `/v1/async-consults/${consultId}/intake`,
    token,
    payload: {
      template_id: templateId,
      template_version: '1',
      intake_payload_envelope: makeEnvelope('intake'),
    },
  });
  expect(res.statusCode).toBe(201);
  return json<{ submission_id: string }>(res).submission_id;
}

async function runAiPreparation(consultId: string, patientId: string): Promise<string> {
  const res = await inject({
    method: 'POST',
    url: `/v1/async-consults/${consultId}/ai-preparation`,
    token: aiServiceToken,
    payload: {
      patient_id: patientId,
      prepared_by_mode: 'mode_1',
      ai_provider: 'null_local_dev',
      model_id: 'null-provider:integration-test',
      summary_envelope: makeEnvelope('summary'),
      interaction_signals_snapshot: {},
      recommendation: 'recommend',
    },
  });
  expect(res.statusCode).toBe(201);
  return json<{ summary_id: string }>(res).summary_id;
}

async function claimConsult(consultId: string): Promise<string> {
  const res = await inject({
    method: 'POST',
    url: `/v1/async-consults/${consultId}/claim`,
    token: clinician.token,
    payload: {},
  });
  expect(res.statusCode).toBe(201);
  return json<{ claim_id: string }>(res).claim_id;
}

beforeAll(async () => {
  process.env['NODE_ENV'] = 'test';

  // ------------------------------------------------------------------
  // SI-010 bind-pool provisioning (slice-level opt-in per tests/setup.ts
  // R2/R4 closure). Migration 031 creates bind_actor_context_role as
  // LOGIN without credentials; a DEDICATED superuser connection from
  // TEST_DATABASE_URL provisions a suite-local password (the SHARED test
  // client authenticates as non-superuser telecheck_test_app and cannot
  // AlterRole — CI run 28910988544 pinned that 42501). Then we open a
  // pool whose session_user is the bind role — the exact production
  // trust boundary the boot probe verifies.
  // ------------------------------------------------------------------
  const superuser = new pg.Client({
    connectionString: process.env['TEST_DATABASE_URL'] as string,
  });
  await superuser.connect();
  try {
    await superuser.query(
      `ALTER ROLE bind_actor_context_role WITH LOGIN PASSWORD '${BIND_ROLE_TEST_PASSWORD}'`,
    );
    // Mirror the production app-role acquisition topology onto the test
    // principal: migrations 051/061/064 grant slice-role memberships to
    // telecheck_app_role, but the suite's shared client runs as
    // telecheck_test_app (tests/setup.ts installTestAppRole), which gets
    // broad table grants and NO memberships — so every handler's
    // SET LOCAL ROLE would 42501 (CI run 28911340820 pinned this as a
    // blanket 403 on all v1 writes). Plain GRANT (CI is PG 15 — the
    // 051 §2 per-membership `WITH INHERIT FALSE, SET TRUE` clause is
    // PG 16 grammar; the PG 15 posture relies on the member role's
    // NOINHERIT attribute, exactly as migration 061's version branch
    // documents).
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

  // ------------------------------------------------------------------
  // Seed identities + the forms-template FK target (mirrors
  // scripts/seed-staging-accounts.sql).
  // ------------------------------------------------------------------
  const patientId = await seedAccount('patient');
  const patientBId = await seedAccount('patient');
  const clinicianId = await seedAccount('clinician');
  patient = { accountId: patientId, token: mintToken(patientId, 'patient') };
  patientB = { accountId: patientBId, token: mintToken(patientBId, 'patient') };
  clinician = { accountId: clinicianId, token: mintToken(clinicianId, 'clinician') };
  aiServiceToken = mintToken(AI_SERVICE_PRINCIPAL, 'ai_service');

  // Forms-template FK target for the intake step (mirrors
  // scripts/seed-staging-accounts.sql). Seeded through the SHARED test
  // client — its writes live inside the file's outer transaction, so the
  // row is visible to every request in this file (the app queries run on
  // the same connection via setTestPool) but NEVER commits — a
  // superuser-committed row leaked into the parallel forms-intake fork's
  // keyset-pagination expectations (CI run 28911758035 pinned that).
  templateId = ulid();
  await withTenantContext(T_US, async () => {
    await getTestClient().query(
      `INSERT INTO forms_template (
         template_id, tenant_id, program_id, country_of_care,
         template_version, name, description, created_by
       ) VALUES ($1, $2, $3, 'US', 1, 'v1 integration intake template',
                 'Synthetic template for async-consult v1 HTTP integration tests.', $4)`,
      // program_id is NOT NULL on forms_template (migration 006) — an
      // opaque TEXT per the migration 010 widening. The 'zzz_' prefix is
      // load-bearing: forms-intake-admin's keyset-pagination test lists
      // tenant-wide (limit 2, ordered by program_id first) then filters
      // to its own 'prog_*' program — a digit-prefixed ULID here sorts
      // BEFORE 'prog_*' and steals a page-1 slot when both files share a
      // worker's outer transaction (CI runs 28911758035 + 28911931016
      // pinned this). 'zzz_*' sorts after every fixture family.
      [templateId, T_US, `zzz_v1_http_${ulid()}`, clinicianId],
    );
  });
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
// Tests. IMPORTANT: tests/setup.ts wraps EVERY test in a savepoint that is
// rolled back at test end — DB state does NOT survive across `it` blocks
// (CI run 28911517079 pinned this: cross-test chaining 409'd on rolled-back
// consults while the self-contained B1 chain passed). Every test below is
// therefore fully self-contained: it creates whatever consult chain it
// needs and asserts within the same block.
// ===========================================================================

describe('async-consult v1 — full pilot loop (live SI-010 + SECDEF + RLS)', () => {
  it('A. initiate → intake → ai-preparation → queue → claim → decision → patient read-back', async () => {
    // Initiate (patient).
    const consultId = await initiateConsult(patient.token);
    expect(consultId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);

    // Intake (patient).
    const submissionId = await submitIntake(patient.token, consultId);
    expect(submissionId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);

    // AI preparation (ai_service) — submitted → processing → queued
    // through the migration 059 §3 wrapper under ai_service_account.
    const summaryId = await runAiPreparation(consultId, patient.accountId);
    expect(summaryId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    const queuedRead = await inject({
      method: 'GET',
      url: `/v1/async-consults/${consultId}`,
      token: patient.token,
    });
    expect(queuedRead.statusCode).toBe(200);
    expect(json<{ current_state: string }>(queuedRead).current_state).toBe('queued');

    // Clinician queue lists it.
    const queue = await inject({
      method: 'GET',
      url: '/v1/async-consults/queue?limit=50',
      token: clinician.token,
    });
    expect(queue.statusCode).toBe(200);
    const row = json<{ rows: { consult_id: string; current_state: string | null }[] }>(
      queue,
    ).rows.find((r) => r.consult_id === consultId);
    expect(row).toBeDefined();
    expect(row!.current_state).toBe('queued');

    // Claim + decision (clinician, recommend).
    const claimId = await claimConsult(consultId);
    const decision = await inject({
      method: 'POST',
      url: `/v1/async-consults/${consultId}/decision`,
      token: clinician.token,
      payload: {
        claim_id: claimId,
        patient_id: patient.accountId,
        decision_type: 'recommend',
        agreement_with_ai_recommendation: 'no_ai_recommendation',
        decision_rationale_envelope: makeEnvelope('rationale'),
        interaction_signals_reviewed_ids: [],
      },
    });
    expect(decision.statusCode).toBe(201);

    // Patient read-back — tenant-blind body (I-025 / §17 brand rule).
    const finalRead = await inject({
      method: 'GET',
      url: `/v1/async-consults/${consultId}`,
      token: patient.token,
    });
    expect(finalRead.statusCode).toBe(200);
    const view = json<{ current_state: string; decision_type: string | null }>(finalRead);
    expect(view.current_state).toBe('advised');
    expect(view.decision_type).toBe('recommend');
    expect(finalRead.body).not.toContain('"tenant_id"');
    expect(finalRead.body).not.toContain('Telecheck-US');
  });
});

describe('async-consult v1 — endpoint #9 + follow-up messages (#10/#11)', () => {
  it('B. request-additional-data → awaiting_data; both parties message; both list; envelope round-trips', async () => {
    // Chain to under_review.
    const consultId = await initiateConsult(patient.token);
    await submitIntake(patient.token, consultId);
    await runAiPreparation(consultId, patient.accountId);
    const claimId = await claimConsult(consultId);

    // Endpoint #9 — decision_type pinned server-side.
    const rad = await inject({
      method: 'POST',
      url: `/v1/async-consults/${consultId}/request-additional-data`,
      token: clinician.token,
      payload: {
        claim_id: claimId,
        patient_id: patient.accountId,
        agreement_with_ai_recommendation: 'no_ai_recommendation',
        decision_rationale_envelope: makeEnvelope('need-more-data'),
        interaction_signals_reviewed_ids: [],
      },
    });
    expect(rad.statusCode).toBe(201);
    const awaiting = await inject({
      method: 'GET',
      url: `/v1/async-consults/${consultId}`,
      token: patient.token,
    });
    expect(json<{ current_state: string }>(awaiting).current_state).toBe('awaiting_data');

    // Endpoint #10 — patient + clinician sends.
    const patientSend = await inject({
      method: 'POST',
      url: `/v1/async-consults/${consultId}/follow-up-messages`,
      token: patient.token,
      payload: { message_envelope: makeEnvelope('patient-msg') },
    });
    expect(patientSend.statusCode).toBe(201);
    const clinicianSend = await inject({
      method: 'POST',
      url: `/v1/async-consults/${consultId}/follow-up-messages`,
      token: clinician.token,
      payload: {
        patient_id: patient.accountId,
        message_envelope: makeEnvelope('clinician-msg'),
      },
    });
    expect(clinicianSend.statusCode).toBe(201);

    // Endpoint #11 — patient list (self-scoped) round-trips the sealed
    // envelope; clinician list sees the same rows.
    const patientList = await inject({
      method: 'GET',
      url: `/v1/async-consults/${consultId}/follow-up-messages`,
      token: patient.token,
    });
    expect(patientList.statusCode).toBe(200);
    const rows = json<{
      rows: { sender_role: string; message_envelope: { ciphertext_b64: string } }[];
    }>(patientList).rows;
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.sender_role).sort()).toEqual(['clinician', 'patient']);
    const patientMsg = rows.find((r) => r.sender_role === 'patient')!;
    expect(Buffer.from(patientMsg.message_envelope.ciphertext_b64, 'base64').toString()).toBe(
      'sealed:patient-msg',
    );
    expect(patientList.body).not.toContain('"tenant_id"');
    expect(patientList.body).not.toContain('Telecheck-US');

    const clinicianList = await inject({
      method: 'GET',
      url: `/v1/async-consults/${consultId}/follow-up-messages`,
      token: clinician.token,
    });
    expect(clinicianList.statusCode).toBe(200);
    expect(json<{ rows: unknown[] }>(clinicianList).rows).toHaveLength(2);
  });
});

describe('async-consult v1 — caller-class gates', () => {
  // Layer B fires before any consult lookup, so a syntactically-valid
  // random consult_id suffices — no seeded state needed.
  const someConsultId = '01HFG6Z3Q8B7H9P2W4V5K6N7T0';

  it('C1 ai-preparation rejects a patient token with 403', async () => {
    const res = await inject({
      method: 'POST',
      url: `/v1/async-consults/${someConsultId}/ai-preparation`,
      token: patient.token,
      payload: {},
    });
    expect(res.statusCode).toBe(403);
  });

  it('C2 ai-preparation rejects a clinician token with 403', async () => {
    const res = await inject({
      method: 'POST',
      url: `/v1/async-consults/${someConsultId}/ai-preparation`,
      token: clinician.token,
      payload: {},
    });
    expect(res.statusCode).toBe(403);
  });

  it('C3 queue rejects an ai_service token with 403', async () => {
    const res = await inject({
      method: 'GET',
      url: '/v1/async-consults/queue',
      token: aiServiceToken,
    });
    expect(res.statusCode).toBe(403);
  });
});

describe('async-consult v1 — tenant-blind self-scoping (I-025)', () => {
  it('D1 a second patient reading another patient consult gets a tenant-blind 404', async () => {
    const consultId = await initiateConsult(patient.token);
    const res = await inject({
      method: 'GET',
      url: `/v1/async-consults/${consultId}`,
      token: patientB.token,
    });
    expect(res.statusCode).toBe(404);
    expect(res.body).not.toContain('Telecheck-US');
  });

  it('D2 a second patient sees ZERO follow-up messages on a foreign consult (indistinguishable from message-less)', async () => {
    const consultId = await initiateConsult(patient.token);
    const send = await inject({
      method: 'POST',
      url: `/v1/async-consults/${consultId}/follow-up-messages`,
      token: patient.token,
      payload: { message_envelope: makeEnvelope('private-msg') },
    });
    expect(send.statusCode).toBe(201);

    const res = await inject({
      method: 'GET',
      url: `/v1/async-consults/${consultId}/follow-up-messages`,
      token: patientB.token,
    });
    expect(res.statusCode).toBe(200);
    expect(json<{ rows: unknown[] }>(res).rows).toHaveLength(0);
  });
});
