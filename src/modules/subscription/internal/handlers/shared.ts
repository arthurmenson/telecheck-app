/**
 * subscription/internal/handlers/shared.ts — shared validation, wire-view
 * projection, actor/scope resolution, and outcome mapping for the
 * Subscription HTTP surface (OpenAPI v0.2 §20).
 *
 * Kept module-private (internal/) per ADR-001; nothing here is exported
 * from the module's index.ts.
 *
 * Key discipline points:
 *   - **I-025 tenant-blind views:** `toSubscriptionView` STRIPS tenant_id
 *     (and the opaque payment_method_id handle) from every wire response.
 *     The idempotency cache stores the projected view, never the raw row.
 *   - **Glossary (hard rule):** the DB column is CDM-verbatim
 *     `prescription_id`, but the wire field is the canonical
 *     `medication_request_id` (GLOSSARY forbids the `prescription` alias;
 *     see the migration 076 GLOSSARY TENSION note).
 *   - **Actor resolution:** the HTTP write surface (pause/resume/switch/
 *     cancel) is the patient-sovereign transition set per State Machines
 *     v1.1 §15 + OpenAPI §20.3-20.6 ("subscription owner; or tenant
 *     operator"). JWT role → SubscriptionActor: patient → 'patient';
 *     tenant_admin → 'tenant_operator'. clinician / platform_admin /
 *     ai_service have NO ratified subscription write endpoint (clinician
 *     transitions run via exported service functions; platform_admin is
 *     break-glass territory per I-024) → 403.
 *   - **Reader scope:** patient → self-scoped; tenant_admin → tenant-wide
 *     staff read (OpenAPI §20.1 Tenant Admin/Operator/Billing). Other
 *     roles → 403 (platform_admin cross-tenant reads require break-glass,
 *     not wired at v1.0 — fail closed).
 *
 * Spec references: OpenAPI v0.2 §20, State Machines v1.1 §15, I-023/I-025,
 * migrations/075-077.
 */

import type { FastifyRequest } from 'fastify';

import { requireActorContext, UnauthorizedRoleError } from '../../../../lib/auth-context.js';
import type { ReaderScope, SubscriptionActor } from '../service.js';
import type { SubscriptionRow } from '../types.js';

// ---------------------------------------------------------------------------
// Error envelope + primitive validation (crisis/async-consult handler parity)
// ---------------------------------------------------------------------------

export interface ErrorEnvelopeBody {
  error: { code: string; message: string; request_id: string };
}

export function makeErrorEnvelope(reqId: string, code: string, message: string): ErrorEnvelopeBody {
  return { error: { code, message, request_id: reqId } };
}

export function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}

/** Parse an ISO 8601 timestamp; null on malformed input (boundary check
 *  before the DB type-cast error path). */
