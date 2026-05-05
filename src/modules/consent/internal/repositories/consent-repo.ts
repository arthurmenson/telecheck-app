/**
 * consent-repo.ts — DB access for `consent` + `consent_versions` tables
 * (migration 016).
 *
 * Repository pattern (mirror of identity repos):
 *   - Pure DB access; no domain logic
 *   - Returns null on tenant-blind miss
 *   - All SELECTs filter by tenant_id explicitly (defense in depth)
 *   - Append-only: createConsent INSERTs a NEW row; revocation creates
 *     a fresh 'revoked' row that supersedes the prior 'granted' row
 *     (Slice PRD §7.1)
 *
 * Spec references:
 *   - migrations/016_consent.sql
 *   - Consent Slice PRD v1.0 §5-§8
 *   - CDM v1.2 §3.3 entities 11-12
 *   - I-023 / I-025
 */

import type { DbClient, DbTransaction } from '../../../../lib/db.js';
import { withTenantBoundConnection } from '../../../../lib/db.js';
import type { TenantId } from '../../../../lib/glossary.js';
import type { AccountId } from '../../../identity/internal/types.js';
import type {
  Consent,
  ConsentEvidence,
  ConsentId,
  ConsentRevocationReason,
  ConsentStatus,
  ConsentType,
  ConsentVersion,
  ConsentVersionId,
} from '../types.js';

// ---------------------------------------------------------------------------
// Row mapping
// ---------------------------------------------------------------------------

interface ConsentVersionRow {
  consent_version_id: string;
  tenant_id: string;
  consent_type: string;
  version_label: string;
  locale: string;
  terms_text: string;
  regulatory_reference: string | null;
  published_at: Date | string;
  superseded_at: Date | string | null;
  created_at: Date | string;
}

interface ConsentRow {
  consent_id: string;
  tenant_id: string;
  account_id: string;
  consent_type: string;
  scope_id: string | null;
  consent_version_id: string;
  status: string;
  evidence: ConsentEvidence;
  revocation_reason: string | null;
  expires_at: Date | string | null;
  created_at: Date | string;
}

function tsToIso(v: Date | string): string {
  return typeof v === 'string' ? v : v.toISOString();
}
function tsToIsoNullable(v: Date | string | null): string | null {
  if (v === null) return null;
  return tsToIso(v);
}

function rowToVersion(row: ConsentVersionRow): ConsentVersion {
  return {
    consent_version_id: row.consent_version_id as ConsentVersionId,
    tenant_id: row.tenant_id as TenantId,
    consent_type: row.consent_type as ConsentType,
    version_label: row.version_label,
    locale: row.locale,
    terms_text: row.terms_text,
    regulatory_reference: row.regulatory_reference,
    published_at: tsToIso(row.published_at),
    superseded_at: tsToIsoNullable(row.superseded_at),
    created_at: tsToIso(row.created_at),
  };
}

function rowToConsent(row: ConsentRow): Consent {
  return {
    consent_id: row.consent_id as ConsentId,
    tenant_id: row.tenant_id as TenantId,
    account_id: row.account_id as AccountId,
    consent_type: row.consent_type as ConsentType,
    scope_id: row.scope_id,
    consent_version_id: row.consent_version_id as ConsentVersionId,
    status: row.status as ConsentStatus,
    evidence: row.evidence,
    revocation_reason: row.revocation_reason as ConsentRevocationReason | null,
    expires_at: tsToIsoNullable(row.expires_at),
    created_at: tsToIso(row.created_at),
  };
}

const VERSION_COLUMNS = `
  consent_version_id, tenant_id, consent_type, version_label, locale,
  terms_text, regulatory_reference,
  published_at, superseded_at, created_at
`;

const CONSENT_COLUMNS = `
  consent_id, tenant_id, account_id, consent_type, scope_id,
  consent_version_id, status, evidence,
  revocation_reason, expires_at, created_at
`;

// ---------------------------------------------------------------------------
// CreateConsentVersionInput
// ---------------------------------------------------------------------------

export interface CreateConsentVersionInput {
  consent_version_id: ConsentVersionId;
  tenant_id: TenantId;
  consent_type: ConsentType;
  version_label: string;
  locale?: string;
  terms_text: string;
  regulatory_reference?: string | null;
}

export async function createConsentVersion(
  input: CreateConsentVersionInput,
  externalTx?: DbTransaction,
): Promise<ConsentVersion> {
  const runFn = async (tx: DbClient): Promise<ConsentVersion> => {
    const result = await tx.query<ConsentVersionRow>(
      `INSERT INTO consent_versions (
          consent_version_id, tenant_id, consent_type, version_label, locale,
          terms_text, regulatory_reference
       ) VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING ${VERSION_COLUMNS}`,
      [
        input.consent_version_id,
        input.tenant_id,
        input.consent_type,
        input.version_label,
        input.locale ?? 'en-US',
        input.terms_text,
        input.regulatory_reference ?? null,
      ],
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw new Error('createConsentVersion: INSERT returned no rows');
    }
    return rowToVersion(row);
  };
  if (externalTx !== undefined) return runFn(externalTx);
  return withTenantBoundConnection(input.tenant_id, runFn);
}

// ---------------------------------------------------------------------------
// findActiveConsentVersion — most-recent non-superseded version
// ---------------------------------------------------------------------------

