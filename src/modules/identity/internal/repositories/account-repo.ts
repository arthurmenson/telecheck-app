/**
 * account-repo.ts — DB access for the `accounts` table (migration 012).
 *
 * Repository pattern (mirror of forms-intake/internal/repositories/*.ts):
 *   - Pure DB access; no domain logic, no audit emission, no event emission
 *   - Returns null on tenant-blind miss (RLS-filtered)
 *   - All SELECTs filter by tenant_id explicitly even though RLS would
 *     enforce it — defense in depth (per the audit-records HIGH-4 closure
 *     pattern from src/lib/audit.ts)
 *   - INSERT helpers expose only the fields service-layer callers can
 *     legitimately set; lifecycle timestamps + status defaults handled by
 *     the schema
 *
 * Spec references:
 *   - migrations/012_accounts.sql
 *   - CDM v1.2 §3.2 entity 7 "Account"
 *   - I-023 (RLS layer-1 + app-layer tenant filter = layer 2)
 *   - I-025 (tenant-blind null on miss)
 */

import type { DbClient, DbTransaction } from '../../../../lib/db.js';
import { withTenantBoundConnection } from '../../../../lib/db.js';
import type { TenantId } from '../../../../lib/glossary.js';
import type { Account, AccountId, AccountStatus, AccountType, AccountGender } from '../types.js';

// ---------------------------------------------------------------------------
// Row mapping — DB row → domain Account
// ---------------------------------------------------------------------------

interface AccountRow {
  account_id: string;
  tenant_id: string;
  phone_e164: string | null;
  email: string | null;
  first_name: string;
  last_name: string;
  date_of_birth: Date | string;
  gender: string;
  national_id: string | null;
  country_of_residence: string;
  country_of_care: string;
  locale: string;
  account_type: string;
  status: string;
  created_at: Date | string;
  updated_at: Date | string;
  activated_at: Date | string | null;
  suspended_at: Date | string | null;
  archived_at: Date | string | null;
  deleted_at: Date | string | null;
}

function rowToAccount(row: AccountRow): Account {
  return {
    account_id: row.account_id as AccountId,
    tenant_id: row.tenant_id as TenantId,
    phone_e164: row.phone_e164,
    email: row.email,
    first_name: row.first_name,
    last_name: row.last_name,
    date_of_birth:
      typeof row.date_of_birth === 'string'
        ? row.date_of_birth
        : row.date_of_birth.toISOString().slice(0, 10),
    gender: row.gender as AccountGender,
    national_id: row.national_id,
    country_of_residence: row.country_of_residence,
    country_of_care: row.country_of_care as 'US' | 'GH',
    locale: row.locale,
    account_type: row.account_type as AccountType,
    status: row.status as AccountStatus,
    created_at: typeof row.created_at === 'string' ? row.created_at : row.created_at.toISOString(),
    updated_at: typeof row.updated_at === 'string' ? row.updated_at : row.updated_at.toISOString(),
    activated_at: tsToIso(row.activated_at),
    suspended_at: tsToIso(row.suspended_at),
    archived_at: tsToIso(row.archived_at),
    deleted_at: tsToIso(row.deleted_at),
  };
}

function tsToIso(v: Date | string | null): string | null {
  if (v === null) return null;
  return typeof v === 'string' ? v : v.toISOString();
}

// ---------------------------------------------------------------------------
// CreateAccountInput — fields the service layer can set at creation
// ---------------------------------------------------------------------------

export interface CreateAccountInput {
  account_id: AccountId;
  tenant_id: TenantId;
  // Optional since migration 078 (email-only accounts). Omit for email+PIN.
  phone_e164?: string | null;
  email?: string | null;
  first_name: string;
  last_name: string;
  date_of_birth: string; // YYYY-MM-DD
  gender: AccountGender;
  national_id?: string | null;
  country_of_residence: string;
  country_of_care: 'US' | 'GH';
  locale?: string;
  account_type?: AccountType;
}

const ACCOUNT_COLUMNS = `
  account_id, tenant_id, phone_e164, email,
  first_name, last_name, date_of_birth, gender, national_id,
  country_of_residence, country_of_care, locale,
  account_type, status,
  created_at, updated_at,
  activated_at, suspended_at, archived_at, deleted_at
`;

// ---------------------------------------------------------------------------
// findAccountById — lookup by PK (tenant-scoped via RLS + explicit filter)
// ---------------------------------------------------------------------------

/**
 * Resolve an account by ID under the caller's tenant. Returns null on miss
 * or cross-tenant (RLS-filtered). Caller maps null to a tenant-blind 404
 * envelope per I-025.
 *
 * The explicit `tenant_id = $1` predicate in addition to RLS is defense in
 * depth (mirror of audit-records HIGH-4 closure: in transactions that can
 * see rows from multiple tenants — break-glass; platform-admin work — RLS
 * alone is insufficient).
 */
export async function findAccountById(
  tenantId: TenantId,
  accountId: AccountId,
  externalTx?: DbClient,
): Promise<Account | null> {
  const runner = externalTx
    ? (fn: (client: DbClient) => Promise<Account | null>) => fn(externalTx)
    : (fn: (client: DbClient) => Promise<Account | null>) =>
        withTenantBoundConnection(tenantId, fn);
  return runner(async (client) => {
    const result = await client.query<AccountRow>(
      `SELECT ${ACCOUNT_COLUMNS}
         FROM accounts
        WHERE tenant_id = $1
          AND account_id = $2
          AND deleted_at IS NULL`,
      [tenantId, accountId],
    );
    if (result.rows.length === 0) return null;
    const row = result.rows[0];
    if (row === undefined) return null;
    return rowToAccount(row);
  });
}

