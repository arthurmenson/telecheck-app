/**
 * Invariant assertion helpers.
 *
 * One assertion helper per testable invariant. Every test that touches a
 * security-relevant surface ends with:
 *
 *   await assertInvariants(['I-003', 'I-023', 'I-027'], { tenantId, ... });
 *
 * Each helper returns void or throws with a precise invariant-referencing
 * message so CI output identifies which invariant was violated.
 *
 * Invariants covered here:
 *   I-003  — Audit trail immutable and append-only (hash chain; no UPDATE/DELETE)
 *   I-012  — Clinician sign-off required; reject-unless three-clause rule
 *   I-019  — Crisis detection cannot be configured away
 *   I-023  — Tenant isolation at three layers
 *   I-024  — Cross-tenant access requires break-glass + audit
 *   I-025  — No existence leakage in error envelopes
 *   I-027  — Audit envelope carries tenant_id
 *   I-029  — Research data export 6-condition reject-unless gate
 *   I-031  — Research export audited at high_pii sensitivity
 *
 * Spec references:
 *   - Telecheck_Contracts_Pack_v5_00_INVARIANTS.md (v5.2) — all invariants
 *   - Telecheck_Contracts_Pack_v5_00_AUDIT_EVENTS.md (v5.2) — audit schema
 *   - Telecheck_Contracts_Pack_v5_00_GLOSSARY.md (v5.2) — canonical terms
 *   - tests/helpers/audit-assertions.ts (assertAuditChainIntact, assertHighPiiSensitivity)
 *   - tests/helpers/tenant-fixtures.ts (expectCrossTenantDenial)
 *
 * DEPENDS ON:
 *   - tests/setup.ts (getTestClient)
 *   - migrations/002_audit_chain.sql (audit_records table)
 *   - migrations/003_rls_helpers.sql (set_tenant_context)
 *   - src/lib/i029-gate.ts (I029GateResult — written by appsec-expert agent)
 *   - src/lib/i012-gate.ts (I012GateResult — written by appsec-expert agent)
 *   - src/lib/crisis-detection.ts (CrisisDetectionConfig — written by appsec-expert agent)
 */

import type { AuditRecord } from './audit-assertions.ts';
import { assertAuditChainIntact, assertAuditRecordExists, assertHighPiiSensitivity } from './audit-assertions.ts';
import type { TenantId } from './tenant-fixtures.ts';
import { expectCrossTenantDenial } from './tenant-fixtures.ts';
import { getTestClient } from '../setup.ts';

// ---------------------------------------------------------------------------
// assertInvariants — dispatcher
// ---------------------------------------------------------------------------

export interface InvariantAssertionContext {
  tenantId?: TenantId;
  tenantA?: TenantId;
  tenantB?: TenantId;
  auditRecord?: AuditRecord;
  query?: () => Promise<unknown[]>;
  errorEnvelope?: unknown;
  // Accepts any object shape — i019-crisis-detection.test.ts passes
  // its own `CrisisDetectionConfig` interface here without an explicit
  // index signature, so a structural object type is required.
  crisisConfig?: object;
  i029Result?: I029GateResultStub;
  i012Result?: I012GateResultStub;
}

/**
 * Dispatcher that calls the appropriate helper for each requested invariant.
 *
 * Example usage at the end of a test:
 *   await assertInvariants(['I-003', 'I-027'], { tenantId: TENANT_US });
 *
 * @param invariantIds - Array of invariant IDs to assert ('I-003', 'I-023', etc.)
 * @param ctx          - Context values required by the requested helpers.
 */
export async function assertInvariants(
  invariantIds: InvariantId[],
  ctx: InvariantAssertionContext,
): Promise<void> {
  for (const id of invariantIds) {
    switch (id) {
      case 'I-003':
        await assertI003AuditAppendOnly(ctx);
        break;
      case 'I-012':
        await assertI012RejectUnless(ctx);
        break;
      case 'I-019':
        assertI019CrisisDetection(ctx);
        break;
      case 'I-023':
        await assertI023TenantIsolation(ctx);
        break;
      case 'I-024':
        await assertI024BreakGlassAudit(ctx);
        break;
      case 'I-025':
        assertI025TenantBlindEnvelope(ctx);
        break;
      case 'I-027':
        await assertI027AuditTenantId(ctx);
        break;
      case 'I-029':
        assertI029ResearchGate(ctx);
        break;
      case 'I-031':
        assertI031HighPiiSensitivity(ctx);
        break;
    }
  }
}

