/**
 * pharmacy-engine-writeback.test.ts — direct-service-call integration
 * tests for the Med Interaction Engine writeback per Sprint 35-36 /
 * TLC-055 PR I.
 *
 * Service under test:
 *   evaluateInteractionsAsEngine(ctx, mrId, evaluation, tx?)
 *
 * State Machines v1.2 §19 admits two engine-driven transitions out of
 * pending_interaction_check:
 *
 *   pending_interaction_check --[engine_clean]-->       pending_clinician_review
 *   pending_interaction_check --[engine_safety_hold]--> pending_clinician_review
 *                                                       (with safety_hold flag)
 *
 * SCOPE NOTE: at v1.0 this is service-callable only (no HTTP).
 * System-actor JWT tokens do not yet exist; the Med Interaction Engine
 * module invokes this directly. Tests therefore call the service fn
 * via its export, not through buildApp/inject.
 *
 * Coverage (4 groups, 7 cases):
 *
 *   Group A — Happy path engine_clean
 *     A1 signalsStatus='clean'   → status=pending_clinician_review
 *     A2 signalsStatus='caution' → status=pending_clinician_review
 *     A3 audit row: medication_request.interaction_evaluation_completed
 *        with actor_type='system', signals_status in payload
 *
 *   Group B — Happy path engine_safety_hold
 *     B1 signalsStatus='safety_hold' → status=pending_clinician_review
 *        + safety-hold domain event medication_request.interaction_safety_
 *          hold_triggered.v1 emitted
 *
 *   Group C — State machine
 *     C1 draft row → 409-equivalent (MedicationRequestStateConflictError)
 *     C2 already-evaluated row (signals_status != 'pending') → conflict
 *
 *   Group D — Resource resolution
 *     D1 nonexistent id → MedicationRequestNotFoundError
 *
 * Spec references:
 *   - State Machines v1.2 §19 (engine_clean, engine_safety_hold)
 *   - CDM v1.3 §4.16 (interaction_signals_status + evaluated_at)
 *   - AUDIT_EVENTS v5.3 (medication_request.interaction_evaluation_completed
 *     Category A; actor_type='system'; ai_workload_type/autonomy_level null
 *     per deterministic-rules-engine carve-out)
 *   - DOMAIN_EVENTS v5.2 (medication_request.interaction_safety_hold_triggered.v1
 *     Path 1 integration; only emitted on safety_hold)
 *   - I-023 / I-025 / I-027 (tenant scoping; tenant-blind 404; tenant_id
 *     on every audit row)
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { asTenantId } from '../../src/lib/glossary.ts';
import type { TenantContext } from '../../src/lib/tenant-context.ts';
import { ulid } from '../../src/lib/ulid.ts';
import { createAccount } from '../../src/modules/identity/internal/repositories/account-repo.ts';
import { asAccountId, type AccountId } from '../../src/modules/identity/internal/types.ts';
import {
  evaluateInteractionsAsEngine,
  MedicationRequestNotFoundError,
  MedicationRequestStateConflictError,
} from '../../src/modules/pharmacy/internal/services/medication-request-service.ts';
import {
  asMedicationRequestId,
  asProductCatalogId,
  type MedicationRequestId,
  type ProductCatalogId,
} from '../../src/modules/pharmacy/internal/types.ts';
import { TENANT_US, withTenantContext } from '../helpers/tenant-fixtures.ts';
import { uniquePhone } from '../helpers/unique-phone.ts';
import { getTestClient } from '../setup.ts';

const T_US = asTenantId(TENANT_US);

const US_CTX: TenantContext = {
  tenantId: T_US,
  displayName: 'Telecheck-US',
  countryOfCare: 'US',
  kmsKeyAlias: 'alias/telecheck-us-data-key',
  consumerDba: 'Heros Health',
  legalEntity: 'Telecheck Health LLC',
  consumerSubdomain: 'heroshealth.com',
};

beforeAll(() => {
  process.env['NODE_ENV'] = 'test';
});

afterAll(() => {
  /* no-op */
});