// ---------------------------------------------------------------------------
// findAccountByPhoneE164 — lookup by tenant-scoped phone (login + uniqueness)
// ---------------------------------------------------------------------------

/**
 * Resolve an account by tenant-scoped phone number. Used by:
 *   - Login: phone → account → issue OTP
 *   - Registration: phone collision check before INSERT
 *
 * Per CDM §5.1 phone uniqueness is tenant-scoped — same phone in two
 * tenants is two distinct accounts; this lookup honors that boundary.
 */
export async function findAccountByPhoneE164(
  tenantId: TenantId,
  phoneE164: string,
  externalTx?: DbClient,
): Promise<Account | null> {
  const runner = externalTx
    ? (fn: (client: DbClient) => Promise<Account | null>) => fn(externalTx)
    : (fn: (client: DbClient) => Promise<Account | null>) =>
        withTenantBoundConnection(tenantId, fn);
  return runner(async (client) => {
    const result = await client.query<AccountRow>(
      `SELECT ${ACCOUNT_COLUMNS}
         FROM accounts
        WHERE tenant_id = $1
          AND phone_e164 = $2
          AND deleted_at IS NULL`,
      [tenantId, phoneE164],
    );
    if (result.rows.length === 0) return null;
    const row = result.rows[0];
    if (row === undefined) return null;
    return rowToAccount(row);
  });
}

// ---------------------------------------------------------------------------
// createAccount — INSERT a fresh account row (lifecycle = pending_verification)
// ---------------------------------------------------------------------------

/**
 * INSERT a new account row. Status defaults to `pending_verification` per
 * the schema; the service layer calls `activateAccount()` after successful
 * OTP verification to flip status → 'active' + set activated_at.
 *
 * `account_type` defaults to 'patient' per the schema.
 *
 * Returns the persisted Account row (round-tripped via INSERT...RETURNING)
 * so the service layer sees the schema-applied defaults (status,
 * timestamps, etc.) without a follow-up SELECT.
 *
 * Throws on:
 *   - Phone uniqueness violation (uq_account_tenant_phone) — service-layer
 *     code translates the canonical SQLSTATE 23505 to the slice's
 *     PHONE_TAKEN sentinel.
 *   - Format CHECK violations (E.164, email, country regex) — service-
 *     layer validation should catch these before the INSERT, but the DB
 *     layer is the floor.
 */
export async function createAccount(
  input: CreateAccountInput,
  txCallback: (tx: DbTransaction, account: Account) => Promise<void>,
  externalTx?: DbTransaction,
): Promise<Account> {
  const runFn = async (tx: DbClient): Promise<Account> => {
    const result = await tx.query<AccountRow>(
      `INSERT INTO accounts (
          account_id, tenant_id, phone_e164, email,
          first_name, last_name, date_of_birth, gender, national_id,
          country_of_residence, country_of_care, locale, account_type
       ) VALUES (
          $1, $2, $3, $4,
          $5, $6, $7::date, $8, $9,
          $10, $11, $12, $13
       )
       RETURNING ${ACCOUNT_COLUMNS}`,
      [
        input.account_id,
        input.tenant_id,
        input.phone_e164 ?? null,
        input.email ?? null,
        input.first_name,
        input.last_name,
        input.date_of_birth,
        input.gender,
        input.national_id ?? null,
        input.country_of_residence,
        input.country_of_care,
        input.locale ?? `en-${input.country_of_care}`,
        input.account_type ?? 'patient',
      ],
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw new Error('createAccount: INSERT returned no rows (unreachable)');
    }
    const account = rowToAccount(row);
    // The txCallback hook lets the service layer emit audit + domain
    // events INSIDE the same transaction (mirror of forms-intake's
    // createSubmission pattern).
    await txCallback(tx, account);
    return account;
  };

  if (externalTx !== undefined) {
    return runFn(externalTx);
  }
  return withTenantBoundConnection(input.tenant_id, runFn);
}

// ---------------------------------------------------------------------------
// activateAccount — flip status pending_verification → active
// ---------------------------------------------------------------------------

/**
 * Transition an account from `pending_verification` to `active`. Called
 * after successful OTP verification at end of registration flow.
 *
 * Idempotent: re-calling on an already-active row is a no-op (the
 * `WHERE status = 'pending_verification'` predicate filters out
 * already-activated rows, leaving them unchanged).
 *
 * Returns the updated Account, or null if the account doesn't exist OR
 * is in a non-`pending_verification` state (rejected by the WHERE clause).
 */
export async function activateAccount(
  tenantId: TenantId,
  accountId: AccountId,
  externalTx?: DbClient,
): Promise<Account | null> {
  const runner = externalTx
    ? (fn: (client: DbClient) => Promise<Account | null>) => fn(externalTx)
    : (fn: (client: DbClient) => Promise<Account | null>) =>
        withTenantBoundConnection(tenantId, fn);
  return runner(async (client) => {
    const result = await client.query<AccountRow>(
      `UPDATE accounts
          SET status = 'active',
              activated_at = NOW()
        WHERE tenant_id = $1
          AND account_id = $2
          AND status = 'pending_verification'
          AND deleted_at IS NULL
       RETURNING ${ACCOUNT_COLUMNS}`,
      [tenantId, accountId],
    );
    if (result.rows.length === 0) return null;
    const row = result.rows[0];
    if (row === undefined) return null;
    return rowToAccount(row);
  });
}
