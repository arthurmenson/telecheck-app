/**
 * consents.ts — POST /v0/consent/consents (grant) and POST
 * /v0/consent/consents/revoke handlers per Consent Slice PRD v1.0.
 *
 *   POST /v0/consent/consents
 *     Auth: Bearer JWT (req.actorContext required)
 *     Body: { consent_type, scope_id?, consent_version_id, evidence,
 *             expires_at? }
 *     - Grants consent for the authenticated patient (account_id from
 *       req.actorContext.accountId)
 *     - Returns 201 + Consent row (PHI-safe; tenant_id stripped)
 *
 *   POST /v0/consent/consents/revoke
 *     Auth: Bearer JWT
 *     Body: { consent_type, scope_id?, consent_version_id, reason,
 *             evidence }
 *     - Revokes the active consent for (account, type, scope_id)
 *     - Returns 200 + revoked Consent row, or 404 if no active consent
 *       to revoke
 *
 *   GET /v0/consent/consents/me
 *     Auth: Bearer JWT
 *     - Returns the calling patient's full consent history
 *     - Tenant_id stripped from each row
 *
 * Spec references:
 *   - Consent Slice PRD v1.0 §5-§9
 *   - I-003 (audit append-only)
 *   - I-025 (tenant-blind 404)
 *   - Master PRD v1.10 §17 + Glossary v5.2 C3 (no tenant_id leak)
 */

import type { FastifyReply, FastifyRequest } from 'fastify';

import { requirePatientActorContext } from '../../../../lib/auth-context.js';
import { withIdempotentExecution } from '../../../../lib/idempotent-handler.js';
import { requireTenantContext } from '../../../../lib/tenant-context.js';
import type { AccountId } from '../../../identity/internal/types.js';
import * as consentService from '../services/consent-service.js';
import {
  asConsentVersionId,
  type Consent,
  type ConsentEvidence,
  type ConsentRevocationReason,
  type ConsentType,
} from '../types.js';

// ---------------------------------------------------------------------------
// PHI-safe view: strip tenant_id
// ---------------------------------------------------------------------------

type PatientConsentView = Omit<Consent, 'tenant_id'>;

function toPatientView(consent: Consent): PatientConsentView {
  const { tenant_id: _stripped, ...patientView } = consent;
  void _stripped;
  return patientView;
}

// ---------------------------------------------------------------------------
// Body shapes + validators
// ---------------------------------------------------------------------------

interface GrantBody {
  consent_type?: string;
  scope_id?: string | null;
  consent_version_id?: string;
  evidence?: Record<string, unknown>;
  expires_at?: string | null;
}

interface RevokeBody {
  consent_type?: string;
  scope_id?: string | null;
  consent_version_id?: string;
  reason?: string;
  evidence?: Record<string, unknown>;
}

const VALID_TYPES = new Set([
  'platform',
  'care',
  'data_use',
  'delegation',
  'jurisdictional',
  'episode',
]);

const VALID_REASONS = new Set([
  'patient_initiated',
  'account_closed',
  'jurisdictional_change',
  'admin_revoked',
  'expired',
]);

function isString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}

function isEvidence(v: unknown): v is ConsentEvidence {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return typeof o['timestamp'] === 'string';
}

// ---------------------------------------------------------------------------
// Service-error mapping for withIdempotentExecution. Consent handlers don't
// currently distinguish service-error classes for HTTP status mapping —
// errors propagate to Fastify's global error handler. Return false to
// signal "I didn't map; propagate the throw."
// ---------------------------------------------------------------------------

function mapServiceError(): boolean {
  return false;
}

// ---------------------------------------------------------------------------
// POST /v0/consent/consents
// ---------------------------------------------------------------------------

export async function grantConsentHandler(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<unknown> {
  const ctx = requireTenantContext(req);
  const actor = requirePatientActorContext(req);
  const body = (req.body ?? {}) as GrantBody;

  if (
    !isString(body.consent_type) ||
    !VALID_TYPES.has(body.consent_type) ||
    !isString(body.consent_version_id) ||
    !isEvidence(body.evidence)
  ) {
    return reply.code(400).send({
      error: {
        code: 'internal.request.invalid',
        message:
          'consent_type (enum), consent_version_id, and evidence (with timestamp) are required.',
        request_id: req.id,
      },
    });
  }

  const grantInput: consentService.GrantConsentInput = {
    account_id: actor.accountId as AccountId,
    consent_type: body.consent_type as ConsentType,
    consent_version_id: asConsentVersionId(body.consent_version_id),
    evidence: body.evidence,
  };
  if (body.scope_id !== undefined) grantInput.scope_id = body.scope_id;
  if (body.expires_at !== undefined) grantInput.expires_at = body.expires_at;

  return withIdempotentExecution(req, reply, mapServiceError, async (tx) => {
    const consent = await consentService.grantConsent(
      ctx,
      { actorId: actor.accountId },
      grantInput,
      tx,
    );
    return { status: 201, view: toPatientView(consent) };
  });
}

// ---------------------------------------------------------------------------
// POST /v0/consent/consents/revoke
// ---------------------------------------------------------------------------

export async function revokeConsentHandler(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<unknown> {
  const ctx = requireTenantContext(req);
  const actor = requirePatientActorContext(req);
  const body = (req.body ?? {}) as RevokeBody;

  if (
    !isString(body.consent_type) ||
    !VALID_TYPES.has(body.consent_type) ||
    !isString(body.consent_version_id) ||
    !isString(body.reason) ||
    !VALID_REASONS.has(body.reason) ||
    !isEvidence(body.evidence)
  ) {
    return reply.code(400).send({
      error: {
        code: 'internal.request.invalid',
        message: 'consent_type (enum), consent_version_id, reason (enum), evidence required.',
        request_id: req.id,
      },
    });
  }

  const revokeInput: consentService.RevokeConsentInput = {
    account_id: actor.accountId as AccountId,
    consent_type: body.consent_type as ConsentType,
    consent_version_id: asConsentVersionId(body.consent_version_id),
    reason: body.reason as ConsentRevocationReason,
    evidence: body.evidence,
  };
  if (body.scope_id !== undefined) revokeInput.scope_id = body.scope_id;

  return withIdempotentExecution(req, reply, mapServiceError, async (tx) => {
    const revoked = await consentService.revokeConsent(
      ctx,
      { actorId: actor.accountId },
      revokeInput,
      tx,
    );
    if (revoked === null) {
      // 404 for no-active-consent. Cached so retry replays the same 404.
      return {
        status: 404,
        view: {
          error: {
            code: 'internal.resource.not_found',
            message: 'No active consent to revoke.',
            request_id: req.id,
          },
        } as unknown as Omit<Consent, 'tenant_id'>,
      };
    }
    return { status: 200, view: toPatientView(revoked) };
  });
}

// ---------------------------------------------------------------------------
// GET /v0/consent/consents/me
// ---------------------------------------------------------------------------

export async function getMyConsentHistoryHandler(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<unknown> {
  const ctx = requireTenantContext(req);
  const actor = requirePatientActorContext(req);

  const history = await consentService.listConsentHistory(ctx, actor.accountId as AccountId);
  return reply.code(200).send({
    consents: history.map(toPatientView),
  });
}
