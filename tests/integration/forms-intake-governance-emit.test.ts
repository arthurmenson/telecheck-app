/**
 * Forms-intake governance audit + domain-event emitter tests.
 *
 * Sprint 2 / TLC-006. The 2 audit emitters
 * (`emitFormsEligibilityLogicEdited`, `emitFormsApprovalGovernanceEdited`)
 * exist in `src/modules/forms-intake/audit.ts:503,540` but have ZERO
 * callers in `src/` at v0.1 — the operator-side mutation surface that
 * would invoke them lands with Admin Backend slice v1.1 (or a future
 * template-service mutation path).
 *
 * This test:
 *   1. Calls each audit emitter directly (envelope-shape coverage)
 *   2. Calls each parallel domain-event emitter directly (outbox-landing)
 *   3. Asserts Category B + standard sensitivity (audits)
 *   4. Asserts forms_version aggregate + payload shape (events)
 *
 * The audit + event emitters thus are exercised end-to-end before the
 * operator surface exists, ensuring spec compliance is verifiable
 * regardless of whether the consumer surface lands in Admin Backend,
 * a future v1.0 mutation handler, or a CLI-only operator tool.
 *
 * Spec references:
 *   - Slice PRD v2.1 §13.4 (Layer 3 eligibility-logic edits)
 *   - Slice PRD v2.1 §13.5 (Layer 4 approval-governance edits)
 *   - AUDIT_EVENTS v5.2 §Category B (governance events)
 *   - DOMAIN_EVENTS v5.2 §forms_version aggregate (placeholder per SI-003)
 *   - I-003 / I-016 / I-023 / I-027
 */

import { describe, expect, it } from 'vitest';

import type { TenantId } from '../../src/lib/glossary.ts';
import { ulid } from '../../src/lib/ulid.ts';
import {
  emitFormsApprovalGovernanceEdited as emitFormsApprovalGovernanceEditedAudit,
  emitFormsEligibilityLogicEdited as emitFormsEligibilityLogicEditedAudit,
} from '../../src/modules/forms-intake/audit.ts';
import {
  emitFormsApprovalGovernanceEdited as emitFormsApprovalGovernanceEditedEvent,
  emitFormsEligibilityLogicEdited as emitFormsEligibilityLogicEditedEvent,
} from '../../src/modules/forms-intake/events.ts';
import type { FormVersionId, PatientId } from '../../src/modules/forms-intake/internal/types.ts';
import { TENANT_US, withTenantContext } from '../helpers/tenant-fixtures.ts';
import { getTestClient } from '../setup.ts';

const T_US = TENANT_US as TenantId;

// ---------------------------------------------------------------------------
// §1 audit emitters — envelope-shape coverage
// ---------------------------------------------------------------------------

describe('forms-intake governance — §1 audit emitters', () => {
  it('§1a emitFormsEligibilityLogicEdited writes Category B audit row', async () => {
    const versionId: FormVersionId = ulid();
    const targetPatientId: PatientId = ulid();
    await withTenantContext(T_US, async () => {
      await emitFormsEligibilityLogicEditedAudit(
        {
          tenantId: T_US,
          actorId: 'op_eligibility_test',
          actorTenantId: T_US,
          countryOfCare: 'US',
          versionId,
          targetPatientId,
          changes: [{ field: 'min_age', from: 18, to: 21 }],
          clinicalImpactAssessment: 'Tightening eligibility floor — reviewed by clinical lead',
        },
        getTestClient(),
      );
    });

    const r = await getTestClient().query<{ category: string; action: string }>(
      `SELECT category, action FROM audit_records
        WHERE tenant_id = $1
          AND resource_id = $2
          AND action = 'forms_eligibility_logic_edited'`,
      [T_US, versionId],
    );
    expect(r.rows[0]).toBeDefined();
    expect(r.rows[0]!.category).toBe('B');
    expect(r.rows[0]!.action).toBe('forms_eligibility_logic_edited');
  });

  it('§1b emitFormsApprovalGovernanceEdited writes Category B audit row', async () => {
    const versionId: FormVersionId = ulid();
    const targetPatientId: PatientId = ulid();
    await withTenantContext(T_US, async () => {
      await emitFormsApprovalGovernanceEditedAudit(
        {
          tenantId: T_US,
          actorId: 'op_governance_test',
          actorTenantId: T_US,
          countryOfCare: 'US',
          versionId,
          targetPatientId,
          changes: [{ field: 'launch_state', from: 'gated', to: 'public' }],
        },
        getTestClient(),
      );
    });

    const r = await getTestClient().query<{ category: string; action: string }>(
      `SELECT category, action FROM audit_records
        WHERE tenant_id = $1
          AND resource_id = $2
          AND action = 'forms_approval_governance_edited'`,
      [T_US, versionId],
    );
    expect(r.rows[0]).toBeDefined();
    expect(r.rows[0]!.category).toBe('B');
  });
});

// ---------------------------------------------------------------------------
// §2 domain-event emitters — outbox-landing coverage
// ---------------------------------------------------------------------------

describe('forms-intake governance — §2 domain events', () => {
  it('§2a emitFormsEligibilityLogicEdited lands forms_eligibility_logic.edited in outbox', async () => {
    const versionId: FormVersionId = ulid();
    await withTenantContext(T_US, async () => {
      await emitFormsEligibilityLogicEditedEvent(getTestClient(), {
        tenantId: T_US,
        versionId,
        changes: [{ field: 'min_age', from: 18, to: 21 }],
        clinicalImpactAssessment: 'Tighten eligibility',
      });
    });

    const r = await getTestClient().query<{
      event_type: string;
      aggregate_type: string;
      payload: Record<string, unknown>;
    }>(
      `SELECT event_type, aggregate_type, payload FROM domain_events_outbox
        WHERE tenant_id = $1 AND aggregate_id = $2
          AND event_type = 'forms_eligibility_logic.edited'`,
      [T_US, versionId],
    );
    expect(r.rows[0]).toBeDefined();
    expect(r.rows[0]!.aggregate_type).toBe('forms_version');
    expect(r.rows[0]!.payload['form_version_id']).toBe(versionId);
    expect(r.rows[0]!.payload['clinical_impact_assessment']).toBe('Tighten eligibility');
  });

  it('§2b emitFormsApprovalGovernanceEdited lands forms_approval_governance.edited in outbox', async () => {
    const versionId: FormVersionId = ulid();
    await withTenantContext(T_US, async () => {
      await emitFormsApprovalGovernanceEditedEvent(getTestClient(), {
        tenantId: T_US,
        versionId,
        changes: [{ field: 'launch_state', from: 'gated', to: 'public' }],
      });
    });

    const r = await getTestClient().query<{
      aggregate_type: string;
      payload: Record<string, unknown>;
    }>(
      `SELECT aggregate_type, payload FROM domain_events_outbox
        WHERE tenant_id = $1 AND aggregate_id = $2
          AND event_type = 'forms_approval_governance.edited'`,
      [T_US, versionId],
    );
    expect(r.rows[0]).toBeDefined();
    expect(r.rows[0]!.aggregate_type).toBe('forms_version');
    expect(r.rows[0]!.payload['form_version_id']).toBe(versionId);
  });
});
