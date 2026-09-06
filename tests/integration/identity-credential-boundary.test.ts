import { describe, expect, it } from 'vitest';

import { asTenantId } from '../../src/lib/glossary.ts';
import { withIdempotency } from '../../src/lib/idempotency.ts';
import { ulid } from '../../src/lib/ulid.ts';
import { createAccount } from '../../src/modules/identity/internal/repositories/account-repo.ts';
import { asAccountId } from '../../src/modules/identity/internal/types.ts';
import { TENANT_US, TENANT_GHANA } from '../helpers/tenant-fixtures.ts';
import { getTestClient } from '../setup.ts';

describe('Identity credential database boundary', () => {
  it('rolls back a default Identity repository write when its audit callback fails', async () => {
    const accountId = asAccountId(ulid());
    await expect(
      createAccount(
        {
          account_id: accountId,
          tenant_id: asTenantId(TENANT_US),
          email: accountId + '@example.invalid',
          first_name: 'Synthetic',
          last_name: 'Atomic',
          date_of_birth: '1990-01-01',
          gender: 'prefer_not_to_say',
          country_of_residence: 'US',
          country_of_care: 'US',
        },
        async () => {
          throw new Error('synthetic_audit_failure');
        },
      ),
    ).rejects.toThrow('synthetic_audit_failure');
    const client = getTestClient();
    await client.query('SELECT set_tenant_context($1)', [TENANT_US]);
    const result = await client.query('SELECT account_id FROM accounts WHERE account_id=$1', [
      accountId,
    ]);
    expect(result.rows).toEqual([]);
  });

  it('caps private auth replay TTL even when the raw endpoint uses an encoded spelling', async () => {
    const client = getTestClient();
    await client.query('SELECT set_tenant_context($1)', [TENANT_US]);
    const key = ulid();
    await withIdempotency(
      client,
      {
        tenantId: TENANT_US,
        idempotencyKey: key,
        endpoint: '/v0/%69dentity/login/pin',
        actorId: 'anonymous',
        bodyHash: 'ab'.repeat(32),
      },
      async () => ({ status: 200, body: { access_token: 'synthetic-only' } }),
      'identity_idempotency_keys',
    );
    const result = await client.query<{ ttl: number }>(
      'SELECT EXTRACT(EPOCH FROM expires_at-created_at)::int AS ttl FROM identity_idempotency_keys WHERE key=$1',
      [key],
    );
    expect(result.rows[0]?.ttl).toBeLessThanOrEqual(900);
    expect(result.rows[0]?.ttl).toBeGreaterThan(0);
  });

  it('denies ordinary credential/session writes, private-cache access and role assumption', async () => {
    const client = getTestClient();
    await client.query('RESET SESSION AUTHORIZATION');
    await client.query('SET SESSION AUTHORIZATION telecheck_app_role');
    try {
      await client.query('SELECT set_tenant_context($1)', [TENANT_US]);
      const denied = [
        'SET ROLE identity_service_role',
        'SET ROLE bind_actor_context_role',
        'SELECT * FROM account_pin_credentials',
        'SELECT * FROM otp_challenges',
        'SELECT * FROM email_passcodes',
        'SELECT * FROM auth_devices',
        'SELECT * FROM identity_idempotency_keys',
        "UPDATE account_pin_credentials SET pin_hash=repeat('a',128)",
        "UPDATE otp_challenges SET code_hash='forged'",
        "UPDATE email_passcodes SET code_hash='forged'",
        'UPDATE sessions SET revoked_at=NULL',
        "UPDATE accounts SET status='active'",
        "UPDATE accounts SET account_type='platform_admin'",
        "INSERT INTO sessions(session_id) VALUES ('forged')",
        "INSERT INTO accounts(account_id) VALUES ('forged')",
        'DELETE FROM identity_idempotency_keys',
        "UPDATE identity_idempotency_keys SET endpoint='/public'",
        "INSERT INTO identity_idempotency_keys(tenant_id) VALUES ('Telecheck-US')",
      ];
      for (const sql of denied) {
        await client.query('SAVEPOINT denied_identity_sql');
        await expect(client.query(sql)).rejects.toMatchObject({ code: '42501' });
        await client.query('ROLLBACK TO SAVEPOINT denied_identity_sql');
        await client.query('RELEASE SAVEPOINT denied_identity_sql');
      }
      const membership = await client.query(
        "SELECT pg_has_role('telecheck_app_role','identity_service_role','MEMBER') AS app, pg_has_role('bind_actor_context_role','identity_service_role','MEMBER') AS bind",
      );
      expect(membership.rows).toEqual([{ app: false, bind: false }]);
    } finally {
      await client.query('RESET SESSION AUTHORIZATION');
      await client.query('SET SESSION AUTHORIZATION telecheck_test_app');
    }
  });

  it('keeps private replay tenant-scoped and blocks general-cache auth namespace forgery', async () => {
    const client = getTestClient();
    const key = ulid();
    await client.query('RESET SESSION AUTHORIZATION');
    try {
      await client.query('SET SESSION AUTHORIZATION identity_service_role');
      for (const tenant of [TENANT_US, TENANT_GHANA]) {
        await client.query('SELECT set_tenant_context($1)', [tenant]);
        await client.query(
          `INSERT INTO identity_idempotency_keys
          (tenant_id,key,endpoint,actor_id,request_hash,response_status,response_body,processing_state)
          VALUES ($1,$2,'/v0/identity/login/pin','anonymous',decode(repeat('aa',32),'hex'),200,'{"access_token":"synthetic-only"}','completed')`,
          [tenant, key],
        );
      }
      await client.query('SELECT set_tenant_context($1)', [TENANT_US]);
      const visible = await client.query(
        'SELECT tenant_id FROM identity_idempotency_keys WHERE key=$1',
        [key],
      );
      expect(visible.rows).toEqual([{ tenant_id: TENANT_US }]);
      await client.query('RESET SESSION AUTHORIZATION');
      await client.query('SET SESSION AUTHORIZATION telecheck_app_role');
      const ordinary = await client.query('SELECT * FROM idempotency_keys WHERE key=$1', [key]);
      expect(ordinary.rows).toEqual([]);
      await client.query('SAVEPOINT forged_auth_cache');
      await expect(
        client.query(
          `INSERT INTO idempotency_keys
        (tenant_id,key,endpoint,actor_id,request_hash,response_status)
        VALUES ($1,$2,'/v0/identity/login/pin','anonymous',decode(repeat('aa',32),'hex'),200)`,
          [TENANT_US, key],
        ),
      ).rejects.toMatchObject({ code: '42501' });
      await client.query('ROLLBACK TO SAVEPOINT forged_auth_cache');
      await client.query('RELEASE SAVEPOINT forged_auth_cache');
    } finally {
      await client.query('RESET SESSION AUTHORIZATION');
      await client.query('SET SESSION AUTHORIZATION telecheck_test_app');
    }
  });
});
