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
 * ## How expiry is forced inside the window — deterministically
 *
 * The nonce is bound with a generous 300-second TTL so that no app-side
 * `assertPatient` can pre-empt the case. The connection handed to the
 * admission is a thin proxy that intercepts the `COMMIT` statement and, at
 * that boundary and no earlier, expires the binding row directly
 * (`_session_actor_context.expires_at` moved into the past on a separate
 * connection, autocommitted, hence visible under READ COMMITTED). Every
 * app-side check has already passed by then; the expiry lands precisely in
 * the gap between the last app-side check and the actual COMMIT — the gap
 * the defect lived in. `kms_current_actor_context()` compares `expires_at`
 * against `clock_timestamp()`, so the deferred `crisis_care_evidence`
 * trigger's call to `crisis_care_live_patient()` sees an expired binding and
 * raises PT401 from the COMMIT statement itself.
 *
 * The test asserts that the interception happened AND that the raw
 * PostgreSQL COMMIT rejected with PT401, so it cannot pass via an app-side
 * rejection that never reached COMMIT (Codex finding on PR #302: a
 * sleep-based TTL race allowed exactly that).
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
const LIVE_NONCE_TTL_SECONDS = 300;

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

/** Expire a bound nonce NOW, from a separate autocommitting connection. */
async function expireNonce(nonce: string): Promise<void> {
  const c = await admin.connect();
  try {
    const r = await c.query(
      "UPDATE _session_actor_context SET expires_at = clock_timestamp() - INTERVAL '1 second' WHERE nonce = $1::uuid",
      [nonce],
    );
    if (r.rowCount !== 1) throw new Error(`expireNonce: expected 1 row, updated ${r.rowCount}`);
  } finally {
    c.release();
  }
}

interface CommitInterception {
  intercepted: boolean;
  /** The raw rejection from the underlying PostgreSQL COMMIT, if any. */
  commitError: unknown;
}

/**
 * A real connection whose `COMMIT` is intercepted. Every other statement
 * passes straight through, so all app-side checks run at full speed. At the
 * COMMIT boundary — and no earlier — `onCommit` runs, then the real COMMIT is
 * forwarded and its raw outcome recorded, so the test can prove the deferred
 * trigger was what rejected the transaction.
 */
function withCommitInterceptor(
  client: pg.PoolClient,
  onCommit: () => Promise<void>,
  record: CommitInterception,
): DbClient {
  return {
    query: async (text: string, values?: readonly unknown[]) => {
      if (text.trim().toUpperCase() === 'COMMIT') {
        record.intercepted = true;
        await onCommit();
        try {
          return await client.query(text, values as unknown[]);
        } catch (error) {
          record.commitError = error;
          throw error;
        }
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
  onCommit: () => Promise<void>,
  record: CommitInterception,
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
        connection: withCommitInterceptor(c, onCommit, record),
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
  it('rejects an admission whose nonce expires at the COMMIT boundary — proven at the real COMMIT', async () => {
    const { accountId, sessionId } = await seedPatientWithSession();
    const nonce = await bindNonce(accountId, sessionId, LIVE_NONCE_TTL_SECONDS);
    const record: CommitInterception = { intercepted: false, commitError: null };

    await expect(
      runAdmission(accountId, sessionId, nonce, () => expireNonce(nonce), record),
    ).rejects.toMatchObject({ code: 'PT401', statusCode: 401 });

    // The rejection must have come from the DEFERRED TRIGGER AT COMMIT,
    // not from an app-side assertPatient that happened to run late.
    expect(record.intercepted).toBe(true);
    expect(record.commitError).toMatchObject({ code: 'PT401' });

    // The transaction rolled back at COMMIT: nothing was recorded under
    // expired authority. This is the assertion the defect violated.
    expect(await admissionRowCount(accountId)).toEqual({ events: 0, admissions: 0 });
  }, 20_000);

  it('records the admission when the nonce is still live at COMMIT (positive control)', async () => {
    const { accountId, sessionId } = await seedPatientWithSession();
    const nonce = await bindNonce(accountId, sessionId, LIVE_NONCE_TTL_SECONDS);
    const record: CommitInterception = { intercepted: false, commitError: null };

    const result = await runAdmission(accountId, sessionId, nonce, async () => undefined, record);

    expect(record.intercepted).toBe(true);
    expect(record.commitError).toBeNull();
    expect(result).toMatchObject({
      kind: 'crisis_interruption',
      recording_status: 'recorded',
      escalation_status: 'pending',
    });
    expect(await admissionRowCount(accountId)).toEqual({ events: 1, admissions: 1 });
  }, 20_000);
});
