/**
 * tests/contracts/canonicalize-db-url.test.ts — Regression coverage
 * for `canonicalizeDbUrl` (the bench-mode collision guard's URL
 * canonicalization function).
 *
 * Sprint 17 r13 fix-forward (Codex perf-bench-r13 HIGH closure
 * 2026-05-06). Codex r13 explicitly recommended "add focused
 * regression coverage for omitted port, explicit default port,
 * omitted host, query ?port=, and duplicate query params against
 * canonicalizeDbUrl". This test file delivers that coverage as a
 * lockdown contract.
 *
 * Why a contracts test (not perf bench):
 *   - canonicalizeDbUrl is a pure function; no DB needed
 *   - Lives under `tests/contracts/` per existing convention for
 *     lockdown tests that pin invariants of helper functions
 *   - Runs in `vitest run` (the integration-test runner), not
 *     `vitest bench`
 *   - Fast (<10ms total); always-on, never gated on env
 *
 * Trajectory of the URL-canonicalization finding-class (closed at
 * each round; this test pins each round's invariant):
 *
 *   r10-C (Sprint 14): string-equality bypassed by URL-form difference
 *   r11-2 (Sprint 17 r1): ignored ?host= query-host
 *   r12 (Sprint 17 r2): URLSearchParams first-wins ≠ pg's last-wins;
 *     ?port= ignored
 *   r13 (Sprint 17 r3): empty-string port not normalized to 5432
 *
 * Spec references:
 *   - tests/perf/db/canonicalize-db-url.ts (the function under test)
 *   - tests/perf/db/setup.ts (consumer; bench-mode collision guard
 *     calls this at beforeAll to compare BENCH_DATABASE_URL vs
 *     DATABASE_URL vs TEST_DATABASE_URL)
 *   - docs/PROJECT_CONVENTIONS.md r2 §5.4 closure-path-overclaim
 *     pre-emption pattern (loose-grep / wrong-parser class)
 *   - docs/TLC-027-DB-BENCH-INFRA-ESCALATION.md (acceptance criteria)
 */

import { describe, expect, it } from 'vitest';

import { canonicalizeDbUrl } from '../perf/db/canonicalize-db-url.ts';

