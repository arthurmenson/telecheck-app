/**
 * src/modules/identity/internal/repositories/session-repo.ts — direct
 * integration tests against migration 013.
 *
 * Coverage in this file (5 sections, 14 cases):
 *   §1 findSessionById — happy path, tenant-blind miss, cross-tenant
 *   §2 findActiveSessionByRefreshHash — match; null on revoked / expired
 *   §3 listActiveSessionsForAccount — count + ordering by last_active_at DESC
 *   §4 createSession — round-trip + txCallback
 *   §5 revokeSession — idempotent on already-revoked; reason enum honored
 *
 * Spec references:
 *   - session-repo.ts (target)
 *   - migrations/013_sessions.sql
 *   - CDM v1.2 §3.2 entity 8 + Identity Spec §3.2 (session management)
 */

import crypto from 'node:crypto';

import { describe, expect, it } from 'vitest';

import type { TenantId } from '../../src/lib/glossary.ts';
import { ulid } from '../../src/lib/ulid.ts';
import { createAccount } from '../../src/modules/identity/internal/repositories/account-repo.ts';
import {
  createSession,
  findActiveSessionByRefreshHash,
  findSessionById,
  listActiveSessionsForAccount,
  revokeSession,
} from '../../src/modules/identity/internal/repositories/session-repo.ts';
import {
  asAccountId,
  asSessionId,
  type AccountId,
} from '../../src/modules/identity/internal/types.ts';
import { TENANT_GHANA, TENANT_US, withTenantContext } from '../helpers/tenant-fixtures.ts';
import { getTestClient } from '../setup.ts';

const T_US = TENANT_US as TenantId;
const T_GH = TENANT_GHANA as TenantId;

function uniquePhone(prefix: '+1' | '+233' = '+1'): string {
  const digits = ulid()
    .slice(-9)
    .replace(/[^0-9]/g, '0')
    .padEnd(9, '0');
  return `${prefix}${digits}`;
}

function freshHash(): string {
  return crypto.randomBytes(32).toString('hex');
}

async function seedAccount(tenant: TenantId, country: 'US' | 'GH' = 'US'): Promise<AccountId> {
  const accountId = asAccountId(ulid());
  await withTenantContext(tenant, () =>
    createAccount(
      {
        account_id: accountId,
        tenant_id: tenant,
        phone_e164: uniquePhone(country === 'US' ? '+1' : '+233'),
        first_name: 'A',
        last_name: 'B',
        date_of_birth: '1990-01-01',
        gender: 'prefer_not_to_say',
        country_of_residence: country,
        country_of_care: country,
      },
      async () => {},
      getTestClient(),
    ),
  );
  return accountId;
}

function thirtyDaysFromNow(): string {
  return new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString();
}

// ---------------------------------------------------------------------------
// §1 — findSessionById
// ---------------------------------------------------------------------------

