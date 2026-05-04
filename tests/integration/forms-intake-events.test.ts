/**
 * forms-intake/events.ts — direct integration tests on the 9 domain
 * event emitter wrappers.
 *
 * Until this commit each emitter was exercised only INDIRECTLY via the
 * forms-intake handler suites (forms-intake-publish, forms-intake-pause,
 * forms-intake-restore, forms-intake-submission, etc.) where the emitter
 * is one step in a larger transaction. The wrapper-level contract — that
 * each emitter populates the correct event_type, aggregate_type,
 * aggregate_id, tenant_id, and payload shape — was never directly pinned.
 *
 * Why this matters:
 *   These emitters are the CANONICAL on-the-wire shape downstream
 *   subscribers (notification module, Pharmacy + Refill, analytics
 *   pipeline) bind to. A regression in any field name or aggregate
 *   string would silently break a downstream consumer that's been
 *   shipping under a contract we didn't pin. SPEC ISSUEs flagged
 *   inline in events.ts (e.g., DOMAIN_EVENTS v5.2 doesn't enumerate
 *   `forms_template.created`) are exactly the kind of unratified
 *   strings whose pinning matters most: when the spec amendment
 *   lands, the change should be deliberate, not silent.
 *
 * Coverage in this file (9 emitters × multi-assert each):
 *
 *   §1 Template lifecycle:
 *      - emitFormsTemplateCreated → forms_template.created
 *      - emitFormsTemplateVersionPublished → forms_template.version_published
 *
 *   §2 Deployment lifecycle:
 *      - emitFormsDeploymentCreated → forms_deployment.created
 *      - emitFormsDeploymentRetired → forms_deployment.retired
 *
 *   §3 Submission lifecycle:
 *      - emitFormsSubmissionStarted → intake_response.started
 *      - emitFormsSubmissionCompleted → intake_response.submitted
 *      - emitFormsSubmissionAbandoned → intake_response.abandoned
 *
 *   §4 Save-and-resume:
 *      - emitFormsResumeStateSaved → forms_resume_state.saved
 *
 *   §5 Subscription handoff:
 *      - emitIntakeSubscriptionIntent → intake_subscription_intent
 *
 *   §6 Tenant isolation regression — each tenant sees only its own
 *      events; partition_key reflects tenant prefix.
 *
 * Spec references:
 *   - DOMAIN_EVENTS v5.2 (intake_response aggregate; event types)
 *   - Slice PRD v2.1 §6, §8, §14, §16, §17 (per-emitter contracts)
 *   - I-016 (domain events immutable; same-tx outbox pattern)
 *   - I-023 (tenant_id mandatory; partition_key tenant-prefixed)
 */

import { afterEach, describe, expect, it } from 'vitest';

import { type DbTransaction } from '../../src/lib/domain-events.ts';
import { asTenantId, type TenantId } from '../../src/lib/glossary.ts';
import { ulid } from '../../src/lib/ulid.ts';
import {
  emitFormsDeploymentCreated,
  emitFormsDeploymentRetired,
  emitFormsResumeStateSaved,
  emitFormsSubmissionAbandoned,
  emitFormsSubmissionCompleted,
  emitFormsSubmissionStarted,
  emitFormsTemplateCreated,
  emitFormsTemplateVersionPublished,
  emitIntakeSubscriptionIntent,
} from '../../src/modules/forms-intake/events.ts';
import {
  TENANT_GHANA,
  TENANT_US,
  withTenantContext as withTenantCtx,
} from '../helpers/tenant-fixtures.ts';
import { getTestClient } from '../setup.ts';

// Brand the canonical tenant strings so emitter args type-check.
const T_US: TenantId = asTenantId(TENANT_US);
const T_GHANA: TenantId = asTenantId(TENANT_GHANA);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface OutboxRow {
  event_id: string;
  tenant_id: string;
  aggregate_type: string;
  aggregate_id: string;
  event_type: string;
  partition_key: string;
  payload: Record<string, unknown>;
}

