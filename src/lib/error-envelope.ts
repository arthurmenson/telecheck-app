/**
 * error-envelope.ts — Tenant-blind error responses per I-025 + ERROR_MODEL v5.1.
 *
 * Purpose:
 *   Replaces Fastify's default error serialization with the canonical ERROR_MODEL
 *   v5.1 envelope. Enforces tenant-blind error responses: a resource-not-found
 *   is identical whether the resource doesn't exist or exists in another tenant.
 *
 * Spec references:
 *   - I-025: error responses MUST NOT differentiate "resource doesn't exist" from
 *     "resource exists in another tenant". Both yield the same not-found envelope.
 *     Using 403 instead of 404 for cross-tenant access signals existence — forbidden.
 *   - ERROR_MODEL v5.1:
 *       * Standard envelope: { error: { code, message, detail, retry_after, trace_id, timestamp } }
 *       * HTTP mapping table
 *       * Tenant-isolation error behavior (§Tenant-isolation error behavior)
 *       * Resource-not-found uniformity rule
 *       * No tenant_id echo in error responses for unauthorized scopes
 *   - I-003: errors from audit emission are re-thrown, not swallowed.
 *
 * Security decisions:
 *   - 5xx errors in production: generic message only; full detail in server logs.
 *   - Stack traces: NEVER included in error responses.
 *   - Tenant ID: NEVER echoed in error response detail for 403 responses.
 *   - Cross-tenant 404: identical envelope to plain 404 (I-025).
 *   - The `detail` block is omitted for 5xx and 404 responses to clients;
 *     available for 4xx validation errors where detail doesn't leak internal state.
 *
 * Open questions for Engineering Lead:
 *   - Locale resolution for `message`: ERROR_MODEL v5.1 specifies locale resolution
 *     order (patient locale → device locale → CCR default → en-US). Currently
 *     all messages are in en-US. Locale resolution requires patient session context
 *     which is not available at the error handler layer — deferred to i18n slice.
 */

import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';

// ---------------------------------------------------------------------------
// Error envelope shape (ERROR_MODEL v5.1)
// ---------------------------------------------------------------------------

export interface ErrorEnvelope {
  error: {
    code: string;
    message: string;
    detail?: Record<string, unknown>;
    retry_after?: string | null;
    trace_id: string;
    timestamp: string;
  };
}

// ---------------------------------------------------------------------------
// HTTP status → error code + message defaults
// ---------------------------------------------------------------------------

interface ErrorDefaults {
  code: string;
  message: string;
  retryAfter?: string | null;
}

function defaultsForStatus(statusCode: number): ErrorDefaults {
  switch (statusCode) {
    case 400:
      return { code: 'internal.request.invalid', message: 'The request was invalid or malformed.' };
    case 401:
      return { code: 'internal.auth.unauthenticated', message: 'Authentication is required.' };
    case 403:
      return { code: 'internal.auth.insufficient_scope', message: 'You are not authorized to perform this action.' };
    case 404:
      return { code: 'internal.resource.not_found', message: 'The requested resource was not found.' };
    case 409:
      return { code: 'internal.resource.conflict', message: 'The request conflicts with the current state of the resource.' };
    case 422:
      return { code: 'internal.request.semantically_invalid', message: 'The request was semantically invalid.' };
    case 429:
      return { code: 'internal.rate_limit.exceeded', message: 'Rate limit exceeded. Please wait before retrying.' };
    case 503:
      return { code: 'internal.service.unavailable', message: 'The service is temporarily unavailable.', retryAfter: 'PT30S' };
    case 500:
    default:
      return { code: 'internal.service.error', message: 'An internal error occurred.' };
  }
}

// ---------------------------------------------------------------------------
// Cross-tenant 404 — identical to plain 404 per I-025
// ---------------------------------------------------------------------------

/**
 * crossTenantNotFoundError — returns a 404 envelope that is byte-identical
 * to a plain resource-not-found response. No existence signal is leaked.
 *
 * Per I-025 mandatory rules:
 *   "When a tenant-scoped resource lookup by ID fails because the resource is
 *    not in the requestor's authorized tenant scope, the response is 404
 *    NOT_FOUND with code RESOURCE_NOT_FOUND — identical to the response when
 *    the resource ID does not exist at all."
 */
