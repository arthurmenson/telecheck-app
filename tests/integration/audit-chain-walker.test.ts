/**
 * Audit chain walker integrity tests — `assertAuditChainIntact()`.
 *
 * Closes the test gap where the existing `audit-chain.test.ts` scenarios
 * cover happy-path chain integrity (Scenario 1) and the append-only
 * triggers (Scenarios 2 + 3), but NEVER actually exercise the walker's
 * tampering-detection code paths (the it.todo() Scenario 4 was deferred
 * pending DISABLE-TRIGGER scaffolding).
 *
 * Why this matters:
 *   `assertAuditChainIntact()` is the I-003 verification path
 *   production relies on for offline chain audits. The walker has three
 *   distinct failure-detection branches:
 *
 *     1. Per-record canonical-hash recomputation (HIGH-2 closure 2026-05-03):
 *        catches forged-and-resigned tampering where a column was
 *        altered and record_hash was hand-rewritten to "match" but
 *        won't match `audit_records_canonical_hash(...)` evaluated now.
 *
 *     2. Chain link verification: each record's prev_hash MUST equal
 *        the prior record's record_hash within the same partition.
 *
 *     3. Genesis seed verification (HIGH-1 closure 2026-05-03):
 *        the FIRST record in a partition's prev_hash MUST equal
 *        SHA-256('GENESIS:' || tenant_id || ':' ||
 *        COALESCE(target_patient_id, 'PLATFORM')). Catches an injected
 *        fake-genesis row whose prev_hash points at another tenant's
 *        chain or some other forged value.
 *
 *   Without tests exercising each failure branch, a regression in the
 *   walker's detection logic — e.g. comparing record_hash to
 *   itself instead of to the recomputed value — would silently mean
 *   tampered audit chains read as "intact" in production.
 *
 * Coverage in this file:
 *   §1 — Walker on EMPTY chain (vacuously passes; no rows for tenant).
 *   §2 — Walker on SINGLE-RECORD chain (genesis verification path
 *        exercised in isolation; no chain-link branch).
 *   §3 — Walker on MULTI-PARTITION single tenant (3 patient partitions
 *        + PLATFORM partition; each chain validated independently).
 *   §4 — Tampering detection — record_hash mismatch (HIGH-2 walker
 *        branch). DISABLE TRIGGER scaffolding inserts a row whose
 *        column values don't match its stored record_hash; walker
 *        throws with "record_hash mismatch" + audit_id + partition.
 *   §5 — Tampering detection — broken chain link (HIGH-1 walker
 *        branch). Inject a non-first record whose prev_hash doesn't
 *        equal the prior record's record_hash; walker throws "chain
 *        link broken" + audit_id + seq.
 *   §6 — Tampering detection — forged genesis (HIGH-1 + HIGH-2 in the
 *        first-record-of-partition case). Inject a first record whose
 *        prev_hash is NOT the canonical genesis seed; walker throws
 *        "expected genesis seed".
 *
 * Spec references:
 *   - I-003 (audit append-only; chain never broken)
 *   - I-027 (every audit record carries tenant_id)
 *   - migration 002 (audit_records table + triggers + canonical-hash
 *     SQL function used by both trigger and walker for symmetric
 *     verification)
 *   - tests/helpers/audit-assertions.ts assertAuditChainIntact (the
 *     walker under test)
 *
 * DISABLE-TRIGGER scaffolding pattern:
 *   The shared test client (per tests/setup.ts) runs as a non-
 *   superuser test app role. ALTER TABLE ... DISABLE TRIGGER requires
 *   table-owner privilege, which only the connection's underlying
 *   superuser has. The pattern:
 *
 *     await client.query('RESET SESSION AUTHORIZATION');           // escalate
 *     await client.query('ALTER TABLE audit_records DISABLE TRIGGER <name>');
 *     // ... inject tampered row(s) ...
 *     await client.query('ALTER TABLE audit_records ENABLE TRIGGER <name>');
 *     await client.query(`SET SESSION AUTHORIZATION ${TEST_APP_ROLE}`); // restore
 *
 *   ALWAYS run via try/finally so the trigger is re-enabled even on
 *   test failure. The savepoint isolation in tests/setup.ts rolls
 *   back any tampered rows at afterEach.
 */

import { createHash, randomUUID } from 'node:crypto';

import { afterEach, describe, expect, it } from 'vitest';

