import { describe, expect, it } from 'vitest';

import {
  patientRefreshKeySchema,
  patientRefreshReplySchema,
  patientRefreshRequestSchema,
} from './patient-refresh-contract.js';

describe('patient refresh wire contract', () => {
  const token = 'A'.repeat(43),
    id = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
  const session = {
    session_id: id,
    account_id: id,
    created_at: '2026-09-07T12:00:00.000Z',
    last_active_at: '2026-09-07T12:15:00.000Z',
    expires_at: '2026-10-07T12:00:00.000Z',
  };
  it('accepts only the opaque refresh credential', () => {
    expect(patientRefreshRequestSchema.safeParse({ refresh_token: token }).success).toBe(true);
  });
  it.each([
    { refresh_token: token, role: 'patient' },
    { refresh_token: token, session_id: id },
    { refresh_token: token, delegate_id: id },
    { refresh_token: 'short' },
    { refresh_token: token + '=' },
    {},
    null,
  ])('rejects caller authority or malformed credentials', (value) => {
    expect(patientRefreshRequestSchema.safeParse(value).success).toBe(false);
  });
  it('requires canonical ULID operation keys', () => {
    expect(patientRefreshKeySchema.safeParse(id).success).toBe(true);
    expect(patientRefreshKeySchema.safeParse('00000000-0000-4000-8000-000000000000').success).toBe(
      false,
    );
  });
  it('projects no digest, tenant, device metadata or client role', () => {
    const reply = { session, access_token: 'signed.token.value', refresh_token: token };
    expect(patientRefreshReplySchema.safeParse(reply).success).toBe(true);
    expect(
      patientRefreshReplySchema.safeParse({
        ...reply,
        session: { ...session, refresh_token_hash: '0'.repeat(64) },
      }).success,
    ).toBe(false);
    expect(patientRefreshReplySchema.safeParse({ ...reply, role: 'patient' }).success).toBe(false);
  });
  it('uses canonical UTC timestamps', () => {
    expect(
      patientRefreshReplySchema.safeParse({
        session: { ...session, expires_at: '2026-10-07 12:00:00+00' },
        access_token: 'signed.token.value',
        refresh_token: token,
      }).success,
    ).toBe(false);
  });
});
