/**
 * migrations/013_sessions.sql — schema-level integration tests.
 *
 * Validates the migration empirically:
 *   - RLS isolation (tenant_isolation policy)
 *   - Composite FK to accounts (cross-tenant binding rejected at DB layer)
 *   - refresh_token_hash format CHECK (64 chars [0-9a-f])
 *   - revoked_reason enum CHECK (8 documented reasons)
 *   - revocation-consistency CHECK (revoked_at and revoked_reason both
 *     NULL or both NOT NULL)
 *   - tenant-scoped refresh_token_hash UNIQUE
 *   - last_active_at trigger fires on UPDATE (clock_timestamp()-based,
 *     advances within transactions)
 *
 * Coverage in this file (5 sections, 16 cases).
 *
 * Spec references:
 *   - migrations/013_sessions.sql (target)
 *   - Identity & Authentication Spec v1.0 §3.2 (session management)
 *   - CDM v1.2 §3.2 entity 8 "Session"
 *   - I-023 (RLS layer-1 enforcement)
 */

import crypto from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { ulid } from '../../src/lib/ulid.ts';
import { TENANT_GHANA, TENANT_US, withTenantContext } from '../helpers/tenant-fixtures.ts';
import { getTestClient } from '../setup.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface InsertAccountInput {
  account_id?: string;
  tenant_id: string;
  phone_e164?: string;
  country_of_residence?: string;
  country_of_care?: 'US' | 'GH';
}

/** Insert a parent account row so a session FK target exists. */
async function seedAccount(input: InsertAccountInput): Promise<string> {
  const client = getTestClient();
  const accountId = input.account_id ?? ulid();
  const phone =
    input.phone_e164 ??
    `+1${ulid()
      .slice(-9)
      .replace(/[^0-9]/g, '0')
      .padEnd(9, '0')}`;
  await client.query(
    `INSERT INTO accounts (
        account_id, tenant_id, phone_e164,
        first_name, last_name, date_of_birth, gender,
        country_of_residence, country_of_care, locale,
        account_type, status
     ) VALUES ($1, $2, $3, 'F', 'L', '1990-01-01', 'prefer_not_to_say',
               $4, $5, 'en-US', 'patient', 'active')`,
    [
      accountId,
      input.tenant_id,
      phone,
      input.country_of_residence ?? 'US',
      input.country_of_care ?? 'US',
    ],
  );
  return accountId;
}

interface InsertSessionInput {
  session_id?: string;
  tenant_id: string;
  account_id: string;
  refresh_token_hash?: string;
  expires_at?: string;
  revoked_at?: string | null;
  revoked_reason?: string | null;
}

async function insertSession(input: InsertSessionInput): Promise<string> {
  const client = getTestClient();
  const sessionId = input.session_id ?? ulid();
  const hash = input.refresh_token_hash ?? crypto.randomBytes(32).toString('hex');
  const expiresAt = input.expires_at ?? new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString();
  await client.query(
    `INSERT INTO sessions (
        session_id, tenant_id, account_id,
        refresh_token_hash,
        created_at, last_active_at, expires_at,
        revoked_at, revoked_reason
     ) VALUES ($1, $2, $3, $4,
               NOW(), NOW(), $5,
               $6, $7)`,
    [
      sessionId,
      input.tenant_id,
      input.account_id,
      hash,
      expiresAt,
      input.revoked_at ?? null,
      input.revoked_reason ?? null,
    ],
  );
  return sessionId;
}

// ---------------------------------------------------------------------------
// §1 — RLS isolation
// ---------------------------------------------------------------------------

describe('sessions migration — §1 RLS tenant_isolation', () => {
  it('§1a session inserted in US is invisible from Ghana context', async () => {
    const accountId = await withTenantContext(TENANT_US, () =>
      seedAccount({ tenant_id: TENANT_US }),
    );
    await withTenantContext(TENANT_US, () =>
      insertSession({ tenant_id: TENANT_US, account_id: accountId }),
    );

    const visibleFromGhana = await withTenantContext(TENANT_GHANA, async () => {
      const r = await getTestClient().query('SELECT 1 FROM sessions WHERE account_id = $1', [
        accountId,
      ]);
      return r.rows.length;
    });
    expect(visibleFromGhana).toBe(0);
  });

  it('§1b INSERT with mismatched tenant_id rejected by WITH CHECK', async () => {
    const accountId = await withTenantContext(TENANT_US, () =>
      seedAccount({ tenant_id: TENANT_US }),
    );
    // Insert under TENANT_US context but trying to write tenant_id=Ghana
    await expect(
      withTenantContext(TENANT_US, async () => {
        await insertSession({ tenant_id: TENANT_GHANA, account_id: accountId });
      }),
    ).rejects.toThrow(/row-level security|policy/i);
  });
});

// ---------------------------------------------------------------------------
// §2 — Composite FK to accounts
// ---------------------------------------------------------------------------

