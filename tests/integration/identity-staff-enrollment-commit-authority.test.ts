/**
 * identity-staff-enrollment-commit-authority.test.ts
 *
 * Proves, against a real PostgreSQL and the real identity_service_role, that
 * staff-enrollment operator authority is enforced at the ACTUAL COMMIT — the
 * fifth site of the deferred-authority-trigger defect class (PR #308), on the
 * shared primitive (PR #306/#309). Codex's follow-up recommendation on #308:
 * expire the nonce after the final application check, require PT401 from the
 * actual COMMIT, verify account / enrollment / evidence rollback, and include
 * a live-authority positive control.
 *
 * ## Why this test owns a real connection
 *
 * The shared harness wraps each test in BEGIN + SAVEPOINT and translates the
 * app's BEGIN/COMMIT into savepoints, so a DEFERRABLE INITIALLY DEFERRED
 * trigger never fires there. This test uses its own pools: an admin pool
 * (TEST_DATABASE_URL) for seeding and inspection, the bind pool as
 * bind_actor_context_role for the nonce, and an identity pool logged in as
 * identity_service_role — the role the handler really runs under — for the
 * write. The write goes through the primitive's caller-owned client path with
 * the handler's exact `staffAuthority(ctx)`, and the connection's COMMIT is
 * intercepted so the nonce can be expired after the last application-side
 * check and before the server's deferred trigger runs.
 */

import { randomBytes } from 'node:crypto';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { bindActorContextForRequest } from '../../src/lib/actor-context-binding.ts';
import { commitAuthorityTransaction } from '../../src/lib/commit-authority-transaction.ts';
import type { DbClient, DbTransaction } from '../../src/lib/db.ts';
import type { TenantContext } from '../../src/lib/tenant-context.ts';
import { ulid } from '../../src/lib/ulid.ts';
import {
  staffAuthority,
  type StaffContext,
} from '../../src/modules/identity/internal/handlers/staff-enrollment.ts';
import { StaffEnrollmentReceiptSchema } from '../../src/modules/identity/internal/services/staff-contract.ts';
import { emitStaffEvidence } from '../../src/modules/identity/internal/services/staff-evidence.ts';
import { configureBindRole } from '../helpers/configure-bind-role.ts';

const BIND_ROLE_TEST_PASSWORD = 'telecheck_test_bind_pw';
const IDENTITY_ROLE_TEST_PASSWORD = 'telecheck_test_identity_pw';
const LIVE_NONCE_TTL_SECONDS = 300;

/**
 * A dedicated tenant, committed once per file run. The positive control below
 * COMMITS an enrollment — and with it an audit row and an outbox row — outside
 * the harness rollback. In Telecheck-US that row would be counted by
 * audit-chain-walker.test.ts (Codex R1 on PR #310), so nothing here touches a
 * shared tenant. Append-only audit evidence stays intact inside this tenant.
 */
let tenantId = '';
let tenant: TenantContext;

let admin: pg.Pool;
let bindPool: pg.Pool;
let identityPool: pg.Pool;

function syntheticPhone(): string {
  return (
    '+1' + String(BigInt('0x' + randomBytes(6).toString('hex')) % 10_000_000_000n).padStart(10, '0')
  );
}

function randomLetters(n: number): string {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ';
  return Array.from(randomBytes(n), (b) => alphabet[b % alphabet.length]).join('');
}

/** Commit a uniquely named tenant (letters only, `Telecheck-T…`, like the shared fixture) through the admin pool. */
async function seedTenant(): Promise<string> {
  const suffix = randomLetters(4);
  const id = `Telecheck-TI${suffix}`;
  const c = await admin.connect();
  try {
    await c.query(
      `INSERT INTO tenants (id, display_name, consumer_dba, legal_entity, consumer_subdomain,
         country_of_care, kms_key_alias, status, activated_at)
       VALUES ($1,$1,$2,$3,$4,'US',$5,'active',NOW())`,
      [
        id,
        `Heros Health Test ${suffix}`,
        `Telecheck Test ${suffix} Inc.`,
        `test-${suffix.toLowerCase()}.heroshealth.com`,
        `alias/telecheck-test-${suffix.toLowerCase()}-data-key`,
      ],
    );
  } finally {
    c.release();
  }
  return id;
}

