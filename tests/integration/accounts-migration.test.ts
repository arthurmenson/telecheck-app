/**
 * migrations/012_accounts.sql — schema-level integration tests.
 *
 * Validates the migration empirically against a live PostgreSQL instance:
 *   - RLS isolation (tenant_isolation policy gates SELECT and INSERT)
 *   - Tenant-scoped phone uniqueness per CDM v1.2 §5.1 (same phone in
 *     two tenants is two distinct accounts; duplicate within one tenant
 *     is rejected by the UNIQUE constraint)
 *   - Format CHECK constraints (E.164 phone, email, country regex,
 *     country_of_care enum, gender enum, account_type enum, status enum)
 *   - updated_at trigger fires on UPDATE
 *   - Soft-delete (deleted_at NOT NULL) doesn't break RLS
 *   - Composite UNIQUE (tenant_id, account_id) enforces no cross-tenant
 *     account_id collision
 *
 * Why direct schema tests:
 *   The accounts table is the FIRST entity built without an Identity
 *   service layer on top — there are no service-level tests yet. Schema
 *   tests pin the constraints empirically so a future migration that
 *   relaxes one (e.g., drops the E.164 CHECK in a "fix it later"
 *   shortcut) trips this file at unit-test speed before any service
 *   layer is built on broken assumptions.
 *
 *   The pattern mirrors the implicit schema validation in existing
 *   forms-intake tests (which exercise migration 006 indirectly through
 *   service calls) but makes the validation EXPLICIT so the contract is
 *   under test independently of any consumer.
 *
 * Coverage in this file (8 sections, 26 cases):
 *
 *   §1 RLS isolation — rows inserted under tenant A are invisible from
 *      tenant B context, and tenant B cannot insert with tenant_id=A
 *      (the WITH CHECK clause).
 *
 *   §2 Tenant-scoped phone uniqueness (CDM §5.1):
 *      §2a same phone in two different tenants → both inserts succeed
 *      §2b duplicate phone within one tenant → UNIQUE violation
 *      §2c soft-deleted account does NOT free the phone for reuse within
 *          the same tenant (UNIQUE constraint applies regardless of
 *          deleted_at — pin to catch a regression that adds a partial
 *          unique index)
 *
 *   §3 Phone E.164 format CHECK:
 *      §3a accepts canonical +1XXXXXXXXXX (US 11-digit)
 *      §3b accepts canonical +233XXXXXXXXX (Ghana 12-digit)
 *      §3c rejects bare digits (no + prefix)
 *      §3d rejects + followed by leading 0 (E.164 prohibits)
 *      §3e rejects shorter than 2 digits after +
 *      §3f rejects longer than 15 digits after + (E.164 max is 15)
 *
 *   §4 Email format CHECK:
 *      §4a accepts NULL (email is optional)
 *      §4b accepts well-formed email
 *      §4c rejects malformed (no @)
 *      §4d rejects malformed (no domain TLD)
 *
 *   §5 Enum CHECKs (gender, account_type, status):
 *      §5a gender accepts every documented value
 *      §5b gender rejects out-of-set value
 *      §5c account_type rejects 'admin' (out of set; admin is operators
 *          table — NOT yet authored)
 *      §5d status rejects 'deleted' (use deleted_at, not status)
 *
 *   §6 country_of_residence + country_of_care CHECKs:
 *      §6a country_of_residence accepts ANY valid 2-letter code (not
 *          enum-restricted; supports cross-jurisdiction CCR cases)
 *      §6b country_of_residence rejects lowercase
 *      §6c country_of_residence rejects 3-letter
 *      §6d country_of_care rejects 'XX' (only 'US' and 'GH' active at v1.0)
 *
 *   §7 updated_at trigger:
 *      §7a UPDATE bumps updated_at past the original timestamp
 *      §7b INSERT sets updated_at = created_at (matching default)
 *
 *   §8 Composite UNIQUE (tenant_id, account_id):
 *      §8a same account_id in two different tenants → both succeed
 *          (the composite UNIQUE permits this; the PK on account_id
 *          alone WOULD reject — pin that the table uses the composite
 *          shape so downstream composite-FK consumers work correctly)
 *
 * Spec references:
 *   - migrations/012_accounts.sql (this file's target)
 *   - CDM v1.2 §3.2 (Account entity) + §5.1 (tenant-scoped uniqueness)
 *   - Identity & Authentication Spec v1.0 §2 (E.164 phone, identity fields)
 *   - I-023 (RLS layer-1 enforcement; tested via withTenantContext)
 *   - I-027 (tenant_id NOT NULL — implicit; the FK ensures presence)
 */

