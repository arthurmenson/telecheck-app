/**
 * consent-service.ts — direct integration tests.
 *
 * Coverage in this file (3 sections, 9 cases):
 *   §1 grantConsent (3 cases)
 *   §2 revokeConsent (3 cases) — happy + idempotent no-op + null-when-no-grant
 *   §3 hasActiveConsent (3 cases) — runtime check per Slice PRD §7.2
 *
 * Spec references:
 *   - consent-service.ts (target)
 *   - Consent Slice PRD v1.0 §5-§9
 */

import { describe, expect, it } from 'vitest';

import { asTenantId } from '../../src/lib/glossary.ts';
import type { TenantContext } from '../../src/lib/tenant-context.ts';
import { ulid } from '../../src/lib/ulid.ts';
import { createConsentVersion } from '../../src/modules/consent/internal/repositories/consent-repo.ts';
import * as consentService from '../../src/modules/consent/internal/services/consent-service.ts';
import {
  asConsentVersionId,
  type ConsentVersionId,
} from '../../src/modules/consent/internal/types.ts';
import { createAccount } from '../../src/modules/identity/internal/repositories/account-repo.ts';
import { asAccountId, type AccountId } from '../../src/modules/identity/internal/types.ts';
import { assertAuditRecordExists } from '../helpers/audit-assertions.ts';
import { TENANT_US, withTenantContext } from '../helpers/tenant-fixtures.ts';
import { uniquePhone } from '../helpers/unique-phone.ts';
import { getTestClient } from '../setup.ts';

const T_US = asTenantId(TENANT_US);
const US_CTX: TenantContext = {
  tenantId: T_US,
  displayName: 'Telecheck-US',
  countryOfCare: 'US',
  kmsKeyAlias: 'alias/telecheck-us-data-key',
  consumerDba: 'Heros Health',
  legalEntity: 'Telecheck Health LLC',
  consumerSubdomain: 'heroshealth.com',
};

async function seedAccount(): Promise<AccountId> {
  const accountId = asAccountId(ulid());
  await withTenantContext(T_US, () =>
    createAccount(
      {
        account_id: accountId,
        tenant_id: T_US,
        phone_e164: uniquePhone(),
        first_name: 'A',
        last_name: 'B',
        date_of_birth: '1990-01-01',
        gender: 'prefer_not_to_say',
        country_of_residence: 'US',
        country_of_care: 'US',
      },
      async () => {},
      getTestClient(),
    ),
  );
  return accountId;
}

async function seedVersion(consentType = 'platform'): Promise<ConsentVersionId> {
  const id = asConsentVersionId(ulid());
  await withTenantContext(T_US, () =>
    createConsentVersion(
      {
        consent_version_id: id,
        tenant_id: T_US,
        consent_type: consentType as 'platform',
        version_label: 'v1.0',
        terms_text: 'Terms.',
      },
      getTestClient(),
    ),
  );
  return id;
}

// ---------------------------------------------------------------------------
// §1 — grantConsent
// ---------------------------------------------------------------------------

