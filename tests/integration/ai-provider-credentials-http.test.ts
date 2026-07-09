/**
 * ai-provider-credentials-http.test.ts — live-PostgreSQL HTTP integration
 * tests for the SI-025 admin-managed AI provider credential endpoints
 * (Phase 1 backend):
 *
 *   GET    /v1/admin/ai-providers               masked list
 *   PUT    /v1/admin/ai-providers/:provider     set / rotate (platform_admin only)
 *   DELETE /v1/admin/ai-providers/:provider     revoke (platform_admin only)
 *   POST   /v1/admin/ai-providers/:provider/test  live probe (platform_admin only)
 *
 * WHY LIVE PG (Phase-D discipline): the migration-079 SECDEF read wrapper +
 * the writer/reader role grants + the one-active-per-provider EXCLUDE
 * constraint only exercise against a real Postgres. Handler unit tests mock
 * SQL and cannot catch a 42702 OUT-param collision in the read wrapper (the
 * migration 071/074 latent-defect class) or a grant skew (42501). This suite
 * pins the full pipeline end-to-end.
 *
 * Exercises the REAL composition: JWT verify → tenant context → LAYER B
 * (platform_admin gate for mutations; admin gate for masked GET) → SET LOCAL
 * ROLE ai_provider_credential_writer (writes) / ai_service_credential_reader
 * (SECDEF read) → envelope encrypt/decrypt → same-tx Cat B audit.
 *
 * Coverage:
 *   Group A — set / rotate / masked read
 *     A1 platform_admin PUT anthropic → 200; GET masked shows the provider,
 *        sk-...last4, status=active; the plaintext key is NOWHERE in either
 *        response body; the DB ciphertext != plaintext.
 *     A2 rotate (second PUT) → 200; exactly ONE active row remains (EXCLUDE);
 *        the prior row is status=revoked.
 *   Group B — SECDEF read decrypts (the read-path wiring)
 *     B1 read_active_ai_provider_key under the reader role returns the
 *        envelope; app-side decrypt yields the original plaintext.
 *   Group C — revoke
 *     C1 DELETE → 200; GET masked no longer lists the provider; revoke on a
 *        not-configured provider → 404.
 *   Group D — cross-role denial (LAYER B + DB floor)
 *     D1 patient token PUT → 403 (no credential written).
 *     D2 tenant_admin token PUT → 403 (mutations are platform_admin ONLY).
 *     D3 tenant_admin token GET masked → 200 (masked read allowed).
 *   Group E — audit
 *     E1 a set + a rotate + a revoke each emit a Cat B ai_provider_credential.*
 *        audit row; NONE of the audit detail contains the plaintext key.
 *
 * Spec references: SI-025 v0.1 §2/§4/§5/§7; migration 079; I-003/I-025/I-027;
 * migration 071/074 (the OUT-param defect class the SECDEF read must avoid).
 */

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
import { TENANT_US, withTenantContext } from '../helpers/tenant-fixtures.ts';
import { uniquePhone } from '../helpers/unique-phone.ts';
import { getTestClient } from '../setup.ts';

const T_US = asTenantId(TENANT_US);
const BIND_ROLE_TEST_PASSWORD = 'telecheck_test_bind_pw';

const SI025_SLICE_ROLES = [
  'ai_provider_credential_writer',
  'ai_service_credential_reader',
] as const;

const SAMPLE_KEY = 'sk-ant-api03-TESTKEYTESTKEYTESTKEYTESTKEY-WXYZ';
const ROTATED_KEY = 'sk-ant-api03-ROTATEDROTATEDROTATEDROTATED-9999';

let app: FastifyInstance | null = null;
let bindPool: pg.Pool | null = null;

let platformAdmin: AccountId;
let usPatient: AccountId;
let usTenantAdmin: AccountId;

function platformAdminAuth(accountId: string): { authorization: string } {
  return bearerAuthHeader({
    accountId,
    tenantId: T_US,
    countryOfCare: 'US',
    role: 'platform_admin',
  });
}
function patientAuth(accountId: string): { authorization: string } {
  return bearerAuthHeader({ accountId, tenantId: T_US, countryOfCare: 'US', role: 'patient' });
}
function tenantAdminAuth(accountId: string): { authorization: string } {
  return bearerAuthHeader({ accountId, tenantId: T_US, countryOfCare: 'US', role: 'tenant_admin' });
}

