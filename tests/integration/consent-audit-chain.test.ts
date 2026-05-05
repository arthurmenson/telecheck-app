/**
 * Consent slice — I-003 audit-chain integrity regression for the 8 lifecycle
 * audit events the slice emits.
 *
 * The generic audit-chain.test.ts already proves the
 * `audit_records_hash_insert` trigger computes valid links for synthetic
 * envelopes. This file exercises the chain against ACTUAL consent +
 * delegation events emitted by the consent module's service layer — proving
 * that the per-record canonical hash recomputes correctly for these specific
 * action shapes, that the chain links across slice events are intact, and
 * that I-027 (every audit row carries tenant_id) holds for the slice's
 * emissions.
 *
 * Coverage in this file (1 section, 3 cases):
 *   §1a grant + revoke + grantDelegation lifecycle through chain walker
 *   §1b 8 distinct action IDs all participate in the same per-tenant chain
 *   §1c chain still walks intact across cross-tenant boundary (Ghana chain
 *       is independent of US chain even when both tenants emit identical
 *       action IDs in the same test process)
 *
 * Spec references:
 *   - I-003 (audit append-only; hash chain never broken)
 *   - I-027 (every audit record carries tenant_id)
 *   - AUDIT_EVENTS v5.2 (8 slice action IDs; pending ratification, emitted
 *     via consentAuditPlaceholder())
 *   - Consent Slice PRD v1.0 §10
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
import { assertAuditChainIntact } from '../helpers/audit-assertions.ts';
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
// §1 — Audit-chain integrity for slice lifecycle events
// ---------------------------------------------------------------------------

describe('consent slice — §1 I-003 audit-chain integrity', () => {
  it('§1a chain walks intact across grant + revoke + delegation lifecycle', async () => {
    const account = await seedAccountIn(US_CTX, '+1');
    const versionId = await seedConsentVersionIn(US_CTX);
    const grantor = await seedAccountIn(US_CTX, '+1');
    const delegate = await seedAccountIn(US_CTX, '+1');

    // Emit consent_granted then consent_revoked
    await withTenantContext(T_US, () =>
      consentService.grantConsent(
        US_CTX,
        { actorId: 'op_audit_1a' },
        {
          account_id: account,
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
        { actorId: 'op_audit_1a' },
        {
          account_id: account,
          consent_type: 'platform',
          consent_version_id: versionId,
          reason: 'patient_initiated',
          evidence: { timestamp: new Date().toISOString() },
        },
        getTestClient(),
      ),
    );

    // Emit delegation_invited + delegation_accepted + delegation_revoked
    const delegation = await withTenantContext(T_US, () =>
      delegationService.inviteDelegate(
        US_CTX,
        { actorId: 'op_audit_1a' },
        {
          grantor_account_id: grantor,
          delegate_account_id: delegate,
          relationship_type: 'spouse_partner',
        },
        getTestClient(),
      ),
    );
    await withTenantContext(T_US, () =>
      delegationService.acceptDelegation(
        US_CTX,
        { actorId: 'op_audit_1a' },
        delegation.delegation_id,
        getTestClient(),
      ),
    );
    await withTenantContext(T_US, () =>
      delegationService.revokeDelegation(
        US_CTX,
        { actorId: 'op_audit_1a' },
        delegation.delegation_id,
        'patient_initiated',
        getTestClient(),
      ),
    );

    // Walk the chain — must be intact (link integrity + per-record hash recompute).
    await assertAuditChainIntact(T_US);
  });

  it('§1b chain walks intact across all 8 slice action IDs in one tenant', async () => {
    const account = await seedAccountIn(US_CTX, '+1');
    const versionId = await seedConsentVersionIn(US_CTX);
    const grantor = await seedAccountIn(US_CTX, '+1');
    const delegate = await seedAccountIn(US_CTX, '+1');

    // 1. consent_granted
    await withTenantContext(T_US, () =>
      consentService.grantConsent(
        US_CTX,
        { actorId: 'op_audit_1b' },
        {
          account_id: account,
          consent_type: 'platform',
          consent_version_id: versionId,
          evidence: { timestamp: new Date().toISOString() },
        },
        getTestClient(),
      ),
    );
    // 2. consent_revoked
    await withTenantContext(T_US, () =>
      consentService.revokeConsent(
        US_CTX,
        { actorId: 'op_audit_1b' },
        {
          account_id: account,
          consent_type: 'platform',
          consent_version_id: versionId,
          reason: 'patient_initiated',
          evidence: { timestamp: new Date().toISOString() },
        },
        getTestClient(),
      ),
    );

    // Setup 1st delegation: invite + accept + revoke
    const delegation1 = await withTenantContext(T_US, () =>
      delegationService.inviteDelegate(
        US_CTX,
        { actorId: 'op_audit_1b' },
        {
          grantor_account_id: grantor,
          delegate_account_id: delegate,
          relationship_type: 'spouse_partner',
        },
        getTestClient(),
      ),
    );
    // 3. delegation_invited (already happened)
    // 4. delegation_accepted
    await withTenantContext(T_US, () =>
      delegationService.acceptDelegation(
        US_CTX,
        { actorId: 'op_audit_1b' },
        delegation1.delegation_id,
        getTestClient(),
      ),
    );
    // 5. delegation_scope_granted
    const scope = await withTenantContext(T_US, () =>
      delegationService.grantScope(
        US_CTX,
        { actorId: 'op_audit_1b', grantorAccountId: grantor },
        { delegation_id: delegation1.delegation_id, scope: 'view_records' },
        getTestClient(),
      ),
    );
    // 6. delegation_scope_revoked
    await withTenantContext(T_US, () =>
      delegationService.revokeScope(
        US_CTX,
        { actorId: 'op_audit_1b', grantorAccountId: grantor },
        scope.delegation_scope_id,
        getTestClient(),
      ),
    );
    // 7. delegation_revoked
    await withTenantContext(T_US, () =>
      delegationService.revokeDelegation(
        US_CTX,
        { actorId: 'op_audit_1b' },
        delegation1.delegation_id,
        'patient_initiated',
        getTestClient(),
      ),
    );

    // Setup 2nd delegation just for the decline path:
    const grantor2 = await seedAccountIn(US_CTX, '+1');
    const delegate2 = await seedAccountIn(US_CTX, '+1');
    const delegation2 = await withTenantContext(T_US, () =>
      delegationService.inviteDelegate(
        US_CTX,
        { actorId: 'op_audit_1b' },
        {
          grantor_account_id: grantor2,
          delegate_account_id: delegate2,
          relationship_type: 'spouse_partner',
        },
        getTestClient(),
      ),
    );
    // 8. delegation_declined
    await withTenantContext(T_US, () =>
      delegationService.declineDelegation(
        US_CTX,
        { actorId: 'op_audit_1b' },
        delegation2.delegation_id,
        getTestClient(),
      ),
    );

    // Walk chain: ALL 8 distinct action IDs should be present and the
    // chain links + per-record hashes intact.
    await assertAuditChainIntact(T_US);

    // Verify the 8 distinct action IDs landed in this tenant's chain.
    const result = await getTestClient().query<{ action: string }>(
      `SELECT DISTINCT action FROM audit_records WHERE tenant_id = $1
         AND action IN (
           'consent_granted', 'consent_revoked',
           'delegation_invited', 'delegation_accepted', 'delegation_declined',
           'delegation_revoked', 'delegation_scope_granted', 'delegation_scope_revoked'
         )`,
      [T_US],
    );
    const actions = new Set(result.rows.map((r) => r.action));
    expect(actions.size).toBe(8);
  });

  it('§1c per-tenant chain isolation — Ghana chain independent of US chain', async () => {
    // Both tenants emit consent_granted + consent_revoked + delegation_invited
    // — same action IDs but different tenants. The chain walker must walk
    // each tenant's chain independently (different partition keys per the
    // trigger's tenant-scoped partition rule).
    const usAccount = await seedAccountIn(US_CTX, '+1');
    const usVersion = await seedConsentVersionIn(US_CTX);
    const ghAccount = await seedAccountIn(GH_CTX, '+233');
    const ghVersion = await seedConsentVersionIn(GH_CTX);

    await withTenantContext(T_US, () =>
      consentService.grantConsent(
        US_CTX,
        { actorId: 'op_audit_1c_us' },
        {
          account_id: usAccount,
          consent_type: 'platform',
          consent_version_id: usVersion,
          evidence: { timestamp: new Date().toISOString() },
        },
        getTestClient(),
      ),
    );
    await withTenantContext(T_GH, () =>
      consentService.grantConsent(
        GH_CTX,
        { actorId: 'op_audit_1c_gh' },
        {
          account_id: ghAccount,
          consent_type: 'platform',
          consent_version_id: ghVersion,
          evidence: { timestamp: new Date().toISOString() },
        },
        getTestClient(),
      ),
    );

    // Walk both tenant chains — each independently intact.
    await assertAuditChainIntact(T_US);
    await assertAuditChainIntact(T_GH);
  });
});
