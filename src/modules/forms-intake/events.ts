/**
 * forms-intake/events.ts — module-specific domain event emitters.
 *
 * Wraps `lib/domain-events.ts emitDomainEvent()` with the canonical event
 * types the Forms/Intake Engine produces per Forms/Intake Engine Slice PRD
 * v2.1 §17 (subscription handoff to Pharmacy + Refill) and Contracts Pack
 * v5.2 DOMAIN_EVENTS (`intake_response` aggregate with `submitted`,
 * `ai_evaluated`, `physician_reviewed`, `approved`, `declined` states).
 *
 * Spec references:
 *   - DOMAIN_EVENTS v5.2 — `intake_response` aggregate (event types
 *     `intake_response.submitted`, `.ai_evaluated`, `.physician_reviewed`,
 *     `.approved`, `.declined`).
 *   - Slice PRD v2.1 §17.1 — `intake_subscription_intent` event consumed
 *     by Pharmacy + Refill for subscription handoff.
 *   - Slice PRD v2.1 §8 — save-and-resume; resume state is internal
 *     persistence — not emitted as a domain event today (PostHog conversion
 *     events from §14.3 are analytics, not domain events).
 *   - INVARIANT I-016 — domain events are immutable; INSERT failure surfaces
 *     and aborts the transaction.
 *   - INVARIANT I-023 — every event carries `tenant_id`; partition key is
 *     composite `tenant_id:aggregate_id`.
 *
 * Important: NEVER emit a domain event without a transaction (`tx`). The
 * underlying `emitDomainEvent` requires it; the same transaction MUST cover
 * the aggregate state change so rollback discards the event.
 */

import { emitDomainEvent, type DbTransaction } from '../../lib/domain-events.js';
import type { TenantId } from '../../lib/glossary.js';

import type {
  FormDeploymentId,
  FormSubmissionId,
  FormTemplateId,
  FormVersionId,
  PatientId,
  ResumeStateId,
} from './internal/types.js';

// ---------------------------------------------------------------------------
// Aggregate constants
// ---------------------------------------------------------------------------

const INTAKE_RESPONSE_AGGREGATE = 'intake_response';
const RESUME_STATE_AGGREGATE = 'forms_resume_state';
const FORMS_TEMPLATE_AGGREGATE = 'forms_template';
const FORMS_DEPLOYMENT_AGGREGATE = 'forms_deployment';

// ---------------------------------------------------------------------------
// Template lifecycle event emitters
//
// SPEC ISSUE: DOMAIN_EVENTS v5.2 catalog enumerates the `intake_response`
// aggregate but does NOT canonicalize a `forms_template` aggregate or its
// lifecycle events (`forms_template.created`, `.published`, `.superseded`,
// `.archived`). The slice PRD §6 visual-builder workflows clearly require
// these — added here pending Engineering Lead ratification per EHBG §12
// SI/DSI escalation.
// ---------------------------------------------------------------------------

/**
 * Emit `forms_template.created` — tenant admin created a new draft template.
 * Per Slice PRD §6.1 visual-builder workflow. Always emitted at draft creation
 * (status='draft' per FORMS_ENGINE v5.2 lifecycle); subsequent edits do NOT
 * re-emit `created` — they emit `forms_eligibility_logic_edited` (audit) or
 * other change events as appropriate.
 */
export async function emitFormsTemplateCreated(
  tx: DbTransaction,
  args: {
    tenantId: TenantId;
    templateId: FormTemplateId;
    programId: string;
    countryOfCare: string;
    templateVersion: number;
    actorId: string;
  },
): Promise<void> {
  await emitDomainEvent(tx, {
    tenant_id: args.tenantId,
    aggregate_type: FORMS_TEMPLATE_AGGREGATE,
    aggregate_id: args.templateId,
    event_type: 'forms_template.created',
    payload: {
      template_id: args.templateId,
      program_id: args.programId,
      country_of_care: args.countryOfCare,
      template_version: args.templateVersion,
      actor_id: args.actorId,
    },
    occurred_at: new Date().toISOString(),
  });
}