import { assertAuditChainIntact } from '../helpers/audit-assertions.ts';
import { TENANT_GHANA, TENANT_US, withTenantContext } from '../helpers/tenant-fixtures.ts';
import { getTestClient } from '../setup.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Insert a well-formed audit record. The BEFORE INSERT trigger
 * recomputes prev_hash, record_hash, and sequence_number on every
 * row, so this helper passes only the body fields.
 */
async function insertAuditRecord(args: {
  tenant_id: string;
  target_patient_id: string | null;
  action: string;
  category: 'A' | 'B' | 'C';
  resource_id: string;
  audit_id?: string;
}): Promise<string> {
  const client = getTestClient();
  const auditId = args.audit_id ?? randomUUID();
  await client.query(
    `INSERT INTO audit_records
       (audit_id, tenant_id, actor_type, actor_id,
        target_patient_id, action, category,
        audit_sensitivity_level, resource_type, resource_id,
        ai_workload_type, autonomy_level, payload)
     VALUES
       ($1, $2, 'system', 'sys_walker_test',
        $3, $4, $5,
        'standard', 'medication_request', $6,
        NULL, NULL, '{}'::jsonb)`,
    [auditId, args.tenant_id, args.target_patient_id, args.action, args.category, args.resource_id],
  );
  return auditId;
}

const TEST_APP_ROLE = 'telecheck_test_app';

/**
 * Run `fn` with the BEFORE INSERT hash trigger temporarily disabled, so
 * tampered rows can be inserted with arbitrary prev_hash / record_hash
 * / sequence_number values.
 *
 * Cleanup safety (Codex chain-walker-r0 HIGH closure 2026-05-04):
 *   The shared test client is a single long-lived connection that
 *   subsequent tests reuse. A cleanup failure here can leave:
 *     (a) the hash trigger disabled — subsequent inserts skip the hash
 *         chain entirely, silently corrupting integration-test results.
 *     (b) the session authorized as the underlying superuser — RLS
 *         and authorization-gate tests would silently bypass.
 *
 *   Each cleanup step runs in its own guarded try/catch so a failure
 *   in one doesn't skip the others. After all cleanup runs, we VERIFY
 *   the post-cleanup state (trigger enabled + session_user is the test
 *   role); any verification failure throws loud and kills the test
 *   process so contamination can't reach later tests.
 *
 *   Errors during cleanup are PRESERVED (concatenated into a single
 *   error) — the original `fn` error (if any) is re-thrown via
 *   AggregateError to preserve diagnostics for both failure modes.
 *
 * Requires the underlying connection role to own audit_records (the
 * test harness runs migrations as a superuser and then SETs the test
 * app role; RESET SESSION AUTHORIZATION drops back to the superuser).
 */
async function withInsertTriggerDisabled<T>(fn: () => Promise<T>): Promise<T> {
  const client = getTestClient();
  await client.query('RESET SESSION AUTHORIZATION');
  await client.query('ALTER TABLE audit_records DISABLE TRIGGER audit_records_before_insert');

  let fnError: unknown;
  let result: T;
  try {
    result = await fn();
  } catch (err) {
    fnError = err;
    result = undefined as unknown as T;
  }

  // Each cleanup step in its own try/catch — a failure in one MUST NOT
  // skip the others. Collect cleanup errors for a single AggregateError.
  const cleanupErrors: unknown[] = [];

  try {
    await client.query('ALTER TABLE audit_records ENABLE TRIGGER audit_records_before_insert');
  } catch (err) {
    cleanupErrors.push(err);
  }
  try {
    await client.query(`SET SESSION AUTHORIZATION ${TEST_APP_ROLE}`);
  } catch (err) {
    cleanupErrors.push(err);
  }

  // Verify the post-cleanup state. If verification fails, the shared
  // client is in an unsafe state and subsequent tests would be
  // contaminated. We capture the verification mismatch as a
  // structured error and compose the final throw below so the
  // original `fnError` and any `cleanupErrors` are NEVER lost
  // (Codex r1 MED closure 2026-05-04).
  const verificationError = await checkCleanupState();

  const composed = composeCleanupErrors(fnError, cleanupErrors, verificationError);
  if (composed !== null) {
    throw composed;
  }

  return result;
}

