/**
 * delegations.ts — POST/GET /v0/consent/delegations + scope handlers per
 * Consent Slice PRD v1.0 §6.
 *
 *   POST /v0/consent/delegations              — patient invites delegate
 *   POST /v0/consent/delegations/:id/accept   — delegate accepts
 *   POST /v0/consent/delegations/:id/decline  — delegate declines
 *   POST /v0/consent/delegations/:id/revoke   — patient revokes
 *   GET  /v0/consent/delegations/granted      — list outbound (grantor)
 *   GET  /v0/consent/delegations/received     — list inbound (delegate)
 *   POST /v0/consent/delegations/:id/scopes   — grant a scope
 *   POST /v0/consent/delegations/:id/scopes/:scopeId/revoke — revoke
 *   GET  /v0/consent/delegations/:id/scopes   — list active scopes
 *
 * All require Bearer JWT auth (req.actorContext).
 *
 * Spec references:
 *   - Consent Slice PRD v1.0 §6
 *   - I-003 / I-025
 */

import type { FastifyReply, FastifyRequest } from 'fastify';

import { requirePatientActorContext } from '../../../../lib/auth-context.js';
import type { DbTransaction } from '../../../../lib/db.js';
import { withIdempotentExecution } from '../../../../lib/idempotent-handler.js';
import { requireTenantContext } from '../../../../lib/tenant-context.js';
import { asAccountId, type AccountId } from '../../../identity/internal/types.js';
import * as delegationService from '../services/delegation-service.js';
import {
  asDelegationId,
  asDelegationScopeId,
  type Delegation,
  type DelegationRelationshipType,
  type DelegationRevocationReason,
  type DelegationScope,
  type DelegationScopeRow,
  type DelegationVisibilityRestrictions,
} from '../types.js';

// ---------------------------------------------------------------------------
// PHI-safe views: strip tenant_id
// ---------------------------------------------------------------------------

type PatientDelegationView = Omit<Delegation, 'tenant_id'>;
type PatientScopeView = Omit<DelegationScopeRow, 'tenant_id'>;

function delegationToPatientView(d: Delegation): PatientDelegationView {
  const { tenant_id: _stripped, ...rest } = d;
  void _stripped;
  return rest;
}
function scopeToPatientView(s: DelegationScopeRow): PatientScopeView {
  const { tenant_id: _stripped, ...rest } = s;
  void _stripped;
  return rest;
}

// ---------------------------------------------------------------------------
// Body shapes + validators
// ---------------------------------------------------------------------------

interface InviteBody {
  delegate_account_id?: string;
  relationship_type?: string;
  legal_documentation_id?: string | null;
}
interface RevokeBody {
  reason?: string;
}
interface GrantScopeBody {
  scope?: string;
  visibility_restrictions?: DelegationVisibilityRestrictions | null;
}

const VALID_RELATIONSHIPS = new Set([
  'parent_of_minor',
  'adult_child',
  'spouse_partner',
  'professional_caregiver',
  'healthcare_proxy',
  'other',
]);

const VALID_REVOKE_REASONS = new Set([
  'patient_initiated',
  'delegate_initiated',
  'expiration',
  'admin_revoked',
  'compromise_detected',
]);

const VALID_SCOPES = new Set([
  'view_records',
  'request_refills',
  'book_consults',
  'attend_consults',
  'receive_notifications',
  'make_payments',
  'upload_documents',
  'give_consent_on_behalf',
  'view_community',
]);

function isString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}

// ---------------------------------------------------------------------------
// Service-error mapping for withIdempotentExecution.
//
// inviteDelegate throws Error with message === DELEGATION_SELF_FORBIDDEN
// or DELEGATION_CHAIN_FORBIDDEN. Other errors propagate.
// ---------------------------------------------------------------------------

