/**
 * Collision-proof unique-phone helper for integration tests.
 *
 * Why this exists (CI fix 2026-05-05):
 *   The original ad-hoc helper used by ~10 test files derived a 9-digit
 *   phone suffix from `ulid().slice(-9).replace(/[^0-9]/g, '0').padEnd(9, '0')`.
 *   When the ULID slice happened to contain many non-digit base32 chars
 *   (a common case — Crockford base32 has 22 letter chars vs 10 digit chars),
 *   they all collapsed to '0' and entropy plummeted. Two seedAccount() calls
 *   in the same test body could legitimately produce the same `+10000000000`
 *   phone, tripping the `uq_account_tenant_phone` UNIQUE constraint on the
 *   second INSERT.
 *
 *   This was masked for months — the suite was getting lucky. CI run
 *   25362764302 (head 723a611) finally surfaced it as a hard failure on
 *   delegations-migration.test.ts §1a.
 *
 * Why Date.now() + counter:
 *   Date.now() at millisecond precision gives ~13 digits in 2026; multiplying
 *   by 1000 and adding a per-process counter (mod 1000) gives a unique 16-
 *   digit value within a test process for up to 1000 calls per millisecond.
 *   Slicing the last 9 digits gives a phone-suffix-shaped value that is
 *   monotonically unique within the process.
 *
 * Spec references:
 *   - I-009 (no hardcoded country / tenant assumptions in tests; helpers
 *     accept any E.164 prefix)
 *   - I-023 (tenant isolation — phones are scoped per tenant by the
 *     uq_account_tenant_phone UNIQUE constraint, so cross-tenant collisions
 *     are not a concern; only same-tenant in-test collisions are)
 *   - migrations/012_accounts.sql (the table this helper feeds)
 */

let _counter = 0;

/**
 * Generate a collision-free E.164 phone number for test fixtures.
 *
 * Default prefix is `+1` (US). Pass `+233` for Ghana or any other E.164
 * country code as a string; the helper just concatenates `${prefix}${digits}`
 * where `digits` is exactly 9 digits.
 *
 * @param prefix - E.164 country-code prefix (e.g., '+1', '+233'). Default '+1'.
 * @returns Phone string in E.164 format, e.g. '+15551234567'.
 */
export function uniquePhone(prefix: string = '+1'): string {
  _counter += 1;
  const digits = String(Date.now() * 1000 + (_counter % 1000)).slice(-9);
  return `${prefix}${digits}`;
}
