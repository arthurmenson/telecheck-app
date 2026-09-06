/** Database-backed JWT fixture for endpoints that enforce session liveness. */
import { randomBytes } from 'node:crypto';

import type { TenantContext } from '../../src/lib/tenant-context.js';
import { ulid } from '../../src/lib/ulid.js';
import * as sessionRepo from '../../src/modules/identity/internal/repositories/session-repo.js';
import { asAccountId, asSessionId } from '../../src/modules/identity/internal/types.js';
import { getTestClient } from '../setup.js';

import { mintTestJwt, type MintTestJwtInput } from './jwt-fixtures.js';
import { withTenantContext } from './tenant-fixtures.js';

export async function seedLiveSession(
  ctx: TenantContext,
  accountId: string,
  role: MintTestJwtInput['role'] = 'patient',
) {
  const sessionId = asSessionId(ulid());
  await withTenantContext(ctx.tenantId, () =>
    sessionRepo.createSession(
      {
        session_id: sessionId,
        tenant_id: ctx.tenantId,
        account_id: asAccountId(accountId),
        refresh_token_hash: randomBytes(32).toString('hex'),
        expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      },
      async () => {},
      getTestClient(),
    ),
  );
  const token = mintTestJwt({
    accountId,
    sessionId,
    tenantId: ctx.tenantId,
    countryOfCare: ctx.countryOfCare,
    role,
    ...(role === 'tenant_admin' ? { adminTenantBinding: ctx.tenantId } : {}),
  });
  return { sessionId, token };
}
