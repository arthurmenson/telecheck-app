import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  audit: vi.fn(),
  outbox: vi.fn(),
  profile: vi.fn(),
  commitFailure: false,
}));
vi.mock('../../../lib/db.js', () => ({
  withTransaction: async (work: (tx: unknown) => Promise<unknown>) => {
    const result = await work({ query: mocks.query });
    if (mocks.commitFailure) throw new Error('connection_lost');
    return result;
  },
}));
vi.mock('../../../lib/rls.js', () => ({
  withTenantContext: (_tx: unknown, _tenant: string, work: () => Promise<unknown>) => work(),
}));
vi.mock('../../../lib/actor-context-binding.js', () => ({
  withActorContext: (_tx: unknown, _nonce: string, work: () => Promise<unknown>) => work(),
}));
vi.mock('../../../lib/with-db-role.js', () => ({
  withDbRole: (_tx: unknown, _role: string, work: () => Promise<unknown>) => work(),
}));
vi.mock('../../../lib/logger.js', () => ({ logger: { error: vi.fn() } }));
vi.mock('../../../lib/domain-events.js', () => ({ emitDomainEvent: mocks.outbox }));
vi.mock('../../tenant-config/index.js', () => ({ getTenantCountryProfile: mocks.profile }));
vi.mock('./patient-care-read.js', () => ({
  withPatientCareRead: (work: (tx: unknown) => Promise<unknown>) => work({ query: mocks.query }),
}));
vi.mock('../audit.js', () => ({ emitCrisisDetectedAudit: mocks.audit }));

import type { TenantContext } from '../../../lib/tenant-context.js';

import { admitPatientCareInput, collectPatientCareText } from './patient-care-admission.js';

const ctx = {
  tenant: { tenantId: 'Telecheck-US', countryOfCare: 'US' } as TenantContext,
  accountId: '01M1WQJRSCWYKQC9VBEQXWFG0T',
  sessionId: '01M1WQJRSCWYKQC9VBEQXWFG0S',
  actorNonce: '123e4567-e89b-42d3-a456-426614174000',
  idempotencyKey: 'synthetic-request',
};
beforeEach(() => {
  vi.clearAllMocks();
  mocks.commitFailure = false;
  mocks.profile.mockResolvedValue({
    emergency_number: 'configured-emergency',
    crisis_helplines: [],
  });
  mocks.audit.mockResolvedValue({ audit_id: '123e4567-e89b-42d3-a456-426614174001' });
  mocks.outbox.mockResolvedValue(undefined);
  mocks.query.mockImplementation(async (sql: string) => {
    if (sql.includes('crisis_care_live_patient'))
      return {
        rows: [
          {
            actor: {
              account_id: ctx.accountId,
              session_id: ctx.sessionId,
              tenant_id: ctx.tenant.tenantId,
              country_of_care: 'US',
            },
          },
        ],
      };
    if (sql.includes('crisis_care_record'))
      return {
        rows: [
          {
            result: {
              crisis_event_id: '123e4567-e89b-42d3-a456-426614174002',
              server_signal_id: '123e4567-e89b-42d3-a456-426614174003',
              created: true,
            },
          },
        ],
      };
    return { rows: [] };
  });
});

