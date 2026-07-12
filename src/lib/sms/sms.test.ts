/**
 * sms.test.ts — unit coverage for the transactional-SMS module: template,
 * provider factory, and both senders. Pure (no network): Telnyx's `fetch` is
 * injected. Mirrors email.test.ts.
 */
import { describe, expect, it, vi } from 'vitest';

import { NoopSmsSender } from './noop-sender.js';
import { renderPasscodeSms } from './passcode-template.js';
import { TelnyxSmsSender } from './telnyx-sender.js';
import type { PasscodeSms, SmsLogger } from './types.js';

import { createSmsSender } from './index.js';

const CODE = '481973';
const PHONE = '+15551234567';
const baseMsg = (purpose: PasscodeSms['purpose']): PasscodeSms => ({
  to: PHONE,
  code: CODE,
  purpose,
  consumerDba: 'Heros Health',
  ttlMinutes: 5,
});

type LogEntry = { obj: Record<string, unknown>; msg: string | undefined };
function capturingLogger(): SmsLogger & { entries: LogEntry[] } {
  const entries: LogEntry[] = [];
  return {
    entries,
    warn: (obj, msg) => entries.push({ obj, msg }),
    error: (obj, msg) => entries.push({ obj, msg }),
  };
}

describe('renderPasscodeSms', () => {
  it('includes the code, brand, ttl; no emoji; single-segment-ish length', () => {
    const s = renderPasscodeSms(baseMsg('login'));
    expect(s).toContain(CODE);
    expect(s).toContain('Heros Health');
    expect(s).toContain('5 minutes');
    expect(/\p{Extended_Pictographic}/u.test(s)).toBe(false);
    expect(s.length).toBeLessThanOrEqual(160);
  });
});

describe('createSmsSender', () => {
  it('defaults to NoopSmsSender for provider=noop', () => {
    expect(createSmsSender({ provider: 'noop' }, capturingLogger())).toBeInstanceOf(NoopSmsSender);
  });

  it('builds TelnyxSmsSender for provider=telnyx with a key + from', () => {
    const s = createSmsSender(
      { provider: 'telnyx', telnyxApiKey: 'KEY', from: '+18005550111' },
      capturingLogger(),
    );
    expect(s).toBeInstanceOf(TelnyxSmsSender);
  });

  it('builds TelnyxSmsSender with a messaging profile id instead of from', () => {
    const s = createSmsSender(
      { provider: 'telnyx', telnyxApiKey: 'KEY', messagingProfileId: 'mp_1' },
      capturingLogger(),
    );
    expect(s).toBeInstanceOf(TelnyxSmsSender);
  });

  it('throws for provider=telnyx without a key', () => {
    expect(() => createSmsSender({ provider: 'telnyx', from: '+1800' }, capturingLogger())).toThrow(
      /TELNYX_API_KEY/,
    );
  });

  it('throws for provider=telnyx without a sender', () => {
    expect(() =>
      createSmsSender({ provider: 'telnyx', telnyxApiKey: 'KEY' }, capturingLogger()),
    ).toThrow(/SMS_FROM|TELNYX_MESSAGING_PROFILE_ID/);
  });
});

describe('NoopSmsSender', () => {
  it('resolves, sends nothing, logs last4 only — never the code or full number', async () => {
    const log = capturingLogger();
    await new NoopSmsSender(log).sendPasscode(baseMsg('login'));
    expect(log.entries.length).toBe(1);
    const dump = JSON.stringify(log.entries);
    expect(dump).not.toContain(CODE);
    expect(dump).not.toContain(PHONE);
    expect(dump).toContain('***4567');
  });
});

describe('TelnyxSmsSender', () => {
  it('POSTs to the Telnyx API with bearer auth + from/to/text', async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ data: { id: 'm1' } }), { status: 200 }),
    );
    const sender = new TelnyxSmsSender({
      apiKey: 'KEY',
      from: '+18005550111',
      log: capturingLogger(),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await sender.sendPasscode(baseMsg('login'));

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.telnyx.com/v2/messages');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer KEY');
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.from).toBe('+18005550111');
    expect(body.to).toBe(PHONE);
    expect(String(body.text)).toContain(CODE);
  });

  it('prefers messaging_profile_id over from when both are set', async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ data: { id: 'm1' } }), { status: 200 }),
    );
    const sender = new TelnyxSmsSender({
      apiKey: 'KEY',
      from: '+18005550111',
      messagingProfileId: 'mp_1',
      log: capturingLogger(),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await sender.sendPasscode(baseMsg('registration'));
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.messaging_profile_id).toBe('mp_1');
    expect(body.from).toBeUndefined();
  });

  it('rejects and logs status + error code (never the code) on a non-2xx', async () => {
    const log = capturingLogger();
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ errors: [{ code: '10015' }] }), { status: 422 }),
    );
    const sender = new TelnyxSmsSender({
      apiKey: 'KEY',
      from: '+1800',
      log,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(sender.sendPasscode(baseMsg('login'))).rejects.toThrow(/HTTP 422/);
    const dump = JSON.stringify(log.entries);
    expect(dump).toContain('10015');
    expect(dump).not.toContain(CODE);
  });

  it('rejects and logs a transport error without the code', async () => {
    const log = capturingLogger();
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    const sender = new TelnyxSmsSender({
      apiKey: 'KEY',
      from: '+1800',
      log,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(sender.sendPasscode(baseMsg('login'))).rejects.toThrow();
    expect(JSON.stringify(log.entries)).not.toContain(CODE);
  });

  it('constructor rejects an empty API key and a missing sender', () => {
    expect(
      () => new TelnyxSmsSender({ apiKey: '', from: '+1800', log: capturingLogger() }),
    ).toThrow(/apiKey/);
    expect(() => new TelnyxSmsSender({ apiKey: 'KEY', log: capturingLogger() })).toThrow(
      /from.*messagingProfileId/,
    );
  });
});
