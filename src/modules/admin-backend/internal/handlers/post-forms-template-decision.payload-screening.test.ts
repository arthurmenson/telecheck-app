/**
 * post-forms-template-decision.payload-screening.test.ts —
 * Sprint 1.1d bypass-regression suite for the `audit_bound` screening
 * of `decision_payload`.
 *
 * Why this file exists: `decision_payload` is echoed verbatim into a
 * Category B audit record. The audit chain is append-only per I-003 and
 * `audit_records` is explicitly PRESERVED by the Pilot 1 env-purge
 * allowlist (it carries the `env.purge.executed` attestation). PII that
 * reaches an audit row therefore survives the environment purge
 * ENTIRELY — the capture-then-purge mitigation Pilot 1 relies on
 * everywhere else does not apply, and redact-inline would itself
 * violate I-003.
 *
 * So the traversal that feeds the screener must be exhaustive. These
 * tests pin the two bypasses Codex R1 found in the first implementation:
 *   1. object KEYS were not screened
 *   2. depth exhaustion returned `[]` — failing OPEN
 *
 * Spec references:
 *   - docs/PII_SCREENING_AND_LOG_REDACTION_SPEC.md §Route class audit_bound
 *   - I-003 (audit append-only), I-027 (audit attribution)
 */

import { describe, expect, it } from 'vitest';

import { screenInput } from '../../../../lib/pii-screener/index.js';

import {
  DECISION_PAYLOAD_MAX_DEPTH,
  DecisionPayloadTooDeepError,
  collectPayloadStrings,
} from './post-forms-template-decision.js';

/** Build an object nested exactly `depth` levels, with `leaf` at the bottom. */
function nest(depth: number, leaf: unknown): unknown {
  let acc: unknown = leaf;
  for (let i = 0; i < depth; i++) {
    acc = { next: acc };
  }
  return acc;
}

describe('collectPayloadStrings — exhaustive traversal (Sprint 1.1d)', () => {
  it('collects a flat review_notes string', () => {
    expect(collectPayloadStrings({ review_notes: 'looks good' })).toContain('looks good');
  });

  it('collects every element of required_revisions[]', () => {
    const strings = collectPayloadStrings({
      required_revisions: ['fix q1', 'fix q2', 'fix q3'],
    });
    expect(strings).toContain('fix q1');
    expect(strings).toContain('fix q2');
    expect(strings).toContain('fix q3');
  });

  it('collects OBJECT KEYS, not just values (Codex R1 bypass #1)', () => {
    // A payload shaped { "john.smith@example.com": "ok" } carries PII in
    // the key. Keys are caller-controlled — they must be screened.
    const strings = collectPayloadStrings({ 'john.smith@example.com': 'ok' });
    expect(strings).toContain('john.smith@example.com');
  });

  it('collects keys nested inside arrays of objects', () => {
    const strings = collectPayloadStrings({
      revisions: [{ 'reviewer.email@example.com': 'note' }],
    });
    expect(strings).toContain('reviewer.email@example.com');
  });

  it('collects strings from deeply nested mixed structures', () => {
    const strings = collectPayloadStrings({
      a: [{ b: { c: ['deep-value'] } }],
    });
    expect(strings).toContain('deep-value');
  });

  it('ignores non-string scalars', () => {
    const strings = collectPayloadStrings({ n: 42, b: true, z: null });
    // Keys are still collected; the scalar values are not.
    expect(strings).toEqual(expect.arrayContaining(['n', 'b', 'z']));
    expect(strings).not.toContain('42');
  });
});

describe('collectPayloadStrings — depth exhaustion FAILS CLOSED (Codex R1 bypass #2)', () => {
  it('accepts a payload at the depth bound', () => {
    const atBound = nest(DECISION_PAYLOAD_MAX_DEPTH - 1, 'reachable');
    expect(collectPayloadStrings(atBound)).toContain('reachable');
  });

  it('THROWS past the depth bound rather than returning [] (fail closed)', () => {
    // The original implementation returned [] here, silently admitting
    // an unscreened payload into append-only, purge-exempt storage.
    const tooDeep = nest(DECISION_PAYLOAD_MAX_DEPTH + 4, 'hidden-pii');
    expect(() => collectPayloadStrings(tooDeep)).toThrow(DecisionPayloadTooDeepError);
  });

  it('a PII value hidden immediately past the bound is NOT silently admitted', () => {
    const justPastBound = nest(DECISION_PAYLOAD_MAX_DEPTH + 1, 'SSN 123-45-6789');
    expect(() => collectPayloadStrings(justPastBound)).toThrow(DecisionPayloadTooDeepError);
  });
});

describe('audit_bound screening over collected payload strings (end-to-end)', () => {
  it('a PII-bearing KEY is caught by the screener once collected', () => {
    const strings = collectPayloadStrings({ 'john.smith@example.com': 'ok' });
    const blocked = strings.some((s) => screenInput(s, 'audit_bound').action === 'block');
    expect(blocked).toBe(true);
  });

  it('a PII-bearing nested VALUE is caught by the screener once collected', () => {
    const strings = collectPayloadStrings({
      revisions: [{ note: 'reviewer SSN is 123-45-6789' }],
    });
    const blocked = strings.some((s) => screenInput(s, 'audit_bound').action === 'block');
    expect(blocked).toBe(true);
  });

  it('clean synthetic reviewer payload produces no block', () => {
    const strings = collectPayloadStrings({
      review_notes: 'Question 4 wording is ambiguous.',
      required_revisions: ['Clarify question 4.'],
    });
    const blocked = strings.some((s) => screenInput(s, 'audit_bound').action === 'block');
    expect(blocked).toBe(false);
  });
});
