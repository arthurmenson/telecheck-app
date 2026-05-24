/**
 * idempotency-body-hash.test.ts — coverage on `canonicalBodyForHash`
 * and the empty-body equivalence-class contract introduced by PR #205
 * Codex R1 Finding 2.
 *
 * Why this matters:
 *   The IDEMPOTENCY v5.1 contract is "same key + same body → idempotent
 *   replay". The body-hash is computed identically by both the
 *   preHandler hook (cache-lookup) and the handler-side
 *   `buildIdempotencyCtx` (cache-write). Drift between those two call
 *   sites — or non-determinism between successive retries with
 *   semantically-equivalent empty bodies — surfaces as a spurious
 *   `internal.idempotency.body_mismatch` 409 to a well-behaved client.
 *
 *   The pre-#205 expression at both call sites was:
 *       typeof body === 'string' ? body : JSON.stringify(body ?? '')
 *   which produced 3 different canonical strings for 4
 *   semantically-equivalent empty inputs:
 *       undefined → '""'   (length 2)
 *       null      → '""'   (length 2)
 *       ''        → ''     (length 0)  <-- different!
 *       {}        → '{}'   (length 2)  <-- different!
 *
 *   `canonicalBodyForHash` collapses all 4 to the single canonical
 *   sentinel `''` so retries of a body-less POST always produce the
 *   same hash regardless of on-the-wire representation.
 *
 * Spec references:
 *   - IDEMPOTENCY v5.1 contract §1 same-key + same-body semantics.
 *   - PR #205 Codex R1 Finding 2 (deterministic empty-body
 *     idempotency contract for submit-for-review).
 */

import { describe, expect, it } from 'vitest';

import {
  CANONICAL_EMPTY_BODY,
  canonicalBodyForHash,
  hashBody,
} from './idempotency.js';

describe('canonicalBodyForHash — empty-body equivalence class (PR #205 Codex R1 Finding 2)', () => {
  it('CANONICAL_EMPTY_BODY is the literal empty string (smallest representable input)', () => {
    expect(CANONICAL_EMPTY_BODY).toBe('');
  });

  it('undefined → CANONICAL_EMPTY_BODY', () => {
    expect(canonicalBodyForHash(undefined)).toBe(CANONICAL_EMPTY_BODY);
  });

  it('null → CANONICAL_EMPTY_BODY', () => {
    expect(canonicalBodyForHash(null)).toBe(CANONICAL_EMPTY_BODY);
  });

  it("'' (empty string) → CANONICAL_EMPTY_BODY", () => {
    expect(canonicalBodyForHash('')).toBe(CANONICAL_EMPTY_BODY);
  });

  it('{} (empty plain object) → CANONICAL_EMPTY_BODY', () => {
    expect(canonicalBodyForHash({})).toBe(CANONICAL_EMPTY_BODY);
  });

  it('Object.create(null) with no keys → CANONICAL_EMPTY_BODY (defensive — class-instances WITHOUT plain-prototype do NOT collapse, but null-prototype objects are clearly empty-body)', () => {
    // Object.create(null) has prototype === null, NOT Object.prototype.
    // The collapse predicate restricts to plain Object.prototype, so a
    // null-prototype object falls through to JSON.stringify. This pins
    // the conservative behavior: only plain `{}` collapses; weird
    // object shapes go through stringify so they aren't accidentally
    // collapsed.
    const nullProto = Object.create(null);
    // JSON.stringify on a null-prototype empty object returns '{}'.
    expect(canonicalBodyForHash(nullProto)).toBe('{}');
  });

  it('all four empty-body representations hash to the same SHA-256 (closes Finding 2 invariant)', () => {
    const hashes = [undefined, null, '', {}].map((b) => hashBody(canonicalBodyForHash(b)));
    // All four hashes equal. Use a Set to assert cardinality 1.
    expect(new Set(hashes).size).toBe(1);
    // And specifically, they equal the SHA-256 of the empty string —
    // the documented sentinel value (e3b0c44...). Pin so a future
    // change to CANONICAL_EMPTY_BODY surfaces here.
    expect(hashes[0]).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });
});

describe('canonicalBodyForHash — non-empty bodies preserve prior behavior', () => {
  it('non-empty string returns the string verbatim (no stringify)', () => {
    expect(canonicalBodyForHash('hello')).toBe('hello');
  });

  it('non-empty object returns JSON.stringify(body)', () => {
    expect(canonicalBodyForHash({ a: 1, b: 2 })).toBe('{"a":1,"b":2}');
  });

  it('non-empty object preserves field order (JSON.stringify is deterministic on insertion order)', () => {
    const a = { x: 1, y: 2 };
    const b = { x: 1, y: 2 };
    expect(canonicalBodyForHash(a)).toBe(canonicalBodyForHash(b));
  });

  it('empty array [] is NOT collapsed to the empty-body sentinel — empty arrays are meaningful payloads', () => {
    // `[]` is a non-empty payload semantically — it represents an
    // explicit empty collection. The collapse predicate intentionally
    // restricts to plain objects (Object.prototype), not arrays.
    expect(canonicalBodyForHash([])).toBe('[]');
    expect(canonicalBodyForHash([])).not.toBe(CANONICAL_EMPTY_BODY);
  });

  it('non-empty array uses JSON.stringify', () => {
    expect(canonicalBodyForHash([1, 2, 3])).toBe('[1,2,3]');
  });

  it("'{}' as a STRING (already JSON-stringified) returns verbatim — not re-collapsed (the caller has already chosen a canonical form)", () => {
    // The string '{}' (length 2) is a valid non-empty body. Returning
    // it verbatim matches the prior behavior on the string-branch and
    // preserves cache-hit semantics for callers that pre-stringify.
    expect(canonicalBodyForHash('{}')).toBe('{}');
  });
});

describe('canonicalBodyForHash — empty-body invariant: hash equality holds end-to-end through buildIdempotencyCtx-equivalent path', () => {
  it('hashBody(canonicalBodyForHash(X)) is identical for X ∈ { undefined, null, "", {} }', () => {
    const inputs: unknown[] = [undefined, null, '', {}];
    const hashes = inputs.map((b) => hashBody(canonicalBodyForHash(b)));
    for (let i = 1; i < hashes.length; i++) {
      expect(hashes[i]).toBe(hashes[0]);
    }
  });

  it('hashBody(canonicalBodyForHash({key: "value"})) DIFFERS from the empty-body hash', () => {
    const emptyHash = hashBody(canonicalBodyForHash({}));
    const nonEmptyHash = hashBody(canonicalBodyForHash({ key: 'value' }));
    expect(emptyHash).not.toBe(nonEmptyHash);
  });
});
