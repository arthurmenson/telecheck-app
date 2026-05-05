/**
 * accounts.ts — GET /v0/identity/accounts/me handler.
 *
 * Returns the patient's own account record. Identifies the calling
 * actor via the same `x-actor-id` / `x-account-id` header stubs that
 * the forms-intake module uses (per ALLOW_ACTOR_HEADER_AUTH config).
 * When JWT auth lands, this handler reads from req.actorContext
 * instead of headers.
 *
 *   GET /v0/identity/accounts/me
 *     Headers: x-account-id: <account_id>
 *     - Resolves account by id under the caller's tenant
 *     - Returns 200 + PatientAccountView (tenant_id stripped)
 *     - Returns 404 if not found OR cross-tenant (tenant-blind per I-025)
 *
 * Spec references:
 *   - Identity & Authentication Spec v1.0 §2.2 (account fields surface)
 *   - I-025 (tenant-blind 404 envelope)
 *   - Master PRD v1.10 §17 + Glossary v5.2 C3 (PatientAccountView strip)
 */

import type { FastifyReply, FastifyRequest } from 'fastify';

import { requireTenantContext } from '../../../../lib/tenant-context.js';
import * as accountService from '../services/account-service.js';
import { asAccountId } from '../types.js';

function isString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}

// ---------------------------------------------------------------------------
// GET /v0/identity/accounts/me
// ---------------------------------------------------------------------------

export async function getMyAccountHandler(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<unknown> {
  const ctx = requireTenantContext(req);

  // STUB actor resolution — same pattern as forms-intake handlers at
  // v1.0 (per ALLOW_ACTOR_HEADER_AUTH). Read account_id from header.
  // When JWT lands, this comes from req.actorContext.accountId.
  const accountIdHeader = req.headers['x-account-id'];
  if (!isString(accountIdHeader)) {
    return reply.code(400).send({
      error: {
        code: 'internal.request.invalid',
        message: 'x-account-id header is required.',
        request_id: req.id,
      },
    });
  }

  const account = await accountService.findAccountById(ctx, asAccountId(accountIdHeader));
  if (account === null) {
    // Tenant-blind 404 — same envelope whether the account doesn't
    // exist or is in another tenant.
    return reply.code(404).send({
      error: {
        code: 'internal.resource.not_found',
        message: 'Account not found.',
        request_id: req.id,
      },
    });
  }

  return reply.code(200).send(accountService.toPatientAccountView(account));
}
