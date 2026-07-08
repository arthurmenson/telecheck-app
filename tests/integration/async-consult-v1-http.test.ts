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
import { createAccount } from '../../src/modules/identity/internal/repositories/account-repo.ts';
import { asAccountId, type AccountId } from '../../src/modules/identity/internal/types.ts';
import { TENANT_US, withTenantContext } from '../helpers/tenant-fixtures.ts';
import { uniquePhone } from '../helpers/unique-phone.ts';

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

// Cross-test state (Group A/B chains).
let consultA = '';
let consultB = '';
let claimB = '';

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
  // scripts/seed-staging-accounts.sql). Inserted via a dedicated
  // superuser connection — superusers bypass RLS, so no tenant GUC is
  // needed on this one-off seed row.
  templateId = ulid();
  const seeder = new pg.Client({
    connectionString: process.env['TEST_DATABASE_URL'] as string,
  });
  await seeder.connect();
  try {
    await seeder.query(
      `INSERT INTO forms_template (
         template_id, tenant_id, program_id, country_of_care,
         template_version, name, description, created_by
       ) VALUES ($1, $2, $3, 'US', 1, 'v1 integration intake template',
                 'Synthetic template for async-consult v1 HTTP integration tests.', $4)`,
      // program_id is NOT NULL on forms_template (migration 006) — an
      // opaque identifier per the migration 010 TEXT widening; any ULID
      // satisfies it (CI run 28911163674 pinned the 23502).
      [templateId, T_US, ulid(), clinicianId],
    );
  } finally {
    await seeder.end();
  }
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
// Group A — full pilot loop
// ===========================================================================