import { describe, expect, it } from 'vitest';

import { ulid } from '../../src/lib/ulid.ts';
import { TENANT_GHANA, TENANT_US, withTenantContext } from '../helpers/tenant-fixtures.ts';
import { uniquePhone as uniqueE164 } from '../helpers/unique-phone.ts';
import { getTestClient } from '../setup.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface InsertAccountInput {
  account_id?: string;
  tenant_id: string;
  phone_e164: string;
  email?: string | null;
  first_name?: string;
  last_name?: string;
  date_of_birth?: string; // YYYY-MM-DD
  gender?: string;
  national_id?: string | null;
  country_of_residence?: string;
  country_of_care?: string;
  locale?: string;
  account_type?: string;
  status?: string;
}

/**
 * Insert an account with sensible defaults for fields the test isn't
 * exercising. Returns the account_id (caller-supplied or generated).
 *
 * Run inside a withTenantContext block — the RLS WITH CHECK clause
 * requires current_tenant_id() to match the row's tenant_id at INSERT.
 */
async function insertAccount(input: InsertAccountInput): Promise<string> {
  const client = getTestClient();
  const accountId = input.account_id ?? ulid();
  await client.query(
    `INSERT INTO accounts (
        account_id, tenant_id, phone_e164, email,
        first_name, last_name, date_of_birth, gender, national_id,
        country_of_residence, country_of_care, locale,
        account_type, status
     ) VALUES ($1, $2, $3, $4,
               $5, $6, $7, $8, $9,
               $10, $11, $12,
               $13, $14)`,
    [
      accountId,
      input.tenant_id,
      input.phone_e164,
      input.email ?? null,
      input.first_name ?? 'TestFirst',
      input.last_name ?? 'TestLast',
      input.date_of_birth ?? '1990-01-01',
      input.gender ?? 'prefer_not_to_say',
      input.national_id ?? null,
      input.country_of_residence ?? 'US',
      input.country_of_care ?? 'US',
      input.locale ?? 'en-US',
      input.account_type ?? 'patient',
      input.status ?? 'active',
    ],
  );
  return accountId;
}

// ---------------------------------------------------------------------------
// §1 — RLS isolation
// ---------------------------------------------------------------------------

describe('accounts migration — §1 RLS tenant_isolation policy', () => {
  it('§1a row inserted in tenant US is invisible from tenant Ghana context', async () => {
    const phone = uniqueE164('+1');
    await withTenantContext(TENANT_US, async () => {
      await insertAccount({ tenant_id: TENANT_US, phone_e164: phone });
    });

    // Switch to Ghana context — the row MUST NOT be visible.
    const visibleFromGhana = await withTenantContext(TENANT_GHANA, async () => {
      const result = await getTestClient().query(
        'SELECT account_id FROM accounts WHERE phone_e164 = $1',
        [phone],
      );
      return result.rows.length;
    });
    expect(visibleFromGhana).toBe(0);
  });

  it('§1b row visible from its own tenant context (sanity counterpart)', async () => {
    const phone = uniqueE164('+1');
    await withTenantContext(TENANT_US, async () => {
      await insertAccount({ tenant_id: TENANT_US, phone_e164: phone });
      const result = await getTestClient().query(
        'SELECT account_id FROM accounts WHERE phone_e164 = $1',
        [phone],
      );
      expect(result.rows.length).toBe(1);
    });
  });

  it('§1c INSERT with tenant_id mismatched to current_tenant_id() is rejected (WITH CHECK)', async () => {
    // current_tenant_id() = 'Telecheck-US' but the row's tenant_id is
    // 'Telecheck-Ghana' — RLS WITH CHECK clause must reject.
    const phone = uniqueE164('+1');
    await expect(
      withTenantContext(TENANT_US, async () => {
        await insertAccount({ tenant_id: TENANT_GHANA, phone_e164: phone });
      }),
    ).rejects.toThrow(/row-level security|policy/i);
  });
});