/**
 * Pure error-composition helper. Returns the single error (or
 * AggregateError) that should be thrown given:
 *   - `fnError` — callback failure if any (undefined = no error)
 *   - `cleanupErrors` — each cleanup step's error (empty array OK)
 *   - `verificationError` — post-cleanup state mismatch if any
 *
 * Behavior:
 *   - 0 causes → returns null (caller returns result)
 *   - 1 cause  → returns that error verbatim (clean stack for the
 *                common case)
 *   - 2+ causes → returns AggregateError with all causes preserved
 *
 * Extracted as a pure function (Codex r2 MED closure 2026-05-04) so
 * the multi-cause composition path can be unit-tested directly
 * without DB-level fault injection.
 */
export function composeCleanupErrors(
  fnError: unknown,
  cleanupErrors: readonly unknown[],
  verificationError: Error | null,
): unknown {
  const allErrors: unknown[] = [];
  if (fnError !== undefined) allErrors.push(fnError);
  for (const e of cleanupErrors) allErrors.push(e);
  if (verificationError !== null) allErrors.push(verificationError);

  if (allErrors.length === 0) return null;
  if (allErrors.length === 1) return allErrors[0];
  return new AggregateError(
    allErrors,
    'withInsertTriggerDisabled: multiple errors during execution + cleanup. ' +
      'Inspect AggregateError.errors[] in order: callback error (if any), ' +
      'cleanup errors (if any), then post-cleanup verification error (if state ' +
      'verification failed). All causes preserved for diagnostics.',
  );
}

/**
 * Verify that after cleanup:
 *   - audit_records_before_insert trigger is enabled
 *   - session_user is the test app role (not the underlying superuser)
 *
 * Returns an Error describing the mismatch, or null if the state is
 * clean. Returning instead of throwing lets the caller compose all
 * causes (callback error + cleanup errors + verification error) into
 * a single AggregateError so diagnostics aren't lost when multiple
 * failures stack up.
 *
 * (Codex r1 MED closure 2026-05-04 — refactored from a throwing
 * function to a returning one so the outer try/cleanup logic owns
 * the throw composition.)
 */
async function checkCleanupState(): Promise<Error | null> {
  const client = getTestClient();
  // `triggerEnabled` is true when verified enabled, false when verified
  // disabled, and 'unknown' when the verification query itself errored.
  // `sessionUser` is the verified session user string, or 'unknown' on
  // verify-query error. The literal 'unknown' is a sentinel value
  // distinguishable from a real session_user (which is always a
  // PostgreSQL role name).
  let triggerEnabled: boolean | 'unknown' = 'unknown';
  let sessionUser = 'unknown';
  const verifyErrors: unknown[] = [];

  try {
    const r = await client.query<{ tgenabled: string }>(
      `SELECT tgenabled FROM pg_trigger
        WHERE tgname = 'audit_records_before_insert'
          AND tgrelid = 'audit_records'::regclass`,
    );
    // tgenabled = 'O' means trigger is enabled (origin/local mode).
    // 'D' means disabled. Other values: 'R' replica only, 'A' always.
    triggerEnabled = r.rows[0]?.tgenabled === 'O';
  } catch (err) {
    verifyErrors.push(err);
  }

  try {
    const r = await client.query<{ session_user: string }>(`SELECT session_user`);
    sessionUser = r.rows[0]?.session_user ?? 'unknown';
  } catch (err) {
    verifyErrors.push(err);
  }

  if (triggerEnabled === true && sessionUser === TEST_APP_ROLE && verifyErrors.length === 0) {
    return null; // Clean state
  }

  const summary =
    `Post-cleanup verification FAILED: ` +
    `audit_records_before_insert trigger enabled=${String(triggerEnabled)} ` +
    `(expected true); session_user='${sessionUser}' (expected '${TEST_APP_ROLE}'). ` +
    `The shared test client is in an UNSAFE state — subsequent tests would be ` +
    `contaminated.`;

  if (verifyErrors.length > 0) {
    return new AggregateError(
      verifyErrors,
      `${summary} Verification queries themselves errored — see AggregateError.errors[].`,
    );
  }
  return new Error(summary);
}

