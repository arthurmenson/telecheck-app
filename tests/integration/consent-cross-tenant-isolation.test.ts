/**
 * Cross-tenant isolation — consent + delegation services (I-023 / I-024 / I-025).
 *
 * Coverage in this file (2 sections, 4 cases):
 *   §1 consent-service (2 cases) — grant in Ghana, attempt revoke / has-active
 *      from US; both must return null/false with no spurious US-tenant audit.
 *   §2 delegation-service (2 cases) — invite in Ghana, attempt accept / revoke
 *      from US; both must return null with no spurious US-tenant audit.
 *
 * Pattern mirrors `identity-account-service.test.ts §3c` cross-tenant case.
 * Direct service-layer test of three-layer isolation: the RLS policy filter
 * scopes the SELECT, so the cross-tenant attempt sees no row, returns null,
 * and the audit emitter never fires.
 *
 * Spec references:
 *   - I-023 (three-layer tenant isolation: RLS + app-layer + per-tenant KMS)
 *   - I-024 (cross-actor / break-glass discipline)
 *   - I-025 (tenant-blind error envelopes; null return is the canonical
 *     "tenant-blind not-found" surface for service-layer)
 *   - Consent Slice PRD v1.0 §6, §7
 */

import { describe, expect, it } from 'vitest';

import { asTenantId } from '../../src/lib/glossary.ts';
import type { TenantContext } from '../../src/lib/tenant-context.ts';
import { ulid } from '../../src/lib/ulid.ts';
import { createConsentVersion } from '../../src/modules/consent/internal/repositories/consent-repo.ts';
import * as consentService from '../../src/modules/consent/internal/services/consent-service.ts';
import * as delegationService from '../../src/modules/consent/internal/services/delegation-service.ts';
import {
  asConsentVersionId,
  type ConsentVersionId,
} from '../../src/modules/consent/internal/types.ts';
import { createAccount } from '../../src/modules/identity/internal/repositories/account-repo.ts';
import { asAccountId, type AccountId } from '../../src/modules/identity/internal/types.ts';
import { TENANT_GHANA, TENANT_US, withTenantContext } from '../helpers/tenant-fixtures.ts';
import { uniquePhone } from '../helpers/unique-phone.ts';
import { getTestClient } from '../setup.ts';

const T_US = asTenantId(TENANT_US);
const T_GH = asTenantId(TENANT_GHANA);

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

async function seedAccountIn(tenantCtx: TenantContext, phonePrefix: string): Promise<AccountId> {
  const accountId = asAccountId(ulid());
  await withTenantContext(tenantCtx.tenantId, () =>
    createAccount(
      {
        account_id: accountId,
        tenant_id: tenantCtx.tenantId,
        phone_e164: uniquePhone(phonePrefix),
        first_name: 'A',
        last_name: 'B',
        date_of_birth: '1990-01-01',
        gender: 'prefer_not_to_say',
        country_of_residence: tenantCtx.countryOfCare,
        country_of_care: tenantCtx.countryOfCare,
      },
      async () => {},
      getTestClient(),
    ),
  );
  return accountId;
}

async function seedConsentVersionIn(tenantCtx: TenantContext): Promise<ConsentVersionId> {
  const id = asConsentVersionId(ulid());
  await withTenantContext(tenantCtx.tenantId, () =>
    createConsentVersion(
      {
        consent_version_id: id,
        tenant_id: tenantCtx.tenantId,
        consent_type: 'platform',
        version_label: 'v1.0',
        terms_text: 'Terms.',
      },
      getTestClient(),
    ),
  );
  return id;
}

// ---------------------------------------------------------------------------
// §1 — consent-service cross-tenant attempts
// ---------------------------------------------------------------------------

