import { fileURLToPath } from 'node:url';

import { Tokenizer } from 'tokenizers';
import { describe, expect, it, vi } from 'vitest';

import { createBoundedClassifier, NER_MAX_CHARACTERS } from './ner-capacity.js';
import { aggregateHits, makeWindows, sourceEncoding } from './ner-spans.js';
import { classifyEntities, getNerReadiness, initializeNer } from './ner.js';

import { applyRedactions, screenInput, screenOutput, type PiiHit } from './index.js';

const cases = [
  ['US name', 'Please contact Emily Carter about the appointment.', ['Emily Carter']],
  ['Ghana name', 'My name is Akosua Adjei and I have a headache.', ['Akosua Adjei']],
  ['lowercase Ghana', 'my name is kwame mensah and i live in kumasi.', ['kwame mensah', 'kumasi']],
  [
    'US street',
    'My address is 742 Evergreen Terrace, Springfield.',
    ['742 Evergreen Terrace', 'Springfield'],
  ],
  [
    'Ghana street',
    'Ama Serwaa lives at 14 Oxford Street, Accra.',
    ['Ama Serwaa', '14 Oxford Street', 'Accra'],
  ],
  ['decomposed surname', '😀 My name is A\u0301ma O’Dwyer-Smith.', ['A\u0301ma', 'O’Dwyer-Smith']],
  ['repeated', 'John Smith met John Smith at the clinic.', ['John Smith']],
] as const;

describe('pinned real English ONNX inference and sensitive-character coverage', () => {
  it.each(cases)('%s', async (_id, text, sensitive) => {
    const hits = await classifyEntities(text);
    expect(hits.length).toBeGreaterThan(0);
    for (const hit of hits) expect(text.slice(hit.start, hit.end)).toBe(hit.match);
    for (const expected of sensitive) {
      for (const occurrence of text.matchAll(
        new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'),
      )) {
        for (
          let position = occurrence.index;
          position < occurrence.index + expected.length;
          position++
        ) {
          expect(
            hits.some((hit) => position >= hit.start && position < hit.end),
            `${_id}: sensitive character not covered`,
          ).toBe(true);
        }
      }
    }
    const egress = await screenOutput(text);
    for (const expected of sensitive) expect(egress.output).not.toContain(expected);
  });

  it.each([
    'What time should I take my medication today?',
    'Take medication tonight with water.',
    'The patient reports a mild headache and fatigue for three days.',
    'I am pilot1-participant-01 and I feel great.',
    'Template rejected: question 4 wording is ambiguous.',
  ])('negative control: %s', async (text) => {
    expect(await classifyEntities(text)).toEqual([]);
  });

  it('screens tail beyond the failing native overflow path and deduplicates window overlaps', async () => {
    const text =
      'I have a mild headache today. '.repeat(65) +
      ' My name is Akosua Adjei and I live at 55 Liberty Road, Accra.';
    const hits = await classifyEntities(text);
    expect(hits.some((h) => h.match === 'Akosua Adjei')).toBe(true);
    expect(hits.some((h) => h.match.includes('55 Liberty Road'))).toBe(true);
    expect(new Set(hits.map((h) => `${h.start}:${h.end}:${h.entityType}`)).size).toBe(hits.length);
  });

  it('a regex low-confidence hit cannot bypass an accompanying PERSON block', async () => {
    const result = await screenInput('My name is John Smith. Server address 10.0.0.1.', 'internal');
    expect(result.action).toBe('block');
    expect(result.hits.some((h) => h.patternId === 'ner_person')).toBe(true);
  });

  it('literal special tokens are source input rather than dropped positions', async () => {
    const hits = await classifyEntities('My name is [CLS] John [SEP] Smith [UNK].');
    expect(hits.some((h) => h.match.includes('John'))).toBe(true);
    expect(hits.some((h) => h.match.includes('Smith'))).toBe(true);
  });

  it('reports verified safe readiness metadata', async () => {
    await initializeNer();
    expect(getNerReadiness()).toMatchObject({
      ready: true,
      assetsVerified: true,
      warmedUp: true,
      capacity: 2,
    });
    expect(JSON.stringify(getNerReadiness())).not.toMatch(/John|Smith|candidate|stack/);
  });
});