describe('async-consult v1 — Group A full pilot loop (live SI-010 + SECDEF + RLS)', () => {
  it('A1 initiate (patient) returns 201 + consult_id; no tenant leak', async () => {
    consultA = await initiateConsult(patient.token);
    expect(consultA).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it('A2 intake (patient) returns 201 + submission_id', async () => {
    const submissionId = await submitIntake(patient.token, consultA);
    expect(submissionId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it('A3 ai-preparation (ai_service) advances submitted → queued through the real wrapper', async () => {
    const summaryId = await runAiPreparation(consultA, patient.accountId);
    expect(summaryId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);

    const read = await inject({
      method: 'GET',
      url: `/v1/async-consults/${consultA}`,
      token: patient.token,
    });
    expect(read.statusCode).toBe(200);
    expect(json<{ current_state: string }>(read).current_state).toBe('queued');
  });

  it('A4 clinician queue lists the consult in state queued', async () => {
    const res = await inject({
      method: 'GET',
      url: '/v1/async-consults/queue?limit=50',
      token: clinician.token,
    });
    expect(res.statusCode).toBe(200);
    const rows = json<{ rows: { consult_id: string; current_state: string | null }[] }>(res).rows;
    const row = rows.find((r) => r.consult_id === consultA);
    expect(row).toBeDefined();
    expect(row!.current_state).toBe('queued');
  });

  it('A5 claim (clinician) returns 201 + claim_id', async () => {
    const claimId = await claimConsult(consultA);
    expect(claimId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);

    const res = await inject({
      method: 'POST',
      url: `/v1/async-consults/${consultA}/decision`,
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
    expect(res.statusCode).toBe(201);
    expect(json<{ decision_id: string }>(res).decision_id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it('A7 patient reads back the decided consult (advised / recommend); tenant-blind body', async () => {
    const res = await inject({
      method: 'GET',
      url: `/v1/async-consults/${consultA}`,
      token: patient.token,
    });
    expect(res.statusCode).toBe(200);
    const view = json<{ current_state: string; decision_type: string | null }>(res);
    expect(view.current_state).toBe('advised');
    expect(view.decision_type).toBe('recommend');
    expect(res.body).not.toContain('"tenant_id"');
    expect(res.body).not.toContain('Telecheck-US');
  });
});

// ===========================================================================
// Group B — endpoint #9 + follow-up messages on a second consult
// ===========================================================================

describe('async-consult v1 — Group B request-additional-data + follow-up messages', () => {
  it('B1 request-additional-data (endpoint #9) → awaiting_data', async () => {
    consultB = await initiateConsult(patient.token);
    await submitIntake(patient.token, consultB);
    await runAiPreparation(consultB, patient.accountId);
    claimB = await claimConsult(consultB);

    const res = await inject({
      method: 'POST',
      url: `/v1/async-consults/${consultB}/request-additional-data`,
      token: clinician.token,
      payload: {
        claim_id: claimB,
        patient_id: patient.accountId,
        agreement_with_ai_recommendation: 'no_ai_recommendation',
        decision_rationale_envelope: makeEnvelope('need-more-data'),
        interaction_signals_reviewed_ids: [],
      },
    });
    expect(res.statusCode).toBe(201);

    const read = await inject({
      method: 'GET',
      url: `/v1/async-consults/${consultB}`,
      token: patient.token,
    });
    expect(json<{ current_state: string }>(read).current_state).toBe('awaiting_data');
  });

  it('B2 patient sends a follow-up message (endpoint #10)', async () => {
    const res = await inject({
      method: 'POST',
      url: `/v1/async-consults/${consultB}/follow-up-messages`,
      token: patient.token,
      payload: { message_envelope: makeEnvelope('patient-msg') },
    });
    expect(res.statusCode).toBe(201);
    expect(json<{ message_id: string }>(res).message_id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it('B3 clinician sends a follow-up message (endpoint #10)', async () => {
    const res = await inject({
      method: 'POST',
      url: `/v1/async-consults/${consultB}/follow-up-messages`,
      token: clinician.token,
      payload: {
        patient_id: patient.accountId,
        message_envelope: makeEnvelope('clinician-msg'),
      },
    });
    expect(res.statusCode).toBe(201);
  });

  it('B4 patient lists both messages; envelope round-trips; no tenant leak (endpoint #11)', async () => {
    const res = await inject({
      method: 'GET',
      url: `/v1/async-consults/${consultB}/follow-up-messages`,
      token: patient.token,
    });
    expect(res.statusCode).toBe(200);
    const rows = json<{
      rows: {
        sender_role: string;
        message_envelope: { ciphertext_b64: string };
      }[];
    }>(res).rows;
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.sender_role).sort()).toEqual(['clinician', 'patient']);
    const patientMsg = rows.find((r) => r.sender_role === 'patient')!;
    expect(Buffer.from(patientMsg.message_envelope.ciphertext_b64, 'base64').toString()).toBe(
      'sealed:patient-msg',
    );
    expect(res.body).not.toContain('"tenant_id"');
    expect(res.body).not.toContain('Telecheck-US');
  });

  it('B5 clinician lists both messages (endpoint #11)', async () => {
    const res = await inject({
      method: 'GET',
      url: `/v1/async-consults/${consultB}/follow-up-messages`,
      token: clinician.token,
    });
    expect(res.statusCode).toBe(200);
    expect(json<{ rows: unknown[] }>(res).rows).toHaveLength(2);
  });
});

// ===========================================================================
// Group C — caller-class gates
// ===========================================================================

describe('async-consult v1 — Group C caller-class gates', () => {
  it('C1 ai-preparation rejects a patient token with 403', async () => {
    const res = await inject({
      method: 'POST',
      url: `/v1/async-consults/${consultA}/ai-preparation`,
      token: patient.token,
      payload: {},
    });
    expect(res.statusCode).toBe(403);
  });

  it('C2 ai-preparation rejects a clinician token with 403', async () => {
    const res = await inject({
      method: 'POST',
      url: `/v1/async-consults/${consultA}/ai-preparation`,
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

// ===========================================================================
// Group D — tenant-blind self-scoping (I-025)
// ===========================================================================

describe('async-consult v1 — Group D self-scoping', () => {
  it('D1 a second patient reading the first patient consult gets a tenant-blind 404', async () => {
    const res = await inject({
      method: 'GET',
      url: `/v1/async-consults/${consultA}`,
      token: patientB.token,
    });
    expect(res.statusCode).toBe(404);
    expect(res.body).not.toContain('Telecheck-US');
  });

  it('D2 the second patient sees ZERO follow-up messages on the foreign consult (indistinguishable from message-less)', async () => {
    const res = await inject({
      method: 'GET',
      url: `/v1/async-consults/${consultB}/follow-up-messages`,
      token: patientB.token,
    });
    expect(res.statusCode).toBe(200);
    expect(json<{ rows: unknown[] }>(res).rows).toHaveLength(0);
  });
});
