/**
 * email/types.ts — provider-agnostic transactional-email boundary.
 *
 * The platform generates one-time passcodes (email+PIN auth, migration 078)
 * and, historically, phone OTPs. Delivery was a stub until this module: the
 * plaintext code was generated and either echoed (staging `dev_passcode`,
 * AUTH_DEV_OTP_ECHO-gated) or discarded. This interface is the seam a real
 * provider plugs into.
 *
 * Design constraints (do not regress):
 *   - Callers FIRE-AND-FORGET after the DB transaction commits. Delivery must
 *     never (a) block the HTTP response — that would add provider latency to
 *     the request and, because start endpoints must do uniform work for every
 *     email (Codex round-6 enumeration/timing defense), risk a timing oracle;
 *     or (b) fail the request on a provider outage.
 *   - Implementations MAY reject so the caller can log the failure; the caller
 *     swallows it. They MUST NOT surface which email addresses exist.
 *   - Brand is the consumer DBA (`tenant.consumer_dba`, e.g. "Heros Health"),
 *     NEVER the operating-tenant id (Glossary v5.2 C3 brand structure).
 *
 * Spec status: no canonical notification/messaging contract exists yet — this
 * is flagged as a §12 Spec Issue (docs/SI-EMAIL-DELIVERY-PROVIDER.md), the
 * same posture as the pending SMS-provider SI referenced in config.ts.
 */

export type PasscodePurpose = 'email_registration' | 'pin_recovery';

export interface PasscodeMessage {
  /** Recipient email (already normalized/validated by the caller). */
  to: string;
  /** The plaintext one-time code. Held only long enough to send; never logged. */
  code: string;
  /** What the code authorizes — drives copy (verify email vs reset PIN). */
  purpose: PasscodePurpose;
  /** Consumer-facing brand, from `tenant.consumer_dba`. Never the tenant id. */
  consumerDba: string;
  /** Code lifetime in minutes, for the "expires in N minutes" line. */
  ttlMinutes: number;
}

export interface EmailSender {
  /**
   * Deliver a one-time passcode email. Resolves on accepted-for-delivery;
   * rejects on a provider/transport error so the caller can log it. Callers
   * fire-and-forget: a rejection never fails the originating request.
   */
  sendPasscode(msg: PasscodeMessage): Promise<void>;
}

/**
 * Minimal structural logger the senders need. Satisfied by pino's `Logger`
 * and by Fastify's `req.log` alike, without importing either — keeps the
 * email module dependency-light and unit-testable with a plain stub.
 */
export interface EmailLogger {
  warn(obj: Record<string, unknown>, msg?: string): void;
  error(obj: Record<string, unknown>, msg?: string): void;
}
