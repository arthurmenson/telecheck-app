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

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);
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
      // Network/timeout. Log WITHOUT the code or full recipient, then rethrow
      // so the fire-and-forget caller records a delivery failure.
      this.#log.error(
        { event: 'passcode_email_send_error', purpose: msg.purpose, err: errName(err) },
        'Resend passcode email send failed (transport).',
      );
      throw err instanceof Error ? err : new Error('resend send failed');
    } finally {
      clearTimeout(timer);
    }

    if (!resp.ok) {
      // Do not log the response body verbatim — a misconfig echo could contain
      // the payload. Log status + Resend's error name only.
      const detail = await safeErrorName(resp);
      this.#log.error(
        { event: 'passcode_email_send_rejected', purpose: msg.purpose, status: resp.status, detail },
        'Resend rejected the passcode email.',
      );
      throw new Error(`resend rejected passcode email: HTTP ${resp.status}`);
    }
  }
}

function errName(err: unknown): string {
  if (err instanceof Error) return err.name === 'AbortError' ? 'timeout' : err.name;
  return 'unknown';
}

/** Resend error bodies are `{ name, message, statusCode }`; return `name` only. */
async function safeErrorName(resp: Response): Promise<string> {
  try {
    const body = (await resp.json()) as { name?: unknown };
    return typeof body.name === 'string' ? body.name : 'unknown';
  } catch {
    return 'unparseable';
  }
}