describe('complete source coverage and interval union', () => {
  const tokenizer = Tokenizer.fromFile(
    fileURLToPath(new URL('../../../assets/pii-ner/tokenizer.json', import.meta.url)),
  );
  tokenizer.disablePadding();
  tokenizer.disableTruncation();

  it('manual windows cover every token at all boundary lengths through the budget', () => {
    for (const length of [0, 1, 381, 382, 383, 700, 701, 4096]) {
      const windows = makeWindows(length);
      const coverage = new Set(
        windows.flatMap((w) => Array.from({ length: w.end - w.start }, (_v, i) => w.start + i)),
      );
      expect(coverage.size).toBe(length);
      expect(windows.every((w) => w.end - w.start <= 382)).toBe(true);
    }
    expect(() => makeWindows(4097)).toThrow('pii_screening_unavailable');
  });

  it('retains literal special/unknown tokens with source offsets and combines attached marks', async () => {
    const text = '😀 A\u0301ma O’Dwyer-Smith [CLS] ' + 'x'.repeat(150);
    const source = sourceEncoding(
      text,
      await tokenizer.encode(text, null, { addSpecialTokens: false }),
    );
    expect(source.ids).toContain(101);
    expect(source.spans.at(-1)?.[1]).toBe(text.length);
    const token = source.spans.findIndex(([start, end]) => text.slice(start, end) === 'O');
    const hit = aggregateHits(text, source, [{ token, entityType: 'PERSON' }])[0];
    expect(hit?.match).toBe('O’Dwyer-Smith');
  });

  it('rejects a native offset result that leaves a substantive source tail uncovered', async () => {
    const encoding = await tokenizer.encode('John Smith', null, { addSpecialTokens: false });
    vi.spyOn(encoding, 'getOffsets').mockReturnValue([
      [0, 4],
      [5, 8],
    ]);
    expect(() => sourceEncoding('John Smith', encoding)).toThrow('pii_screening_unavailable');
  });

  it('unions extending overlaps rather than leaving the final suffix', () => {
    const hit = (start: number, end: number): PiiHit => ({
      start,
      end,
      confidence: 'low_confidence',
      patternId: 'fixture',
      label: 'PII',
      match: '',
    });
    expect(applyRedactions('abcdefghij', [hit(1, 5), hit(3, 8), hit(7, 9)])).toBe(
      'a[REDACTED:PII]j',
    );
  });
});

describe('safe failure and bounded native work', () => {
  it('rejects malformed Unicode and oversized strings before invoking inference', async () => {
    const infer = vi.fn(async () => []);
    const bounded = createBoundedClassifier(infer);
    await expect(bounded.classify('\ud800John')).rejects.toThrow('pii_screening_unavailable');
    await expect(bounded.classify('x'.repeat(NER_MAX_CHARACTERS + 1))).rejects.toThrow(
      'pii_screening_unavailable',
    );
    expect(infer).not.toHaveBeenCalled();
  });

  it('deadline does not release a native permit or queue later requests', async () => {
    let finish!: (hits: readonly []) => void;
    const infer = vi.fn(
      () =>
        new Promise<readonly []>((resolve) => {
          finish = resolve;
        }),
    );
    const bounded = createBoundedClassifier(infer, { capacity: 1, deadlineMs: 10 });
    await expect(bounded.classify('synthetic input')).rejects.toThrow('pii_screening_unavailable');
    expect(bounded.status()).toEqual({ capacity: 1, inFlight: 1, degraded: true });
    await expect(bounded.classify('next')).rejects.toThrow('pii_screening_unavailable');
    expect(infer).toHaveBeenCalledTimes(1);
    finish([]);
    await new Promise((resolve) => setImmediate(resolve));
    expect(bounded.status()).toEqual({ capacity: 1, inFlight: 0, degraded: false });
  });

  it('erases native error details and returns no candidate in error metadata', async () => {
    const bounded = createBoundedClassifier(async () => {
      throw new Error('SECRET CANDIDATE native error');
    });
    let error: unknown;
    try {
      await bounded.classify('PRIVATE INPUT');
    } catch (caught) {
      error = caught;
    }
    expect(String(error)).toBe('NerScreeningError: pii_screening_unavailable');
    expect(JSON.stringify(error)).not.toMatch(/PRIVATE|SECRET|cause/);
  });

  it('unverified egress is suppressed completely and oversized ingress blocks', async () => {
    const oversized = 'private '.repeat(3000);
    expect((await screenInput(oversized, 'ai_bound')).blockReason).toBe('screening_unavailable');
    const output = await screenOutput(oversized);
    expect(output.output).toBe('[REDACTED:Unverified output]');
    expect(output.hits[0]?.match).toBe('');
  });
});