describe('canonicalizeDbUrl — bench-mode collision guard', () => {
  describe('§A basic forms — same target → same canonical triple', () => {
    it('omitted port canonicalizes to default 5432 (r13 closure)', () => {
      const a = canonicalizeDbUrl('postgresql://user:pass@localhost/mydb');
      const b = canonicalizeDbUrl('postgresql://user:pass@localhost:5432/mydb');
      expect(a).not.toBeNull();
      expect(a).toBe(b);
      expect(a).toBe('localhost:5432/mydb');
    });

    it('different auth credentials → same canonical triple', () => {
      const a = canonicalizeDbUrl('postgresql://alice:s3cret@host:5432/dbname');
      const b = canonicalizeDbUrl('postgresql://bob:other@host:5432/dbname');
      expect(a).toBe(b);
      expect(a).toBe('host:5432/dbname');
    });

    it('different query params (other than host/port) → same canonical triple', () => {
      const a = canonicalizeDbUrl('postgresql://user@host:5432/dbname?application_name=foo');
      const b = canonicalizeDbUrl('postgresql://user@host:5432/dbname?application_name=bar');
      expect(a).toBe(b);
      expect(a).toBe('host:5432/dbname');
    });

    it('case differences in host/dbname → same canonical triple', () => {
      const a = canonicalizeDbUrl('postgresql://user@HOST:5432/DBNAME');
      const b = canonicalizeDbUrl('postgresql://user@host:5432/dbname');
      expect(a).toBe(b);
      expect(a).toBe('host:5432/dbname');
    });
  });

  describe('§B different targets → different canonical triples', () => {
    it('different host → different canonical triples', () => {
      expect(canonicalizeDbUrl('postgresql://user@host1:5432/dbname')).not.toBe(
        canonicalizeDbUrl('postgresql://user@host2:5432/dbname'),
      );
    });

    it('different port → different canonical triples', () => {
      expect(canonicalizeDbUrl('postgresql://user@host:5432/dbname')).not.toBe(
        canonicalizeDbUrl('postgresql://user@host:5433/dbname'),
      );
    });

    it('different database → different canonical triples', () => {
      expect(canonicalizeDbUrl('postgresql://user@host:5432/db1')).not.toBe(
        canonicalizeDbUrl('postgresql://user@host:5432/db2'),
      );
    });
  });

  describe('§C libpq query-string overrides (r11-2 closure)', () => {
    it('?host= query overrides URL hostname', () => {
      // pg-connection-string uses ?host= to override URL host (libpq
      // semantics). Two URLs that pg connects to the SAME host should
      // canonicalize identically.
      const a = canonicalizeDbUrl('postgresql://user@hostfromurl:5432/dbname?host=actualhost');
      const b = canonicalizeDbUrl('postgresql://user@actualhost:5432/dbname');
      expect(a).toBe(b);
      expect(a).toBe('actualhost:5432/dbname');
    });

    it('?port= query overrides URL port (r12 closure)', () => {
      const a = canonicalizeDbUrl('postgresql://user@host:5432/dbname?port=6543');
      const b = canonicalizeDbUrl('postgresql://user@host:6543/dbname');
      expect(a).toBe(b);
      expect(a).toBe('host:6543/dbname');
    });
  });

  describe('§D last-wins for duplicate query keys (r12 closure)', () => {
    it('duplicate ?host= takes the LAST value (matches pg)', () => {
      // URLSearchParams.get is first-wins; pg-connection-string parser
      // is last-wins. Sprint 17 r12 closure switched to pg parser to
      // match its behavior. This test pins that semantic.
      const a = canonicalizeDbUrl(
        'postgresql://user@x:5432/dbname?host=ignored1&host=ignored2&host=actualhost',
      );
      expect(a).toBe('actualhost:5432/dbname');
    });

    it('duplicate ?port= takes the LAST value (matches pg)', () => {
      const a = canonicalizeDbUrl(
        'postgresql://user@host:5432/dbname?port=1111&port=2222&port=3333',
      );
      expect(a).toBe('host:3333/dbname');
    });
  });

  describe('§E fail-closed on ambiguous/unparseable URLs', () => {
    it('undefined URL → null', () => {
      expect(canonicalizeDbUrl(undefined)).toBeNull();
    });

    it('empty-string URL → null', () => {
      expect(canonicalizeDbUrl('')).toBeNull();
    });

    it('omitted host → null (fail-closed; no env-default inference)', () => {
      // postgresql:///dbname has no host; pg-connection-string returns
      // null/empty for host. We refuse to canonicalize ambiguously.
      const result = canonicalizeDbUrl('postgresql:///dbname');
      expect(result).toBeNull();
    });

    it('omitted database → null (fail-closed; no env-default inference)', () => {
      // postgresql://user@host:5432 has no database. Refuse to canonicalize.
      const result = canonicalizeDbUrl('postgresql://user@host:5432');
      expect(result).toBeNull();
    });

    it('not-a-url string → null', () => {
      expect(canonicalizeDbUrl('this is not a url')).toBeNull();
    });
  });

  describe('§F r13 specifically — empty-string port normalizes to 5432', () => {
    // Direct regression test for Codex r13: pg-connection-string
    // returns '' (empty string) for an omitted port, NOT null. Prior
    // canonicalization only checked null/undefined and would emit
    // `host:/db` for an empty-string port. r13 closure normalizes
    // ALL falsy values to 5432.
    it('postgresql://host/db canonicalizes with port=5432, not empty', () => {
      const result = canonicalizeDbUrl('postgresql://host/db');
      expect(result).toBe('host:5432/db');
    });

    it('omitted port + ?port= override → uses ?port= (NOT 5432)', () => {
      const result = canonicalizeDbUrl('postgresql://host/db?port=9999');
      expect(result).toBe('host:9999/db');
    });

    it('explicit :5432 + omitted-port URL canonicalize identically', () => {
      // The exact scenario Codex r13 cited: BENCH_DATABASE_URL=
      // postgresql://localhost/app could pass collision check vs
      // DATABASE_URL=postgresql://localhost:5432/app while pg
      // connects both to the same DB. r13 closure makes them equal.
      const a = canonicalizeDbUrl('postgresql://localhost/app');
      const b = canonicalizeDbUrl('postgresql://localhost:5432/app');
      expect(a).toBe(b);
      expect(a).toBe('localhost:5432/app');
    });
  });
});
