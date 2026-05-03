/**
 * ulid.ts — minimal inline ULID generator (Crockford base32, 26 chars).
 *
 * Purpose:
 *   Provides time-ordered, unique 26-character identifiers per the ULID
 *   spec (https://github.com/ulid/spec) without taking a runtime dependency
 *   on the `ulid` npm package. The package.json carries `ulid` as a
 *   dependency for the eventual migration to the upstream library — this
 *   inline implementation lives here so foundation + slice scaffold work
 *   can proceed before `npm install` runs in the deployment pipeline.
 *
 * ULID structure (26 Crockford base32 chars; 128 bits total):
 *   - 10 chars / 48 bits  — Unix milliseconds timestamp (big-endian)
 *   - 16 chars / 80 bits  — randomness (cryptographically secure)
 *
 * Crockford base32 alphabet (excludes I, L, O, U for human-readability;
 * not lexicographically equal to RFC 4648 base32):
 *   0123456789ABCDEFGHJKMNPQRSTVWXYZ
 *
 * Properties:
 *   - 26 chars exactly — fits VARCHAR(26) PRIMARY KEY columns in the
 *     migration set without an extension or non-standard column type.
 *   - Lexicographically sortable by timestamp (newer ULIDs sort after
 *     older ones) — useful for index range scans.
 *   - Cryptographically random suffix — collision probability is
 *     negligible for any realistic application throughput.
 *   - Url-safe — no characters require escaping in path segments.
 *
 * When to swap to the upstream `ulid` package:
 *   - When `npm install` reliably resolves the dependency in deployment.
 *   - The function signature `ulid(): string` is upstream-compatible, so
 *     callers do not need to change. Just swap the import.
 */

import { randomBytes } from 'crypto';

const CROCKFORD_BASE32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const TIME_LEN = 10;
const RANDOM_LEN = 16;

/**
 * Generate a new ULID. Returns a 26-character Crockford-base32 string.
 *
 * The timestamp portion uses Date.now() (millisecond precision). The
 * randomness portion uses Node's `crypto.randomBytes(10)` — 80 bits of
 * cryptographically-secure randomness, which gives a per-millisecond
 * collision probability of ~1 in 2^40 even at extreme throughput.
 */
export function ulid(): string {
  return encodeTime(Date.now()) + encodeRandom();
}

function encodeTime(ms: number): string {
  // ULID time encoding: 48 bits → 10 base32 chars, big-endian.
  // Walk down from the MSB to the LSB, peeling off 5-bit chunks.
  let remaining = ms;
  const out = new Array<string>(TIME_LEN);
  for (let i = TIME_LEN - 1; i >= 0; i--) {
    // eslint-disable-next-line no-bitwise
    const idx = remaining % 32;
    out[i] = CROCKFORD_BASE32[idx]!;
    remaining = Math.floor(remaining / 32);
  }
  return out.join('');
}

function encodeRandom(): string {
  // 80 bits of randomness → 16 base32 chars. randomBytes returns a Buffer;
  // we walk it as a stream of 5-bit groups (10 bytes = 80 bits = 16 groups).
  const bytes = randomBytes(10);
  let bitBuffer = 0;
  let bitCount = 0;
  const out = new Array<string>(RANDOM_LEN);
  let outIdx = 0;
  for (let i = 0; i < bytes.length; i++) {
    // eslint-disable-next-line no-bitwise
    bitBuffer = (bitBuffer << 8) | bytes[i]!;
    bitCount += 8;
    while (bitCount >= 5 && outIdx < RANDOM_LEN) {
      bitCount -= 5;
      // eslint-disable-next-line no-bitwise
      const idx = (bitBuffer >> bitCount) & 0b11111;
      out[outIdx++] = CROCKFORD_BASE32[idx]!;
    }
  }
  return out.join('');
}
