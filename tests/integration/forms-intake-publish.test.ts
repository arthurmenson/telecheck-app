/**
 * Forms/Intake — publishVersion integration tests.
 *
 * Exercises the publish path end-to-end: status transition, supersession
 * cascade, audit emission, domain event emission, RLS-enforced cross-
 * tenant denial.
 *
 * Spec references:
 *   - FORMS_ENGINE v5.2 §Form versioning (Pattern A: each row IS a version;
 *     one published per (tenant, program, country) family at a time).
 *   - Slice PRD v2.1 §6.2 deploy template (publish workflow).
 *   - INVARIANT I-013 (published version immutability).
 *   - INVARIANT I-016 (domain event durability — same-tx outbox).
 *   - INVARIANT I-023 / I-027 (cross-tenant denial via RLS).
 *
 * ============================================================================
 * TEST-ARCHITECTURE BLOCKER (deferred to it.todo 2026-05-03)
 * ============================================================================
 *
 * `templateService.publishVersion` and `templateService.createDraftTemplate`
 * use `withTransaction` from src/lib/db.ts, which calls `pool.connect()`
 * to acquire a fresh pool connection. The integration-test harness in
 * tests/setup.ts maintains a SINGLE long-running `pg.Client` (returned by
 * `getTestClient()`) wrapped in an outer BEGIN, with per-test SAVEPOINT
 * isolation — so any data inserted via the test client is uncommitted and
 * invisible to a separate pool connection (PostgreSQL transaction isolation).
 *
 * Concrete failure mode: a test that inserts a draft via the test client
 * then calls `publishVersion(...)` from the service layer fails with
 * `forms.publish.version_not_found` because the service's pool connection
 * can't see the test's uncommitted draft.
 *
 * The audit-chain / tenant-isolation tests work because they only use the
 * test client (no service-layer calls). This file is the FIRST integration
 * test that crosses the test-client / pool boundary, so it's also the first
 * to surface this gap.
 *
 * Three paths to resolve, none of which are in scope for the publishVersion
 * implementation commit:
 *
 *   (a) Add an optional `externalTx?: DbTransaction` parameter to the
 *       service/repo functions, mirroring `lib/audit.ts emitAudit()`'s
 *       NODE_ENV-gated `tx?` pattern. Tests pass `getTestClient()`;
 *       production passes nothing. Smallest surface change but extends
 *       the production API for testability.
 *
 *   (b) Replace the pool-based `withTransaction` with a test-mode
 *       implementation that reuses the test client. Cleanest from the
 *       caller's perspective but invasive to `lib/db.ts`.
 *
 *   (c) Switch the integration test to commit data via the pool and add
 *       explicit DELETE cleanup in afterEach. Loses savepoint isolation
 *       for these specific tests; audit rows would persist (append-only
 *       trigger forbids cleanup), accumulating in long-lived dev DBs.
 *
 * Until that's resolved, these scenarios are tracked as `it.todo` so the
 * pattern + assertions are visible alongside the implementation. The
 * implementation's correctness is exercised by:
 *
 *   - Local lint + typecheck (catches type/signature drift).
 *   - Codex adversarial review on the publishVersion commit.
 *   - The next CI run that exercises a full handler invocation with HTTP
 *     fixtures (planned with `app.inject` / supertest in a follow-up
 *     once test-infrastructure work lands).
 *
 * The helper functions + TenantContext literals below are kept for the
 * future implementation — they document the expected fixture shape so
 * activating any of these tests is a matter of removing `.todo` once the
 * harness can bridge pool/savepoint.
 *
 * DEPENDS ON (when activated):
 *   - tests/setup.ts (savepoint wrapping; telecheck_test_app role bound
 *     so RLS applies).
 *   - migrations/006_forms_intake.sql (forms_template table + RLS policies).
 */

import { describe, it } from 'vitest';

// ---------------------------------------------------------------------------
// Pre-staged it.todo entries — activate as the test-architecture blocker resolves.
// ---------------------------------------------------------------------------

describe('forms-intake publishVersion — first-time publish (no prior to supersede)', () => {
  it.todo(
    'should flip a draft to published, set published_at, and emit governance audit + domain event ' +
      '— blocked on test-architecture bridge between pool connections and the test client savepoint',
  );
});

describe('forms-intake publishVersion — supersession cascade', () => {
  it.todo(
    'should flip prior published to superseded when a newer version publishes in the same family ' +
      '— blocked on test-architecture bridge (see file header)',
  );
});

describe('forms-intake publishVersion — I-013 immutability', () => {
  it.todo(
    'should reject re-publishing an already-published row with PUBLISH_VERSION_NOT_DRAFT ' +
      '— blocked on test-architecture bridge (see file header)',
  );
});

describe('forms-intake publishVersion — cross-tenant isolation (I-023)', () => {
  it.todo(
    'should treat a cross-tenant publish attempt as VERSION_NOT_FOUND (tenant-blind) ' +
      '— blocked on test-architecture bridge (see file header)',
  );
});