function mapServiceError(err: unknown, reply: FastifyReply, reqId: string): boolean {
  if (err instanceof Error) {
    if (err.message === delegationService.DELEGATION_SELF_FORBIDDEN) {
      void reply.code(400).send({
        error: {
          code: delegationService.DELEGATION_SELF_FORBIDDEN,
          message: 'Cannot delegate to yourself.',
          request_id: reqId,
        },
      });
      return true;
    }
    if (err.message === delegationService.DELEGATION_CHAIN_FORBIDDEN) {
      void reply.code(400).send({
        error: {
          code: delegationService.DELEGATION_CHAIN_FORBIDDEN,
          message: 'A delegate cannot create another delegate.',
          request_id: reqId,
        },
      });
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// POST /v0/consent/delegations
// ---------------------------------------------------------------------------

export async function inviteDelegateHandler(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<unknown> {
  const ctx = requireTenantContext(req);
  const actor = requirePatientActorContext(req);
  const body = (req.body ?? {}) as InviteBody;

  if (
    !isString(body.delegate_account_id) ||
    !isString(body.relationship_type) ||
    !VALID_RELATIONSHIPS.has(body.relationship_type)
  ) {
    return reply.code(400).send({
      error: {
        code: 'internal.request.invalid',
        message: 'delegate_account_id + relationship_type (enum) required.',
        request_id: req.id,
      },
    });
  }

  return withIdempotentExecution(req, reply, mapServiceError, async (tx) => {
    const inviteInput: delegationService.InviteDelegateInput = {
      grantor_account_id: actor.accountId as AccountId,
      delegate_account_id: asAccountId(body.delegate_account_id as string),
      relationship_type: body.relationship_type as DelegationRelationshipType,
    };
    if (body.legal_documentation_id !== undefined) {
      inviteInput.legal_documentation_id = body.legal_documentation_id;
    }

    const delegation = await delegationService.inviteDelegate(
      ctx,
      { actorId: actor.accountId },
      inviteInput,
      tx,
    );
    return { status: 201, view: delegationToPatientView(delegation) };
  });
}

// ---------------------------------------------------------------------------
// State transitions
//
// SI-006 PR-C: transition wraps the service call in withIdempotentExecution.
// The service callback receives an externalTx so the reservation INSERT
// + business mutation + completion UPDATE are atomic.
// ---------------------------------------------------------------------------

async function transition<T>(
  req: FastifyRequest,
  reply: FastifyReply,
  fn: (
    ctx: ReturnType<typeof requireTenantContext>,
    actor: { actorId: string },
    tx: DbTransaction,
  ) => Promise<T | null>,
  toView: (v: T) => unknown,
): Promise<unknown> {
  const ctx = requireTenantContext(req);
  const actor = requirePatientActorContext(req);
  return withIdempotentExecution(req, reply, mapServiceError, async (tx) => {
    const result = await fn(ctx, { actorId: actor.accountId }, tx);
    if (result === null) {
      // Cache the 404 so retries replay it consistently. The view shape
      // doesn't match the success view; cast as unknown for the helper's
      // generic. At runtime the cached body is just JSON.
      return {
        status: 404,
        view: {
          error: {
            code: 'internal.resource.not_found',
            message: 'Delegation transition failed.',
            request_id: req.id,
          },
        } as unknown,
      };
    }
    return { status: 200, view: toView(result) };
  });
}

// ---------------------------------------------------------------------------
// Delegation ownership precondition (Codex PR-118 R5 HIGH closure)
//
// Pre-existing pattern in this slice: the transition handlers (accept /
// decline / revoke) and scope mutators (grant / revoke scope) authorized
// solely by `tenant_id + delegation_id` at the repo predicate level. The
// patient role gate (added in R1) confirms the caller is a patient but
// does NOT verify the caller owns the delegation. A same-tenant patient
// who can guess or harvest a delegation_id could therefore accept,
// decline, revoke, or alter scopes on a delegation they have no part in.
// Fix: every mutating handler now loads the delegation first via
// `findDelegationById` and verifies the caller's accountId matches the
// expected role (grantor for revoke + scope mutations; delegate for
// accept / decline). Mismatches collapse to a tenant-blind 404 per I-025.
// ---------------------------------------------------------------------------

async function assertOwnership(
  ctx: ReturnType<typeof requireTenantContext>,
  delegationId: ReturnType<typeof asDelegationId>,
  actorAccountId: string,
  expected: 'grantor' | 'delegate',
): Promise<boolean> {
  const delegation = await delegationService.findDelegationById(ctx, delegationId);
  if (delegation === null) return false;
  if (expected === 'grantor') {
    return delegation.grantor_account_id === actorAccountId;
  }
  return delegation.delegate_account_id === actorAccountId;
}

function tenantBlindDelegationNotFound(req: FastifyRequest, reply: FastifyReply): unknown {
  return reply.code(404).send({
    error: {
      code: 'internal.resource.not_found',
      message: 'Delegation not found.',
      request_id: req.id,
    },
  });
}

export async function acceptDelegationHandler(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<unknown> {
  const ctx = requireTenantContext(req);
  const actor = requirePatientActorContext(req);
  const id = (req.params as { id?: string }).id;
  if (!isString(id)) {
    return reply.code(400).send({
      error: {
        code: 'internal.request.invalid',
        message: 'id param required.',
        request_id: req.id,
      },
    });
  }
  // Ownership: only the delegate may accept the invitation.
  if (!(await assertOwnership(ctx, asDelegationId(id), actor.accountId, 'delegate'))) {
    return tenantBlindDelegationNotFound(req, reply);
  }
  return transition(
    req,
    reply,
    (innerCtx, innerActor, tx) =>
      delegationService.acceptDelegation(innerCtx, innerActor, asDelegationId(id), tx),
    delegationToPatientView,
  );
}

export async function declineDelegationHandler(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<unknown> {
  const ctx = requireTenantContext(req);
  const actor = requirePatientActorContext(req);
  const id = (req.params as { id?: string }).id;
  if (!isString(id)) {
    return reply.code(400).send({
      error: {
        code: 'internal.request.invalid',
        message: 'id param required.',
        request_id: req.id,
      },
    });
  }
  // Ownership: only the delegate may decline the invitation.
  if (!(await assertOwnership(ctx, asDelegationId(id), actor.accountId, 'delegate'))) {
    return tenantBlindDelegationNotFound(req, reply);
  }
  return transition(
    req,
    reply,
    (innerCtx, innerActor, tx) =>
      delegationService.declineDelegation(innerCtx, innerActor, asDelegationId(id), tx),
    delegationToPatientView,
  );
}

export async function revokeDelegationHandler(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<unknown> {
  const ctx = requireTenantContext(req);
  const actor = requirePatientActorContext(req);
  const id = (req.params as { id?: string }).id;
  const body = (req.body ?? {}) as RevokeBody;
  if (!isString(id) || !isString(body.reason) || !VALID_REVOKE_REASONS.has(body.reason)) {
    return reply.code(400).send({
      error: {
        code: 'internal.request.invalid',
        message: 'id + reason (enum) required.',
        request_id: req.id,
      },
    });
  }
  // Ownership: only the grantor may revoke. Delegate-initiated revoke
  // is not modeled at v1.0 (when it lands, the body would discriminate
  // the actor role and this check widens).
  if (!(await assertOwnership(ctx, asDelegationId(id), actor.accountId, 'grantor'))) {
    return tenantBlindDelegationNotFound(req, reply);
  }
  return transition(
    req,
    reply,
    (innerCtx, innerActor, tx) =>
      delegationService.revokeDelegation(
        innerCtx,
        innerActor,
        asDelegationId(id),
        body.reason as DelegationRevocationReason,
        tx,
      ),
    delegationToPatientView,
  );
}

// ---------------------------------------------------------------------------
// List endpoints
// ---------------------------------------------------------------------------

export async function listGrantedDelegationsHandler(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<unknown> {
  const ctx = requireTenantContext(req);
  const actor = requirePatientActorContext(req);
  const list = await delegationService.listActiveDelegationsForGrantor(
    ctx,
    actor.accountId as AccountId,
  );
  return reply.code(200).send({ delegations: list.map(delegationToPatientView) });
}

export async function listReceivedDelegationsHandler(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<unknown> {
  const ctx = requireTenantContext(req);
  const actor = requirePatientActorContext(req);
  const list = await delegationService.listActiveDelegationsForDelegate(
    ctx,
    actor.accountId as AccountId,
  );
  return reply.code(200).send({ delegations: list.map(delegationToPatientView) });
}

// ---------------------------------------------------------------------------
// Scope endpoints
// ---------------------------------------------------------------------------

export async function grantScopeHandler(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<unknown> {
  const ctx = requireTenantContext(req);
  const actor = requirePatientActorContext(req);
  const id = (req.params as { id?: string }).id;
  const body = (req.body ?? {}) as GrantScopeBody;
  if (!isString(id) || !isString(body.scope) || !VALID_SCOPES.has(body.scope)) {
    return reply.code(400).send({
      error: {
        code: 'internal.request.invalid',
        message: 'id + scope (enum) required.',
        request_id: req.id,
      },
    });
  }

  // Ownership: only the grantor of the parent delegation may add scopes.
  // Codex PR-118 R5 HIGH closure 2026-05-13.
  if (!(await assertOwnership(ctx, asDelegationId(id), actor.accountId, 'grantor'))) {
    return tenantBlindDelegationNotFound(req, reply);
  }

  const grantInput: delegationService.GrantScopeInput = {
    delegation_id: asDelegationId(id),
    scope: body.scope as DelegationScope,
  };
  if (body.visibility_restrictions !== undefined) {
    grantInput.visibility_restrictions = body.visibility_restrictions;
  }

  return withIdempotentExecution(req, reply, mapServiceError, async (tx) => {
    const created = await delegationService.grantScope(
      ctx,
      { actorId: actor.accountId, grantorAccountId: actor.accountId as AccountId },
      grantInput,
      tx,
    );
    return { status: 201, view: scopeToPatientView(created) };
  });
}

export async function revokeScopeHandler(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<unknown> {
  const ctx = requireTenantContext(req);
  const actor = requirePatientActorContext(req);
  const params = req.params as { id?: string; scopeId?: string };
  if (!isString(params.id) || !isString(params.scopeId)) {
    return reply.code(400).send({
      error: {
        code: 'internal.request.invalid',
        message: 'id + scopeId path params required.',
        request_id: req.id,
      },
    });
  }

  // Ownership: only the grantor of the parent delegation may revoke
  // its scopes. The :id path param carries the parent delegation_id —
  // verify grantor match. If a scope is requested via :scopeId but
  // doesn't belong to the :id delegation, the service-layer
  // mismatch surfaces as a 404. Codex PR-118 R5 HIGH closure 2026-05-13.
  if (!(await assertOwnership(ctx, asDelegationId(params.id), actor.accountId, 'grantor'))) {
    return tenantBlindDelegationNotFound(req, reply);
  }

  return withIdempotentExecution(req, reply, mapServiceError, async (tx) => {
    const revoked = await delegationService.revokeScope(
      ctx,
      { actorId: actor.accountId, grantorAccountId: actor.accountId as AccountId },
      asDelegationScopeId(params.scopeId as string),
      tx,
    );
    if (revoked === null) {
      return {
        status: 404,
        view: {
          error: {
            code: 'internal.resource.not_found',
            message: 'Scope not found.',
            request_id: req.id,
          },
        } as unknown,
      };
    }
    return { status: 200, view: scopeToPatientView(revoked) };
  });
}

export async function listScopesForDelegationHandler(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<unknown> {
  const ctx = requireTenantContext(req);
  const actor = requirePatientActorContext(req);
  const id = (req.params as { id?: string }).id;
  if (!isString(id)) {
    return reply.code(400).send({
      error: {
        code: 'internal.request.invalid',
        message: 'id param required.',
        request_id: req.id,
      },
    });
  }

  // Ownership check (Codex PR-118 R4 HIGH closure 2026-05-13). The
  // role gate at requirePatientActorContext blocks clinician JWTs but
  // does NOT prevent same-tenant patient B from reading patient A's
  // delegation scopes by guessing or harvesting the delegation_id.
  // Fix: load the delegation row and verify actor is the grantor OR
  // delegate; mismatch → tenant-blind 404 per I-025 (collapsed with
  // the not-found envelope so a same-tenant attacker cannot
  // distinguish "exists but not yours" from "doesn't exist").
  const delegationId = asDelegationId(id);
  const delegation = await delegationService.findDelegationById(ctx, delegationId);
  const tenantBlindNotFound = (): unknown =>
    reply.code(404).send({
      error: {
        code: 'internal.resource.not_found',
        message: 'Delegation not found.',
        request_id: req.id,
      },
    });
  if (delegation === null) {
    return tenantBlindNotFound();
  }
  if (
    delegation.grantor_account_id !== actor.accountId &&
    delegation.delegate_account_id !== actor.accountId
  ) {
    return tenantBlindNotFound();
  }

  const list = await delegationService.listActiveScopesForDelegation(ctx, delegationId);
  return reply.code(200).send({ scopes: list.map(scopeToPatientView) });
}
