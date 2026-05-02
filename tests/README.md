# `tests/` — integration + e2e tests

## Discipline

- **Unit tests live alongside source code** as `<file>.test.ts` (per CLAUDE.md code conventions). This directory is for **integration** + **end-to-end** tests that span modules.
- **Every tenant-isolation test must include a cross-tenant access case.** The pattern is: create resource as Tenant A, attempt access as Tenant B, assert tenant-blind error envelope per I-025.
- **State machine tests must cover guards + invariant assertions.** I-029 6-condition gate, I-012 reject-unless three-clause rule, etc.
- **OpenAPI conformance tests run in CI** validating that every endpoint honors its OpenAPI v0.2 contract.
- **Invariant assertion harness** runs against integration test results to ensure no test scenario violates an invariant.

## Layout (filled in by foundation-layer agents)

```
tests/
├── README.md                       # this file
├── helpers/
│   ├── tenant-fixtures.ts          # createTenant, createTestUser, withTenantContext
│   ├── audit-assertions.ts         # assertAuditChainIntact, assertAuditEnvelopePresent
│   └── invariant-assertions.ts     # invariant verification utilities
├── integration/
│   ├── tenant-isolation.test.ts    # cross-tenant access denial across all PHI tables
│   ├── audit-chain.test.ts         # hash chain integrity (I-003)
│   └── error-envelope.test.ts      # tenant-blind error responses (I-025)
├── contracts/
│   ├── openapi-conformance.test.ts # every endpoint matches OpenAPI v0.2
│   └── canonical-glossary.test.ts  # forbidden glossary aliases not present
├── state-machines/
│   ├── i029-research-export.test.ts  # 6-condition gate enforcement
│   ├── i012-prescribing.test.ts      # reject-unless three-clause rule
│   └── ... (per State Machines v1.1; one file per machine)
└── invariants/
    ├── i003-audit-append-only.test.ts
    ├── i019-crisis-detection.test.ts
    ├── i023-tenant-isolation.test.ts
    └── ... (one per invariant where testable)
```

## Test database

Integration tests run against a **real Postgres** with RLS policies enabled (per ADR-023). Vitest setup spins up an ephemeral database per test run, applies all migrations, and seeds two distinct tenants (`Telecheck-US` + `Telecheck-Ghana`) for cross-tenant tests.

## Status

**Empty at bootstrap.** The `test-qa-engineer` agent in the foundation layer commit drops in the helpers, vitest config, and the canonical test patterns.

## Spec references

- `Telecheck_Contracts_Pack_v5_00_INVARIANTS.md` — every invariant where testable gets a test
- `Telecheck_OpenAPI_v0_2.md` — endpoint conformance
- `Telecheck_State_Machines_v1_1.md` — state machine guards + transitions
- `Telecheck_Tenant_Threading_Addendum_v1_0.md` — slice-specific tenant isolation patterns