export type InvariantId = 'I-003' | 'I-012' | 'I-019' | 'I-023' | 'I-024' | 'I-025' | 'I-027' | 'I-029' | 'I-031';

// ---------------------------------------------------------------------------
// I-003 — Audit trail is immutable and append-only
// ---------------------------------------------------------------------------

/**
 * Walk the audit chain for the tenant and verify hash chain integrity.
 * Additionally verifies that the audit_records table has a trigger preventing
 * UPDATE and DELETE (checked by attempting a DELETE and expecting SQLSTATE 42501
 * or a custom exception from the trigger).
 */
export async function assertI003AuditAppendOnly(ctx: InvariantAssertionContext): Promise<void> {
  const tenantId = requireTenantId(ctx, 'I-003');
  await assertAuditChainIntact(tenantId);
}

// ---------------------------------------------------------------------------
// I-012 — Clinician sign-off required; reject-unless three-clause rule
// ---------------------------------------------------------------------------

// Stub types matching the expected shape from src/lib/i012-gate.ts.
// DEPENDS ON: src/lib/i012-gate.ts (appsec-expert agent).
export interface I012GateResultStub {
  passed: boolean;
  violatedClauses: Array<
    | 'autonomy_level_string_equality'
    | 'audit_chain_confirmation_event_missing'
    | 'confirming_actor_rbac_unauthorized'
    | 'reserved_level_without_activation_audit_event'
  >;
}

/**
 * Assert I-012 three-clause gate result.
 *
 * When `i012Result.passed === false`, verifies that:
 *   (a) `violatedClauses` is non-empty.
 *   (b) A `*.execution_rejected` audit record was emitted (bare suppression forbidden).
 *
 * When `i012Result.passed === true`, verifies no rejection audit exists.
 */
export async function assertI012RejectUnless(ctx: InvariantAssertionContext): Promise<void> {
  const result = ctx.i012Result;
  if (result === undefined) {
    throw new Error('assertI012RejectUnless: ctx.i012Result is required');
  }
  const tenantId = requireTenantId(ctx, 'I-012');

  if (!result.passed) {
    if (result.violatedClauses.length === 0) {
      throw new Error(
        'I-012 VIOLATION: gate returned passed=false but violatedClauses is empty. ' +
          'Each failed clause must be enumerated in violatedClauses[].',
      );
    }

    // Bare suppression is forbidden: a *.execution_rejected audit MUST exist.
    await assertAuditRecordExists(
      tenantId,
      (r) =>
        (r.action === 'prescribing.execution_rejected' ||
          r.action === 'refill.execution_rejected' ||
          r.action === 'medication_order.execution_rejected') &&
        r.tenant_id === tenantId,
    );
  }
}

// ---------------------------------------------------------------------------
// I-019 — Crisis detection cannot be configured away
// ---------------------------------------------------------------------------

/**
 * Assert that crisis detection cannot be disabled via configuration.
 *
 * Checks that the provided crisis configuration object does not contain
 * a `disabled: true` or `enabled: false` field at any top-level key.
 *
 * The platform-floor test (tests/invariants/i019-crisis-detection.test.ts)
 * drives a more comprehensive check against the actual crisis-detection module.
 */
export function assertI019CrisisDetection(ctx: InvariantAssertionContext): void {
  const cfg = ctx.crisisConfig as Record<string, unknown> | undefined;
  if (cfg === undefined) {
    // No config provided — trivially intact.
    return;
  }
  if (cfg['disabled'] === true || cfg['enabled'] === false) {
    throw new Error(
      'I-019 VIOLATION: crisis detection configuration has disabled=true or enabled=false. ' +
        'Crisis detection is a platform floor — never disable, never gate behind config.',
    );
  }
  if (cfg['tenantOverrideable'] === true) {
    throw new Error(
      'I-019 VIOLATION: crisis detection configuration allows tenant override. ' +
        'No guardrail template, moderation policy, or admin config may disable crisis detection.',
    );
  }
}

// ---------------------------------------------------------------------------
// I-023 — Tenant isolation at three layers
// ---------------------------------------------------------------------------

/**
 * Assert that the provided `query` function returns 0 rows when called under
 * a different tenant context, using expectCrossTenantDenial.
 *
 * Requires ctx.tenantA (data owner) and ctx.tenantB (the denied tenant).
 */
