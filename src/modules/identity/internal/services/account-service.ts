/**
 * account-service.ts — Account lifecycle orchestration with audit emission.
 *
 * Wraps account-repo.ts with same-transaction audit + domain-event emission
 * (mirror of forms-intake/internal/services/submission-service.ts pattern).
 *
 * Spec references:
 *   - Identity & Authentication Spec v1.0 §2 (registration flow)
 *   - CDM v1.2 §3.2 entity 7 "Account"
 *   - Master PRD v1.10 §17 + Glossary v5.2 C3 (consumer DBA at render
 *     time; never store DBA snapshot on account row)
 *   - I-003 (audit append-only; bare suppression forbidden;
 *     emit audit INSIDE the same transaction as the row INSERT)
 *   - I-023 (RLS layer-1 + app-layer tenant filter = layer 2)
 *   - I-027 (every audit record carries tenant_id)
 */

import type { DbClient, DbTransaction } from '../../../../lib/db.js';
import type { TenantContext } from '../../../../lib/tenant-context.js';
import { emitAccountActivatedAudit, emitAccountCreatedAudit } from '../../audit.js';
import * as accountRepo from '../repositories/account-repo.js';
import type { Account, AccountId, AccountGender, AccountType } from '../types.js';

// ---------------------------------------------------------------------------
// Patient-safe account view (mirror of submission-service.toPatientView).
// Strips `tenant_id` so handlers serving patient surfaces never render the
// operating-tenant identifier (Master PRD v1.10 §17 + Glossary v5.2 C3).
// ---------------------------------------------------------------------------

export type PatientAccountView = Omit<Account, 'tenant_id'>;

/**
 * Project a full Account to the patient-safe view. Drops `tenant_id`
 * by destructuring; never copy the field by mistake.
 */
export function toPatientAccountView(account: Account): PatientAccountView {
  const { tenant_id: _stripped, ...patientView } = account;
  void _stripped;
  return patientView;
}

// ---------------------------------------------------------------------------
// CreateAccountInput — surface that the handler / registration flow passes in.
// Mirrors the repo input but omits tenant_id (resolved from ctx).
// ---------------------------------------------------------------------------

export interface CreateAccountServiceInput {
  account_id: AccountId;
  phone_e164: string;
  email?: string | null;
  first_name: string;
  last_name: string;
  date_of_birth: string; // YYYY-MM-DD
  gender: AccountGender;
  national_id?: string | null;
  /** Defaults to ctx.countryOfCare when not supplied. */
  country_of_residence?: string;
  locale?: string;
  account_type?: AccountType;
}

// ---------------------------------------------------------------------------
// createAccount — orchestrates INSERT + audit emission
// ---------------------------------------------------------------------------

/**
 * Create a new account with same-transaction audit emission.
 *
 * Status defaults to `pending_verification` per the schema. Caller flips
 * to `active` via `activateAccount()` after successful OTP verification.
 *
 * Phone-uniqueness violation surfaces as the canonical SQLSTATE 23505
 * `duplicate key` error from the repo — handler maps to PHONE_TAKEN
 * sentinel for the registration surface.
 */
export async function createAccount(
  ctx: TenantContext,
  actor: { actorId: string },
  input: CreateAccountServiceInput,
  externalTx?: DbTransaction,
): Promise<Account> {
  // Build the repo input with only the fields the caller actually
  // supplied. `exactOptionalPropertyTypes: true` rejects passing
  // `undefined` to optional properties typed `string | null`, so we
  // omit unspecified optionals rather than passing them through.
  const repoInput: accountRepo.CreateAccountInput = {
    account_id: input.account_id,
    tenant_id: ctx.tenantId,
    phone_e164: input.phone_e164,
    first_name: input.first_name,
    last_name: input.last_name,
    date_of_birth: input.date_of_birth,
    gender: input.gender,
    country_of_residence: input.country_of_residence ?? ctx.countryOfCare,
    country_of_care: ctx.countryOfCare,
  };
  if (input.email !== undefined) repoInput.email = input.email;
  if (input.national_id !== undefined) repoInput.national_id = input.national_id;
  if (input.locale !== undefined) repoInput.locale = input.locale;
  if (input.account_type !== undefined) repoInput.account_type = input.account_type;

  return accountRepo.createAccount(
    repoInput,
    async (tx, account) => {
      await emitAccountCreatedAudit(
        {
          tenantId: ctx.tenantId,
          accountId: account.account_id,
          actorId: actor.actorId,
          countryOfCare: ctx.countryOfCare,
          phoneE164: account.phone_e164,
          accountType: account.account_type,
        },
        tx,
      );
    },
    externalTx,
  );
}

