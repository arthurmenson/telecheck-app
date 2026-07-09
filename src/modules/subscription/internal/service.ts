/**
 * subscription/internal/service.ts — transition engine + repository for the
 * Subscription slice (State Machines v1.1 §15 over CDM v1.2 §4.7/§4.8).
 *
 * Composition contract (canonical write stack; async-consult v1 +
 * med-interaction precedents): the CALLER owns
 *   withTransaction / withIdempotentExecution → withTenantContext →
 *   [withActorContext] → <service function>
 * and each service function owns the INNERMOST withDbRole elevation around
 * its SQL, then emits the §15 audit record AFTER withDbRole returns (same
 * tx, restored app role — the latent-defect discipline: audits are never
 * emitted inside the elevated block).
 *
 * Write path: direct INSERT/UPDATE under the migration 075 slice roles
 * (Pharmacy + Refill v2.1 §8 prescribes no SECDEF wrappers — see the 075
 * header WRITE-PATH NOTE). Guard failures RETURN outcome objects (never
 * throw) so the caller can commit the transaction WITH the rejection audit
 * (I-003: bare suppression on rejection forbidden; a rollback would
 * suppress the trail).
 *
 * State-guard defense-in-depth: the UPDATE re-checks `status = <from>` AND
 * `version = <read version>` in its WHERE clause under a prior
 * SELECT … FOR UPDATE, so no interleaved writer can commit an unratified
 * transition (CDM §4.7 optimistic-concurrency `version` column).
 *
 * Spec references: State Machines v1.1 §15 (+§16 cross-machine rows),
 * CDM v1.2 §4.7/§4.8, Pharmacy + Refill v2.1 §8, OpenAPI v0.2 §20,
 * I-003 / I-023 / I-025 / I-027, migrations/075-077.
 */

import type { DbClient } from '../../../lib/db.js';
import { ulid } from '../../../lib/ulid.js';
import { withDbRole, type SliceRole } from '../../../lib/with-db-role.js';
import {
  emitSubscriptionCreatedAudit,
  emitSubscriptionTransitionAudit,
  emitSubscriptionTransitionRejectedAudit,
} from '../audit.js';

import {
  cadenceInterval,
  checkTransition,
  isValidPauseWindow,
  TRANSITION_TABLE,
  type SubscriptionTransition,
} from './state-machine.js';
import type {
  SubscriptionActorType,
  SubscriptionCadence,
  SubscriptionEventType,
  SubscriptionRow,
  SubscriptionStatus,
} from './types.js';

// ---------------------------------------------------------------------------
// Actor + outcome shapes
// ---------------------------------------------------------------------------

export interface SubscriptionActor {
  /** CDM §4.8 actor_type. HTTP handlers map ActorRole tenant_admin →
   *  'tenant_operator' (OpenAPI §20 "tenant operator"); platform_admin is
   *  NOT permitted on write transitions (cross-tenant writes are break-glass
   *  territory per I-024 — no §20 write endpoint grants it). */
  type: SubscriptionActorType;
  /** Verified actor identity (SI-010 trust anchor); null ONLY for system. */
  id: string | null;
}

export type TransitionOutcome =
  | { outcome: 'transitioned'; row: SubscriptionRow; eventId: string | null }
  | { outcome: 'not_found' }
  | {
      outcome: 'invalid_state';
      currentStatus: SubscriptionStatus;
      expectedFrom: SubscriptionStatus;
    }
  | { outcome: 'guard_failed'; reason: string };

export interface TransitionContext {
  tenantId: string;
  countryOfCare: string;
  /** actor_tenant_id for the audit envelope (resolveActorTenantIdForAudit). */
  actorTenantIdForAudit: string | null;
}

/** Slice-role selection per §15 actor class (075 role comments). */
function roleForActor(actor: SubscriptionActor): SliceRole {
  switch (actor.type) {
    case 'patient':
    case 'tenant_operator':
      return 'subscription_patient_manager';
    case 'clinician':
      return 'subscription_clinician_reviewer';
    case 'system':
      return 'subscription_system_scheduler';
    case 'platform_admin':
      // Reads route through subscription_staff_reader; write transitions
      // reject platform_admin BEFORE role selection (checkTransition).
      return 'subscription_staff_reader';
  }
}

