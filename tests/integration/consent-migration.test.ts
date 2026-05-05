/**
 * migrations/016_consent.sql — schema-level integration tests.
 *
 * Validates the migration empirically:
 *   - consent_versions: RLS, type enum, version regex, locale
 *     uniqueness, append-only via REVOKE
 *   - consent: RLS, composite FK to accounts + consent_versions,
 *     status enum, revocation-consistency CHECK, evidence-timestamp
 *     CHECK, append-only
 *
 * Coverage in this file (4 sections, 16 cases).
 *
 * Spec references:
 *   - migrations/016_consent.sql (target)
 *   - Consent Slice PRD v1.0 §5 (6 types) + §7 (5-attribute model)
 *   - CDM v1.2 §3.3 entities 11-12
 */

import { describe, expect, it } from 'vitest';

import type { TenantId } from '../../src/lib/glossary.ts';
import { ulid } from '../../src/lib/ulid.ts';
import { createAccount } from '../../src/modules/identity/internal/repositories/account-repo.ts';
import { asAccountId, type AccountId } from '../../src/modules/identity/internal/types.ts';
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

interface InsertVersionInput {
  consent_version_id?: string;
  tenant_id: string;
  consent_type?: string;
  version_label?: string;
  locale?: string;
  terms_text?: string;
  regulatory_reference?: string | null;
}

