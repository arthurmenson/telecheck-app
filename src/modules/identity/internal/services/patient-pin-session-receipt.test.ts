import type { FastifyRequest } from 'fastify';
import { describe, expect, it, vi } from 'vitest';

import type { DbClient } from '../../../../lib/db.js';
import { asTenantId } from '../../../../lib/glossary.js';
import { issueAccessToken } from '../../../../lib/jwt.js';

import {
  assertPatientPinSessionReceipt,
  PatientPinSessionUnavailable,
} from './patient-pin-session-receipt.js';

vi.mock('../../../../lib/config.js', () => ({
  config: { jwtSigningKey: 'synthetic-pin-receipt-test-key-32-chars' },
}));
const tenantId = asTenantId('Telecheck-US');
const accountId = '01ARZ3NDEKTSV4RRFFQ69G5FAV',
  sessionId = '01ARZ3NDEKTSV4RRFFQ69G5FAW';
function request(path = '/v0/identity/login/pin') {
  return { routeOptions: { url: path }, tenantContext: { tenantId } } as FastifyRequest;
}
function receipt(overrides: Record<string, unknown> = {}) {
  return {
    status: 200,
    body: {
      account: { account_id: accountId },
      session_id: sessionId,
      access_token: issueAccessToken(
        {
          account_id: accountId,
          tenant_id: tenantId,
          session_id: sessionId,
          role: 'patient',
          country_of_care: 'US',
        },
        'synthetic-pin-receipt-test-key-32-chars',
      ),
      refresh_token: 'synthetic-private-refresh-token',
      ...overrides,
    },
  };
}
function database(rowCount = 1, allowed = true) {
  const query = vi
    .fn()
    .mockResolvedValueOnce({ rowCount: 1, rows: [] })
    .mockResolvedValueOnce({ rowCount, rows: [] })
    .mockResolvedValueOnce({ rows: [{ allowed }] });
  return { query, tx: { query } as DbClient };
}

describe('patient PIN credential receipts', () => {
  it('accepts the original live patient session and checks expiry after its lock', async () => {
    const db = database();
    await assertPatientPinSessionReceipt(request(), db.tx, receipt());
    expect(db.query).toHaveBeenCalledTimes(3);
    expect(db.query.mock.calls[0]?.[0]).toContain('FROM accounts');
    expect(db.query.mock.calls[1]?.[0]).toContain('FROM sessions');
    expect(db.query.mock.calls[2]?.[0]).toContain('clock_timestamp()');
    expect(JSON.stringify(db.query.mock.calls)).not.toContain('synthetic-private-refresh-token');
  });
  it('rejects a session revoked by PIN reset even if cached tokens remain', async () => {
    const db = database(0);
    await expect(
      assertPatientPinSessionReceipt(request(), db.tx, receipt()),
    ).rejects.toBeInstanceOf(PatientPinSessionUnavailable);
  });
  it('rejects expiry reached during a database lock wait', async () => {
    const db = database(1, false);
    await expect(
      assertPatientPinSessionReceipt(request(), db.tx, receipt()),
    ).rejects.toBeInstanceOf(PatientPinSessionUnavailable);
  });
  it.each([
    { access_token: 'malformed-token' },
    { account: { account_id: '01ARZ3NDEKTSV4RRFFQ69G5FAX' } },
    { session_id: '01ARZ3NDEKTSV4RRFFQ69G5FAX' },
    { refresh_token: undefined },
    {
      access_token: issueAccessToken(
        {
          account_id: accountId,
          tenant_id: tenantId,
          session_id: sessionId,
          role: 'clinician',
          country_of_care: 'US',
        },
        'synthetic-pin-receipt-test-key-32-chars',
      ),
    },
  ])('denies malformed or mismatched cached authority before querying', async (fields) => {
    const db = database();
    await expect(
      assertPatientPinSessionReceipt(request(), db.tx, receipt(fields)),
    ).rejects.toBeInstanceOf(PatientPinSessionUnavailable);
    expect(db.query).not.toHaveBeenCalled();
  });
  it('checks email registration token replays as well as PIN login', async () => {
    const db = database(0);
    await expect(
      assertPatientPinSessionReceipt(request('/v0/identity/registration/email/verify'), db.tx, {
        ...receipt(),
        status: 201,
      }),
    ).rejects.toBeInstanceOf(PatientPinSessionUnavailable);
  });
  it('does not change failure or unrelated endpoint receipts', async () => {
    const db = database();
    await assertPatientPinSessionReceipt(request(), db.tx, {
      status: 401,
      body: { error: { code: 'identity.login.invalid_credentials' } },
    });
    await assertPatientPinSessionReceipt(request('/v0/identity/recovery/pin/verify'), db.tx, {
      status: 200,
      body: { status: 'ok' },
    });
    expect(db.query).not.toHaveBeenCalled();
  });
});