describe('cross-tenant isolation §1 consent-service', () => {
  it('§1a revoke from wrong tenant returns null + emits no audit in attacking tenant', async () => {
    // Setup: Ghana account + Ghana consent grant
    const accountId = await seedAccountIn(GH_CTX, '+233');
    const versionId = await seedConsentVersionIn(GH_CTX);

    await withTenantContext(T_GH, () =>
      consentService.grantConsent(
        GH_CTX,
        { actorId: 'op_gh_grant' },
        {
          account_id: accountId,
          consent_type: 'platform',
          consent_version_id: versionId,
          evidence: { timestamp: new Date().toISOString() },
        },
        getTestClient(),
      ),
    );

    // Attack: US tenant tries to revoke the Ghana consent.
    const result = await withTenantContext(T_US, () =>
      consentService.revokeConsent(
        US_CTX,
        { actorId: 'op_us_attacker' },
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

    // No `consent_revoked` audit row written under the US tenant.
    const us = await getTestClient().query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM audit_records
        WHERE tenant_id = $1
          AND action = 'consent_revoked'
          AND target_patient_id = $2`,
      [T_US, accountId],
    );
    expect(us.rows[0]!.count).toBe('0');

    // The Ghana grant is still active (RLS prevented the cross-tenant write).
    const stillActive = await withTenantContext(T_GH, () =>
      consentService.hasActiveConsent(GH_CTX, accountId, 'platform', null, getTestClient()),
    );
    expect(stillActive).toBe(true);
  });

  it('§1b hasActiveConsent from wrong tenant returns false (RLS-filtered SELECT)', async () => {
    const accountId = await seedAccountIn(GH_CTX, '+233');
    const versionId = await seedConsentVersionIn(GH_CTX);

    await withTenantContext(T_GH, () =>
      consentService.grantConsent(
        GH_CTX,
        { actorId: 'op_gh_grant_1b' },
        {
          account_id: accountId,
          consent_type: 'platform',
          consent_version_id: versionId,
          evidence: { timestamp: new Date().toISOString() },
        },
        getTestClient(),
      ),
    );

    // From US tenant context, the Ghana consent is invisible.
    const isActive = await withTenantContext(T_US, () =>
      consentService.hasActiveConsent(US_CTX, accountId, 'platform', null, getTestClient()),
    );
    expect(isActive).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// §2 — delegation-service cross-tenant attempts
// ---------------------------------------------------------------------------

describe('cross-tenant isolation §2 delegation-service', () => {
  it('§2a accept from wrong tenant returns null + emits no audit in attacking tenant', async () => {
    // Setup: Ghana grantor + Ghana delegate + Ghana invite
    const grantor = await seedAccountIn(GH_CTX, '+233');
    const delegate = await seedAccountIn(GH_CTX, '+233');
    const invited = await withTenantContext(T_GH, () =>
      delegationService.inviteDelegate(
        GH_CTX,
        { actorId: 'op_gh_invite' },
        {
          grantor_account_id: grantor,
          delegate_account_id: delegate,
          relationship_type: 'spouse_partner',
        },
        getTestClient(),
      ),
    );

    // Attack: US tenant tries to accept the Ghana delegation.
    const result = await withTenantContext(T_US, () =>
      delegationService.acceptDelegation(
        US_CTX,
        { actorId: 'op_us_attacker' },
        invited.delegation_id,
        getTestClient(),
      ),
    );
    expect(result).toBeNull();

    // No `delegation_accepted` audit row in US tenant for this delegation.
    const us = await getTestClient().query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM audit_records
        WHERE tenant_id = $1
          AND action = 'delegation_accepted'
          AND resource_id = $2`,
      [T_US, invited.delegation_id],
    );
    expect(us.rows[0]!.count).toBe('0');

    // From the legitimate Ghana side it's still pending_acceptance (no
    // cross-tenant write happened).
    const fromGhana = await withTenantContext(T_GH, () =>
      delegationService.findDelegationById(GH_CTX, invited.delegation_id, getTestClient()),
    );
    expect(fromGhana).not.toBeNull();
    expect(fromGhana!.status).toBe('pending_acceptance');
  });

  it('§2b revoke from wrong tenant returns null + emits no audit in attacking tenant', async () => {
    // Setup: Ghana grantor + delegate + active delegation
    const grantor = await seedAccountIn(GH_CTX, '+233');
    const delegate = await seedAccountIn(GH_CTX, '+233');
    const invited = await withTenantContext(T_GH, () =>
      delegationService.inviteDelegate(
        GH_CTX,
        { actorId: 'op_gh_invite_2b' },
        {
          grantor_account_id: grantor,
          delegate_account_id: delegate,
          relationship_type: 'spouse_partner',
        },
        getTestClient(),
      ),
    );
    await withTenantContext(T_GH, () =>
      delegationService.acceptDelegation(
        GH_CTX,
        { actorId: 'op_gh_accept_2b' },
        invited.delegation_id,
        getTestClient(),
      ),
    );

    // Attack: US tenant tries to revoke.
    const result = await withTenantContext(T_US, () =>
      delegationService.revokeDelegation(
        US_CTX,
        { actorId: 'op_us_attacker' },
        invited.delegation_id,
        'patient_initiated',
        getTestClient(),
      ),
    );
    expect(result).toBeNull();

    // No `delegation_revoked` audit row in US tenant for this delegation.
    const us = await getTestClient().query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM audit_records
        WHERE tenant_id = $1
          AND action = 'delegation_revoked'
          AND resource_id = $2`,
      [T_US, invited.delegation_id],
    );
    expect(us.rows[0]!.count).toBe('0');

    // The Ghana delegation is still active.
    const fromGhana = await withTenantContext(T_GH, () =>
      delegationService.findDelegationById(GH_CTX, invited.delegation_id, getTestClient()),
    );
    expect(fromGhana).not.toBeNull();
    expect(fromGhana!.status).toBe('active');
  });
});
