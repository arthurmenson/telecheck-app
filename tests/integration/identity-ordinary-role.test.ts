/** Runtime grants must preserve RLS and privileged procedure boundaries. */
import { describe, expect, it } from 'vitest';

import { ulid } from '../../src/lib/ulid.ts';
import { TENANT_GHANA, TENANT_US, withTenantContext } from '../helpers/tenant-fixtures.ts';
import { getTestClient } from '../setup.ts';

describe('ordinary Identity application role', () => {
  it('has required Identity privileges but cannot rewrite immutable audit or event history', async () => {
    const client = getTestClient();
    const role = await client.query(
      "SELECT rolsuper, rolbypassrls, rolinherit, rolcreaterole FROM pg_roles WHERE rolname='telecheck_app_role'",
    );
    expect(role.rows).toEqual([
      { rolsuper: false, rolbypassrls: false, rolinherit: false, rolcreaterole: false },
    ]);
    for (const table of [
      'sessions',
      'auth_devices',
      'otp_challenges',
      'email_passcodes',
      'account_pin_credentials',
    ]) {
      const result = await client.query(
        "SELECT (has_table_privilege('telecheck_app_role',$1,'SELECT') AND has_table_privilege('telecheck_app_role',$1,'INSERT') AND has_table_privilege('telecheck_app_role',$1,'UPDATE')) AS allowed, has_table_privilege('telecheck_app_role',$1,'DELETE') AS can_delete",
        [table],
      );
      expect(result.rows).toEqual([{ allowed: true, can_delete: false }]);
    }
    for (const table of ['audit_records', 'domain_events_outbox']) {
      const result = await client.query(
        "SELECT has_table_privilege('telecheck_app_role',$1,'INSERT') AS allowed, has_table_privilege('telecheck_app_role',$1,'UPDATE,DELETE') AS can_mutate",
        [table],
      );
      expect(result.rows).toEqual([{ allowed: true, can_mutate: false }]);
    }
    const anchor = await client.query(
      "SELECT has_table_privilege('telecheck_app_role','_session_actor_context','INSERT,UPDATE,DELETE') AS can_bind",
    );
    expect(anchor.rows).toEqual([{ can_bind: false }]);
  });

  it('forces tenant isolation on Identity data when using the real app role', async () => {
    const client = getTestClient();
    const ids = [ulid(), ulid()];
    for (const [index, tenant] of [TENANT_US, TENANT_GHANA].entries()) {
      await withTenantContext(tenant, () =>
        client.query(
          `INSERT INTO accounts
        (account_id, tenant_id, email, first_name, last_name, date_of_birth, gender, country_of_residence, country_of_care)
        VALUES ($1,$2,$3,'Synthetic','Role','1990-01-01','prefer_not_to_say',$4,$4)`,
          [ids[index], tenant, `${ids[index]}@example.invalid`, index === 0 ? 'US' : 'GH'],
        ),
      );
    }
    await client.query('RESET SESSION AUTHORIZATION');
    await client.query('SET SESSION AUTHORIZATION telecheck_app_role');
    try {
      for (const [index, tenant] of [TENANT_US, TENANT_GHANA].entries()) {
        await client.query('SELECT set_tenant_context($1)', [tenant]);
        const own = await client.query(
          'SELECT account_id FROM accounts WHERE account_id=ANY($1::text[])',
          [ids],
        );
        expect(own.rows).toEqual([{ account_id: ids[index] }]);
      }
    } finally {
      await client.query('RESET SESSION AUTHORIZATION');
      await client.query('SET SESSION AUTHORIZATION telecheck_test_app');
    }
  });

  it('allows read-only, tenant-scoped brand configuration', async () => {
    const client = getTestClient();
    await client.query('RESET SESSION AUTHORIZATION');
    await client.query('SET SESSION AUTHORIZATION telecheck_app_role');
    try {
      await client.query('SELECT set_tenant_context($1)', [TENANT_US]);
      const brands = await client.query('SELECT tenant_id FROM tenant_brands');
      expect(brands.rows).toEqual([{ tenant_id: TENANT_US }]);
      const update = await client.query(
        "SELECT has_table_privilege(current_user,'tenant_brands','UPDATE') AS can_update",
      );
      expect(update.rows).toEqual([{ can_update: false }]);
    } finally {
      await client.query('RESET SESSION AUTHORIZATION');
      await client.query('SET SESSION AUTHORIZATION telecheck_test_app');
    }
  });
});

describe('ordinary account control fields', () => {
  it('allows registration and activation but forbids privileged role/cohort writes', async () => {
    const client = getTestClient();
    await client.query('RESET SESSION AUTHORIZATION');
    await client.query('SET SESSION AUTHORIZATION telecheck_app_role');
    try {
      await client.query('SELECT set_tenant_context($1)', [TENANT_US]);
      const id = ulid();
      const registration =
        "INSERT INTO accounts(account_id,tenant_id,email,first_name,last_name,date_of_birth,gender,country_of_residence,country_of_care) VALUES ($1,$2,$3,'Synthetic','Privileges','1990-01-01','prefer_not_to_say','US','US')";
      await client.query(registration, [id, TENANT_US, id + '@example.invalid']);
      await client.query(
        "UPDATE accounts SET status='active', activated_at=NOW() WHERE account_id=$1",
        [id],
      );
      const attempts = [
        "UPDATE accounts SET account_type='platform_admin' WHERE account_id=$1",
        "UPDATE accounts SET cohort_classification='baseline' WHERE account_id=$1",
        "UPDATE accounts SET first_name='Rewritten' WHERE account_id=$1",
        "UPDATE accounts SET tenant_id='unauthorized-tenant' WHERE account_id=$1",
        'UPDATE accounts SET deleted_at=NOW() WHERE account_id=$1',
        "INSERT INTO accounts(account_id,tenant_id,email,first_name,last_name,date_of_birth,gender,country_of_residence,country_of_care,account_type) VALUES ($1,$2,$3,'Synthetic','Denied','1990-01-01','prefer_not_to_say','US','US','platform_admin')",
        "INSERT INTO accounts(account_id,tenant_id,email,first_name,last_name,date_of_birth,gender,country_of_residence,country_of_care,cohort_classification) VALUES ($1,$2,$3,'Synthetic','Denied','1990-01-01','prefer_not_to_say','US','US','baseline')",
      ];
      for (const sql of attempts) {
        await client.query('SAVEPOINT control_field_probe');
        const params = sql.startsWith('INSERT')
          ? [ulid(), TENANT_US, ulid() + '@example.invalid']
          : [id];
        await expect(client.query(sql, params)).rejects.toMatchObject({ code: '42501' });
        await client.query('ROLLBACK TO SAVEPOINT control_field_probe');
        await client.query('RELEASE SAVEPOINT control_field_probe');
      }
      const stored = await client.query(
        'SELECT account_type,cohort_classification,status FROM accounts WHERE account_id=$1',
        [id],
      );
      expect(stored.rows).toEqual([
        { account_type: 'patient', cohort_classification: 'unclassified', status: 'active' },
      ]);
    } finally {
      await client.query('RESET SESSION AUTHORIZATION');
      await client.query('SET SESSION AUTHORIZATION telecheck_test_app');
    }
  });
});
