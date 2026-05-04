/**
 * ulid.ts — direct unit-coverage on the inline ULID generator.
 *
 * Until this commit `src/lib/ulid.ts` had ZERO direct test coverage.
 * Every exercise was indirect — used by every test that calls `ulid()`
 * for fixture IDs (~hundreds of call sites) — but no test pinned the
 * spec contract: 26-char Crockford base32, timestamp prefix lex-orderable,
 * randomness collision-free, alphabet excludes I/L/O/U.
 *
 * Why this matters:
 *   ULID is the universal PK format across the schema (template_id,
 *   deployment_id, submission_id, audit_id, etc.). A regression that
 *   produces 25-char outputs (off-by-one in encodeTime), or that uses
 *   the RFC 4648 base32 alphabet by accident (which has I/L/O/U), would
 *   silently break VARCHAR(26) ULID columns AND any column that relies
 *   on Crockford's human-readability discipline. The test suite would
 *   eventually catch it via collision/format failures, but only after
 *   N tests that happen to use the regressed ULID path. Direct unit
 *   coverage catches the regression at unit-test speed.
 *
 * Spec reference:
 *   - https://github.com/ulid/spec
 *
 * Coverage in this file (8 sections):
 *
 *   §1 Length contract — every ulid() returns exactly 26 chars
 *   §2 Alphabet — Crockford base32 (no I/L/O/U); every char in
 *      0123456789ABCDEFGHJKMNPQRSTVWXYZ
 *   §3 Timestamp prefix is lexicographically orderable (newer >= older)
 *   §4 Randomness — N=1000 calls in tight loop produce N distinct ULIDs
 *      (no within-batch collisions in 80 bits of randomness; this is
 *      the practical floor that proves randomBytes wired correctly)
 *   §5 Timestamp prefix decodes to "now" within tolerance
 *   §6 Two ULIDs in the same millisecond share the 10-char timestamp
 *      prefix but differ in the 16-char random suffix (the property
 *      that test-fixture helpers like `.slice(-8)` rely on)
 *   §7 Timestamp prefix is the FIRST 10 chars (verified against fresh
 *      ULIDs taken at different points in time)
 *   §8 Random suffix is the LAST 16 chars and uses the full alphabet
 *      across many calls (statistical sanity — empty diversity check)
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { ulid } from './ulid.ts';

const CROCKFORD_BASE32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const CROCKFORD_REGEX = /^[0-9A-HJKMNP-TV-Z]{26}$/;

// ---------------------------------------------------------------------------
// §1 — Length contract
// ---------------------------------------------------------------------------

describe('ulid() — length contract', () => {
  it('§1a returns exactly 26 chars on a single call', () => {
    expect(ulid()).toHaveLength(26);
  });

  it('§1b returns 26 chars on every call across a batch', () => {
    for (let i = 0; i < 100; i++) {
      expect(ulid()).toHaveLength(26);
    }
  });
});

// ---------------------------------------------------------------------------
// §2 — Crockford base32 alphabet
// ---------------------------------------------------------------------------

describe('ulid() — Crockford base32 alphabet (no I/L/O/U)', () => {
  it('§2a every char in a fresh ULID is in the Crockford alphabet', () => {
    const id = ulid();
    for (const ch of id) {
      expect(CROCKFORD_BASE32).toContain(ch);
    }
  });

  it('§2b regex match — full ULID conforms to /^[0-9A-HJKMNP-TV-Z]{26}$/', () => {
    const id = ulid();
    expect(id).toMatch(CROCKFORD_REGEX);
  });

  it('§2c regex holds across a batch (100 IDs)', () => {
    for (let i = 0; i < 100; i++) {
      expect(ulid()).toMatch(CROCKFORD_REGEX);
    }
  });

  it('§2d alphabet excludes I, L, O, U (Crockford-specific)', () => {
    // Sanity pin on the alphabet constant itself — pins the contract
    // against a copy-paste regression to RFC 4648 base32 (which has
    // ABCDEFGHIJKLMNOPQRSTUVWXYZ234567 — INCLUDES I, L, O, U).
    expect(CROCKFORD_BASE32).not.toMatch(/[ILOU]/);
    expect(CROCKFORD_BASE32).toHaveLength(32);
  });
});

// ---------------------------------------------------------------------------
// §3 — Timestamp prefix is lexicographically orderable
// ---------------------------------------------------------------------------

describe('ulid() — timestamp prefix lex-orderable', () => {
  it('§3a a ULID generated later in time sorts >= a ULID generated earlier (single-ms granularity)', async () => {
    const earlier = ulid();
    // Wait at least 2ms so the timestamp prefix is guaranteed to advance
    await new Promise((resolve) => setTimeout(resolve, 2));
    const later = ulid();
    expect(later >= earlier).toBe(true);
  });

  it('§3b 10ms apart — later ULID strictly greater than earlier in lex order', async () => {
    const earlier = ulid();
    await new Promise((resolve) => setTimeout(resolve, 10));
    const later = ulid();
    expect(later > earlier).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// §4 — Randomness — collision-free in batch
// ---------------------------------------------------------------------------

describe('ulid() — randomness (collision-free per millisecond)', () => {
  it('§4a 1000 IDs in a tight loop produce 1000 distinct values', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 1000; i++) {
      ids.add(ulid());
    }
    expect(ids.size).toBe(1000);
  });

  it('§4b within-millisecond uniqueness — generate 100 IDs in <1ms, all distinct', () => {
    const ids = new Set<string>();
    const start = Date.now();
    for (let i = 0; i < 100; i++) {
      ids.add(ulid());
    }
    const elapsed = Date.now() - start;
    // Sanity — these 100 calls really did happen within a tight window
    // (typically 1-3ms on modern hardware). The point is to force the
    // randomness suffix to do all the disambiguation work.
    expect(elapsed).toBeLessThan(50);
    expect(ids.size).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// §5 — Timestamp prefix decodes to "now"
// ---------------------------------------------------------------------------

describe('ulid() — timestamp prefix decodes to current time (Date.now())', () => {
  /**
   * Decode a 10-char Crockford-base32 timestamp prefix back to ms since
   * epoch. Mirrors the inverse of encodeTime() in ulid.ts.
   */
  function decodeTimestamp(prefix: string): number {
    let ms = 0;
    for (const ch of prefix) {
      const idx = CROCKFORD_BASE32.indexOf(ch);
      if (idx < 0) throw new Error(`invalid char '${ch}' in ULID prefix`);
      ms = ms * 32 + idx;
    }
    return ms;
  }

  it('§5a decoded prefix is within ±100ms of Date.now() at generation time', () => {
    const beforeMs = Date.now();
    const id = ulid();
    const afterMs = Date.now();
    const decoded = decodeTimestamp(id.slice(0, 10));
    // Must be in [beforeMs, afterMs] — the function captured Date.now()
    // at some point inside that window.
    expect(decoded).toBeGreaterThanOrEqual(beforeMs);
    expect(decoded).toBeLessThanOrEqual(afterMs);
  });
});

