/**
 * tenant-brand-repo.ts — read access to per-tenant brand identity per CDM v1.2 §4.2.
 *
 * tenant_brands is tenant-scoped (RLS enforced). Queries require an active
 * tenant binding. Used by patient/clinician UI surfaces that render brand
 * colors, logo, support contact, and legal-copy URLs.
 *
 * Spec references:
 *   - migrations/018_tenant_config.sql
 *   - CDM v1.2 §4.2
 *   - DIC v1.1 (design tokens consumed by frontend)
 */

import type { DbClient } from '../../../../lib/db.js';
import { withTenantBoundConnection } from '../../../../lib/db.js';
import type { TenantId } from '../../../../lib/glossary.js';
import type { TenantBrand } from '../types.js';

const TENANT_BRAND_COLUMNS = `
  tenant_id,
  brand_name,
  logo_url,
  primary_color,
  secondary_color,
  accent_color,
  custom_domain,
  custom_domain_verified,
  terms_of_service_url,
  privacy_policy_url,
  support_email,
  support_phone,
  design_tokens,
  notification_copy_overrides,
  created_at::text AS created_at,
  updated_at::text AS updated_at
`;

interface TenantBrandRow {
  tenant_id: string;
  brand_name: string;
  logo_url: string | null;
  primary_color: string | null;
  secondary_color: string | null;
  accent_color: string | null;
  custom_domain: string | null;
  custom_domain_verified: boolean;
  terms_of_service_url: string | null;
  privacy_policy_url: string | null;
  support_email: string | null;
  support_phone: string | null;
  design_tokens: Record<string, unknown> | null;
  notification_copy_overrides: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
}

function rowToTenantBrand(row: TenantBrandRow): TenantBrand {
  return {
    tenant_id: row.tenant_id as TenantId,
    brand_name: row.brand_name,
    logo_url: row.logo_url,
    primary_color: row.primary_color,
    secondary_color: row.secondary_color,
    accent_color: row.accent_color,
    custom_domain: row.custom_domain,
    custom_domain_verified: row.custom_domain_verified,
    terms_of_service_url: row.terms_of_service_url,
    privacy_policy_url: row.privacy_policy_url,
    support_email: row.support_email,
    support_phone: row.support_phone,
    design_tokens: row.design_tokens,
    notification_copy_overrides: row.notification_copy_overrides,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/**
 * Read the brand row for a tenant. Returns null if no brand row exists
 * (uncommon — every tenant should have a brand seed; if missing, callers
 * should fall back to design-system defaults).
 */
export async function findTenantBrand(
  tenantId: TenantId,
  externalTx?: DbClient,
): Promise<TenantBrand | null> {
  const runner = externalTx
    ? (fn: (client: DbClient) => Promise<TenantBrand | null>) => fn(externalTx)
    : (fn: (client: DbClient) => Promise<TenantBrand | null>) =>
        withTenantBoundConnection(tenantId, fn);
  return runner(async (client) => {
    const result = await client.query<TenantBrandRow>(
      `SELECT ${TENANT_BRAND_COLUMNS} FROM tenant_brands WHERE tenant_id = $1`,
      [tenantId],
    );
    if (result.rows.length === 0) return null;
    const row = result.rows[0];
    if (row === undefined) return null;
    return rowToTenantBrand(row);
  });
}