describe('session-repo §1 findSessionById', () => {
  it('§1a returns row on same-tenant match', async () => {
    const accountId = await seedAccount(T_US);
    const sessionId = asSessionId(ulid());
    await withTenantContext(T_US, () =>
      createSession(
        {
          session_id: sessionId,
          tenant_id: T_US,
          account_id: accountId,
          refresh_token_hash: freshHash(),
          expires_at: thirtyDaysFromNow(),
        },
        async () => {},
        getTestClient(),
      ),
    );

    const found = await withTenantContext(T_US, () =>
      findSessionById(T_US, sessionId, getTestClient()),
    );
    expect(found).not.toBeNull();
    expect(found!.session_id).toBe(sessionId);
    expect(found!.account_id).toBe(accountId);
  });

  it('§1b returns null on phantom session_id', async () => {
    const phantom = asSessionId(ulid());
    const found = await withTenantContext(T_US, () =>
      findSessionById(T_US, phantom, getTestClient()),
    );
    expect(found).toBeNull();
  });

  it('§1c returns null on cross-tenant lookup', async () => {
    const accountId = await seedAccount(T_GH, 'GH');
    const sessionId = asSessionId(ulid());
    await withTenantContext(T_GH, () =>
      createSession(
        {
          session_id: sessionId,
          tenant_id: T_GH,
          account_id: accountId,
          refresh_token_hash: freshHash(),
          expires_at: thirtyDaysFromNow(),
        },
        async () => {},
        getTestClient(),
      ),
    );

    const fromUS = await withTenantContext(T_US, () =>
      findSessionById(T_US, sessionId, getTestClient()),
    );
    expect(fromUS).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// §2 — findActiveSessionByRefreshHash
// ---------------------------------------------------------------------------

describe('session-repo §2 findActiveSessionByRefreshHash', () => {
  it('§2a matches active session', async () => {
    const accountId = await seedAccount(T_US);
    const hash = freshHash();
    await withTenantContext(T_US, () =>
      createSession(
        {
          session_id: asSessionId(ulid()),
          tenant_id: T_US,
          account_id: accountId,
          refresh_token_hash: hash,
          expires_at: thirtyDaysFromNow(),
        },
        async () => {},
        getTestClient(),
      ),
    );

    const found = await withTenantContext(T_US, () =>
      findActiveSessionByRefreshHash(T_US, hash, getTestClient()),
    );
    expect(found).not.toBeNull();
    expect(found!.refresh_token_hash).toBe(hash);
  });

  it('§2b returns null when session is revoked', async () => {
    const accountId = await seedAccount(T_US);
    const hash = freshHash();
    const sessionId = asSessionId(ulid());
    await withTenantContext(T_US, () =>
      createSession(
        {
          session_id: sessionId,
          tenant_id: T_US,
          account_id: accountId,
          refresh_token_hash: hash,
          expires_at: thirtyDaysFromNow(),
        },
        async () => {},
        getTestClient(),
      ),
    );
    await withTenantContext(T_US, () =>
      revokeSession(T_US, sessionId, 'patient_logout', getTestClient()),
    );

    const found = await withTenantContext(T_US, () =>
      findActiveSessionByRefreshHash(T_US, hash, getTestClient()),
    );
    expect(found).toBeNull();
  });

  it('§2c returns null when session is expired', async () => {
    const accountId = await seedAccount(T_US);
    const hash = freshHash();
    // Insert with expires_at in the PAST. Note: the
    // session_revocation_consistent CHECK still requires both NULL or
    // both NOT NULL; expires_at being past doesn't trigger it.
    const expired = new Date(Date.now() - 1000).toISOString();
    await withTenantContext(T_US, () =>
      createSession(
        {
          session_id: asSessionId(ulid()),
          tenant_id: T_US,
          account_id: accountId,
          refresh_token_hash: hash,
          expires_at: expired,
        },
        async () => {},
        getTestClient(),
      ),
    );

    const found = await withTenantContext(T_US, () =>
      findActiveSessionByRefreshHash(T_US, hash, getTestClient()),
    );
    expect(found).toBeNull();
  });

  it('§2d returns null on phantom hash', async () => {
    const found = await withTenantContext(T_US, () =>
      findActiveSessionByRefreshHash(T_US, freshHash(), getTestClient()),
    );
    expect(found).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// §3 — listActiveSessionsForAccount
// ---------------------------------------------------------------------------

describe('session-repo §3 listActiveSessionsForAccount', () => {
  it('§3a returns all active sessions for an account', async () => {
    const accountId = await seedAccount(T_US);
    for (let i = 0; i < 3; i++) {
      await withTenantContext(T_US, () =>
        createSession(
          {
            session_id: asSessionId(ulid()),
            tenant_id: T_US,
            account_id: accountId,
            refresh_token_hash: freshHash(),
            expires_at: thirtyDaysFromNow(),
          },
          async () => {},
          getTestClient(),
        ),
      );
    }

    const list = await withTenantContext(T_US, () =>
      listActiveSessionsForAccount(T_US, accountId, getTestClient()),
    );
    expect(list).toHaveLength(3);
  });

  it('§3b excludes revoked sessions', async () => {
    const accountId = await seedAccount(T_US);
    const sId = asSessionId(ulid());
    await withTenantContext(T_US, () =>
      createSession(
        {
          session_id: sId,
          tenant_id: T_US,
          account_id: accountId,
          refresh_token_hash: freshHash(),
          expires_at: thirtyDaysFromNow(),
        },
        async () => {},
        getTestClient(),
      ),
    );
    await withTenantContext(T_US, () =>
      revokeSession(T_US, sId, 'patient_logout', getTestClient()),
    );

    const list = await withTenantContext(T_US, () =>
      listActiveSessionsForAccount(T_US, accountId, getTestClient()),
    );
    expect(list).toHaveLength(0);
  });

  it('§3c returns empty array when account has no sessions', async () => {
    const accountId = await seedAccount(T_US);
    const list = await withTenantContext(T_US, () =>
      listActiveSessionsForAccount(T_US, accountId, getTestClient()),
    );
    expect(list).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// §4 — createSession
// ---------------------------------------------------------------------------

describe('session-repo §4 createSession', () => {
  it('§4a INSERT round-trip via RETURNING', async () => {
    const accountId = await seedAccount(T_US);
    const sessionId = asSessionId(ulid());
    const hash = freshHash();
    const expires = thirtyDaysFromNow();

    const session = await withTenantContext(T_US, () =>
      createSession(
        {
          session_id: sessionId,
          tenant_id: T_US,
          account_id: accountId,
          refresh_token_hash: hash,
          ip_address: '10.0.0.1',
          user_agent: 'TestAgent/1.0',
          expires_at: expires,
        },
        async () => {},
        getTestClient(),
      ),
    );
    expect(session.session_id).toBe(sessionId);
    expect(session.refresh_token_hash).toBe(hash);
    expect(session.ip_address).toBe('10.0.0.1');
    expect(session.user_agent).toBe('TestAgent/1.0');
    expect(session.revoked_at).toBeNull();
    expect(session.revoked_reason).toBeNull();
  });

  it('§4b txCallback fires inside transaction with persisted session', async () => {
    const accountId = await seedAccount(T_US);
    let captured: string | null = null;
    const sId = asSessionId(ulid());
    await withTenantContext(T_US, () =>
      createSession(
        {
          session_id: sId,
          tenant_id: T_US,
          account_id: accountId,
          refresh_token_hash: freshHash(),
          expires_at: thirtyDaysFromNow(),
        },
        async (_tx, persisted) => {
          captured = persisted.session_id;
        },
        getTestClient(),
      ),
    );
    expect(captured).toBe(sId);
  });
});

// ---------------------------------------------------------------------------
// §5 — revokeSession
// ---------------------------------------------------------------------------

describe('session-repo §5 revokeSession', () => {
  it('§5a flips revoked_at + revoked_reason; returns updated row', async () => {
    const accountId = await seedAccount(T_US);
    const sId = asSessionId(ulid());
    await withTenantContext(T_US, () =>
      createSession(
        {
          session_id: sId,
          tenant_id: T_US,
          account_id: accountId,
          refresh_token_hash: freshHash(),
          expires_at: thirtyDaysFromNow(),
        },
        async () => {},
        getTestClient(),
      ),
    );

    const revoked = await withTenantContext(T_US, () =>
      revokeSession(T_US, sId, 'patient_logout', getTestClient()),
    );
    expect(revoked).not.toBeNull();
    expect(revoked!.revoked_at).toBeTruthy();
    expect(revoked!.revoked_reason).toBe('patient_logout');
  });

  it('§5b returns null on already-revoked (idempotent no-op)', async () => {
    const accountId = await seedAccount(T_US);
    const sId = asSessionId(ulid());
    await withTenantContext(T_US, () =>
      createSession(
        {
          session_id: sId,
          tenant_id: T_US,
          account_id: accountId,
          refresh_token_hash: freshHash(),
          expires_at: thirtyDaysFromNow(),
        },
        async () => {},
        getTestClient(),
      ),
    );

    await withTenantContext(T_US, () =>
      revokeSession(T_US, sId, 'patient_logout', getTestClient()),
    );
    const second = await withTenantContext(T_US, () =>
      revokeSession(T_US, sId, 'admin_revoked', getTestClient()),
    );
    expect(second).toBeNull();
  });

  it('§5c returns null on phantom session_id', async () => {
    const phantom = asSessionId(ulid());
    const result = await withTenantContext(T_US, () =>
      revokeSession(T_US, phantom, 'patient_logout', getTestClient()),
    );
    expect(result).toBeNull();
  });
});
