/**
 * consent slice — domain-event emission integration test.
 *
 * Verifies that the 8 lifecycle events the consent + delegation services
 * emit actually land in domain_events_outbox alongside the audit chain.
 * Closes the test gap from the fcfbc3a wiring commit.
 *
 * Coverage in this file (1 section, 4 cases):
 *   §1a grantConsent emits consent.granted in outbox
 *   §1b revokeConsent emits consent.revoked in outbox
 *   §1c inviteDelegate emits delegation.invited in outbox
 *   §1d acceptDelegation emits delegation.accepted in outbox + payload check
 *
 * Spec references:
 *   - DOMAIN_EVENTS v5.2 envelope shape
 *   - I-016 (events immutable; INSERT failure aborts the tx)
 *   - I-023 (every event carries tenant_id)
 *   - migrations/004_domain_events_outbox.sql (the table this test queries)
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

async function seedConsentVersion(): Promise<ConsentVersionId> {
  const id = asConsentVersionId(ulid());
  await withTenantContext(T_US, () =>
    createConsentVersion(
      {
        consent_version_id: id,
        tenant_id: T_US,
        consent_type: 'platform',
        version_label: 'v1.0',
        terms_text: 'Terms.',
      },
      getTestClient(),
    ),
  );
  return id;
}

interface OutboxRow {
  event_type: string;
  aggregate_type: string;
  aggregate_id: string;
  tenant_id: string;
  payload: Record<string, unknown>;
  partition_key: string;
}

async function findOutboxEvent(
  tenantId: string,
  eventType: string,
  aggregateId: string,
): Promise<OutboxRow | null> {
  const r = await getTestClient().query<OutboxRow>(
    `SELECT event_type, aggregate_type, aggregate_id, tenant_id, payload, partition_key
       FROM domain_events_outbox
      WHERE tenant_id = $1 AND event_type = $2 AND aggregate_id = $3
      ORDER BY created_at DESC LIMIT 1`,
    [tenantId, eventType, aggregateId],
  );
  return r.rows[0] ?? null;
}

describe('consent slice — §1 domain-event emission', () => {
  it('§1a grantConsent emits consent.granted in outbox', async () => {
    const account = await seedAccount();
    const versionId = await seedConsentVersion();

    const consent = await withTenantContext(T_US, () =>
      consentService.grantConsent(
        US_CTX,
        { actorId: 'op_evt_1a' },
        {
          account_id: account,
          consent_type: 'platform',
          consent_version_id: versionId,
          evidence: { timestamp: new Date().toISOString() },
        },
        getTestClient(),
      ),
    );

    const event = await findOutboxEvent(T_US, 'consent.granted', consent.consent_id);
    expect(event).not.toBeNull();
    expect(event!.aggregate_type).toBe('consent');
    expect(event!.partition_key).toBe(`${T_US}:${consent.consent_id}`);
    expect(event!.payload['account_id']).toBe(account);
    expect(event!.payload['consent_type']).toBe('platform');
  });

  it('§1b revokeConsent emits consent.revoked in outbox', async () => {
    const account = await seedAccount();
    const versionId = await seedConsentVersion();

    await withTenantContext(T_US, () =>
      consentService.grantConsent(
        US_CTX,
        { actorId: 'op_evt_1b' },
        {
          account_id: account,
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
        { actorId: 'op_evt_1b' },
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
    expect(revoked).not.toBeNull();

    const event = await findOutboxEvent(T_US, 'consent.revoked', revoked!.consent_id);
    expect(event).not.toBeNull();
    expect(event!.payload['revocation_reason']).toBe('patient_initiated');
  });

  it('§1c inviteDelegate emits delegation.invited in outbox', async () => {
    const grantor = await seedAccount();
    const delegate = await seedAccount();

    const delegation = await withTenantContext(T_US, () =>
      delegationService.inviteDelegate(
        US_CTX,
        { actorId: 'op_evt_1c' },
        {
          grantor_account_id: grantor,
          delegate_account_id: delegate,
          relationship_type: 'spouse_partner',
        },
        getTestClient(),
      ),
    );

    const event = await findOutboxEvent(T_US, 'delegation.invited', delegation.delegation_id);
    expect(event).not.toBeNull();
    expect(event!.aggregate_type).toBe('delegation');
    expect(event!.payload['relationship_type']).toBe('spouse_partner');
    expect(event!.payload['grantor_account_id']).toBe(grantor);
    expect(event!.payload['delegate_account_id']).toBe(delegate);
  });

  it('§1d acceptDelegation emits delegation.accepted in outbox', async () => {
    const grantor = await seedAccount();
    const delegate = await seedAccount();
    const invited = await withTenantContext(T_US, () =>
      delegationService.inviteDelegate(
        US_CTX,
        { actorId: 'op_evt_1d' },
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
        { actorId: 'op_evt_1d' },
        invited.delegation_id,
        getTestClient(),
      ),
    );

    const event = await findOutboxEvent(T_US, 'delegation.accepted', invited.delegation_id);
    expect(event).not.toBeNull();
    expect(event!.payload['delegation_id']).toBe(invited.delegation_id);
    expect(event!.payload['grantor_account_id']).toBe(grantor);
  });
});
