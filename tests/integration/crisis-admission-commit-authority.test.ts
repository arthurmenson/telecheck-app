/**
 * crisis-admission-commit-authority.test.ts — the COMMIT-time authority gate.
 *
 * Reproduces, and pins the fix for, the clinical v1 review finding: a patient
 * crisis admission could be COMMITTED after its actor nonce had expired.
 *
 * ## Why this test owns a real connection
 *
 * The shared harness client (tests/setup.ts) wraps every test in an outer
 * BEGIN + SAVEPOINT and translates the app's BEGIN/COMMIT into savepoints. A
 * DEFERRABLE INITIALLY DEFERRED constraint trigger fires only at a REAL
 * COMMIT — never at RELEASE SAVEPOINT — so on that client the property under
 * test is invisible: the admission would look committed whether or not the
 * trigger ran. This file therefore opens its own pool on TEST_DATABASE_URL,
 * commits its own fixtures, and hands `admitPatientCareInput` a caller-owned
 * connection via the test-only `connection` field.
 *
 * ## How expiry is forced inside the window
 *
 * The nonce is bound with a 1-second TTL. The connection handed to the
 * admission is a thin proxy whose `query` sleeps 1.3 s when — and only when —
 * the statement is `COMMIT`. Every app-side `assertPatient` has already
 * passed by then; the sleep lands precisely in the gap between the last
 * app-side check and the actual COMMIT, which is the gap the defect lived in.
 * `kms_current_actor_context()` compares `expires_at` against
 * `clock_timestamp()`, so at COMMIT the deferred `crisis_care_evidence`
 * trigger's call to `crisis_care_live_patient()` sees an expired binding and
 * raises PT401 from the COMMIT statement itself.
 *
 * ## What "fixed" means, concretely
 *
 *   - expired-at-COMMIT → the admission REJECTS with 401, and NO
 *     crisis_event / crisis_care_admission row exists for that patient.
 *   - the same path with a live nonce and no delay → recorded, one row.
 *
 * Rows committed here are not covered by the per-test savepoint rollback.
 * The CI database is ephemeral per run, and audit_records is append-only
 * (I-003) so it must not be cleaned up anyway; account/session fixtures use
 * fresh ULIDs per run.
 */

import { randomBytes } from 'node:crypto';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { bindActorContextForRequest } from '../../src/lib/actor-context-binding.ts';
import type { DbClient } from '../../src/lib/db.ts';
import type { TenantContext } from '../../src/lib/tenant-context.ts';
import { ulid } from '../../src/lib/ulid.ts';
import { admitPatientCareInput } from '../../src/modules/crisis-response/index.ts';
import { configureBindRole } from '../helpers/configure-bind-role.ts';
import { TENANT_US } from '../helpers/tenant-fixtures.ts';

const BIND_ROLE_TEST_PASSWORD = 'telecheck_test_bind_pw';
const NONCE_TTL_SECONDS = 1;
const COMMIT_DELAY_MS = 1_300;

const tenant = { tenantId: TENANT_US, countryOfCare: 'US' } as unknown as TenantContext;

let admin: pg.Pool;
let bindPool: pg.Pool;

/** Seed an active patient + live session, COMMITTED, visible to any connection. */
async function seedPatientWithSession(): Promise<{ accountId: string; sessionId: string }> {
  const accountId = ulid();
  const sessionId = ulid();
  const phone =
    '+1' +
    String(BigInt('0x' + randomBytes(6).toString('hex')) % 10_000_000_000n).padStart(10, '0');
  const c = await admin.connect();
  try {
    await c.query('BEGIN');
    await c.query('SELECT set_tenant_context($1)', [TENANT_US]);
    await c.query(
      `INSERT INTO accounts (account_id, tenant_id, phone_e164, first_name, last_name, date_of_birth,
         gender, country_of_residence, country_of_care, account_type, status, cohort_classification)
       VALUES ($1,$2,$3,'Synthetic','CommitGate','1990-01-01','prefer_not_to_say','US','US','patient','active','baseline')`,
      [accountId, TENANT_US, phone],
    );
    await c.query(
      `INSERT INTO sessions (session_id, tenant_id, account_id, refresh_token_hash, expires_at)
       VALUES ($1,$2,$3,$4, clock_timestamp() + INTERVAL '1 hour')`,
      [sessionId, TENANT_US, accountId, randomBytes(32).toString('hex')],
    );
    await c.query('SELECT clear_tenant_context()');
    await c.query('COMMIT');
  } catch (error) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    c.release();
  }
  return { accountId, sessionId };
}