/** Cast getTestClient() to the DbTransaction shape the lib expects. */
function getTx(): DbTransaction {
  return getTestClient() as unknown as DbTransaction;
}

/**
 * Read back a single outbox row by aggregate_id under the given tenant
 * context. Each test uses a unique aggregate_id so this returns the
 * exact row the test just emitted.
 */
async function readOutboxRow(tenantId: string, aggregateId: string): Promise<OutboxRow | null> {
  return withTenantCtx(tenantId, async () => {
    const client = getTestClient();
    const { rows } = await client.query<OutboxRow>(
      `SELECT event_id, tenant_id, aggregate_type, aggregate_id, event_type,
              partition_key, payload
         FROM domain_events_outbox
        WHERE tenant_id = $1 AND aggregate_id = $2`,
      [tenantId, aggregateId],
    );
    return rows[0] ?? null;
  });
}

afterEach(() => {
  // Per-test SAVEPOINT in tests/setup.ts undoes any inserted rows.
});

// ---------------------------------------------------------------------------
// §1 Template lifecycle
// ---------------------------------------------------------------------------

describe('emitFormsTemplateCreated', () => {
  it('emits aggregate_type=forms_template + event_type=forms_template.created with correct payload', async () => {
    const tenantId = T_US;
    const templateId = ulid();
    const programId = `prog_${ulid().slice(0, 8)}`;
    const actorId = `usr_${ulid().slice(0, 8)}`;

    await withTenantCtx(tenantId, () =>
      emitFormsTemplateCreated(getTx(), {
        tenantId,
        templateId,
        programId,
        countryOfCare: 'US',
        templateVersion: 1,
        actorId,
      }),
    );

    const row = await readOutboxRow(tenantId, templateId);
    expect(row).not.toBeNull();
    expect(row!.aggregate_type).toBe('forms_template');
    expect(row!.event_type).toBe('forms_template.created');
    expect(row!.tenant_id).toBe(tenantId);
    expect(row!.aggregate_id).toBe(templateId);
    expect(row!.partition_key).toBe(`${tenantId}:${templateId}`);
    expect(row!.payload['template_id']).toBe(templateId);
    expect(row!.payload['program_id']).toBe(programId);
    expect(row!.payload['country_of_care']).toBe('US');
    expect(row!.payload['template_version']).toBe(1);
    expect(row!.payload['actor_id']).toBe(actorId);
  });
});