/**
 * Emit `forms_template.version_published` — tenant admin promoted a draft
 * version to `published`, with optional supersession of a prior published
 * version in the same family. Per Slice PRD §6.2 publish workflow + I-013
 * immutability semantics.
 *
 * Same SPEC ISSUE caveat as emitFormsTemplateCreated: DOMAIN_EVENTS v5.2
 * doesn't enumerate this event_type on the forms_template aggregate;
 * pending Engineering Lead ratification per EHBG §12.
 *
 * Subscribers (Pharmacy / Refill / analytics): when `prior_published_version_id`
 * is non-null, deployments still pointing at the prior version remain valid
 * for in-progress submissions per FORMS_ENGINE v5.2 (no mid-flow switch);
 * new submissions get the freshly-published version. Subscribers that route
 * by deployment-active-template SHOULD treat the prior version as superseded
 * once they observe this event.
 */
export async function emitFormsTemplateVersionPublished(
  tx: DbTransaction,
  args: {
    tenantId: TenantId;
    templateId: FormTemplateId;
    versionId: FormVersionId;
    programId: string;
    countryOfCare: string;
    templateVersion: number;
    priorPublishedVersionId: FormVersionId | null;
    actorId: string;
    changeNotes: string | null;
  },
): Promise<void> {
  await emitDomainEvent(tx, {
    tenant_id: args.tenantId,
    aggregate_type: FORMS_TEMPLATE_AGGREGATE,
    aggregate_id: args.versionId,
    event_type: 'forms_template.version_published',
    payload: {
      template_id: args.templateId,
      version_id: args.versionId,
      program_id: args.programId,
      country_of_care: args.countryOfCare,
      template_version: args.templateVersion,
      prior_published_version_id: args.priorPublishedVersionId,
      actor_id: args.actorId,
      change_notes: args.changeNotes,
    },
    occurred_at: new Date().toISOString(),
  });
}

/**
 * Emit `forms_deployment.created` — tenant admin deployed a published
 * template to a program. Per Slice PRD §6.2 deployment workflow.
 *
 * Same SPEC ISSUE caveat as emitFormsTemplateCreated: DOMAIN_EVENTS v5.2
 * doesn't canonicalize the forms_deployment aggregate; pending Engineering
 * Lead ratification.
 */
export async function emitFormsDeploymentCreated(
  tx: DbTransaction,
  args: {
    tenantId: TenantId;
    deploymentId: FormDeploymentId;
    templateId: FormTemplateId;
    programId: string;
    countryOfCare: string;
    actorId: string;
  },
): Promise<void> {
  await emitDomainEvent(tx, {
    tenant_id: args.tenantId,
    aggregate_type: FORMS_DEPLOYMENT_AGGREGATE,
    aggregate_id: args.deploymentId,
    event_type: 'forms_deployment.created',
    payload: {
      deployment_id: args.deploymentId,
      template_id: args.templateId,
      program_id: args.programId,
      country_of_care: args.countryOfCare,
      actor_id: args.actorId,
    },
    occurred_at: new Date().toISOString(),
  });
}

// ---------------------------------------------------------------------------
// Lifecycle event emitters per DOMAIN_EVENTS v5.2 intake_response aggregate
// ---------------------------------------------------------------------------

/**
 * Emit `intake_response.started` — patient began an intake.
 *
 * SPEC NOTE: DOMAIN_EVENTS v5.2 lists `submitted` as the first lifecycle
 * event for `intake_response`; `started` is added for funnel-analysis
 * symmetry with PostHog `intake_started` (Slice PRD §14.3). Engineering
 * Lead should confirm this is the intended canonical event type or ratify
 * an amendment.
 */
export async function emitFormsSubmissionStarted(
  tx: DbTransaction,
  args: {
    tenantId: TenantId;
    submissionId: FormSubmissionId;
    versionId: FormVersionId;
    patientId: PatientId | null;
  },
): Promise<void> {
  await emitDomainEvent(tx, {
    tenant_id: args.tenantId,
    aggregate_type: INTAKE_RESPONSE_AGGREGATE,
    aggregate_id: args.submissionId,
    event_type: 'intake_response.started',
    payload: {
      submission_id: args.submissionId,
      version_id: args.versionId,
      patient_id: args.patientId,
    },
    occurred_at: new Date().toISOString(),
  });
}

/**
 * Emit `intake_response.submitted` — patient completed all required fields.
 * Triggers downstream eligibility evaluation per FORMS_ENGINE v5.2 intake
 * lifecycle step 3.
 */
