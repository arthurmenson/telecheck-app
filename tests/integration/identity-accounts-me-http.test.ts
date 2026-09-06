import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../../src/app.ts';
import type { TenantId } from '../../src/lib/glossary.ts';
import type { TenantContext } from '../../src/lib/tenant-context.ts';
import { ulid } from '../../src/lib/ulid.ts';
import * as accountService from '../../src/modules/identity/internal/services/account-service.ts';
import { asAccountId } from '../../src/modules/identity/internal/types.ts';
import { mintTestJwt } from '../helpers/jwt-fixtures.ts';
import { seedLiveSession } from '../helpers/live-session-fixtures.ts';
import { TENANT_GHANA, TENANT_US, withTenantContext } from '../helpers/tenant-fixtures.ts';
import { getTestClient } from '../setup.ts';

const T_US = TENANT_US as TenantId;
const T_GH = TENANT_GHANA as TenantId;
const US_CTX: TenantContext = {
  tenantId: T_US,
  displayName: 'Telecheck-US',
  countryOfCare: 'US',
  kmsKeyAlias: 'alias/telecheck-us-data-key',
  consumerDba: 'Heros Health',
  legalEntity: 'Telecheck Health LLC',
  consumerSubdomain: 'heroshealth.com',
};
const GH_CTX: TenantContext = {
  tenantId: T_GH,
  displayName: 'Telecheck-Ghana',
  countryOfCare: 'GH',
  kmsKeyAlias: 'alias/telecheck-gh-data-key',
  consumerDba: 'Heros Health Ghana',
  legalEntity: 'Telecheck-Ghana Ltd.',
  consumerSubdomain: 'ghana.heroshealth.com',
};

let app: FastifyInstance | null = null;

beforeAll(async () => {
  process.env['NODE_ENV'] = 'test';
  app = await buildApp({ logger: false });
  await app.ready();
});

afterAll(async () => {
  if (app !== null) {
    await app.close();
  }
});

async function seedIdentity(ctx: TenantContext = US_CTX) {
  const accountId = asAccountId(ulid());
  await withTenantContext(ctx.tenantId, async () => {
    await accountService.createAccount(
      ctx,
      { actorId: 'op_seed' },
      {
        account_id: accountId,
        email: accountId + '@example.invalid',
        first_name: 'Synthetic',
        last_name: 'Identity',
        date_of_birth: '1990-01-01',
        gender: 'prefer_not_to_say',
      },
      getTestClient(),
    );
    await accountService.activateAccount(ctx, { actorId: 'op_seed' }, accountId, getTestClient());
  });
  return { accountId, ...(await seedLiveSession(ctx, accountId)) };
}

const protectedPaths = ['/v0/identity/accounts/me', '/v0/identity/devices'];

for (const url of protectedPaths) {
  describe(url + ' authorization', () => {
    it('requires a bearer token even with forged legacy account and role headers', async () => {
      const { accountId } = await seedIdentity();
      const response = await app!.inject({
        method: 'GET',
        url,
        headers: {
          host: 'localhost',
          'x-account-id': accountId,
          'x-actor-id': accountId,
          'x-actor-roles': 'platform_admin',
        },
      });
      expect(response.statusCode).toBe(401);
      expect(response.body).not.toContain('Telecheck-US');
    });
    it('rejects invalid bearer authentication with legacy headers', async () => {
      const { accountId } = await seedIdentity();
      const response = await app!.inject({
        method: 'GET',
        url,
        headers: {
          host: 'localhost',
          authorization: 'Bearer invalid',
          'x-account-id': accountId,
        },
      });
      expect(response.statusCode).toBe(401);
    });
    it('rejects a valid token from another tenant', async () => {
      const { token } = await seedIdentity(GH_CTX);
      const response = await app!.inject({
        method: 'GET',
        url,
        headers: { host: 'localhost', authorization: 'Bearer ' + token },
      });
      expect(response.statusCode).toBe(401);
      expect(response.body).not.toContain('Telecheck-Ghana');
    });
    for (const state of [
      'revoked',
      'expired',
      'suspended',
      'archived',
      'pending_verification',
    ] as const) {
      it('rejects ' + state + ' sessions or accounts', async () => {
        const identity = await seedIdentity();
        await withTenantContext(T_US, async () => {
          if (state === 'revoked') {
            await getTestClient().query(
              "UPDATE sessions SET revoked_at=NOW(), revoked_reason='patient_logout' WHERE session_id=$1",
              [identity.sessionId],
            );
          } else if (state === 'expired') {
            await getTestClient().query(
              "UPDATE sessions SET expires_at=NOW()-INTERVAL '1 second' WHERE session_id=$1",
              [identity.sessionId],
            );
          } else {
            await getTestClient().query('UPDATE accounts SET status=$2 WHERE account_id=$1', [
              identity.accountId,
              state,
            ]);
          }
        });
        const response = await app!.inject({
          method: 'GET',
          url,
          headers: { host: 'localhost', authorization: 'Bearer ' + identity.token },
        });
        expect(response.statusCode).toBe(401);
      });
    }
    it('rejects a fabricated session and a session owned by another account', async () => {
      const account = await seedIdentity();
      const other = await seedIdentity();
      for (const sessionId of [ulid(), other.sessionId]) {
        const token = mintTestJwt({
          accountId: account.accountId,
          sessionId,
          tenantId: T_US,
          countryOfCare: 'US',
          role: 'patient',
        });
        const response = await app!.inject({
          method: 'GET',
          url,
          headers: { host: 'localhost', authorization: 'Bearer ' + token },
        });
        expect(response.statusCode).toBe(401);
      }
    });
    it('rejects stale role claims and delegated credential access', async () => {
      const identity = await seedIdentity();
      for (const claims of [
        { role: 'clinician' as const },
        { role: 'patient' as const, delegateId: ulid() },
      ]) {
        const token = mintTestJwt({
          accountId: identity.accountId,
          sessionId: identity.sessionId,
          tenantId: T_US,
          countryOfCare: 'US',
          ...claims,
        });
        const response = await app!.inject({
          method: 'GET',
          url,
          headers: { host: 'localhost', authorization: 'Bearer ' + token },
        });
        expect(response.statusCode).toBe(401);
      }
    });
  });
}

describe('account self read', () => {
  it('uses the authenticated account, ignores forged account headers, and strips tenant identity', async () => {
    const own = await seedIdentity();
    const other = await seedIdentity();
    const response = await app!.inject({
      method: 'GET',
      url: '/v0/identity/accounts/me',
      headers: {
        host: 'localhost',
        authorization: 'Bearer ' + own.token,
        'x-account-id': other.accountId,
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().account_id).toBe(own.accountId);
    expect(response.body).not.toContain(other.accountId);
    expect(response.body).not.toContain('"tenant_id"');
    expect(response.body).not.toContain('Telecheck-US');
  });
});
