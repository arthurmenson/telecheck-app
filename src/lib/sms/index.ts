/**
 * sms/index.ts — SmsSender factory + process-wide singleton. Config-driven
 * (SMS_PROVIDER). Default 'noop' → no external send, so an unconfigured
 * environment changes NO behavior. Activation is a config flip
 * (SMS_PROVIDER=telnyx + TELNYX_API_KEY + a sender) by the operator.
 */

import { config } from '../config.js';
import { logger } from '../logger.js';

import { NoopSmsSender } from './noop-sender.js';
import { TelnyxSmsSender } from './telnyx-sender.js';
import type { SmsLogger, SmsSender } from './types.js';

export type { SmsSender, PasscodeSms, OtpPurpose, SmsLogger } from './types.js';

export interface SmsConfig {
  provider: 'noop' | 'telnyx';
  telnyxApiKey?: string | undefined;
  from?: string | undefined;
  messagingProfileId?: string | undefined;
}

export function createSmsSender(smsConfig: SmsConfig, log: SmsLogger): SmsSender {
  if (smsConfig.provider === 'telnyx') {
    if (smsConfig.telnyxApiKey === undefined || smsConfig.telnyxApiKey.length === 0) {
      throw new Error('SMS_PROVIDER=telnyx requires TELNYX_API_KEY.');
    }
    if (!smsConfig.from && !smsConfig.messagingProfileId) {
      throw new Error('SMS_PROVIDER=telnyx requires SMS_FROM or TELNYX_MESSAGING_PROFILE_ID.');
    }
    return new TelnyxSmsSender({
      apiKey: smsConfig.telnyxApiKey,
      from: smsConfig.from,
      messagingProfileId: smsConfig.messagingProfileId,
      log,
    });
  }
  return new NoopSmsSender(log);
}

let singleton: SmsSender | null = null;

/** Lazily-created process singleton wired from `config.sms` + the app logger. */
export function getSmsSender(): SmsSender {
  if (singleton === null) {
    singleton = createSmsSender(config.sms, logger as SmsLogger);
  }
  return singleton;
}

/** Test-only: reset the singleton so a fresh config/logger can be wired. */
export function __resetSmsSenderForTests(): void {
  singleton = null;
}
