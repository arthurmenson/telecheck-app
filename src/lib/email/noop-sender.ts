/**
 * email/noop-sender.ts — the default EmailSender when no provider is
 * configured (EMAIL_PROVIDER=noop). It renders the message (so template
 * errors still surface) but performs NO external send. It logs that a send
 * was skipped — WITHOUT the code — so operators can see delivery was not
 * wired, but a log leak can never expose a live passcode.
 *
 * This preserves the pre-provider behavior: in staging the `dev_passcode`
 * echo still lets testers complete the flow; in any environment the passcode
 * is issued + persisted regardless of delivery.
 */

import { renderPasscodeEmail } from './passcode-template.js';
import type { EmailLogger, EmailSender, PasscodeMessage } from './types.js';

export class NoopEmailSender implements EmailSender {
  constructor(private readonly log: EmailLogger) {}

  sendPasscode(msg: PasscodeMessage): Promise<void> {
    // Render to surface any template defect even without a provider; discard.
    renderPasscodeEmail(msg);
    this.log.warn(
      {
        event: 'passcode_email_skipped_no_provider',
        purpose: msg.purpose,
        // Never log `to` in full (PII) or `code` (live credential).
        to_domain: msg.to.includes('@') ? msg.to.slice(msg.to.indexOf('@')) : 'unknown',
      },
      'EMAIL_PROVIDER=noop — passcode email NOT delivered (no provider wired). ' +
        'Set EMAIL_PROVIDER=resend + RESEND_API_KEY to enable real delivery.',
    );
    return Promise.resolve();
  }
}