/** Seed an active tenant_admin with a live clinician_enroller membership and a session, COMMITTED. */
async function seedOperator(): Promise<{ accountId: string; sessionId: string }> {
  const accountId = ulid();
  const sessionId = ulid();
  const c = await admin.connect();
  try {
    await c.query('BEGIN');
    await c.query('SELECT set_tenant_context($1)', [tenantId]);
    await c.query(
      `INSERT INTO accounts (account_id, tenant_id, phone_e164, first_name, last_name, date_of_birth,
         gender, country_of_residence, country_of_care, account_type, status, cohort_classification)
       VALUES ($1,$2,$3,'Synthetic','Enroller','1985-01-01','prefer_not_to_say','US','US','tenant_admin','active','baseline')`,
      [accountId, tenantId, syntheticPhone()],
    );
    await c.query(
      `INSERT INTO identity_staff_membership (tenant_id, account_id, capability, granted_by, evidence_sha256, provisioning_reference)
       VALUES ($1,$2,'clinician_enroller',$2,$3,$4)`,
      [tenantId, accountId, randomBytes(32).toString('hex'), `synthetic-provisioning-${accountId}`],
    );
    await c.query(
      `INSERT INTO sessions (session_id, tenant_id, account_id, refresh_token_hash, expires_at)
       VALUES ($1,$2,$3,$4, clock_timestamp() + INTERVAL '1 hour')`,
      [sessionId, tenantId, accountId, randomBytes(32).toString('hex')],
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

async function bindNonce(accountId: string, sessionId: string): Promise<string> {
  const binder = await bindPool.connect();
  try {
    const bound = await bindActorContextForRequest(binder as unknown as DbClient, {
      actorAccountId: accountId,
      actorAccountTenantId: tenantId,
      actorRole: 'tenant_admin',
      actorAdminHomeTenantId: null,
      sessionId,
      ttlSeconds: LIVE_NONCE_TTL_SECONDS,
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
  commitError: unknown;
}

/** A real connection whose COMMIT is intercepted; every other statement passes through. */
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

async function enrollmentRows(clinicianAccountId: string): Promise<{
  accounts: number;
  enrollments: number;
  audits: number;
  outbox: number;
}> {
  const c = await admin.connect();
  try {
    await c.query('SELECT set_tenant_context($1)', [tenantId]);
    const count = async (sql: string) =>
      Number((await c.query<{ n: string }>(sql, [tenantId, clinicianAccountId])).rows[0]?.n ?? 0);
    const accounts = await count(
      'SELECT count(*)::text AS n FROM accounts WHERE tenant_id=$1 AND account_id=$2',
    );
    const enrollments = await count(
      'SELECT count(*)::text AS n FROM identity_staff_enrollment WHERE tenant_id=$1 AND account_id=$2',
    );
    const audits = await count(
      "SELECT count(*)::text AS n FROM audit_records WHERE tenant_id=$1 AND resource_id=$2 AND resource_type='identity_staff_enrollment'",
    );
    const outbox = await count(
      "SELECT count(*)::text AS n FROM domain_events_outbox WHERE tenant_id=$1 AND aggregate_id=$2 AND event_type='identity.clinician.enrolled'",
    );
    await c.query('SELECT clear_tenant_context()');
    return { accounts, enrollments, audits, outbox };
  } finally {
    c.release();
  }
}

/** The handler's write, verbatim: enroll via the SQL contract + emit the evidence the deferred trigger requires. */
async function enrollClinician(tx: DbTransaction, ctx: StaffContext, clinicianAccountId: string) {
  const result = await tx.query<{ receipt: unknown }>(
    'SELECT public.identity_enroll_clinician($1,$2,$3,$4,$5) AS receipt',
    [
      clinicianAccountId,
      'Synthetic',
      'Clinician',
      syntheticPhone(),
      `${clinicianAccountId.toLowerCase()}@synthetic.invalid`,
    ],
  );
  const receipt = StaffEnrollmentReceiptSchema.parse(result.rows[0]?.receipt);
  await emitStaffEvidence(tx, ctx.tenant, ctx.actor.accountId, receipt.account_id, 'enrolled');
  return receipt;
}

async function runEnrollment(
  operator: { accountId: string; sessionId: string },
  nonce: string,
  clinicianAccountId: string,
  onCommit: () => Promise<void>,
  record: CommitInterception,
) {
  const ctx = {
    tenant,
    actor: { accountId: operator.accountId, sessionId: operator.sessionId },
    nonce,
  } as unknown as StaffContext;
  const c = await identityPool.connect();
  try {
    // The caller-owned client arrives already tenant-bound — exactly what the
    // primitive's callerOwnedClient contract expects.
    await c.query('SELECT set_tenant_context($1)', [tenantId]);
    const run = commitAuthorityTransaction({
      ...staffAuthority(ctx),
      callerOwnedClient: withCommitInterceptor(c, onCommit, record),
    });
    return await run((tx) => enrollClinician(tx, ctx, clinicianAccountId));
  } finally {
    await c.query('SELECT clear_tenant_context()').catch(() => undefined);
    c.release();
  }
}

beforeAll(async () => {
  process.env['NODE_ENV'] = 'test';
  const url = process.env['TEST_DATABASE_URL'] as string;
  admin = new pg.Pool({ connectionString: url, max: 3 });

  const superuser = await admin.connect();
  try {
    await configureBindRole(superuser as unknown as DbClient, BIND_ROLE_TEST_PASSWORD);
    await superuser.query("SELECT pg_advisory_lock(hashtext('test_configure_identity_role'))");
    try {
      await superuser.query(
        `ALTER ROLE identity_service_role WITH LOGIN PASSWORD '${IDENTITY_ROLE_TEST_PASSWORD}'`,
      );
    } finally {
      await superuser.query("SELECT pg_advisory_unlock(hashtext('test_configure_identity_role'))");
    }
  } finally {
    superuser.release();
  }
  const bindUrl = new URL(url);
  bindUrl.username = 'bind_actor_context_role';
  bindUrl.password = BIND_ROLE_TEST_PASSWORD;
  bindPool = new pg.Pool({ connectionString: bindUrl.toString(), max: 2 });
  const identityUrl = new URL(url);
  identityUrl.username = 'identity_service_role';
  identityUrl.password = IDENTITY_ROLE_TEST_PASSWORD;
  identityPool = new pg.Pool({ connectionString: identityUrl.toString(), max: 2 });

  tenantId = await seedTenant();
  tenant = { tenantId, countryOfCare: 'US' } as unknown as TenantContext;
});

afterAll(async () => {
  await identityPool?.end().catch(() => undefined);
  await bindPool?.end().catch(() => undefined);
  await admin?.end().catch(() => undefined);
});

describe('staff enrollment — operator authority is enforced at the actual COMMIT (identity_service_role)', () => {
  it('rejects an enrollment whose nonce expires at the COMMIT boundary — PT401 from the real COMMIT, everything rolled back', async () => {
    const operator = await seedOperator();
    const nonce = await bindNonce(operator.accountId, operator.sessionId);
    const clinicianAccountId = ulid();
    const record: CommitInterception = { intercepted: false, commitError: null };

    await expect(
      runEnrollment(operator, nonce, clinicianAccountId, () => expireNonce(nonce), record),
    ).rejects.toMatchObject({ code: 'PT401' });

    // The application-side checks all passed; only the server's deferred
    // trigger, running inside COMMIT, saw the expired authority.
    expect(record.intercepted).toBe(true);
    expect(record.commitError).toMatchObject({ code: 'PT401', severity: 'ERROR' });
    expect(await enrollmentRows(clinicianAccountId)).toEqual({
      accounts: 0,
      enrollments: 0,
      audits: 0,
      outbox: 0,
    });
  });

  it('records the enrollment when the nonce is still live at COMMIT (positive control)', async () => {
    const operator = await seedOperator();
    const nonce = await bindNonce(operator.accountId, operator.sessionId);
    const clinicianAccountId = ulid();
    const record: CommitInterception = { intercepted: false, commitError: null };

    const receipt = await runEnrollment(
      operator,
      nonce,
      clinicianAccountId,
      async () => undefined,
      record,
    );

    expect(receipt).toEqual({ account_id: clinicianAccountId, status: 'pending_verification' });
    expect(record.intercepted).toBe(true);
    expect(record.commitError).toBeNull();
    expect(await enrollmentRows(clinicianAccountId)).toEqual({
      accounts: 1,
      enrollments: 1,
      audits: 1,
      outbox: 1,
    });
  });
});