describe('emitFormsTemplateVersionPublished', () => {
  it('emits forms_template.version_published with version + supersession fields', async () => {
    // aggregate_id is the VERSION id (not the template id), per events.ts
    // line 139 — pin that here so a regression that re-aggregates onto
    // template_id (which would re-emit on every version of the same
    // template, conflating the family timeline) gets caught.
    const tenantId = T_US;
    const templateId = ulid();
    const versionId = ulid();
    const priorVersionId = ulid();
    const programId = `prog_${ulid().slice(0, 8)}`;
    const actorId = `usr_${ulid().slice(0, 8)}`;
    const auditId = ulid();
    const changeNotes = 'bumped clinical eligibility threshold per protocol amendment';

    await withTenantCtx(tenantId, () =>
      emitFormsTemplateVersionPublished(getTx(), {
        tenantId,
        templateId,
        versionId,
        programId,
        countryOfCare: 'US',
        templateVersion: 2,
        priorPublishedVersionId: priorVersionId,
        actorId,
        changeNotes,
        auditId,
      }),
    );

    const row = await readOutboxRow(tenantId, versionId);
    expect(row).not.toBeNull();
    expect(row!.aggregate_type).toBe('forms_template');
    expect(row!.event_type).toBe('forms_template.version_published');
    expect(row!.aggregate_id).toBe(versionId);
    expect(row!.partition_key).toBe(`${tenantId}:${versionId}`);
    expect(row!.payload['template_id']).toBe(templateId);
    expect(row!.payload['version_id']).toBe(versionId);
    expect(row!.payload['template_version']).toBe(2);
    expect(row!.payload['prior_published_version_id']).toBe(priorVersionId);
    expect(row!.payload['change_notes']).toBe(changeNotes);
    // audit_id correlates the wire event to the Category B governance
    // record per the publishVersion-r1 HIGH closure pattern (events.ts
    // §emitFormsTemplateVersionPublished JSDoc). Pin presence so a
    // regression that drops the field gets caught.
    expect(row!.payload['audit_id']).toBe(auditId);
  });

  it('handles priorPublishedVersionId=null (first published version in family)', async () => {
    const tenantId = T_US;
    const templateId = ulid();
    const versionId = ulid();

    await withTenantCtx(tenantId, () =>
      emitFormsTemplateVersionPublished(getTx(), {
        tenantId,
        templateId,
        versionId,
        programId: `prog_${ulid().slice(0, 8)}`,
        countryOfCare: 'US',
        templateVersion: 1,
        priorPublishedVersionId: null,
        actorId: `usr_${ulid().slice(0, 8)}`,
        changeNotes: null,
        auditId: ulid(),
      }),
    );

    const row = await readOutboxRow(tenantId, versionId);
    expect(row).not.toBeNull();
    expect(row!.payload['prior_published_version_id']).toBeNull();
    expect(row!.payload['change_notes']).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// §2 Deployment lifecycle
// ---------------------------------------------------------------------------

describe('emitFormsDeploymentCreated', () => {
  it('emits forms_deployment.created with template + program linkage', async () => {
    const tenantId = T_US;
    const deploymentId = ulid();
    const templateId = ulid();
    const programId = `prog_${ulid().slice(0, 8)}`;

    await withTenantCtx(tenantId, () =>
      emitFormsDeploymentCreated(getTx(), {
        tenantId,
        deploymentId,
        templateId,
        programId,
        countryOfCare: 'US',
        actorId: `usr_${ulid().slice(0, 8)}`,
      }),
    );

    const row = await readOutboxRow(tenantId, deploymentId);
    expect(row).not.toBeNull();
    expect(row!.aggregate_type).toBe('forms_deployment');
    expect(row!.event_type).toBe('forms_deployment.created');
    expect(row!.aggregate_id).toBe(deploymentId);
    expect(row!.partition_key).toBe(`${tenantId}:${deploymentId}`);
    expect(row!.payload['template_id']).toBe(templateId);
    expect(row!.payload['program_id']).toBe(programId);
  });
});

describe('emitFormsDeploymentRetired', () => {
  it('emits forms_deployment.retired with audit_id correlation + template/program linkage', async () => {
    // Note: events.ts retire emitter does NOT carry a `retiredAt`
    // payload field — the occurred_at on the envelope IS the retire
    // timestamp; payload-side retired_at would duplicate. Pinned here
    // so a regression that adds a separate retired_at gets caught.
    const tenantId = T_US;
    const deploymentId = ulid();
    const templateId = ulid();
    const programId = `prog_${ulid().slice(0, 8)}`;
    const actorId = `usr_${ulid().slice(0, 8)}`;
    const auditId = ulid();

    await withTenantCtx(tenantId, () =>
      emitFormsDeploymentRetired(getTx(), {
        tenantId,
        deploymentId,
        templateId,
        programId,
        countryOfCare: 'US',
        actorId,
        auditId,
      }),
    );

    const row = await readOutboxRow(tenantId, deploymentId);
    expect(row).not.toBeNull();
    expect(row!.event_type).toBe('forms_deployment.retired');
    expect(row!.aggregate_type).toBe('forms_deployment');
    expect(row!.aggregate_id).toBe(deploymentId);
    expect(row!.payload['deployment_id']).toBe(deploymentId);
    expect(row!.payload['template_id']).toBe(templateId);
    expect(row!.payload['program_id']).toBe(programId);
    expect(row!.payload['country_of_care']).toBe('US');
    expect(row!.payload['actor_id']).toBe(actorId);
    expect(row!.payload['audit_id']).toBe(auditId);
    // Defensive: payload should NOT carry retired_at (envelope's
    // occurred_at is canonical).
    expect(row!.payload).not.toHaveProperty('retired_at');
  });
});

// ---------------------------------------------------------------------------
// §3 Submission lifecycle
// ---------------------------------------------------------------------------

describe('emitFormsSubmissionStarted', () => {
  it('emits intake_response.started under intake_response aggregate', async () => {
    const tenantId = T_US;
    const submissionId = ulid();
    const versionId = ulid();
    const patientId = `pat_${ulid().slice(0, 8)}`;

    await withTenantCtx(tenantId, () =>
      emitFormsSubmissionStarted(getTx(), {
        tenantId,
        submissionId,
        versionId,
        patientId,
      }),
    );

    const row = await readOutboxRow(tenantId, submissionId);
    expect(row).not.toBeNull();
    expect(row!.aggregate_type).toBe('intake_response');
    expect(row!.event_type).toBe('intake_response.started');
    expect(row!.aggregate_id).toBe(submissionId);
    expect(row!.payload['submission_id']).toBe(submissionId);
    expect(row!.payload['version_id']).toBe(versionId);
    expect(row!.payload['patient_id']).toBe(patientId);
  });

  it('handles patientId=null (anonymous flow forward-compat)', async () => {
    const tenantId = T_US;
    const submissionId = ulid();

    await withTenantCtx(tenantId, () =>
      emitFormsSubmissionStarted(getTx(), {
        tenantId,
        submissionId,
        versionId: ulid(),
        patientId: null,
      }),
    );

    const row = await readOutboxRow(tenantId, submissionId);
    expect(row).not.toBeNull();
    expect(row!.payload['patient_id']).toBeNull();
  });
});

describe('emitFormsSubmissionCompleted', () => {
  it('emits intake_response.submitted with timing + mode_2_eligible flag', async () => {
    const tenantId = T_US;
    const submissionId = ulid();

    await withTenantCtx(tenantId, () =>
      emitFormsSubmissionCompleted(getTx(), {
        tenantId,
        submissionId,
        versionId: ulid(),
        patientId: `pat_${ulid().slice(0, 8)}`,
        totalTimeMs: 12345,
        mode2Eligible: true,
      }),
    );

    const row = await readOutboxRow(tenantId, submissionId);
    expect(row).not.toBeNull();
    expect(row!.event_type).toBe('intake_response.submitted');
    expect(row!.payload['total_time_ms']).toBe(12345);
    expect(row!.payload['mode_2_eligible']).toBe(true);
  });

  it('preserves mode2Eligible=false in payload (boolean fidelity)', async () => {
    const tenantId = T_US;
    const submissionId = ulid();
    await withTenantCtx(tenantId, () =>
      emitFormsSubmissionCompleted(getTx(), {
        tenantId,
        submissionId,
        versionId: ulid(),
        patientId: `pat_${ulid().slice(0, 8)}`,
        totalTimeMs: 0,
        mode2Eligible: false,
      }),
    );
    const row = await readOutboxRow(tenantId, submissionId);
    expect(row!.payload['mode_2_eligible']).toBe(false);
  });
});

describe('emitFormsSubmissionAbandoned', () => {
  it('emits intake_response.abandoned with timePausedMs', async () => {
    const tenantId = T_US;
    const submissionId = ulid();
    const patientId = `pat_${ulid().slice(0, 8)}`;

    await withTenantCtx(tenantId, () =>
      emitFormsSubmissionAbandoned(getTx(), {
        tenantId,
        submissionId,
        patientId,
        timePausedMs: 30 * 24 * 60 * 60 * 1000,
      }),
    );

    const row = await readOutboxRow(tenantId, submissionId);
    expect(row).not.toBeNull();
    expect(row!.event_type).toBe('intake_response.abandoned');
    expect(row!.payload['time_paused_ms']).toBe(30 * 24 * 60 * 60 * 1000);
    expect(row!.payload['patient_id']).toBe(patientId);
  });

  it('handles patientId=null (anonymous flow abandonment)', async () => {
    const tenantId = T_US;
    const submissionId = ulid();
    await withTenantCtx(tenantId, () =>
      emitFormsSubmissionAbandoned(getTx(), {
        tenantId,
        submissionId,
        patientId: null,
        timePausedMs: 100,
      }),
    );
    const row = await readOutboxRow(tenantId, submissionId);
    expect(row!.payload['patient_id']).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// §4 Save-and-resume
// ---------------------------------------------------------------------------

describe('emitFormsResumeStateSaved', () => {
  it('emits forms_resume_state.saved under forms_resume_state aggregate (NOT intake_response)', async () => {
    // The aggregate distinction is important: subscribers to
    // intake_response.* should NOT see resume-state events. Pinning
    // the aggregate type prevents an accidental cross-aggregate leak.
    const tenantId = T_US;
    const submissionId = ulid();
    const resumeStateId = ulid();
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

    await withTenantCtx(tenantId, () =>
      emitFormsResumeStateSaved(getTx(), {
        tenantId,
        submissionId,
        resumeStateId,
        patientId: `pat_${ulid().slice(0, 8)}`,
        expiresAt,
      }),
    );

    // aggregate_id is the resumeStateId, not the submissionId — pin it.
    const row = await readOutboxRow(tenantId, resumeStateId);
    expect(row).not.toBeNull();
    expect(row!.aggregate_type).toBe('forms_resume_state');
    expect(row!.event_type).toBe('forms_resume_state.saved');
    expect(row!.aggregate_id).toBe(resumeStateId);
    expect(row!.partition_key).toBe(`${tenantId}:${resumeStateId}`);
    expect(row!.payload['submission_id']).toBe(submissionId);
    expect(row!.payload['resume_state_id']).toBe(resumeStateId);
    expect(row!.payload['expires_at']).toBe(expiresAt);
  });
});

// ---------------------------------------------------------------------------
// §5 Subscription handoff (Pharmacy + Refill consumer)
// ---------------------------------------------------------------------------

describe('emitIntakeSubscriptionIntent', () => {
  it('emits intake_subscription_intent under intake_response aggregate with products + preferences', async () => {
    const tenantId = T_US;
    const submissionId = ulid();
    const patientId = `pat_${ulid().slice(0, 8)}`;
    const products = [
      { product_id: 'prod_glp1_001', quantity: 1, subscription_cadence: 'monthly' as const },
      { product_id: 'prod_b12_002', quantity: 2, subscription_cadence: 'quarterly' as const },
    ];

    await withTenantCtx(tenantId, () =>
      emitIntakeSubscriptionIntent(getTx(), {
        tenantId,
        submissionId,
        patientId,
        products,
        paymentMethodPreference: 'card_on_file',
        shippingPreference: 'home_delivery',
      }),
    );

    const row = await readOutboxRow(tenantId, submissionId);
    expect(row).not.toBeNull();
    expect(row!.aggregate_type).toBe('intake_response');
    expect(row!.event_type).toBe('intake_subscription_intent');
    expect(row!.payload['intake_submission_id']).toBe(submissionId);
    expect(row!.payload['patient_id']).toBe(patientId);
    expect(row!.payload['payment_method_preference']).toBe('card_on_file');
    expect(row!.payload['shipping_preference']).toBe('home_delivery');
    // Products array preserved verbatim; consumer (Pharmacy + Refill)
    // depends on the exact field shape per Slice PRD §17.2.
    expect(row!.payload['products']).toEqual(products);
  });

  it('payload also includes tenant_id at the payload-level (consumer convenience)', async () => {
    // The emitter explicitly puts tenant_id INSIDE the payload (in
    // addition to the envelope-level tenant_id) so subscribers
    // examining only the payload don't have to climb the envelope.
    // Pin the duplication so a future "DRY-it-up" refactor doesn't
    // accidentally drop the payload-level field that consumers may
    // depend on.
    const tenantId = T_US;
    const submissionId = ulid();
    await withTenantCtx(tenantId, () =>
      emitIntakeSubscriptionIntent(getTx(), {
        tenantId,
        submissionId,
        patientId: `pat_${ulid().slice(0, 8)}`,
        products: [],
        paymentMethodPreference: 'card_on_file',
        shippingPreference: 'home_delivery',
      }),
    );
    const row = await readOutboxRow(tenantId, submissionId);
    expect(row!.payload['tenant_id']).toBe(tenantId);
  });
});

// ---------------------------------------------------------------------------
// §6 Tenant isolation regression
// ---------------------------------------------------------------------------

describe('events.ts — tenant isolation regression', () => {
  it('US-emitted event is invisible to Ghana-context reader (RLS on outbox)', async () => {
    // Honest RLS test: insert under US, then query WITHOUT a tenant_id
    // WHERE filter under Ghana context. If RLS is wired correctly on
    // domain_events_outbox, the SELECT returns 0 rows because the row's
    // `tenant_id = 'Telecheck-US'` doesn't match the active session's
    // `app.current_tenant_id = 'Telecheck-Ghana'`. A regression that
    // disabled RLS on the outbox would return 1 row here (the US row
    // visible from Ghana context) — that's the failure mode we pin.
    const submissionId = ulid();
    await withTenantCtx(T_US, () =>
      emitFormsSubmissionStarted(getTx(), {
        tenantId: T_US,
        submissionId,
        versionId: ulid(),
        patientId: `pat_${ulid().slice(0, 8)}`,
      }),
    );

    // Query under Ghana context with NO tenant_id filter — RLS alone
    // must hide the US row.
    const client = getTestClient();
    await withTenantCtx(T_GHANA, async () => {
      const { rows } = await client.query<{ tenant_id: string }>(
        `SELECT tenant_id FROM domain_events_outbox WHERE aggregate_id = $1`,
        [submissionId],
      );
      expect(rows).toHaveLength(0);
    });

    // Sanity counterpart: same query under US context returns the row
    // (proving the row was inserted and the rejection above is RLS-
    // specific, not a "row never existed" false positive).
    await withTenantCtx(T_US, async () => {
      const { rows } = await client.query<{ tenant_id: string }>(
        `SELECT tenant_id FROM domain_events_outbox WHERE aggregate_id = $1`,
        [submissionId],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]!.tenant_id).toBe(T_US);
    });
  });

  it('different tenants emitting the same aggregate_id produce DISTINCT partition_keys', async () => {
    const sharedAggregateId = ulid();

    await withTenantCtx(T_US, () =>
      emitFormsSubmissionStarted(getTx(), {
        tenantId: T_US,
        submissionId: sharedAggregateId,
        versionId: ulid(),
        patientId: `pat_${ulid().slice(0, 8)}`,
      }),
    );
    await withTenantCtx(T_GHANA, () =>
      emitFormsSubmissionStarted(getTx(), {
        tenantId: T_GHANA,
        submissionId: sharedAggregateId,
        versionId: ulid(),
        patientId: `pat_${ulid().slice(0, 8)}`,
      }),
    );

    const usRow = await readOutboxRow(T_US, sharedAggregateId);
    const ghRow = await readOutboxRow(T_GHANA, sharedAggregateId);
    expect(usRow).not.toBeNull();
    expect(ghRow).not.toBeNull();
    expect(usRow!.partition_key).toBe(`${T_US}:${sharedAggregateId}`);
    expect(ghRow!.partition_key).toBe(`${T_GHANA}:${sharedAggregateId}`);
    expect(usRow!.partition_key).not.toBe(ghRow!.partition_key);
  });
});
