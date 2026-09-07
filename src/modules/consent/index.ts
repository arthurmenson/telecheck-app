/**
 * consent/index.ts — public interface for the Consent & Delegated Access
 * module. Per ADR-001 modular monolith.
 *
 * Spec references:
 *   - ADR-001 (modular monolith)
 *   - Consent Slice PRD v1.0
 *   - CDM v1.2 §3.3
 */

// ---------------------------------------------------------------------------
// Branded ID types + constructors
// ---------------------------------------------------------------------------

export type {
  ConsentId,
  ConsentVersionId,
  DelegationId,
  DelegationScopeId,
} from './internal/types.js';

export {
  asConsentId,
  asConsentVersionId,
  asDelegationId,
  asDelegationScopeId,
} from './internal/types.js';

// ---------------------------------------------------------------------------
// Enums (cross-module callers may need these)
// ---------------------------------------------------------------------------

export type {
  ConsentType,
  ConsentStatus,
  ConsentRevocationReason,
  DelegationRelationshipType,
  DelegationStatus,
  DelegationRevocationReason,
  DelegationScope,
} from './internal/types.js';

// ---------------------------------------------------------------------------
// Consent service
// ---------------------------------------------------------------------------

export {
  grantConsent,
  revokeConsent,
  hasActiveConsent,
  findLatestConsent,
  listConsentHistory,
} from './internal/services/consent-service.js';

export type { GrantConsentInput, RevokeConsentInput } from './internal/services/consent-service.js';

// Published-policy patient operations require a caller-owned transaction with
// its trusted tenant and live request nonce already bound. They authorize only
// that patient. They do not grant clinician or background-worker access.
export {
  resolveCareConsentInTransaction as resolveCareConsentForPatient,
  getCareConsentStatus,
} from './internal/services/care-consent.js';
export type { CareConsentPatientContext } from './internal/services/care-consent.js';
export type {
  CarePolicyProposal,
  CarePolicyTerm,
} from './internal/services/care-policy-contract.js';

// ---------------------------------------------------------------------------
// Delegation service
// ---------------------------------------------------------------------------

export {
  inviteDelegate,
  acceptDelegation,
  declineDelegation,
  revokeDelegation,
  grantScope,
  revokeScope,
  findDelegationById,
  listActiveDelegationsForGrantor,
  listActiveDelegationsForDelegate,
  listActiveScopesForDelegation,
  DELEGATION_CHAIN_FORBIDDEN,
  DELEGATION_SELF_FORBIDDEN,
} from './internal/services/delegation-service.js';

export type {
  InviteDelegateInput,
  GrantScopeInput,
} from './internal/services/delegation-service.js';

// ---------------------------------------------------------------------------
// Future plugin re-export
// ---------------------------------------------------------------------------
//
// `consentPlugin` will be re-exported here when the Fastify plugin is
// authored (next commit). Cross-module callers do NOT register this
// plugin — `src/app.ts` is the single registration site.