export async function findActiveConsentVersion(
  tenantId: TenantId,
  consentType: ConsentType,
  locale: string,
  externalTx?: DbClient,
): Promise<ConsentVersion | null> {
  const runner = externalTx
    ? (fn: (client: DbClient) => Promise<ConsentVersion | null>) => fn(externalTx)
    : (fn: (client: DbClient) => Promise<ConsentVersion | null>) =>
        withTenantBoundConnection(tenantId, fn);
  return runner(async (client) => {
    const result = await client.query<ConsentVersionRow>(
      `SELECT ${VERSION_COLUMNS}
         FROM consent_versions
        WHERE tenant_id = $1
          AND consent_type = $2
          AND locale = $3
          AND superseded_at IS NULL
        ORDER BY published_at DESC
        LIMIT 1`,
      [tenantId, consentType, locale],
    );
    if (result.rows.length === 0) return null;
    const row = result.rows[0];
    if (row === undefined) return null;
    return rowToVersion(row);
  });
}

// ---------------------------------------------------------------------------
// CreateConsentInput
// ---------------------------------------------------------------------------

export interface CreateConsentInput {
  consent_id: ConsentId;
  tenant_id: TenantId;
  account_id: AccountId;
  consent_type: ConsentType;
  scope_id?: string | null;
  consent_version_id: ConsentVersionId;
  status: ConsentStatus;
  evidence: ConsentEvidence;
  revocation_reason?: ConsentRevocationReason | null;
  expires_at?: string | null;
}

export async function createConsent(
  input: CreateConsentInput,
  txCallback: (tx: DbTransaction, consent: Consent) => Promise<void>,
  externalTx?: DbTransaction,
): Promise<Consent> {
  const runFn = async (tx: DbClient): Promise<Consent> => {
    const result = await tx.query<ConsentRow>(
      `INSERT INTO consent (
          consent_id, tenant_id, account_id, consent_type, scope_id,
          consent_version_id, status, evidence,
          revocation_reason, expires_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10)
       RETURNING ${CONSENT_COLUMNS}`,
      [
        input.consent_id,
        input.tenant_id,
        input.account_id,
        input.consent_type,
        input.scope_id ?? null,
        input.consent_version_id,
        input.status,
        JSON.stringify(input.evidence),
        input.revocation_reason ?? null,
        input.expires_at ?? null,
      ],
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw new Error('createConsent: INSERT returned no rows');
    }
    const consent = rowToConsent(row);
    await txCallback(tx, consent);
    return consent;
  };
  if (externalTx !== undefined) return runFn(externalTx);
  return withTenantBoundConnection(input.tenant_id, runFn);
}

// ---------------------------------------------------------------------------
// findLatestConsent — current state for (account, consent_type, scope_id)
// ---------------------------------------------------------------------------

/**
 * Return the most-recent consent row for (tenant, account, consent_type,
 * scope_id). If the latest row is 'granted', the consent is active; if
 * 'revoked', the consent has been withdrawn. Append-only history means
 * older rows remain — they're not the canonical state.
 *
 * Per Slice PRD §7.2 runtime check: callers verify both
 *   1. latest row exists, AND
 *   2. latest row.status === 'granted'
 *   3. (optionally) latest row.expires_at > now
 */
export async function findLatestConsent(
  tenantId: TenantId,
  accountId: AccountId,
  consentType: ConsentType,
  scopeId: string | null,
  externalTx?: DbClient,
): Promise<Consent | null> {
  const runner = externalTx
    ? (fn: (client: DbClient) => Promise<Consent | null>) => fn(externalTx)
    : (fn: (client: DbClient) => Promise<Consent | null>) =>
        withTenantBoundConnection(tenantId, fn);
  return runner(async (client) => {
    const result = await client.query<ConsentRow>(
      `SELECT ${CONSENT_COLUMNS}
         FROM consent
        WHERE tenant_id = $1
          AND account_id = $2
          AND consent_type = $3
          AND ${scopeId === null ? 'scope_id IS NULL' : 'scope_id = $4'}
        ORDER BY created_at DESC
        LIMIT 1`,
      scopeId === null
        ? [tenantId, accountId, consentType]
        : [tenantId, accountId, consentType, scopeId],
    );
    if (result.rows.length === 0) return null;
    const row = result.rows[0];
    if (row === undefined) return null;
    return rowToConsent(row);
  });
}

/**
 * Return the FULL consent history for an account (all rows ordered by
 * created_at). Used by the Settings UI per Slice PRD §9.3.
 */
export async function listConsentHistory(
  tenantId: TenantId,
  accountId: AccountId,
  externalTx?: DbClient,
): Promise<Consent[]> {
  const runner = externalTx
    ? (fn: (client: DbClient) => Promise<Consent[]>) => fn(externalTx)
    : (fn: (client: DbClient) => Promise<Consent[]>) => withTenantBoundConnection(tenantId, fn);
  return runner(async (client) => {
    const result = await client.query<ConsentRow>(
      `SELECT ${CONSENT_COLUMNS}
         FROM consent
        WHERE tenant_id = $1
          AND account_id = $2
        ORDER BY created_at DESC`,
      [tenantId, accountId],
    );
    return result.rows.map(rowToConsent);
  });
}