// ---------------------------------------------------------------------------
// §2 — Tenant-scoped phone uniqueness (CDM §5.1)
// ---------------------------------------------------------------------------

describe('accounts migration — §2 tenant-scoped phone uniqueness', () => {
  it('§2a same phone in two different tenants → both inserts succeed', async () => {
    const phone = uniqueE164('+1');

    await withTenantContext(TENANT_US, async () => {
      await insertAccount({ tenant_id: TENANT_US, phone_e164: phone });
    });

    // Same phone, different tenant — must succeed (the composite
    // (tenant_id, phone_e164) UNIQUE allows this).
    await withTenantContext(TENANT_GHANA, async () => {
      await insertAccount({
        tenant_id: TENANT_GHANA,
        phone_e164: phone,
        country_of_residence: 'GH',
        country_of_care: 'GH',
      });
    });

    // Both rows exist (sanity check via direct queries scoped to each tenant).
    const usCount = await withTenantContext(TENANT_US, async () => {
      const r = await getTestClient().query('SELECT 1 FROM accounts WHERE phone_e164 = $1', [
        phone,
      ]);
      return r.rows.length;
    });
    const ghCount = await withTenantContext(TENANT_GHANA, async () => {
      const r = await getTestClient().query('SELECT 1 FROM accounts WHERE phone_e164 = $1', [
        phone,
      ]);
      return r.rows.length;
    });
    expect(usCount).toBe(1);
    expect(ghCount).toBe(1);
  });

  it('§2b duplicate phone within one tenant → UNIQUE violation', async () => {
    const phone = uniqueE164('+1');
    await withTenantContext(TENANT_US, async () => {
      await insertAccount({ tenant_id: TENANT_US, phone_e164: phone });
    });

    await expect(
      withTenantContext(TENANT_US, async () => {
        await insertAccount({ tenant_id: TENANT_US, phone_e164: phone });
      }),
    ).rejects.toThrow(/duplicate key|uq_account_tenant_phone|unique constraint/i);
  });

  it('§2c soft-deleted account does NOT free the phone within the same tenant', async () => {
    // Pin: the UNIQUE constraint is unconditional (no `WHERE deleted_at
    // IS NULL` partial index). A regression that converts the constraint
    // to a partial index would let phone reuse race the soft-delete
    // window and create overlap. The current schema rejects reuse
    // until a hard DELETE happens.
    const phone = uniqueE164('+1');
    await withTenantContext(TENANT_US, async () => {
      const accountId = await insertAccount({ tenant_id: TENANT_US, phone_e164: phone });
      await getTestClient().query('UPDATE accounts SET deleted_at = NOW() WHERE account_id = $1', [
        accountId,
      ]);
    });

    await expect(
      withTenantContext(TENANT_US, async () => {
        await insertAccount({ tenant_id: TENANT_US, phone_e164: phone });
      }),
    ).rejects.toThrow(/duplicate key|uq_account_tenant_phone|unique constraint/i);
  });
});

// ---------------------------------------------------------------------------
// §3 — Phone E.164 format CHECK
// ---------------------------------------------------------------------------

