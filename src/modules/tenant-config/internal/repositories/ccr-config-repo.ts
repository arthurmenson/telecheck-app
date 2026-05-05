/**
 * ccr-config-repo.ts — read access to per-tenant CCR overrides per CDM v1.2 §4.4.
 *
 * ccr_configs is tenant-scoped (RLS enforced). All queries require an
 * active tenant binding via withTenantContext / set_tenant_context().
 *
 * Used by the CCR resolver service that combines per-tenant overrides
 * with country_profiles defaults. The resolver is the canonical CCR-key
 * lookup surface; cross-module consumers should NEVER read ccr_configs
 * directly — go through the resolver.
 *
 * Spec references:
 *   - migrations/018_tenant_config.sql
 *   - CDM v1.2 §4.4
 */

import type { DbClient } from '../../../../lib/db.js';
import { withTenantBoundConnection } from '../../../../lib/db.js';
import type { TenantId } from '../../../../lib/glossary.js';
import { asCcrConfigId, type CcrConfig } from '../types.js';

const CCR_CONFIG_COLUMNS = `
  id            AS ccr_config_id,
  tenant_id,
  config_key,
  config_value,
  created_at::text AS created_at,
  updated_at::text AS updated_at
`;

interface CcrConfigRow {
  ccr_config_id: string;
  tenant_id: string;
  config_key: string;
  config_value: unknown;
  created_at: string;
  updated_at: string;
}

function rowToCcrConfig(row: CcrConfigRow): CcrConfig {
  return {
    ccr_config_id: asCcrConfigId(row.ccr_config_id),
    tenant_id: row.tenant_id as TenantId,
    config_key: row.config_key,
    config_value: row.config_value,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/**
 * Look up a single per-tenant CCR override by key. Returns null if the
 * tenant has no override for that key (caller falls back to the
 * country_profiles default via the resolver service).
 */
export async function findCcrConfig(
  tenantId: TenantId,
  configKey: string,
  externalTx?: DbClient,
): Promise<CcrConfig | null> {
  const runner = externalTx
    ? (fn: (client: DbClient) => Promise<CcrConfig | null>) => fn(externalTx)
    : (fn: (client: DbClient) => Promise<CcrConfig | null>) =>
        withTenantBoundConnection(tenantId, fn);
  return runner(async (client) => {
    const result = await client.query<CcrConfigRow>(
      `SELECT ${CCR_CONFIG_COLUMNS} FROM ccr_configs
        WHERE tenant_id = $1 AND config_key = $2`,
      [tenantId, configKey],
    );
    if (result.rows.length === 0) return null;
    const row = result.rows[0];
    if (row === undefined) return null;
    return rowToCcrConfig(row);
  });
}

/**
 * List all per-tenant CCR overrides for a tenant. Used by Admin Backend
 * tenant-config UI; downstream slice consumers should call findCcrConfig
 * for individual key lookups via the resolver.
 */
export async function listCcrConfigsForTenant(
  tenantId: TenantId,
  externalTx?: DbClient,
): Promise<CcrConfig[]> {
  const runner = externalTx
    ? (fn: (client: DbClient) => Promise<CcrConfig[]>) => fn(externalTx)
    : (fn: (client: DbClient) => Promise<CcrConfig[]>) => withTenantBoundConnection(tenantId, fn);
  return runner(async (client) => {
    const result = await client.query<CcrConfigRow>(
      `SELECT ${CCR_CONFIG_COLUMNS} FROM ccr_configs
        WHERE tenant_id = $1
        ORDER BY config_key`,
      [tenantId],
    );
    return result.rows.map(rowToCcrConfig);
  });
}
