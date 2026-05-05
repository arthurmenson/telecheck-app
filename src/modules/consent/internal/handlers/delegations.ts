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

import { requireActorContext } from '../../../../lib/auth-context.js';
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
// POST /v0/consent/delegations
// ---------------------------------------------------------------------------

export async function inviteDelegateHandler(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<unknown> {
  const ctx = requireTenantContext(req);
  const actor = requireActorContext(req);
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

  try {
    const inviteInput: delegationService.InviteDelegateInput = {
      grantor_account_id: actor.accountId as AccountId,
      delegate_account_id: asAccountId(body.delegate_account_id),
      relationship_type: body.relationship_type as DelegationRelationshipType,
    };
    if (body.legal_documentation_id !== undefined) {
      inviteInput.legal_documentation_id = body.legal_documentation_id;
    }

    const delegation = await delegationService.inviteDelegate(
      ctx,
      { actorId: actor.accountId },
      inviteInput,
    );
    return reply.code(201).send(delegationToPatientView(delegation));
  } catch (err) {
    if (err instanceof Error) {
      if (err.message === delegationService.DELEGATION_SELF_FORBIDDEN) {
        return reply.code(400).send({
          error: {
            code: delegationService.DELEGATION_SELF_FORBIDDEN,
            message: 'Cannot delegate to yourself.',
            request_id: req.id,
          },
        });
      }
      if (err.message === delegationService.DELEGATION_CHAIN_FORBIDDEN) {
        return reply.code(400).send({
          error: {
            code: delegationService.DELEGATION_CHAIN_FORBIDDEN,
            message: 'A delegate cannot create another delegate.',
            request_id: req.id,
          },
        });
      }
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// State transitions
// ---------------------------------------------------------------------------

async function transition<T>(
  req: FastifyRequest,
  reply: FastifyReply,
  fn: (
    ctx: ReturnType<typeof requireTenantContext>,
    actor: { actorId: string },
  ) => Promise<T | null>,
  toView: (v: T) => unknown,
): Promise<unknown> {
  const ctx = requireTenantContext(req);
  const actor = requireActorContext(req);
  const result = await fn(ctx, { actorId: actor.accountId });
  if (result === null) {
    return reply.code(404).send({
      error: {
        code: 'internal.resource.not_found',
        message: 'Delegation transition failed.',
        request_id: req.id,
      },
    });
  }
  return reply.code(200).send(toView(result));
}

export async function acceptDelegationHandler(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<unknown> {
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
  return transition(
    req,
    reply,
    (ctx, actor) => delegationService.acceptDelegation(ctx, actor, asDelegationId(id)),
    delegationToPatientView,
  );
}

export async function declineDelegationHandler(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<unknown> {
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
  return transition(
    req,
    reply,
    (ctx, actor) => delegationService.declineDelegation(ctx, actor, asDelegationId(id)),
    delegationToPatientView,
  );
}

export async function revokeDelegationHandler(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<unknown> {
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
  return transition(
    req,
    reply,
    (ctx, actor) =>
      delegationService.revokeDelegation(
        ctx,
        actor,
        asDelegationId(id),
        body.reason as DelegationRevocationReason,
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
  const actor = requireActorContext(req);
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
  const actor = requireActorContext(req);
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
  const actor = requireActorContext(req);
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

  const grantInput: delegationService.GrantScopeInput = {
    delegation_id: asDelegationId(id),
    scope: body.scope as DelegationScope,
  };
  if (body.visibility_restrictions !== undefined) {
    grantInput.visibility_restrictions = body.visibility_restrictions;
  }

  const created = await delegationService.grantScope(
    ctx,
    { actorId: actor.accountId, grantorAccountId: actor.accountId as AccountId },
    grantInput,
  );
  return reply.code(201).send(scopeToPatientView(created));
}

export async function revokeScopeHandler(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<unknown> {
  const ctx = requireTenantContext(req);
  const actor = requireActorContext(req);
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

  const revoked = await delegationService.revokeScope(
    ctx,
    { actorId: actor.accountId, grantorAccountId: actor.accountId as AccountId },
    asDelegationScopeId(params.scopeId),
  );
  if (revoked === null) {
    return reply.code(404).send({
      error: {
        code: 'internal.resource.not_found',
        message: 'Scope not found.',
        request_id: req.id,
      },
    });
  }
  return reply.code(200).send(scopeToPatientView(revoked));
}

export async function listScopesForDelegationHandler(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<unknown> {
  const ctx = requireTenantContext(req);
  requireActorContext(req); // auth required even for list
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

  const list = await delegationService.listActiveScopesForDelegation(ctx, asDelegationId(id));
  return reply.code(200).send({ scopes: list.map(scopeToPatientView) });
}