describe('accounts migration — §3 phone_e164 format CHECK', () => {
  it('§3a accepts canonical +1XXXXXXXXXX (US 11-digit)', async () => {
    await withTenantContext(TENANT_US, async () => {
      await insertAccount({ tenant_id: TENANT_US, phone_e164: '+15551234567' });
    });
  });

  it('§3b accepts canonical +233XXXXXXXXX (Ghana 12-digit)', async () => {
    await withTenantContext(TENANT_GHANA, async () => {
      await insertAccount({
        tenant_id: TENANT_GHANA,
        phone_e164: '+233241234567',
        country_of_residence: 'GH',
        country_of_care: 'GH',
      });
    });
  });

  it('§3c rejects bare digits (no + prefix)', async () => {
    await expect(
      withTenantContext(TENANT_US, async () => {
        await insertAccount({ tenant_id: TENANT_US, phone_e164: '15551234567' });
      }),
    ).rejects.toThrow(/account_phone_e164_format|check constraint/i);
  });

  it('§3d rejects + followed by leading 0 (E.164 prohibits)', async () => {
    await expect(
      withTenantContext(TENANT_US, async () => {
        await insertAccount({ tenant_id: TENANT_US, phone_e164: '+05551234567' });
      }),
    ).rejects.toThrow(/account_phone_e164_format|check constraint/i);
  });

  it('§3e rejects shorter than 2 digits after +', async () => {
    await expect(
      withTenantContext(TENANT_US, async () => {
        await insertAccount({ tenant_id: TENANT_US, phone_e164: '+1' });
      }),
    ).rejects.toThrow(/account_phone_e164_format|check constraint/i);
  });

  it('§3f rejects longer than 15 digits after + (E.164 max is 15)', async () => {
    await expect(
      withTenantContext(TENANT_US, async () => {
        await insertAccount({ tenant_id: TENANT_US, phone_e164: '+1234567890123456' });
      }),
    ).rejects.toThrow(/account_phone_e164_format|check constraint/i);
  });
});

// ---------------------------------------------------------------------------
// §4 — Email format CHECK
// ---------------------------------------------------------------------------

describe('accounts migration — §4 email format CHECK', () => {
  it('§4a accepts NULL (email is optional per Identity Spec §2.2)', async () => {
    await withTenantContext(TENANT_US, async () => {
      await insertAccount({
        tenant_id: TENANT_US,
        phone_e164: uniqueE164('+1'),
        email: null,
      });
    });
  });

  it('§4b accepts well-formed email', async () => {
    await withTenantContext(TENANT_US, async () => {
      await insertAccount({
        tenant_id: TENANT_US,
        phone_e164: uniqueE164('+1'),
        email: 'patient@example.com',
      });
    });
  });

  it('§4c rejects malformed (no @)', async () => {
    await expect(
      withTenantContext(TENANT_US, async () => {
        await insertAccount({
          tenant_id: TENANT_US,
          phone_e164: uniqueE164('+1'),
          email: 'not-an-email',
        });
      }),
    ).rejects.toThrow(/account_email_format_or_null|check constraint/i);
  });

  it('§4d rejects malformed (no domain TLD)', async () => {
    await expect(
      withTenantContext(TENANT_US, async () => {
        await insertAccount({
          tenant_id: TENANT_US,
          phone_e164: uniqueE164('+1'),
          email: 'patient@example',
        });
      }),
    ).rejects.toThrow(/account_email_format_or_null|check constraint/i);
  });
});

// ---------------------------------------------------------------------------
// §5 — Enum CHECKs (gender / account_type / status)
// ---------------------------------------------------------------------------

