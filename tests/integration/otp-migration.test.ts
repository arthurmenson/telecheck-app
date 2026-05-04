/**
 * migrations/014_otp.sql — schema-level integration tests.
 *
 * Validates the migration empirically:
 *   - RLS isolation
 *   - Composite FK to accounts (when account_id is non-null)
 *   - Registration case: account_id NULL is permitted
 *   - code_hash format CHECK (SHA-256 hex, 64 lowercase chars)
 *   - phone_e164 format CHECK
 *   - purpose enum CHECK
 *   - attempts_remaining range CHECK (0..3)
 *   - expires_after_creation sanity CHECK
 *
 * Coverage in this file (5 sections, 13 cases).
 *
 * Spec references:
 *   - migrations/014_otp.sql (target)
 *   - Identity & Authentication Spec v1.0 §2.1 / §3.1 (OTP semantics)
 *   - CDM v1.2 §3.2 entity 9 "OTP"
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

async function seedAccount(input: InsertAccountInput): Promise<{
  accountId: string;
  phone: string;
}> {
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
  return { accountId, phone };
}

interface InsertOtpInput {
  otp_id?: string;
  tenant_id: string;
  account_id?: string | null;
  phone_e164: string;
  purpose?: string;
  code_hash?: string;
  attempts_remaining?: number;
  expires_at?: string;
  created_at?: string;
}

async function insertOtp(input: InsertOtpInput): Promise<string> {
  const client = getTestClient();
  const otpId = input.otp_id ?? ulid();
  const codeHash = input.code_hash ?? crypto.randomBytes(32).toString('hex');
  const expiresAt = input.expires_at ?? new Date(Date.now() + 5 * 60 * 1000).toISOString();
  const createdAt = input.created_at ?? new Date().toISOString();
  await client.query(
    `INSERT INTO otp_challenges (
        otp_id, tenant_id, account_id, phone_e164, purpose,
        code_hash, attempts_remaining,
        created_at, expires_at
     ) VALUES ($1, $2, $3, $4, $5,
               $6, $7,
               $8, $9)`,
    [
      otpId,
      input.tenant_id,
      input.account_id ?? null,
      input.phone_e164,
      input.purpose ?? 'login',
      codeHash,
      input.attempts_remaining ?? 3,
      createdAt,
      expiresAt,
    ],
  );
  return otpId;
}

// ---------------------------------------------------------------------------
// §1 — RLS isolation
// ---------------------------------------------------------------------------

describe('otp migration — §1 RLS tenant_isolation', () => {
  it('§1a OTP inserted in US is invisible from Ghana', async () => {
    const { accountId, phone } = await withTenantContext(TENANT_US, () =>
      seedAccount({ tenant_id: TENANT_US }),
    );
    await withTenantContext(TENANT_US, () =>
      insertOtp({ tenant_id: TENANT_US, account_id: accountId, phone_e164: phone }),
    );

    const visibleFromGhana = await withTenantContext(TENANT_GHANA, async () => {
      const r = await getTestClient().query('SELECT 1 FROM otp_challenges WHERE phone_e164 = $1', [
        phone,
      ]);
      return r.rows.length;
    });
    expect(visibleFromGhana).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// §2 — Account binding (composite FK + registration NULL case)
// ---------------------------------------------------------------------------

describe('otp migration — §2 account binding', () => {
  it('§2a OTP with NULL account_id permitted (registration case)', async () => {
    // Registration: brand-new patient with no account yet — OTP binds
    // to phone_e164 only.
    await withTenantContext(TENANT_US, async () => {
      await insertOtp({
        tenant_id: TENANT_US,
        account_id: null,
        phone_e164: '+15551234567',
        purpose: 'registration',
      });
    });
  });

  it('§2b OTP with valid account_id binds via composite FK', async () => {
    const { accountId, phone } = await withTenantContext(TENANT_US, () =>
      seedAccount({ tenant_id: TENANT_US }),
    );
    await withTenantContext(TENANT_US, () =>
      insertOtp({ tenant_id: TENANT_US, account_id: accountId, phone_e164: phone }),
    );
  });

  it('§2c OTP with cross-tenant account_id rejected by composite FK', async () => {
    // Account in Ghana; OTP attempted in US — composite FK lookup
    // for (US, accountId) finds no row.
    const { accountId, phone } = await withTenantContext(TENANT_GHANA, () =>
      seedAccount({
        tenant_id: TENANT_GHANA,
        country_of_residence: 'GH',
        country_of_care: 'GH',
      }),
    );
    await expect(
      withTenantContext(TENANT_US, async () => {
        await insertOtp({
          tenant_id: TENANT_US,
          account_id: accountId,
          phone_e164: phone,
        });
      }),
    ).rejects.toThrow(/foreign key|fk_otp_account|violates/i);
  });
});

// ---------------------------------------------------------------------------
// §3 — Format CHECKs
// ---------------------------------------------------------------------------

describe('otp migration — §3 format CHECKs', () => {
  it('§3a code_hash accepts 64 lowercase hex', async () => {
    await withTenantContext(TENANT_US, async () => {
      await insertOtp({
        tenant_id: TENANT_US,
        phone_e164: '+15551234567',
        code_hash: 'a'.repeat(64),
        purpose: 'registration',
      });
    });
  });

  it('§3b code_hash rejects 63-char too-short', async () => {
    await expect(
      withTenantContext(TENANT_US, async () => {
        await insertOtp({
          tenant_id: TENANT_US,
          phone_e164: '+15551234567',
          code_hash: 'a'.repeat(63),
          purpose: 'registration',
        });
      }),
    ).rejects.toThrow(/otp_code_hash_format|check constraint|value too long/i);
  });

  it('§3c phone_e164 rejects bare digits', async () => {
    await expect(
      withTenantContext(TENANT_US, async () => {
        await insertOtp({
          tenant_id: TENANT_US,
          phone_e164: '15551234567',
          purpose: 'registration',
        });
      }),
    ).rejects.toThrow(/otp_phone_e164_format|check constraint/i);
  });
});

// ---------------------------------------------------------------------------
// §4 — Enum + range CHECKs
// ---------------------------------------------------------------------------

describe('otp migration — §4 enum + range CHECKs', () => {
  it('§4a purpose accepts every documented value', async () => {
    for (const p of ['registration', 'login', 'phone_number_change', 'sensitive_action']) {
      await withTenantContext(TENANT_US, async () => {
        await insertOtp({
          tenant_id: TENANT_US,
          phone_e164: '+15551234567',
          purpose: p,
        });
      });
    }
  });

  it("§4b purpose rejects 'made_up' (out of enum)", async () => {
    await expect(
      withTenantContext(TENANT_US, async () => {
        await insertOtp({
          tenant_id: TENANT_US,
          phone_e164: '+15551234567',
          purpose: 'made_up',
        });
      }),
    ).rejects.toThrow(/check constraint|purpose/i);
  });

  it('§4c attempts_remaining accepts 0, 1, 2, 3', async () => {
    for (const n of [0, 1, 2, 3]) {
      await withTenantContext(TENANT_US, async () => {
        await insertOtp({
          tenant_id: TENANT_US,
          phone_e164: '+15551234567',
          purpose: 'login',
          attempts_remaining: n,
        });
      });
    }
  });

  it('§4d attempts_remaining rejects -1 (below range)', async () => {
    await expect(
      withTenantContext(TENANT_US, async () => {
        await insertOtp({
          tenant_id: TENANT_US,
          phone_e164: '+15551234567',
          purpose: 'login',
          attempts_remaining: -1,
        });
      }),
    ).rejects.toThrow(/check constraint|attempts_remaining/i);
  });

  it('§4e attempts_remaining rejects 4 (above range)', async () => {
    await expect(
      withTenantContext(TENANT_US, async () => {
        await insertOtp({
          tenant_id: TENANT_US,
          phone_e164: '+15551234567',
          purpose: 'login',
          attempts_remaining: 4,
        });
      }),
    ).rejects.toThrow(/check constraint|attempts_remaining/i);
  });
});

// ---------------------------------------------------------------------------
// §5 — expires_at sanity CHECK
// ---------------------------------------------------------------------------

describe('otp migration — §5 otp_expiry_after_creation CHECK', () => {
  it('§5a expires_at = created_at rejected (not strictly after)', async () => {
    const ts = new Date().toISOString();
    await expect(
      withTenantContext(TENANT_US, async () => {
        await insertOtp({
          tenant_id: TENANT_US,
          phone_e164: '+15551234567',
          purpose: 'login',
          created_at: ts,
          expires_at: ts,
        });
      }),
    ).rejects.toThrow(/otp_expiry_after_creation|check constraint/i);
  });

  it('§5b expires_at BEFORE created_at rejected', async () => {
    const created = new Date();
    const expires = new Date(created.getTime() - 1000); // 1s before
    await expect(
      withTenantContext(TENANT_US, async () => {
        await insertOtp({
          tenant_id: TENANT_US,
          phone_e164: '+15551234567',
          purpose: 'login',
          created_at: created.toISOString(),
          expires_at: expires.toISOString(),
        });
      }),
    ).rejects.toThrow(/otp_expiry_after_creation|check constraint/i);
  });
});
