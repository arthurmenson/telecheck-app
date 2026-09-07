/**
 * Retired unversioned consent contract. These routes accepted client-authored
 * evidence and arbitrary version/type/scope, and returned the full evidence.
 * The published-policy /care surface replaces them. Keeping a second mutation
 * path would bypass exact terms, live authority and append-only choice order.
 */
import type { FastifyReply, FastifyRequest } from 'fastify';

import { requirePatientActorContext } from '../../../../lib/auth-context.js';
import { requireTenantContext } from '../../../../lib/tenant-context.js';

async function versionedPolicyRequired(req: FastifyRequest, reply: FastifyReply): Promise<unknown> {
  void reply.header('Cache-Control', 'no-store');
  requireTenantContext(req);
  requirePatientActorContext(req);
  return reply.code(410).send({
    error: {
      code: 'consent.versioned_policy_required',
      message: 'Use the current consent and privacy flow to review or change your choices.',
      request_id: req.id,
    },
  });
}

export const grantConsentHandler = versionedPolicyRequired;
export const revokeConsentHandler = versionedPolicyRequired;
export const getMyConsentHistoryHandler = versionedPolicyRequired;
