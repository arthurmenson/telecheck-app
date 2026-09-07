import { beforeEach, describe, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({ query: vi.fn(), profile: vi.fn(), read: vi.fn() }));
vi.mock('../../../lib/rls.js', () => ({
  withTenantContext: (_tx: unknown, _tenant: string, work: () => Promise<unknown>) => work(),
}));
vi.mock('../../../lib/actor-context-binding.js', () => ({
  withActorContext: (_tx: unknown, _nonce: string, work: () => Promise<unknown>) => work(),
}));
vi.mock('../../../lib/with-db-role.js', () => ({
  withDbRole: (_tx: unknown, role: string, work: () => Promise<unknown>) => {
    expect(role).toBe('crisis_care_patient');
    return work();
  },
}));
vi.mock('../../tenant-config/index.js', () => ({ getTenantCountryProfile: mock.profile }));
vi.mock('./patient-care-read.js', () => ({ withPatientCareRead: mock.read }));

import type { PatientCareAdmissionContext } from './patient-care-admission.js';
import { getPatientCrisisHistory } from './patient-history.js';

const ctx = {
  tenant: { tenantId: 'Telecheck-US', countryOfCare: 'US' },
  accountId: '01M1WQJRSCWYKQC9VBEQXWFG0T',
  sessionId: '01M1WQJRSCWYKQC9VBEQXWFG0S',
  actorNonce: 'trusted-context',
} as PatientCareAdmissionContext;
const history = { items: [], active_event: null, offset: 0, limit: 25, has_more: false };
let actor: Record<string, unknown>;
beforeEach(() => {
  vi.clearAllMocks();
  actor = {
    tenant_id: ctx.tenant.tenantId,
    account_id: ctx.accountId,
    session_id: ctx.sessionId,
    country_of_care: 'US',
  };
  mock.read.mockImplementation((work: (tx: unknown) => Promise<unknown>) =>
    work({ query: mock.query }),
  );
  mock.query.mockImplementation(async (sql: string) => ({
    rows: [sql.includes('crisis_care_live_patient') ? { actor } : { history }],
  }));
  mock.profile.mockResolvedValue({ emergency_number: 'configured', crisis_helplines: [] });
});
describe('durable patient crisis history disclosure', () => {
  it('returns an actual empty history and configured resources only after final live authorization', async () => {
    const result = await getPatientCrisisHistory(ctx, 0);
    expect(result).toEqual({
      ...history,
      resources: {
        country_of_care: 'US',
        emergency_number: 'configured',
        crisis_helplines: [],
        status: 'available',
      },
    });
    expect(mock.query.mock.calls.at(-1)?.[0]).toContain('crisis_care_live_patient');
    expect(mock.read).toHaveBeenCalledTimes(3);
  });
  it.each([-1, 0.5, 10001, NaN, Infinity])(
    'rejects invalid offset %s before any read',
    async (offset) => {
      await expect(getPatientCrisisHistory(ctx, offset)).rejects.toMatchObject({ code: '22023' });
      expect(mock.read).not.toHaveBeenCalled();
    },
  );
  it.each(['tenant_id', 'account_id', 'session_id', 'country_of_care'])(
    'denies a mismatched %s',
    async (field) => {
      actor[field] = 'unrelated';
      await expect(getPatientCrisisHistory(ctx, 0)).rejects.toMatchObject({ code: 'PT401' });
      expect(mock.profile).not.toHaveBeenCalled();
      expect(mock.query.mock.calls.some(([sql]) => sql.includes('patient_history'))).toBe(false);
    },
  );
  it('never turns a failed history read into no active event', async () => {
    mock.query.mockImplementation(async (sql: string) => {
      if (sql.includes('patient_history')) throw new Error('history_unavailable');
      return { rows: [{ actor }] };
    });
    await expect(getPatientCrisisHistory(ctx, 0)).rejects.toThrow('history_unavailable');
    expect(mock.profile).not.toHaveBeenCalled();
  });
  it('preserves known history when resource configuration is unavailable', async () => {
    mock.profile.mockRejectedValue(new Error('country_profile_unavailable'));
    const result = await getPatientCrisisHistory(ctx, 0);
    expect(result).toEqual({
      ...history,
      resources: {
        country_of_care: 'US',
        emergency_number: null,
        crisis_helplines: [],
        status: 'unavailable',
      },
    });
  });
  it('withholds history when the session expires during resource lookup', async () => {
    mock.profile.mockImplementation(async () => {
      mock.query.mockRejectedValue(Object.assign(new Error('expired'), { code: 'PT401' }));
      return { emergency_number: 'configured', crisis_helplines: [] };
    });
    await expect(getPatientCrisisHistory(ctx, 0)).rejects.toMatchObject({ code: 'PT401' });
  });
  it('withholds history if the final authorization connection is unavailable', async () => {
    mock.read
      .mockImplementationOnce((work: (tx: unknown) => Promise<unknown>) =>
        work({ query: mock.query }),
      )
      .mockImplementationOnce((work: (tx: unknown) => Promise<unknown>) =>
        work({ query: mock.query }),
      )
      .mockRejectedValueOnce(new Error('crisis_read_unavailable'));
    await expect(getPatientCrisisHistory(ctx, 0)).rejects.toThrow('crisis_read_unavailable');
  });
});
