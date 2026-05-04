/**
 * src/modules/identity/internal/services/session-service.ts — direct
 * integration tests.
 *
 * Coverage in this file (4 sections, 9 cases):
 *   §1 generateRefreshToken / hashRefreshToken (3 cases) — pure functions
 *   §2 issueSession (2 cases) — row + audit; returns plaintext + hash matches
 *   §3 revokeSession (2 cases) — flip + audit; idempotent no-op no audit
 *   §4 findActiveSessionByRefreshToken (2 cases) — hashes plaintext to lookup;
 *      null on miss
 *
 * Spec references:
 *   - session-service.ts (target)
 *   - I-003 (audit append-only; no spurious emission)
 */

import crypto from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { asTenantId } from '../../src/lib/glossary.ts';
import type { TenantContext } from '../../src/lib/tenant-context.ts';
import { ulid } from '../../src/lib/ulid.ts';
import * as accountService from '../../src/modules/identity/internal/services/account-service.ts';
import * as sessionService from '../../src/modules/identity/internal/services/session-service.ts';
import {
  asAccountId,
  asSessionId,
  type AccountId,
} from '../../src/modules/identity/internal/types.ts';
import { assertAuditRecordExists } from '../helpers/audit-assertions.ts';
import { TENANT_US, withTenantContext } from '../helpers/tenant-fixtures.ts';
import { getTestClient } from '../setup.ts';

const US_CTX: TenantContext = {
  tenantId: asTenantId(TENANT_US),
  displayName: 'Telecheck-US',
  countryOfCare: 'US',
  kmsKeyAlias: 'alias/telecheck-us-data-key',
  consumerDba: 'Heros Health',
  legalEntity: 'Telecheck Health LLC',
  consumerSubdomain: 'heroshealth.com',
};

function uniquePhone(): string {
  const digits = ulid()
    .slice(-9)
    .replace(/[^0-9]/g, '0')
    .padEnd(9, '0');
  return `+1${digits}`;
}

async function seedAccount(): Promise<AccountId> {
  const accountId = asAccountId(ulid());
  await withTenantContext(US_CTX.tenantId, () =>
    accountService.createAccount(
      US_CTX,
      { actorId: 'op_session_test_seed' },
      {
        account_id: accountId,
        phone_e164: uniquePhone(),
        first_name: 'A',
        last_name: 'B',
        date_of_birth: '1990-01-01',
        gender: 'prefer_not_to_say',
      },
      getTestClient(),
    ),
  );
  return accountId;
}

// ---------------------------------------------------------------------------
// §1 — pure functions
// ---------------------------------------------------------------------------