describe('sessions migration — §2 composite FK to accounts', () => {
  it('§2a session referencing account in same tenant succeeds', async () => {
    const accountId = await withTenantContext(TENANT_US, () =>
      seedAccount({ tenant_id: TENANT_US }),
    );
    await withTenantContext(TENANT_US, () =>
      insertSession({ tenant_id: TENANT_US, account_id: accountId }),
    );
  });

  it('§2b session referencing account_id that does not exist in this tenant fails (composite FK)', async () => {
    // Account exists in Ghana but session is in US — composite FK lookup
    // for (tenant_id=US, account_id=X) finds no row, rejects.
    const accountId = await withTenantContext(TENANT_GHANA, () =>
      seedAccount({
        tenant_id: TENANT_GHANA,
        country_of_residence: 'GH',
        country_of_care: 'GH',
      }),
    );
    await expect(
      withTenantContext(TENANT_US, async () => {
        await insertSession({ tenant_id: TENANT_US, account_id: accountId });
      }),
    ).rejects.toThrow(/foreign key|fk_session_account|violates/i);
  });

  it('§2c session referencing nonexistent account_id fails (composite FK)', async () => {
    const phantomAccountId = ulid();
    await expect(
      withTenantContext(TENANT_US, async () => {
        await insertSession({ tenant_id: TENANT_US, account_id: phantomAccountId });
      }),
    ).rejects.toThrow(/foreign key|fk_session_account|violates/i);
  });
});

// ---------------------------------------------------------------------------
// §3 — refresh_token_hash format CHECK
// ---------------------------------------------------------------------------

describe('sessions migration — §3 refresh_token_hash format CHECK', () => {
  it('§3a accepts canonical 64-char SHA-256 hex', async () => {
    const accountId = await withTenantContext(TENANT_US, () =>
      seedAccount({ tenant_id: TENANT_US }),
    );
    await withTenantContext(TENANT_US, async () => {
      await insertSession({
        tenant_id: TENANT_US,
        account_id: accountId,
        refresh_token_hash: 'a'.repeat(64),
      });
    });
  });

  it('§3b rejects 63-char (one too short)', async () => {
    const accountId = await withTenantContext(TENANT_US, () =>
      seedAccount({ tenant_id: TENANT_US }),
    );
    await expect(
      withTenantContext(TENANT_US, async () => {
        await insertSession({
          tenant_id: TENANT_US,
          account_id: accountId,
          refresh_token_hash: 'a'.repeat(63),
        });
      }),
    ).rejects.toThrow(/session_refresh_token_hash_format|check constraint|value too long/i);
  });

  it('§3c rejects uppercase hex (canonical SHA-256 hex is lowercase)', async () => {
    const accountId = await withTenantContext(TENANT_US, () =>
      seedAccount({ tenant_id: TENANT_US }),
    );
    await expect(
      withTenantContext(TENANT_US, async () => {
        await insertSession({
          tenant_id: TENANT_US,
          account_id: accountId,
          refresh_token_hash: 'A'.repeat(64),
        });
      }),
    ).rejects.toThrow(/session_refresh_token_hash_format|check constraint/i);
  });

  it('§3d rejects non-hex characters (e.g., contains "g")', async () => {
    const accountId = await withTenantContext(TENANT_US, () =>
      seedAccount({ tenant_id: TENANT_US }),
    );
    await expect(
      withTenantContext(TENANT_US, async () => {
        await insertSession({
          tenant_id: TENANT_US,
          account_id: accountId,
          refresh_token_hash: 'g' + 'a'.repeat(63),
        });
      }),
    ).rejects.toThrow(/session_refresh_token_hash_format|check constraint/i);
  });
});

// ---------------------------------------------------------------------------
// §4 — Revocation consistency + enum
// ---------------------------------------------------------------------------

