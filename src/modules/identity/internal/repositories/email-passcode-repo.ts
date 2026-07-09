/**
 * email-passcode-repo.ts — DB access for the `email_passcodes` table
 * (migration 078). The email analogue of otp-repo.ts (phone otp_challenges).
 *
 * Repository pattern (mirror of otp-repo.ts): pure DB access, tenant-blind
 * miss → null, explicit tenant_id filter on every statement, service owns
 * rate-limit decisions.
 *
 * Spec references: migration 078; docs/SI-EMAIL-PIN-AUTH.md; I-023 / I-025.
 */

import type { DbClient, DbTransaction } from '../../../../lib/db.js';
import { withTenantBoundConnection } from '../../../../lib/db.js';
import type { TenantId } from '../../../../lib/glossary.js';

export type EmailPasscodePurpose = 'email_registration' | 'pin_recovery';

export interface EmailPasscode {
  passcode_id: string;
  tenant_id: string;
  account_id: string | null;
  email: string;
  purpose: EmailPasscodePurpose;
  code_hash: string;
  attempts_remaining: number;
  created_at: string;
  expires_at: string;
  consumed_at: string | null;
  locked_until: string | null;
}

interface PasscodeRow {
  passcode_id: string;
  tenant_id: string;
  account_id: string | null;
  email: string;
  purpose: string;
  code_hash: string;
  attempts_remaining: number;
  created_at: Date | string;
  expires_at: Date | string;
  consumed_at: Date | string | null;
  locked_until: Date | string | null;
}

function tsToIso(v: Date | string): string {
  return typeof v === 'string' ? v : v.toISOString();
}
function tsToIsoNullable(v: Date | string | null): string | null {
  return v === null ? null : tsToIso(v);
}

function rowToPasscode(row: PasscodeRow): EmailPasscode {
  return {
    passcode_id: row.passcode_id,
    tenant_id: row.tenant_id,
    account_id: row.account_id,
    email: row.email,
    purpose: row.purpose as EmailPasscodePurpose,
    code_hash: row.code_hash,
    attempts_remaining: row.attempts_remaining,
    created_at: tsToIso(row.created_at),
    expires_at: tsToIso(row.expires_at),
    consumed_at: tsToIsoNullable(row.consumed_at),
    locked_until: tsToIsoNullable(row.locked_until),
  };
}

const PASSCODE_COLUMNS = `
  passcode_id, tenant_id, account_id, email,
  purpose, code_hash, attempts_remaining,
  created_at, expires_at, consumed_at, locked_until
`;

export interface CreatePasscodeInput {
  passcode_id: string;
  tenant_id: TenantId;
  account_id?: string | null;
  email: string;
  purpose: EmailPasscodePurpose;
  code_hash: string;
  expires_at: string; // ISO 8601
}

export async function findLatestActivePasscode(
  tenantId: TenantId,
  email: string,
  purpose: EmailPasscodePurpose,
  externalTx?: DbClient,
): Promise<EmailPasscode | null> {
  const runner = externalTx
    ? (fn: (c: DbClient) => Promise<EmailPasscode | null>) => fn(externalTx)
    : (fn: (c: DbClient) => Promise<EmailPasscode | null>) =>
        withTenantBoundConnection(tenantId, fn);
  return runner(async (client) => {
    const result = await client.query<PasscodeRow>(
      `SELECT ${PASSCODE_COLUMNS}
         FROM email_passcodes
        WHERE tenant_id = $1
          AND email = $2
          AND purpose = $3
          AND consumed_at IS NULL
          AND expires_at > NOW()
        ORDER BY created_at DESC
        LIMIT 1`,
      [tenantId, email, purpose],
    );
    const row = result.rows[0];
    return row === undefined ? null : rowToPasscode(row);
  });
}

