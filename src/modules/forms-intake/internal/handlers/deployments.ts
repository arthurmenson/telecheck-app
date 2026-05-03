/**
 * forms-intake/internal/handlers/deployments.ts — deployment route handlers.
 *
 * Endpoints (per Slice PRD v2.1 §6.2 deployment workflow):
 *   - POST   /v0/forms/deployments                  create active deployment
 *   - GET    /v0/forms/deployments/:deploymentId    read deployment
 *   - POST   /v0/forms/deployments/:deploymentId/retire   retire deployment
 *
 * Per Slice PRD §25.4 program porting workflow, the deployment binds a
 * specific (tenant, template, version, ProgramMarketPolicy) tuple — Pattern A
 * one-version-per-market immutability is preserved per FORMS_ENGINE v5.2.
 */

import type { FastifyReply, FastifyRequest } from 'fastify';

import { requireTenantContext } from '../../../../lib/tenant-context.js';

/** POST /v0/forms/deployments — deploy a published version to a market. */
export async function createDeploymentHandler(
  req: FastifyRequest,
  _reply: FastifyReply,
): Promise<unknown> {
  void requireTenantContext(req);
  // TODO: validate body via CreateDeploymentRequestSchema; call submission
  // service variant assignment to confirm no orphan in-progress submissions;
  // delegate to repo write under withTransaction.
  throw new Error('not implemented');
}

/** GET /v0/forms/deployments/:deploymentId — read a deployment. */
export async function getDeploymentHandler(
  req: FastifyRequest,
  _reply: FastifyReply,
): Promise<unknown> {
  void requireTenantContext(req);
  throw new Error('not implemented');
}

/**
 * POST /v0/forms/deployments/:deploymentId/retire — retire an active
 * deployment. In-progress submissions complete on their assigned version
 * per Slice PRD §14.5 supersession discipline.
 */
export async function retireDeploymentHandler(
  req: FastifyRequest,
  _reply: FastifyReply,
): Promise<unknown> {
  void requireTenantContext(req);
  throw new Error('not implemented');
}
