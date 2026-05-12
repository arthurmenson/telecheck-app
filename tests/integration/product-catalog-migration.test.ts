/**
 * migrations/024_product_catalog.sql — schema-level integration tests.
 *
 * Validates the migration empirically:
 *   - Table exists with the canonical CDM v1.2 §4.9 column set
 *   - Composite UNIQUE (tenant_id, id) per PROJECT_CONVENTIONS r5 §1.1
 *     (defensive prep for SI-001 DRAFT v0.2 medication_requests composite FK)
 *   - Status enum CHECK constraint enforces canonical 3-value set
 *   - Compounding pharmacy type enum CHECK allows NULL or 503A/503B
 *   - JSONB columns accept structured payloads
 *   - RLS policy uses the canonical current_tenant_id() helper
 *     (NOT the stale current_setting('app.tenant_id', true) pattern from
 *     CDM §4.9 example — see migration header for the deviation rationale)
 *   - FORCE RLS denies cross-tenant SELECT + INSERT
 *
 * Spec references:
 *   - migrations/024_product_catalog.sql (target)
 *   - Canonical Data Model v1.2 §4.9 (lines 496-554)
 *   - Pharmacy + Refill Slice PRD v2.1 §8 (consumer)
 *   - SI-001 Closure DRAFT v0.2 (downstream FK target — pending ratification)
 *   - PROJECT_CONVENTIONS r5 §1.1 (composite UNIQUE for FK targets)
 *   - migrations/003_rls_helpers.sql (current_tenant_id() helper)
 */

import { describe, expect, it } from 'vitest';

import type { TenantId } from '../../src/lib/glossary.ts';
import { ulid } from '../../src/lib/ulid.ts';
import { TENANT_GHANA, TENANT_US, withTenantContext } from '../helpers/tenant-fixtures.ts';
import { getTestClient } from '../setup.ts';

const T_US = TENANT_US as TenantId;
const T_GH = TENANT_GHANA as TenantId;

interface InsertProductInput {
  id?: string;
  tenant_id: string;
  display_name?: string;
  generic_name?: string;
  rxnorm_code?: string | null;
  ndc_codes?: object | null;
  form?: string | null;
  strength?: string | null;
  package_size?: string | null;
  program?: string;
  category?: string;
  available_adapters?: string[];
  preferred_adapter?: string | null;
  is_compounded?: boolean;
  compounding_pharmacy_type?: string | null;
  pricing?: object;
  subscription_eligible?: boolean;
  status?: string;
  description_patient_facing?: string | null;
  description_clinical?: string | null;
}

async function insertProduct(input: InsertProductInput): Promise<string> {
  const client = getTestClient();
  const id = input.id ?? ulid();
  await client.query(
    `INSERT INTO product_catalog (
        id, tenant_id, display_name, generic_name, rxnorm_code, ndc_codes,
        form, strength, package_size, program, category, available_adapters,
        preferred_adapter, is_compounded, compounding_pharmacy_type, pricing,
        subscription_eligible, status, description_patient_facing,
        description_clinical
     ) VALUES (
        $1, $2, $3, $4, $5, $6::jsonb,
        $7, $8, $9, $10, $11, $12::jsonb,
        $13, $14, $15, $16::jsonb,
        $17, $18, $19, $20
     )`,
    [
      id,
      input.tenant_id,
      input.display_name ?? 'Test Medication',
      input.generic_name ?? 'test_generic',
      input.rxnorm_code ?? null,
      JSON.stringify(input.ndc_codes ?? null),
      input.form ?? 'tablet',
      input.strength ?? '10mg',
      input.package_size ?? '30 tablets',
      input.program ?? 'weight_loss',
      input.category ?? 'primary_treatment',
      JSON.stringify(input.available_adapters ?? ['truepill']),
      input.preferred_adapter ?? 'truepill',
      input.is_compounded ?? false,
      input.compounding_pharmacy_type ?? null,
      JSON.stringify(input.pricing ?? { monthly: 199.0, quarterly: 549.0 }),
      input.subscription_eligible ?? true,
      input.status ?? 'active',
      input.description_patient_facing ?? null,
      input.description_clinical ?? null,
    ],
  );
  return id;
}

// ---------------------------------------------------------------------------
// §1 — Canonical insert + column shape
// ---------------------------------------------------------------------------

