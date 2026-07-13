/**
 * sms/telnyx-sender.ts — SmsSender backed by Telnyx (https://telnyx.com).
 *
 * POST https://api.telnyx.com/v2/messages with a Bearer API key. The key is
 * passed in from config, NEVER read from process.env here, and NEVER logged.
 * `fetch` is injected (defaults to global) for unit-testing without a network.
 *
 * Carries the same secret-leak discipline the Resend sender converged on over
 * Codex PR#274 (r1 sanitized rethrow, r1 abort-bounded body parse, r2
 * closed-set error labels): nothing that could smuggle the API key or the OTP
 * plaintext ever reaches logs or a rejection message.
 */

import { renderPasscodeSms } from './passcode-template.js';
import type { PasscodeSms, SmsLogger, SmsSender } from './types.js';

const TELNYX_MESSAGES_URL = 'https://api.telnyx.com/v2/messages';
const SEND_TIMEOUT_MS = 10_000;

export interface TelnyxSenderOptions {
  apiKey: string;
  /** Sending phone number in E.164 (e.g. +18005550111). Mutually optional
   *  with messagingProfileId; at least one must be provided. */
  from?: string | undefined;
  /** Telnyx messaging profile id — picks a number from the profile's pool. */
  messagingProfileId?: string | undefined;
  log: SmsLogger;
  fetchImpl?: typeof fetch;
}

export class TelnyxSmsSender implements SmsSender {
  readonly #apiKey: string;
  readonly #from: string | undefined;
  readonly #profileId: string | undefined;
  readonly #log: SmsLogger;
  readonly #fetch: typeof fetch;

  constructor(opts: TelnyxSenderOptions) {
    if (opts.apiKey.length === 0) {
      throw new Error('TelnyxSmsSender requires a non-empty apiKey.');
    }
    if (!opts.from && !opts.messagingProfileId) {
      throw new Error('TelnyxSmsSender requires either from (E.164) or messagingProfileId.');
    }
    this.#apiKey = opts.apiKey;
    this.#from = opts.from;
    this.#profileId = opts.messagingProfileId;
    this.#log = opts.log;
    this.#fetch = opts.fetchImpl ?? fetch;
  }

  async sendPasscode(msg: PasscodeSms): Promise<void> {
    const text = renderPasscodeSms(msg);
    const body: Record<string, string> = { to: msg.to, text };
    // messaging_profile_id takes precedence when both are set (pool sending).
    if (this.#profileId) body.messaging_profile_id = this.#profileId;
    else if (this.#from) body.from = this.#from;

    // Timer stays live across ALL response handling (Codex PR#274 r1 MEDIUM):
    // a stalled error body must not pin the un-awaited dispatch promise.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);
    try {
      let resp: Response;
      try {
        resp = await this.#fetch(TELNYX_MESSAGES_URL, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${this.#apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
      } catch (err) {
        const name = errName(err);
        this.#log.error(
          { event: 'passcode_sms_send_error', purpose: msg.purpose, err: name },
          'Telnyx passcode SMS send failed (transport).',
        );
        // SANITIZED rethrow (Codex PR#274 r1 HIGH): the ORIGINAL transport
        // error can carry request options (Authorization header = API key;
        // body = OTP plaintext) via cause/metadata a caller-side
        // log.error({ err }) would serialize. Only a stable label crosses.
        throw new Error(`telnyx transport failure: ${name}`);
      }

      if (!resp.ok) {
        const detail = await safeErrorCode(resp, controller.signal);
        this.#log.error(
          {
            event: 'passcode_sms_send_rejected',
            purpose: msg.purpose,
            status: resp.status,
            detail,
          },
          'Telnyx rejected the passcode SMS.',
        );
        throw new Error(`telnyx rejected passcode sms: HTTP ${resp.status}`);
      }

      // Success: release the body without reading it so an unread stream
      // cannot hold the connection open past this call.
      try {
        await resp.body?.cancel();
      } catch {
        // Already consumed/closed.
      }
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Closed-set transport label (Codex PR#274 r2 HIGH): Error.name is as
 *  runtime-controllable as message/cause; only these two literals escape. */
function errName(err: unknown): 'timeout' | 'transport_error' {
  if (err instanceof Error && err.name === 'AbortError') return 'timeout';
  return 'transport_error';
}

/** Rejects when (or if already) aborted — bounds the provider body read. */
function abortRejection(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    const onAbort = (): void => reject(new Error('aborted'));
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Telnyx error bodies are `{ errors: [{ code, title, detail }] }`. Return the
 * first error's `code` only, clamped to a safe token shape (same closed-shape
 * discipline as the Resend sender): the body is external input and must not
 * carry arbitrary strings into logs. The read is raced against the abort
 * signal so a stalled body resolves as 'unparseable' at the timeout.
 */
async function safeErrorCode(resp: Response, signal: AbortSignal): Promise<string> {
  try {
    const parsed = (await Promise.race([resp.json(), abortRejection(signal)])) as {
      errors?: Array<{ code?: unknown }>;
    };
    const code = parsed.errors?.[0]?.code;
    const asStr = typeof code === 'string' ? code : typeof code === 'number' ? String(code) : '';
    return /^[a-z0-9_]{1,64}$/i.test(asStr) ? asStr : 'unknown';
  } catch {
    return 'unparseable';
  }
}
