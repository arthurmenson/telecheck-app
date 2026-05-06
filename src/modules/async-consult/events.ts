/**
 * async-consult/events.ts — module-specific domain event emitters.
 *
 * Wraps `lib/domain-events.ts emitDomainEvent()` for the Async Consult
 * slice lifecycle events per Async Consult Slice PRD v1.0 §13 + State
 * Machines v1.1 §3 transitions implemented at Sprint 9 (TLC-021c):
 *
 *   - consult.initiated         (transition 1: INITIATED → INTAKE)
 *   - consult.intake_submitted  (transition 2: INTAKE → SUBMITTED)
 *   - consult.abandoned         (transition 3: INTAKE → ABANDONED)
 *   - consult.expired           (transition 5: ABANDONED → EXPIRED;
 *                                 scaffolded — call site deferred)
 *
 * Events are emitted inside the SAME transaction as the audit emission
 * + the aggregate state change. Rollback discards all three together
 * (I-016 outbox consistency).
 *
 * SPEC ISSUE: DOMAIN_EVENTS v5.2 doesn't yet enumerate canonical
 * event-type strings for these aggregates — same SI-004 placeholder
 * posture as the audit emitters. SI-004 closure path: when DOMAIN_EVENTS
 * v5.2 ratifies consult.* event names, replace placeholder strings
 * (string replace; trivial if names match verbatim).
 *
 * Spec references:
 *   - DOMAIN_EVENTS v5.2 (envelope shape; tenant-scoped partition key)
 *   - Async Consult Slice PRD v1.0 §13 (audit + domain event mirror)
 *   - I-016 (domain events immutable; INSERT failure aborts the tx)
 *   - I-023 (every event carries tenant_id)
 *   - docs/SI-004-Async-Consult-Audit-Events-Ratification.md
 */

import { emitDomainEvent, type DbTransaction } from '../../lib/domain-events.js';
import type { TenantId } from '../../lib/glossary.js';
import type { AccountId } from '../identity/internal/types.js';

import type { ConsultId, ConsultType, ConsultModality } from './internal/types.js';

// ---------------------------------------------------------------------------
// Aggregate constant (DOMAIN_EVENTS v5.2 partition-key derivation)
// ---------------------------------------------------------------------------

const CONSULT_AGGREGATE = 'consult';

// ---------------------------------------------------------------------------
// consult.initiated
// ---------------------------------------------------------------------------

export async function emitConsultInitiatedDomainEvent(
  tx: DbTransaction,
  args: {
    tenantId: TenantId;
    consultId: ConsultId;
    accountId: AccountId;
    consultType: ConsultType;
    modality: ConsultModality;
    currentProgramCatalogEntryId: string | null;
    occurredAt: string;
  },
): Promise<void> {
  await emitDomainEvent(tx, {
    tenant_id: args.tenantId,
    aggregate_type: CONSULT_AGGREGATE,
    aggregate_id: args.consultId,
    event_type: 'consult.initiated',
    payload: {
      consult_id: args.consultId,
      account_id: args.accountId,
      consult_type: args.consultType,
      modality: args.modality,
      current_program_catalog_entry_id: args.currentProgramCatalogEntryId,
    },
    occurred_at: args.occurredAt,
  });
}

// ---------------------------------------------------------------------------
// consult.intake_submitted
// ---------------------------------------------------------------------------

export async function emitConsultIntakeSubmittedDomainEvent(
  tx: DbTransaction,
  args: {
    tenantId: TenantId;
    consultId: ConsultId;
    accountId: AccountId;
    intakeFormSubmissionId: string;
    occurredAt: string;
  },
): Promise<void> {
  await emitDomainEvent(tx, {
    tenant_id: args.tenantId,
    aggregate_type: CONSULT_AGGREGATE,
    aggregate_id: args.consultId,
    event_type: 'consult.intake_submitted',
    payload: {
      consult_id: args.consultId,
      account_id: args.accountId,
      intake_form_submission_id: args.intakeFormSubmissionId,
    },
    occurred_at: args.occurredAt,
  });
}

// ---------------------------------------------------------------------------
// consult.abandoned
// ---------------------------------------------------------------------------

export async function emitConsultAbandonedDomainEvent(
  tx: DbTransaction,
  args: {
    tenantId: TenantId;
    consultId: ConsultId;
    accountId: AccountId;
    hoursSinceActivity: number;
    occurredAt: string;
  },
): Promise<void> {
  await emitDomainEvent(tx, {
    tenant_id: args.tenantId,
    aggregate_type: CONSULT_AGGREGATE,
    aggregate_id: args.consultId,
    event_type: 'consult.abandoned',
    payload: {
      consult_id: args.consultId,
      account_id: args.accountId,
      hours_since_activity: args.hoursSinceActivity,
    },
    occurred_at: args.occurredAt,
  });
}

// ---------------------------------------------------------------------------
// consult.expired (scaffolded; call site deferred to Sprint 11+)
// ---------------------------------------------------------------------------

export async function emitConsultExpiredDomainEvent(
  tx: DbTransaction,
  args: {
    tenantId: TenantId;
    consultId: ConsultId;
    accountId: AccountId;
    daysSinceAbandoned: number;
    occurredAt: string;
  },
): Promise<void> {
  await emitDomainEvent(tx, {
    tenant_id: args.tenantId,
    aggregate_type: CONSULT_AGGREGATE,
    aggregate_id: args.consultId,
    event_type: 'consult.expired',
    payload: {
      consult_id: args.consultId,
      account_id: args.accountId,
      days_since_abandoned: args.daysSinceAbandoned,
    },
    occurred_at: args.occurredAt,
  });
}