// ---------------------------------------------------------------------------
// activateAccount — orchestrates status flip + audit emission
// ---------------------------------------------------------------------------

/**
 * Flip an account from `pending_verification` to `active` after successful
 * OTP verify. Emits `identity_account_activated` audit in the same
 * transaction.
 *
 * Idempotent: returns null if the account is already active or doesn't
 * exist in the caller's tenant. Service-layer callers map null to the
 * tenant-blind 404 envelope per I-025.
 *
 * Audit emission ONLY fires on successful flip (i.e., the repo returned a
 * non-null account). Calling `activateAccount` on an already-active row
 * is a no-op AT THE DB LEVEL and a no-op AT THE AUDIT LEVEL — no spurious
 * "activated" audit entries on idempotent re-call.
 */
export async function activateAccount(
  ctx: TenantContext,
  actor: { actorId: string },
  accountId: AccountId,
  externalTx?: DbTransaction,
): Promise<Account | null> {
  // Two-step: first attempt the flip via the repo. If it returns null
  // (idempotent miss), do not emit audit. If it returns the activated
  // row, emit the audit in the SAME transaction.
  //
  // The repo's `activateAccount` accepts a DbClient (not the heavier
  // DbTransaction); when an externalTx is supplied, audit emission must
  // share that transaction. Use a wrapper that captures the activated
  // row from the repo and emits inside the caller's tx.

  if (externalTx === undefined) {
    // No external tx — wrap in a fresh tenant-bound connection. The repo's
    // activateAccount handles the connection; we layer audit emission on
    // top by passing a tx-bound runner. Since the repo's API accepts an
    // external tx, we run BOTH the UPDATE and the audit emission inside
    // a freshly-acquired connection by importing withTenantBoundConnection.
    const { withTenantBoundConnection } = await import('../../../../lib/db.js');
    return withTenantBoundConnection(ctx.tenantId, async (tx) => {
      const activated = await accountRepo.activateAccount(ctx.tenantId, accountId, tx);
      if (activated === null) return null;
      await emitAccountActivatedAudit(
        {
          tenantId: ctx.tenantId,
          accountId: activated.account_id,
          actorId: actor.actorId,
          countryOfCare: ctx.countryOfCare,
        },
        tx,
      );
      return activated;
    });
  }

  // External tx provided — emit audit on the caller's tx.
  const activated = await accountRepo.activateAccount(ctx.tenantId, accountId, externalTx);
  if (activated === null) return null;
  await emitAccountActivatedAudit(
    {
      tenantId: ctx.tenantId,
      accountId: activated.account_id,
      actorId: actor.actorId,
      countryOfCare: ctx.countryOfCare,
    },
    externalTx,
  );
  return activated;
}

// ---------------------------------------------------------------------------
// Read paths — pure delegates to the repo (no audit on reads)
// ---------------------------------------------------------------------------

export async function findAccountById(
  ctx: TenantContext,
  accountId: AccountId,
  externalTx?: DbClient,
): Promise<Account | null> {
  return accountRepo.findAccountById(ctx.tenantId, accountId, externalTx);
}

export async function findAccountByPhoneE164(
  ctx: TenantContext,
  phoneE164: string,
  externalTx?: DbClient,
): Promise<Account | null> {
  return accountRepo.findAccountByPhoneE164(ctx.tenantId, phoneE164, externalTx);
}