export function crossTenantNotFoundError(traceId: string): ErrorEnvelope {
  return {
    error: {
      code: 'internal.resource.not_found',
      message: 'The requested resource was not found.',
      trace_id: traceId,
      timestamp: new Date().toISOString(),
    },
  };
}

/**
 * insufficientTenantScopeError — 403 for requests supplying an unauthorized
 * tenant_id. Does NOT echo back the requested tenant_id (I-025 rule 2).
 */
export function insufficientTenantScopeError(traceId: string): ErrorEnvelope {
  return {
    error: {
      code: 'internal.auth.insufficient_tenant_scope',
      message: 'Insufficient scope for this request.',
      // Intentionally no `detail` — echoing the requested tenant_id here
      // would confirm the tenant exists (I-025 violation).
      trace_id: traceId,
      timestamp: new Date().toISOString(),
    },
  };
}

// ---------------------------------------------------------------------------
// Build error envelope from FastifyError
// ---------------------------------------------------------------------------

function buildErrorEnvelope(
  error: FastifyError,
  request: FastifyRequest,
  isProd: boolean,
): { statusCode: number; envelope: ErrorEnvelope } {
  const statusCode = error.statusCode ?? 500;
  const defaults = defaultsForStatus(statusCode);
  const traceId = request.id;

  const envelope: ErrorEnvelope = {
    error: {
      code: error.code ?? defaults.code,
      message: isProd && statusCode >= 500
        ? defaults.message          // Never leak internal detail in prod 5xx
        : (error.message || defaults.message),
      trace_id: traceId,
      timestamp: new Date().toISOString(),
    },
  };

  if (defaults.retryAfter !== undefined) {
    envelope.error.retry_after = defaults.retryAfter;
  }

  // Include validation detail for 4xx only (structured input errors are safe to expose)
  // Never include detail for 5xx (implementation leak risk) or 404 (existence leak risk)
  if (statusCode >= 400 && statusCode < 500 && statusCode !== 404 && statusCode !== 403) {
    const validation = (error as unknown as { validation?: unknown }).validation;
    if (validation) {
      envelope.error.detail = { validation };
    }
  }

  return { statusCode, envelope };
}

// ---------------------------------------------------------------------------
// Fastify plugin
// ---------------------------------------------------------------------------

const errorEnvelopePluginImpl = async (fastify: FastifyInstance): Promise<void> => {
  const isProd = process.env['NODE_ENV'] === 'production';

  fastify.setErrorHandler(
    (error: FastifyError, request: FastifyRequest, reply: FastifyReply) => {
      const { statusCode, envelope } = buildErrorEnvelope(error, request, isProd);

      // Log at appropriate level. 5xx logs include the full error for server-side
      // investigation; 4xx logs at warn.
      if (statusCode >= 500) {
        request.log.error(
          {
            err: error,
            statusCode,
            requestId: request.id,
            // Intentionally NO tenant info in the log field name that appears
            // in centralized aggregators accessible to tenant operators (I-023 discipline).
          },
          'Internal server error',
        );
      } else {
        request.log.warn(
          { statusCode, code: error.code, requestId: request.id },
          'Request error',
        );
      }

      void reply.code(statusCode).type('application/json').send(envelope);
    },
  );

  // Fastify 5.x: also handle not-found at the plugin level for uniform envelope
  fastify.setNotFoundHandler((request: FastifyRequest, reply: FastifyReply) => {
    const envelope: ErrorEnvelope = {
      error: {
        code: 'internal.resource.not_found',
        message: 'The requested resource was not found.',
        trace_id: request.id,
        timestamp: new Date().toISOString(),
      },
    };
    void reply.code(404).type('application/json').send(envelope);
  });
};

export const errorEnvelopePlugin = fp(errorEnvelopePluginImpl, {
  name: 'error-envelope',
  fastify: '5.x',
});