// ---------------------------------------------------------------------------
// Row helpers
// ---------------------------------------------------------------------------

const SUBSCRIPTION_COLUMNS =
  'id, tenant_id, patient_id, product_id, prescription_id, cadence, unit_price, ' +
  'currency, status, started_at, paused_at, pause_until, cancelled_at, ' +
  'cancel_reason, next_renewal_at, last_fulfilled_at, preauth_window_months, ' +
  'preauth_renewals_remaining, payment_method_id, version, created_at, updated_at';

async function insertSubscriptionEvent(
  tx: DbClient,
  args: {
    tenantId: string;
    subscriptionId: string;
    eventType: SubscriptionEventType;
    eventData: Record<string, unknown>;
    actor: SubscriptionActor;
  },
): Promise<string> {
  const eventId = `sue_${ulid()}`;
  await tx.query(
    `INSERT INTO subscription_events
       (id, tenant_id, subscription_id, event_type, event_data, actor_type, actor_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      eventId,
      args.tenantId,
      args.subscriptionId,
      args.eventType,
      JSON.stringify(args.eventData),
      args.actor.type,
      args.actor.id,
    ],
  );
  return eventId;
}

// ---------------------------------------------------------------------------
// Creation (DRAFT row + `created` event; CDM §4.7 + §4.8)
//
// NOTE (HTTP surface): POST /subscriptions is ratified under the OpenAPI
// v0.2 PAYMENTS module (checkout orchestration), which is not implemented
// in this repo — this function is the stable in-process target for that
// slice (async-consult "exported service functions, no premature HTTP"
// precedent). Pricing (unit_price/currency) is supplied by the caller (the
// checkout orchestration resolves it from the product catalog + CCR); this
// module does NOT read product_catalog directly (ADR-001 module boundary —
// the composite FK enforces existence + tenant coherence at the DB layer).
// ---------------------------------------------------------------------------

export interface CreateSubscriptionDraftArgs {
  ctx: TransitionContext;
  actor: SubscriptionActor; // patient or tenant_operator
  patientId: string;
  productId: string;
  /** Canonical medication_request binding (DB column `prescription_id` is
   *  CDM-verbatim; see migration 076 GLOSSARY TENSION note). */
  medicationRequestId: string;
  cadence: SubscriptionCadence;
  unitPrice: string; // decimal string, e.g. '199.00'
  currency: string;
  preauthWindowMonths: number;
  preauthRenewalsRemaining: number;
  paymentMethodId: string | null;
}

export type CreateSubscriptionOutcome =
  | { outcome: 'created'; row: SubscriptionRow; eventId: string }
  | { outcome: 'guard_failed'; reason: string };

export async function createSubscriptionDraft(
  tx: DbClient,
  args: CreateSubscriptionDraftArgs,
): Promise<CreateSubscriptionOutcome> {
  if (args.actor.type !== 'patient' && args.actor.type !== 'tenant_operator') {
    return { outcome: 'guard_failed', reason: 'actor_not_permitted' };
  }

  const subscriptionId = `sub_${ulid()}`;

  const result = await withDbRole(tx, 'subscription_patient_manager', async () => {
    const inserted = await tx.query<SubscriptionRow>(
      `INSERT INTO subscriptions
         (id, tenant_id, patient_id, product_id, prescription_id, cadence,
          unit_price, currency, status, started_at, preauth_window_months,
          preauth_renewals_remaining, payment_method_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'DRAFT', NOW(), $9, $10, $11)
       RETURNING ${SUBSCRIPTION_COLUMNS}`,
      [
        subscriptionId,
        args.ctx.tenantId,
        args.patientId,
        args.productId,
        args.medicationRequestId,
        args.cadence,
        args.unitPrice,
        args.currency,
        args.preauthWindowMonths,
        args.preauthRenewalsRemaining,
        args.paymentMethodId,
      ],
    );
    const row = inserted.rows[0] as SubscriptionRow;
    const eventId = await insertSubscriptionEvent(tx, {
      tenantId: args.ctx.tenantId,
      subscriptionId,
      eventType: 'created',
      eventData: {
        product_id: args.productId,
        medication_request_id: args.medicationRequestId,
        cadence: args.cadence,
      },
      actor: args.actor,
    });
    return { row, eventId };
  });

  // Same-tx Cat C audit under the restored app role (I-003 discipline).
  await emitSubscriptionCreatedAudit(
    {
      tenantId: args.ctx.tenantId,
      subscriptionId,
      patientId: args.patientId,
      actorType: args.actor.type,
      actorId: args.actor.id ?? 'system',
      actorTenantId: args.ctx.actorTenantIdForAudit,
      countryOfCare: args.ctx.countryOfCare,
      detail: {
        product_id: args.productId,
        medication_request_id: args.medicationRequestId,
        cadence: args.cadence,
        payment_provider_posture: 'mock_local_dev',
      },
    },
    tx,
  );

  return { outcome: 'created', row: result.row, eventId: result.eventId };
}

// ---------------------------------------------------------------------------
// Generic §15 transition executor
// ---------------------------------------------------------------------------

export interface ExecuteTransitionArgs {
  ctx: TransitionContext;
  actor: SubscriptionActor;
  subscriptionId: string;
  transition: SubscriptionTransition;
  /** Recorded on the subscription_events row (and audit detail). */
  eventData?: Record<string, unknown>;
  /** pause_request only — validated against the 90-day window. */
  pauseUntil?: Date;
  /** cancel_request / clinician_terminate — persisted to cancel_reason. */
  cancelReason?: string;
  /** switch_approve only — the new bindings + pricing (§15: "update
   *  product_id, prescription_id, pricing"; cadence preserved per PRD §8.4). */
  switchTo?: {
    productId: string;
    medicationRequestId: string;
    unitPrice: string;
  };
}

/** Per-transition SET fragments. $1=id, $2=expected version; $3+ are
 *  transition-specific params appended in order. All fragments bump
 *  version + updated_at. */
function updateSqlFor(
  transition: SubscriptionTransition,
  cadence: SubscriptionCadence,
): { setSql: string; extraParams: (args: ExecuteTransitionArgs) => unknown[] } {
  const interval = cadenceInterval(cadence);
  switch (transition) {
    case 'clinician_approval':
      return {
        setSql: `status = 'ACTIVE', next_renewal_at = NOW() + INTERVAL '${interval}'`,
        extraParams: () => [],
      };
    case 'clinician_decline':
      return { setSql: `status = 'DECLINED'`, extraParams: () => [] };
    case 'period_end':
      return { setSql: `status = 'FULFILLING'`, extraParams: () => [] };
    case 'pause_request':
      return {
        setSql: `status = 'PAUSED', paused_at = NOW(), pause_until = $3, next_renewal_at = NULL`,
        extraParams: (a) => [a.pauseUntil],
      };
    case 'switch_request':
      return { setSql: `status = 'SWITCHING'`, extraParams: () => [] };
    case 'cancel_request':
      return {
        setSql: `status = 'CANCELLATION_PENDING', cancel_reason = $3`,
        extraParams: (a) => [a.cancelReason ?? null],
      };
    case 'safety_signal_critical':
      return { setSql: `status = 'SAFETY_HOLD', next_renewal_at = NULL`, extraParams: () => [] };
    case 'payment_failed_terminal':
      return {
        setSql: `status = 'PAYMENT_FAILED_TERMINAL', next_renewal_at = NULL`,
        extraParams: () => [],
      };
    case 'complete':
      // Decrement preauth_renewals_remaining per §15; floor at 0 so the
      // durable CHECK (>= 0) can never fire from the ratified transition
      // (preauth-exhausted renewals route through clinician review on the
      // REFILL side per PRD §8.4 — refill wiring is a named follow-up).
      return {
        setSql:
          `status = 'ACTIVE', last_fulfilled_at = NOW(), ` +
          `preauth_renewals_remaining = GREATEST(preauth_renewals_remaining - 1, 0), ` +
          `next_renewal_at = NOW() + INTERVAL '${interval}'`,
        extraParams: () => [],
      };
    case 'resume':
      return {
        setSql:
          `status = 'ACTIVE', paused_at = NULL, pause_until = NULL, ` +
          `next_renewal_at = NOW() + INTERVAL '${interval}'`,
        extraParams: () => [],
      };
    case 'pause_expires':
      return {
        setSql:
          `status = 'CANCELLED', cancelled_at = NOW(), ` +
          `cancel_reason = COALESCE(cancel_reason, 'pause_expired')`,
        extraParams: () => [],
      };
    case 'switch_approve':
      return {
        setSql: `status = 'ACTIVE', product_id = $3, prescription_id = $4, unit_price = $5`,
        extraParams: (a) => [
          a.switchTo?.productId,
          a.switchTo?.medicationRequestId,
          a.switchTo?.unitPrice,
        ],
      };
    case 'switch_decline':
      return { setSql: `status = 'ACTIVE'`, extraParams: () => [] };
    case 'end_period':
      return { setSql: `status = 'CANCELLED', cancelled_at = NOW()`, extraParams: () => [] };
    case 'clinician_release':
      return {
        setSql: `status = 'ACTIVE', next_renewal_at = NOW() + INTERVAL '${interval}'`,
        extraParams: () => [],
      };
    case 'clinician_terminate':
      return {
        setSql:
          `status = 'CANCELLED', cancelled_at = NOW(), ` +
          `cancel_reason = COALESCE($3, 'clinical_termination')`,
        extraParams: (a) => [a.cancelReason ?? null],
      };
  }
}

/**
 * Execute a §15 transition. Outcomes:
 *   - transitioned: row updated + subscription_events row (when the CDM
 *     §4.8 enum has a value for the transition) + success audit — same tx.
 *   - not_found: zero rows visible (absent OR cross-tenant OR, for patient
 *     actors, not-owned) — caller maps to tenant-blind 404 (I-025). No audit.
 *   - invalid_state: row exists but is not in the transition's from-state —
 *     caller maps to 409. REJECTION audit emitted (I-003 — commit the tx).
 *   - guard_failed: transition-specific guard rejected (pause window,
 *     missing switch bindings, payment posture) — caller maps to 400/409.
 *     REJECTION audit emitted for state-machine-level guards.
 */
export async function executeSubscriptionTransition(
  tx: DbClient,
  args: ExecuteTransitionArgs,
): Promise<TransitionOutcome> {
  const spec = TRANSITION_TABLE[args.transition];
  const role = roleForActor(args.actor);

  // Phase 1 — locked read (self-scoped for patient actors: a patient can
  // only ever transition their OWN subscription; other patients' rows are
  // indistinguishable from absent per I-025).
  const selfScope = args.actor.type === 'patient' ? 'AND patient_id = $2' : '';
  const readParams: unknown[] =
    args.actor.type === 'patient' ? [args.subscriptionId, args.actor.id] : [args.subscriptionId];

  const current = await withDbRole(tx, role, async () => {
    const r = await tx.query<SubscriptionRow>(
      `SELECT ${SUBSCRIPTION_COLUMNS} FROM subscriptions
        WHERE id = $1 ${selfScope}
        FOR UPDATE`,
      readParams,
    );
    return r.rows[0];
  });

  if (current === undefined) {
    return { outcome: 'not_found' };
  }

  // Phase 2 — pure state-machine guard.
  const check = checkTransition(args.transition, current.status, args.actor.type);
  if (!check.ok) {
    if (check.reason === 'invalid_from_state') {
      await emitRejection(tx, args, current);
      return {
        outcome: 'invalid_state',
        currentStatus: current.status,
        expectedFrom: spec.from,
      };
    }
    return { outcome: 'guard_failed', reason: check.reason ?? 'actor_not_permitted' };
  }

  // Phase 3 — transition-specific guards.
  if (args.transition === 'pause_request') {
    if (args.pauseUntil === undefined || !isValidPauseWindow(new Date(), args.pauseUntil)) {
      return { outcome: 'guard_failed', reason: 'invalid_pause_duration' };
    }
  }
  if (args.transition === 'switch_approve') {
    if (args.switchTo === undefined) {
      return { outcome: 'guard_failed', reason: 'switch_bindings_required' };
    }
  }
  if (args.transition === 'period_end') {
    // §15 guard: "next_renewal_at reached AND payment method valid AND
    // interaction engine clear". Payment validity under the mock_local_dev
    // staging posture = a payment method handle is present (the real
    // adapter is the standing Track-5 gap). The renewal-time interaction-
    // engine re-check is a named follow-up (cross-module event wiring —
    // module README §Deferred). Fail-closed on both persisted guards.
    if (current.payment_method_id === null) {
      await emitRejection(tx, args, current, 'payment_method_missing');
      return { outcome: 'guard_failed', reason: 'payment_method_missing' };
    }
    if (current.next_renewal_at === null || current.next_renewal_at.getTime() > Date.now()) {
      await emitRejection(tx, args, current, 'renewal_not_due');
      return { outcome: 'guard_failed', reason: 'renewal_not_due' };
    }
  }

  // Phase 4 — durable UPDATE with from-state + version re-check.
  const { setSql, extraParams } = updateSqlFor(args.transition, current.cadence);
  const updated = await withDbRole(tx, role, async () => {
    const r = await tx.query<SubscriptionRow>(
      `UPDATE subscriptions
          SET ${setSql}, version = version + 1, updated_at = NOW()
        WHERE id = $1 AND status = '${spec.from}' AND version = $2
        RETURNING ${SUBSCRIPTION_COLUMNS}`,
      [args.subscriptionId, current.version, ...extraParams(args)],
    );
    return r.rows[0];
  });

  if (updated === undefined) {
    // Unreachable under FOR UPDATE (the lock serializes writers); kept as a
    // defense-in-depth backstop for a future lock-dropping refactor.
    return {
      outcome: 'invalid_state',
      currentStatus: current.status,
      expectedFrom: spec.from,
    };
  }

  // Phase 5 — CDM §4.8 event row (when the ratified enum covers this
  // transition; see the SPEC GAP note in state-machine.ts).
  let eventId: string | null = null;
  if (spec.eventType !== null) {
    eventId = await withDbRole(tx, role, async () =>
      insertSubscriptionEvent(tx, {
        tenantId: args.ctx.tenantId,
        subscriptionId: args.subscriptionId,
        eventType: spec.eventType as SubscriptionEventType,
        eventData: args.eventData ?? {},
        actor: args.actor,
      }),
    );
  }

  // Phase 6 — same-tx success audit under the restored app role.
  await emitSubscriptionTransitionAudit(
    args.transition,
    {
      tenantId: args.ctx.tenantId,
      subscriptionId: args.subscriptionId,
      patientId: updated.patient_id,
      actorType: args.actor.type,
      actorId: args.actor.id ?? 'system',
      actorTenantId: args.ctx.actorTenantIdForAudit,
      countryOfCare: args.ctx.countryOfCare,
      detail: {
        from_status: spec.from,
        to_status: spec.to,
        ...(args.eventData ?? {}),
      },
    },
    tx,
  );

  return { outcome: 'transitioned', row: updated, eventId };
}

async function emitRejection(
  tx: DbClient,
  args: ExecuteTransitionArgs,
  current: SubscriptionRow,
  reason?: string,
): Promise<void> {
  await emitSubscriptionTransitionRejectedAudit(
    args.transition,
    {
      tenantId: args.ctx.tenantId,
      subscriptionId: args.subscriptionId,
      patientId: current.patient_id,
      actorType: args.actor.type,
      actorId: args.actor.id ?? 'system',
      actorTenantId: args.ctx.actorTenantIdForAudit,
      countryOfCare: args.ctx.countryOfCare,
      detail: {
        current_status: current.status,
        ...(reason !== undefined ? { guard: reason } : {}),
      },
    },
    tx,
  );
}

// ---------------------------------------------------------------------------
// Read paths (OpenAPI §20.1 / §20.2 / §20.7)
// ---------------------------------------------------------------------------

export interface ReaderScope {
  /** 'patient' self-scopes to patientId; staff reads tenant-wide. */
  kind: 'patient' | 'staff';
  patientId?: string;
}

function readerRole(scope: ReaderScope): SliceRole {
  return scope.kind === 'patient' ? 'subscription_patient_manager' : 'subscription_staff_reader';
}

export interface ListSubscriptionsFilters {
  status?: SubscriptionStatus;
  productId?: string;
  patientId?: string; // staff-only filter (§20.1)
  limit: number;
  /** Keyset cursor: created_at ISO + id from the previous page's last row. */
  cursor?: { createdAt: string; id: string };
}

export async function listSubscriptions(
  tx: DbClient,
  scope: ReaderScope,
  filters: ListSubscriptionsFilters,
): Promise<SubscriptionRow[]> {
  const where: string[] = [];
  const params: unknown[] = [];
  const p = (v: unknown): string => {
    params.push(v);
    return `$${params.length}`;
  };

  if (scope.kind === 'patient') {
    where.push(`patient_id = ${p(scope.patientId)}`);
  } else if (filters.patientId !== undefined) {
    where.push(`patient_id = ${p(filters.patientId)}`);
  }
  if (filters.status !== undefined) {
    where.push(`status = ${p(filters.status)}`);
  }
  if (filters.productId !== undefined) {
    where.push(`product_id = ${p(filters.productId)}`);
  }
  if (filters.cursor !== undefined) {
    where.push(
      `(created_at, id) < (${p(filters.cursor.createdAt)}::timestamptz, ${p(filters.cursor.id)})`,
    );
  }
  const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  const limitSql = p(filters.limit);

  return withDbRole(tx, readerRole(scope), async () => {
    const r = await tx.query<SubscriptionRow>(
      `SELECT ${SUBSCRIPTION_COLUMNS} FROM subscriptions
        ${whereSql}
        ORDER BY created_at DESC, id DESC
        LIMIT ${limitSql}`,
      params,
    );
    return r.rows;
  });
}

export async function getSubscription(
  tx: DbClient,
  scope: ReaderScope,
  subscriptionId: string,
): Promise<SubscriptionRow | undefined> {
  const selfScope = scope.kind === 'patient' ? 'AND patient_id = $2' : '';
  const params: unknown[] =
    scope.kind === 'patient' ? [subscriptionId, scope.patientId] : [subscriptionId];
  return withDbRole(tx, readerRole(scope), async () => {
    const r = await tx.query<SubscriptionRow>(
      `SELECT ${SUBSCRIPTION_COLUMNS} FROM subscriptions WHERE id = $1 ${selfScope}`,
      params,
    );
    return r.rows[0];
  });
}

export interface SubscriptionEventListRow {
  id: string;
  event_type: string;
  event_data: Record<string, unknown>;
  actor_type: string;
  actor_id: string | null;
  occurred_at: Date;
}

/** §20.7 event history. Returns undefined when the subscription itself is
 *  not visible to the caller (tenant-blind 404 upstream); [] when visible
 *  but event-less (cannot happen post-creation — 'created' always exists). */
export async function listSubscriptionEvents(
  tx: DbClient,
  scope: ReaderScope,
  subscriptionId: string,
): Promise<SubscriptionEventListRow[] | undefined> {
  const parent = await getSubscription(tx, scope, subscriptionId);
  if (parent === undefined) return undefined;
  return withDbRole(tx, readerRole(scope), async () => {
    const r = await tx.query<SubscriptionEventListRow>(
      `SELECT id, event_type, event_data, actor_type, actor_id, occurred_at
         FROM subscription_events
        WHERE subscription_id = $1
        ORDER BY occurred_at ASC, id ASC`,
      [subscriptionId],
    );
    return r.rows;
  });
}
