import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { ulid } from '../../src/lib/ulid.ts';
import { TENANT_US, TENANT_GHANA } from '../helpers/tenant-fixtures.ts';
import { getTestClient } from '../setup.ts';

describe('Identity legacy cache upgrade', () => {
  it('relocates encoded success and failure rows for active and suspended tenants without changing retry scope', async () => {
    const client = getTestClient();
    const key = ulid();
    const expiry = '2030-01-01T00:00:00.000Z';
    const authPaths = [
      '/v0/identity/login/pin',
      '/v0/%69dentity/login/pin',
      '/%76%30/%69%64%65%6E%74%69%74%79/login/pin',
      '/v0/identity/login/%70in',
      '/v0/identity%2flogin%2fpin',
    ];
    const unrelatedPaths = [
      '/v0/consent',
      '/v0/identity-other',
      '/v0/%2569dentity',
      '/bad/%00/%GG',
    ];
    // Run the actual source block so this regression catches migration changes,
    // rather than reimplementing its classifier in the test.
    const migration = readFileSync(
      new URL(
        '../../migrations/083_identity_account_control_field_privileges.sql',
        import.meta.url,
      ),
      'utf8',
    );
    const start = migration.indexOf('-- Retain existing auth retry results');
    const end = migration.indexOf('-- Auth replay contains bearer tokens');
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    await client.query('RESET SESSION AUTHORIZATION');
    try {
      for (const tenant of [TENANT_US, TENANT_GHANA]) {
        for (const [index, endpoint] of [...authPaths, ...unrelatedPaths].entries()) {
          await client.query(
            `INSERT INTO public.idempotency_keys
            (tenant_id,key,endpoint,actor_id,request_hash,response_status,response_body,processing_state,expires_at)
            VALUES($1,$2,$3,'anonymous',decode(repeat('ab',32),'hex'),$4,$5,'completed',$6)`,
            [
              tenant,
              key,
              endpoint,
              index === 0 ? 200 : 401,
              index === 0
                ? { access_token: 'synthetic-only' }
                : { error: { code: 'identity.pin.invalid_credentials' } },
              expiry,
            ],
          );
        }
      }
      await client.query("UPDATE public.tenants SET status='suspended' WHERE id=$1", [
        TENANT_GHANA,
      ]);
      await client.query(migration.slice(start, end));
      const moved = await client.query<{
        tenant_id: string;
        endpoint: string;
        actor_id: string;
        request_hash: Buffer;
        expires_at: Date;
        response_status: number;
      }>('SELECT * FROM public.identity_idempotency_keys WHERE key=$1', [key]);
      expect(moved.rows).toHaveLength(authPaths.length * 2);
      for (const tenant of [TENANT_US, TENANT_GHANA]) {
        expect(
          moved.rows
            .filter((row) => row.tenant_id === tenant)
            .map((row) => row.endpoint)
            .sort(),
        ).toEqual([...authPaths].sort());
      }
      for (const row of moved.rows) {
        expect(row.actor_id).toBe('anonymous');
        expect(row.request_hash.toString('hex')).toBe('ab'.repeat(32));
        expect(row.expires_at.toISOString()).toBe(expiry);
        expect(row.response_status).toBe(row.endpoint === authPaths[0] ? 200 : 401);
      }
      const remaining = await client.query<{ endpoint: string }>(
        'SELECT endpoint FROM public.idempotency_keys WHERE key=$1',
        [key],
      );
      expect(remaining.rows.map((row) => row.endpoint).sort()).toEqual(
        [...unrelatedPaths, ...unrelatedPaths].sort(),
      );
      await client.query('SET SESSION AUTHORIZATION telecheck_app_role');
      await client.query('SELECT public.set_tenant_context($1)', [TENANT_US]);
      const visible = await client.query<{ endpoint: string }>(
        'SELECT endpoint FROM public.idempotency_keys WHERE key=$1',
        [key],
      );
      expect(visible.rows.map((row) => row.endpoint).sort()).toEqual([...unrelatedPaths].sort());
    } finally {
      await client.query('RESET SESSION AUTHORIZATION');
      await client.query('SET SESSION AUTHORIZATION telecheck_test_app');
    }
  });
});
