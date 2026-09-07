/**
 * consent/routes.ts — Fastify route registration for the Consent module.
 *
 * Registers published care-policy governance, own-patient consent choices,
 * bounded history/status and withdrawal. The older client-evidence contract
 * is explicitly retired. Delegation retains its separate existing surface.
 *
 * Spec references:
 *   - Consent Slice PRD v1.0 (full route surface defined per slice spec)
 *   - I-023 (tenant scoping via foundation tenantContext plugin)
 */

import type { FastifyInstance, FastifyPluginAsync } from 'fastify';

import { registerCareConsentPatientRoutes } from './internal/handlers/care-consents.js';
import { registerCarePolicyRoutes } from './internal/handlers/care-policies.js';
import {
  getMyConsentHistoryHandler,
  grantConsentHandler,
  revokeConsentHandler,
} from './internal/handlers/consents.js';
import {
  acceptDelegationHandler,
  declineDelegationHandler,
  grantScopeHandler,
  inviteDelegateHandler,
  listGrantedDelegationsHandler,
  listReceivedDelegationsHandler,
  listScopesForDelegationHandler,
  revokeDelegationHandler,
  revokeScopeHandler,
} from './internal/handlers/delegations.js';

export const registerConsentRoutes: FastifyPluginAsync = async (
  app: FastifyInstance,
): Promise<void> => {
  registerCarePolicyRoutes(app);
  registerCareConsentPatientRoutes(app);
  /**
   * Module health probe — module-scoped equivalent of the platform-level
   * /health. Bypasses tenant resolution via the app.ts allowlist entry.
   */
  app.get('/health', async (_request, reply) => {
    await reply.code(200).send({ status: 'ok', module: 'consent' });
  });

  /**
   * Consent grant / revoke / history per Slice PRD §5-§9.
   * All require Bearer JWT auth (req.actorContext).
   */
  app.post('/consents', grantConsentHandler);
  app.post('/consents/revoke', revokeConsentHandler);
  app.get('/consents/me', getMyConsentHistoryHandler);

  /**
   * Delegation flow per Slice PRD §6.
   */
  app.post('/delegations', inviteDelegateHandler);
  app.post('/delegations/:id/accept', acceptDelegationHandler);
  app.post('/delegations/:id/decline', declineDelegationHandler);
  app.post('/delegations/:id/revoke', revokeDelegationHandler);
  app.get('/delegations/granted', listGrantedDelegationsHandler);
  app.get('/delegations/received', listReceivedDelegationsHandler);
  app.post('/delegations/:id/scopes', grantScopeHandler);
  app.post('/delegations/:id/scopes/:scopeId/revoke', revokeScopeHandler);
  app.get('/delegations/:id/scopes', listScopesForDelegationHandler);
};
