import { EventEmitter } from 'node:events';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  audit: vi.fn(),
  outbox: vi.fn(),
  profile: vi.fn(),
  commitFailure: false,
  commitError: null as unknown,
  cleanupError: null as unknown,
  commitHang: false,
  cleanupHang: false,
  rollbackHang: false,
  release: vi.fn(),
  previousTenantId: null as string | null,
  /** Emit a client 'error' event alongside the COMMIT rejection (pg does both). */
  commitEmitsError: false,
  client: null as unknown,
  /** Emit a client 'error' synchronously the instant checkout hands over. */
  emitOnCheckout: null as Error | null,
  /** Exercise the harness-style promise-only connect(). */
  promiseOnlyConnect: false,
}));
// The module now OWNS its recording client: it takes a raw pool client,
// sets the tenant binding itself, runs BEGIN/COMMIT, and decides whether to
// return or DISCARD the client. So the seam is `getPool().connect()`, and
// COMMIT/cleanup failures are simulated where they really happen — on the
// `COMMIT` and `clear_tenant_context()` statements via `mocks.query` — and
// disposal is observed via `mocks.release`.
// A real EventEmitter, like pg.Client: an 'error' event with no listener
// THROWS out of emit() — the process-exit path the module must prevent by
// owning the listener while it owns the client.
vi.mock('../../../lib/db.js', () => ({
  getPool: () => ({
    // Mirrors pg-pool: with a callback, hand the client over synchronously
    // (returning undefined); without one, return a promise. The harness
    // wrapper is promise-only and ignores the callback.
    connect: (callback?: (error: Error | null, client?: unknown) => void) => {
      const client = Object.assign(new EventEmitter(), {
        query: mocks.query,
        release: mocks.release,
      });
      mocks.client = client;
      if (mocks.promiseOnlyConnect || !callback) return Promise.resolve(client);
      callback(null, client);
      // pg-pool has already dropped its own idle listener by now; a
      // coalesced ReadyForQuery + FATAL read emits here, before any await
      // in the caller can resume.
      if (mocks.emitOnCheckout) client.emit('error', mocks.emitOnCheckout);
      return undefined;
    },
  }),
}));
vi.mock('../../../lib/rls.js', () => ({
  withTenantContext: (_tx: unknown, _tenant: string, work: () => Promise<unknown>) => work(),
  readCurrentTenantId: async () => mocks.previousTenantId,
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
/** Let consumed background cleanup run (real timers). */
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
beforeEach(() => {
  vi.clearAllMocks();
  mocks.commitFailure = false;
  mocks.commitError = null;
  mocks.cleanupError = null;
  mocks.commitHang = false;
  mocks.cleanupHang = false;
  mocks.rollbackHang = false;
  mocks.previousTenantId = null;
  mocks.commitEmitsError = false;
  mocks.client = null;
  mocks.emitOnCheckout = null;
  mocks.promiseOnlyConnect = false;
  mocks.profile.mockResolvedValue({
    emergency_number: 'configured-emergency',
    crisis_helplines: [],
  });
  mocks.audit.mockResolvedValue({ audit_id: '123e4567-e89b-42d3-a456-426614174001' });
  mocks.outbox.mockResolvedValue(undefined);
  mocks.query.mockImplementation(async (sql: string) => {
    if (sql === 'ROLLBACK') {
      // A wedged connection after a rejected COMMIT: ROLLBACK never returns.
      if (mocks.rollbackHang) return new Promise<never>(() => undefined);
      return { rows: [] };
    }
    if (sql.includes('clear_tenant_context')) {
      // Post-COMMIT cleanup runs outside the transaction and its timeouts.
      if (mocks.cleanupHang) return new Promise<never>(() => undefined);
      if (mocks.cleanupError !== null) throw mocks.cleanupError;
      return { rows: [] };
    }
    if (sql === 'COMMIT') {
      // A COMMIT that never acknowledges: deferred-trigger work the server's
      // statement_timeout does not bound.
      if (mocks.commitHang) return new Promise<never>(() => undefined);
      // Acknowledgement loss: no SQLSTATE, outcome genuinely unknown.
      if (mocks.commitFailure) throw new Error('connection_lost');
      // Server RAISED during COMMIT (deferred trigger): a definite rollback.
      if (mocks.commitError !== null) {
        if (mocks.commitEmitsError) {
          const err = mocks.commitError as Error;
          setImmediate(() => (mocks.client as EventEmitter).emit('error', err));
        }
        throw mocks.commitError;
      }
      return { rows: [] };
    }
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

  it('lets the deferred evidence trigger fire at COMMIT instead of forcing it early', async () => {
    // The old code issued `SET CONSTRAINTS crisis_care_evidence IMMEDIATE`
    // before the last assert, draining the trigger queue so COMMIT ran with
    // no authority check. That is the window in which an expired nonce was
    // committed. The trigger must fire on COMMIT itself.
    await admitPatientCareInput(ctx, 'in crisis', 'messaging');
    const sqls = mocks.query.mock.calls.map(([sql]) => String(sql));
    expect(sqls.some((q) => q.includes('SET CONSTRAINTS'))).toBe(false);
    const write = sqls.findIndex((q) => q.includes('crisis_care_record'));
    const commit = sqls.indexOf('COMMIT');
    expect(write).toBeGreaterThanOrEqual(0);
    expect(commit).toBeGreaterThan(write);
    expect(sqls.indexOf('BEGIN')).toBeLessThan(write);
  });

  it('rejects an admission whose nonce expired before COMMIT (PT401 raised by COMMIT)', async () => {
    // `crisis_care_require_evidence()` calls `crisis_care_live_patient()`,
    // which compares the nonce against clock_timestamp(). Fired at COMMIT,
    // an expired nonce raises PT401 from the COMMIT statement and the
    // transaction rolls back — nothing is recorded under expired authority.
    mocks.commitError = Object.assign(new Error('crisis_unauthenticated'), {
      code: 'PT401',
      severity: 'ERROR',
    });
    await expect(admitPatientCareInput(ctx, 'in crisis', 'messaging')).rejects.toMatchObject({
      code: 'PT401',
      statusCode: 401,
    });
    const sqls = mocks.query.mock.calls.map(([sql]) => String(sql));
    expect(sqls.indexOf('ROLLBACK')).toBeGreaterThan(sqls.indexOf('COMMIT'));
  });

  it('treats a constraint violation raised at COMMIT as a definite rollback, not uncertainty', async () => {
    // With the evidence trigger deferred, `crisis_evidence_required` can
    // now arrive on COMMIT. A raise carries a SQLSTATE and is a guaranteed
    // rollback; only acknowledgement loss (no SQLSTATE) is `unconfirmed`.
    mocks.commitError = Object.assign(new Error('crisis_evidence_required'), {
      code: '23514',
      severity: 'ERROR',
    });
    expect(await admitPatientCareInput(ctx, 'in crisis', 'messaging')).toMatchObject({
      recording_status: 'not_recorded',
      escalation_status: 'not_queued',
    });
  });

  it('keeps an acknowledged COMMIT recorded even when tenant cleanup fails afterwards', async () => {
    // Codex finding on PR #302: after a successful COMMIT the wrapper still
    // runs clear_tenant_context. If that cleanup loses its connection the
    // wrapper throws a generic error with no SQLSTATE, and the acknowledged
    // admission was being reported `unconfirmed` (503). The outcome is
    // settled at COMMIT; bookkeeping afterwards must not rewrite it.
    mocks.cleanupError = new Error('connection terminated during cleanup');
    const result = await admitPatientCareInput(ctx, 'in crisis', 'messaging');
    expect(result).toMatchObject({
      recording_status: 'recorded',
      escalation_status: 'pending',
      crisis_event_id: '123e4567-e89b-42d3-a456-426614174002',
    });
    // Cleanup is consumed background work; a client whose tenant binding
    // could not be cleared is DISCARDED, never returned (I-023).
    await flush();
    expect(mocks.release).toHaveBeenCalledWith(true);
  });

  it('keeps a PT401 raised by COMMIT as a 401 even when cleanup also fails', async () => {
    // Same finding, other branch: PT401 at COMMIT followed by a cleanup
    // failure became an AggregateError with no code, replacing the required
    // 401 with `unconfirmed`. The primary transaction failure wins.
    mocks.commitError = Object.assign(new Error('crisis_unauthenticated'), {
      code: 'PT401',
      severity: 'ERROR',
    });
    mocks.cleanupError = new Error('connection terminated during cleanup');
    await expect(admitPatientCareInput(ctx, 'in crisis', 'messaging')).rejects.toMatchObject({
      code: 'PT401',
      statusCode: 401,
    });
    await flush();
    expect(mocks.release).toHaveBeenCalledWith(true);
  });

  it('bounds a stalled COMMIT with a client-side deadline and reports uncertainty', async () => {
    // Codex round 3 on PR #302: PostgreSQL disables statement_timeout
    // before running deferred triggers inside COMMIT, so once the evidence
    // trigger fires at COMMIT its scan is unbounded server-side. A stalled
    // COMMIT must not hold the patient's safety-resource response hostage.
    vi.useFakeTimers();
    try {
      mocks.commitHang = true;
      const pending = admitPatientCareInput(ctx, 'in crisis', 'messaging');
      // Deadline is 4 s; nothing should have resolved before it.
      await vi.advanceTimersByTimeAsync(3_900);
      let resolvedEarly = false;
      void pending.then(() => {
        resolvedEarly = true;
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(resolvedEarly).toBe(false);
      await vi.advanceTimersByTimeAsync(200);
      const result = await pending;
      expect(result).toMatchObject({
        recording_status: 'unconfirmed',
        escalation_status: 'unconfirmed',
      });
      expect(result).not.toHaveProperty('crisis_event_id');
      // The stalled client is DESTROYED so it can never be handed to another
      // request mid-COMMIT. No backend is signalled by pid: under pool
      // saturation a delayed pg_cancel_backend can land after this client
      // was released and re-borrowed, aborting another tenant's transaction
      // (Codex round 4 on PR #302).
      expect(mocks.release).toHaveBeenCalledWith(true);
      const sqls = mocks.query.mock.calls.map(([sql]) => String(sql));
      expect(sqls.some((q) => q.includes('pg_cancel_backend'))).toBe(false);
      expect(sqls.some((q) => q.includes('pg_backend_pid'))).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not arm the COMMIT deadline for work that never reaches COMMIT', async () => {
    // A failure before COMMIT is a known rollback and must classify
    // not_recorded — the deadline must not turn it into uncertainty.
    vi.useFakeTimers();
    try {
      mocks.outbox.mockRejectedValue(new Error('synthetic_outbox_error'));
      const pending = admitPatientCareInput(ctx, 'in crisis', 'messaging');
      await vi.advanceTimersByTimeAsync(10_000);
      expect(await pending).toMatchObject({
        recording_status: 'not_recorded',
        escalation_status: 'not_queued',
      });
      await vi.advanceTimersByTimeAsync(0);
      // Rolled back and cleaned up: the client is RETURNED, not discarded.
      expect(mocks.release).toHaveBeenCalledWith();
      expect(mocks.release).not.toHaveBeenCalledWith(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('returns an acknowledged COMMIT immediately even when cleanup hangs, then discards the client', async () => {
    // Codex round 4 on PR #302: with the timer cleared on successful COMMIT,
    // a hanging clear_tenant_context() DELETE — outside the transaction and
    // its SET LOCAL timeouts — withheld the safety resources despite an
    // acknowledged commit. Cleanup is now consumed background work with its
    // own 2 s bound; the response never waits on it.
    vi.useFakeTimers();
    try {
      mocks.cleanupHang = true;
      const pending = admitPatientCareInput(ctx, 'in crisis', 'messaging');
      await vi.advanceTimersByTimeAsync(0);
      const result = await pending;
      expect(result).toMatchObject({
        recording_status: 'recorded',
        escalation_status: 'pending',
        crisis_event_id: '123e4567-e89b-42d3-a456-426614174002',
      });
      expect(mocks.release).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(2_100);
      expect(mocks.release).toHaveBeenCalledWith(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('returns a PT401 raised by COMMIT immediately even when ROLLBACK hangs', async () => {
    // Codex round 5 on PR #302: after COMMIT rejected, the run still awaited
    // ROLLBACK with the deadline armed, so a wedged connection let the
    // deadline fire and overwrite a KNOWN 401 with `unconfirmed` (503). The
    // outcome is published the instant COMMIT settles; ROLLBACK is bounded
    // background work and the wedged client is discarded.
    vi.useFakeTimers();
    try {
      mocks.commitError = Object.assign(new Error('crisis_unauthenticated'), {
        code: 'PT401',
        severity: 'ERROR',
      });
      mocks.rollbackHang = true;
      const pending = admitPatientCareInput(ctx, 'in crisis', 'messaging');
      // Attach the expectation BEFORE advancing the clock: the rejection
      // lands in that tick, and an unhandled rejection is a vitest error
      // even when a handler arrives one microtask later.
      const rejection = expect(pending).rejects.toMatchObject({ code: 'PT401', statusCode: 401 });
      await vi.advanceTimersByTimeAsync(0);
      await rejection;
      expect(mocks.release).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(2_100);
      expect(mocks.release).toHaveBeenCalledWith(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('returns a 23514 raised by COMMIT as not_recorded immediately even when ROLLBACK hangs', async () => {
    vi.useFakeTimers();
    try {
      mocks.commitError = Object.assign(new Error('crisis_evidence_required'), {
        code: '23514',
        severity: 'ERROR',
      });
      mocks.rollbackHang = true;
      const pending = admitPatientCareInput(ctx, 'in crisis', 'messaging');
      await vi.advanceTimersByTimeAsync(0);
      expect(await pending).toMatchObject({
        recording_status: 'not_recorded',
        escalation_status: 'not_queued',
      });
      expect(mocks.release).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(2_100);
      expect(mocks.release).toHaveBeenCalledWith(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps EPIPE on an issued COMMIT classified as uncertain — a SQLSTATE shape is not a raise', async () => {
    // Codex round 2 on PR #303, same classifier: EPIPE is five uppercase
    // characters, so a shape-only test read a socket error as a server
    // raise and reported not_recorded. pg server errors carry `severity`;
    // transport errors never do.
    mocks.commitError = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
    const result = await admitPatientCareInput(ctx, 'in crisis', 'messaging');
    expect(result).toMatchObject({
      recording_status: 'unconfirmed',
      escalation_status: 'unconfirmed',
    });
    expect(result).not.toHaveProperty('crisis_event_id');
  });

  it('restores the tenant binding that was in place when it took the client, else clears', async () => {
    mocks.previousTenantId = 'Telecheck-Ghana';
    await admitPatientCareInput(ctx, 'in crisis', 'messaging');
    await flush();
    const sets = mocks.query.mock.calls.filter(([sql]) =>
      String(sql).includes('set_tenant_context'),
    );
    expect(sets[0]?.[1]).toEqual([ctx.tenant.tenantId]);
    expect(sets[sets.length - 1]?.[1]).toEqual(['Telecheck-Ghana']);
    expect(
      mocks.query.mock.calls.some(([sql]) => String(sql).includes('clear_tenant_context')),
    ).toBe(false);

    vi.clearAllMocks();
    mocks.previousTenantId = null;
    await admitPatientCareInput(ctx, 'in crisis', 'messaging');
    await flush();
    expect(
      mocks.query.mock.calls.some(([sql]) => String(sql).includes('clear_tenant_context')),
    ).toBe(true);
  });

  it('survives the driver emitting a client error event alongside the COMMIT rejection', async () => {
    // Same class as Codex round 3 on PR #303: with no listener, the client
    // 'error' emit that accompanies an EPIPE rejection throws and exits Node
    // before any rejection handler runs.
    mocks.commitError = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
    mocks.commitEmitsError = true;
    const result = await admitPatientCareInput(ctx, 'in crisis', 'messaging');
    expect(result).toMatchObject({ recording_status: 'unconfirmed' });
    await new Promise<void>((resolve) => setImmediate(resolve));
    // Retained after discard: a destroyed client may still emit late.
    expect((mocks.client as EventEmitter).listenerCount('error')).toBe(1);
  });

  it('listens for client errors for the whole ownership window, then lets go at release', async () => {
    let duringWork = -1;
    mocks.query.mockImplementationOnce(async (sql: string) => {
      duringWork = (mocks.client as EventEmitter).listenerCount('error');
      return sql === 'BEGIN' ? { rows: [] } : { rows: [] };
    });
    await admitPatientCareInput(ctx, 'in crisis', 'messaging');
    expect(duringWork).toBe(1);
    await flush();
    expect(mocks.release).toHaveBeenCalledWith();
    expect((mocks.client as EventEmitter).listenerCount('error')).toBe(0);
  });

  it('is already listening when pool checkout hands the client over — no microtask gap', async () => {
    // Codex round 4 on PR #303: a listener attached after `await` resumes is
    // one microtask too late for a coalesced startup ReadyForQuery + FATAL
    // 57P01, which pg parses synchronously. With no listener that emit
    // throws and Node exits. This emit fires synchronously right after
    // handover; a crisis message must still be admitted.
    mocks.emitOnCheckout = Object.assign(new Error('terminating connection'), {
      code: '57P01',
      severity: 'FATAL',
    });
    const result = await admitPatientCareInput(ctx, 'in crisis', 'messaging');
    expect(result).toMatchObject({ recording_status: 'recorded' });
  });

  it('still works with a promise-only pool (the test harness wrapper)', async () => {
    mocks.promiseOnlyConnect = true;
    const result = await admitPatientCareInput(ctx, 'in crisis', 'messaging');
    expect(result).toMatchObject({ recording_status: 'recorded' });
    await flush();
    expect(mocks.release).toHaveBeenCalledWith();
  });

  it('keeps a class-08 connection exception at COMMIT classified as uncertain', async () => {
    // Codex verification round on PR #302: a five-char SQLSTATE was being
    // read as "the server raised, so it rolled back". Class 08 is the
    // opposite — the CLIENT reporting it does not know what the server
    // did. 08007 is literally transaction_resolution_unknown; the
    // admission may already be committed, so claiming `not_recorded`
    // would invite a duplicating retry under a fresh key.
    for (const code of ['08007', '08006', '08003', '08000']) {
      mocks.commitError = Object.assign(new Error('connection exception'), { code });
      const result = await admitPatientCareInput(ctx, 'in crisis', 'messaging');
      expect(result, `SQLSTATE ${code} must stay uncertain`).toMatchObject({
        recording_status: 'unconfirmed',
        escalation_status: 'unconfirmed',
      });
      expect(result).not.toHaveProperty('crisis_event_id');
    }
  });

  it('keeps a driver-level failure code (not a SQLSTATE) classified as uncertain', async () => {
    // pg surfaces socket errors with codes like ECONNRESET. Those are not
    // five-char SQLSTATEs and must not be mistaken for a server raise.
    mocks.commitError = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
    expect(await admitPatientCareInput(ctx, 'in crisis', 'messaging')).toMatchObject({
      recording_status: 'unconfirmed',
      escalation_status: 'unconfirmed',
    });
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
