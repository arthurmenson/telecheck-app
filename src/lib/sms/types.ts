/**
 * sms/types.ts — provider-agnostic transactional-SMS boundary. The phone-OTP
 * analogue of src/lib/email (see that module's header for the full rationale).
 *
 * Until this module, the phone OTP was generated + persisted then either
 * echoed (staging `dev_otp`, AUTH_DEV_OTP_ECHO-gated) or discarded — no SMS
 * ever sent, so phone login/registration was unreachable without the echo.
 * This is the seam a real provider (Telnyx) plugs into.
 *
 * Design constraints (identical to the email sender — do not regress):
 *   - Callers FIRE-AND-FORGET after the DB tx commits: delivery must not block
 *     the response (provider latency / uniform-work timing) or fail the request
 *     on a provider outage. The OTP is issued + persisted regardless.
 *   - Implementations MAY reject so the caller can log; they MUST NOT surface
 *     which phone numbers exist, and MUST NOT log the code or full number.
 *   - Brand is the consumer DBA (`tenant.consumer_dba`), never the tenant id.
 *
 * Spec status: §12 Spec Issue (docs/SI-SMS-DELIVERY-PROVIDER.md) — the SMS
 * analogue of the email-delivery SI; no canonical notification contract exists.
 */

export type OtpPurpose = 'login' | 'registration';

export interface PasscodeSms {
  /** Recipient phone in E.164 (already validated by the caller). */
  to: string;
  /** The plaintext one-time code. Held only long enough to send; never logged. */
  code: string;
  /** What the code authorizes — drives copy. */
  purpose: OtpPurpose;
  /** Consumer-facing brand, from `tenant.consumer_dba`. Never the tenant id. */
  consumerDba: string;
  /** Code lifetime in minutes, for the "expires in N minutes" line. */
  ttlMinutes: number;
}

export interface SmsSender {
  /**
   * Deliver a one-time passcode SMS. Resolves on accepted-for-delivery;
   * rejects on a provider/transport error so the caller can log it. Callers
   * fire-and-forget: a rejection never fails the originating request.
   */
  sendPasscode(msg: PasscodeSms): Promise<void>;
}

/**
 * Minimal structural logger. Satisfied by pino's `Logger` and Fastify's
 * `req.log` alike, without importing either.
 */
export interface SmsLogger {
  warn(obj: Record<string, unknown>, msg?: string): void;
  error(obj: Record<string, unknown>, msg?: string): void;
}
