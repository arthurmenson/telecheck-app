/**
 * pin-credentials-repo.ts — DB access for the `account_pin_credentials`
 * table (migration 078): the persistent 6-digit PIN credential (one row per
 * account). Pure DB access; the pin-service owns hashing + lockout policy.
 *
 * Spec references: migration 078; docs/SI-EMAIL-PIN-AUTH.md; I-023 / I-025.
 */

import type { DbClient } from '../../../../lib/db.js';
import { withTenantBoundConnection } from '../../../../lib/db.js';
import type { TenantId } from '../../../../lib/glossary.js';

export interface PinCredential {
  account_id: string;
  tenant_id: string;
  pin_hash: string;
  pin_salt: string;
  algorithm: string;
  failed_attempts: number;
  locked_until: string | null;
  set_at: string;
  updated_at: string;
}

interface PinCredRow {
  account_id: string;
  tenant_id: string;
  pin_hash: string;
  pin_salt: string;
  algorithm: string;
  failed_attempts: number;
  locked_until: Date | string | null;
  set_at: Date | string;
  updated_at: Date | string;
}

function tsToIso(v: Date | string): string {
  return typeof v === 'string' ? v : v.toISOString();
}

function rowToCred(row: PinCredRow): PinCredential {
  return {
    account_id: row.account_id,
    tenant_id: row.tenant_id,
    pin_hash: row.pin_hash,
    pin_salt: row.pin_salt,
    algorithm: row.algorithm,
    failed_attempts: row.failed_attempts,
    locked_until: row.locked_until === null ? null : tsToIso(row.locked_until),
    set_at: tsToIso(row.set_at),
    updated_at: tsToIso(row.updated_at),
  };
}

const CRED_COLUMNS = `
  account_id, tenant_id, pin_hash, pin_salt, algorithm,
  failed_attempts, locked_until, set_at, updated_at
`;

export interface UpsertPinCredentialInput {
  account_id: string;
  tenant_id: TenantId;
  pin_hash: string;
  pin_salt: string;
  algorithm: string;
}

/**
 * Insert or replace the PIN credential for an account (signup sets it;
 * recovery replaces it). On replace, failed_attempts + locked_until reset to
 * a clean state — a successful reset clears any prior lockout.
 */
export async function upsertPinCredential(
  input: UpsertPinCredentialInput,
  externalTx?: DbClient,
): Promise<PinCredential> {
  const runFn = async (client: DbClient): Promise<PinCredential> => {
    const result = await client.query<PinCredRow>(
      `INSERT INTO account_pin_credentials (
          account_id, tenant_id, pin_hash, pin_salt, algorithm,
          failed_attempts, locked_until, set_at, updated_at
       ) VALUES (
          $1, $2, $3, $4, $5, 0, NULL, NOW(), NOW()
       )
       ON CONFLICT (account_id) DO UPDATE
          SET pin_hash = EXCLUDED.pin_hash,
              pin_salt = EXCLUDED.pin_salt,
              algorithm = EXCLUDED.algorithm,
              failed_attempts = 0,
              locked_until = NULL,
              set_at = NOW()
       RETURNING ${CRED_COLUMNS}`,
      [input.account_id, input.tenant_id, input.pin_hash, input.pin_salt, input.algorithm],
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw new Error('upsertPinCredential: upsert returned no rows (unreachable)');
    }
    return rowToCred(row);
  };
  if (externalTx !== undefined) return runFn(externalTx);
  return withTenantBoundConnection(input.tenant_id, runFn);
}

export async function findByAccountId(
  tenantId: TenantId,
  accountId: string,
  externalTx?: DbClient,
): Promise<PinCredential | null> {
  const runner = externalTx
    ? (fn: (c: DbClient) => Promise<PinCredential | null>) => fn(externalTx)
    : (fn: (c: DbClient) => Promise<PinCredential | null>) =>
        withTenantBoundConnection(tenantId, fn);
  return runner(async (client) => {
    const result = await client.query<PinCredRow>(
      `SELECT ${CRED_COLUMNS}
         FROM account_pin_credentials
        WHERE tenant_id = $1 AND account_id = $2`,
      [tenantId, accountId],
    );
    const row = result.rows[0];
    return row === undefined ? null : rowToCred(row);
  });
}

/** Reset failed_attempts + clear lockout after a SUCCESSFUL login. */
export async function recordSuccess(
  tenantId: TenantId,
  accountId: string,
  externalTx?: DbClient,
): Promise<void> {
  const runner = externalTx
    ? (fn: (c: DbClient) => Promise<void>) => fn(externalTx)
    : (fn: (c: DbClient) => Promise<void>) => withTenantBoundConnection(tenantId, fn);
  await runner(async (client) => {
    await client.query(
      `UPDATE account_pin_credentials
          SET failed_attempts = 0, locked_until = NULL
        WHERE tenant_id = $1 AND account_id = $2`,
      [tenantId, accountId],
    );
  });
}

/**
 * Atomically record a FAILED PIN attempt (Codex review 2026-07-09 HIGH:
 * the previous read-in-app / write-absolute-count path let N concurrent
 * wrong-PIN requests all read the same failed_attempts and write the same
 * next value — undercounting the lockout under parallel brute force).
 *
 * The increment + lockout derivation happen in ONE UPDATE that reads
 * failed_attempts from the current row value, so Postgres row-locking
 * serializes concurrent failures on the same credential — every wrong PIN
 * counts. When the incremented count reaches maxAttempts, the cooldown is
 * set and the counter resets to 0 (the cooldown IS the penalty; a fresh
 * window starts after it elapses). Returns the post-update state.
 */
export async function recordFailureAtomic(
  tenantId: TenantId,
  accountId: string,
  maxAttempts: number,
  lockoutMinutes: number,
  externalTx?: DbClient,
): Promise<{ failedAttempts: number; lockedUntil: string | null }> {
  const runner = externalTx
    ? (fn: (c: DbClient) => Promise<{ failedAttempts: number; lockedUntil: string | null }>) =>
        fn(externalTx)
    : (fn: (c: DbClient) => Promise<{ failedAttempts: number; lockedUntil: string | null }>) =>
        withTenantBoundConnection(tenantId, fn);
  return runner(async (client) => {
    const result = await client.query<{
      failed_attempts: number;
      locked_until: Date | string | null;
    }>(
      `UPDATE account_pin_credentials
          SET failed_attempts = CASE
                  WHEN failed_attempts + 1 >= $3 THEN 0
                  ELSE failed_attempts + 1
              END,
              locked_until = CASE
                  WHEN failed_attempts + 1 >= $3
                      THEN NOW() + ($4 || ' minutes')::interval
                  ELSE locked_until
              END
        WHERE tenant_id = $1 AND account_id = $2
       RETURNING failed_attempts, locked_until`,
      [tenantId, accountId, maxAttempts, lockoutMinutes],
    );
    const row = result.rows[0];
    if (row === undefined) {
      // Credential vanished mid-flight (deleted account); treat as locked-out
      // fail-closed rather than silently succeeding.
      return { failedAttempts: 0, lockedUntil: new Date(Date.now() + 60_000).toISOString() };
    }
    return {
      failedAttempts: row.failed_attempts,
      lockedUntil: row.locked_until === null ? null : tsToIso(row.locked_until),
    };
  });
}