describe('sessions migration — §4 revocation CHECKs', () => {
  it('§4a accepts both NULL (active session)', async () => {
    const accountId = await withTenantContext(TENANT_US, () =>
      seedAccount({ tenant_id: TENANT_US }),
    );
    await withTenantContext(TENANT_US, async () => {
      await insertSession({
        tenant_id: TENANT_US,
        account_id: accountId,
        revoked_at: null,
        revoked_reason: null,
      });
    });
  });

  it('§4b accepts both NOT NULL with valid reason', async () => {
    const accountId = await withTenantContext(TENANT_US, () =>
      seedAccount({ tenant_id: TENANT_US }),
    );
    await withTenantContext(TENANT_US, async () => {
      await insertSession({
        tenant_id: TENANT_US,
        account_id: accountId,
        revoked_at: new Date().toISOString(),
        revoked_reason: 'patient_logout',
      });
    });
  });

  it('§4c rejects revoked_at NOT NULL with revoked_reason NULL (consistency violation)', async () => {
    const accountId = await withTenantContext(TENANT_US, () =>
      seedAccount({ tenant_id: TENANT_US }),
    );
    await expect(
      withTenantContext(TENANT_US, async () => {
        await insertSession({
          tenant_id: TENANT_US,
          account_id: accountId,
          revoked_at: new Date().toISOString(),
          revoked_reason: null,
        });
      }),
    ).rejects.toThrow(/session_revocation_consistent|check constraint/i);
  });

  it('§4d rejects revoked_at NULL with revoked_reason NOT NULL (consistency violation)', async () => {
    const accountId = await withTenantContext(TENANT_US, () =>
      seedAccount({ tenant_id: TENANT_US }),
    );
    await expect(
      withTenantContext(TENANT_US, async () => {
        await insertSession({
          tenant_id: TENANT_US,
          account_id: accountId,
          revoked_at: null,
          revoked_reason: 'patient_logout',
        });
      }),
    ).rejects.toThrow(/session_revocation_consistent|check constraint/i);
  });

  it("§4e rejects revoked_reason='made_up' (not in the documented enum)", async () => {
    const accountId = await withTenantContext(TENANT_US, () =>
      seedAccount({ tenant_id: TENANT_US }),
    );
    await expect(
      withTenantContext(TENANT_US, async () => {
        await insertSession({
          tenant_id: TENANT_US,
          account_id: accountId,
          revoked_at: new Date().toISOString(),
          revoked_reason: 'made_up',
        });
      }),
    ).rejects.toThrow(/check constraint|revoked_reason/i);
  });
});

// ---------------------------------------------------------------------------
// §5 — Tenant-scoped refresh_token_hash uniqueness
// ---------------------------------------------------------------------------

describe('sessions migration — §5 tenant-scoped refresh_token_hash uniqueness', () => {
  it('§5a same hash across two tenants → both inserts succeed', async () => {
    const sharedHash = crypto.randomBytes(32).toString('hex');

    const usAccountId = await withTenantContext(TENANT_US, () =>
      seedAccount({ tenant_id: TENANT_US }),
    );
    await withTenantContext(TENANT_US, () =>
      insertSession({
        tenant_id: TENANT_US,
        account_id: usAccountId,
        refresh_token_hash: sharedHash,
      }),
    );

    const ghAccountId = await withTenantContext(TENANT_GHANA, () =>
      seedAccount({
        tenant_id: TENANT_GHANA,
        country_of_residence: 'GH',
        country_of_care: 'GH',
      }),
    );
    await withTenantContext(TENANT_GHANA, () =>
      insertSession({
        tenant_id: TENANT_GHANA,
        account_id: ghAccountId,
        refresh_token_hash: sharedHash,
      }),
    );
  });

  it('§5b duplicate hash within one tenant → UNIQUE violation', async () => {
    const accountId = await withTenantContext(TENANT_US, () =>
      seedAccount({ tenant_id: TENANT_US }),
    );
    const dupHash = crypto.randomBytes(32).toString('hex');
    await withTenantContext(TENANT_US, () =>
      insertSession({
        tenant_id: TENANT_US,
        account_id: accountId,
        refresh_token_hash: dupHash,
      }),
    );

    await expect(
      withTenantContext(TENANT_US, async () => {
        await insertSession({
          tenant_id: TENANT_US,
          account_id: accountId,
          refresh_token_hash: dupHash,
        });
      }),
    ).rejects.toThrow(/duplicate key|uq_session_tenant_refresh_hash|unique constraint/i);
  });
});

// ---------------------------------------------------------------------------
// §6 — last_active_at trigger
// ---------------------------------------------------------------------------

describe('sessions migration — §6 last_active_at trigger', () => {
  it('§6a UPDATE bumps last_active_at via clock_timestamp() (advances within tx)', async () => {
    const accountId = await withTenantContext(TENANT_US, () =>
      seedAccount({ tenant_id: TENANT_US }),
    );
    const sessionId = await withTenantContext(TENANT_US, () =>
      insertSession({ tenant_id: TENANT_US, account_id: accountId }),
    );

    const before = await withTenantContext(TENANT_US, async () => {
      const r = await getTestClient().query<{ last_active_at: Date }>(
        'SELECT last_active_at FROM sessions WHERE session_id = $1',
        [sessionId],
      );
      return r.rows[0]!.last_active_at;
    });

    await new Promise((resolve) => setTimeout(resolve, 5));

    await withTenantContext(TENANT_US, async () => {
      // Touch a column other than last_active_at to verify the trigger
      // bumps the activity stamp on any UPDATE (mirrors the refresh-flow
      // service-layer behavior of UPDATE on the row → trigger advances).
      await getTestClient().query(
        "UPDATE sessions SET ip_address = '10.0.0.1' WHERE session_id = $1",
        [sessionId],
      );
    });

    const after = await withTenantContext(TENANT_US, async () => {
      const r = await getTestClient().query<{ last_active_at: Date }>(
        'SELECT last_active_at FROM sessions WHERE session_id = $1',
        [sessionId],
      );
      return r.rows[0]!.last_active_at;
    });

    expect(after.getTime()).toBeGreaterThan(before.getTime());
  });
});