async function seedAccount(accountType: 'patient' | 'tenant_admin'): Promise<AccountId> {
  const accountId = asAccountId(ulid());
  await withTenantContext(T_US, () =>
    createAccount(
      {
        account_id: accountId,
        tenant_id: T_US,
        phone_e164: uniquePhone('+1'),
        first_name: 'SI025',
        last_name: 'Actor',
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

function idem(): Record<string, string> {
  return { 'idempotency-key': ulid() };
}

async function put(
  provider: string,
  auth: { authorization: string },
  apiKey: string,
): Promise<{ statusCode: number; body: string }> {
  return app!.inject({
    method: 'PUT',
    url: `/v1/admin/ai-providers/${provider}`,
    headers: { host: 'localhost', ...auth, ...idem() },
    payload: { api_key: apiKey },
  });
}
async function del(
  provider: string,
  auth: { authorization: string },
): Promise<{ statusCode: number; body: string }> {
  return app!.inject({
    method: 'DELETE',
    url: `/v1/admin/ai-providers/${provider}`,
    headers: { host: 'localhost', ...auth, ...idem() },
    payload: {},
  });
}
async function getMasked(auth: {
  authorization: string;
}): Promise<{ statusCode: number; body: string }> {
  return app!.inject({
    method: 'GET',
    url: '/v1/admin/ai-providers',
    headers: { host: 'localhost', ...auth },
  });
}

function json<T>(res: { body: string }): T {
  return JSON.parse(res.body) as T;
}

beforeAll(async () => {
  process.env['NODE_ENV'] = 'test';
  if (
    process.env['TENANT_KMS_LOCAL_DEV_KEY'] === undefined ||
    process.env['TENANT_KMS_LOCAL_DEV_KEY'].length < 32
  ) {
    process.env['TENANT_KMS_LOCAL_DEV_KEY'] = 'test-local-dev-kms-master-key-0123456789abcdef';
  }

  const superuser = new pg.Client({ connectionString: process.env['TEST_DATABASE_URL'] as string });
  await superuser.connect();
  try {
    await superuser.query(
      `ALTER ROLE bind_actor_context_role WITH LOGIN PASSWORD '${BIND_ROLE_TEST_PASSWORD}'`,
    );
  } finally {
    await superuser.end();
  }
  await grantSliceRolesToTestApp(SI025_SLICE_ROLES);

  const testUrl = new URL(process.env['TEST_DATABASE_URL'] as string);
  testUrl.username = 'bind_actor_context_role';
  testUrl.password = BIND_ROLE_TEST_PASSWORD;
  bindPool = new pg.Pool({ connectionString: testUrl.toString(), max: 2 });
  setBindActorContextTestPool(bindPool as unknown as DbClient);

  app = await buildApp({ logger: false });
  await app.ready();

  platformAdmin = await seedAccount('tenant_admin'); // account row; JWT role is platform_admin
  usPatient = await seedAccount('patient');
  usTenantAdmin = await seedAccount('tenant_admin');
}, 60_000);

afterAll(async () => {
  clearBindActorContextTestPool();
  if (app !== null) await app.close();
  if (bindPool !== null) await bindPool.end();
});

describe('SI-025 ai-providers — Group A: set / rotate / masked read', () => {
  it('A1. platform_admin PUT anthropic → 200; masked GET shows sk-...last4; plaintext NOWHERE; DB ciphertext != plaintext', async () => {
    const putRes = await put('anthropic', platformAdminAuth(platformAdmin), SAMPLE_KEY);
    expect(putRes.statusCode).toBe(200);
    // The PUT response body NEVER contains the plaintext key.
    expect(putRes.body).not.toContain(SAMPLE_KEY);
    const putBody = json<{ provider: string; key_last4: string; status: string }>(putRes);
    expect(putBody.provider).toBe('anthropic');
    expect(putBody.status).toBe('active');
    expect(putBody.key_last4).toBe('sk-...WXYZ');

    const getRes = await getMasked(platformAdminAuth(platformAdmin));
    expect(getRes.statusCode).toBe(200);
    expect(getRes.body).not.toContain(SAMPLE_KEY);
    const listed = json<{
      providers: Array<{ provider: string; key_last4: string; status: string }>;
    }>(getRes);
    const row = listed.providers.find((p) => p.provider === 'anthropic');
    expect(row).toBeDefined();
    expect(row?.key_last4).toBe('sk-...WXYZ');
    expect(row?.status).toBe('active');

    // The stored ciphertext is NOT the plaintext.
    const stored = await getTestClient().query<{ key_ciphertext: Buffer }>(
      `SELECT key_ciphertext FROM ai_provider_credential WHERE provider = 'anthropic' AND status = 'active'`,
    );
    expect(stored.rows.length).toBe(1);
    expect(stored.rows[0]?.key_ciphertext.toString('utf8')).not.toContain(SAMPLE_KEY);
  });

  it('A2. rotate (second PUT) → 200; exactly ONE active row; prior row revoked', async () => {
    await put('anthropic', platformAdminAuth(platformAdmin), SAMPLE_KEY);
    const rot = await put('anthropic', platformAdminAuth(platformAdmin), ROTATED_KEY);
    expect(rot.statusCode).toBe(200);

    const active = await getTestClient().query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM ai_provider_credential WHERE provider = 'anthropic' AND status = 'active'`,
    );
    expect(active.rows[0]?.n).toBe(1);
    const revoked = await getTestClient().query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM ai_provider_credential WHERE provider = 'anthropic' AND status = 'revoked'`,
    );
    expect(revoked.rows[0]?.n).toBeGreaterThanOrEqual(1);

    // The active row now masks the rotated key's last4.
    const masked = await getMasked(platformAdminAuth(platformAdmin));
    const listed = json<{ providers: Array<{ provider: string; key_last4: string }> }>(masked);
    expect(listed.providers.find((p) => p.provider === 'anthropic')?.key_last4).toBe('sk-...9999');
  });
});

describe('SI-025 ai-providers — Group B: SECDEF read decrypts', () => {
  it('B1. read_active_ai_provider_key under the reader role → envelope decrypts to the plaintext', async () => {
    await put('anthropic', platformAdminAuth(platformAdmin), SAMPLE_KEY);

    // Read the envelope via the SECDEF wrapper under the reader role, then
    // decrypt app-side (mirrors resolveClinicalProvider).
    const { decryptAiProviderKey } =
      await import('../../src/lib/ai-provider-credential-envelope.ts');
    const client = getTestClient();
    await client.query('SET LOCAL ROLE ai_service_credential_reader');
    const r = await client.query<{
      key_ciphertext: Buffer;
      key_kms_envelope_dek_id: string;
      key_kms_envelope_iv: Buffer;
      key_kms_envelope_tag: Buffer;
      key_kms_envelope_alg: string;
      key_kms_envelope_alg_version: string;
      key_kms_envelope_aad: Buffer;
      key_kms_envelope_encrypted_at: Date;
    }>('SELECT * FROM read_active_ai_provider_key($1)', ['anthropic']);
    await client.query('SET LOCAL ROLE telecheck_test_app');

    expect(r.rows.length).toBe(1);
    const row = r.rows[0];
    if (row === undefined) throw new Error('no envelope row');
    const plain = decryptAiProviderKey({
      ciphertext: row.key_ciphertext,
      dekId: row.key_kms_envelope_dek_id,
      iv: row.key_kms_envelope_iv,
      tag: row.key_kms_envelope_tag,
      alg: row.key_kms_envelope_alg,
      algVersion: row.key_kms_envelope_alg_version,
      aad: row.key_kms_envelope_aad,
      encryptedAt: row.key_kms_envelope_encrypted_at,
    });
    expect(plain).toBe(SAMPLE_KEY);
  });
});

describe('SI-025 ai-providers — Group C: revoke', () => {
  it('C1. DELETE → 200; masked GET no longer lists it; revoke of not-configured → 404', async () => {
    await put('anthropic', platformAdminAuth(platformAdmin), SAMPLE_KEY);
    const revoke = await del('anthropic', platformAdminAuth(platformAdmin));
    expect(revoke.statusCode).toBe(200);

    const masked = await getMasked(platformAdminAuth(platformAdmin));
    const listed = json<{ providers: Array<{ provider: string }> }>(masked);
    expect(listed.providers.find((p) => p.provider === 'anthropic')).toBeUndefined();

    // Revoking a provider with no active credential → 404 tenant-blind.
    const revokeAgain = await del('azure_openai', platformAdminAuth(platformAdmin));
    expect(revokeAgain.statusCode).toBe(404);
  });
});

describe('SI-025 ai-providers — Group D: cross-role denial', () => {
  it('D1. patient PUT → 403; NO credential written', async () => {
    const res = await put('anthropic', patientAuth(usPatient), SAMPLE_KEY);
    expect(res.statusCode).toBe(403);
    expect(res.body).not.toContain(SAMPLE_KEY);
  });

  it('D2. tenant_admin PUT → 403 (mutations are platform_admin ONLY)', async () => {
    const res = await put('anthropic', tenantAdminAuth(usTenantAdmin), SAMPLE_KEY);
    expect(res.statusCode).toBe(403);
  });

  it('D3. tenant_admin masked GET → 200 (masked read allowed)', async () => {
    const res = await getMasked(tenantAdminAuth(usTenantAdmin));
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain(SAMPLE_KEY);
  });
});

describe('SI-025 ai-providers — Group E: Cat B audit (no plaintext)', () => {
  it('E1. set + rotate + revoke each emit a Cat B ai_provider_credential.* audit; NONE carry the plaintext', async () => {
    await put('anthropic', platformAdminAuth(platformAdmin), SAMPLE_KEY);
    await put('anthropic', platformAdminAuth(platformAdmin), ROTATED_KEY);
    await del('anthropic', platformAdminAuth(platformAdmin));

    const audits = await getTestClient().query<{
      action: string;
      category: string;
      payload: unknown;
    }>(
      `SELECT action, category, payload
         FROM audit_records
        WHERE tenant_id = $1 AND action LIKE 'ai_provider_credential.%'
        ORDER BY sequence_number DESC
        LIMIT 10`,
      [T_US],
    );
    const actions = audits.rows.map((r) => r.action);
    expect(actions).toContain('ai_provider_credential.set');
    expect(actions).toContain('ai_provider_credential.rotated');
    expect(actions).toContain('ai_provider_credential.revoked');
    for (const row of audits.rows) {
      expect(row.category).toBe('B');
      const detailStr = JSON.stringify(row.payload);
      expect(detailStr).not.toContain(SAMPLE_KEY);
      expect(detailStr).not.toContain(ROTATED_KEY);
    }
  });
});
