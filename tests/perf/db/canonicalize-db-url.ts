/**
 * tests/perf/db/canonicalize-db-url.ts — Postgres URL canonicalization
 * for the bench-mode collision guard.
 *
 * Extracted from `tests/perf/db/setup.ts` (Sprint 17 r13 fix-forward
 * 2026-05-06) so a regression test (`tests/contracts/canonicalize-db-
 * url.test.ts`) can import the function without dragging the
 * `beforeAll`/`afterAll` hooks that the setup file registers.
 *
 * Why this matters:
 *   - Codex perf-bench-r13 HIGH: the prior canonicalization didn't
 *     normalize empty-string port to 5432, so `postgresql://host/db`
 *     canonicalized as `host:/db` while `postgresql://host:5432/db`
 *     canonicalized as `host:5432/db` — different triples for the
 *     same physical DB. Bench writes could pollute dev/test data.
 *   - Codex r13 explicitly recommended regression test coverage for
 *     the omitted-port / explicit-default-port / omitted-host /
 *     query-?port= / duplicate-query-keys cases. This split file +
 *     the companion test deliver that coverage.
 *
 * The collision-guard semantics are documented inline below.
 *
 * Spec references:
 *   - ORT v1.5 OR-218 (Tier 1 launch-blocking)
 *   - tests/perf/db/setup.ts (the setup file that uses this function
 *     in the canonicalized 3-way collision check at beforeAll)
 *   - docs/PROJECT_CONVENTIONS.md r2 §5.4 closure-path-overclaim
 *     pre-emption pattern (loose-grep / wrong-parser class — same
 *     trajectory Sprint 13 r7-A → r8-B documented)
 *   - docs/TLC-027-DB-BENCH-INFRA-ESCALATION.md (acceptance criteria)
 */

// pg-connection-string is a direct dep of `pg`; pg uses it internally
// to parse connection strings. We import it explicitly so the
// canonicalization matches the parser pg uses to actually connect.
import { parse as parsePgConnectionString } from 'pg-connection-string';

/**
 * Canonicalize a Postgres connection URL for collision-guard
 * comparison. Returns `host:port/database` triple (lowercase host;
 * default port 5432 for all falsy port values; lowercase database).
 *
 * Returns `null` when the URL is unparseable OR when host/database
 * are empty/null/undefined (fail-closed: ambiguous URLs are rejected
 * outright rather than canonicalized to a partial triple that could
 * silently bypass collision detection).
 *
 * Trajectory of the same finding-class:
 *
 *   r10-C (Sprint 14 SCAFFOLD, reverted): string-equality on raw
 *     URLs bypassed by any URL-form difference.
 *
 *   r11-2 (Sprint 17 r1, commit 16c191b): Web URL parser, read
 *     `parsed.hostname`. Closed by reading
 *     `searchParams.get('host')` so libpq query-host wasn't ignored.
 *
 *   r12 (Sprint 17 r2, commit 8dd6a76): `URLSearchParams.get` is
 *     first-wins; pg parses last-wins. `?port=` ignored entirely.
 *     Closed by switching to pg-connection-string parser.
 *
 *   r13 (Sprint 17 r3, this file): pg-connection-string returns
 *     EMPTY STRING for omitted port/database (not null/undefined);
 *     prior null/undefined-only check missed empty-string. Closed
 *     by defensive-default to 5432 for all falsy port values + fail-
 *     closed for empty host/database + extracted to dedicated file
 *     for regression test coverage.
 */
export function canonicalizeDbUrl(url: string | undefined): string | null {
  if (url === undefined || url === '') return null;

  // Sprint 20 / TLC-039 closure (Codex r17 implicit, surfaced by my own
  // PR #11 §E lockdown test): pg-connection-string is permissive and
  // will parse ARBITRARY strings into a partial config (e.g.,
  // 'this is not a url' parses to host='base', database='this is not a url').
  // Reject inputs that don't look like a proper postgres URL up front
  // — otherwise the §E "not-a-url string → null" lockdown invariant
  // breaks.
  //
  // Accept: postgresql:// or postgres:// scheme prefix (case-insensitive)
  // Reject: anything else
  const schemeMatch = /^postgres(ql)?:\/\//i.test(url);
  if (!schemeMatch) {
    return null;
  }

  try {
    const cfg = parsePgConnectionString(url);

    // Host: fail-closed if absent. Don't try to infer from pg defaults
    // / env — collision guard is safer when ambiguous URLs are
    // rejected outright. Empty string also rejected.
    const rawHost = cfg.host;
    if (rawHost === null || rawHost === undefined || rawHost === '') {
      return null;
    }
    const host = String(rawHost).toLowerCase();

    // Port: default to 5432 for ALL falsy values (null, undefined,
    // empty string). pg's actual connect logic does the same. r13
    // closure: missing this normalization meant omitted-port URLs
    // canonicalized as `host:/db` rather than `host:5432/db`.
    const rawPort = cfg.port;
    const port =
      rawPort === null || rawPort === undefined || String(rawPort).trim() === ''
        ? '5432'
        : String(rawPort).trim();

    // Database: fail-closed if absent. pg can fall back to env
    // PGDATABASE or the user name; without that context here, refuse
    // to canonicalize an ambiguous URL.
    const rawDb = cfg.database;
    if (rawDb === null || rawDb === undefined || rawDb === '') {
      return null;
    }
    const dbname = String(rawDb).toLowerCase();

    return `${host}:${port}/${dbname}`;
  } catch {
    return null;
  }
}
