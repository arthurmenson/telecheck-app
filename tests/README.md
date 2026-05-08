# `tests/` — integration + e2e tests

## Discipline

- **Unit tests live alongside source code** as `<file>.test.ts` (per CLAUDE.md code conventions). This directory is for **integration** + **end-to-end** tests that span modules.
- **Every tenant-isolation test must include a cross-tenant access case.** The pattern is: create resource as Tenant A, attempt access as Tenant B, assert tenant-blind error envelope per I-025.
- **State machine tests must cover guards + invariant assertions.** I-029 6-condition gate, I-012 reject-unless three-clause rule, etc.
- **OpenAPI conformance tests run in CI** validating that every endpoint honors its OpenAPI v0.2 contract.
- **Lockdown contract tests pin resolved invariants** after Codex fix-forward chains converge (per PROJECT_CONVENTIONS r5 §5.4 lockdown-test pinning rule + §5.11 comment-stripped source-grep). Sprint 33-34 SI-006 closure added Group F lockdown for legacy onSend cache-write hook removal.

## Layout

```
tests/
├── README.md                       # this file
├── setup.ts                        # vitest setup: per-test SAVEPOINT isolation, tenant fixtures, RLS context
├── helpers/
│   ├── tenant-fixtures.ts          # createTenant, createTestUser, withTenantContext
│   ├── audit-assertions.ts         # assertAuditChainIntact, assertAuditEnvelopePresent
│   ├── invariant-assertions.ts     # invariant verification utilities
│   └── unique-phone.ts             # collision-free phone number generator for parallel tests
├── integration/                    # ~92 files: per-slice service + repo + HTTP coverage; cross-tenant isolation; idempotency replay; audit chain; domain events; migration regression
├── contracts/
│   ├── openapi-conformance.test.ts                  # every endpoint matches OpenAPI v0.2 (gated on TELECHECK_SPEC_PATH; CI clones spec corpus)
│   ├── canonical-glossary.test.ts                   # forbidden glossary aliases not present anywhere in src/
│   ├── canonicalize-db-url.test.ts                  # 19-case lockdown — Sprint 17 / TLC-027 r10→r11→r12→r13 trajectory pinned
│   ├── crisis-detection-coverage-lockdown.test.ts   # I-019 platform-floor — every crisis-touching surface has runCrisisGate
│   ├── idempotency-actor-scoping-lockdown.test.ts   # IDEMPOTENCY v5.1 — actor_id is part of the cache 4-tuple PK
│   └── rls-policy-coverage-lockdown.test.ts         # 50-case lockdown — every PHI-touching table has a RLS policy attached
├── state-machines/
│   ├── i029-research-export.test.ts                 # 6-condition reject-unless gate enforcement (15 cases)
│   └── i012-prescribing.test.ts                     # reject-unless three-clause rule for prescribing/refill/medication-order (17 cases)
├── invariants/
│   ├── i003-audit-append-only.test.ts               # audit_records cannot UPDATE / DELETE; hash chain integrity
│   ├── i019-crisis-detection.test.ts                # crisis-detection guard is a platform-floor; never disabled
│   └── i023-tenant-isolation.test.ts                # three-layer enforcement (RLS + app-layer + KMS)
└── perf/                            # OR-218 perf benches; thresholds enforced via .github/workflows/perf.yml + machine-enforced baseline-refresh-guard
    └── README.md                    # see for bench-mode infrastructure docs (Sprint 17 / TLC-027)
```

## Test database

Integration tests run against a **real Postgres** with RLS policies enabled (per ADR-023). Vitest setup at `tests/setup.ts` applies all migrations on first run, seeds two distinct tenants (`Telecheck-US` + `Telecheck-Ghana`), and uses **per-test SAVEPOINT isolation** so tests roll back cleanly without re-applying migrations between cases. The test pool's savepoint translation at `src/lib/db.ts:147` maps `BEGIN` → `SAVEPOINT app_tx_N` so handler-level `withTransaction` wrappers nest correctly inside the per-test outer SAVEPOINT.

`FORCE RLS` requires every PHI-touching query to be wrapped in `withTenantContext` — repo-layer queries that are not wrapped will hit zero rows even when data exists, regardless of the actor's role. This is by design (I-023 three-layer enforcement) and the most common test-debugging pitfall.

## Bench mode

`tests/perf/` runs against an ephemeral Postgres role (`telecheck_bench_app`, constrained per Sprint 17 / TLC-027) via `setBenchPool()` in `src/lib/db.ts`. The bench pool is canonicalized via `pg-connection-string` to prevent collision with the test pool. Thresholds are pinned in JSON manifests and enforced by the `perf` GitHub workflow + the `baseline-refresh-guard` workflow that machine-checks any bench-baseline manifest update.

## Status

**88+ integration test files at Sprint 34 close (2026-05-08).** Coverage spans:

- **5 implementation-complete slices:** Forms-Intake (v2.1), Identity & Auth (v1.0), Consent + Delegation (v1.0), Async Consult (v1.0), Tenant-Config (read paths v1.0; admin-write 503-stubbed)
- **3 BLOCKED-aware module skeletons:** Pharmacy + Refill, Subscription, Medication Interaction Engine — plugin smoke tests only
- **Cross-cutting:** audit chain (I-003), audit envelope (I-027), audit dedupe (`audit_dedupe_markers` Sprint 34 PR #49), domain events (DOMAIN_EVENTS v5.2), idempotency (IDEMPOTENCY v5.1), error envelopes (I-025 tenant-blind), RLS coverage lockdown (50 PHI-touching tables), tenant context, KMS, crisis detection (I-019), I-012 prescribing gate, I-029 research export 6-condition gate

The `database-integration-expert` agent owned the bootstrap helpers (`tenant-fixtures.ts`, `audit-assertions.ts`, `invariant-assertions.ts`); subsequent test files were authored as part of slice-implementation sprints with Codex per-PR adversarial review.

## Sprint 33-34 SI-006 closure additions

- `tests/integration/audit-dedupe.test.ts` — 11 cases including Group G documented-limitation regression marker (PR #59)
- `tests/integration/forms-intake-idempotency-replay.test.ts` — IDEMPOTENCY v5.1 contract regression on forms-intake admin write paths (PR #63)
- `tests/integration/identity-{devices,login,registration}-http.test.ts` §4-§5 — IDEMPOTENCY v5.1 contract HTTP coverage on identity routes (PRs #60-#62)
- `tests/integration/idempotency-helper.test.ts` — Group F source-grep lockdown pinning the absence of legacy onSend cache-write hook (Sprint 33 PR-E + Sprint 34 cleanup-sweep)

## Spec references

- `Telecheck_Contracts_Pack_v5_00_INVARIANTS.md` — every invariant where testable gets a test (I-003, I-019, I-023, I-025, I-027, I-012, I-029, I-030, I-031)
- `Telecheck_OpenAPI_v0_2.md` — endpoint conformance via `tests/contracts/openapi-conformance.test.ts`
- `Telecheck_State_Machines_v1_1.md` — state machine guards + transitions
- `Telecheck_Tenant_Threading_Addendum_v1_0.md` — slice-specific tenant isolation patterns
- `Telecheck_Contracts_Pack_v5_00_GLOSSARY.md` — forbidden alias enforcement via `tests/contracts/canonical-glossary.test.ts`
- `Telecheck_Contracts_Pack_v5_00_AUDIT_EVENTS.md` v5.2 — audit envelope shape + Category A dedupe
- `Telecheck_Contracts_Pack_v5_00_IDEMPOTENCY.md` v5.1 — reserve-then-execute + 4-tuple PK
