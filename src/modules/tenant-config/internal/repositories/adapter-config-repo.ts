/**
 * adapter-config-repo.ts — read access to per-tenant adapter selections
 * per CDM v1.2 §4.5.
 *
 * adapter_configs is tenant-scoped (RLS enforced). Queries require an
 * active tenant binding. The `adapter_config` JSONB payload carries
 * adapter-specific API keys + account IDs — encrypted at the application
 * layer per ADR-024 (NOT at the DB layer; the column-level contract is
 * documented in migration 019). At v0.1 the read paths return the JSONB
 * unmasked; admin handlers MUST NOT render decrypted secrets back to
 * clients — that's an Admin Backend slice (TLC-Admin-MVP) concern.
 *
 * Spec references:
 *   - migrations/019_adapter_configs_tenant_users.sql
 *   - CDM v1.2 §4.5
 *   - ADR-024 (per-tenant KMS encryption)
 */

import type { DbClient } from '../../../../lib/db.js';
import { withTenantBoundConnection } from '../../../../lib/db.js';
import type { TenantId } from '../../../../lib/glossary.js';

// ---------------------------------------------------------------------------
// AdapterConfig row shape (CDM §4.5 — minimal at v0.1)
// ---------------------------------------------------------------------------

export type AdapterType = 'clinician_network' | 'pharmacy' | 'payment' | 'sms' | 'lab' | 'video';
export type AdapterConfigStatus = 'active' | 'inactive' | 'testing';

export interface AdapterConfig {
  id: string;
  tenant_id: TenantId;
  adapter_type: AdapterType;
  adapter_name: string;
  /**
   * Encrypted-at-application-layer JSONB per ADR-024. Read paths surface
   * this as opaque to handlers; admin UI must not render the JSONB
   * directly to the client without redaction.
   */
  adapter_config: Record<string, unknown>;
  status: AdapterConfigStatus;
  created_at: string;
  updated_at: string;
}

const ADAPTER_CONFIG_COLUMNS = `
  id,
  tenant_id,
  adapter_type,
  adapter_name,
  adapter_config,
  status,
  created_at::text AS created_at,
  updated_at::text AS updated_at
`;

interface AdapterConfigRow {
  id: string;
  tenant_id: string;
  adapter_type: string;
  adapter_name: string;
  adapter_config: Record<string, unknown>;
  status: string;
  created_at: string;
  updated_at: string;
}

function rowToAdapterConfig(row: AdapterConfigRow): AdapterConfig {
  return {
    id: row.id,
    tenant_id: row.tenant_id as TenantId,
    adapter_type: row.adapter_type as AdapterType,
    adapter_name: row.adapter_name,
    adapter_config: row.adapter_config,
    status: row.status as AdapterConfigStatus,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/**
 * List all adapter configs for a tenant (across all types). Used by
 * Admin Backend tenant-config UI.
 */
export async function listAdapterConfigsForTenant(
  tenantId: TenantId,
  externalTx?: DbClient,
): Promise<AdapterConfig[]> {
  const runner = externalTx
    ? (fn: (client: DbClient) => Promise<AdapterConfig[]>) => fn(externalTx)
    : (fn: (client: DbClient) => Promise<AdapterConfig[]>) =>
        withTenantBoundConnection(tenantId, fn);
  return runner(async (client) => {
    const result = await client.query<AdapterConfigRow>(
      `SELECT ${ADAPTER_CONFIG_COLUMNS} FROM adapter_configs
        WHERE tenant_id = $1
        ORDER BY adapter_type, adapter_name`,
      [tenantId],
    );
    return result.rows.map(rowToAdapterConfig);
  });
}