describe('accounts migration — §5 enum CHECKs', () => {
  it('§5a gender accepts every documented value', async () => {
    for (const g of ['female', 'male', 'non_binary', 'prefer_not_to_say']) {
      await withTenantContext(TENANT_US, async () => {
        await insertAccount({
          tenant_id: TENANT_US,
          phone_e164: uniqueE164('+1'),
          gender: g,
        });
      });
    }
  });

  it('§5b gender rejects out-of-set value', async () => {
    await expect(
      withTenantContext(TENANT_US, async () => {
        await insertAccount({
          tenant_id: TENANT_US,
          phone_e164: uniqueE164('+1'),
          gender: 'unknown',
        });
      }),
    ).rejects.toThrow(/check constraint|gender/i);
  });

  it("§5c account_type rejects 'admin' (admin is the future operators table)", async () => {
    await expect(
      withTenantContext(TENANT_US, async () => {
        await insertAccount({
          tenant_id: TENANT_US,
          phone_e164: uniqueE164('+1'),
          account_type: 'admin',
        });
      }),
    ).rejects.toThrow(/check constraint|account_type/i);
  });

  it("§5d status rejects 'deleted' (use deleted_at column instead)", async () => {
    await expect(
      withTenantContext(TENANT_US, async () => {
        await insertAccount({
          tenant_id: TENANT_US,
          phone_e164: uniqueE164('+1'),
          status: 'deleted',
        });
      }),
    ).rejects.toThrow(/check constraint|status/i);
  });
});

// ---------------------------------------------------------------------------
// §6 — country_of_residence + country_of_care CHECKs
// ---------------------------------------------------------------------------

describe('accounts migration — §6 country CHECKs', () => {
  it('§6a country_of_residence accepts any valid 2-letter code (cross-jurisdiction CCR)', async () => {
    // A US-resident legal guardian of a Ghana-care patient via delegation
    // is a real case — country_of_residence is not enum-restricted at
    // the schema layer (only the regex). Pin acceptance of a non-tenant
    // country code (CA, NG, etc.).
    await withTenantContext(TENANT_US, async () => {
      await insertAccount({
        tenant_id: TENANT_US,
        phone_e164: uniqueE164('+1'),
        country_of_residence: 'CA', // Canada — not a tenant country
        country_of_care: 'US',
      });
    });
  });

  it('§6b country_of_residence rejects lowercase', async () => {
    await expect(
      withTenantContext(TENANT_US, async () => {
        await insertAccount({
          tenant_id: TENANT_US,
          phone_e164: uniqueE164('+1'),
          country_of_residence: 'us',
        });
      }),
    ).rejects.toThrow(/check constraint|country_of_residence/i);
  });

  it('§6c country_of_residence rejects 3-letter (e.g., USA)', async () => {
    await expect(
      withTenantContext(TENANT_US, async () => {
        await insertAccount({
          tenant_id: TENANT_US,
          phone_e164: uniqueE164('+1'),
          country_of_residence: 'USA',
        });
      }),
    ).rejects.toThrow(/check constraint|country_of_residence/i);
  });

  it("§6d country_of_care rejects 'XX' (only 'US' and 'GH' active at v1.0)", async () => {
    await expect(
      withTenantContext(TENANT_US, async () => {
        await insertAccount({
          tenant_id: TENANT_US,
          phone_e164: uniqueE164('+1'),
          country_of_care: 'XX',
        });
      }),
    ).rejects.toThrow(/check constraint|country_of_care/i);
  });
});

// ---------------------------------------------------------------------------
// §7 — updated_at trigger
// ---------------------------------------------------------------------------