describe('product_catalog migration — §1 canonical insert', () => {
  it('§1a accepts canonical product per CDM §4.9 column set', async () => {
    await withTenantContext(T_US, () => insertProduct({ tenant_id: T_US }));
  });

  it('§1b accepts product with full optional column set populated', async () => {
    await withTenantContext(T_US, () =>
      insertProduct({
        tenant_id: T_US,
        rxnorm_code: '12345',
        ndc_codes: { primary: '00000-0000-00', alternate: ['00000-0000-01'] },
        is_compounded: true,
        compounding_pharmacy_type: '503A',
        description_patient_facing: 'Take with food.',
        description_clinical: 'Indications: type 2 diabetes; weight management.',
      }),
    );
  });

  it('§1c JSONB columns accept structured payloads', async () => {
    const id = await withTenantContext(T_US, () =>
      insertProduct({
        tenant_id: T_US,
        available_adapters: ['truepill', 'honeybee'],
        pricing: { monthly: 199.0, quarterly: 549.0, one_time: 99.0 },
        ndc_codes: { primary: '00000-0000-00' },
      }),
    );
    const result = await withTenantContext(T_US, async () => {
      const client = getTestClient();
      return client.query<{
        available_adapters: string[];
        pricing: Record<string, number>;
        ndc_codes: Record<string, string>;
      }>(
        `SELECT available_adapters, pricing, ndc_codes
           FROM product_catalog WHERE id = $1`,
        [id],
      );
    });
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.available_adapters).toEqual(['truepill', 'honeybee']);
    expect(result.rows[0]?.pricing).toEqual({ monthly: 199.0, quarterly: 549.0, one_time: 99.0 });
    expect(result.rows[0]?.ndc_codes).toEqual({ primary: '00000-0000-00' });
  });
});

// ---------------------------------------------------------------------------
// §2 — CHECK constraints
// ---------------------------------------------------------------------------

describe('product_catalog migration — §2 CHECK constraints', () => {
  it('§2a status enum: rejects out-of-set value', async () => {
    await expect(
      withTenantContext(T_US, () => insertProduct({ tenant_id: T_US, status: 'made_up' })),
    ).rejects.toThrow(/check constraint|status/i);
  });

  it('§2b status enum: accepts active', async () => {
    await withTenantContext(T_US, () => insertProduct({ tenant_id: T_US, status: 'active' }));
  });

  it('§2c status enum: accepts out_of_stock', async () => {
    await withTenantContext(T_US, () => insertProduct({ tenant_id: T_US, status: 'out_of_stock' }));
  });

  it('§2d status enum: accepts discontinued', async () => {
    await withTenantContext(T_US, () => insertProduct({ tenant_id: T_US, status: 'discontinued' }));
  });

  it('§2e compounding_pharmacy_type: accepts NULL when not compounded', async () => {
    await withTenantContext(T_US, () =>
      insertProduct({
        tenant_id: T_US,
        is_compounded: false,
        compounding_pharmacy_type: null,
      }),
    );
  });

  it('§2f compounding_pharmacy_type: accepts 503A', async () => {
    await withTenantContext(T_US, () =>
      insertProduct({
        tenant_id: T_US,
        is_compounded: true,
        compounding_pharmacy_type: '503A',
      }),
    );
  });

  it('§2g compounding_pharmacy_type: accepts 503B', async () => {
    await withTenantContext(T_US, () =>
      insertProduct({
        tenant_id: T_US,
        is_compounded: true,
        compounding_pharmacy_type: '503B',
      }),
    );
  });

  it('§2h compounding_pharmacy_type: rejects out-of-set value', async () => {
    await expect(
      withTenantContext(T_US, () =>
        insertProduct({
          tenant_id: T_US,
          is_compounded: true,
          compounding_pharmacy_type: '503X',
        }),
      ),
    ).rejects.toThrow(/check constraint|compounding_pharmacy_type/i);
  });
});

// ---------------------------------------------------------------------------
// §3 — Composite UNIQUE (tenant_id, id) per PROJECT_CONVENTIONS r5 §1.1
// ---------------------------------------------------------------------------

