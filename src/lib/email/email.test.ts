/**
 * email.test.ts — unit coverage for the transactional-email module:
 * template rendering, provider factory selection, and both senders. Pure
 * (no network): the Resend sender's `fetch` is injected.
 */
import { describe, expect, it, vi } from 'vitest';

import { NoopEmailSender } from './noop-sender.js';
import { renderPasscodeEmail } from './passcode-template.js';
import { ResendEmailSender } from './resend-sender.js';
import type { EmailLogger, PasscodeMessage } from './types.js';

import { createEmailSender } from './index.js';

const CODE = '481973';
const baseMsg = (purpose: PasscodeMessage['purpose']): PasscodeMessage => ({
  to: 'patient@example.com',
  code: CODE,
  purpose,
  consumerDba: 'Heros Health',
  ttlMinutes: 5,
});

type LogEntry = { obj: Record<string, unknown>; msg: string | undefined };
function capturingLogger(): EmailLogger & { entries: LogEntry[] } {
  const entries: LogEntry[] = [];
  return {
    entries,
    warn: (obj, msg) => entries.push({ obj, msg }),
    error: (obj, msg) => entries.push({ obj, msg }),
  };
}

describe('renderPasscodeEmail', () => {
  it('registration copy: verification subject, code, ttl, brand, no emoji', () => {
    const r = renderPasscodeEmail(baseMsg('email_registration'));
    expect(r.subject).toBe('Your Heros Health verification code');
    expect(r.text).toContain(CODE);
    expect(r.text).toContain('5 minutes');
    expect(r.text).toContain('Heros Health');
    expect(r.html).toContain(CODE);
    // No emoji anywhere (cross-market reliability rule).
    expect(/\p{Extended_Pictographic}/u.test(r.subject + r.text + r.html)).toBe(false);
  });

  it('recovery copy: PIN reset subject', () => {
    const r = renderPasscodeEmail(baseMsg('pin_recovery'));
    expect(r.subject).toBe('Your Heros Health PIN reset code');
    expect(r.text.toLowerCase()).toContain('reset your heros health pin');
  });

  it('escapes HTML metacharacters in the brand (no injection)', () => {
    const r = renderPasscodeEmail({ ...baseMsg('pin_recovery'), consumerDba: '<b>x</b>' });
    expect(r.html).not.toContain('<b>x</b>');
    expect(r.html).toContain('&lt;b&gt;x&lt;/b&gt;');
  });
});

describe('createEmailSender', () => {
  it('defaults to NoopEmailSender for provider=noop', () => {
    const s = createEmailSender({ provider: 'noop', from: 'x@y.z' }, capturingLogger());
    expect(s).toBeInstanceOf(NoopEmailSender);
  });

  it('builds ResendEmailSender for provider=resend with a key', () => {
    const s = createEmailSender(
      { provider: 'resend', resendApiKey: 're_test', from: 'x@y.z' },
      capturingLogger(),
    );
    expect(s).toBeInstanceOf(ResendEmailSender);
  });

  it('throws for provider=resend without a key (never silently falls back to noop)', () => {
    expect(() =>
      createEmailSender({ provider: 'resend', from: 'x@y.z' }, capturingLogger()),
    ).toThrow(/RESEND_API_KEY/);
  });
});

describe('NoopEmailSender', () => {
  it('resolves, sends nothing, and never logs the code', async () => {
    const log = capturingLogger();
    await new NoopEmailSender(log).sendPasscode(baseMsg('email_registration'));
    expect(log.entries.length).toBe(1);
    expect(JSON.stringify(log.entries)).not.toContain(CODE);
    // Logs the recipient DOMAIN only, never the full address.
    expect(JSON.stringify(log.entries)).not.toContain('patient@example.com');
  });
});

describe('ResendEmailSender', () => {
  it('POSTs to the Resend API with bearer auth and the rendered body', async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ id: 'e_1' }), { status: 200 }),
    );
    const sender = new ResendEmailSender({
      apiKey: 're_test',
      from: 'Heros Health <no-reply@heroshealth.com>',
      log: capturingLogger(),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await sender.sendPasscode(baseMsg('email_registration'));

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.resend.com/emails');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer re_test');
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.from).toBe('Heros Health <no-reply@heroshealth.com>');
    expect(body.to).toEqual(['patient@example.com']);
    expect(body.subject).toBe('Your Heros Health verification code');
    expect(String(body.text)).toContain(CODE);
  });

  it('rejects and logs status+name (never the code) on a non-2xx', async () => {
    const log = capturingLogger();
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ name: 'validation_error' }), { status: 422 }),
    );
    const sender = new ResendEmailSender({
      apiKey: 're_test',
      from: 'x@y.z',
      log,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(sender.sendPasscode(baseMsg('pin_recovery'))).rejects.toThrow(/HTTP 422/);
    const dump = JSON.stringify(log.entries);
    expect(dump).toContain('validation_error');
    expect(dump).not.toContain(CODE);
  });

  it('rejects and logs a transport error without the code', async () => {
    const log = capturingLogger();
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    const sender = new ResendEmailSender({
      apiKey: 're_test',
      from: 'x@y.z',
      log,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(sender.sendPasscode(baseMsg('email_registration'))).rejects.toThrow();
    expect(JSON.stringify(log.entries)).not.toContain(CODE);
  });

  it('constructor rejects an empty API key', () => {
    expect(
      () => new ResendEmailSender({ apiKey: '', from: 'x@y.z', log: capturingLogger() }),
    ).toThrow(/apiKey/);
  });
});