export async function emitFormsSubmissionCompleted(
  tx: DbTransaction,
  args: {
    tenantId: TenantId;
    submissionId: FormSubmissionId;
    versionId: FormVersionId;
    patientId: PatientId;
    totalTimeMs: number;
    mode2Eligible: boolean;
  },
): Promise<void> {
  await emitDomainEvent(tx, {
    tenant_id: args.tenantId,
    aggregate_type: INTAKE_RESPONSE_AGGREGATE,
    aggregate_id: args.submissionId,
    event_type: 'intake_response.submitted',
    payload: {
      submission_id: args.submissionId,
      version_id: args.versionId,
      patient_id: args.patientId,
      total_time_ms: args.totalTimeMs,
      mode_2_eligible: args.mode2Eligible,
    },
    occurred_at: new Date().toISOString(),
  });
}

/**
 * Emit `intake_response.abandoned` — Resume State expired without
 * completion (Slice PRD §16.1 — 30-day default).
 */
export async function emitFormsSubmissionAbandoned(
  tx: DbTransaction,
  args: {
    tenantId: TenantId;
    submissionId: FormSubmissionId;
    patientId: PatientId | null;
    timePausedMs: number;
  },
): Promise<void> {
  await emitDomainEvent(tx, {
    tenant_id: args.tenantId,
    aggregate_type: INTAKE_RESPONSE_AGGREGATE,
    aggregate_id: args.submissionId,
    event_type: 'intake_response.abandoned',
    payload: {
      submission_id: args.submissionId,
      patient_id: args.patientId,
      time_paused_ms: args.timePausedMs,
    },
    occurred_at: new Date().toISOString(),
  });
}

/**
 * Emit a save-and-resume domain event.
 *
 * SPEC NOTE: DOMAIN_EVENTS v5.2 does not list a canonical event type for
 * resume-state save. The slice PRD §8.5 says save/resume is audited
 * (Category C); whether it ALSO needs a domain event depends on whether
 * any other module subscribes to it. This is emitted under the
 * `forms_resume_state` aggregate so subscribers (notification module for
 * abandonment recovery touches per §16) can wire to it. Engineering Lead
 * should ratify the aggregate and event names in DOMAIN_EVENTS.
 */
export async function emitFormsResumeStateSaved(
  tx: DbTransaction,
  args: {
    tenantId: TenantId;
    submissionId: FormSubmissionId;
    resumeStateId: ResumeStateId;
    patientId: PatientId | null;
    expiresAt: string;
  },
): Promise<void> {
  await emitDomainEvent(tx, {
    tenant_id: args.tenantId,
    aggregate_type: RESUME_STATE_AGGREGATE,
    aggregate_id: args.resumeStateId,
    event_type: 'forms_resume_state.saved',
    payload: {
      submission_id: args.submissionId,
      resume_state_id: args.resumeStateId,
      patient_id: args.patientId,
      expires_at: args.expiresAt,
    },
    occurred_at: new Date().toISOString(),
  });
}

// ---------------------------------------------------------------------------
// Subscription handoff to Pharmacy + Refill (Slice PRD §17.1)
// ---------------------------------------------------------------------------

/**
 * Emit `intake_subscription_intent` — passes subscription preferences from
 * intake to Pharmacy + Refill v2.1. Per Slice PRD §17.2 the event is
 * intent-only; the actual subscription is created by Pharmacy + Refill
 * AFTER clinical review approves.
 */
export async function emitIntakeSubscriptionIntent(
  tx: DbTransaction,
  args: {
    tenantId: TenantId;
    submissionId: FormSubmissionId;
    patientId: PatientId;
    products: ReadonlyArray<{
      product_id: string;
      quantity: number;
      subscription_cadence: 'monthly' | 'quarterly';
    }>;
    paymentMethodPreference: string;
    shippingPreference: string;
  },
): Promise<void> {
  await emitDomainEvent(tx, {
    tenant_id: args.tenantId,
    aggregate_type: INTAKE_RESPONSE_AGGREGATE,
    aggregate_id: args.submissionId,
    event_type: 'intake_subscription_intent',
    payload: {
      tenant_id: args.tenantId,
      patient_id: args.patientId,
      intake_submission_id: args.submissionId,
      products: args.products,
      payment_method_preference: args.paymentMethodPreference,
      shipping_preference: args.shippingPreference,
    },
    occurred_at: new Date().toISOString(),
  });
}
