# telecheck-app

Implementation of the Telecheck multi-tenant AI-powered telehealth platform.

> **Spec corpus is in `arthurmenson/telecheckONE`** (sibling repo). This repo implements what that one specifies. Read [`CLAUDE.md`](./CLAUDE.md) before doing anything; it points at the canonical sources.

## Status

**5 modules implementation-complete + 3 BLOCKED-aware skeletons** as of Sprint 34 close (2026-05-08):

- **Implementation-complete:** Forms-Intake (slice PRD v2.1), Identity & Auth (v1.0), Consent + Delegation (v1.0), Async Consult (v1.0), Tenant Configuration (read paths; admin-write 503-stubbed pending Admin Backend slice v1.1 ratification).
- **BLOCKED-aware skeletons:** Pharmacy + Refill, Subscription (both blocked on SI-001 MedicationRequest schema gap), Medication Interaction Engine (blocked on slice PRD ratification).
- **Cross-cutting infra:** SI-006 reserve-then-execute idempotency redesign closed across Sprint 33-34 (9 PRs); cross-cutting Category A audit-dedupe primitive at `src/lib/audit-dedupe.ts`; per-tenant KMS + 3-layer RLS + audit hash-chain all live.

Slice-level state lives in `docs/{FORMS_INTAKE,IDENTITY,CONSENT,PHARMACY}_SLICE_STATUS_2026-05-05.md` (each with Sprint 33-34 amendment sections appended). Cumulative cross-slice state lives in `docs/BUILD_VS_SPEC_TRACEABILITY_MATRIX.md` r5. Cross-cutting patterns codified in `docs/PROJECT_CONVENTIONS.md` r5. Spec-issue artifacts in `docs/SI-*.md` (SI-006 closed at v0.3; SI-001/002/003 still open).

## Tech stack

- TypeScript on Node.js 20 LTS
- Fastify HTTP framework
- PostgreSQL 15+ with Row-Level Security (per ADR-023 multi-tenancy Model A)
- Prisma ORM
- Redis for cache + queues
- AWS us-east-1 primary / us-west-2 cold DR (per ADR-026)
- Anthropic Claude as primary clinical AI (multi-provider abstraction per ADR-020)

See [`CLAUDE.md`](./CLAUDE.md) "Tech stack" section for the full list with ADR justifications.

## Getting started

Prerequisites:

- Node.js 20 LTS
- PostgreSQL 15+
- Spec corpus cloned to `../telecheckONE/` (or `TELECHECK_SPEC_PATH` env var pointing to it)

Setup:

```bash
npm install                  # install dependencies
cp .env.example .env         # populate with local Postgres URL etc.
npm run dev                  # start Fastify app shell on :3000
```

Initial scaffold has no real endpoints — just a `/health` route to confirm the app boots.

## Layout

```
telecheck-app/
├── CLAUDE.md                # project context for Claude Code
├── README.md                # this file
├── package.json             # deps + npm scripts
├── tsconfig.json            # TypeScript strict mode
├── .gitignore
├── .prettierrc
├── .eslintrc.cjs
├── .env.example
├── src/
│   ├── server.ts            # entry point (binds Fastify to port)
│   ├── app.ts               # Fastify app factory (no port binding)
│   ├── lib/                 # cross-module utilities (logger, config)
│   └── modules/             # one directory per platform module (per ADR-001)
│       └── README.md        # explains the modular monolith pattern
├── migrations/              # sequentially numbered SQL migrations
│   └── README.md
├── tests/                   # integration + e2e tests
│   └── README.md
└── docs/
    └── README.md            # pointer to spec corpus
```

## Spec corpus

This repo does NOT contain the spec — it consumes it from a sibling repo. Authoritative sources:

- `Telecheck_Master_Platform_PRD_v1_10.md` — what the product is
- `Telecheck_Artifact_Registry_v2_10.md` — which version of what is canonical
- `Telecheck_OpenAPI_v0_2.md` — endpoint contracts
- `Telecheck_Canonical_Data_Model_v1_2.md` — entity schemas
- `Telecheck_State_Machines_v1_1.md` — state transitions
- `Telecheck_Contracts_Pack_v5_00_*.md` — runtime contracts (v5.2 in headers)
- 17 slice PRDs for per-feature detail

Spec workflow: edits to specs happen in `arthurmenson/telecheckONE` per its own CLAUDE.md and Phase-N cycle discipline. When specs change, this repo follows.

## Hard rules (summary; full list in CLAUDE.md)

- Audit table is append-only (I-003)
- Every PHI-touching query is tenant-filtered, three layers (I-023)
- Cross-tenant access requires break-glass with audit (I-024)
- Crisis detection is platform-floor (I-019)
- Operating-tenant identifier is `Telecheck-{country}`; consumer DBA `Heros Health` is sourced from `tenant.consumer_dba`, never from `tenant.id` (per Master PRD v1.10 §17 C3 brand structure)
- I-029 6-condition reject-unless gate for research data export
- I-012 reject-unless three-clause rule for prescription/refill/medication-order execution

## License

Proprietary. All rights reserved.