describe('consent-service §1 grantConsent', () => {
  it('§1a INSERTs granted row + emits consent_granted audit', async () => {
    const accountId = await seedAccount();
    const versionId = await seedVersion();

    const consent = await withTenantContext(T_US, () =>
      consentService.grantConsent(
        US_CTX,
        { actorId: 'op_test_1a' },
        {
          account_id: accountId,
          consent_type: 'platform',
          consent_version_id: versionId,
          evidence: { timestamp: new Date().toISOString() },
        },
        getTestClient(),
      ),
    );
    expect(consent.status).toBe('granted');
    expect(consent.account_id).toBe(accountId);

    await assertAuditRecordExists(
      T_US,
      (r) =>
        r.action === 'consent_granted' &&
        r.resource_id === consent.consent_id &&
        r.resource_type === 'consent',
    );
  });

  it('§1b scope_id propagates correctly (per Slice PRD §5.3 data_use category)', async () => {
    const accountId = await seedAccount();
    const versionId = await seedVersion('data_use');

    const consent = await withTenantContext(T_US, () =>
      consentService.grantConsent(
        US_CTX,
        { actorId: 'op_test_1b' },
        {
          account_id: accountId,
          consent_type: 'data_use',
          scope_id: 'ai_interpretation',
          consent_version_id: versionId,
          evidence: { timestamp: new Date().toISOString() },
        },
        getTestClient(),
      ),
    );
    expect(consent.scope_id).toBe('ai_interpretation');
  });

  it('§1c expires_at supported for time-bounded consents', async () => {
    const accountId = await seedAccount();
    const versionId = await seedVersion('episode');
    const expires = new Date(Date.now() + 24 * 3600 * 1000).toISOString();

    const consent = await withTenantContext(T_US, () =>
      consentService.grantConsent(
        US_CTX,
        { actorId: 'op_test_1c' },
        {
          account_id: accountId,
          consent_type: 'episode',
          consent_version_id: versionId,
          evidence: { timestamp: new Date().toISOString() },
          expires_at: expires,
        },
        getTestClient(),
      ),
    );
    expect(consent.expires_at).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// §2 — revokeConsent
// ---------------------------------------------------------------------------

describe('consent-service §2 revokeConsent', () => {
  it('§2a happy path: grant then revoke', async () => {
    const accountId = await seedAccount();
    const versionId = await seedVersion();

    await withTenantContext(T_US, () =>
      consentService.grantConsent(
        US_CTX,
        { actorId: 'op_test_2a' },
        {
          account_id: accountId,
          consent_type: 'platform',
          consent_version_id: versionId,
          evidence: { timestamp: new Date().toISOString() },
        },
        getTestClient(),
      ),
    );

    const revoked = await withTenantContext(T_US, () =>
      consentService.revokeConsent(
        US_CTX,
        { actorId: 'op_test_2a' },
        {
          account_id: accountId,
          consent_type: 'platform',
          consent_version_id: versionId,
          reason: 'patient_initiated',
          evidence: { timestamp: new Date().toISOString() },
        },
        getTestClient(),
      ),
    );
    expect(revoked).not.toBeNull();
    expect(revoked!.status).toBe('revoked');
    expect(revoked!.revocation_reason).toBe('patient_initiated');
  });

  it('§2b idempotent: revoke without prior grant returns null (no spurious audit)', async () => {
    const accountId = await seedAccount();
    const versionId = await seedVersion();

    const result = await withTenantContext(T_US, () =>
      consentService.revokeConsent(
        US_CTX,
        { actorId: 'op_test_2b' },
        {
          account_id: accountId,
          consent_type: 'platform',
          consent_version_id: versionId,
          reason: 'patient_initiated',
          evidence: { timestamp: new Date().toISOString() },
        },
        getTestClient(),
      ),
    );
    expect(result).toBeNull();
  });

  it('§2c double-revoke: second call is no-op', async () => {
    const accountId = await seedAccount();
    const versionId = await seedVersion();

    await withTenantContext(T_US, () =>
      consentService.grantConsent(
        US_CTX,
        { actorId: 'op_test_2c' },
        {
          account_id: accountId,
          consent_type: 'platform',
          consent_version_id: versionId,
          evidence: { timestamp: new Date().toISOString() },
        },
        getTestClient(),
      ),
    );
    await withTenantContext(T_US, () =>
      consentService.revokeConsent(
        US_CTX,
        { actorId: 'op_test_2c' },
        {
          account_id: accountId,
          consent_type: 'platform',
          consent_version_id: versionId,
          reason: 'patient_initiated',
          evidence: { timestamp: new Date().toISOString() },
        },
        getTestClient(),
      ),
    );

    const second = await withTenantContext(T_US, () =>
      consentService.revokeConsent(
        US_CTX,
        { actorId: 'op_test_2c' },
        {
          account_id: accountId,
          consent_type: 'platform',
          consent_version_id: versionId,
          reason: 'patient_initiated',
          evidence: { timestamp: new Date().toISOString() },
        },
        getTestClient(),
      ),
    );
    expect(second).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// §3 — hasActiveConsent (runtime check per Slice PRD §7.2)
// ---------------------------------------------------------------------------

describe('consent-service §3 hasActiveConsent', () => {
  it('§3a returns true after grant', async () => {
    const accountId = await seedAccount();
    const versionId = await seedVersion();

    await withTenantContext(T_US, () =>
      consentService.grantConsent(
        US_CTX,
        { actorId: 'op_test_3a' },
        {
          account_id: accountId,
          consent_type: 'platform',
          consent_version_id: versionId,
          evidence: { timestamp: new Date().toISOString() },
        },
        getTestClient(),
      ),
    );

    const isActive = await withTenantContext(T_US, () =>
      consentService.hasActiveConsent(US_CTX, accountId, 'platform', null, getTestClient()),
    );
    expect(isActive).toBe(true);
  });

  it('§3b returns false when no consent exists', async () => {
    const accountId = await seedAccount();

    const isActive = await withTenantContext(T_US, () =>
      consentService.hasActiveConsent(US_CTX, accountId, 'platform', null, getTestClient()),
    );
    expect(isActive).toBe(false);
  });

  it('§3c returns false after revoke', async () => {
    const accountId = await seedAccount();
    const versionId = await seedVersion();

    await withTenantContext(T_US, () =>
      consentService.grantConsent(
        US_CTX,
        { actorId: 'op_test_3c' },
        {
          account_id: accountId,
          consent_type: 'platform',
          consent_version_id: versionId,
          evidence: { timestamp: new Date().toISOString() },
        },
        getTestClient(),
      ),
    );
    await withTenantContext(T_US, () =>
      consentService.revokeConsent(
        US_CTX,
        { actorId: 'op_test_3c' },
        {
          account_id: accountId,
          consent_type: 'platform',
          consent_version_id: versionId,
          reason: 'patient_initiated',
          evidence: { timestamp: new Date().toISOString() },
        },
        getTestClient(),
      ),
    );

    const isActive = await withTenantContext(T_US, () =>
      consentService.hasActiveConsent(US_CTX, accountId, 'platform', null, getTestClient()),
    );
    expect(isActive).toBe(false);
  });
});
