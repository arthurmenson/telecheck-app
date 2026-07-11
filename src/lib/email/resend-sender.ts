/**
 * email/resend-sender.ts — EmailSender backed by Resend (https://resend.com).
 *
 * POST https://api.resend.com/emails with a Bearer API key. The key is passed
 * into the constructor (from config), NEVER read from process.env here, and
 * NEVER logged — same discipline as the Anthropic provider adapter.
 *
 * `fetch` is injected (defaults to the global) so the sender is unit-testable
 * without a network, mirroring anthropic-provider.ts.
 */

import { renderPasscodeEmail } from './passcode-template.js';
import type { EmailLogger, EmailSender, PasscodeMessage } from './types.js';

const RESEND_EMAILS_URL = 'https://api.resend.com/emails';
const SEND_TIMEOUT_MS = 10_000;

export interface ResendSenderOptions {
  apiKey: string;
  /** Fully-formed From header, e.g. `Heros Health <no-reply@heroshealth.com>`. */
  from: string;
  log: EmailLogger;
  fetchImpl?: typeof fetch;
}

export class ResendEmailSender implements EmailSender {
  readonly #apiKey: string;
  readonly #from: string;
  readonly #log: EmailLogger;
  readonly #fetch: typeof fetch;

  constructor(opts: ResendSenderOptions) {
    if (opts.apiKey.length === 0) {
      throw new Error('ResendEmailSender requires a non-empty apiKey.');
    }
    this.#apiKey = opts.apiKey;
    this.#from = opts.from;
    this.#log = opts.log;
    this.#fetch = opts.fetchImpl ?? fetch;
  }

  async sendPasscode(msg: PasscodeMessage): Promise<void> {
    const { subject, text, html } = renderPasscodeEmail(msg);

    // The abort timer stays live until ALL response handling is done (Codex
    // PR#274 r1 MEDIUM): fetch can resolve on headers while a stalled error
    // body keeps `resp.json()` pending forever — which would pin the caller's
    // un-awaited dispatch promise indefinitely. The non-2xx body parse below
    // is raced against this same signal, so the 10s bound covers it.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);
    try {
      let resp: Response;
      try {
        resp = await this.#fetch(RESEND_EMAILS_URL, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${this.#apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ from: this.#from, to: [msg.to], subject, text, html }),
          signal: controller.signal,
        });
      } catch (err) {
        // Network/timeout. Log WITHOUT the code or full recipient.
        const name = errName(err);
        this.#log.error(
          { event: 'passcode_email_send_error', purpose: msg.purpose, err: name },
          'Resend passcode email send failed (transport).',
        );
        // SANITIZED rethrow (Codex PR#274 r1 HIGH): never let the ORIGINAL
        // transport error cross the fire-and-forget boundary — runtime fetch
        // errors can carry the request options (Authorization header = API
        // key; body = passcode plaintext) via cause/metadata properties,
        // which a caller-side `log.error({ err })` would serialize. Only a
        // stable name crosses.
        throw new Error(`resend transport failure: ${name}`);
      }

      if (!resp.ok) {
        // Do not log the response body verbatim — a misconfig echo could
        // contain the payload. Log status + Resend's error name only. Parse
        // is bounded by the abort signal (see timer note above).
        const detail = await safeErrorName(resp, controller.signal);
        this.#log.error(
          {
            event: 'passcode_email_send_rejected',
            purpose: msg.purpose,
            status: resp.status,
            detail,
          },
          'Resend rejected the passcode email.',
        );
        throw new Error(`resend rejected passcode email: HTTP ${resp.status}`);
      }

      // Success: release the (small) response body without reading it so an
      // unread stream cannot hold the connection open past this call.
      try {
        await resp.body?.cancel();
      } catch {
        // Body already consumed/closed — nothing to release.
      }
    } finally {
      clearTimeout(timer);
    }
  }
}

function errName(err: unknown): string {
  if (err instanceof Error) return err.name === 'AbortError' ? 'timeout' : err.name;
  return 'unknown';
}

/** Rejects when (or if already) aborted — used to bound provider body reads. */
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
 * Resend error bodies are `{ name, message, statusCode }`; return `name` only.
 * The read is raced against the request's abort signal so a stalled error
 * body resolves as 'unparseable' at the timeout instead of hanging forever
 * (Codex PR#274 r1 MEDIUM).
 */
async function safeErrorName(resp: Response, signal: AbortSignal): Promise<string> {
  try {
    const body = (await Promise.race([resp.json(), abortRejection(signal)])) as {
      name?: unknown;
    };
    return typeof body.name === 'string' ? body.name : 'unknown';
  } catch {
    return 'unparseable';
  }
}
