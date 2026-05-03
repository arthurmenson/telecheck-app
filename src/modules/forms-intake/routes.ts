/**
 * forms-intake/routes.ts — Fastify route registration for the Forms/Intake Engine.
 *
 * Registered under the `/v0/forms` prefix by `plugin.ts`. Path conventions
 * derived from Slice PRD v2.1 §6 (visual-builder workflows), §7 (onboarding
 * flow), §8 (save-and-resume), §14 (A/B testing native), and §17 (subscription
 * handoff).
 *
 * SPEC ISSUE: OpenAPI v0.2 does NOT enumerate `/v0/forms/*` endpoints —
 * the only intake reference in OpenAPI v0.2 is `POST /consults/{id}/intake`
 * (consult-scoped intake submission). The slice PRD v2.1 references
 * endpoint behavior for templates, deployments, submissions, variants, and
 * resume but does not pin canonical paths. The paths below are derived
 * from slice-PRD verbs + §6 builder workflows + RESTful convention; they
 * MUST be reconciled against an OpenAPI v0.2 amendment before slice ships.
 * Filed per EHBG §12 SI/DSI escalation.
 */

import type { FastifyInstance, FastifyPluginAsync } from 'fastify';

import {
  createDeploymentHandler,
  getDeploymentHandler,
  retireDeploymentHandler,
} from './internal/handlers/deployments.js';
import {
  getResumeStateHandler,
  resumeSubmissionHandler,
} from './internal/handlers/resume.js';
import {
  getSubmissionHandler,
  startSubmissionHandler,
  submitSubmissionHandler,
  updateSubmissionResponsesHandler,
} from './internal/handlers/submissions.js';
import {
  createTemplateHandler,
  getTemplateHandler,
  listTemplatesHandler,
  publishVersionHandler,
} from './internal/handlers/templates.js';
import {
  createVariantHandler,
  getVariantHandler,
  promoteVariantHandler,
} from './internal/handlers/variants.js';

/**
 * Registers all Forms/Intake routes on the supplied Fastify instance.
 * Called by `formsIntakePlugin` in `plugin.ts` under the `/v0/forms` prefix.
 */
export const registerFormsIntakeRoutes: FastifyPluginAsync = async (
  app: FastifyInstance,
): Promise<void> => {
  // ---- Templates ----
  app.post('/templates', createTemplateHandler);
  app.get('/templates', listTemplatesHandler);
  app.get('/templates/:templateId', getTemplateHandler);
  app.post(
    '/templates/:templateId/versions/:versionId/publish',
    publishVersionHandler,
  );

  // ---- Deployments ----
  app.post('/deployments', createDeploymentHandler);
  app.get('/deployments/:deploymentId', getDeploymentHandler);
  app.post('/deployments/:deploymentId/retire', retireDeploymentHandler);

  // ---- Submissions (patient/delegate-facing) ----
  app.post('/submissions', startSubmissionHandler);
  app.get('/submissions/:submissionId', getSubmissionHandler);
  app.patch(
    '/submissions/:submissionId/responses',
    updateSubmissionResponsesHandler,
  );
  app.post('/submissions/:submissionId/submit', submitSubmissionHandler);

  // ---- Variants (A/B test administration) ----
  app.post('/variants', createVariantHandler);
  app.get('/variants/:variantId', getVariantHandler);
  app.post('/variants/:variantId/promote', promoteVariantHandler);

  // ---- Resume ----
  app.post('/resume', resumeSubmissionHandler);
  app.get('/resume/:resumeToken', getResumeStateHandler);
};
