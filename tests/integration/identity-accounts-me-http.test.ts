/**
 * GET /v0/identity/accounts/me — HTTP integration tests.
 *
 * Coverage in this file (1 section, 5 cases):
 *   §1a 200 + PatientAccountView for valid x-account-id
 *   §1b 400 missing header
 *   §1c 404 phantom account_id (tenant-blind)
 *   §1d 404 cross-tenant (account in Ghana, request from US)
 *   §1e response body has no tenant_id substring
 *
 * Spec references:
 *   - src/modules/identity/internal/handlers/accounts.ts (target)
 *   - I-025 (tenant-blind 404)
 */

import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../../src/app.ts';
import type { TenantId } from '../../src/lib/glossary.ts';
import type { TenantContext } from '../../src/lib/tenant-context.ts';
import { ulid } from '../../src/lib/ulid.ts';
import * as accountService from '../../src/modules/identity/internal/services/account-service.ts';
import { asAccountId } from '../../src/modules/identity/internal/types.ts';
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

function uniquePhone(prefix: '+1' | '+233' = '+1'): string {
  const digits = ulid()
    .slice(-9)
    .replace(/[^0-9]/g, '0')
    .padEnd(9, '0');
  return `${prefix}${digits}`;
}

describe('GET /v0/identity/accounts/me', () => {
  it('§1a returns 200 + PatientAccountView for valid x-account-id', async () => {
    const accountId = asAccountId(ulid());
    await withTenantContext(T_US, () =>
      accountService.createAccount(
        US_CTX,
        { actorId: 'op_seed' },
        {
          account_id: accountId,
          phone_e164: uniquePhone('+1'),
          first_name: 'Test',
          last_name: 'Patient',
          date_of_birth: '1990-01-01',
          gender: 'prefer_not_to_say',
        },
        getTestClient(),
      ),
    );

    const response = await app!.inject({
      method: 'GET',
      url: '/v0/identity/accounts/me',
      headers: { host: 'localhost', 'x-account-id': accountId },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json<{ account_id: string; first_name: string }>();
    expect(body.account_id).toBe(accountId);
    expect(body.first_name).toBe('Test');
    expect(response.body).not.toContain('"tenant_id"');
    expect(response.body).not.toContain('Telecheck-US');
  });

  it('§1b returns 400 when x-account-id missing', async () => {
    const response = await app!.inject({
      method: 'GET',
      url: '/v0/identity/accounts/me',
      headers: { host: 'localhost' },
    });
    expect(response.statusCode).toBe(400);
    const body = response.json<{ error: { code: string } }>();
    expect(body.error.code).toBe('internal.request.invalid');
  });

  it('§1c returns 404 (tenant-blind) for phantom account_id', async () => {
    const phantom = asAccountId(ulid());
    const response = await app!.inject({
      method: 'GET',
      url: '/v0/identity/accounts/me',
      headers: { host: 'localhost', 'x-account-id': phantom },
    });
    expect(response.statusCode).toBe(404);
    const body = response.json<{ error: { code: string } }>();
    expect(body.error.code).toBe('internal.resource.not_found');
  });

  it('§1d returns 404 for cross-tenant account (RLS-blind)', async () => {
    // Create account in Ghana, request from US
    const accountId = asAccountId(ulid());
    await withTenantContext(T_GH, () =>
      accountService.createAccount(
        GH_CTX,
        { actorId: 'op_seed' },
        {
          account_id: accountId,
          phone_e164: uniquePhone('+233'),
          first_name: 'A',
          last_name: 'B',
          date_of_birth: '1990-01-01',
          gender: 'prefer_not_to_say',
        },
        getTestClient(),
      ),
    );

    // Request from US tenant (host=localhost resolves to Telecheck-US)
    const response = await app!.inject({
      method: 'GET',
      url: '/v0/identity/accounts/me',
      headers: { host: 'localhost', 'x-account-id': accountId },
    });
    expect(response.statusCode).toBe(404);
  });

  it('§1e response body is fully tenant-blind (no Telecheck-* / heros)', async () => {
    const phantom = asAccountId(ulid());
    const response = await app!.inject({
      method: 'GET',
      url: '/v0/identity/accounts/me',
      headers: { host: 'localhost', 'x-account-id': phantom },
    });
    expect(response.body).not.toContain('Telecheck-US');
    expect(response.body).not.toContain('Telecheck-Ghana');
    expect(response.body.toLowerCase()).not.toContain('heros');
  });
});
