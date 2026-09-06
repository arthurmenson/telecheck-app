import type { Encoding } from 'tokenizers';

import { NerScreeningError } from './ner-capacity.js';

export interface NerHit {
  readonly entityType: string;
  readonly confidence: 'high_confidence' | 'low_confidence';
  readonly match: string;
  readonly start: number;
  readonly end: number;
}
interface SourceEncoding {
  ids: number[];
  spans: Array<[number, number]>;
  words: Array<number | null | undefined>;
  wordSpans: Map<number, [number, number]>;
}
export const NER_MAX_TOKENS = 4096;
export const NER_MAX_WINDOWS = 13;

/** Native overflow handling on the pinned tokenizer loses tail tokens. Encode
 * the full bounded source without truncation and cover every token manually. */
export function makeWindows(tokens: number): Array<{ start: number; end: number }> {
  if (!Number.isSafeInteger(tokens) || tokens < 0 || tokens > NER_MAX_TOKENS)
    throw new NerScreeningError();
  const windows = [];
  for (let start = 0; start < tokens; start += 318) {
    const end = Math.min(start + 382, tokens);
    windows.push({ start, end });
    if (end === tokens) break;
  }
  if (windows.length > NER_MAX_WINDOWS) throw new NerScreeningError();
  return windows;
}

export function sourceEncoding(text: string, encoding: Encoding): SourceEncoding {
  const ids = encoding.getIds(),
    offsets = encoding.getOffsets(),
    words = encoding.getWordIds();
  const attention = encoding.getAttentionMask(),
    special = encoding.getSpecialTokensMask();
  if (
    [offsets, words, attention, special].some((a) => a.length !== ids.length) ||
    encoding.getOverflowing().length
  )
    throw new NerScreeningError();
  makeWindows(ids.length);
  const boundaries = [0];
  for (const char of text) boundaries.push(boundaries[boundaries.length - 1]! + char.length);
  const spans: Array<[number, number]> = [];
  const wordSpans = new Map<number, [number, number]>();
  let previous = 0;
  for (let i = 0; i < ids.length; i++) {
    const [from, to] = offsets[i]!;
    const start = boundaries[from!],
      end = boundaries[to!];
    if (
      !Number.isSafeInteger(from) ||
      !Number.isSafeInteger(to) ||
      start === undefined ||
      end === undefined ||
      start >= end ||
      start < previous ||
      attention[i] !== 1 ||
      special[i] !== 0 ||
      !Number.isSafeInteger(ids[i]) ||
      ids[i]! < 0 ||
      ids[i]! >= 30522
    )
      throw new NerScreeningError();
    spans.push([start, end]);
    previous = start;
    const word = words[i];
    if (word !== null && word !== undefined) {
      const prior = wordSpans.get(word);
      wordSpans.set(word, [
        prior ? Math.min(prior[0], start) : start,
        prior ? Math.max(prior[1], end) : end,
      ]);
    }
  }
  // Normalization may omit whitespace, controls and combining marks, but may
  // not silently omit substantive source characters.
  let covered = 0;
  for (const [start, end] of spans) {
    if (start > covered && /[^\s\p{M}\p{Cf}\p{Cc}]/u.test(text.slice(covered, start)))
      throw new NerScreeningError();
    covered = Math.max(covered, end);
  }
  if (/[^\s\p{M}\p{Cf}\p{Cc}]/u.test(text.slice(covered))) throw new NerScreeningError();
  return { ids, spans, words, wordSpans };
}

export function aggregateHits(
  text: string,
  source: SourceEncoding,
  detected: readonly { token: number; entityType: string }[],
): readonly NerHit[] {
  const hits = detected
    .map(({ token, entityType }) => {
      const piece = source.spans[token];
      if (!piece) throw new NerScreeningError();
      const word = source.words[token];
      let [start, end] =
        word === null || word === undefined ? piece : (source.wordSpans.get(word) ?? piece);
      // Include a bounded attached surname cluster such as O’Dwyer-Smith. This
      // expands only an actual model prediction; no allowlists or name regex NER.
      if (entityType === 'PERSON') {
        const clusters =
          /[\p{L}\p{M}][\p{L}\p{M}\p{Cf}]*(?:['’\-‐‑][\p{L}\p{M}][\p{L}\p{M}\p{Cf}]*)*/gu;
        for (const match of text.matchAll(clusters)) {
          if (match.index < end && match.index + match[0].length > start) {
            if (match[0].length > 256) throw new NerScreeningError();
            start = Math.min(start, match.index);
            end = Math.max(end, match.index + match[0].length);
          }
        }
      }
      while (
        end < text.length &&
        /[\p{M}\p{Cf}]/u.test(String.fromCodePoint(text.codePointAt(end)!))
      )
        end += String.fromCodePoint(text.codePointAt(end)!).length;
      return { start, end, entityType };
    })
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: Array<{ start: number; end: number; entityType: string }> = [];
  for (const hit of hits) {
    const previous = merged[merged.length - 1];
    if (
      previous &&
      previous.entityType === hit.entityType &&
      (hit.start <= previous.end || /^\s+$/u.test(text.slice(previous.end, hit.start)))
    )
      previous.end = Math.max(previous.end, hit.end);
    else merged.push({ ...hit });
  }
  return merged.map((hit) => ({
    ...hit,
    match: text.slice(hit.start, hit.end),
    confidence:
      hit.entityType === 'PERSON' || hit.entityType === 'DOB'
        ? 'high_confidence'
        : 'low_confidence',
  }));
}
