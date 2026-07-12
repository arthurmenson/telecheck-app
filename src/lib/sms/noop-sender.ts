/**
 * sms/noop-sender.ts — default SmsSender when no provider is configured
 * (SMS_PROVIDER=noop). Renders the message (so template errors still surface)
 * but performs NO external send. Logs a skip WITHOUT the code and with only
 * the last 4 digits of the recipient, so a log leak can never expose a live
 * OTP or a full phone number.
 */

import { renderPasscodeSms } from './passcode-template.js';
import type { PasscodeSms, SmsLogger, SmsSender } from './types.js';

/** Last 4 digits only — never the full E.164 number in logs. */
function last4(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  return digits.length >= 4 ? `***${digits.slice(-4)}` : '***';
}

export class NoopSmsSender implements SmsSender {
  constructor(private readonly log: SmsLogger) {}

  sendPasscode(msg: PasscodeSms): Promise<void> {
    renderPasscodeSms(msg); // surface template defects even without a provider
    this.log.warn(
      {
        event: 'passcode_sms_skipped_no_provider',
        purpose: msg.purpose,
        to_last4: last4(msg.to),
      },
      'SMS_PROVIDER=noop — passcode SMS NOT delivered (no provider wired). ' +
        'Set SMS_PROVIDER=telnyx + TELNYX_API_KEY + a sender to enable real delivery.',
    );
    return Promise.resolve();
  }
}
