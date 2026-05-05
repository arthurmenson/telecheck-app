/**
 * consent-service.ts — Consent lifecycle orchestration with audit
 * emission. Same-tx audit per I-003.
 *
 * Per Consent Slice PRD v1.0 §7.1 the consent table is APPEND-ONLY:
 *   - Granting consent INSERTs a 'granted' row
 *   - Revoking consent INSERTs a 'revoked' row that supersedes the
 *     prior 'granted' row by created_at
 *   - The most-recent row is the canonical state
 *   - Older rows remain for audit linkage
 *
 * Spec references:
 *   - Consent Slice PRD v1.0 §5-§9
 *   - I-003 (audit append-only)
 *   - I-022 (consent UI clarity — schema + service is presence-tracker)
 *   - I-023 / I-027
 */

import type { DbClient, DbTransaction } from '../../../../lib/db.js';
import type { TenantContext } from '../../../../lib/tenant-context.js';
import { ulid } from '../../../../lib/ulid.js';
import type { AccountId } from '../../../identity/internal/types.js';
import { emitConsentGrantedAudit, emitConsentRevokedAudit } from '../../audit.js';
import * as consentRepo from '../repositories/consent-repo.js';
import {
  asConsentId,
  type Consent,
  type ConsentEvidence,
  type ConsentRevocationReason,
  type ConsentType,
  type ConsentVersionId,
} from '../types.js';

// ---------------------------------------------------------------------------
// GrantConsentInput
// ---------------------------------------------------------------------------

export interface GrantConsentInput {
  account_id: AccountId;
  consent_type: ConsentType;
  scope_id?: string | null;
  consent_version_id: ConsentVersionId;
  evidence: ConsentEvidence;
  expires_at?: string | null;
}

/**
 * Grant a consent. INSERTs a fresh 'granted' row + emits
 * consent_granted audit in the same transaction.
 *
 * The caller is responsible for choosing the correct consent_version_id
 * — typically by calling findActiveConsentVersion first.
 */
export async function grantConsent(
  ctx: TenantContext,
  actor: { actorId: string },
  input: GrantConsentInput,
  externalTx?: DbTransaction,
): Promise<Consent> {
  const consentId = asConsentId(ulid());
  const repoInput: consentRepo.CreateConsentInput = {
    consent_id: consentId,
    tenant_id: ctx.tenantId,
    account_id: input.account_id,
    consent_type: input.consent_type,
    consent_version_id: input.consent_version_id,
    status: 'granted',
    evidence: input.evidence,
  };
  if (input.scope_id !== undefined) repoInput.scope_id = input.scope_id;
  if (input.expires_at !== undefined) repoInput.expires_at = input.expires_at;

  return consentRepo.createConsent(
    repoInput,
    async (tx, consent) => {
      await emitConsentGrantedAudit(
        {
          tenantId: ctx.tenantId,
          accountId: consent.account_id,
          consentId: consent.consent_id,
          actorId: actor.actorId,
          countryOfCare: ctx.countryOfCare,
          consentType: consent.consent_type,
          scopeId: consent.scope_id,
          consentVersionId: consent.consent_version_id,
        },
        tx,
      );
    },
    externalTx,
  );
}

// ---------------------------------------------------------------------------
// RevokeConsentInput
// ---------------------------------------------------------------------------

export interface RevokeConsentInput {
  account_id: AccountId;
  consent_type: ConsentType;
  scope_id?: string | null;
  reason: ConsentRevocationReason;
  /**
   * Reference to the consent_version active at revocation time. The
   * service-layer caller resolves this via findActiveConsentVersion.
   */
  consent_version_id: ConsentVersionId;
  evidence: ConsentEvidence;
}

/**
 * Revoke an active consent by INSERTing a fresh 'revoked' row that
 * supersedes the prior 'granted' row by created_at. Emits
 * consent_revoked audit in the same transaction.
 *
 * Idempotency: if no active 'granted' row exists for the (account,
 * consent_type, scope_id) tuple, returns null without inserting (the
 * revocation is a no-op when there's nothing to revoke).
 *
 * The latest-row check is informational only — the service layer
 * issues the revoke INSERT regardless of the prior state, since the
 * append-only history preserves the full sequence.
 */
export async function revokeConsent(
  ctx: TenantContext,
  actor: { actorId: string },
  input: RevokeConsentInput,
  externalTx?: DbTransaction,
): Promise<Consent | null> {
  // Check if there's an active grant to revoke
  const latest = await consentRepo.findLatestConsent(
    ctx.tenantId,
    input.account_id,
    input.consent_type,
    input.scope_id ?? null,
    externalTx,
  );
  if (latest === null || latest.status !== 'granted') {
    // Nothing to revoke (no prior consent OR already revoked)
    return null;
  }

  const consentId = asConsentId(ulid());
  const repoInput: consentRepo.CreateConsentInput = {
    consent_id: consentId,
    tenant_id: ctx.tenantId,
    account_id: input.account_id,
    consent_type: input.consent_type,
    consent_version_id: input.consent_version_id,
    status: 'revoked',
    evidence: input.evidence,
    revocation_reason: input.reason,
  };
  if (input.scope_id !== undefined) repoInput.scope_id = input.scope_id;

  return consentRepo.createConsent(
    repoInput,
    async (tx, consent) => {
      await emitConsentRevokedAudit(
        {
          tenantId: ctx.tenantId,
          accountId: consent.account_id,
          consentId: consent.consent_id,
          actorId: actor.actorId,
          countryOfCare: ctx.countryOfCare,
          consentType: consent.consent_type,
          scopeId: consent.scope_id,
          revocationReason: input.reason,
        },
        tx,
      );
    },
    externalTx,
  );
}

// ---------------------------------------------------------------------------
// hasActiveConsent — runtime check per Slice PRD §7.2
// ---------------------------------------------------------------------------

/**
 * Synchronous (one DB round-trip) consent check used by downstream
 * workflows per Slice PRD §7.2:
 *   - Refill workflow checking care consent
 *   - AI Clinical Assistant checking data_use(ai_interpretation)
 *   - Pharmacy workflow checking data_use(pharmacy_sharing)
 *   - Etc.
 *
 * Returns true when ALL of:
 *   1. A consent row exists for (tenant, account, consent_type, scope)
 *   2. Latest row by created_at has status='granted'
 *   3. Latest row's expires_at is null OR > now
 *
 * Otherwise false (caller blocks the action and prompts for consent).
 */
export async function hasActiveConsent(
  ctx: TenantContext,
  accountId: AccountId,
  consentType: ConsentType,
  scopeId: string | null,
  externalTx?: DbClient,
): Promise<boolean> {
  const latest = await consentRepo.findLatestConsent(
    ctx.tenantId,
    accountId,
    consentType,
    scopeId,
    externalTx,
  );
  if (latest === null) return false;
  if (latest.status !== 'granted') return false;
  if (latest.expires_at !== null && new Date(latest.expires_at) <= new Date()) {
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Read paths — pure delegates
// ---------------------------------------------------------------------------

export async function findLatestConsent(
  ctx: TenantContext,
  accountId: AccountId,
  consentType: ConsentType,
  scopeId: string | null,
  externalTx?: DbClient,
): Promise<Consent | null> {
  return consentRepo.findLatestConsent(ctx.tenantId, accountId, consentType, scopeId, externalTx);
}

export async function listConsentHistory(
  ctx: TenantContext,
  accountId: AccountId,
  externalTx?: DbClient,
): Promise<Consent[]> {
  return consentRepo.listConsentHistory(ctx.tenantId, accountId, externalTx);
}