describe('patient crisis admission', () => {
  it.each([
    ['I want to die', 'suicidal_ideation'],
    ['I am cutting myself', 'self_harm'],
    ['I am being abused', 'abuse_disclosure'],
    ['I have chest pain', 'medical_emergency'],
    ['I am in crisis', 'general_crisis'],
  ])(
    'preserves actual detector classification for %s without claiming imminence',
    async (text, type) => {
      const body = {
        invalid_schema: { unknown: [text] },
        patient_id: 'other',
        severity: 'non_imminent',
      };
      const result = await admitPatientCareInput(ctx, body, 'form_response');
      expect(result).toMatchObject({
        kind: 'crisis_interruption',
        recording_status: 'recorded',
        escalation_status: 'pending',
      });
      expect(mocks.audit).toHaveBeenCalledWith(
        expect.objectContaining({
          crisisInitiatorIdentity: 'patient',
          targetPatientId: ctx.accountId,
          crisisType: type,
          severity: 'unassessed',
          detectorVersion: 'keyword_engineering_v1',
        }),
        expect.anything(),
      );
      const write = mocks.query.mock.calls.find(([sql]) => sql.includes('crisis_care_record'));
      expect(write?.[1]).toEqual([type, 'forms', expect.stringMatching(/^[a-f0-9]{64}$/)]);
      expect(JSON.stringify(mocks.query.mock.calls)).not.toContain(text);
      expect(JSON.stringify(mocks.audit.mock.calls)).not.toContain(text);
      expect(JSON.stringify(mocks.outbox.mock.calls)).not.toContain(text);
    },
  );

  it('scans deeply nested unknown values without recursion or business validation', async () => {
    let body: unknown = 'in crisis';
    for (let i = 0; i < 12_000; i++) body = [body];
    expect(await admitPatientCareInput(ctx, body, 'messaging')).toMatchObject({
      recording_status: 'recorded',
    });
    const late = ['x'.repeat(1_040_000), { invalid_answer: 'in crisis' }];
    expect(await admitPatientCareInput(ctx, late, 'form_response')).toMatchObject({
      recording_status: 'recorded',
    });
    expect(() => collectPatientCareText('x'.repeat(1_048_577))).toThrow('crisis_input_limit');
  });

  it('live-authenticates ordinary input without creating a crisis event', async () => {
    expect(await admitPatientCareInput(ctx, { wrong_schema: 4 }, 'form_response')).toEqual({
      kind: 'no_detection',
    });
    expect(
      mocks.query.mock.calls.filter(([sql]) => sql.includes('crisis_care_live_patient')).length,
    ).toBeGreaterThan(1);
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it('returns resources and not-recorded when the same-transaction outbox fails', async () => {
    mocks.outbox.mockRejectedValue(new Error('synthetic_outbox_error'));
    expect(await admitPatientCareInput(ctx, 'in crisis', 'messaging')).toMatchObject({
      recording_status: 'not_recorded',
      escalation_status: 'not_queued',
      resources: { status: 'available', emergency_number: 'configured-emergency' },
    });
  });

  it('reports an uncertain commit without claiming absence or successful recording', async () => {
    mocks.commitFailure = true;
    const result = await admitPatientCareInput(ctx, 'in crisis', 'messaging');
    expect(result).toMatchObject({
      recording_status: 'unconfirmed',
      escalation_status: 'unconfirmed',
    });
    expect(result).not.toHaveProperty('crisis_event_id');
  });

  it('cannot turn a profile lookup failure into ordinary clinical continuation', async () => {
    mocks.profile.mockRejectedValue(new Error('profile_unavailable'));
    expect(await admitPatientCareInput(ctx, 'in crisis', 'messaging')).toMatchObject({
      recording_status: 'recorded',
      resources: { status: 'unavailable', emergency_number: null },
    });
  });

  it('commits before reading resources and checks live authorization after the wait', async () => {
    mocks.profile.mockImplementation(async () => {
      expect(mocks.outbox).toHaveBeenCalledOnce();
      mocks.query.mockRejectedValue(Object.assign(new Error('revoked'), { code: 'PT401' }));
      return { emergency_number: 'configured-emergency', crisis_helplines: [] };
    });
    await expect(admitPatientCareInput(ctx, 'in crisis', 'messaging')).rejects.toMatchObject({
      code: 'PT401',
      statusCode: 401,
    });
  });

  it('retains known recording status while withholding ID when final authorization is unavailable', async () => {
    mocks.profile.mockImplementation(async () => {
      mocks.query.mockRejectedValue(new Error('connection_unavailable'));
      return { emergency_number: 'configured-emergency', crisis_helplines: [] };
    });
    const result = await admitPatientCareInput(ctx, 'in crisis', 'messaging');
    expect(result).toMatchObject({
      recording_status: 'recorded',
      escalation_status: 'pending',
      disclosure_status: 'unavailable',
    });
    expect(result).not.toHaveProperty('crisis_event_id');
  });

  it('rejects identity mismatch before any write even with a retry key', async () => {
    await expect(
      admitPatientCareInput({ ...ctx, accountId: 'different' }, 'in crisis', 'messaging'),
    ).rejects.toMatchObject({ code: 'PT401', statusCode: 401 });
    expect(mocks.audit).not.toHaveBeenCalled();
  });
});