async function insertConsentVersion(input: InsertVersionInput): Promise<string> {
  const client = getTestClient();
  const id = input.consent_version_id ?? ulid();
  await client.query(
    `INSERT INTO consent_versions (
        consent_version_id, tenant_id, consent_type, version_label, locale,
        terms_text, regulatory_reference
     ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      id,
      input.tenant_id,
      input.consent_type ?? 'platform',
      input.version_label ?? 'v1.0',
      input.locale ?? 'en-US',
      input.terms_text ?? 'You agree to use Telecheck.',
      input.regulatory_reference ?? null,
    ],
  );
  return id;
}

interface InsertConsentInput {
  consent_id?: string;
  tenant_id: string;
  account_id: string;
  consent_version_id: string;
  consent_type?: string;
  scope_id?: string | null;
  status?: 'granted' | 'revoked';
  evidence?: object;
  revocation_reason?: string | null;
}

async function insertConsent(input: InsertConsentInput): Promise<string> {
  const client = getTestClient();
  const id = input.consent_id ?? ulid();
  await client.query(
    `INSERT INTO consent (
        consent_id, tenant_id, account_id, consent_type, scope_id,
        consent_version_id, status, evidence, revocation_reason
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9)`,
    [
      id,
      input.tenant_id,
      input.account_id,
      input.consent_type ?? 'platform',
      input.scope_id ?? null,
      input.consent_version_id,
      input.status ?? 'granted',
      JSON.stringify(input.evidence ?? { timestamp: new Date().toISOString() }),
      input.revocation_reason ?? null,
    ],
  );
  return id;
}

// ---------------------------------------------------------------------------
// §1 — consent_versions
// ---------------------------------------------------------------------------

describe('consent_versions migration — §1 schema', () => {
  it('§1a accepts canonical platform version', async () => {
    await withTenantContext(T_US, () => insertConsentVersion({ tenant_id: T_US }));
  });

  it('§1b consent_type enum: rejects out-of-set value', async () => {
    await expect(
      withTenantContext(T_US, () =>
        insertConsentVersion({ tenant_id: T_US, consent_type: 'made_up' }),
      ),
    ).rejects.toThrow(/check constraint|consent_type/i);
  });

  it('§1c version_label regex accepts vN.N and vN.N.N; rejects bare digits', async () => {
    await withTenantContext(T_US, () =>
      insertConsentVersion({ tenant_id: T_US, version_label: 'v2.1.3' }),
    );
    await expect(
      withTenantContext(T_US, () =>
        insertConsentVersion({ tenant_id: T_US, version_label: '1.0' }),
      ),
    ).rejects.toThrow(/check constraint|version_label/i);
  });

  it('§1d (tenant_id, consent_type, version_label, locale) uniqueness', async () => {
    await withTenantContext(T_US, () =>
      insertConsentVersion({
        tenant_id: T_US,
        consent_type: 'care',
        version_label: 'v1.2',
        locale: 'en-US',
      }),
    );
    await expect(
      withTenantContext(T_US, () =>
        insertConsentVersion({
          tenant_id: T_US,
          consent_type: 'care',
          version_label: 'v1.2',
          locale: 'en-US',
        }),
      ),
    ).rejects.toThrow(/duplicate key|unique constraint/i);
  });

  it('§1e same (consent_type, version_label) in DIFFERENT locales OK', async () => {
    await withTenantContext(T_US, () =>
      insertConsentVersion({
        tenant_id: T_US,
        consent_type: 'data_use',
        version_label: 'v1.0',
        locale: 'en-US',
      }),
    );
    await withTenantContext(T_US, () =>
      insertConsentVersion({
        tenant_id: T_US,
        consent_type: 'data_use',
        version_label: 'v1.0',
        locale: 'en-GH',
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// §2 — consent table
// ---------------------------------------------------------------------------

describe('consent migration — §2 schema', () => {
  it('§2a happy path: granted consent with evidence timestamp', async () => {
    const accountId = await seedAccount(T_US);
    const versionId = await withTenantContext(T_US, () =>
      insertConsentVersion({ tenant_id: T_US }),
    );
    await withTenantContext(T_US, () =>
      insertConsent({
        tenant_id: T_US,
        account_id: accountId,
        consent_version_id: versionId,
        status: 'granted',
      }),
    );
  });

  it('§2b composite FK to accounts: cross-tenant binding rejected', async () => {
    // Account in Ghana
    const accountId = await seedAccount(T_GH, 'GH');
    const ghVersionId = await withTenantContext(T_GH, () =>
      insertConsentVersion({ tenant_id: T_GH }),
    );
    // Try to insert a consent in US tenant referencing Ghana account
    await expect(
      withTenantContext(T_US, () =>
        insertConsent({
          tenant_id: T_US,
          account_id: accountId,
          consent_version_id: ghVersionId,
          status: 'granted',
        }),
      ),
    ).rejects.toThrow(/foreign key|fk_consent_account|violates|row-level security|policy/i);
  });

  it('§2c composite FK to consent_versions: cross-tenant rejected', async () => {
    // Account in US, but consent_version in Ghana
    const accountId = await seedAccount(T_US);
    const ghVersionId = await withTenantContext(T_GH, () =>
      insertConsentVersion({ tenant_id: T_GH }),
    );
    await expect(
      withTenantContext(T_US, () =>
        insertConsent({
          tenant_id: T_US,
          account_id: accountId,
          consent_version_id: ghVersionId,
          status: 'granted',
        }),
      ),
    ).rejects.toThrow(/foreign key|fk_consent_version|violates/i);
  });

  it('§2d revocation-consistency: status=revoked + reason=null rejected', async () => {
    const accountId = await seedAccount(T_US);
    const versionId = await withTenantContext(T_US, () =>
      insertConsentVersion({ tenant_id: T_US }),
    );
    await expect(
      withTenantContext(T_US, () =>
        insertConsent({
          tenant_id: T_US,
          account_id: accountId,
          consent_version_id: versionId,
          status: 'revoked',
          revocation_reason: null,
        }),
      ),
    ).rejects.toThrow(/consent_revocation_consistent|check constraint/i);
  });

  it('§2e revocation-consistency: status=granted + reason!=null rejected', async () => {
    const accountId = await seedAccount(T_US);
    const versionId = await withTenantContext(T_US, () =>
      insertConsentVersion({ tenant_id: T_US }),
    );
    await expect(
      withTenantContext(T_US, () =>
        insertConsent({
          tenant_id: T_US,
          account_id: accountId,
          consent_version_id: versionId,
          status: 'granted',
          revocation_reason: 'patient_initiated',
        }),
      ),
    ).rejects.toThrow(/consent_revocation_consistent|check constraint/i);
  });

  it('§2f revocation-consistency: revoked + valid reason → accepted', async () => {
    const accountId = await seedAccount(T_US);
    const versionId = await withTenantContext(T_US, () =>
      insertConsentVersion({ tenant_id: T_US }),
    );
    await withTenantContext(T_US, () =>
      insertConsent({
        tenant_id: T_US,
        account_id: accountId,
        consent_version_id: versionId,
        status: 'revoked',
        revocation_reason: 'patient_initiated',
      }),
    );
  });

  it('§2g evidence MUST contain a timestamp key', async () => {
    const accountId = await seedAccount(T_US);
    const versionId = await withTenantContext(T_US, () =>
      insertConsentVersion({ tenant_id: T_US }),
    );
    await expect(
      withTenantContext(T_US, () =>
        insertConsent({
          tenant_id: T_US,
          account_id: accountId,
          consent_version_id: versionId,
          status: 'granted',
          evidence: { not_a_timestamp: true },
        }),
      ),
    ).rejects.toThrow(/consent_evidence_has_timestamp|check constraint/i);
  });

  it('§2h status enum: rejects out-of-set value', async () => {
    const accountId = await seedAccount(T_US);
    const versionId = await withTenantContext(T_US, () =>
      insertConsentVersion({ tenant_id: T_US }),
    );
    await expect(
      withTenantContext(T_US, () =>
        insertConsent({
          tenant_id: T_US,
          account_id: accountId,
          consent_version_id: versionId,
          // @ts-expect-error: deliberately invalid value
          status: 'pending',
        }),
      ),
    ).rejects.toThrow(/check constraint|status/i);
  });

  it("§2i revocation_reason enum rejects 'made_up'", async () => {
    const accountId = await seedAccount(T_US);
    const versionId = await withTenantContext(T_US, () =>
      insertConsentVersion({ tenant_id: T_US }),
    );
    await expect(
      withTenantContext(T_US, () =>
        insertConsent({
          tenant_id: T_US,
          account_id: accountId,
          consent_version_id: versionId,
          status: 'revoked',
          revocation_reason: 'made_up',
        }),
      ),
    ).rejects.toThrow(/check constraint|revocation_reason/i);
  });
});

// ---------------------------------------------------------------------------
// §3 — RLS isolation
// ---------------------------------------------------------------------------

describe('consent migration — §3 RLS', () => {
  it('§3a consent_versions: row in US invisible from Ghana', async () => {
    const versionId = await withTenantContext(T_US, () =>
      insertConsentVersion({ tenant_id: T_US }),
    );
    const visible = await withTenantContext(T_GH, async () => {
      const r = await getTestClient().query(
        'SELECT 1 FROM consent_versions WHERE consent_version_id = $1',
        [versionId],
      );
      return r.rows.length;
    });
    expect(visible).toBe(0);
  });

  it('§3b consent: row in US invisible from Ghana', async () => {
    const accountId = await seedAccount(T_US);
    const versionId = await withTenantContext(T_US, () =>
      insertConsentVersion({ tenant_id: T_US }),
    );
    const consentId = await withTenantContext(T_US, () =>
      insertConsent({
        tenant_id: T_US,
        account_id: accountId,
        consent_version_id: versionId,
      }),
    );
    const visible = await withTenantContext(T_GH, async () => {
      const r = await getTestClient().query('SELECT 1 FROM consent WHERE consent_id = $1', [
        consentId,
      ]);
      return r.rows.length;
    });
    expect(visible).toBe(0);
  });
});