/** SHA-256 hex of the input string (matches audit-assertions.ts). */
function sha256Hex(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

afterEach(async () => {
  // Defensive: if `withInsertTriggerDisabled` itself ran cleanly the
  // session is already in a clean state (test app role + trigger
  // enabled). This hook's job is to verify that, and to recover from
  // any prior crash that escaped the inner cleanup.
  //
  // Cleanup safety (Codex r0 HIGH closure 2026-05-04): the shared
  // client persists across tests, so leaked privilege escalation or
  // a disabled trigger silently corrupts every subsequent test. Each
  // step is independently guarded, post-state is verified, and any
  // verification failure throws loudly to abort the suite at this
  // boundary rather than propagate.
  const client = getTestClient();

  // Step 1: try to RESET to the underlying superuser so we can
  // execute ALTER TRIGGER. If this fails because we're already at
  // the underlying role (no SET in effect), pg returns silently —
  // RESET is a no-op when no SESSION AUTHORIZATION is in effect.
  // The wrapper still runs ENABLE next so the trigger state is
  // re-asserted regardless.
  try {
    await client.query('RESET SESSION AUTHORIZATION');
  } catch {
    // Permission error → we're not in a position to ALTER. Verify
    // step below catches an actually-disabled trigger.
  }

  // Step 2: re-enable the trigger if disabled. If we don't have
  // privilege (because RESET failed or the connection's underlying
  // role isn't the table owner), this fails — verify will then
  // throw. ENABLE on an already-enabled trigger is a no-op.
  try {
    await client.query('ALTER TABLE audit_records ENABLE TRIGGER audit_records_before_insert');
  } catch {
    // Verify step catches a still-disabled trigger.
  }

  // Step 3: switch back to the test app role. If we're already there,
  // SET SESSION AUTHORIZATION to the same role is a no-op.
  try {
    await client.query(`SET SESSION AUTHORIZATION ${TEST_APP_ROLE}`);
  } catch {
    // Verify step catches an unexpected session_user.
  }

  // Verify post-cleanup state. Throw LOUD on mismatch — silent
  // corruption is the failure mode this whole batch was designed
  // around. Re-uses the helper so afterEach + withInsertTriggerDisabled
  // share verification logic.
  const verifyErr = await checkCleanupState();
  if (verifyErr !== null) {
    throw verifyErr;
  }
});

// ---------------------------------------------------------------------------
// §0 — composeCleanupErrors: pure-function unit tests
//     (Codex r2 MED closure 2026-05-04)
//
// The error-composition contract was extracted from the body of
// withInsertTriggerDisabled into a pure function that can be exercised
// for every branch directly, without needing DB-level fault injection.
// These tests pin the contract: 0 causes → null; 1 cause → verbatim;
// 2+ causes → AggregateError preserving every cause in order
// (callback first, cleanup steps next, verification last).
// ---------------------------------------------------------------------------

describe('composeCleanupErrors — error preservation contract', () => {
  it('returns null when no errors occurred (success path)', () => {
    expect(composeCleanupErrors(undefined, [], null)).toBeNull();
  });

  it('returns the callback error verbatim when only fn errored (single-cause path)', () => {
    const cb = new Error('cb boom');
    expect(composeCleanupErrors(cb, [], null)).toBe(cb);
  });

  it('returns the single cleanup error verbatim when only one cleanup step failed', () => {
    const c1 = new Error('cleanup-step-1 boom');
    expect(composeCleanupErrors(undefined, [c1], null)).toBe(c1);
  });

  it('returns the verification error verbatim when only post-state was bad', () => {
    const v = new Error('verification mismatch');
    expect(composeCleanupErrors(undefined, [], v)).toBe(v);
  });

  it('returns AggregateError preserving fnError + cleanupError(s) in order', () => {
    const cb = new Error('cb boom');
    const c1 = new Error('cleanup-1');
    const c2 = new Error('cleanup-2');
    const result = composeCleanupErrors(cb, [c1, c2], null);
    expect(result).toBeInstanceOf(AggregateError);
    const agg = result as AggregateError;
    expect(agg.errors).toHaveLength(3);
    expect(agg.errors[0]).toBe(cb);
    expect(agg.errors[1]).toBe(c1);
    expect(agg.errors[2]).toBe(c2);
  });

  it('returns AggregateError preserving fnError + verificationError', () => {
    const cb = new Error('cb boom');
    const v = new Error('verification mismatch');
    const result = composeCleanupErrors(cb, [], v);
    expect(result).toBeInstanceOf(AggregateError);
    const agg = result as AggregateError;
    expect(agg.errors).toHaveLength(2);
    expect(agg.errors[0]).toBe(cb);
    expect(agg.errors[1]).toBe(v);
  });

  it('returns AggregateError preserving cleanupError + verificationError (no callback)', () => {
    const c1 = new Error('cleanup-1');
    const v = new Error('verification mismatch');
    const result = composeCleanupErrors(undefined, [c1], v);
    expect(result).toBeInstanceOf(AggregateError);
    const agg = result as AggregateError;
    expect(agg.errors).toHaveLength(2);
    expect(agg.errors[0]).toBe(c1);
    expect(agg.errors[1]).toBe(v);
  });

  it('returns AggregateError preserving ALL three causes in order (the original Codex r2 case)', () => {
    // The exact multi-cause regression Codex r2 flagged: callback
    // errored, cleanup errored, AND verification failed. All three
    // causes MUST be preserved at AggregateError.errors[0..2] in
    // (callback, cleanup, verification) order so operators reading
    // CI logs see the root cause first.
    const cb = new Error('cb boom — root cause');
    const c1 = new Error('cleanup-step-1 also boomed');
    const v = new Error('verification: trigger still disabled');
    const result = composeCleanupErrors(cb, [c1], v);
    expect(result).toBeInstanceOf(AggregateError);
    const agg = result as AggregateError;
    expect(agg.errors).toHaveLength(3);
    expect(agg.errors[0]).toBe(cb); // root cause first
    expect(agg.errors[1]).toBe(c1); // cleanup next
    expect(agg.errors[2]).toBe(v); // verification last
    // Aggregate message documents the order so callers can grep CI
    // logs without parsing AggregateError shape.
    expect(agg.message).toMatch(/All causes preserved for diagnostics/);
  });

  it('does NOT wrap a single cause in AggregateError (clean stack for common case)', () => {
    // Regression guard: a future change that "always wraps" would
    // produce noisy stack traces. The contract is verbatim throw on
    // single cause.
    const cb = new Error('only one error');
    const result = composeCleanupErrors(cb, [], null);
    expect(result).not.toBeInstanceOf(AggregateError);
    expect(result).toBe(cb);
  });
});

// ---------------------------------------------------------------------------
// §0b — Integration smoke: withInsertTriggerDisabled does NOT lose the
//       callback error in the single-cause production path
// ---------------------------------------------------------------------------

describe('withInsertTriggerDisabled — single-cause production path', () => {
  it('callback error alone is rethrown verbatim (clean cleanup case)', async () => {
    // The integration-side smoke: in the realistic case where cleanup
    // succeeds, the callback error reaches the test verbatim. Pairs
    // with the unit tests above to cover both ends of the contract.
    const cbErr = new Error('callback boom — production smoke');
    let caught: unknown;
    try {
      await withInsertTriggerDisabled(async () => {
        throw cbErr;
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBe(cbErr);
    // afterEach's checkCleanupState() asserts post-state is clean.
  });
});

// ---------------------------------------------------------------------------
// §1 — Empty chain
// ---------------------------------------------------------------------------

describe('assertAuditChainIntact — empty chain', () => {
  it('passes vacuously when no records exist for the tenant', async () => {
    // Use a unique tenant ID via createTenant; the tenant has no audit
    // records yet, so the walker should return without error. We use
    // an existing canonical tenant (Telecheck-US/Ghana) and rely on the
    // savepoint to ensure no records bleed in from another test —
    // BUT the savepoint resets within a per-test scope, so other tests
    // that have run inside the SAME savepoint (this test) can't have
    // inserted records. The canonical tenants START WITH ZERO RECORDS
    // at the savepoint boundary because the savepoint is held by the
    // outer test transaction, not by the suite's beforeAll.
    //
    // To be extra-safe, query first to confirm zero records.
    const client = getTestClient();
    const before = await withTenantContext(TENANT_US, async () => {
      const r = await client.query<{ n: string }>(
        `SELECT COUNT(*)::text AS n FROM audit_records WHERE tenant_id = $1`,
        [TENANT_US],
      );
      return Number(r.rows[0]!.n);
    });
    expect(before).toBe(0);

    // Now the walker.
    await withTenantContext(TENANT_US, () => assertAuditChainIntact(TENANT_US));
  });
});

// ---------------------------------------------------------------------------
// §2 — Single-record chain
// ---------------------------------------------------------------------------

describe('assertAuditChainIntact — single-record chain', () => {
  it('passes when a single record exists with valid genesis link', async () => {
    const patient = `pat_walk_single_${randomUUID().slice(0, 8)}`;
    await withTenantContext(TENANT_US, () =>
      insertAuditRecord({
        tenant_id: TENANT_US,
        target_patient_id: patient,
        action: 'consent_granted',
        category: 'C',
        resource_id: `cnst_${patient}`,
      }),
    );
    await withTenantContext(TENANT_US, () => assertAuditChainIntact(TENANT_US));
  });

  it('passes for a single platform-scope record (target_patient_id NULL → PLATFORM partition)', async () => {
    await withTenantContext(TENANT_US, () =>
      insertAuditRecord({
        tenant_id: TENANT_US,
        target_patient_id: null,
        action: 'config_change_validated',
        category: 'B',
        resource_id: `cfg_walk_${randomUUID().slice(0, 8)}`,
      }),
    );
    await withTenantContext(TENANT_US, () => assertAuditChainIntact(TENANT_US));
  });
});

// ---------------------------------------------------------------------------
// §3 — Multi-partition single tenant
// ---------------------------------------------------------------------------

describe('assertAuditChainIntact — multi-partition single tenant', () => {
  it('walks 3 patient partitions + PLATFORM partition independently', async () => {
    const patientA = `pat_walk_multi_a_${randomUUID().slice(0, 8)}`;
    const patientB = `pat_walk_multi_b_${randomUUID().slice(0, 8)}`;
    const patientC = `pat_walk_multi_c_${randomUUID().slice(0, 8)}`;

    await withTenantContext(TENANT_US, async () => {
      // Patient A: 3 records
      for (let i = 1; i <= 3; i += 1) {
        await insertAuditRecord({
          tenant_id: TENANT_US,
          target_patient_id: patientA,
          action: 'prescribing.initiated',
          category: 'A',
          resource_id: `mr_a_${patientA}_${i}`,
        });
      }
      // Patient B: 2 records
      for (let i = 1; i <= 2; i += 1) {
        await insertAuditRecord({
          tenant_id: TENANT_US,
          target_patient_id: patientB,
          action: 'consent_granted',
          category: 'C',
          resource_id: `cnst_b_${patientB}_${i}`,
        });
      }
      // Patient C: 1 record
      await insertAuditRecord({
        tenant_id: TENANT_US,
        target_patient_id: patientC,
        action: 'lab_uploaded',
        category: 'C',
        resource_id: `lab_c_${patientC}`,
      });
      // PLATFORM partition: 2 records
      for (let i = 1; i <= 2; i += 1) {
        await insertAuditRecord({
          tenant_id: TENANT_US,
          target_patient_id: null,
          action: 'config_change_validated',
          category: 'B',
          resource_id: `cfg_${randomUUID().slice(0, 8)}_${i}`,
        });
      }
    });

    // Walker must validate all 4 partitions cleanly in one call.
    await withTenantContext(TENANT_US, () => assertAuditChainIntact(TENANT_US));

    // Sanity: confirm 8 total records were actually inserted.
    const client = getTestClient();
    const total = await withTenantContext(TENANT_US, async () => {
      const r = await client.query<{ n: string }>(
        `SELECT COUNT(*)::text AS n FROM audit_records
          WHERE tenant_id = $1
            AND (target_patient_id = ANY($2::text[]) OR target_patient_id IS NULL)`,
        [TENANT_US, [patientA, patientB, patientC]],
      );
      return Number(r.rows[0]!.n);
    });
    expect(total).toBe(8);
  });

  it('walks tenant US chain cleanly while tenant Ghana also has data (cross-tenant isolation regression)', async () => {
    // Codex CI-fix HIGH-1 regression test: the walker must filter by
    // tenant_id; cross-tenant rows must not affect the US chain walk.
    const patientUS = `pat_walk_iso_us_${randomUUID().slice(0, 8)}`;
    const patientGH = `pat_walk_iso_gh_${randomUUID().slice(0, 8)}`;
    await withTenantContext(TENANT_US, () =>
      insertAuditRecord({
        tenant_id: TENANT_US,
        target_patient_id: patientUS,
        action: 'consent_granted',
        category: 'C',
        resource_id: `cnst_iso_us_${patientUS}`,
      }),
    );
    await withTenantContext(TENANT_GHANA, () =>
      insertAuditRecord({
        tenant_id: TENANT_GHANA,
        target_patient_id: patientGH,
        action: 'consent_granted',
        category: 'C',
        resource_id: `cnst_iso_gh_${patientGH}`,
      }),
    );
    // Each chain walks cleanly independently.
    await withTenantContext(TENANT_US, () => assertAuditChainIntact(TENANT_US));
    await withTenantContext(TENANT_GHANA, () => assertAuditChainIntact(TENANT_GHANA));
  });
});

// ---------------------------------------------------------------------------
// §4 — Tampering detection: record_hash mismatch (HIGH-2)
// ---------------------------------------------------------------------------

describe('assertAuditChainIntact — record_hash tampering (HIGH-2 closure)', () => {
  it('throws "record_hash mismatch" when a row stored with arbitrary hash is walked', async () => {
    // Closes the it.todo() at audit-chain.test.ts Scenario 4. Insert
    // a tampered row with hash trigger disabled — its stored record_hash
    // will be hand-supplied (a fake), but `audit_records_canonical_hash`
    // recomputed from the row's other columns will produce a different
    // value. The walker MUST detect this mismatch.
    const auditId = randomUUID();
    const patient = `pat_walk_tamper_${randomUUID().slice(0, 8)}`;
    const fakeRecordHash = '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff'; // 64-char fake
    const partitionKey = `${TENANT_US}:${patient}`;
    const genesis = sha256Hex(`GENESIS:${partitionKey}`);

    await withInsertTriggerDisabled(async () => {
      const client = getTestClient();
      await client.query(
        `INSERT INTO audit_records
           (audit_id, tenant_id, actor_type, actor_id,
            target_patient_id, action, category,
            audit_sensitivity_level, resource_type, resource_id,
            ai_workload_type, autonomy_level, payload,
            sequence_number, prev_hash, record_hash, recorded_at)
         VALUES
           ($1, $2, 'system', 'sys_tamper_test',
            $3, 'consent_granted', 'C',
            'standard', 'consent_record', $4,
            NULL, NULL, '{}'::jsonb,
            1, decode($5, 'hex'), decode($6, 'hex'), NOW())`,
        [auditId, TENANT_US, patient, `cnst_tamper_${patient}`, genesis, fakeRecordHash],
      );
    });

    // Walker must detect the record_hash mismatch.
    await expect(
      withTenantContext(TENANT_US, () => assertAuditChainIntact(TENANT_US)),
    ).rejects.toThrow(
      new RegExp(
        `I-003 VIOLATION: record_hash mismatch at audit_id=${auditId}.*partition=${partitionKey}.*seq=1`,
        's',
      ),
    );
  });
});

// ---------------------------------------------------------------------------
// §5 — Tampering detection: broken chain link (HIGH-1 follower-record)
// ---------------------------------------------------------------------------

describe('assertAuditChainIntact — broken chain link (HIGH-1 closure)', () => {
  it('throws "chain link broken" when a non-first record\'s prev_hash != prior record_hash', async () => {
    const patient = `pat_walk_broken_${randomUUID().slice(0, 8)}`;
    const partitionKey = `${TENANT_US}:${patient}`;

    // First insert a HEALTHY record (trigger enabled). This will be
    // sequence_number=1 with the canonical genesis prev_hash.
    const firstAuditId = randomUUID();
    await withTenantContext(TENANT_US, () =>
      insertAuditRecord({
        audit_id: firstAuditId,
        tenant_id: TENANT_US,
        target_patient_id: patient,
        action: 'consent_granted',
        category: 'C',
        resource_id: `cnst_first_${patient}`,
      }),
    );

    // Now bypass the trigger to inject a SECOND record with a deliberately
    // wrong prev_hash. The walker must catch the broken link.
    const secondAuditId = randomUUID();
    const wrongPrevHash = 'deadbeefcafebabe1111222233334444aaaabbbbccccdddd5555666677778888'; // not the first's record_hash

    // Compute the canonical record_hash for the tampered row so the
    // PER-RECORD hash check passes — that isolates the failure to the
    // chain-link check, not the record-hash check.
    const client = getTestClient();
    await withInsertTriggerDisabled(async () => {
      // First, look up what the canonical hash function would produce
      // given our chosen column values + the wrongPrevHash. Then store
      // exactly that as the row's record_hash so the per-record HIGH-2
      // check passes.
      const recordedAt = new Date().toISOString();
      const canonical = await client.query<{ canonical_hex: string }>(
        `SELECT encode(
            audit_records_canonical_hash(
              $1::uuid, $2, 'C', 'standard', 'consent_granted',
              'system', 'sys_broken_test', NULL, NULL,
              $3, NULL, 'consent_record', $4, 'US', NULL,
              '{}'::jsonb, decode($5, 'hex'), 2::bigint, $6::timestamptz
            ),
            'hex'
         ) AS canonical_hex`,
        [secondAuditId, TENANT_US, patient, `cnst_broken_${patient}`, wrongPrevHash, recordedAt],
      );
      const canonicalHash = canonical.rows[0]!.canonical_hex;

      await client.query(
        `INSERT INTO audit_records
           (audit_id, tenant_id, actor_type, actor_id,
            target_patient_id, action, category,
            audit_sensitivity_level, resource_type, resource_id,
            ai_workload_type, autonomy_level, payload,
            sequence_number, prev_hash, record_hash, recorded_at)
         VALUES
           ($1, $2, 'system', 'sys_broken_test',
            $3, 'consent_granted', 'C',
            'standard', 'consent_record', $4,
            NULL, NULL, '{}'::jsonb,
            2, decode($5, 'hex'), decode($6, 'hex'), $7::timestamptz)`,
        [
          secondAuditId,
          TENANT_US,
          patient,
          `cnst_broken_${patient}`,
          wrongPrevHash,
          canonicalHash,
          recordedAt,
        ],
      );
    });

    await expect(
      withTenantContext(TENANT_US, () => assertAuditChainIntact(TENANT_US)),
    ).rejects.toThrow(
      new RegExp(
        `I-003 VIOLATION: audit chain link broken at audit_id=${secondAuditId}.*partition=${partitionKey}.*seq=2`,
        's',
      ),
    );
  });
});

// ---------------------------------------------------------------------------
// §6 — Tampering detection: forged genesis (HIGH-1 first-record case)
// ---------------------------------------------------------------------------

describe('assertAuditChainIntact — forged genesis (HIGH-1 closure)', () => {
  it('throws with "expected genesis seed" hint when a first-record\'s prev_hash is not the canonical genesis', async () => {
    // Inject a single record (sequence_number=1) but with prev_hash
    // pointing at some forged value instead of the canonical
    // SHA-256('GENESIS:' || partition_key). The walker's chain-link
    // check expects the genesis seed for the first record in any
    // partition; a non-genesis prev_hash on a first record is exactly
    // the cross-tenant-link injection HIGH-1 was designed to catch.
    const patient = `pat_walk_genesis_${randomUUID().slice(0, 8)}`;
    const partitionKey = `${TENANT_US}:${patient}`;
    const auditId = randomUUID();
    // Forged genesis: pointing at some other value (e.g., another
    // partition's record_hash equivalent). 64-char hex but not the
    // canonical seed.
    const forgedGenesis = 'feedfacedeadbeef0000111122223333aaaabbbbccccdddd5555666677778888';

    const client = getTestClient();
    await withInsertTriggerDisabled(async () => {
      const recordedAt = new Date().toISOString();
      // Compute canonical record_hash given the forged prev_hash so the
      // per-record HIGH-2 check passes — isolates failure to the
      // genesis-seed check.
      const canonical = await client.query<{ canonical_hex: string }>(
        `SELECT encode(
            audit_records_canonical_hash(
              $1::uuid, $2, 'C', 'standard', 'consent_granted',
              'system', 'sys_forged_genesis', NULL, NULL,
              $3, NULL, 'consent_record', $4, 'US', NULL,
              '{}'::jsonb, decode($5, 'hex'), 1::bigint, $6::timestamptz
            ),
            'hex'
         ) AS canonical_hex`,
        [auditId, TENANT_US, patient, `cnst_forged_${patient}`, forgedGenesis, recordedAt],
      );
      const canonicalHash = canonical.rows[0]!.canonical_hex;

      await client.query(
        `INSERT INTO audit_records
           (audit_id, tenant_id, actor_type, actor_id,
            target_patient_id, action, category,
            audit_sensitivity_level, resource_type, resource_id,
            ai_workload_type, autonomy_level, payload,
            sequence_number, prev_hash, record_hash, recorded_at)
         VALUES
           ($1, $2, 'system', 'sys_forged_genesis',
            $3, 'consent_granted', 'C',
            'standard', 'consent_record', $4,
            NULL, NULL, '{}'::jsonb,
            1, decode($5, 'hex'), decode($6, 'hex'), $7::timestamptz)`,
        [
          auditId,
          TENANT_US,
          patient,
          `cnst_forged_${patient}`,
          forgedGenesis,
          canonicalHash,
          recordedAt,
        ],
      );
    });

    await expect(
      withTenantContext(TENANT_US, () => assertAuditChainIntact(TENANT_US)),
    ).rejects.toThrow(
      new RegExp(
        `I-003 VIOLATION: audit chain link broken at audit_id=${auditId}.*partition=${partitionKey}.*seq=1.*expected genesis seed`,
        's',
      ),
    );
  });
});