describe('product_catalog migration — §3 composite UNIQUE', () => {
  it('§3a composite UNIQUE (tenant_id, id) exists per PROJECT_CONVENTIONS r5 §1.1', async () => {
    const client = getTestClient();
    const result = await client.query(
      `SELECT conname FROM pg_constraint
         WHERE conrelid = 'product_catalog'::regclass
           AND contype  = 'u'
           AND conname  = 'product_catalog_tenant_id_id_unique'`,
    );
    expect(result.rows).toHaveLength(1);
  });

  it('§3b composite UNIQUE prevents same-tenant same-id collision', async () => {
    const id = ulid();
    await withTenantContext(T_US, () => insertProduct({ tenant_id: T_US, id }));
    await expect(
      withTenantContext(T_US, () => insertProduct({ tenant_id: T_US, id })),
    ).rejects.toThrow(/duplicate key|unique constraint/i);
  });
});

// ---------------------------------------------------------------------------
// §4 — RLS enforcement
// ---------------------------------------------------------------------------

describe('product_catalog migration — §4 RLS', () => {
  it('§4a RLS is enabled', async () => {
    const client = getTestClient();
    const result = await client.query<{
      relrowsecurity: boolean;
      relforcerowsecurity: boolean;
    }>(
      `SELECT relrowsecurity, relforcerowsecurity FROM pg_class
         WHERE oid = 'product_catalog'::regclass`,
    );
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.relrowsecurity).toBe(true);
    expect(result.rows[0]?.relforcerowsecurity).toBe(true);
  });

  it('§4b RLS policy uses current_tenant_id() helper (NOT stale current_setting pattern)', async () => {
    const client = getTestClient();
    const result = await client.query<{ qual: string; with_check: string }>(
      `SELECT qual::text, with_check::text FROM pg_policies
         WHERE schemaname = 'public'
           AND tablename  = 'product_catalog'
           AND policyname = 'product_catalog_tenant_isolation'`,
    );
    expect(result.rows).toHaveLength(1);
    // Codex Finding 4 (SI-001 v0.2) regression guard:
    // verify the policy uses current_tenant_id(), not the stale pattern.
    expect(result.rows[0]?.qual).toContain('current_tenant_id()');
    expect(result.rows[0]?.with_check).toContain('current_tenant_id()');
    expect(result.rows[0]?.qual).not.toContain("current_setting('app.tenant_id'");
  });

  it('§4c cross-tenant SELECT returns nothing', async () => {
    const id = await withTenantContext(T_US, () => insertProduct({ tenant_id: T_US }));
    const result = await withTenantContext(T_GH, async () => {
      const client = getTestClient();
      return client.query(`SELECT id FROM product_catalog WHERE id = $1`, [id]);
    });
    expect(result.rows).toHaveLength(0);
  });

  it('§4d cross-tenant INSERT is denied (FORCE RLS WITH CHECK)', async () => {
    await expect(
      withTenantContext(T_GH, () =>
        // Try to INSERT a product with tenant_id=T_US while in T_GH context
        insertProduct({ tenant_id: T_US }),
      ),
    ).rejects.toThrow(/policy|row-level security|violates/i);
  });
});

// ---------------------------------------------------------------------------
// §5 — FK relationships (forward-looking; defensive)
// ---------------------------------------------------------------------------

describe('product_catalog migration — §5 FK target shape', () => {
  it('§5a tenant_id FK to tenants(id) is present', async () => {
    const client = getTestClient();
    const result = await client.query(
      `SELECT conname FROM pg_constraint
         WHERE conrelid = 'product_catalog'::regclass
           AND contype  = 'f'
           AND pg_get_constraintdef(oid) LIKE '%REFERENCES tenants(id)%'`,
    );
    expect(result.rows.length).toBeGreaterThanOrEqual(1);
  });

  it('§5b composite UNIQUE enables future composite-FK targeting per SI-001 DRAFT v0.2', async () => {
    // Smoke test: a composite-FK lookup against the UNIQUE constraint works.
    const id = await withTenantContext(T_US, () => insertProduct({ tenant_id: T_US }));
    const result = await withTenantContext(T_US, async () => {
      const client = getTestClient();
      return client.query<{ id: string }>(
        `SELECT id FROM product_catalog WHERE tenant_id = $1 AND id = $2`,
        [T_US, id],
      );
    });
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.id).toBe(id);
  });
});