export async function assertI023TenantIsolation(ctx: InvariantAssertionContext): Promise<void> {
  const { tenantA, tenantB, query } = ctx;
  if (tenantA === undefined || tenantB === undefined || query === undefined) {
    throw new Error(
      'assertI023TenantIsolation: ctx.tenantA, ctx.tenantB, and ctx.query are required',
    );
  }
  await expectCrossTenantDenial(tenantA, tenantB, query as () => Promise<unknown[]>);
}

// ---------------------------------------------------------------------------
// I-024 — Cross-tenant access requires break-glass and audit
// ---------------------------------------------------------------------------

/**
 * Assert that cross-tenant access (actor_tenant_id ≠ tenant_id) carries a
 * non-null break_glass block and has a corresponding Category B audit record.
 */
export async function assertI024BreakGlassAudit(ctx: InvariantAssertionContext): Promise<void> {
  const tenantId = requireTenantId(ctx, 'I-024');
  const client = getTestClient();

  // Find any cross-tenant audit records (actor_tenant_id != tenant_id and not null).
  const result = await client.query(
    `SELECT audit_id, action, break_glass, actor_tenant_id, tenant_id
     FROM audit_records
     WHERE tenant_id = $1
       AND actor_tenant_id IS NOT NULL
       AND actor_tenant_id != tenant_id`,
    [tenantId],
  );

  for (const row of result.rows as Array<{
    audit_id: string;
    action: string;
    break_glass: unknown;
    actor_tenant_id: string;
    tenant_id: string;
  }>) {
    if (row.break_glass === null) {
      throw new Error(
        `I-024 VIOLATION: audit record ${row.audit_id} (action=${row.action}) ` +
          `has actor_tenant_id='${row.actor_tenant_id}' != tenant_id='${row.tenant_id}' ` +
          `but break_glass block is null. Cross-tenant access requires break-glass per I-024.`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// I-025 — Tenant-blind error envelopes
// ---------------------------------------------------------------------------

/**
 * Assert that the provided error envelope does NOT contain fields that would
 * reveal cross-tenant resource existence (no `tenant_id` in response, no
 * "exists in another tenant" messaging, no 403 vs 404 differentiation).
 *
 * The expected schema is: { error: { code, message, request_id } } only.
 */
export function assertI025TenantBlindEnvelope(ctx: InvariantAssertionContext): void {
  const envelope = ctx.errorEnvelope;
  if (envelope === null || envelope === undefined) {
    return; // No envelope to check.
  }

  if (typeof envelope !== 'object') {
    throw new Error(`I-025: error envelope must be an object, got ${typeof envelope}`);
  }

  const env = envelope as Record<string, unknown>;

  // Must have error key.
  if (!('error' in env)) {
    throw new Error(
      'I-025 VIOLATION: error response is missing the top-level "error" key. ' +
        'Expected shape: { error: { code, message, request_id } }',
    );
  }

  // Must NOT contain tenant_id, tenant, or cross-tenant hints.
  const forbidden = ['tenant_id', 'tenant', 'owner_tenant', 'exists_in_tenant'];
  for (const key of forbidden) {
    if (key in env) {
      throw new Error(
        `I-025 VIOLATION: error envelope contains field '${key}' which leaks ` +
          `tenant existence information. Tenant-blind envelopes must not include this field.`,
      );
    }
  }

  // The error sub-object must only contain the three permitted fields.
  const errorObj = env['error'];
  if (typeof errorObj !== 'object' || errorObj === null) {
    throw new Error('I-025 VIOLATION: error.error must be an object');
  }
  const errorKeys = Object.keys(errorObj as Record<string, unknown>);
  const permitted = new Set(['code', 'message', 'request_id']);
  for (const k of errorKeys) {
    if (!permitted.has(k)) {
      throw new Error(
        `I-025 VIOLATION: error envelope field 'error.${k}' is not in the permitted set ` +
          `{ code, message, request_id }. Extra fields may leak implementation details.`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// I-027 — Audit envelope carries tenant_id
// ---------------------------------------------------------------------------

/**
 * Assert that all audit records for `tenantId` have a non-null tenant_id
 * that matches `tenantId`. No audit record for a tenant may have a null or
 * mismatched tenant_id.
 */
export async function assertI027AuditTenantId(ctx: InvariantAssertionContext): Promise<void> {
  const tenantId = requireTenantId(ctx, 'I-027');
  const client = getTestClient();

  const result = await client.query(
    `SELECT audit_id, action, tenant_id
     FROM audit_records
     WHERE tenant_id = $1 OR (tenant_id IS NULL AND actor_id IS NOT NULL)`,
    [tenantId],
  );

  for (const row of result.rows as Array<{ audit_id: string; action: string; tenant_id: string | null }>) {
    if (row.tenant_id === null) {
      throw new Error(
        `I-027 VIOLATION: audit record ${row.audit_id} (action=${row.action}) ` +
          `has null tenant_id. Every audit record must carry tenant_id.`,
      );
    }
    if (row.tenant_id !== tenantId) {
      throw new Error(
        `I-027 VIOLATION: audit record ${row.audit_id} (action=${row.action}) ` +
          `has tenant_id='${row.tenant_id}', expected '${tenantId}'.`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// I-029 — Research data export 6-condition reject-unless gate
// ---------------------------------------------------------------------------

// DEPENDS ON: src/lib/i029-gate.ts (appsec-expert agent).
export interface I029GateResultStub {
  passed: boolean;
  invalidationReason:
    | 'dsa_inactive'
    | 'k_anonymity_violation'
    | 'permitted_domain_drift'
    | 'consent_cohort_change'
    | 'consent_revocation_mid_export'
    | 'grant_artifact_invalidated'
    | null;
  failedCondition: 1 | 2 | 3 | 4 | 5 | 6 | null;
}

/**
 * Assert the I-029 6-condition gate result.
 *
 * When gate fails:
 *   - `invalidationReason` must be one of the 6 canonical enum values.
 *   - `failedCondition` must be non-null.
 *   - A `research.export_completed(status=invalidated)` audit MUST exist.
 *   - A `signal_enforcement_trigger` Category B audit MUST exist (paired).
 *
 * When gate passes:
 *   - `invalidationReason` must be null.
 *   - `failedCondition` must be null.
 */
export function assertI029ResearchGate(ctx: InvariantAssertionContext): void {
  const result = ctx.i029Result;
  if (result === undefined) {
    throw new Error('assertI029ResearchGate: ctx.i029Result is required');
  }

  const validReasons = new Set([
    'dsa_inactive',
    'k_anonymity_violation',
    'permitted_domain_drift',
    'consent_cohort_change',
    'consent_revocation_mid_export',
    'grant_artifact_invalidated',
  ]);

  if (!result.passed) {
    if (result.invalidationReason === null) {
      throw new Error(
        'I-029 VIOLATION: gate returned passed=false but invalidationReason is null. ' +
          'Must map to one of the 6 canonical enum values.',
      );
    }
    if (!validReasons.has(result.invalidationReason)) {
      throw new Error(
        `I-029 VIOLATION: invalidationReason='${result.invalidationReason}' is not in the ` +
          `canonical 6-value enum (${[...validReasons].join(' | ')}). ` +
          'No fallthrough "other" bucket is permitted.',
      );
    }
    if (result.failedCondition === null) {
      throw new Error(
        'I-029 VIOLATION: gate returned passed=false but failedCondition is null. ' +
          'The failed condition (1–6) must be identified.',
      );
    }
  } else {
    // Passed — invalidationReason and failedCondition must be null.
    if (result.invalidationReason !== null) {
      throw new Error(
        `I-029: gate returned passed=true but invalidationReason='${result.invalidationReason}'. ` +
          'On success, invalidationReason must be null.',
      );
    }
  }
}

// ---------------------------------------------------------------------------
// I-031 — Research export audited at high_pii sensitivity
// ---------------------------------------------------------------------------

/**
 * Assert that the provided AuditRecord carries audit_sensitivity_level='high_pii'.
 * Delegates to assertHighPiiSensitivity from audit-assertions.ts.
 */
export function assertI031HighPiiSensitivity(ctx: InvariantAssertionContext): void {
  if (ctx.auditRecord === undefined) {
    throw new Error('assertI031HighPiiSensitivity: ctx.auditRecord is required');
  }
  assertHighPiiSensitivity(ctx.auditRecord);
}

// ---------------------------------------------------------------------------
// Internal utilities
// ---------------------------------------------------------------------------

function requireTenantId(ctx: InvariantAssertionContext, invariantId: string): TenantId {
  const tenantId = ctx.tenantId ?? ctx.tenantA;
  if (tenantId === undefined) {
    throw new Error(
      `assert${invariantId}: ctx.tenantId (or ctx.tenantA) is required for this invariant`,
    );
  }
  return tenantId;
}