// ---------------------------------------------------------------------------
// Seeding helpers
// ---------------------------------------------------------------------------

async function insertPatient(ctx: TenantContext): Promise<AccountId> {
  const accountId = asAccountId(ulid());
  await withTenantContext(ctx.tenantId, () =>
    createAccount(
      {
        account_id: accountId,
        tenant_id: ctx.tenantId,
        phone_e164: uniquePhone('+1'),
        first_name: 'A',
        last_name: 'B',
        date_of_birth: '1990-01-01',
        gender: 'prefer_not_to_say',
        country_of_residence: ctx.countryOfCare,
        country_of_care: ctx.countryOfCare,
        account_type: 'patient',
      },
      async () => {
        /* no-op */
      },
    ),
  );
  return accountId;
}

async function seedProduct(ctx: TenantContext): Promise<ProductCatalogId> {
  const id = ulid();
  await withTenantContext(ctx.tenantId, async () => {
    const client = getTestClient();
    await client.query(
      `INSERT INTO product_catalog (
          id, tenant_id, display_name, generic_name, rxnorm_code, ndc_codes,
          form, strength, package_size, program, category, available_adapters,
          preferred_adapter, is_compounded, compounding_pharmacy_type, pricing,
          subscription_eligible, status
       ) VALUES (
          $1, $2, $3, $4, $5, $6::jsonb,
          $7, $8, $9, $10, $11, $12::jsonb,
          $13, $14, $15, $16::jsonb,
          $17, $18
       )`,
      [
        id,
        ctx.tenantId,
        'Test',
        'test',
        null,
        JSON.stringify(null),
        'tablet',
        '10mg',
        '30 tablets',
        'weight_loss',
        'primary_treatment',
        JSON.stringify(['truepill']),
        'truepill',
        false,
        null,
        JSON.stringify({ monthly: 199.0 }),
        true,
        'active',
      ],
    );
  });
  return asProductCatalogId(id);
}

/**
 * Seed a row at pending_interaction_check with signals_status='pending'
 * (the precondition for engine writeback). Or at draft / pending_
 * clinician_review (already evaluated) for negative-path tests.
 */
async function seedRow(
  ctx: TenantContext,
  patient: AccountId,
  product: ProductCatalogId,
  status: 'draft' | 'pending_interaction_check' | 'pending_clinician_review',
): Promise<MedicationRequestId> {
  const id = asMedicationRequestId(`mrx_${ulid()}`);
  await withTenantContext(ctx.tenantId, async () => {
    const client = getTestClient();
    const now = new Date().toISOString();
    const alreadyEvaluated = status === 'pending_clinician_review';
    await client.query(
      `INSERT INTO medication_requests (
          id, tenant_id, patient_account_id, product_catalog_id,
          medication_name, strength, formulation,
          dose_instructions, quantity, quantity_unit, refills_allowed,
          status, prescribed_at, activated_at,
          discontinued_at, discontinued_reason,
          prescribed_by_clinician_account_id,
          interaction_signals_status, interaction_signals_evaluated_at,
          country_of_care
       ) VALUES (
          $1, $2, $3, $4,
          $5, $6, $7,
          $8, $9, $10, $11,
          $12, NULL, NULL,
          NULL, NULL,
          NULL,
          $13, $14,
          $15
       )`,
      [
        id,
        ctx.tenantId,
        patient,
        product,
        'Test',
        '10mg',
        'tablet',
        '1 tablet daily',
        30,
        'tablet',
        0,
        status,
        alreadyEvaluated ? 'clean' : 'pending',
        alreadyEvaluated ? now : null,
        ctx.countryOfCare,
      ],
    );
  });
  return id;
}

async function readStatus(
  mrId: MedicationRequestId,
): Promise<{ status: string; signals: string; evaluated_at: Date | null }> {
  return withTenantContext(T_US, async () => {
    const client = getTestClient();
    const res = await client.query<{
      status: string;
      interaction_signals_status: string;
      interaction_signals_evaluated_at: Date | null;
    }>(
      `SELECT status, interaction_signals_status, interaction_signals_evaluated_at
         FROM medication_requests
        WHERE tenant_id = $1 AND id = $2`,
      [T_US, mrId],
    );
    const row = res.rows[0]!;
    return {
      status: row.status,
      signals: row.interaction_signals_status,
      evaluated_at: row.interaction_signals_evaluated_at,
    };
  });
}

