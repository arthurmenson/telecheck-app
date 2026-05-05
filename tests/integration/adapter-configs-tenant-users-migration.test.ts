/**
 * migrations/019_adapter_configs_tenant_users.sql — schema-level tests.
 *
 * Validates the two new tenant-management tables empirically:
 *   §1 adapter_configs — tenant-scoped, adapter_type CHECK enum, status CHECK,
 *                        UNIQUE (tenant_id, adapter_type, adapter_name),
 *                        RLS isolation, updated_at trigger
 *   §2 tenant_users    — global UNIQUE email, role-scope consistency CHECK,
 *                        status-timestamp consistency CHECK, RLS allowing
 *                        platform admins (tenant_id=NULL) cross-tenant
 *
 * Coverage in this file (2 sections, 12 cases):
 *   §1a INSERT round-trip with active status
 *   §1b adapter_type CHECK rejects unknown enum value
 *   §1c status CHECK rejects unknown status value
 *   §1d UNIQUE collision (same tenant + type + name) rejected
 *   §1e RLS — US adapter invisible from Ghana tenant context
 *   §1f updated_at trigger advances on UPDATE
 *
 *   §2a tenant_user INSERT round-trip (platform_admin, tenant_id NULL)
 *   §2b tenant_user INSERT round-trip (tenant_admin, tenant_id set)
 *   §2c role-scope CHECK rejects platform_admin with tenant_id set
 *   §2d role-scope CHECK rejects tenant_admin with tenant_id NULL
 *   §2e UNIQUE email rejected on insert
 *   §2f RLS — platform_admin row visible cross-tenant; tenant_admin not
 *
 * Spec references:
 *   - migrations/019_adapter_configs_tenant_users.sql (target)
 *   - CDM v1.2 §4.5 (AdapterConfig) + §4.6 (TenantUser)
 *   - I-023 / I-024 / I-027 (RLS + cross-tenant break-glass + tenant_id mandatory)
 */

import { describe, expect, it } from 'vitest';

import type { TenantId } from '../../src/lib/glossary.ts';
import { ulid } from '../../src/lib/ulid.ts';
import { TENANT_GHANA, TENANT_US, withTenantContext } from '../helpers/tenant-fixtures.ts';
import { getTestClient } from '../setup.ts';

const T_US = TENANT_US as TenantId;
const T_GH = TENANT_GHANA as TenantId;

// ---------------------------------------------------------------------------
// §1 — adapter_configs
// ---------------------------------------------------------------------------