/** Bind an SI-010 actor nonce as the bind role, with an explicit TTL. */
async function bindNonce(
  accountId: string,
  sessionId: string,
  ttlSeconds: number,
): Promise<string> {
  const binder = await bindPool.connect();
  try {
    const bound = await bindActorContextForRequest(binder as unknown as DbClient, {
      actorAccountId: accountId,
      actorAccountTenantId: TENANT_US,
      actorRole: 'patient',
      actorAdminHomeTenantId: null,
      sessionId,
      ttlSeconds,
    });
    return bound.nonce;
  } finally {
    binder.release();
  }
}

/**
 * A real connection whose `COMMIT` is delayed. Every other statement passes
 * straight through, so all app-side checks run at full speed; only the final
 * COMMIT waits — which is exactly where the defect's window was.
 */
function withDelayedCommit(client: pg.PoolClient, delayMs: number): DbClient {
  return {
    query: async (text: string, values?: readonly unknown[]) => {
      if (delayMs > 0 && text.trim().toUpperCase() === 'COMMIT') {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
      return client.query(text, values as unknown[]);
    },
    release: () => undefined,
  } as unknown as DbClient;
}

async function admissionRowCount(
  accountId: string,
): Promise<{ events: number; admissions: number }> {
  const c = await admin.connect();
  try {
    await c.query('SELECT set_tenant_context($1)', [TENANT_US]);
    const events = await c.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM crisis_event WHERE tenant_id=$1 AND patient_account_id=$2',
      [TENANT_US, accountId],
    );
    const admissions = await c.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM crisis_care_admission WHERE tenant_id=$1 AND patient_account_id=$2',
      [TENANT_US, accountId],
    );
    await c.query('SELECT clear_tenant_context()');
    return {
      events: Number(events.rows[0]?.n ?? 0),
      admissions: Number(admissions.rows[0]?.n ?? 0),
    };
  } finally {
    c.release();
  }
}

async function runAdmission(
  accountId: string,
  sessionId: string,
  nonce: string,
  commitDelayMs: number,
): Promise<ReturnType<typeof admitPatientCareInput>> {
  const c = await admin.connect();
  try {
    // The caller-owned connection also owns the tenant binding — the
    // externalTx path of withTenantBoundConnection deliberately skips it.
    await c.query('SELECT set_tenant_context($1)', [TENANT_US]);
    return await admitPatientCareInput(
      {
        tenant,
        accountId,
        sessionId,
        actorNonce: nonce,
        idempotencyKey: `commit-gate-${ulid()}`,
        connection: withDelayedCommit(c, commitDelayMs),
      },
      'I want to die',
      'messaging',
    );
  } finally {
    await c.query('SELECT clear_tenant_context()').catch(() => undefined);
    c.release();
  }
}

beforeAll(async () => {
  process.env['NODE_ENV'] = 'test';
  const url = process.env['TEST_DATABASE_URL'] as string;
  admin = new pg.Pool({ connectionString: url, max: 3 });

  // Same bind-role provisioning the v1 HTTP suite performs: the bind role is
  // created LOGIN without credentials by migration 031; give it a suite-local
  // password and open a pool whose session_user is that role.
  const superuser = await admin.connect();
  try {
    await configureBindRole(superuser as unknown as DbClient, BIND_ROLE_TEST_PASSWORD);
  } finally {
    superuser.release();
  }
  const bindUrl = new URL(url);
  bindUrl.username = 'bind_actor_context_role';
  bindUrl.password = BIND_ROLE_TEST_PASSWORD;
  bindPool = new pg.Pool({ connectionString: bindUrl.toString(), max: 2 });
});

afterAll(async () => {
  await bindPool?.end().catch(() => undefined);
  await admin?.end().catch(() => undefined);
});

describe('crisis admission — authority is enforced at the actual COMMIT', () => {
  it('rejects an admission whose nonce expired between the last app-side check and COMMIT', async () => {
    const { accountId, sessionId } = await seedPatientWithSession();
    const nonce = await bindNonce(accountId, sessionId, NONCE_TTL_SECONDS);

    await expect(runAdmission(accountId, sessionId, nonce, COMMIT_DELAY_MS)).rejects.toMatchObject({
      code: 'PT401',
      statusCode: 401,
    });

    // The transaction rolled back at COMMIT: nothing was recorded under
    // expired authority. This is the assertion the defect violated.
    expect(await admissionRowCount(accountId)).toEqual({ events: 0, admissions: 0 });
  }, 20_000);

  it('records the admission when the nonce is still live at COMMIT (positive control)', async () => {
    const { accountId, sessionId } = await seedPatientWithSession();
    const nonce = await bindNonce(accountId, sessionId, 300);

    const result = await runAdmission(accountId, sessionId, nonce, 0);

    expect(result).toMatchObject({
      kind: 'crisis_interruption',
      recording_status: 'recorded',
      escalation_status: 'pending',
    });
    expect(await admissionRowCount(accountId)).toEqual({ events: 1, admissions: 1 });
  }, 20_000);
});