// ===========================================================================
// Group A — Happy path engine_clean
// ===========================================================================

describe('engine writeback — Group A: engine_clean', () => {
  it('A1 signalsStatus=clean → status=pending_clinician_review + signals persisted', async () => {
    const patient = await insertPatient(US_CTX);
    const product = await seedProduct(US_CTX);
    const mrId = await seedRow(US_CTX, patient, product, 'pending_interaction_check');

    const updated = await evaluateInteractionsAsEngine(US_CTX, mrId, {
      interactionSignals: [],
      signalsStatus: 'clean',
      knowledgeBaseVersion: 'kb-2026.05.01',
      engineVersion: 'engine-1.0.0',
    });
    expect(updated.status).toBe('pending_clinician_review');
    expect(updated.interaction_signals_status).toBe('clean');
    expect(updated.interaction_signals_evaluated_at).not.toBeNull();

    const row = await readStatus(mrId);
    expect(row.status).toBe('pending_clinician_review');
    expect(row.signals).toBe('clean');
  });

  it('A2 signalsStatus=caution → status=pending_clinician_review + signals=caution persisted', async () => {
    const patient = await insertPatient(US_CTX);
    const product = await seedProduct(US_CTX);
    const mrId = await seedRow(US_CTX, patient, product, 'pending_interaction_check');

    const updated = await evaluateInteractionsAsEngine(US_CTX, mrId, {
      interactionSignals: [{ signal_id: 'sig1', severity: 'low', check_class: 'drug_interaction' }],
      signalsStatus: 'caution',
      knowledgeBaseVersion: 'kb-2026.05.01',
      engineVersion: 'engine-1.0.0',
    });
    expect(updated.status).toBe('pending_clinician_review');
    expect(updated.interaction_signals_status).toBe('caution');
  });

  it('A3 audit row emitted with actor_type=system + signals_status in payload', async () => {
    const patient = await insertPatient(US_CTX);
    const product = await seedProduct(US_CTX);
    const mrId = await seedRow(US_CTX, patient, product, 'pending_interaction_check');

    await evaluateInteractionsAsEngine(US_CTX, mrId, {
      interactionSignals: [],
      signalsStatus: 'clean',
      knowledgeBaseVersion: 'kb-2026.05.01',
      engineVersion: 'engine-1.0.0',
    });

    await withTenantContext(T_US, async () => {
      const client = getTestClient();
      const rows = await client.query<{
        action: string;
        actor_type: string;
        actor_id: string;
        ai_workload_type: string | null;
        autonomy_level: string | null;
        payload: Record<string, unknown>;
      }>(
        `SELECT action, actor_type, actor_id, ai_workload_type, autonomy_level, payload
           FROM audit_records
          WHERE tenant_id = $1
            AND resource_id = $2
            AND action = 'medication_request.interaction_evaluation_completed'`,
        [T_US, mrId],
      );
      expect(rows.rows.length).toBe(1);
      const row = rows.rows[0]!;
      expect(row.actor_type).toBe('system');
      expect(row.actor_id).toBe('system:interaction-engine');
      // Deterministic rules engine — NOT an AI workload at v1.0.
      expect(row.ai_workload_type).toBeNull();
      expect(row.autonomy_level).toBeNull();
      expect(row.payload.interaction_signals_status).toBe('clean');
      expect(row.payload.engine_version).toBe('engine-1.0.0');
    });
  });
});

// ===========================================================================
// Group B — Happy path engine_safety_hold
// ===========================================================================

