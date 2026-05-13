/**
 * identity/index.ts — public interface for the Identity & Auth module.
 *
 * Per ADR-001 modular monolith: only the names re-exported below are
 * legitimate cross-module imports. Anything under `./internal/*` is
 * module-private and MUST NOT be imported from other modules — the
 * ESLint `import/no-restricted-paths` rule catches regressions.
 *
 * Spec references:
 *   - ADR-001 (modular monolith — extraction-ready boundaries)
 *   - CDM v1.2 §3.2 (Identity & Account entities 7-10)
 *   - Identity & Authentication Spec v1.0
 */

// ---------------------------------------------------------------------------
// Public type re-exports
//
// Only types that cross the module boundary are re-exported here. Internal
// row shapes (Account, Session, OtpChallenge, AuthDevice) stay private —
// cross-module consumers receive opaque IDs and patient-safe view types,
// not the full PHI rows.
// ---------------------------------------------------------------------------

export type { AccountId, SessionId, OtpId, DeviceId } from './internal/types.js';

export { asAccountId, asSessionId, asOtpId, asDeviceId } from './internal/types.js';

// Patient-safe view types (the projection that handlers serving patient
// surfaces should return; tenant_id stripped per Master PRD v1.10 §17 +
// Glossary v5.2 C3).
export type { PatientAccountView } from './internal/services/account-service.js';
export type { PatientSessionView } from './internal/services/session-service.js';

// ---------------------------------------------------------------------------
// Service-layer public functions
//
// Cross-module callers (e.g., a future Subscription module that needs to
// resolve an Account by ID for billing) should call THESE functions, not
// reach into ./internal/services/* directly.
//
// Note: most identity service functions take a TenantContext + actor +
// inputs. The plugin (deferred to next commit) wires the request-scoped
// TenantContext + JWT-resolved actor automatically. Cross-module callers
// outside an HTTP request flow (e.g., async jobs) construct the
// TenantContext themselves.
// ---------------------------------------------------------------------------

export {
  createAccount,
  activateAccount,
  findAccountById,
  findAccountByPhoneE164,
  toPatientAccountView,
} from './internal/services/account-service.js';

export type { CreateAccountServiceInput } from './internal/services/account-service.js';

export {
  issueSession,
  revokeSession,
  findSessionById,
  findActiveSessionById,
  findActiveSessionByRefreshToken,
  listActiveSessionsForAccount,
  toPatientSessionView,
  generateRefreshToken,
  hashRefreshToken,
} from './internal/services/session-service.js';

export type { IssueSessionInput } from './internal/services/session-service.js';

export {
  issueOtp,
  verifyOtp,
  generateOtpCode,
  hashOtpCode,
  timingSafeHashEqual,
  OTP_LOCKOUT_ACTIVE,
  OTP_NO_ACTIVE_CHALLENGE,
  OTP_INVALID_CODE,
  OTP_LOCKOUT_TRIGGERED,
} from './internal/services/otp-service.js';

export type { IssueOtpInput, VerifyOtpResult } from './internal/services/otp-service.js';

export {
  registerDevice,
  revokeDevice,
  findDeviceById,
  listActiveDevicesForAccount,
} from './internal/services/auth-device-service.js';

export type { RegisterDeviceInput } from './internal/services/auth-device-service.js';

// ---------------------------------------------------------------------------
// Future plugin re-export
// ---------------------------------------------------------------------------

// `identityPlugin` will be re-exported here when the Fastify plugin is
// authored (next commit). It registers the JWT verification hook that
// replaces the forms-intake module's `x-actor-id` / `x-patient-id` header
// stubs with real JWT-resolved actor context.
//
// Cross-module callers do NOT register this plugin — `src/app.ts` is the
// single registration site, mirroring formsIntakePlugin.