describe('session-service §1 pure helpers', () => {
  it('§1a generateRefreshToken returns plaintext + matching hash', () => {
    const { plaintext, hash } = sessionService.generateRefreshToken();
    expect(plaintext.length).toBeGreaterThan(20);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    // Hash matches sha256(plaintext)
    const expected = crypto.createHash('sha256').update(plaintext).digest('hex');
    expect(hash).toBe(expected);
  });

  it('§1b hashRefreshToken is deterministic for same input', () => {
    const a = sessionService.hashRefreshToken('test-token');
    const b = sessionService.hashRefreshToken('test-token');
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it('§1c hashRefreshToken differs for different inputs', () => {
    const a = sessionService.hashRefreshToken('token-a');
    const b = sessionService.hashRefreshToken('token-b');
    expect(a).not.toBe(b);
  });
});

// ---------------------------------------------------------------------------
// §2 — issueSession
// ---------------------------------------------------------------------------

describe('session-service §2 issueSession', () => {
  it('§2a INSERT + audit emission; returned plaintext hashes to stored hash', async () => {
    const accountId = await seedAccount();
    const sessionId = asSessionId(ulid());

    const { session, refreshTokenPlaintext } = await withTenantContext(US_CTX.tenantId, () =>
      sessionService.issueSession(
        US_CTX,
        { actorId: 'op_test_2a' },
        {
          session_id: sessionId,
          account_id: accountId,
          ip_address: '10.0.0.1',
          user_agent: 'TestAgent',
        },
        getTestClient(),
      ),
    );

    expect(session.session_id).toBe(sessionId);
    expect(session.account_id).toBe(accountId);
    // The stored hash matches sha256(plaintext)
    const expectedHash = crypto.createHash('sha256').update(refreshTokenPlaintext).digest('hex');
    expect(session.refresh_token_hash).toBe(expectedHash);

    // Audit emitted
    const audit = await assertAuditRecordExists(
      US_CTX.tenantId,
      (r) =>
        r.action === 'identity_session_issued' &&
        r.resource_id === sessionId &&
        r.resource_type === 'session',
    );
    expect(audit.category).toBe('C');
  });

  it('§2b expires_at is ~30 days from NOW (Identity Spec §3.2 refresh TTL)', async () => {
    const accountId = await seedAccount();
    const { session } = await withTenantContext(US_CTX.tenantId, () =>
      sessionService.issueSession(
        US_CTX,
        { actorId: 'op_test_2b' },
        {
          session_id: asSessionId(ulid()),
          account_id: accountId,
        },
        getTestClient(),
      ),
    );
    const expiresMs = new Date(session.expires_at).getTime();
    const expectedMin = Date.now() + 29 * 24 * 60 * 60 * 1000; // 29 days
    const expectedMax = Date.now() + 31 * 24 * 60 * 60 * 1000; // 31 days
    expect(expiresMs).toBeGreaterThan(expectedMin);
    expect(expiresMs).toBeLessThan(expectedMax);
  });
});

// ---------------------------------------------------------------------------
// §3 — revokeSession
// ---------------------------------------------------------------------------

describe('session-service §3 revokeSession', () => {
  it('§3a flip + audit; subsequent re-call returns null with NO spurious audit', async () => {
    const accountId = await seedAccount();
    const sessionId = asSessionId(ulid());
    await withTenantContext(US_CTX.tenantId, () =>
      sessionService.issueSession(
        US_CTX,
        { actorId: 'op_test_3a' },
        { session_id: sessionId, account_id: accountId },
        getTestClient(),
      ),
    );

    // First revoke succeeds + audit
    const revoked = await withTenantContext(US_CTX.tenantId, () =>
      sessionService.revokeSession(
        US_CTX,
        { actorId: 'op_test_3a' },
        sessionId,
        'patient_logout',
        getTestClient(),
      ),
    );
    expect(revoked).not.toBeNull();
    expect(revoked!.revoked_reason).toBe('patient_logout');

    const audit = await assertAuditRecordExists(
      US_CTX.tenantId,
      (r) => r.action === 'identity_session_revoked' && r.resource_id === sessionId,
    );
    expect(audit.category).toBe('C');

    // Count audit records BEFORE second call
    const before = await getTestClient().query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM audit_records
        WHERE tenant_id = $1
          AND action = 'identity_session_revoked'
          AND resource_id = $2`,
      [US_CTX.tenantId, sessionId],
    );
    expect(before.rows[0]!.count).toBe('1');

    // Second revoke — null, NO spurious audit
    const second = await withTenantContext(US_CTX.tenantId, () =>
      sessionService.revokeSession(
        US_CTX,
        { actorId: 'op_test_3a' },
        sessionId,
        'admin_revoked',
        getTestClient(),
      ),
    );
    expect(second).toBeNull();

    const after = await getTestClient().query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM audit_records
        WHERE tenant_id = $1
          AND action = 'identity_session_revoked'
          AND resource_id = $2`,
      [US_CTX.tenantId, sessionId],
    );
    expect(after.rows[0]!.count).toBe('1');
  });

  it('§3b phantom session_id returns null with no audit', async () => {
    const phantom = asSessionId(ulid());
    const result = await withTenantContext(US_CTX.tenantId, () =>
      sessionService.revokeSession(
        US_CTX,
        { actorId: 'op_test_3b' },
        phantom,
        'patient_logout',
        getTestClient(),
      ),
    );
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// §4 — findActiveSessionByRefreshToken (plaintext lookup)
// ---------------------------------------------------------------------------

describe('session-service §4 findActiveSessionByRefreshToken', () => {
  it('§4a hashes plaintext for lookup', async () => {
    const accountId = await seedAccount();
    const { refreshTokenPlaintext, session } = await withTenantContext(US_CTX.tenantId, () =>
      sessionService.issueSession(
        US_CTX,
        { actorId: 'op_test_4a' },
        {
          session_id: asSessionId(ulid()),
          account_id: accountId,
        },
        getTestClient(),
      ),
    );

    // Pass PLAINTEXT — service hashes internally
    const found = await withTenantContext(US_CTX.tenantId, () =>
      sessionService.findActiveSessionByRefreshToken(
        US_CTX,
        refreshTokenPlaintext,
        getTestClient(),
      ),
    );
    expect(found).not.toBeNull();
    expect(found!.session_id).toBe(session.session_id);
  });

  it('§4b returns null on phantom plaintext', async () => {
    const found = await withTenantContext(US_CTX.tenantId, () =>
      sessionService.findActiveSessionByRefreshToken(
        US_CTX,
        'not-a-real-token-plaintext',
        getTestClient(),
      ),
    );
    expect(found).toBeNull();
  });
});