describe('engine writeback — Group B: engine_safety_hold', () => {
  it('B1 signalsStatus=safety_hold → state=pending_clinician_review + domain event emitted', async () => {
    const patient = await insertPatient(US_CTX);
    const product = await seedProduct(US_CTX);
    const mrId = await seedRow(US_CTX, patient, product, 'pending_interaction_check');

    const updated = await evaluateInteractionsAsEngine(US_CTX, mrId, {
      interactionSignals: [
        { signal_id: 'sig-warfarin', severity: 'high', check_class: 'major_bleed_risk' },
      ],
      signalsStatus: 'safety_hold',
      knowledgeBaseVersion: 'kb-2026.05.01',
      engineVersion: 'engine-1.0.0',
    });
    expect(updated.status).toBe('pending_clinician_review');
    expect(updated.interaction_signals_status).toBe('safety_hold');

    // Audit row should emit the canonical interaction_evaluation_completed
    // action, AND the safety-hold domain event should appear.
    await withTenantContext(T_US, async () => {
      const client = getTestClient();
      const auditCount = await client.query<{ n: string }>(
        `SELECT COUNT(*)::text AS n FROM audit_records
          WHERE tenant_id = $1 AND resource_id = $2
            AND action = 'medication_request.interaction_evaluation_completed'`,
        [T_US, mrId],
      );
      expect(Number.parseInt(auditCount.rows[0]!.n, 10)).toBe(1);

      const eventRows = await client.query<{
        event_type: string;
        payload: Record<string, unknown>;
      }>(
        `SELECT event_type, payload FROM domain_events_outbox
          WHERE tenant_id = $1
            AND aggregate_id = $2
            AND event_type = 'medication_request.interaction_safety_hold_triggered.v1'`,
        [T_US, mrId],
      );
      expect(eventRows.rows.length).toBe(1);
      expect(eventRows.rows[0]!.payload.interaction_signals_status).toBe('safety_hold');
      // PR I R1 HIGH closure: prescriber_id is null on pre-active rows
      // per migration 025 CHECK clause (a) which forces
      // prescribed_by_clinician_account_id = NULL until activation. The
      // payload must surface that honestly, not paper it over with ''.
      expect(eventRows.rows[0]!.payload.prescriber_id).toBeNull();
    });
  });
});

// ===========================================================================
// Group C — State machine
// ===========================================================================

describe('engine writeback — Group C: state machine', () => {
  it('C1 draft row → MedicationRequestStateConflictError', async () => {
    const patient = await insertPatient(US_CTX);
    const product = await seedProduct(US_CTX);
    const mrId = await seedRow(US_CTX, patient, product, 'draft');

    let thrown: unknown = null;
    try {
      await evaluateInteractionsAsEngine(US_CTX, mrId, {
        interactionSignals: [],
        signalsStatus: 'clean',
        knowledgeBaseVersion: 'kb-2026.05.01',
        engineVersion: 'engine-1.0.0',
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(MedicationRequestStateConflictError);
  });

  it('C2 already-evaluated (pending_clinician_review) → conflict', async () => {
    const patient = await insertPatient(US_CTX);
    const product = await seedProduct(US_CTX);
    const mrId = await seedRow(US_CTX, patient, product, 'pending_clinician_review');

    let thrown: unknown = null;
    try {
      await evaluateInteractionsAsEngine(US_CTX, mrId, {
        interactionSignals: [],
        signalsStatus: 'clean',
        knowledgeBaseVersion: 'kb-2026.05.01',
        engineVersion: 'engine-1.0.0',
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(MedicationRequestStateConflictError);
  });
});

// ===========================================================================
// Group D — Resource resolution
// ===========================================================================

describe('engine writeback — Group D: resource resolution', () => {
  it('D1 nonexistent id → MedicationRequestNotFoundError', async () => {
    const fakeId = asMedicationRequestId(`mrx_${ulid()}`);
    let thrown: unknown = null;
    try {
      await evaluateInteractionsAsEngine(US_CTX, fakeId, {
        interactionSignals: [],
        signalsStatus: 'clean',
        knowledgeBaseVersion: 'kb-2026.05.01',
        engineVersion: 'engine-1.0.0',
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(MedicationRequestNotFoundError);
  });
});