// ---------------------------------------------------------------------------
// §6 — Same-millisecond pair shares prefix, differs on suffix
// ---------------------------------------------------------------------------

describe('ulid() — same-millisecond pair: prefix shared, suffix differs', () => {
  // Restore the real Date.now() after each test in this section so the
  // mock doesn't leak into subsequent timestamp-dependent tests.
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('§6a two ULIDs generated at the SAME ms (mocked Date.now) share the 10-char prefix and differ on suffix', () => {
    // Codex ulid-test-r1 MED closure 2026-05-04: the prior version
    // relied on real-clock cooperation across two back-to-back ulid()
    // calls — a 10-iteration retry loop, but on slow / instrumented /
    // heavily-loaded CI the retries could still all straddle a ms
    // boundary, leading to a flaky failure even when the generator is
    // correct. Mocking Date.now to a fixed value makes the test
    // deterministic: both calls see the SAME ms by construction, so
    // any failure points unambiguously at the random-suffix
    // disambiguation property.
    const FIXED_MS = 1_780_000_000_000; // arbitrary fixed timestamp
    vi.spyOn(Date, 'now').mockReturnValue(FIXED_MS);

    const a = ulid();
    const b = ulid();

    expect(a.slice(0, 10)).toBe(b.slice(0, 10));
    // Suffix must differ — the property test-helpers like
    // `prog_${ulid().slice(-8)}` rely on (CI surfaced two
    // uq_template_version dup-keys before this property was relied on
    // explicitly).
    expect(a.slice(10)).not.toBe(b.slice(10));
  });

  it('§6b 100 ULIDs generated at the SAME ms (mocked Date.now) all share the prefix; all 100 suffixes are distinct', () => {
    const FIXED_MS = 1_780_000_000_000;
    vi.spyOn(Date, 'now').mockReturnValue(FIXED_MS);

    const ids = Array.from({ length: 100 }, () => ulid());
    const prefixes = new Set(ids.map((id) => id.slice(0, 10)));
    const suffixes = new Set(ids.map((id) => id.slice(10)));

    // All 100 IDs share the SAME timestamp prefix.
    expect(prefixes.size).toBe(1);
    // All 100 random suffixes are distinct (collision-resistance under
    // forced same-ms — the entire collision-prevention burden falls on
    // randomBytes here).
    expect(suffixes.size).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// §7 — Timestamp prefix is the FIRST 10 chars
// ---------------------------------------------------------------------------

describe('ulid() — structural layout pin (timestamp prefix at offset 0..10)', () => {
  it('§7a a ULID generated 200ms later has a different first 10 chars (timestamp portion changed)', async () => {
    const earlier = ulid();
    await new Promise((resolve) => setTimeout(resolve, 200));
    const later = ulid();
    expect(earlier.slice(0, 10)).not.toBe(later.slice(0, 10));
    // And the later prefix is lex-greater (sanity counterpart).
    expect(later.slice(0, 10) > earlier.slice(0, 10)).toBe(true);
  });

  it('§7b ULIDs generated 200ms apart share NOTHING in the first 10 chars at minimum (the timestamp slot)', async () => {
    // The point is that .slice(0, 10) IS the timestamp slot — any change
    // there reflects the clock advancing. The random suffix differs
    // independently every call.
    const earlier = ulid();
    await new Promise((resolve) => setTimeout(resolve, 200));
    const later = ulid();
    // Random suffixes will differ regardless. The timestamp prefix
    // should also differ given 200ms gap.
    expect(later.slice(0, 10)).not.toBe(earlier.slice(0, 10));
  });
});

// ---------------------------------------------------------------------------
// §8 — Random suffix uses alphabet diversity (sanity, not exhaustive)
// ---------------------------------------------------------------------------

describe('ulid() — random-suffix alphabet diversity', () => {
  it('§8a across 200 ULIDs, the random suffix uses MORE THAN 8 distinct chars', () => {
    // 200 ULIDs × 16-char suffix = 3200 chars total. Alphabet size is
    // 32. Coupon-collector says we'll see ~all 32 chars after ~125
    // chars of randomness. Conservative floor: at least 8 distinct
    // chars. (Sanity check: a regression that always emits '0' on
    // randomness would fail; passing means randomBytes is wired.)
    const suffixChars = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const id = ulid();
      for (const ch of id.slice(10)) {
        suffixChars.add(ch);
      }
    }
    expect(suffixChars.size).toBeGreaterThan(8);
  });

  it('§8b every char in a 50-ULID suffix sample is in the Crockford alphabet', () => {
    for (let i = 0; i < 50; i++) {
      const suffix = ulid().slice(10);
      for (const ch of suffix) {
        expect(CROCKFORD_BASE32).toContain(ch);
      }
    }
  });
});