describe('migrations/019 — §1 adapter_configs', () => {
  it('§1a INSERT round-trip with active status', async () => {
    const id = ulid();
    await withTenantContext(T_US, () =>
      getTestClient().query(
        `INSERT INTO adapter_configs (id, tenant_id, adapter_type, adapter_name,
                                       adapter_config, status)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6)`,
        [id, T_US, 'pharmacy', 'truepill', JSON.stringify({ api_key_ref: 'kms:1' }), 'active'],
      ),
    );
    const r = await withTenantContext(T_US, () =>
      getTestClient().query<{ adapter_name: string; status: string }>(
        `SELECT adapter_name, status FROM adapter_configs WHERE id = $1`,
        [id],
      ),
    );
    expect(r.rows[0]!.adapter_name).toBe('truepill');
    expect(r.rows[0]!.status).toBe('active');
  });

  it('§1b adapter_type CHECK rejects unknown enum', async () => {
    await expect(
      withTenantContext(T_US, () =>
        getTestClient().query(
          `INSERT INTO adapter_configs (id, tenant_id, adapter_type, adapter_name,
                                         adapter_config, status)
           VALUES ($1, $2, $3, $4, $5::jsonb, $6)`,
          [ulid(), T_US, 'made_up', 'x', JSON.stringify({}), 'active'],
        ),
      ),
    ).rejects.toThrow(/check constraint|adapter_type/i);
  });

  it('§1c status CHECK rejects unknown status', async () => {
    await expect(
      withTenantContext(T_US, () =>
        getTestClient().query(
          `INSERT INTO adapter_configs (id, tenant_id, adapter_type, adapter_name,
                                         adapter_config, status)
           VALUES ($1, $2, $3, $4, $5::jsonb, $6)`,
          [ulid(), T_US, 'pharmacy', 'truepill', JSON.stringify({}), 'broken'],
        ),
      ),
    ).rejects.toThrow(/check constraint|status/i);
  });

  it('§1d UNIQUE (tenant_id, adapter_type, adapter_name) collision rejected', async () => {
    await withTenantContext(T_US, () =>
      getTestClient().query(
        `INSERT INTO adapter_configs (id, tenant_id, adapter_type, adapter_name,
                                       adapter_config, status)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6)`,
        [ulid(), T_US, 'sms', 'twilio', JSON.stringify({}), 'active'],
      ),
    );
    await expect(
      withTenantContext(T_US, () =>
        getTestClient().query(
          `INSERT INTO adapter_configs (id, tenant_id, adapter_type, adapter_name,
                                         adapter_config, status)
           VALUES ($1, $2, $3, $4, $5::jsonb, $6)`,
          [ulid(), T_US, 'sms', 'twilio', JSON.stringify({}), 'active'],
        ),
      ),
    ).rejects.toThrow(/duplicate key|unique/i);
  });

  it('§1e RLS — US adapter invisible from Ghana', async () => {
    const id = ulid();
    await withTenantContext(T_US, () =>
      getTestClient().query(
        `INSERT INTO adapter_configs (id, tenant_id, adapter_type, adapter_name,
                                       adapter_config, status)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6)`,
        [id, T_US, 'lab', 'quest', JSON.stringify({}), 'active'],
      ),
    );
    const visible = await withTenantContext(T_GH, async () => {
      const r = await getTestClient().query<{ c: string }>(
        `SELECT COUNT(*)::text AS c FROM adapter_configs WHERE id = $1`,
        [id],
      );
      return Number.parseInt(r.rows[0]!.c, 10);
    });
    expect(visible).toBe(0);
  });

  it('§1f updated_at trigger advances on UPDATE', async () => {
    const id = ulid();
    await withTenantContext(T_US, () =>
      getTestClient().query(
        `INSERT INTO adapter_configs (id, tenant_id, adapter_type, adapter_name,
                                       adapter_config, status)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6)`,
        [id, T_US, 'video', 'livekit', JSON.stringify({}), 'testing'],
      ),
    );
    const before = await withTenantContext(T_US, () =>
      getTestClient().query<{ updated_at: string }>(
        `SELECT updated_at FROM adapter_configs WHERE id = $1`,
        [id],
      ),
    );
    await withTenantContext(T_US, () =>
      getTestClient().query(`UPDATE adapter_configs SET status = 'active' WHERE id = $1`, [id]),
    );
    const after = await withTenantContext(T_US, () =>
      getTestClient().query<{ updated_at: string }>(
        `SELECT updated_at FROM adapter_configs WHERE id = $1`,
        [id],
      ),
    );
    expect(after.rows[0]!.updated_at).not.toBe(before.rows[0]!.updated_at);
  });
});

// ---------------------------------------------------------------------------
// §2 — tenant_users
// ---------------------------------------------------------------------------