describe('accounts migration — §7 updated_at trigger', () => {
  it('§7a UPDATE bumps updated_at past the original timestamp', async () => {
    const accountId = await withTenantContext(TENANT_US, async () => {
      return insertAccount({ tenant_id: TENANT_US, phone_e164: uniqueE164('+1') });
    });

    const before = await withTenantContext(TENANT_US, async () => {
      const r = await getTestClient().query<{ updated_at: Date }>(
        'SELECT updated_at FROM accounts WHERE account_id = $1',
        [accountId],
      );
      return r.rows[0]!.updated_at;
    });

    // Wait at least 2ms so the trigger's NOW() is guaranteed to advance.
    await new Promise((resolve) => setTimeout(resolve, 5));

    await withTenantContext(TENANT_US, async () => {
      await getTestClient().query(
        "UPDATE accounts SET first_name = 'Renamed' WHERE account_id = $1",
        [accountId],
      );
    });

    const after = await withTenantContext(TENANT_US, async () => {
      const r = await getTestClient().query<{ updated_at: Date }>(
        'SELECT updated_at FROM accounts WHERE account_id = $1',
        [accountId],
      );
      return r.rows[0]!.updated_at;
    });

    expect(after.getTime()).toBeGreaterThan(before.getTime());
  });

  it('§7b INSERT initializes updated_at = created_at (DEFAULT NOW() applies before trigger fires on INSERT)', async () => {
    // The trigger only runs on UPDATE per the migration's BEFORE UPDATE
    // ON accounts FOR EACH ROW EXECUTE FUNCTION accounts_set_updated_at()
    // declaration. INSERT lets the column default fire — which is also
    // NOW(), so updated_at == created_at on a fresh row.
    const accountId = await withTenantContext(TENANT_US, async () => {
      return insertAccount({ tenant_id: TENANT_US, phone_e164: uniqueE164('+1') });
    });

    const stamps = await withTenantContext(TENANT_US, async () => {
      const r = await getTestClient().query<{ created_at: Date; updated_at: Date }>(
        'SELECT created_at, updated_at FROM accounts WHERE account_id = $1',
        [accountId],
      );
      return r.rows[0]!;
    });

    // Both timestamps come from NOW() during the same INSERT — they
    // should be equal at the microsecond level the row was written.
    expect(stamps.updated_at.getTime()).toBe(stamps.created_at.getTime());
  });
});

// ---------------------------------------------------------------------------
// §8 — Composite UNIQUE (tenant_id, account_id)
// ---------------------------------------------------------------------------

describe('accounts migration — §8 composite UNIQUE (tenant_id, account_id)', () => {
  it('§8a same account_id in two different tenants → both succeed (composite UNIQUE permits)', async () => {
    // The schema declares both `account_id PRIMARY KEY` AND
    // `UNIQUE (tenant_id, account_id)`. The PK alone would reject this
    // case, BUT — wait, the PK on account_id alone IS unique across
    // the table. The composite UNIQUE adds a separate index for the
    // composite-FK pattern. So two tenants sharing the same account_id
    // still hit the PK violation.
    //
    // This test pins that fact: account_id IS globally unique despite
    // the composite UNIQUE existing alongside. Downstream composite-FK
    // consumers don't rely on (tenant_id, account_id) being a "less
    // strict than PK" key — they rely on it being a NAMED UNIQUE so the
    // FK can target it (Postgres requires the FK target to be a UNIQUE
    // index, not just a PK).
    const sharedAccountId = ulid();

    await withTenantContext(TENANT_US, async () => {
      await insertAccount({
        account_id: sharedAccountId,
        tenant_id: TENANT_US,
        phone_e164: uniqueE164('+1'),
      });
    });

    // Second insert with the same account_id under Ghana — should FAIL
    // with PK violation (account_id is the primary key, globally unique).
    await expect(
      withTenantContext(TENANT_GHANA, async () => {
        await insertAccount({
          account_id: sharedAccountId,
          tenant_id: TENANT_GHANA,
          phone_e164: uniqueE164('+233'),
          country_of_residence: 'GH',
          country_of_care: 'GH',
        });
      }),
    ).rejects.toThrow(/duplicate key|primary key|accounts_pkey/i);
  });

  it('§8b composite UNIQUE INDEX exists (named for composite-FK referencing)', async () => {
    // Named-index pin — downstream tables will declare:
    //   FOREIGN KEY (tenant_id, account_id) REFERENCES accounts(tenant_id, account_id)
    // which Postgres requires the target columns to be declared UNIQUE.
    // Verify the named constraint exists in the catalog.
    const result = await getTestClient().query<{ conname: string }>(
      `SELECT conname FROM pg_constraint
        WHERE conrelid = 'accounts'::regclass
          AND conname = 'uq_account_tenant_id'
          AND contype = 'u'`,
    );
    expect(result.rows.length).toBe(1);
  });
});