export async function findActiveLockout(
  tenantId: TenantId,
  email: string,
  purpose: EmailPasscodePurpose,
  externalTx?: DbClient,
): Promise<EmailPasscode | null> {
  const runner = externalTx
    ? (fn: (c: DbClient) => Promise<EmailPasscode | null>) => fn(externalTx)
    : (fn: (c: DbClient) => Promise<EmailPasscode | null>) =>
        withTenantBoundConnection(tenantId, fn);
  return runner(async (client) => {
    const result = await client.query<PasscodeRow>(
      `SELECT ${PASSCODE_COLUMNS}
         FROM email_passcodes
        WHERE tenant_id = $1
          AND email = $2
          AND purpose = $3
          AND locked_until IS NOT NULL
          AND locked_until > NOW()
        ORDER BY locked_until DESC
        LIMIT 1`,
      [tenantId, email, purpose],
    );
    const row = result.rows[0];
    return row === undefined ? null : rowToPasscode(row);
  });
}

export async function createPasscode(
  input: CreatePasscodeInput,
  txCallback: (tx: DbTransaction, passcode: EmailPasscode) => Promise<void>,
  externalTx?: DbTransaction,
): Promise<EmailPasscode> {
  const runFn = async (tx: DbTransaction): Promise<EmailPasscode> => {
    const result = await tx.query<PasscodeRow>(
      `INSERT INTO email_passcodes (
          passcode_id, tenant_id, account_id, email, purpose,
          code_hash, attempts_remaining, created_at, expires_at
       ) VALUES (
          $1, $2, $3, $4, $5, $6, 3, NOW(), $7::timestamptz
       )
       RETURNING ${PASSCODE_COLUMNS}`,
      [
        input.passcode_id,
        input.tenant_id,
        input.account_id ?? null,
        input.email,
        input.purpose,
        input.code_hash,
        input.expires_at,
      ],
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw new Error('createPasscode: INSERT returned no rows (unreachable)');
    }
    const passcode = rowToPasscode(row);
    await txCallback(tx, passcode);
    return passcode;
  };
  if (externalTx !== undefined) return runFn(externalTx);
  return withTenantBoundConnection(input.tenant_id, (c) => runFn(c as DbTransaction));
}

export async function consumePasscode(
  tenantId: TenantId,
  passcodeId: string,
  externalTx?: DbClient,
): Promise<EmailPasscode | null> {
  const runner = externalTx
    ? (fn: (c: DbClient) => Promise<EmailPasscode | null>) => fn(externalTx)
    : (fn: (c: DbClient) => Promise<EmailPasscode | null>) =>
        withTenantBoundConnection(tenantId, fn);
  return runner(async (client) => {
    const result = await client.query<PasscodeRow>(
      `UPDATE email_passcodes
          SET consumed_at = NOW()
        WHERE tenant_id = $1
          AND passcode_id = $2
          AND consumed_at IS NULL
          AND expires_at > NOW()
       RETURNING ${PASSCODE_COLUMNS}`,
      [tenantId, passcodeId],
    );
    const row = result.rows[0];
    return row === undefined ? null : rowToPasscode(row);
  });
}

export async function decrementAttempts(
  tenantId: TenantId,
  passcodeId: string,
  externalTx?: DbClient,
): Promise<EmailPasscode | null> {
  const runner = externalTx
    ? (fn: (c: DbClient) => Promise<EmailPasscode | null>) => fn(externalTx)
    : (fn: (c: DbClient) => Promise<EmailPasscode | null>) =>
        withTenantBoundConnection(tenantId, fn);
  return runner(async (client) => {
    const result = await client.query<PasscodeRow>(
      `UPDATE email_passcodes
          SET attempts_remaining = attempts_remaining - 1,
              locked_until = CASE
                  WHEN attempts_remaining - 1 <= 0
                      THEN NOW() + INTERVAL '15 minutes'
                  ELSE locked_until
              END
        WHERE tenant_id = $1
          AND passcode_id = $2
          AND consumed_at IS NULL
          AND expires_at > NOW()
          AND attempts_remaining > 0
       RETURNING ${PASSCODE_COLUMNS}`,
      [tenantId, passcodeId],
    );
    const row = result.rows[0];
    return row === undefined ? null : rowToPasscode(row);
  });
}