describe('migrations/019 — §2 tenant_users', () => {
  it('§2a INSERT platform_admin (tenant_id NULL)', async () => {
    const id = ulid();
    const email = `platform.admin+${id}@telecheck.health`;
    await getTestClient().query(
      `INSERT INTO tenant_users (id, tenant_id, email, display_name, role, status, activated_at)
       VALUES ($1, NULL, $2, $3, 'platform_admin', 'active', NOW())`,
      [id, email, 'Platform Admin Test'],
    );
    const r = await getTestClient().query<{ tenant_id: string | null; role: string }>(
      `SELECT tenant_id, role FROM tenant_users WHERE id = $1`,
      [id],
    );
    expect(r.rows[0]!.tenant_id).toBeNull();
    expect(r.rows[0]!.role).toBe('platform_admin');
  });

  it('§2b INSERT tenant_admin (tenant_id set)', async () => {
    const id = ulid();
    const email = `tenant.admin+${id}@telecheck.health`;
    await withTenantContext(T_US, () =>
      getTestClient().query(
        `INSERT INTO tenant_users (id, tenant_id, email, display_name, role, status, activated_at)
         VALUES ($1, $2, $3, $4, 'tenant_admin', 'active', NOW())`,
        [id, T_US, email, 'Tenant Admin Test'],
      ),
    );
    const r = await withTenantContext(T_US, () =>
      getTestClient().query<{ tenant_id: string; role: string }>(
        `SELECT tenant_id, role FROM tenant_users WHERE id = $1`,
        [id],
      ),
    );
    expect(r.rows[0]!.tenant_id).toBe(T_US);
    expect(r.rows[0]!.role).toBe('tenant_admin');
  });

  it('§2c role-scope CHECK rejects platform_admin with tenant_id set', async () => {
    await expect(
      withTenantContext(T_US, () =>
        getTestClient().query(
          `INSERT INTO tenant_users (id, tenant_id, email, display_name, role, status, activated_at)
           VALUES ($1, $2, $3, $4, 'platform_admin', 'active', NOW())`,
          [ulid(), T_US, `bad+${ulid()}@x.com`, 'Bad Platform Admin'],
        ),
      ),
    ).rejects.toThrow(/tenant_user_role_scope_consistent|check constraint/i);
  });

  it('§2d role-scope CHECK rejects tenant_admin with tenant_id NULL', async () => {
    await expect(
      getTestClient().query(
        `INSERT INTO tenant_users (id, tenant_id, email, display_name, role, status, activated_at)
         VALUES ($1, NULL, $2, $3, 'tenant_admin', 'active', NOW())`,
        [ulid(), `bad+${ulid()}@x.com`, 'Bad Tenant Admin'],
      ),
    ).rejects.toThrow(/tenant_user_role_scope_consistent|check constraint/i);
  });

  it('§2e UNIQUE email rejected on second insert', async () => {
    const email = `unique+${ulid()}@telecheck.health`;
    await getTestClient().query(
      `INSERT INTO tenant_users (id, tenant_id, email, display_name, role, status, activated_at)
       VALUES ($1, NULL, $2, $3, 'platform_admin', 'active', NOW())`,
      [ulid(), email, 'First'],
    );
    await expect(
      getTestClient().query(
        `INSERT INTO tenant_users (id, tenant_id, email, display_name, role, status, activated_at)
         VALUES ($1, NULL, $2, $3, 'platform_admin', 'active', NOW())`,
        [ulid(), email, 'Second'],
      ),
    ).rejects.toThrow(/duplicate key|unique/i);
  });

  it('§2f RLS — platform_admin visible cross-tenant; tenant_admin not', async () => {
    // Seed a platform admin (tenant_id NULL) + a US tenant admin
    const platformId = ulid();
    const usAdminId = ulid();
    await getTestClient().query(
      `INSERT INTO tenant_users (id, tenant_id, email, display_name, role, status, activated_at)
       VALUES ($1, NULL, $2, $3, 'platform_admin', 'active', NOW())`,
      [platformId, `pa+${platformId}@x.com`, 'PA'],
    );
    await withTenantContext(T_US, () =>
      getTestClient().query(
        `INSERT INTO tenant_users (id, tenant_id, email, display_name, role, status, activated_at)
         VALUES ($1, $2, $3, $4, 'tenant_admin', 'active', NOW())`,
        [usAdminId, T_US, `ta+${usAdminId}@x.com`, 'TA'],
      ),
    );

    // From Ghana tenant context: platform admin row IS visible (tenant_id NULL),
    // US tenant_admin row is NOT visible.
    const fromGhana = await withTenantContext(T_GH, () =>
      getTestClient().query<{ id: string }>(`SELECT id FROM tenant_users WHERE id IN ($1, $2)`, [
        platformId,
        usAdminId,
      ]),
    );
    const ids = new Set(fromGhana.rows.map((r) => r.id));
    expect(ids.has(platformId)).toBe(true);
    expect(ids.has(usAdminId)).toBe(false);
  });
});
