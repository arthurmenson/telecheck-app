/**
 * email/index.ts — EmailSender factory + process-wide singleton.
 *
 * Selection is config-driven (EMAIL_PROVIDER). Default 'noop' → no external
 * send, so an unconfigured/dev/test/CI environment changes NO behavior when
 * this module lands: the passcode is still issued + persisted, and staging's
 * `dev_passcode` echo still completes the flow. Activation is a pure config
 * flip (EMAIL_PROVIDER=resend + RESEND_API_KEY) by the operator.
 */

import { config } from '../config.js';
import { logger } from '../logger.js';

import { NoopEmailSender } from './noop-sender.js';
import { ResendEmailSender } from './resend-sender.js';
import type { EmailLogger, EmailSender } from './types.js';

export type { EmailSender, PasscodeMessage, PasscodePurpose, EmailLogger } from './types.js';

export interface EmailConfig {
  provider: 'noop' | 'resend';
  resendApiKey?: string | undefined;
  from: string;
}

/**
 * Build an EmailSender from config. Exported for tests (inject a stub logger
 * / config) and used by the lazy singleton below.
 */
export function createEmailSender(emailConfig: EmailConfig, log: EmailLogger): EmailSender {
  if (emailConfig.provider === 'resend') {
    if (emailConfig.resendApiKey === undefined || emailConfig.resendApiKey.length === 0) {
      // config.ts fail-fast should have caught this; belt-and-suspenders so we
      // never silently fall back to noop when 'resend' was explicitly asked.
      throw new Error('EMAIL_PROVIDER=resend requires RESEND_API_KEY.');
    }
    return new ResendEmailSender({
      apiKey: emailConfig.resendApiKey,
      from: emailConfig.from,
      log,
    });
  }
  return new NoopEmailSender(log);
}

let singleton: EmailSender | null = null;

/** Lazily-created process singleton wired from `config.email` + the app logger. */
export function getEmailSender(): EmailSender {
  if (singleton === null) {
    singleton = createEmailSender(config.email, logger as EmailLogger);
  }
  return singleton;
}

/** Test-only: reset the singleton so a fresh config/logger can be wired. */
export function __resetEmailSenderForTests(): void {
  singleton = null;
}
