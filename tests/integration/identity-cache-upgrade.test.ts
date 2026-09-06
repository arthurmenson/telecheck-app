import { readFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';

import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';

import { withIdempotentExecution } from '../../src/lib/idempotent-handler.ts';
import { idempotencyPlugin, withIdempotency } from '../../src/lib/idempotency.ts';
import type { TenantContext } from '../../src/lib/tenant-context.ts';
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
      'http://localhost/v0/identity/login/pin',
      'https://localhost:3101/v0/%69dentity/login/pin',
      'http:///v0/identity/login/pin',
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

  it('covers the real router encoding matrix and blocks lossy absolute-form retries in both cache capabilities', async () => {
    const client = getTestClient();
    const server = Fastify({ routerOptions: { maxParamLength: 512 } });
    let calls = 0;
    server.addHook('onRequest', async (req) => {
      req.tenantContext = { tenantId: TENANT_US, countryOfCare: 'US' } as TenantContext;
    });
    await server.register(idempotencyPlugin);
    for (const route of ['/care', '/v0/identity/login/pin']) {
      server.post(route, async (req, reply) =>
        withIdempotentExecution(
          req,
          reply,
          () => false,
          async () => {
            calls++;
            return { status: 200, view: { executed: true } };
          },
          undefined,
          route.startsWith('/v0/identity/') ? 'identity_idempotency_keys' : 'idempotency_keys',
        ),
      );
    }
    await server.ready();
    const endpoints = new Set<string>();
    for (let mask = 0; mask < 1024; mask++) {
      let position = 0;
      const path =
        '/v0/identity'.replace(/[a-z0-9]/g, (char) =>
          mask & (1 << position++) ? `%${char.charCodeAt(0).toString(16)}` : char,
        ) + '/login/pin';
      for (const prefix of [
        '',
        'http://localhost',
        'https://[::1]:3101',
        'http://',
        'http://localhost?discarded',
      ]) {
        const raw = prefix + path;
        expect(server.findRoute({ method: 'POST', url: raw })).not.toBeNull();
        endpoints.add(raw.split('?')[0]!);
      }
    }
    expect(endpoints.size).toBe(4097);
    const key = ulid();
    const expiry = '2030-01-01T00:00:00.000Z';
    const source = readFileSync(
      new URL(
        '../../migrations/083_identity_account_control_field_privileges.sql',
        import.meta.url,
      ),
      'utf8',
    );
    const start = source.indexOf('-- Retain existing auth retry results');
    const end = source.indexOf('-- Auth replay contains bearer tokens');
    await client.query('RESET SESSION AUTHORIZATION');
    try {
      for (const tenant of [TENANT_US, TENANT_GHANA]) {
        await client.query(
          `INSERT INTO public.idempotency_keys
          (tenant_id,key,endpoint,actor_id,request_hash,response_status,response_body,processing_state,expires_at)
          SELECT $1,$2,path,'anonymous',decode(repeat('ab',32),'hex'),401,
            '{"error":{"code":"identity.pin.invalid_credentials"},"synthetic_secret":"must disappear from ambiguous rows"}'::jsonb,'completed',$4
          FROM unnest($3::text[]) AS path`,
          [tenant, key, [...endpoints], expiry],
        );
      }
      await client.query("UPDATE public.tenants SET status='suspended' WHERE id=$1", [
        TENANT_GHANA,
      ]);
      await client.query(source.slice(start, end));
      const totals = await client.query<{ count: number }>(
        'SELECT count(*)::int AS count FROM public.identity_idempotency_keys WHERE key=$1',
        [key],
      );
      expect(totals.rows[0]?.count).toBe(endpoints.size * 2);
      for (const table of ['idempotency_keys', 'identity_idempotency_keys'] as const) {
        const markers = await client.query<{
          tenant_id: string;
          request_hash: Buffer;
          response_status: number;
          response_body: unknown;
          expires_at: Date;
        }>(`SELECT * FROM public.${table} WHERE key=$1 AND endpoint='http://localhost'`, [key]);
        expect(markers.rows).toHaveLength(2);
        for (const marker of markers.rows) {
          expect(marker.request_hash.equals(Buffer.alloc(32))).toBe(true);
          expect(marker.response_status).toBe(409);
          expect(marker.expires_at.toISOString()).toBe(expiry);
          expect(marker.response_body).toEqual({
            error: {
              code: 'internal.idempotency.legacy_result_unavailable',
              message:
                'The legacy operation result is unavailable. Reconcile its status before retrying.',
            },
          });
        }
        await client.query('SELECT public.set_tenant_context($1)', [TENANT_US]);
        for (const hash of ['ab'.repeat(32), 'cd'.repeat(32)]) {
          await expect(
            withIdempotency(
              client,
              {
                tenantId: TENANT_US,
                idempotencyKey: key,
                endpoint: 'http://localhost',
                actorId: 'anonymous',
                bodyHash: hash,
              },
              async () => {
                calls++;
                return { status: 200, body: { executed: true } };
              },
              table,
            ),
          ).rejects.toMatchObject({
            cachedStatus: 409,
            cachedBody: {
              error: {
                code: 'internal.idempotency.legacy_result_unavailable',
              },
            },
          });
        }
      }
      await client.query('SET SESSION AUTHORIZATION telecheck_app_role');
      await client.query('SELECT public.set_tenant_context($1)', [TENANT_US]);
      const remaining = await client.query<{ request_hash: Buffer; endpoint: string }>(
        'SELECT request_hash,endpoint FROM public.idempotency_keys WHERE key=$1',
        [key],
      );
      expect(remaining.rows).toHaveLength(1);
      expect(remaining.rows[0]?.request_hash.equals(Buffer.alloc(32))).toBe(true);
      await client.query('RESET SESSION AUTHORIZATION');
      await client.query('SET SESSION AUTHORIZATION telecheck_test_app');
      const address = new URL(await server.listen({ host: '127.0.0.1', port: 0 }));
      for (const path of ['/care', '/v0/identity/login/pin']) {
        for (const body of ['{}', '{"changed":true}']) {
          const response = await new Promise<{ status: number | undefined; body: string }>(
            (resolve, reject) => {
              const request = httpRequest(
                {
                  hostname: '127.0.0.1',
                  port: address.port,
                  method: 'POST',
                  path: `http://localhost?discarded${path}`,
                  headers: {
                    host: 'localhost',
                    'content-type': 'application/json',
                    'content-length': Buffer.byteLength(body),
                    'idempotency-key': key,
                  },
                },
                (res) => {
                  let data = '';
                  res.setEncoding('utf8');
                  res.on('data', (chunk: string) => {
                    data += chunk;
                  });
                  res.on('end', () => resolve({ status: res.statusCode, body: data }));
                },
              );
              request.on('error', reject);
              request.end(body);
            },
          );
          expect(response.status).toBe(409);
          expect(JSON.parse(response.body).error.code).toBe(
            'internal.idempotency.legacy_result_unavailable',
          );
        }
      }
      expect(calls).toBe(0);
    } finally {
      await server.close();
      await client.query('RESET SESSION AUTHORIZATION');
      await client.query('SET SESSION AUTHORIZATION telecheck_test_app');
    }
  });
});