export function parseIsoTimestamp(v: unknown): Date | null {
  if (typeof v !== 'string' || v.length === 0) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function pgErrorCode(err: unknown): string | null {
  if (typeof err === 'object' && err !== null && 'code' in err) {
    const code = (err as { code?: unknown }).code;
    return typeof code === 'string' ? code : null;
  }
  return null;
}

/** Canonical sub_<ULID> path-parameter shape (mirrors types.ts pattern). */
const SUBSCRIPTION_ID_PATTERN = /^sub_[0-7][0-9A-HJKMNPQRSTVWXYZ]{25}$/;
export function isSubscriptionIdShape(v: unknown): v is string {
  return typeof v === 'string' && SUBSCRIPTION_ID_PATTERN.test(v);
}

/** Canonical prd_<ULID> product id (OpenAPI §20.5 new_product_id). Product
 *  ids are validated shape-only at the boundary; tenant-coherence + existence
 *  are enforced by the composite FK at switch_approve time (the DB layer),
 *  not here (ADR-001 — this module never reads product_catalog directly). */
const PRODUCT_ID_PATTERN = /^prd_[0-7][0-9A-HJKMNPQRSTVWXYZ]{25}$/;
export function isProductIdShape(v: unknown): v is string {
  return typeof v === 'string' && PRODUCT_ID_PATTERN.test(v);
}

// ---------------------------------------------------------------------------
// Wire view (I-025: tenant_id + payment handle stripped; canonical naming)
// ---------------------------------------------------------------------------

export interface SubscriptionView {
  id: string;
  patient_id: string;
  product_id: string;
  /** Canonical glossary term for the DB `prescription_id` column. */
  medication_request_id: string;
  cadence: string;
  unit_price: string;
  currency: string;
  status: string;
  started_at: string;
  paused_at: string | null;
  pause_until: string | null;
  cancelled_at: string | null;
  cancel_reason: string | null;
  next_renewal_at: string | null;
  last_fulfilled_at: string | null;
  preauth_window_months: number;
  preauth_renewals_remaining: number;
  version: number;
  created_at: string;
  updated_at: string;
}

function iso(d: Date | null): string | null {
  return d === null ? null : d.toISOString();
}

/** Project a durable row to the tenant-blind wire view. NEVER include
 *  tenant_id (I-025) or payment_method_id (opaque processor handle). */
export function toSubscriptionView(row: SubscriptionRow): SubscriptionView {
  return {
    id: row.id,
    patient_id: row.patient_id,
    product_id: row.product_id,
    medication_request_id: row.prescription_id,
    cadence: row.cadence,
    unit_price: row.unit_price,
    currency: row.currency,
    status: row.status,
    started_at: row.started_at.toISOString(),
    paused_at: iso(row.paused_at),
    pause_until: iso(row.pause_until),
    cancelled_at: iso(row.cancelled_at),
    cancel_reason: row.cancel_reason,
    next_renewal_at: iso(row.next_renewal_at),
    last_fulfilled_at: iso(row.last_fulfilled_at),
    preauth_window_months: row.preauth_window_months,
    preauth_renewals_remaining: row.preauth_renewals_remaining,
    version: row.version,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Actor + reader-scope resolution from the verified JWT actor context
// ---------------------------------------------------------------------------

/**
 * Resolve the SubscriptionActor for a patient-sovereign WRITE transition.
 * The actor identity is ALWAYS the verified JWT subject (SI-025 P-045
 * lesson: identity comes from the trust anchor, never the request body).
 *
 * Throws UnauthenticatedError (401) when unauthenticated, or
 * UnauthorizedRoleError (403) for any role without a ratified subscription
 * write endpoint (clinician / platform_admin / ai_service).
 */
export function resolveWriteActor(req: FastifyRequest): SubscriptionActor {
  const actor = requireActorContext(req);
  switch (actor.role) {
    case 'patient':
      return { type: 'patient', id: actor.accountId };
    case 'tenant_admin':
      // OpenAPI §20.3-20.6 "or tenant operator" — the tenant-staff
      // on-behalf write path. The audit trail records actor_type=operator.
      return { type: 'tenant_operator', id: actor.accountId };
    default:
      throw new UnauthorizedRoleError(['patient', 'tenant_admin'], actor.role);
  }
}

/**
 * Resolve the ReaderScope for a READ endpoint (list/get/events).
 *   - patient → self-scoped to their own subscriptions.
 *   - tenant_admin → tenant-wide staff read (OpenAPI §20.1).
 * Other roles → 403 (platform_admin cross-tenant reads require break-glass,
 * not wired at v1.0; clinician assigned-patient reads have no primitive yet).
 */
export function resolveReaderScope(req: FastifyRequest): ReaderScope {
  const actor = requireActorContext(req);
  switch (actor.role) {
    case 'patient':
      return { kind: 'patient', patientId: actor.accountId };
    case 'tenant_admin':
      return { kind: 'staff' };
    default:
      throw new UnauthorizedRoleError(['patient', 'tenant_admin'], actor.role);
  }
}
