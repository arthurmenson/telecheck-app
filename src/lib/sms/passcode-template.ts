/**
 * sms/passcode-template.ts — renders the SMS body for a one-time passcode.
 * Plain text only (no HTML). Kept under ~160 GSM-7 chars to stay a single
 * segment where possible.
 *
 * Copy rules (DIC v1.1): honest + literal, no emoji (cross-market reliability),
 * brand = consumer DBA. The code leads so it surfaces in the lock-screen
 * preview; the "not you? ignore" line closes.
 */

import type { PasscodeSms } from './types.js';

export function renderPasscodeSms(msg: PasscodeSms): string {
  return (
    `${msg.code} is your ${msg.consumerDba} verification code. ` +
    `It expires in ${msg.ttlMinutes} minutes. ` +
    `If you didn't request it, ignore this message.`
  );
}
